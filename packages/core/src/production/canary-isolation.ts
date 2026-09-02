import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import { StateManager } from "../state/manager.js";
import { isSafeBookId } from "../utils/book-id.js";
import { bindBookSoul, loadActiveBookSoulBinding, type BindBookSoulInput } from "./book-soul-binding.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SAFE_SOUL_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const SAFE_AGENT_WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const TRANSIENT_BOOK_FILES = new Set([".write.lock", ".soul-turn.lock"]);
export const CANARY_ISOLATION_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

const processCanaryLeases = new Map<string, string>();

interface CanaryLeaseMetadata {
  readonly schemaVersion: "inkos-canary-lease/v1";
  readonly kind: "prepare" | "agent-operation";
  readonly pairId: string;
  readonly lane: "neutral" | "soul" | null;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

interface CanaryLeaseRecoveryMetadata {
  readonly schemaVersion: "inkos-canary-lease-recovery/v1";
  readonly pairId: string;
  readonly lane: "neutral" | "soul" | null;
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

const RegularFileRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256),
  byteLength: z.number().int().nonnegative(),
}).strict();

const FileManifestSchema = z.object({
  files: z.array(RegularFileRefSchema),
  manifestSha256: z.string().regex(SHA256),
}).strict();

const ExpectedSoulBindingSchema = z.object({
  soulId: z.string().min(1),
  soulVersion: z.string().min(1),
  bindingSha256: z.string().regex(SHA256),
}).strict();

const CanaryLaneSchema = z.object({
  projectRoot: z.string().min(1),
  preBindManifestSha256: z.string().regex(SHA256),
  postBindManifestSha256: z.string().regex(SHA256),
  allowedDeltaPaths: z.array(z.string().min(1)),
  allowedDeltaManifestSha256: z.string().regex(SHA256),
  expectedSoulBinding: ExpectedSoulBindingSchema.nullable(),
}).strict();

const CanaryInputArtifactSchema = RegularFileRefSchema.extend({
  role: z.enum(["soul-package-manifest", "source-registry-receipt", "soul-binding-decision"]),
}).strict();

const CanaryCommonSnapshotUnsignedSchema = z.object({
  schemaVersion: z.literal("inkos-canary-common-snapshot/v1"),
  pairId: z.string().regex(SAFE_PAIR_ID),
  bookId: z.string().refine(isSafeBookId, "Book ID is not filesystem-safe"),
  scopeId: z.string().min(1),
  sourceProjectRootFingerprint: z.string().regex(SHA256),
  sourceConfig: RegularFileRefSchema,
  sourceGenres: z.object({
    state: z.enum(["present", "absent"]),
    files: z.array(RegularFileRefSchema),
    manifestSha256: z.string().regex(SHA256),
  }).strict(),
  sourceBook: FileManifestSchema,
  commonSnapshotSha256: z.string().regex(SHA256),
  isolationScopeSha256: z.string().regex(SHA256),
  soulBindingInputs: z.object({
    soulId: z.string().min(1),
    soulVersion: z.string().min(1),
    artifacts: z.array(CanaryInputArtifactSchema).length(3),
  }).strict(),
  lanes: z.object({
    neutral: CanaryLaneSchema,
    genreSoul: CanaryLaneSchema,
  }).strict(),
  productionBookFingerprint: z.object({
    before: z.string().regex(SHA256),
    after: z.string().regex(SHA256),
    unchanged: z.literal(true),
  }).strict(),
  excludedTransientBookPaths: z.array(z.enum([".soul-turn.lock", ".write.lock"])).length(2),
  createdAt: z.string().datetime(),
}).strict();

export const CanaryCommonSnapshotReceiptSchema = CanaryCommonSnapshotUnsignedSchema.extend({
  receiptSelfHash: z.string().regex(SHA256),
}).strict();

export type CanaryCommonSnapshotReceipt = z.infer<typeof CanaryCommonSnapshotReceiptSchema>;
export type CanaryRegularFileRef = z.infer<typeof RegularFileRefSchema>;

export interface CanaryEvidenceRoots {
  readonly referenceLab: string;
  readonly inkos: string;
  readonly hq: string;
}

export interface CanaryRelativeArtifactInput {
  readonly root: string;
  readonly path: string;
}

export interface PrepareProductionCanaryPairInput {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly pairId: string;
  readonly soulId: string;
  readonly soulVersion: string;
  readonly soulManifestPath: string;
  readonly sourceRegistryReceipt: CanaryRelativeArtifactInput;
  readonly decisionReceipt: CanaryRelativeArtifactInput;
  readonly evidenceRoots: CanaryEvidenceRoots;
  readonly now?: () => Date;
}

export interface PrepareProductionCanaryPairResult {
  readonly schemaVersion: "inkos-canary-prepare-result/v1";
  readonly pairId: string;
  readonly bookId: string;
  readonly scopeId: string;
  readonly sourceProjectRootFingerprint: string;
  readonly commonSnapshotSha256: string;
  readonly isolationScopeSha256: string;
  readonly sourceBook: z.infer<typeof FileManifestSchema>;
  readonly lanes: CanaryCommonSnapshotReceipt["lanes"];
  readonly receipt: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
    readonly selfHash: string;
  };
  readonly replayed: boolean;
}

export interface VerifyProductionCanaryExecutionRootInput {
  readonly projectRoot: string;
  readonly pairId: string;
  readonly lane: "neutral" | "soul";
  readonly receiptSha256: string;
  readonly receiptByteLength: number;
  readonly receiptSelfHash: string;
  readonly isolationScopeSha256: string;
  readonly commonSnapshotSha256: string;
  readonly bookId: string;
  readonly expectedSoulBinding: null | {
    readonly soulId: string;
    readonly soulVersion: string;
    readonly bindingSha256: string;
  };
}

export interface VerifyProductionCanaryTerminalReplayRootInput extends VerifyProductionCanaryExecutionRootInput {
  readonly workOrderId: string;
  readonly finalLaneManifestSha256: string;
}

export const ProductionCanaryExecutionRootVerificationSchema = z.object({
  schemaVersion: z.literal("inkos-canary-execution-root-verification/v1"),
  scopeId: z.string().min(1),
  pairId: z.string().regex(SAFE_PAIR_ID),
  bookId: z.string().refine(isSafeBookId, "Book ID is not filesystem-safe"),
  lane: z.enum(["neutral", "soul"]),
  projectRoot: z.string().min(1),
  sourceProjectRootFingerprint: z.string().regex(SHA256),
  sourceBookManifestSha256: z.string().regex(SHA256),
  laneManifestSha256: z.string().regex(SHA256),
  receipt: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().positive(),
    selfHash: z.string().regex(SHA256),
  }).strict(),
  isolationScopeSha256: z.string().regex(SHA256),
  commonSnapshotSha256: z.string().regex(SHA256),
  expectedSoulBinding: ExpectedSoulBindingSchema.nullable(),
}).strict().superRefine((projection, ctx) => {
  const expectedProjectRoot = laneRelativePath(projection.pairId, projection.lane);
  const expectedReceiptPath = receiptRelativePath(projection.pairId);
  if (projection.scopeId !== isolationScopeId(projection.pairId, projection.bookId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "Canary execution scope ID is not canonical" });
  }
  if (projection.projectRoot !== expectedProjectRoot) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectRoot"], message: "Canary execution project root is not canonical" });
  }
  if (projection.receipt.path !== expectedReceiptPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receipt", "path"], message: "Canary execution receipt path is not canonical" });
  }
  if (projection.lane === "neutral" && projection.expectedSoulBinding !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedSoulBinding"], message: "Neutral canary execution forbids a Soul binding" });
  }
  if (projection.lane === "soul" && projection.expectedSoulBinding === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedSoulBinding"], message: "Soul canary execution requires a Soul binding" });
  }
});

export type ProductionCanaryExecutionRootVerification = z.infer<
  typeof ProductionCanaryExecutionRootVerificationSchema
>;

interface SourceSnapshot {
  readonly config: CanaryRegularFileRef;
  readonly genres: {
    readonly state: "present" | "absent";
    readonly files: readonly CanaryRegularFileRef[];
    readonly manifestSha256: string;
  };
  readonly book: z.infer<typeof FileManifestSchema>;
  readonly commonSnapshotSha256: string;
  readonly sourceProjectRootFingerprint: string;
}

interface DeltaEntry {
  readonly path: string;
  readonly kind: "added";
  readonly after: CanaryRegularFileRef;
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

function safeRelativePath(path: string, label: string): string {
  const normalized = normalize(path);
  if (
    !path.trim()
    || isAbsolute(path)
    || path.includes("\\")
    || normalized !== path
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} must be one normalized relative path.`);
  }
  return normalized;
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory; symlinks are forbidden.`);
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await assertRealDirectory(path, label);
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readRegularFile(
  path: string,
  receiptPath: string,
  maxBytes?: number,
): Promise<{ readonly bytes: Buffer; readonly ref: CanaryRegularFileRef }> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ELOOP") {
      throw new Error(`Canary input must not be a symlink: ${receiptPath}`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Canary input must be a regular file: ${receiptPath}`);
    }
    if (maxBytes !== undefined && before.size > maxBytes) {
      throw new Error(`Canary input exceeds the ${maxBytes}-byte limit: ${receiptPath}`);
    }
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !after.isFile()
      || !pathAfter.isFile()
      || pathAfter.isSymbolicLink()
      || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, pathAfter)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || after.size !== bytes.byteLength
    ) {
      throw new Error(`Canary input changed while it was being read: ${receiptPath}`);
    }
    return {
      bytes,
      ref: { path: toPosixPath(receiptPath), sha256: sha256(bytes), byteLength: bytes.byteLength },
    };
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkComponents(root: string, relativePath: string, label: string): Promise<string> {
  await assertRealDirectory(root, `${label} root`);
  const safe = safeRelativePath(relativePath, label);
  let cursor = root;
  for (const part of safe.split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`${label} contains a forbidden symlink: ${relativePath}`);
  }
  return cursor;
}

async function readRelativeArtifact(
  input: CanaryRelativeArtifactInput,
  role: z.infer<typeof CanaryInputArtifactSchema>["role"],
): Promise<{ readonly absolutePath: string; readonly bytes: Buffer; readonly ref: z.infer<typeof CanaryInputArtifactSchema> }> {
  const absolutePath = await assertNoSymlinkComponents(input.root, input.path, role);
  const read = await readRegularFile(absolutePath, input.path);
  return { absolutePath, bytes: read.bytes, ref: { ...read.ref, role } };
}

async function collectRegularFileManifest(
  root: string,
  receiptPrefix: string,
  excludeRootRelativePaths: ReadonlySet<string> = new Set(),
): Promise<z.infer<typeof FileManifestSchema>> {
  await assertRealDirectory(root, receiptPrefix || "manifest root");
  const files: CanaryRegularFileRef[] = [];

  const walk = async (directory: string, rootRelative: string): Promise<void> => {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const nextRootRelative = rootRelative ? join(rootRelative, name) : name;
      if (excludeRootRelativePaths.has(toPosixPath(nextRootRelative))) continue;
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      const receiptPath = toPosixPath(receiptPrefix ? join(receiptPrefix, nextRootRelative) : nextRootRelative);
      if (info.isSymbolicLink()) throw new Error(`Canary snapshot rejects symlink: ${receiptPath}`);
      if (info.isDirectory()) {
        await walk(absolute, nextRootRelative);
      } else if (info.isFile()) {
        files.push((await readRegularFile(absolute, receiptPath)).ref);
      } else {
        throw new Error(`Canary snapshot accepts only directories and regular files: ${receiptPath}`);
      }
    }
  };

  await walk(root, "");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return FileManifestSchema.parse({ files, manifestSha256: hashCanonicalJson(files) });
}

async function collectSourceSnapshot(projectRoot: string, bookId: string): Promise<SourceSnapshot> {
  const configRead = await readRegularFile(join(projectRoot, "inkos.json"), "inkos.json");
  const genresRoot = join(projectRoot, "genres");
  let genres: SourceSnapshot["genres"];
  try {
    await assertRealDirectory(genresRoot, "Project genres directory");
    const manifest = await collectRegularFileManifest(genresRoot, "genres");
    genres = {
      state: "present",
      files: manifest.files,
      manifestSha256: hashCanonicalJson({ state: "present", files: manifest.files }),
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    genres = { state: "absent", files: [], manifestSha256: hashCanonicalJson({ state: "absent", files: [] }) };
  }

  const bookRelative = join("books", bookId);
  const book = await collectRegularFileManifest(
    join(projectRoot, bookRelative),
    bookRelative,
    TRANSIENT_BOOK_FILES,
  );
  const commonSnapshot = {
    schemaVersion: "inkos-canary-source-snapshot/v1" as const,
    config: configRead.ref,
    genres,
    book,
  };
  const commonSnapshotSha256 = hashCanonicalJson(commonSnapshot);
  return {
    config: configRead.ref,
    genres,
    book,
    commonSnapshotSha256,
    sourceProjectRootFingerprint: hashCanonicalJson({
      schemaVersion: "inkos-canary-source-project-fingerprint/v1",
      commonSnapshotSha256,
    }),
  };
}

async function copyRef(sourceRoot: string, targetRoot: string, ref: CanaryRegularFileRef): Promise<void> {
  const relativePath = safeRelativePath(ref.path.split("/").join(sep), "Snapshot file path");
  const sourcePath = await assertNoSymlinkComponents(sourceRoot, relativePath, "Snapshot source");
  const read = await readRegularFile(sourcePath, ref.path);
  if (read.ref.sha256 !== ref.sha256 || read.ref.byteLength !== ref.byteLength) {
    throw new Error(`Snapshot source changed before clone: ${ref.path}`);
  }
  const destination = join(targetRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, read.bytes, { flag: "wx" });
  const copied = await readRegularFile(destination, ref.path);
  if (copied.ref.sha256 !== ref.sha256 || copied.ref.byteLength !== ref.byteLength) {
    throw new Error(`Snapshot clone readback failed: ${ref.path}`);
  }
}

async function cloneSourceSnapshot(
  projectRoot: string,
  laneRoot: string,
  bookId: string,
  snapshot: SourceSnapshot,
): Promise<void> {
  await mkdir(laneRoot, { recursive: false });
  await assertRealDirectory(laneRoot, "Canary lane root");
  const refs = [snapshot.config, ...snapshot.genres.files, ...snapshot.book.files];
  for (const ref of refs) await copyRef(projectRoot, laneRoot, ref);
  if (snapshot.genres.state === "present") await ensureRealDirectory(join(laneRoot, "genres"), "Canary genres directory");
  await assertRealDirectory(join(laneRoot, "books"), "Canary books directory");
  await assertRealDirectory(join(laneRoot, "books", bookId), "Canary Book directory");
}

function mapManifest(manifest: z.infer<typeof FileManifestSchema>): Map<string, CanaryRegularFileRef> {
  return new Map(manifest.files.map((entry) => [entry.path, entry]));
}

function computeAllowedDelta(
  neutral: z.infer<typeof FileManifestSchema>,
  genreSoul: z.infer<typeof FileManifestSchema>,
  bookId: string,
): DeltaEntry[] {
  const before = mapManifest(neutral);
  const after = mapManifest(genreSoul);
  const allowedPrefixes = [
    ".inkos/production/souls/objects/",
    `books/${bookId}/story/soul-bindings/`,
  ];
  const delta: DeltaEntry[] = [];
  for (const [path, beforeRef] of before) {
    const afterRef = after.get(path);
    if (!afterRef) throw new Error(`Soul binding deleted a common snapshot file: ${path}`);
    if (afterRef.sha256 !== beforeRef.sha256 || afterRef.byteLength !== beforeRef.byteLength) {
      throw new Error(`Soul binding modified a common snapshot file: ${path}`);
    }
  }
  for (const [path, afterRef] of after) {
    if (before.has(path)) continue;
    if (!allowedPrefixes.some((prefix) => path.startsWith(prefix))) {
      throw new Error(`Soul binding created a file outside the allowed delta: ${path}`);
    }
    delta.push({ path, kind: "added", after: afterRef });
  }
  delta.sort((left, right) => left.path.localeCompare(right.path));
  if (delta.length === 0) throw new Error("Soul binding did not create an explicit isolated-lane delta.");
  return delta;
}

function receiptRelativePath(pairId: string): string {
  return toPosixPath(join(".inkos", "canaries", pairId, "common-snapshot.json"));
}

function isolationScopeId(pairId: string, bookId: string): string {
  return `canary-pair:${pairId}:${bookId}`;
}

function laneRelativePath(pairId: string, lane: "neutral" | "soul"): string {
  return toPosixPath(join(".inkos", "canaries", pairId, lane));
}

export function parseCanaryCommonSnapshotReceiptBytes(bytes: Uint8Array): CanaryCommonSnapshotReceipt {
  if (bytes.byteLength < 1 || bytes.byteLength > CANARY_ISOLATION_RECEIPT_MAX_BYTES) {
    throw new Error(`Canary common snapshot receipt must be 1-${CANARY_ISOLATION_RECEIPT_MAX_BYTES} bytes.`);
  }
  const raw = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Canary common snapshot receipt must be an object.");
  }
  const rawRecord = raw as Record<string, unknown>;
  const rawSelfHash = rawRecord.receiptSelfHash;
  if (typeof rawSelfHash !== "string" || !SHA256.test(rawSelfHash)) {
    throw new Error("Canary common snapshot receipt self-hash is invalid.");
  }
  const { receiptSelfHash: _self, ...rawUnsigned } = rawRecord;
  if (hashCanonicalJson(rawUnsigned) !== rawSelfHash) {
    throw new Error("Canary common snapshot receipt raw self-hash mismatch.");
  }
  return CanaryCommonSnapshotReceiptSchema.parse(raw);
}

async function readSealedReceipt(path: string): Promise<{ readonly receipt: CanaryCommonSnapshotReceipt; readonly bytes: Buffer }> {
  const read = await readRegularFile(path, toPosixPath(path), CANARY_ISOLATION_RECEIPT_MAX_BYTES);
  return { receipt: parseCanaryCommonSnapshotReceiptBytes(read.bytes), bytes: read.bytes };
}

function assertReceiptDerivedIntegrity(receipt: CanaryCommonSnapshotReceipt): void {
  if (!isSafeBookId(receipt.bookId)) throw new Error("Canary receipt Book ID is not filesystem-safe.");
  const expectedNeutralRoot = laneRelativePath(receipt.pairId, "neutral");
  const expectedGenreSoulRoot = laneRelativePath(receipt.pairId, "soul");
  if (
    receipt.scopeId !== isolationScopeId(receipt.pairId, receipt.bookId)
    || receipt.lanes.neutral.projectRoot !== expectedNeutralRoot
    || receipt.lanes.genreSoul.projectRoot !== expectedGenreSoulRoot
    || receipt.lanes.neutral.expectedSoulBinding !== null
    || receipt.lanes.neutral.allowedDeltaPaths.length !== 0
    || receipt.lanes.neutral.preBindManifestSha256 !== receipt.lanes.neutral.postBindManifestSha256
  ) {
    throw new Error("Canary receipt lane scope is not canonical.");
  }
  const artifactRoles = receipt.soulBindingInputs.artifacts.map((artifact) => artifact.role).sort();
  if (JSON.stringify(artifactRoles) !== JSON.stringify([
    "soul-binding-decision",
    "soul-package-manifest",
    "source-registry-receipt",
  ])) {
    throw new Error("Canary receipt Soul binding inputs are incomplete or duplicated.");
  }
  const assertCanonicalRefs = (refs: readonly CanaryRegularFileRef[], prefix: string, label: string) => {
    const paths = refs.map((ref) => ref.path);
    const sorted = [...paths].sort((left, right) => left.localeCompare(right));
    if (
      JSON.stringify(paths) !== JSON.stringify(sorted)
      || new Set(paths).size !== paths.length
      || paths.some((path) => !path.startsWith(prefix) || path.includes("\\") || path.includes("../"))
    ) {
      throw new Error(`Canary receipt ${label} paths are not canonical.`);
    }
  };
  if (receipt.sourceConfig.path !== "inkos.json") throw new Error("Canary receipt source config path is not canonical.");
  assertCanonicalRefs(receipt.sourceGenres.files, "genres/", "genre");
  assertCanonicalRefs(receipt.sourceBook.files, `books/${receipt.bookId}/`, "Book");
  if (
    (receipt.sourceGenres.state === "absent" && receipt.sourceGenres.files.length !== 0)
    || !receipt.sourceBook.files.some((ref) => ref.path === `books/${receipt.bookId}/book.json`)
  ) {
    throw new Error("Canary receipt source topology is incomplete.");
  }
  for (const artifact of receipt.soulBindingInputs.artifacts) {
    safeRelativePath(artifact.path.split("/").join(sep), `Canary ${artifact.role} receipt path`);
  }
  if (
    receipt.sourceBook.manifestSha256 !== hashCanonicalJson(receipt.sourceBook.files)
    || receipt.sourceGenres.manifestSha256 !== hashCanonicalJson({
      state: receipt.sourceGenres.state,
      files: receipt.sourceGenres.files,
    })
  ) {
    throw new Error("Canary receipt source manifest hash mismatch.");
  }
  const expectedCommonSnapshotSha256 = hashCanonicalJson({
    schemaVersion: "inkos-canary-source-snapshot/v1",
    config: receipt.sourceConfig,
    genres: receipt.sourceGenres,
    book: receipt.sourceBook,
  });
  if (
    receipt.commonSnapshotSha256 !== expectedCommonSnapshotSha256
    || receipt.sourceProjectRootFingerprint !== hashCanonicalJson({
      schemaVersion: "inkos-canary-source-project-fingerprint/v1",
      commonSnapshotSha256: expectedCommonSnapshotSha256,
    })
  ) {
    throw new Error("Canary receipt common snapshot fingerprint mismatch.");
  }
  const expectedDeltaPaths = [...receipt.lanes.genreSoul.allowedDeltaPaths].sort((left, right) => left.localeCompare(right));
  if (
    expectedDeltaPaths.length === 0
    || JSON.stringify(expectedDeltaPaths) !== JSON.stringify(receipt.lanes.genreSoul.allowedDeltaPaths)
    || new Set(expectedDeltaPaths).size !== expectedDeltaPaths.length
    || expectedDeltaPaths.some((path) => !(
      path.startsWith(".inkos/production/souls/objects/")
      || path.startsWith(`books/${receipt.bookId}/story/soul-bindings/`)
    ))
  ) {
    throw new Error("Canary receipt allowed Soul delta paths are invalid.");
  }
  if (
    receipt.lanes.neutral.allowedDeltaManifestSha256 !== hashCanonicalJson([])
    || receipt.lanes.genreSoul.allowedDeltaManifestSha256 !== hashCanonicalJson(expectedDeltaPaths)
  ) {
    throw new Error("Canary receipt allowed delta manifest hash mismatch.");
  }
  const expectedIsolationScopeSha256 = hashCanonicalJson({
    schemaVersion: "inkos-canary-isolation-scope/v1",
    scopeId: receipt.scopeId,
    pairId: receipt.pairId,
    bookId: receipt.bookId,
    sourceProjectRootFingerprint: receipt.sourceProjectRootFingerprint,
    receiptPath: receiptRelativePath(receipt.pairId),
    laneProjectRoots: [expectedNeutralRoot, expectedGenreSoulRoot],
    allowedDeltaPaths: expectedDeltaPaths,
  });
  if (
    receipt.isolationScopeSha256 !== expectedIsolationScopeSha256
    || receipt.productionBookFingerprint.before !== receipt.sourceBook.manifestSha256
    || receipt.productionBookFingerprint.after !== receipt.sourceBook.manifestSha256
  ) {
    throw new Error("Canary receipt isolation or production fingerprint mismatch.");
  }
}

/** Load and authenticate one pair-level isolation receipt without trusting an absolute path from the receipt. */
export async function loadCanaryCommonSnapshotReceipt(
  projectRoot: string,
  pairId: string,
): Promise<CanaryCommonSnapshotReceipt> {
  if (!SAFE_PAIR_ID.test(pairId)) throw new Error("Canary pair ID is not filesystem-safe.");
  await assertRealDirectory(projectRoot, "Source project root");
  const pairRoot = await assertNoSymlinkComponents(
    projectRoot,
    join(".inkos", "canaries", pairId),
    "Canary pair root",
  );
  await assertRealDirectory(pairRoot, "Canary pair root");
  const stored = await readSealedReceipt(join(pairRoot, "common-snapshot.json"));
  if (stored.receipt.pairId !== pairId) throw new Error("Canary receipt pair ID does not match its canonical path.");
  assertReceiptDerivedIntegrity(stored.receipt);
  for (const lane of [stored.receipt.lanes.neutral, stored.receipt.lanes.genreSoul]) {
    const laneRoot = await assertNoSymlinkComponents(projectRoot, lane.projectRoot.split("/").join(sep), "Canary lane root");
    await assertRealDirectory(laneRoot, "Canary lane root");
  }
  return stored.receipt;
}

/**
 * Fail-closed preflight for `production agent-operate` in a canary lane.
 * The caller supplies every pair-level hash; this function derives the source
 * project from the lane path and never trusts an absolute source path in IPC.
 */
async function verifyProductionCanaryRoot(
  input: VerifyProductionCanaryExecutionRootInput,
  requirePristineLane: boolean,
): Promise<ProductionCanaryExecutionRootVerification> {
  if (!SAFE_PAIR_ID.test(input.pairId) || !isSafeBookId(input.bookId)) {
    throw new Error("Canary execution identity is not filesystem-safe.");
  }
  for (const [label, value] of [
    ["receiptSha256", input.receiptSha256],
    ["receiptSelfHash", input.receiptSelfHash],
    ["isolationScopeSha256", input.isolationScopeSha256],
    ["commonSnapshotSha256", input.commonSnapshotSha256],
  ] as const) {
    if (!SHA256.test(value)) throw new Error(`Canary execution ${label} is invalid.`);
  }
  if (
    !Number.isInteger(input.receiptByteLength)
    || input.receiptByteLength < 1
    || input.receiptByteLength > CANARY_ISOLATION_RECEIPT_MAX_BYTES
  ) {
    throw new Error("Canary execution receiptByteLength is invalid.");
  }
  const laneRelative = laneRelativePath(input.pairId, input.lane);
  const lexicalLaneRoot = resolve(input.projectRoot);
  await assertRealDirectory(lexicalLaneRoot, "Canary execution project root");
  const lexicalPairRoot = dirname(lexicalLaneRoot);
  const lexicalCanariesRoot = dirname(lexicalPairRoot);
  const lexicalRuntimeRoot = dirname(lexicalCanariesRoot);
  if (
    basename(lexicalLaneRoot) !== input.lane
    || basename(lexicalPairRoot) !== input.pairId
    || basename(lexicalCanariesRoot) !== "canaries"
    || basename(lexicalRuntimeRoot) !== ".inkos"
  ) {
    throw new Error("Canary execution cwd is not shaped as the canonical lane project root.");
  }
  const lexicalSourceRoot = resolve(lexicalLaneRoot, "../../../..");
  const sourceRoot = await realpath(lexicalSourceRoot);
  await assertRealDirectory(sourceRoot, "Derived source project root");
  const expectedLaneRoot = await assertNoSymlinkComponents(
    sourceRoot,
    laneRelative.split("/").join(sep),
    "Canonical canary execution root",
  );
  const [actualLaneReal, expectedLaneReal] = await Promise.all([
    realpath(lexicalLaneRoot),
    realpath(expectedLaneRoot),
  ]);
  if (actualLaneReal !== expectedLaneReal) {
    throw new Error("Canary execution cwd is not the exact canonical lane project root.");
  }

  const receiptPath = receiptRelativePath(input.pairId);
  const receiptAbsolute = await assertNoSymlinkComponents(
    sourceRoot,
    receiptPath.split("/").join(sep),
    "Canary common snapshot receipt",
  );
  const stored = await readSealedReceipt(receiptAbsolute);
  assertReceiptDerivedIntegrity(stored.receipt);
  const receipt = stored.receipt;
  const laneReceipt = input.lane === "neutral" ? receipt.lanes.neutral : receipt.lanes.genreSoul;
  if (
    receipt.pairId !== input.pairId
    || receipt.bookId !== input.bookId
    || laneReceipt.projectRoot !== laneRelative
    || sha256(stored.bytes) !== input.receiptSha256
    || stored.bytes.byteLength !== input.receiptByteLength
    || receipt.receiptSelfHash !== input.receiptSelfHash
    || receipt.isolationScopeSha256 !== input.isolationScopeSha256
    || receipt.commonSnapshotSha256 !== input.commonSnapshotSha256
    || hashCanonicalJson(laneReceipt.expectedSoulBinding) !== hashCanonicalJson(input.expectedSoulBinding)
  ) {
    throw new Error("Canary execution request does not match the exact pair-level isolation receipt.");
  }

  const sourceState = new StateManager(sourceRoot);
  const laneState = new StateManager(actualLaneReal);
  const releaseSourceSoul = await sourceState.acquireBookSoulTurnLock(input.bookId);
  let releaseSourceBook: (() => Promise<void>) | undefined;
  let releaseLaneSoul: (() => Promise<void>) | undefined;
  let releaseLaneBook: (() => Promise<void>) | undefined;
  try {
    releaseSourceBook = await sourceState.acquireBookLock(input.bookId);
    releaseLaneSoul = await laneState.acquireBookSoulTurnLock(input.bookId);
    releaseLaneBook = await laneState.acquireBookLock(input.bookId);
    const [sourceSnapshot, laneManifest, activeBinding] = await Promise.all([
      collectSourceSnapshot(sourceRoot, input.bookId),
      collectRegularFileManifest(actualLaneReal, "", new Set([
        toPosixPath(join("books", input.bookId, ".soul-turn.lock")),
        toPosixPath(join("books", input.bookId, ".write.lock")),
      ])),
      loadActiveBookSoulBinding(actualLaneReal, input.bookId),
    ]);
    if (
      sourceSnapshot.book.manifestSha256 !== receipt.sourceBook.manifestSha256
      || sourceSnapshot.commonSnapshotSha256 !== receipt.commonSnapshotSha256
      || sourceSnapshot.sourceProjectRootFingerprint !== receipt.sourceProjectRootFingerprint
    ) {
      throw new Error("Source production Book no longer matches the sealed canary snapshot.");
    }
    if (requirePristineLane && laneManifest.manifestSha256 !== laneReceipt.postBindManifestSha256) {
      throw new Error("Canary execution lane changed after its sealed preparation snapshot.");
    }
    const activeSessionBinding = activeBinding
      ? { soulId: activeBinding.soulId, soulVersion: activeBinding.version, bindingSha256: activeBinding.bindingSha256 }
      : null;
    if (hashCanonicalJson(activeSessionBinding) !== hashCanonicalJson(input.expectedSoulBinding)) {
      throw new Error("Canary execution lane active Soul binding does not match the sealed expectation.");
    }
    return ProductionCanaryExecutionRootVerificationSchema.parse({
      schemaVersion: "inkos-canary-execution-root-verification/v1",
      scopeId: receipt.scopeId,
      pairId: receipt.pairId,
      bookId: receipt.bookId,
      lane: input.lane,
      projectRoot: laneReceipt.projectRoot,
      sourceProjectRootFingerprint: receipt.sourceProjectRootFingerprint,
      sourceBookManifestSha256: receipt.sourceBook.manifestSha256,
      laneManifestSha256: requirePristineLane ? laneManifest.manifestSha256 : laneReceipt.postBindManifestSha256,
      receipt: {
        path: receiptPath,
        sha256: input.receiptSha256,
        byteLength: stored.bytes.byteLength,
        selfHash: receipt.receiptSelfHash,
      },
      isolationScopeSha256: receipt.isolationScopeSha256,
      commonSnapshotSha256: receipt.commonSnapshotSha256,
      expectedSoulBinding: input.expectedSoulBinding,
    });
  } finally {
    try {
      await releaseLaneBook?.();
    } finally {
      try {
        await releaseLaneSoul?.();
      } finally {
        try {
          await releaseSourceBook?.();
        } finally {
          await releaseSourceSoul();
        }
      }
    }
  }
}

/** Full first-run preflight; the lane must still equal the immutable prepared snapshot. */
export async function verifyProductionCanaryExecutionRoot(
  input: VerifyProductionCanaryExecutionRootInput,
): Promise<ProductionCanaryExecutionRootVerification> {
  return verifyProductionCanaryRoot(input, true);
}

/**
 * Read-only replay preflight for the canonical root, receipt, source Book, and
 * active Soul binding. The terminal's sealed final manifest is checked by
 * `verifyProductionCanaryTerminalReplayRoot` before replay is returned.
 */
export async function verifyProductionCanaryStructuralRoot(
  input: VerifyProductionCanaryExecutionRootInput,
): Promise<ProductionCanaryExecutionRootVerification> {
  return verifyProductionCanaryRoot(input, false);
}

function agentTerminalLaneRelativePath(bookId: string, workOrderId: string): string {
  if (!isSafeBookId(bookId) || !SAFE_AGENT_WORK_ORDER_ID.test(workOrderId)) {
    throw new Error("Canary Agent terminal identity is not filesystem-safe.");
  }
  return toPosixPath(join(
    "books",
    bookId,
    "story",
    "runtime",
    "hermes-control",
    workOrderId,
    "terminal.json",
  ));
}

function finalLaneManifestExclusions(bookId: string, workOrderId: string): ReadonlySet<string> {
  return new Set([
    toPosixPath(join("books", bookId, ".soul-turn.lock")),
    toPosixPath(join("books", bookId, ".write.lock")),
    agentTerminalLaneRelativePath(bookId, workOrderId),
  ]);
}

/** Sealable whole-lane fingerprint excluding only locks and its self-referential terminal file. */
export async function collectProductionCanaryFinalLaneManifestSha256(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly workOrderId: string;
}): Promise<string> {
  const laneRoot = resolve(input.projectRoot);
  await assertRealDirectory(laneRoot, "Canary execution project root");
  const manifest = await collectRegularFileManifest(
    laneRoot,
    "",
    finalLaneManifestExclusions(input.bookId, input.workOrderId),
  );
  return manifest.manifestSha256;
}

/** Authenticate an immutable terminal replay against the current whole lane. */
export async function verifyProductionCanaryTerminalReplayRoot(
  input: VerifyProductionCanaryTerminalReplayRootInput,
): Promise<ProductionCanaryExecutionRootVerification> {
  if (!SHA256.test(input.finalLaneManifestSha256)) {
    throw new Error("Canary terminal finalLaneManifestSha256 is invalid.");
  }
  const structural = await verifyProductionCanaryStructuralRoot(input);
  const current = await collectProductionCanaryFinalLaneManifestSha256(input);
  if (current !== input.finalLaneManifestSha256) {
    throw new Error("Canary terminal replay lane differs from its sealed final manifest.");
  }
  return structural;
}

function buildResult(
  receipt: CanaryCommonSnapshotReceipt,
  bytes: Buffer,
  replayed: boolean,
): PrepareProductionCanaryPairResult {
  return {
    schemaVersion: "inkos-canary-prepare-result/v1",
    pairId: receipt.pairId,
    bookId: receipt.bookId,
    scopeId: receipt.scopeId,
    sourceProjectRootFingerprint: receipt.sourceProjectRootFingerprint,
    commonSnapshotSha256: receipt.commonSnapshotSha256,
    isolationScopeSha256: receipt.isolationScopeSha256,
    sourceBook: receipt.sourceBook,
    lanes: receipt.lanes,
    receipt: {
      path: receiptRelativePath(receipt.pairId),
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      selfHash: receipt.receiptSelfHash,
    },
    replayed,
  };
}

async function verifyReplay(
  finalPairRoot: string,
  current: SourceSnapshot,
  input: PrepareProductionCanaryPairInput,
  inputArtifacts: readonly z.infer<typeof CanaryInputArtifactSchema>[],
): Promise<PrepareProductionCanaryPairResult> {
  await assertRealDirectory(finalPairRoot, "Existing canary pair root");
  const stored = await readSealedReceipt(join(finalPairRoot, "common-snapshot.json"));
  const receipt = stored.receipt;
  assertReceiptDerivedIntegrity(receipt);
  if (
    receipt.pairId !== input.pairId
    || receipt.bookId !== input.bookId
    || receipt.soulBindingInputs.soulId !== input.soulId
    || receipt.soulBindingInputs.soulVersion !== input.soulVersion
    || receipt.commonSnapshotSha256 !== current.commonSnapshotSha256
    || receipt.sourceProjectRootFingerprint !== current.sourceProjectRootFingerprint
    || receipt.productionBookFingerprint.after !== current.book.manifestSha256
    || hashCanonicalJson(receipt.soulBindingInputs.artifacts) !== hashCanonicalJson(inputArtifacts)
  ) {
    throw new Error("Existing canary pair does not match the exact immutable prepare request or current source snapshot.");
  }
  const canonicalPairRoot = await assertNoSymlinkComponents(
    input.projectRoot,
    join(".inkos", "canaries", input.pairId),
    "Existing canary pair root",
  );
  if (await realpath(canonicalPairRoot) !== await realpath(finalPairRoot)) {
    throw new Error("Existing canary pair is not at its canonical real path.");
  }
  for (const [laneName, lane] of [
    ["neutral", receipt.lanes.neutral],
    ["soul", receipt.lanes.genreSoul],
  ] as const) {
    const laneRoot = await assertNoSymlinkComponents(
      input.projectRoot,
      lane.projectRoot.split("/").join(sep),
      `Existing ${laneName} canary root`,
    );
    await assertRealDirectory(laneRoot, `Existing ${laneName} canary root`);
    const laneState = new StateManager(laneRoot);
    const releaseSoul = await laneState.acquireBookSoulTurnLock(input.bookId);
    let releaseBook: (() => Promise<void>) | undefined;
    try {
      releaseBook = await laneState.acquireBookLock(input.bookId);
      const [manifest, activeBinding] = await Promise.all([
        collectRegularFileManifest(laneRoot, "", new Set([
          toPosixPath(join("books", input.bookId, ".soul-turn.lock")),
          toPosixPath(join("books", input.bookId, ".write.lock")),
        ])),
        loadActiveBookSoulBinding(laneRoot, input.bookId),
      ]);
      const projectedBinding = activeBinding
        ? { soulId: activeBinding.soulId, soulVersion: activeBinding.version, bindingSha256: activeBinding.bindingSha256 }
        : null;
      if (
        manifest.manifestSha256 !== lane.postBindManifestSha256
        || hashCanonicalJson(projectedBinding) !== hashCanonicalJson(lane.expectedSoulBinding)
      ) {
        throw new Error(`Existing ${laneName} canary lane is not the full immutable prepared snapshot.`);
      }
    } finally {
      try {
        await releaseBook?.();
      } finally {
        await releaseSoul();
      }
    }
  }
  return buildResult(receipt, stored.bytes, true);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

function parseCanaryLease(bytes: Buffer): CanaryLeaseMetadata | undefined {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    if (
      value.schemaVersion !== "inkos-canary-lease/v1"
      || (value.kind !== "prepare" && value.kind !== "agent-operation")
      || typeof value.pairId !== "string"
      || !SAFE_PAIR_ID.test(value.pairId)
      || (value.lane !== null && value.lane !== "neutral" && value.lane !== "soul")
      || !Number.isInteger(value.pid)
      || Number(value.pid) < 1
      || typeof value.token !== "string"
      || !/^[0-9a-f-]{36}$/iu.test(value.token)
      || typeof value.startedAt !== "string"
      || Number.isNaN(Date.parse(value.startedAt))
    ) return undefined;
    return value as unknown as CanaryLeaseMetadata;
  } catch {
    return undefined;
  }
}

async function moveOwnedLeaseAside(input: {
  readonly lockPath: string;
  readonly expectedBytes: Buffer;
  readonly token: string;
  readonly reason: "stale" | "release";
}): Promise<boolean> {
  let current: Buffer;
  try {
    current = (await readRegularFile(input.lockPath, input.lockPath, 64 * 1024)).bytes;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!current.equals(input.expectedBytes) || parseCanaryLease(current)?.token !== input.token) return false;
  const tombstone = `${input.lockPath}.${input.reason}-${input.token}-${randomUUID()}`;
  try {
    await rename(input.lockPath, tombstone);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  const moved = await readRegularFile(tombstone, tombstone, 64 * 1024);
  if (!moved.bytes.equals(input.expectedBytes) || parseCanaryLease(moved.bytes)?.token !== input.token) {
    throw new Error(`Canary ${input.reason} lease ownership changed during atomic retirement.`);
  }
  await unlink(tombstone);
  return true;
}

/**
 * Serialize retirement of a dead pathname lease. Without this guard, two
 * recoverers can both authenticate the same dead file; after the first moves it
 * and a new owner appears, the second recoverer could rename the new owner's
 * pathname. Recovery guards are deliberately not auto-reclaimed: a crash in
 * this tiny critical section fails closed and requires operator inspection.
 */
async function acquireCanaryLeaseRecoveryGuard(input: {
  readonly lockPath: string;
  readonly pairId: string;
  readonly lane: CanaryLeaseMetadata["lane"];
  readonly busyMessage: string;
}): Promise<() => Promise<void>> {
  const recoveryPath = `${input.lockPath}.recovery`;
  const metadata: CanaryLeaseRecoveryMetadata = {
    schemaVersion: "inkos-canary-lease-recovery/v1",
    pairId: input.pairId,
    lane: input.lane,
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  let handle: FileHandle;
  try {
    handle = await open(recoveryPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new Error(`${input.busyMessage} Dead-lease recovery is already in progress or requires operator inspection.`);
    }
    throw error;
  }
  let closed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    const readback = await readRegularFile(recoveryPath, recoveryPath, 64 * 1024);
    if (!readback.bytes.equals(bytes)) throw new Error("Canary dead-lease recovery guard readback failed.");
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(recoveryPath).catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    const current = await readRegularFile(recoveryPath, recoveryPath, 64 * 1024);
    if (!current.bytes.equals(bytes)) {
      throw new Error("Canary dead-lease recovery guard ownership changed; refusing to delete it.");
    }
    await unlink(recoveryPath);
    released = true;
  };
}

async function acquireCanaryLease(input: {
  readonly lockPath: string;
  readonly kind: CanaryLeaseMetadata["kind"];
  readonly pairId: string;
  readonly lane: CanaryLeaseMetadata["lane"];
  readonly busyMessage: string;
}): Promise<() => Promise<void>> {
  const lockKey = resolve(input.lockPath);
  if (processCanaryLeases.has(lockKey)) throw new Error(input.busyMessage);
  const metadata: CanaryLeaseMetadata = {
    schemaVersion: "inkos-canary-lease/v1",
    kind: input.kind,
    pairId: input.pairId,
    lane: input.lane,
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  processCanaryLeases.set(lockKey, metadata.token);
  try {
    let acquired = false;
    for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
      try {
        const handle = await open(input.lockPath, "wx");
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await moveOwnedLeaseAside({
            lockPath: input.lockPath,
            expectedBytes: bytes,
            token: metadata.token,
            reason: "release",
          }).catch(() => undefined);
          throw error;
        }
        await handle.close();
        const readback = await readRegularFile(input.lockPath, input.lockPath, 64 * 1024);
        if (!readback.bytes.equals(bytes)) throw new Error("Canary lease raw readback failed.");
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
        const existingRead = await readRegularFile(input.lockPath, input.lockPath, 64 * 1024).catch((readError) => {
          if (isMissing(readError)) return undefined;
          throw readError;
        });
        if (!existingRead) continue;
        const existing = parseCanaryLease(existingRead.bytes);
        if (!existing || existing.kind !== input.kind || existing.pairId !== input.pairId || existing.lane !== input.lane) {
          throw new Error(`${input.busyMessage} Existing lease metadata is invalid; fail-closed operator recovery is required.`);
        }
        if (isProcessAlive(existing.pid)) throw new Error(input.busyMessage);
        const releaseRecoveryGuard = await acquireCanaryLeaseRecoveryGuard({
          lockPath: input.lockPath,
          pairId: input.pairId,
          lane: input.lane,
          busyMessage: input.busyMessage,
        });
        let retired = false;
        try {
          retired = await moveOwnedLeaseAside({
            lockPath: input.lockPath,
            expectedBytes: existingRead.bytes,
            token: existing.token,
            reason: "stale",
          });
        } finally {
          await releaseRecoveryGuard();
        }
        if (!retired) continue;
      }
    }
    if (!acquired) throw new Error(input.busyMessage);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (processCanaryLeases.get(lockKey) === metadata.token) processCanaryLeases.delete(lockKey);
      await moveOwnedLeaseAside({
        lockPath: input.lockPath,
        expectedBytes: bytes,
        token: metadata.token,
        reason: "release",
      }).catch((error) => {
        console.warn(`[inkos] Failed to release canary lease ${input.lockPath}: ${String(error)}`);
      });
    };
  } catch (error) {
    if (processCanaryLeases.get(lockKey) === metadata.token) processCanaryLeases.delete(lockKey);
    throw error;
  }
}

/**
 * Serialize one isolated lane from the final pristine check through terminal
 * readback. The lease lives at the pair root, so it never contaminates either
 * lane manifest.
 */
export async function acquireProductionCanaryAgentOperationLease(input: {
  readonly projectRoot: string;
  readonly pairId: string;
  readonly lane: "neutral" | "soul";
}): Promise<() => Promise<void>> {
  if (!SAFE_PAIR_ID.test(input.pairId)) throw new Error("Canary pair ID is not filesystem-safe.");
  const laneRoot = resolve(input.projectRoot);
  const pairRoot = dirname(laneRoot);
  if (basename(laneRoot) !== input.lane || basename(pairRoot) !== input.pairId) {
    throw new Error("Canary Agent lease requires the exact canonical lane project root.");
  }
  await assertRealDirectory(laneRoot, "Canary Agent lane root");
  await assertRealDirectory(pairRoot, "Canary Agent pair root");
  const [laneReal, pairReal] = await Promise.all([realpath(laneRoot), realpath(pairRoot)]);
  if (dirname(laneReal) !== pairReal) throw new Error("Canary Agent lane root is not inside its real pair root.");
  return acquireCanaryLease({
    lockPath: join(pairRoot, `.agent-${input.lane}.lock`),
    kind: "agent-operation",
    pairId: input.pairId,
    lane: input.lane,
    busyMessage: `Canary ${input.pairId}/${input.lane} is already running an Agent operation.`,
  });
}

/**
 * Creates two independent real InkOS project roots from one locked Book snapshot.
 * The neutral lane stays byte-identical; only the genre-Soul lane is rebound.
 */
export async function prepareProductionCanaryPair(
  input: PrepareProductionCanaryPairInput,
): Promise<PrepareProductionCanaryPairResult> {
  if (!isSafeBookId(input.bookId)) throw new Error("Canary Book ID is not filesystem-safe.");
  if (!SAFE_PAIR_ID.test(input.pairId)) throw new Error("Canary pair ID is not filesystem-safe.");
  if (!SAFE_SOUL_IDENTITY.test(input.soulId) || !SAFE_SOUL_IDENTITY.test(input.soulVersion)) {
    throw new Error("Canary Soul identity is invalid.");
  }
  await assertRealDirectory(input.projectRoot, "Source project root");
  const state = new StateManager(input.projectRoot);
  const sourceBookDir = state.bookDir(input.bookId);
  await assertRealDirectory(sourceBookDir, "Source Book directory");
  const book = await state.loadBookConfig(input.bookId);
  if (book.id !== input.bookId) throw new Error("Source Book config does not match the requested Book ID.");

  for (const [label, root] of Object.entries(input.evidenceRoots)) {
    await assertRealDirectory(root, `${label} evidence root`);
  }
  await assertRealDirectory(input.sourceRegistryReceipt.root, "Source registry receipt root");
  await assertRealDirectory(input.decisionReceipt.root, "Soul binding decision root");
  const soulManifest = await readRelativeArtifact(
    { root: input.evidenceRoots.inkos, path: input.soulManifestPath },
    "soul-package-manifest",
  );
  const sourceRegistry = await readRelativeArtifact(input.sourceRegistryReceipt, "source-registry-receipt");
  const decision = await readRelativeArtifact(input.decisionReceipt, "soul-binding-decision");
  const inputArtifacts = [soulManifest.ref, sourceRegistry.ref, decision.ref]
    .sort((left, right) => left.role.localeCompare(right.role));

  const releaseSoulTurn = await state.acquireBookSoulTurnLock(input.bookId);
  let releaseBook: (() => Promise<void>) | undefined;
  let releasePairLease: (() => Promise<void>) | undefined;
  let stagingPairRoot: string | undefined;
  try {
    releaseBook = await state.acquireBookLock(input.bookId);
    if (await loadActiveBookSoulBinding(input.projectRoot, input.bookId)) {
      throw new Error("Canary source Book must have no active Writer Soul binding so the neutral lane stays neutral.");
    }
    const before = await collectSourceSnapshot(input.projectRoot, input.bookId);
    const canariesRoot = join(input.projectRoot, ".inkos", "canaries");
    await ensureRealDirectory(join(input.projectRoot, ".inkos"), "InkOS runtime directory");
    await ensureRealDirectory(canariesRoot, "Canary root directory");
    const finalPairRoot = join(canariesRoot, input.pairId);
    try {
      await lstat(finalPairRoot);
      return await verifyReplay(finalPairRoot, before, input, inputArtifacts);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    releasePairLease = await acquireCanaryLease({
      lockPath: join(canariesRoot, `.${input.pairId}.prepare.lock`),
      kind: "prepare",
      pairId: input.pairId,
      lane: null,
      busyMessage: "The requested canary pair is already being prepared; retry after the active operation finishes.",
    });
    try {
      await lstat(finalPairRoot);
      return await verifyReplay(finalPairRoot, before, input, inputArtifacts);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    stagingPairRoot = join(canariesRoot, `.${input.pairId}.prepare-${randomUUID()}`);
    await mkdir(stagingPairRoot, { recursive: false });
    await assertRealDirectory(stagingPairRoot, "Canary staging pair root");
    const neutralRoot = join(stagingPairRoot, "neutral");
    const genreSoulRoot = join(stagingPairRoot, "soul");
    await cloneSourceSnapshot(input.projectRoot, neutralRoot, input.bookId, before);
    await cloneSourceSnapshot(input.projectRoot, genreSoulRoot, input.bookId, before);
    const neutralPre = await collectRegularFileManifest(neutralRoot, "");
    const genreSoulPre = await collectRegularFileManifest(genreSoulRoot, "");
    if (neutralPre.manifestSha256 !== genreSoulPre.manifestSha256) {
      throw new Error("Canary lane clones are not byte-identical before Soul binding.");
    }

    const bindInput: BindBookSoulInput = {
      projectRoot: genreSoulRoot,
      bookId: input.bookId,
      manifestPath: soulManifest.absolutePath,
      sourceRegistryReceiptPath: sourceRegistry.absolutePath,
      decisionReceiptPath: decision.absolutePath,
      status: "candidate",
      evidenceRoots: input.evidenceRoots,
      now: input.now,
    };
    const binding = await bindBookSoul(bindInput);
    if (
      binding.schemaVersion !== "book-soul-binding/v2"
      || binding.status !== "candidate"
      || binding.soulId !== input.soulId
      || binding.version !== input.soulVersion
      || binding.adoptionEvidence.hqAdoption !== null
    ) {
      throw new Error("Canary genre Soul lane requires the exact unpromoted evidence-bound candidate Soul v2.");
    }
    const [soulManifestReadback, sourceRegistryReadback, decisionReadback] = await Promise.all([
      readRelativeArtifact({ root: input.evidenceRoots.inkos, path: input.soulManifestPath }, "soul-package-manifest"),
      readRelativeArtifact(input.sourceRegistryReceipt, "source-registry-receipt"),
      readRelativeArtifact(input.decisionReceipt, "soul-binding-decision"),
    ]);
    const inputReadback = [soulManifestReadback.ref, sourceRegistryReadback.ref, decisionReadback.ref]
      .sort((left, right) => left.role.localeCompare(right.role));
    if (hashCanonicalJson(inputReadback) !== hashCanonicalJson(inputArtifacts)) {
      throw new Error("Canary Soul binding input artifacts changed during preparation.");
    }

    const [neutralPost, genreSoulPost] = await Promise.all([
      collectRegularFileManifest(neutralRoot, ""),
      collectRegularFileManifest(genreSoulRoot, ""),
    ]);
    if (neutralPost.manifestSha256 !== neutralPre.manifestSha256) {
      throw new Error("Neutral canary lane changed while the genre Soul lane was bound.");
    }
    const delta = computeAllowedDelta(neutralPost, genreSoulPost, input.bookId);
    const after = await collectSourceSnapshot(input.projectRoot, input.bookId);
    if (
      after.book.manifestSha256 !== before.book.manifestSha256
      || after.commonSnapshotSha256 !== before.commonSnapshotSha256
      || after.sourceProjectRootFingerprint !== before.sourceProjectRootFingerprint
    ) {
      throw new Error("Production source project changed while its isolated canary pair was prepared.");
    }
    const neutralProjectRoot = laneRelativePath(input.pairId, "neutral");
    const genreSoulProjectRoot = laneRelativePath(input.pairId, "soul");
    const allowedDeltaPaths = delta.map((entry) => entry.path);
    const scopeId = isolationScopeId(input.pairId, input.bookId);
    const isolationScopeSha256 = hashCanonicalJson({
      schemaVersion: "inkos-canary-isolation-scope/v1",
      scopeId,
      pairId: input.pairId,
      bookId: input.bookId,
      sourceProjectRootFingerprint: before.sourceProjectRootFingerprint,
      receiptPath: receiptRelativePath(input.pairId),
      laneProjectRoots: [neutralProjectRoot, genreSoulProjectRoot],
      allowedDeltaPaths,
    });
    const unsigned = CanaryCommonSnapshotUnsignedSchema.parse({
      schemaVersion: "inkos-canary-common-snapshot/v1",
      pairId: input.pairId,
      bookId: input.bookId,
      scopeId,
      sourceProjectRootFingerprint: before.sourceProjectRootFingerprint,
      sourceConfig: before.config,
      sourceGenres: before.genres,
      sourceBook: before.book,
      commonSnapshotSha256: before.commonSnapshotSha256,
      isolationScopeSha256,
      soulBindingInputs: {
        soulId: input.soulId,
        soulVersion: input.soulVersion,
        artifacts: inputArtifacts,
      },
      lanes: {
        neutral: {
          projectRoot: neutralProjectRoot,
          preBindManifestSha256: neutralPre.manifestSha256,
          postBindManifestSha256: neutralPost.manifestSha256,
          allowedDeltaPaths: [],
          allowedDeltaManifestSha256: hashCanonicalJson([]),
          expectedSoulBinding: null,
        },
        genreSoul: {
          projectRoot: genreSoulProjectRoot,
          preBindManifestSha256: genreSoulPre.manifestSha256,
          postBindManifestSha256: genreSoulPost.manifestSha256,
          allowedDeltaPaths,
          allowedDeltaManifestSha256: hashCanonicalJson(allowedDeltaPaths),
          expectedSoulBinding: {
            soulId: binding.soulId,
            soulVersion: binding.version,
            bindingSha256: binding.bindingSha256,
          },
        },
      },
      productionBookFingerprint: {
        before: before.book.manifestSha256,
        after: after.book.manifestSha256,
        unchanged: true,
      },
      excludedTransientBookPaths: [".soul-turn.lock", ".write.lock"],
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    const receipt = CanaryCommonSnapshotReceiptSchema.parse({
      ...unsigned,
      receiptSelfHash: hashCanonicalJson(unsigned),
    });
    assertReceiptDerivedIntegrity(receipt);
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (receiptBytes.byteLength > CANARY_ISOLATION_RECEIPT_MAX_BYTES) {
      throw new Error(`Canary common snapshot receipt exceeds ${CANARY_ISOLATION_RECEIPT_MAX_BYTES} bytes.`);
    }
    await writeFile(join(stagingPairRoot, "common-snapshot.json"), receiptBytes, { flag: "wx" });
    const stagedReadback = await readSealedReceipt(join(stagingPairRoot, "common-snapshot.json"));
    if (sha256(stagedReadback.bytes) !== sha256(receiptBytes)) throw new Error("Canary receipt raw readback mismatch.");
    try {
      await lstat(finalPairRoot);
      throw new Error("Canary pair appeared during no-clobber preparation.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await rename(stagingPairRoot, finalPairRoot);
    stagingPairRoot = undefined;
    const finalReadback = await readSealedReceipt(join(finalPairRoot, "common-snapshot.json"));
    if (sha256(finalReadback.bytes) !== sha256(receiptBytes)) throw new Error("Final canary receipt raw readback mismatch.");
    return buildResult(finalReadback.receipt, finalReadback.bytes, false);
  } finally {
    if (stagingPairRoot) await rm(stagingPairRoot, { recursive: true, force: true });
    await releasePairLease?.();
    try {
      await releaseBook?.();
    } finally {
      await releaseSoulTurn();
    }
  }
}
