import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, normalize, posix, sep } from "node:path";
import { z } from "zod";
import { ChapterCommitReceiptSchema, listChapterCommitReceiptsForAttempt } from "../state/chapter-commit-receipt.js";
import { StateManager } from "../state/manager.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  HermesControlTaskGuidanceReferenceSchema,
  Sha256HexSchema,
  directionTextSha256,
  type HermesControlTaskGuidanceReference,
} from "./direction-context.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";
import { ProductionRunSchema, type ProductionRun } from "./run-projection.js";

const SafeIdSchema = z.string().trim().min(1).max(240).superRefine((value, ctx) => {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "identity must be one safe path segment" });
  }
});
const MAX_GUIDANCE_BYTES = 32 * 1024;

const ArtifactRefSchema = z.object({
  path: z.string().min(1).superRefine((value, ctx) => {
    const normalized = posix.normalize(value);
    if (posix.isAbsolute(value) || value.includes("\\") || normalized !== value || normalized === ".." || normalized.startsWith("../")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifact path must stay inside the Book" });
    }
  }),
  sha256: Sha256HexSchema,
  byteLength: z.number().int().positive(),
}).strict();
export type HermesControlArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const HermesControlActionSchema = z.object({
  schemaVersion: z.literal("hermes-control-action/v1"),
  action: z.literal("write-next"),
  workOrderId: SafeIdSchema,
  workOrderSha256: Sha256HexSchema,
  bookId: SafeIdSchema,
  sessionId: SafeIdSchema,
  guidance: z.string().min(1).superRefine((value, ctx) => {
    if (!value.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "guidance must contain non-whitespace text" });
    if (Buffer.byteLength(value, "utf8") > MAX_GUIDANCE_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `guidance must not exceed ${MAX_GUIDANCE_BYTES} UTF-8 bytes` });
    }
  }),
  guidanceSha256: Sha256HexSchema,
}).strict().superRefine((action, ctx) => {
  if (directionTextSha256(action.guidance) !== action.guidanceSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["guidanceSha256"], message: "guidance hash mismatch" });
  }
});
export type HermesControlAction = z.infer<typeof HermesControlActionSchema>;

const HermesProfileReceiptSchema = z.object({
  profileId: SafeIdSchema,
  soulId: SafeIdSchema,
  soulVersion: SafeIdSchema,
  configSha256: Sha256HexSchema,
  soulSha256: Sha256HexSchema,
}).strict();

export const HermesInvocationReceiptSchema = z.object({
  schemaVersion: z.literal("hermes-invocation-receipt/v1"),
  status: z.literal("completed"),
  workOrderId: SafeIdSchema,
  workOrderSha256: Sha256HexSchema,
  profile: HermesProfileReceiptSchema,
  runtime: z.object({
    provider: z.literal("openai-codex"),
    model: z.literal("gpt-5.6-sol"),
    reasoning: z.literal("high"),
    platform: z.literal("cli"),
    openaiRuntime: z.literal("auto"),
    transport: z.literal("codex_responses"),
    toolsCount: z.literal(0),
    toolCallCount: z.literal(0),
  }).strict(),
  invocation: z.object({
    sessionId: SafeIdSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    exitCode: z.literal(0),
  }).strict(),
  promptSha256: Sha256HexSchema,
  systemPrompt: z.object({
    sha256: Sha256HexSchema,
    byteLength: z.number().int().positive(),
  }).strict(),
  rawOutput: z.object({
    sha256: Sha256HexSchema,
    byteLength: z.number().int().positive(),
  }).strict(),
  action: z.object({
    sha256: Sha256HexSchema,
    byteLength: z.number().int().positive(),
    textSha256: Sha256HexSchema,
  }).strict(),
  sessionExport: z.object({
    sha256: Sha256HexSchema,
    byteLength: z.number().int().positive(),
  }).strict(),
  receiptSelfHash: Sha256HexSchema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "Hermes invocation receipt self hash mismatch" });
  }
  if (Date.parse(receipt.invocation.completedAt) < Date.parse(receipt.invocation.startedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["invocation", "completedAt"], message: "Hermes invocation completed before it started" });
  }
});
export type HermesInvocationReceipt = z.infer<typeof HermesInvocationReceiptSchema>;

export const HermesControlImportReceiptSchema = z.object({
  schemaVersion: z.literal("hermes-control-import/v1"),
  workOrderId: SafeIdSchema,
  workOrderSha256: Sha256HexSchema,
  bookId: SafeIdSchema,
  sessionId: SafeIdSchema,
  request: ArtifactRefSchema,
  action: ArtifactRefSchema,
  hermesReceipt: ArtifactRefSchema,
  taskGuidance: HermesControlTaskGuidanceReferenceSchema,
  importedAt: z.string().datetime(),
  receiptSelfHash: Sha256HexSchema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "Hermes control import receipt self hash mismatch" });
  }
});
export type HermesControlImportReceipt = z.infer<typeof HermesControlImportReceiptSchema>;

const AgentOperationTerminalBaseSchema = z.object({
  schemaVersion: z.literal("inkos-agent-operation-terminal/v1"),
  workOrderId: SafeIdSchema,
  workOrderSha256: Sha256HexSchema,
  bookId: SafeIdSchema,
  sessionId: SafeIdSchema,
  executionMode: z.enum(["promotion-canary", "production"]),
  importReceipt: ArtifactRefSchema,
  productionRun: ArtifactRefSchema.extend({
    commandId: z.string().uuid(),
    productionOperationId: z.string().uuid(),
    attemptId: z.string().uuid(),
  }).strict(),
  completedAt: z.string().datetime(),
  receiptSelfHash: Sha256HexSchema,
});

export const AgentOperationTerminalReceiptSchema = z.discriminatedUnion("status", [
  AgentOperationTerminalBaseSchema.extend({
    status: z.literal("succeeded"),
    chapterCommit: ArtifactRefSchema.extend({
      receiptId: z.string().uuid(),
      receiptSelfHash: Sha256HexSchema,
    }).strict(),
  }).strict(),
  AgentOperationTerminalBaseSchema.extend({
    status: z.enum(["failed", "cancelled"]),
    chapterCommit: z.null(),
  }).strict(),
]).superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "Agent operation terminal self hash mismatch" });
  }
});
export type AgentOperationTerminalReceipt = z.infer<typeof AgentOperationTerminalReceiptSchema>;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function operationRoot(workOrderId: string): string {
  return posix.join("story", "runtime", "hermes-control", SafeIdSchema.parse(workOrderId));
}

export function hermesControlOperationPaths(workOrderId: string): {
  readonly request: string;
  readonly action: string;
  readonly hermesReceipt: string;
  readonly importReceipt: string;
  readonly terminal: string;
} {
  const root = operationRoot(workOrderId);
  return {
    request: posix.join(root, "request.json"),
    action: posix.join(root, "action.json"),
    hermesReceipt: posix.join(root, "hermes-invocation.json"),
    importReceipt: posix.join(root, "import-receipt.json"),
    terminal: posix.join(root, "terminal.json"),
  };
}

async function readRegular(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Hermes control artifact is not a regular file: ${path}`);
  return readFile(path);
}

async function assertNoSymlinkAncestors(rootDir: string, relativePath: string): Promise<void> {
  const parts = normalize(relativePath).split(sep).filter(Boolean);
  let current = rootDir;
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Hermes control Book root must be a real directory.");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Hermes control artifact path contains a symlink: ${relativePath}`);
      if (index < parts.length - 1 && !info.isDirectory()) {
        throw new Error(`Hermes control artifact parent is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readVerifiedArtifact(bookDir: string, ref: HermesControlArtifactRef): Promise<Buffer> {
  const parsed = ArtifactRefSchema.parse({ path: ref.path, sha256: ref.sha256, byteLength: ref.byteLength });
  await assertNoSymlinkAncestors(bookDir, parsed.path);
  const bytes = await readRegular(join(bookDir, parsed.path));
  if (bytes.byteLength !== parsed.byteLength || sha256Bytes(bytes) !== parsed.sha256) {
    throw new Error(`Hermes control referenced artifact hash/length mismatch: ${parsed.path}`);
  }
  return bytes;
}

function artifactRef(path: string, bytes: Uint8Array): HermesControlArtifactRef {
  return ArtifactRefSchema.parse({ path, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength });
}

async function assertExistingBytes(bookDir: string, ref: HermesControlArtifactRef, expected: Uint8Array): Promise<void> {
  const stored = await readVerifiedArtifact(bookDir, ref);
  if (!stored.equals(Buffer.from(expected))) {
    throw new Error(`Immutable Hermes control artifact differs from the imported bytes: ${ref.path}`);
  }
}

async function verifyHermesControlImportEvidence(
  bookDir: string,
  imported: HermesControlImportReceipt,
): Promise<void> {
  const [requestBytes, actionBytes, hermesReceiptBytes] = await Promise.all([
    readVerifiedArtifact(bookDir, imported.request),
    readVerifiedArtifact(bookDir, imported.action),
    readVerifiedArtifact(bookDir, imported.hermesReceipt),
  ]);
  const action = HermesControlActionSchema.parse(JSON.parse(actionBytes.toString("utf8")));
  const hermesReceipt = HermesInvocationReceiptSchema.parse(JSON.parse(hermesReceiptBytes.toString("utf8")));
  if (
    imported.request.sha256 !== imported.workOrderSha256
    || sha256Bytes(requestBytes) !== imported.workOrderSha256
    || action.workOrderId !== imported.workOrderId
    || action.workOrderSha256 !== imported.workOrderSha256
    || action.bookId !== imported.bookId
    || action.sessionId !== imported.sessionId
    || hashCanonicalJson(imported.taskGuidance.actionRef) !== hashCanonicalJson(imported.action)
    || imported.taskGuidance.bookId !== imported.bookId
    || imported.taskGuidance.workOrderId !== imported.workOrderId
    || imported.taskGuidance.textSha256 !== action.guidanceSha256
    || hermesReceipt.workOrderId !== imported.workOrderId
    || hermesReceipt.workOrderSha256 !== imported.workOrderSha256
    || hermesReceipt.action.sha256 !== imported.action.sha256
    || hermesReceipt.action.byteLength !== imported.action.byteLength
    || hermesReceipt.action.textSha256 !== action.guidanceSha256
  ) throw new Error("Hermes control import receipt children are not exactly cross-bound.");
}

function assertProductionRunMatchesHermesImport(
  run: ProductionRun,
  imported: HermesControlImportReceipt,
): void {
  if (
    run.command.schemaVersion !== "production-command/v2"
    || run.command.authorization.kind !== "authenticated-orchestrator"
    || run.command.binding.bookId !== imported.bookId
    || run.command.binding.sessionId !== imported.sessionId
    || run.command.binding.workOrderId !== imported.workOrderId
    || run.command.authorization.workOrderId !== imported.workOrderId
    || run.command.authorization.workOrderSha256 !== imported.workOrderSha256
    || !run.command.args.taskGuidance
    || hashCanonicalJson(run.command.args.taskGuidance) !== hashCanonicalJson(imported.taskGuidance)
  ) throw new Error("Production run is not exactly bound to the imported Hermes control evidence.");
}

export async function importHermesControlOperation(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly sessionId: string;
  readonly workOrderId: string;
  readonly workOrderSha256: string;
  readonly workOrderBytes: Uint8Array;
  readonly actionBytes: Uint8Array;
  readonly hermesReceiptBytes: Uint8Array;
  readonly profile: {
    readonly profileId: string;
    readonly soulId: string;
    readonly soulVersion: string;
    readonly profileConfigSha256: string;
    readonly soulSha256: string;
  };
  readonly importedAt?: Date;
}): Promise<{
  readonly action: HermesControlAction;
  readonly hermesReceipt: HermesInvocationReceipt;
  readonly importReceipt: HermesControlImportReceipt;
  readonly taskGuidance: HermesControlTaskGuidanceReference;
}> {
  const state = new StateManager(input.projectRoot);
  const book = await state.loadBookConfig(input.bookId);
  if (book.id !== input.bookId) throw new Error("Hermes control operation Book config mismatch.");
  if (sha256Bytes(input.workOrderBytes) !== input.workOrderSha256) throw new Error("Hermes control WorkOrder byte hash mismatch.");
  const action = HermesControlActionSchema.parse(JSON.parse(Buffer.from(input.actionBytes).toString("utf8")));
  const hermesReceipt = HermesInvocationReceiptSchema.parse(JSON.parse(Buffer.from(input.hermesReceiptBytes).toString("utf8")));
  const actionSha256 = sha256Bytes(input.actionBytes);
  if (
    action.workOrderId !== input.workOrderId
    || action.workOrderSha256 !== input.workOrderSha256
    || action.bookId !== input.bookId
    || action.sessionId !== input.sessionId
    || hermesReceipt.workOrderId !== input.workOrderId
    || hermesReceipt.workOrderSha256 !== input.workOrderSha256
    || hermesReceipt.action.sha256 !== actionSha256
    || hermesReceipt.action.byteLength !== input.actionBytes.byteLength
    || hermesReceipt.action.textSha256 !== action.guidanceSha256
  ) throw new Error("Hermes control action/receipt does not match the exact WorkOrder.");
  if (
    hermesReceipt.profile.profileId !== input.profile.profileId
    || hermesReceipt.profile.soulId !== input.profile.soulId
    || hermesReceipt.profile.soulVersion !== input.profile.soulVersion
    || hermesReceipt.profile.configSha256 !== input.profile.profileConfigSha256
    || hermesReceipt.profile.soulSha256 !== input.profile.soulSha256
  ) throw new Error("Hermes invocation profile does not match the owner-approved mode evidence.");

  const paths = hermesControlOperationPaths(input.workOrderId);
  const requestRef = artifactRef(paths.request, input.workOrderBytes);
  const actionRef = artifactRef(paths.action, input.actionBytes);
  const hermesReceiptRef = artifactRef(paths.hermesReceipt, input.hermesReceiptBytes);
  const taskGuidance = HermesControlTaskGuidanceReferenceSchema.parse({
    source: "hermes-control-action",
    bookId: input.bookId,
    workOrderId: input.workOrderId,
    actionRef,
    textSha256: action.guidanceSha256,
  });
  const importedAt = (input.importedAt ?? new Date()).toISOString();
  const unsigned = {
    schemaVersion: "hermes-control-import/v1" as const,
    workOrderId: input.workOrderId,
    workOrderSha256: input.workOrderSha256,
    bookId: input.bookId,
    sessionId: input.sessionId,
    request: requestRef,
    action: actionRef,
    hermesReceipt: hermesReceiptRef,
    taskGuidance,
    importedAt,
  };
  const importReceipt = HermesControlImportReceiptSchema.parse({
    ...unsigned,
    receiptSelfHash: hashCanonicalJson(unsigned),
  });
  const importBytes = Buffer.from(`${JSON.stringify(importReceipt, null, 2)}\n`, "utf8");
  const release = await state.acquireBookLock(input.bookId);
  try {
    await Promise.all([
      assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.request),
      assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.action),
      assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.hermesReceipt),
      assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.importReceipt),
    ]);
    let existingImport: Buffer | undefined;
    try {
      existingImport = await readRegular(join(state.bookDir(input.bookId), paths.importReceipt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existingImport) {
      const existing = HermesControlImportReceiptSchema.parse(JSON.parse(existingImport.toString("utf8")));
      if (
        existing.workOrderId !== input.workOrderId
        || existing.workOrderSha256 !== input.workOrderSha256
        || existing.bookId !== input.bookId
        || existing.sessionId !== input.sessionId
        || hashCanonicalJson(existing.request) !== hashCanonicalJson(requestRef)
        || hashCanonicalJson(existing.action) !== hashCanonicalJson(actionRef)
        || hashCanonicalJson(existing.hermesReceipt) !== hashCanonicalJson(hermesReceiptRef)
        || hashCanonicalJson(existing.taskGuidance) !== hashCanonicalJson(taskGuidance)
      ) throw new Error("Hermes control WorkOrder was already imported with different immutable evidence.");
      await Promise.all([
        assertExistingBytes(state.bookDir(input.bookId), existing.request, input.workOrderBytes),
        assertExistingBytes(state.bookDir(input.bookId), existing.action, input.actionBytes),
        assertExistingBytes(state.bookDir(input.bookId), existing.hermesReceipt, input.hermesReceiptBytes),
      ]);
      return { action, hermesReceipt, importReceipt: existing, taskGuidance: existing.taskGuidance };
    }
    for (const relativePath of [paths.request, paths.action, paths.hermesReceipt]) {
      try {
        await lstat(join(state.bookDir(input.bookId), relativePath));
        throw new Error(`Hermes control artifact exists without its immutable import receipt: ${relativePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await commitAtomicFileSet({
      rootDir: state.bookDir(input.bookId),
      writes: [
        { relativePath: paths.request, content: input.workOrderBytes },
        { relativePath: paths.action, content: input.actionBytes },
        { relativePath: paths.hermesReceipt, content: input.hermesReceiptBytes },
        { relativePath: paths.importReceipt, content: importBytes },
      ],
    });
    await Promise.all([
      assertExistingBytes(state.bookDir(input.bookId), requestRef, input.workOrderBytes),
      assertExistingBytes(state.bookDir(input.bookId), actionRef, input.actionBytes),
      assertExistingBytes(state.bookDir(input.bookId), hermesReceiptRef, input.hermesReceiptBytes),
      assertExistingBytes(state.bookDir(input.bookId), artifactRef(paths.importReceipt, importBytes), importBytes),
    ]);
    return { action, hermesReceipt, importReceipt, taskGuidance };
  } finally {
    await release();
  }
}

export async function loadAgentOperationTerminal(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly workOrderId: string;
}): Promise<AgentOperationTerminalReceipt | undefined> {
  const state = new StateManager(input.projectRoot);
  const bookDir = state.bookDir(input.bookId);
  const terminalPath = hermesControlOperationPaths(input.workOrderId).terminal;
  await assertNoSymlinkAncestors(bookDir, terminalPath);
  let terminalBytes: Buffer;
  try {
    terminalBytes = await readRegular(join(bookDir, terminalPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const terminal = AgentOperationTerminalReceiptSchema.parse(JSON.parse(terminalBytes.toString("utf8")));
  if (terminal.bookId !== input.bookId || terminal.workOrderId !== input.workOrderId) {
    throw new Error("Agent operation terminal identity does not match its Book-local path.");
  }
  const [importBytes, runBytes] = await Promise.all([
    readVerifiedArtifact(bookDir, terminal.importReceipt),
    readVerifiedArtifact(bookDir, terminal.productionRun),
  ]);
  const imported = HermesControlImportReceiptSchema.parse(JSON.parse(importBytes.toString("utf8")));
  const run = ProductionRunSchema.parse(JSON.parse(runBytes.toString("utf8")));
  await verifyHermesControlImportEvidence(bookDir, imported);
  assertProductionRunMatchesHermesImport(run, imported);
  if (
    imported.workOrderId !== terminal.workOrderId
    || imported.workOrderSha256 !== terminal.workOrderSha256
    || imported.bookId !== terminal.bookId
    || imported.sessionId !== terminal.sessionId
    || run.command.binding.bookId !== terminal.bookId
    || run.command.binding.sessionId !== terminal.sessionId
    || run.command.binding.workOrderId !== terminal.workOrderId
    || run.command.commandId !== terminal.productionRun.commandId
    || run.productionAttempt.productionOperationId !== terminal.productionRun.productionOperationId
    || run.productionAttempt.attemptId !== terminal.productionRun.attemptId
  ) throw new Error("Agent operation terminal referenced evidence is cross-bound incorrectly.");
  if (terminal.status === "succeeded") {
    if (
      run.executionStatus !== "succeeded"
      || run.completionHealth !== "verified"
      || run.evidence.kind !== "verified-commit"
    ) {
      throw new Error("Successful Agent operation terminal references a non-success production run.");
    }
    const chapterBytes = await readVerifiedArtifact(bookDir, terminal.chapterCommit);
    const chapter = ChapterCommitReceiptSchema.parse(JSON.parse(chapterBytes.toString("utf8")));
    const receipts = await listChapterCommitReceiptsForAttempt(bookDir, run.productionAttempt);
    if (
      receipts.length !== 1
      || hashCanonicalJson(receipts[0]) !== hashCanonicalJson(chapter)
      || run.evidence.receiptFile.path !== terminal.chapterCommit.path
      || run.evidence.receiptFile.sha256 !== terminal.chapterCommit.sha256
      || chapter.receiptId !== terminal.chapterCommit.receiptId
      || chapter.receiptSelfHash !== terminal.chapterCommit.receiptSelfHash
      || chapter.productionOperationId !== terminal.productionRun.productionOperationId
      || chapter.attemptId !== terminal.productionRun.attemptId
      || chapter.commitState !== "verified"
    ) throw new Error("Agent operation terminal Chapter commit evidence is invalid.");
  } else if (run.executionStatus !== terminal.status) {
    throw new Error("Failed Agent operation terminal status does not match its production run.");
  }
  return terminal;
}

export async function finalizeAgentOperation(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly sessionId: string;
  readonly workOrderId: string;
  readonly workOrderSha256: string;
  readonly executionMode: "promotion-canary" | "production";
  readonly importReceipt: HermesControlImportReceipt;
  readonly productionRun: ProductionRun;
  readonly completedAt?: Date;
}): Promise<AgentOperationTerminalReceipt> {
  const state = new StateManager(input.projectRoot);
  const run = ProductionRunSchema.parse(input.productionRun);
  if (
    run.command.binding.bookId !== input.bookId
    || run.command.binding.sessionId !== input.sessionId
    || run.command.binding.workOrderId !== input.workOrderId
  ) {
    throw new Error("Production run does not belong to the Hermes control WorkOrder.");
  }
  const paths = hermesControlOperationPaths(input.workOrderId);
  const runPath = posix.join("story", "runtime", "production-runs", "terminals", `${run.command.commandId}.json`);
  await Promise.all([
    assertNoSymlinkAncestors(state.bookDir(input.bookId), runPath),
    assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.importReceipt),
  ]);
  const runBytes = await readRegular(join(state.bookDir(input.bookId), runPath));
  if (hashCanonicalJson(JSON.parse(runBytes.toString("utf8"))) !== hashCanonicalJson(run)) {
    throw new Error("Persisted production run differs from the Hermes control result.");
  }
  const importBytes = await readRegular(join(state.bookDir(input.bookId), paths.importReceipt));
  const importRef = artifactRef(paths.importReceipt, importBytes);
  const storedImport = HermesControlImportReceiptSchema.parse(JSON.parse(importBytes.toString("utf8")));
  if (
    storedImport.receiptSelfHash !== input.importReceipt.receiptSelfHash
    || storedImport.workOrderId !== input.workOrderId
    || storedImport.workOrderSha256 !== input.workOrderSha256
    || storedImport.bookId !== input.bookId
    || storedImport.sessionId !== input.sessionId
  ) throw new Error("Agent operation import receipt does not match the persisted Hermes control evidence.");
  await verifyHermesControlImportEvidence(state.bookDir(input.bookId), storedImport);
  assertProductionRunMatchesHermesImport(run, storedImport);
  const assertReplayMatches = (existing: AgentOperationTerminalReceipt): AgentOperationTerminalReceipt => {
    if (
      existing.workOrderSha256 !== input.workOrderSha256
      || existing.bookId !== input.bookId
      || existing.sessionId !== input.sessionId
      || existing.executionMode !== input.executionMode
      || existing.importReceipt.sha256 !== importRef.sha256
      || existing.importReceipt.byteLength !== importRef.byteLength
      || existing.productionRun.commandId !== run.command.commandId
      || existing.productionRun.productionOperationId !== run.productionAttempt.productionOperationId
      || existing.productionRun.attemptId !== run.productionAttempt.attemptId
      || existing.productionRun.sha256 !== sha256Bytes(runBytes)
    ) throw new Error("Immutable Agent operation terminal does not match the replayed production evidence.");
    return existing;
  };
  const preexisting = await loadAgentOperationTerminal(input);
  if (preexisting) return assertReplayMatches(preexisting);
  const base = {
    schemaVersion: "inkos-agent-operation-terminal/v1" as const,
    workOrderId: input.workOrderId,
    workOrderSha256: input.workOrderSha256,
    bookId: input.bookId,
    sessionId: input.sessionId,
    executionMode: input.executionMode,
    importReceipt: importRef,
    productionRun: {
      ...artifactRef(runPath, runBytes),
      commandId: run.command.commandId,
      productionOperationId: run.productionAttempt.productionOperationId,
      attemptId: run.productionAttempt.attemptId,
    },
    completedAt: (input.completedAt ?? new Date()).toISOString(),
  };
  let unsigned: Omit<AgentOperationTerminalReceipt, "receiptSelfHash">;
  if (run.executionStatus === "succeeded") {
    const receipts = await listChapterCommitReceiptsForAttempt(state.bookDir(input.bookId), run.productionAttempt);
    if (receipts.length !== 1) throw new Error("Successful Agent operation requires exactly one Chapter commit receipt.");
    const receipt = ChapterCommitReceiptSchema.parse(receipts[0]);
    if (receipt.commitState !== "verified" || run.completionHealth !== "verified" || run.evidence.kind !== "verified-commit") {
      throw new Error("Successful Agent operation requires a fully verified Chapter commit terminal.");
    }
    await assertNoSymlinkAncestors(state.bookDir(input.bookId), run.evidence.receiptFile.path);
    const receiptBytes = await readRegular(join(state.bookDir(input.bookId), run.evidence.receiptFile.path));
    unsigned = {
      ...base,
      status: "succeeded",
      chapterCommit: {
        ...artifactRef(run.evidence.receiptFile.path, receiptBytes),
        receiptId: receipt.receiptId,
        receiptSelfHash: receipt.receiptSelfHash,
      },
    };
  } else {
    unsigned = {
      ...base,
      status: run.executionStatus === "cancelled" ? "cancelled" : "failed",
      chapterCommit: null,
    };
  }
  const terminal = AgentOperationTerminalReceiptSchema.parse({
    ...unsigned,
    receiptSelfHash: hashCanonicalJson(unsigned),
  });
  const terminalBytes = Buffer.from(`${JSON.stringify(terminal, null, 2)}\n`, "utf8");
  const release = await state.acquireBookLock(input.bookId);
  try {
    await assertNoSymlinkAncestors(state.bookDir(input.bookId), paths.terminal);
    const existing = await loadAgentOperationTerminal(input);
    if (existing) {
      return assertReplayMatches(existing);
    }
    await commitAtomicFileSet({
      rootDir: state.bookDir(input.bookId),
      writes: [{ relativePath: paths.terminal, content: terminalBytes }],
    });
    const stored = await loadAgentOperationTerminal(input);
    if (!stored || stored.receiptSelfHash !== terminal.receiptSelfHash) {
      throw new Error("Agent operation terminal readback failed.");
    }
    return stored;
  } finally {
    await release();
  }
}
