// Focused fixture derived from the existing StoryRailReflowStore tests.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterArcProvenance, ChapterMeta } from "../../models/chapter.js";
import type { ArcPacket } from "../../arc/schema.js";
import type { ArcRouteEntry, StoryRailPlan, StoryRailPlanInput } from "../../arc/rail-schema.js";
import { StoryRailStore } from "../../arc/rail-store.js";
import { StoryRailReflowStore } from "../../arc/reflow-store.js";
import { ArcStore } from "../../arc/store.js";
import { writeChapterTruthReceipt } from "../../state/chapter-truth-receipt.js";

export async function installReadyFixture(
  bookDir: string,
  options: { readonly stateThrough?: number } = {},
): Promise<{ readonly plan: StoryRailPlan; readonly arc: ArcPacket; readonly chapters: ChapterMeta[] }> {
  const railStore = new StoryRailStore(bookDir, {
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  });
  await railStore.replace("book-a", makeReadyInput());
  const arcStore = new ArcStore(bookDir, {
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  });
  const arc = await arcStore.save(makeArc());
  await arcStore.setActive(arc.id);
  await railStore.bindActiveArc("book-a", arc.id);
  const plan = (await railStore.load())!;
  await writeStateManifest(bookDir, options.stateThrough ?? 2);
  const chapters = arc.chapterNumbers.map((chapterNumber) => makeChapter(chapterNumber, plan, arc));
  await installChapterTruthReceipts(bookDir, chapters);
  return {
    plan,
    arc,
    chapters,
  };
}

function makeReflowStore(bookDir: string): StoryRailReflowStore {
  return new StoryRailReflowStore(bookDir, {
    now: () => new Date("2026-08-09T11:00:00.000Z"),
    idFactory: () => "reflow-one",
  });
}

async function writeStateManifest(bookDir: string, chapter: number): Promise<void> {
  const stateDir = join(bookDir, "story", "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "manifest.json"), stateManifestContent(chapter), "utf8");
}

async function installChapterTruthReceipts(
  bookDir: string,
  chapters: ReadonlyArray<ChapterMeta>,
): Promise<void> {
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  for (const chapter of chapters) {
    await writeFile(
      join(bookDir, "chapters", `${String(chapter.number).padStart(4, "0")}_Chapter_${chapter.number}.md`),
      `# Chapter ${chapter.number}\n\n지훈은 계약서의 퇴근 시간을 여섯 시로 고쳤다. 딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.`,
      "utf8",
    );
    const snapshotStateDir = join(bookDir, "story", "snapshots", String(chapter.number), "state");
    await mkdir(snapshotStateDir, { recursive: true });
    await writeFile(join(snapshotStateDir, "manifest.json"), stateManifestContent(chapter.number), "utf8");
    await writeChapterTruthReceipt(bookDir, "book-a", chapter, () => new Date("2026-08-09T10:10:00.000Z"));
  }
}

function stateManifestContent(chapter: number): string {
  return JSON.stringify({
    schemaVersion: 2,
    language: "en",
    lastAppliedChapter: chapter,
    projectionVersion: 1,
    migrationWarnings: [],
  });
}

export function makeReadyInput(): StoryRailPlanInput {
  const anchors = Array.from({ length: 6 }, (_, index) => makeAnchor(index + 1));
  return {
    anchorRail: { status: "ready", anchors },
    arcRouteRail: {
      status: "ready",
      entries: Array.from({ length: 6 }, (_, index) => makeBEntry(
        index + 1,
        index === 0 ? "active" : index === 1 ? "provisional" : "hypothesis",
        `A0${index + 1}`,
      )),
    },
  };
}

function makeAnchor(number: number) {
  return {
    id: `A0${number}`,
    routeOrder: number * 100,
    title: `Anchor ${number}`,
    detailLevel: number <= 2 ? "compound" as const : "sparse" as const,
    state: "planned" as const,
    entryState: `Entry ${number}`,
    trigger: `Trigger ${number}`,
    irreversibleChange: `Change ${number}`,
    humanAftermath: `Aftermath ${number}`,
    readerDebt: `Debt ${number}`,
    payoffAxis: `Payoff ${number}`,
    nextPressure: `Pressure ${number}`,
  };
}

function makeBEntry(
  number: number,
  status: ArcRouteEntry["status"],
  targetAnchorId: string,
): ArcRouteEntry {
  return {
    bId: `B00${number}`,
    routeOrder: number * 100,
    status,
    targetAnchorId,
    narrativeFunction: `Function ${number}`,
    payoffAxis: `Payoff ${number}`,
    carriedReaderDebt: `Debt ${number}`,
    contrastRequirement: `Contrast ${number}`,
  };
}

function makeArc(): ArcPacket {
  return {
    version: 1,
    id: "arc-active",
    bookId: "book-a",
    title: "First contract",
    status: "ready",
    episodeCount: 2,
    chapterNumbers: [1, 2],
    openingState: "The debt collector arrives.",
    promise: "Close the first contract.",
    goal: "Secure the client.",
    obstacle: "The terms are hidden.",
    pressure: "The deadline is tonight.",
    turn: "The protagonist accepts a visible cost.",
    payoff: "The first contract closes.",
    irreversibleChange: "A client relationship now exists.",
    nextHook: "The next order is larger.",
    episodeBeats: [
      { chapterNumber: 1, role: "promise", beats: ["Make the promise visible."], endingHook: "The terms change." },
      { chapterNumber: 2, role: "payoff", beats: ["Close the contract."], endingHook: "A larger order arrives." },
    ],
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
  };
}

function makeChapter(number: number, plan: StoryRailPlan, arc: ArcPacket): ChapterMeta {
  return {
    number,
    title: `Chapter ${number}`,
    status: "approved",
    wordCount: 2200,
    createdAt: `2026-08-09T09:0${number}:00.000Z`,
    updatedAt: `2026-08-09T10:0${number}:00.000Z`,
    auditIssues: [],
    lengthWarnings: [],
    arcProvenance: makeProvenance(number, plan, arc),
  };
}

function makeProvenance(number: number, plan: StoryRailPlan, arc: ArcPacket): ChapterArcProvenance {
  const activeB = plan.arcRouteRail.entries[0]!;
  const nextB = plan.arcRouteRail.entries[1]!;
  const anchor = plan.anchorRail.anchors[0]!;
  const beat = arc.episodeBeats.find((candidate) => candidate.chapterNumber === number)!;
  return {
    version: 1,
    bookId: "book-a",
    arcId: arc.id,
    arcUpdatedAt: arc.updatedAt,
    arcTitle: arc.title,
    chapterNumber: number,
    episodeRole: beat.role,
    openingState: arc.openingState,
    promise: arc.promise,
    goal: arc.goal,
    obstacle: arc.obstacle,
    pressure: arc.pressure,
    turn: arc.turn,
    payoff: arc.payoff,
    irreversibleChange: arc.irreversibleChange,
    nextHook: arc.nextHook,
    beats: beat.beats,
    endingHook: beat.endingHook,
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    storyRail: {
      planUpdatedAt: plan.updatedAt,
      anchor,
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
      nextB: {
        bId: nextB.bId,
        routeOrder: nextB.routeOrder,
        status: "provisional",
        targetAnchorId: nextB.targetAnchorId,
        narrativeFunction: nextB.narrativeFunction,
        payoffAxis: nextB.payoffAxis,
        carriedReaderDebt: nextB.carriedReaderDebt,
        contrastRequirement: nextB.contrastRequirement,
      },
    },
  };
}

export function makeApplyInput(pendingId: string, expectedPlanUpdatedAt: string) {
  return {
    pendingId,
    expectedPlanUpdatedAt,
    closeout: {
      startState: "The debt collector arrived.",
      actualOutcome: "The protagonist paid a visible cost and secured the first client.",
      irreversibleSettlement: "The client relationship and payment history now exist.",
      humanRemainder: "The family now expects the protagonist to carry the next order.",
      readerDebt: {
        paid: ["The first contract closed."],
        carried: ["Can the operation scale?"],
        retired: [],
        emerged: ["Who sent the larger order?"],
      },
      emergence: ["The client introduced a larger buyer."],
      anchorImpact: {
        anchorId: "A01",
        decision: "keep" as const,
        reason: "The first contract advances the existing A01 direction without changing it.",
      },
      stateThroughChapter: 2,
    },
    nextActiveBId: "B002",
    nextProvisionalBId: "B003",
    decisions: [2, 3, 4, 5, 6].map((number) => ({
      bId: `B00${number}`,
      action: "keep" as const,
    })),
    newEntries: [makeBEntry(7, "hypothesis", "A06")],
  };
}
