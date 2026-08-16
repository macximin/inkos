import {
  ChapterStoryRailProvenanceSchema,
  type ChapterStoryRailProvenance,
} from "../models/chapter.js";
import type { StoryRailPlan } from "./rail-schema.js";

export type StoryRailBindingStatus =
  | "bound"
  | "missing-active-b"
  | "active-b-unbound"
  | "active-b-conflict";

export interface StoryRailBindingInspection {
  readonly status: StoryRailBindingStatus;
  readonly bId?: string;
  readonly boundArcId?: string;
}

export type StoryRailRuntimeStatus =
  | StoryRailBindingStatus
  | "not-ready"
  | "target-chapters-stale";

export interface StoryRailRuntimeInspection {
  readonly status: StoryRailRuntimeStatus;
  readonly bId?: string;
  readonly boundArcId?: string;
  readonly targetChaptersSnapshot?: number;
  readonly currentTargetChapters?: number;
}

/**
 * Inspect the optional B-Rail mapping without changing either the route or
 * ArcStore. story/arcs/active.json remains the only runtime Arc pointer.
 */
export function inspectStoryRailBinding(
  plan: StoryRailPlan,
  activeArcId: string,
): StoryRailBindingInspection {
  const activeB = plan.arcRouteRail.entries.find((entry) => entry.status === "active");
  if (!activeB) return { status: "missing-active-b" };
  if (!activeB.arcId) return { status: "active-b-unbound", bId: activeB.bId };
  if (activeB.arcId !== activeArcId) {
    return {
      status: "active-b-conflict",
      bId: activeB.bId,
      boundArcId: activeB.arcId,
    };
  }
  return { status: "bound", bId: activeB.bId, boundArcId: activeB.arcId };
}

/**
 * A Rail may guide production only when both editable planning layers are
 * explicitly ready, its route capacity was calculated for the Book's current
 * target length, and its active B is bound to the exact runtime Arc.
 */
export function inspectStoryRailRuntimeEligibility(
  plan: StoryRailPlan,
  activeArcId: string,
  currentTargetChapters: number,
): StoryRailRuntimeInspection {
  if (plan.anchorRail.status !== "ready" || plan.arcRouteRail.status !== "ready") {
    return { status: "not-ready" };
  }
  if (plan.routeCapacity.targetChaptersSnapshot !== currentTargetChapters) {
    return {
      status: "target-chapters-stale",
      targetChaptersSnapshot: plan.routeCapacity.targetChaptersSnapshot,
      currentTargetChapters,
    };
  }
  return inspectStoryRailBinding(plan, activeArcId);
}

/** Resolve only the active B and its target Anchor for an exact active Arc. */
export function resolveActiveStoryRailProvenance(input: {
  readonly plan: StoryRailPlan;
  readonly bookId: string;
  readonly activeArcId: string;
  readonly targetChapters: number;
}): ChapterStoryRailProvenance | null {
  if (input.plan.bookId !== input.bookId) {
    throw new Error(
      `Story rail plan belongs to book ${JSON.stringify(input.plan.bookId)}, not ${JSON.stringify(input.bookId)}.`,
    );
  }

  if (
    inspectStoryRailRuntimeEligibility(input.plan, input.activeArcId, input.targetChapters).status
    !== "bound"
  ) return null;

  const activeB = input.plan.arcRouteRail.entries.find((entry) => entry.status === "active");
  if (!activeB?.arcId || activeB.arcId !== input.activeArcId) return null;
  const anchor = input.plan.anchorRail.anchors.find((candidate) => candidate.id === activeB.targetAnchorId);
  if (!anchor || anchor.state === "retired") return null;
  const nextB = input.plan.arcRouteRail.entries.find((entry) => entry.status === "provisional");

  return ChapterStoryRailProvenanceSchema.parse({
    planUpdatedAt: input.plan.updatedAt,
    anchor: { ...anchor },
    activeB: {
      bId: activeB.bId,
      routeOrder: activeB.routeOrder,
      status: "active",
      targetAnchorId: activeB.targetAnchorId,
      narrativeFunction: activeB.narrativeFunction,
      payoffAxis: activeB.payoffAxis,
      carriedReaderDebt: activeB.carriedReaderDebt,
      contrastRequirement: activeB.contrastRequirement,
    },
    ...(nextB
      ? {
          nextB: {
            bId: nextB.bId,
            routeOrder: nextB.routeOrder,
            status: "provisional" as const,
            targetAnchorId: nextB.targetAnchorId,
            narrativeFunction: nextB.narrativeFunction,
            payoffAxis: nextB.payoffAxis,
            carriedReaderDebt: nextB.carriedReaderDebt,
            contrastRequirement: nextB.contrastRequirement,
          },
        }
      : {}),
  });
}

/** Render the immutable local A/B slice stored with a generated Chapter. */
export function renderStoryRailProvenance(snapshot: ChapterStoryRailProvenance): string {
  const { anchor, activeB, nextB } = snapshot;
  return [
    "## Story Plan Rails Snapshot",
    "- Authority: editable future planning only; Book canon, hard rules, written chapters, and explicit user direction remain higher.",
    `- Plan snapshot updated at: ${snapshot.planUpdatedAt}`,
    `- A-Rail destination: ${anchor.title} (${anchor.id})`,
    anchor.entryState ? `- Anchor entry state: ${anchor.entryState}` : "",
    anchor.trigger ? `- Anchor trigger: ${anchor.trigger}` : "",
    anchor.irreversibleChange ? `- Anchor irreversible change: ${anchor.irreversibleChange}` : "",
    anchor.humanAftermath ? `- Anchor human aftermath: ${anchor.humanAftermath}` : "",
    anchor.readerDebt ? `- Anchor reader debt/payoff: ${anchor.readerDebt}` : "",
    anchor.payoffAxis ? `- Anchor payoff axis: ${anchor.payoffAxis}` : "",
    anchor.nextPressure ? `- Pressure after Anchor: ${anchor.nextPressure}` : "",
    `- Active B: ${activeB.bId}`,
    activeB.narrativeFunction ? `- B narrative function: ${activeB.narrativeFunction}` : "",
    activeB.payoffAxis ? `- B payoff axis: ${activeB.payoffAxis}` : "",
    activeB.carriedReaderDebt ? `- B carried reader debt: ${activeB.carriedReaderDebt}` : "",
    activeB.contrastRequirement ? `- B contrast requirement: ${activeB.contrastRequirement}` : "",
    ...(nextB
      ? [
          `- Next provisional B: ${nextB.bId} → ${nextB.targetAnchorId}`,
          nextB.narrativeFunction ? `- Next B narrative function: ${nextB.narrativeFunction}` : "",
          nextB.payoffAxis ? `- Next B payoff axis: ${nextB.payoffAxis}` : "",
          nextB.carriedReaderDebt ? `- Next B carried reader debt: ${nextB.carriedReaderDebt}` : "",
          nextB.contrastRequirement ? `- Next B contrast requirement: ${nextB.contrastRequirement}` : "",
        ]
      : []),
  ].filter(Boolean).join("\n");
}

/** Render the whole editable future plan for Forecast comparison and review. */
export function renderStoryRailPlan(plan: StoryRailPlan): string {
  const maximumRoutedChapterCapacity = plan.arcRouteRail.entries.reduce((total, entry) => {
    if (entry.status === "closed") return total + (entry.actualEpisodeCount ?? 0);
    if (entry.status === "active" || entry.status === "provisional" || entry.status === "hypothesis") {
      return total + plan.routeCapacity.arcEpisodeCap;
    }
    return total;
  }, 0);
  const anchors = plan.anchorRail.anchors.flatMap((anchor) => [
    `### ${anchor.id} · ${anchor.title} [${anchor.state}/${anchor.detailLevel}]`,
    anchor.entryState ? `- Entry: ${anchor.entryState}` : "",
    anchor.trigger ? `- Trigger: ${anchor.trigger}` : "",
    anchor.irreversibleChange ? `- Irreversible change: ${anchor.irreversibleChange}` : "",
    anchor.humanAftermath ? `- Human aftermath: ${anchor.humanAftermath}` : "",
    anchor.readerDebt ? `- Reader debt/payoff: ${anchor.readerDebt}` : "",
    anchor.payoffAxis ? `- Payoff axis: ${anchor.payoffAxis}` : "",
    anchor.nextPressure ? `- Next pressure: ${anchor.nextPressure}` : "",
  ].filter(Boolean));
  const entries = plan.arcRouteRail.entries.flatMap((entry) => [
    `### ${entry.bId} [${entry.status}] → ${entry.targetAnchorId}`,
    entry.arcId ? `- Bound Arc: ${entry.arcId}` : "",
    entry.actualEpisodeCount !== undefined
      ? `- Actual episode count: ${entry.actualEpisodeCount}`
      : "",
    entry.narrativeFunction ? `- Narrative function: ${entry.narrativeFunction}` : "",
    entry.payoffAxis ? `- Payoff axis: ${entry.payoffAxis}` : "",
    entry.carriedReaderDebt ? `- Carried reader debt: ${entry.carriedReaderDebt}` : "",
    entry.contrastRequirement ? `- Contrast requirement: ${entry.contrastRequirement}` : "",
  ].filter(Boolean));

  return [
    "# Editable Story Rails",
    `- Book: ${plan.bookId}`,
    `- Updated at: ${plan.updatedAt}`,
    `- A-Rail readiness: ${plan.anchorRail.status}`,
    `- B-Rail readiness: ${plan.arcRouteRail.status}`,
    `- Target chapters snapshot: ${plan.routeCapacity.targetChaptersSnapshot}`,
    `- Arc episode cap: ${plan.routeCapacity.arcEpisodeCap}`,
    `- Maximum routed chapter capacity: ${maximumRoutedChapterCapacity}`,
    "- This is future planning material, not already-written canon.",
    "",
    "## A-Rail · long-horizon irreversible destinations",
    ...anchors,
    "",
    "## B-Rail · route of Story Arc(B) units",
    ...entries,
  ].join("\n");
}
