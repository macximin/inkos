import { z } from "zod";
import { GoldSelectionKindSchema } from "../references/gold-route-receipt.js";
import { StableRailIdSchema } from "./rail-schema.js";
import { ArcIdSchema } from "./schema.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const BoundedTextSchema = z.string().trim().min(1).max(2_000);
const TextListSchema = z.array(BoundedTextSchema).max(30).default([]);

export const NarrativeArcObligationDispositionSchema = z.enum([
  "assigned",
  "deferred",
  "retired",
]);
export type NarrativeArcObligationDisposition = z.infer<typeof NarrativeArcObligationDispositionSchema>;

export const NarrativeArcGoldRouteSnapshotSchema = z.object({
  receiptId: StableIdSchema,
  approvedReceiptSha256: Sha256Schema,
}).strict();
export type NarrativeArcGoldRouteSnapshot = z.infer<typeof NarrativeArcGoldRouteSnapshotSchema>;

export const NarrativeArcGoldObligationSchema = z.object({
  obligationId: StableIdSchema,
  sourceReceiptId: StableIdSchema,
  sourceKind: GoldSelectionKindSchema,
  sourceId: StableIdSchema,
  disposition: NarrativeArcObligationDispositionSchema,
  targetArcPacketId: ArcIdSchema.optional(),
  note: BoundedTextSchema,
}).strict().superRefine((obligation, ctx) => {
  if (obligation.disposition === "assigned" && !obligation.targetArcPacketId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetArcPacketId"],
      message: "An assigned Gold obligation requires a target ArcPacket",
    });
  }
  if (obligation.disposition !== "assigned" && obligation.targetArcPacketId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetArcPacketId"],
      message: "Only an assigned Gold obligation may target an ArcPacket",
    });
  }
});
export type NarrativeArcGoldObligation = z.infer<typeof NarrativeArcGoldObligationSchema>;

export const NarrativeArcPacketAssignmentSchema = z.object({
  routeOrder: z.number().int().min(0),
  arcPacketId: ArcIdSchema,
  bRailEntryId: StableRailIdSchema,
  chapterNumbers: z.array(z.number().int().min(1)).min(1).max(3),
  arcPacketUpdatedAt: z.string().datetime(),
  arcPacketSha256: Sha256Schema,
  bRailEntrySha256: Sha256Schema,
  events: TextListSchema,
  pressures: TextListSchema,
  microPayoffs: TextListSchema,
  relationshipChanges: TextListSchema,
  obligationIds: z.array(StableIdSchema).max(100).default([]),
}).strict().superRefine((assignment, ctx) => {
  const meaningfulCount = assignment.events.length
    + assignment.pressures.length
    + assignment.microPayoffs.length
    + assignment.relationshipChanges.length
    + assignment.obligationIds.length;
  if (meaningfulCount === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: "An ArcPacket assignment needs an event, pressure, payoff, relationship change, or Gold obligation",
    });
  }
  validateUnique(assignment.obligationIds, ["obligationIds"], ctx);
});
export type NarrativeArcPacketAssignment = z.infer<typeof NarrativeArcPacketAssignmentSchema>;

const NarrativeArcAllocationReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }).strict(),
  z.object({
    status: z.literal("approved"),
    approvedBy: z.string().trim().min(1).max(200),
    approvedAt: z.string().datetime(),
    approvedAllocationSha256: Sha256Schema,
  }).strict(),
]);
export type NarrativeArcAllocationReview = z.infer<typeof NarrativeArcAllocationReviewSchema>;

export const NarrativeArcAllocationSchema = z.object({
  version: z.literal(1),
  allocationId: StableIdSchema,
  bookId: z.string().min(1),
  narrativeArcId: StableIdSchema,
  title: z.string().trim().min(1).max(300),
  entryState: BoundedTextSchema,
  exitState: BoundedTextSchema,
  irreversibleChange: BoundedTextSchema,
  sourceGoldRoutes: z.array(NarrativeArcGoldRouteSnapshotSchema).max(20),
  packetAssignments: z.array(NarrativeArcPacketAssignmentSchema).min(1).max(100),
  obligations: z.array(NarrativeArcGoldObligationSchema).max(2_000),
  review: NarrativeArcAllocationReviewSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((allocation, ctx) => {
  validateUnique(
    allocation.sourceGoldRoutes.map((route) => route.receiptId),
    ["sourceGoldRoutes"],
    ctx,
  );
  validateUnique(
    allocation.packetAssignments.map((assignment) => assignment.arcPacketId),
    ["packetAssignments"],
    ctx,
  );
  validateUnique(
    allocation.packetAssignments.map((assignment) => assignment.bRailEntryId),
    ["packetAssignments"],
    ctx,
  );
  validateUnique(
    allocation.obligations.map((obligation) => obligation.obligationId),
    ["obligations"],
    ctx,
  );

  const packetIds = new Set(allocation.packetAssignments.map((assignment) => assignment.arcPacketId));
  const sourceReceiptIds = new Set(allocation.sourceGoldRoutes.map((route) => route.receiptId));
  const obligationById = new Map(
    allocation.obligations.map((obligation) => [obligation.obligationId, obligation] as const),
  );
  const assignedCounts = new Map<string, number>();

  for (const [index, assignment] of allocation.packetAssignments.entries()) {
    if (assignment.routeOrder !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packetAssignments", index, "routeOrder"],
        message: "ArcPacket routeOrder must match its zero-based position",
      });
    }
    if (index > 0) {
      const previous = allocation.packetAssignments[index - 1]!;
      const expectedChapter = previous.chapterNumbers.at(-1)! + 1;
      if (assignment.chapterNumbers[0] !== expectedChapter) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packetAssignments", index, "chapterNumbers"],
          message: "NarrativeArc ArcPackets must cover one continuous chapter span",
        });
      }
    }
    for (const obligationId of assignment.obligationIds) {
      const obligation = obligationById.get(obligationId);
      if (!obligation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packetAssignments", index, "obligationIds"],
          message: `Unknown Gold obligation ${JSON.stringify(obligationId)}`,
        });
        continue;
      }
      if (
        obligation.disposition !== "assigned"
        || obligation.targetArcPacketId !== assignment.arcPacketId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packetAssignments", index, "obligationIds"],
          message: `Gold obligation ${JSON.stringify(obligationId)} is not assigned to this ArcPacket`,
        });
      }
      assignedCounts.set(obligationId, (assignedCounts.get(obligationId) ?? 0) + 1);
    }
  }

  for (const [index, obligation] of allocation.obligations.entries()) {
    if (!sourceReceiptIds.has(obligation.sourceReceiptId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["obligations", index, "sourceReceiptId"],
        message: "Gold obligation references a receipt outside sourceGoldRoutes",
      });
    }
    if (obligation.targetArcPacketId && !packetIds.has(obligation.targetArcPacketId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["obligations", index, "targetArcPacketId"],
        message: "Gold obligation targets an ArcPacket outside this allocation",
      });
    }
    const count = assignedCounts.get(obligation.obligationId) ?? 0;
    if (obligation.disposition === "assigned" && count !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["obligations", index, "obligationId"],
        message: "An assigned Gold obligation must appear in exactly one ArcPacket",
      });
    }
    if (obligation.disposition !== "assigned" && count !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["obligations", index, "obligationId"],
        message: "A deferred or retired Gold obligation may not appear in an ArcPacket",
      });
    }
  }
});
export type NarrativeArcAllocation = z.infer<typeof NarrativeArcAllocationSchema>;

export const NarrativeArcAllocationStoreSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  allocations: z.array(NarrativeArcAllocationSchema),
}).strict().superRefine((store, ctx) => {
  validateUnique(store.allocations.map((allocation) => allocation.allocationId), ["allocations"], ctx);
  validateUnique(store.allocations.map((allocation) => allocation.narrativeArcId), ["allocations"], ctx);
  for (const [index, allocation] of store.allocations.entries()) {
    if (allocation.bookId !== store.bookId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allocations", index, "bookId"],
        message: "NarrativeArc allocation belongs to another Book",
      });
    }
  }
});
export type NarrativeArcAllocationStore = z.infer<typeof NarrativeArcAllocationStoreSchema>;

export const NarrativeArcGoldObligationInputSchema = NarrativeArcGoldObligationSchema;
export type NarrativeArcGoldObligationInput = z.infer<typeof NarrativeArcGoldObligationInputSchema>;

export const NarrativeArcPacketAssignmentInputSchema = z.object({
  arcPacketId: ArcIdSchema,
  bRailEntryId: StableRailIdSchema,
  events: TextListSchema,
  pressures: TextListSchema,
  microPayoffs: TextListSchema,
  relationshipChanges: TextListSchema,
  obligationIds: z.array(StableIdSchema).max(100).default([]),
}).strict();
export type NarrativeArcPacketAssignmentInput = z.infer<typeof NarrativeArcPacketAssignmentInputSchema>;

export const NarrativeArcAllocationInputSchema = z.object({
  allocationId: StableIdSchema,
  narrativeArcId: StableIdSchema,
  title: z.string().trim().min(1).max(300),
  entryState: BoundedTextSchema,
  exitState: BoundedTextSchema,
  irreversibleChange: BoundedTextSchema,
  sourceGoldRouteReceiptIds: z.array(StableIdSchema).max(20),
  packetAssignments: z.array(NarrativeArcPacketAssignmentInputSchema).min(1).max(100),
  obligations: z.array(NarrativeArcGoldObligationInputSchema).max(2_000),
}).strict().superRefine((input, ctx) => {
  validateUnique(input.sourceGoldRouteReceiptIds, ["sourceGoldRouteReceiptIds"], ctx);
  validateUnique(input.packetAssignments.map((assignment) => assignment.arcPacketId), ["packetAssignments"], ctx);
  validateUnique(input.packetAssignments.map((assignment) => assignment.bRailEntryId), ["packetAssignments"], ctx);
});
export type NarrativeArcAllocationInput = z.infer<typeof NarrativeArcAllocationInputSchema>;

function validateUnique(
  values: ReadonlyArray<string>,
  path: Array<string | number>,
  ctx: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "Values must be unique" });
  }
}
