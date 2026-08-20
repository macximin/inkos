import { createHash } from "node:crypto";
import { z } from "zod";
import { ArcIdSchema, FutureAdvantageMoveSchema } from "../arc/schema.js";

export const FutureAdvantageMemoryReliabilitySchema = z.enum([
  "intact",
  "strained",
  "degraded",
  "unreliable",
]);
export type FutureAdvantageMemoryReliability = z.infer<typeof FutureAdvantageMemoryReliabilitySchema>;

export const FutureAdvantageResearchStatusSchema = z.enum([
  "not-applicable",
  "not-checked",
  "needs-research",
  "verified",
  "conflict",
]);

const WorldChangeEvidenceSchema = z.object({
  change: z.string().min(1),
  evidence: z.string().min(1),
}).strict();

export const FutureAdvantageExecutionCandidateSchema = z.object({
  moveId: z.string().min(1),
  implemented: z.boolean(),
  bridgeEvidence: z.array(z.string().min(1)).default([]),
  proofEvidence: z.array(z.string().min(1)).default([]),
  rewardEvidence: z.array(z.string().min(1)).default([]),
  worldChanges: z.array(WorldChangeEvidenceSchema).default([]),
  memoryReliability: FutureAdvantageMemoryReliabilitySchema.default("intact"),
  memoryEvidence: z.array(z.string().min(1)).default([]),
  note: z.string().default(""),
}).strict();
export type FutureAdvantageExecutionCandidate = z.infer<typeof FutureAdvantageExecutionCandidateSchema>;

export const ChapterFutureAdvantageExecutionSchema = FutureAdvantageExecutionCandidateSchema.extend({
  version: z.literal(1),
  chapterNumber: z.number().int().min(1),
  arcId: ArcIdSchema,
  move: FutureAdvantageMoveSchema,
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  researchStatus: FutureAdvantageResearchStatusSchema,
  researchClaimIds: z.array(z.string().min(1)),
  authorizedDivergences: z.array(z.string().min(1)),
}).strict();
export type ChapterFutureAdvantageExecution = z.infer<typeof ChapterFutureAdvantageExecutionSchema>;

export const FutureAdvantageCanonEntrySchema = ChapterFutureAdvantageExecutionSchema.extend({
  approvedAt: z.string().datetime(),
}).strict();
export type FutureAdvantageCanonEntry = z.infer<typeof FutureAdvantageCanonEntrySchema>;

export const FutureAdvantageCanonLedgerSchema = z.object({
  version: z.literal(1),
  executedMoves: z.array(FutureAdvantageCanonEntrySchema),
}).strict();
export type FutureAdvantageCanonLedger = z.infer<typeof FutureAdvantageCanonLedgerSchema>;

export const FutureAdvantageResearchReceiptSchema = z.object({
  version: z.literal(1),
  chapterNumber: z.number().int().min(1),
  arcId: ArcIdSchema,
  moveId: z.string().min(1),
  claimIds: z.array(z.string().min(1)),
  status: FutureAdvantageResearchStatusSchema,
  approvedAt: z.string().datetime(),
}).strict();

export const FutureAdvantageResearchReceiptStoreSchema = z.object({
  version: z.literal(1),
  receipts: z.array(FutureAdvantageResearchReceiptSchema),
}).strict();
export type FutureAdvantageResearchReceiptStore = z.infer<typeof FutureAdvantageResearchReceiptStoreSchema>;

export function hashFutureAdvantageChapterContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateFutureAdvantageExecutionCandidate(params: {
  readonly candidate: FutureAdvantageExecutionCandidate;
  readonly moveId: string;
  readonly chapterContent: string;
}): FutureAdvantageExecutionCandidate | undefined {
  const parsed = FutureAdvantageExecutionCandidateSchema.safeParse(params.candidate);
  if (!parsed.success || !parsed.data.implemented || parsed.data.moveId !== params.moveId) return undefined;
  if (
    parsed.data.bridgeEvidence.length === 0
    || parsed.data.proofEvidence.length === 0
    || parsed.data.rewardEvidence.length === 0
  ) return undefined;
  const excerpts = [
    ...parsed.data.bridgeEvidence,
    ...parsed.data.proofEvidence,
    ...parsed.data.rewardEvidence,
    ...parsed.data.worldChanges.map((entry) => entry.evidence),
    ...parsed.data.memoryEvidence,
  ];
  if (excerpts.some((excerpt) => !params.chapterContent.includes(excerpt))) return undefined;
  if (parsed.data.memoryReliability !== "intact" && parsed.data.memoryEvidence.length === 0) return undefined;
  return parsed.data;
}
