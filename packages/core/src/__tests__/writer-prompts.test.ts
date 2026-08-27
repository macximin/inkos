import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { buildWriterSystemPrompt, buildGoldenOpeningDiscipline } from "../agents/writer-prompts.js";
import { BookRulesSchema } from "../models/book-rules.js";

const BOOK: BookConfig = {
  id: "prompt-book",
  title: "Prompt Book",
  platform: "tomato",
  genre: "other",
  status: "active",
  targetChapters: 20,
  chapterWordCount: 3000,
  createdAt: "2026-03-22T00:00:00.000Z",
  updatedAt: "2026-03-22T00:00:00.000Z",
};

const GENRE: GenreProfile = {
  id: "other",
  name: "综合",
  language: "zh",
  chapterTypes: ["setup", "conflict"],
  fatigueWords: [],
  numericalSystem: false,
  powerScaling: false,
  eraResearch: false,
  pacingRule: "",
  satisfactionTypes: [],
  auditDimensions: [],
};

describe("buildWriterSystemPrompt", () => {
  it("includes writing methodology blocks in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 输入治理契约");
    expect(prompt).toContain("卷纲是默认规划");
    // v10: compact craft card replaces full methodology modules
    expect(prompt).toContain("写作铁律");
    expect(prompt).toContain("盐溶于汤");
    expect(prompt).toContain("黄金3章");
  });

  it("injects cross-theme prose-execution rules: simile restraint + dramatize the climax (zh)", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 5, "creative", undefined, "zh", "governed",
    );
    expect(prompt).toContain("明喻节制");
    expect(prompt).toContain("高潮必须演出");
    expect(prompt).toContain("不许概述");
  });

  it("injects cross-theme prose-execution rules into the English prompt", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK }, { ...GENRE, language: "en" }, null, "", "", "", undefined, 5, "creative", undefined, "en", "governed",
    );
    expect(prompt).toContain("Simile restraint");
    expect(prompt).toContain("Play out the climax");
  });

  it("keeps unprovenanced personalityLock as characterization advice, never a hard mandate", () => {
    const rules = BookRulesSchema.parse({
      protagonist: {
        name: "Han",
        personalityLock: ["범죄 뒤에는 반드시 속죄한다"],
        behavioralConstraints: [],
      },
    });

    const ko = buildWriterSystemPrompt(
      { ...BOOK, language: "ko" },
      { ...GENRE, language: "ko", name: "현대 판타지" },
      rules, "", "", "", undefined, 6, "creative", undefined, "ko", "governed",
    );
    expect(ko).toContain("성격 참고(인물 형상화용, 자동 금지 아님)");
    expect(ko).not.toContain("성격 고정점");

    const en = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General" },
      rules, "", "", "", undefined, 6, "creative", undefined, "en", "governed",
    );
    expect(en).toContain("Characterization reference (advisory, not a hard rule)");
    expect(en).not.toContain("Protagonist lock");

    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, rules, "", "", "", undefined, 6, "creative", undefined, "zh", "governed",
    );
    expect(zh).toContain("性格参考（仅供人物塑造，不是硬规则）");
    expect(zh).not.toContain("性格锁定");
  });

  it("keeps zh/en endings fun-first without hook quotas or forced cliffhangers", () => {
    for (const inputProfile of ["legacy", "governed"] as const) {
      const zh = buildWriterSystemPrompt(
        BOOK, GENRE, null, "", "", "", undefined, 6, "creative", undefined, "zh", inputProfile,
      );
      expect(zh).toContain("完整收束和有余韵的平静都是合法结尾");
      expect(zh).toContain("不按每多少字几个爽点、钩子或未解悬念来凑数");
      expect(zh).toContain("不得只为制造断章而扣住读者已经挣到的结果");
      expect(zh).not.toContain("每章结尾设置悬念/伏笔/钩子");
      expect(zh).not.toContain("每 300 字至少 1 个爽点");
      expect(zh).not.toContain("每 500 字至少 1 个钩子");
      expect(zh).not.toContain("每 1000-1500 字至少 1 个完整悬念");
      expect(zh).not.toContain("永远不要在一章里把本章故事讲完");
      expect(zh).not.toContain("满足70%");
      expect(zh).not.toContain("读者期待释放时适当延迟");

      const en = buildWriterSystemPrompt(
        { ...BOOK, language: "en" },
        { ...GENRE, language: "en", name: "General" },
        null,
        "",
        "",
        "",
        undefined,
        6,
        "creative",
        undefined,
        "en",
        inputProfile,
      );
      expect(en).toContain("A clean settlement or earned calm is valid");
      expect(en).toContain("not by a fixed number of payoffs, hooks, or unresolved arcs");
      expect(en).toContain("Do not postpone an earned result merely to manufacture a cliffhanger");
      expect(en).not.toContain("Every chapter ending needs a hook");
      expect(en).not.toContain("A forward hook roughly every");
      expect(en).not.toContain("A full setup → tension → unresolved arc");
      expect(en).not.toContain("Never finish the chapter's story inside the chapter");
      expect(en).not.toContain("70% satisfaction");
      expect(en).not.toContain("Delay release when the reader craves it");
    }
  });

  it("treats the chapter memo as steering rather than a literal prose checklist", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 6, "creative", undefined, "zh", "governed",
    );
    expect(zh).toContain("不是逐项打勾的清单");
    expect(zh).toContain("不要求在正文里逐条留下字面痕迹");
    expect(zh).not.toContain("每一段都要在正文里有对应的兑现痕迹");

    const en = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General" },
      null,
      "",
      "",
      "",
      undefined,
      6,
      "creative",
      undefined,
      "en",
      "governed",
    );
    expect(en).toContain("steering contract, not a checklist");
    expect(en).toContain("do not require a literal one-to-one trace");
    expect(en).not.toContain("Every section must leave a visible trace");
  });

  it("treats hook debt as evidence and only memo-selected hooks as scene obligations", () => {
    const ko = buildWriterSystemPrompt(
      { ...BOOK, language: "ko" },
      { ...GENRE, language: "ko", name: "현대 판타지" },
      null, "", "", "", undefined, 6, "creative", undefined, "ko", "governed",
    );
    expect(ko).toContain("복선 목록은 증거이지 장면 할당량이 아닙니다");
    expect(ko).toContain("defer 항목과 단순히 오래 묵었다는 이유만으로는 본문 의무가 생기지 않습니다");

    const en = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General" },
      null, "", "", "", undefined, 6, "creative", undefined, "en", "governed",
    );
    expect(en).toContain("Hook Debt Briefs are evidence, not scene quotas");
    expect(en).toContain("Entries under defer need no prose");
    expect(en).toContain("Age or stale status alone never creates a scene obligation");

    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "", "", "", undefined, 6, "creative", undefined, "zh", "governed",
    );
    expect(zh).toContain("Hook Debt 简报是证据，不是场景配额");
    expect(zh).toContain("defer 条目不需要落进正文");
    expect(zh).toContain("stale，不会自动变成本章场景义务");
  });

  it("keeps an unprovenanced narrative-person field advisory (#290)", () => {
    const firstPerson = BookRulesSchema.parse({ narrativePerson: "first" });
    const promptFirst = buildWriterSystemPrompt(
      BOOK, GENRE, firstPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptFirst).toContain("叙事人称参考（非自动硬规则）");
    expect(promptFirst).toContain("第一人称");
    expect(promptFirst).toContain("不能成为自动修改理由");

    // Unset → no narrative-person section is imposed (the genre default applies).
    const noPerson = BookRulesSchema.parse({});
    const promptNone = buildWriterSystemPrompt(
      BOOK, GENRE, noPerson, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 3, "creative", undefined, "zh", "governed",
    );
    expect(promptNone).not.toContain("叙事人称参考");
  });

  it("tolerates a stray narrativePerson value (degrades to no constraint, fail-open)", () => {
    const rules = BookRulesSchema.parse({ narrativePerson: "(仅当用户指定)" });
    expect(rules.narrativePerson).toBeUndefined();
  });

  it("uses target-range wording when a length spec is provided", () => {
    const lengthSpec = LengthSpecSchema.parse({
      target: 2200,
      softMin: 1900,
      softMax: 2500,
      hardMin: 1600,
      hardMax: 2800,
      countingMode: "zh_chars",
      normalizeMode: "none",
    });

    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
      lengthSpec,
    );

    expect(prompt).toContain("目标字数：2200");
    expect(prompt).toContain("允许区间：1900-2500");
    expect(prompt).not.toContain("正文不少于2200字");
  });

  it("keeps hard guardrails and book/style constraints in governed mode", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules\n\n- Do not reveal the mastermind.",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    expect(prompt).toContain("## 核心规则");
    expect(prompt).toContain("## 硬性禁令");
    expect(prompt).toContain("Do not reveal the mastermind");
    expect(prompt).toContain("Keep the prose restrained");
  });

  it("injects the creative constitution and six pillars of immersion as prose (zh)", () => {
    const prompt = buildWriterSystemPrompt(
      BOOK,
      GENRE,
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      3,
      "creative",
      undefined,
      "zh",
      "governed",
    );

    // Constitution and pillars appear as prose section headings.
    expect(prompt).toContain("## 创作宪法");
    expect(prompt).toContain("## 代入感六支柱");
    // Constitution prose beats — verify a few load-bearing phrases ship.
    expect(prompt).toContain("盐溶于汤");
    expect(prompt).toContain("全员智商在线");
    expect(prompt).toContain("拒绝流水账");
    // Pillar prose beats — ensure six-pillar content is present.
    expect(prompt).toContain("基础信息标签化");
    expect(prompt).toContain("可视化熟悉感");
    expect(prompt).toContain("五感钩子");
    // Must NOT be rendered as a numbered checklist — writer must internalise.
    expect(prompt).not.toContain("1. 基础信息标签化");
    expect(prompt).not.toContain("- 基础信息标签化");
  });

  it("injects the creative constitution and six pillars of immersion as prose (en)", () => {
    const prompt = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General" },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide",
      undefined,
      3,
      "creative",
      undefined,
      "en",
      "governed",
    );

    expect(prompt).toContain("## Creative Constitution");
    expect(prompt).toContain("## Six Pillars of Immersion");
    expect(prompt).toContain("salt in soup");
    expect(prompt).toContain("Refuse chronicle drift");
    expect(prompt).toContain("core tag plus one contrasting detail");
  });

  it("injects golden opening discipline into zh writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        GENRE,
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "zh",
        "governed",
      );
      expect(prompt).toContain("黄金三章写作纪律");
      expect(prompt).toContain(`第 ${ch} 章`);
    }
  });

  it("injects golden opening discipline into en writer system prompt for ch<=3", () => {
    for (const ch of [1, 2, 3]) {
      const prompt = buildWriterSystemPrompt(
        BOOK,
        { ...GENRE, language: "en", name: "General" },
        null,
        "# Book Rules",
        "# Genre Body",
        "# Style Guide",
        undefined,
        ch,
        "creative",
        undefined,
        "en",
        "governed",
      );
      expect(prompt).toContain("Golden Opening Discipline");
      expect(prompt).toContain(`Chapter ${ch}`);
    }
  });

  it("omits golden opening discipline for ch>=4 in both languages", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, GENRE, null, "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "zh", "governed",
    );
    expect(zh).not.toContain("黄金三章写作纪律");

    const en = buildWriterSystemPrompt(
      BOOK, { ...GENRE, language: "en", name: "General" }, null,
      "# Book Rules", "# Genre Body", "# Style Guide",
      undefined, 4, "creative", undefined, "en", "governed",
    );
    expect(en).not.toContain("Golden Opening Discipline");
  });

  it("renders golden opening discipline as cohesive prose, not a checklist", () => {
    const out = buildGoldenOpeningDiscipline(1, "zh");
    // Header line is allowed; body must not contain enumerated/bulleted lines.
    expect(out).not.toMatch(/^\s*1\.\s/m);
    expect(out).not.toMatch(/^\s*-\s/m);
    expect(out).not.toMatch(/^\s*\*\s/m);
    // Carries the load-bearing story-value contract without fixed slots.
    expect(out).toContain("不靠固定句位公式");
    expect(out).toContain("做出来");
    expect(out).toContain("看得见的后果");
    expect(out).toContain("不设固定配额");
    expect(out).toContain("不能为了伪造悬念扣住已经挣到的兑现");
    expect(out).not.toContain("前 300 字");
    expect(out).not.toContain("最后一句必须");
  });

  it("keeps later golden and genre blocks advisory instead of reintroducing fixed cast or cadence quotas", () => {
    const zh = buildWriterSystemPrompt(
      BOOK, { ...GENRE, pacingRule: "三章内必须反馈" }, null,
      "", "- 每三章必须反转", "", undefined, 1, "creative", undefined, "zh", "governed",
    );
    expect(zh).toContain("以下是优先指导，不是固定配额");
    expect(zh).toContain("不设开篇固定上限");
    expect(zh).toContain("题材节奏诊断（不是通过配额）");
    expect(zh).toContain("章数频率、章节形状、回报与章尾例子都只是参考");
    expect(zh).not.toContain("第 1-2 章有名有姓参与正面冲突的人物 ≤ 2 个");

    const en = buildWriterSystemPrompt(
      { ...BOOK, language: "en" },
      { ...GENRE, language: "en", name: "General", pacingRule: "A payoff every three chapters" },
      null, "", "- Every third chapter must reverse", "", undefined, 1, "creative", undefined, "en", "governed",
    );
    expect(en).toContain("rather than fixed caps");
    expect(en).toContain("Genre rhythm diagnostic (not a pass/fail quota)");
    expect(en).toContain("Cadence, chapter-shape, payoff, and ending examples");
    expect(en).not.toContain("ch1-ch2 keep named characters in conflict ≤ 2");
  });

  it("buildGoldenOpeningDiscipline returns empty string for ch>=4 / undefined", () => {
    expect(buildGoldenOpeningDiscipline(4, "zh")).toBe("");
    expect(buildGoldenOpeningDiscipline(99, "en")).toBe("");
    expect(buildGoldenOpeningDiscipline(undefined, "zh")).toBe("");
  });

  it("tells governed English prompts to obey variance briefs and include resistance-bearing exchanges", () => {
    const prompt = buildWriterSystemPrompt(
      {
        ...BOOK,
        language: "en",
      },
      {
        ...GENRE,
        language: "en",
        name: "General",
      },
      null,
      "# Book Rules",
      "# Genre Body",
      "# Style Guide\n\nKeep the prose restrained.",
      undefined,
      3,
      "creative",
      undefined,
      "en",
      "governed",
    );

    expect(prompt).toContain("English Variance Brief");
    expect(prompt).toContain("resistance-bearing exchange");
  });
});
