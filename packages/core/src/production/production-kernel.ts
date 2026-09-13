import type { ChapterPipelineResult } from "../pipeline/runner.js";
import { lstat } from "node:fs/promises";
import { ProductionKernelModeSchema, type ProductionKernelMode } from "../models/project.js";
import { readGenreProfileWithReceipt } from "../agents/rules-reader.js";
import { StateManager } from "../state/manager.js";
import {
  ChapterCommitReceiptSchema,
  listChapterCommitReceiptsForAttempt,
} from "../state/chapter-commit-receipt.js";
import { captureChapterPersistenceFingerprint } from "../state/chapter-persistence-journal.js";
import {
  ProductionAttemptIdentitySchema,
  createProductionAttemptIdentity,
  type ProductionAttemptIdentity,
} from "./attempt-identity.js";
import { resolveDetachedOwnerDirectionLease } from "./detached-payload-store.js";
import { verifyResolvedProductionDirectionContext, type ResolvedProductionDirectionContext } from "./direction-context.js";
import {
  ProductionExecutionContextSchema,
  runWithProductionExecutionContext,
  type ProductionExecutionContext,
} from "./execution-context.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";
import { BookSoulStore } from "./book-soul-binding.js";
import {
  createProductionInputReceipt,
  runWithProductionInputBundle,
  sha256Bytes,
  type ProductionInputReceipt,
} from "./production-input.js";
import { resolveWriteNextProductionSkills } from "./production-skill.js";
import { resolveAuthorCraftInputReceipt } from "../reference/author-craft.js";
import { resolveTaskGuidance } from "./task-guidance-resolver.js";
import {
  ProductionCommandBindingSchema,
  parsePersistedProductionCommand,
  productionCommandActionSource,
  type ProductionCommand,
  type ProductionCommandBinding,
} from "./production-command.js";
import {
  buildNoCommitProductionRun,
  buildSucceededProductionRun,
  createProductionRunSnapshot,
  ensureProductionProjectionDirectories,
  finalizeProductionRun,
  findProductionProjectionByIdempotencyKey,
  loadProductionRunSnapshotByCommandId,
  saveProductionRunSnapshot,
  verifyProductionCommitEvidence,
  verifyProductionNoCommit,
  type ProductionRun,
  type ProductionRunSnapshot,
} from "./run-projection.js";

export interface ProductionKernelWriteNextResult {
  readonly run: ProductionRun;
  readonly result?: ChapterPipelineResult;
  readonly reused: boolean;
}

export class ProductionExecutionTerminalError extends Error {
  constructor(
    readonly run: ProductionRun,
    readonly cause: unknown,
  ) {
    super(`Production execution ended ${run.executionStatus}; terminal run ${run.command.commandId} was persisted.`);
    this.name = "ProductionExecutionTerminalError";
  }
}

function assertCurrentBinding(
  command: ProductionCommand,
  currentBinding: ProductionCommandBinding,
): ProductionCommandBinding {
  const current = ProductionCommandBindingSchema.parse(currentBinding);
  if (hashCanonicalJson(command.binding) !== hashCanonicalJson(current)) {
    throw new Error("Persisted production command no longer matches the current Book/session/Soul binding.");
  }
  return current;
}

function expectedTargetLengthUnit(language: "zh" | "ko" | "en" | undefined): "zh-chars" | "ko-chars" | "words" | undefined {
  if (language === "zh") return "zh-chars";
  if (language === "ko") return "ko-chars";
  if (language === "en") return "words";
  return undefined;
}

function isCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && /\babort(?:ed)?\b/iu.test(error.message);
}

function buildExecutionContext(
  command: ProductionCommand,
  productionAttempt: ProductionAttemptIdentity,
  startedAt: string,
  mode: "observe" | "enforce",
  productionInputs?: ProductionInputReceipt,
): ProductionExecutionContext {
  return ProductionExecutionContextSchema.parse({
    schemaVersion: "production-execution-context/v1",
    commandId: command.commandId,
    commandSha256: command.commandSelfHash,
    productionOperationId: productionAttempt.productionOperationId,
    attemptId: productionAttempt.attemptId,
    intentDigest: command.intentDigest,
    capability: command.capability,
    mode,
    source: command.source,
    actionSource: productionCommandActionSource(command),
    binding: command.binding,
    activatedSkills: productionInputs?.skills.map((skill) => skill.id) ?? command.activatedSkills,
    ...(productionInputs ? { productionInputs } : {}),
    startedAt,
  });
}

/**
 * Reconcile one abandoned snapshot while the caller holds the exact Book lock.
 * It never invokes a model or the write pipeline.
 */
export async function reconcileProductionRunSnapshot(input: {
  readonly bookDir: string;
  readonly snapshot: ProductionRunSnapshot;
  readonly now?: Date;
}): Promise<ProductionRun> {
  const receipts = await listChapterCommitReceiptsForAttempt(
    input.bookDir,
    input.snapshot.productionAttempt,
  );
  if (receipts.length > 1) {
    throw new Error("A write-next production attempt has multiple Chapter commit receipts.");
  }
  if (receipts[0]) {
    const verified = await verifyProductionCommitEvidence({
      bookDir: input.bookDir,
      command: input.snapshot.command,
      productionAttempt: input.snapshot.productionAttempt,
      receipt: receipts[0],
      allowSupersededCanon: true,
      now: input.now,
    });
    return finalizeProductionRun(input.bookDir, buildSucceededProductionRun({
      snapshot: input.snapshot,
      evidence: verified.evidence,
      chapter: verified.chapter,
      projectionOrigin: "reconciled",
      now: input.now,
    }));
  }
  const evidence = await verifyProductionNoCommit({
    bookDir: input.bookDir,
    snapshot: input.snapshot,
    error: new Error("Abandoned production snapshot had no Chapter commit receipt."),
    now: input.now,
  });
  return finalizeProductionRun(input.bookDir, buildNoCommitProductionRun({
    snapshot: input.snapshot,
    evidence,
    executionStatus: "failed",
    projectionOrigin: "reconciled",
    now: input.now,
  }));
}

/**
 * Phase-3 observe adapter for one write-next command. The legacy writer remains
 * the only canon mutator; this wrapper adds typed authority, correlation,
 * idempotency, and a reconciled run projection around it.
 */
export async function executeObserveOnlyWriteNext(input: {
  readonly projectRoot: string;
  readonly kernelMode: ProductionKernelMode;
  readonly persistedCommand: unknown;
  readonly currentBinding: ProductionCommandBinding;
  readonly signal?: AbortSignal;
  readonly executeWithinBookLock: (args: {
    readonly bookId: string;
    readonly wordCount?: number;
    readonly productionAttempt: ProductionAttemptIdentity;
    readonly directionContext: ResolvedProductionDirectionContext;
  }) => Promise<ChapterPipelineResult>;
  readonly now?: () => Date;
}): Promise<ProductionKernelWriteNextResult> {
  const mode = ProductionKernelModeSchema.parse(input.kernelMode);
  if (mode === "off") throw new Error("Production kernel is off.");

  // Serialize and parse again so caller-owned object identity cannot act as
  // authorization. The strict schema and self-hash are checked on these bytes.
  const command = parsePersistedProductionCommand(JSON.parse(JSON.stringify(input.persistedCommand)));
  if (mode === "enforce" && command.schemaVersion === "production-command/v1") {
    throw new Error("Production kernel enforce mode requires ProductionCommand v2.");
  }
  assertCurrentBinding(command, input.currentBinding);
  input.signal?.throwIfAborted();

  const state = new StateManager(input.projectRoot);
  const bookDirectoryInfo = await lstat(state.bookDir(command.binding.bookId));
  if (!bookDirectoryInfo.isDirectory() || bookDirectoryInfo.isSymbolicLink()) {
    throw new Error("Production command Book path must be a real local directory.");
  }
  const releaseLock = await state.acquireBookLock(command.binding.bookId);
  try {
    const now = input.now ?? (() => new Date());
    const book = await state.loadBookConfig(command.binding.bookId);
    if (book.id !== command.binding.bookId) {
      throw new Error("Current Book config is not bound to the production command.");
    }
    assertCurrentBinding(command, input.currentBinding);
    const expectedUnit = expectedTargetLengthUnit(book.language);
    if (command.args.targetLength && expectedUnit && command.args.targetLength.unit !== expectedUnit) {
      throw new Error(`Production target length unit must be ${expectedUnit} for this Book.`);
    }

    await ensureProductionProjectionDirectories(state.bookDir(command.binding.bookId));
    const existing = await findProductionProjectionByIdempotencyKey(
      state.bookDir(command.binding.bookId),
      command.idempotencyKey,
      command.intentDigest,
    );
    if (existing?.kind === "terminal") {
      return { run: existing.value, reused: true };
    }
    if (existing?.kind === "snapshot") {
      return {
        run: await reconcileProductionRunSnapshot({
          bookDir: state.bookDir(command.binding.bookId),
          snapshot: existing.value,
          now: now(),
        }),
        reused: true,
      };
    }

    const activeSoul = await new BookSoulStore(
      input.projectRoot,
      state.bookDir(command.binding.bookId),
      command.binding.bookId,
    ).resolveActiveInput();
    const expectedSoulBinding = activeSoul?.sessionBinding;
    if (hashCanonicalJson(command.binding.soulBinding ?? null) !== hashCanonicalJson(expectedSoulBinding ?? null)) {
      throw new Error("Production command/session Soul binding does not match the active Book Soul.");
    }
    const resolvedSkills = await resolveWriteNextProductionSkills({
      projectRoot: input.projectRoot,
      requestedSkillIds: command.activatedSkills,
      disabledSkillIds: command.disabledSkills,
    });
    const promptInjection = [
      activeSoul?.promptInput,
      ...resolvedSkills.promptInputs,
    ].filter((value): value is string => Boolean(value)).join("\n\n");
    const writerGenreProfile = (await readGenreProfileWithReceipt(
      input.projectRoot,
      book.genre,
    )).receipt;
    if (
      activeSoul?.binding.schemaVersion === "book-soul-binding/v2"
      && hashCanonicalJson(activeSoul.binding.adoptionEvidence.writerGenreProfile.receipt)
        !== hashCanonicalJson(writerGenreProfile)
    ) {
      throw new Error("Active Soul adoption evidence no longer matches the Writer genre profile resolved for this Book.");
    }
    const authorCraft = await resolveAuthorCraftInputReceipt(input.projectRoot, book.writing?.authorCraft, book.language ?? writerGenreProfile.language);
    const productionInputs = createProductionInputReceipt({
      schemaVersion: "production-input-receipt/v1",
      soul: activeSoul?.receipt ?? null,
      skills: [...resolvedSkills.receipts],
      writerGenreProfile,
      ...(authorCraft ? { authorCraft } : {}),
      externalContextSha256: command.authorization.ownerDirection.textSha256,
      promptInjectionSha256: sha256Bytes(promptInjection),
    });

    const nextChapterNumber = await state.getNextChapterNumber(command.binding.bookId);
    const productionAttempt = createProductionAttemptIdentity();
    const startedAt = now().toISOString();
    const context = buildExecutionContext(command, productionAttempt, startedAt, mode, productionInputs);
    const canonicalBaseline = await captureChapterPersistenceFingerprint(
      state.bookDir(command.binding.bookId),
      nextChapterNumber,
    );
    let snapshot = createProductionRunSnapshot({
      command,
      productionAttempt,
      context,
      executionStatus: "preparing",
      canonicalBaseline,
      now: new Date(startedAt),
    });
    await saveProductionRunSnapshot(state.bookDir(command.binding.bookId), snapshot);

    try {
      const persistedPreparing = await loadProductionRunSnapshotByCommandId(
        state.bookDir(command.binding.bookId),
        command.commandId,
      );
      if (!persistedPreparing || hashCanonicalJson(persistedPreparing) !== hashCanonicalJson(snapshot)) {
        throw new Error("Preparing production snapshot changed before execution authorization.");
      }
      const executableCommand = parsePersistedProductionCommand(persistedPreparing.command);
      assertCurrentBinding(executableCommand, input.currentBinding);
      // Resolve the detached decision payload only after the persisted command,
      // current binding, Book, and idempotency state have all been revalidated.
      snapshot = createProductionRunSnapshot({
        command,
        productionAttempt,
        context,
        executionStatus: "running",
        canonicalBaseline,
        now: now(),
      });
      await saveProductionRunSnapshot(state.bookDir(command.binding.bookId), snapshot);
      const persistedRunning = await loadProductionRunSnapshotByCommandId(
        state.bookDir(command.binding.bookId),
        command.commandId,
      );
      if (!persistedRunning || hashCanonicalJson(persistedRunning) !== hashCanonicalJson(snapshot)) {
        throw new Error("Running production snapshot changed before the write-next call.");
      }
      snapshot = persistedRunning;
      assertCurrentBinding(snapshot.command, input.currentBinding);
      input.signal?.throwIfAborted();
      // Resolve at the final authority boundary so an expired or replaced
      // lease cannot survive the snapshot transition into the writer call.
      const ownerDirection = await resolveDetachedOwnerDirectionLease({
        projectRoot: input.projectRoot,
        reference: executableCommand.authorization.ownerDirection,
        now: now(),
      });
      const taskGuidance = executableCommand.schemaVersion === "production-command/v2"
        && executableCommand.args.taskGuidance
        ? await resolveTaskGuidance({
            projectRoot: input.projectRoot,
            reference: executableCommand.args.taskGuidance,
          })
        : undefined;
      const directionContext = verifyResolvedProductionDirectionContext({
        ownerDirection,
        ...(taskGuidance ? { taskGuidance } : {}),
      });

      const result = await runWithProductionExecutionContext(context, () => runWithProductionInputBundle({
        bookId: snapshot.command.binding.bookId,
        commandId: snapshot.command.commandId,
        productionOperationId: productionAttempt.productionOperationId,
        attemptId: productionAttempt.attemptId,
        promptInjection,
        externalContextText: ownerDirection.text,
        receipt: productionInputs,
      }, () => input.executeWithinBookLock({
          bookId: snapshot.command.binding.bookId,
          wordCount: snapshot.command.args.targetLength?.count,
          productionAttempt,
          directionContext,
        })));
      const returnedAttempt = ProductionAttemptIdentitySchema.parse(result.productionAttempt);
      if (hashCanonicalJson(returnedAttempt) !== hashCanonicalJson(productionAttempt)) {
        throw new Error("Legacy write-next returned a different production attempt identity.");
      }
      const receipts = await listChapterCommitReceiptsForAttempt(
        state.bookDir(command.binding.bookId),
        productionAttempt,
      );
      if (receipts.length !== 1 || !result.chapterCommitReceipt) {
        throw new Error("Successful write-next requires exactly one persisted Chapter commit receipt.");
      }
      const returnedReceipt = ChapterCommitReceiptSchema.parse(result.chapterCommitReceipt);
      if (hashCanonicalJson(receipts[0]) !== hashCanonicalJson(returnedReceipt)) {
        throw new Error("Returned Chapter commit receipt differs from the persisted receipt.");
      }
      const verified = await verifyProductionCommitEvidence({
        bookDir: state.bookDir(command.binding.bookId),
        command,
        productionAttempt,
        receipt: receipts[0]!,
        now: now(),
      });
      const run = await finalizeProductionRun(state.bookDir(command.binding.bookId), buildSucceededProductionRun({
        snapshot,
        evidence: verified.evidence,
        chapter: verified.chapter,
        projectionOrigin: "direct",
        now: now(),
      }));
      return { run, result, reused: false };
    } catch (error) {
      const receipts = await listChapterCommitReceiptsForAttempt(
        state.bookDir(command.binding.bookId),
        productionAttempt,
      );
      if (receipts.length > 1) {
        throw new AggregateError([error], "A write-next production attempt has multiple Chapter commit receipts.");
      }
      if (receipts[0]) {
        const verified = await verifyProductionCommitEvidence({
          bookDir: state.bookDir(command.binding.bookId),
          command,
          productionAttempt,
          receipt: receipts[0],
          allowSupersededCanon: true,
          now: now(),
        });
        const run = await finalizeProductionRun(state.bookDir(command.binding.bookId), buildSucceededProductionRun({
          snapshot,
          evidence: verified.evidence,
          chapter: verified.chapter,
          projectionOrigin: "reconciled",
          now: now(),
        }));
        return { run, reused: false };
      }
      const evidence = await verifyProductionNoCommit({
        bookDir: state.bookDir(command.binding.bookId),
        snapshot,
        error,
        now: now(),
      });
      const run = await finalizeProductionRun(state.bookDir(command.binding.bookId), buildNoCommitProductionRun({
        snapshot,
        evidence,
        executionStatus: isCancelled(error, input.signal) ? "cancelled" : "failed",
        projectionOrigin: "direct",
        now: now(),
      }));
      throw new ProductionExecutionTerminalError(run, error);
    }
  } finally {
    await releaseLock();
  }
}
