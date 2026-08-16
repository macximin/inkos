import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArcPacketSchema, type ArcPacket } from "../arc/schema.js";
import { ArcStore, assertSafeArcId } from "../arc/store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import type { StoryRailPlanInput } from "../arc/rail-schema.js";
import { renderStoryRailPlan } from "../arc/rail-context.js";
import {
  createArcDraftFromForecast,
  loadOptionalActiveArcContext,
  renderArcContext,
  resolveArcChapterContext,
} from "../arc/forecast.js";
import { makeForecast } from "./helpers/forecast-fixture.js";

describe("ArcStore", () => {
  let bookDir: string;

  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "inkos-arc-store-"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "book-a",
      title: "Book A",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 18,
      chapterWordCount: 3000,
      language: "en",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }), "utf-8");
  });
  afterEach(async () => { await rm(bookDir, { recursive: true, force: true }); });

  it("persists a validated Arc and resolves its active packet", async () => {
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z"), idFactory: () => "arc-opening" });
    const arc = await store.save(makeArc(await store.allocateArcId()));
    await store.setActive(arc.id);

    expect(await store.getActive()).toEqual(arc);
    expect((await store.list()).map((item) => item.id)).toEqual(["arc-opening"]);
  });

  it("allocates distinct default Arc ids even within the same timestamp", async () => {
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z") });

    const [first, second] = await Promise.all([
      store.allocateArcId(),
      store.allocateArcId(),
    ]);

    expect(first).toMatch(/^arc-20260809100000-[0-9a-f-]{36}$/);
    expect(second).toMatch(/^arc-20260809100000-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it("rejects an Arc whose beats do not exactly match its 1–3 chapter range", () => {
    const invalid = makeArc("arc-invalid", { episodeBeats: [{ chapterNumber: 1, role: "promise", beats: ["x"], endingHook: "" }] });
    expect(() => ArcPacketSchema.parse(invalid)).toThrow(/episodeBeats/);
  });

  it("rejects reverse chapter ordering even when the numbers are consecutive", () => {
    const invalid = makeArc("arc-reverse", {
      episodeCount: 3,
      chapterNumbers: [3, 2, 1],
      episodeBeats: [
        { chapterNumber: 3, role: "promise", beats: ["a"], endingHook: "" },
        { chapterNumber: 2, role: "pressure", beats: ["b"], endingHook: "" },
        { chapterNumber: 1, role: "payoff", beats: ["c"], endingHook: "" },
      ],
    });
    expect(() => ArcPacketSchema.parse(invalid)).toThrow(/consecutive chapter numbers/i);
  });

  it("turns a forecast branch into a non-canonical editable Arc draft", async () => {
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z"), idFactory: () => "arc-from-forecast" });
    const forecast = makeForecast({ bookId: "book-a", baseChapter: 3 });
    const branch = { ...forecast.branches[0]!, beats: [
      { chapter: 4, summary: "주인공이 약속을 건다" },
      { chapter: 5, summary: "압박 속에서 선택한다" },
      { chapter: 6, summary: "대가를 치르고 보상받는다" },
    ] };

    const arc = await createArcDraftFromForecast({ store, forecast, branch });
    const context = renderArcContext(arc, 5);

    expect(arc).toMatchObject({ status: "draft", episodeCount: 3, chapterNumbers: [4, 5, 6] });
    expect(arc.sourceForecast).toEqual({ forecastId: forecast.forecastId, branchId: branch.branchId });
    expect(context).toContain("압박 속에서 선택한다");
    expect(resolveArcChapterContext(arc, 5)?.provenance).toMatchObject({
      arcId: arc.id,
      arcUpdatedAt: arc.updatedAt,
      chapterNumber: 5,
      episodeRole: "pressure",
      beats: ["압박 속에서 선택한다"],
    });
    expect(renderArcContext(arc, 7)).toBeNull();
  });

  it("uses the first consecutive window when a valid forecast has sparse beats", async () => {
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z"), idFactory: () => "arc-sparse" });
    const forecast = makeForecast({ bookId: "book-a", baseChapter: 3 });
    const branch = { ...forecast.branches[0]!, beats: [
      { chapter: 4, summary: "첫 선택" },
      { chapter: 6, summary: "건너뛴 미래" },
      { chapter: 7, summary: "먼 결말" },
    ] };

    const arc = await createArcDraftFromForecast({ store, forecast, branch });
    expect(arc).toMatchObject({
      episodeCount: 1,
      chapterNumbers: [4],
      goal: "첫 선택",
      payoff: "첫 선택",
    });
    expect(arc.episodeBeats).toHaveLength(1);
  });

  it("does not promote branch-wide changes beyond the selected 1-3 chapter window into an active Arc", async () => {
    const store = new ArcStore(bookDir, {
      now: () => new Date("2026-08-09T10:00:00Z"),
      idFactory: () => "arc-window-only",
    });
    const forecast = makeForecast({ bookId: "book-a", baseChapter: 3, horizon: 5 });
    const branch = {
      ...forecast.branches[0]!,
      beats: Array.from({ length: 5 }, (_, index) => ({
        chapter: index + 4,
        summary: index === 4 ? "FAR_CHAPTER_FIVE_CHANGE" : `가까운 비트 ${index + 1}`,
      })),
      characterDecisions: [{ character: "먼 인물", decision: "FAR_CHARACTER_DECISION" }],
      projectedChanges: {
        characters: ["FAR_CHARACTER_CHANGE"],
        relationships: ["FAR_RELATIONSHIP_CHANGE"],
        world: ["FAR_WORLD_CHANGE"],
        hooks: ["FAR_HOOK_CHANGE"],
      },
    };

    const arc = await createArcDraftFromForecast({ store, forecast, branch });
    const activeContext = renderArcContext(arc, 4) ?? "";
    const serializedArc = JSON.stringify(arc);

    expect(arc.chapterNumbers).toEqual([4, 5, 6]);
    expect(arc.goal).toBe("가까운 비트 3");
    expect(arc.payoff).toBe("가까운 비트 3");
    expect(arc).toMatchObject({
      turn: "",
      irreversibleChange: "",
      nextHook: "",
      characterChanges: [],
      relationshipChanges: [],
      worldChanges: [],
      hookOperations: [],
    });
    for (const distantProjection of [
      "FAR_CHAPTER_FIVE_CHANGE",
      "FAR_CHARACTER_DECISION",
      "FAR_CHARACTER_CHANGE",
      "FAR_RELATIONSHIP_CHANGE",
      "FAR_WORLD_CHANGE",
      "FAR_HOOK_CHANGE",
    ]) {
      expect(serializedArc).not.toContain(distantProjection);
      expect(activeContext).not.toContain(distantProjection);
    }
  });

  it("fails open when optional Arc state is dangling, corrupt, or belongs to another book", async () => {
    const warnings: string[] = [];
    const store = new ArcStore(bookDir);
    await mkdir(store.arcsDir, { recursive: true });
    await writeFile(store.activePath, JSON.stringify({ arcId: "missing", updatedAt: "2026-08-09T10:00:00.000Z" }), "utf-8");

    await expect(loadOptionalActiveArcContext({
      store,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
      onWarning: (warning) => warnings.push(warning),
    })).resolves.toBeNull();

    const otherBookArc = await store.save(makeArc("arc-other", { bookId: "book-b" }));
    await store.setActive(otherBookArc.id);
    await expect(loadOptionalActiveArcContext({
      store,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
      onWarning: (warning) => warnings.push(warning),
    })).resolves.toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it("attaches an exactly bound active B and its A-Rail destination to Arc context and provenance", async () => {
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z") });
    const railStore = new StoryRailStore(bookDir, { now: () => new Date("2026-08-09T11:00:00Z") });
    const arc = await store.save(makeArc("arc-bound"));
    await store.setActive(arc.id);
    await railStore.replace("book-a", makeRailInput(arc.id));

    const context = await loadOptionalActiveArcContext({
      store,
      railStore,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
    });

    expect(context?.markdown).toContain("Story Plan Rails Snapshot");
    expect(context?.markdown).toContain("채무 장부를 공개한다");
    expect(context?.provenance.storyRail).toMatchObject({
      planUpdatedAt: "2026-08-09T11:00:00.000Z",
      anchor: { id: "A01", title: "항구의 장부를 장악한다" },
      activeB: {
        bId: "B001",
        status: "active",
        targetAnchorId: "A01",
        narrativeFunction: "채무 장부를 공개한다",
      },
      nextB: {
        bId: "B002",
        status: "provisional",
        targetAnchorId: "A02",
        narrativeFunction: "증인의 공개 선택을 시험한다",
      },
    });
    expect(context?.markdown).toContain("Next provisional B: B002 → A02");
  });

  it("renders route-capacity evidence and closed B actual episode counts for Forecast review", async () => {
    const railStore = new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T11:00:00Z"),
    });
    const base = makeRailInput();
    const plan = await railStore.replace("book-a", {
      anchorRail: base.anchorRail,
      arcRouteRail: {
        status: "ready",
        entries: [
          { ...base.arcRouteRail.entries[0]!, status: "closed", actualEpisodeCount: 2 },
          { ...base.arcRouteRail.entries[1]!, status: "active" },
          { ...base.arcRouteRail.entries[2]!, status: "provisional" },
          ...base.arcRouteRail.entries.slice(3),
          {
            ...base.arcRouteRail.entries[5]!,
            bId: "B007",
            routeOrder: 700,
          },
        ],
      },
    });

    const rendered = renderStoryRailPlan(plan);

    expect(rendered).toContain("Target chapters snapshot: 18");
    expect(rendered).toContain("Arc episode cap: 3");
    expect(rendered).toContain("Maximum routed chapter capacity: 20");
    expect(rendered).toContain("B001 [closed]");
    expect(rendered).toContain("Actual episode count: 2");
  });

  it("keeps a valid active Arc when Rail JSON is corrupt or its active B is bound elsewhere", async () => {
    const warnings: string[] = [];
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z") });
    const railStore = new StoryRailStore(bookDir, { now: () => new Date("2026-08-09T11:00:00Z") });
    const arc = await store.save(makeArc("arc-runtime"));
    await store.setActive(arc.id);
    await mkdir(railStore.railsDir, { recursive: true });
    await writeFile(railStore.planPath, "{ broken-rail", "utf-8");

    const withCorruptRail = await loadOptionalActiveArcContext({
      store,
      railStore,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(withCorruptRail?.provenance).toMatchObject({ arcId: "arc-runtime", chapterNumber: 1 });
    expect(withCorruptRail?.provenance.storyRail).toBeUndefined();

    await rm(railStore.railsDir, { recursive: true, force: true });
    await railStore.replace("book-a", makeRailInput("arc-different"));
    const withMismatchedRail = await loadOptionalActiveArcContext({
      store,
      railStore,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(withMismatchedRail?.provenance).toMatchObject({ arcId: "arc-runtime", chapterNumber: 1 });
    expect(withMismatchedRail?.provenance.storyRail).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("ignored"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("arc-different"))).toBe(true);
  });

  it("ignores only the Rail when readiness is draft or its target-chapter snapshot is stale", async () => {
    const warnings: string[] = [];
    const store = new ArcStore(bookDir, { now: () => new Date("2026-08-09T10:00:00Z") });
    const railStore = new StoryRailStore(bookDir, { now: () => new Date("2026-08-09T11:00:00Z") });
    const arc = await store.save(makeArc("arc-eligibility"));
    await store.setActive(arc.id);
    await railStore.replace("book-a", makeRailInput(arc.id));

    const staleTarget = await loadOptionalActiveArcContext({
      store,
      railStore,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 20,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(staleTarget?.provenance.arcId).toBe(arc.id);
    expect(staleTarget?.provenance.storyRail).toBeUndefined();

    await railStore.replace("book-a", makeRailInput(arc.id, "draft"));
    const draftRail = await loadOptionalActiveArcContext({
      store,
      railStore,
      bookId: "book-a",
      chapterNumber: 1,
      targetChapters: 18,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(draftRail?.provenance.arcId).toBe(arc.id);
    expect(draftRail?.provenance.storyRail).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("currently targets 20"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("must both be ready"))).toBe(true);
  });

  it("rejects unsafe Arc ids", () => {
    expect(() => assertSafeArcId("../outside")).toThrow();
    expect(assertSafeArcId("arc-01")).toBe("arc-01");
  });
});

function makeArc(id: string, overrides: Record<string, unknown> = {}): ArcPacket {
  return {
    version: 1,
    id,
    bookId: "book-a",
    title: "첫 번째 약속",
    status: "draft",
    episodeCount: 2,
    chapterNumbers: [1, 2],
    openingState: "빚 독촉이 시작됐다.",
    promise: "주인공은 빚의 출처를 찾는다.",
    goal: "증거를 확보한다.",
    obstacle: "상대가 증거를 숨긴다.",
    pressure: "마감이 다가온다.",
    turn: "동맹이 배신한다.",
    payoff: "증거 일부를 손에 넣는다.",
    irreversibleChange: "주인공의 신분이 노출된다.",
    nextHook: "누가 빚을 만들었는가?",
    episodeBeats: [
      { chapterNumber: 1, role: "promise", beats: ["빚 독촉이 시작된다"], endingHook: "낯선 영수증" },
      { chapterNumber: 2, role: "payoff", beats: ["영수증의 주인을 찾는다"], endingHook: "새 빚" },
    ],
    characterChanges: [], relationshipChanges: [], worldChanges: [], hookOperations: [],
    mustKeep: [], mustAvoid: [], styleEmphasis: [],
    createdAt: "2026-08-09T10:00:00.000Z", updatedAt: "2026-08-09T10:00:00.000Z",
    ...overrides,
  } as ArcPacket;
}

function makeRailInput(
  boundArcId?: string,
  readiness: "draft" | "ready" = "ready",
): StoryRailPlanInput {
  return {
    anchorRail: {
      status: readiness,
      anchors: Array.from({ length: 6 }, (_, index) => ({
        id: `A${String(index + 1).padStart(2, "0")}`,
        routeOrder: (index + 1) * 100,
        title: index === 0 ? "항구의 장부를 장악한다" : `장기 도착점 ${index + 1}`,
        detailLevel: index < 2 ? "compound" as const : "sparse" as const,
        state: "planned" as const,
        entryState: `진입 상태 ${index + 1}`,
        trigger: `트리거 ${index + 1}`,
        irreversibleChange: `비가역 변화 ${index + 1}`,
        humanAftermath: `인간 후폭풍 ${index + 1}`,
        readerDebt: `독자 부채 ${index + 1}`,
        payoffAxis: `보상 축 ${index + 1}`,
        nextPressure: `다음 압력 ${index + 1}`,
      })),
    },
    arcRouteRail: {
      status: readiness,
      entries: Array.from({ length: 6 }, (_, index) => ({
        bId: `B${String(index + 1).padStart(3, "0")}`,
        routeOrder: (index + 1) * 100,
        status: index === 0 ? "active" as const
          : index === 1 ? "provisional" as const
            : "hypothesis" as const,
        targetAnchorId: `A${String(index + 1).padStart(2, "0")}`,
        ...(index === 0 && boundArcId ? { arcId: boundArcId } : {}),
        narrativeFunction: index === 0
          ? "채무 장부를 공개한다"
          : index === 1
            ? "증인의 공개 선택을 시험한다"
            : `장기 기능 ${index + 1}`,
        payoffAxis: `증거 축 ${index + 1}`,
        carriedReaderDebt: `독자 부채 ${index + 1}`,
        contrastRequirement: `직전 Arc와 다른 결산 ${index + 1}`,
      })),
    },
  };
}
