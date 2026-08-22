import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { safeNonSymlinkChildPath } from "../utils/path-safety.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitCommitSchema = z.string().regex(/^[a-f0-9]{7,64}$/);
const StableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const RepositorySchema = z.string().trim().min(1).max(240).refine(
  (value) => !value.includes("\0") && !value.includes("\\") && !value.includes(".."),
  "Repository names may not contain traversal or backslash segments",
);
const RelativeArtifactPathSchema = z.string().trim().min(1).max(1_000).refine(
  (value) => (
    !isAbsolute(value)
    && !value.includes("\0")
    && !value.includes("\\")
    && !value.split("/").includes("..")
  ),
  "Artifact paths must be safe POSIX-style relative paths",
);
const BoundedTextSchema = z.string().trim().min(1).max(2_000);

export const GoldRouteRoleSchema = z.enum([
  "spine",
  "engine",
  "payoff",
  "hook",
  "wildcard",
]);
export type GoldRouteRole = z.infer<typeof GoldRouteRoleSchema>;

export const GoldSelectionKindSchema = z.enum([
  "narrative-arc",
  "event",
  "reward",
  "pacing",
  "character",
  "relationship",
  "hook",
]);
export type GoldSelectionKind = z.infer<typeof GoldSelectionKindSchema>;

export const GoldRouteTargetKindSchema = z.enum([
  "narrative-arc",
  "b-rail",
  "arc-packet",
]);
export type GoldRouteTargetKind = z.infer<typeof GoldRouteTargetKindSchema>;

export const GoldArtifactReferenceSchema = z.object({
  repository: RepositorySchema,
  commit: GitCommitSchema,
  path: RelativeArtifactPathSchema,
  sha256: Sha256Schema,
}).strict();
export type GoldArtifactReference = z.infer<typeof GoldArtifactReferenceSchema>;

export const GoldRouteSelectionSchema = z.object({
  kind: GoldSelectionKindSchema,
  id: StableIdSchema,
}).strict();
export type GoldRouteSelection = z.infer<typeof GoldRouteSelectionSchema>;

export const GoldRouteTargetSchema = z.object({
  kind: GoldRouteTargetKindSchema,
  id: StableIdSchema,
}).strict();
export type GoldRouteTarget = z.infer<typeof GoldRouteTargetSchema>;

const GoldRouteApprovalSchema = z.object({
  approvedBy: z.string().trim().min(1).max(200),
  approvedAt: z.string().datetime(),
  approvedReceiptSha256: Sha256Schema,
}).strict();

export const GoldRouteReceiptSchema = z.object({
  version: z.literal(1),
  receiptId: StableIdSchema,
  bookId: z.string().min(1),
  originArtifact: GoldArtifactReferenceSchema,
  qaReceiptArtifact: GoldArtifactReferenceSchema,
  role: GoldRouteRoleSchema,
  allowedUses: z.array(BoundedTextSchema).min(1).max(20),
  selectedSources: z.array(GoldRouteSelectionSchema).min(1).max(100),
  forbiddenSourceSurfaces: z.array(BoundedTextSchema).min(1).max(20),
  transformationRationale: z.string().trim().min(20).max(8_000),
  targets: z.array(GoldRouteTargetSchema).min(1).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approval: GoldRouteApprovalSchema,
}).strict().superRefine((receipt, ctx) => {
  validateUniqueValues(receipt.allowedUses, ["allowedUses"], ctx);
  validateUniqueValues(receipt.forbiddenSourceSurfaces, ["forbiddenSourceSurfaces"], ctx);
  validateUniqueValues(
    receipt.selectedSources.map((source) => `${source.kind}:${source.id}`),
    ["selectedSources"],
    ctx,
  );
  validateUniqueValues(
    receipt.targets.map((target) => `${target.kind}:${target.id}`),
    ["targets"],
    ctx,
  );
});
export type GoldRouteReceipt = z.infer<typeof GoldRouteReceiptSchema>;

export const GoldRouteReceiptStoreSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  receipts: z.array(GoldRouteReceiptSchema),
}).strict().superRefine((store, ctx) => {
  validateUniqueValues(store.receipts.map((receipt) => receipt.receiptId), ["receipts"], ctx);
  for (const [index, receipt] of store.receipts.entries()) {
    if (receipt.bookId !== store.bookId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipts", index, "bookId"],
        message: "Gold route receipt belongs to another Book",
      });
    }
  }
});
export type GoldRouteReceiptStore = z.infer<typeof GoldRouteReceiptStoreSchema>;

export interface ApproveGoldRouteReceiptInput {
  readonly receiptId: string;
  readonly originArtifact: GoldArtifactReference;
  readonly qaReceiptArtifact: GoldArtifactReference;
  readonly role: GoldRouteRole;
  readonly allowedUses: ReadonlyArray<string>;
  readonly selectedSources: ReadonlyArray<GoldRouteSelection>;
  readonly forbiddenSourceSurfaces: ReadonlyArray<string>;
  readonly transformationRationale: string;
  readonly targets: ReadonlyArray<GoldRouteTarget>;
  readonly approvedBy: string;
}

export interface GoldRouteReceiptDeps {
  readonly repositoryRoots: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export type GoldArtifactFreshness = "current" | "stale" | "missing";

export interface GoldArtifactInspection {
  readonly artifact: GoldArtifactReference;
  readonly status: GoldArtifactFreshness;
  readonly actualSha256?: string;
  readonly reason?: "repository-root-unavailable" | "artifact-missing" | "hash-mismatch";
}

export interface GoldRouteReceiptInspection {
  readonly receiptId: string;
  readonly status: GoldArtifactFreshness;
  readonly originArtifact: GoldArtifactInspection;
  readonly qaReceiptArtifact: GoldArtifactInspection;
}

export const GOLD_ROUTE_RECEIPT_STORE_PATH = "story/references/gold_route_receipts.json";

export async function approveGoldRouteReceipt(
  projectRoot: string,
  bookIdInput: string,
  input: ApproveGoldRouteReceiptInput,
  deps: GoldRouteReceiptDeps,
): Promise<GoldRouteReceipt> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  const current = await loadGoldRouteReceiptStore(projectRoot, bookId);
  const existing = current.receipts.find((receipt) => receipt.receiptId === input.receiptId);
  const now = (deps.now?.() ?? new Date()).toISOString();
  const normalized = GoldRouteReceiptSchema.parse({
    version: 1 as const,
    receiptId: input.receiptId,
    bookId,
    originArtifact: input.originArtifact,
    qaReceiptArtifact: input.qaReceiptArtifact,
    role: input.role,
    allowedUses: input.allowedUses,
    selectedSources: input.selectedSources,
    forbiddenSourceSurfaces: input.forbiddenSourceSurfaces,
    transformationRationale: input.transformationRationale,
    targets: input.targets,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    approval: {
      approvedBy: input.approvedBy,
      approvedAt: now,
      approvedReceiptSha256: "0".repeat(64),
    },
  });
  const { approvedReceiptSha256: _placeholder, ...approval } = normalized.approval;
  const unsigned = { ...normalized, approval };
  const receipt = GoldRouteReceiptSchema.parse({
    ...unsigned,
    approval: {
      ...unsigned.approval,
      approvedReceiptSha256: hashCanonicalJson(unsigned),
    },
  });
  const inspection = await inspectGoldRouteReceipt(receipt, deps.repositoryRoots);
  if (inspection.status !== "current") {
    throw new Error(
      `Cannot approve Gold route receipt ${receipt.receiptId}: source evidence is ${inspection.status}.`,
    );
  }
  const next = GoldRouteReceiptStoreSchema.parse({
    version: 1,
    bookId,
    receipts: [
      ...current.receipts.filter((entry) => entry.receiptId !== receipt.receiptId),
      receipt,
    ],
  });
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: GOLD_ROUTE_RECEIPT_STORE_PATH,
      content: `${JSON.stringify(next, null, 2)}\n`,
    }],
  });
  return receipt;
}

export async function loadGoldRouteReceiptStore(
  projectRoot: string,
  bookIdInput: string,
): Promise<GoldRouteReceiptStore> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bookDir, GOLD_ROUTE_RECEIPT_STORE_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { version: 1, bookId, receipts: [] };
    }
    throw error;
  }
  const store = GoldRouteReceiptStoreSchema.parse(parsed);
  if (store.bookId !== bookId) {
    throw new Error(`Gold route receipt store belongs to another Book: ${store.bookId}`);
  }
  for (const receipt of store.receipts) assertGoldRouteReceiptApproval(receipt);
  return store;
}

export function assertGoldRouteReceiptApproval(receiptInput: GoldRouteReceipt): GoldRouteReceipt {
  const receipt = GoldRouteReceiptSchema.parse(receiptInput);
  const { approvedReceiptSha256, ...approval } = receipt.approval;
  const expected = hashCanonicalJson({ ...receipt, approval });
  if (approvedReceiptSha256 !== expected) {
    throw new Error(`Gold route receipt approval hash mismatch: ${receipt.receiptId}`);
  }
  return receipt;
}

export async function inspectGoldRouteReceipt(
  receiptInput: GoldRouteReceipt,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<GoldRouteReceiptInspection> {
  const receipt = assertGoldRouteReceiptApproval(receiptInput);
  const [originArtifact, qaReceiptArtifact] = await Promise.all([
    inspectArtifact(receipt.originArtifact, repositoryRoots),
    inspectArtifact(receipt.qaReceiptArtifact, repositoryRoots),
  ]);
  const statuses = [originArtifact.status, qaReceiptArtifact.status];
  const status: GoldArtifactFreshness = statuses.includes("stale")
    ? "stale"
    : statuses.includes("missing")
      ? "missing"
      : "current";
  return { receiptId: receipt.receiptId, status, originArtifact, qaReceiptArtifact };
}

async function inspectArtifact(
  artifact: GoldArtifactReference,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<GoldArtifactInspection> {
  const root = repositoryRoots[artifact.repository];
  if (!root) {
    return { artifact, status: "missing", reason: "repository-root-unavailable" };
  }
  let path: string;
  try {
    path = await safeNonSymlinkChildPath(root, artifact.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { artifact, status: "missing", reason: "artifact-missing" };
    }
    throw error;
  }
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { artifact, status: "missing", reason: "artifact-missing" };
    }
    throw error;
  }
  const actualSha256 = sha256(content);
  if (actualSha256 !== artifact.sha256) {
    return { artifact, status: "stale", actualSha256, reason: "hash-mismatch" };
  }
  return { artifact, status: "current", actualSha256 };
}

async function assertBookExists(bookDir: string, bookId: string): Promise<void> {
  try {
    if (!(await stat(bookDir)).isDirectory()) throw new Error(`Book not found: ${bookId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(`Book not found: ${bookId}`);
    }
    throw error;
  }
}

function validateUniqueValues(
  values: ReadonlyArray<string>,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Values must be unique" });
  }
}

function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
