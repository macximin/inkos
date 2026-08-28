import { createHash } from "node:crypto";
import { z } from "zod";
import { scoreCommercialEvaluation, type CommercialEvaluation, type ReferenceTransformationHilCandidateView } from "../reference/hil-store.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CandidateSpanSchema = z.object({
  coordinateKind: z.literal("utf8-byte"),
  startByte: z.number().int().min(0),
  endByte: z.number().int().min(1),
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

export const FireflySurfaceMatchV2Schema = z.object({
  matchId: z.string().regex(/^fsm-[0-9a-f]{24}$/u),
  selectorSha256: Sha256Schema,
  provenanceBridgeReceiptSha256: Sha256Schema,
  matchMethod: z.enum(["exact-token-12", "exact-byte-120", "long-common-substring", "near-string"]),
  classification: z.literal("pending"),
  candidate: z.object({
    coordinateKind: z.literal("utf8-byte"),
    candidateContentSha256: Sha256Schema,
    startByte: z.number().int().min(0),
    endByte: z.number().int().min(1),
    candidateSliceSha256: Sha256Schema,
  }).strict(),
  source: z.object({
    coordinateKind: z.literal("utf8-byte"),
    sourceId: z.string().min(1),
    sourceSha256: Sha256Schema,
    startByte: z.number().int().min(0),
    endByte: z.number().int().min(1),
    sliceSha256: Sha256Schema,
  }).strict(),
}).strict();
export type FireflySurfaceMatchV2 = z.infer<typeof FireflySurfaceMatchV2Schema>;

const ContentNeutralViolationSchema = z.object({
  code: z.enum([
    "unauthorized-softening", "unauthorized-escalation", "moral-lecture", "disclaimer",
    "forced-punishment", "forced-apology", "forced-redemption", "forced-cost",
    "forced-moral-growth", "forced-balance",
  ]),
  evidence: z.array(CandidateSpanSchema),
}).strict();

export const FireflyReviewCandidateV2Schema = z.object({
  id: z.string().regex(/^candidate-[A-Z]$/u),
  applicationBindingSha256: Sha256Schema,
  status: z.string().min(1),
  body: z.string(),
  sha256: Sha256Schema,
  preparedAt: z.string().datetime(),
  commercialScore: z.number().min(0).max(100),
  commercialEvaluation: CommercialEvaluationSchema,
  commercialEvaluationReceiptSha256: Sha256Schema,
  review: z.object({
    status: z.string().min(1),
    retained: z.array(z.string()),
    variedSurface: z.array(z.string()),
    linkedConsequences: z.array(z.string()),
    emotionalCoherence: z.object({ score: z.number().min(0).max(100), evidence: z.array(CandidateSpanSchema) }).strict(),
    contentNeutrality: z.object({ passed: z.boolean(), violations: z.array(ContentNeutralViolationSchema) }).strict(),
    canonContradictions: z.array(z.object({ code: z.literal("hard-canon-contradiction"), evidence: z.array(CandidateSpanSchema) }).strict()),
    surfaceComparison: z.object({
      schemaVersion: z.literal("soul_corpus_comparison/v2"),
      soulId: z.string().min(1),
      soulVersion: z.string().min(1),
      surfaceIndexSha256: Sha256Schema,
      surfaceMatches: z.array(FireflySurfaceMatchV2Schema),
      similarityPenaltyApplied: z.literal(false),
      automaticRewriteApplied: z.literal(false),
      automaticRejectApplied: z.literal(false),
      humanDecision: z.literal("pending"),
    }).strict(),
  }).strict(),
}).strict();
export type FireflyReviewCandidateV2 = z.infer<typeof FireflyReviewCandidateV2Schema>;

const FireflyReviewPacketV2BodySchema = z.object({
  source: z.object({ system: z.literal("inkos"), bookId: z.string().min(1), sourceRevision: z.string().min(1) }).strict(),
  work: z.object({ id: z.string().min(1), title: z.string().min(1), genre: z.string().min(1), status: z.string().min(1), targetChapters: z.number().int().min(1) }).strict(),
  artifact: z.object({
    id: z.string().min(1), kind: z.literal("chapter"), chapterNumber: z.number().int().min(1),
    title: z.string(), status: z.string().min(1), currentContent: z.string(), currentContentSha256: Sha256Schema,
  }).strict(),
  comparison: z.object({
    reviewKind: z.literal("independent-blind-comparison"),
    pairId: z.string().min(1),
    round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    blindRunId: z.string().min(1),
    blindSessionId: z.string().min(1),
    commonInputReceiptSha256: Sha256Schema,
    pairedGenerationReceiptSha256: Sha256Schema,
    labelAssignmentReceiptSha256: Sha256Schema,
    runtimeReceiptSha256: Sha256Schema,
    candidateLabelsShuffled: z.literal(true),
    generatorMetadataExcluded: z.literal(true),
    runtime: z.object({
      kernel: z.literal("enforce"), piWorker: z.literal("off"), retrieval: z.literal("legacy"),
      fts: z.literal("off"), model: z.literal("gpt-5.6-sol"), reasoning: z.literal("high"),
    }).strict(),
  }).strict(),
  candidates: z.tuple([FireflyReviewCandidateV2Schema, FireflyReviewCandidateV2Schema]),
  sealedGenerationEvidence: z.object({
    candidateEvidenceReceiptSha256s: z.tuple([Sha256Schema, Sha256Schema]),
    contentNeutralReceiptSha256s: z.tuple([Sha256Schema, Sha256Schema]),
  }).strict(),
  recommendation: z.null(),
  actions: z.tuple([z.literal("approve"), z.literal("polish"), z.literal("hold"), z.literal("reject")]),
  authority: z.object({
    canon: z.literal("inkos"), decisionSurface: z.literal("storyyard"), apply: z.literal("inkos"), reverseSync: z.literal(false),
  }).strict(),
}).strict();
export type FireflyReviewPacketV2Body = z.infer<typeof FireflyReviewPacketV2BodySchema>;

export const FireflyReviewPacketV2Schema = z.object({
  schemaVersion: z.literal("firefly_review_packet/v2"),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  generatedAt: z.string().datetime(),
}).merge(FireflyReviewPacketV2BodySchema).strict();
export type FireflyReviewPacketV2 = z.infer<typeof FireflyReviewPacketV2Schema>;

export const FireflySurfaceClassificationReceiptSchema = z.object({
  matchId: z.string().regex(/^fsm-[0-9a-f]{24}$/u),
  selectorSha256: Sha256Schema,
  classification: z.enum(["engine", "genre-convention", "source-surface", "canon-leak"]),
  classifiedByActorId: z.string().min(1),
  classifiedByRole: z.literal("admin"),
  ownerScope: z.string().min(1),
  classifiedAt: z.string().datetime(),
}).strict();

export const FireflyReviewDecisionV2Schema = z.object({
  schemaVersion: z.literal("firefly_review_decision/v2"),
  decisionId: z.string().min(1),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  workId: z.string().min(1),
  artifactId: z.string().min(1),
  candidateId: z.string().regex(/^candidate-[A-Z]$/u),
  candidateSha256: Sha256Schema,
  decision: z.enum(["approve", "polish", "hold", "reject"]),
  comment: z.string().max(2_000),
  surfaceClassifications: z.array(FireflySurfaceClassificationReceiptSchema),
  status: z.enum(["pending", "applied", "superseded", "failed"]),
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable().optional(),
  applyReceiptPath: z.string().nullable().optional(),
}).strict();
export type FireflyReviewDecisionV2 = z.infer<typeof FireflyReviewDecisionV2Schema>;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function utf8Slice(value: string, startByte: number, endByte: number, label: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (endByte <= startByte || endByte > bytes.byteLength) throw new Error(`${label} byte range is invalid.`);
  const slice = bytes.slice(startByte, endByte);
  try { new TextDecoder("utf-8", { fatal: true }).decode(slice); }
  catch { throw new Error(`${label} does not align to UTF-8 boundaries.`); }
  return slice;
}

function assertCandidateSpan(span: z.infer<typeof CandidateSpanSchema>, body: string, label: string): void {
  if (sha256(utf8Slice(body, span.startByte, span.endByte, label)) !== span.sliceSha256) {
    throw new Error(`${label} slice SHA-256 mismatch.`);
  }
}

function selectorBody(match: FireflySurfaceMatchV2) {
  return {
    provenanceBridgeReceiptSha256: match.provenanceBridgeReceiptSha256,
    matchMethod: match.matchMethod,
    candidate: match.candidate,
    source: match.source,
  };
}

export function fireflyApplicationBindingSha256(input: {
  readonly bookId: string;
  readonly artifactId: string;
  readonly candidateId: string;
  readonly candidateSha256: string;
}): string {
  return sha256(JSON.stringify({
    bookId: input.bookId,
    artifactId: input.artifactId,
    candidateId: input.candidateId,
    candidateSha256: input.candidateSha256,
  }));
}

export function assertFireflyReviewPacketV2Identity(packet: FireflyReviewPacketV2): void {
  const { schemaVersion: _schemaVersion, packetId, packetSha256, generatedAt: _generatedAt, ...body } = packet;
  const actual = sha256(JSON.stringify(body));
  if (actual !== packetSha256 || packetId !== `frp-${actual.slice(0, 24)}`) {
    throw new Error("Firefly review packet v2 identity or SHA-256 mismatch.");
  }
  if (sha256(packet.artifact.currentContent) !== packet.artifact.currentContentSha256) {
    throw new Error("Firefly review packet v2 current manuscript SHA-256 mismatch.");
  }
  if (packet.candidates[0].id === packet.candidates[1].id) throw new Error("Blind candidate labels must be unique.");
  const seenMatches = new Set<string>();
  for (const candidate of packet.candidates) {
    if (sha256(candidate.body) !== candidate.sha256) throw new Error(`Blind candidate ${candidate.id} body SHA-256 mismatch.`);
    if (scoreCommercialEvaluation(candidate.commercialEvaluation as CommercialEvaluation) !== candidate.commercialScore) {
      throw new Error(`Blind candidate ${candidate.id} commercial score does not match dopamine70-reference30-v1.`);
    }
    if (candidate.review.contentNeutrality.passed !== (candidate.review.contentNeutrality.violations.length === 0)) {
      throw new Error(`Blind candidate ${candidate.id} content-neutrality flag contradicts its violations.`);
    }
    for (const span of candidate.review.emotionalCoherence.evidence) assertCandidateSpan(span, candidate.body, "emotional coherence evidence");
    for (const violation of candidate.review.contentNeutrality.violations) {
      for (const span of violation.evidence) assertCandidateSpan(span, candidate.body, "content-neutrality evidence");
    }
    for (const contradiction of candidate.review.canonContradictions) {
      for (const span of contradiction.evidence) assertCandidateSpan(span, candidate.body, "canon contradiction evidence");
    }
    for (const match of candidate.review.surfaceComparison.surfaceMatches) {
      if (seenMatches.has(match.matchId)) throw new Error("Surface match IDs must be unique inside a review packet.");
      seenMatches.add(match.matchId);
      if (match.candidate.candidateContentSha256 !== candidate.sha256) throw new Error("Surface match candidate SHA-256 drifted.");
      const candidateBytes = utf8Slice(candidate.body, match.candidate.startByte, match.candidate.endByte, "surface candidate selector");
      if (sha256(candidateBytes) !== match.candidate.candidateSliceSha256) throw new Error("Surface candidate slice SHA-256 mismatch.");
      if (match.source.endByte <= match.source.startByte || match.source.endByte - match.source.startByte > 32_768) {
        throw new Error("Surface source selector range is invalid.");
      }
      const selectorSha = sha256(JSON.stringify(selectorBody(match)));
      if (selectorSha !== match.selectorSha256 || match.matchId !== `fsm-${selectorSha.slice(0, 24)}`) {
        throw new Error("Surface selector identity or SHA-256 mismatch.");
      }
    }
  }
  for (const values of [
    packet.sealedGenerationEvidence.candidateEvidenceReceiptSha256s,
    packet.sealedGenerationEvidence.contentNeutralReceiptSha256s,
  ]) {
    if (values[0] >= values[1]) throw new Error("Sealed generation evidence must contain two unique sorted SHA-256 values.");
  }
}

export function buildFireflyReviewPacketV2(input: { readonly generatedAt?: string; readonly body: unknown }): FireflyReviewPacketV2 {
  const body = FireflyReviewPacketV2BodySchema.parse(input.body);
  const packetSha256 = sha256(JSON.stringify(body));
  const packet = FireflyReviewPacketV2Schema.parse({
    schemaVersion: "firefly_review_packet/v2",
    packetId: `frp-${packetSha256.slice(0, 24)}`,
    packetSha256,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    ...body,
  });
  assertFireflyReviewPacketV2Identity(packet);
  return packet;
}

export function resolveFireflyReviewCandidateV2(
  packet: FireflyReviewPacketV2,
  publicCandidate: FireflyReviewCandidateV2,
  views: ReadonlyArray<ReferenceTransformationHilCandidateView>,
): ReferenceTransformationHilCandidateView {
  const matches = views.filter((view) => view.candidate.chapterNumber === packet.artifact.chapterNumber
    && view.candidate.candidateContentSha256 === publicCandidate.sha256
    && fireflyApplicationBindingSha256({
      bookId: packet.work.id,
      artifactId: packet.artifact.id,
      candidateId: view.candidate.candidateId,
      candidateSha256: view.candidate.candidateContentSha256,
    }) === publicCandidate.applicationBindingSha256);
  if (matches.length !== 1) throw new Error("Blind review application binding did not resolve exactly one InkOS candidate.");
  const [view] = matches;
  if (!view || view.candidate.status !== "prepared" || !view.currentChapterMatchesPreparation
    || view.candidate.currentContentSha256 !== packet.artifact.currentContentSha256
    || view.candidateContent !== publicCandidate.body) {
    throw new Error("Blind review candidate no longer matches the canonical InkOS HIL state.");
  }
  return view;
}

export function assertFireflyReviewDecisionV2MatchesPacket(
  decision: FireflyReviewDecisionV2,
  packet: FireflyReviewPacketV2,
): void {
  if (decision.packetId !== packet.packetId || decision.packetSha256 !== packet.packetSha256
    || decision.workId !== packet.work.id || decision.artifactId !== packet.artifact.id) {
    throw new Error("Storyyard v2 decision does not match the review packet identity.");
  }
  const candidate = packet.candidates.find((item) => item.id === decision.candidateId);
  if (!candidate || candidate.sha256 !== decision.candidateSha256) throw new Error("Storyyard v2 decision candidate does not match the packet.");
  const matches = packet.candidates.flatMap((item) => item.review.surfaceComparison.surfaceMatches);
  if (decision.surfaceClassifications.length !== matches.length) throw new Error("Storyyard v2 decision must classify every surface match.");
  const receipts = new Map(decision.surfaceClassifications.map((receipt) => [receipt.matchId, receipt]));
  if (receipts.size !== matches.length || matches.some((match) => receipts.get(match.matchId)?.selectorSha256 !== match.selectorSha256)) {
    throw new Error("Storyyard v2 surface classifications do not match the packet selectors.");
  }
  if (decision.decision === "approve" && decision.surfaceClassifications.some((receipt) => receipt.classification === "canon-leak")) {
    throw new Error("A candidate classified with canon-leak cannot be approved.");
  }
}
