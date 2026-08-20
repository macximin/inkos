import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityAuditor } from "../agents/continuity.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("ContinuityAuditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a critical audit issue instead of throwing when audit output is not JSON", () => {
    const auditor = new ContinuityAuditor({
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
      projectRoot: "/tmp/inkos-auditor-bad-json-test",
    });

    const result = (auditor as any).parseAuditResult("模型只返回了一段散文，没有 JSON。", "zh");

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("审稿输出解析失败");
    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: "critical",
        category: "系统错误",
      }),
    ]);
  });

  it("parses typed repair_scope from audit JSON", () => {
    const auditor = new ContinuityAuditor({
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
      projectRoot: "/tmp/inkos-auditor-repair-scope-test",
    });

    const result = (auditor as any).parseAuditResult(JSON.stringify({
      passed: false,
      issues: [{
        severity: "critical",
        repair_scope: "structural",
        category: "模型审稿判断",
        description: "核心场面缺失",
        suggestion: "重写场面",
      }],
      summary: "needs rewrite",
    }), "zh");

    expect(result.issues[0]).toMatchObject({
      repairScope: "structural",
      category: "模型审稿判断",
    });
  });

  it("keeps future-advantage research separate while preserving real creative blockers", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-future-separation-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "future-book",
        title: "미래를 당겨온 재벌",
        genre: "other",
        platform: "other",
        chapterWordCount: 5000,
        targetChapters: 200,
        status: "active",
        language: "ko",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "current_state.md"), "# 현재 상태\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 복선 목록\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# 회차 요약\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 보조 사건선\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 감정선\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 인물 관계\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# 권 구성\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# 문체 지침\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never)
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          research_status: "verified",
          overall_score: 72,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            category: "시대 고증",
            description: "실제 역사보다 3년 빠르며 외부 근거가 아직 없다.",
            suggestion: "실제 역사로 되돌린다.",
          }],
          summary: "고증 확인 필요",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          research_status: "not-checked",
          overall_score: 61,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            category: "미래 선점 정보 경계 위반",
            description: "주인공이 알 수 없는 비공개 협상 내용을 사용했다.",
            suggestion: "정보 획득 장면을 만든다.",
          }],
          summary: "정보 경계 위반",
        }),
        usage: ZERO_USAGE,
      });
    const arcContext = [
      "## Future Advantage Move",
      "- Target: 반도체 장비 국산화",
      "- Authorized divergences: 상용화를 실제보다 3년 앞당긴다",
      "- A-Rail bridge: 퇴직 기술자 영입; 시험 라인 확보",
      "- A-Rail proof: 첫 납품 검사 통과",
      "- A-Rail reward: 계열사 우선 공급권",
    ].join("\n");

    try {
      const researchOnly = await auditor.auditChapter(bookDir, "시험 라인이 돌아갔다.", 1, "other", { arcContext });
      expect(researchOnly.passed).toBe(true);
      expect(researchOnly.creativePassed).toBe(true);
      expect(researchOnly.researchStatus).toBe("needs-research");
      expect(researchOnly.issues[0]).toMatchObject({ severity: "info", track: "research" });

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      expect(messages[0]?.content).toContain("당신은 엄격한");
      expect(messages[0]?.content).toContain("허용된 역사 분기");
      expect(messages[0]?.content).not.toContain("You are a strict");
      expect(messages[1]?.content).toContain("## 감리할 원고");

      const boundaryBreach = await auditor.auditChapter(bookDir, "비공개 협상 결과를 이미 알았다.", 1, "other", { arcContext });
      expect(boundaryBreach.passed).toBe(false);
      expect(boundaryBreach.creativePassed).toBe(false);
      expect(boundaryBreach.issues[0]).toMatchObject({ severity: "critical", track: "creative" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers book language override when building audit prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-lang-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await mkdir(join(root, "prompt", "longform"), { recursive: true });

    await Promise.all([
      writeFile(join(root, "prompt", "longform", "auditor.md"), "PROJECT AUDITOR OVERRIDE", "utf-8"),
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "xuanhuan",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue keeps the oath token hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nReturn to the mentor debt.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "xuanhuan");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";

      expect(systemPrompt).toContain("ALL OUTPUT MUST BE IN ENGLISH");
      expect(systemPrompt).toContain("PROJECT AUDITOR OVERRIDE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("localizes English audit prompts instead of mixing Chinese control text", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-en-prompt-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(
        join(bookDir, "book.json"),
        JSON.stringify({
          id: "english-book",
          title: "English Book",
          genre: "other",
          platform: "royalroad",
          chapterWordCount: 800,
          targetChapters: 60,
          status: "active",
          language: "en",
          createdAt: "2026-03-23T00:00:00.000Z",
          updatedAt: "2026-03-23T00:00:00.000Z",
        }, null, 2),
        "utf-8",
      ),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Mara keeps the warehouse key hidden.\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 1\nCheck Warehouse 9.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 1, "other");

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      expect(systemPrompt).toContain("Hook Check");
      expect(systemPrompt).toContain("Chapter Memo Drift Check");
      expect(systemPrompt).not.toContain("Outline Drift Check");
      expect(systemPrompt).toContain("stays dormant long enough to feel abandoned");
      expect(systemPrompt).toContain("3-question test");
      expect(systemPrompt).toContain("same mode long enough to flatten rhythm");
      expect(systemPrompt).not.toContain("more than 5 chapters");
      expect(systemPrompt).not.toContain("3 straight chapters");
      expect(systemPrompt).not.toContain("3+ consecutive chapters");
      expect(systemPrompt).not.toContain("伏笔检查");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      expect(userPrompt).toContain("Review chapter 1.");
      expect(userPrompt).toContain("## Current State Card");
      expect(userPrompt).toContain("## Pending Hooks");
      expect(userPrompt).not.toContain("请审查第1章");
      expect(userPrompt).not.toContain("## 当前状态卡");
      expect(userPrompt).not.toContain("## 伏笔池");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses selected summary and hook evidence instead of full long-history markdown in governed mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-test-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\n- Lin Yue still hides the broken oath token.\n", "utf-8"),
      writeFile(
        join(storyDir, "pending_hooks.md"),
        [
          "# Pending Hooks",
          "",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| guild-route | 1 | mystery | open | 2 | 6 | Merchant guild trail |",
          "| mentor-oath | 8 | relationship | open | 99 | 101 | Mentor oath debt with Lin Yue |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(
        join(storyDir, "chapter_summaries.md"),
        [
          "# Chapter Summaries",
          "",
          "| 1 | Guild Trail | Merchant guild flees west | Route clues only | None | guild-route seeded | tense | action |",
          "| 99 | Trial Echo | Lin Yue | Mentor left without explanation | Oath token matters again | mentor-oath advanced | aching | fallout |",
          "",
        ].join("\n"),
        "utf-8",
      ),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线进度板\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感弧线\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 角色交互矩阵\n", "utf-8"),
      writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n\n## Chapter 100\nTrack the merchant guild trail.\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n\n- Keep the prose restrained.\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
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

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({
        passed: true,
        issues: [],
        summary: "ok",
      }),
      usage: ZERO_USAGE,
    });

    try {
      await auditor.auditChapter(
        bookDir,
        "Chapter body.",
        100,
        "xuanhuan",
        {
          chapterIntent: "# Chapter Intent\n\n## Goal\nBring the focus back to the mentor oath conflict.\n",
          contextPackage: {
            chapter: 100,
            selectedContext: [
              {
                source: "story/chapter_summaries.md#99",
                reason: "Relevant episodic memory.",
                excerpt: "Trial Echo | Mentor left without explanation | mentor-oath advanced",
              },
              {
                source: "story/pending_hooks.md#mentor-oath",
                reason: "Carry forward unresolved hook.",
                excerpt: "relationship | open | 101 | Mentor oath debt with Lin Yue",
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
        },
      );

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const userPrompt = messages?.[1]?.content ?? "";

      expect(userPrompt).toContain("story/chapter_summaries.md#99");
      expect(userPrompt).toContain("story/pending_hooks.md#mentor-oath");
      expect(userPrompt).not.toContain("| 1 | Guild Trail |");
      expect(userPrompt).not.toContain("guild-route | 1 | mystery");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the chapter memo into the audit prompt for memo-drift checking", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-memo-drift-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n", "utf-8"),
    ]);

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0, maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });

    const chatSpy = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "ok" }),
      usage: ZERO_USAGE,
    });

    const memoBody = [
      "## 当前任务",
      "陆焚在小巷抢回残刃并离开。",
      "",
      "## 读者此刻在等什么",
      "读者想看他怎么脱身。",
      "",
      "## 该兑现的 / 暂不掀的",
      "兑现：残刃归手；暂不掀：身世。",
      "",
      "## 日常/过渡承担什么任务",
      "开篇小巷场景 → 情绪代入 + 信息植入。",
      "",
      "## 关键抉择过三连问",
      "陆焚选择独自动手的理由是什么？",
      "",
      "## 章尾必须发生的改变",
      "陆焚拿回残刃，被人目击。",
      "",
      "## 本章 hook 账",
      "resolve: H11 残刃下落 → 本章找回。defer: H04 幕后主使 → 留到第 50 章。",
      "",
      "## 不要做",
      "不要写成大段打斗。",
    ].join("\n");

    try {
      await auditor.auditChapter(bookDir, "Chapter body.", 42, "xuanhuan", {
        chapterMemo: {
          chapter: 42,
          goal: "陆焚抢回残刃并离开",
          isGoldenOpening: false,
          body: memoBody,
          threadRefs: [],
        },
      });

      const messages = chatSpy.mock.calls[0]?.[0] as
        | ReadonlyArray<{ content: string }>
        | undefined;
      const systemPrompt = messages?.[0]?.content ?? "";
      const userPrompt = messages?.[1]?.content ?? "";

      // Prompt declares structure-only scope and sparse-memo legality.
      expect(systemPrompt).toContain("审稿边界");
      expect(systemPrompt).toContain("你不审文笔");
      expect(systemPrompt).toContain("稀疏 memo 是合法状态");
      expect(systemPrompt).toContain("章节备忘偏离");
      expect(systemPrompt).not.toContain("大纲偏离检测");

      // User prompt injects the memo for drift-checking.
      expect(userPrompt).toContain("## 章节备忘（用于 memo 偏离检测）");
      expect(userPrompt).toContain("goal：陆焚抢回残刃并离开");
      expect(userPrompt).toContain("## 章尾必须发生的改变");
      // Legacy volume-outline block is gone.
      expect(userPrompt).not.toContain("## 卷纲");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
