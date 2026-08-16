import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterAgent } from "../agents/writer.js";
import type { ArcPacket } from "../arc/schema.js";
import { resolveArcChapterContext } from "../arc/forecast.js";
import { StoryRailStore } from "../arc/rail-store.js";
import type { StoryRailPlanInput } from "../arc/rail-schema.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

function makeArcPacket(): ArcPacket {
  return {
    version: 1,
    id: "arc-river-ledger",
    bookId: "writer-book",
    title: "River Ledger Arc",
    status: "ready",
    episodeCount: 1,
    chapterNumbers: [3],
    openingState: "The mentor debt is unresolved.",
    promise: "Trace the debt through the river-port ledger.",
    goal: "Secure the ledger page.",
    obstacle: "Guild watchers control the quay.",
    pressure: "The tide will erase the trail.",
    turn: "The page names an ally.",
    payoff: "Lin Yue obtains the page.",
    irreversibleChange: "The guild learns Lin Yue is investigating.",
    nextHook: "Why is the ally named?",
    episodeBeats: [{
      chapterNumber: 3,
      role: "payoff",
      beats: ["Recover the ledger page before the tide turns."],
      endingHook: "The ally's seal is on the page.",
    }],
    characterChanges: ["Lin Yue commits to the debt trail."],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: ["Advance mentor-debt."],
    mustKeep: ["The jade seal cannot be destroyed."],
    mustAvoid: ["Do not reveal the mentor's motive."],
    styleEmphasis: ["Restrained tension."],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function makeWriterRailInput(boundArcId: string, targetChapters: number): StoryRailPlanInput {
  const routeEntryCount = Math.ceil(targetChapters / 3);
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
      entries: Array.from({ length: routeEntryCount }, (_, index) => ({
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

function createCaptureLogger() {
  const infos: string[] = [];
  const warnings: string[] = [];

  const logger = {
    debug() {},
    info(message: string) {
      infos.push(message);
    },
    warn(message: string) {
      warnings.push(message);
    },
    error() {},
    child() {
      return logger;
    },
  };

  return { logger, infos, warnings };
}

describe("WriterAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders per-chapter user context in governed creative prompts", () => {
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-writer-context-test",
    });

    const prompt = (agent as unknown as {
      buildGovernedUserPrompt(params: {
        readonly chapterNumber: number;
        readonly chapterMemo: {
          readonly chapter: number;
          readonly goal: string;
          readonly isGoldenOpening: boolean;
          readonly body: string;
          readonly threadRefs: readonly string[];
        };
        readonly contextPackage: { readonly chapter: number; readonly selectedContext: readonly [] };
        readonly ruleStack: {
          readonly layers: readonly [];
          readonly sections: { readonly hard: readonly string[]; readonly soft: readonly string[]; readonly diagnostic: readonly string[] };
          readonly overrideEdges: readonly [];
          readonly activeOverrides: readonly [];
        };
        readonly lengthSpec: ReturnType<typeof buildLengthSpec>;
        readonly language?: "zh" | "ko" | "en";
        readonly externalContext?: string;
      }): string;
    }).buildGovernedUserPrompt({
      chapterNumber: 7,
      chapterMemo: {
        chapter: 7,
        goal: "推进账本线",
        isGoldenOpening: false,
        body: "## 当前任务\n围绕账本线推进。",
        threadRefs: [],
      },
      contextPackage: { chapter: 7, selectedContext: [] },
      ruleStack: {
        layers: [],
        sections: { hard: [], soft: [], diagnostic: [] },
        overrideEdges: [],
        activeOverrides: [],
      },
      lengthSpec: buildLengthSpec(1200, "zh"),
      language: "zh",
      externalContext: "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。",
    });

    expect(prompt).toContain("本章用户指令");
    expect(prompt).toContain("本章标题：雨夜账本");
    expect(prompt).toContain("当面对质");
  });

  it("caps oversized legacy truth files in creative prompts", () => {
    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: "/tmp/inkos-writer-context-budget-test",
    });
    const oversizedStoryBible = [
      "BEGIN-STORY",
      "旧设定。".repeat(4000),
      "MIDDLE-MARKER",
      "近期设定。".repeat(4000),
      "LATEST-STORY",
    ].join("\n");

    const prompt = (agent as unknown as {
      buildUserPrompt(params: {
        readonly chapterNumber: number;
        readonly storyBible: string;
        readonly currentState: string;
        readonly ledger: string;
        readonly hooks: string;
        readonly recentChapters: string;
        readonly lengthSpec: ReturnType<typeof buildLengthSpec>;
        readonly chapterSummaries: string;
        readonly subplotBoard: string;
        readonly emotionalArcs: string;
        readonly characterMatrix: string;
        readonly language?: "zh" | "ko" | "en";
      }): string;
    }).buildUserPrompt({
      chapterNumber: 88,
      storyBible: oversizedStoryBible,
      currentState: "(文件尚未创建)",
      ledger: "",
      hooks: "(文件尚未创建)",
      recentChapters: "",
      lengthSpec: buildLengthSpec(1200, "zh"),
      chapterSummaries: "(文件尚未创建)",
      subplotBoard: "(文件尚未创建)",
      emotionalArcs: "(文件尚未创建)",
      characterMatrix: "(文件尚未创建)",
      language: "zh",
    });

    expect(prompt).toContain("BEGIN-STORY");
    expect(prompt).toContain("LATEST-STORY");
    expect(prompt).toContain("InkOS context budget");
    expect(prompt).toContain("story_bible");
    expect(prompt).not.toContain("MIDDLE-MARKER");
  });

  it("uses compact summary context plus selected long-range evidence during governed settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "# Pending Hooks",
        "",
        "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
        "| old-seal | 3 | artifact | open | 12 | 40 | Old seal detour |",
        "| stale-ledger | 14 | mystery | open | 70 | 120 | Old ledger debt is dormant but unresolved |",
        "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "# Chapter Summaries",
        "",
        "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
        "| 97 | Shrine Ash | Lin Yue | The old shrine proves empty | Frustration rises | none | bitter | setback |",
        "| 98 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
        "| 99 | Locked Gate | Lin Yue | Lin Yue chooses the mentor line over the guild line | Mentor conflict takes priority | mentor-oath advanced | focused | decision |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), [
        "# 支线进度板",
        "",
        "| 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| SP-mentor | 师债线 | Lin Yue | 8 | 99 | 1 | active | 师债继续推进 | 101 |",
        "| SP-seal | 旧印支线 | Guildmaster Ren | 3 | 12 | 88 | closed | 旧印已回收 | 12 |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), [
        "# 情感弧线",
        "",
        "| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |",
        "| --- | --- | --- | --- | --- | --- |",
        "| Lin Yue | 40 | 麻木 | 旧印支线拖延 | 4 | 停滞 |",
        "| Lin Yue | 99 | 紧绷 | 师债重新压上来 | 8 | 收紧 |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), [
        "# 角色交互矩阵",
        "",
        "### 角色档案",
        "| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| Lin Yue | oath | restraint | clipped | stubborn | self | repay debt | find mentor |",
        "| Guildmaster Ren | guild | swagger | loud | opportunistic | rival | stall Mara | seize seal |",
      ].join("\n"), "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "A Decision",
          "",
          "=== CHAPTER_CONTENT ===",
          "Lin Yue turned away from the guild trail and chose the mentor debt.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "| 伏笔变动 | mentor-oath 推进 | 同步更新伏笔池 |",
          "",
          "=== UPDATED_STATE ===",
          "状态卡",
          "",
          "=== UPDATED_HOOKS ===",
          "伏笔池",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 100 | A Decision | Lin Yue | Chooses the mentor debt | Focus narrowed | mentor-oath advanced | tense | decision |",
          "",
          "=== UPDATED_SUBPLOTS ===",
          "支线板",
          "",
          "=== UPDATED_EMOTIONAL_ARCS ===",
          "情感弧线",
          "",
          "=== UPDATED_CHARACTER_MATRIX ===",
          "角色矩阵",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 120,
          chapterWordCount: 2200,
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 100,
        chapterIntent: [
          "# Chapter Intent",
          "",
          "## Goal",
          "Bring the focus back to the mentor oath conflict.",
          "",
          "## Hook Agenda",
          "### Must Advance",
          "- mentor-oath",
          "",
          "### Eligible Resolve",
          "- none",
          "",
          "### Stale Debt",
          "- stale-ledger",
          "",
          "### Avoid New Hook Families",
          "- none",
        ].join("\n"),
        contextPackage: {
          chapter: 100,
          selectedContext: [
            {
              source: "story/volume_outline.md",
              reason: "Anchor the current beat.",
              excerpt: "Bring the focus back to the mentor oath conflict.",
            },
            {
              source: "story/chapter_summaries.md#99",
              reason: "Relevant episodic memory.",
              excerpt: "Locked Gate | Lin Yue chooses the mentor line over the guild line | mentor-oath advanced",
            },
            {
              source: "story/pending_hooks.md#mentor-oath",
              reason: "Carry forward unresolved hook.",
              excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
            },
            {
              source: "runtime/hook_debt#mentor-oath",
              reason: "Explicit hook debt brief for the agenda target.",
              excerpt: "mentor-oath | cadence: slow-burn | seed: ch8 River Camp - Mentor debt becomes personal | latest: ch99 Locked Gate - Lin Yue chooses the mentor line over the guild line | unpaid: reveal why the mentor broke the oath",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(220, "zh"),
      });

      const settlePrompt = (chatSpy.mock.calls[2]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(settlePrompt).toContain("## 本章控制输入");
      expect(settlePrompt).toContain("story/chapter_summaries.md#99");
      expect(settlePrompt).toContain("| 99 | Locked Gate |");
      expect(settlePrompt).toContain("## Hook Debt Briefs");
      expect(settlePrompt).toContain("mentor-oath | cadence: slow-burn");
      expect(settlePrompt).toContain("| stale-ledger | 14 | mystery | open | 70 | 120 | 中程 | 无 |  | 否 |  |  | Old ledger debt is dormant but unresolved |");
      expect(settlePrompt).not.toContain("| 1 | Guild Trail |");
      expect(settlePrompt).not.toContain("old-seal");
      expect(settlePrompt).not.toContain("Guildmaster Ren");
      expect(settlePrompt).not.toContain("| Lin Yue | 40 | 麻木 |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds structured runtime-state artifacts when settler returns a delta", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-runtime-state-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(storyDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });
    await mkdir(join(storyDir, "arcs"), { recursive: true });

    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "writer-book",
        title: "Writer Book",
        platform: "tomato",
        genre: "xuanhuan",
        status: "active",
        targetChapters: 20,
        chapterWordCount: 2200,
        language: "en",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }), "utf-8"),
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
      ]), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 3\nTrace the debt through the river-port ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 2 |",
        "| Current Goal | Find the vanished mentor |",
        "| Current Conflict | Guild pressure keeps colliding with the debt trail |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| mentor-debt | 1 | relationship | open | 2 | 6 | Still unresolved |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 2 | Old Ledger | Lin Yue | Lin Yue finds the old ledger | Debt sharpens | mentor-debt advanced | tense | mainline |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(
        join(storyDir, "arcs", "arc-river-ledger.json"),
        `${JSON.stringify(makeArcPacket(), null, 2)}\n`,
        "utf-8",
      ),
      writeFile(
        join(storyDir, "arcs", "active.json"),
        `${JSON.stringify({ arcId: "arc-river-ledger", updatedAt: "2026-08-09T00:00:00.000Z" }, null, 2)}\n`,
        "utf-8",
      ),
    ]);
    await new StoryRailStore(bookDir, {
      now: () => new Date("2026-08-09T00:30:00.000Z"),
    }).replace("writer-book", makeWriterRailInput("arc-river-ledger", 20));

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "River Ledger",
          "",
          "=== CHAPTER_CONTENT ===",
          "Lin Yue follows the debt into the river-port ledger.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- mentor-debt advanced",
          "",
          "=== RUNTIME_STATE_DELTA ===",
          "```json",
          JSON.stringify({
            chapter: 3,
            currentStatePatch: {
              currentGoal: "Trace the debt through the river-port ledger.",
              currentConflict: "Guild pressure keeps colliding with the debt trail.",
            },
            hookOps: {
              upsert: [
                {
                  hookId: "mentor-debt",
                  startChapter: 1,
                  type: "relationship",
                  status: "progressing",
                  lastAdvancedChapter: 3,
                  expectedPayoff: "Reveal the debt.",
                  notes: "The ledger clue sharpens the line.",
                },
              ],
              resolve: [],
              defer: [],
            },
            chapterSummary: {
              chapter: 3,
              title: "River Ledger",
              characters: "Lin Yue",
              events: "Lin Yue follows the debt into the river-port ledger.",
              stateChanges: "The debt line sharpens.",
              hookActivity: "mentor-debt advanced",
              mood: "tense",
              chapterType: "investigation",
            },
            notes: [],
          }, null, 2),
          "```",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const output = await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 3,
        externalContext: "Use the exact title River Ledger.",
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      expect(output.runtimeStateDelta?.chapter).toBe(3);
      expect(output.runtimeStateSnapshot?.manifest.lastAppliedChapter).toBe(3);
      expect(output.updatedState).toContain("Trace the debt through the river-port ledger.");
      expect(output.updatedHooks).toContain("mentor-debt");
      expect(output.updatedChapterSummaries).toContain("River Ledger");
      expect(output.chapterSummary).toContain("| 3 | River Ledger |");
      expect(output.arcProvenance).toMatchObject({
        bookId: "writer-book",
        arcId: "arc-river-ledger",
        chapterNumber: 3,
        beats: ["Recover the ledger page before the tide turns."],
        storyRail: {
          anchor: { id: "A01" },
          activeB: { bId: "B001" },
          nextB: { bId: "B002", status: "provisional" },
        },
      });
      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(creativePrompt).toContain("Per-chapter user instruction (highest priority)");
      expect(creativePrompt).toContain("Use the exact title River Ledger.");
      expect(creativePrompt).toContain("Active Arc planning guidance (subordinate authority)");
      expect(creativePrompt).toContain("Recover the ledger page before the tide turns.");
      expect(creativePrompt).toContain("Next provisional B: B002 → A02");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the Planner-supplied Arc snapshot instead of re-reading a raced disk active Arc", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-arc-snapshot-race-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    const plannerArc: ArcPacket = {
      ...makeArcPacket(),
      id: "arc-planner-snapshot",
      title: "Planner Snapshot Arc",
      promise: "PLANNER_SNAPSHOT_PROMISE",
      goal: "Follow the plan captured before Writer starts.",
      episodeBeats: [{
        chapterNumber: 3,
        role: "payoff",
        beats: ["PLANNER_SNAPSHOT_BEAT"],
        endingHook: "The captured plan remains authoritative for this run.",
      }],
      updatedAt: "2026-08-09T01:00:00.000Z",
    };
    const diskArc: ArcPacket = {
      ...makeArcPacket(),
      id: "arc-disk-race-winner",
      title: "Disk Race Arc",
      promise: "DISK_RACE_PROMISE_MUST_NOT_APPEAR",
      goal: "This later active Arc belongs to another planning run.",
      episodeBeats: [{
        chapterNumber: 3,
        role: "payoff",
        beats: ["DISK_RACE_BEAT_MUST_NOT_APPEAR"],
        endingHook: "A later pointer should not replace the supplied snapshot.",
      }],
      updatedAt: "2026-08-09T02:00:00.000Z",
    };
    const plannerSnapshot = resolveArcChapterContext(plannerArc, 3)!.provenance;

    await mkdir(chaptersDir, { recursive: true });
    await mkdir(join(storyDir, "arcs"), { recursive: true });
    await Promise.all([
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
      ]), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The seal remains intact.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 3\nFollow the captured plan.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n| Current Chapter | 2 |\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "| hook_id | status |\n| --- | --- |\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "| chapter | title | events |\n| --- | --- | --- |\n", "utf-8"),
      writeFile(join(storyDir, "arcs", `${diskArc.id}.json`), `${JSON.stringify(diskArc, null, 2)}\n`, "utf-8"),
      writeFile(
        join(storyDir, "arcs", "active.json"),
        `${JSON.stringify({ arcId: diskArc.id, updatedAt: diskArc.updatedAt }, null, 2)}\n`,
        "utf-8",
      ),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "Captured Plan",
          "",
          "=== CHAPTER_CONTENT ===",
          "Lin Yue follows the plan captured before the active pointer changes.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- captured plan applied",
          "",
          "=== RUNTIME_STATE_DELTA ===",
          "```json",
          JSON.stringify({
            chapter: 3,
            currentStatePatch: { currentGoal: "Continue from the captured plan." },
            hookOps: { upsert: [], resolve: [], defer: [] },
            chapterSummary: {
              chapter: 3,
              title: "Captured Plan",
              characters: "Lin Yue",
              events: "Lin Yue follows the captured plan.",
              stateChanges: "The plan advances.",
              hookActivity: "none",
              mood: "tense",
              chapterType: "investigation",
            },
            notes: [],
          }, null, 2),
          "```",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const output = await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 3,
        arcProvenance: plannerSnapshot,
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(creativePrompt).toContain("PLANNER_SNAPSHOT_PROMISE");
      expect(creativePrompt).toContain("PLANNER_SNAPSHOT_BEAT");
      expect(creativePrompt).not.toContain("DISK_RACE_PROMISE_MUST_NOT_APPEAR");
      expect(creativePrompt).not.toContain("DISK_RACE_BEAT_MUST_NOT_APPEAR");
      expect(output.arcProvenance).toEqual(plannerSnapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to legacy settlement tags when runtime-state delta JSON is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-bad-delta-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The jade seal cannot be destroyed.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 3\nTrace the debt.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep it tense.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n| Field | Value |\n| --- | --- |\n| Current Chapter | 2 |\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "| hook_id | status |\n| --- | --- |\n| mentor-debt | open |\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "| chapter | title | events |\n| --- | --- | --- |\n| 2 | Old Ledger | Debt sharpens |\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "| character | role |\n| --- | --- |\n| Lin Yue | lead |\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- legacy settlement survived",
          "",
          "=== RUNTIME_STATE_DELTA ===",
          "{ this is not json }",
          "",
          "=== UPDATED_STATE ===",
          "| Field | Value |",
          "| --- | --- |",
          "| Current Chapter | 3 |",
          "| Current Goal | Keep tracing the debt |",
          "",
          "=== UPDATED_HOOKS ===",
          "| hook_id | status |",
          "| --- | --- |",
          "| mentor-debt | progressing |",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 3 | River Ledger | Lin Yue | Legacy fallback wrote summary |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const output = await agent.settleChapterState({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "other",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 3,
        title: "River Ledger",
        content: "Lin Yue follows the debt into the river-port ledger.",
      });

      expect(output.runtimeStateDelta).toBeUndefined();
      expect(output.postSettlement).toContain("legacy settlement survived");
      expect(output.updatedState).toContain("Keep tracing the debt");
      expect(output.updatedHooks).toContain("mentor-debt");
      expect(output.chapterSummary).toContain("Legacy fallback wrote summary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overrides hallucinated chapter numbers across both delta and summary row", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-runtime-state-hallucinated-chapter-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(storyDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });

    await Promise.all([
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
      ]), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The city still remembers 1988.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 3\nTrace the debt through the river-port ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 2 |",
        "| Current Goal | Find the vanished mentor |",
        "| Current Conflict | Guild pressure keeps colliding with the debt trail |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| mentor-debt | 1 | relationship | open | 2 | 6 | Still unresolved |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 2 | Old Ledger | Lin Yue | Lin Yue finds the old ledger | Debt sharpens | mentor-debt advanced | tense | mainline |",
        "",
      ].join("\n"), "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "River Ledger",
          "",
          "=== CHAPTER_CONTENT ===",
          "Lin Yue follows the debt into the river-port ledger. The old wall still carries the year 1988.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- mentor-debt advanced",
          "",
          "=== RUNTIME_STATE_DELTA ===",
          "```json",
          JSON.stringify({
            chapter: 1988,
            currentStatePatch: {
              currentGoal: "Trace the debt through the river-port ledger.",
              currentConflict: "Guild pressure keeps colliding with the debt trail.",
            },
            hookOps: {
              upsert: [
                {
                  hookId: "mentor-debt",
                  startChapter: 1,
                  type: "relationship",
                  status: "progressing",
                  lastAdvancedChapter: 1988,
                  expectedPayoff: "Reveal the debt.",
                  notes: "The ledger clue sharpens the line.",
                },
              ],
              resolve: [],
              defer: [],
            },
            chapterSummary: {
              chapter: 1988,
              title: "River Ledger",
              characters: "Lin Yue",
              events: "Lin Yue follows the debt into the river-port ledger.",
              stateChanges: "The debt line sharpens.",
              hookActivity: "mentor-debt advanced",
              mood: "tense",
              chapterType: "investigation",
            },
            notes: [],
          }, null, 2),
          "```",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const output = await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-25T00:00:00.000Z",
          updatedAt: "2026-03-25T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 3,
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      expect(output.runtimeStateDelta?.chapter).toBe(3);
      expect(output.runtimeStateDelta?.chapterSummary?.chapter).toBe(3);
      expect(output.runtimeStateSnapshot?.manifest.lastAppliedChapter).toBe(3);
      expect(output.runtimeStateSnapshot?.hooks.hooks[0]?.lastAdvancedChapter).toBe(3);
      expect(output.updatedHooks).toContain("| mentor-debt | 1 | relationship | progressing | 3 |");
      expect(output.updatedChapterSummaries).toContain("| 3 | River Ledger |");
      expect(output.chapterSummary).toContain("| 3 | River Ledger |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the arbiter-resolved delta instead of raw new-hook candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-arbiter-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(storyDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });

    await Promise.all([
      writeFile(join(chaptersDir, "index.json"), JSON.stringify([
        { number: 1, title: "Ch1", status: "approved" },
        { number: 2, title: "Ch2", status: "approved" },
      ]), "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- Anonymous messages keep steering the debt trail.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 3\nThe anonymous source widens from route to address.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), [
        "# Current State",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| Current Chapter | 2 |",
        "| Current Goal | Find who fed the route to the anonymous source |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| anonymous-source-scope | 1 | source-risk | open | 2 | Reveal how much the anonymous source already knew about the route. | The source knowledge question remains unresolved. |",
        "",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 2 | Route Leak | Lin Yue | An anonymous source already knew the route | Suspicion sharpens | anonymous-source-scope advanced | tense | mainline |",
        "",
      ].join("\n"), "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "Address Leak",
          "",
          "=== CHAPTER_CONTENT ===",
          "Lin Yue realizes the anonymous source knew the address, not just the route.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- source scope widens",
          "",
          "=== RUNTIME_STATE_DELTA ===",
          "```json",
          JSON.stringify({
            chapter: 3,
            hookOps: {
              upsert: [],
              mention: [],
              resolve: [],
              defer: [],
            },
            newHookCandidates: [
              {
                type: "source-risk",
                expectedPayoff: "Reveal how much the anonymous source already knew about the route and address.",
                notes: "This chapter adds the address angle to the anonymous source question.",
              },
            ],
            chapterSummary: {
              chapter: 3,
              title: "Address Leak",
              characters: "Lin Yue",
              events: "Lin Yue realizes the anonymous source knew the address.",
              stateChanges: "The source knowledge question widens.",
              hookActivity: "anonymous-source-scope advanced",
              mood: "tight",
              chapterType: "investigation",
            },
            notes: [],
          }, null, 2),
          "```",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      const output = await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "other",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-27T00:00:00.000Z",
          updatedAt: "2026-03-27T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 3,
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      expect(output.runtimeStateDelta?.hookOps.upsert).toEqual([
        expect.objectContaining({
          hookId: "anonymous-source-scope",
          lastAdvancedChapter: 3,
        }),
      ]);
      expect(output.runtimeStateDelta?.newHookCandidates).toEqual([]);
      expect(output.updatedHooks).toContain("anonymous-source-scope");
      expect(output.updatedHooks).toContain("| anonymous-source-scope | 1 | source-risk | progressing | 3 |");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs localized phase messages for Chinese books", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const { logger, infos } = createCaptureLogger();
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(root, "prompt", "longform"), { recursive: true });

    await Promise.all([
      writeFile(join(root, "prompt", "longform", "writer.md"), "PROJECT WRITER OVERRIDE", "utf-8"),
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# 当前状态\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 伏笔池\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# 章节摘要\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
      logger,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "试炼前夜",
          "",
          "=== CHAPTER_CONTENT ===",
          "林越在破庙外停住脚步，想起师门旧债。",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "| 伏笔变动 | mentor-oath 推进 | 同步更新伏笔池 |",
          "",
          "=== UPDATED_STATE ===",
          "状态卡",
          "",
          "=== UPDATED_HOOKS ===",
          "伏笔池",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 1 | 试炼前夜 | 林越 | 林越记起师门旧债 | 决心加深 | mentor-oath advanced | tense | setup |",
          "",
          "=== UPDATED_SUBPLOTS ===",
          "支线板",
          "",
          "=== UPDATED_EMOTIONAL_ARCS ===",
          "情感弧线",
          "",
          "=== UPDATED_CHARACTER_MATRIX ===",
          "角色矩阵",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "tomato",
          genre: "xuanhuan",
          status: "active",
          targetChapters: 120,
          chapterWordCount: 2200,
          language: "zh",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 1,
        lengthSpec: buildLengthSpec(220, "zh"),
      });

      expect(infos).toEqual(expect.arrayContaining([
        "阶段 1：创作正文（第1章）",
        "阶段 2：状态结算（第1章，18字）",
        "阶段 2a：提取第1章事实",
        "阶段 2b：把观察结果回写到真相文件",
      ]));
      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined;
      expect(messages?.[0]?.content ?? "").toContain("PROJECT WRITER OVERRIDE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects an English variance brief into governed creative prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-variance-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(storyDir, { recursive: true });
    await mkdir(chaptersDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- The registry seals matter.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 4\nForce Mara back toward the ledger trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose lean.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara still hides the ledger fragment.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), [
        "| hook_id | start_chapter | type | status | last_advanced | expected_payoff | notes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        "| ledger-fragment | 1 | mystery | open | 3 | 8 | Mara still hides the ledger fragment |",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), [
        "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        "| 1 | Ledger | Mara | Mara hides the ledger | pressure tightens | none | tense | investigation |",
        "| 2 | Ash | Mara,Taryn | Ash falls over the archive | pressure tightens | none | tense | investigation |",
        "| 3 | Harbor | Mara,Taryn | The gate stays under watch | pressure tightens | none | tense | investigation |",
      ].join("\n"), "utf-8"),
      writeFile(join(chaptersDir, "0001_Ledger.md"), "# Chapter 1 Ledger\n\nMara kept the ledger close to her chest. The corridor stayed quiet after the bell. There it was again.\n", "utf-8"),
      writeFile(join(chaptersDir, "0002_Ash.md"), "# Chapter 2 Ash\n\nMara kept the ledger close to her chest while the ash fell. The corridor stayed quiet until Taryn stopped. There it was again.\n", "utf-8"),
      writeFile(join(chaptersDir, "0003_Harbor.md"), "# Chapter 3 Harbor\n\nMara kept the ledger close to her chest near the harbor gate. The corridor stayed quiet while the guards changed. There it was again.\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "Pressure Ledger",
          "",
          "=== CHAPTER_CONTENT ===",
          "Mara forced Taryn to answer beside the archive window.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- ledger-fragment advanced",
          "",
          "=== UPDATED_STATE ===",
          "state",
          "",
          "=== UPDATED_HOOKS ===",
          "hooks",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 4 | Pressure Ledger | Mara,Taryn | Pressure rises | Trail narrows | ledger-fragment advanced | tense | confrontation |",
          "",
          "=== UPDATED_SUBPLOTS ===",
          "subplots",
          "",
          "=== UPDATED_EMOTIONAL_ARCS ===",
          "arcs",
          "",
          "=== UPDATED_CHARACTER_MATRIX ===",
          "matrix",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 4,
        chapterMemo: {
          chapter: 4,
          goal: "Force Mara back toward the ledger trail.",
          isGoldenOpening: false,
          body: "",
          threadRefs: ["ledger-fragment"],
        },
        contextPackage: {
          chapter: 4,
          selectedContext: [
            {
              source: "story/chapter_summaries.md#3",
              reason: "Carry recent pressure into the next chapter.",
              excerpt: "The gate stays under watch.",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(creativePrompt).toContain("## English Variance Brief");
      expect(creativePrompt).toContain("High-frequency phrases");
      expect(creativePrompt).toContain("Scene obligation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders explicit title history, mood trail, and canon blocks in governed creative prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-governed-evidence-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- Registry seals still matter.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 4\nPush Mara back toward the archive ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose lean.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara still hides the ledger fragment.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- ledger-fragment\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "Archive Pressure",
          "",
          "=== CHAPTER_CONTENT ===",
          "Mara corners Taryn beside the archive ledger.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- ledger-fragment advanced",
          "",
          "=== UPDATED_STATE ===",
          "state",
          "",
          "=== UPDATED_HOOKS ===",
          "hooks",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 4 | Archive Pressure | Mara,Taryn | Pressure rises | Trail narrows | ledger-fragment advanced | tense | confrontation |",
          "",
          "=== UPDATED_SUBPLOTS ===",
          "subplots",
          "",
          "=== UPDATED_EMOTIONAL_ARCS ===",
          "arcs",
          "",
          "=== UPDATED_CHARACTER_MATRIX ===",
          "matrix",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 4,
        chapterMemo: {
          chapter: 4,
          goal: "Push Mara back toward the archive ledger.",
          isGoldenOpening: false,
          body: "",
          threadRefs: ["ledger-fragment"],
        },
        contextPackage: {
          chapter: 4,
          selectedContext: [
            {
              source: "story/chapter_summaries.md#recent_titles",
              reason: "Avoid repeated ledger titles.",
              excerpt: "1: Ledger in Rain | 2: Ledger at Dusk | 3: Harbor Ledger",
            },
            {
              source: "story/chapter_summaries.md#recent_mood_type_trail",
              reason: "Track recent emotional and chapter-type cadence.",
              excerpt: "1: tight / investigation | 2: tight / investigation | 3: tight / investigation",
            },
            {
              source: "story/parent_canon.md",
              reason: "Preserve parent canon constraints.",
              excerpt: "The mentor does not learn about the archive fire until volume two.",
            },
            {
              source: "story/fanfic_canon.md",
              reason: "Preserve extracted fanfic canon constraints.",
              excerpt: "Mara may diverge from the archive route, but the oath debt logic must stay intact.",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";
      expect(creativePrompt).toContain("## Recent Title History");
      expect(creativePrompt).toContain("Ledger in Rain");
      expect(creativePrompt).toContain("## Recent Mood / Chapter Type Trail");
      expect(creativePrompt).toContain("tight / investigation");
      expect(creativePrompt).toContain("## Canon Evidence");
      expect(creativePrompt).toContain("archive fire until volume two");
      expect(creativePrompt).toContain("oath debt logic must stay intact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes governed control inputs so raw hook ids and control headings do not enter the creative prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-writer-hook-agenda-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n\n- Registry seals still matter.\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 4\nPush Mara back toward the archive ledger.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose lean.\n", "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara still hides the ledger fragment.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n\n- ledger-fragment\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
    ]);

    const agent = new WriterAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: [
          "=== CHAPTER_TITLE ===",
          "Archive Pressure",
          "",
          "=== CHAPTER_CONTENT ===",
          "Mara corners Taryn beside the archive ledger.",
          "",
          "=== PRE_WRITE_CHECK ===",
          "- ok",
        ].join("\n"),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: "=== OBSERVATIONS ===\n- observed",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: [
          "=== POST_SETTLEMENT ===",
          "- ledger-fragment advanced",
          "",
          "=== UPDATED_STATE ===",
          "state",
          "",
          "=== UPDATED_HOOKS ===",
          "hooks",
          "",
          "=== CHAPTER_SUMMARY ===",
          "| 4 | Archive Pressure | Mara,Taryn | Pressure rises | Trail narrows | ledger-fragment advanced | tense | confrontation |",
          "",
          "=== UPDATED_SUBPLOTS ===",
          "subplots",
          "",
          "=== UPDATED_EMOTIONAL_ARCS ===",
          "arcs",
          "",
          "=== UPDATED_CHARACTER_MATRIX ===",
          "matrix",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    try {
      await agent.writeChapter({
        book: {
          id: "writer-book",
          title: "Writer Book",
          platform: "other",
          genre: "other",
          status: "active",
          targetChapters: 20,
          chapterWordCount: 2200,
          language: "en",
          createdAt: "2026-03-26T00:00:00.000Z",
          updatedAt: "2026-03-26T00:00:00.000Z",
        },
        bookDir,
        chapterNumber: 4,
        chapterMemo: {
          chapter: 4,
          goal: "Push Mara back toward the archive ledger.",
          isGoldenOpening: false,
          body: "本章要做的是推进 ledger-fragment tension at the archive.",
          threadRefs: ["mentor-oath", "ledger-fragment"],
        },
        contextPackage: {
          chapter: 4,
          selectedContext: [
            {
              source: "story/pending_hooks.md#mentor-oath",
              reason: "Carry the unresolved oath line.",
              excerpt: "relationship | open | old oath debt",
            },
          ],
        },
        ruleStack: {
          layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }],
          sections: {
            hard: ["current_state"],
            soft: ["current_focus"],
            diagnostic: ["continuity_audit"],
          },
          overrideEdges: [],
          activeOverrides: [],
        },
        lengthSpec: buildLengthSpec(2200, "en"),
      });

      const systemPrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[0]?.content ?? "";
      const creativePrompt = (chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }> | undefined)?.[1]?.content ?? "";

      expect(systemPrompt).not.toContain("Hook-A / Hook-B");
      expect(systemPrompt).toContain("Real hook_id"); // English book gets the English output scaffold
      // Enum/identifier fields (hookId, movement, chapterType) are NOT sanitized —
      // the writer needs them to understand which hook to move and what chapter type
      // to write. Free-text fields (goal, instruction, targetEffect) ARE sanitized.
      expect(creativePrompt).not.toContain("## Hook Agenda");
      // hookIds appear verbatim in Hook Plan (identifiers, not free text)
      expect(creativePrompt).toContain("mentor-oath");
      expect(creativePrompt).toContain("ledger-fragment");
      // But slug references INSIDE free text (targetEffect) are sanitized
      expect(creativePrompt).not.toContain("stale-ledger");
      expect(creativePrompt).not.toContain("H001");
      expect(creativePrompt).not.toContain("本章要做的");
      // The goal text should survive sanitization
      expect(creativePrompt).toContain("Push Mara back toward the archive ledger.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
