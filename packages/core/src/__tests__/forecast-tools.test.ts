import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNarrativeForecastCreateTool,
  createNarrativeForecastGetTool,
  createNarrativeForecastSelectTool,
} from "../agent/forecast-tools.js";
import { NarrativeForecastAgent } from "../forecast/agent.js";
import type { AgentContext } from "../agents/base.js";
import type { PipelineRunner } from "../pipeline/runner.js";
import { ArcStore } from "../arc/store.js";
import type { ArcPacket } from "../arc/schema.js";
import { StoryRailStore } from "../arc/rail-store.js";
import type { StoryRailPlanInput } from "../arc/rail-schema.js";
import { makeModelBranch, writeForecastFixtureBook } from "./helpers/forecast-fixture.js";

const BOOK_ID = "demo-book";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((piece) => piece.text ?? "").join("\n");
}

describe("narrative forecast agent tools", () => {
  let root: string;
  let bookDir: string;
  let pipeline: PipelineRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-forecast-tools-"));
    bookDir = join(root, "books", BOOK_ID);
    await writeForecastFixtureBook(bookDir);
    await writeFile(join(bookDir, "book.json"), JSON.stringify(makeToolBookConfig()), "utf-8");
    const runtime: AgentContext = { client: { provider: "openai" } as never, model: "fake", projectRoot: root };
    pipeline = { createAgentContext: () => runtime } as never;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function stubAgent() {
    return vi.spyOn(NarrativeForecastAgent.prototype, "generateBranches").mockResolvedValue({
      branches: [makeModelBranch({ title: "接受提议" }), makeModelBranch({ title: "拒绝提议" })],
    });
  }

  async function createForecast(): Promise<string> {
    stubAgent();
    const tool = createNarrativeForecastCreateTool(pipeline, BOOK_ID, root);
    const result = await tool.execute("call-1", { divergence: "主角是否接受提议", branchCount: 2 });
    const details = result.details as { forecastId: string };
    return details.forecastId;
  }

  it("exposes the three tool names with required params", () => {
    const create = createNarrativeForecastCreateTool(pipeline, BOOK_ID, root);
    const get = createNarrativeForecastGetTool(BOOK_ID, root);
    const select = createNarrativeForecastSelectTool(BOOK_ID, root);

    expect(create.name).toBe("create_narrative_forecast");
    expect(get.name).toBe("get_narrative_forecast");
    expect(select.name).toBe("select_narrative_branch");
    expect(create.parameters.required).toContain("divergence");
    expect(get.parameters.required).toContain("forecastId");
    expect(select.parameters.required).toEqual(expect.arrayContaining(["forecastId", "branchId"]));
  });

  it("create returns an actionable branch overview and forecast id", async () => {
    stubAgent();
    const tool = createNarrativeForecastCreateTool(pipeline, BOOK_ID, root);

    const result = await tool.execute("call-1", { divergence: "主角是否接受提议", branchCount: 2 });
    const text = textOf(result as never);

    expect(text).toMatch(/fc-/);
    expect(text).toContain("branch-1");
    expect(text).toContain("branch-2");
    expect(text).toContain("接受提议");
    expect(text).toContain("select_narrative_branch");
  });

  it("create rejects a bookId that does not match the active book", async () => {
    stubAgent();
    const tool = createNarrativeForecastCreateTool(pipeline, BOOK_ID, root);

    await expect(tool.execute("call-1", { bookId: "other-book", divergence: "分歧" }))
      .rejects.toThrow(/active book/);
  });

  it("get reports staleness after canonical state changes", async () => {
    const forecastId = await createForecast();
    const tool = createNarrativeForecastGetTool(BOOK_ID, root);

    const fresh = textOf(await tool.execute("call-2", { forecastId }) as never);
    expect(fresh).toContain("active");

    await writeFile(join(bookDir, "story", "state", "current_state.json"), JSON.stringify({ facts: ["变了"] }), "utf-8");
    const stale = textOf(await tool.execute("call-3", { forecastId }) as never);
    expect(stale).toContain("stale");
  });

  it("select writes the plan and surfaces the path", async () => {
    const forecastId = await createForecast();
    const tool = createNarrativeForecastSelectTool(BOOK_ID, root);

    const result = await tool.execute("call-2", { forecastId, branchId: "branch-2" });
    const text = textOf(result as never);

    expect(text).toContain("selected-branch-plan.md");
    expect(text).toContain("拒绝提议");
    expect(text).toContain("Active Arc draft");
    expect((result.details as { arcActivated: boolean }).arcActivated).toBe(true);
  });

  it("reports when a ready B-Rail conflict saves the draft without activating it", async () => {
    const arcStore = new ArcStore(bookDir);
    const previousArc = await arcStore.save(makeToolArc("arc-tool-existing"));
    await arcStore.setActive(previousArc.id);
    await new StoryRailStore(bookDir).replace(
      BOOK_ID,
      makeToolRailInput(previousArc.id),
    );
    const forecastId = await createForecast();
    const tool = createNarrativeForecastSelectTool(BOOK_ID, root);

    const result = await tool.execute("call-2", { forecastId, branchId: "branch-2" });
    const text = textOf(result as never);
    const details = result.details as { arcActivated: boolean; arc?: ArcPacket };

    expect(text).toContain("Arc draft saved but not activated");
    expect(text).toContain("WARNING:");
    expect(details.arcActivated).toBe(false);
    expect(details.arc).toBeDefined();
    expect((await arcStore.getActive())?.id).toBe(previousArc.id);
    await expect(arcStore.load(details.arc!.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("select propagates a missing-branch error listing available branches", async () => {
    const forecastId = await createForecast();
    const tool = createNarrativeForecastSelectTool(BOOK_ID, root);

    await expect(tool.execute("call-2", { forecastId, branchId: "branch-9" }))
      .rejects.toThrow(/branch-1, branch-2/);
  });

  it("tools require a book when none is active", async () => {
    const tool = createNarrativeForecastGetTool(null, root);
    await expect(tool.execute("call-1", { forecastId: "fc-x" })).rejects.toThrow(/bookId/);
  });
});

function makeToolBookConfig() {
  return {
    id: BOOK_ID,
    title: "示例书",
    platform: "other",
    genre: "urban",
    status: "active",
    targetChapters: 200,
    chapterWordCount: 3000,
    language: "zh",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  } as const;
}

function makeToolArc(id: string): ArcPacket {
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

function makeToolRailInput(boundArcId: string): StoryRailPlanInput {
  return {
    anchorRail: {
      status: "ready",
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
      status: "ready",
      entries: Array.from({ length: Math.ceil(200 / 3) }, (_, index) => ({
        bId: `B${String(index + 1).padStart(3, "0")}`,
        routeOrder: (index + 1) * 100,
        status: index === 0 ? "active" as const
          : index === 1 ? "provisional" as const
            : "hypothesis" as const,
        targetAnchorId: `A${String(Math.min(index + 1, 6)).padStart(2, "0")}`,
        ...(index === 0 ? { arcId: boundArcId } : {}),
        narrativeFunction: `내구 서사 기능 ${index + 1}`,
        payoffAxis: `내구 보상 축 ${index + 1}`,
        carriedReaderDebt: `이월 독자 부채 ${index + 1}`,
        contrastRequirement: `직전 Arc와 다른 결산 ${index + 1}`,
      })),
    },
  };
}
