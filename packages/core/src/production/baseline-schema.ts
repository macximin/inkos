import { z } from "zod";
import { ArcIdSchema, ArcStatusSchema } from "../arc/schema.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);

export const BookProductionPitchSnapshotSchema = z.object({
  path: z.literal("project_pitch.md"),
  sha256: Sha256Schema,
}).strict();
export type BookProductionPitchSnapshot = z.infer<typeof BookProductionPitchSnapshotSchema>;

export const BookProductionBookRulesSnapshotSchema = z.object({
  path: z.literal("story/book_rules.md"),
  sha256: Sha256Schema,
}).strict();
export type BookProductionBookRulesSnapshot = z.infer<typeof BookProductionBookRulesSnapshotSchema>;

export const BookProductionStoryRailSnapshotSchema = z.object({
  path: z.literal("story/rails/plan.json"),
  updatedAt: z.string().datetime(),
  sha256: Sha256Schema,
}).strict();
export type BookProductionStoryRailSnapshot = z.infer<typeof BookProductionStoryRailSnapshotSchema>;

export const BookProductionNarrativeArcSnapshotSchema = z.object({
  narrativeArcId: StableIdSchema,
  allocationId: StableIdSchema,
  approvedAllocationSha256: Sha256Schema,
}).strict();
export type BookProductionNarrativeArcSnapshot = z.infer<typeof BookProductionNarrativeArcSnapshotSchema>;

export const BookProductionArcPacketSnapshotSchema = z.object({
  arcPacketId: ArcIdSchema,
  status: ArcStatusSchema.refine((status) => status !== "draft", {
    message: "A production baseline cannot include a draft ArcPacket",
  }),
  updatedAt: z.string().datetime(),
  chapterNumbers: z.array(z.number().int().min(1)).min(1).max(3),
  sha256: Sha256Schema,
}).strict();
export type BookProductionArcPacketSnapshot = z.infer<typeof BookProductionArcPacketSnapshotSchema>;

export const BookProductionGoldRouteSnapshotSchema = z.object({
  receiptId: StableIdSchema,
  approvedReceiptSha256: Sha256Schema,
}).strict();
export type BookProductionGoldRouteSnapshot = z.infer<typeof BookProductionGoldRouteSnapshotSchema>;

export const BookProductionBaselineReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }).strict(),
  z.object({
    status: z.literal("approved"),
    approvedBy: z.string().trim().min(1).max(200),
    approvedAt: z.string().datetime(),
    approvedBaselineSha256: Sha256Schema,
  }).strict(),
]);
export type BookProductionBaselineReview = z.infer<typeof BookProductionBaselineReviewSchema>;

export const BookProductionBaselineSchema = z.object({
  version: z.literal(1),
  baselineId: StableIdSchema,
  bookId: z.string().min(1),
  pitch: BookProductionPitchSnapshotSchema,
  bookRules: BookProductionBookRulesSnapshotSchema,
  storyRail: BookProductionStoryRailSnapshotSchema,
  narrativeArcs: z.array(BookProductionNarrativeArcSnapshotSchema).min(1).max(500),
  arcPackets: z.array(BookProductionArcPacketSnapshotSchema).min(1).max(2_000),
  goldRoutes: z.array(BookProductionGoldRouteSnapshotSchema).max(500),
  review: BookProductionBaselineReviewSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((baseline, ctx) => {
  validateUnique(baseline.narrativeArcs.map((entry) => entry.narrativeArcId), ["narrativeArcs"], ctx);
  validateUnique(baseline.narrativeArcs.map((entry) => entry.allocationId), ["narrativeArcs"], ctx);
  validateUnique(baseline.arcPackets.map((entry) => entry.arcPacketId), ["arcPackets"], ctx);
  validateUnique(baseline.goldRoutes.map((entry) => entry.receiptId), ["goldRoutes"], ctx);
});
export type BookProductionBaseline = z.infer<typeof BookProductionBaselineSchema>;

export const BookProductionBaselineStoreSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  baselines: z.array(BookProductionBaselineSchema),
}).strict().superRefine((store, ctx) => {
  validateUnique(store.baselines.map((baseline) => baseline.baselineId), ["baselines"], ctx);
  for (const [index, baseline] of store.baselines.entries()) {
    if (baseline.bookId !== store.bookId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baselines", index, "bookId"],
        message: "Production baseline belongs to another Book",
      });
    }
  }
});
export type BookProductionBaselineStore = z.infer<typeof BookProductionBaselineStoreSchema>;

export const BookProductionBaselineInputSchema = z.object({
  baselineId: StableIdSchema,
  narrativeArcAllocationIds: z.array(StableIdSchema).min(1).max(500),
}).strict().superRefine((input, ctx) => {
  validateUnique(input.narrativeArcAllocationIds, ["narrativeArcAllocationIds"], ctx);
});
export type BookProductionBaselineInput = z.infer<typeof BookProductionBaselineInputSchema>;

function validateUnique(
  values: ReadonlyArray<string>,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Values must be unique" });
  }
}
