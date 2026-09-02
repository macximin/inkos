import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  AgentOperationTerminalReceiptV2Schema,
  HermesControlImportReceiptV2Schema,
  HermesInvocationReceiptSchema,
  hermesControlOperationPaths,
  loadAgentOperationTerminal,
  type AgentOperationTerminalReceiptV2,
} from "../production/hermes-control-operation.js";
import { hashCanonicalJson } from "../production/fiction-content-contract.js";
import { ChapterCommitReceiptSchema, type ChapterCommitReceipt } from "../state/chapter-commit-receipt.js";
import { StateManager } from "../state/manager.js";
import { isSafeBookId } from "../utils/book-id.js";
import {
  FireflyCanaryIsolationProjectionSchema,
  FireflyReviewDecisionV2Schema,
  FireflyReviewPacketV2Schema,
  assertFireflyReviewDecisionV2MatchesPacket,
  assertFireflyReviewPacketV2Identity,
  buildFireflyReviewPacketV2,
  type FireflyCanaryIsolationProjection,
  type FireflyReviewPacketV2,
} from "./review-packet-v2.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SAFE_WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const OPAQUE_PAIR_ID = /^bp-[0-9a-f]{24}$/u;
const OPAQUE_BLIND_ID = /^br-[0-9a-f]{24}$/u;
const MAX_REVIEW_ARTIFACT_BYTES = 10 * 1024 * 1024;
// These are the audited RefLab evaluator profile bytes.  Accepting an arbitrary
// digest here would let a caller relabel a different evaluator as the blind
// evaluator while preserving the public schema shape.
const BLIND_EVALUATOR_CONFIG_SHA256 = "4124e16bc40d28732d1dd02f9f2e8b78127a202313e1ace21021f16fca809f46";
const BLIND_EVALUATOR_SOUL_SHA256 = "5c4cca60c9971312682f7b71cac5d4d61b6f9e2c42d19af99c8fe6daedacd94b";
const SURFACE_CORPUS_BY_GENRE = {
  "modern-fantasy-ko": { soulId: "male-modern-fantasy-ko", soulVersion: "v1" },
  "fantasy-ko": { soulId: "male-fantasy-ko", soulVersion: "v1" },
  "murim-ko": { soulId: "male-murim-ko", soulVersion: "v1" },
} as const;

const Sha256Schema = z.string().regex(SHA256);
const SafePairIdSchema = z.string().regex(SAFE_PAIR_ID);
const SafeWorkOrderIdSchema = z.string().regex(SAFE_WORK_ORDER_ID);
const CandidateIdSchema = z.enum(["candidate-A", "candidate-B"]);
const ArtifactRefSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
  byteLength: z.number().int().positive().max(MAX_REVIEW_ARTIFACT_BYTES),
}).strict();

const CandidateSpanSchema = z.object({
  coordinateKind: z.literal("utf8-byte"),
  startByte: z.number().int().min(0),
  endByte: z.number().int().positive(),
  sliceSha256: Sha256Schema,
}).strict();

const CommercialEvaluationSchema = z.object({
  openingPressure: z.number().min(0).max(100),
  protagonistAgency: z.number().min(0).max(100),
  resistanceQuality: z.number().min(0).max(100),
  visiblePayoff: z.number().min(0).max(100),
  endingPropulsion: z.number().min(0).max(100),
  referenceEngineRetention: z.number().min(0).max(100),
  transformationIntegrity: z.number().min(0).max(100),
  styleFidelity: z.number().min(0).max(100),
}).strict();

const ContentNeutralViolationSchema = z.object({
  code: z.enum([
    "unauthorized-softening", "unauthorized-escalation", "moral-lecture", "disclaimer",
    "forced-punishment", "forced-apology", "forced-redemption", "forced-cost",
    "forced-moral-growth", "forced-balance",
  ]),
  evidence: z.array(CandidateSpanSchema).min(1),
}).strict();

const CandidateEvaluationSchema = z.object({
  candidateSha256: Sha256Schema,
  commercialEvaluation: CommercialEvaluationSchema,
  commercialScore: z.number().min(0).max(100),
  emotionalCoherence: z.object({
    score: z.number().min(0).max(100),
    evidence: z.array(CandidateSpanSchema).min(1),
  }).strict(),
  contentNeutrality: z.object({
    passed: z.boolean(),
    violations: z.array(ContentNeutralViolationSchema),
  }).strict(),
  canonContradictions: z.array(z.object({
    code: z.literal("hard-canon-contradiction"),
    evidence: z.array(CandidateSpanSchema).min(1),
  }).strict()),
  canonLeaks: z.array(z.object({
    code: z.literal("canon-leak"),
    evidence: z.array(CandidateSpanSchema).min(1),
  }).strict()),
  genreIdentity: z.object({
    worldConstraintEvidence: z.array(CandidateSpanSchema),
    repeatableVerbEvidence: z.array(CandidateSpanSchema),
    oppositionFormEvidence: z.array(CandidateSpanSchema),
    rewardStatusCurrencyEvidence: z.array(CandidateSpanSchema),
    nextEpisodeActionEvidence: z.array(CandidateSpanSchema),
    pass: z.boolean(),
  }).strict(),
}).strict().superRefine((evaluation, ctx) => {
  if (scoreCommercial(evaluation.commercialEvaluation) !== evaluation.commercialScore) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commercialScore"], message: "commercial score does not match dopamine70-reference30-v1" });
  }
  if (evaluation.contentNeutrality.passed !== (evaluation.contentNeutrality.violations.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contentNeutrality", "passed"], message: "content-neutrality pass flag contradicts violations" });
  }
  const genre = evaluation.genreIdentity;
  const genreComplete = genre.worldConstraintEvidence.length > 0
    && genre.repeatableVerbEvidence.length > 0
    && genre.oppositionFormEvidence.length > 0
    && genre.rewardStatusCurrencyEvidence.length > 0
    && genre.nextEpisodeActionEvidence.length > 0;
  if (genre.pass !== genreComplete) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["genreIdentity", "pass"], message: "genre identity pass flag contradicts evidence coverage" });
  }
});

export const RefLabBlindPairEvaluatorResultV2Schema = z.object({
  schemaVersion: z.literal("firefly-blind-pair-evaluator-result/v2"),
  pairId: z.string().regex(OPAQUE_PAIR_ID),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  pairedGenerationReceiptSha256: Sha256Schema,
  winner: z.enum(["candidate-A", "candidate-B", "tie", "invalid"]),
  rankingReason: z.string().min(1).max(8_000).refine((value) => value.trim().length > 0, "ranking reason must not be blank"),
  evaluations: z.object({
    "candidate-A": CandidateEvaluationSchema,
    "candidate-B": CandidateEvaluationSchema,
  }).strict(),
  humanDecision: z.literal("pending"),
  authority: z.object({
    scope: z.literal("analysis-only"),
    mayWriteInkOSCanon: z.literal(false),
    mayPromoteSoul: z.literal(false),
    ownerDecisionRequired: z.literal(true),
  }).strict(),
}).strict();
export type RefLabBlindPairEvaluatorResultV2 = z.infer<typeof RefLabBlindPairEvaluatorResultV2Schema>;

const RefLabAuthoritySchema = z.object({
  scope: z.literal("analysis-only"),
  mayWriteInkOSCanon: z.literal(false),
  mayPromoteSoul: z.literal(false),
  ownerDecisionRequired: z.literal(true),
}).strict();

export const RefLabBlindPairEvaluationInputV2Schema = z.object({
  schemaVersion: z.literal("firefly-blind-pair-evaluation-input/v2"),
  genre: z.enum(["modern-fantasy-ko", "fantasy-ko", "murim-ko"]),
  pairId: z.string().regex(OPAQUE_PAIR_ID),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  blindSessionId: z.string().regex(OPAQUE_BLIND_ID),
  reviewPacket: ArtifactRefSchema,
  commonContext: z.object({ text: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  commonInputReceiptSha256: Sha256Schema,
  pairedGenerationReceiptSha256: Sha256Schema,
  labelAssignmentReceiptSha256: Sha256Schema,
  candidates: z.tuple([
    z.object({ id: z.literal("candidate-A"), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
    z.object({ id: z.literal("candidate-B"), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  ]),
  producerActors: z.array(z.object({
    lane: z.enum(["neutral", "soul"]),
    actorId: z.string().min(1).max(240),
    profileId: z.string().min(1).max(240),
    terminalReceiptSha256: Sha256Schema,
  }).strict()).length(2),
  reviewer: z.object({
    actorId: z.string().min(1).max(240),
    profileId: z.literal("inkos_blind_evaluator"),
    provider: z.literal("openai-codex"),
    model: z.literal("gpt-5.6-sol"),
    reasoning: z.literal("high"),
    configSha256: Sha256Schema,
    soulSha256: Sha256Schema,
  }).strict(),
  contentContract: z.object({
    id: z.literal("fiction-content-neutral-ko/v1"),
    sha256: Sha256Schema,
    intensityDirectiveSha256: Sha256Schema,
  }).strict(),
  authority: RefLabAuthoritySchema,
}).strict().superRefine((input, ctx) => {
  if (input.blindRunId === input.blindSessionId || input.candidates[0].sha256 === input.candidates[1].sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RefLab input blind identifiers and candidates must be distinct" });
  }
  if (new Set(input.producerActors.map((actor) => actor.lane)).size !== 2
    || new Set(input.producerActors.map((actor) => actor.actorId)).size !== 2
    || input.producerActors.some((actor) => actor.actorId === input.reviewer.actorId || actor.profileId === input.reviewer.profileId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["producerActors"], message: "RefLab input producers/reviewer are not exactly separated" });
  }
  const commonBytes = Buffer.from(input.commonContext.text, "utf8");
  if (commonBytes.toString("utf8") !== input.commonContext.text || commonBytes.byteLength !== input.commonContext.byteLength
    || sha256Bytes(commonBytes) !== input.commonContext.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commonContext"], message: "RefLab input common context byte binding mismatch" });
  }
});
export type RefLabBlindPairEvaluationInputV2 = z.infer<typeof RefLabBlindPairEvaluationInputV2Schema>;

const RefLabBlindPairEvaluatorCandidateWithSpansInputV2Schema = z.object({
  id: CandidateIdSchema,
  sha256: Sha256Schema,
  byteLength: z.number().int().positive(),
  body: z.string().min(1),
  evidenceSpans: z.array(CandidateSpanSchema).min(1),
}).strict().superRefine((candidate, ctx) => {
  const bytes = Buffer.from(candidate.body, "utf8");
  if (bytes.toString("utf8") !== candidate.body || bytes.byteLength !== candidate.byteLength || sha256Bytes(bytes) !== candidate.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "private evaluator candidate body does not match its exact bytes" });
  }
});

/** Private, body-bearing RefLab evaluator ingress; it is distinct from the public sealed review input. */
export const RefLabBlindPairEvaluatorInputV2Schema = z.object({
  schemaVersion: z.literal("private-firefly-blind-pair-evaluator-input/v2"),
  genre: z.enum(["modern-fantasy-ko", "fantasy-ko", "murim-ko"]),
  pairId: z.string().regex(OPAQUE_PAIR_ID),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  pairedGenerationReceiptSha256: Sha256Schema,
  commonContext: z.object({ text: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  reviewerRuntime: z.object({ configSha256: Sha256Schema, soulSha256: Sha256Schema }).strict(),
  candidates: z.tuple([RefLabBlindPairEvaluatorCandidateWithSpansInputV2Schema, RefLabBlindPairEvaluatorCandidateWithSpansInputV2Schema]),
  contentContract: z.object({ id: z.literal("fiction-content-neutral-ko/v1"), sha256: Sha256Schema, intensityDirectiveSha256: Sha256Schema }).strict(),
  authority: RefLabAuthoritySchema,
}).strict().superRefine((input, ctx) => {
  if (input.candidates[0].sha256 === input.candidates[1].sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RefLab private evaluator input candidates must be distinct" });
  }
  const commonBytes = Buffer.from(input.commonContext.text, "utf8");
  if (commonBytes.toString("utf8") !== input.commonContext.text || commonBytes.byteLength !== input.commonContext.byteLength
    || sha256Bytes(commonBytes) !== input.commonContext.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commonContext"], message: "RefLab private evaluator common context byte binding mismatch" });
  }
  for (const candidate of input.candidates) {
    const bytes = Buffer.from(candidate.body, "utf8");
    try { assertCandidateEvidenceSpanCatalog(candidate.evidenceSpans, bytes, `private evaluator input ${candidate.id}`); }
    catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates", candidate.id, "evidenceSpans"], message: String(error) }); }
  }
});
export type RefLabBlindPairEvaluatorInputV2 = z.infer<typeof RefLabBlindPairEvaluatorInputV2Schema>;

// RefLab emits `classification` after the selector body. Keep this producer
// order here because its receipt self-hash is over canonical insertion-order
// JSON, while the Storyyard packet schema is free to normalize its own copy.
const RefLabSurfaceMatchV2Schema = z.object({
  matchId: z.string().regex(/^fsm-[0-9a-f]{24}$/u),
  selectorSha256: Sha256Schema,
  provenanceBridgeReceiptSha256: Sha256Schema,
  matchMethod: z.enum(["exact-token-12", "exact-byte-120", "long-common-substring", "near-string"]),
  candidate: z.object({
    coordinateKind: z.literal("utf8-byte"),
    candidateContentSha256: Sha256Schema,
    startByte: z.number().int().min(0),
    endByte: z.number().int().positive(),
    candidateSliceSha256: Sha256Schema,
  }).strict(),
  source: z.object({
    coordinateKind: z.literal("utf8-byte"),
    sourceId: z.string().min(1),
    sourceSha256: Sha256Schema,
    startByte: z.number().int().min(0),
    endByte: z.number().int().positive(),
    sliceSha256: Sha256Schema,
  }).strict(),
  classification: z.literal("pending"),
}).strict();

export const RefLabBlindSurfaceScanReceiptSchema = z.object({
  schemaVersion: z.literal("firefly-blind-pair-surface-scan/v1"),
  candidateId: CandidateIdSchema,
  candidateSha256: Sha256Schema,
  candidateByteLength: z.number().int().positive().max(MAX_REVIEW_ARTIFACT_BYTES),
  scanner: z.object({
    version: z.literal("genre-soul-surface-scanner/v1"),
    exactTokenCount: z.literal(12),
    exactByteLength: z.literal(120),
  }).strict(),
  corpus: z.object({
    privateRegistrySha256: Sha256Schema,
    availableSourceCount: z.number().int().positive(),
    observedSourceSetSha256: Sha256Schema,
    surfaceIndexSha256: Sha256Schema,
  }).strict(),
  upstreamScanSha256: Sha256Schema,
  status: z.enum(["completed-no-match", "completed-with-matches"]),
  matchCount: z.number().int().min(0),
  matches: z.array(RefLabSurfaceMatchV2Schema),
  truncated: z.literal(false),
  automaticRewriteApplied: z.literal(false),
  automaticRejectApplied: z.literal(false),
  humanDecision: z.literal("pending"),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const expectedStatus = receipt.matches.length === 0 ? "completed-no-match" : "completed-with-matches";
  if (receipt.matchCount !== receipt.matches.length || receipt.status !== expectedStatus) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["matchCount"], message: "surface scan status/count contradicts matches" });
  }
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (refLabArtifactHash(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "surface scan receipt self hash mismatch" });
  }
});
export type RefLabBlindSurfaceScanReceipt = z.infer<typeof RefLabBlindSurfaceScanReceiptSchema>;

const RefLabCandidateBindingSchema = z.object({
  candidateSha256: Sha256Schema,
  evaluationBindingSha256: Sha256Schema,
  surfaceScanReceiptSha256: Sha256Schema,
  surfaceIndexSha256: Sha256Schema,
  surfaceScanStatus: z.enum(["completed-no-match", "completed-with-matches"]),
  surfaceMatchCount: z.number().int().min(0),
}).strict();

export const RefLabBlindReviewReceiptV2Schema = z.object({
  schemaVersion: z.literal("firefly-blind-review-receipt/v2"),
  genre: z.enum(["modern-fantasy-ko", "fantasy-ko", "murim-ko"]),
  pairId: z.string().regex(OPAQUE_PAIR_ID),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  blindSessionId: z.string().regex(OPAQUE_BLIND_ID),
  sealedInputSha256: Sha256Schema,
  commonContextSha256: Sha256Schema,
  commonContextByteLength: z.number().int().positive(),
  evaluatorBinding: z.object({
    evaluatorInputSha256: Sha256Schema,
    evaluatorResultSha256: Sha256Schema,
    hostReceiptSha256: Sha256Schema,
    tripleBindingSha256: Sha256Schema,
  }).strict(),
  reviewPacketSha256: Sha256Schema,
  commonInputReceiptSha256: Sha256Schema,
  pairedGenerationReceiptSha256: Sha256Schema,
  labelAssignmentReceiptSha256: Sha256Schema,
  reviewer: z.object({
    actorId: z.string().min(1),
    profileId: z.literal("inkos_blind_evaluator"),
    configSha256: Sha256Schema,
    soulSha256: Sha256Schema,
    model: z.literal("gpt-5.6-sol"),
    reasoning: z.literal("high"),
    actorDistinctFromProducers: z.literal(true),
    runId: z.string().min(1),
  }).strict(),
  candidateBindings: z.object({
    "candidate-A": RefLabCandidateBindingSchema,
    "candidate-B": RefLabCandidateBindingSchema,
  }).strict(),
  outcome: z.object({
    winner: z.enum(["candidate-A", "candidate-B", "tie", "invalid"]),
    commercialScores: z.object({ "candidate-A": z.number(), "candidate-B": z.number() }).strict(),
    emotionalCoherenceScores: z.object({ "candidate-A": z.number(), "candidate-B": z.number() }).strict(),
    genreIdentityPassed: z.object({ "candidate-A": z.boolean(), "candidate-B": z.boolean() }).strict(),
    contentNeutralViolationCounts: z.object({ "candidate-A": z.number().int().min(0), "candidate-B": z.number().int().min(0) }).strict(),
    hardContradictionCount: z.number().int().min(0),
    canonLeakCount: z.number().int().min(0),
    humanDecision: z.literal("pending"),
  }).strict(),
  storyyardProjection: z.object({
    purpose: z.literal("promotion-evaluation"),
    actions: z.tuple([z.literal("select"), z.literal("tie"), z.literal("invalid")]),
    decisionEffect: z.literal("advisory"),
    manuscriptApply: z.literal(false),
    canonLeakPolicy: z.literal("block-on-nonzero"),
  }).strict(),
  authority: RefLabAuthoritySchema,
  createdAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const triple = {
    evaluatorInputSha256: receipt.evaluatorBinding.evaluatorInputSha256,
    evaluatorResultSha256: receipt.evaluatorBinding.evaluatorResultSha256,
    hostReceiptSha256: receipt.evaluatorBinding.hostReceiptSha256,
  };
  if (refLabArtifactHash(triple) !== receipt.evaluatorBinding.tripleBindingSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluatorBinding", "tripleBindingSha256"], message: "RefLab evaluator triple binding mismatch" });
  }
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (refLabArtifactHash(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "RefLab blind review receipt self hash mismatch" });
  }
});
export type RefLabBlindReviewReceiptV2 = z.infer<typeof RefLabBlindReviewReceiptV2Schema>;

// This is the exact Hermès host receipt shape emitted by Reference Lab's blind
// evaluator.  InkOS must re-read this raw artifact rather than accepting only
// the digest embedded in the derived review receipt.
const RefLabBlindEvaluatorHostReceiptSchema = z.object({
  schemaVersion: z.literal("private-hermes-structured-run-receipt/v1"),
  role: z.literal("blind-pair-commercial-evaluator"), runId: z.string().min(1), profileId: z.literal("inkos_blind_evaluator"),
  model: z.literal("gpt-5.6-sol"), provider: z.literal("openai-codex"),
  readCapabilitySha256: Sha256Schema, readCapabilityTool: z.literal("firefly_read_source"), readCapabilityToolset: z.literal("firefly-source-read"),
  readExecutionEnvironmentSha256: Sha256Schema, readExecutionRuntimeIdentitySha256: Sha256Schema, readManifestSha256: Sha256Schema,
  reasoningEffort: z.literal("high"), runtimeAttestation: z.literal("current-attested"), promptSha256: Sha256Schema,
  inputDigest: Sha256Schema, inputSha256: Sha256Schema, profileConfigSha256: Sha256Schema, soulSha256: Sha256Schema,
  contentNeutralContractId: z.literal("fiction-content-neutral-ko/v1"),
  contentNeutralContractSha256: z.literal("c5b531577cbfbfb1dfc4cd2b5cb82d7ce796c6958e0bc00c3e180b0e5440e199"),
  contentNeutralSoulSectionSha256: Sha256Schema, effectiveSystemPromptSha256: Sha256Schema, contextLimitEntrySha256: Sha256Schema,
  hermesExecutableSha256: Sha256Schema, hermesDelegatedExecutableSha256: Sha256Schema, hermesVersionSha256: Sha256Schema,
  hermesImplementationSha256: Sha256Schema, hermesDependencySha256: Sha256Schema, hermesProfileContextSha256: Sha256Schema,
  hermesProjectContextSha256: Sha256Schema, hermesRuntimeIdentitySha256: Sha256Schema,
  contextBudgetUpperBoundTokens: z.number().int().nonnegative(), contextInputProxyTokens: z.number().int().nonnegative(),
  contextLimit: z.number().int().min(100_000), contextOutputReserveTokens: z.number().int().positive(),
  cumulativeCacheReadTokens: z.number().int().nonnegative(), cacheWriteTokens: z.number().int().nonnegative(),
  compaction: z.literal(false), compression: z.literal(false), truncation: z.literal(false),
  expectedReadCount: z.literal(1), exactReadCount: z.literal(1), exactReadSha256s: z.tuple([Sha256Schema]),
  candidateOutputSha256: Sha256Schema, resultSha256: Sha256Schema, usageSha256: Sha256Schema, traceSha256: Sha256Schema,
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), reasoningTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(), apiCalls: z.number().int().nonnegative(), completedAt: z.string().datetime(), completed: z.literal(true),
}).strict().superRefine((receipt, ctx) => {
  if (
    receipt.totalTokens !== receipt.inputTokens + receipt.outputTokens + receipt.cumulativeCacheReadTokens + receipt.cacheWriteTokens
    || receipt.contextBudgetUpperBoundTokens !== receipt.contextInputProxyTokens + receipt.contextOutputReserveTokens
    || receipt.contextBudgetUpperBoundTokens >= receipt.contextLimit
    || receipt.outputTokens > receipt.contextOutputReserveTokens
  ) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "RefLab full Hermès host receipt context accounting drifted" });
});
type RefLabBlindEvaluatorHostReceipt = z.infer<typeof RefLabBlindEvaluatorHostReceiptSchema>;

const PrivateCandidateMappingSchema = z.object({
  candidateId: CandidateIdSchema,
  lane: z.enum(["neutral", "soul"]),
  profileId: z.string().min(1).max(240),
  sessionId: z.string().min(1).max(240),
  workOrderId: SafeWorkOrderIdSchema,
  laneProjectRoot: z.string().min(1),
  expectedSoulBinding: z.object({
    soulId: z.string().min(1),
    soulVersion: z.string().min(1),
    bindingSha256: Sha256Schema,
  }).strict().nullable(),
  terminal: ArtifactRefSchema.extend({ receiptSelfHash: Sha256Schema }).strict(),
  chapterCommit: ArtifactRefSchema.extend({ receiptSelfHash: Sha256Schema }).strict(),
  chapterArtifact: ArtifactRefSchema,
  body: z.string().min(1),
}).strict().superRefine((mapping, ctx) => {
  const bodyBytes = Buffer.from(mapping.body, "utf8");
  if (bodyBytes.toString("utf8") !== mapping.body
    || bodyBytes.byteLength !== mapping.chapterArtifact.byteLength
    || sha256Bytes(bodyBytes) !== mapping.chapterArtifact.sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "private candidate body does not match exact Chapter artifact bytes" });
  }
});
export type BlindPairPrivateCandidateMapping = z.infer<typeof PrivateCandidateMappingSchema>;

export const BlindPairPrivateMappingReceiptSchema = z.object({
  schemaVersion: z.literal("inkos-blind-pair-private-mapping/v1"),
  sourcePairId: SafePairIdSchema,
  opaquePairId: z.string().regex(OPAQUE_PAIR_ID),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  blindSessionId: z.string().regex(OPAQUE_BLIND_ID),
  bookId: z.string().refine(isSafeBookId, "Book ID is not filesystem-safe"),
  chapterNumber: z.number().int().positive(),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  commonContext: z.object({ text: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  commonInputReceiptSha256: Sha256Schema,
  pairedGenerationReceiptSha256: Sha256Schema,
  canaryIsolation: FireflyCanaryIsolationProjectionSchema,
  entropyCommitmentSha256: Sha256Schema,
  mappingRandomized: z.literal(true),
  mappings: z.tuple([PrivateCandidateMappingSchema, PrivateCandidateMappingSchema]),
  createdAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  if (receipt.opaquePairId === receipt.sourcePairId || receipt.blindRunId === receipt.blindSessionId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "blind identifiers must be distinct and opaque" });
  }
  if (receipt.mappings[0].candidateId !== "candidate-A" || receipt.mappings[1].candidateId !== "candidate-B") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mappings"], message: "candidate mappings must be ordered A then B" });
  }
  if (new Set(receipt.mappings.map((mapping) => mapping.lane)).size !== 2
    || new Set(receipt.mappings.map((mapping) => mapping.workOrderId)).size !== 2
    || new Set(receipt.mappings.map((mapping) => mapping.profileId)).size !== 2
    || new Set(receipt.mappings.map((mapping) => mapping.chapterArtifact.sha256)).size !== 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mappings"], message: "blind mappings must bind two distinct lanes, WorkOrders, profiles, and manuscripts" });
  }
  if (receipt.mappings.some((mapping) => mapping.lane === "neutral" ? mapping.expectedSoulBinding !== null : mapping.expectedSoulBinding === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mappings"], message: "lane Soul bindings are inconsistent" });
  }
  if (sha256Bytes(Buffer.from(receipt.commonContext.text, "utf8")) !== receipt.commonContext.sha256
    || Buffer.byteLength(receipt.commonContext.text, "utf8") !== receipt.commonContext.byteLength) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commonContext"], message: "common context byte binding mismatch" });
  }
  if (commonInputReceiptSha256(receipt.commonContext) !== receipt.commonInputReceiptSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commonInputReceiptSha256"], message: "common input receipt digest mismatch" });
  }
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "private mapping receipt self hash mismatch" });
  }
});
export type BlindPairPrivateMappingReceipt = z.infer<typeof BlindPairPrivateMappingReceiptSchema>;

export const BlindPairEvaluationTransferSchema = z.object({
  schemaVersion: z.literal("inkos-blind-pair-evaluation-transfer/v1"),
  pairId: z.string().regex(OPAQUE_PAIR_ID),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  blindRunId: z.string().regex(OPAQUE_BLIND_ID),
  blindSessionId: z.string().regex(OPAQUE_BLIND_ID),
  bookId: z.string().refine(isSafeBookId, "Book ID is not filesystem-safe"),
  chapterNumber: z.number().int().positive(),
  commonContext: z.object({ text: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  commonInputReceiptSha256: Sha256Schema,
  pairedGenerationReceiptSha256: Sha256Schema,
  labelAssignmentReceiptSha256: Sha256Schema,
  canaryIsolation: FireflyCanaryIsolationProjectionSchema,
  candidates: z.tuple([
    z.object({ id: z.literal("candidate-A"), body: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
    z.object({ id: z.literal("candidate-B"), body: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().positive() }).strict(),
  ]),
  generatedAt: z.string().datetime(),
  authority: z.object({
    scope: z.literal("evaluation-input"),
    mayWriteInkOSCanon: z.literal(false),
    mayRevealGeneratorIdentity: z.literal(false),
    ownerDecisionRequired: z.literal(true),
  }).strict(),
  transferSelfHash: Sha256Schema,
}).strict().superRefine((transfer, ctx) => {
  if (transfer.blindRunId === transfer.blindSessionId || transfer.candidates[0].sha256 === transfer.candidates[1].sha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "blind transfer identifiers and candidate manuscripts must be distinct" });
  }
  for (const candidate of transfer.candidates) {
    const bodyBytes = Buffer.from(candidate.body, "utf8");
    if (bodyBytes.toString("utf8") !== candidate.body || bodyBytes.byteLength !== candidate.byteLength
      || sha256Bytes(bodyBytes) !== candidate.sha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: `${candidate.id} exact UTF-8 body binding mismatch` });
    }
  }
  if (sha256Bytes(Buffer.from(transfer.commonContext.text, "utf8")) !== transfer.commonContext.sha256
    || Buffer.byteLength(transfer.commonContext.text, "utf8") !== transfer.commonContext.byteLength
    || commonInputReceiptSha256(transfer.commonContext) !== transfer.commonInputReceiptSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commonContext"], message: "blind transfer common context binding mismatch" });
  }
  const { transferSelfHash: _self, ...unsigned } = transfer;
  if (hashCanonicalJson(unsigned) !== transfer.transferSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferSelfHash"], message: "blind evaluation transfer self hash mismatch" });
  }
});
export type BlindPairEvaluationTransfer = z.infer<typeof BlindPairEvaluationTransferSchema>;

export const FireflyReviewEvaluationAckSchema = z.object({
  schemaVersion: z.literal("firefly_review_evaluation_ack/v1"),
  decisionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  workId: z.string().min(1),
  artifactId: z.string().min(1),
  candidateId: CandidateIdSchema.nullable(),
  candidateSha256: Sha256Schema.nullable(),
  decision: z.enum(["select", "tie", "invalid"]),
  comment: z.string().max(2_000),
  surfaceClassifications: z.array(z.unknown()),
  purpose: z.literal("promotion-evaluation"),
  decisionEffect: z.literal("advisory"),
  canonEffect: z.literal("none"),
  manuscriptApply: z.literal(false),
  status: z.literal("acknowledged"),
  createdAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime(),
  ackReceiptPath: z.string().min(1),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "evaluation ACK self hash mismatch" });
  }
  if (Date.parse(receipt.acknowledgedAt) < Date.parse(receipt.createdAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acknowledgedAt"], message: "evaluation ACK predates the Storyyard decision" });
  }
});
export type FireflyReviewEvaluationAck = z.infer<typeof FireflyReviewEvaluationAckSchema>;

interface LoadedCandidate {
  readonly mapping: BlindPairPrivateCandidateMapping;
  readonly body: string;
  readonly bytes: Buffer;
  readonly terminal: AgentOperationTerminalReceiptV2 & { status: "succeeded" };
  readonly terminalRawSha256: string;
  readonly chapter: ChapterCommitReceipt;
}

export interface PrepareBlindPairInput {
  readonly projectRoot: string;
  readonly pairId: string;
  readonly bookId: string;
  readonly neutralWorkOrderId: string;
  readonly soulWorkOrderId: string;
  readonly commonContextBytes?: Uint8Array;
  readonly commonContextPath?: string;
  readonly round?: 1 | 2 | 3;
  readonly now?: () => Date;
}

export interface PrepareBlindPairResult {
  readonly mapping: { readonly path: string; readonly sha256: string };
  readonly transfer: { readonly path: string; readonly sha256: string; readonly value: BlindPairEvaluationTransfer };
  readonly replayed: boolean;
}

export interface MaterializeBlindPairInput {
  readonly projectRoot: string;
  readonly pairId: string;
  /** Public firefly-blind-pair-evaluation-input/v2 sealed by reviewReceipt.sealedInputSha256. */
  readonly reviewInputPath: string;
  /** Private body-bearing evaluator input read by the RefLab evaluator host. */
  readonly evaluatorInputPath: string;
  readonly evaluatorResultPath: string;
  /** Project-relative raw RefLab Hermès receipt for the blind evaluator run. */
  readonly evaluatorHostReceiptPath: string;
  readonly reviewReceiptPath: string;
  readonly surfaceScanPaths: readonly [string, string];
  readonly generatedAt?: string;
}

export interface MaterializeBlindPairResult {
  readonly packet: FireflyReviewPacketV2;
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly replayed: boolean;
}

export function blindPairMappingRelativePath(pairId: string): string {
  return posix.join(".inkos", "canaries", SafePairIdSchema.parse(pairId), "review", "private", "label-assignment.json");
}

export function blindPairTransferRelativePath(pairId: string): string {
  return posix.join(".inkos", "canaries", SafePairIdSchema.parse(pairId), "review", "public", "evaluation-transfer.json");
}

export function storyyardEvaluationAckRelativePath(pairId: string, decisionId: string): string {
  SafePairIdSchema.parse(pairId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(decisionId)) throw new Error("Storyyard decision ID is not filesystem-safe.");
  return posix.join(".inkos", "canaries", pairId, "review", "decisions", `${decisionId}.json`);
}

export async function prepareBlindPair(input: PrepareBlindPairInput): Promise<PrepareBlindPairResult> {
  const projectRoot = resolve(input.projectRoot);
  const pairId = SafePairIdSchema.parse(input.pairId);
  if (!isSafeBookId(input.bookId)) throw new Error("Blind pair Book ID is not filesystem-safe.");
  const neutralWorkOrderId = SafeWorkOrderIdSchema.parse(input.neutralWorkOrderId);
  const soulWorkOrderId = SafeWorkOrderIdSchema.parse(input.soulWorkOrderId);
  if (neutralWorkOrderId === soulWorkOrderId) throw new Error("Blind pair lanes require different WorkOrders.");
  const round = input.round ?? 1;
  if ((input.commonContextBytes === undefined) === (input.commonContextPath === undefined)) {
    throw new Error("Blind pair preparation requires exactly one common-context byte source or project-relative path.");
  }
  const commonContextBytes = input.commonContextBytes === undefined
    ? await readRegularStable(projectRoot, input.commonContextPath!)
    : Buffer.from(input.commonContextBytes);
  const commonContext = decodeBoundedUtf8(commonContextBytes, "Blind pair common context", 500_000);
  if (!commonContext.trim()) throw new Error("Blind pair common context must not be blank.");
  const commonContextRef = {
    text: commonContext,
    sha256: sha256Bytes(commonContextBytes),
    byteLength: commonContextBytes.byteLength,
  };
  const mappingPath = blindPairMappingRelativePath(pairId);
  const transferPath = blindPairTransferRelativePath(pairId);
  const lockPath = posix.join(".inkos", "canaries", pairId, "review", ".prepare-blind-pair.lock");
  await ensureDirectory(projectRoot, posix.dirname(lockPath));
  const lockAbsolute = absoluteContainedPath(projectRoot, lockPath);
  let lockHandle: FileHandle;
  try {
    lockHandle = await open(
      lockAbsolute,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Blind pair ${pairId} is already being prepared.`);
    throw error;
  }
  const ownedLock = await lockHandle.stat();
  try {
    const existing = await readOptionalRegular(projectRoot, mappingPath);
    if (existing) {
      const mapping = parseRawJson(existing, BlindPairPrivateMappingReceiptSchema, "Blind pair private mapping");
      if (mapping.sourcePairId !== pairId || mapping.bookId !== input.bookId || mapping.round !== round
        || mapping.commonContext.sha256 !== commonContextRef.sha256 || mapping.commonContext.byteLength !== commonContextRef.byteLength
        || mapping.mappings.find((item) => item.lane === "neutral")?.workOrderId !== neutralWorkOrderId
        || mapping.mappings.find((item) => item.lane === "soul")?.workOrderId !== soulWorkOrderId) {
        throw new Error("Existing blind pair mapping belongs to different inputs; no-clobber prevents replacement.");
      }
      const loaded = await loadMappedPair(projectRoot, mapping);
      assertLoadedCandidatesMatchMapping(mapping, loaded);
      const transfer = buildEvaluationTransfer(mapping, sha256Bytes(existing));
      assertNoPublicGeneratorLeaks(transfer, mapping);
      const transferBytes = serializeJson(transfer);
      const storedTransfer = await writeExclusiveOrVerify(projectRoot, transferPath, transferBytes, 0o644);
      return {
        mapping: { path: mappingPath, sha256: sha256Bytes(existing) },
        transfer: { path: transferPath, sha256: sha256Bytes(transferBytes), value: transfer },
        replayed: storedTransfer.replayed,
      };
    }

    const [neutral, soul] = await Promise.all([
      loadLaneCandidate(projectRoot, pairId, "neutral", input.bookId, neutralWorkOrderId),
      loadLaneCandidate(projectRoot, pairId, "soul", input.bookId, soulWorkOrderId),
    ]);
    if (neutral.chapter.chapterNumber !== soul.chapter.chapterNumber) {
      throw new Error("Blind pair lanes committed different chapter numbers.");
    }
    if (neutral.bytes.equals(soul.bytes) || neutral.mapping.chapterArtifact.sha256 === soul.mapping.chapterArtifact.sha256) {
      throw new Error("Blind pair lanes produced the same candidate manuscript.");
    }
    assertCommonCanaryIsolation(neutral.terminal, soul.terminal);
    if (neutral.mapping.profileId === soul.mapping.profileId) throw new Error("Blind pair lanes require different producer profiles.");

    const entropy = randomBytes(32);
    const ordered = (entropy[0]! & 1) === 0 ? [neutral, soul] as const : [soul, neutral] as const;
    const mappings = ordered.map((candidate, index) => ({
      ...candidate.mapping,
      candidateId: index === 0 ? "candidate-A" as const : "candidate-B" as const,
    })) as unknown as readonly [BlindPairPrivateCandidateMapping, BlindPairPrivateCandidateMapping];
    const opaquePairId = `bp-${taggedEntropySha256(entropy, "pair").slice(0, 24)}`;
    const blindRunId = `br-${taggedEntropySha256(entropy, "run").slice(0, 24)}`;
    const blindSessionId = `br-${taggedEntropySha256(entropy, "session").slice(0, 24)}`;
    const canaryIsolation = projectCanaryIsolation(neutral.terminal);
    const pairedGenerationReceiptSha256 = hashCanonicalJson({
      schemaVersion: "inkos-blind-pair-generation-binding/v1",
      bookId: input.bookId,
      chapterNumber: neutral.chapter.chapterNumber,
      canaryIsolation,
      terminals: [neutral, soul].map((candidate) => ({
        terminalSha256: candidate.terminalRawSha256,
        terminalSelfHash: candidate.terminal.receiptSelfHash,
        chapterCommitSha256: candidate.mapping.chapterCommit.sha256,
        chapterArtifactSha256: candidate.mapping.chapterArtifact.sha256,
      })).sort((left, right) => left.terminalSha256.localeCompare(right.terminalSha256)),
    });
    const unsigned = {
      schemaVersion: "inkos-blind-pair-private-mapping/v1" as const,
      sourcePairId: pairId,
      opaquePairId,
      blindRunId,
      blindSessionId,
      bookId: input.bookId,
      chapterNumber: neutral.chapter.chapterNumber,
      round,
      commonContext: commonContextRef,
      commonInputReceiptSha256: commonInputReceiptSha256(commonContextRef),
      pairedGenerationReceiptSha256,
      canaryIsolation,
      entropyCommitmentSha256: sha256Bytes(entropy),
      mappingRandomized: true as const,
      mappings,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    const mapping = BlindPairPrivateMappingReceiptSchema.parse({ ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) });
    const mappingBytes = serializeJson(mapping);
    await writeExclusive(projectRoot, mappingPath, mappingBytes, 0o600);
    const transfer = buildEvaluationTransfer(mapping, sha256Bytes(mappingBytes));
    assertNoPublicGeneratorLeaks(transfer, mapping);
    const transferBytes = serializeJson(transfer);
    await writeExclusive(projectRoot, transferPath, transferBytes, 0o644);
    return {
      mapping: { path: mappingPath, sha256: sha256Bytes(mappingBytes) },
      transfer: { path: transferPath, sha256: sha256Bytes(transferBytes), value: transfer },
      replayed: false,
    };
  } finally {
    await lockHandle.close().catch(() => undefined);
    const current = await lstat(lockAbsolute).catch(() => undefined);
    if (current && current.dev === ownedLock.dev && current.ino === ownedLock.ino) {
      await unlink(lockAbsolute).catch(() => undefined);
    }
  }
}

export async function materializeBlindPair(input: MaterializeBlindPairInput): Promise<MaterializeBlindPairResult> {
  const projectRoot = resolve(input.projectRoot);
  const pairId = SafePairIdSchema.parse(input.pairId);
  const mappingBytes = await readRegularStable(projectRoot, blindPairMappingRelativePath(pairId));
  const mapping = parseRawJson(mappingBytes, BlindPairPrivateMappingReceiptSchema, "Blind pair private mapping");
  if (mapping.sourcePairId !== pairId) throw new Error("Blind pair private mapping belongs to another pair.");
  const transferBytes = await readRegularStable(projectRoot, blindPairTransferRelativePath(pairId));
  const transfer = parseRawJson(transferBytes, BlindPairEvaluationTransferSchema, "Blind pair evaluation transfer");
  if (transfer.labelAssignmentReceiptSha256 !== sha256Bytes(mappingBytes)) {
    throw new Error("Blind pair transfer label-assignment digest does not match the private mapping receipt.");
  }
  assertTransferMatchesMapping(transfer, mapping);
  assertNoPublicGeneratorLeaks(transfer, mapping);
  const loaded = await loadMappedPair(projectRoot, mapping);
  assertLoadedCandidatesMatchMapping(mapping, loaded);

  const reviewInputBytes = await readRegularStable(projectRoot, input.reviewInputPath);
  const reviewInput = parseCanonicalRefLabJson(reviewInputBytes, RefLabBlindPairEvaluationInputV2Schema, "Reference Lab public review input v2");
  const evaluatorInputBytes = await readRegularStable(projectRoot, input.evaluatorInputPath);
  const evaluatorInput = parseCanonicalRefLabJson(evaluatorInputBytes, RefLabBlindPairEvaluatorInputV2Schema, "Reference Lab private evaluator input v2");
  const evaluatorResultBytes = await readRegularStable(projectRoot, input.evaluatorResultPath);
  const evaluatorResult = parseCanonicalRefLabJson(evaluatorResultBytes, RefLabBlindPairEvaluatorResultV2Schema, "Reference Lab evaluator result v2");
  const evaluatorHostReceiptBytes = await readRegularStable(projectRoot, input.evaluatorHostReceiptPath);
  const evaluatorHostReceipt = parseCanonicalRefLabJson(
    evaluatorHostReceiptBytes,
    RefLabBlindEvaluatorHostReceiptSchema,
    "Reference Lab evaluator host receipt",
  );
  const reviewReceiptBytes = await readRegularStable(projectRoot, input.reviewReceiptPath);
  const reviewReceipt = parseCanonicalRefLabJson(reviewReceiptBytes, RefLabBlindReviewReceiptV2Schema, "Reference Lab blind review receipt v2");
  const state = new StateManager(projectRoot);
  const book = await state.loadBookConfig(mapping.bookId);
  const currentChapter = await loadCurrentCanonicalChapter({
    projectRoot,
    state,
    bookId: mapping.bookId,
    chapterNumber: mapping.chapterNumber,
  });
  const surfaceCorpus = surfaceCorpusForGenre(book.genre);
  assertReviewInputMatchesTransfer(reviewInput, transfer, book.genre);
  assertPrivateEvaluatorInputMatchesReviewInput(evaluatorInput, reviewInput, transfer);
  assertEvaluatorResultMatchesTransfer(evaluatorResult, transfer, loaded);
  assertEvaluatorResultMatchesPrivateEvaluatorInput(evaluatorResult, evaluatorInput);
  const canonLeakCount = Object.values(evaluatorResult.evaluations)
    .reduce((count, evaluation) => count + evaluation.canonLeaks.length, 0);
  if (canonLeakCount !== 0) {
    throw new Error(`Storyyard materialization blocked: Reference Lab reported ${canonLeakCount} canon leak(s).`);
  }

  const scanBytes = await Promise.all(input.surfaceScanPaths.map((path) => readRegularStable(projectRoot, path))) as [Buffer, Buffer];
  const scans = scanBytes.map((bytes, index) => parseCanonicalRefLabJson(bytes, RefLabBlindSurfaceScanReceiptSchema, `Reference Lab surface scan ${index + 1}`)) as [RefLabBlindSurfaceScanReceipt, RefLabBlindSurfaceScanReceipt];
  const scanById = new Map(scans.map((scan, index) => [scan.candidateId, { scan, bytes: scanBytes[index]! }]));
  if (scanById.size !== 2) throw new Error("Reference Lab surface scans must cover candidate-A and candidate-B exactly once.");

  const byId = new Map(loaded.map((candidate) => [candidate.mapping.candidateId, candidate]));
  for (const candidateId of ["candidate-A", "candidate-B"] as const) {
    const candidate = byId.get(candidateId)!;
    const scan = scanById.get(candidateId)?.scan;
    if (!scan) throw new Error(`Reference Lab surface scan is missing ${candidateId}.`);
    assertSurfaceScanMatchesCandidate(scan, candidate);
  }
  assertEvaluatorHostReceiptMatchesEvidence({
    hostReceipt: evaluatorHostReceipt,
    hostReceiptBytes: evaluatorHostReceiptBytes,
    reviewInputBytes,
    evaluatorInputBytes,
    evaluatorResultBytes,
    receipt: reviewReceipt,
  });
  assertReviewReceiptMatchesEvidence({
    receipt: reviewReceipt,
    reviewInputBytes,
    reviewInput,
    evaluatorInput,
    evaluatorInputBytes,
    evaluatorResult,
    evaluatorResultBytes,
    evaluatorHostReceiptBytes,
    scans,
    scanBytes,
    transfer,
  });

  const candidateEvidenceReceiptSha256s = loaded.map((candidate) => candidate.terminalRawSha256).sort() as [string, string];
  const contentNeutralReceiptSha256s = (["candidate-A", "candidate-B"] as const)
    .map((id) => hashCanonicalJson({
      schemaVersion: "firefly-content-neutral-evaluation/v1",
      candidateId: id,
      candidateSha256: evaluatorResult.evaluations[id].candidateSha256,
      contentNeutrality: evaluatorResult.evaluations[id].contentNeutrality,
    })).sort() as [string, string];
  if (candidateEvidenceReceiptSha256s[0] === candidateEvidenceReceiptSha256s[1]
    || contentNeutralReceiptSha256s[0] === contentNeutralReceiptSha256s[1]) {
    throw new Error("Blind pair sealed evidence receipts must be distinct.");
  }
  const publicCandidates = (["candidate-A", "candidate-B"] as const).map((id) => {
    const candidate = byId.get(id)!;
    const evaluation = evaluatorResult.evaluations[id];
    const scanEvidence = scanById.get(id)!;
    return {
      id,
      kind: "blind-pair-candidate" as const,
      evaluationBindingSha256: reviewReceipt.candidateBindings[id].evaluationBindingSha256,
      canaryIsolation: transfer.canaryIsolation,
      status: "unreviewed",
      body: candidate.body,
      sha256: candidate.mapping.chapterArtifact.sha256,
      preparedAt: mapping.createdAt,
      commercialScore: evaluation.commercialScore,
      commercialEvaluation: evaluation.commercialEvaluation,
      commercialEvaluationReceiptSha256: reviewReceipt.evaluatorBinding.evaluatorResultSha256,
      review: {
        status: "unreviewed",
        retained: [] as string[],
        variedSurface: [] as string[],
        linkedConsequences: [] as string[],
        emotionalCoherence: evaluation.emotionalCoherence,
        contentNeutrality: evaluation.contentNeutrality,
        canonContradictions: evaluation.canonContradictions,
        surfaceComparison: {
          schemaVersion: "soul_corpus_comparison/v2" as const,
          // This is the public, genre-derived comparison corpus used for both
          // candidates. It does not disclose which candidate came from a Soul lane.
          soulId: surfaceCorpus.soulId,
          soulVersion: surfaceCorpus.soulVersion,
          surfaceIndexSha256: scanEvidence.scan.corpus.surfaceIndexSha256,
          surfaceMatches: scanEvidence.scan.matches,
          similarityPenaltyApplied: false as const,
          automaticRewriteApplied: false as const,
          automaticRejectApplied: false as const,
          humanDecision: "pending" as const,
        },
      },
    };
  }) as unknown as [Record<string, unknown>, Record<string, unknown>];
  const packet = buildFireflyReviewPacketV2({
    generatedAt: input.generatedAt ?? reviewReceipt.createdAt,
    body: {
      purpose: "promotion-evaluation",
      source: { system: "inkos", bookId: mapping.bookId, sourceRevision: book.updatedAt },
      work: { id: book.id, title: book.title, genre: book.genre, status: book.status, targetChapters: book.targetChapters },
      artifact: {
        id: `chapter-${String(mapping.chapterNumber).padStart(4, "0")}`,
        kind: "chapter",
        chapterNumber: mapping.chapterNumber,
        title: currentChapter.title,
        status: currentChapter.status,
        currentContent: currentChapter.body,
        currentContentSha256: currentChapter.sha256,
      },
      comparison: {
        reviewKind: "independent-blind-comparison",
        pairId: transfer.pairId,
        round: transfer.round,
        blindRunId: transfer.blindRunId,
        blindSessionId: transfer.blindSessionId,
        commonInputReceiptSha256: transfer.commonInputReceiptSha256,
        pairedGenerationReceiptSha256: transfer.pairedGenerationReceiptSha256,
        labelAssignmentReceiptSha256: transfer.labelAssignmentReceiptSha256,
        runtimeReceiptSha256: reviewReceipt.evaluatorBinding.evaluatorResultSha256,
        canaryIsolation: transfer.canaryIsolation,
        candidateLabelsShuffled: true,
        generatorMetadataExcluded: true,
        runtime: { kernel: "enforce", piWorker: "off", retrieval: "legacy", fts: "off", model: "gpt-5.6-sol", reasoning: "high" },
      },
      candidates: publicCandidates,
      sealedGenerationEvidence: { candidateEvidenceReceiptSha256s, contentNeutralReceiptSha256s },
      recommendation: null,
      actions: ["select", "tie", "invalid"],
      authority: { canon: "inkos", decisionSurface: "storyyard", decisionEffect: "advisory", manuscriptApply: false, reverseSync: false },
    },
  });
  assertNoPublicGeneratorLeaks(packet, mapping, new Set([surfaceCorpus.soulId, surfaceCorpus.soulVersion]));
  const outputPath = posix.join(".inkos", "canaries", pairId, "review", "public", `${packet.packetId}.json`);
  const packetBytes = serializeJson(packet);
  const stored = await writeExclusiveOrVerify(projectRoot, outputPath, packetBytes, 0o644);
  return { packet, artifact: { path: outputPath, sha256: sha256Bytes(packetBytes) }, replayed: stored.replayed };
}

export async function acknowledgeStoryyardEvaluation(input: {
  readonly projectRoot: string;
  readonly pairId: string;
  readonly packetPath: string;
  readonly decisionPath: string;
  readonly now?: () => Date;
}): Promise<FireflyReviewEvaluationAck> {
  const projectRoot = resolve(input.projectRoot);
  const pairId = SafePairIdSchema.parse(input.pairId);
  const [mappingBytes, packetBytes, decisionBytes] = await Promise.all([
    readRegularStable(projectRoot, blindPairMappingRelativePath(pairId)),
    readRegularStable(projectRoot, input.packetPath),
    readRegularStable(projectRoot, input.decisionPath),
  ]);
  const mapping = parseRawJson(mappingBytes, BlindPairPrivateMappingReceiptSchema, "Blind pair private mapping");
  const packet = parseRawJson(packetBytes, FireflyReviewPacketV2Schema, "Storyyard review packet v2");
  const decision = parseRawJson(decisionBytes, FireflyReviewDecisionV2Schema, "Storyyard evaluation decision v2");
  if (mapping.sourcePairId !== pairId || packet.comparison.pairId !== mapping.opaquePairId
    || packet.comparison.labelAssignmentReceiptSha256 !== sha256Bytes(mappingBytes)) {
    throw new Error("Storyyard evaluation packet belongs to another blind pair.");
  }
  assertFireflyReviewPacketV2Identity(packet);
  assertFireflyReviewDecisionV2MatchesPacket(decision, packet);
  // The private source pair locates InkOS's label mapping, but the public ACK
  // path must use the opaque pair ID already exposed to Storyyard.
  const ackReceiptPath = storyyardEvaluationAckRelativePath(packet.comparison.pairId, decision.decisionId);
  const acknowledgedAt = (input.now ?? (() => new Date()))().toISOString();
  const unsigned = {
    schemaVersion: "firefly_review_evaluation_ack/v1" as const,
    decisionId: decision.decisionId,
    packetId: decision.packetId,
    packetSha256: decision.packetSha256,
    workId: decision.workId,
    artifactId: decision.artifactId,
    candidateId: decision.candidateId,
    candidateSha256: decision.candidateSha256,
    decision: decision.decision,
    comment: decision.comment,
    surfaceClassifications: decision.surfaceClassifications,
    purpose: "promotion-evaluation" as const,
    decisionEffect: "advisory" as const,
    canonEffect: "none" as const,
    manuscriptApply: false as const,
    status: "acknowledged" as const,
    createdAt: decision.createdAt,
    acknowledgedAt,
    ackReceiptPath,
  };
  const ack = FireflyReviewEvaluationAckSchema.parse({ ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) });
  await writeExclusive(projectRoot, ackReceiptPath, serializeJson(ack), 0o600);
  return ack;
}

function buildEvaluationTransfer(mapping: BlindPairPrivateMappingReceipt, mappingRawSha256: string): BlindPairEvaluationTransfer {
  const unsigned = {
    schemaVersion: "inkos-blind-pair-evaluation-transfer/v1" as const,
    pairId: mapping.opaquePairId,
    round: mapping.round,
    blindRunId: mapping.blindRunId,
    blindSessionId: mapping.blindSessionId,
    bookId: mapping.bookId,
    chapterNumber: mapping.chapterNumber,
    commonContext: mapping.commonContext,
    commonInputReceiptSha256: mapping.commonInputReceiptSha256,
    pairedGenerationReceiptSha256: mapping.pairedGenerationReceiptSha256,
    labelAssignmentReceiptSha256: mappingRawSha256,
    canaryIsolation: mapping.canaryIsolation,
    candidates: mapping.mappings.map((candidate) => ({
      id: candidate.candidateId,
      body: candidate.body,
      sha256: candidate.chapterArtifact.sha256,
      byteLength: candidate.chapterArtifact.byteLength,
    })) as [{ id: "candidate-A"; body: string; sha256: string; byteLength: number }, { id: "candidate-B"; body: string; sha256: string; byteLength: number }],
    generatedAt: mapping.createdAt,
    authority: { scope: "evaluation-input" as const, mayWriteInkOSCanon: false as const, mayRevealGeneratorIdentity: false as const, ownerDecisionRequired: true as const },
  };
  return BlindPairEvaluationTransferSchema.parse({ ...unsigned, transferSelfHash: hashCanonicalJson(unsigned) });
}

async function loadMappedPair(projectRoot: string, mapping: BlindPairPrivateMappingReceipt): Promise<[LoadedCandidate, LoadedCandidate]> {
  const loaded = await Promise.all(mapping.mappings.map((candidate) => loadLaneCandidate(
    projectRoot,
    mapping.sourcePairId,
    candidate.lane,
    mapping.bookId,
    candidate.workOrderId,
  )));
  return loaded.map((candidate, index) => ({
    ...candidate,
    mapping: { ...candidate.mapping, candidateId: mapping.mappings[index]!.candidateId },
  })) as [LoadedCandidate, LoadedCandidate];
}

async function loadLaneCandidate(
  sourceProjectRoot: string,
  pairId: string,
  lane: "neutral" | "soul",
  bookId: string,
  workOrderId: string,
): Promise<LoadedCandidate> {
  const laneProjectRelative = posix.join(".inkos", "canaries", pairId, lane);
  const laneRoot = absoluteContainedPath(sourceProjectRoot, laneProjectRelative);
  const terminal = await loadAgentOperationTerminal({ projectRoot: laneRoot, bookId, workOrderId });
  if (!terminal || terminal.schemaVersion !== "inkos-agent-operation-terminal/v2" || terminal.status !== "succeeded"
    || terminal.executionMode !== "promotion-canary" || !terminal.canaryIsolation || !terminal.chapterCommit) {
    throw new Error(`Blind pair ${lane} lane requires one successful promotion-canary terminal v2.`);
  }
  if (terminal.bookId !== bookId || terminal.workOrderId !== workOrderId
    || terminal.canaryIsolation.pairId !== pairId || terminal.canaryIsolation.lane !== lane
    || terminal.canaryIsolation.bookId !== bookId || terminal.canaryIsolation.projectRoot !== laneProjectRelative) {
    throw new Error(`Blind pair ${lane} terminal is cross-bound to another pair, lane, Book, or WorkOrder.`);
  }
  const bookDir = posix.join("books", bookId);
  const terminalPath = posix.join(bookDir, hermesControlOperationPaths(workOrderId).terminal);
  const terminalBytes = await readRegularStable(laneRoot, terminalPath);
  const rawTerminal = parseRawJson(terminalBytes, AgentOperationTerminalReceiptV2Schema, `Blind pair ${lane} terminal`);
  if (hashCanonicalJson(rawTerminal) !== hashCanonicalJson(terminal)) throw new Error(`Blind pair ${lane} terminal changed after canonical replay verification.`);
  const importPath = posix.join(bookDir, terminal.importReceipt.path);
  const importBytes = await readExpectedArtifact(laneRoot, importPath, terminal.importReceipt, `${lane} import receipt`);
  const importReceipt = parseRawJson(importBytes, HermesControlImportReceiptV2Schema, `Blind pair ${lane} import receipt`);
  if (importReceipt.workOrderId !== workOrderId || importReceipt.bookId !== bookId
    || hashCanonicalJson(importReceipt.canaryIsolation) !== hashCanonicalJson(terminal.canaryIsolation)) {
    throw new Error(`Blind pair ${lane} import receipt is cross-bound.`);
  }
  const requestBytes = await readExpectedArtifact(laneRoot, posix.join(bookDir, importReceipt.request.path), importReceipt.request, `${lane} WorkOrder request`);
  const request = parseRawJson(requestBytes, z.object({
    schemaVersion: z.literal(2),
    workOrderId: SafeWorkOrderIdSchema,
    repo: z.literal("inkos"),
    capability: z.literal("agent-operate"),
    bookId: z.string(),
    sessionId: z.string().min(1),
    expectedSoulBinding: z.unknown(),
    executionMode: z.literal("promotion-canary"),
    runtime: z.object({ hermesProfile: z.string().min(1) }).passthrough(),
    modeEvidence: z.object({
      lane: z.enum(["neutral-baseline", "genre-soul"]),
      profileId: z.string().min(1),
      soulId: z.string().min(1),
      soulVersion: z.string().min(1),
      canaryIsolation: z.object({ pairId: SafePairIdSchema }).passthrough(),
    }).passthrough(),
  }).passthrough(), `Blind pair ${lane} WorkOrder request`);
  const expectedLane = lane === "neutral" ? "neutral-baseline" : "genre-soul";
  if (request.workOrderId !== workOrderId || request.bookId !== bookId || request.sessionId !== terminal.sessionId
    || request.modeEvidence.lane !== expectedLane || request.modeEvidence.canaryIsolation.pairId !== pairId
    || request.runtime.hermesProfile !== request.modeEvidence.profileId) {
    throw new Error(`Blind pair ${lane} WorkOrder profile/lane/session binding is invalid.`);
  }
  if (hashCanonicalJson(request.expectedSoulBinding) !== hashCanonicalJson(terminal.canaryIsolation.expectedSoulBinding)) {
    throw new Error(`Blind pair ${lane} WorkOrder expected Soul binding drifted from its terminal.`);
  }
  if (lane === "soul" && (request.modeEvidence.soulId !== terminal.canaryIsolation.expectedSoulBinding?.soulId
    || request.modeEvidence.soulVersion !== terminal.canaryIsolation.expectedSoulBinding.soulVersion)) {
    throw new Error("Blind pair Soul lane profile identity drifted from its isolated Soul binding.");
  }
  const hermesReceiptBytes = await readExpectedArtifact(
    laneRoot,
    posix.join(bookDir, importReceipt.hermesReceipt.path),
    importReceipt.hermesReceipt,
    `${lane} Hermes invocation receipt`,
  );
  const hermesReceipt = parseRawJson(hermesReceiptBytes, HermesInvocationReceiptSchema, `Blind pair ${lane} Hermes invocation receipt`);
  if (hermesReceipt.workOrderId !== workOrderId || hermesReceipt.workOrderSha256 !== importReceipt.workOrderSha256
    || hermesReceipt.profile.profileId !== request.modeEvidence.profileId
    || hermesReceipt.profile.soulId !== request.modeEvidence.soulId
    || hermesReceipt.profile.soulVersion !== request.modeEvidence.soulVersion) {
    throw new Error(`Blind pair ${lane} Hermes producer profile is cross-bound.`);
  }
  const chapterCommitBytes = await readExpectedArtifact(
    laneRoot,
    posix.join(bookDir, terminal.chapterCommit.path),
    terminal.chapterCommit,
    `${lane} ChapterCommitReceipt`,
  );
  const chapter = parseRawJson(chapterCommitBytes, ChapterCommitReceiptSchema, `Blind pair ${lane} ChapterCommitReceipt`);
  if (chapter.bookId !== bookId || chapter.productionOperationId !== terminal.productionRun.productionOperationId
    || chapter.attemptId !== terminal.productionRun.attemptId || chapter.receiptId !== terminal.chapterCommit.receiptId
    || chapter.receiptSelfHash !== terminal.chapterCommit.receiptSelfHash || chapter.commitState !== "verified") {
    throw new Error(`Blind pair ${lane} ChapterCommitReceipt is cross-bound.`);
  }
  const canonicalChapterPrefix = String(chapter.chapterNumber).padStart(4, "0");
  if (!new RegExp(`^chapters/${canonicalChapterPrefix}(?:\\.md|_[^/]+\\.md)$`, "u").test(chapter.chapterArtifact.path)) {
    throw new Error(`Blind pair ${lane} Chapter artifact path is not canonical for its chapter.`);
  }
  const chapterArtifactBytes = await readRegularStable(laneRoot, posix.join(bookDir, chapter.chapterArtifact.path));
  if (sha256Bytes(chapterArtifactBytes) !== chapter.chapterArtifact.sha256) {
    throw new Error(`Blind pair ${lane} Chapter manuscript raw SHA-256 mismatch.`);
  }
  const body = decodeBoundedUtf8(chapterArtifactBytes, `Blind pair ${lane} Chapter manuscript`, MAX_REVIEW_ARTIFACT_BYTES);
  const mapping: BlindPairPrivateCandidateMapping = {
    candidateId: "candidate-A",
    lane,
    profileId: request.modeEvidence.profileId,
    sessionId: request.sessionId,
    workOrderId,
    laneProjectRoot: laneProjectRelative,
    expectedSoulBinding: terminal.canaryIsolation.expectedSoulBinding,
    terminal: {
      path: hermesControlOperationPaths(workOrderId).terminal,
      sha256: sha256Bytes(terminalBytes),
      byteLength: terminalBytes.byteLength,
      receiptSelfHash: terminal.receiptSelfHash,
    },
    chapterCommit: {
      path: terminal.chapterCommit.path,
      sha256: sha256Bytes(chapterCommitBytes),
      byteLength: chapterCommitBytes.byteLength,
      receiptSelfHash: chapter.receiptSelfHash,
    },
    chapterArtifact: {
      path: chapter.chapterArtifact.path,
      sha256: sha256Bytes(chapterArtifactBytes),
      byteLength: chapterArtifactBytes.byteLength,
    },
    body,
  };
  return { mapping, body, bytes: chapterArtifactBytes, terminal, terminalRawSha256: sha256Bytes(terminalBytes), chapter };
}

function assertLoadedCandidatesMatchMapping(mapping: BlindPairPrivateMappingReceipt, loaded: readonly LoadedCandidate[]): void {
  for (let index = 0; index < mapping.mappings.length; index += 1) {
    const expected = mapping.mappings[index]!;
    const actual = loaded[index]!;
    for (const [label, left, right] of [
      ["lane", expected.lane, actual.mapping.lane],
      ["profile", expected.profileId, actual.mapping.profileId],
      ["session", expected.sessionId, actual.mapping.sessionId],
      ["WorkOrder", expected.workOrderId, actual.mapping.workOrderId],
      ["lane project", expected.laneProjectRoot, actual.mapping.laneProjectRoot],
      ["terminal", expected.terminal.sha256, actual.mapping.terminal.sha256],
      ["ChapterCommitReceipt", expected.chapterCommit.sha256, actual.mapping.chapterCommit.sha256],
      ["manuscript", expected.chapterArtifact.sha256, actual.mapping.chapterArtifact.sha256],
      ["manuscript body", expected.body, actual.body],
    ] as const) {
      if (left !== right) throw new Error(`Blind pair private ${label} mapping changed after preparation.`);
    }
    if (hashCanonicalJson(expected.expectedSoulBinding) !== hashCanonicalJson(actual.mapping.expectedSoulBinding)) {
      throw new Error("Blind pair private Soul binding changed after preparation.");
    }
  }
  if (loaded[0]!.bytes.equals(loaded[1]!.bytes)) throw new Error("Blind pair candidates became identical.");
}

function assertTransferMatchesMapping(transfer: BlindPairEvaluationTransfer, mapping: BlindPairPrivateMappingReceipt): void {
  const expected = buildEvaluationTransfer(mapping, transfer.labelAssignmentReceiptSha256);
  if (hashCanonicalJson(expected) !== hashCanonicalJson(transfer)) {
    throw new Error("Blind pair public transfer does not exactly project its private mapping receipt.");
  }
}

function assertEvaluatorResultMatchesTransfer(
  result: RefLabBlindPairEvaluatorResultV2,
  transfer: BlindPairEvaluationTransfer,
  loaded: readonly LoadedCandidate[],
): void {
  if (result.pairId !== transfer.pairId || result.round !== transfer.round || result.blindRunId !== transfer.blindRunId
    || result.pairedGenerationReceiptSha256 !== transfer.pairedGenerationReceiptSha256) {
    throw new Error("Reference Lab evaluator result opaque IDs/digests do not match the blind transfer.");
  }
  const byId = new Map(loaded.map((candidate) => [candidate.mapping.candidateId, candidate]));
  for (const id of ["candidate-A", "candidate-B"] as const) {
    const candidate = byId.get(id)!;
    const expected = transfer.candidates.find((item) => item.id === id)!;
    const evaluation = result.evaluations[id];
    if (evaluation.candidateSha256 !== expected.sha256 || expected.sha256 !== candidate.mapping.chapterArtifact.sha256
      || expected.byteLength !== candidate.bytes.byteLength) {
      throw new Error(`Reference Lab evaluator result ${id} does not match exact candidate bytes.`);
    }
    for (const span of collectEvaluationSpans(evaluation)) assertCandidateSpan(span, candidate.bytes, `${id} evaluator evidence`);
  }
}

function assertReviewInputMatchesTransfer(
  reviewInput: RefLabBlindPairEvaluationInputV2,
  transfer: BlindPairEvaluationTransfer,
  genre: string,
): void {
  if (reviewInput.genre !== genre || reviewInput.pairId !== transfer.pairId || reviewInput.round !== transfer.round
    || reviewInput.blindRunId !== transfer.blindRunId || reviewInput.blindSessionId !== transfer.blindSessionId
    || reviewInput.commonInputReceiptSha256 !== transfer.commonInputReceiptSha256
    || reviewInput.pairedGenerationReceiptSha256 !== transfer.pairedGenerationReceiptSha256
    || reviewInput.labelAssignmentReceiptSha256 !== transfer.labelAssignmentReceiptSha256
    || hashCanonicalJson(reviewInput.commonContext) !== hashCanonicalJson(transfer.commonContext)) {
    throw new Error("Reference Lab public review input does not exactly bind the sealed blind transfer.");
  }
  for (const id of ["candidate-A", "candidate-B"] as const) {
    const expected = transfer.candidates.find((candidate) => candidate.id === id)!;
    const actual = reviewInput.candidates.find((candidate) => candidate.id === id);
    if (!actual || actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) {
      throw new Error(`Reference Lab public review input ${id} does not bind exact transferred candidate bytes.`);
    }
  }
  if (reviewInput.reviewer.profileId !== "inkos_blind_evaluator"
    || reviewInput.reviewer.configSha256 !== BLIND_EVALUATOR_CONFIG_SHA256
    || reviewInput.reviewer.soulSha256 !== BLIND_EVALUATOR_SOUL_SHA256) {
    throw new Error("Reference Lab public review input does not use the audited blind evaluator profile bytes.");
  }
}

function assertPrivateEvaluatorInputMatchesReviewInput(
  evaluatorInput: RefLabBlindPairEvaluatorInputV2,
  reviewInput: RefLabBlindPairEvaluationInputV2,
  transfer: BlindPairEvaluationTransfer,
): void {
  if (
    evaluatorInput.genre !== reviewInput.genre
    || evaluatorInput.pairId !== reviewInput.pairId
    || evaluatorInput.round !== reviewInput.round
    || evaluatorInput.blindRunId !== reviewInput.blindRunId
    || evaluatorInput.pairedGenerationReceiptSha256 !== reviewInput.pairedGenerationReceiptSha256
    || hashCanonicalJson(evaluatorInput.commonContext) !== hashCanonicalJson(reviewInput.commonContext)
    || hashCanonicalJson(evaluatorInput.contentContract) !== hashCanonicalJson(reviewInput.contentContract)
    || hashCanonicalJson(evaluatorInput.authority) !== hashCanonicalJson(reviewInput.authority)
    || evaluatorInput.reviewerRuntime.configSha256 !== reviewInput.reviewer.configSha256
    || evaluatorInput.reviewerRuntime.soulSha256 !== reviewInput.reviewer.soulSha256
  ) {
    throw new Error("Reference Lab private evaluator input does not match the public review input's shared contract.");
  }
  for (const candidate of evaluatorInput.candidates) {
    const transferred = transfer.candidates.find((item) => item.id === candidate.id);
    if (!transferred || candidate.body !== transferred.body || candidate.sha256 !== transferred.sha256 || candidate.byteLength !== transferred.byteLength) {
      throw new Error(`Reference Lab private evaluator input ${candidate.id} does not bind exact transferred candidate body bytes.`);
    }
    const publicCandidate = reviewInput.candidates.find((item) => item.id === candidate.id);
    if (!publicCandidate || publicCandidate.sha256 !== candidate.sha256 || publicCandidate.byteLength !== candidate.byteLength) {
      throw new Error(`Reference Lab private evaluator input ${candidate.id} does not match the public review candidate digest.`);
    }
    const bytes = Buffer.from(candidate.body, "utf8");
    for (const span of candidate.evidenceSpans) assertCandidateSpan(span, bytes, `${candidate.id} private evaluator input span`);
  }
}

function assertEvaluatorResultMatchesPrivateEvaluatorInput(
  result: RefLabBlindPairEvaluatorResultV2,
  evaluatorInput: RefLabBlindPairEvaluatorInputV2,
): void {
  for (const id of ["candidate-A", "candidate-B"] as const) {
    const candidate = evaluatorInput.candidates.find((item) => item.id === id);
    const evaluation = result.evaluations[id];
    if (!candidate || evaluation.candidateSha256 !== candidate.sha256) {
      throw new Error(`Reference Lab evaluator result ${id} does not match the private evaluator input.`);
    }
    const bytes = Buffer.from(candidate.body, "utf8");
    assertCandidateEvidenceSpanCatalog(candidate.evidenceSpans, bytes, `${id} private evaluator input`);
    const catalog = new Set(candidate.evidenceSpans.map((span) => JSON.stringify(span)));
    for (const span of collectEvaluationSpans(evaluation)) {
      assertCandidateSpan(span, bytes, `${id} private evaluator evidence`);
      if (!catalog.has(JSON.stringify(span))) throw new Error(`${id} evaluator evidence is not a sealed candidate-local catalog member.`);
    }
  }
}

function assertEvaluatorHostReceiptMatchesEvidence(input: {
  readonly hostReceipt: RefLabBlindEvaluatorHostReceipt;
  readonly hostReceiptBytes: Buffer;
  readonly reviewInputBytes: Buffer;
  readonly evaluatorInputBytes: Buffer;
  readonly evaluatorResultBytes: Buffer;
  readonly receipt: RefLabBlindReviewReceiptV2;
}): void {
  const { hostReceipt, hostReceiptBytes, reviewInputBytes, evaluatorInputBytes, evaluatorResultBytes, receipt } = input;
  const evaluatorInputSha256 = sha256Bytes(evaluatorInputBytes);
  const evaluatorResultSha256 = sha256Bytes(evaluatorResultBytes);
  const hostReceiptSha256 = sha256Bytes(hostReceiptBytes);
  if (hostReceipt.profileConfigSha256 !== receipt.reviewer.configSha256
    || hostReceipt.soulSha256 !== receipt.reviewer.soulSha256
    || hostReceipt.runId !== receipt.reviewer.runId
    || hostReceipt.completedAt !== receipt.createdAt
    || hostReceipt.inputDigest !== sha256Bytes(reviewInputBytes)
    || hostReceipt.exactReadSha256s[0] !== evaluatorInputSha256
    || hostReceipt.resultSha256 !== evaluatorResultSha256
    || hostReceiptSha256 !== receipt.evaluatorBinding.hostReceiptSha256) {
    throw new Error("Reference Lab evaluator host receipt does not bind the exact evaluator input/result/review evidence.");
  }
}

function assertReviewReceiptMatchesEvidence(input: {
  readonly receipt: RefLabBlindReviewReceiptV2;
  readonly reviewInputBytes: Buffer;
  readonly reviewInput: RefLabBlindPairEvaluationInputV2;
  readonly evaluatorInput: RefLabBlindPairEvaluatorInputV2;
  readonly evaluatorInputBytes: Buffer;
  readonly evaluatorResult: RefLabBlindPairEvaluatorResultV2;
  readonly evaluatorResultBytes: Buffer;
  readonly evaluatorHostReceiptBytes: Buffer;
  readonly scans: readonly [RefLabBlindSurfaceScanReceipt, RefLabBlindSurfaceScanReceipt];
  readonly scanBytes: readonly [Buffer, Buffer];
  readonly transfer: BlindPairEvaluationTransfer;
}): void {
  const {
    receipt, reviewInputBytes, reviewInput, evaluatorInput, evaluatorInputBytes, evaluatorResult, evaluatorResultBytes,
    evaluatorHostReceiptBytes, scans, scanBytes, transfer,
  } = input;
  const evaluatorInputSha256 = sha256Bytes(evaluatorInputBytes);
  const evaluatorResultSha256 = sha256Bytes(evaluatorResultBytes);
  const evaluatorHostReceiptSha256 = sha256Bytes(evaluatorHostReceiptBytes);
  if (receipt.genre !== reviewInput.genre || receipt.pairId !== transfer.pairId || receipt.round !== transfer.round
    || receipt.blindRunId !== transfer.blindRunId || receipt.blindSessionId !== transfer.blindSessionId
    || receipt.sealedInputSha256 !== sha256Bytes(reviewInputBytes) || receipt.commonContextSha256 !== transfer.commonContext.sha256
    || receipt.commonContextByteLength !== transfer.commonContext.byteLength
    || receipt.reviewPacketSha256 !== reviewInput.reviewPacket.sha256
    || receipt.commonInputReceiptSha256 !== transfer.commonInputReceiptSha256
    || receipt.pairedGenerationReceiptSha256 !== transfer.pairedGenerationReceiptSha256
    || receipt.labelAssignmentReceiptSha256 !== transfer.labelAssignmentReceiptSha256
    || receipt.evaluatorBinding.evaluatorInputSha256 !== evaluatorInputSha256
    || receipt.evaluatorBinding.evaluatorResultSha256 !== evaluatorResultSha256
    || receipt.evaluatorBinding.hostReceiptSha256 !== evaluatorHostReceiptSha256
    || receipt.reviewer.profileId !== reviewInput.reviewer.profileId
    || receipt.reviewer.configSha256 !== reviewInput.reviewer.configSha256
    || receipt.reviewer.soulSha256 !== reviewInput.reviewer.soulSha256) {
    throw new Error("Reference Lab blind review receipt does not bind the exact input/result/transfer evidence.");
  }
  const triple = {
    evaluatorInputSha256: receipt.evaluatorBinding.evaluatorInputSha256,
    evaluatorResultSha256: receipt.evaluatorBinding.evaluatorResultSha256,
    hostReceiptSha256: receipt.evaluatorBinding.hostReceiptSha256,
  };
  if (receipt.evaluatorBinding.tripleBindingSha256 !== refLabArtifactHash(triple)) {
    throw new Error("Reference Lab blind review receipt evaluator triple binding drifted.");
  }
  const expectedPolicy = {
    purpose: "promotion-evaluation",
    actions: ["select", "tie", "invalid"],
    decisionEffect: "advisory",
    manuscriptApply: false,
    canonLeakPolicy: "block-on-nonzero",
  };
  if (hashCanonicalJson(receipt.storyyardProjection) !== hashCanonicalJson(expectedPolicy)) {
    throw new Error("Reference Lab blind review receipt Storyyard policy drifted.");
  }
  const expectedHardContradictions = Object.values(evaluatorResult.evaluations)
    .reduce((count, evaluation) => count + evaluation.canonContradictions.length, 0);
  const expectedCanonLeaks = Object.values(evaluatorResult.evaluations)
    .reduce((count, evaluation) => count + evaluation.canonLeaks.length, 0);
  if (receipt.outcome.winner !== evaluatorResult.winner || receipt.outcome.hardContradictionCount !== expectedHardContradictions
    || receipt.outcome.canonLeakCount !== expectedCanonLeaks) {
    throw new Error("Reference Lab blind review receipt outcome does not match the evaluator result.");
  }
  for (const id of ["candidate-A", "candidate-B"] as const) {
    const index = id === "candidate-A" ? 0 : 1;
    const scan = scans[index];
    const scanSha256 = sha256Bytes(scanBytes[index]);
    const evaluation = evaluatorResult.evaluations[id];
    const binding = receipt.candidateBindings[id];
    if (binding.candidateSha256 !== evaluation.candidateSha256 || binding.surfaceScanReceiptSha256 !== scanSha256
      || binding.surfaceIndexSha256 !== scan.corpus.surfaceIndexSha256 || binding.surfaceScanStatus !== scan.status
      || binding.surfaceMatchCount !== scan.matchCount
      || receipt.outcome.commercialScores[id] !== evaluation.commercialScore
      || receipt.outcome.emotionalCoherenceScores[id] !== evaluation.emotionalCoherence.score
      || receipt.outcome.genreIdentityPassed[id] !== evaluation.genreIdentity.pass
      || receipt.outcome.contentNeutralViolationCounts[id] !== evaluation.contentNeutrality.violations.length) {
      throw new Error(`Reference Lab blind review receipt ${id} result/surface binding drifted.`);
    }
    const expectedBinding = refLabArtifactHash({
      schemaVersion: "firefly-blind-evaluation-binding/v1",
      candidateSha256: binding.candidateSha256,
      ...triple,
      surfaceScanReceiptSha256: scanSha256,
    });
    if (binding.evaluationBindingSha256 !== expectedBinding) {
      throw new Error(`Reference Lab blind review receipt ${id} evaluation binding drifted.`);
    }
  }
}

function assertSurfaceScanMatchesCandidate(scan: RefLabBlindSurfaceScanReceipt, candidate: LoadedCandidate): void {
  if (scan.candidateId !== candidate.mapping.candidateId || scan.candidateSha256 !== candidate.mapping.chapterArtifact.sha256
    || scan.candidateByteLength !== candidate.bytes.byteLength) {
    throw new Error(`Reference Lab surface scan ${scan.candidateId} does not match exact candidate bytes.`);
  }
  const matchIds = new Set<string>();
  for (const match of scan.matches) {
    if (matchIds.has(match.matchId)) throw new Error("Reference Lab surface scan match IDs must be unique.");
    matchIds.add(match.matchId);
    if (match.candidate.candidateContentSha256 !== scan.candidateSha256) throw new Error("Reference Lab surface selector candidate digest drifted.");
    assertCandidateSpan({
      coordinateKind: "utf8-byte",
      startByte: match.candidate.startByte,
      endByte: match.candidate.endByte,
      sliceSha256: match.candidate.candidateSliceSha256,
    }, candidate.bytes, `${scan.candidateId} surface selector`);
    const selectorBody = {
      provenanceBridgeReceiptSha256: match.provenanceBridgeReceiptSha256,
      matchMethod: match.matchMethod,
      candidate: match.candidate,
      source: match.source,
    };
    const selectorSha256 = sha256Bytes(Buffer.from(JSON.stringify(selectorBody), "utf8"));
    if (match.selectorSha256 !== selectorSha256 || match.matchId !== `fsm-${selectorSha256.slice(0, 24)}`) {
      throw new Error("Reference Lab surface selector identity drifted.");
    }
  }
}

function collectEvaluationSpans(evaluation: z.infer<typeof CandidateEvaluationSchema>): z.infer<typeof CandidateSpanSchema>[] {
  const genre = evaluation.genreIdentity;
  return [
    ...evaluation.emotionalCoherence.evidence,
    ...evaluation.contentNeutrality.violations.flatMap((item) => item.evidence),
    ...evaluation.canonContradictions.flatMap((item) => item.evidence),
    ...evaluation.canonLeaks.flatMap((item) => item.evidence),
    ...genre.worldConstraintEvidence,
    ...genre.repeatableVerbEvidence,
    ...genre.oppositionFormEvidence,
    ...genre.rewardStatusCurrencyEvidence,
    ...genre.nextEpisodeActionEvidence,
  ];
}

function assertCandidateSpan(span: z.infer<typeof CandidateSpanSchema>, bytes: Buffer, label: string): void {
  if (span.endByte <= span.startByte || span.endByte > bytes.byteLength) throw new Error(`${label} byte range is invalid.`);
  const slice = bytes.subarray(span.startByte, span.endByte);
  decodeBoundedUtf8(slice, label, MAX_REVIEW_ARTIFACT_BYTES);
  if (sha256Bytes(slice) !== span.sliceSha256) throw new Error(`${label} slice SHA-256 mismatch.`);
}

/** Reproduce RefLab's sealed catalog: every non-whitespace physical UTF-8 line, in source order. */
function buildCandidateEvidenceSpanCatalog(body: string): z.infer<typeof CandidateSpanSchema>[] {
  const spans: z.infer<typeof CandidateSpanSchema>[] = [];
  for (const match of body.matchAll(/[^\r\n]+/gu)) {
    const raw = match[0];
    const leading = raw.match(/^\s*/u)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/u)?.[0].length ?? 0;
    const startCodeUnit = (match.index ?? 0) + leading;
    const endCodeUnit = (match.index ?? 0) + raw.length - trailing;
    if (endCodeUnit <= startCodeUnit) continue;
    const startByte = Buffer.byteLength(body.slice(0, startCodeUnit), "utf8");
    const slice = Buffer.from(body.slice(startCodeUnit, endCodeUnit), "utf8");
    spans.push({ coordinateKind: "utf8-byte", startByte, endByte: startByte + slice.byteLength, sliceSha256: sha256Bytes(slice) });
  }
  if (spans.length === 0) throw new Error("Blind evaluator candidate requires at least one non-whitespace evidence span.");
  return spans;
}

function assertCandidateEvidenceSpanCatalog(
  actual: readonly z.infer<typeof CandidateSpanSchema>[],
  bytes: Buffer,
  label: string,
): void {
  const body = decodeBoundedUtf8(bytes, label, MAX_REVIEW_ARTIFACT_BYTES);
  const expected = buildCandidateEvidenceSpanCatalog(body);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} evidence span catalog does not equal RefLab's deterministic non-whitespace line catalog.`);
  }
}

function assertCommonCanaryIsolation(
  neutral: AgentOperationTerminalReceiptV2 & { status: "succeeded" },
  soul: AgentOperationTerminalReceiptV2 & { status: "succeeded" },
): void {
  const left = projectCanaryIsolation(neutral);
  const right = projectCanaryIsolation(soul);
  if (hashCanonicalJson(left) !== hashCanonicalJson(right)) throw new Error("Blind pair lanes do not share one exact canary isolation root.");
}

function projectCanaryIsolation(terminal: AgentOperationTerminalReceiptV2): FireflyCanaryIsolationProjection {
  if (!terminal.canaryIsolation) throw new Error("Blind pair terminal is missing canary isolation.");
  return FireflyCanaryIsolationProjectionSchema.parse({
    receiptSha256: terminal.canaryIsolation.receipt.sha256,
    receiptSelfHash: terminal.canaryIsolation.receipt.selfHash,
    isolationScopeSha256: terminal.canaryIsolation.isolationScopeSha256,
    commonSnapshotSha256: terminal.canaryIsolation.commonSnapshotSha256,
  });
}

function assertNoPublicGeneratorLeaks(
  value: unknown,
  mapping: BlindPairPrivateMappingReceipt,
  allowedPublicStrings: ReadonlySet<string> = new Set(),
): void {
  const forbiddenKeys = new Set([
    "lane", "profileId", "sessionId", "workOrderId", "laneProjectRoot", "expectedSoulBinding",
    "terminal", "chapterCommit", "chapterArtifact", "producerActors", "producerEvidence", "labelMap", "hiddenLane",
  ]);
  const forbidden = new Set<string>([
    mapping.sourcePairId,
    ...mapping.mappings.flatMap((candidate) => [
      candidate.profileId,
      candidate.sessionId,
      candidate.workOrderId,
      candidate.laneProjectRoot,
      candidate.expectedSoulBinding?.soulId ?? "",
      candidate.expectedSoulBinding?.soulVersion ?? "",
    ]),
  ].filter((item) => item.length >= 3 && !allowedPublicStrings.has(item)));
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      for (const secret of forbidden) {
        if (item.includes(secret)) throw new Error("Public blind payload leaks generator lane/profile/WorkOrder identity.");
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (forbiddenKeys.has(key)) throw new Error(`Public blind payload leaks forbidden generator metadata field ${key}.`);
        visit(child);
      }
    }
  };
  visit(value);
}

function surfaceCorpusForGenre(genre: string): (typeof SURFACE_CORPUS_BY_GENRE)[keyof typeof SURFACE_CORPUS_BY_GENRE] {
  if (!Object.prototype.hasOwnProperty.call(SURFACE_CORPUS_BY_GENRE, genre)) {
    throw new Error(`Blind surface corpus is not configured for genre ${genre}.`);
  }
  return SURFACE_CORPUS_BY_GENRE[genre as keyof typeof SURFACE_CORPUS_BY_GENRE];
}

function commonInputReceiptSha256(commonContext: { readonly text: string; readonly sha256: string; readonly byteLength: number }): string {
  return hashCanonicalJson({ schemaVersion: "inkos-blind-common-context/v1", commonContext });
}

function scoreCommercial(evaluation: z.infer<typeof CommercialEvaluationSchema>): number {
  const dopamine = (evaluation.openingPressure + evaluation.protagonistAgency + evaluation.resistanceQuality
    + evaluation.visiblePayoff + evaluation.endingPropulsion) / 5;
  const reference = (evaluation.referenceEngineRetention + evaluation.transformationIntegrity + evaluation.styleFidelity) / 3;
  return Math.round(((dopamine * 0.7) + (reference * 0.3)) * 10) / 10;
}

function taggedEntropySha256(entropy: Uint8Array, tag: string): string {
  return createHash("sha256").update(entropy).update("\0").update(tag).digest("hex");
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refLabArtifactHash(value: unknown): string {
  return sha256Bytes(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function decodeBoundedUtf8(bytes: Uint8Array, label: string, maximum: number): string {
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw new Error(`${label} must contain 1-${maximum} raw bytes.`);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not strict UTF-8.`);
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) throw new Error(`${label} is not canonical UTF-8.`);
  return decoded;
}

function parseRawJson<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  const decoded = decodeBoundedUtf8(bytes, label, MAX_REVIEW_ARTIFACT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return schema.parse(value);
}

function parseCanonicalRefLabJson<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  const decoded = decodeBoundedUtf8(bytes, label, MAX_REVIEW_ARTIFACT_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !bytes.equals(serializeJson(raw))) {
    throw new Error(`${label} must use exact canonical JSON bytes from Firefly Reference Lab.`);
  }
  schema.parse(raw);
  // Zod object parsing reorders known fields before passthrough fields. Return
  // the canonical raw object after validation so hash/self-hash consumers keep
  // the producer's exact insertion order.
  return raw as T;
}

function canonicalRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || posix.isAbsolute(path)
    || posix.normalize(path) !== path || path === ".." || path.startsWith("../")) {
    throw new Error(`Review artifact path must stay inside its project root: ${path}`);
  }
  return path;
}

function absoluteContainedPath(root: string, relativePath: string): string {
  const canonical = canonicalRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, ...canonical.split("/"));
  const rel = relative(absoluteRoot, absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Review artifact escaped its project root.");
  return absolute;
}

async function ensureDirectory(root: string, relativeDirectory: string): Promise<void> {
  const canonical = canonicalRelativePath(relativeDirectory);
  const parts = canonical.split("/");
  let cursor = resolve(root);
  const rootStat = await lstat(cursor);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Review project root must be a real directory.");
  for (const part of parts) {
    cursor = join(cursor, part);
    await mkdir(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Review output ancestor is not a real directory: ${cursor}`);
  }
}

interface AncestorIdentity { readonly path: string; readonly dev: number; readonly ino: number }

async function snapshotPhysicalAncestors(root: string, relativePath: string): Promise<AncestorIdentity[]> {
  const canonical = canonicalRelativePath(relativePath);
  let cursor = resolve(root);
  const rootStat = await lstat(cursor);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Review project root must be a real directory.");
  const identities: AncestorIdentity[] = [{ path: cursor, dev: rootStat.dev, ino: rootStat.ino }];
  for (const part of canonical.split("/").slice(0, -1)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Review artifact ancestor is not a real directory: ${cursor}`);
    identities.push({ path: cursor, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function readRegularStable(root: string, relativePath: string): Promise<Buffer> {
  const canonical = canonicalRelativePath(relativePath);
  const ancestorsBefore = await snapshotPhysicalAncestors(root, canonical);
  const absolute = absoluteContainedPath(root, canonical);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(absolute, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Review artifact is a forbidden symlink: ${relativePath}`);
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_REVIEW_ARTIFACT_BYTES) throw new Error(`Review artifact is not a bounded regular file: ${relativePath}`);
    const bytes = await handle.readFile();
    const [after, pathStat, ancestorsAfter] = await Promise.all([
      handle.stat(),
      lstat(absolute),
      snapshotPhysicalAncestors(root, canonical),
    ]);
    const ancestorsStable = ancestorsBefore.length === ancestorsAfter.length
      && ancestorsBefore.every((entry, index) => entry.path === ancestorsAfter[index]?.path
        && entry.dev === ancestorsAfter[index]?.dev && entry.ino === ancestorsAfter[index]?.ino);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || after.dev !== pathStat.dev || after.ino !== pathStat.ino || bytes.byteLength !== after.size || !ancestorsStable) {
      throw new Error(`Review artifact changed during stable readback: ${relativePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readOptionalRegular(root: string, relativePath: string): Promise<Buffer | undefined> {
  try {
    return await readRegularStable(root, relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadCurrentCanonicalChapter(input: {
  readonly projectRoot: string;
  readonly state: StateManager;
  readonly bookId: string;
  readonly chapterNumber: number;
}): Promise<{ readonly title: string; readonly status: string; readonly body: string; readonly sha256: string }> {
  const directoryPath = posix.join("books", input.bookId, "chapters");
  const absoluteDirectory = absoluteContainedPath(input.projectRoot, directoryPath);
  let before;
  try {
    before = await lstat(absoluteDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { title: "", status: "not-written", body: "", sha256: sha256Bytes(Buffer.alloc(0)) };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("Canonical chapter directory must be a real directory.");
  }
  const names = await readdir(absoluteDirectory);
  const after = await lstat(absoluteDirectory);
  if (after.isSymbolicLink() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error("Canonical chapter directory changed during stable lookup.");
  }
  const matches = names.flatMap((name) => {
    const match = name.match(/^(\d+)[_-]?(.*?)\.md$/u);
    if (!match || Number.parseInt(match[1]!, 10) !== input.chapterNumber) return [];
    return [{ name, fallbackTitle: match[2]!.replace(/_/gu, " ").trim() }];
  });
  const chapterIndex = await input.state.loadChapterIndex(input.bookId);
  const metadata = chapterIndex.find((chapter) => chapter.number === input.chapterNumber);
  if (matches.length === 0) {
    if (metadata) throw new Error("Canonical chapter index points to a missing manuscript file.");
    return { title: "", status: "not-written", body: "", sha256: sha256Bytes(Buffer.alloc(0)) };
  }
  if (matches.length !== 1) throw new Error("Canonical chapter lookup is ambiguous for the requested chapter number.");
  const match = matches[0]!;
  const bytes = await readRegularStable(input.projectRoot, posix.join(directoryPath, match.name));
  const body = decodeBoundedUtf8(bytes, "Canonical current chapter", MAX_REVIEW_ARTIFACT_BYTES);
  return {
    title: metadata?.title ?? match.fallbackTitle,
    status: metadata?.status ?? "ready-for-review",
    body,
    sha256: sha256Bytes(bytes),
  };
}

async function readExpectedArtifact(
  root: string,
  relativePath: string,
  expected: { readonly sha256: string; readonly byteLength: number },
  label: string,
): Promise<Buffer> {
  const bytes = await readRegularStable(root, relativePath);
  if (bytes.byteLength !== expected.byteLength || sha256Bytes(bytes) !== expected.sha256) {
    throw new Error(`${label} raw bytes do not match their sealed artifact reference.`);
  }
  return bytes;
}

async function writeExclusive(root: string, relativePath: string, bytes: Buffer, mode: number): Promise<void> {
  const canonical = canonicalRelativePath(relativePath);
  await ensureDirectory(root, posix.dirname(canonical));
  const absolute = absoluteContainedPath(root, canonical);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(absolute, flags, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Review artifact already exists; no-clobber refused replacement: ${relativePath}`);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readRegularStable(root, canonical);
  if (!readback.equals(bytes)) throw new Error(`Review artifact failed exact write readback: ${relativePath}`);
}

async function writeExclusiveOrVerify(
  root: string,
  relativePath: string,
  bytes: Buffer,
  mode: number,
): Promise<{ readonly replayed: boolean }> {
  try {
    await writeExclusive(root, relativePath, bytes, mode);
    return { replayed: false };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no-clobber")) throw error;
    const existing = await readRegularStable(root, relativePath);
    if (!existing.equals(bytes)) throw new Error(`Existing review artifact differs; no-clobber refused replacement: ${relativePath}`);
    return { replayed: true };
  }
}
