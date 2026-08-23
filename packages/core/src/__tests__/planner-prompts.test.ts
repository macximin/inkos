import { describe, it, expect } from "vitest";
import {
  PLANNER_MEMO_SYSTEM_PROMPT,
  PLANNER_MEMO_SYSTEM_PROMPT_EN,
  PLANNER_MEMO_SYSTEM_PROMPT_KO,
  PLANNER_MEMO_USER_TEMPLATE,
  PLANNER_MEMO_USER_TEMPLATE_EN,
  PLANNER_MEMO_USER_TEMPLATE_KO,
  buildPlannerUserMessage,
  buildGoldenOpeningGuidance,
} from "../agents/planner-prompts.js";

describe("PLANNER_MEMO_SYSTEM_PROMPT", () => {
  it("contains key mobile web-fiction craft phrases", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("1 主线 + 1 支线");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("三连问");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不要 YAML frontmatter");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 本章目标");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 关联线索");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不超过 50 字");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 当前任务");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("## 不要做");
  });

  it("is not accidentally empty", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });

  it("allows clean closure instead of forcing an end hook in Chinese and English", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("干净结算章可以直接收束");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("干净结算可以直接收束");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("每章章尾留钩");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("每一笔都要是未来剧情的伏笔或钩子");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("每 3-5 章必须有一个小目标达成或悬念升级");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不当作硬配额");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("a clean-closure chapter may simply close");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("clean closure may simply close");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).not.toContain("every chapter ends with a hook");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).not.toContain("every beat must be a future foreshadow or hook");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).not.toContain("every 3-5 chapters there must be");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("not as a hard quota");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("不是清仓配额");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("每章对活跃 hook 做明确动作");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("not a clearance quota");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).not.toContain("every chapter takes explicit action on active hooks");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).toContain("고정 슬롯이나 회차별 체크리스트가 아닙니다");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).toContain("필요한 쉼");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).not.toContain("3-10화를 끌 단기 목표");
  });

  it("treats stale hooks as review candidates rather than mandatory scenes in every language", () => {
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("优先检视候选");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).toContain("否则可以 defer");
    expect(PLANNER_MEMO_SYSTEM_PROMPT).not.toContain("不允许 defer");
    expect(PLANNER_MEMO_USER_TEMPLATE).toContain("陈旧 hook 优先检视");
    expect(PLANNER_MEMO_USER_TEMPLATE).not.toContain("本章必须 advance / resolve");

    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("priority review candidate");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).toContain("otherwise defer it");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_EN).not.toContain("deferring is not allowed");
    expect(PLANNER_MEMO_USER_TEMPLATE_EN).toContain("Stale-hook review");
    expect(PLANNER_MEMO_USER_TEMPLATE_EN).not.toContain("MUST be advanced");

    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).toContain("우선 검토합니다");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).toContain("defer합니다");
    expect(PLANNER_MEMO_SYSTEM_PROMPT_KO).not.toContain("5화 이상 멈춘 복선은 advance나 resolve에 넣습니다");
    expect(PLANNER_MEMO_USER_TEMPLATE_KO).toContain("우선 검토하고 advance / resolve / defer를 고를 묵은 복선");
    expect(PLANNER_MEMO_USER_TEMPLATE_KO).not.toContain("이번 화에 반드시 다룰 묵은 복선");
  });
});

describe("PLANNER_MEMO_USER_TEMPLATE", () => {
  it("contains all placeholders", () => {
    const placeholders = [
      "{{chapterNumber}}",
      "{{previous_chapter_ending_excerpt}}",
      "{{recent_summaries}}",
      "{{current_arc_prose}}",
      "{{protagonist_matrix_row}}",
      "{{opponent_rows}}",
      "{{collaborator_rows}}",
      "{{relevant_threads}}",
      "{{recyclable_hooks}}",
      "{{isGoldenOpening}}",
      "{{book_rules_relevant}}",
    ];
    for (const ph of placeholders) {
      expect(PLANNER_MEMO_USER_TEMPLATE).toContain(ph);
    }
  });
});

describe("buildPlannerUserMessage", () => {
  it("fills placeholders in order", () => {
    const out = buildPlannerUserMessage({
      chapterNumber: 12,
      previousChapterEndingExcerpt: "上一屏结尾原文",
      recentSummaries: "| ch9 | ... |",
      currentArcProse: "主线推进七号门",
      protagonistMatrixRow: "| 阿泽 | 主角 | ... |",
      opponentRows: "| 老李 | 对手 | ... |",
      collaboratorRows: "| 小白 | 盟友 | ... |",
      relevantThreads: "- H03: 未解码信\n- S004: 七号门异常",
      recyclableHooks: "（暂无陈旧 hook——账本干净）",
      isGoldenOpening: false,
      bookRulesRelevant: "- 禁止主角降智",
    });

    expect(out).toContain("# 第 12 章 memo 请求");
    expect(out).toContain("上一屏结尾原文");
    expect(out).toContain("| ch9 | ... |");
    expect(out).toContain("主线推进七号门");
    expect(out).toContain("| 阿泽 | 主角 | ... |");
    expect(out).toContain("| 老李 | 对手 | ... |");
    expect(out).toContain("| 小白 | 盟友 | ... |");
    expect(out).toContain("- H03: 未解码信");
    expect(out).toContain("是否黄金三章：否");
    expect(out).toContain("- 禁止主角降智");
    expect(out).not.toContain("{{");
  });

  it("translates isGoldenOpening true to 是", () => {
    const out = buildPlannerUserMessage({
      chapterNumber: 1,
      previousChapterEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: true,
      bookRulesRelevant: "",
    });
    expect(out).toContain("是否黄金三章：是");
  });

  it("keeps the Korean genre-fun contract out of Chinese and English prompts", () => {
    const base = {
      chapterNumber: 6,
      previousChapterEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: false,
      bookRulesRelevant: "",
      genreFunContract: {
        name: "현대판타지 재벌물",
        pacingRule: "돈과 지분의 가시적 결과",
        chapterTypes: ["거래 승부"],
        satisfactionTypes: ["저평가 자산 선점"],
      },
    };

    for (const language of ["zh", "en"] as const) {
      const out = buildPlannerUserMessage({ ...base, language });
      expect(out).not.toContain("장르 반복 재미 후보");
      expect(out).not.toContain("저평가 자산 선점");
      expect(out).not.toContain("genre_fun_contract");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6.5 — Golden Opening Guidance prose
// ---------------------------------------------------------------------------

describe("buildGoldenOpeningGuidance", () => {
  it("emits zh opening diagnostics without fixed chapter, scene, or cast slots", () => {
    const out = buildGoldenOpeningGuidance(1, "zh");
    expect(out).toContain("黄金三章规划指引");
    expect(out).toContain("第 1 章");
    expect(out).toContain("核心冲突");
    expect(out).toContain("具体行动");
    expect(out).toContain("短期目标");
    expect(out).toContain("开篇诊断");
    expect(out).toContain("不设固定数量上限");
    expect(out).not.toContain("场景 ≤ 3");
    expect(out).not.toContain("人物 ≤ 3");
    expect(out).toContain("不是给第 1、2、3 章分配的硬槽位");
  });

  it("keeps all opening diagnostics available in chapter 2", () => {
    const out = buildGoldenOpeningGuidance(2, "zh");
    expect(out).toContain("第 2 章");
    expect(out).toContain("能力或信息优势");
    expect(out).toContain("第一次可见结果");
  });

  it("keeps the short-term goal diagnostic without a fixed 3-10 chapter quota", () => {
    const out = buildGoldenOpeningGuidance(3, "zh");
    expect(out).toContain("第 3 章");
    expect(out).toContain("短期目标");
    expect(out).not.toContain("3-10 章");
  });

  it("emits English opening diagnostics without fixed slots or counts", () => {
    const out = buildGoldenOpeningGuidance(1, "en");
    expect(out).toContain("Golden Opening Guidance");
    expect(out).toContain("Chapter 1");
    expect(out).toContain("core conflict");
    expect(out).toContain("concrete action");
    expect(out).toContain("short-term goal");
    expect(out).toContain("not fixed chapter slots");
    expect(out).toContain("there is no fixed count");
    expect(out).not.toContain("at most three scenes");
  });

  it("makes visible payoff primary and allows natural closure in every opening language", () => {
    const ko = buildGoldenOpeningGuidance(1, "ko");
    expect(ko).toContain("이번 화가 약속한 결과를 눈에 보이게 지급");
    expect(ko).toContain("억지 훅을 만들려고 결과를 감추지 않습니다");
    expect(ko).not.toContain("작은 훅이나 감정적 빈틈을 남기세요");

    const en = buildGoldenOpeningGuidance(1, "en");
    expect(en).toContain("first make its promised result visible");
    expect(en).toContain("Never hide an earned result to fabricate a hook");
    expect(en).not.toContain("must be a small hook or emotional gap");

    const zh = buildGoldenOpeningGuidance(1, "zh");
    expect(zh).toContain("先让本章承诺的结果可见");
    expect(zh).toContain("不能为了造钩子扣住已经挣到的兑现");
    expect(zh).not.toContain("不要写成平稳收束");
  });

  it("returns empty string for ch>=4 in both languages", () => {
    expect(buildGoldenOpeningGuidance(4, "zh")).toBe("");
    expect(buildGoldenOpeningGuidance(5, "zh")).toBe("");
    expect(buildGoldenOpeningGuidance(4, "en")).toBe("");
    expect(buildGoldenOpeningGuidance(99, "en")).toBe("");
  });

  it("renders as cohesive prose, not a numbered or bulleted checklist", () => {
    const zh = buildGoldenOpeningGuidance(1, "zh");
    // Heading is allowed; body must not contain enumerated lines.
    expect(zh).not.toMatch(/^\s*1\.\s/m);
    expect(zh).not.toMatch(/^\s*-\s/m);
    expect(zh).not.toMatch(/^\s*\*\s/m);
  });

  it("buildPlannerUserMessage appends guidance for ch<=3 and omits it for ch>=4", () => {
    const base = {
      previousChapterEndingExcerpt: "",
      recentSummaries: "",
      currentArcProse: "",
      protagonistMatrixRow: "",
      opponentRows: "",
      collaboratorRows: "",
      relevantThreads: "",
      recyclableHooks: "",
      isGoldenOpening: false,
      bookRulesRelevant: "",
    };

    const ch2 = buildPlannerUserMessage({ ...base, chapterNumber: 2 });
    expect(ch2).toContain("黄金三章规划指引");
    expect(ch2).toContain("第 2 章");

    const ch4 = buildPlannerUserMessage({ ...base, chapterNumber: 4 });
    expect(ch4).not.toContain("黄金三章规划指引");
  });
});
