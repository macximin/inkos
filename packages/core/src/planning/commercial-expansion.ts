import { createHash } from "node:crypto";
import { z } from "zod";
import { FireflyEntryContractSchema } from "./entry-contract.js";
import {
  FireflyHumanPremiseSchema,
  FireflyPitchRuntimeReceiptSchema,
  FireflyPitchSourceBindingSchema,
} from "./human-premise.js";
import { FireflySpineRetentionContractSchema } from "./spine-retention.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const TextSchema = z.string().trim().min(1);
const ScoreSchema = z.object({
  promise: z.number().int().min(0).max(20),
  earlyPayoff: z.number().int().min(0).max(20),
  repeatEngine: z.number().int().min(0).max(20),
  railConversion: z.number().int().min(0).max(20),
  longRunSupply: z.number().int().min(0).max(20),
  total: z.number().int().min(0).max(100),
}).strict().superRefine((score, context) => {
  if (score.total !== score.promise + score.earlyPayoff + score.repeatEngine + score.railConversion + score.longRunSupply) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "commercial score total must equal its components" });
  }
});

export const FireflyPremiseExpansionBindingSchema = z.object({
  premiseSlateId: z.string().min(1),
  premiseCandidateId: z.string().regex(/^p\d{2}$/u),
  premiseCandidateSha256: Sha256Schema,
  premiseDecisionId: z.string().regex(/^hpd-[0-9a-f]{24}$/u),
  premiseDecisionSha256: Sha256Schema,
  sourcePremiseSlateSha256: Sha256Schema,
  sourcePremiseReviewSha256: Sha256Schema,
}).strict();

export const FireflyCommercialExpansionCandidateSchema = z.object({
  candidateId: z.literal("p01"),
  titleCandidates: z.array(TextSchema).min(1).max(3),
  oneLinePromise: TextSchema,
  primaryReference: TextSchema,
  preservedSkeleton: z.array(TextSchema).min(4),
  surfaceVariation: TextSchema,
  linkedCausalAdjustments: z.array(TextSchema).min(1),
  humanPremise: FireflyHumanPremiseSchema,
  spineRetention: FireflySpineRetentionContractSchema,
  protagonist: z.object({
    startingIdentity: TextSchema,
    repeatedVerb: TextSchema,
    firstAsset: TextSchema,
  }).strict(),
  entryContract: FireflyEntryContractSchema,
  openingEpisodes: z.array(z.object({
    episode: z.number().int().min(1).max(4),
    event: TextSchema,
    visiblePayoff: TextSchema,
  }).strict()).length(4),
  firstReward: TextSchema,
  railA: z.array(TextSchema).min(3),
  railB: z.array(TextSchema).min(3),
  arcLadder: z.array(z.object({
    arc: z.number().int().positive(),
    externalMove: TextSchema,
    visibleReward: TextSchema,
    relationshipConversion: TextSchema,
  }).strict()).min(6),
  supportingReferenceRoutes: z.array(z.object({
    reference: TextSchema,
    role: TextSchema,
    targetArc: TextSchema,
  }).strict()).min(1),
  longRunRisk: TextSchema,
  commercialScore: ScoreSchema,
  decision: z.literal("pending"),
}).strict().superRefine((candidate, context) => {
  if (!candidate.openingEpisodes.every((item, index) => item.episode === index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "opening episodes must be ordered 1 through 4" });
  }
  if (!candidate.arcLadder.every((item, index) => item.arc === index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Arc ladder must be ordered from 1" });
  }
});

export const FireflyCommercialExpansionSlateSchema = z.object({
  schemaVersion: z.literal(2),
  slateId: z.string().min(1),
  canonStatus: z.literal("non-canonical"),
  reviewStatus: z.literal("pending"),
  candidateCount: z.literal(1),
  genre: z.literal("modern-fantasy-ko"),
  targetChapters: z.number().int().min(20).max(2_000),
  instruction: z.string().min(1),
  instructionSha256: Sha256Schema,
  sourcePremiseBinding: FireflyPremiseExpansionBindingSchema,
  sourceBinding: FireflyPitchSourceBindingSchema,
  runtimeReceipt: FireflyPitchRuntimeReceiptSchema,
  generatedAt: z.string().datetime(),
  candidates: z.array(FireflyCommercialExpansionCandidateSchema).length(1),
}).strict().superRefine((slate, context) => {
  if (createHash("sha256").update(slate.instruction).digest("hex") !== slate.instructionSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "instruction SHA-256 mismatch" });
  }
  const candidate = slate.candidates[0];
  if (!candidate) return;
  const contract = candidate.spineRetention;
  if (contract.primaryReference.packId !== slate.sourceBinding.packId
    || contract.primaryReference.packSha256 !== slate.sourceBinding.packSha256
    || contract.primaryReference.sourceSha256 !== slate.sourceBinding.sourceSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "spine primary reference does not match the bound source pack" });
  }
  const storyBySequence = new Map(slate.sourceBinding.storyIndex.selected.map((item) => [item.sequence, item]));
  for (const mapping of contract.openingEpisodeMappings) {
    const source = storyBySequence.get(mapping.sourceBeatSequence);
    if (!source || source.arcId !== mapping.sourceArcId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `opening episode ${mapping.episode} cites an unbound source beat` });
    }
  }
});

export type FireflyCommercialExpansionCandidate = z.infer<typeof FireflyCommercialExpansionCandidateSchema>;
export type FireflyCommercialExpansionSlate = z.infer<typeof FireflyCommercialExpansionSlateSchema>;
export type FireflyPremiseExpansionBinding = z.infer<typeof FireflyPremiseExpansionBindingSchema>;
