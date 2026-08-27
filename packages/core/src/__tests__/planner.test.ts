import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PlannerAgent } from "../agents/planner.js";
import * as llmProvider from "../llm/provider.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterArcProvenance } from "../models/chapter.js";
import { parseBookRules } from "../models/book-rules.js";
import {
  compileBookRuleProvenance,
  compileBookRuleSourceAuthorityReceipt,
  persistBookRulesPair,
  renderBookRuleSourceAuthorityReceipt,
} from "../models/book-rule-provenance.js";

const VALID_BODY = `
## 当前任务
主角进入七号门现场，比对锁芯刮痕与监控时间线，把"被动过手脚"从猜测钉成实证。

## 读者此刻在等什么
1) 读者在等七号门是否有异常实锤
2) 本章完全兑现，钉成现场实证

## 该兑现的 / 暂不掀的
- 该兑现：七号门异常 → 钉成现场实证
- 暂不掀：幕后主使 → 压到第 20 章

## 日常/过渡承担什么任务
不适用 - 本章为高压实证章，无日常过渡段。

## 关键抉择过三连问
- 主角本章最关键的一次选择：
  - 为什么这么做？线索只剩这一条
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合
- 对手/配角本章最关键的一次选择：
  - 为什么这么做？掩盖踪迹
  - 符合当前利益吗？符合
  - 符合他的人设吗？符合

## 章尾必须发生的改变
- 信息改变：主角掌握实证，可以面对幕后主使前先压住对手的退路

## 本章 hook 账
advance:
- H03 "七号门异常" → 从 pressured → near_payoff（本章钉成实证）
resolve:
- S004 "锁芯刮痕" → 核验完毕，本章结清
defer:
- H07 "幕后主使" → 第 20 章再动

## 不要做
- 不要让对手突然降智
- 不要直接点破幕后主使
`.trim();

function validMemoRaw(chapter: number): string {
  return `# 第 ${chapter} 章 memo

## 本章目标
把七号门被动过手脚钉成现场实证

## 关联线索
- H03
- S004

${VALID_BODY}
`;
}

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const STUB_CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, maxTokensCap: null, extra: {} },
};

function makeBook(): BookConfig {
  return {
    id: "book-plan-1",
    title: "Test Book",
    genre: "urban",
    platform: "qidian",
    status: "active",
    language: "zh",
    targetChapters: 120,
    chapterWordCount: 3000,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

async function seedStoryFiles(bookDir: string): Promise<void> {
  const storyDir = join(bookDir, "story");
  await mkdir(storyDir, { recursive: true });
  await Promise.all([
    writeFile(join(storyDir, "author_intent.md"), "# Intent\n- Tell a taut mystery.", "utf-8"),
    writeFile(join(storyDir, "current_focus.md"), "# Focus\n- Keep pressure on the seventh gate.", "utf-8"),
    writeFile(join(storyDir, "story_bible.md"), "# Bible\n- Protagonist: 阿泽", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# Outline\n- 第 1 章：开场", "utf-8"),
    writeFile(join(storyDir, "chapter_summaries.md"), "# Summaries\n", "utf-8"),
    writeFile(join(storyDir, "book_rules.md"), "# Rules\n- 禁止反派降智", "utf-8"),
    writeFile(join(storyDir, "current_state.md"), "# State\n- 主角在七号门附近", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), "# Hooks\n", "utf-8"),
    writeFile(join(storyDir, "subplot_board.md"), "# Subplot\n", "utf-8"),
    writeFile(join(storyDir, "emotional_arcs.md"), "# Arcs\n", "utf-8"),
    writeFile(join(storyDir, "character_matrix.md"), "# Matrix\n", "utf-8"),
  ]);
}

describe("PlannerAgent.planChapter memo generation", () => {
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "planner-memo-"));
    bookDir = join(root, "book");
    await seedStoryFiles(bookDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function makePlanner(): PlannerAgent {
    return new PlannerAgent({
      client: STUB_CLIENT,
      model: "test-model",
      projectRoot: root,
      bookId: "book-plan-1",
    });
  }

  it("produces a valid ChapterMemo when the LLM returns well-formed output", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.chapter).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 zh → golden opening, authoritative over LLM
    expect(result.memo.goal).toBe("把七号门被动过手脚钉成现场实证");
    expect(result.memo.threadRefs).toEqual(["H03", "S004"]);
    expect(result.memo.body).toContain("## 当前任务");
  });

  it("does not hard-cap memo generation below the configured model output budget", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const options = callArgs[3] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.7 }));
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("passes per-chapter user context into the memo prompt as a high-priority instruction", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
      externalContext: "本章标题：雨夜账本\n必须围绕账本失窃后的当面对质展开。",
    });

    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("本章用户指令");
    expect(userMsg?.content).toContain("本章标题：雨夜账本");
    expect(userMsg?.content).toContain("当面对质");
  });

  it("keeps Arc planning below the explicit per-chapter user instruction", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
      externalContext: "사용자 지시가 최우선이다.",
      arcContext: "## Active Arc\n- Required beat: 장부를 회수한다.",
    });

    const messages = chatSpy.mock.calls[0]![2] as ReadonlyArray<{ role: string; content: string }>;
    const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(userPrompt).toContain("本章用户指令（本章最高优先级）");
    expect(userPrompt).toContain("当前 Arc 制作计划（从属权威）");
    expect(userPrompt).toContain("不得覆盖创作 brief、作品正典、硬性规则");
  });

  it("infers the Korean planner route and supplies compact native genre payoff candidates", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const koreanGenreBook: BookConfig = {
      ...makeBook(),
      title: "IMF를 독식한 재벌 3세",
      genre: "현대판타지 재벌물",
      language: undefined,
    };
    await writeFile(join(bookDir, "story", "book_rules.md"), "", "utf-8");

    await makePlanner().planChapter({
      book: koreanGenreBook,
      bookDir,
      chapterNumber: 1,
    });

    const messages = chatSpy.mock.calls[0]![2] as ReadonlyArray<{ role: string; content: string }>;
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(systemPrompt).toContain("당신은 한국 장르소설의 담당 편집자입니다");
    expect(userPrompt).toContain("## 장르 반복 재미 후보 (하위 참고)");
    expect(userPrompt).toContain("초반 1~2화를 독자 체감 점검 창으로 삼아");
    expect(userPrompt).toContain("완전 수습, 후과, 자연스러운 다음 선택이나 압력");
    expect(userPrompt).not.toContain("그 결과가 만든 다음 압력을 붙인다");
    expect(userPrompt).toContain("거래 승부");
    expect(userPrompt).toContain("저평가 자산 선점");
    expect(userPrompt).toContain("사용자 직접 지시 > 활성 Arc의 지급 > 직전 회차가 만든 약속 > 위 후보");
    expect(userPrompt).toContain("quota나 체크리스트가 아닙니다");
    expect(userPrompt).toContain("첫 회차라 직전 회차 없음");
    expect(userPrompt).toContain("작품 규칙 항목 없음");
    expect(userPrompt).toContain("직전 회차 요약 없음");
    expect(userPrompt).toContain("현재 Arc 자료 없음");
    expect(userPrompt).toContain("주인공 행을 찾지 못함");
    expect(userPrompt).toContain("이번 화에 확인된 주요 상대 없음");
    expect(userPrompt).toContain("이번 화에 확인된 주요 협력자 없음");
    expect(userPrompt).toContain("현재 건드릴 수 있는 활성 복선이나 보조 줄기 없음");
    expect(userPrompt).toContain("우선 검토할 묵은 복선 없음");
    expect(userPrompt).not.toContain("반드시 처리할 묵은 복선 없음");
    expect(userPrompt).not.toContain("this is the opening chapter — no prior chapter");
    expect(userPrompt).not.toContain("no book_rules entries");
    expect(userPrompt).not.toContain("暂无");
    expect(userPrompt).not.toContain("no stale hooks");
    expect(userPrompt).not.toContain("## 장르의 중심");
  });

  it("keeps Korean retry feedback inside the inferred Korean planner route", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: "메모 형식이 아님",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: validMemoRaw(1),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const koreanGenreBook: BookConfig = {
      ...makeBook(),
      title: "IMF를 독식한 재벌 3세",
      genre: "현대판타지 재벌물",
      language: undefined,
    };

    await makePlanner().planChapter({
      book: koreanGenreBook,
      bookDir,
      chapterNumber: 1,
    });

    const messages = chatSpy.mock.calls[1]![2] as ReadonlyArray<{ role: string; content: string }>;
    const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(userPrompt).toContain("## 직전 출력 오류");
    expect(userPrompt).toContain("오류를 고쳐 같은 형식으로 다시 출력하세요.");
    expect(userPrompt).not.toContain("## Error from previous output");
    expect(userPrompt).not.toContain("Fix and re-emit.");
  });

  it.each([
    "Do not let the criminal escape justice",
    "범죄자가 처벌 없이 승리하게 두지 않는다",
    "The chapter must include diverse representation.",
    "여성 인물에게는 반드시 주도성과 긍정적 묘사를 부여한다.",
    "本章必须包含多元代表性。",
    "Ensure the cast is diverse.",
    "Include at least one woman, one queer character, and one racial minority in every arc.",
    "Every chapter requires inclusive representation.",
    "All female leads should be empowered and sympathetic.",
    "No protected-group character may be portrayed as evil.",
    "The antagonist cannot be gay.",
    "The narrative may not use offensive language or perpetuate harmful stereotypes.",
    "각 회차마다 여성, 퀴어, 소수자 인물을 최소 한 명씩 넣는다.",
    "등장인물 구성을 다양하게 유지해야 한다.",
    "여성 주연은 모두 주체적이고 호감 가게 묘사한다.",
    "소수자 인물을 악인으로 묘사하지 않는다.",
    "악역을 성소수자로 설정하면 안 된다.",
    "매 회차 포용적 대표성을 확보한다.",
    "每章至少加入一名女性、一名酷儿和一名少数族裔角色。",
    "确保角色阵容多元化。",
    "所有女性主角都应当坚强、讨喜。",
    "不得把少数群体角色描写成恶人。",
    "反派不能是同性恋。",
    "At least half the cast must be women.",
    "Reserve 50 percent of speaking roles for underrepresented groups.",
    "All villains must be cisgender heterosexual men.",
    "Marginalized characters must never be portrayed as perpetrators.",
    "Use inclusive language throughout.",
    "Avoid ableist, sexist, racist, or homophobic tropes.",
    "The story should celebrate diversity and inclusion.",
    "No marginalized identity may be associated with vice.",
    "등장인물 절반 이상을 여성으로 구성해야 한다.",
    "발화 역할의 50퍼센트를 소수자에게 배정한다.",
    "악역은 비장애인 이성애자 남성으로만 설정한다.",
    "소수자 인물을 가해자로 묘사해서는 안 된다.",
    "전반적으로 포용적 언어를 사용한다.",
    "성차별적·인종차별적·동성애 혐오 표현을 피한다.",
    "至少一半角色必须是女性。",
    "把百分之五十的有台词角色分配给少数群体。",
    "所有反派必须是顺性别异性恋男性。",
    "少数群体角色不得被描写为施害者。",
    "全文使用包容性语言。",
    "避免性别歧视、种族歧视或恐同表达。",
    "The narrative has a duty to model responsible behavior.",
    "서사는 책임 있는 행동의 본보기가 되어야 한다.",
    "叙事有责任示范负责任的行为。",
  ])("removes an invented memo prohibition before it reaches Writer: %s", async (mandate) => {
    const output = validMemoRaw(2).replace(
      "- 不要让对手突然降智",
      `- ${mandate}`,
    );
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: output,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.body).not.toContain(mandate);
    expect(result.memo.body).toContain("- 不要直接点破幕后主使");
  });

  it("keeps an exact owner prohibition but removes vetoed or unapproved mentions", async () => {
    const mandate = "Do not let the criminal escape justice";
    const output = validMemoRaw(2).replace(
      "- 不要让对手突然降智",
      `- ${mandate}`,
    );
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: output,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const authorized = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
      externalContext: mandate,
    });
    expect(authorized.memo.body).toContain(mandate);

    for (const externalContext of [
      `The owner vetoed this rule: ${mandate}`,
      `The owner never approved this rule: ${mandate}`,
      `The owner said this was not canon: ${mandate}`,
    ]) {
      const result = await makePlanner().planChapter({
        book: makeBook(),
        bookDir,
        chapterNumber: 2,
        externalContext,
      });
      expect(result.memo.body).not.toContain(mandate);
    }
    expect(chatSpy).toHaveBeenCalledTimes(4);
  });

  it("fails closed before an LLM call when legacy current_state contains a moral command", async () => {
    const poison = "The chapter must include diverse representation, and the criminal protagonist must repent before success.";
    await writeFile(join(bookDir, "story/current_state.md"), `# State\n- ${poison}`, "utf8");
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(2),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    await expect(makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    })).rejects.toThrow(/repair the source before continuing/);
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("allows attributed fictional dialogue in prior evidence but blocks a raw meta mandate", async () => {
    const mandate = "The protagonist must repent for his crimes before success.";
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(2),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    for (const previousEndingExcerpt of [
      `The priest insisted that ${mandate}`,
      `His mother whispered, "${mandate}"`,
      `The antagonist mocked him: ${mandate}`,
      "사제가 주인공은 범죄를 반성해야 한다고 말했다.",
    ]) {
      await expect(makePlanner().planChapterMemo({
        storyDir: join(bookDir, "story"),
        bookDir,
        chapterNumber: 2,
        isGoldenOpening: false,
        fallbackGoal: "Continue the auction conflict",
        chapterSummariesRaw: "",
        previousEndingExcerpt,
      })).resolves.toMatchObject({ chapter: 2 });
    }
    expect(chatSpy).toHaveBeenCalledTimes(4);

    await expect(makePlanner().planChapterMemo({
      storyDir: join(bookDir, "story"),
      bookDir,
      chapterNumber: 2,
      isGoldenOpening: false,
      fallbackGoal: "Continue the auction conflict",
      chapterSummariesRaw: "",
      previousEndingExcerpt: mandate,
    })).rejects.toThrow(/repair the source before continuing/);
    expect(chatSpy).toHaveBeenCalledTimes(4);
  });

  it("keeps an omitted-language Korean profile inside the three-chapter opening boundary", async () => {
    vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: validMemoRaw(3),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: validMemoRaw(4),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const koreanGenreBook: BookConfig = {
      ...makeBook(),
      title: "IMF를 독식한 재벌 3세",
      genre: "현대판타지 재벌물",
      language: undefined,
    };

    const chapterThree = await makePlanner().planChapter({
      book: koreanGenreBook,
      bookDir,
      chapterNumber: 3,
    });
    const chapterFour = await makePlanner().planChapter({
      book: koreanGenreBook,
      bookDir,
      chapterNumber: 4,
    });

    expect(chapterThree.memo.isGoldenOpening).toBe(true);
    expect(chapterFour.memo.isGoldenOpening).toBe(false);
  });

  it("routes only the current Arc future-advantage move into chapter intent", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(1),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const arcProvenance: ChapterArcProvenance = {
      version: 1,
      bookId: "book-plan-1",
      arcId: "arc-future-1",
      arcUpdatedAt: "2026-08-20T00:00:00.000Z",
      arcTitle: "먼저 확보한 공정 엔지니어",
      chapterNumber: 1,
      episodeRole: "promise",
      openingState: "1997년 외환위기 직전이다.",
      promise: "미래의 병목을 풀 인재를 먼저 확보한다.",
      goal: "현재 시점의 영입 다리를 놓는다.",
      obstacle: "그룹 임원들이 반대한다.",
      pressure: "경쟁사가 먼저 접촉한다.",
      turn: "주인공이 실패 책임을 떠안는다.",
      payoff: "첫 수율 개선을 증명한다.",
      irreversibleChange: "투자 시계가 빨라진다.",
      nextHook: "바뀐 역사에서 기억은 얼마나 버틸까?",
      beats: ["연구소 장비 인수 조건을 제시한다."],
      endingHook: "엔지니어가 조건 하나를 더 건다.",
      characterChanges: [],
      relationshipChanges: [],
      worldChanges: [],
      hookOperations: [],
      mustKeep: [],
      mustAvoid: [],
      styleEmphasis: [],
      futureAdvantageMove: {
        moveId: "FA-SEMICON-001",
        mode: "recruit",
        domain: "인재",
        target: "공정 엔지니어",
        rememberedOutcome: "2007년에 양산 병목을 해결한다.",
        baselineQuestions: ["1997년 소속 연구소는 어디인가?"],
        researchClaimIds: ["RC-1997-SEMICON-01"],
        authorizedDivergences: ["공정 장비 투자를 1997년으로 앞당긴다."],
        bridgeSteps: ["부도 위기 연구소 장비를 인수한다."],
        resistance: ["현재 실적만 보는 임원 반대"],
        proof: "폐기 웨이퍼 수율이 오른다.",
        reward: "핵심 생산 라인을 선점한다.",
        downstreamConsequences: ["미래 기억의 세부가 어긋난다."],
      },
    };

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 1,
      arcContext: "## Active Arc\n- Required beat: 장비 인수 조건을 제시한다.",
      arcProvenance,
    });

    expect(result.intent.futureAdvantageMoveIds).toEqual(["FA-SEMICON-001"]);
    expect(result.intent.researchClaimIds).toEqual(["RC-1997-SEMICON-01"]);
    expect(result.intent.authorizedDivergences).toEqual(["공정 장비 투자를 1997년으로 앞당긴다."]);
    expect(result.intentMarkdown).toContain("FA-SEMICON-001");
    expect(result.arcProvenance).toEqual(arcProvenance);
  });

  it("retries when the first response is malformed and succeeds on retry", async () => {
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion")
      .mockResolvedValueOnce({
        content: "no memo sections here",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: "still no memo sections",
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>)
      .mockResolvedValueOnce({
        content: validMemoRaw(4),
        usage: ZERO_USAGE,
      } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 4,
    });

    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(result.memo.chapter).toBe(4);
    expect(result.memo.isGoldenOpening).toBe(false);

    // Retry prompts must include the failure feedback
    const secondCallArgs = chatSpy.mock.calls[1]!;
    const secondMessages = secondCallArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const userMsg = secondMessages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("上次输出的错误");
  });

  // Phase hotfix 4: English books must receive English system + user prompts
  // and English golden-opening guidance for chapters ≤ 3.
  it("uses English prompts end-to-end when book.language is en", async () => {
    const VALID_EN_BODY = `
## Current task
Pin the Door 7 tampering from suspicion to live evidence.

## What the reader is waiting for right now
1) Reader expects to learn whether Door 7 is really compromised.
2) This chapter pays it off in full — live evidence on stage.

## To pay off / to keep buried
- Pay off: Door 7 anomaly → live evidence
- Keep buried: the mastermind → push to chapter 20

## What the slow / transitional beats carry
n/a — pressure chapter, no transitional beats.

## Three-question check on the key choice
- Protagonist's most important choice this chapter:
  - Why this choice? It is the only remaining lead.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.
- Antagonist / supporting cast's most important choice this chapter:
  - Why this choice? To cover their tracks.
  - Does it match current interest? Yes.
  - Does it match their persona? Yes.

## Required end-of-chapter change
- Information change: protagonist holds live evidence.

## Hook ledger for this chapter
advance:
- H03 "Door 7 anomaly" → pressured → near_payoff (pinned as live evidence this chapter)
defer:
- H07 "the mastermind" → hold until chapter 20

## Do not
- Do not let the antagonist suddenly turn dumb.
- Do not directly name the mastermind.
`.trim();

    const validEnRaw = `# Chapter 1 memo

## Chapter goal
Pin Door 7 tampering as live evidence

## Thread refs
- H03

${VALID_EN_BODY}
`;

    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validEnRaw,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const enBook = { ...makeBook(), language: "en" as const };
    const result = await makePlanner().planChapter({
      book: enBook,
      bookDir,
      chapterNumber: 1,
    });

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.memo.chapter).toBe(1);
    expect(result.memo.isGoldenOpening).toBe(true); // ch1 en → also inside the shared first-three boundary

    // System prompt must be the English variant
    const callArgs = chatSpy.mock.calls[0]!;
    const messages = callArgs[2] as ReadonlyArray<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    const userMsg = messages.find((m) => m.role === "user");

    // English system prompt markers
    expect(systemMsg?.content).toContain("editor-in-chief");
    expect(systemMsg?.content).toContain("Output format (strict)");
    expect(systemMsg?.content).not.toContain("你是这本小说的创作总编");

    // English user template markers
    expect(userMsg?.content).toContain("# Chapter 1 memo request");
    expect(userMsg?.content).toContain("Last screen of previous chapter");
    expect(userMsg?.content).toContain("Golden opening chapter: yes");
    expect(userMsg?.content).not.toContain("# 第 1 章 memo 请求");

    // English golden-opening guidance appended for ch ≤ 3
    expect(userMsg?.content).toContain("Golden Opening Guidance");
    expect(userMsg?.content).toContain("Chapter 1");
    expect(userMsg?.content).not.toContain("黄金三章规划指引");
  });

  it("infers English prompts end-to-end from an English genre profile when language is omitted", async () => {
    const validEnRaw = `# Chapter 1 memo

## Chapter goal
Make the system advantage visible

## Thread refs
none

## Current task
Use the system once and show a concrete result.

## What the reader is waiting for right now
The reader is waiting to see whether the advantage works.

## To pay off / to keep buried
Pay off the first use; keep the larger system origin buried.

## What the slow / transitional beats carry
The aftermath shows the practical cost.

## Three-question check on the key choice
The choice has a reason, serves the protagonist's interest, and matches their persona.

## Required end-of-chapter change
The protagonist confirms one usable ability.

## Hook ledger for this chapter
defer: system origin — review later.

## Do not
Do not invent an unrelated quest.
`;
    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validEnRaw,
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: { ...makeBook(), genre: "litrpg", language: undefined },
      bookDir,
      chapterNumber: 1,
    });

    const messages = chatSpy.mock.calls[0]![2] as ReadonlyArray<{ role: string; content: string }>;
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    const userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
    expect(systemPrompt).toContain("editor-in-chief");
    expect(systemPrompt).not.toContain("你是这本小说的创作总编");
    expect(userPrompt).toContain("# Chapter 1 memo request");
    expect(result.intentMarkdown).toContain("# Chapter Intent");
  });

  it("returns a degraded memo instead of throwing when all 3 attempts fail", async () => {
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "permanently broken",
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });

    expect(result.memo.chapter).toBe(2);
    expect(result.memo.goal.length).toBeGreaterThan(0);
    expect(result.memo.body).toContain("## 当前任务");
    expect(result.memo.body).toContain("## Planner warning");
    expect(result.memo.body).toContain("完整收束不需要新造压力");
    expect(result.memo.body).not.toContain("章尾至少要在信息、压力、关系、目标或风险上发生一个明确变化");
    expect(result.intentMarkdown).toContain("Planner warning");
  });

  it("keeps degraded Korean and English memos payoff-first without forced next pressure", async () => {
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "permanently broken",
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const korean = await makePlanner().planChapter({
      book: { ...makeBook(), genre: "현대판타지 재벌물", language: undefined },
      bookDir,
      chapterNumber: 2,
    });
    const english = await makePlanner().planChapter({
      book: { ...makeBook(), genre: "litrpg", language: undefined },
      bookDir,
      chapterNumber: 2,
    });

    expect(korean.memo.body).toContain("완전 수습이면 새 압력을 만들 필요가 없다");
    expect(korean.memo.body).not.toContain("다음 화를 당긴다");
    expect(english.memo.body).toContain("Full settlement does not need fresh pressure");
    expect(english.memo.body).not.toContain("so the chapter is not only summary");
  });

  // A parsed rule without host-owned provenance remains display-only. It must
  // never become a silent planning prohibition.
  it("does not derive intent.mustAvoid from unprovenanced story-frame rules", async () => {
    // Replace book_rules.md with a Phase 5 compat shim (no YAML, just pointer)
    // and put the authoritative YAML on outline/story_frame.md.
    const storyDir = join(bookDir, "story");
    await mkdir(join(storyDir, "outline"), { recursive: true });
    await writeFile(
      join(storyDir, "outline/story_frame.md"),
      [
        "---",
        "version: \"1.0\"",
        "protagonist:",
        "  name: 阿泽",
        "  personalityLock: []",
        "  behavioralConstraints: []",
        "prohibitions:",
        "  - 禁止主角降智",
        "  - 禁止神化反派",
        "---",
        "",
        "## 主题与基调",
        "调查与压制。",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(storyDir, "book_rules.md"),
      "# 本书规则（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。",
      "utf-8",
    );

    const chatSpy = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: validMemoRaw(2),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const result = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });

    expect(result.intent.mustAvoid).not.toContain("禁止主角降智");
    expect(result.intent.mustAvoid).not.toContain("禁止神化反派");

    const verifiedText = "禁止主角降智";
    const rulesFileContent = [
      "---",
      "prohibitions:",
      `  - ${verifiedText}`,
      "---",
      "# Verified rules",
    ].join("\n");
    const rules = parseBookRules(rulesFileContent)!.rules;
    const artifactPath = "story/authority/planner-user-instruction.md";
    const receiptPath = "story/authority/planner-user-instruction.receipt.json";
    const artifactContent = `사용자 지시: ${verifiedText}`;
    const start = artifactContent.indexOf(verifiedText);
    const sourceSelector = {
      artifactPath,
      artifactContent,
      start,
      end: start + verifiedText.length,
    };
    const authorityReceipt = compileBookRuleSourceAuthorityReceipt({
      bookId: makeBook().id,
      source: "user-explicit",
      authorityOrigin: "authenticated-owner-instruction",
      intent: "authorize-rule",
      decisionId: "planner-owner-rule-test-1",
      authorizedByActorId: "owner-test",
      fieldPath: "prohibitions[0]",
      text: verifiedText,
      sourceSelector,
    });
    const receiptContent = renderBookRuleSourceAuthorityReceipt(authorityReceipt);
    for (const [relativePath, content] of [
      [artifactPath, artifactContent],
      [receiptPath, receiptContent],
    ] as const) {
      await mkdir(dirname(join(bookDir, relativePath)), { recursive: true });
      await writeFile(join(bookDir, relativePath), content, "utf8");
    }
    const provenance = compileBookRuleProvenance({
      bookId: makeBook().id,
      rulesFileContent,
      rules,
      assignments: [{
        fieldPath: "prohibitions[0]",
        text: verifiedText,
        source: "user-explicit",
        strength: "hard",
        sourceSelector,
        sourceAuthorityReceipt: { receiptPath, receiptContent },
      }],
    });
    await persistBookRulesPair({
      bookDir,
      bookId: makeBook().id,
      rulesFileContent,
      rules,
      receipt: provenance,
    });

    chatSpy.mockResolvedValue({
      content: validMemoRaw(2).replace(
        "- 不要让对手突然降智",
        `- ${verifiedText}`,
      ),
      usage: ZERO_USAGE,
    } as unknown as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);

    const verifiedResult = await makePlanner().planChapter({
      book: makeBook(),
      bookDir,
      chapterNumber: 2,
    });
    expect(verifiedResult.intent.mustAvoid).toContain(verifiedText);
    expect(verifiedResult.memo.body).toContain(verifiedText);
  });
});
