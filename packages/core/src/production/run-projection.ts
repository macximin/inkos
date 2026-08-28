import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { ChapterMetaSchema, ChapterStatusSchema } from "../models/chapter.js";
import {
  ChapterCommitReceiptSchema,
  chapterCommitReceiptRelativePath,
  type ChapterCommitReceipt,
} from "../state/chapter-commit-receipt.js";
import {
  captureChapterPersistenceFingerprint,
  type ChapterPersistenceFingerprint,
} from "../state/chapter-persistence-journal.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { ProductionAttemptIdentitySchema, type ProductionAttemptIdentity } from "./attempt-identity.js";
import { Sha256HexSchema } from "./direction-context.js";
import { ProductionExecutionContextSchema, type ProductionExecutionContext } from "./execution-context.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";
import { ProductionCommandSchema, productionCommandActionSource, type ProductionCommand } from "./production-command.js";

const RUN_ROOT = join("story", "runtime", "production-runs");
const SNAPSHOT_DIR = join(RUN_ROOT, "snapshots");
const TERMINAL_DIR = join(RUN_ROOT, "terminals");

const ArtifactRefSchema = z.object({
  path: z.string().min(1).superRefine((path, ctx) => {
    const normalized = normalize(path);
    if (isAbsolute(path) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "artifact path must stay inside the Book" });
    }
  }),
  sha256: Sha256HexSchema,
}).strict();
export type ProductionArtifactRef = z.infer<typeof ArtifactRefSchema>;

const ChapterPersistenceFingerprintSchema = z.object({
  chapterNumber: z.number().int().positive(),
  artifacts: z.array(ArtifactRefSchema),
  fingerprintSha256: Sha256HexSchema,
}).strict().superRefine((fingerprint, ctx) => {
  const paths = fingerprint.artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: "fingerprint paths must be unique" });
  }
  if ([...paths].sort().some((path, index) => path !== paths[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["artifacts"], message: "fingerprint paths must be sorted" });
  }
  if (fingerprintSha256(fingerprint.artifacts) !== fingerprint.fingerprintSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fingerprintSha256"], message: "canon fingerprint hash mismatch" });
  }
});

const ProductionRunSnapshotUnsignedSchema = z.object({
  schemaVersion: z.literal("production-run-snapshot/v1"),
  command: ProductionCommandSchema,
  commandSha256: Sha256HexSchema,
  productionAttempt: ProductionAttemptIdentitySchema,
  context: ProductionExecutionContextSchema,
  executionStatus: z.enum(["preparing", "running"]),
  canonicalBaseline: ChapterPersistenceFingerprintSchema,
  updatedAt: z.string().datetime(),
}).strict();

export const ProductionRunSnapshotSchema = ProductionRunSnapshotUnsignedSchema.extend({
  snapshotSelfHash: Sha256HexSchema,
}).strict().superRefine((snapshot, ctx) => {
  validateRunCorrelation(snapshot, ctx);
  const { snapshotSelfHash: _self, ...unsigned } = snapshot;
  if (hashCanonicalJson(unsigned) !== snapshot.snapshotSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshotSelfHash"], message: "snapshot self hash mismatch" });
  }
});
export type ProductionRunSnapshot = z.infer<typeof ProductionRunSnapshotSchema>;

const ProductionCommitEvidenceSchema = z.object({
  kind: z.literal("verified-commit"),
  receiptFile: ArtifactRefSchema,
  receiptId: z.string().uuid(),
  commitState: z.enum(["verified", "committed-needs-recovery"]),
  chapterArtifact: ArtifactRefSchema,
  indexArtifact: ArtifactRefSchema,
  currentStateArtifact: ArtifactRefSchema.nullable(),
  railTruth: z.union([
    z.object({ applicability: z.literal("not-applicable"), reason: z.string().min(1) }).strict(),
    z.object({ applicability: z.literal("required"), status: z.literal("verified"), receipt: ArtifactRefSchema }).strict(),
    z.object({ applicability: z.literal("required"), status: z.literal("missing"), recoveryRequired: z.literal(true) }).strict(),
  ]),
  verifiedAt: z.string().datetime(),
}).strict();

const ProductionNoCommitEvidenceSchema = z.object({
  kind: z.literal("verified-no-commit"),
  canonicalBaseline: ChapterPersistenceFingerprintSchema,
  errorName: z.string().min(1).max(160),
  errorSha256: Sha256HexSchema,
  verifiedAt: z.string().datetime(),
}).strict();

const ProjectedChapterResultSchema = z.object({
  chapterNumber: z.number().int().positive(),
  title: z.string(),
  wordCount: z.number().int().min(0),
  status: ChapterStatusSchema,
}).strict();
export type ProjectedChapterResult = z.infer<typeof ProjectedChapterResultSchema>;

const ProductionRunUnsignedSchema = z.object({
  schemaVersion: z.literal("production-run/v1"),
  command: ProductionCommandSchema,
  commandSha256: Sha256HexSchema,
  productionAttempt: ProductionAttemptIdentitySchema,
  context: ProductionExecutionContextSchema,
  executionStatus: z.enum(["succeeded", "failed", "cancelled"]),
  approvalStatus: z.enum(["not-required", "pending", "held", "approved", "rejected"]),
  completionHealth: z.enum(["verified", "needs-recovery"]),
  projectionHealth: z.enum(["verified", "stale", "invalid"]),
  projectionOrigin: z.enum(["direct", "reconciled"]),
  evidence: z.union([ProductionCommitEvidenceSchema, ProductionNoCommitEvidenceSchema]),
  chapter: ProjectedChapterResultSchema.nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
}).strict();

export const ProductionRunSchema = ProductionRunUnsignedSchema.extend({
  runSelfHash: Sha256HexSchema,
}).strict().superRefine((run, ctx) => {
  validateRunCorrelation(run, ctx);
  if ((run.executionStatus === "succeeded") !== (run.evidence.kind === "verified-commit")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evidence"], message: "terminal status and commit evidence disagree" });
  }
  if ((run.executionStatus === "succeeded") !== (run.chapter !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["chapter"], message: "only a succeeded run may project a chapter" });
  }
  if (run.evidence.kind === "verified-commit") {
    const needsRecovery = run.evidence.commitState === "committed-needs-recovery";
    if (run.completionHealth !== (needsRecovery ? "needs-recovery" : "verified")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completionHealth"], message: "completion health disagrees with commit receipt" });
    }
    const expectedApproval = approvalStatusForChapter(run.chapter!.status, needsRecovery);
    if (run.approvalStatus !== expectedApproval) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approvalStatus"], message: "approval status disagrees with recovery state" });
    }
  } else if (run.completionHealth !== "verified" || run.approvalStatus !== "not-required") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["completionHealth"], message: "verified no-commit must be terminal and approval-free" });
  }
  const { runSelfHash: _self, ...unsigned } = run;
  if (hashCanonicalJson(unsigned) !== run.runSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runSelfHash"], message: "run self hash mismatch" });
  }
});
export type ProductionRun = z.infer<typeof ProductionRunSchema>;

type RunCorrelation = {
  readonly command: ProductionCommand;
  readonly commandSha256: string;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly context: ProductionExecutionContext;
};

function validateRunCorrelation(value: RunCorrelation, ctx: z.RefinementCtx): void {
  if (value.command.commandSelfHash !== value.commandSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commandSha256"], message: "command hash mismatch" });
  }
  if (
    value.context.commandId !== value.command.commandId
    || value.context.commandSha256 !== value.commandSha256
    || value.context.intentDigest !== value.command.intentDigest
    || value.context.capability !== value.command.capability
    || value.context.source !== value.command.source
    || value.context.actionSource !== productionCommandActionSource(value.command)
    || hashCanonicalJson(value.context.binding) !== hashCanonicalJson(value.command.binding)
    || value.context.productionOperationId !== value.productionAttempt.productionOperationId
    || value.context.attemptId !== value.productionAttempt.attemptId
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context"], message: "execution context is not bound to this command and attempt" });
  }
  if (value.context.productionInputs) {
    const receipt = value.context.productionInputs;
    if (
      receipt.externalContextSha256 !== value.command.args.ownerDirectionTextSha256
      || hashCanonicalJson(value.context.activatedSkills) !== hashCanonicalJson(receipt.skills.map((skill) => skill.id))
      || hashCanonicalJson(value.command.binding.soulBinding ?? null) !== hashCanonicalJson(receipt.soul?.binding ?? null)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "productionInputs"], message: "production input receipt is not bound to this command" });
    }
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprintSha256(artifacts: ReadonlyArray<ProductionArtifactRef>): string {
  return sha256(JSON.stringify(artifacts));
}

function approvalStatusForChapter(
  status: ProjectedChapterResult["status"],
  needsRecovery: boolean,
): "pending" | "held" | "approved" | "rejected" {
  if (needsRecovery || status === "audit-failed" || status === "state-degraded" || status === "needs-revision") {
    return "held";
  }
  if (status === "approved" || status === "published") return "approved";
  if (status === "rejected") return "rejected";
  return "pending";
}

function snapshotRelativePath(commandId: string): string {
  return join(SNAPSHOT_DIR, `${commandId}.json`);
}

function terminalRelativePath(commandId: string): string {
  return join(TERMINAL_DIR, `${commandId}.json`);
}

async function readRegularJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Production projection is not a regular file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function artifactRef(bookDir: string, path: string): Promise<ProductionArtifactRef> {
  const safePath = ArtifactRefSchema.shape.path.parse(path);
  const info = await lstat(join(bookDir, safePath));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Production evidence is not a regular file: ${safePath}`);
  return ArtifactRefSchema.parse({ path: safePath, sha256: sha256(await readFile(join(bookDir, safePath))) });
}

async function assertArtifactRef(bookDir: string, ref: ProductionArtifactRef): Promise<void> {
  const current = await artifactRef(bookDir, ref.path);
  if (current.sha256 !== ref.sha256) throw new Error(`Production evidence hash mismatch: ${ref.path}`);
}

export function createProductionRunSnapshot(input: {
  readonly command: ProductionCommand;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly context: ProductionExecutionContext;
  readonly executionStatus: "preparing" | "running";
  readonly canonicalBaseline: ChapterPersistenceFingerprint;
  readonly now?: Date;
}): ProductionRunSnapshot {
  const unsigned = ProductionRunSnapshotUnsignedSchema.parse({
    schemaVersion: "production-run-snapshot/v1",
    command: input.command,
    commandSha256: input.command.commandSelfHash,
    productionAttempt: input.productionAttempt,
    context: input.context,
    executionStatus: input.executionStatus,
    canonicalBaseline: input.canonicalBaseline,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  return ProductionRunSnapshotSchema.parse({ ...unsigned, snapshotSelfHash: hashCanonicalJson(unsigned) });
}

export async function saveProductionRunSnapshot(
  bookDir: string,
  snapshot: ProductionRunSnapshot,
): Promise<void> {
  const parsed = ProductionRunSnapshotSchema.parse(snapshot);
  const existingTerminal = await loadProductionRunByCommandId(bookDir, parsed.command.commandId);
  if (existingTerminal) throw new Error(`Production command is already terminal: ${parsed.command.commandId}`);
  const existing = await loadProductionRunSnapshotByCommandId(bookDir, parsed.command.commandId);
  if (existing) {
    if (
      existing.commandSha256 !== parsed.commandSha256
      || hashCanonicalJson(existing.productionAttempt) !== hashCanonicalJson(parsed.productionAttempt)
      || existing.executionStatus === "running" && parsed.executionStatus === "preparing"
    ) {
      throw new Error(`Production snapshot update is not a legal monotonic transition: ${parsed.command.commandId}`);
    }
  }
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: snapshotRelativePath(parsed.command.commandId),
      content: `${JSON.stringify(parsed, null, 2)}\n`,
    }],
  });
  const stored = await loadProductionRunSnapshotByCommandId(bookDir, parsed.command.commandId);
  if (!stored || hashCanonicalJson(stored) !== hashCanonicalJson(parsed)) {
    throw new Error(`Production snapshot readback failed: ${parsed.command.commandId}`);
  }
}

export async function loadProductionRunSnapshotByCommandId(
  bookDir: string,
  commandId: string,
): Promise<ProductionRunSnapshot | undefined> {
  try {
    return ProductionRunSnapshotSchema.parse(await readRegularJson(join(bookDir, snapshotRelativePath(commandId))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadProductionRunByCommandId(
  bookDir: string,
  commandId: string,
): Promise<ProductionRun | undefined> {
  try {
    return ProductionRunSchema.parse(await readRegularJson(join(bookDir, terminalRelativePath(commandId))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function findProductionProjectionByIdempotencyKey(
  bookDir: string,
  idempotencyKey: string,
  intentDigest: string,
): Promise<{ readonly kind: "snapshot"; readonly value: ProductionRunSnapshot } | { readonly kind: "terminal"; readonly value: ProductionRun } | undefined> {
  const records: Array<{ readonly kind: "snapshot"; readonly value: ProductionRunSnapshot } | { readonly kind: "terminal"; readonly value: ProductionRun }> = [];
  const collect = async (relativeDir: string, kind: "snapshot" | "terminal") => {
    const names = await readdir(join(bookDir, relativeDir)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      if (kind === "snapshot") {
        const value = ProductionRunSnapshotSchema.parse(await readRegularJson(join(bookDir, relativeDir, name)));
        if (`${value.command.commandId}.json` !== name) throw new Error(`Production projection filename mismatch: ${name}`);
        if (value.command.idempotencyKey === idempotencyKey) records.push({ kind: "snapshot", value });
      } else {
        const value = ProductionRunSchema.parse(await readRegularJson(join(bookDir, relativeDir, name)));
        if (`${value.command.commandId}.json` !== name) throw new Error(`Production projection filename mismatch: ${name}`);
        if (value.command.idempotencyKey === idempotencyKey) records.push({ kind: "terminal", value });
      }
    }
  };
  await Promise.all([collect(SNAPSHOT_DIR, "snapshot"), collect(TERMINAL_DIR, "terminal")]);
  if (records.some((record) => record.value.command.intentDigest !== intentDigest)) {
    throw new Error("Production idempotency key was reused with a different intent digest.");
  }
  if (records.length > 1) {
    throw new Error("Production idempotency key resolves to multiple projections; manual inspection is required.");
  }
  return records[0];
}

export async function finalizeProductionRun(bookDir: string, run: ProductionRun): Promise<ProductionRun> {
  const parsed = ProductionRunSchema.parse(run);
  if (parsed.projectionHealth !== "verified") {
    throw new Error("Only a verified production projection may become an immutable terminal.");
  }
  const existing = await loadProductionRunByCommandId(bookDir, parsed.command.commandId);
  if (existing) {
    if (hashCanonicalJson(existing) !== hashCanonicalJson(parsed)) {
      throw new Error(`Immutable production terminal already exists with different bytes: ${parsed.command.commandId}`);
    }
    return existing;
  }
  const snapshot = await loadProductionRunSnapshotByCommandId(bookDir, parsed.command.commandId);
  if (!snapshot || snapshot.commandSha256 !== parsed.commandSha256) {
    throw new Error(`Production terminal requires its exact persisted snapshot: ${parsed.command.commandId}`);
  }
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: terminalRelativePath(parsed.command.commandId),
      content: `${JSON.stringify(parsed, null, 2)}\n`,
    }],
    deletes: [snapshotRelativePath(parsed.command.commandId)],
  });
  const stored = await loadProductionRunByCommandId(bookDir, parsed.command.commandId);
  if (!stored || hashCanonicalJson(stored) !== hashCanonicalJson(parsed)) {
    throw new Error(`Production terminal readback failed: ${parsed.command.commandId}`);
  }
  return stored;
}

export async function verifyProductionCommitEvidence(input: {
  readonly bookDir: string;
  readonly command: ProductionCommand;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly receipt: ChapterCommitReceipt;
  readonly allowSupersededCanon?: boolean;
  readonly now?: Date;
}): Promise<{
  readonly evidence: z.infer<typeof ProductionCommitEvidenceSchema>;
  readonly chapter: ProjectedChapterResult;
}> {
  const receipt = ChapterCommitReceiptSchema.parse(input.receipt);
  if (
    receipt.bookId !== input.command.binding.bookId
    || receipt.capability !== input.command.capability
    || receipt.productionOperationId !== input.productionAttempt.productionOperationId
    || receipt.attemptId !== input.productionAttempt.attemptId
  ) {
    throw new Error("Chapter commit receipt is not bound to the active production command and attempt.");
  }
  const receiptPath = chapterCommitReceiptRelativePath(receipt.productionOperationId, receipt.receiptId);
  const receiptFile = await artifactRef(input.bookDir, receiptPath);
  const storedReceipt = ChapterCommitReceiptSchema.parse(await readRegularJson(join(input.bookDir, receiptPath)));
  if (hashCanonicalJson(storedReceipt) !== hashCanonicalJson(receipt)) {
    throw new Error("Stored Chapter commit receipt differs from the returned receipt.");
  }
  await Promise.all(receipt.operationManifests.map((entry) => assertArtifactRef(input.bookDir, entry.artifact)));
  await assertArtifactRef(input.bookDir, receipt.chapterArtifact);

  const indexRaw = await readFile(join(input.bookDir, receipt.indexArtifact.path));
  const indexHashMatches = sha256(indexRaw) === receipt.indexArtifact.sha256;
  const index = z.array(ChapterMetaSchema).parse(JSON.parse(indexRaw.toString("utf8")));
  const chapter = index.find((entry) => entry.number === receipt.chapterNumber);
  if (!chapter || index.filter((entry) => entry.number === receipt.chapterNumber).length !== 1) {
    throw new Error("Current Chapter index does not contain exactly one committed Chapter entry.");
  }
  const laterChapterExists = index.some((entry) => entry.number > receipt.chapterNumber);
  if (!indexHashMatches && !(input.allowSupersededCanon && laterChapterExists)) {
    throw new Error("Current Chapter index no longer matches the commit receipt.");
  }
  if (receipt.currentStateArtifact) {
    const currentState = await artifactRef(input.bookDir, receipt.currentStateArtifact.path);
    if (currentState.sha256 !== receipt.currentStateArtifact.sha256 && !(input.allowSupersededCanon && laterChapterExists)) {
      throw new Error("Current state no longer matches the commit receipt.");
    }
  }
  if (receipt.railTruth.applicability === "required" && receipt.railTruth.status === "verified") {
    await assertArtifactRef(input.bookDir, receipt.railTruth.receipt);
  }
  return {
    evidence: ProductionCommitEvidenceSchema.parse({
      kind: "verified-commit",
      receiptFile,
      receiptId: receipt.receiptId,
      commitState: receipt.commitState,
      chapterArtifact: receipt.chapterArtifact,
      indexArtifact: receipt.indexArtifact,
      currentStateArtifact: receipt.currentStateArtifact,
      railTruth: receipt.railTruth.applicability === "not-applicable"
        ? receipt.railTruth
        : receipt.railTruth.status === "verified"
          ? receipt.railTruth
          : { applicability: "required", status: "missing", recoveryRequired: true },
      verifiedAt: (input.now ?? new Date()).toISOString(),
    }),
    chapter: ProjectedChapterResultSchema.parse({
      chapterNumber: chapter.number,
      title: chapter.title,
      wordCount: chapter.wordCount,
      status: chapter.status,
    }),
  };
}

export async function verifyProductionNoCommit(input: {
  readonly bookDir: string;
  readonly snapshot: ProductionRunSnapshot;
  readonly error: unknown;
  readonly now?: Date;
}): Promise<z.infer<typeof ProductionNoCommitEvidenceSchema>> {
  const current = await captureChapterPersistenceFingerprint(
    input.bookDir,
    input.snapshot.canonicalBaseline.chapterNumber,
  );
  if (hashCanonicalJson(current) !== hashCanonicalJson(input.snapshot.canonicalBaseline)) {
    throw new Error("Cannot prove no-commit: the Chapter canon surface differs from the pre-run baseline.");
  }
  const errorName = input.error instanceof Error ? input.error.name || "Error" : "UnknownError";
  const errorText = input.error instanceof Error
    ? `${input.error.name}:${input.error.message}`
    : String(input.error);
  return ProductionNoCommitEvidenceSchema.parse({
    kind: "verified-no-commit",
    canonicalBaseline: input.snapshot.canonicalBaseline,
    errorName,
    errorSha256: sha256(errorText),
    verifiedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function buildSucceededProductionRun(input: {
  readonly snapshot: ProductionRunSnapshot;
  readonly evidence: z.infer<typeof ProductionCommitEvidenceSchema>;
  readonly chapter: ProjectedChapterResult;
  readonly projectionOrigin: "direct" | "reconciled";
  readonly now?: Date;
}): ProductionRun {
  const needsRecovery = input.evidence.commitState === "committed-needs-recovery";
  const unsigned = ProductionRunUnsignedSchema.parse({
    schemaVersion: "production-run/v1",
    command: input.snapshot.command,
    commandSha256: input.snapshot.commandSha256,
    productionAttempt: input.snapshot.productionAttempt,
    context: input.snapshot.context,
    executionStatus: "succeeded",
    approvalStatus: approvalStatusForChapter(input.chapter.status, needsRecovery),
    completionHealth: needsRecovery ? "needs-recovery" : "verified",
    projectionHealth: "verified",
    projectionOrigin: input.projectionOrigin,
    evidence: input.evidence,
    chapter: input.chapter,
    startedAt: input.snapshot.context.startedAt,
    completedAt: (input.now ?? new Date()).toISOString(),
  });
  return ProductionRunSchema.parse({ ...unsigned, runSelfHash: hashCanonicalJson(unsigned) });
}

export function buildNoCommitProductionRun(input: {
  readonly snapshot: ProductionRunSnapshot;
  readonly evidence: z.infer<typeof ProductionNoCommitEvidenceSchema>;
  readonly executionStatus: "failed" | "cancelled";
  readonly projectionOrigin: "direct" | "reconciled";
  readonly now?: Date;
}): ProductionRun {
  const unsigned = ProductionRunUnsignedSchema.parse({
    schemaVersion: "production-run/v1",
    command: input.snapshot.command,
    commandSha256: input.snapshot.commandSha256,
    productionAttempt: input.snapshot.productionAttempt,
    context: input.snapshot.context,
    executionStatus: input.executionStatus,
    approvalStatus: "not-required",
    completionHealth: "verified",
    projectionHealth: "verified",
    projectionOrigin: input.projectionOrigin,
    evidence: input.evidence,
    chapter: null,
    startedAt: input.snapshot.context.startedAt,
    completedAt: (input.now ?? new Date()).toISOString(),
  });
  return ProductionRunSchema.parse({ ...unsigned, runSelfHash: hashCanonicalJson(unsigned) });
}

export async function ensureProductionProjectionDirectories(bookDir: string): Promise<void> {
  const relativeDirectories = [
    "story",
    join("story", "runtime"),
    RUN_ROOT,
    SNAPSHOT_DIR,
    TERMINAL_DIR,
  ];
  for (const relativePath of relativeDirectories) {
    const absolutePath = join(bookDir, relativePath);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(absolutePath);
      info = await lstat(absolutePath);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Production projection directory is not a real Book-local directory: ${relativePath}`);
    }
  }
}
