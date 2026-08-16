import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NarrativeForecastAgent } from "../forecast/agent.js";
import {
  createNarrativeForecast,
  getNarrativeForecast,
  selectNarrativeBranch,
} from "../forecast/runner.js";
import type { AgentContext } from "../agents/base.js";
import { ArcStore } from "../arc/store.js";
import type { ArcPacket } from "../arc/schema.js";
import { StoryRailStore } from "../arc/rail-store.js";
import type { StoryRailPlanInput } from "../arc/rail-schema.js";
import { StateManager } from "../state/manager.js";
import {
  makeModelBranch,
  snapshotCanonicalFiles,
  writeForecastFixtureBook,
} from "./helpers/forecast-fixture.js";

const BOOK_ID = "demo-book";
const FIXED_NOW = () => new Date("2026-07-15T00:00:00Z");
const FIXED_ID = "fc-20260715-000000";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runtime(projectRoot: string): AgentContext {
  return { client: { provider: "openai" } as never, model: "fake", projectRoot };
}

function stubBranches() {
  return [
    makeModelBranch({ title: "接受提议" }),
    makeModelBranch({
      title: "拒绝提议",
      premise: "假设主角当场拒绝并公开把柄。",
      projectedChanges: {
        characters: ["主角声望上升"],
        relationships: ["与盟友结盟加深"],
        world: ["对手提前动手"],
        hooks: ["hook-03 保持休眠"],
      },
    }),
  ];
}

describe("narrative forecast runner", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-forecast-run-"));
    bookDir = join(root, "books", BOOK_ID);
    await writeForecastFixtureBook(bookDir);
    await writeFile(join(bookDir, "book.json"), JSON.stringify(makeRunnerBookConfig()), "utf-8");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function stubAgent() {
    return vi.spyOn(NarrativeForecastAgent.prototype, "generateBranches")
      .mockResolvedValue({ branches: stubBranches() });
  }

  function createOptions() {
    return {
      projectRoot: root,
      bookId: BOOK_ID,
      divergence: "主角是否接受对手的合作提议",
      branchCount: 2,
      horizon: 5,
      runtime: runtime(root),
      determinism: { now: FIXED_NOW },
    };
  }

  it("creates forecast.json and comparison.md with assigned branch ids", async () => {
    const spy = stubAgent();

    const result = await createNarrativeForecast(createOptions());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.forecast.forecastId).toBe(FIXED_ID);
    expect(result.forecast.baseChapter).toBe(2);
    expect(result.forecast.status).toBe("active");
    expect(result.forecast.branches.map((branch) => branch.branchId)).toEqual(["branch-1", "branch-2"]);
    expect(result.forecast.createdAt).toBe("2026-07-15T00:00:00.000Z");

    const onDisk = JSON.parse(await readFile(result.forecastJsonPath, "utf-8"));
    expect(onDisk.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const comparison = await readFile(result.comparisonPath, "utf-8");
    expect(comparison).toContain("接受提议");
    expect(comparison).toContain("拒绝提议");
  });

  it("keeps sibling branches isolated in the stored forecast", async () => {
    stubAgent();

    const result = await createNarrativeForecast(createOptions());

    const [first, second] = result.forecast.branches;
    expect(first?.projectedChanges.relationships).toEqual(["主角与盟友决裂"]);
    expect(second?.projectedChanges.relationships).toEqual(["与盟友结盟加深"]);
    expect(first?.beats).not.toBe(second?.beats);
  });

  it("does not modify any canonical file when creating a forecast", async () => {
    stubAgent();
    const before = await snapshotCanonicalFiles(bookDir);

    await createNarrativeForecast(createOptions());

    expect(await snapshotCanonicalFiles(bookDir)).toEqual(before);
  });

  it("leaves no forecast files behind when the model output is invalid", async () => {
    const chatSpy = vi.spyOn(
      NarrativeForecastAgent.prototype as unknown as { chat: () => Promise<{ content: string; usage: object }> },
      "chat",
    ).mockResolvedValue({ content: "不是 JSON", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

    await expect(createNarrativeForecast(createOptions())).rejects.toThrow(/not valid JSON/);

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(await exists(join(bookDir, "story", "runtime", "narrative-forecasts"))).toBe(false);
  });

  it("rejects out-of-range branch counts and horizons before calling the model", async () => {
    const spy = stubAgent();

    await expect(createNarrativeForecast({ ...createOptions(), branchCount: 1 })).rejects.toThrow(/branchCount/);
    await expect(createNarrativeForecast({ ...createOptions(), horizon: 0 })).rejects.toThrow(/horizon/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a fresh forecast as active", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await getNarrativeForecast({ projectRoot: root, bookId: BOOK_ID, forecastId: FIXED_ID });

    expect(result.stale).toBe(false);
    expect(result.forecast.status).toBe("active");
  });

  it("marks a forecast stale after the canonical context changes", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    await writeFile(join(bookDir, "story", "state", "current_state.json"), JSON.stringify({ facts: ["主角离开东城"] }), "utf-8");

    const result = await getNarrativeForecast({ projectRoot: root, bookId: BOOK_ID, forecastId: FIXED_ID });

    expect(result.stale).toBe(true);
    const onDisk = JSON.parse(await readFile(result.forecastJsonPath, "utf-8"));
    expect(onDisk.status).toBe("stale");
  });

  it("marks a forecast stale after the story frame changes", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    await writeFile(join(bookDir, "story", "outline", "story_frame.md"), "# 故事框架\n都市复仇改为悬疑探案", "utf-8");

    const result = await getNarrativeForecast({ projectRoot: root, bookId: BOOK_ID, forecastId: FIXED_ID });

    expect(result.stale).toBe(true);
  });

  it("selects a fresh branch into an active editable Arc without changing canonical files", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    const forecastJsonPath = join(bookDir, "story", "runtime", "narrative-forecasts", FIXED_ID, "forecast.json");
    const forecastJsonBefore = await readFile(forecastJsonPath, "utf-8");
    const canonBefore = await snapshotCanonicalFiles(bookDir);

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-2",
      determinism: { now: FIXED_NOW },
    });

    expect(result.branch.branchId).toBe("branch-2");
    expect(result.arcActivated).toBe(true);
    expect(result.arc).toMatchObject({ status: "draft", episodeCount: 2, chapterNumbers: [13, 14] });
    const plan = await readFile(result.planPath, "utf-8");
    expect(plan).toContain("拒绝提议");
    expect(plan).not.toContain("branch-1");
    expect(await readFile(forecastJsonPath, "utf-8")).toBe(forecastJsonBefore);
    expect(await snapshotCanonicalFiles(bookDir)).toEqual(canonBefore);
  });

  it("rejects selection while the Book is busy and releases its lock after a successful selection", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    const state = new StateManager(root);
    const releaseCompetingLock = await state.acquireBookLock(BOOK_ID);

    try {
      await expect(selectNarrativeBranch({
        projectRoot: root,
        bookId: BOOK_ID,
        forecastId: FIXED_ID,
        branchId: "branch-1",
        determinism: { now: FIXED_NOW, idFactory: () => "arc-lock-test" },
      })).rejects.toMatchObject({ code: "BOOK_BUSY" });
      expect(await exists(join(
        bookDir, "story", "runtime", "narrative-forecasts", FIXED_ID, "selected-branch-plan.md",
      ))).toBe(false);
    } finally {
      await releaseCompetingLock();
    }

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW, idFactory: () => "arc-lock-test" },
    });
    expect(result.arcActivated).toBe(true);

    const releaseAfterSelection = await new StateManager(root).acquireBookLock(BOOK_ID);
    await releaseAfterSelection();
  });

  it("releases the Book lock when Arc creation fails", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    vi.spyOn(ArcStore.prototype, "allocateArcId").mockRejectedValueOnce(new Error("forced Arc allocation failure"));

    await expect(selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    })).rejects.toThrow("forced Arc allocation failure");

    const releaseAfterFailure = await new StateManager(root).acquireBookLock(BOOK_ID);
    await releaseAfterFailure();
  });

  it("binds a fresh selected Arc to the existing unbound active B without changing route status", async () => {
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput());
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-2",
      determinism: { now: FIXED_NOW },
    });

    expect(result.stale).toBe(false);
    expect(result.arcActivated).toBe(true);
    expect(result.arc).toBeDefined();
    expect(result.railBinding).toEqual({ bId: "B001", changed: true });
    expect(result.railWarning).toBeUndefined();
    const rail = await railStore.load();
    expect(rail?.arcRouteRail.entries[0]).toMatchObject({
      bId: "B001",
      status: "active",
      arcId: result.arc!.id,
    });
  });

  it("commits a fresh B binding and active Arc pointer without the split setActive path", async () => {
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput());
    const splitActivation = vi.spyOn(ArcStore.prototype, "setActive")
      .mockRejectedValue(new Error("split activation must not run"));
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.arcActivated).toBe(true);
    expect(result.railBinding).toMatchObject({ bId: "B001", changed: true });
    expect(splitActivation).not.toHaveBeenCalled();
    expect((await railStore.load())?.arcRouteRail.entries[0]?.arcId).toBe(result.arc?.id);
    expect((await new ArcStore(bookDir).getActive())?.id).toBe(result.arc?.id);
  });

  it("activates a fresh Arc when the ready active B is already compatibly bound", async () => {
    const expectedArcId = "arc-20260715000000";
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput({ boundArcId: expectedArcId }));
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-2",
      determinism: { now: FIXED_NOW, idFactory: () => expectedArcId },
    });

    expect(result.arc?.id).toBe(expectedArcId);
    expect(result.arcActivated).toBe(true);
    expect(result.railBinding).toEqual({ bId: "B001", changed: false });
    expect((await new ArcStore(bookDir).getActive())?.id).toBe(expectedArcId);
  });

  it("saves the new draft but preserves the current active Arc on a ready B-Rail conflict", async () => {
    const arcStore = new ArcStore(bookDir, { now: FIXED_NOW });
    const previousArc = await arcStore.save(makeRunnerArc("arc-existing-active"));
    await arcStore.setActive(previousArc.id);
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput({ boundArcId: previousArc.id }));
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-2",
      determinism: { now: FIXED_NOW },
    });

    expect(result.arc?.id).toMatch(/^arc-20260715000000-/);
    expect(result.arcActivated).toBe(false);
    expect(result.railBinding).toBeUndefined();
    expect(result.railWarning).toContain("was saved but story/arcs/active.json was not changed");
    expect((await arcStore.getActive())?.id).toBe(previousArc.id);
    await expect(arcStore.load(result.arc!.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("saves the new draft but preserves the current active Arc when a draft B-Rail is already bound", async () => {
    const arcStore = new ArcStore(bookDir, { now: FIXED_NOW });
    const previousArc = await arcStore.save(makeRunnerArc("arc-draft-binding"));
    await arcStore.setActive(previousArc.id);
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput({
      boundArcId: previousArc.id,
      readiness: "draft",
    }));
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.arcActivated).toBe(false);
    expect(result.railBinding).toBeUndefined();
    expect(result.railWarning).toContain("was saved but story/arcs/active.json was not changed");
    expect((await arcStore.getActive())?.id).toBe(previousArc.id);
    expect((await railStore.load())?.arcRouteRail.entries[0]?.arcId).toBe(previousArc.id);
    await expect(arcStore.load(result.arc!.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("fails open and activates when the optional Rail file is corrupt", async () => {
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await mkdir(railStore.railsDir, { recursive: true });
    await writeFile(railStore.planPath, "{ corrupt-rail", "utf-8");
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.arcActivated).toBe(true);
    expect(result.railBinding).toBeUndefined();
    expect(result.railWarning).toContain("failed and was ignored");
    expect((await new ArcStore(bookDir).getActive())?.id).toBe(result.arc?.id);
  });

  it("fails open and activates when plan.json belongs to another book", async () => {
    const arcStore = new ArcStore(bookDir, { now: FIXED_NOW });
    const previousArc = await arcStore.save(makeRunnerArc("arc-cross-book-binding"));
    await arcStore.setActive(previousArc.id);
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput({ boundArcId: previousArc.id }));
    const mismatchedPlan = JSON.parse(await readFile(railStore.planPath, "utf-8")) as Record<string, unknown>;
    await writeFile(
      railStore.planPath,
      `${JSON.stringify({ ...mismatchedPlan, bookId: "other-book" }, null, 2)}\n`,
      "utf-8",
    );
    stubAgent();
    await createNarrativeForecast(createOptions());

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.arcActivated).toBe(true);
    expect(result.railBinding).toBeUndefined();
    expect(result.railWarning).toContain("belongs to book");
    expect((await arcStore.getActive())?.id).toBe(result.arc?.id);
  });

  it("does not bind or otherwise mutate the Rail when selecting a stale forecast", async () => {
    const railStore = new StoryRailStore(bookDir, { now: FIXED_NOW });
    await railStore.replace(BOOK_ID, makeRunnerRailInput());
    stubAgent();
    await createNarrativeForecast(createOptions());
    const railBefore = await readFile(railStore.planPath, "utf-8");
    await writeFile(join(bookDir, "chapters", "0003_反击.md"), "第三章正文", "utf-8");

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.stale).toBe(true);
    expect(result.arcActivated).toBe(false);
    expect(result.arc).toBeUndefined();
    expect(result.railBinding).toBeUndefined();
    expect(await readFile(railStore.planPath, "utf-8")).toBe(railBefore);
  });

  it("refuses to select a branch that does not exist", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());

    await expect(selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-9",
    })).rejects.toThrow(/branch-9[\s\S]*branch-1, branch-2/);

    expect(await exists(join(
      bookDir, "story", "runtime", "narrative-forecasts", FIXED_ID, "selected-branch-plan.md",
    ))).toBe(false);
  });

  it("warns in the plan when selecting from a stale forecast", async () => {
    stubAgent();
    await createNarrativeForecast(createOptions());
    await writeFile(join(bookDir, "chapters", "0003_反击.md"), "第三章正文", "utf-8");

    const result = await selectNarrativeBranch({
      projectRoot: root,
      bookId: BOOK_ID,
      forecastId: FIXED_ID,
      branchId: "branch-1",
      determinism: { now: FIXED_NOW },
    });

    expect(result.stale).toBe(true);
    expect(await readFile(result.planPath, "utf-8")).toContain("已过期");
  });

  it("errors early when the book does not exist", async () => {
    await mkdir(join(root, "books"), { recursive: true });
    await expect(createNarrativeForecast({ ...createOptions(), bookId: "nope" })).rejects.toThrow(/nope/);
  });
});

function makeRunnerBookConfig(targetChapters = 200) {
  return {
    id: BOOK_ID,
    title: "示例书",
    platform: "other",
    genre: "urban",
    status: "active",
    targetChapters,
    chapterWordCount: 3000,
    language: "zh",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  } as const;
}

function makeRunnerArc(id: string): ArcPacket {
  return {
    version: 1,
    id,
    bookId: BOOK_ID,
    title: "기존 활성 Arc",
    status: "draft",
    episodeCount: 1,
    chapterNumbers: [3],
    openingState: "기존 경로가 진행 중이다.",
    promise: "기존 약속을 결산한다.",
    goal: "현재 증거를 지킨다.",
    obstacle: "상대가 증거를 노린다.",
    pressure: "시간이 부족하다.",
    turn: "동맹이 개입한다.",
    payoff: "증거를 보존한다.",
    irreversibleChange: "상대가 추적을 시작한다.",
    nextHook: "다음 증인은 누구인가?",
    episodeBeats: [{
      chapterNumber: 3,
      role: "payoff",
      beats: ["기존 증거를 지킨다."],
      endingHook: "새 증인이 등장한다.",
    }],
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function makeRunnerRailInput(options: {
  readonly boundArcId?: string;
  readonly readiness?: "draft" | "ready";
  readonly targetChapters?: number;
} = {}): StoryRailPlanInput {
  const readiness = options.readiness ?? "ready";
  const targetChapters = options.targetChapters ?? 200;
  const routeEntryCount = Math.ceil(targetChapters / 3);
  return {
    anchorRail: {
      status: readiness,
      anchors: Array.from({ length: 6 }, (_, index) => ({
        id: `A${String(index + 1).padStart(2, "0")}`,
        routeOrder: (index + 1) * 100,
        title: `장기 도착점 ${index + 1}`,
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
      entries: Array.from({ length: routeEntryCount }, (_, index) => ({
        bId: `B${String(index + 1).padStart(3, "0")}`,
        routeOrder: (index + 1) * 100,
        status: index === 0 ? "active" as const
          : index === 1 ? "provisional" as const
            : "hypothesis" as const,
        targetAnchorId: `A${String(Math.min(index + 1, 6)).padStart(2, "0")}`,
        ...(index === 0 && options.boundArcId ? { arcId: options.boundArcId } : {}),
        narrativeFunction: `내구 서사 기능 ${index + 1}`,
        payoffAxis: `내구 보상 축 ${index + 1}`,
        carriedReaderDebt: `이월 독자 부채 ${index + 1}`,
        contrastRequirement: `직전 Arc와 다른 결산 ${index + 1}`,
      })),
    },
  };
}
