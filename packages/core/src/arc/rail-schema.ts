import { z } from "zod";
import { ArcIdSchema } from "./schema.js";

export const StableRailIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/,
  "Rail ids must start with an alphanumeric character and contain only alphanumerics, _ or -",
);

const RouteOrderSchema = z.number().int().min(0);
export const ArcActualEpisodeCountSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type ArcActualEpisodeCount = z.infer<typeof ArcActualEpisodeCountSchema>;
export const StoryRailReadinessSchema = z.enum(["draft", "ready"]);
export type StoryRailReadiness = z.infer<typeof StoryRailReadinessSchema>;
const NonEmptyTitleSchema = z.string().trim().min(1);

export const AnchorDetailLevelSchema = z.enum(["compound", "sparse"]);
export type AnchorDetailLevel = z.infer<typeof AnchorDetailLevelSchema>;

export const AnchorStateSchema = z.enum(["planned", "reached", "retired"]);
export type AnchorState = z.infer<typeof AnchorStateSchema>;

export const StoryAnchorSchema = z.object({
  id: StableRailIdSchema,
  routeOrder: RouteOrderSchema,
  title: NonEmptyTitleSchema,
  detailLevel: AnchorDetailLevelSchema,
  state: AnchorStateSchema,
  entryState: z.string(),
  trigger: z.string(),
  irreversibleChange: z.string(),
  humanAftermath: z.string(),
  readerDebt: z.string(),
  payoffAxis: z.string(),
  nextPressure: z.string(),
}).strict();
export type StoryAnchor = z.infer<typeof StoryAnchorSchema>;

export const AnchorRailSchema = z.object({
  status: StoryRailReadinessSchema,
  // Retired anchors are immutable tombstones and therefore do not consume one
  // of the 6-12 live A-Rail destinations.
  anchors: z.array(StoryAnchorSchema).min(1),
}).strict().superRefine((rail, ctx) => {
  validateUniqueAndIncreasing(
    rail.anchors,
    (anchor) => anchor.id,
    (anchor) => anchor.routeOrder,
    ["anchors"],
    "Anchor",
    ctx,
  );

  if (rail.status !== "ready") return;
  const liveAnchors = rail.anchors.filter((anchor) => anchor.state !== "retired");
  if (liveAnchors.length < 6 || liveAnchors.length > 12) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchors"],
      message: "A ready A-Rail requires 6 to 12 anchors (non-retired)",
    });
  }

  const plannedAnchors = liveAnchors.filter((anchor) => anchor.state === "planned");
  for (const [plannedIndex, anchor] of plannedAnchors.entries()) {
    const expectedDetail = plannedIndex < 2 ? "compound" : "sparse";
    if (anchor.detailLevel !== expectedDetail) {
      const index = rail.anchors.indexOf(anchor);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchors", index, "detailLevel"],
        message: plannedIndex < 2
          ? "The nearest one or two planned anchors in a ready A-Rail must be compound"
          : "Only the nearest one or two planned anchors may be compound; later planned anchors must be sparse",
      });
    }
  }

  for (const [index, anchor] of rail.anchors.entries()) {
    if (anchor.state === "retired") continue;
    const requiredFields = anchor.state === "reached" || anchor.detailLevel === "compound"
      ? ANCHOR_COMPOUND_READY_FIELDS
      : ANCHOR_SPARSE_READY_FIELDS;
    for (const field of requiredFields) {
      if (!anchor[field].trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", index, field],
          message: `A ready anchor requires non-empty ${field}`,
        });
      }
    }
  }
});
export type AnchorRail = z.infer<typeof AnchorRailSchema>;

export const ArcRouteEntryStatusSchema = z.enum([
  "closed",
  "active",
  "provisional",
  "hypothesis",
  "retired",
]);
export type ArcRouteEntryStatus = z.infer<typeof ArcRouteEntryStatusSchema>;

/**
 * A B-Rail entry deliberately contains only durable route information.
 * Volatile chapter coordinates, beats, characters, scenes, and exact rewards
 * remain in an active ArcPacket rather than becoming distant canon.
 */
export const ArcRouteEntrySchema = z.object({
  bId: StableRailIdSchema,
  routeOrder: RouteOrderSchema,
  status: ArcRouteEntryStatusSchema,
  targetAnchorId: StableRailIdSchema,
  arcId: ArcIdSchema.optional(),
  actualEpisodeCount: ArcActualEpisodeCountSchema.optional(),
  narrativeFunction: z.string(),
  payoffAxis: z.string(),
  carriedReaderDebt: z.string(),
  contrastRequirement: z.string(),
}).strict().superRefine((entry, ctx) => {
  if (entry.status === "closed" && entry.actualEpisodeCount === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actualEpisodeCount"],
      message: "A closed B-Rail entry requires its actual episode count",
    });
  } else if (entry.status !== "closed" && entry.actualEpisodeCount !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actualEpisodeCount"],
      message: "Only a closed B-Rail entry may record an actual episode count",
    });
  }
});
export type ArcRouteEntry = z.infer<typeof ArcRouteEntrySchema>;

export const ArcRouteRailSchema = z.object({
  status: StoryRailReadinessSchema,
  entries: z.array(ArcRouteEntrySchema),
}).strict().superRefine((rail, ctx) => {
  validateUniqueAndIncreasing(
    rail.entries,
    (entry) => entry.bId,
    (entry) => entry.routeOrder,
    ["entries"],
    "B-Rail entry",
    ctx,
  );

  const arcIds = new Map<string, number>();
  for (const [index, entry] of rail.entries.entries()) {
    if (!entry.arcId) continue;
    const previous = arcIds.get(entry.arcId);
    if (previous !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "arcId"],
        message: `Arc id ${JSON.stringify(entry.arcId)} is already bound to entry ${previous + 1}`,
      });
    } else {
      arcIds.set(entry.arcId, index);
    }
  }

  const active = rail.entries.filter((entry) => entry.status === "active");
  const provisional = rail.entries.filter((entry) => entry.status === "provisional");
  if (active.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "A B-Rail can contain at most one active entry",
    });
  }
  if (provisional.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "A B-Rail can contain at most one provisional entry",
    });
  }

  if (rail.status !== "ready") return;
  if (active.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries"],
      message: "A ready B-Rail requires exactly one active entry",
    });
  }

  validateReadyBStatusOrder(rail.entries, ctx);
  for (const [index, entry] of rail.entries.entries()) {
    if (entry.status === "retired") continue;
    for (const field of ARC_ROUTE_DURABLE_FIELDS) {
      if (!entry[field].trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, field],
          message: `A ready B-Rail entry requires non-empty ${field}`,
        });
      }
    }
  }
});
export type ArcRouteRail = z.infer<typeof ArcRouteRailSchema>;

export const StoryRailPlanInputSchema = z.object({
  anchorRail: AnchorRailSchema,
  arcRouteRail: ArcRouteRailSchema,
}).strict();
export type StoryRailPlanInput = z.infer<typeof StoryRailPlanInputSchema>;

export const StoryRailRouteCapacitySchema = z.object({
  targetChaptersSnapshot: z.number().int().min(1),
  // InkOS ArcPacket is deliberately a 1-3 chapter contract. Keep the cap in
  // the plan so the capacity claim is self-contained and versionable.
  arcEpisodeCap: z.literal(3),
}).strict();
export type StoryRailRouteCapacity = z.infer<typeof StoryRailRouteCapacitySchema>;

export const StoryRailPlanSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  anchorRail: AnchorRailSchema,
  arcRouteRail: ArcRouteRailSchema,
  routeCapacity: StoryRailRouteCapacitySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((plan, ctx) => {
  const anchorIds = new Set(plan.anchorRail.anchors.map((anchor) => anchor.id));
  const liveAnchorIds = new Set(
    plan.anchorRail.anchors
      .filter((anchor) => anchor.state !== "retired")
      .map((anchor) => anchor.id),
  );

  for (const [index, entry] of plan.arcRouteRail.entries.entries()) {
    if (!anchorIds.has(entry.targetAnchorId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arcRouteRail", "entries", index, "targetAnchorId"],
        message: `B-Rail target anchor ${JSON.stringify(entry.targetAnchorId)} does not exist`,
      });
    } else if (entry.status !== "retired" && !liveAnchorIds.has(entry.targetAnchorId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arcRouteRail", "entries", index, "targetAnchorId"],
        message: "A live B-Rail entry cannot target a retired anchor",
      });
    }
  }

  if (plan.arcRouteRail.status !== "ready") return;
  if (plan.anchorRail.status !== "ready") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchorRail", "status"],
      message: "A ready B-Rail requires a ready A-Rail",
    });
  }

  const liveEntries = plan.arcRouteRail.entries.filter((entry) => entry.status !== "retired");
  const routedAnchorIds = new Set(liveEntries.map((entry) => entry.targetAnchorId));
  for (const [index, anchor] of plan.anchorRail.anchors.entries()) {
    if (anchor.state !== "retired" && !routedAnchorIds.has(anchor.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchorRail", "anchors", index, "id"],
        message: `Live anchor ${JSON.stringify(anchor.id)} is not represented in the B-Rail`,
      });
    }
  }

  let previousAnchorOrder: number | undefined;
  for (const [index, entry] of plan.arcRouteRail.entries.entries()) {
    if (entry.status === "retired") continue;
    const targetOrder = plan.anchorRail.anchors.find(
      (anchor) => anchor.id === entry.targetAnchorId,
    )?.routeOrder;
    if (targetOrder === undefined) continue;
    if (previousAnchorOrder !== undefined && targetOrder < previousAnchorOrder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["arcRouteRail", "entries", index, "targetAnchorId"],
        message: "Live B-Rail entries must not route backward to an earlier anchor",
      });
    }
    previousAnchorOrder = targetOrder;
  }

  const routeCapacity = plan.arcRouteRail.entries.reduce((total, entry) => {
    if (entry.status === "closed") return total + (entry.actualEpisodeCount ?? 0);
    if (entry.status === "active" || entry.status === "provisional" || entry.status === "hypothesis") {
      return total + plan.routeCapacity.arcEpisodeCap;
    }
    return total;
  }, 0);
  if (routeCapacity < plan.routeCapacity.targetChaptersSnapshot) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["routeCapacity"],
      message: `A ready B-Rail covers at most ${routeCapacity} chapters, below the target snapshot of `
        + `${plan.routeCapacity.targetChaptersSnapshot}`,
    });
  }

  const lastLiveAnchor = maxByRouteOrder(
    plan.anchorRail.anchors.filter((anchor) => anchor.state !== "retired"),
  );
  const lastLiveEntry = maxByRouteOrder(liveEntries);
  if (!lastLiveAnchor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["anchorRail", "anchors"],
      message: "A ready rail plan requires at least one live anchor",
    });
  } else if (!lastLiveEntry) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["arcRouteRail", "entries"],
      message: "A ready rail plan requires at least one live B-Rail entry",
    });
  } else if (lastLiveEntry.targetAnchorId !== lastLiveAnchor.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["arcRouteRail", "entries"],
      message: "The last live B-Rail entry must target the last live anchor",
    });
  }
});
export type StoryRailPlan = z.infer<typeof StoryRailPlanSchema>;

const ANCHOR_COMPOUND_READY_FIELDS = [
  "entryState",
  "trigger",
  "irreversibleChange",
  "humanAftermath",
  "readerDebt",
  "payoffAxis",
  "nextPressure",
] as const satisfies ReadonlyArray<keyof StoryAnchor>;

const ANCHOR_SPARSE_READY_FIELDS = [
  "irreversibleChange",
  "readerDebt",
  "payoffAxis",
  "nextPressure",
] as const satisfies ReadonlyArray<keyof StoryAnchor>;

const ARC_ROUTE_DURABLE_FIELDS = [
  "narrativeFunction",
  "payoffAxis",
  "carriedReaderDebt",
  "contrastRequirement",
] as const satisfies ReadonlyArray<keyof ArcRouteEntry>;

function validateUniqueAndIncreasing<T>(
  values: ReadonlyArray<T>,
  idOf: (value: T) => string,
  orderOf: (value: T) => number,
  path: ReadonlyArray<string | number>,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const [index, value] of values.entries()) {
    const id = idOf(value);
    const order = orderOf(value);
    if (ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "id"],
        message: `${label} ids must be unique: ${JSON.stringify(id)}`,
      });
    }
    if (orders.has(order)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "routeOrder"],
        message: `${label} route orders must be unique: ${order}`,
      });
    }
    if (index > 0 && order <= orderOf(values[index - 1]!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, "routeOrder"],
        message: `${label} route orders must be strictly increasing`,
      });
    }
    ids.add(id);
    orders.add(order);
  }
}

function validateReadyBStatusOrder(
  entries: ReadonlyArray<ArcRouteEntry>,
  ctx: z.RefinementCtx,
): void {
  const liveEntries = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.status !== "retired");
  const activeIndex = liveEntries.findIndex(({ entry }) => entry.status === "active");
  if (activeIndex < 0) return;

  for (const { entry, index } of liveEntries.slice(0, activeIndex)) {
    if (entry.status !== "closed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", index, "status"],
        message: "Before the active B, every non-retired entry must be closed",
      });
    }
  }

  let hypothesisStarted = false;
  let provisionalSeen = false;
  for (const { entry, index } of liveEntries.slice(activeIndex + 1)) {
    if (entry.status === "provisional" && !provisionalSeen && !hypothesisStarted) {
      provisionalSeen = true;
      continue;
    }
    if (entry.status === "hypothesis") {
      hypothesisStarted = true;
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entries", index, "status"],
      message: "After the active B, the ready route allows at most one provisional B followed only by hypotheses",
    });
  }
}

function maxByRouteOrder<T extends { readonly routeOrder: number }>(values: ReadonlyArray<T>): T | undefined {
  return values.reduce<T | undefined>(
    (latest, value) => !latest || value.routeOrder > latest.routeOrder ? value : latest,
    undefined,
  );
}
