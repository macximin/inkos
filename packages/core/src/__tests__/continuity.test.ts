import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  ContinuityAuditor,
  isAutomaticRevisionIssue,
  isRevisionCandidateIssue,
} from "../agents/continuity.js";
import { UnauthorizedProductionContextMoralCorrectionError } from "../agents/writer.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("ContinuityAuditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a poisoned legacy style guide before audit while preserving commercial craft", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-style-authority-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "audit-style",
        title: "Audit Style",
        genre: "other",
        platform: "other",
        chapterWordCount: 1200,
        targetChapters: 20,
        status: "active",
        language: "en",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }), "utf8"),
      writeFile(join(storyDir, "current_state.md"), "# Current State\n\nThe board vote opens tonight.", "utf8"),
      writeFile(join(storyDir, "style_guide.md"), "Every chapter must include diverse representation.", "utf8"),
    ]);
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chatSpy = vi.spyOn(auditor as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ passed: true, issues: [], summary: "ok", overall_score: 90 }),
        usage: ZERO_USAGE,
      });

    try {
      await expect(auditor.auditChapter(bookDir, "The CFO rejects the offer.", 1, "other"))
        .rejects.toBeInstanceOf(UnauthorizedProductionContextMoralCorrectionError);
      expect(chatSpy).not.toHaveBeenCalled();

      await writeFile(
        join(storyDir, "style_guide.md"),
        "The chapter must include a visible cash payoff and end on a hostile tender offer.",
        "utf8",
      );
      await expect(auditor.auditChapter(bookDir, "The CFO rejects the offer.", 1, "other"))
        .resolves.toMatchObject({ passed: true, overallScore: 90 });
      expect(chatSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("withholds poisoned legacy current-state controls while preserving fiction and commercial facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-current-state-authority-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const currentStatePath = join(storyDir, "current_state.md");
    const rawCurrentState = [
      "# Current State",
      "",
      "- The female CFO wires the acquisition deposit before midnight.",
      "- Each chapter is obligated to feature at least one queer character.",
      "- 각 화마다 여성 인물을 한 명 이상 넣도록 한다.",
      "- Every chapter must",
      "  include diverse representation.",
      "- The editor said, \"Each chapter must include diverse representation.\"",
    ].join("\n");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "audit-current-state",
        title: "Audit Current State",
        genre: "other",
        platform: "other",
        chapterWordCount: 1200,
        targetChapters: 20,
        status: "active",
        language: "en",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      }), "utf8"),
      writeFile(currentStatePath, rawCurrentState, "utf8"),
      writeFile(join(storyDir, "style_guide.md"), "Pay off the hostile tender with visible cash movement.", "utf8"),
    ]);
    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const chatSpy = vi.spyOn(auditor as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: JSON.stringify({ passed: true, issues: [], summary: "ok", overall_score: 90 }),
        usage: ZERO_USAGE,
      });

    try {
      await expect(auditor.auditChapter(bookDir, "The board accepts the deposit.", 1, "other"))
        .resolves.toMatchObject({ passed: true });
      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      const userPrompt = messages?.[1]?.content ?? "";
      expect(userPrompt).toContain("The female CFO wires the acquisition deposit before midnight.");
      expect(userPrompt).toContain("The editor said, \"Each chapter must include diverse representation.\"");
      expect(userPrompt).not.toContain("Each chapter is obligated to feature at least one queer character.");
      expect(userPrompt).not.toContain("각 화마다 여성 인물을 한 명 이상 넣도록 한다.");
      expect(userPrompt).not.toContain("- Every chapter must");
      await expect(readFile(currentStatePath, "utf8")).resolves.toBe(rawCurrentState);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("does not trust a truncated passed=true fragment as a completed audit", () => {
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
      projectRoot: "/tmp/inkos-auditor-truncated-pass-test",
    });

    const result = (auditor as any).parseAuditResult(
      'partial response\n"passed": true\n"issues": [',
      "en",
    );

    expect(result.passed).toBe(false);
    expect(result.creativePassed).toBe(false);
    expect(result.parseFailed).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({ severity: "critical", category: "System Error" }),
    ]);

    const incompleteJson = (auditor as any).parseAuditResult('{"passed":true}', "en");
    expect(incompleteJson).toMatchObject({
      passed: false,
      creativePassed: false,
      parseFailed: true,
    });

    const invalidSeverity = (auditor as any).parseAuditResult(JSON.stringify({
      passed: true,
      issues: [{
        severity: "error",
        category: "Timeline",
        description: "Broken order",
        suggestion: "Restore order",
      }],
      summary: "invalid severity",
    }), "en");
    expect(invalidSeverity).toMatchObject({
      passed: false,
      creativePassed: false,
      parseFailed: true,
    });

    const partialWarning = (auditor as any).parseAuditResult(
      '{"passed":false,"issues":[{"severity":"warning","category":"Pacing","description":"The ending could pull harder.","suggestion":"Consider a sharper consequence."}],"summary":"partial recovery"',
      "en",
    );
    expect(partialWarning).toMatchObject({
      passed: false,
      creativePassed: false,
      parseFailed: true,
      summary: "partial recovery",
    });
    expect(partialWarning.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "critical", category: "System Error" }),
      expect.objectContaining({ severity: "warning", category: "Pacing" }),
    ]));
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
          future_advantage_execution: {
            moveId: "FA-1",
            implemented: true,
            bridgeEvidence: ["시험 라인이 돌아갔다"],
            proofEvidence: ["시험 라인이 돌아갔다"],
            rewardEvidence: ["시험 라인이 돌아갔다"],
            worldChanges: [{ change: "시험 생산이 시작됐다", evidence: "시험 라인이 돌아갔다" }],
            memoryReliability: "intact",
            memoryEvidence: [],
            note: "본문 실행 확인",
          },
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
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          research_status: "not-applicable",
          overall_score: 58,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "local",
            category: "Information Boundary",
            description: "The protagonist uses a confidential research report before receiving it.",
            suggestion: "Restore the missing acquisition step.",
          }],
          summary: "information boundary breach",
        }),
        usage: ZERO_USAGE,
      });
    const arcContext = [
      "## Future Advantage Move",
      "- Move: FA-1",
      "- Target: 반도체 장비 국산화",
      "- Authorized divergences: 상용화를 실제보다 3년 앞당긴다",
      "- A-Rail bridge: 퇴직 기술자 영입; 시험 라인 확보",
      "- A-Rail proof: 첫 납품 검사 통과",
      "- A-Rail reward: 계열사 우선 공급권",
    ].join("\n");

    try {
      const researchOnly = await auditor.auditChapter(bookDir, "시험 라인이 돌아갔다.", 1, "other", {
        arcContext,
        chapterMemo: {
          chapter: 1,
          goal: "시험 라인의 첫 증거를 지급한다",
          isGoldenOpening: true,
          body: "## 독자가 지금 기다리는 것\n- 재미 앵커: 첫 수율 개선을 눈앞에서 증명한다\n- 상태: 전부 지급",
          threadRefs: [],
        },
      });
      expect(researchOnly.passed).toBe(true);
      expect(researchOnly.creativePassed).toBe(true);
      expect(researchOnly.researchStatus).toBe("needs-research");
      expect(researchOnly.issues[0]).toMatchObject({ severity: "info", track: "research" });
      expect(researchOnly.futureAdvantageExecution).toMatchObject({ moveId: "FA-1", implemented: true });

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      expect(messages[0]?.content).toContain("당신은 엄격한");
      expect(messages[0]?.content).toContain("이번 화의 재미 앵커");
      expect(messages[0]?.content).toContain("별도 점수가 아니라");
      expect(messages[0]?.content).toContain("'전부 지급' 또는 이번 화의 핵심 작업");
      expect(messages[0]?.content).toContain("장면은 있으나 타격감이 약한 경우 warning");
      expect(messages[0]?.content).toContain("허용된 역사 분기");
      expect(messages[0]?.content).not.toContain("You are a strict");
      expect(messages[1]?.content).toContain("## 감리할 원고");

      const boundaryBreach = await auditor.auditChapter(bookDir, "비공개 협상 결과를 이미 알았다.", 1, "other", { arcContext });
      expect(boundaryBreach.passed).toBe(true);
      expect(boundaryBreach.creativePassed).toBe(true);
      expect(boundaryBreach.issues[0]).toMatchObject({
        severity: "critical",
        track: "creative",
        automaticRevisionEligible: false,
      });
      expect(isAutomaticRevisionIssue(boundaryBreach.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(boundaryBreach.issues[0]!)).toBe(true);
      const legacyMessages = chatSpy.mock.calls[1]?.[0] as ReadonlyArray<{ content: string }>;
      expect(legacyMessages[0]?.content).not.toContain("이번 화의 재미 앵커");

      const researchReportBreach = await auditor.auditChapter(
        bookDir,
        "He quoted the confidential report before anyone handed it to him.",
        1,
        "other",
      );
      expect(researchReportBreach.passed).toBe(true);
      expect(researchReportBreach.creativePassed).toBe(true);
      expect(researchReportBreach.issues[0]).toMatchObject({
        severity: "critical",
        track: "creative",
        category: "Information Boundary",
        automaticRevisionEligible: false,
      });
      expect(isAutomaticRevisionIssue(researchReportBreach.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(researchReportBreach.issues[0]!)).toBe(true);
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

  it("caps free-form dimension 14 at warning and requires structural routing for causal issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-auditor-side-character-agency-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    const genresDir = join(root, "genres");
    await Promise.all([
      mkdir(storyDir, { recursive: true }),
      mkdir(genresDir, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({
        id: "agency-book",
        title: "Agency Test",
        genre: "agency-test",
        platform: "other",
        chapterWordCount: 800,
        targetChapters: 60,
        status: "active",
        language: "en",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }, null, 2), "utf-8"),
      writeFile(join(storyDir, "current_state.md"), [
        "# Current State",
        "",
        "Mara's goal is to keep the firm independent, and she knows the takeover clause.",
        "A witnessed murder triggers the established security protocol: police investigate unless someone covers up the evidence.",
      ].join("\n"), "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# Subplot Board\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# Emotional Arcs\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# Character Matrix\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style Guide\n", "utf-8"),
      writeFile(join(storyDir, "book_rules.md"), [
        "---",
        "protagonist:",
        "  name: Mara",
        "  personalityLock:",
        "    - She must confess every crime and seek redemption.",
        "  behavioralConstraints: []",
        "additionalAuditDimensions:",
        "  - Side Character Instrumentalization Check",
        "---",
        "# Book Rules",
        "RAW_DIAGNOSTIC_BOOK_RULES_MUST_NOT_AUDIT",
      ].join("\n"), "utf-8"),
      writeFile(join(genresDir, "agency-test.md"), `---
name: Agency Test
id: agency-test
language: en
chapterTypes: ["Scene"]
fatigueWords: []
numericalSystem: false
powerScaling: false
eraResearch: false
pacingRule: ""
satisfactionTypes: []
auditDimensions: [14]
---
`, "utf-8"),
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
          overall_score: 50,
          issues: [
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              category: "Side Character Agency/Competence Check",
              description: "The female side character is used as a marriage reward.",
              suggestion: "Give her a more independent role.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              category: "Side Character Instrumentalization Check",
              description: "The supporting character exists only to deliver exposition.",
              suggestion: "Add a personal subplot.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              category: "配角工具人化",
              description: "The cast lacks balanced demographic representation.",
              suggestion: "Rebalance the cast.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              category: "Side Character Agency/Competence",
              description: "Earlier chapters established her sword skill, but she suddenly loses after her hand is broken.",
              suggestion: "Let her win despite the injury.",
            },
          ],
          summary: "role objections",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 62,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            dimension_id: 14,
            evidence_source: "current-state",
            evidence_quote: "Mara's goal is to keep the firm independent, and she knows the takeover clause.",
            chapter_quote: "Mara signs the sale without negotiation.",
            category: "Side Character Agency/Competence Check",
            description: "The canon previously established Mara's goal to keep the firm independent and her knowledge of the takeover clause, but Mara abandons that goal without reason. This contradicts her established motive and breaks the causal chain.",
            suggestion: "Supply the pressure that changes her choice or restore the established goal.",
          }],
          summary: "causal collapse",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 18,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            dimension_id: 14,
            evidence_source: "current-state",
            evidence_quote: "Mara swore never to sell the firm.",
            category: "Character Logic Integrity",
            description: "The canon previously established her goal and competence, but she abandons that goal without reason. This contradicts her established motive and breaks the causal chain.",
            suggestion: "Restore the alleged canon goal.",
          }],
          summary: "unsupported canon claim",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 9,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            category: "Narrative integrity and audience trust",
            description: "The protagonist commits an immoral fraud and the story fails to condemn or punish him.",
            suggestion: "Make him feel remorse, apologize, and earn redemption.",
          }],
          summary: "moral objection under an alias",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 43,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            dimension_id: 27,
            category: "Ethics and Safety",
            description: "The murder happens in front of witnesses, but there is no police investigation or cover-up; this breaks the causal chain.",
            suggestion: "Add the investigation, a cover-up, or another concrete causal response.",
          }],
          summary: "crime consequence breaks causality",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 43,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            dimension_id: 11,
            evidence_source: "current-state",
            evidence_quote: "A witnessed murder triggers the established security protocol: police investigate unless someone covers up the evidence.",
            chapter_quote: "The murder is witnessed, yet nobody starts an investigation or hides the evidence.",
            category: "Incentive Chain Check",
            description: "The witnessed murder has no police investigation or cover-up, which contradicts the established protocol and breaks the causal chain.",
            suggestion: "Restore the established investigation, cover-up, or another canon-consistent causal response.",
          }],
          summary: "evidence-backed crime consequence breaks causality",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 51,
          issues: [{
            severity: "critical",
            track: "creative",
            repair_scope: "structural",
            dimension_id: 27,
            evidence_source: "rule-stack-hard",
            evidence_quote: "The protagonist must not harm children.",
            rule_id: "book-rule:no-harm-children",
            category: "Ethics and Safety",
            description: "The protagonist harms a child despite the verified prohibition.",
            suggestion: "Restore the verified hard rule.",
          }],
          summary: "verified rule violation",
        }),
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          passed: false,
          creative_passed: false,
          overall_score: 24,
          issues: [
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              dimension_id: 14,
              evidence_source: "chapter-control",
              evidence_quote: "Mara will surrender the firm without negotiation.",
              chapter_quote: "Mara signs the sale without negotiation.",
              category: "Side Character Agency/Competence Check",
              description: "The planner previously established her goal, but the chapter contradicts it without reason and breaks the causal chain.",
              suggestion: "Restore the planner instruction.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              dimension_id: 14,
              evidence_source: "chapter-memo",
              evidence_quote: "Mara must abandon independence in this chapter.",
              chapter_quote: "Mara signs the sale without negotiation.",
              category: "Side Character Agency/Competence Check",
              description: "The memo previously established her goal, but the chapter contradicts it without reason and breaks the causal chain.",
              suggestion: "Restore the memo instruction.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              dimension_id: 14,
              evidence_source: "arc-plan",
              evidence_quote: "Mara loses all negotiating competence for this Arc.",
              chapter_quote: "Mara signs the sale without negotiation.",
              category: "Side Character Agency/Competence Check",
              description: "The Arc plan previously established her competence, but the chapter contradicts it without reason and breaks the causal chain.",
              suggestion: "Restore the Arc plan.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              dimension_id: 14,
              evidence_quote: "Mara's goal is to keep the firm independent, and she knows the takeover clause.",
              chapter_quote: "Mara signs the sale without negotiation.",
              category: "Side Character Agency/Competence Check",
              description: "Mara contradicts the established goal without reason and breaks the causal chain.",
              suggestion: "Restore Mara's goal.",
            },
            {
              severity: "critical",
              track: "creative",
              repair_scope: "structural",
              dimension_id: 14,
              evidence_source: "current-state",
              evidence_quote: "# Current State",
              chapter_quote: "Mara signs the sale without negotiation.",
              category: "Side Character Agency/Competence Check",
              description: "Mara contradicts an alleged established goal without reason and breaks the causal chain.",
              suggestion: "Restore Mara's alleged goal.",
            },
          ],
          summary: "planning surfaces cannot establish character canon",
        }),
        usage: ZERO_USAGE,
      });

    try {
      const chapterUnderReview = [
        "Mara signs the sale without negotiation.",
        "She turns over the takeover file and leaves the room.",
        "The murder is witnessed, yet nobody starts an investigation or hides the evidence.",
      ].join(" ");
      const roleOnly = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(roleOnly.passed).toBe(true);
      expect(roleOnly.creativePassed).toBe(true);
      expect(roleOnly.issues).toHaveLength(4);
      expect(roleOnly.issues.slice(0, 3).every((issue) => (
        issue.severity === "info"
        && issue.contentNeutralized === true
        && issue.revisionEligible === false
      ))).toBe(true);
      expect(roleOnly.issues.slice(0, 3).some(isAutomaticRevisionIssue)).toBe(false);
      expect(roleOnly.issues.slice(0, 3).some(isRevisionCandidateIssue)).toBe(false);
      expect(roleOnly.issues[3]).toMatchObject({
        severity: "warning",
        revisionEligible: false,
      });
      expect(roleOnly.overallScore).toBe(85);

      const messages = chatSpy.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
      const systemPrompt = messages[0]?.content ?? "";
      expect(systemPrompt).toContain("Side Character Agency/Competence Check");
      expect(systemPrompt).toContain("gender, identity, representation");
      expect(systemPrompt).toContain("must not lower overall_score");
      expect(systemPrompt).toContain("warning is the maximum");
      expect(systemPrompt).not.toContain("Side Character Instrumentalization Check");
      expect(systemPrompt).not.toContain("RAW_DIAGNOSTIC_BOOK_RULES_MUST_NOT_AUDIT");
      expect(systemPrompt).not.toContain("She must confess every crime and seek redemption.");
      expect(systemPrompt).toContain("commit a crime");
      expect(systemPrompt).toContain("absence of condemnation, punishment, remorse");
      expect(systemPrompt).toContain("moral growth, or a moral cost is not");
      expect(systemPrompt).not.toContain("Female characters reduced");
      const userPrompt = messages[1]?.content ?? "";
      expect(userPrompt).toContain("## Canonical evidence source selectors");
      expect(userPrompt).toContain("- current-state");

      const causalCollapse = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(causalCollapse.passed).toBe(true);
      expect(causalCollapse.creativePassed).toBe(true);
      expect(causalCollapse.overallScore).toBe(85);
      expect(causalCollapse.issues[0]).toMatchObject({
        severity: "warning",
        category: "Side Character Agency/Competence Check",
        revisionEligible: false,
      });

      const hallucinatedQuote = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(hallucinatedQuote).toMatchObject({
        passed: true,
        creativePassed: true,
        overallScore: 85,
      });
      expect(hallucinatedQuote.issues[0]).toMatchObject({
        severity: "warning",
        revisionEligible: false,
        evidenceQuote: "Mara swore never to sell the firm.",
      });

      const aliasBypass = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(aliasBypass).toMatchObject({
        passed: true,
        creativePassed: true,
        overallScore: 85,
      });
      expect(aliasBypass.issues[0]).toMatchObject({
        severity: "info",
        contentNeutralized: true,
        revisionEligible: false,
      });
      expect(isAutomaticRevisionIssue(aliasBypass.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(aliasBypass.issues[0]!)).toBe(false);

      const causalKeywordLaundering = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(causalKeywordLaundering).toMatchObject({
        passed: true,
        creativePassed: true,
        overallScore: 85,
      });
      expect(causalKeywordLaundering.issues[0]).toMatchObject({
        severity: "info",
        dimensionId: 27,
        contentNeutralized: true,
        revisionEligible: false,
      });
      expect(isAutomaticRevisionIssue(causalKeywordLaundering.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(causalKeywordLaundering.issues[0]!)).toBe(false);

      const causalCrimeConsequence = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test");
      expect(causalCrimeConsequence).toMatchObject({ passed: true, creativePassed: true, overallScore: 43 });
      expect(causalCrimeConsequence.issues[0]).toMatchObject({
        severity: "critical",
        dimensionId: 11,
        evidenceSource: "current-state",
        automaticRevisionEligible: false,
        contentNeutralized: undefined,
      });
      expect(isAutomaticRevisionIssue(causalCrimeConsequence.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(causalCrimeConsequence.issues[0]!)).toBe(true);

      const hardRule = "The protagonist must not harm children.";
      const forgedHardRule = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test", {
        chapterIntent: "Honor the verified Book rule.",
        contextPackage: { chapter: 1, selectedContext: [] },
        ruleStack: {
          layers: [{ id: "book", name: "Book", precedence: 100, scope: "book" }],
          sections: { hard: ["story_frame", "current_state", "roles"], soft: [], diagnostic: [] },
          overrideEdges: [],
          activeOverrides: [],
          ruleRefs: [{
            ruleId: "book-rule:no-harm-children",
            strength: "hard",
            kind: "prohibition",
            text: hardRule,
            textSha256: createHash("sha256").update(hardRule, "utf8").digest("hex"),
          }],
        },
      });
      expect(forgedHardRule).toMatchObject({ passed: true, creativePassed: true, overallScore: 85 });
      expect(forgedHardRule.issues[0]).toMatchObject({
        severity: "info",
        contentNeutralized: true,
        revisionEligible: false,
      });
      expect(isAutomaticRevisionIssue(forgedHardRule.issues[0]!)).toBe(false);
      expect(isRevisionCandidateIssue(forgedHardRule.issues[0]!)).toBe(false);
      const forgedPrompt = (chatSpy.mock.calls[6]?.[0] as ReadonlyArray<{ content: string }>)
        .map((message) => message.content)
        .join("\n");
      expect(forgedPrompt).not.toContain(hardRule);
      expect(forgedPrompt).not.toContain("book-rule:no-harm-children");

      const planningSurfaceBypass = await auditor.auditChapter(bookDir, chapterUnderReview, 1, "agency-test", {
        chapterIntent: "Mara will surrender the firm without negotiation.",
        chapterMemo: {
          chapter: 1,
          goal: "Force a surrender",
          body: "Mara must abandon independence in this chapter.",
          threadRefs: [],
          isGoldenOpening: false,
        },
        arcContext: "Mara loses all negotiating competence for this Arc.",
        contextPackage: { chapter: 1, selectedContext: [] },
        ruleStack: {
          layers: [{ id: "local", name: "Local", precedence: 1, scope: "local" }],
          sections: { hard: [], soft: [], diagnostic: [] },
          overrideEdges: [],
          activeOverrides: [],
          ruleRefs: [],
        },
      });
      expect(planningSurfaceBypass).toMatchObject({
        passed: true,
        creativePassed: true,
        overallScore: 85,
      });
      expect(planningSurfaceBypass.issues).toHaveLength(5);
      expect(planningSurfaceBypass.issues.every((issue) => (
        issue.severity === "warning"
        && issue.revisionEligible === false
        && isAutomaticRevisionIssue(issue) === false
      ))).toBe(true);
      const planningPrompt = chatSpy.mock.calls[7]?.[0] as ReadonlyArray<{ content: string }>;
      const planningUserPrompt = planningPrompt?.[1]?.content ?? "";
      expect(planningUserPrompt).toContain("Mara will surrender the firm without negotiation.");
      expect(planningUserPrompt).toContain("Mara must abandon independence in this chapter.");
      expect(planningUserPrompt).toContain("Mara loses all negotiating competence for this Arc.");
      expect(planningUserPrompt).not.toContain("- chapter-control");
      expect(planningUserPrompt).not.toContain("- chapter-memo");
      expect(planningUserPrompt).not.toContain("- arc-plan");
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
    const genresDir = join(root, "genres");
    await Promise.all([
      mkdir(storyDir, { recursive: true }),
      mkdir(genresDir, { recursive: true }),
    ]);

    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
      writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n", "utf-8"),
      writeFile(join(storyDir, "subplot_board.md"), "# 支线\n", "utf-8"),
      writeFile(join(storyDir, "emotional_arcs.md"), "# 情感\n", "utf-8"),
      writeFile(join(storyDir, "character_matrix.md"), "# 矩阵\n", "utf-8"),
      writeFile(join(storyDir, "style_guide.md"), "# Style\n", "utf-8"),
      writeFile(join(genresDir, "empty-fun.md"), `---
name: 空候选测试
id: empty-fun
chapterTypes: ["推进章", "结算章"]
fatigueWords: []
numericalSystem: false
powerScaling: false
eraResearch: false
pacingRule: ""
satisfactionTypes: []
auditDimensions: [6, 15]
---
`, "utf-8"),
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
      await auditor.auditChapter(bookDir, "Chapter body.", 42, "empty-fun", {
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
      expect(systemPrompt).toContain("完整收束和必要后效都合法");
      expect(systemPrompt).toContain("情绪、关系、信息、选择、兑现或后果");
      expect(systemPrompt).toContain("干净结算的章尾不必重新点燃好奇心");
      expect(systemPrompt).toContain("不是逐项打勾的清单");
      expect(systemPrompt).toContain("只有以下情况可以判 critical");
      expect(systemPrompt).toContain("只能记 warning，绝不能触发自动重写");
      expect(systemPrompt).toContain("不得按百分比、新奇度或爽点数量判定通过");
      expect(systemPrompt).toContain("不是本章场景配额");
      expect(systemPrompt).toContain("不能仅凭年龄判 critical 或自动改写当前正文");
      expect(systemPrompt).toContain("本章 chapter_memo 明确把某 hook_id 选为 advance/resolve");
      expect(systemPrompt).not.toContain("章尾是否重新点燃好奇心");
      expect(systemPrompt).not.toContain("埋伏笔、推关系、建立反差、准备下一轮蓄压");
      expect(systemPrompt).not.toContain("任何段落缺失或被写反 → critical");
      expect(systemPrompt).not.toContain("70%期待");
      expect(systemPrompt).not.toContain("过期超过 10 章未回收 → warning 升级为 critical");
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
