import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../models/chapter.js";
import type { ChapterPipelineResult } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import {
  writeChapterCommitReceipt,
  type ChapterCommitReceipt,
} from "../state/chapter-commit-receipt.js";
import { captureChapterPersistenceFingerprint } from "../state/chapter-persistence-journal.js";
import { createProductionAttemptIdentity, type ProductionAttemptIdentity } from "../production/attempt-identity.js";
import {
  beginFictionContentOperation,
  prepareFictionContentInvocation,
  sealFictionContentOperationManifest,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";
import { createDetachedOwnerDirectionLease } from "../production/detached-payload-store.js";
import {
  ProductionExecutionContextSchema,
  currentProductionExecutionContext,
} from "../production/execution-context.js";
import {
  createWriteNextProductionCommand,
  type ProductionCommand,
  type ProductionCommandBinding,
} from "../production/production-command.js";
import {
  ProductionExecutionTerminalError,
  executeObserveOnlyWriteNext,
} from "../production/production-kernel.js";
import {
  createProductionRunSnapshot,
  loadProductionRunByCommandId,
  loadProductionRunSnapshotByCommandId,
  saveProductionRunSnapshot,
} from "../production/run-projection.js";

const roots: string[] = [];
const NOW = new Date("2026-08-28T01:00:00.000Z");
const OWNER_DIRECTION = "다음 화에서 인수전의 첫 승리를 보여 줘.";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(suffix: string): Promise<{
  readonly root: string;
  readonly bookId: string;
  readonly bookDir: string;
  readonly state: StateManager;
  readonly binding: ProductionCommandBinding;
  readonly command: ProductionCommand;
}> {
  const root = await mkdtemp(join(tmpdir(), `inkos-production-kernel-${suffix}-`));
  roots.push(root);
  const bookId = `phase3-${suffix}`;
  const state = new StateManager(root);
  await state.saveBookConfig(bookId, {
    id: bookId,
    title: "Phase 3",
    platform: "other",
    genre: "urban-fantasy",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await state.saveChapterIndex(bookId, []);
  await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
  await writeFile(join(state.bookDir(bookId), "story", "current_state.md"), "before\n", "utf8");
  const ownerDirection = await createDetachedOwnerDirectionLease({
    projectRoot: root,
    receiptId: `request-${suffix}`,
    text: OWNER_DIRECTION,
    now: NOW,
  });
  const binding: ProductionCommandBinding = {
    bookId,
    sessionId: `session-${suffix}`,
    requestId: `request-${suffix}`,
  };
  const command = createWriteNextProductionCommand({
    idempotencyKey: `idempotency-${suffix}`,
    source: "test",
    actionSource: "quick-action",
    binding,
    ownerDirection,
    now: NOW,
  });
  return { root, bookId, bookDir: state.bookDir(bookId), state, binding, command };
}

async function persistCommittedChapter(input: {
  readonly root: string;
  readonly bookId: string;
  readonly bookDir: string;
  readonly productionAttempt: ProductionAttemptIdentity;
}): Promise<ChapterPipelineResult> {
  const operation = await beginFictionContentOperation({
    projectRoot: input.root,
    bookId: input.bookId,
    operationKind: "write-next-chapter",
    chapterNumber: 1,
    requiredStages: ["writer"],
    productionAttempt: input.productionAttempt,
    now: () => NOW,
  });
  const prepared = await prepareFictionContentInvocation({
    projectRoot: input.root,
    bookId: input.bookId,
    agentName: "writer",
    stage: "writer",
    model: "test-model",
    operationId: operation.operationId,
    productionAttempt: input.productionAttempt,
    messages: [
      { role: "system", content: "write" },
      { role: "user", content: OWNER_DIRECTION },
    ],
    now: () => NOW,
  });
  await writeFictionContentInvocationOutcome({
    projectRoot: input.root,
    prepared,
    output: "completed",
    now: () => NOW,
  });
  const manifest = await sealFictionContentOperationManifest({
    projectRoot: input.root,
    operation,
    now: () => NOW,
  });
  const chapter: ChapterMeta = {
    number: 1,
    title: "첫 인수전",
    status: "ready-for-review",
    wordCount: 1800,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    auditIssues: [],
    lengthWarnings: [],
  };
  await Promise.all([
    mkdir(join(input.bookDir, "chapters"), { recursive: true }),
    mkdir(join(input.bookDir, "story"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(input.bookDir, "chapters", "0001_첫-인수전.md"), "# 1화 첫 인수전\n\n본문\n", "utf8"),
    writeFile(join(input.bookDir, "chapters", "index.json"), `${JSON.stringify([chapter], null, 2)}\n`, "utf8"),
    writeFile(join(input.bookDir, "story", "current_state.md"), "after chapter 1\n", "utf8"),
  ]);
  const chapterCommitReceipt: ChapterCommitReceipt = await writeChapterCommitReceipt({
    bookDir: input.bookDir,
    bookId: input.bookId,
    chapterNumber: 1,
    capability: "write-next-chapter",
    productionAttempt: input.productionAttempt,
    operationManifests: [manifest],
    now: () => NOW,
  });
  return {
    chapterNumber: 1,
    title: chapter.title,
    wordCount: chapter.wordCount,
    auditResult: { passed: true, issues: [], summary: "ok" },
    revised: false,
    status: "ready-for-review",
    productionAttempt: input.productionAttempt,
    chapterCommitReceipt,
  };
}

function executor(f: Awaited<ReturnType<typeof fixture>>, call?: () => void) {
  return async (input: {
    readonly productionAttempt: ProductionAttemptIdentity;
  }): Promise<ChapterPipelineResult> => {
    call?.();
    return persistCommittedChapter({
      root: f.root,
      bookId: f.bookId,
      bookDir: f.bookDir,
      productionAttempt: input.productionAttempt,
    });
  };
}

describe("Phase 3 production command authority", () => {
  it("keeps free text proposal-only and rejects command tampering", async () => {
    const f = await fixture("authority");
    expect(() => createWriteNextProductionCommand({
      idempotencyKey: "bad",
      source: "test",
      actionSource: "free-text",
      binding: f.binding,
      ownerDirection: f.command.authorization.ownerDirection,
      now: NOW,
    })).toThrow(/proposal-only/i);

    const skillCommand = createWriteNextProductionCommand({
      idempotencyKey: "premature-skill",
      source: "test",
      actionSource: "quick-action",
      binding: f.binding,
      ownerDirection: f.command.authorization.ownerDirection,
      activatedSkills: ["inkos-long-writing"],
      now: NOW,
    });
    expect(skillCommand.activatedSkills).toEqual(["inkos-long-writing"]);

    const tampered = structuredClone(f.command);
    tampered.args.ownerDirectionTextSha256 = "0".repeat(64);
    await expect(executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: tampered,
      currentBinding: f.binding,
      executeWithinBookLock: executor(f),
      now: () => NOW,
    })).rejects.toThrow();
  });
});

describe("Phase 3 observe-only write-next kernel", () => {
  it("keeps legacy and observe canon bytes equal while invoking the writer once", async () => {
    const observed = await fixture("parity-observed");
    const legacy = await fixture("parity-legacy");
    let observeCalls = 0;
    await executeObserveOnlyWriteNext({
      projectRoot: observed.root,
      kernelMode: "observe",
      persistedCommand: observed.command,
      currentBinding: observed.binding,
      executeWithinBookLock: executor(observed, () => { observeCalls += 1; }),
      now: () => NOW,
    });
    let legacyCalls = 0;
    const release = await legacy.state.acquireBookLock(legacy.bookId);
    try {
      await legacy.state.getNextChapterNumber(legacy.bookId);
      legacyCalls += 1;
      await persistCommittedChapter({
        root: legacy.root,
        bookId: legacy.bookId,
        bookDir: legacy.bookDir,
        productionAttempt: createProductionAttemptIdentity(),
      });
    } finally {
      await release();
    }
    expect(observeCalls).toBe(1);
    expect(legacyCalls).toBe(1);
    for (const relativePath of [
      join("chapters", "0001_첫-인수전.md"),
      join("chapters", "index.json"),
      join("story", "current_state.md"),
    ]) {
      await expect(readFile(join(observed.bookDir, relativePath)))
        .resolves.toEqual(await readFile(join(legacy.bookDir, relativePath)));
    }
  });

  it("projects one successful call, propagates context, and reuses its terminal without a second call", async () => {
    const f = await fixture("success");
    let calls = 0;
    const execute = executor(f, () => {
      calls += 1;
      expect(currentProductionExecutionContext()).toMatchObject({
        commandId: f.command.commandId,
        binding: f.binding,
      });
    });

    const first = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    });
    expect(first.run).toMatchObject({
      executionStatus: "succeeded",
      completionHealth: "verified",
      approvalStatus: "pending",
      projectionOrigin: "direct",
      chapter: { chapterNumber: 1, title: "첫 인수전" },
      context: {
        activatedSkills: ["inkos-long-writing"],
        productionInputs: {
          soul: null,
          externalContextSha256: f.command.args.ownerDirectionTextSha256,
          skills: [expect.objectContaining({
            id: "inkos-long-writing",
            namespace: "trusted-builtin",
          })],
        },
      },
    });
    expect(first.reused).toBe(false);
    expect(first.run.evidence).toMatchObject({
      kind: "verified-commit",
      receiptFile: expect.objectContaining({ path: expect.stringContaining("chapter-commits") }),
    });
    expect(first.run.evidence).not.toHaveProperty("receipt");
    expect(calls).toBe(1);
    await expect(loadProductionRunSnapshotByCommandId(f.bookDir, f.command.commandId)).resolves.toBeUndefined();
    await expect(loadProductionRunByCommandId(f.bookDir, f.command.commandId)).resolves.toEqual(first.run);

    const second = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    });
    expect(second.reused).toBe(true);
    expect(second.run).toEqual(first.run);
    expect(calls).toBe(1);

    const retryLease = await createDetachedOwnerDirectionLease({
      projectRoot: f.root,
      receiptId: f.binding.requestId,
      text: "다음 화에서 인수전의 첫 승리를 보여 줘.",
      now: NOW,
    });
    const reconstructedRetry = createWriteNextProductionCommand({
      idempotencyKey: f.command.idempotencyKey,
      source: "test",
      actionSource: "quick-action",
      binding: f.binding,
      ownerDirection: retryLease,
      activatedSkills: f.command.activatedSkills,
      now: NOW,
    });
    expect(reconstructedRetry.intentDigest).toBe(f.command.intentDigest);
    const reconstructed = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: reconstructedRetry,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    });
    expect(reconstructed.reused).toBe(true);
    expect(reconstructed.run).toEqual(first.run);
    expect(calls).toBe(1);

    const changedIntent = createWriteNextProductionCommand({
      idempotencyKey: f.command.idempotencyKey,
      source: "test",
      actionSource: "quick-action",
      binding: f.binding,
      ownerDirection: f.command.authorization.ownerDirection,
      targetLength: { count: 2200, unit: "ko-chars" },
      activatedSkills: f.command.activatedSkills,
      now: NOW,
    });
    await expect(executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: changedIntent,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    })).rejects.toThrow(/different intent digest/i);
    expect(calls).toBe(1);
  });

  it("persists verified failed and cancelled no-commit terminals", async () => {
    const failed = await fixture("failed");
    let failedError: unknown;
    try {
      await executeObserveOnlyWriteNext({
        projectRoot: failed.root,
        kernelMode: "observe",
        persistedCommand: failed.command,
        currentBinding: failed.binding,
        executeWithinBookLock: async () => { throw new Error("provider failed"); },
        now: () => NOW,
      });
    } catch (error) {
      failedError = error;
    }
    expect(failedError).toBeInstanceOf(ProductionExecutionTerminalError);
    const failedRun = (failedError as ProductionExecutionTerminalError).run;
    expect(failedRun.executionStatus).toBe("failed");
    expect(failedRun.evidence.kind).toBe("verified-no-commit");
    if (failedRun.evidence.kind === "verified-no-commit") {
      expect(await captureChapterPersistenceFingerprint(failed.bookDir, 1))
        .toEqual(failedRun.evidence.canonicalBaseline);
    }

    const cancelled = await fixture("cancelled");
    const controller = new AbortController();
    let cancelledError: unknown;
    try {
      await executeObserveOnlyWriteNext({
        projectRoot: cancelled.root,
        kernelMode: "observe",
        persistedCommand: cancelled.command,
        currentBinding: cancelled.binding,
        signal: controller.signal,
        executeWithinBookLock: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
        now: () => NOW,
      });
    } catch (error) {
      cancelledError = error;
    }
    expect(cancelledError).toBeInstanceOf(ProductionExecutionTerminalError);
    expect((cancelledError as ProductionExecutionTerminalError).run.executionStatus).toBe("cancelled");
  });

  it("treats an error after the Chapter receipt as success instead of retrying canon", async () => {
    const f = await fixture("post-commit");
    let calls = 0;
    const result = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: async ({ productionAttempt }) => {
        calls += 1;
        await persistCommittedChapter({ ...f, productionAttempt });
        throw new Error("notification failed after commit");
      },
      now: () => NOW,
    });
    expect(result.run.executionStatus).toBe("succeeded");
    expect(result.run.projectionOrigin).toBe("reconciled");
    expect(result.result).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("reconciles a crash-after-commit snapshot without invoking the writer again", async () => {
    const f = await fixture("orphan-commit");
    const productionAttempt = createProductionAttemptIdentity();
    const context = ProductionExecutionContextSchema.parse({
      schemaVersion: "production-execution-context/v1",
      commandId: f.command.commandId,
      commandSha256: f.command.commandSelfHash,
      productionOperationId: productionAttempt.productionOperationId,
      attemptId: productionAttempt.attemptId,
      intentDigest: f.command.intentDigest,
      capability: f.command.capability,
      mode: "observe",
      source: f.command.source,
      actionSource: f.command.authorization.actionSource,
      binding: f.command.binding,
      activatedSkills: f.command.activatedSkills,
      startedAt: NOW.toISOString(),
    });
    const release = await f.state.acquireBookLock(f.bookId);
    try {
      const baseline = await captureChapterPersistenceFingerprint(f.bookDir, 1);
      await saveProductionRunSnapshot(f.bookDir, createProductionRunSnapshot({
        command: f.command,
        productionAttempt,
        context,
        executionStatus: "running",
        canonicalBaseline: baseline,
        now: NOW,
      }));
      await persistCommittedChapter({ ...f, productionAttempt });
    } finally {
      await release();
    }

    const execute = vi.fn(async () => { throw new Error("writer must not rerun"); });
    const result = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    });
    expect(result.run).toMatchObject({ executionStatus: "succeeded", projectionOrigin: "reconciled" });
    expect(result.reused).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reconciles an abandoned no-commit snapshot as failed without invoking the writer", async () => {
    const f = await fixture("orphan-empty");
    const productionAttempt = createProductionAttemptIdentity();
    const context = ProductionExecutionContextSchema.parse({
      schemaVersion: "production-execution-context/v1",
      commandId: f.command.commandId,
      commandSha256: f.command.commandSelfHash,
      productionOperationId: productionAttempt.productionOperationId,
      attemptId: productionAttempt.attemptId,
      intentDigest: f.command.intentDigest,
      capability: f.command.capability,
      mode: "observe",
      source: f.command.source,
      actionSource: f.command.authorization.actionSource,
      binding: f.command.binding,
      activatedSkills: f.command.activatedSkills,
      startedAt: NOW.toISOString(),
    });
    const release = await f.state.acquireBookLock(f.bookId);
    try {
      await saveProductionRunSnapshot(f.bookDir, createProductionRunSnapshot({
        command: f.command,
        productionAttempt,
        context,
        executionStatus: "preparing",
        canonicalBaseline: await captureChapterPersistenceFingerprint(f.bookDir, 1),
        now: NOW,
      }));
    } finally {
      await release();
    }
    const execute = vi.fn(async () => { throw new Error("writer must not rerun"); });
    const result = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: execute,
      now: () => NOW,
    });
    expect(result.run).toMatchObject({ executionStatus: "failed", projectionOrigin: "reconciled" });
    expect(result.reused).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps off as the compatibility default and fails closed on premature enforce", async () => {
    const f = await fixture("flags");
    for (const kernelMode of ["off", "enforce"] as const) {
      await expect(executeObserveOnlyWriteNext({
        projectRoot: f.root,
        kernelMode,
        persistedCommand: f.command,
        currentBinding: f.binding,
        executeWithinBookLock: executor(f),
        now: () => NOW,
      })).rejects.toThrow();
    }
  });

  it("refuses a symlinked projection ancestor before writing through it", async () => {
    const f = await fixture("projection-symlink");
    const outside = await mkdtemp(join(tmpdir(), "inkos-phase3-outside-"));
    roots.push(outside);
    await symlink(outside, join(f.bookDir, "story", "runtime"), "dir");
    await expect(executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "observe",
      persistedCommand: f.command,
      currentBinding: f.binding,
      executeWithinBookLock: executor(f),
      now: () => NOW,
    })).rejects.toThrow(/real Book-local directory/i);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
