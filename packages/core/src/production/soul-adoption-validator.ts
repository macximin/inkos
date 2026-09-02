const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u;
const GENRES = new Set(["modern-fantasy-ko", "fantasy-ko", "murim-ko"]);
const SELECTION_BASES = ["commercial-anchor", "genre-breadth", "surface-anchor"] as const;
const ROUTES = [
  ["spine", "commercial-anchor"],
  ["style", "surface-anchor"],
  ["supporting", "genre-breadth"],
] as const;
type JsonObject = Record<string, unknown>;

export interface CanonicalSoulAnalysis {
  readonly sourceByBasis: ReadonlyMap<string, string>;
  readonly sourceIds: ReadonlyArray<string>;
  readonly privateRunInputDigest: string;
  readonly synthesisRunId: string;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function exact(value: unknown, keys: readonly string[], label: string): JsonObject {
  const result = object(value, label);
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys are not canonical.`);
  }
  return result;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty.`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be SHA-256.`);
  return value;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${label} must be a string array.`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length || result.some((entry, index) => entry !== [...result].sort()[index])) {
    throw new Error(`${label} must be unique and sorted.`);
  }
  return result;
}

function ref(value: unknown, label: string): JsonObject {
  const result = exact(value, ["path", "sha256", "sizeBytes"], label);
  string(result.path, `${label}.path`);
  sha(result.sha256, `${label}.sha256`);
  positive(result.sizeBytes, `${label}.sizeBytes`);
  return result;
}

function assertSoulIdentity(value: JsonObject, expected: { genre: string; soulId: string; version: string }, label: string): void {
  if (!GENRES.has(expected.genre) || expected.soulId !== `male-${expected.genre}` || expected.version !== "v1"
    || value.genre !== expected.genre || value.soulId !== expected.soulId || value.version !== expected.version) {
    throw new Error(`${label} identity is not an approved v1 male-genre Soul.`);
  }
}

export function validateCanonicalSoulAnalysisProfile(
  value: unknown,
  expected: { readonly genre: string; readonly soulId: string; readonly version: string },
): CanonicalSoulAnalysis {
  const profile = object(value, "Genre Soul analysis profile");
  assertSoulIdentity(profile, expected, "Genre Soul analysis profile");
  if (profile.schemaVersion !== "genre-soul-analysis-profile/v1" || profile.state !== "candidate") {
    throw new Error("Genre Soul analysis profile is not a candidate v1 artifact.");
  }
  const evidenceSet = object(profile.evidenceSet, "Genre Soul analysis evidenceSet");
  if (!Array.isArray(evidenceSet.sources) || evidenceSet.sources.length !== 3) {
    throw new Error("Genre Soul analysis must project exactly three sources.");
  }
  const sourceByBasis = new Map<string, string>();
  for (const [index, raw] of evidenceSet.sources.entries()) {
    const source = object(raw, `Genre Soul analysis source[${index}]`);
    const sourceId = string(source.sourceId, `Genre Soul analysis source[${index}].sourceId`);
    const selectionBasis = String(source.selectionBasis);
    if (!SOURCE_ID.test(sourceId) || !SELECTION_BASES.includes(selectionBasis as typeof SELECTION_BASES[number])
      || sourceByBasis.has(selectionBasis)) {
      throw new Error("Genre Soul analysis source identity/basis drifted.");
    }
    sourceByBasis.set(selectionBasis, sourceId);
  }
  if (new Set(sourceByBasis.values()).size !== 3) throw new Error("Genre Soul analysis sources are duplicated.");
  const synthesis = object(profile.synthesis, "Genre Soul analysis synthesis");
  const privateInput = object(synthesis.privateInput, "Genre Soul analysis privateInput");
  const privateInputPath = string(privateInput.path, "Genre Soul analysis privateInput.path");
  const privateInputMatch = new RegExp(
    `^exports/genre-souls/${expected.soulId}/${expected.version}/profile-runs/([0-9a-f]{64})/genre/input\\.json$`,
    "u",
  ).exec(privateInputPath);
  const privateRunInputDigest = privateInputMatch?.[1];
  if (privateInput.schemaVersion !== "private-genre-soul-profile-input/v1" || !privateRunInputDigest) {
    throw new Error("Genre Soul analysis private input identity/path drifted.");
  }
  sha(privateInput.sha256, "Genre Soul analysis privateInput.sha256");
  positive(privateInput.sizeBytes, "Genre Soul analysis privateInput.sizeBytes");
  if (JSON.stringify(strings(privateInput.sourceIds, "Genre Soul analysis privateInput.sourceIds"))
    !== JSON.stringify([...sourceByBasis.values()].sort())) {
    throw new Error("Genre Soul analysis private input source set drifted.");
  }
  const run = object(synthesis.run, "Genre Soul analysis run");
  const synthesisRunId = string(run.runId, "Genre Soul analysis runId");
  if (synthesis.truncation !== false) {
    throw new Error("Genre Soul analysis run was truncated.");
  }
  const neutrality = object(profile.contentNeutrality, "Genre Soul analysis contentNeutrality");
  if (neutrality.automaticMoralGate !== false || neutrality.illegalityIsAutomaticFailure !== false
    || neutrality.userIntensityPreserved !== true) throw new Error("Genre Soul analysis content boundary drifted.");
  const authority = object(profile.authority, "Genre Soul analysis authority");
  if (authority.scope !== "analysis-only" || authority.mayWriteInkOSCanon !== false
    || authority.mayPromoteSoul !== false || authority.ownerDecisionRequired !== true) {
    throw new Error("Genre Soul analysis authority drifted.");
  }
  return {
    sourceByBasis,
    sourceIds: [...sourceByBasis.values()].sort(),
    privateRunInputDigest,
    synthesisRunId,
  };
}

function validateSurfaceBoundary(value: unknown, managerSchema: unknown): void {
  const review = object(value, "Manager QA surfaceReview");
  if (!new Set(["genre-soul-manager-surface-review-proof/v2", "genre-soul-manager-surface-review-proof/v3"])
    .has(String(review.schemaVersion))
    || (managerSchema === "genre-soul-manager-qa/v3"
      && review.schemaVersion !== "genre-soul-manager-surface-review-proof/v3")) {
    throw new Error("Manager QA surface proof schema drifted.");
  }
  const deterministic = object(review.deterministic, "Manager QA deterministic surface proof");
  if (deterministic.status === "pass") {
    if (review.mode !== "deterministic-clean" || review.semantic !== null || review.ownerDecision !== null) {
      throw new Error("Manager QA deterministic-clean boundary drifted.");
    }
  } else if (deterministic.status === "pending_semantic_review") {
    const semantic = object(review.semantic, "Manager QA semantic surface proof");
    const counts = object(semantic.verdictCounts, "Manager QA surface verdictCounts");
    const generic = Number(counts.genericOverlap);
    const protectedCount = Number(counts.protectedIdentity);
    const uncertain = Number(counts.uncertain);
    if (![generic, protectedCount, uncertain].every((entry) => Number.isSafeInteger(entry) && entry >= 0)
      || generic + uncertain < 1 || protectedCount !== 0) {
      throw new Error("Manager QA surface verdict boundary failed.");
    }
    if (uncertain === 0) {
      if (review.mode !== "semantic-auto-passed" || semantic.outcome !== "auto-passed" || review.ownerDecision !== null) {
        throw new Error("Manager QA semantic auto-pass boundary drifted.");
      }
    } else {
      const owner = object(review.ownerDecision, "Manager QA ownerDecision");
      ref(owner.request, "Manager QA owner request");
      const decision = object(owner.decision, "Manager QA owner decision");
      string(decision.path, "Manager QA owner decision.path");
      sha(decision.sha256, "Manager QA owner decision.sha256");
      positive(decision.sizeBytes, "Manager QA owner decision.sizeBytes");
      string(decision.decisionId, "Manager QA owner decision.decisionId");
      if (review.mode !== "semantic-owner-approved" || semantic.outcome !== "owner-approved"
        || decision.outcome !== "approved" || decision.decidedByRole !== "owner") {
        throw new Error("Manager QA owner approval boundary drifted.");
      }
    }
  } else throw new Error("Manager QA surface status is invalid.");
  const authority = object(review.authority, "Manager QA surface authority");
  if (authority.scope !== "reference-lab-analysis-surface-only"
    || authority.mayWriteInkOSCanon !== false || authority.mayPromoteSoul !== false) {
    throw new Error("Manager QA surface authority drifted.");
  }
}

export function validateCanonicalManagerQaReceipt(
  value: unknown,
  expected: {
    readonly genre: string;
    readonly soulId: string;
    readonly version: string;
    readonly profilePath: string;
    readonly profileSha256: string;
    readonly profileSizeBytes: number;
    readonly analysis: CanonicalSoulAnalysis;
  },
): void {
  const receipt = object(value, "Manager QA");
  assertSoulIdentity(receipt, expected, "Manager QA");
  const isV3 = receipt.schemaVersion === "genre-soul-manager-qa/v3";
  if ((!isV3 && receipt.schemaVersion !== "genre-soul-manager-qa/v2")
    || receipt.state !== "candidate-qa-passed" || receipt.result !== "pass") {
    throw new Error("Manager QA is not a canonical PASS receipt.");
  }
  const profile = object(receipt.profile, "Manager QA profile");
  if (profile.path !== expected.profilePath || profile.sha256 !== expected.profileSha256
    || profile.sizeBytes !== expected.profileSizeBytes || profile.synthesisRunId !== expected.analysis.synthesisRunId) {
    throw new Error("Manager QA profile binding drifted.");
  }
  const privateInput = object(receipt.privateInput, "Manager QA privateInput");
  const sourceIds = strings(privateInput.sourceIds, "Manager QA sourceIds");
  if (privateInput.schemaVersion !== (isV3 ? "private-genre-soul-manager-qa-input/v3" : "private-genre-soul-manager-qa-input/v2")
    || !new RegExp(`^exports/genre-souls/${expected.soulId}/v1/manager-qa-runs/[0-9a-f]{64}/input\\.json$`, "u")
      .test(String(privateInput.path))
    || sourceIds.length !== 3 || JSON.stringify(sourceIds) !== JSON.stringify(expected.analysis.sourceIds)) {
    throw new Error("Manager QA private input projection drifted.");
  }
  sha(privateInput.sha256, "Manager QA private input sha256");
  positive(privateInput.sizeBytes, "Manager QA private input sizeBytes");
  const manager = object(receipt.manager, "Manager QA manager");
  if (manager.role !== "manager" || manager.runId === profile.synthesisRunId) {
    throw new Error("Manager QA manager identity/run separation drifted.");
  }
  string(manager.runId, "Manager QA runId");
  sha(manager.inputDigest, "Manager QA inputDigest");
  // Sampling, selectors, engine-pair semantics, and collective assessment are
  // Reference Lab internals. InkOS consumes only its terminal receipt.
  if (!Array.isArray(receipt.sources) || !Array.isArray(receipt.engineComparisons)) {
    throw new Error("Manager QA source/comparison projections are incomplete.");
  }
  const checks = object(receipt.checks, "Manager QA checks");
  if (checks.profileEvidenceBinding !== true || Object.values(checks).some((entry) => entry !== true)) {
    throw new Error("Manager QA checks are not all true.");
  }
  const neutrality = object(receipt.contentNeutrality, "Manager QA contentNeutrality");
  if (neutrality.moralFitnessGate !== false || neutrality.automaticRewrite !== false
    || neutrality.userIntensityPreserved !== true) throw new Error("Manager QA content boundary drifted.");
  const authority = object(receipt.authority, "Manager QA authority");
  if (authority.scope !== "reference-lab-qa-only" || authority.mayWriteInkOSCanon !== false
    || authority.mayPromoteSoul !== false || authority.ownerDecisionRequired !== true) {
    throw new Error("Manager QA authority drifted.");
  }
  validateSurfaceBoundary(receipt.surfaceReview, receipt.schemaVersion);
}

export function validateCanonicalRoutingCatalog(
  value: unknown,
  expected: {
    readonly genre: string;
    readonly soulId: string;
    readonly version: string;
    readonly profilePath: string;
    readonly profileSha256: string;
    readonly analysis: CanonicalSoulAnalysis;
  },
): void {
  const routing = object(value, "Reference routing catalog");
  assertSoulIdentity(routing, expected, "Reference routing catalog");
  if (routing.schemaVersion !== "genre-soul-reference-routing-catalog/v1" || routing.state !== "candidate") {
    throw new Error("Reference routing catalog is not a candidate v1 artifact.");
  }
  sha(routing.privateRunInputDigest, "Reference routing privateRunInputDigest");
  if (routing.privateRunInputDigest !== expected.analysis.privateRunInputDigest) {
    throw new Error("Reference routing private input digest is not bound to the analysis profile run.");
  }
  const profile = object(routing.profile, "Reference routing profile");
  if (profile.path !== expected.profilePath || profile.sha256 !== expected.profileSha256) {
    throw new Error("Reference routing profile binding drifted.");
  }
  if (!Array.isArray(routing.routes) || routing.routes.length !== 3) {
    throw new Error("Reference routing catalog needs exactly three routes.");
  }
  const expectedRoutes = new Map<string, string>(ROUTES);
  const seenRoles = new Set<string>();
  for (const [index, raw] of routing.routes.entries()) {
    const route = object(raw, `Reference routing route[${index}]`);
    const role = string(route.role, `Reference routing route[${index}].role`);
    const basis = expectedRoutes.get(role);
    if (!basis || seenRoles.has(role) || route.selectionBasis !== basis
      || route.sourceId !== expected.analysis.sourceByBasis.get(basis)
      || route.planned !== true || route.retrievalActive !== false) {
      throw new Error(`Reference routing ${role} route drifted.`);
    }
    seenRoles.add(role);
  }
  const authority = object(routing.authority, "Reference routing authority");
  if (authority.scope !== "reference-lab-advisory-only" || authority.mayWriteInkOSCanon !== false
    || authority.mayActivateRetrieval !== false || authority.mayPromoteSoul !== false
    || authority.ownerDecisionRequired !== true) throw new Error("Reference routing authority drifted.");
}
