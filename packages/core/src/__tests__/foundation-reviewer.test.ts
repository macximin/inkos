import { describe, expect, it, vi } from "vitest";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import type { LLMClient } from "../llm/provider.js";

const TEST_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
} as unknown as LLMClient;

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

describe("FoundationReviewerAgent", () => {
  it("keeps Korean-native fun and prose scores diagnostic without granting regeneration authority", async () => {
    const agent = new FoundationReviewerAgent({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const scores = [85, 85, 85, 85, 85, 69, 85, 85];
    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({
      content: [
        ...scores.flatMap((score, index) => [
          `=== DIMENSION: ${index + 1} ===`,
          `점수: ${score}`,
          `근거: ${score < 80 ? "IMF 전후의 인수전" : "없음"}`,
          "의견: 실제 사건을 근거로 판단함",
        ]),
        "=== OVERALL ===",
        "총점: 83",
        "통과: 아니요",
        "총평: 문체를 먼저 고쳐야 한다.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const result = await agent.review({
      language: "ko",
      mode: "original",
      targetChapters: 200,
      foundation: {
        storyBible: "재벌가 승계전",
        volumeOutline: "IMF 전후의 인수전",
        bookRules: "주인공은 직접 거래한다.",
        currentState: "1997년 7월",
        pendingHooks: "외환 위기",
      },
    });

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("한국 장르소설을 오래 다룬 편집자");
    expect(messages[0]?.content).toContain("대표 재미와 독자 약속");
    expect(messages[0]?.content).toContain("한국어 기획 문체");
    expect(messages[0]?.content).toContain("눈에 보이는 보상을 먼저 지급하고");
    expect(messages[0]?.content).toContain("자연스럽게 생기는 선택·후과·압력 또는 완결된 결산");
    expect(messages[0]?.content).toContain("추가 대가·내적 성장·처벌·반성·속죄가 없다는 이유만으로 감점");
    expect(messages[0]?.content).toContain("도덕적 교정을 기획에 덧붙이지 않습니다");
    expect(messages[0]?.content).toContain("정확한 인용이 없는 저점은 진단으로만 남고 재생성을 일으키지 않습니다");
    expect(messages[0]?.content).not.toContain("다음 문제는 그 결과에서 자연스럽게 생길 때만");
    expect(messages[0]?.content).not.toContain("You are a senior fiction editor");
    expect(messages[1]?.content).toContain("## 이야기 기반");
    expect(result.totalScore).toBe(83);
    expect(result.passed).toBe(true);
    expect(result.overallFeedback).toBe("문체를 먼저 고쳐야 한다.");
    expect(result.dimensions[5]).toMatchObject({
      score: 69,
      evidenceQuote: "IMF 전후의 인수전",
      gating: false,
    });

    await agent.review({
      language: "ko",
      mode: "series",
      targetChapters: 200,
      foundation: {
        storyBible: "재벌가 승계전 후속부",
        volumeOutline: "IMF 이후의 인수전",
        bookRules: "주인공은 직접 거래한다.",
        currentState: "1998년 1월",
        pendingHooks: "채권단 재편",
      },
    });

    const derivativeMessages = chatSpy.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(derivativeMessages[0]?.content).toContain("눈에 보이는 보상을 먼저 지급하고");
    expect(derivativeMessages[0]?.content).toContain("자연스럽게 생기는 선택·후과·압력 또는 완결된 결산");
    expect(derivativeMessages[0]?.content).not.toContain("행동, 대응, 보상, 다음 문제가 장면으로 이어지는가");
  });

  it("neutralizes moral-review scores and unsupported low scores before they can regenerate a foundation", async () => {
    const agent = new FoundationReviewerAgent({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });
    vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({
      content: [
        "=== DIMENSION: 1 ===",
        "Score: 20",
        "Evidence: The heir wins the takeover.",
        "Feedback: The fraud lacks narrative closure because he is never condemned or punished, damaging reader trust.",
        "=== DIMENSION: 2 ===",
        "Score: 40",
        "Evidence: NONE",
        "Feedback: The opening momentum may be weak.",
        "=== DIMENSION: 3 ===",
        "Score: 85",
        "Evidence: NONE",
        "Feedback: Coherent.",
        "=== DIMENSION: 4 ===",
        "Score: 85",
        "Evidence: NONE",
        "Feedback: Distinct.",
        "=== DIMENSION: 5 ===",
        "Score: 85",
        "Evidence: NONE",
        "Feedback: Feasible.",
        "=== OVERALL ===",
        "Total: 63",
        "Passed: no",
        "Summary: The criminal victory needs punishment and redemption. Commercial structure is otherwise usable.",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    const result = await agent.review({
      language: "en",
      mode: "original",
      targetChapters: 200,
      foundation: {
        storyBible: "The heir wins the takeover.",
        volumeOutline: "He compounds the victory across the group.",
        bookRules: "No moral correction is required.",
        currentState: "He controls the board.",
        pendingHooks: "A rival prepares a tender offer.",
      },
    });

    expect(result.passed).toBe(true);
    expect(result.totalScore).toBe(83);
    expect(result.dimensions[0]).toMatchObject({
      score: 80,
      gating: false,
      contentNeutralized: true,
    });
    expect(result.dimensions[1]).toMatchObject({ score: 80, gating: false });
    expect(result.overallFeedback).toBe("Commercial structure is otherwise usable.");
  });

  it("fails closed on truncated dimension fields or a missing overall summary", async () => {
    const agent = new FoundationReviewerAgent({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });
    const valid = [1, 2, 3, 4, 5].flatMap((index) => [
      `=== DIMENSION: ${index} ===`,
      "Score: 80",
      "Evidence: NONE",
      "Feedback: Usable.",
    ]).concat([
      "=== OVERALL ===",
      "Total: 80",
      "Passed: yes",
      "Summary: Ready for diagnostic review.",
    ]).join("\n");
    const chat = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    );
    const input = {
      language: "en" as const,
      mode: "original" as const,
      targetChapters: 100,
      foundation: {
        storyBible: "Story",
        volumeOutline: "Outline",
        bookRules: "Rules",
        currentState: "State",
        pendingHooks: "Hooks",
      },
    };

    chat.mockResolvedValueOnce({
      content: valid.replace("Score: 80", "Score: missing"),
      usage: ZERO_USAGE,
    });
    await expect(agent.review(input)).rejects.toThrow("no valid 0-100 score");

    chat.mockResolvedValueOnce({
      content: valid.replace("Feedback: Usable.", "Feedback:"),
      usage: ZERO_USAGE,
    });
    await expect(agent.review(input)).rejects.toThrow("missing feedback");

    chat.mockResolvedValueOnce({
      content: valid.replace("Summary: Ready for diagnostic review.", ""),
      usage: ZERO_USAGE,
    });
    await expect(agent.review(input)).rejects.toThrow("overall summary");
  });

  it("reviews original foundations against the requested chapter count", async () => {
    const agent = new FoundationReviewerAgent({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({
      content: [
        "=== DIMENSION: 1 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 2 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 3 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 4 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 5 ===",
        "分数：80",
        "意见：可用",
        "=== OVERALL ===",
        "总分：80",
        "通过：是",
        "总评：可开写。",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    await agent.review({
      language: "zh",
      mode: "original",
      targetChapters: 8,
      foundation: {
        storyBible: "故事框架",
        volumeOutline: "8章大纲",
        bookRules: "规则",
        currentState: "状态",
        pendingHooks: "伏笔",
      },
    });

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("用户要求的8章");
    expect(messages[0]?.content).toContain("前5章");
    expect(messages[0]?.content).toContain("连续8章");
    expect(messages[0]?.content).toContain("没有额外代价、内在成长、惩罚、反省或赎罪本身不是缺陷");
    expect(messages[0]?.content).toContain("不得把道德纠正写进修改意见");
    expect(messages[0]?.content).not.toContain("支撑40章");
    expect(messages[0]?.content).not.toContain("连续10章");
  });

  it("does not silently truncate foundation, canon, or style inputs before review", async () => {
    const agent = new FoundationReviewerAgent({
      client: TEST_CLIENT,
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const chatSpy = vi.spyOn(
      agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> },
      "chat",
    ).mockResolvedValue({
      content: [
        "=== DIMENSION: 1 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 2 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 3 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 4 ===",
        "分数：80",
        "意见：可用",
        "=== DIMENSION: 5 ===",
        "分数：80",
        "意见：可用",
        "=== OVERALL ===",
        "总分：80",
        "通过：是",
        "总评：可开写。",
      ].join("\n"),
      usage: ZERO_USAGE,
    });

    await agent.review({
      language: "zh",
      mode: "fanfic",
      sourceCanon: `${"正典".repeat(9000)}\nSOURCE_CANON_TAIL_MARKER`,
      styleGuide: `${"文风".repeat(3000)}\nSTYLE_GUIDE_TAIL_MARKER`,
      foundation: {
        storyBible: `${"世界".repeat(5000)}\nSTORY_BIBLE_TAIL_MARKER`,
        volumeOutline: `${"卷纲".repeat(5000)}\nVOLUME_OUTLINE_TAIL_MARKER`,
        bookRules: `${"规则".repeat(3000)}\nBOOK_RULES_TAIL_MARKER`,
        currentState: `${"状态".repeat(2000)}\nCURRENT_STATE_TAIL_MARKER`,
        pendingHooks: `${"伏笔".repeat(2000)}\nPENDING_HOOKS_TAIL_MARKER`,
      },
    });

    const messages = chatSpy.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("SOURCE_CANON_TAIL_MARKER");
    expect(messages[0]?.content).toContain("STYLE_GUIDE_TAIL_MARKER");
    expect(messages[1]?.content).toContain("STORY_BIBLE_TAIL_MARKER");
    expect(messages[1]?.content).toContain("VOLUME_OUTLINE_TAIL_MARKER");
    expect(messages[1]?.content).toContain("BOOK_RULES_TAIL_MARKER");
    expect(messages[1]?.content).toContain("CURRENT_STATE_TAIL_MARKER");
    expect(messages[1]?.content).toContain("PENDING_HOOKS_TAIL_MARKER");
  });
});
