import { z } from "zod";
import { sourceFactRepairHash, sourceFactRepairJson } from "./source-fact-repair.js";
import { PITCH_VARIATION_PLANNING_GUIDANCE_VERSION, PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2, requiresFullVariationPlan, VariationProjectPlanSchema, WebnovelProjectPlanSchema, renderVariationProjectPlan } from "./webnovel-plan-format.js";
export { PITCH_VARIATION_PLANNING_GUIDANCE_VERSION, PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2, requiresFullVariationPlan, VariationProjectPlanSchema, WebnovelProjectPlanSchema, validateVariationProjectPlan, renderVariationProjectPlan, WEBNOVEL_PLAN_SECTIONS_V1 } from "./webnovel-plan-format.js";
export type { VariationProjectPlan } from "./webnovel-plan-format.js";

const text = z.string().trim().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
const variantId = z.string().regex(/^v\d{2}$/u);
export const variationHash = (value: unknown): string => sourceFactRepairHash(sourceFactRepairJson(value));
const boundBaselineProjectPlan = WebnovelProjectPlanSchema.extend({
  // Source text is hash-bound: validate its size without trimming its bytes.
  markdown: z.string().refine((value) => value.trim().length >= 600 && value.trim().length <= 30_000, "Baseline project plan must contain 600-30000 characters"),
});

export const VariationScopeSchema = z.object({
  episodeStart: z.literal(1), episodeEnd: z.literal(4), through: text,
}).strict();
export const VariationBaselineSchema = z.object({
  slateId: id, candidateId: text, candidateSha256: sha, planSha256: sha, title: text,
}).strict();

/** Actual source observations, kept separate from the newly designed events. */
export const VariationSourceEventSchema = z.object({
  eventId: id, role: z.enum(["main", "donor"]), workTitle: text,
  sourcePath: text, sourceSha256: sha, startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  chapterRange: text, actualEvent: text, privateGoal: text, interventionReason: text,
  advantageUse: text, personalGain: text, readerPleasure: text, nextGoal: text,
  prerequisites: text, transferUse: text, doNotTransfer: text,
}).strict().refine((event) => event.endLine >= event.startLine, "Invalid source line range");
export const BoundVariationSourceSchema = z.object({
  event: VariationSourceEventSchema, excerpt: z.string().min(1), excerptSha256: sha,
}).strict().refine((source) => sourceFactRepairHash(source.excerpt) === source.excerptSha256, "Source excerpt SHA mismatch");

export const PitchVariationRequestSchema = z.object({
  schemaVersion: z.literal("pitch-variation-request/v1"), slateId: id,
  // No default: omitting this marker preserves legacy request and prompt bytes.
  planningGuidanceVersion: z.enum([PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION]).optional(),
  baseline: VariationBaselineSchema, baselinePath: text, baselineContext: text,
  baselineProjectPlan: boundBaselineProjectPlan.optional(),
  scope: VariationScopeSchema, genre: z.literal("modern-fantasy-ko"), targetChapters: z.number().int().positive(),
  instruction: text, directions: z.array(text).min(2).max(3),
  directionSourceEventIds: z.array(z.array(id).min(2).max(8)).min(2).max(3).optional(),
  sources: z.array(BoundVariationSourceSchema).min(2).max(8),
}).strict().superRefine((request, context) => {
  if (requiresFullVariationPlan(request.planningGuidanceVersion) && !request.baselineProjectPlan) {
    context.addIssue({ code: "custom", path: ["baselineProjectPlan"], message: "Variation guidance v2 requires the bound full baseline project plan" });
  }
  if (request.baselineProjectPlan && sourceFactRepairHash(request.baselineProjectPlan.markdown) !== request.baseline.planSha256) {
    context.addIssue({ code: "custom", path: ["baselineProjectPlan"], message: "Baseline project plan SHA mismatch" });
  }
  const ids = request.sources.map((source) => source.event.eventId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate source event IDs" });
  if (!["main", "donor"].every((role) => request.sources.some((source) => source.event.role === role))) {
    context.addIssue({ code: "custom", message: "Both main and donor source events are required" });
  }
  if (request.directionSourceEventIds && (request.directionSourceEventIds.length !== request.directions.length
    || request.directionSourceEventIds.some((group) => new Set(group).size !== group.length || group.some((eventId) => !ids.includes(eventId))
      || !["main", "donor"].every((role) => group.some((eventId) => request.sources.find((source) => source.event.eventId === eventId)?.event.role === role))))) {
    context.addIssue({ code: "custom", message: "Each direction must bind its own main and donor source IDs" });
  }
});
export type PitchVariationRequest = z.infer<typeof PitchVariationRequestSchema>;

const functionSchema = z.object({
  personalGoal: text, interventionReason: text, advantageUse: text,
  personalGain: text, readerPleasure: text, nextGoal: text,
}).strict();
export const PitchVariationCandidateSchema = z.object({
  candidateId: variantId, title: text, variationIntent: text, sourceEventIds: z.array(id).min(2).max(8),
  projectPlan: VariationProjectPlanSchema.optional(),
  synopsis: text.min(400).max(5000),
  eventComparisons: z.array(z.object({
    baselineEvent: text, retainedFunction: functionSchema, donorEventIds: z.array(id).min(1),
    redesignedEvent: text, prerequisiteChanges: text, downstreamConnection: text,
  }).strict()).min(2).max(5),
  openingEpisodes: z.array(z.object({
    episode: z.number().int().min(1).max(4), goal: text, action: text, gainOrProgress: text, endingPull: text,
  }).strict()).length(4),
  firstInvestment: z.object({
    item: text, informationEdge: text, capitalAndExecution: text, sequence: text,
    realizedReturn: text, nextUse: text,
  }).strict(),
  chronologyChanges: text, remainingQuestions: text,
}).strict().superRefine((candidate, context) => {
  if (!candidate.openingEpisodes.every((episode, index) => episode.episode === index + 1)) {
    context.addIssue({ code: "custom", message: "Opening episodes must be ordered 1 through 4" });
  }
  const ids = new Set(candidate.sourceEventIds);
  if (ids.size !== candidate.sourceEventIds.length) context.addIssue({ code: "custom", message: "Duplicate candidate source IDs" });
  if (candidate.eventComparisons.some((event) => event.donorEventIds.some((eventId) => !ids.has(eventId)))) {
    context.addIssue({ code: "custom", message: "Comparison source is absent from candidate source IDs" });
  }
});
export type PitchVariationCandidate = z.infer<typeof PitchVariationCandidateSchema>;

export function validateVariationAgainstRequest(candidate: PitchVariationCandidate, request: PitchVariationRequest): void {
  if (requiresFullVariationPlan(request.planningGuidanceVersion)) {
    PitchVariationRequestSchema.parse(request);
    if (!candidate.projectPlan) throw new Error("Variation guidance v2 requires the full nine-section projectPlan");
    VariationProjectPlanSchema.parse(candidate.projectPlan);
  } else if (candidate.projectPlan !== undefined) {
    throw new Error("Variation projectPlan requires explicit guidance v2");
  }
  const sources = new Map(request.sources.map((source) => [source.event.eventId, source.event]));
  const direction = request.directionSourceEventIds?.[Number(candidate.candidateId.slice(1)) - 1];
  if (request.directionSourceEventIds && (!direction || candidate.sourceEventIds.some((eventId) => !direction.includes(eventId)))) throw new Error("Candidate used an event outside its assigned direction");
  if (candidate.sourceEventIds.some((eventId) => !sources.has(eventId))) throw new Error("Candidate invented a source event ID");
  if (!candidate.sourceEventIds.some((eventId) => sources.get(eventId)?.role === "main")) throw new Error("Candidate omitted the main source");
  if (candidate.eventComparisons.some((event) => !event.donorEventIds.some((eventId) => sources.get(eventId)?.role === "donor"))) {
    throw new Error("Each changed event requires an actual donor source");
  }
}

const check = z.object({ passed: z.boolean(), evidence: text }).strict();
export const VariationIndependentReviewSchema = z.object({
  verdict: z.enum(["ready", "revise", "reject"]),
  sourceAccuracy: check, selfInterest: check, causalCoherence: check, variationQuality: check,
  readingPleasure: z.object({ assessment: text, evidence: text }).strict(), requiredRepair: text,
}).strict().superRefine((review, context) => {
  if (review.verdict === "ready" && [review.sourceAccuracy, review.selfInterest, review.causalCoherence, review.variationQuality].some((item) => !item.passed)) {
    context.addIssue({ code: "custom", message: "Failed checks cannot receive a ready verdict" });
  }
});
export const PitchVariationReviewSchema = z.object({
  requestSha256: sha, candidatesSha256: sha,
  verdicts: z.array(z.object({ candidateId: variantId, review: VariationIndependentReviewSchema }).strict()).min(2).max(3),
  recommendation: z.object({ candidateId: variantId, reason: text }).strict().nullable(),
}).strict();
export type PitchVariationReview = z.infer<typeof PitchVariationReviewSchema>;

export function validateVariationReview(review: PitchVariationReview, request: PitchVariationRequest, candidates: PitchVariationCandidate[]): void {
  if (review.requestSha256 !== variationHash(request) || review.candidatesSha256 !== variationHash(candidates)) throw new Error("Review input binding mismatch");
  for (const candidate of candidates) validateVariationAgainstRequest(candidate, request);
  const ids = candidates.map((candidate) => candidate.candidateId).sort();
  if (JSON.stringify(ids) !== JSON.stringify(review.verdicts.map((verdict) => verdict.candidateId).sort())) throw new Error("Review must assess every candidate exactly once");
  if (review.recommendation && !review.verdicts.some((verdict) => verdict.candidateId === review.recommendation?.candidateId && verdict.review.verdict === "ready")) {
    throw new Error("Recommendation must identify a ready candidate");
  }
}

export function renderPitchVariation(candidate: PitchVariationCandidate, request: PitchVariationRequest): string {
  validateVariationAgainstRequest(candidate, request);
  if (requiresFullVariationPlan(request.planningGuidanceVersion)) return renderVariationProjectPlan(candidate.projectPlan!);
  const rows = candidate.eventComparisons.flatMap((event, index) => [
    `### ${index + 1}. ${event.baselineEvent}`, "", `**새 사건:** ${event.redesignedEvent}`, "",
    `- 자기 목적: ${event.retainedFunction.personalGoal}`,
    `- 개입 이유: ${event.retainedFunction.interventionReason}`,
    `- 우위 사용: ${event.retainedFunction.advantageUse}`,
    `- 자기 몫: ${event.retainedFunction.personalGain}`,
    `- 읽는 재미: ${event.retainedFunction.readerPleasure}`,
    `- 다음 목적: ${event.retainedFunction.nextGoal}`,
    `- 가져온 사건: ${event.donorEventIds.join(", ")}`,
    `- 바뀌는 선행 조건: ${event.prerequisiteChanges}`,
    `- 후속 연결: ${event.downstreamConnection}`, "",
  ]);
  const investment = candidate.firstInvestment;
  return [
    `# ${candidate.title}`, "", candidate.variationIntent, "",
    "## 초반 이야기", "", candidate.synopsis, "", "## 사건을 어떻게 바꾸는가", "", ...rows,
    "## 도입 4화", "", ...candidate.openingEpisodes.flatMap((episode) => [
      `### ${episode.episode}화`, "", `목적: ${episode.goal}`, "", episode.action, "",
      `얻는 것·진행: ${episode.gainOrProgress}`, "", `다음 기대: ${episode.endingPull}`, "",
    ]),
    "## 첫 투자와 회수", "", `- 대상: ${investment.item}`, `- 정보 우위: ${investment.informationEdge}`,
    `- 자금·실행: ${investment.capitalAndExecution}`, `- 사건 순서: ${investment.sequence}`,
    `- 실제 회수: ${investment.realizedReturn}`, `- 다음 사용: ${investment.nextUse}`, "",
    "## 배치와 남은 판단", "", candidate.chronologyChanges, "", candidate.remainingQuestions, "",
    "## 실제 원문 근거", "", ...request.sources.filter((source) => candidate.sourceEventIds.includes(source.event.eventId)).map(({ event }) =>
      `- ${event.eventId} · 《${event.workTitle}》 ${event.chapterRange}, ${event.startLine}~${event.endLine}행: ${event.actualEvent}`), "",
  ].join("\n");
}

export const FireflyVariationReviewCandidateV5Schema = z.object({
  id: variantId, title: text, markdown: text.min(600).max(35_000), sha256: sha,
  preparedAt: z.string().datetime(), sourceEventIds: z.array(id).min(2).max(8),
  independentReview: VariationIndependentReviewSchema,
}).strict().superRefine((candidate, context) => {
  const { sha256, ...unsigned } = candidate;
  if (variationHash(unsigned) !== sha256) context.addIssue({ code: "custom", message: "Variation candidate SHA mismatch" });
});

export const FireflyVariationReviewPacketV5Schema = z.object({
  schemaVersion: z.literal("firefly_review_packet/v5"), packetId: z.string().regex(/^frp-[a-f0-9]{24}$/u), packetSha256: sha,
  generatedAt: z.string().datetime(), purpose: z.literal("planning-variation"),
  source: z.object({ system: z.literal("inkos"), slateId: id, sourceRevision: sha }).strict(),
  work: z.object({ id, title: text, genre: text, status: z.literal("non-canonical"), targetChapters: z.number().int().positive() }).strict(),
  artifact: z.object({ id, kind: z.literal("pitch-variation-slate"), title: text, status: z.literal("human-decision-pending") }).strict(),
  baseline: VariationBaselineSchema, scope: VariationScopeSchema,
  candidates: z.array(FireflyVariationReviewCandidateV5Schema).min(2).max(3),
  recommendation: z.object({ candidateId: variantId, reason: text }).strict().nullable(),
  actions: z.tuple([z.literal("select"), z.literal("hold"), z.literal("reject")]),
  authority: z.object({ canon: z.literal("inkos"), decisionSurface: z.literal("storyyard"), decisionEffect: z.literal("variation-selection"), bookCreation: z.literal(false), manuscriptApply: z.literal(false), reverseSync: z.literal(false) }).strict(),
}).strict().superRefine((packet, context) => {
  if (packet.work.id !== packet.source.slateId || packet.artifact.id !== packet.source.slateId) context.addIssue({ code: "custom", message: "Variation slate identity mismatch" });
  if (new Set(packet.candidates.map((candidate) => candidate.id)).size !== packet.candidates.length) context.addIssue({ code: "custom", message: "Duplicate variation candidates" });
  if (packet.recommendation && !packet.candidates.some((candidate) => candidate.id === packet.recommendation?.candidateId && candidate.independentReview.verdict === "ready")) context.addIssue({ code: "custom", message: "Recommended variation must be ready" });
  const { schemaVersion: _version, packetId, packetSha256, ...unsigned } = packet;
  const actual = variationHash(unsigned);
  if (packetSha256 !== actual || packetId !== `frp-${actual.slice(0, 24)}`) context.addIssue({ code: "custom", message: "Variation packet identity mismatch" });
});
export type FireflyVariationReviewPacketV5 = z.infer<typeof FireflyVariationReviewPacketV5Schema>;

export function buildVariationReviewPacket(request: PitchVariationRequest, candidates: PitchVariationCandidate[], review: PitchVariationReview, generatedAt: string): FireflyVariationReviewPacketV5 {
  validateVariationReview(review, request, candidates);
  const unsigned = {
    generatedAt, purpose: "planning-variation" as const,
    source: { system: "inkos" as const, slateId: request.slateId, sourceRevision: variationHash({ request, candidates, review }) },
    work: { id: request.slateId, title: request.baseline.title, genre: request.genre, status: "non-canonical" as const, targetChapters: request.targetChapters },
    artifact: { id: request.slateId, kind: "pitch-variation-slate" as const, title: "초반 사건 변주 비교", status: "human-decision-pending" as const },
    baseline: request.baseline, scope: request.scope,
    candidates: candidates.map((candidate) => {
      const value = { id: candidate.candidateId, title: candidate.title, markdown: renderPitchVariation(candidate, request).trim(), preparedAt: generatedAt, sourceEventIds: candidate.sourceEventIds, independentReview: review.verdicts.find((verdict) => verdict.candidateId === candidate.candidateId)!.review };
      return { ...value, sha256: variationHash(value) };
    }),
    recommendation: review.recommendation, actions: ["select", "hold", "reject"] as const,
    authority: { canon: "inkos" as const, decisionSurface: "storyyard" as const, decisionEffect: "variation-selection" as const, bookCreation: false as const, manuscriptApply: false as const, reverseSync: false as const },
  };
  const packetSha256 = variationHash(unsigned);
  return FireflyVariationReviewPacketV5Schema.parse({ schemaVersion: "firefly_review_packet/v5", packetId: `frp-${packetSha256.slice(0, 24)}`, packetSha256, ...unsigned });
}
