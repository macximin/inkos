import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterArcProvenance, ChapterMeta } from "../models/chapter.js";
import type { ArcPacket } from "../arc/schema.js";
import type { ArcRouteEntry, StoryRailPlan, StoryRailPlanInput } from "../arc/rail-schema.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { StoryRailReflowStore } from "../arc/reflow-store.js";
import { ArcStore } from "../arc/store.js";
import { writeChapterTruthReceipt } from "../state/chapter-truth-receipt.js";

describe("StoryRailReflowStore", () => {
  let bookDir: string;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "inkos-story-rail-reflow-"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "book-a",
      title: "Book A",
      platform: "qidian",
      genre: "urban",
      status: "active",
      targetChapters: 18,
      chapterWordCount: 2200,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }), "utf8");
  });

  afterEach(async () => {
    await rm(bookDir, { recursive: true, force: true });
  });

  it("prepares an immutable pending closeout without closing or promoting anything", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const planBefore = await readFile(new StoryRailStore(bookDir).planPath, "utf8");
    const arcBefore = await readFile(new ArcStore(bookDir).arcPath(fixture.arc.id), "utf8");
    const activeBefore = await readFile(new ArcStore(bookDir).activePath, "utf8");

    const result = await store.prepare("book-a", fixture.chapters);

    expect(result).toMatchObject({
      status: "pending",
      pending: {
        pendingId: "reflow-one",
        expectedPlanUpdatedAt: fixture.plan.updatedAt,
        activeB: { bId: "B001", arcId: fixture.arc.id },
        endpointChapterNumber: 2,
        actualEpisodeCount: 2,
        stateEvidence: { lastAppliedChapter: 2, projectionVersion: 1 },
      },
    });
    await expect(store.getPending("book-a")).resolves.toMatchObject({ pendingId: "reflow-one" });
    expect(await readFile(store.requestPath("reflow-one"), "utf8")).toContain('"status": "pending"');
    expect(await readFile(new StoryRailStore(bookDir).planPath, "utf8")).toBe(planBefore);
    expect(await readFile(new ArcStore(bookDir).arcPath(fixture.arc.id), "utf8")).toBe(arcBefore);
    expect(await readFile(new ArcStore(bookDir).activePath, "utf8")).toBe(activeBefore);

    const repeated = await store.prepare("book-a", fixture.chapters);
    expect(repeated).toMatchObject({ status: "already-pending", pending: { pendingId: "reflow-one" } });
  });

  it("derives an explicit early-close span from approved consecutive evidence", async () => {
    const fixture = await installReadyFixture(bookDir, { stateThrough: 1 });
    const onlyFirst = fixture.chapters.slice(0, 1);

    const result = await makeReflowStore(bookDir).prepare("book-a", onlyFirst, {
      endpointChapterNumber: 1,
    });

    expect(result).toMatchObject({
      status: "pending",
      pending: { endpointChapterNumber: 1, actualEpisodeCount: 1 },
    });
  });

  it("fails closed for stale state or mismatched provenance while leaving all Rail files untouched", async () => {
    const fixture = await installReadyFixture(bookDir, { stateThrough: 1 });
    const store = makeReflowStore(bookDir);
    const planBefore = await readFile(new StoryRailStore(bookDir).planPath, "utf8");

    await expect(store.prepare("book-a", fixture.chapters)).resolves.toMatchObject({
      status: "not-eligible",
      reason: "state-not-fresh",
    });
    await expect(access(store.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });

    await writeStateManifest(bookDir, 2);
    const mismatched = fixture.chapters.map((chapter, index) => index === 0
      ? {
          ...chapter,
          arcProvenance: { ...chapter.arcProvenance!, arcId: "arc-other" },
        }
      : chapter);
    await expect(store.prepare("book-a", mismatched)).resolves.toMatchObject({
      status: "not-eligible",
      reason: "chapter-provenance-mismatch",
    });
    expect(await readFile(new StoryRailStore(bookDir).planPath, "utf8")).toBe(planBefore);
    await expect(access(store.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create an unapplyable pending gate when Book target capacity changed", async () => {
    const fixture = await installReadyFixture(bookDir);
    const rawBook = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      ...rawBook,
      targetChapters: 19,
      updatedAt: "2026-08-09T10:30:00.000Z",
    }), "utf8");
    const store = makeReflowStore(bookDir);

    await expect(store.prepare("book-a", fixture.chapters)).resolves.toMatchObject({
      status: "not-eligible",
      reason: "target-chapters-stale",
      message: expect.stringContaining("now targets 19"),
    });
    await expect(access(store.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects duplicate Chapter evidence before writing a pending request", async () => {
    const fixture = await installReadyFixture(bookDir);
    const duplicated = [...fixture.chapters, { ...fixture.chapters[0]! }];
    const store = makeReflowStore(bookDir);

    await expect(store.prepare("book-a", duplicated)).resolves.toMatchObject({
      status: "not-eligible",
      reason: "chapter-evidence-ambiguous",
      message: expect.stringContaining("appears 2 times"),
    });
    await expect(access(store.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects edited manuscript content when narrative state still reflects the old Chapter", async () => {
    const fixture = await installReadyFixture(bookDir);
    await writeFile(join(bookDir, "chapters", "0002_Chapter_2.md"), "# Chapter 2\n\nManually changed.", "utf8");

    await expect(makeReflowStore(bookDir).prepare("book-a", fixture.chapters)).resolves.toMatchObject({
      status: "not-eligible",
      reason: "state-not-fresh",
      message: expect.stringContaining("truth-settlement receipt"),
    });
  });

  it("atomically applies explicit decisions, closes history, completes the Arc, and clears a stale active pointer", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", fixture.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const keptBefore = fixture.plan.arcRouteRail.entries.find((entry) => entry.bId === "B004")!;

    const result = await store.apply("book-a", fixture.chapters, makeApplyInput(
      prepared.pending.pendingId,
      prepared.pending.expectedPlanUpdatedAt,
    ));

    expect(result.plan.arcRouteRail.entries.map((entry) => [entry.bId, entry.status])).toEqual([
      ["B001", "closed"],
      ["B002", "active"],
      ["B003", "provisional"],
      ["B004", "hypothesis"],
      ["B005", "hypothesis"],
      ["B006", "hypothesis"],
      ["B007", "hypothesis"],
    ]);
    expect(result.plan.arcRouteRail.entries[0]).toMatchObject({
      bId: "B001",
      arcId: fixture.arc.id,
      actualEpisodeCount: 2,
    });
    expect(result.plan.arcRouteRail.entries.find((entry) => entry.bId === "B004")).toEqual(keptBefore);
    await expect(new ArcStore(bookDir).load(fixture.arc.id)).resolves.toMatchObject({ status: "completed" });
    await expect(access(new ArcStore(bookDir).activePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(store.pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.getReceipt("book-a", "B001")).resolves.toMatchObject({
      pendingId: prepared.pending.pendingId,
      closedB: { bId: "B001", actualEpisodeCount: 2 },
      nextActiveBId: "B002",
      nextProvisionalBId: "B003",
      newEntryIds: ["B007"],
      evidence: {
        expectedPlanUpdatedAt: prepared.pending.expectedPlanUpdatedAt,
        approvedChapters: prepared.pending.approvedChapters,
        stateEvidence: prepared.pending.stateEvidence,
      },
    });
  });

  it("records an early close as the Arc's actual completed span", async () => {
    const fixture = await installReadyFixture(bookDir, { stateThrough: 1 });
    const chapters = fixture.chapters.slice(0, 1);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", chapters, { endpointChapterNumber: 1 });
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const input = makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt);
    input.closeout.stateThroughChapter = 1;

    await store.apply("book-a", chapters, input);

    await expect(new ArcStore(bookDir).load(fixture.arc.id)).resolves.toMatchObject({
      status: "completed",
      episodeCount: 1,
      chapterNumbers: [1],
      episodeBeats: [expect.objectContaining({ chapterNumber: 1 })],
    });
  });

  it("does not silently demote the current provisional when another B is selected active", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", fixture.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const input = makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt);
    input.nextActiveBId = "B003";
    input.nextProvisionalBId = "B004";

    await expect(store.apply("book-a", fixture.chapters, input)).rejects.toThrow(/cannot be silently demoted/i);
    await expect(new ArcStore(bookDir).load(fixture.arc.id)).resolves.toMatchObject({ status: "ready" });
    await expect(store.getPending("book-a")).resolves.toMatchObject({ pendingId: prepared.pending.pendingId });
  });

  it("invalidates a prebound future Arc and requires a fresh post-close selection", async () => {
    const fixture = await installReadyFixture(bookDir);
    const railStore = new StoryRailStore(bookDir);
    const nextArc = await new ArcStore(bookDir).save({
      ...makeArc(),
      id: "arc-overlap",
      chapterNumbers: [2, 3],
      episodeBeats: [
        { chapterNumber: 2, role: "promise", beats: ["Overlap."], endingHook: "Still overlaps." },
        { chapterNumber: 3, role: "payoff", beats: ["Continue."], endingHook: "Continue." },
      ],
    });
    const rebound = structuredClone(fixture.plan);
    rebound.arcRouteRail.entries[1]!.arcId = nextArc.id;
    rebound.updatedAt = "2026-08-09T10:20:00.000Z";
    await railStore.save(rebound);
    const chapters = fixture.chapters.map((chapter) => ({
      ...chapter,
      arcProvenance: {
        ...chapter.arcProvenance!,
        storyRail: {
          ...chapter.arcProvenance!.storyRail!,
          planUpdatedAt: rebound.updatedAt,
        },
      },
    }));
    await installChapterTruthReceipts(bookDir, chapters);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);

    const applied = await store.apply(
      "book-a",
      chapters,
      makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt),
    );

    expect(applied.plan.arcRouteRail.entries.find((entry) => entry.bId === "B002"))
      .not.toHaveProperty("arcId");
    expect(applied.receipt.invalidatedFutureArcBindings).toEqual([{
      bId: "B002",
      arcId: nextArc.id,
    }]);
    await expect(new ArcStore(bookDir).load(nextArc.id)).resolves.toMatchObject({ status: "ready" });
    await expect(access(new ArcStore(bookDir).activePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects incomplete future decisions and CAS drift before changing any file", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", fixture.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const planPath = new StoryRailStore(bookDir).planPath;
    const arcPath = new ArcStore(bookDir).arcPath(fixture.arc.id);
    const before = {
      plan: await readFile(planPath, "utf8"),
      arc: await readFile(arcPath, "utf8"),
      pending: await readFile(store.pendingPath, "utf8"),
    };

    const incomplete = makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt);
    incomplete.decisions = incomplete.decisions.filter((decision) => decision.bId !== "B006");
    await expect(store.apply("book-a", fixture.chapters, incomplete)).rejects.toThrow(/exactly one explicit/i);
    expect(await readFile(planPath, "utf8")).toBe(before.plan);
    expect(await readFile(arcPath, "utf8")).toBe(before.arc);
    expect(await readFile(store.pendingPath, "utf8")).toBe(before.pending);

    const stale = makeApplyInput(prepared.pending.pendingId, "2026-08-09T23:00:00.000Z");
    await expect(store.apply("book-a", fixture.chapters, stale)).rejects.toThrow(/does not match the pending plan/i);
    expect(await readFile(planPath, "utf8")).toBe(before.plan);
    expect(await readFile(arcPath, "utf8")).toBe(before.arc);
  });

  it("rejects a pending closeout when Chapter approval evidence changes before apply", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", fixture.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const planPath = new StoryRailStore(bookDir).planPath;
    const arcPath = new ArcStore(bookDir).arcPath(fixture.arc.id);
    const before = {
      plan: await readFile(planPath, "utf8"),
      arc: await readFile(arcPath, "utf8"),
      pending: await readFile(store.pendingPath, "utf8"),
    };
    const changedChapters = fixture.chapters.map((chapter) => chapter.number === 2
      ? { ...chapter, status: "rejected" as const }
      : chapter);

    await expect(store.apply(
      "book-a",
      changedChapters,
      makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt),
    )).rejects.toThrow(/chapter 2 approval or provenance changed/i);
    expect(await readFile(planPath, "utf8")).toBe(before.plan);
    expect(await readFile(arcPath, "utf8")).toBe(before.arc);
    expect(await readFile(store.pendingPath, "utf8")).toBe(before.pending);
  });

  it("supersedes stale pending evidence without overwriting its immutable request", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const first = await store.prepare("book-a", fixture.chapters);
    if (first.status === "not-eligible") throw new Error(first.message);
    const firstRequest = await readFile(store.requestPath(first.pending.pendingId), "utf8");
    const republished = fixture.chapters.map((chapter) => chapter.number === 2
      ? {
          ...chapter,
          status: "published" as const,
          updatedAt: "2026-08-09T10:22:00.000Z",
        }
      : chapter);

    const second = await store.prepare("book-a", republished);

    expect(second).toMatchObject({
      status: "pending",
      pending: {
        pendingId: "reflow-one-2",
        supersedesPendingId: "reflow-one",
        approvedChapters: [
          expect.objectContaining({ number: 1, status: "approved" }),
          expect.objectContaining({ number: 2, status: "published" }),
        ],
      },
    });
    expect(await readFile(store.requestPath("reflow-one"), "utf8")).toBe(firstRequest);
    await expect(store.getPending("book-a")).resolves.toMatchObject({ pendingId: "reflow-one-2" });
  });

  it("supersedes a stale pending after compatible future Rail edits", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const first = await store.prepare("book-a", fixture.chapters);
    if (first.status === "not-eligible") throw new Error(first.message);
    const currentPlan = (await new StoryRailStore(bookDir).load())!;
    const editedPlan = structuredClone(currentPlan);
    editedPlan.arcRouteRail.entries[3]!.narrativeFunction = "Revised distant hypothesis";
    editedPlan.updatedAt = "2026-08-09T10:30:00.000Z";
    await new StoryRailStore(bookDir).save(editedPlan);

    const second = await store.prepare("book-a", fixture.chapters);

    expect(second).toMatchObject({
      status: "pending",
      pending: {
        pendingId: "reflow-one-2",
        supersedesPendingId: first.pending.pendingId,
        expectedPlanUpdatedAt: "2026-08-09T10:30:00.000Z",
        approvedChapters: [
          expect.objectContaining({ railPlanUpdatedAt: fixture.plan.updatedAt }),
          expect.objectContaining({ railPlanUpdatedAt: fixture.plan.updatedAt }),
        ],
      },
    });
  });

  it("explicitly discards a stale pending gate without changing Book, Rail, or Arc truth", async () => {
    const fixture = await installReadyFixture(bookDir);
    const store = makeReflowStore(bookDir);
    const prepared = await store.prepare("book-a", fixture.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const planBefore = await readFile(new StoryRailStore(bookDir).planPath, "utf8");
    const arcBefore = await readFile(new ArcStore(bookDir).arcPath(fixture.arc.id), "utf8");
    const activeBefore = await readFile(new ArcStore(bookDir).activePath, "utf8");

    const discarded = await store.discard("book-a", {
      pendingId: prepared.pending.pendingId,
      expectedPlanUpdatedAt: prepared.pending.expectedPlanUpdatedAt,
      reason: "Production intentionally continued on the direct Book to Chapter path.",
    });

    expect(discarded).toMatchObject({
      status: "discarded",
      receipt: {
        pending: { pendingId: prepared.pending.pendingId },
        reason: expect.stringContaining("direct Book to Chapter"),
      },
    });
    await expect(store.getPending("book-a")).resolves.toBeNull();
    await expect(store.getDiscardReceipt("book-a", prepared.pending.pendingId)).resolves.toEqual(discarded.receipt);
    expect(await readFile(new StoryRailStore(bookDir).planPath, "utf8")).toBe(planBefore);
    expect(await readFile(new ArcStore(bookDir).arcPath(fixture.arc.id), "utf8")).toBe(arcBefore);
    expect(await readFile(new ArcStore(bookDir).activePath, "utf8")).toBe(activeBefore);
  });
});

async function installReadyFixture(
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
      `# Chapter ${chapter.number}\n\nSettled content ${chapter.number}.`,
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

function makeReadyInput(): StoryRailPlanInput {
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

function makeApplyInput(pendingId: string, expectedPlanUpdatedAt: string) {
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
