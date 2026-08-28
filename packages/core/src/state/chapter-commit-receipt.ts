import { createHash, randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterMetaSchema, type ChapterMeta } from "../models/chapter.js";
import {
  FictionContentOperationManifestSchema,
  hashCanonicalJson,
  type FictionContentOperationManifest,
} from "../production/fiction-content-contract.js";
import {
  ProductionAttemptIdentitySchema,
  verifyProductionAttemptIdentity,
  type ProductionAttemptIdentity,
} from "../production/attempt-identity.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  chapterTruthReceiptRelativePath,
  verifyChapterTruthReceipt,
  writeChapterTruthReceipt,
} from "./chapter-truth-receipt.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
}).strict();

export const ChapterCommitCapabilitySchema = z.enum([
  "write-draft",
  "write-next-chapter",
  "audit-draft",
  "revise-draft",
  "repair-chapter-state",
  "resync-chapter-artifacts",
  "import-chapter",
]);
export type ChapterCommitCapability = z.infer<typeof ChapterCommitCapabilitySchema>;

const RailTruthEvidenceSchema = z.union([
  z.object({
    applicability: z.literal("not-applicable"),
    reason: z.enum(["no-active-rail", "state-degraded", "pending-audit"]),
  }).strict(),
  z.object({
    applicability: z.literal("required"),
    status: z.literal("verified"),
    receipt: ArtifactRefSchema,
  }).strict(),
  z.object({
    applicability: z.literal("required"),
    status: z.literal("missing"),
    errorSha256: Sha256Schema,
    recoveryRequired: z.literal(true),
  }).strict(),
]);

export const ChapterCommitReceiptSchema = z.object({
  schemaVersion: z.literal("chapter-commit-receipt/v1"),
  receiptId: z.string().uuid(),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().positive(),
  capability: ChapterCommitCapabilitySchema,
  productionOperationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  fictionOperationIds: z.array(z.string().uuid()).min(1),
  operationManifests: z.array(z.object({
    operationId: z.string().uuid(),
    artifact: ArtifactRefSchema,
  }).strict()).min(1),
  chapterArtifact: ArtifactRefSchema,
  indexArtifact: ArtifactRefSchema,
  currentStateArtifact: ArtifactRefSchema.nullable(),
  railTruth: RailTruthEvidenceSchema,
  commitState: z.enum(["verified", "committed-needs-recovery"]),
  committedAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  if (new Set(receipt.fictionOperationIds).size !== receipt.fictionOperationIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fictionOperationIds"], message: "duplicate fiction operation ID" });
  }
  if ([...receipt.fictionOperationIds].sort().some((id, index) => id !== receipt.fictionOperationIds[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fictionOperationIds"], message: "fiction operation IDs must be sorted" });
  }
  const expectedState = receipt.railTruth.applicability === "required" && receipt.railTruth.status === "missing"
    ? "committed-needs-recovery"
    : "verified";
  if (receipt.commitState !== expectedState) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commitState"], message: "commit state does not match evidence" });
  }
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "receipt self hash mismatch" });
  }
});
export type ChapterCommitReceipt = z.infer<typeof ChapterCommitReceiptSchema>;

export const ChapterCommitRepairReceiptSchema = z.object({
  schemaVersion: z.literal("chapter-commit-repair/v1"),
  repairId: z.string().uuid(),
  originalReceipt: ArtifactRefSchema,
  productionOperationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().positive(),
  railTruthReceipt: ArtifactRefSchema,
  repairedIndexArtifact: ArtifactRefSchema,
  repairedAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "repair receipt self hash mismatch" });
  }
});
export type ChapterCommitRepairReceipt = z.infer<typeof ChapterCommitRepairReceiptSchema>;

export function chapterCommitReceiptRelativePath(productionOperationId: string, receiptId: string): string {
  return join("story", "runtime", "chapter-commits", `${productionOperationId}--${receiptId}.json`);
}

export async function writeChapterCommitReceipt(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly capability: ChapterCommitCapability;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly operationManifests: ReadonlyArray<FictionContentOperationManifest>;
  readonly now?: () => Date;
}): Promise<ChapterCommitReceipt> {
  const productionAttempt = verifyProductionAttemptIdentity(input.productionAttempt);
  const capability = ChapterCommitCapabilitySchema.parse(input.capability);
  if (input.operationManifests.length === 0) throw new Error("Chapter commit receipt requires a fiction operation manifest.");
  const manifests = input.operationManifests.map((value) => FictionContentOperationManifestSchema.parse(value));
  for (const manifest of manifests) {
    if (
      manifest.bookId !== input.bookId
      || manifest.chapterNumber !== input.chapterNumber
      || manifest.operationKind !== capability
      || manifest.productionOperationId !== productionAttempt.productionOperationId
      || manifest.attemptId !== productionAttempt.attemptId
    ) {
      throw new Error("Fiction operation manifest does not match the Chapter commit capability or production attempt.");
    }
  }
  const fictionOperationIds = manifests.map((manifest) => manifest.operationId).sort();
  const receiptId = fictionOperationIds[0]!;
  const receiptPath = chapterCommitReceiptRelativePath(productionAttempt.productionOperationId, receiptId);
  await access(join(input.bookDir, receiptPath)).then(
    () => { throw new Error(`Chapter commit receipt already exists: ${receiptPath}`); },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );

  const manifestRefs = await Promise.all(manifests.map(async (manifest) => {
    const relativePath = join(
      "story",
      "runtime",
      "fiction-content-neutral",
      "operations",
      `${manifest.operationId}.json`,
    );
    const raw = await readFile(join(input.bookDir, relativePath));
    const stored = FictionContentOperationManifestSchema.parse(JSON.parse(raw.toString("utf8")));
    if (hashCanonicalJson(stored) !== hashCanonicalJson(manifest)) {
      throw new Error(`Stored fiction operation manifest ${manifest.operationId} changed before Chapter commit.`);
    }
    return { operationId: manifest.operationId, artifact: { path: relativePath, sha256: sha256(raw) } };
  }));

  const [chapterArtifact, rawIndex, currentStateArtifact] = await Promise.all([
    readChapterArtifact(input.bookDir, input.chapterNumber),
    readFile(join(input.bookDir, "chapters", "index.json")),
    readOptionalArtifact(input.bookDir, join("story", "current_state.md")),
  ]);
  const index = ChapterMetaSchema.array().parse(JSON.parse(rawIndex.toString("utf8")));
  const chapter = index.find((entry) => entry.number === input.chapterNumber);
  if (!chapter) throw new Error(`Chapter ${input.chapterNumber} is missing from the persisted index.`);

  const railTruth = await inspectRailTruth(input.bookDir, input.bookId, chapter);
  const needsRecovery = railTruth.applicability === "required" && railTruth.status === "missing";
  const finalIndex = needsRecovery
    ? index.map((entry) => entry.number === input.chapterNumber
      ? ChapterMetaSchema.parse({ ...entry, pendingAuditReason: "production-evidence-needs-recovery" })
      : entry)
    : index;
  const indexBytes = needsRecovery
    ? Buffer.from(`${JSON.stringify(finalIndex, null, 2)}\n`, "utf8")
    : rawIndex;
  const unsigned = {
    schemaVersion: "chapter-commit-receipt/v1" as const,
    receiptId,
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    capability,
    productionOperationId: productionAttempt.productionOperationId,
    attemptId: productionAttempt.attemptId,
    fictionOperationIds,
    operationManifests: manifestRefs.sort((left, right) => left.operationId.localeCompare(right.operationId)),
    chapterArtifact,
    indexArtifact: { path: join("chapters", "index.json"), sha256: sha256(indexBytes) },
    currentStateArtifact,
    railTruth,
    commitState: needsRecovery ? "committed-needs-recovery" as const : "verified" as const,
    committedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const receipt = ChapterCommitReceiptSchema.parse({ ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) });
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: [
      ...(needsRecovery ? [{ relativePath: join("chapters", "index.json"), content: indexBytes }] : []),
      { relativePath: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n` },
    ],
  });
  return receipt;
}

export async function listChapterCommitReceiptsForAttempt(
  bookDir: string,
  productionAttempt: ProductionAttemptIdentity,
): Promise<ReadonlyArray<ChapterCommitReceipt>> {
  const attempt = ProductionAttemptIdentitySchema.parse(productionAttempt);
  const dir = join(bookDir, "story", "runtime", "chapter-commits");
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const receipts = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) =>
    ChapterCommitReceiptSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")))));
  return receipts.filter((receipt) =>
    receipt.productionOperationId === attempt.productionOperationId
    && receipt.attemptId === attempt.attemptId);
}

export async function repairChapterCommitEvidence(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly productionOperationId: string;
  readonly receiptId: string;
  readonly now?: () => Date;
  readonly repairId?: string;
}): Promise<ChapterCommitRepairReceipt> {
  const originalRelative = chapterCommitReceiptRelativePath(input.productionOperationId, input.receiptId);
  const originalRaw = await readFile(join(input.bookDir, originalRelative));
  const original = ChapterCommitReceiptSchema.parse(JSON.parse(originalRaw.toString("utf8")));
  if (
    original.bookId !== input.bookId
    || original.productionOperationId !== input.productionOperationId
    || original.receiptId !== input.receiptId
    || original.commitState !== "committed-needs-recovery"
    || original.railTruth.applicability !== "required"
    || original.railTruth.status !== "missing"
  ) {
    throw new Error("Chapter commit receipt is not eligible for evidence-only repair.");
  }
  const [currentArtifact, rawIndex] = await Promise.all([
    readChapterArtifact(input.bookDir, original.chapterNumber),
    readFile(join(input.bookDir, "chapters", "index.json")),
  ]);
  if (currentArtifact.sha256 !== original.chapterArtifact.sha256) {
    throw new Error("Chapter body changed after the committed-needs-recovery receipt; repair requires operator review.");
  }
  const index = ChapterMetaSchema.array().parse(JSON.parse(rawIndex.toString("utf8")));
  const chapter = index.find((entry) => entry.number === original.chapterNumber);
  if (!chapter || chapter.pendingAuditReason !== "production-evidence-needs-recovery") {
    throw new Error("Chapter recovery gate is missing or belongs to another state.");
  }
  await writeChapterTruthReceipt(input.bookDir, input.bookId, chapter, input.now);
  await verifyChapterTruthReceipt(input.bookDir, input.bookId, chapter);
  const repairedTruthRaw = await readFile(join(
    input.bookDir,
    chapterTruthReceiptRelativePath(original.chapterNumber),
  ));
  const repairedIndex = index.map((entry) => entry.number === original.chapterNumber
    ? ChapterMetaSchema.parse({ ...entry, pendingAuditReason: undefined })
    : entry);
  const repairedIndexBytes = Buffer.from(`${JSON.stringify(repairedIndex, null, 2)}\n`, "utf8");
  const repairId = input.repairId ?? randomUUID();
  const unsigned = {
    schemaVersion: "chapter-commit-repair/v1" as const,
    repairId,
    originalReceipt: { path: originalRelative, sha256: sha256(originalRaw) },
    productionOperationId: original.productionOperationId,
    attemptId: original.attemptId,
    bookId: original.bookId,
    chapterNumber: original.chapterNumber,
    railTruthReceipt: {
      path: chapterTruthReceiptRelativePath(original.chapterNumber),
      sha256: sha256(repairedTruthRaw),
    },
    repairedIndexArtifact: { path: join("chapters", "index.json"), sha256: sha256(repairedIndexBytes) },
    repairedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const repair = ChapterCommitRepairReceiptSchema.parse({ ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) });
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: [
      { relativePath: join("chapters", "index.json"), content: repairedIndexBytes },
      {
        relativePath: join("story", "runtime", "chapter-commits", "repairs", `${repairId}.json`),
        content: `${JSON.stringify(repair, null, 2)}\n`,
      },
    ],
  });
  return repair;
}

async function inspectRailTruth(bookDir: string, bookId: string, chapter: ChapterMeta) {
  if (!chapter.arcProvenance?.storyRail) {
    return { applicability: "not-applicable" as const, reason: "no-active-rail" as const };
  }
  if (chapter.status === "state-degraded") {
    return { applicability: "not-applicable" as const, reason: "state-degraded" as const };
  }
  if (chapter.pendingAuditReason && chapter.pendingAuditReason !== "production-evidence-needs-recovery") {
    return { applicability: "not-applicable" as const, reason: "pending-audit" as const };
  }
  try {
    await verifyChapterTruthReceipt(bookDir, bookId, chapter);
    const receiptPath = chapterTruthReceiptRelativePath(chapter.number);
    const receiptRaw = await readFile(join(bookDir, receiptPath));
    return {
      applicability: "required" as const,
      status: "verified" as const,
      receipt: {
        path: receiptPath,
        sha256: sha256(receiptRaw),
      },
    };
  } catch (error) {
    return {
      applicability: "required" as const,
      status: "missing" as const,
      errorSha256: sha256(error instanceof Error ? `${error.name}:${error.message}` : String(error)),
      recoveryRequired: true as const,
    };
  }
}

async function readChapterArtifact(bookDir: string, chapterNumber: number) {
  const names = await readdir(join(bookDir, "chapters"));
  const prefix = String(chapterNumber).padStart(4, "0");
  const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith(".md"));
  if (matches.length !== 1) throw new Error(`Chapter ${chapterNumber} needs exactly one manuscript file; found ${matches.length}.`);
  const path = join("chapters", matches[0]!);
  return { path, sha256: sha256(await readFile(join(bookDir, path))) };
}

async function readOptionalArtifact(bookDir: string, path: string) {
  try {
    return { path, sha256: sha256(await readFile(join(bookDir, path))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
