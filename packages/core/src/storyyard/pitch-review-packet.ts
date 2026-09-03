import { createHash } from "node:crypto";
import { z } from "zod";
import { FireflyEntryContractSchema } from "../planning/entry-contract.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const ScoreSchema = z.object({
  promise: z.number().int().min(0).max(20),
  earlyPayoff: z.number().int().min(0).max(20),
  repeatEngine: z.number().int().min(0).max(20),
  railConversion: z.number().int().min(0).max(20),
  longRunSupply: z.number().int().min(0).max(20),
  total: z.number().int().min(0).max(100),
}).strict().superRefine((score, context) => {
  const sum = score.promise + score.earlyPayoff + score.repeatEngine + score.railConversion + score.longRunSupply;
  if (score.total !== sum) context.addIssue({ code: z.ZodIssueCode.custom, message: "total must equal component scores" });
});

export const FireflyPitchEntryGateSchema = z.object({
  passed: z.boolean(),
  protagonistNow: z.string().trim().min(1),
  personalWant: z.string().trim().min(1),
  whyNow: z.string().trim().min(1),
  repeatableFantasy: z.string().trim().min(1),
  chapterGoal: z.string().trim().min(1),
  failureReasons: z.array(z.string().trim().min(1)),
}).strict().superRefine((gate, context) => {
  if (gate.passed !== (gate.failureReasons.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "passed must match failureReasons emptiness" });
  }
});

const OpeningEpisodeSchema = z.object({
  episode: z.number().int().min(1),
  event: z.string().min(1),
  visiblePayoff: z.string().min(1),
}).strict();

const ArcSchema = z.object({
  arc: z.number().int().min(1),
  externalMove: z.string().min(1),
  visibleReward: z.string().min(1),
  relationshipConversion: z.string().min(1),
}).strict();

export const FireflyPitchReviewCandidateV3Schema = z.object({
  id: z.string().regex(/^p\d{2}$/u),
  sha256: Sha256Schema,
  titleCandidates: z.array(z.string().min(1)).min(1).max(3),
  oneLinePromise: z.string().min(1),
  entryContract: FireflyEntryContractSchema,
  protagonist: z.object({
    startingIdentity: z.string().min(1),
    repeatedVerb: z.string().min(1),
    firstAsset: z.string().min(1),
  }).strict(),
  openingEpisodes: z.array(OpeningEpisodeSchema).length(4),
  firstReward: z.string().min(1),
  railA: z.array(z.string().min(1)).min(3),
  railB: z.array(z.string().min(1)).min(3),
  arcLadder: z.array(ArcSchema).min(6),
  longRunRisk: z.string().min(1),
  independentReview: z.object({
    verdict: z.enum(["SURVIVE", "HOLD", "KILL"]),
    independentScore: ScoreSchema,
    entryGate: FireflyPitchEntryGateSchema,
    decisiveStrength: z.string().min(1),
    decisiveRisk: z.string().min(1),
    requiredRepair: z.string().min(1),
  }).strict(),
}).strict().superRefine((candidate, context) => {
  const unsigned = { ...candidate } as Record<string, unknown>;
  delete unsigned.sha256;
  if (hashCanonicalJson(unsigned) !== candidate.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate SHA-256 mismatch" });
  }
  if (!candidate.independentReview.entryGate.passed && candidate.independentReview.verdict === "SURVIVE") {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed entry gate cannot SURVIVE" });
  }
});

export const FireflyPitchReviewPacketV3Schema = z.object({
  schemaVersion: z.literal("firefly_review_packet/v3"),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  generatedAt: z.string().datetime(),
  purpose: z.literal("planning-entry"),
  source: z.object({
    system: z.literal("inkos"),
    slateId: z.string().min(1),
    sourceRevision: Sha256Schema,
  }).strict(),
  work: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    genre: z.string().min(1),
    status: z.literal("non-canonical"),
    targetChapters: z.number().int().min(1),
  }).strict(),
  artifact: z.object({
    id: z.string().min(1),
    kind: z.literal("pitch-slate"),
    title: z.string().min(1),
    status: z.literal("human-decision-pending"),
  }).strict(),
  candidates: z.array(FireflyPitchReviewCandidateV3Schema).min(1).max(20),
  recommendation: z.object({ candidateId: z.string().regex(/^p\d{2}$/u), reason: z.string().min(1) }).strict().nullable(),
  actions: z.tuple([z.literal("select"), z.literal("hold"), z.literal("reject")]),
  authority: z.object({
    canon: z.literal("inkos"),
    decisionSurface: z.literal("storyyard"),
    decisionEffect: z.literal("planning-selection"),
    manuscriptApply: z.literal(false),
    reverseSync: z.literal(false),
  }).strict(),
}).strict().superRefine((packet, context) => {
  const candidateIds = new Set(packet.candidates.map((candidate) => candidate.id));
  if (candidateIds.size !== packet.candidates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate IDs must be unique" });
  }
  if (packet.recommendation && !candidateIds.has(packet.recommendation.candidateId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "recommendation candidate is absent" });
  }
  const survivorIds = packet.candidates.filter((candidate) => candidate.independentReview.verdict === "SURVIVE").map((candidate) => candidate.id);
  if (survivorIds.length > 1 || (packet.recommendation?.candidateId ?? null) !== (survivorIds[0] ?? null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "recommendation must match the sole SURVIVE candidate" });
  }
  const unsigned = { ...packet } as Record<string, unknown>;
  delete unsigned.schemaVersion;
  delete unsigned.packetId;
  delete unsigned.packetSha256;
  const actual = hashCanonicalJson(unsigned);
  if (packet.packetSha256 !== actual || packet.packetId !== `frp-${actual.slice(0, 24)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "packet identity mismatch" });
  }
});

export type FireflyPitchReviewPacketV3 = z.infer<typeof FireflyPitchReviewPacketV3Schema>;

export function hashCanonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sort(child)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

export function buildFireflyPitchReviewPacketV3(input: Omit<FireflyPitchReviewPacketV3, "schemaVersion" | "packetId" | "packetSha256">): FireflyPitchReviewPacketV3 {
  const packetSha256 = hashCanonicalJson(input);
  return FireflyPitchReviewPacketV3Schema.parse({
    schemaVersion: "firefly_review_packet/v3",
    packetId: `frp-${packetSha256.slice(0, 24)}`,
    packetSha256,
    ...input,
  });
}
