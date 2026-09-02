import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ActiveArcSchema, ArcPacketSchema } from "../arc/schema.js";
import { StoryRailPlanSchema } from "../arc/rail-schema.js";
import { BookConfigSchema } from "../models/book.js";
import {
  CANARY_ISOLATION_RECEIPT_MAX_BYTES,
  loadCanaryCommonSnapshotReceipt,
  parseCanaryCommonSnapshotReceiptBytes,
  type CanaryCommonSnapshotReceipt,
  type CanaryRegularFileRef,
} from "./canary-isolation.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const CONTEXT_MAX_BYTES = 500_000;

const ArtifactSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256),
  byteLength: z.number().int().positive(),
}).strict();

/** Lane-neutral, public-safe materialization. It deliberately has no Soul or lane fields. */
export const ProductionCanaryCommonContextSchema = z.object({
  schemaVersion: z.literal("inkos-canary-common-context/v1"),
  bookId: z.string().min(1),
  commonSnapshotSha256: z.string().regex(SHA256),
  sourceArtifacts: z.object({
    bookConfig: ArtifactSchema,
    brief: ArtifactSchema,
    storyRailPlan: ArtifactSchema,
    activeArcPointer: ArtifactSchema,
    activeArc: ArtifactSchema,
  }).strict(),
  bookConfig: BookConfigSchema,
  brief: z.string().min(1),
  storyRailPlan: StoryRailPlanSchema,
  activeArcPointer: ActiveArcSchema,
  activeArc: ArcPacketSchema,
}).strict();

export type ProductionCanaryCommonContext = z.infer<typeof ProductionCanaryCommonContextSchema>;

export interface MaterializeProductionCanaryCommonContextInput {
  readonly projectRoot: string;
  readonly pairId: string;
}

export interface MaterializeProductionCanaryCommonContextResult {
  readonly schemaVersion: "inkos-canary-common-context-result/v1";
  readonly pairId: string;
  readonly bookId: string;
  readonly commonSnapshotSha256: string;
  readonly context: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly replayed: boolean;
}

interface StableArtifact {
  readonly bytes: Buffer;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface ContextInputs {
  readonly receiptBytes: Buffer;
  readonly receipt: CanaryCommonSnapshotReceipt;
  readonly artifacts: ReadonlyMap<string, StableArtifact>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function safeRelativePath(path: string, label: string): string {
  const normalized = normalize(path);
  if (!path || isAbsolute(path) || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return normalized;
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory.`);
}

async function assertNoSymlinkComponents(root: string, relativePath: string, label: string): Promise<string> {
  const realRoot = await realpath(root);
  await assertRealDirectory(realRoot, `${label} root`);
  const safe = safeRelativePath(relativePath, label);
  let current = realRoot;
  for (const component of safe.split(sep)) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`${label} must not contain a symlink: ${current}`);
  }
  const resolved = resolve(current);
  if (relative(realRoot, resolved).startsWith(`..${sep}`) || relative(realRoot, resolved) === "..") {
    throw new Error(`${label} escapes its project root.`);
  }
  return current;
}

async function readStableRegularFile(path: string, label: string, maxBytes = CONTEXT_MAX_BYTES): Promise<StableArtifact> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular file.`);
  if (before.size < 1 || before.size > maxBytes) throw new Error(`${label} must be 1-${maxBytes} bytes.`);
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || bytes.byteLength !== before.size
  ) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return { bytes, path: "", sha256: sha256(bytes), byteLength: bytes.byteLength };
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8 JSON: ${String(error)}`);
  }
}

function parseNonblankUtf8(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8: ${String(error)}`);
  }
  if (!text.trim()) throw new Error(`${label} must be nonblank.`);
  return text;
}

function expectedBookRef(receipt: CanaryCommonSnapshotReceipt, path: string): CanaryRegularFileRef {
  const ref = receipt.sourceBook.files.find((candidate) => candidate.path === path);
  if (!ref) throw new Error(`Canary common snapshot does not seal required Book artifact: ${path}`);
  return ref;
}

function artifactRef(artifact: StableArtifact): z.infer<typeof ArtifactSchema> {
  return ArtifactSchema.parse({
    path: artifact.path,
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
  });
}

function assertReceiptBytesMatch(receipt: CanaryCommonSnapshotReceipt, bytes: Buffer): void {
  const exact = parseCanaryCommonSnapshotReceiptBytes(bytes);
  if (hashCanonicalJson(exact) !== hashCanonicalJson(receipt)) {
    throw new Error("Canary common snapshot receipt changed between authenticated reads.");
  }
}

async function readContextInputs(projectRoot: string, pairId: string): Promise<ContextInputs> {
  const receipt = await loadCanaryCommonSnapshotReceipt(projectRoot, pairId);
  const receiptPath = await assertNoSymlinkComponents(
    projectRoot,
    join(".inkos", "canaries", pairId, "common-snapshot.json"),
    "Canary common snapshot receipt",
  );
  const rawReceipt = await readStableRegularFile(receiptPath, "Canary common snapshot receipt", CANARY_ISOLATION_RECEIPT_MAX_BYTES);
  assertReceiptBytesMatch(receipt, rawReceipt.bytes);

  const neutralRoot = await assertNoSymlinkComponents(
    projectRoot,
    receipt.lanes.neutral.projectRoot.split("/").join(sep),
    "Canary neutral root",
  );
  await assertRealDirectory(neutralRoot, "Canary neutral root");
  const artifacts = new Map<string, StableArtifact>();
  for (const ref of receipt.sourceBook.files) {
    const path = await assertNoSymlinkComponents(neutralRoot, ref.path.split("/").join(sep), "Canary neutral Book artifact");
    const artifact = await readStableRegularFile(path, `Canary neutral Book artifact ${ref.path}`);
    if (artifact.sha256 !== ref.sha256 || artifact.byteLength !== ref.byteLength) {
      throw new Error(`Canary neutral Book artifact does not match the sealed source snapshot: ${ref.path}`);
    }
    artifacts.set(ref.path, { ...artifact, path: ref.path });
  }
  return { receiptBytes: rawReceipt.bytes, receipt, artifacts };
}

function contextBytesFromInputs(input: ContextInputs): Buffer {
  const bookId = input.receipt.bookId;
  const configPath = `books/${bookId}/book.json`;
  const briefPath = `books/${bookId}/story/brief.md`;
  const railPath = `books/${bookId}/story/rails/plan.json`;
  const pointerPath = `books/${bookId}/story/arcs/active.json`;
  const config = input.artifacts.get(configPath) ?? (() => { throw new Error("Canary Book config is missing."); })();
  const brief = input.artifacts.get(briefPath) ?? (() => { throw new Error("Canary Book brief is missing."); })();
  const rail = input.artifacts.get(railPath) ?? (() => { throw new Error("Canary Book Story Rail plan is missing."); })();
  const pointer = input.artifacts.get(pointerPath) ?? (() => { throw new Error("Canary active Arc pointer is missing."); })();

  expectedBookRef(input.receipt, configPath);
  expectedBookRef(input.receipt, briefPath);
  expectedBookRef(input.receipt, railPath);
  expectedBookRef(input.receipt, pointerPath);
  const bookConfig = BookConfigSchema.parse(parseJson(config.bytes, "Canary Book config"));
  if (bookConfig.id !== bookId) throw new Error("Canary Book config does not match the sealed Book ID.");
  const activeArcPointer = ActiveArcSchema.parse(parseJson(pointer.bytes, "Canary active Arc pointer"));
  const activeArcPath = `books/${bookId}/story/arcs/${activeArcPointer.arcId}.json`;
  const activeArcArtifact = input.artifacts.get(activeArcPath);
  if (!activeArcArtifact) throw new Error("Canary active Arc content is missing from the sealed Book snapshot.");
  expectedBookRef(input.receipt, activeArcPath);
  const storyRailPlan = StoryRailPlanSchema.parse(parseJson(rail.bytes, "Canary Story Rail plan"));
  const activeArc = ArcPacketSchema.parse(parseJson(activeArcArtifact.bytes, "Canary active Arc content"));
  if (storyRailPlan.bookId !== bookId || activeArc.bookId !== bookId || activeArc.id !== activeArcPointer.arcId) {
    throw new Error("Canary ready Story Rail or active Arc belongs to a different Book.");
  }
  if (storyRailPlan.anchorRail.status !== "ready" || storyRailPlan.arcRouteRail.status !== "ready" || activeArc.status !== "ready") {
    throw new Error("Canary common context requires ready A-Rail, B-Rail, and active Arc content.");
  }
  const activeRoute = storyRailPlan.arcRouteRail.entries.find((entry) => entry.status === "active");
  if (!activeRoute || activeRoute.arcId !== activeArc.id) {
    throw new Error("Canary ready B-Rail is not bound to the active ready Arc.");
  }
  const context = ProductionCanaryCommonContextSchema.parse({
    schemaVersion: "inkos-canary-common-context/v1",
    bookId,
    commonSnapshotSha256: input.receipt.commonSnapshotSha256,
    sourceArtifacts: {
      bookConfig: artifactRef(config),
      brief: artifactRef(brief),
      storyRailPlan: artifactRef(rail),
      activeArcPointer: artifactRef(pointer),
      activeArc: artifactRef(activeArcArtifact),
    },
    bookConfig,
    brief: parseNonblankUtf8(brief.bytes, "Canary Book brief"),
    storyRailPlan,
    activeArcPointer,
    activeArc,
  });
  const bytes = Buffer.from(`${JSON.stringify(context, null, 2)}\n`, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > CONTEXT_MAX_BYTES) {
    throw new Error(`Canary common context must be 1-${CONTEXT_MAX_BYTES} bytes.`);
  }
  return bytes;
}

async function ensureReviewDirectory(projectRoot: string, pairId: string): Promise<string> {
  const pairRoot = await assertNoSymlinkComponents(projectRoot, join(".inkos", "canaries", pairId), "Canary pair root");
  const reviewRoot = join(pairRoot, "review");
  try {
    const info = await lstat(reviewRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Canary review root must be a real directory.");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(reviewRoot, { recursive: false });
    await assertRealDirectory(reviewRoot, "Canary review root");
  }
  return reviewRoot;
}

function resultFromBytes(
  receipt: CanaryCommonSnapshotReceipt,
  bytes: Buffer,
  replayed: boolean,
): MaterializeProductionCanaryCommonContextResult {
  return {
    schemaVersion: "inkos-canary-common-context-result/v1",
    pairId: receipt.pairId,
    bookId: receipt.bookId,
    commonSnapshotSha256: receipt.commonSnapshotSha256,
    context: {
      path: toPosixPath(join(".inkos", "canaries", receipt.pairId, "review", "common-context.json")),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
    },
    replayed,
  };
}

/**
 * Materialize one deterministic, public-safe common context from the sealed neutral lane.
 * Existing context bytes are reused exactly; any difference fails closed instead of clobbering.
 */
export async function materializeProductionCanaryCommonContext(
  input: MaterializeProductionCanaryCommonContextInput,
): Promise<MaterializeProductionCanaryCommonContextResult> {
  if (!SAFE_PAIR_ID.test(input.pairId)) throw new Error("Canary pair ID is not filesystem-safe.");
  const projectRoot = await realpath(input.projectRoot);
  await assertRealDirectory(projectRoot, "Source project root");
  const first = await readContextInputs(projectRoot, input.pairId);
  const expectedBytes = contextBytesFromInputs(first);
  const second = await readContextInputs(projectRoot, input.pairId);
  const readbackBytes = contextBytesFromInputs(second);
  if (!first.receiptBytes.equals(second.receiptBytes) || !expectedBytes.equals(readbackBytes)) {
    throw new Error("Canary common context inputs changed while being materialized.");
  }
  const reviewRoot = await ensureReviewDirectory(projectRoot, input.pairId);
  const outputPath = join(reviewRoot, "common-context.json");
  try {
    const existing = await readStableRegularFile(outputPath, "Canary common context");
    const parsed = ProductionCanaryCommonContextSchema.parse(parseJson(existing.bytes, "Canary common context"));
    if (
      parsed.bookId !== second.receipt.bookId
      || parsed.commonSnapshotSha256 !== second.receipt.commonSnapshotSha256
      || !existing.bytes.equals(expectedBytes)
    ) {
      throw new Error("Existing canary common context differs from the sealed deterministic context.");
    }
    return resultFromBytes(second.receipt, existing.bytes, true);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await writeFile(outputPath, expectedBytes, { flag: "wx" });
  } catch (error) {
    if (!isExists(error)) throw error;
    const existing = await readStableRegularFile(outputPath, "Canary common context");
    if (!existing.bytes.equals(expectedBytes)) {
      throw new Error("Concurrent canary common context materialization produced different bytes.");
    }
    return resultFromBytes(second.receipt, existing.bytes, true);
  }
  const final = await readStableRegularFile(outputPath, "Canary common context");
  if (!final.bytes.equals(expectedBytes)) throw new Error("Canary common context raw readback mismatch.");
  return resultFromBytes(second.receipt, final.bytes, false);
}
