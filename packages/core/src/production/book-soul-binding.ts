import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { readGenreProfileWithReceipt } from "../agents/rules-reader.js";
import { FireflyRuntimeModelSchema } from "./model-policy.js";
import { StateManager } from "../state/manager.js";
import { runBookMutationTransaction } from "../state/book-mutation-journal.js";
import { commitAtomicFileSet, syncDirectory } from "../utils/atomic-file-set.js";
import {
  validateCanonicalManagerQaReceipt,
  validateCanonicalRoutingCatalog,
  validateCanonicalSoulAnalysisProfile,
} from "./soul-adoption-validator.js";
import {
  assertCanonicalEvidenceTopology,
  TRUSTED_ADOPTION_REPOSITORIES,
  type SoulEvidenceRoots,
} from "./soul-evidence-topology.js";
import {
  ActiveSoulPointerSchema,
  BookSoulBindingSchema,
  SessionSoulBindingSchema,
  SoulBindingDecisionReceiptSchema,
  SoulPackageManifestSchema,
  type SoulAdoptionEvidence,
  type SoulEvidenceArtifactRef,
  type ActiveSoulPointer,
  type BookSoulBinding,
  type SessionSoulBinding,
  type SoulLifecycle,
  type SoulPackageManifest,
} from "./soul-schema.js";
import {
  ProductionSoulInputReceiptSchema,
  hashCanonical,
  sha256Bytes,
  type ProductionSoulInputReceipt,
} from "./production-input.js";

const SOUL_OBJECT_ROOT = join(".inkos", "production", "souls", "objects");
const BINDING_ROOT = join("story", "soul-bindings");
const ACTIVE_POINTER_PATH = join(BINDING_ROOT, "current.json");
const ALLOWED_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml"]);
const MAX_SOUL_FILE_BYTES = 512 * 1024;
const MAX_SOUL_PACKAGE_BYTES = 2 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const EXECUTOR_PROFILE_IDS: Readonly<Record<string, string>> = {
  "male-modern-fantasy-ko": "inkos_male_modern_fantasy",
  "male-fantasy-ko": "inkos_male_fantasy",
  "male-murim-ko": "inkos_male_murim",
};
const HERMES_PROFILE_KEYS = [
  "profileId", "soulId", "soulVersion", "lifecycle", "productionEnabled",
  "promotionDecisionSha256", "provider", "model", "reasoning", "skillsPolicy",
  "configSha256", "soulSha256",
] as const;
const HQ_DECISION_KEYS = [
  "schemaVersion", "soulId", "soulVersion", "candidateSoulSha256", "promptPackSha256",
  "referenceLabEligibility", "inputReceiptSha256s", "decisionId", "decision",
  "decidedByActorId", "decidedByRole", "approvalReceiptSha256", "decidedAt",
] as const;
const HQ_DECISION_INPUT_KEYS = [
  "sourceManifest", "coverage", "managerQa", "pathCanary", "promotionCanary",
  "pairedGeneration", "blindReviews", "genreIdentity", "reviewPacket",
] as const;
const HQ_ACTIVE_ENTRY_KEYS = [
  "soulId", "soulVersion", "soulSha256", "profileId", "profileConfigSha256",
  "decisionPath", "decisionSha256",
] as const;

export interface BindBookSoulInput {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly manifestPath: string;
  readonly sourceRegistryReceiptPath: string;
  readonly decisionReceiptPath: string;
  readonly status: SoulLifecycle;
  readonly evidenceRoots?: SoulEvidenceRoots;
  readonly now?: () => Date;
}

export interface ResolvedBookSoulInput {
  readonly binding: BookSoulBinding;
  readonly sessionBinding: SessionSoulBinding;
  readonly promptInput: string;
  readonly receipt: ProductionSoulInputReceipt;
}

interface ValidatedTextFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function safeRelativePath(value: string): string {
  const normalized = normalize(value);
  if (
    !value.trim()
    || isAbsolute(value)
    || normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Soul package path must stay inside its package: ${value}`);
  }
  return normalized;
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) throw new Error(`Soul text contains NUL bytes: ${label}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Soul text is not valid UTF-8: ${label}`, { cause: error });
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

async function readSecureText(root: string, relativePath: string): Promise<ValidatedTextFile> {
  const safePath = safeRelativePath(relativePath);
  if (!ALLOWED_TEXT_EXTENSIONS.has(extname(safePath).toLowerCase())) {
    throw new Error(`Soul resource extension is not allowed: ${safePath}`);
  }
  await assertRealDirectory(root, "Soul package root");
  const parts = safePath.split(sep);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`Soul package symlink is not allowed: ${safePath}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Soul package path component is not a directory: ${safePath}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`Soul package resource is not a regular file: ${safePath}`);
    }
  }
  const bytes = await readFile(cursor);
  if (bytes.byteLength > MAX_SOUL_FILE_BYTES) {
    throw new Error(`Soul resource exceeds ${MAX_SOUL_FILE_BYTES} bytes: ${safePath}`);
  }
  return {
    path: safePath,
    bytes,
    text: decodeUtf8(bytes, safePath),
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
  };
}

function bindingRelativePath(version: number): string {
  return join(BINDING_ROOT, `v${String(version).padStart(4, "0")}.json`);
}

function decisionRelativePath(decisionId: string): string {
  const safeId = decisionId.replace(/[^a-zA-Z0-9._-]+/gu, "-");
  if (!safeId || safeId !== decisionId) throw new Error("Soul decision ID must be filesystem-safe.");
  return join(BINDING_ROOT, "decisions", `${safeId}.json`);
}

function objectDir(projectRoot: string, objectSha256: string): string {
  return join(projectRoot, SOUL_OBJECT_ROOT, objectSha256);
}

async function assertUnusedDecisionReceipt(bookDir: string, decisionId: string): Promise<void> {
  const path = join(bookDir, decisionRelativePath(decisionId));
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Soul binding decision ID is already used: ${decisionId}`);
}

async function readRegular(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Soul evidence is not a regular file: ${path}`);
  return readFile(path);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = asObject(value, label);
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys are not canonical.`);
  }
  return result;
}

function validShaList(value: unknown, minimum: number, exactLength?: number): boolean {
  return Array.isArray(value)
    && value.length >= minimum
    && (exactLength === undefined || value.length === exactLength)
    && value.every((entry) => typeof entry === "string" && SHA256_HEX.test(entry))
    && new Set(value).size === value.length;
}

function parseJsonObject(file: ValidatedTextFile, label: string): Record<string, unknown> {
  try {
    return asObject(JSON.parse(file.text), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`, { cause: error });
    throw error;
  }
}

function readGitObject(repoRoot: string, commit: string, path: string, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "-C", repoRoot, "show", `${commit}:${path}`],
      { encoding: "buffer", maxBuffer: MAX_SOUL_FILE_BYTES },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${label} is not readable from declared Git commit ${commit}.`, { cause: error }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function readGitText(repoRoot: string, args: string[], label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-replace-objects", "-C", repoRoot, ...args],
      { encoding: "utf8", maxBuffer: MAX_SOUL_FILE_BYTES },
      (error, stdout) => {
        if (error) {
          reject(new Error(`${label} Git evidence could not be verified.`, { cause: error }));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function assertGitCommitRemoteReachable(
  repoRoot: string,
  commit: string,
  label: string,
  expected: { readonly origin: string; readonly branch: string },
): Promise<void> {
  const origin = await readGitText(repoRoot, ["remote", "get-url", "origin"], label);
  if (origin !== expected.origin) {
    throw new Error(`${label} origin is not the canonical Firefly repository.`);
  }
  const [upstreamRemote, upstreamMerge] = await Promise.all([
    readGitText(repoRoot, ["config", "--get", `branch.${expected.branch}.remote`], label),
    readGitText(repoRoot, ["config", "--get", `branch.${expected.branch}.merge`], label),
  ]);
  if (upstreamRemote !== "origin" || upstreamMerge !== `refs/heads/${expected.branch}`) {
    throw new Error(`${label} branch is not configured against the canonical origin upstream.`);
  }
  const remoteBranch = `refs/remotes/origin/${expected.branch}`;
  const [remoteTip, remoteReflog] = await Promise.all([
    readGitText(repoRoot, ["rev-parse", "--verify", `${remoteBranch}^{commit}`], label),
    readGitText(repoRoot, ["reflog", "show", "-1", "--format=%H %gs", remoteBranch], label),
  ]);
  const reflogMatch = /^([0-9a-f]{40})\s+(.+)$/u.exec(remoteReflog);
  if (
    !reflogMatch
    || reflogMatch[1] !== remoteTip
    || !/(?:clone:|fetch|pull|update by push)/iu.test(reflogMatch[2] ?? "")
  ) {
    throw new Error(`${label} remote-tracking branch has no current fetch/push provenance.`);
  }
  try {
    const objectType = await readGitText(repoRoot, ["cat-file", "-t", commit], label);
    if (objectType !== "commit") throw new Error(`${label} object is not a commit.`);
    await readGitText(
      repoRoot,
      ["merge-base", "--is-ancestor", commit, remoteBranch],
      label,
    );
  } catch (error) {
    throw new Error(
      `${label} commit ${commit} is not reachable from origin/${expected.branch}.`,
      { cause: error },
    );
  }
}

async function readGitEvidenceFile(
  repoRoot: string,
  commit: string,
  ref: SoulEvidenceArtifactRef,
  label: string,
): Promise<ValidatedTextFile> {
  const bytes = await readGitObject(repoRoot, commit, ref.path, label);
  const file: ValidatedTextFile = {
    path: ref.path,
    bytes,
    text: decodeUtf8(bytes, ref.path),
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
  };
  if (file.sha256 !== ref.sha256 || file.sizeBytes !== ref.sizeBytes) {
    throw new Error(`${label} committed bytes do not match the adoption evidence.`);
  }
  return file;
}

async function readGitEvidenceArtifact(
  repoRoot: string,
  commit: string,
  ref: SoulEvidenceArtifactRef,
  label: string,
): Promise<{ readonly file: ValidatedTextFile; readonly json: Record<string, unknown> }> {
  const file = await readGitEvidenceFile(repoRoot, commit, ref, label);
  return { file, json: parseJsonObject(file, label) };
}

function writerProfileGitPath(receipt: SoulAdoptionEvidence["writerGenreProfile"]["receipt"]): string {
  if (receipt.source !== "builtin") {
    throw new Error("Genre Soul adoption currently requires a committed builtin InkOS Writer profile.");
  }
  const match = /^builtin-genres\/([^/]+\.md)$/u.exec(receipt.profilePath);
  if (!match) throw new Error("Builtin Writer profile receipt path is invalid.");
  return `packages/core/genres/${match[1]}`;
}

async function verifySoulAdoptionEvidence(input: {
  readonly projectRoot: string;
  readonly bookGenre: string;
  readonly soulId: string;
  readonly soulVersion: string;
  readonly status: SoulLifecycle;
  readonly evidence: SoulAdoptionEvidence;
  readonly evidenceRoots: BindBookSoulInput["evidenceRoots"];
  readonly packageManifest: SoulPackageManifest;
  readonly packageManifestFile: ValidatedTextFile;
  readonly packageFiles: ReadonlyArray<ValidatedTextFile>;
}): Promise<void> {
  await assertCanonicalEvidenceTopology({
    hqCommit: input.evidence.executorSoul.commit,
    evidenceRoots: input.evidenceRoots,
  });
  const expectedBase = `analyses/genre_souls/${input.soulId}/${input.soulVersion}`;
  const expectedAnalysisPath = `${expectedBase}/genre-profile.json`;
  const expectedManagerPath = `${expectedBase}/manager-qa.json`;
  const expectedRoutingPath = `inkos_handoffs/genre-souls/${input.soulId}/${input.soulVersion}/reference-routing-catalog.json`;
  if (
    input.evidence.referenceLab.analysisProfile.path !== expectedAnalysisPath
    || input.evidence.referenceLab.managerQa.path !== expectedManagerPath
    || input.evidence.referenceLab.routingCatalog.path !== expectedRoutingPath
  ) {
    throw new Error("Genre Soul Reference Lab evidence paths do not match the Soul identity.");
  }
  const referenceLabRoot = input.evidenceRoots?.referenceLab;
  if (!referenceLabRoot) throw new Error("Genre Soul adoption evidence requires the Reference Lab repository root.");
  await assertGitCommitRemoteReachable(
    referenceLabRoot,
    input.evidence.referenceLab.commit,
    "Reference Lab evidence",
    TRUSTED_ADOPTION_REPOSITORIES.referenceLab,
  );
  const [analysis, managerQa, routing] = await Promise.all([
    readGitEvidenceArtifact(
      referenceLabRoot,
      input.evidence.referenceLab.commit,
      input.evidence.referenceLab.analysisProfile,
      "Genre Soul analysis profile",
    ),
    readGitEvidenceArtifact(
      referenceLabRoot,
      input.evidence.referenceLab.commit,
      input.evidence.referenceLab.managerQa,
      "Genre Soul Manager QA",
    ),
    readGitEvidenceArtifact(
      referenceLabRoot,
      input.evidence.referenceLab.commit,
      input.evidence.referenceLab.routingCatalog,
      "Genre Soul routing catalog",
    ),
  ]);
  const canonicalAnalysis = validateCanonicalSoulAnalysisProfile(analysis.json, {
    genre: input.bookGenre,
    soulId: input.soulId,
    version: input.soulVersion,
  });
  validateCanonicalManagerQaReceipt(managerQa.json, {
    genre: input.bookGenre,
    soulId: input.soulId,
    version: input.soulVersion,
    profilePath: expectedAnalysisPath,
    profileSha256: input.evidence.referenceLab.analysisProfile.sha256,
    profileSizeBytes: input.evidence.referenceLab.analysisProfile.sizeBytes,
    analysis: canonicalAnalysis,
  });
  validateCanonicalRoutingCatalog(routing.json, {
    genre: input.bookGenre,
    soulId: input.soulId,
    version: input.soulVersion,
    profilePath: expectedAnalysisPath,
    profileSha256: input.evidence.referenceLab.analysisProfile.sha256,
    analysis: canonicalAnalysis,
  });

  const writer = await readGenreProfileWithReceipt(input.projectRoot, input.bookGenre);
  if (hashCanonical(writer.receipt) !== hashCanonical(input.evidence.writerGenreProfile.receipt)) {
    throw new Error("Genre Soul Writer profile does not match the profile InkOS resolves for this Book.");
  }
  const inkosRoot = input.evidenceRoots?.inkos;
  if (!inkosRoot) throw new Error("Genre Soul adoption evidence requires the InkOS repository root.");
  await assertGitCommitRemoteReachable(
    inkosRoot,
    input.evidence.writerGenreProfile.commit,
    "InkOS Writer profile",
    TRUSTED_ADOPTION_REPOSITORIES.inkos,
  );
  const writerGitBytes = await readGitObject(
    inkosRoot,
    input.evidence.writerGenreProfile.commit,
    writerProfileGitPath(input.evidence.writerGenreProfile.receipt),
    "InkOS Writer genre profile",
  );
  if (
    sha256Bytes(writerGitBytes) !== input.evidence.writerGenreProfile.receipt.profileSha256
    || writerGitBytes.byteLength !== input.evidence.writerGenreProfile.receipt.profileSizeBytes
  ) {
    throw new Error("InkOS Writer genre profile committed bytes do not match the adoption evidence.");
  }

  const writerPackage = input.evidence.writerSoulPackage;
  if (writerPackage.commit !== input.evidence.writerGenreProfile.commit) {
    throw new Error("Writer genre profile and Writer Soul package must use one InkOS commit.");
  }
  const packageBase = `packages/core/souls/${input.soulId}/${input.soulVersion}`;
  const expectedManifestPath = `${packageBase}/manifest.json`;
  const expectedPackagePaths = [input.packageManifest.promptPath, ...input.packageManifest.resources]
    .map((path) => `${packageBase}/${path}`);
  if (
    writerPackage.packageManifest.path !== expectedManifestPath
    || JSON.stringify(writerPackage.files.map((file) => file.path)) !== JSON.stringify(expectedPackagePaths)
  ) {
    throw new Error("Writer Soul package evidence paths do not match the package manifest.");
  }
  const expectedPackageSha256 = hashCanonical({
    schemaVersion: "writer-soul-package/v1",
    soulId: input.soulId,
    version: input.soulVersion,
    packageManifest: writerPackage.packageManifest,
    files: writerPackage.files,
  });
  if (writerPackage.packageSha256 !== expectedPackageSha256) {
    throw new Error("Writer Soul package digest does not match its committed file set.");
  }
  const [committedManifest, ...committedFiles] = await Promise.all([
    readGitEvidenceFile(
      inkosRoot,
      writerPackage.commit,
      writerPackage.packageManifest,
      "InkOS Writer Soul package manifest",
    ),
    ...writerPackage.files.map((file, index) => readGitEvidenceFile(
      inkosRoot,
      writerPackage.commit,
      file,
      `InkOS Writer Soul package file[${index}]`,
    )),
  ]);
  if (
    committedManifest.sha256 !== input.packageManifestFile.sha256
    || committedManifest.sizeBytes !== input.packageManifestFile.sizeBytes
    || committedFiles.some((file, index) => (
      file.sha256 !== input.packageFiles[index]?.sha256
      || file.sizeBytes !== input.packageFiles[index]?.sizeBytes
    ))
  ) {
    throw new Error("Installed Writer Soul package bytes do not match the committed InkOS package.");
  }

  const hqRoot = input.evidenceRoots?.hq;
  if (!hqRoot) throw new Error("Genre Soul adoption evidence requires the HQ repository root.");
  const executor = input.evidence.executorSoul;
  if (executor.profileRegistry.path !== "config/hermes-production-profiles.json") {
    throw new Error("Executor Soul profile registry path is not canonical.");
  }
  await assertGitCommitRemoteReachable(
    hqRoot,
    executor.commit,
    "HQ Executor Soul profile",
    TRUSTED_ADOPTION_REPOSITORIES.hq,
  );
  const profileRegistry = await readGitEvidenceArtifact(
    hqRoot,
    executor.commit,
    executor.profileRegistry,
    "HQ Hermes production profile registry",
  );
  const registryEnvelope = exactObject(
    profileRegistry.json,
    ["schemaVersion", "profiles"],
    "HQ Hermes production profile registry",
  );
  if (
    registryEnvelope.schemaVersion !== "hermes-production-profile-registry/v1"
    || !Array.isArray(registryEnvelope.profiles)
  ) {
    throw new Error("HQ Hermes production profile registry is invalid.");
  }
  const expectedProfileId = EXECUTOR_PROFILE_IDS[input.soulId];
  if (!expectedProfileId || executor.profileId !== expectedProfileId) {
    throw new Error("Executor Soul profile ID does not match the Soul identity.");
  }
  const matchingProfiles = registryEnvelope.profiles.filter((value) => (
    value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).profileId === executor.profileId
  ));
  if (matchingProfiles.length !== 1) throw new Error("Executor Soul profile is not unique in the HQ registry.");
  const executorProfile = exactObject(matchingProfiles[0], HERMES_PROFILE_KEYS, "HQ Executor Soul profile");
  if (
    executorProfile.soulId !== input.soulId
    || executorProfile.soulVersion !== input.soulVersion
    || executorProfile.soulSha256 !== executor.soulSha256
    || executorProfile.configSha256 !== executor.configSha256
    || executorProfile.provider !== "openai-codex"
    || !FireflyRuntimeModelSchema.safeParse(executorProfile.model).success
    || executorProfile.reasoning !== "high"
    || executorProfile.skillsPolicy !== "none"
  ) {
    throw new Error("Executor Soul profile identity or runtime configuration drifted.");
  }

  if (input.status === "candidate") {
    if (input.evidence.hqAdoption !== null) {
      throw new Error("Candidate Soul binding must not carry an HQ promotion proof.");
    }
    if (
      executorProfile.lifecycle !== "candidate"
      || executorProfile.productionEnabled !== false
      || executorProfile.promotionDecisionSha256 !== null
    ) {
      throw new Error("Candidate Executor Soul profile lifecycle drifted.");
    }
    return;
  }
  if (input.status !== "promoted") {
    if (input.evidence.hqAdoption !== null) {
      throw new Error("Neutral Soul binding must not carry an HQ promotion proof.");
    }
    if (
      executorProfile.lifecycle !== "candidate"
      || executorProfile.productionEnabled !== false
      || executorProfile.promotionDecisionSha256 !== null
    ) {
      throw new Error("Neutral binding requires a non-production candidate Executor Soul profile.");
    }
    return;
  }
  const hq = input.evidence.hqAdoption;
  if (!hq) throw new Error("Promoted Soul binding requires an HQ promotion decision and active registry proof.");
  if (hq.commit !== executor.commit) {
    throw new Error("Promoted Executor Soul profile and HQ adoption must use one HQ commit.");
  }
  await assertGitCommitRemoteReachable(
    hqRoot,
    hq.commit,
    "HQ Soul adoption",
    TRUSTED_ADOPTION_REPOSITORIES.hq,
  );
  const expectedDecisionPath = `adoptions/genre-souls/${input.soulId}/${input.soulVersion}/decision.json`;
  if (hq.decision.path !== expectedDecisionPath || hq.activeRegistry.path !== "config/genre-soul-adoptions.json") {
    throw new Error("HQ Soul adoption evidence paths do not match the Soul identity.");
  }
  const [decision, registry] = await Promise.all([
    readGitEvidenceArtifact(hqRoot, hq.commit, hq.decision, "HQ Soul promotion decision"),
    readGitEvidenceArtifact(hqRoot, hq.commit, hq.activeRegistry, "HQ Soul active adoption registry"),
  ]);
  const promotionDecision = exactObject(decision.json, HQ_DECISION_KEYS, "HQ Soul promotion decision");
  const inputReceipts = exactObject(
    promotionDecision.inputReceiptSha256s,
    HQ_DECISION_INPUT_KEYS,
    "HQ Soul promotion input receipts",
  );
  const managerQaDigests = Array.isArray(inputReceipts.managerQa) ? inputReceipts.managerQa : [];
  const eligibility = exactObject(
    promotionDecision.referenceLabEligibility,
    ["repo", "commit", "path", "sha256"],
    "HQ Soul Reference Lab eligibility",
  );
  if (
    promotionDecision.schemaVersion !== "genre_soul_promotion/v1"
    || promotionDecision.soulId !== input.soulId
    || promotionDecision.soulVersion !== input.soulVersion
    || promotionDecision.candidateSoulSha256 !== executor.soulSha256
    || typeof promotionDecision.promptPackSha256 !== "string"
    || !SHA256_HEX.test(promotionDecision.promptPackSha256)
    || promotionDecision.decision !== "promote"
    || promotionDecision.decidedByRole !== "owner"
    || typeof promotionDecision.decidedByActorId !== "string"
    || !promotionDecision.decidedByActorId
    || typeof promotionDecision.decisionId !== "string"
    || !promotionDecision.decisionId
    || typeof promotionDecision.approvalReceiptSha256 !== "string"
    || !SHA256_HEX.test(promotionDecision.approvalReceiptSha256)
    || typeof promotionDecision.decidedAt !== "string"
    || !Number.isFinite(Date.parse(promotionDecision.decidedAt))
    || eligibility.repo !== "firefly_reference_lab"
    || eligibility.commit !== input.evidence.referenceLab.commit
    || eligibility.path !== `${expectedBase}/promotion-eligibility.json`
    || typeof eligibility.sha256 !== "string"
    || !SHA256_HEX.test(eligibility.sha256)
    || !["sourceManifest", "pathCanary", "promotionCanary", "reviewPacket"].every((key) => (
      typeof inputReceipts[key] === "string" && SHA256_HEX.test(inputReceipts[key])
    ))
    || !validShaList(inputReceipts.coverage, 1)
    || !validShaList(inputReceipts.managerQa, 1)
    || !validShaList(inputReceipts.pairedGeneration, 3, 3)
    || !validShaList(inputReceipts.blindReviews, 3, 3)
    || !validShaList(inputReceipts.genreIdentity, 3, 3)
    || !managerQaDigests.includes(input.evidence.referenceLab.managerQa.sha256)
    || executorProfile.lifecycle !== "promoted"
    || executorProfile.productionEnabled !== true
    || executorProfile.promotionDecisionSha256 !== hq.decision.sha256
  ) {
    throw new Error("HQ Soul promotion decision does not authorize the exact Reference Lab evidence.");
  }
  const active = Array.isArray(registry.json.active) ? registry.json.active : [];
  const matching = active.filter((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = exactObject(value, HQ_ACTIVE_ENTRY_KEYS, "HQ active Soul adoption entry");
    return entry.soulId === input.soulId
      && entry.soulVersion === input.soulVersion
      && entry.soulSha256 === executor.soulSha256
      && entry.profileId === executor.profileId
      && entry.profileConfigSha256 === executor.configSha256
      && entry.decisionPath === expectedDecisionPath
      && entry.decisionSha256 === hq.decision.sha256;
  });
  const activeRegistry = exactObject(registry.json, ["schemaVersion", "active"], "HQ Soul active adoption registry");
  if (activeRegistry.schemaVersion !== "genre-soul-adoption-registry/v1" || matching.length !== 1) {
    throw new Error("HQ active adoption registry does not point to the exact promotion decision.");
  }
}

async function installSoulObject(input: {
  readonly projectRoot: string;
  readonly objectSha256: string;
  readonly manifestBytes: Buffer;
  readonly sourceRegistryReceiptBytes: Buffer;
  readonly resources: ReadonlyArray<ValidatedTextFile>;
}): Promise<void> {
  const destination = objectDir(input.projectRoot, input.objectSha256);
  try {
    await assertRealDirectory(destination, "Installed Soul object");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const root = join(input.projectRoot, SOUL_OBJECT_ROOT);
  await mkdir(root, { recursive: true });
  const temporary = await mkdtemp(join(root, ".install-"));
  try {
    await writeFile(join(temporary, "manifest.json"), input.manifestBytes);
    await writeFile(join(temporary, "source-registry-receipt.json"), input.sourceRegistryReceiptBytes);
    for (const resource of input.resources) {
      const target = join(temporary, "resources", resource.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, resource.bytes);
    }
    await syncDirectory(temporary);
    try {
      await rename(temporary, destination);
      await syncDirectory(root);
    } catch (error) {
      if (!isMissing(error)) {
        try {
          await assertRealDirectory(destination, "Installed Soul object");
        } catch {
          throw error;
        }
      } else {
        throw error;
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function nextBindingVersion(bookDir: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await readdir(join(bookDir, BINDING_ROOT));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const versions = names.flatMap((name) => {
    const match = /^v(\d{4,})\.json$/u.exec(name);
    return match ? [Number(match[1])] : [];
  });
  return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
}

export function sessionSoulBinding(binding: BookSoulBinding): SessionSoulBinding {
  return SessionSoulBindingSchema.parse({
    soulId: binding.soulId,
    soulVersion: binding.version,
    bindingSha256: binding.bindingSha256,
  });
}

export function sessionSoulBindingsEqual(
  left: SessionSoulBinding | null | undefined,
  right: SessionSoulBinding | null | undefined,
): boolean {
  return hashCanonical(left ?? null) === hashCanonical(right ?? null);
}

export class BookSoulStore {
  constructor(
    private readonly projectRoot: string,
    private readonly bookDir: string,
    private readonly bookId: string,
  ) {}

  private async loadHistory(): Promise<BookSoulBinding[]> {
    let names: string[] = [];
    try {
      names = await readdir(join(this.bookDir, BINDING_ROOT));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const versioned = names.flatMap((name) => {
      const match = /^v(\d{4,})\.json$/u.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((left, right) => left.version - right.version);
    const history: BookSoulBinding[] = [];
    for (const [index, entry] of versioned.entries()) {
      if (entry.version !== index + 1) throw new Error("Soul binding history has a version gap.");
      const bytes = await readRegular(join(this.bookDir, BINDING_ROOT, entry.name));
      const binding = BookSoulBindingSchema.parse(JSON.parse(decodeUtf8(bytes, entry.name)));
      const { bindingSha256: _self, ...unsigned } = binding;
      if (
        binding.bindingVersion !== entry.version
        || binding.bookId !== this.bookId
        || hashCanonical(unsigned) !== binding.bindingSha256
        || binding.previousBindingSha256 !== (history.at(-1)?.bindingSha256 ?? null)
      ) {
        throw new Error(`Soul binding history integrity failed at ${entry.name}.`);
      }
      const decisionBytes = await readRegular(join(this.bookDir, decisionRelativePath(binding.boundByDecisionReceipt)));
      if (sha256Bytes(decisionBytes) !== binding.decisionReceiptSha256) {
        throw new Error(`Soul binding decision receipt hash mismatch at ${entry.name}.`);
      }
      const decision = SoulBindingDecisionReceiptSchema.parse(JSON.parse(decodeUtf8(decisionBytes, entry.name)));
      if (
        decision.decisionId !== binding.boundByDecisionReceipt
        || decision.bookId !== binding.bookId
        || decision.soulId !== binding.soulId
        || decision.soulVersion !== binding.version
        || decision.status !== binding.status
      ) {
        throw new Error(`Soul binding decision does not authorize ${entry.name}.`);
      }
      if (
        (binding.schemaVersion === "book-soul-binding/v2" && (
          decision.schemaVersion !== "soul-binding-decision/v2"
          || hashCanonical(decision.adoptionEvidence) !== hashCanonical(binding.adoptionEvidence)
          || binding.adoptionEvidenceSha256 !== hashCanonical(binding.adoptionEvidence)
          || binding.executorSoulSha256 !== binding.adoptionEvidence.executorSoul.soulSha256
          || binding.writerSoulPackageSha256 !== binding.adoptionEvidence.writerSoulPackage.packageSha256
        ))
        || (binding.schemaVersion === "book-soul-binding/v1" && decision.schemaVersion !== "soul-binding-decision/v1")
      ) {
        throw new Error(`Soul binding adoption evidence does not match ${entry.name}.`);
      }
      history.push(binding);
    }
    return history;
  }

  async loadActive(required = false): Promise<BookSoulBinding | null> {
    let pointerBytes: Buffer;
    try {
      pointerBytes = await readRegular(join(this.bookDir, ACTIVE_POINTER_PATH));
    } catch (error) {
      if (isMissing(error) && !required) {
        if ((await this.loadHistory()).length > 0) {
          throw new Error("Soul binding history exists without an active pointer.");
        }
        return null;
      }
      throw new Error(`Active Soul pointer cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pointer = ActiveSoulPointerSchema.parse(JSON.parse(decodeUtf8(pointerBytes, ACTIVE_POINTER_PATH)));
    const { pointerSha256: _self, ...pointerUnsigned } = pointer;
    if (hashCanonical(pointerUnsigned) !== pointer.pointerSha256 || pointer.bookId !== this.bookId) {
      throw new Error("Active Soul pointer integrity check failed.");
    }
    const bindingBytes = await readRegular(join(this.bookDir, pointer.bindingPath));
    const binding = BookSoulBindingSchema.parse(JSON.parse(decodeUtf8(bindingBytes, pointer.bindingPath)));
    const { bindingSha256: _bindingSelf, ...bindingUnsigned } = binding;
    if (
      hashCanonical(bindingUnsigned) !== binding.bindingSha256
      || binding.bindingSha256 !== pointer.bindingSha256
      || binding.bindingVersion !== pointer.bindingVersion
      || binding.bookId !== this.bookId
    ) {
      throw new Error("Active Soul binding integrity check failed.");
    }
    const history = await this.loadHistory();
    const latest = history.at(-1);
    if (
      !latest
      || latest.bindingSha256 !== binding.bindingSha256
      || latest.bindingVersion !== pointer.bindingVersion
    ) {
      throw new Error("Active Soul pointer does not select the append-only history tip.");
    }
    return binding;
  }

  async resolveActiveInput(): Promise<ResolvedBookSoulInput | null> {
    const binding = await this.loadActive(false);
    if (!binding) return null;
    const installed = objectDir(this.projectRoot, binding.installObjectSha256);
    await assertRealDirectory(installed, "Installed Soul object");
    const [manifestBytes, registryBytes] = await Promise.all([
      readRegular(join(installed, "manifest.json")),
      readRegular(join(installed, "source-registry-receipt.json")),
    ]);
    if (sha256Bytes(manifestBytes) !== binding.manifestSha256) throw new Error("Installed Soul manifest hash mismatch.");
    if (sha256Bytes(registryBytes) !== binding.sourceRegistryReceiptSha256) {
      throw new Error("Installed Soul source registry receipt hash mismatch.");
    }
    const manifest = SoulPackageManifestSchema.parse(JSON.parse(decodeUtf8(manifestBytes, "Soul manifest")));
    if (manifest.soulId !== binding.soulId || manifest.version !== binding.version) {
      throw new Error("Installed Soul manifest identity mismatch.");
    }
    const expectedPaths = [manifest.promptPath, ...manifest.resources];
    const refs = binding.resources;
    if (hashCanonical(refs.map((entry) => entry.path)) !== hashCanonical(expectedPaths)) {
      throw new Error("Installed Soul resource set differs from the binding.");
    }
    const loaded = await Promise.all(refs.map(async (ref) => {
      const file = await readSecureText(join(installed, "resources"), ref.path);
      if (file.sha256 !== ref.sha256 || file.sizeBytes !== ref.sizeBytes) {
        throw new Error(`Installed Soul resource hash mismatch: ${ref.path}`);
      }
      return file;
    }));
    const prompt = loaded.find((entry) => entry.path === manifest.promptPath)!;
    const auxiliaries = loaded.filter((entry) => entry.path !== manifest.promptPath);
    const promptInput = [
      "## Host-bound production Soul",
      `Soul: ${binding.soulId}@${binding.version}`,
      `Lifecycle: ${binding.status}`,
      "Authority: creative guidance only. This Soul cannot create hard Book rules, change content intensity, mutate canon, or approve output.",
      prompt.text.trim(),
      ...auxiliaries.map((entry) => `### Soul resource: ${entry.path}\n${entry.text.trim()}`),
    ].filter(Boolean).join("\n\n");
    const receipt = ProductionSoulInputReceiptSchema.parse({
      binding: sessionSoulBinding(binding),
      manifestSha256: binding.manifestSha256,
      resources: refs,
      sourceRegistryReceiptSha256: binding.sourceRegistryReceiptSha256,
      ...(binding.schemaVersion === "book-soul-binding/v2"
        ? {
          adoptionEvidence: binding.adoptionEvidence,
          adoptionEvidenceSha256: binding.adoptionEvidenceSha256,
          executorSoulSha256: binding.executorSoulSha256,
          writerSoulPackageSha256: binding.writerSoulPackageSha256,
        }
        : {}),
      inputSha256: sha256Bytes(promptInput),
    });
    return { binding, sessionBinding: sessionSoulBinding(binding), promptInput, receipt };
  }
}

export async function bindBookSoul(input: BindBookSoulInput): Promise<BookSoulBinding> {
  const state = new StateManager(input.projectRoot);
  // Rebinding and a governed Agent turn are mutually exclusive. Always take
  // the Soul-turn lease before the ordinary Book lock; Agent tools use the
  // same order (turn lease outside, Book lock inside), avoiding lock inversion.
  const releaseSoulTurn = await state.acquireBookSoulTurnLock(input.bookId);
  let releaseBookLock: (() => Promise<void>) | undefined;
  try {
    releaseBookLock = await state.acquireBookLock(input.bookId);
    const book = await state.loadBookConfig(input.bookId);
    if (book.id !== input.bookId) throw new Error("Soul binding Book config mismatch.");
    const bookDir = state.bookDir(input.bookId);
    const manifestAbsolute = isAbsolute(input.manifestPath) ? input.manifestPath : join(input.projectRoot, input.manifestPath);
    const packageRoot = dirname(manifestAbsolute);
    await assertRealDirectory(packageRoot, "Soul package root");
    const manifestRelative = relative(packageRoot, manifestAbsolute);
    const manifestFile = await readSecureText(packageRoot, manifestRelative);
    const manifest = SoulPackageManifestSchema.parse(JSON.parse(manifestFile.text));
    const resourcePaths = [manifest.promptPath, ...manifest.resources];
    const resources = await Promise.all(resourcePaths.map((path) => readSecureText(packageRoot, path)));
    const totalBytes = manifestFile.sizeBytes + resources.reduce((sum, resource) => sum + resource.sizeBytes, 0);
    if (totalBytes > MAX_SOUL_PACKAGE_BYTES) throw new Error(`Soul package exceeds ${MAX_SOUL_PACKAGE_BYTES} bytes.`);
    const registryBytes = await readRegular(isAbsolute(input.sourceRegistryReceiptPath)
      ? input.sourceRegistryReceiptPath
      : join(input.projectRoot, input.sourceRegistryReceiptPath));
    if (registryBytes.byteLength > MAX_SOUL_FILE_BYTES) {
      throw new Error(`Soul source registry receipt exceeds ${MAX_SOUL_FILE_BYTES} bytes.`);
    }
    const registryText = decodeUtf8(registryBytes, "Soul source registry receipt");
    const registryJson = JSON.parse(registryText);
    if (!registryJson || typeof registryJson !== "object" || Array.isArray(registryJson)) {
      throw new Error("Soul source registry receipt must be a JSON object.");
    }
    const decisionBytes = await readRegular(isAbsolute(input.decisionReceiptPath)
      ? input.decisionReceiptPath
      : join(input.projectRoot, input.decisionReceiptPath));
    if (decisionBytes.byteLength > MAX_SOUL_FILE_BYTES) {
      throw new Error(`Soul decision receipt exceeds ${MAX_SOUL_FILE_BYTES} bytes.`);
    }
    const decision = SoulBindingDecisionReceiptSchema.parse(JSON.parse(decodeUtf8(decisionBytes, "Soul decision receipt")));
    if (
      decision.bookId !== input.bookId
      || decision.soulId !== manifest.soulId
      || decision.soulVersion !== manifest.version
      || decision.status !== input.status
    ) {
      throw new Error("Soul binding decision receipt does not match the requested binding.");
    }
    if (input.status === "candidate" || input.status === "promoted") {
      if (decision.schemaVersion !== "soul-binding-decision/v2") {
        throw new Error(`New ${input.status} Soul bindings require Soul adoption evidence v2.`);
      }
      await verifySoulAdoptionEvidence({
        projectRoot: input.projectRoot,
        bookGenre: book.genre,
        soulId: manifest.soulId,
        soulVersion: manifest.version,
        status: input.status,
        evidence: decision.adoptionEvidence,
        evidenceRoots: input.evidenceRoots,
        packageManifest: manifest,
        packageManifestFile: manifestFile,
        packageFiles: resources,
      });
    } else if (decision.schemaVersion === "soul-binding-decision/v2") {
      await verifySoulAdoptionEvidence({
        projectRoot: input.projectRoot,
        bookGenre: book.genre,
        soulId: manifest.soulId,
        soulVersion: manifest.version,
        status: input.status,
        evidence: decision.adoptionEvidence,
        evidenceRoots: input.evidenceRoots,
        packageManifest: manifest,
        packageManifestFile: manifestFile,
        packageFiles: resources,
      });
    }
    await assertUnusedDecisionReceipt(bookDir, decision.decisionId);
    const resourceRefs = resources.map((resource) => ({
      path: resource.path,
      sha256: resource.sha256,
      sizeBytes: resource.sizeBytes,
    }));
    const objectSha256 = hashCanonical({
      manifestSha256: manifestFile.sha256,
      sourceRegistryReceiptSha256: sha256Bytes(registryBytes),
      resources: resourceRefs,
      adoptionEvidence: decision.schemaVersion === "soul-binding-decision/v2"
        ? decision.adoptionEvidence
        : null,
    });
    await installSoulObject({
      projectRoot: input.projectRoot,
      objectSha256,
      manifestBytes: manifestFile.bytes,
      sourceRegistryReceiptBytes: registryBytes,
      resources,
    });
    const installed = objectDir(input.projectRoot, objectSha256);
    const [installedManifest, installedRegistry, ...installedResources] = await Promise.all([
      readRegular(join(installed, "manifest.json")),
      readRegular(join(installed, "source-registry-receipt.json")),
      ...resourceRefs.map((resource) => readSecureText(join(installed, "resources"), resource.path)),
    ]);
    if (
      sha256Bytes(installedManifest) !== manifestFile.sha256
      || sha256Bytes(installedRegistry) !== sha256Bytes(registryBytes)
      || installedResources.some((resource, index) => (
        resource.sha256 !== resourceRefs[index]!.sha256
        || resource.sizeBytes !== resourceRefs[index]!.sizeBytes
      ))
    ) {
      throw new Error("Installed Soul object failed content-addressed readback.");
    }
    const store = new BookSoulStore(input.projectRoot, bookDir, input.bookId);
    const previous = await store.loadActive(false);
    const version = await nextBindingVersion(bookDir);
    const boundAt = (input.now ?? (() => new Date()))().toISOString();
    const unsigned = {
      schemaVersion: decision.schemaVersion === "soul-binding-decision/v2"
        ? "book-soul-binding/v2" as const
        : "book-soul-binding/v1" as const,
      bindingVersion: version,
      bookId: input.bookId,
      soulId: manifest.soulId,
      version: manifest.version,
      manifestSha256: manifestFile.sha256,
      resources: resourceRefs,
      sourceRegistryReceiptSha256: sha256Bytes(registryBytes),
      installObjectSha256: objectSha256,
      status: input.status,
      boundByDecisionReceipt: decision.decisionId,
      decisionReceiptSha256: sha256Bytes(decisionBytes),
      previousBindingSha256: previous?.bindingSha256 ?? null,
      boundAt,
      ...(decision.schemaVersion === "soul-binding-decision/v2"
        ? {
          adoptionEvidence: decision.adoptionEvidence,
          adoptionEvidenceSha256: hashCanonical(decision.adoptionEvidence),
          executorSoulSha256: decision.adoptionEvidence.executorSoul.soulSha256,
          writerSoulPackageSha256: decision.adoptionEvidence.writerSoulPackage.packageSha256,
        }
        : {}),
    };
    const binding = BookSoulBindingSchema.parse({ ...unsigned, bindingSha256: hashCanonical(unsigned) });
    const bindingPath = bindingRelativePath(version);
    const pointerUnsigned = {
      schemaVersion: "active-soul-pointer/v1" as const,
      bookId: input.bookId,
      bindingVersion: version,
      bindingPath: bindingPath.split(sep).join("/"),
      bindingSha256: binding.bindingSha256,
      updatedAt: boundAt,
    };
    const pointer: ActiveSoulPointer = ActiveSoulPointerSchema.parse({
      ...pointerUnsigned,
      pointerSha256: hashCanonical(pointerUnsigned),
    });
    const decisionPath = decisionRelativePath(decision.decisionId);
    await runBookMutationTransaction({
      bookDir,
      kind: "bind-book-soul",
      relativePaths: [bindingPath, ACTIVE_POINTER_PATH, decisionPath],
      persist: () => commitAtomicFileSet({
        rootDir: bookDir,
        writes: [
          { relativePath: bindingPath, content: `${JSON.stringify(binding, null, 2)}\n` },
          { relativePath: ACTIVE_POINTER_PATH, content: `${JSON.stringify(pointer, null, 2)}\n` },
          { relativePath: decisionPath, content: decisionBytes },
        ],
      }),
    });
    return await store.loadActive(true) ?? binding;
  } finally {
    try {
      await releaseBookLock?.();
    } finally {
      await releaseSoulTurn();
    }
  }
}

export async function loadActiveBookSoulBinding(projectRoot: string, bookId: string): Promise<BookSoulBinding | null> {
  const state = new StateManager(projectRoot);
  return new BookSoulStore(projectRoot, state.bookDir(bookId), bookId).loadActive(false);
}

export async function loadActiveBookSoulSessionBinding(
  projectRoot: string,
  bookId: string,
): Promise<SessionSoulBinding | null> {
  const binding = await loadActiveBookSoulBinding(projectRoot, bookId);
  return binding ? sessionSoulBinding(binding) : null;
}
