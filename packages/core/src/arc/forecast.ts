import type { ForecastBranch, NarrativeForecast } from "../forecast/schema.js";
import type { ChapterArcProvenance } from "../models/chapter.js";
import { ArcPacketSchema, type ArcPacket } from "./schema.js";
import type { ArcStore } from "./store.js";
import type { StoryRailStore } from "./rail-store.js";
import {
  inspectStoryRailRuntimeEligibility,
  renderStoryRailProvenance,
  resolveActiveStoryRailProvenance,
} from "./rail-context.js";

export interface ArcChapterContext {
  readonly markdown: string;
  readonly provenance: ChapterArcProvenance;
}

/**
 * Convert a non-canonical forecast candidate into an editable Arc draft.
 * This is deliberately one-way: choosing a candidate never edits chapters,
 * outline files, or runtime state. The author still explicitly activates it.
 */
export async function createArcDraftFromForecast(input: {
  readonly store: ArcStore;
  readonly forecast: NarrativeForecast;
  readonly branch: ForecastBranch;
  readonly title?: string;
}): Promise<ArcPacket> {
  // Forecasts may legally contain sparse beats. An Arc is deliberately much
  // smaller (1-3 consecutive chapters), so take the first consecutive window
  // instead of making branch selection fail for an otherwise valid forecast.
  const arcBeats = selectConsecutiveArcBeats(input.branch);
  const chapterNumbers = arcBeats.map((beat) => beat.chapter);
  if (chapterNumbers.length === 0) throw new Error("A forecast branch needs at least one beat to become an Arc.");
  const episodeCount = chapterNumbers.length as 1 | 2 | 3;
  const now = input.store.now().toISOString();
  const beatRoles = episodeCount === 1 ? ["payoff"] as const
    : episodeCount === 2 ? ["promise", "payoff"] as const
      : ["promise", "pressure", "payoff"] as const;
  const arc = ArcPacketSchema.parse({
    version: 1,
    id: await input.store.allocateArcId(),
    bookId: input.forecast.bookId,
    title: input.title?.trim() || input.branch.title,
    status: "draft",
    episodeCount,
    chapterNumbers,
    openingState: input.forecast.divergence,
    promise: input.branch.premise,
    goal: arcBeats.at(-1)?.summary ?? input.branch.premise,
    obstacle: input.branch.risks.map((risk) => risk.description).join("\n"),
    pressure: arcBeats.length > 1 ? arcBeats.slice(1).map((beat) => beat.summary).join("\n") : "",
    // Branch-wide projections may describe changes beyond this first 1-3
    // chapter window. Keep them in Forecast/selected-plan provenance instead
    // of promoting distant guesses into the active Arc's must-do contract.
    turn: "",
    payoff: arcBeats.at(-1)?.summary ?? "",
    irreversibleChange: "",
    nextHook: "",
    episodeBeats: arcBeats.map((beat, index) => ({
      chapterNumber: beat.chapter,
      role: beatRoles[index]!,
      beats: [beat.summary],
      endingHook: "",
    })),
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: input.branch.risks.map((risk) => risk.description),
    styleEmphasis: [],
    ...(input.branch.futureAdvantageMove
      ? { futureAdvantageMove: input.branch.futureAdvantageMove }
      : {}),
    sourceForecast: { forecastId: input.forecast.forecastId, branchId: input.branch.branchId },
    createdAt: now,
    updatedAt: now,
  });
  return input.store.save(arc);
}

export function renderArcContext(arc: ArcPacket, chapterNumber: number): string | null {
  return resolveArcChapterContext(arc, chapterNumber)?.markdown ?? null;
}

export function renderChapterArcProvenance(provenance: ChapterArcProvenance): string {
  return [
    ...(provenance.storyRail ? [renderStoryRailProvenance(provenance.storyRail), ""] : []),
    "## Chapter Generation Arc Snapshot",
    `- Book: ${provenance.bookId}`,
    `- Arc: ${provenance.arcTitle} (${provenance.arcId})`,
    `- Arc snapshot updated at: ${provenance.arcUpdatedAt}`,
    provenance.openingState ? `- Opening state: ${provenance.openingState}` : "",
    `- Arc promise: ${provenance.promise}`,
    `- Arc goal: ${provenance.goal}`,
    provenance.obstacle ? `- Obstacle: ${provenance.obstacle}` : "",
    provenance.pressure ? `- Pressure: ${provenance.pressure}` : "",
    provenance.turn ? `- Turn: ${provenance.turn}` : "",
    provenance.payoff ? `- Payoff: ${provenance.payoff}` : "",
    provenance.irreversibleChange
      ? `- Irreversible change: ${provenance.irreversibleChange}`
      : "",
    provenance.nextHook ? `- Next hook: ${provenance.nextHook}` : "",
    `- This episode role: ${provenance.episodeRole}`,
    "- Required beats:",
    ...provenance.beats.map((beat) => `  - ${beat}`),
    provenance.endingHook ? `- Ending hook: ${provenance.endingHook}` : "",
    provenance.characterChanges.length > 0
      ? `- Character changes: ${provenance.characterChanges.join("; ")}`
      : "",
    provenance.relationshipChanges.length > 0
      ? `- Relationship changes: ${provenance.relationshipChanges.join("; ")}`
      : "",
    provenance.worldChanges.length > 0
      ? `- World changes: ${provenance.worldChanges.join("; ")}`
      : "",
    provenance.hookOperations.length > 0
      ? `- Hook operations: ${provenance.hookOperations.join("; ")}`
      : "",
    provenance.mustKeep.length > 0 ? `- Must keep: ${provenance.mustKeep.join("; ")}` : "",
    provenance.mustAvoid.length > 0 ? `- Must avoid: ${provenance.mustAvoid.join("; ")}` : "",
    provenance.styleEmphasis.length > 0
      ? `- Style emphasis: ${provenance.styleEmphasis.join("; ")}`
      : "",
    ...(provenance.futureAdvantageMove
      ? ["", ...renderFutureAdvantageMoveLines(provenance.futureAdvantageMove)]
      : []),
  ].filter(Boolean).join("\n");
}

export function resolveArcChapterContext(
  arc: ArcPacket,
  chapterNumber: number,
  storyRail?: ChapterArcProvenance["storyRail"],
): ArcChapterContext | null {
  const episode = arc.episodeBeats.find((beat) => beat.chapterNumber === chapterNumber);
  if (!episode) return null;
  const markdown = [
    ...(storyRail ? [renderStoryRailProvenance(storyRail), ""] : []),
    "## Active Arc",
    `- Title: ${arc.title}`,
    arc.openingState ? `- Opening state: ${arc.openingState}` : "",
    `- Arc promise: ${arc.promise}`,
    `- Arc goal: ${arc.goal}`,
    arc.obstacle ? `- Obstacle: ${arc.obstacle}` : "",
    arc.pressure ? `- Pressure: ${arc.pressure}` : "",
    arc.turn ? `- Turn: ${arc.turn}` : "",
    arc.payoff ? `- Payoff: ${arc.payoff}` : "",
    arc.irreversibleChange ? `- Irreversible change: ${arc.irreversibleChange}` : "",
    arc.nextHook ? `- Next hook: ${arc.nextHook}` : "",
    `- This episode role: ${episode.role}`,
    "- Required beats:",
    ...episode.beats.map((beat) => `  - ${beat}`),
    episode.endingHook ? `- Ending hook: ${episode.endingHook}` : "",
    arc.characterChanges.length > 0 ? `- Character changes: ${arc.characterChanges.join("; ")}` : "",
    arc.relationshipChanges.length > 0
      ? `- Relationship changes: ${arc.relationshipChanges.join("; ")}`
      : "",
    arc.worldChanges.length > 0 ? `- World changes: ${arc.worldChanges.join("; ")}` : "",
    arc.hookOperations.length > 0 ? `- Hook operations: ${arc.hookOperations.join("; ")}` : "",
    arc.mustKeep.length > 0 ? `- Must keep: ${arc.mustKeep.join("; ")}` : "",
    arc.mustAvoid.length > 0 ? `- Must avoid: ${arc.mustAvoid.join("; ")}` : "",
    arc.styleEmphasis.length > 0 ? `- Style emphasis: ${arc.styleEmphasis.join("; ")}` : "",
    ...(arc.futureAdvantageMove
      ? ["", ...renderFutureAdvantageMoveLines(arc.futureAdvantageMove)]
      : []),
  ].filter(Boolean).join("\n");
  const provenance: ChapterArcProvenance = {
    version: 1,
    bookId: arc.bookId,
    arcId: arc.id,
    arcUpdatedAt: arc.updatedAt,
    arcTitle: arc.title,
    chapterNumber,
    episodeRole: episode.role,
    openingState: arc.openingState,
    promise: arc.promise,
    goal: arc.goal,
    obstacle: arc.obstacle,
    pressure: arc.pressure,
    turn: arc.turn,
    payoff: arc.payoff,
    irreversibleChange: arc.irreversibleChange,
    nextHook: arc.nextHook,
    beats: [...episode.beats],
    endingHook: episode.endingHook,
    characterChanges: [...arc.characterChanges],
    relationshipChanges: [...arc.relationshipChanges],
    worldChanges: [...arc.worldChanges],
    hookOperations: [...arc.hookOperations],
    mustKeep: [...arc.mustKeep],
    mustAvoid: [...arc.mustAvoid],
    styleEmphasis: [...arc.styleEmphasis],
    ...(arc.futureAdvantageMove
      ? { futureAdvantageMove: structuredClone(arc.futureAdvantageMove) }
      : {}),
    ...(arc.sourceForecast ? { sourceForecast: { ...arc.sourceForecast } } : {}),
    ...(storyRail ? { storyRail } : {}),
  };
  return { markdown, provenance };
}

function renderFutureAdvantageMoveLines(
  move: NonNullable<ArcPacket["futureAdvantageMove"]>,
): string[] {
  return [
    "## Future Advantage Move",
    `- Move: ${move.moveId}`,
    `- Mode / domain: ${move.mode} / ${move.domain}`,
    `- Target: ${move.target}`,
    `- Remembered outcome: ${move.rememberedOutcome}`,
    ...(move.baselineQuestions.length > 0
      ? [`- Baseline questions: ${move.baselineQuestions.join("; ")}`]
      : []),
    `- A-Rail bridge: ${move.bridgeSteps.join("; ")}`,
    `- A-Rail proof: ${move.proof}`,
    `- A-Rail reward: ${move.reward}`,
    ...(move.resistance.length > 0
      ? [`- B-Rail resistance: ${move.resistance.join("; ")}`]
      : []),
    ...(move.downstreamConsequences.length > 0
      ? [`- B-Rail aftermath: ${move.downstreamConsequences.join("; ")}`]
      : []),
  ];
}

/**
 * Resolve optional Arc context without letting a missing/corrupt Arc disable
 * the legacy Book -> Chapter generation path.
 */
export async function loadOptionalActiveArcContext(input: {
  readonly store: ArcStore;
  readonly railStore?: StoryRailStore;
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly targetChapters: number;
  readonly onWarning?: (message: string) => void;
}): Promise<ArcChapterContext | null> {
  try {
    const activeArc = await input.store.getActive();
    if (activeArc && activeArc.bookId !== input.bookId) {
      throw new Error(
        `Active Arc belongs to book ${JSON.stringify(activeArc.bookId)}, not ${JSON.stringify(input.bookId)}.`,
      );
    }
    if (!activeArc) return null;

    let storyRail: ChapterArcProvenance["storyRail"];
    if (input.railStore) {
      try {
        const plan = await input.railStore.loadOptional(input.bookId, input.onWarning);
        if (plan) {
          const eligibility = inspectStoryRailRuntimeEligibility(
            plan,
            activeArc.id,
            input.targetChapters,
          );
          if (eligibility.status === "bound") {
            storyRail = resolveActiveStoryRailProvenance({
              plan,
              bookId: input.bookId,
              activeArcId: activeArc.id,
              targetChapters: input.targetChapters,
            }) ?? undefined;
          } else if (eligibility.status === "not-ready") {
            input.onWarning?.(
              "[rail] A-Rail and B-Rail must both be ready before they can guide production; "
              + "Rail context was ignored.",
            );
          } else if (eligibility.status === "target-chapters-stale") {
            input.onWarning?.(
              `[rail] Route capacity targets ${eligibility.targetChaptersSnapshot} chapters, `
              + `but the Book currently targets ${eligibility.currentTargetChapters}; Rail context was ignored.`,
            );
          } else if (eligibility.status === "active-b-conflict") {
            input.onWarning?.(
              `[rail] Active B ${JSON.stringify(eligibility.bId)} is bound to Arc ${JSON.stringify(eligibility.boundArcId)}, `
              + `not runtime Arc ${JSON.stringify(activeArc.id)}; Rail context was ignored.`,
            );
          } else if (eligibility.status === "active-b-unbound") {
            input.onWarning?.(
              `[rail] Active B ${JSON.stringify(eligibility.bId)} is not bound to runtime Arc ${JSON.stringify(activeArc.id)}; `
              + "Rail context was ignored.",
            );
          } else {
            input.onWarning?.(
              "[rail] Ready B-Rail has no active B bound to the runtime Arc; Rail context was ignored.",
            );
          }
        }
      } catch (error) {
        input.onWarning?.(
          `[rail] Optional story Rail context failed and was ignored: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return resolveArcChapterContext(activeArc, input.chapterNumber, storyRail);
  } catch (error) {
    input.onWarning?.(
      `[arc] Optional active Arc could not be loaded and was ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function selectConsecutiveArcBeats(branch: ForecastBranch): ForecastBranch["beats"] {
  const first = branch.beats[0];
  if (!first) return [];
  const selected = [first];
  for (const beat of branch.beats.slice(1)) {
    if (selected.length >= 3 || beat.chapter !== selected[selected.length - 1]!.chapter + 1) break;
    selected.push(beat);
  }
  return selected;
}
