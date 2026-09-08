import { createHash } from "node:crypto";
import { z } from "zod";
import { FireflyRuntimeModelSchema } from "../production/model-policy.js";
import { hashCanonicalJson } from "../storyyard/pitch-review-packet.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CandidateIdSchema = z.string().regex(/^p\d{2}$/u);

export const FireflyPitchSourceBindingSchema = z.object({
  schemaVersion: z.literal("firefly_pitch_source_binding/v1"),
  packId: z.string().min(1),
  packSha256: Sha256Schema,
  sourceSha256: Sha256Schema,
  sourceWork: z.object({
    workSlug: z.string().trim().min(1),
    workTitle: z.string().trim().min(1),
  }).strict().optional(),
  storyIndex: z.object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    selected: z.array(z.object({
      sequence: z.number().int().positive(),
      arcId: z.string().min(1),
      sourceLineRange: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict(),
      sourceCharacterRange: z.object({ start: z.number().int().min(0), end: z.number().int().positive() }).strict(),
      rawProseSha256: Sha256Schema,
    }).strict().superRefine((item, itemContext) => {
      if (item.sourceLineRange.end < item.sourceLineRange.start || item.sourceCharacterRange.end <= item.sourceCharacterRange.start) {
        itemContext.addIssue({ code: z.ZodIssueCode.custom, message: "source ranges must be increasing" });
      }
    })).min(1),
  }).strict(),
  styleExamples: z.object({
    path: z.string().min(1),
    sha256: Sha256Schema,
    selected: z.array(z.object({
      id: z.string().min(1),
      sequence: z.number().int().positive(),
      arcId: z.string().min(1),
      rawProseSha256: Sha256Schema,
    }).strict()).min(1),
  }).strict(),
  structureInputs: z.array(z.object({
    role: z.enum(["project-bible", "chapter-map", "arc-atlas"]),
    path: z.string().min(1),
    sha256: Sha256Schema,
  }).strict()).length(3),
}).strict().superRefine((binding, context) => {
  if (new Set(binding.storyIndex.selected.map((item) => item.sequence)).size !== binding.storyIndex.selected.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "selected story sequences must be unique" });
  }
  if (new Set(binding.styleExamples.selected.map((item) => item.id)).size !== binding.styleExamples.selected.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "selected style example IDs must be unique" });
  }
  if (new Set(binding.structureInputs.map((item) => item.role)).size !== 3) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "all three structure roles are required exactly once" });
  }
});

export const FireflyPitchRuntimeReceiptSchema = z.object({
  schemaVersion: z.literal("firefly_pitch_runtime/v1"),
  provider: z.literal("codex-cli"),
  model: FireflyRuntimeModelSchema,
  reasoning: z.literal("high"),
  soul: z.object({
    mode: z.literal("canary-scoped"),
    soulId: z.literal("male-modern-fantasy-ko"),
    version: z.literal("v1"),
    manifestSha256: Sha256Schema,
    promptSha256: Sha256Schema,
    resourceSha256: Sha256Schema,
  }).strict(),
}).strict();

export const FireflyHumanPremiseSchema = z.object({
  protagonistAsPerson: z.string().trim().min(12),
  privateWant: z.string().trim().min(8),
  feltLack: z.string().trim().min(8),
  targetPerson: z.string().trim().min(2),
  whyToday: z.string().trim().min(8),
  firstChoice: z.string().trim().min(8),
  emotionalPayment: z.string().trim().min(8),
  stillHumanWithoutPower: z.string().trim().min(12),
}).strict();

export const FireflyHumanPremiseCandidateBaseSchema = z.object({
  candidateId: CandidateIdSchema,
  sha256: Sha256Schema,
  titleCandidates: z.array(z.string().trim().min(1)).min(1).max(3),
  oneLineHumanPromise: z.string().trim().min(12),
  humanPremise: FireflyHumanPremiseSchema,
  firstScene: z.object({
    currentSituation: z.string().trim().min(8),
    pressure: z.string().trim().min(8),
    action: z.string().trim().min(8),
    witnessedChange: z.string().trim().min(8),
  }).strict(),
  sourceBeatSequences: z.array(z.number().int().positive()).min(1),
  styleExampleIds: z.array(z.string().min(1)).min(1),
  retainedReferenceTraits: z.array(z.string().trim().min(2)).min(2).max(8),
  surfaceVariation: z.string().trim().min(8),
}).strict();

export const FireflyHumanPremiseCandidateSchema = FireflyHumanPremiseCandidateBaseSchema.superRefine((candidate, context) => {
  const unsigned = { ...candidate } as Record<string, unknown>;
  delete unsigned.sha256;
  if (hashCanonicalJson(unsigned) !== candidate.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "human premise candidate SHA-256 mismatch" });
  }
});

export const FireflyHumanPremiseSlateSchema = z.object({
  schemaVersion: z.literal("firefly_human_premise_slate/v1"),
  slateId: z.string().min(1),
  canonStatus: z.literal("non-canonical"),
  reviewStatus: z.literal("pending"),
  genre: z.literal("modern-fantasy-ko"),
  instruction: z.string().min(1),
  instructionSha256: Sha256Schema,
  sourceBinding: FireflyPitchSourceBindingSchema,
  runtimeReceipt: FireflyPitchRuntimeReceiptSchema,
  generatedAt: z.string().datetime(),
  candidates: z.array(FireflyHumanPremiseCandidateSchema).min(1).max(6),
}).strict().superRefine((slate, context) => {
  if (createHash("sha256").update(slate.instruction).digest("hex") !== slate.instructionSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "instruction SHA-256 mismatch" });
  }
  if (new Set(slate.candidates.map((candidate) => candidate.candidateId)).size !== slate.candidates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate IDs must be unique" });
  }
  const sourceSequences = new Set(slate.sourceBinding.storyIndex.selected.map((item) => item.sequence));
  const styleIds = new Set(slate.sourceBinding.styleExamples.selected.map((item) => item.id));
  for (const candidate of slate.candidates) {
    if (candidate.sourceBeatSequences.some((sequence) => !sourceSequences.has(sequence))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${candidate.candidateId} cites an unbound source beat` });
    }
    if (candidate.styleExampleIds.some((id) => !styleIds.has(id))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${candidate.candidateId} cites an unbound style example` });
    }
  }
});

const HumanGroundingGatesSchema = z.object({
  humanDesire: z.boolean(),
  sourceGrounded: z.boolean(),
  sceneableToday: z.boolean(),
  nonMechanical: z.boolean(),
  voiceGrounded: z.boolean(),
}).strict();

export const FireflyHumanPremiseReviewSchema = z.object({
  schemaVersion: z.literal("firefly_human_premise_review/v1"),
  reviewKind: z.literal("independent-human-grounding"),
  slateId: z.string().min(1),
  sourceSlateSha256: Sha256Schema,
  reviewerRuntimeReceipt: FireflyPitchRuntimeReceiptSchema,
  reviewedAt: z.string().datetime(),
  winnerCandidateId: CandidateIdSchema.nullable(),
  ranking: z.array(CandidateIdSchema).min(1),
  verdicts: z.array(z.object({
    candidateId: CandidateIdSchema,
    verdict: z.enum(["SURVIVE", "HOLD", "KILL"]),
    gates: HumanGroundingGatesSchema,
    decisiveStrength: z.string().trim().min(1),
    decisiveRisk: z.string().trim().min(1),
    requiredRepair: z.string().trim().min(1),
  }).strict()).min(1),
  comparisonReason: z.string().trim().min(1),
  humanDecision: z.literal("pending"),
}).strict().superRefine((review, context) => {
  const ranking = new Set(review.ranking);
  const verdictIds = new Set(review.verdicts.map((item) => item.candidateId));
  if (ranking.size !== review.ranking.length || verdictIds.size !== review.verdicts.length
    || ranking.size !== verdictIds.size || [...ranking].some((id) => !verdictIds.has(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "ranking and verdicts must contain the same unique candidates" });
  }
  const survivors = review.verdicts.filter((item) => item.verdict === "SURVIVE");
  if (survivors.length > 1 || (survivors[0]?.candidateId ?? null) !== review.winnerCandidateId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "winner must match the sole SURVIVE candidate" });
  }
  for (const item of review.verdicts) {
    const passed = Object.values(item.gates).every(Boolean);
    if (!passed && item.verdict === "SURVIVE") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${item.candidateId} cannot SURVIVE a failed grounding gate` });
    }
  }
});

export const FireflyHumanPremiseDecisionSchema = z.object({
  schemaVersion: z.literal("firefly_human_premise_decision/v1"),
  decisionId: z.string().regex(/^hpd-[0-9a-f]{24}$/u),
  slateId: z.string().min(1),
  candidateId: CandidateIdSchema,
  candidateSha256: Sha256Schema,
  decision: z.enum(["select", "hold", "reject"]),
  comment: z.string().max(2_000),
  decidedAt: z.string().datetime(),
  sourceSlateSha256: Sha256Schema,
  sourceReviewSha256: Sha256Schema,
  canonEffect: z.enum(["commercial-expansion-authorized", "none"]),
  manuscriptAuthorized: z.literal(false),
}).strict().superRefine((decision, context) => {
  if ((decision.decision === "select") !== (decision.canonEffect === "commercial-expansion-authorized")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "decision and canon effect disagree" });
  }
  if (decision.decision !== "select" && decision.comment.trim().length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "hold or reject requires a comment" });
  }
});

export type FireflyPitchSourceBinding = z.infer<typeof FireflyPitchSourceBindingSchema>;
export type FireflyPitchRuntimeReceipt = z.infer<typeof FireflyPitchRuntimeReceiptSchema>;
export type FireflyHumanPremiseCandidate = z.infer<typeof FireflyHumanPremiseCandidateSchema>;
export type FireflyHumanPremiseSlate = z.infer<typeof FireflyHumanPremiseSlateSchema>;
export type FireflyHumanPremiseReview = z.infer<typeof FireflyHumanPremiseReviewSchema>;
export type FireflyHumanPremiseDecision = z.infer<typeof FireflyHumanPremiseDecisionSchema>;
