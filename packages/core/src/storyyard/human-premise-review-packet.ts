import { z } from "zod";
import {
  FireflyHumanPremiseCandidateBaseSchema,
  FireflyPitchRuntimeReceiptSchema,
  FireflyPitchSourceBindingSchema,
} from "../planning/human-premise.js";
import { hashCanonicalJson } from "./pitch-review-packet.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const CandidateIdSchema = z.string().regex(/^p\d{2}$/u);

export const FireflyHumanPremiseReviewCandidateV4Schema = FireflyHumanPremiseCandidateBaseSchema.omit({ candidateId: true }).extend({
  id: CandidateIdSchema,
  independentReview: z.object({
    candidateId: CandidateIdSchema,
    verdict: z.enum(["SURVIVE", "HOLD", "KILL"]),
    gates: z.object({
      humanDesire: z.boolean(),
      sourceGrounded: z.boolean(),
      sceneableToday: z.boolean(),
      nonMechanical: z.boolean(),
      voiceGrounded: z.boolean(),
    }).strict(),
    decisiveStrength: z.string().min(1),
    decisiveRisk: z.string().min(1),
    requiredRepair: z.string().min(1),
  }).strict(),
}).strict();

export const FireflyHumanPremiseReviewPacketV4Schema = z.object({
  schemaVersion: z.literal("firefly_review_packet/v4"),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  generatedAt: z.string().datetime(),
  purpose: z.literal("human-premise"),
  source: z.object({
    system: z.literal("inkos"),
    slateId: z.string().min(1),
    sourceRevision: Sha256Schema,
  }).strict(),
  work: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    genre: z.literal("modern-fantasy-ko"),
    status: z.literal("non-canonical"),
  }).strict(),
  artifact: z.object({
    id: z.string().min(1),
    kind: z.literal("human-premise-slate"),
    title: z.string().min(1),
    status: z.literal("human-decision-pending"),
  }).strict(),
  sourceBinding: FireflyPitchSourceBindingSchema,
  runtimeReceipt: FireflyPitchRuntimeReceiptSchema,
  reviewerRuntimeReceipt: FireflyPitchRuntimeReceiptSchema,
  candidates: z.array(FireflyHumanPremiseReviewCandidateV4Schema).min(1).max(6),
  recommendation: z.object({ candidateId: CandidateIdSchema, reason: z.string().min(1) }).strict().nullable(),
  actions: z.tuple([z.literal("select"), z.literal("hold"), z.literal("reject")]),
  authority: z.object({
    canon: z.literal("inkos"),
    decisionSurface: z.literal("storyyard"),
    decisionEffect: z.literal("human-premise-selection"),
    commercialExpansion: z.literal(false),
    bookCreation: z.literal(false),
    manuscriptApply: z.literal(false),
    reverseSync: z.literal(false),
  }).strict(),
}).strict().superRefine((packet, context) => {
  if (packet.runtimeReceipt.model !== packet.reviewerRuntimeReceipt.model) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "generator and reviewer runtime models must match" });
  }
  const ids = new Set(packet.candidates.map((candidate) => candidate.id));
  if (ids.size !== packet.candidates.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "candidate IDs must be unique" });
  }
  const survivors = packet.candidates.filter((candidate) => candidate.independentReview.verdict === "SURVIVE");
  if (survivors.length > 1 || (survivors[0]?.id ?? null) !== (packet.recommendation?.candidateId ?? null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "recommendation must match the sole SURVIVE candidate" });
  }
  for (const candidate of packet.candidates) {
    if (candidate.independentReview.candidateId !== candidate.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${candidate.id} review identity mismatch` });
    }
    const { id, sha256, independentReview: _review, ...unsignedCandidate } = candidate;
    if (hashCanonicalJson({ candidateId: id, ...unsignedCandidate }) !== sha256) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${candidate.id} SHA-256 mismatch` });
    }
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

export type FireflyHumanPremiseReviewPacketV4 = z.infer<typeof FireflyHumanPremiseReviewPacketV4Schema>;

export function buildFireflyHumanPremiseReviewPacketV4(
  input: Omit<FireflyHumanPremiseReviewPacketV4, "schemaVersion" | "packetId" | "packetSha256">,
): FireflyHumanPremiseReviewPacketV4 {
  const packetSha256 = hashCanonicalJson(input);
  return FireflyHumanPremiseReviewPacketV4Schema.parse({
    schemaVersion: "firefly_review_packet/v4",
    packetId: `frp-${packetSha256.slice(0, 24)}`,
    packetSha256,
    ...input,
  });
}
