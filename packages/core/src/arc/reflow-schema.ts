import { z } from "zod";
import { ChapterStatusSchema } from "../models/chapter.js";
import { ArcIdSchema } from "./schema.js";
import {
  ArcActualEpisodeCountSchema,
  ArcRouteEntrySchema,
  StableRailIdSchema,
} from "./rail-schema.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const StoryRailReflowPendingSchema = z.object({
  version: z.literal(1),
  pendingId: StableRailIdSchema,
  supersedesPendingId: StableRailIdSchema.optional(),
  status: z.literal("pending"),
  bookId: z.string().min(1),
  createdAt: z.string().datetime(),
  expectedPlanUpdatedAt: z.string().datetime(),
  activeB: z.object({
    bId: StableRailIdSchema,
    routeOrder: z.number().int().min(0),
    targetAnchorId: StableRailIdSchema,
    arcId: ArcIdSchema,
  }).strict(),
  arc: z.object({
    id: ArcIdSchema,
    updatedAt: z.string().datetime(),
    chapterNumbers: z.array(z.number().int().min(1)).min(1).max(3),
    plannedEpisodeCount: ArcActualEpisodeCountSchema,
  }).strict(),
  endpointChapterNumber: z.number().int().min(1),
  actualEpisodeCount: ArcActualEpisodeCountSchema,
  approvedChapters: z.array(z.object({
    number: z.number().int().min(1),
    status: ChapterStatusSchema.refine(
      (status) => status === "approved" || status === "published",
      "Reflow evidence requires an approved or published chapter",
    ),
    updatedAt: z.string().datetime(),
    arcUpdatedAt: z.string().datetime(),
    railPlanUpdatedAt: z.string().datetime(),
    chapterContentSha256: Sha256Schema,
    stateSnapshotSha256: Sha256Schema,
    truthReceiptSha256: Sha256Schema,
  }).strict()).min(1).max(3),
  stateEvidence: z.object({
    lastAppliedChapter: z.number().int().min(1),
    projectionVersion: z.number().int().min(1),
    stateProjectionSha256: Sha256Schema,
  }).strict(),
}).strict();
export type StoryRailReflowPending = z.infer<typeof StoryRailReflowPendingSchema>;

export const StoryRailReflowCloseoutSchema = z.object({
  startState: z.string().trim().min(1),
  actualOutcome: z.string().trim().min(1),
  irreversibleSettlement: z.string().trim().min(1),
  humanRemainder: z.string().trim().min(1),
  readerDebt: z.object({
    paid: z.array(z.string().trim().min(1)),
    carried: z.array(z.string().trim().min(1)),
    retired: z.array(z.string().trim().min(1)),
    emerged: z.array(z.string().trim().min(1)),
  }).strict(),
  emergence: z.array(z.string().trim().min(1)),
  anchorImpact: z.object({
    anchorId: StableRailIdSchema,
    decision: z.literal("keep"),
    reason: z.string().trim().min(1),
  }).strict(),
  stateThroughChapter: z.number().int().min(1),
}).strict();
export type StoryRailReflowCloseout = z.infer<typeof StoryRailReflowCloseoutSchema>;

export const StoryRailDurableRevisionSchema = z.object({
  routeOrder: z.number().int().min(0),
  targetAnchorId: StableRailIdSchema,
  narrativeFunction: z.string().trim().min(1),
  payoffAxis: z.string().trim().min(1),
  carriedReaderDebt: z.string().trim().min(1),
  contrastRequirement: z.string().trim().min(1),
}).strict();
export type StoryRailDurableRevision = z.infer<typeof StoryRailDurableRevisionSchema>;

export const StoryRailReflowDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    bId: StableRailIdSchema,
    action: z.literal("keep"),
  }).strict(),
  z.object({
    bId: StableRailIdSchema,
    action: z.literal("revise"),
    revision: StoryRailDurableRevisionSchema,
  }).strict(),
  z.object({
    bId: StableRailIdSchema,
    action: z.literal("retire"),
    reason: z.string().trim().min(1),
  }).strict(),
]);
export type StoryRailReflowDecision = z.infer<typeof StoryRailReflowDecisionSchema>;

export const StoryRailReflowApplyInputSchema = z.object({
  pendingId: StableRailIdSchema,
  expectedPlanUpdatedAt: z.string().datetime(),
  closeout: StoryRailReflowCloseoutSchema,
  nextActiveBId: StableRailIdSchema,
  nextProvisionalBId: StableRailIdSchema.optional(),
  decisions: z.array(StoryRailReflowDecisionSchema),
  newEntries: z.array(ArcRouteEntrySchema).default([]),
}).strict().superRefine((input, ctx) => {
  const ids = new Set<string>();
  for (const [index, decision] of input.decisions.entries()) {
    if (ids.has(decision.bId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisions", index, "bId"],
        message: `A reflow decision may appear only once for B ${JSON.stringify(decision.bId)}`,
      });
    }
    ids.add(decision.bId);
  }
  if (input.nextProvisionalBId === input.nextActiveBId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nextProvisionalBId"],
      message: "The next active and provisional B ids must be different",
    });
  }
  for (const [index, entry] of input.newEntries.entries()) {
    if (entry.status !== "hypothesis" || entry.arcId || entry.actualEpisodeCount !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newEntries", index],
        message: "A new reflow entry must begin as an unbound hypothesis without historical episode count",
      });
    }
  }
});
export type StoryRailReflowApplyInput = z.infer<typeof StoryRailReflowApplyInputSchema>;

export const StoryRailReflowDiscardInputSchema = z.object({
  pendingId: StableRailIdSchema,
  expectedPlanUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(1),
}).strict();
export type StoryRailReflowDiscardInput = z.infer<typeof StoryRailReflowDiscardInputSchema>;

export const StoryRailReflowDiscardReceiptSchema = z.object({
  version: z.literal(1),
  receiptId: StableRailIdSchema,
  bookId: z.string().min(1),
  discardedAt: z.string().datetime(),
  reason: z.string().min(1),
  pending: StoryRailReflowPendingSchema,
}).strict();
export type StoryRailReflowDiscardReceipt = z.infer<typeof StoryRailReflowDiscardReceiptSchema>;

export const StoryRailReflowReceiptSchema = z.object({
  version: z.literal(1),
  receiptId: StableRailIdSchema,
  pendingId: StableRailIdSchema,
  bookId: z.string().min(1),
  appliedAt: z.string().datetime(),
  planUpdatedAtBefore: z.string().datetime(),
  planUpdatedAtAfter: z.string().datetime(),
  closedB: z.object({
    bId: StableRailIdSchema,
    arcId: ArcIdSchema,
    endpointChapterNumber: z.number().int().min(1),
    actualEpisodeCount: ArcActualEpisodeCountSchema,
  }).strict(),
  evidence: z.object({
    pendingCreatedAt: z.string().datetime(),
    expectedPlanUpdatedAt: z.string().datetime(),
    activeB: StoryRailReflowPendingSchema.shape.activeB,
    arc: StoryRailReflowPendingSchema.shape.arc,
    approvedChapters: StoryRailReflowPendingSchema.shape.approvedChapters,
    stateEvidence: StoryRailReflowPendingSchema.shape.stateEvidence,
  }).strict(),
  closeout: StoryRailReflowCloseoutSchema,
  decisions: z.array(StoryRailReflowDecisionSchema),
  newEntryIds: z.array(StableRailIdSchema),
  invalidatedFutureArcBindings: z.array(z.object({
    bId: StableRailIdSchema,
    arcId: ArcIdSchema,
  }).strict()),
  nextActiveBId: StableRailIdSchema,
  nextProvisionalBId: StableRailIdSchema.optional(),
  nextActiveArcId: ArcIdSchema.optional(),
}).strict();
export type StoryRailReflowReceipt = z.infer<typeof StoryRailReflowReceiptSchema>;
