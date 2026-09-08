import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const PlanningTextSchema = z.string().trim().min(4).max(2_000);

export const FireflySpineRetentionContractSchema = z.object({
  schemaVersion: z.literal("firefly_spine_retention/v1"),
  primaryReference: z.object({
    packId: z.string().trim().min(1),
    packSha256: Sha256Schema,
    sourceSha256: Sha256Schema,
  }).strict(),
  referenceDisclosure: z.object({
    workSlug: z.string().trim().min(1),
    workTitle: z.string().trim().min(1),
    usageRoles: z.array(z.enum(["commercial-engine", "opening-event", "relationship", "payoff", "style"])).min(1).max(5),
    selectionReason: PlanningTextSchema,
    preservedElements: z.array(PlanningTextSchema).min(4).max(12),
    transformedElements: z.array(PlanningTextSchema).min(1).max(12),
  }).strict(),
  preservedEngine: z.object({
    industry: PlanningTextSchema,
    repeatedVerb: PlanningTextSchema,
    progressionLadder: PlanningTextSchema,
    rewardGrammar: PlanningTextSchema,
  }).strict(),
  openingEpisodeMappings: z.array(z.object({
    episode: z.number().int().min(1).max(4),
    sourceBeatSequence: z.number().int().positive(),
    sourceArcId: z.string().trim().min(1),
    retainedFunction: PlanningTextSchema,
    transformedEvent: PlanningTextSchema,
  }).strict()).length(4),
  relationshipConversion: z.object({
    sourceFunction: PlanningTextSchema,
    transformedExpression: PlanningTextSchema,
  }).strict(),
  hookProgression: z.array(z.object({
    sourceArcId: z.string().trim().min(1),
    retainedFunction: PlanningTextSchema,
    transformedHook: PlanningTextSchema,
  }).strict()).min(2).max(12),
  surfaceChanges: z.array(z.object({
    layer: z.enum(["people", "organization", "object", "location", "local-cause", "number", "scene-dressing"]),
    change: PlanningTextSchema,
    causalAdjustment: PlanningTextSchema,
  }).strict()).min(1).max(14),
  payoffPair: z.object({
    material: PlanningTextSchema,
    emotional: PlanningTextSchema,
    witness: PlanningTextSchema,
  }).strict(),
}).strict().superRefine((contract, context) => {
  const ordered = contract.openingEpisodeMappings.every((item, index) => item.episode === index + 1);
  if (!ordered) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "opening episode mappings must be ordered 1 through 4" });
  }
  if (new Set(contract.openingEpisodeMappings.map((item) => item.sourceBeatSequence)).size < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "opening expansion must reuse at least two source beats" });
  }
});

export type FireflySpineRetentionContract = z.infer<typeof FireflySpineRetentionContractSchema>;

// Keep the Human Premise v1 contract intact. Source-first planning records the
// source's actual choices and rewards without requiring a relationship payoff.
const LegacySpineShape = FireflySpineRetentionContractSchema.innerType().shape;
const SourceSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const FireflySpineRetentionContractV2Schema = z.object({
  schemaVersion: z.literal("firefly_spine_retention/v2"),
  primaryReference: LegacySpineShape.primaryReference,
  referenceDisclosure: LegacySpineShape.referenceDisclosure,
  preservedEngine: LegacySpineShape.preservedEngine,
  sourceReconstruction: z.object({
    protagonist: PlanningTextSchema,
    personalGoal: PlanningTextSchema,
    longTermGoal: PlanningTextSchema,
    firstArcGoal: PlanningTextSchema,
    priorityRule: PlanningTextSchema,
    verifiedScope: PlanningTextSchema,
    uncertainty: PlanningTextSchema,
  }).strict(),
  openingEpisodeMappings: LegacySpineShape.openingEpisodeMappings,
  decisionComparisons: z.array(z.object({
    sourceSequenceStart: SourceSequenceSchema,
    sourceSequenceEnd: SourceSequenceSchema,
    sourceArcId: z.string().trim().min(1),
    sourceChoice: PlanningTextSchema,
    sourceGain: PlanningTextSchema,
    targetChoice: PlanningTextSchema,
    targetGain: PlanningTextSchema,
    preservedReason: PlanningTextSchema,
  }).strict()).min(1).max(24),
  relationshipConversion: LegacySpineShape.relationshipConversion.nullable(),
  hookProgression: z.array(LegacySpineShape.hookProgression.element).max(12),
  surfaceChanges: LegacySpineShape.surfaceChanges,
  rewards: z.array(z.object({
    kind: z.string().trim().min(1).max(80),
    sourceReward: PlanningTextSchema,
    targetReward: PlanningTextSchema,
    beneficiary: z.string().trim().min(1).max(2_000),
    witness: PlanningTextSchema.nullable(),
  }).strict()).min(1).max(24),
}).strict().superRefine((contract, context) => {
  if (!contract.openingEpisodeMappings.every((item, index) => item.episode === index + 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["openingEpisodeMappings"], message: "opening episode mappings must be ordered 1 through 4" });
  }
  if (new Set(contract.openingEpisodeMappings.map((item) => item.sourceBeatSequence)).size < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["openingEpisodeMappings"], message: "opening expansion must reuse at least two source beats" });
  }
  for (const [index, comparison] of contract.decisionComparisons.entries()) {
    if (comparison.sourceSequenceStart > comparison.sourceSequenceEnd) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["decisionComparisons", index, "sourceSequenceEnd"], message: "source sequence range must start at or before its end" });
    }
  }
});

export type FireflySpineRetentionContractV2 = z.infer<typeof FireflySpineRetentionContractV2Schema>;

export const FireflySpineRetentionContractUnionSchema = z.union([
  FireflySpineRetentionContractSchema,
  FireflySpineRetentionContractV2Schema,
]);
export type FireflySpineRetentionContractUnion = z.infer<typeof FireflySpineRetentionContractUnionSchema>;
