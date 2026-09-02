import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../production/soul-evidence-topology.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../production/soul-evidence-topology.js")>();
  return {
    ...original,
    assertCanonicalEvidenceTopology: vi.fn(async () => undefined),
  };
});
import { StateManager } from "../state/manager.js";
import {
  BookSoulStore,
  bindBookSoul,
  loadActiveBookSoulSessionBinding,
} from "../production/book-soul-binding.js";
import { createAndPersistBookSession } from "../interaction/book-session-store.js";
import {
  createProductionInputReceipt,
  currentProductionInputBundle,
  hashCanonical,
  ProductionSoulInputReceiptSchema,
  runWithProductionInputBundle,
  sha256Bytes,
} from "../production/production-input.js";
import { createProductionAttemptIdentity } from "../production/attempt-identity.js";
import { prepareFictionContentInvocation } from "../production/fiction-content-contract.js";
import { readGenreProfileWithReceipt } from "../agents/rules-reader.js";

const roots: string[] = [];
const NOW = new Date("2026-08-28T03:00:00.000Z");
const INKOS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function gitBytes(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-replace-objects", "-C", root, ...args], { encoding: "buffer" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function initEvidenceRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q"]);
  await git(root, ["branch", "-M", "main"]);
  await git(root, ["config", "user.name", "InkOS Test"]);
  await git(root, ["config", "user.email", "inkos-test@example.invalid"]);
  const origin = `${root}-origin.git`;
  await mkdir(origin, { recursive: true });
  await git(origin, ["init", "--bare", "-q"]);
  await git(root, ["remote", "add", "origin", origin]);
}

async function pushEvidenceRepo(root: string, canonicalOrigin: string): Promise<void> {
  await git(root, ["push", "-qu", "origin", "HEAD:refs/heads/main"]);
  await git(root, ["remote", "set-url", "origin", canonicalOrigin]);
}

async function writeJson(root: string, path: string, value: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function artifactRef(root: string, path: string): Promise<{
  path: string;
  sha256: string;
  sizeBytes: number;
}> {
  const bytes = await readFile(join(root, path));
  return { path, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength };
}

async function committedArtifactRef(root: string, commit: string, path: string): Promise<{
  path: string;
  sha256: string;
  sizeBytes: number;
}> {
  const bytes = await gitBytes(root, ["show", `${commit}:${path}`]);
  return { path, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-phase4-soul-"));
  roots.push(root);
  const bookId = "phase4-soul-book";
  const state = new StateManager(root);
  await state.saveBookConfig(bookId, {
    id: bookId,
    title: "Phase 4 Soul",
    platform: "other",
    genre: "modern-fantasy-ko",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  return { root, bookId, bookDir: state.bookDir(bookId) };
}

async function soulArtifacts(
  root: string,
  bookId: string,
  version: string,
  decisionId: string,
  prompt = "",
  status: "neutral" | "candidate" | "promoted" = "candidate",
  options: {
    readonly legacyDecision?: boolean;
    readonly evidenceGenre?: string;
    readonly profileEvidenceBinding?: boolean;
    readonly routingDigestMismatch?: boolean;
    readonly incompleteManagerStructure?: boolean;
  } = {},
): Promise<{
  manifestPath: string;
  registryPath: string;
  decisionPath: string;
  evidenceRoots?: {
    referenceLab: string;
    inkos: string;
    hq?: string;
  };
  referenceLabRoot?: string;
  analysisPath?: string;
}> {
  const packageRoot = join(root, "soul-source", `${version}-${decisionId}`);
  await mkdir(join(packageRoot, "resources"), { recursive: true });
  const manifestPath = join(packageRoot, "manifest.json");
  if (options.legacyDecision) {
    await writeFile(join(packageRoot, "SOUL.md"), prompt, "utf8");
    await writeFile(join(packageRoot, "resources", "genre.md"), "상업적 보상과 회차 말미 훅을 우선한다.\n", "utf8");
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: "soul-package/v1",
      soulId: "male-modern-fantasy-ko",
      version,
      promptPath: "SOUL.md",
      resources: ["resources/genre.md"],
    }, null, 2)}\n`, "utf8");
  } else {
    const canonicalBase = "packages/core/souls/male-modern-fantasy-ko/v1";
    const inkosCommit = await git(INKOS_ROOT, ["rev-parse", "HEAD"]);
    await Promise.all([
      writeFile(manifestPath, await gitBytes(INKOS_ROOT, ["show", `${inkosCommit}:${canonicalBase}/manifest.json`])),
      writeFile(join(packageRoot, "SOUL.md"), await gitBytes(INKOS_ROOT, ["show", `${inkosCommit}:${canonicalBase}/SOUL.md`])),
      writeFile(
        join(packageRoot, "resources", "genre.md"),
        await gitBytes(INKOS_ROOT, ["show", `${inkosCommit}:${canonicalBase}/resources/genre.md`]),
      ),
    ]);
  }
  const registryPath = join(root, `registry-${version}.json`);
  await writeFile(registryPath, `${JSON.stringify({ version: 1, corpus: [], note: "runtime plumbing only" })}\n`, "utf8");
  const decisionPath = join(root, `decision-${decisionId}.json`);
  const decisionBase = {
    kind: "bind-soul",
    decisionId,
    actorId: "owner",
    actorRole: "owner",
    bookId,
    soulId: "male-modern-fantasy-ko",
    soulVersion: version,
    status,
    createdAt: NOW.toISOString(),
  };
  if (options.legacyDecision) {
    await writeFile(decisionPath, `${JSON.stringify({
      schemaVersion: "soul-binding-decision/v1",
      ...decisionBase,
    }, null, 2)}\n`, "utf8");
    return { manifestPath, registryPath, decisionPath };
  }

  const genre = options.evidenceGenre ?? "modern-fantasy-ko";
  const referenceLabRoot = join(root, `reference-lab-${decisionId}`);
  await initEvidenceRepo(referenceLabRoot);
  const analysisPath = `analyses/genre_souls/male-modern-fantasy-ko/${version}/genre-profile.json`;
  const managerPath = `analyses/genre_souls/male-modern-fantasy-ko/${version}/manager-qa.json`;
  const routingPath = `inkos_handoffs/genre-souls/male-modern-fantasy-ko/${version}/reference-routing-catalog.json`;
  const sourceBindings = [
    { sourceId: "source-commercial", selectionBasis: "commercial-anchor" },
    { sourceId: "source-genre", selectionBasis: "genre-breadth" },
    { sourceId: "source-surface", selectionBasis: "surface-anchor" },
  ];
  const synthesisRunId = `synthesis-${decisionId}`;
  const profileInputDigest = sha256Bytes(`profile-input-${decisionId}`);
  const ref = (path: string) => ({ path, sha256: sha256Bytes(path), sizeBytes: 100 });
  await writeJson(referenceLabRoot, analysisPath, {
    schemaVersion: "genre-soul-analysis-profile/v1",
    state: "candidate",
    genre,
    soulId: "male-modern-fantasy-ko",
    version,
    generatedAt: NOW.toISOString(),
    evidenceSet: {
      managerSelection: ref("evidence/genre-souls/male-manager-selection.v1.json"),
      inventory: ref("evidence/genre-souls/male-source-inventory.v1.json"),
      registryReceipt: ref("evidence/genre-souls/male-source-registry-receipt.v1.json"),
      sources: sourceBindings.map((binding) => ({
        ...binding,
        sourceSha256: sha256Bytes(binding.sourceId),
        sourceSizeBytes: 1_000,
        chapterCount: 10,
        trackedStudy: ref(`analyses/${binding.sourceId}.json`),
        privateBundle: ref(`exports/${binding.sourceId}.json`),
        trackedLeakReceipt: ref(`analyses/leaks/${binding.sourceId}.json`),
      })),
    },
    synthesis: {
      privateInput: {
        schemaVersion: "private-genre-soul-profile-input/v1",
        path: `exports/genre-souls/male-modern-fantasy-ko/${version}/profile-runs/${profileInputDigest}/genre/input.json`,
        sha256: sha256Bytes(`profile-input-bytes-${decisionId}`),
        sizeBytes: 1_000,
        sourceIds: sourceBindings.map((binding) => binding.sourceId).sort(),
        observationCount: 9,
        selectorCount: 27,
      },
      run: {
        runId: synthesisRunId,
        model: "gpt-5.6-sol",
        provider: "openai-codex",
        reasoningEffort: "high",
        configSha256: "1".repeat(64),
        traceReceiptSha256: "2".repeat(64),
      },
      contentContract: {},
      truncation: false,
    },
    patterns: Array.from({ length: 9 }, (_, index) => ({ patternId: `pattern-${index}` })),
    primaryCommercialEngines: sourceBindings.map((binding) => ({ sourceId: binding.sourceId })),
    dimensions: {
      worldConstraints: [],
      protagonistRepeatedVerbs: [],
      pressureAndOpposition: [],
      rewardAndStatusCurrency: [],
      nextChapterExpectedAction: [],
      commercialEngines: [],
      emotionalCoherence: [],
      arcAndGrowth: [],
      failurePatterns: [],
    },
    contentNeutrality: {
      automaticMoralGate: false,
      illegalityIsAutomaticFailure: false,
      userIntensityPreserved: true,
    },
    authority: {
      scope: "analysis-only",
      mayWriteInkOSCanon: false,
      mayPromoteSoul: false,
      ownerDecisionRequired: true,
    },
  });
  const analysis = await artifactRef(referenceLabRoot, analysisPath);
  const managerInputDigest = sha256Bytes(`manager-input-${decisionId}`);
  const managerRunKey = sha256Bytes(`manager-run-${decisionId}`);
  const managerRunRoot = `exports/genre-souls/male-modern-fantasy-ko/${version}/manager-qa-runs/${managerRunKey}`;
  const managerSources = sourceBindings.map((binding, sourceIndex) => {
    const samples = (["early", "middle", "late"] as const).map((span, sampleIndex) => ({
      sampleId: `sample-${sourceIndex}-${span}`,
      span,
      observationId: `observation-${sourceIndex}-${span}`,
      kind: "commercial-engine",
      selector: { type: "utf8-byte", startByte: sampleIndex * 100, endByte: sampleIndex * 100 + 50 },
      sliceSha256: sha256Bytes(`${binding.sourceId}-${span}`),
      phaseContribution: "supports-phase",
      supportedMechanismFields: span === "early"
        ? ["pressure", "protagonistRepeatedVerb"]
        : span === "middle"
          ? ["activeChoice", "protagonistRepeatedVerb", "resistance"]
          : ["payoff", "recognition"],
    }));
    return {
      sourceId: binding.sourceId,
      sourceSizeBytes: 1_000,
      engineId: `engine-${sourceIndex}`,
      engineSignatureSha256: sha256Bytes(`engine-${sourceIndex}`),
      mechanismSignatureSha256: sha256Bytes(`mechanism-${sourceIndex}`),
      samples,
      collectiveAssessment: {
        phaseSampleIds: Object.fromEntries(samples.map((sample) => [sample.span, sample.sampleId])),
        supportedMechanismFields: [
          "activeChoice", "payoff", "pressure", "protagonistRepeatedVerb", "recognition", "resistance",
        ],
        collectiveVerdict: "supported",
        rationale: "phase evidence is complete",
        commercialConsequence: "commercial progression remains legible",
      },
    };
  });
  const sortedSourceIds = sourceBindings.map((binding) => binding.sourceId).sort();
  const managerSourceById = new Map(managerSources.map((source) => [source.sourceId, source]));
  const pairs = [
    [sortedSourceIds[0]!, sortedSourceIds[1]!],
    [sortedSourceIds[0]!, sortedSourceIds[2]!],
    [sortedSourceIds[1]!, sortedSourceIds[2]!],
  ];
  await writeJson(referenceLabRoot, managerPath, {
    schemaVersion: "genre-soul-manager-qa/v3",
    state: "candidate-qa-passed",
    genre,
    soulId: "male-modern-fantasy-ko",
    version,
    profile: {
      path: analysisPath,
      sha256: analysis.sha256,
      sizeBytes: analysis.sizeBytes,
      synthesisRunId,
      leakScanReceipt: ref(`analyses/genre_souls/male-modern-fantasy-ko/${version}/leak-scan-receipts/genre-profile.json`),
    },
    privateInput: {
      schemaVersion: "private-genre-soul-manager-qa-input/v3",
      path: `${managerRunRoot}/input.json`,
      sha256: managerRunKey,
      sizeBytes: 1_000,
      sourceIds: sortedSourceIds,
      rawSampleCount: 9,
    },
    manager: {
      actorId: `manager-${decisionId}`,
      role: "manager",
      runId: `manager-run-${decisionId}`,
      inputDigest: managerInputDigest,
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      reasoningEffort: "high",
      configSha256: "3".repeat(64),
      traceReceiptSha256: "4".repeat(64),
      outputSha256: "5".repeat(64),
    },
    decidedAt: NOW.toISOString(),
    sources: options.incompleteManagerStructure ? null : managerSources,
    engineComparisons: pairs.map(([leftSourceId, rightSourceId]) => ({
      comparisonId: `comparison-${sha256Bytes(`${leftSourceId}::${rightSourceId}`).slice(0, 24)}`,
      leftSourceId,
      rightSourceId,
      leftEngineId: managerSourceById.get(leftSourceId)!.engineId,
      rightEngineId: managerSourceById.get(rightSourceId)!.engineId,
      verdict: "distinct-variant",
      semanticDifference: "the commercial mechanisms differ",
      commercialConsequence: "the reward cadence remains distinct",
    })),
    checks: {
      profileEvidenceBinding: options.profileEvidenceBinding ?? true,
      exactSourceCoverage: true,
      rawSampleReadback: true,
      phaseAwareCollectiveEvidenceComplete: true,
      engineRelationsEvidenceComplete: true,
      profileSurfaceLeakScanPassed: true,
      contentNeutrality: true,
      // RefLab owns this evolving matrix; InkOS requires every present check
      // to be true without freezing the complete key list.
      futureReferenceLabContractCheck: true,
    },
    contentNeutrality: {
      moralFitnessGate: false,
      automaticRewrite: false,
      userIntensityPreserved: true,
    },
    authority: {
      scope: "reference-lab-qa-only",
      mayWriteInkOSCanon: false,
      mayPromoteSoul: false,
      ownerDecisionRequired: true,
    },
    result: "pass",
    surfaceReview: {
      schemaVersion: "genre-soul-manager-surface-review-proof/v3",
      gateVersion: "genre-soul-protected-surface-hil/v3",
      extractorVersion: "genre-soul-surface-candidate-extractor/v3",
      mode: "deterministic-clean",
      candidate: ref(`${managerRunRoot}/structured-runs/${managerInputDigest}/surface-review/candidate.json`),
      deterministic: {
        status: "pass",
        privateEvidence: { sourceSetSha256: "6".repeat(64), sampleSetSha256: "7".repeat(64) },
        findingSetSha256: null,
        findingIds: [],
      },
      semantic: null,
      ownerDecision: null,
      authority: {
        scope: "reference-lab-analysis-surface-only",
        mayWriteInkOSCanon: false,
        mayPromoteSoul: false,
      },
    },
  });
  await writeJson(referenceLabRoot, routingPath, {
    schemaVersion: "genre-soul-reference-routing-catalog/v1",
    state: "candidate",
    soulId: "male-modern-fantasy-ko",
    version,
    genre,
    profile: { path: analysisPath, sha256: analysis.sha256 },
    routes: [
      { role: "spine", selectionBasis: "commercial-anchor" },
      { role: "style", selectionBasis: "surface-anchor" },
      { role: "supporting", selectionBasis: "genre-breadth" },
    ].map((route) => ({
      ...route,
      sourceId: sourceBindings.find((binding) => binding.selectionBasis === route.selectionBasis)!.sourceId,
      rationale: `${route.role} route`,
      planned: true,
      retrievalActive: false,
    })),
    authority: {
      scope: "reference-lab-advisory-only",
      mayWriteInkOSCanon: false,
      mayActivateRetrieval: false,
      mayPromoteSoul: false,
      ownerDecisionRequired: true,
    },
    privateRunInputDigest: options.routingDigestMismatch
      ? sha256Bytes(`wrong-profile-input-${decisionId}`)
      : profileInputDigest,
  });
  await git(referenceLabRoot, ["add", analysisPath, managerPath, routingPath]);
  await git(referenceLabRoot, ["commit", "-qm", `reference ${decisionId}`]);
  await pushEvidenceRepo(referenceLabRoot, "git@github.com:macximin/firefly_reference_lab.git");
  const referenceLabCommit = await git(referenceLabRoot, ["rev-parse", "HEAD"]);
  const managerQa = await artifactRef(referenceLabRoot, managerPath);
  const routingCatalog = await artifactRef(referenceLabRoot, routingPath);
  const writerGenreProfile = (await readGenreProfileWithReceipt(root, "modern-fantasy-ko")).receipt;
  const inkosCommit = await git(INKOS_ROOT, ["rev-parse", "HEAD"]);
  const writerPackageBase = "packages/core/souls/male-modern-fantasy-ko/v1";
  const writerPackageManifest = await committedArtifactRef(
    INKOS_ROOT,
    inkosCommit,
    `${writerPackageBase}/manifest.json`,
  );
  const writerPackageFiles = await Promise.all([
    `${writerPackageBase}/SOUL.md`,
    `${writerPackageBase}/resources/genre.md`,
  ].map((path) => committedArtifactRef(INKOS_ROOT, inkosCommit, path)));
  const writerSoulPackageSha256 = hashCanonical({
    schemaVersion: "writer-soul-package/v1",
    soulId: "male-modern-fantasy-ko",
    version,
    packageManifest: writerPackageManifest,
    files: writerPackageFiles,
  });

  const hqRoot = join(root, `hq-${decisionId}`);
  await initEvidenceRepo(hqRoot);
  const hqProfileRegistryPath = "config/hermes-production-profiles.json";
  const hqDecisionPath = `adoptions/genre-souls/male-modern-fantasy-ko/${version}/decision.json`;
  const hqRegistryPath = "config/genre-soul-adoptions.json";
  const executorProfileId = "inkos_male_modern_fantasy";
  const executorSoulSha256 = sha256Bytes(`executor-soul-${decisionId}`);
  const executorConfigSha256 = sha256Bytes("executor-config-sol-high-none");

  let hqAdoption: null | {
    repo: "firefly_studio";
    commit: string;
    decision: Awaited<ReturnType<typeof artifactRef>>;
    activeRegistry: Awaited<ReturnType<typeof artifactRef>>;
  } = null;
  let hqDecision: Awaited<ReturnType<typeof artifactRef>> | null = null;
  let activeRegistry: Awaited<ReturnType<typeof artifactRef>> | null = null;
  if (status === "promoted") {
    await writeJson(hqRoot, hqDecisionPath, {
      schemaVersion: "genre_soul_promotion/v1",
      soulId: "male-modern-fantasy-ko",
      soulVersion: version,
      candidateSoulSha256: executorSoulSha256,
      promptPackSha256: sha256Bytes(`prompt-pack-${decisionId}`),
      referenceLabEligibility: {
        repo: "firefly_reference_lab",
        commit: referenceLabCommit,
        path: `analyses/genre_souls/male-modern-fantasy-ko/${version}/promotion-eligibility.json`,
        sha256: sha256Bytes(`promotion-eligibility-${decisionId}`),
      },
      inputReceiptSha256s: {
        sourceManifest: sha256Bytes("source-manifest"),
        coverage: [sha256Bytes("coverage")],
        managerQa: [managerQa.sha256],
        pathCanary: sha256Bytes("path-canary"),
        promotionCanary: sha256Bytes("promotion-canary"),
        pairedGeneration: [1, 2, 3].map((index) => sha256Bytes(`paired-${index}`)),
        blindReviews: [1, 2, 3].map((index) => sha256Bytes(`blind-${index}`)),
        genreIdentity: [1, 2, 3].map((index) => sha256Bytes(`identity-${index}`)),
        reviewPacket: sha256Bytes("review-packet"),
      },
      decisionId: `hq-${decisionId}`,
      decision: "promote",
      decidedByActorId: "owner",
      decidedByRole: "owner",
      approvalReceiptSha256: sha256Bytes(`approval-${decisionId}`),
      decidedAt: NOW.toISOString(),
    });
    hqDecision = await artifactRef(hqRoot, hqDecisionPath);
    await writeJson(hqRoot, hqRegistryPath, {
      schemaVersion: "genre-soul-adoption-registry/v1",
      active: [{
        soulId: "male-modern-fantasy-ko",
        soulVersion: version,
        soulSha256: executorSoulSha256,
        profileId: executorProfileId,
        profileConfigSha256: executorConfigSha256,
        decisionPath: hqDecisionPath,
        decisionSha256: hqDecision.sha256,
      }],
    });
    activeRegistry = await artifactRef(hqRoot, hqRegistryPath);
  }
  await writeJson(hqRoot, hqProfileRegistryPath, {
    schemaVersion: "hermes-production-profile-registry/v1",
    profiles: [{
      profileId: executorProfileId,
      soulId: "male-modern-fantasy-ko",
      soulVersion: version,
      lifecycle: status === "promoted" ? "promoted" : "candidate",
      productionEnabled: status === "promoted",
      promotionDecisionSha256: hqDecision?.sha256 ?? null,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoning: "high",
      skillsPolicy: "none",
      configSha256: executorConfigSha256,
      soulSha256: executorSoulSha256,
    }],
  });
  await git(hqRoot, ["add", hqProfileRegistryPath, ...(hqDecision ? [hqDecisionPath, hqRegistryPath] : [])]);
  await git(hqRoot, ["commit", "-qm", `${status} ${decisionId}`]);
  await pushEvidenceRepo(hqRoot, "git@github.com:macximin/firefly_studio.git");
  const hqCommit = await git(hqRoot, ["rev-parse", "HEAD"]);
  const hqProfileRegistry = await artifactRef(hqRoot, hqProfileRegistryPath);
  if (hqDecision && activeRegistry) {
    hqAdoption = {
      repo: "firefly_studio",
      commit: hqCommit,
      decision: hqDecision,
      activeRegistry,
    };
  }

  await writeFile(decisionPath, `${JSON.stringify({
    schemaVersion: "soul-binding-decision/v2",
    ...decisionBase,
    adoptionEvidence: {
      schemaVersion: "soul-adoption-evidence/v1",
      referenceLab: {
        repo: "firefly_reference_lab",
        commit: referenceLabCommit,
        analysisProfile: analysis,
        managerQa,
        routingCatalog,
      },
      writerGenreProfile: {
        repo: "inkos",
        commit: inkosCommit,
        receipt: writerGenreProfile,
      },
      executorSoul: {
        repo: "firefly_studio",
        commit: hqCommit,
        profileRegistry: hqProfileRegistry,
        profileId: executorProfileId,
        soulSha256: executorSoulSha256,
        configSha256: executorConfigSha256,
      },
      writerSoulPackage: {
        repo: "inkos",
        commit: inkosCommit,
        packageManifest: writerPackageManifest,
        files: writerPackageFiles,
        packageSha256: writerSoulPackageSha256,
      },
      hqAdoption,
    },
  }, null, 2)}\n`, "utf8");
  return {
    manifestPath,
    registryPath,
    decisionPath,
    evidenceRoots: {
      referenceLab: referenceLabRoot,
      inkos: INKOS_ROOT,
      hq: hqRoot,
    },
    referenceLabRoot,
    analysisPath,
  };
}

describe("Phase 4 BookSoulBinding", () => {
  it("blocks legacy promotion and requires committed, genre-bound Manager PASS evidence", async () => {
    const f = await fixture();
    const legacy = await soulArtifacts(
      f.root,
      f.bookId,
      "v0",
      "legacy-promote",
      "legacy",
      "promoted",
      { legacyDecision: true },
    );
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: legacy.manifestPath,
      sourceRegistryReceiptPath: legacy.registryPath,
      decisionReceiptPath: legacy.decisionPath,
      status: "promoted",
      now: () => NOW,
    })).rejects.toThrow(/adoption evidence v2/i);

    const failedQa = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "failed-manager-binding",
      "candidate",
      "candidate",
      { profileEvidenceBinding: false },
    );
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: failedQa.manifestPath,
      sourceRegistryReceiptPath: failedQa.registryPath,
      decisionReceiptPath: failedQa.decisionPath,
      status: "candidate",
      evidenceRoots: failedQa.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/Manager QA/i);

    const incompleteQa = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "incomplete-manager-structure",
      "candidate",
      "candidate",
      { incompleteManagerStructure: true },
    );
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: incompleteQa.manifestPath,
      sourceRegistryReceiptPath: incompleteQa.registryPath,
      decisionReceiptPath: incompleteQa.decisionPath,
      status: "candidate",
      evidenceRoots: incompleteQa.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/Manager QA source/i);

    const wrongGenre = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "wrong-genre",
      "candidate",
      "candidate",
      { evidenceGenre: "fantasy-ko" },
    );
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: wrongGenre.manifestPath,
      sourceRegistryReceiptPath: wrongGenre.registryPath,
      decisionReceiptPath: wrongGenre.decisionPath,
      status: "candidate",
      evidenceRoots: wrongGenre.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/analysis profile identity/i);

    const routingMismatch = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "routing-run-mismatch",
      "candidate",
      "candidate",
      { routingDigestMismatch: true },
    );
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: routingMismatch.manifestPath,
      sourceRegistryReceiptPath: routingMismatch.registryPath,
      decisionReceiptPath: routingMismatch.decisionPath,
      status: "candidate",
      evidenceRoots: routingMismatch.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/routing private input digest/i);

    const executorMismatch = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "executor-registry-mismatch",
      "candidate",
    );
    const executorDecision = JSON.parse(await readFile(executorMismatch.decisionPath, "utf8")) as {
      adoptionEvidence: { executorSoul: { soulSha256: string } };
    };
    executorDecision.adoptionEvidence.executorSoul.soulSha256 = "f".repeat(64);
    await writeFile(executorMismatch.decisionPath, `${JSON.stringify(executorDecision, null, 2)}\n`, "utf8");
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: executorMismatch.manifestPath,
      sourceRegistryReceiptPath: executorMismatch.registryPath,
      decisionReceiptPath: executorMismatch.decisionPath,
      status: "candidate",
      evidenceRoots: executorMismatch.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/Executor Soul profile identity/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "current.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads adoption artifacts from claimed commits and ignores uncommitted Reference Lab drift", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(f.root, f.bookId, "v1", "commit-bound-candidate", "candidate");
    await writeJson(artifacts.referenceLabRoot!, artifacts.analysisPath!, {
      schemaVersion: "genre-soul-analysis-profile/v1",
      state: "tampered-working-tree",
    });
    const binding = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "candidate",
      evidenceRoots: artifacts.evidenceRoots,
      now: () => NOW,
    });
    expect(binding).toMatchObject({ schemaVersion: "book-soul-binding/v2", status: "candidate" });
    expect(binding).toHaveProperty("adoptionEvidence.referenceLab.commit");
  });

  it("rejects evidence commits that are not reachable from a remote-tracking branch", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(f.root, f.bookId, "v1", "unpushed-evidence", "candidate");
    await git(artifacts.referenceLabRoot!, ["commit", "--allow-empty", "-qm", "unpushed evidence"]);
    const unpushedCommit = await git(artifacts.referenceLabRoot!, ["rev-parse", "HEAD"]);
    const decision = JSON.parse(await readFile(artifacts.decisionPath, "utf8")) as {
      adoptionEvidence: { referenceLab: { commit: string } };
    };
    decision.adoptionEvidence.referenceLab.commit = unpushedCommit;
    await writeFile(artifacts.decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "candidate",
      evidenceRoots: artifacts.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/not reachable from origin\/main/i);
  });

  it("rejects a repository that labels an arbitrary origin as Reference Lab", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(f.root, f.bookId, "v1", "wrong-origin", "candidate");
    await git(artifacts.referenceLabRoot!, ["remote", "set-url", "origin", "ssh://example.invalid/fake.git"]);
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "candidate",
      evidenceRoots: artifacts.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/origin is not the canonical Firefly repository/i);
  });

  it("continues to read legacy neutral v1 binding history", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(
      f.root,
      f.bookId,
      "v0",
      "legacy-neutral",
      "neutral",
      "neutral",
      { legacyDecision: true },
    );
    const binding = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "neutral",
      now: () => NOW,
    });
    expect(binding.schemaVersion).toBe("book-soul-binding/v1");
    await expect(new BookSoulStore(f.root, f.bookDir, f.bookId).loadActive(false))
      .resolves.toEqual(binding);
  });

  it("fails closed when promoted evidence loses its HQ decision/registry link", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "missing-hq-proof",
      "promoted",
      "promoted",
    );
    const decision = JSON.parse(await readFile(artifacts.decisionPath, "utf8")) as {
      adoptionEvidence: { hqAdoption: unknown };
    };
    decision.adoptionEvidence.hqAdoption = null;
    await writeFile(artifacts.decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "promoted",
      evidenceRoots: artifacts.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/requires an HQ promotion decision/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "current.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs a content-addressed candidate, appends history, and forces a new session on rebind", async () => {
    const f = await fixture();
    const firstArtifacts = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-v1");
    const first = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: firstArtifacts.manifestPath,
      sourceRegistryReceiptPath: firstArtifacts.registryPath,
      decisionReceiptPath: firstArtifacts.decisionPath,
      status: "candidate",
      evidenceRoots: firstArtifacts.evidenceRoots,
      now: () => NOW,
    });
    expect(first).toMatchObject({
      bindingVersion: 1,
      soulId: "male-modern-fantasy-ko",
      version: "v1",
      status: "candidate",
      previousBindingSha256: null,
    });
    expect(await readFile(join(f.bookDir, "story", "soul-bindings", "v0001.json"), "utf8")).toContain(first.bindingSha256);
    const runtime = await new BookSoulStore(f.root, f.bookDir, f.bookId).resolveActiveInput();
    expect(runtime?.promptInput).toContain("Lifecycle: candidate");
    expect(runtime?.promptInput).toContain("상업성 판단은 주인공 선택");
    if (first.schemaVersion !== "book-soul-binding/v2") throw new Error("expected v2 Soul binding");
    expect(runtime?.receipt.executorSoulSha256).toBe(first.adoptionEvidence.executorSoul.soulSha256);
    expect(runtime?.receipt.writerSoulPackageSha256)
      .toBe(first.adoptionEvidence.writerSoulPackage.packageSha256);
    expect(() => ProductionSoulInputReceiptSchema.parse({
      ...runtime?.receipt,
      executorSoulSha256: "0".repeat(64),
    })).toThrow(/Executor Soul digest mismatch/i);

    const oldSession = await createAndPersistBookSession(f.root, f.bookId, "phase4-old-session", "book");
    expect(oldSession.soulBinding?.bindingSha256).toBe(first.bindingSha256);

    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: firstArtifacts.manifestPath,
      sourceRegistryReceiptPath: firstArtifacts.registryPath,
      decisionReceiptPath: firstArtifacts.decisionPath,
      status: "candidate",
      evidenceRoots: firstArtifacts.evidenceRoots,
      now: () => new Date(NOW.getTime() + 500),
    })).rejects.toThrow(/decision ID is already used/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "v0002.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const secondArtifacts = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-v2", "현대 판타지 재벌물의 욕망과 보상을 선명하게 유지한다.");
    const second = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: secondArtifacts.manifestPath,
      sourceRegistryReceiptPath: secondArtifacts.registryPath,
      decisionReceiptPath: secondArtifacts.decisionPath,
      status: "candidate",
      evidenceRoots: secondArtifacts.evidenceRoots,
      now: () => new Date(NOW.getTime() + 1000),
    });
    expect(second.bindingVersion).toBe(2);
    expect(second.previousBindingSha256).toBe(first.bindingSha256);
    await expect(createAndPersistBookSession(f.root, f.bookId, oldSession.sessionId, "book"))
      .rejects.toThrow(/soulBinding/i);
    const newSession = await createAndPersistBookSession(f.root, f.bookId, "phase4-new-session", "book");
    expect(newSession.soulBinding).toEqual(await loadActiveBookSoulSessionBinding(f.root, f.bookId));
    expect(newSession.soulBinding?.bindingSha256).toBe(second.bindingSha256);

    const promotedArtifacts = await soulArtifacts(
      f.root,
      f.bookId,
      "v1",
      "owner-promote-v2",
      "현대 판타지 재벌물의 욕망과 보상을 선명하게 유지한다.",
      "promoted",
    );
    const promoted = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: promotedArtifacts.manifestPath,
      sourceRegistryReceiptPath: promotedArtifacts.registryPath,
      decisionReceiptPath: promotedArtifacts.decisionPath,
      status: "promoted",
      evidenceRoots: promotedArtifacts.evidenceRoots,
      now: () => new Date(NOW.getTime() + 2000),
    });
    expect(promoted).toMatchObject({
      bindingVersion: 3,
      status: "promoted",
      previousBindingSha256: second.bindingSha256,
    });
    await rm(join(f.bookDir, "story", "soul-bindings", "current.json"));
    await expect(new BookSoulStore(f.root, f.bookDir, f.bookId).loadActive(false))
      .rejects.toThrow(/history exists without an active pointer/i);
  });

  it("fails before pointer activation for symlinked package input and detects installed byte drift", async () => {
    const f = await fixture();
    const arbitrary = await soulArtifacts(f.root, f.bookId, "v1", "arbitrary-writer-package", "prompt");
    await writeFile(join(arbitrary.manifestPath, "..", "SOUL.md"), "arbitrary prompt", "utf8");
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: arbitrary.manifestPath,
      sourceRegistryReceiptPath: arbitrary.registryPath,
      decisionReceiptPath: arbitrary.decisionPath,
      status: "candidate",
      evidenceRoots: arbitrary.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/Writer Soul package bytes/i);

    const artifacts = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-v1", "prompt");
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await rm(join(artifacts.manifestPath, "..", "resources", "genre.md"));
    await symlink(outside, join(artifacts.manifestPath, "..", "resources", "genre.md"));
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "candidate",
      evidenceRoots: artifacts.evidenceRoots,
      now: () => NOW,
    })).rejects.toThrow(/symlink/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "current.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const clean = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-clean", "prompt");
    const binding = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: clean.manifestPath,
      sourceRegistryReceiptPath: clean.registryPath,
      decisionReceiptPath: clean.decisionPath,
      status: "candidate",
      evidenceRoots: clean.evidenceRoots,
      now: () => NOW,
    });
    const resource = join(
      f.root,
      ".inkos",
      "production",
      "souls",
      "objects",
      binding.installObjectSha256,
      "resources",
      "SOUL.md",
    );
    await writeFile(resource, "drift", "utf8");
    await expect(new BookSoulStore(f.root, f.bookDir, f.bookId).resolveActiveInput())
      .rejects.toThrow(/hash mismatch/i);
  });

  it("injects exact Soul/Skill bytes into the provider request, records only hashes, and expires after the operation", async () => {
    const f = await fixture();
    await mkdir(join(f.bookDir, "story"), { recursive: true });
    const attempt = createProductionAttemptIdentity();
    const promptInjection = "## Host-bound production Soul\n상업성 우선";
    const externalContextText = "이번 화에서 현금 100억 영수증을 보여 준다.";
    const receipt = createProductionInputReceipt({
      schemaVersion: "production-input-receipt/v1",
      soul: null,
      skills: [],
      externalContextSha256: sha256Bytes(externalContextText),
      promptInjectionSha256: sha256Bytes(promptInjection),
    });
    const prepared = await runWithProductionInputBundle({
      bookId: f.bookId,
      commandId: randomUUID(),
      productionOperationId: attempt.productionOperationId,
      attemptId: attempt.attemptId,
      promptInjection,
      externalContextText,
      receipt,
    }, () => prepareFictionContentInvocation({
      projectRoot: f.root,
      bookId: f.bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      productionAttempt: attempt,
      messages: [
        { role: "system", content: "write" },
        { role: "user", content: externalContextText },
      ],
      now: () => NOW,
    }));
    expect(prepared.messages[0]?.content).toContain(promptInjection);
    expect(prepared.receipt.productionInputs).toEqual(receipt);
    const persisted = await readFile(join(
      f.bookDir,
      "story",
      "runtime",
      "fiction-content-neutral",
      "receipts",
      `${prepared.receipt.invocationId}.json`,
    ), "utf8");
    expect(persisted).not.toContain("상업성 우선");
    expect(persisted).not.toContain("현금 100억");
    expect(currentProductionInputBundle()).toBeUndefined();

    expect(() => runWithProductionInputBundle({
      bookId: f.bookId,
      commandId: randomUUID(),
      productionOperationId: attempt.productionOperationId,
      attemptId: attempt.attemptId,
      promptInjection: `${promptInjection} tampered`,
      externalContextText,
      receipt,
    }, () => Promise.resolve())).toThrow(/prompt injection bytes/i);
  });
});
