import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SceneFunctionSchema = z.enum(["entry", "escalation", "payoff"]);

export const ReferencePackSchema = z.object({
  version: z.literal(1),
  kind: z.literal("reference-transformation-pack"),
  id: z.string().min(1),
  language: z.enum(["zh", "ko", "en"]),
  source: z.object({
    workSlug: z.string().min(1),
    workTitle: z.string().min(1),
    sourceSha256: Sha256Schema,
    chapterCount: z.number().int().min(1),
    naturalArcCount: z.number().int().min(1),
    goldStatus: z.string().min(1),
  }).strict(),
  privateInputs: z.object({
    storyIndexSha256: Sha256Schema,
    styleExamplesSha256: Sha256Schema,
    privateIndexSha256: Sha256Schema,
  }).strict(),
  storyRetrieval: z.object({
    indexedChapterCount: z.number().int().min(1),
    defaultMappedChapterLimit: z.number().int().min(1).max(5),
    authority: z.array(z.string().min(1)).min(1),
  }).strict(),
  styleRetrieval: z.object({
    method: z.string().min(1),
    sampleCount: z.number().int().min(1),
    samples: z.array(z.object({
      id: z.string().min(1),
      phaseId: z.string().min(1),
      function: SceneFunctionSchema,
      sequence: z.number().int().min(1),
      arcId: z.string().min(1),
      rawProseSha256: Sha256Schema,
    }).strict()).min(1),
    defaultSampleLimit: z.number().int().min(1).max(5),
    hilRetrySampleLimit: z.number().int().min(1).max(10),
  }).strict(),
  transformationPolicy: z.object({
    requiredSpineReference: z.boolean(),
    reusableLayers: z.array(z.string().min(1)).min(1),
    selectableSurfaceVariation: z.array(z.string().min(1)),
    linkedConsequences: z.array(z.string().min(1)),
  }).strict(),
  commercialPolicy: z.object({
    priority: z.array(z.string().min(1)).min(1),
    similarityPenalty: z.literal(false),
    minimumDistanceScore: z.null(),
    automaticRewriteForOverlap: z.literal(false),
    humanPolishDecision: z.literal(true),
  }).strict(),
  corpusMetrics: z.record(z.unknown()),
  phases: z.array(z.object({
    phaseId: z.string().min(1),
    progressRange: z.object({ start: z.number(), end: z.number() }).strict(),
    sourceChapterRange: z.object({ start: z.number().int(), end: z.number().int() }).strict(),
    metrics: z.record(z.unknown()),
    styleSampleIds: z.array(z.string().min(1)),
  }).strict()).min(1),
}).strict();
export type ReferencePack = z.infer<typeof ReferencePackSchema>;

export const ReferenceStoryIndexEntrySchema = z.object({
  sequence: z.number().int().min(1),
  visibleLabel: z.string(),
  title: z.string(),
  arcId: z.string().min(1),
  sourceLineRange: z.object({ start: z.number().int().min(1), end: z.number().int().min(1) }).strict(),
  sourceCharacterRange: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }).strict(),
  marker: z.string(),
  functions: z.object({
    entryState: z.string(),
    readerPromise: z.string(),
    protagonistGoal: z.string(),
    action: z.string(),
    resistanceOrCost: z.string(),
    turnOrReveal: z.string(),
    paidReward: z.string(),
    stateChange: z.string(),
    endingHook: z.string(),
  }).strict(),
  surfaceRefs: z.object({ peopleAndPlaces: z.string(), locations: z.string() }).strict(),
  rawProseSha256: Sha256Schema,
}).strict();
export type ReferenceStoryIndexEntry = z.infer<typeof ReferenceStoryIndexEntrySchema>;

export const ReferenceStyleExampleSchema = z.object({
  id: z.string().min(1),
  phaseId: z.string().min(1),
  function: SceneFunctionSchema,
  sequence: z.number().int().min(1),
  arcId: z.string().min(1),
  rawProseSha256: Sha256Schema,
  prose: z.string().min(1),
}).strict();
export type ReferenceStyleExample = z.infer<typeof ReferenceStyleExampleSchema>;

export const ReferenceBindingSchema = z.object({
  version: z.literal(1),
  kind: z.literal("reference-binding"),
  bookId: z.string().min(1),
  referencePackId: z.string().min(1),
  spineReference: z.string().min(1),
  packSha256: Sha256Schema,
  storyIndexSha256: Sha256Schema,
  styleExamplesSha256: Sha256Schema,
  sourceSha256: Sha256Schema,
  sourcePath: z.string().min(1),
  boundAt: z.string().datetime(),
}).strict();
export type ReferenceBinding = z.infer<typeof ReferenceBindingSchema>;

export const ReferenceTransformationSegmentSchema = z.object({
  id: z.string().min(1),
  sourceArcIds: z.array(z.string().min(1)).min(1),
  sourceChapterIds: z.array(z.number().int().min(1)).min(1).max(5),
  targetRailAnchorIds: z.array(z.string().min(1)).min(1),
  targetArcIds: z.array(z.string().min(1)).min(1),
  retain: z.array(z.enum([
    "engine",
    "event-order",
    "character-role",
    "pressure",
    "reversal",
    "payoff",
    "hook",
    "scene-function",
  ])).min(1),
  varySurface: z.array(z.enum([
    "people",
    "organization",
    "object",
    "location",
    "local-cause",
    "number",
    "scene-dressing",
  ])),
  linkedConsequences: z.array(z.enum(["money", "evidence", "procedure", "role", "result"])),
}).strict();
export type ReferenceTransformationSegment = z.infer<typeof ReferenceTransformationSegmentSchema>;

export const ReferenceTransformationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("reference-transformation"),
  bookId: z.string().min(1),
  referencePackId: z.string().min(1),
  spineReference: z.string().min(1),
  supportingReferences: z.array(z.object({
    referenceId: z.string().min(1),
    roles: z.array(z.enum(["engine", "payoff", "emotion", "hook", "wildcard"])).min(1),
  }).strict()).default([]),
  sourceSegments: z.array(ReferenceTransformationSegmentSchema).min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ReferenceTransformation = z.infer<typeof ReferenceTransformationSchema>;

export interface WriterReferenceContext {
  readonly packId: string;
  readonly spineReference: string;
  readonly transformation: ReferenceTransformation;
  readonly storyEntries: ReadonlyArray<ReferenceStoryIndexEntry & { readonly prose: string }>;
  readonly styleExamples: ReadonlyArray<ReferenceStyleExample>;
  readonly rendered: string;
}
