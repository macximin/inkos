import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { FanficMode } from "../models/book.js";
import type { ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { getFanficDimensionConfig, FANFIC_DIMENSIONS } from "./fanfic-dimensions.js";
import { readFile, readdir } from "node:fs/promises";
import { filterHooks, filterSummaries, filterSubplots, filterEmotionalArcs, filterCharacterMatrix } from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import {
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";
import { join } from "node:path";

export interface AuditResult {
  readonly passed: boolean;
  /** Creative/structural pass, kept separate from real-world verification. */
  readonly creativePassed?: boolean;
  /** Real-world verification state. This never fails creative review by itself. */
  readonly researchStatus?: ResearchStatus;
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly summary: string;
  /** True when the auditor response itself was not parseable; callers must not auto-revise content from this result. */
  readonly parseFailed?: boolean;
  /** 0-100 overall quality score. Present when the auditor supports scoring. */
  readonly overallScore?: number;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface AuditIssue {
  readonly severity: "critical" | "warning" | "info";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
  readonly repairScope?: "local" | "structural" | "unknown";
  /** Research findings are evidence/status only and never drive automatic prose revision. */
  readonly track?: "creative" | "research";
}

export type ResearchStatus = "not-applicable" | "not-checked" | "needs-research" | "verified" | "conflict";

export function isAutomaticRevisionIssue(issue: AuditIssue): boolean {
  return issue.track !== "research" && issue.severity !== "info";
}

type PromptLanguage = "zh" | "ko" | "en";

function normalizeRepairScope(value: unknown): AuditIssue["repairScope"] {
  if (value === "local" || value === "structural" || value === "unknown") return value;
  return undefined;
}

function normalizeResearchStatus(value: unknown): ResearchStatus | undefined {
  return value === "not-applicable"
    || value === "not-checked"
    || value === "needs-research"
    || value === "verified"
    || value === "conflict"
    ? value
    : undefined;
}

function inferIssueTrack(issue: AuditIssue): "creative" | "research" {
  const text = `${issue.category} ${issue.description}`;
  // Host-owned routing wins over an LLM-supplied track. Otherwise a model can
  // accidentally turn an unverified historical claim into a prose rewrite.
  if (/Era Accuracy|年代考据|시대 고증|고증|research|fact.?check|事实核查/i.test(text)) {
    return "research";
  }
  return issue.track ?? "creative";
}

function normalizeSeparatedAuditResult(
  result: AuditResult,
  options: { readonly researchExpected: boolean; readonly futureAdvantageActive: boolean },
): AuditResult {
  const issues = result.issues.map((rawIssue) => {
    const track = inferIssueTrack(rawIssue);
    let severity = rawIssue.severity;
    const text = `${rawIssue.category} ${rawIssue.description}`;

    // Missing or disputed research is a verification state, not a prose-repair
    // command. Critical future-advantage findings remain possible only for an
    // actual forbidden shortcut, information-boundary breach, or canon conflict.
    if (track === "research") severity = "info";
    if (
      options.futureAdvantageActive
      && severity === "critical"
      && /future advantage|未来先机|미래 선점|회귀 지식/i.test(text)
      && !/forbidden shortcut|금지된 지름길|禁止.*捷径|information boundary|정보 경계|信息越界|canon conflict|정본 모순|正典.*冲突/i.test(text)
    ) {
      severity = "warning";
    }
    return { ...rawIssue, severity, track };
  });
  const creativePassed = !result.parseFailed
    && !issues.some((issue) => issue.track !== "research" && issue.severity === "critical");
  const researchIssues = issues.filter((issue) => issue.track === "research");
  const inferredResearchStatus: ResearchStatus = !options.researchExpected
    ? "not-applicable"
    : researchIssues.some((issue) => /conflict|contradict|충돌|모순|冲突/i.test(`${issue.category} ${issue.description}`))
      ? "conflict"
      : researchIssues.length > 0
        ? "needs-research"
        : "not-checked";
  return {
    ...result,
    passed: creativePassed,
    creativePassed,
    researchStatus: researchIssues.length > 0
      ? inferredResearchStatus
      : (result.researchStatus ?? inferredResearchStatus),
    issues,
  };
}

const DIMENSION_LABELS: Record<number, { readonly zh: string; readonly en: string }> = {
  1: { zh: "OOC检查", en: "OOC Check" },
  2: { zh: "时间线检查", en: "Timeline Check" },
  3: { zh: "设定冲突", en: "Lore Conflict Check" },
  4: { zh: "战力崩坏", en: "Power Scaling Check" },
  5: { zh: "数值检查", en: "Numerical Consistency Check" },
  6: { zh: "伏笔检查", en: "Hook Check" },
  7: { zh: "节奏检查", en: "Pacing Check" },
  8: { zh: "文风检查", en: "Style Check" },
  9: { zh: "信息越界", en: "Information Boundary Check" },
  10: { zh: "词汇疲劳", en: "Lexical Fatigue Check" },
  11: { zh: "利益链断裂", en: "Incentive Chain Check" },
  12: { zh: "年代考据", en: "Era Accuracy Check" },
  13: { zh: "配角降智", en: "Side Character Competence Check" },
  14: { zh: "配角工具人化", en: "Side Character Instrumentalization Check" },
  15: { zh: "爽点虚化", en: "Payoff Dilution Check" },
  16: { zh: "台词失真", en: "Dialogue Authenticity Check" },
  17: { zh: "流水账", en: "Chronicle Drift Check" },
  18: { zh: "知识库污染", en: "Knowledge Base Pollution Check" },
  19: { zh: "视角一致性", en: "POV Consistency Check" },
  20: { zh: "段落等长", en: "Paragraph Uniformity Check" },
  21: { zh: "套话密度", en: "Cliche Density Check" },
  22: { zh: "公式化转折", en: "Formulaic Twist Check" },
  23: { zh: "列表式结构", en: "List-like Structure Check" },
  24: { zh: "支线停滞", en: "Subplot Stagnation Check" },
  25: { zh: "弧线平坦", en: "Arc Flatline Check" },
  26: { zh: "节奏单调", en: "Pacing Monotony Check" },
  27: { zh: "敏感词检查", en: "Sensitive Content Check" },
  28: { zh: "正传事件冲突", en: "Mainline Canon Event Conflict" },
  29: { zh: "未来信息泄露", en: "Future Knowledge Leak Check" },
  30: { zh: "世界规则跨书一致性", en: "Cross-Book World Rule Check" },
  31: { zh: "番外伏笔隔离", en: "Spinoff Hook Isolation Check" },
  32: { zh: "读者期待管理", en: "Reader Expectation Check" },
  33: { zh: "章节备忘偏离", en: "Chapter Memo Drift Check" },
  34: { zh: "角色还原度", en: "Character Fidelity Check" },
  35: { zh: "世界规则遵守", en: "World Rule Compliance Check" },
  36: { zh: "关系动态", en: "Relationship Dynamics Check" },
  37: { zh: "正典事件一致性", en: "Canon Event Consistency Check" },
};

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function resolveGenreLabel(genreId: string, profileName: string, language: PromptLanguage): string {
  if (language === "zh" || !containsChinese(profileName)) {
    return profileName;
  }

  if (genreId === "other") {
    return "general";
  }

  return genreId.replace(/[_-]+/g, " ");
}

function dimensionName(id: number, language: PromptLanguage): string | undefined {
  return DIMENSION_LABELS[id]?.[language === "zh" ? "zh" : "en"];
}

function joinLocalized(items: ReadonlyArray<string>, language: PromptLanguage): string {
  return items.join(language === "zh" ? "、" : ", ");
}

function formatFanficSeverityNote(
  severity: "critical" | "warning" | "info",
  language: PromptLanguage,
): string {
  if (language !== "zh") {
    return severity === "critical"
      ? "Strict check."
      : severity === "info"
        ? "Log only; do not fail the chapter."
        : "Warning level.";
  }

  return severity === "critical"
    ? "（严格检查）"
    : severity === "info"
      ? "（仅记录，不判定失败）"
      : "（警告级别）";
}

function buildDimensionNote(
  id: number,
  language: PromptLanguage,
  gp: GenreProfile,
  bookRules: BookRules | null,
  fanficMode: FanficMode | undefined,
  fanficConfig: ReturnType<typeof getFanficDimensionConfig> | undefined,
): string {
  const words = bookRules?.fatigueWordsOverride && bookRules.fatigueWordsOverride.length > 0
    ? bookRules.fatigueWordsOverride
    : gp.fatigueWords;

  if (fanficConfig?.notes.has(id) && language === "zh") {
    return fanficConfig.notes.get(id)!;
  }

  if (id === 1 && fanficMode === "ooc") {
    return language !== "zh"
      ? "In OOC mode, personality drift can be intentional; record only, do not fail. Evaluate against the character dossiers in fanfic_canon.md."
      : "OOC模式下角色可偏离性格底色，此维度仅记录不判定失败。参照 fanfic_canon.md 角色档案评估偏离程度。";
  }

  if (id === 1 && fanficMode === "canon") {
    return language !== "zh"
      ? "Canon-faithful fanfic: characters must stay close to their original personality core. Evaluate against fanfic_canon.md character dossiers."
      : "原作向同人：角色必须严格遵守性格底色。参照 fanfic_canon.md 角色档案中的性格底色和行为模式。";
  }

  if (id === 10 && words.length > 0) {
    return language !== "zh"
      ? `Fatigue words: ${words.join(", ")}. Also check AI tell markers (仿佛/不禁/宛如/竟然/忽然/猛地); warn when any appears more than once per 3,000 words.`
      : `高疲劳词：${words.join("、")}。同时检查AI标记词（仿佛/不禁/宛如/竟然/忽然/猛地）密度，每3000字超过1次即warning`;
  }

  if (id === 15 && gp.satisfactionTypes.length > 0) {
    return language !== "zh"
      ? `Payoff types: ${gp.satisfactionTypes.join(", ")}`
      : `爽点类型：${gp.satisfactionTypes.join("、")}`;
  }

  if (id === 12 && bookRules?.eraConstraints) {
    const era = bookRules.eraConstraints;
    const parts = [era.period, era.region].filter(Boolean);
    if (parts.length > 0) {
      return language !== "zh"
        ? `Era: ${parts.join(", ")}`
        : `年代：${parts.join("，")}`;
    }
  }

  // v10: Enhanced dimension notes with writing methodology awareness
  if (id === 7) {
    return language !== "zh"
      ? "Check pacing rhythm: Do the recent 3-5 chapters form a complete mini-goal cycle (build-up → escalation → climax → aftermath)? If 5+ consecutive chapters pass without a climax (payoff/reward/reversal), flag as pacing stagnation. If the previous chapter was a climax/big reversal, does this chapter show change (relationships shifted, status changed, costs paid)? If it jumps straight to new build-up without showing impact, flag as 'post-climax impact missing'. Daily/transition scenes must carry at least one task: plant a hook, advance a relationship, set up contrast, or prepare the next cycle."
      : "检查节奏波形：最近 3-5 章是否形成了完整的「蓄压→升级→爆发→后效」周期？如果连续 5 章没有爆发（兑现/回报/翻转），标记为节奏停滞。如果上一章是爆发/高潮/大反转，本章是否写出了改变？如果直接跳到新蓄压而没有展示前一波爆发的影响，标记为「高潮后影响缺失」。非冲突章节中的日常/过渡/对话段落，是否至少承担了一项任务：埋伏笔、推关系、建立反差、准备下一轮蓄压。纯水日常标记为流水账风险。";
  }

  if (id === 15) {
    const base = gp.satisfactionTypes.length > 0
      ? (language !== "zh" ? `Payoff types: ${gp.satisfactionTypes.join(", ")}. ` : `爽点类型：${gp.satisfactionTypes.join("、")}。`)
      : "";
    return language !== "zh"
      ? `${base}Check desire engine: Has the chapter created an emotional gap (reader wants release) OR delivered a payoff that exceeds expectations? A payoff that only satisfies 70% of built-up anticipation counts as diluted. If this chapter is in the aftermath phase of a mini-goal cycle, verify that consequences are shown — not just emotional reactions, but concrete changes to status, relationships, or resources.`
      : `${base}检查欲望驱动：本章是否制造了情绪缺口（读者渴望释放）或完成了超出预期的兑现？只满足读者70%期待的兑现等于爽点虚化。如果本章处于小目标周期的后效阶段，检查是否展示了具体改变——不只是情绪反应，而是地位、关系或资源的实际变化。`;
  }

  if (id === 25) {
    return language !== "zh"
      ? "Cross-check character behavior against the 3-question test: (1) Why does the character do this? (2) Does it match their established profile? (3) Would a reader who only read prior chapters find it jarring? Also check if character's emotional state progresses or stagnates."
      : "人设三问检查：(1)角色为什么这么做？(2)符合之前建立的人设吗？(3)只看过前面章节的读者会觉得突兀吗？同时检查角色情绪弧线是否在推进还是停滞。";
  }

  switch (id) {
    case 6:
      // Phase 7 — hook-debt escalation. Reviewer now reads pending_hooks.md
      // not just for "is this hook undelivered" but for causal/temporal
      // debt escalation. The ledger's status column carries "过期 (距=…/半衰=…)"
      // and "受阻于 …" markers emitted by the stale/blocked detector; this
      // dimension tells the reviewer how to escalate them.
      return language !== "zh"
        ? `Hook-debt escalation (Phase 7 + hotfixes 2/3). Read the pending_hooks.md ledger and escalate based on the stale / blocked / core_hook / depends_on / promoted columns, NOT only on "undelivered hook present":

• Critical severity only applies to hooks with promoted=true in the ledger. A stale/blocked non-promoted hook stays at info — the promotion flag is the gate that keeps reviewer noise down, because architect-seed emits many non-load-bearing seeds.
• A promoted core_hook=true hook that has been stale for over 10 chapters → escalate from warning to critical. The book has only 3-7 core hooks; letting one drift that long is the lead symptom of narrative rot.
• A promoted hook whose status cell contains "blocked on X (blocked Y chapters)" with Y >= 6 → warning. The literal "blocked Y chapters" token comes straight from the ledger — read it, don't guess. Call out the upstream hook id so the planner can route the resolution.
• At volume end (final chapter of any volume per volume_map) a promoted core_hook that is still open or stale without explicit "carried over to volume N+1" planning → critical.
• Any non-promoted stale hook → info-level log; do not fail the chapter on it, but note it so the planner can schedule cleanup.

Quote the exact hook_id in description and include the stale / blocked marker text verbatim. Structure check only — do not judge hook prose quality.`
        : `Phase 7 hook-debt 升级规则（含 hotfix 2/3）。阅读 pending_hooks.md 伏笔池时不要只看"有没有悬而未决的伏笔"，要读状态列中的 stale / blocked 标记、core_hook 列、depends_on 列、以及升级列：

• critical 级别仅适用于升级=是（promoted=true）的伏笔。非升级的 stale/blocked 伏笔一律保持 info——升级标志是降噪的开关，因为架构师阶段会产出大量非承重的伏笔种子。
• 升级=是且 core_hook=是 的伏笔过期超过 10 章未回收 → warning 升级为 critical。全书只有 3-7 条核心伏笔，任何一条漂移这么久都是烂尾前兆。
• 升级=是的受阻伏笔，状态列中"受阻于 X (已阻 Y 章)"且 Y ≥ 6 → warning。"已阻 Y 章"这个字面 token 直接读自账本，不要猜。描述中要写出具体的上游 hook_id，让 planner 能安排落地路径。
• 卷尾（volume_map 中任一卷的末章）仍有升级=是的主线伏笔处于 open 或 stale 且没有显式"延至下一卷"规划 → critical。
• 升级=否的 stale 伏笔 → info 级记录，不判本章失败，但保留以便 planner 安排清理。

description 中要明确引用 hook_id，并把状态列中 stale / blocked 的原文标记字面抄进去。本维度只审结构，不评价伏笔文笔。`;
    case 19:
      return language !== "zh"
        ? "Check whether POV shifts are signaled clearly and stay consistent with the configured viewpoint."
        : "检查视角切换是否有过渡、是否与设定视角一致";
    case 24:
      return language !== "zh"
        ? "Cross-check subplot_board and chapter_summaries: flag any subplot that stays dormant long enough to feel abandoned, or a recent run where every subplot is only restated instead of genuinely moving."
        : "对照 subplot_board 和 chapter_summaries：标记那些沉寂到接近被遗忘的支线，或近期连续只被重复提及、没有真实推进的支线。";
    case 25:
      return language !== "zh"
        ? "Cross-check emotional_arcs and chapter_summaries: flag any major character whose emotional line holds one pressure shape across a run instead of taking new pressure, release, reversal, or reinterpretation. Distinguish unchanged circumstances from unchanged inner movement."
        : "对照 emotional_arcs 和 chapter_summaries：标记主要角色在一段时间内始终停留在同一种情绪压力形态、没有新压力、释放、转折或重估的情况。注意区分'处境未变'和'内心未变'。";
    case 26:
      return language !== "zh"
        ? "Cross-check chapter_summaries for chapter-type distribution: warn when the recent sequence stays in the same mode long enough to flatten rhythm, or when payoff / release beats disappear for too long. Explicitly list the recent type sequence."
        : "对照 chapter_summaries 的章节类型分布：当近期章节长时间停留在同一种模式、把节奏压平，或回收/释放/高潮章节缺席过久时给出 warning。请明确列出最近章节的类型序列。";
    case 28:
      return language !== "zh"
        ? "Check whether spinoff events contradict the mainline canon constraints."
        : "检查番外事件是否与正典约束表矛盾";
    case 29:
      return language !== "zh"
        ? "Check whether characters reference information that should only be revealed after the divergence point (see the information-boundary table)."
        : "检查角色是否引用了分歧点之后才揭示的信息（参照信息边界表）";
    case 30:
      return language !== "zh"
        ? "Check whether the spinoff violates mainline world rules (power system, geography, factions)."
        : "检查番外是否违反正传世界规则（力量体系、地理、阵营）";
    case 31:
      return language !== "zh"
        ? "Check whether the spinoff resolves mainline hooks without authorization (warning level)."
        : "检查番外是否越权回收正传伏笔（warning级别）";
    case 32:
      return language !== "zh"
        ? "Check whether the ending renews curiosity, whether promised payoffs are landing on the cadence their hooks imply, whether pressure gets any release, and whether reader expectation gaps are accumulating faster than they are being satisfied. If a climax just occurred, check whether the aftermath chapters show concrete change before starting a new cycle."
        : "检查：章尾是否重新点燃好奇心，已经承诺的回收是否按伏笔自身节奏落地，压力是否得到释放，读者期待缺口是在持续累积还是在被满足。如果刚经历高潮，检查后效章节是否在开启新周期前展示了具体改变。";
    case 33:
      return language !== "zh"
        ? "Cross-check the chapter_memo provided with the chapter. Does the final prose deliver the memo's goal and leave a visible trace for every one of the 7 sections it contains (tasks, pay-offs / held-back cards, daily/transition function map, three-question check, end-of-chapter concrete changes, hard-don'ts)? Missing or contradicted sections -> critical. Note: a sparse memo (breather chapter, goal + skeleton body only) is legitimate — only flag drift against sections that the memo actually populates. Never flag the memo itself for being sparse."
        : "对照随章提供的 chapter_memo。成稿是否兑现了 memo 中的 goal，并在 7 段正文（当前任务 / 该兑现·暂不掀 / 日常过渡功能 / 关键抉择三连问 / 章尾必须发生的改变 / 不要做 等）中留下可见落地痕迹？任何段落缺失或被写反 → critical。提醒：稀疏 memo 合法（喘息章 memo 可以只有 goal + 骨架 body），只检查 memo 实际写出的段落，不能因为 memo 稀疏就判 incomplete。";
    case 34:
    case 35:
    case 36:
    case 37: {
      if (!fanficConfig) return "";
      const severity = fanficConfig.severityOverrides.get(id) ?? "warning";
      const baseNote = language !== "zh"
        ? {
            34: "Check whether dialogue tics, speaking style, and behavior remain consistent with the character dossiers in fanfic_canon.md. Deviations need clear situational motivation.",
            35: "Check whether the chapter violates world rules documented in fanfic_canon.md (geography, power system, faction relations).",
            36: "Check whether relationship beats remain plausible and aligned with, or meaningfully develop from, the key relationships documented in fanfic_canon.md.",
            37: "Check whether the chapter contradicts the key event timeline in fanfic_canon.md.",
          }[id]
        : FANFIC_DIMENSIONS.find((dimension) => dimension.id === id)?.baseNote;

      return baseNote
        ? `${baseNote} ${formatFanficSeverityNote(severity, language)}`
        : "";
    }
    default:
      return "";
  }
}

function buildDimensionList(
  gp: GenreProfile,
  bookRules: BookRules | null,
  language: PromptLanguage,
  hasParentCanon = false,
  fanficMode?: FanficMode,
): ReadonlyArray<{ readonly id: number; readonly name: string; readonly note: string }> {
  const activeIds = new Set(gp.auditDimensions);

  // Add book-level additional dimensions (supports both numeric IDs and name strings)
  if (bookRules?.additionalAuditDimensions) {
    // Build reverse lookup: name → id
    const nameToId = new Map<string, number>();
    for (const [id, labels] of Object.entries(DIMENSION_LABELS)) {
      nameToId.set(labels.zh, Number(id));
      nameToId.set(labels.en, Number(id));
    }

    for (const d of bookRules.additionalAuditDimensions) {
      if (typeof d === "number") {
        activeIds.add(d);
      } else if (typeof d === "string") {
        // Try exact match first, then substring match
        const exactId = nameToId.get(d);
        if (exactId !== undefined) {
          activeIds.add(exactId);
        } else {
          // Fuzzy: find dimension whose name contains the string
          for (const [name, id] of nameToId) {
            if (name.includes(d) || d.includes(name)) {
              activeIds.add(id);
              break;
            }
          }
        }
      }
    }
  }

  // Always-active dimensions
  activeIds.add(32); // 读者期待管理 — universal
  activeIds.add(33); // 章节备忘偏离 — universal (replaces legacy volume-outline drift)

  // Conditional overrides
  if (gp.eraResearch || bookRules?.eraConstraints?.enabled) {
    activeIds.add(12);
  }

  // Spinoff dimensions — activated when parent_canon.md exists (but NOT in fanfic mode)
  if (hasParentCanon && !fanficMode) {
    activeIds.add(28); // 正传事件冲突
    activeIds.add(29); // 未来信息泄露
    activeIds.add(30); // 世界规则跨书一致性
    activeIds.add(31); // 番外伏笔隔离
  }

  // Fanfic dimensions — replace spinoff dims with fanfic-specific checks
  let fanficConfig: ReturnType<typeof getFanficDimensionConfig> | undefined;
  if (fanficMode) {
    fanficConfig = getFanficDimensionConfig(fanficMode, bookRules?.allowedDeviations);
    for (const id of fanficConfig.activeIds) {
      activeIds.add(id);
    }
    for (const id of fanficConfig.deactivatedIds) {
      activeIds.delete(id);
    }
  }

  const dims: Array<{ id: number; name: string; note: string }> = [];

  for (const id of [...activeIds].sort((a, b) => a - b)) {
    const name = dimensionName(id, language);
    if (!name) continue;

    const note = buildDimensionNote(id, language, gp, bookRules, fanficMode, fanficConfig);

    dims.push({ id, name, note });
  }

  return dims;
}

export class ContinuityAuditor extends BaseAgent {
  get name(): string {
    return "continuity-auditor";
  }

  async auditChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    genre?: string,
    options?: {
      temperature?: number;
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      arcContext?: string;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      truthFileOverrides?: {
        currentState?: string;
        ledger?: string;
        hooks?: string;
      };
    },
  ): Promise<AuditResult> {
    const [diskCurrentState, diskLedger, diskHooks, styleGuideRaw, subplotBoard, emotionalArcs, characterMatrix, chapterSummaries, parentCanon, fanficCanon, volumeOutline] =
      await Promise.all([
        // Phase 5 consolidation: derive initial state from roles + seed hooks
        // when current_state.md is still the architect seed placeholder.
        readCurrentStateWithFallback(bookDir, "(文件不存在)"),
        this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
        this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
        this.readFileSafe(join(bookDir, "story/style_guide.md")),
        this.readFileSafe(join(bookDir, "story/subplot_board.md")),
        this.readFileSafe(join(bookDir, "story/emotional_arcs.md")),
        readCharacterContext(bookDir, "(文件不存在)"),
        this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
        this.readFileSafe(join(bookDir, "story/parent_canon.md")),
        this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
        readVolumeMap(bookDir, "(文件不存在)"),
      ]);
    const currentState = options?.truthFileOverrides?.currentState ?? diskCurrentState;
    const ledger = options?.truthFileOverrides?.ledger ?? diskLedger;
    const hooks = options?.truthFileOverrides?.hooks ?? diskHooks;

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    // Load last chapter full text for fine-grained continuity checking
    const previousChapter = await this.loadPreviousChapter(bookDir, chapterNumber);

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist.
    // Phase 5 hotfix 2: parsedRules.body is only populated for legacy
    // book_rules.md sources — story_frame.md frontmatter yields an empty
    // body, and an empty string is NOT a usable style guide. Treat
    // missing/empty body as "no fallback available".
    const legacyRulesBody = parsedRules?.body?.trim();
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (legacyRulesBody || "(无文风指南)");

    const resolvedLanguage = bookLanguage ?? gp.language;
    const isEnglish = resolvedLanguage !== "zh";
    const fanficMode = hasFanficCanon ? (bookRules?.fanficMode as FanficMode | undefined) : undefined;
    const dimensions = buildDimensionList(gp, bookRules, resolvedLanguage, hasParentCanon, fanficMode);
    const dimList = dimensions
      .map((d) => `${d.id}. ${d.name}${d.note ? (isEnglish ? ` (${d.note})` : `（${d.note}）`) : ""}`)
      .join("\n");
    const genreLabel = resolveGenreLabel(genreId, gp.name, resolvedLanguage);

    const protagonistBlock = bookRules?.protagonist
      ? resolvedLanguage === "ko"
        ? `\n\n주인공 고정점: ${bookRules.protagonist.name}. 성격 고정점: ${joinLocalized(bookRules.protagonist.personalityLock, resolvedLanguage)}. 행동 제약: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage)}.`
        : isEnglish
        ? `\n\nProtagonist lock: ${bookRules.protagonist.name}; personality locks: ${joinLocalized(bookRules.protagonist.personalityLock, resolvedLanguage)}; behavioral constraints: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage)}.`
        : `\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}，行为约束：${bookRules.protagonist.behavioralConstraints.join("、")}`
      : "";

    const searchNote = gp.eraResearch
      ? resolvedLanguage === "ko"
        ? "\n\n회차 심사 중에는 실시간 웹 검색을 수행하지 마세요. 제공된 리서치 근거만 사용하세요. 현실의 사실 주장을 근거에서 확인할 수 없다면 info 수준의 추가 조사 항목으로 기록하세요. 명시적으로 허용된 가상 분기는 실제 역사에 없었다는 이유만으로 오류로 판정하지 마세요."
        : isEnglish
          ? "\n\nDo not perform live web search during chapter audit. Use supplied research evidence only. If a real-world claim cannot be verified from that evidence, record an info-level research need. Never reject an explicitly authorized fictional divergence merely because it did not exist in real history."
          : "\n\n章节审稿期间不要实时联网检索，只使用已提供的研究证据。真实世界主张若无法由证据核实，应记录为 info 级待研究项。已明确授权的虚构分歧，不能仅因真实历史中不存在就判为错误。"
      : "";
    const futureAdvantageActive = Boolean(
      bookRules?.futureAdvantage?.enabled
      || options?.contextPackage?.selectedContext.some((entry) => entry.source.includes("/future-advantage/"))
      || options?.arcContext?.includes("## Future Advantage Move"),
    );
    const futureAdvantageAuditNote = !futureAdvantageActive
      ? ""
      : resolvedLanguage === "ko"
        ? "\n\n## 미래 선점 감리 경계\n- 기억한 미래 결과와 현재 구현 방법을 구분하세요. 결과를 안다는 사실만으로 구현 생략을 허용하지 않습니다.\n- 허용된 역사 분기를 실제 역사에 없었다는 이유만으로 오류 처리하지 마세요.\n- 근거가 없거나 확인되지 않은 현실 주장에는 track=research, severity=info를 사용하고 research_status=needs-research로 기록하세요. 이것은 창작 실패나 자동 수정 사유가 아닙니다.\n- 미래 선점 관련 critical 후보는 금지된 지름길, 인물의 정보 경계 위반, 허용 분기·작품 정본과의 직접 모순뿐입니다. 일반적인 창작 구조 문제는 기존 창작 감리 기준을 따릅니다."
        : resolvedLanguage === "en"
          ? "\n\n## Future Advantage audit boundary\n- Distinguish a remembered later outcome from its present-day implementation. Knowing the outcome does not waive bridge steps, resistance, proof, or cost.\n- Never mark an authorized divergence as an error merely because it did not occur in real history.\n- An unsupported or unverified real-world claim uses track=research, severity=info, and research_status=needs-research. It is not a creative failure or an automatic-revision instruction.\n- Future-advantage-specific critical candidates are limited to forbidden shortcuts, information-boundary breaches, and direct contradictions with authorized divergence or book canon. General creative structural failures still follow the normal creative audit."
          : "\n\n## 未来先机审稿边界\n- 区分主角记得的未来结果与当下实现方法；知道结果不等于可以省略实现步骤、阻力、证据或代价。\n- 已授权的历史分歧不能仅因真实历史中未发生就判错。\n- 缺少依据或尚未核实的现实主张必须使用 track=research、severity=info、research_status=needs-research；它不是创作失败，也不是自动修稿指令。\n- 未来先机专属 critical 只限于禁用捷径、信息边界越界、与授权分歧或作品正典直接矛盾。一般创作结构问题仍按原有创作审稿标准处理。";

    const systemPromptBase = resolvedLanguage === "ko"
      ? `당신은 엄격한 ${genreLabel} 웹소설 구조 편집자입니다. 문장 윤문이 아니라 회차의 완성도와 구조를 감리합니다.${protagonistBlock}${searchNote}${futureAdvantageAuditNote}

## 감리 범위(고정)

기획한 사건이 실제 장면으로 구현됐는지, 인물과 시간선이 유지되는지, 이야기가 앞으로 나아가는지만 판단하세요. 어휘, 문장 호흡, 문단 모양, 문장부호, 비유 같은 표면 문체는 Polisher의 영역입니다. 표면 문체 문제는 severity="info"로만 남길 수 있으며 passed와 overall_score에 반영하거나 critical로 만들면 안 됩니다.

구조적 독자 이탈 요인 열두 가지를 봅니다. 늘어지거나 밋밋한 도입, 현실감 없는 흐릿한 세계, 모순된 인물 설정, 뒤엉킨 시점, 주선 이탈이나 정체, 충돌과 보상 부족, 무너진 완급과 거친 전환, 아크 전후의 인물 불일치, 대비 없는 납작한 인물, 뻣뻣한 감정과 갑작스러운 관계 변화, 불균형한 특전, 행동으로 구현되지 않은 설정입니다. 아래 공학적 차원도 함께 봅니다(OOC, 시간선, 정보 경계, 복선 부채, 회차 간 반복, 어휘 피로, 분량, 제목 피로, 문단 모양).

성긴 chapter_memo는 정상입니다. 숨 고르기·후일담·전환 회차는 목표와 뼈대만 있을 수 있습니다. memo에 쓰지 않은 항목이 없다는 이유로 미완성 처리하거나 감점하지 말고, 실제로 적힌 약속에서 벗어났는지만 판단하세요.

chapter_memo, 규칙 스택, 제공 문맥이 여러 사건선의 비율을 명시했다면 각 선이 장면, 대화, 행동, 관계 변화로 실제 구현됐는지 확인하세요. 한 문장 요약으로 넘긴 선은 구현되지 않은 것으로 봅니다. 다만 memo가 해당 선을 이번 회차에 반드시 진행하라고 명시한 경우에만 critical 후보입니다.

모든 issue에는 repair_scope를 넣으세요. "local"은 표현, 문단 모양, 작은 반복, 좁은 문장 수정입니다. "structural"은 주선 이탈, 시간선 붕괴, 장면·보상 누락, 인물 논리 붕괴, 시점·정보 경계 위반처럼 장면이나 회차를 다시 써야 하는 문제입니다. 정말 판단할 수 없을 때만 "unknown"을 씁니다.

감리 차원:
${dimList}

출력은 반드시 다음 JSON 형식입니다.
{
  "passed": true/false,
  "creative_passed": true/false,
  "research_status": "not-applicable|not-checked|needs-research|verified|conflict",
  "overall_score": 0-100,
  "issues": [
    {
      "severity": "critical|warning|info",
      "repair_scope": "local|structural|unknown",
      "track": "creative|research",
      "category": "감리 차원 이름",
      "description": "구체적인 문제",
      "suggestion": "수정 제안"
    }
  ],
  "summary": "한 문장 결론"
}

creative track에 critical 문제가 있을 때만 passed와 creative_passed를 false로 둡니다. research track은 창작 통과를 실패로 바꾸지 않습니다.

overall_score 기준:
- 95-100: 그대로 공개해도 될 만큼 매끄럽고 뚜렷한 문제 없음
- 85-94: 작은 흠은 있지만 몰입을 깨지 않음
- 75-84: 눈에 띄는 문제가 있으나 이야기 뼈대는 유지됨
- 65-74: 여러 문제가 읽는 맛을 해치고 완급이나 연속성에 틈이 있음
- 65 미만: 구조가 무너져 큰 재작성이 필요함
작은 문제 하나로 점수를 크게 깎지 말고 전체 읽는 맛을 기준으로 판단하세요.`
      : isEnglish
      ? `You are a strict ${genreLabel} web-fiction structural editor. Audit the chapter for completion and structure, not for prose craft. ALL OUTPUT MUST BE IN ENGLISH.${protagonistBlock}${searchNote}${futureAdvantageAuditNote}

## Reviewer Scope (hard constraints)

You audit completion and structure only. Your job is to decide whether the chapter delivers the plan, keeps characters and timelines intact, and moves the book forward. Wording, sentence rhythm, paragraph shape, punctuation, imagery, and other prose-surface choices are NOT yours — those belong to the Polisher pass that runs after you. If you notice prose-surface issues, you may flag them with severity "info" so the Polisher can see them, but they do not count toward passed / overall_score and they must never be critical.

You audit twelve structural reader-pain patterns: dragging / flat openings, blurry worldbuilding disconnected from reality, contradictory character setup, tangled POV, mainline drift or stagnation, weak conflict with missing payoff, pacing loss of control and abrupt transitions, character inconsistency across the arc, thin/one-note characters without contrast, stiff emotion expression and abrupt relationship jumps, imbalanced cheats/power gifts, and settings that never land in concrete action. Alongside these, keep the engineering dimensions listed below (OOC, timeline coherence, information boundary, hook debt, cross-chapter repetition, lexical fatigue, length band, title fatigue, paragraph shape).

Sparse chapter_memo is legitimate. Breather / aftermath / transition chapters may ship a memo that only contains goal + a skeleton body — do NOT flag such memos as incomplete, and do NOT penalise the chapter for lacking content against sections the memo itself does not populate. Judge drift only against what the memo actually says.

If the chapter memo, rule stack, or supplied context specifies content proportions between lines (politics/romance, career/relationship, case/character, etc.), audit whether those lines appear as actual scenes, dialogue, action, or relationship movement. A line that is only summarized in one sentence counts as missing. Mark it critical only when the memo explicitly required it for this chapter.

For every issue, set repair_scope as a typed routing hint: "local" for wording, paragraph shape, small repetition, or narrow sentence-level fixes; "structural" for plot drift, timeline break, missing scene/payoff, character logic collapse, POV/knowledge boundary failure, or anything requiring a rewritten scene/chapter; "unknown" only when you genuinely cannot decide.

Audit dimensions:
${dimList}

Output format MUST be JSON:
{
  "passed": true/false,
  "creative_passed": true/false,
  "research_status": "not-applicable|not-checked|needs-research|verified|conflict",
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "track": "creative|research",
	      "category": "dimension name",
	      "description": "specific issue description",
	      "suggestion": "fix suggestion"
	    }
  ],
  "summary": "one-sentence audit conclusion"
}

passed and creative_passed are false ONLY when creative-track critical issues exist. Research-track issues never fail creative review.

overall_score calibration:
- 95-100: Publishable as-is, no noticeable issues
- 85-94: Minor blemishes but smooth reading, the reader won't break immersion
- 75-84: Noticeable problems but the story backbone holds, needs revision but not urgent
- 65-74: Multiple issues hurt the reading experience, pacing or continuity has gaps
- < 65: Structural breakdown, needs major rewrite
Score holistically — do not let a single minor issue tank the score.`
      : `你是一位严格的${gp.name}网络小说结构审稿编辑。你只审完成度 + 结构，不审文笔。${protagonistBlock}${searchNote}${futureAdvantageAuditNote}

## 审稿边界（硬约束）

你不审文笔、不审排版、不审句式——这些归 Polisher。你发现的文笔问题只能以 severity="info" 标注供 Polisher 参考，不计入 reviewer 的 passed/overall_score，也绝不可标为 critical。

你审 12 条结构类雷点：开篇拖沓/平淡、世界观模糊脱现实、人设矛盾、视角杂乱、主线偏离/停滞、冲突乏力爽点缺失、节奏失控过渡生硬、人设前后矛盾、人物单薄无反差、情感表达生硬/关系突兀、金手指失衡、设定无落地。同时保留工程维度（OOC、timeline 一致、信息越界、hook-debt、跨章重复、词汇疲劳、章节字数、标题疲劳、段落形状）。

稀疏 memo 是合法状态。喘息章 / 后效章 / 过渡章的 memo 可以只有 goal + 骨架 body——此类 memo 不判 incomplete，也不能因为 memo 没写的段落就扣成稿的分。只按 memo 实际写出来的内容判偏离。

如果章节备忘、规则栈或输入上下文明确指定多条剧情线的比例（权谋/感情、事业/恋爱、案件/人物等），要审它们是否真正落成了场景、对话、行动或关系变化。只用一句总结带过的线，视为缺失。只有当 memo 明确要求本章必须推进该线时，才标 critical。

每条 issue 必须给 repair_scope 作为 typed 路由提示："local" 表示措辞、段落形状、小重复、句段级小修；"structural" 表示主线偏离、时间线断裂、场面/回报缺失、人物逻辑崩、视角/信息边界失败，或任何需要重写场景/整章的问题；只有确实无法判断时才写 "unknown"。

审查维度：
${dimList}

输出格式必须为 JSON：
{
  "passed": true/false,
  "creative_passed": true/false,
  "research_status": "not-applicable|not-checked|needs-research|verified|conflict",
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "track": "creative|research",
	      "category": "审查维度名称",
	      "description": "具体问题描述",
	      "suggestion": "修改建议"
	    }
  ],
  "summary": "一句话总结审查结论"
}

只有 creative track 存在 critical 级别问题时，passed 与 creative_passed 才为 false。research track 不得判创作失败。

overall_score 评分校准：
- 95-100：可直接发布，无明显问题
- 85-94：有小瑕疵但整体流畅可读，读者不会出戏
- 75-84：有明显问题但故事主干完整，需要修但不紧急
- 65-74：多处影响阅读体验的问题，节奏或连续性有断裂
- < 65：结构性问题，需要大幅重写
综合评分，不要因为单一小问题大幅拉低分数。`;
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.auditor");

    const ledgerBlock = gp.numericalSystem
      ? resolvedLanguage === "ko"
        ? `\n## 자원 장부\n${ledger}`
        : isEnglish
        ? `\n## Resource Ledger\n${ledger}`
        : `\n## 资源账本\n${ledger}`
      : "";

    // Smart context filtering for auditor — same logic as writer
    const bookRulesForFilter = parsedRules?.rules ?? null;
    const filteredSubplots = filterSubplots(subplotBoard);
    const filteredArcs = filterEmotionalArcs(emotionalArcs, chapterNumber);
    const filteredMatrix = filterCharacterMatrix(characterMatrix, volumeOutline, bookRulesForFilter?.protagonist?.name);
    const filteredSummaries = filterSummaries(chapterSummaries, chapterNumber);
    const filteredHooks = filterHooks(hooks);

    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;

    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? (filteredHooks !== "(文件不存在)"
        ? resolvedLanguage === "ko"
          ? `\n## 복선 목록\n${filteredHooks}\n`
          : isEnglish
          ? `\n## Pending Hooks\n${filteredHooks}\n`
          : `\n## 伏笔池\n${filteredHooks}\n`
        : "");
    const subplotBlock = filteredSubplots !== "(文件不存在)"
      ? resolvedLanguage === "ko"
        ? `\n## 보조 사건선\n${filteredSubplots}\n`
        : isEnglish
        ? `\n## Subplot Board\n${filteredSubplots}\n`
        : `\n## 支线进度板\n${filteredSubplots}\n`
      : "";
    const emotionalBlock = filteredArcs !== "(文件不存在)"
      ? resolvedLanguage === "ko"
        ? `\n## 감정선\n${filteredArcs}\n`
        : isEnglish
        ? `\n## Emotional Arcs\n${filteredArcs}\n`
        : `\n## 情感弧线\n${filteredArcs}\n`
      : "";
    const matrixBlock = filteredMatrix !== "(文件不存在)"
      ? resolvedLanguage === "ko"
        ? `\n## 인물 관계와 상호작용\n${filteredMatrix}\n`
        : isEnglish
        ? `\n## Character Interaction Matrix\n${filteredMatrix}\n`
        : `\n## 角色交互矩阵\n${filteredMatrix}\n`
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (filteredSummaries !== "(文件不存在)"
        ? resolvedLanguage === "ko"
          ? `\n## 최근 회차 요약(완급 확인용)\n${filteredSummaries}\n`
          : isEnglish
          ? `\n## Chapter Summaries (for pacing checks)\n${filteredSummaries}\n`
          : `\n## 章节摘要（用于节奏检查）\n${filteredSummaries}\n`
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const canonBlock = hasParentCanon
      ? resolvedLanguage === "ko"
        ? `\n## 본편 정본(외전 감리용)\n${parentCanon}\n`
        : isEnglish
        ? `\n## Mainline Canon Reference (for spinoff audit)\n${parentCanon}\n`
        : `\n## 正传正典参照（番外审查专用）\n${parentCanon}\n`
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? resolvedLanguage === "ko"
        ? `\n## 원작 정본(팬픽 감리용)\n${fanficCanon}\n`
        : isEnglish
        ? `\n## Fanfic Canon Reference (for fanfic audit)\n${fanficCanon}\n`
        : `\n## 同人正典参照（同人审查专用）\n${fanficCanon}\n`
      : "";

    const memoBlock = options?.chapterMemo
      ? resolvedLanguage === "ko"
        ? `\n## 회차 메모(이탈 확인용)\n목표: ${options.chapterMemo.goal}\n\n${options.chapterMemo.body}\n`
        : isEnglish
        ? `\n## Chapter Memo (for memo drift checks)\nGoal: ${options.chapterMemo.goal}\n\n${options.chapterMemo.body}\n`
        : `\n## 章节备忘（用于 memo 偏离检测）\ngoal：${options.chapterMemo.goal}\n\n${options.chapterMemo.body}\n`
      : "";
    const arcContextBlock = options?.arcContext?.trim()
      ? resolvedLanguage === "ko"
        ? `\n## 아크 계획 스냅샷(하위 제약·회차 이탈 확인용)\n${options.arcContext.trim()}\n`
        : isEnglish
        ? `\n## Arc Plan Snapshot (subordinate; check chapter drift)\n${options.arcContext.trim()}\n`
        : `\n## Arc 计划快照（从属约束；检查本章偏离）\n${options.arcContext.trim()}\n`
      : "";
    const reducedControlBlock = options?.chapterIntent && options.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterIntent, options.contextPackage, options.ruleStack, resolvedLanguage)
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? resolvedLanguage === "ko"
        ? `\n## 문체 지침\n${styleGuide}\n`
        : isEnglish
        ? `\n## Style Guide\n${styleGuide}`
        : `\n## 文风指南\n${styleGuide}`
      : "";

    const prevChapterBlock = previousChapter
      ? resolvedLanguage === "ko"
        ? `\n## 직전 회차 전문(연결 확인용)\n${previousChapter}\n`
        : isEnglish
        ? `\n## Previous Chapter Full Text (for transition checks)\n${previousChapter}\n`
        : `\n## 上一章全文（用于衔接检查）\n${previousChapter}\n`
      : "";

    const userPrompt = resolvedLanguage === "ko"
      ? `제${chapterNumber}화를 감리하세요.

## 현재 상태
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${arcContextBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## 감리할 원고
${chapterContent}`
      : isEnglish
      ? `Review chapter ${chapterNumber}.

## Current State Card
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${arcContextBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## Chapter Content Under Review
${chapterContent}`
      : `请审查第${chapterNumber}章。

## 当前状态卡
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${arcContextBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## 待审章节内容
${chapterContent}`;

    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const chatOptions = { temperature: options?.temperature ?? 0.3 };

    // Auditing is deterministic over supplied evidence. Explicit research is
    // collected separately through research_web and then attached as context.
    const response = await this.chat(chatMessages, chatOptions);

    const result = normalizeSeparatedAuditResult(
      this.parseAuditResult(response.content, resolvedLanguage),
      {
        researchExpected: Boolean(gp.eraResearch || bookRules?.eraConstraints?.enabled || futureAdvantageActive),
        futureAdvantageActive,
      },
    );
    return { ...result, tokenUsage: response.usage };
  }

  private parseAuditResult(content: string, language: PromptLanguage): AuditResult {
    // Try multiple JSON extraction strategies (handles small/local models)

    // Strategy 1: Find balanced JSON object (not greedy)
    const balanced = this.extractBalancedJson(content);
    if (balanced) {
      const result = this.tryParseAuditJson(balanced, language);
      if (result) return result;
    }

    // Strategy 2: Try the whole content as JSON (some models output pure JSON)
    const trimmed = content.trim();
    if (trimmed.startsWith("{")) {
      const result = this.tryParseAuditJson(trimmed, language);
      if (result) return result;
    }

    // Strategy 3: Look for ```json code blocks
    const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      const result = this.tryParseAuditJson(codeBlockMatch[1]!.trim(), language);
      if (result) return result;
    }

    // Strategy 4: Try to extract individual fields via regex (last resort fallback)
    const passedMatch = content.match(/"passed"\s*:\s*(true|false)/);
    const issuesMatch = content.match(/"issues"\s*:\s*\[([\s\S]*?)\]/);
    const summaryMatch = content.match(/"summary"\s*:\s*"([^"]*)"/);
    if (passedMatch) {
      const issues: AuditIssue[] = [];
      if (issuesMatch) {
        // Try to parse individual issue objects
        const issuePattern = /\{[^{}]*"severity"\s*:\s*"[^"]*"[^{}]*\}/g;
        let match: RegExpExecArray | null;
        while ((match = issuePattern.exec(issuesMatch[1]!)) !== null) {
          try {
            const issue = JSON.parse(match[0]);
	            issues.push({
	              severity: issue.severity ?? "warning",
	              category: issue.category ?? (language === "ko" ? "미분류" : language === "en" ? "Uncategorized" : "未分类"),
	              description: issue.description ?? "",
	              suggestion: issue.suggestion ?? "",
	              repairScope: normalizeRepairScope(issue.repair_scope ?? issue.repairScope),
	              track: issue.track === "research" ? "research" : issue.track === "creative" ? "creative" : undefined,
	            });
          } catch {
            // skip malformed individual issue
          }
        }
      }
      return {
        passed: passedMatch[1] === "true",
        creativePassed: passedMatch[1] === "true",
        researchStatus: normalizeResearchStatus(content.match(/"research_status"\s*:\s*"([^"]+)"/)?.[1]),
        issues,
        summary: summaryMatch?.[1] ?? "",
      };
    }

    return {
      passed: false,
      parseFailed: true,
      creativePassed: false,
      researchStatus: "not-checked",
      issues: [{
        severity: "critical",
        category: language === "ko" ? "시스템 오류" : language === "en" ? "System Error" : "系统错误",
        description: language === "ko"
          ? "감리 출력 형식이 잘못되어 JSON으로 해석할 수 없습니다."
          : language === "en"
            ? "Audit output format was invalid and could not be parsed as JSON."
            : "审稿输出格式异常，无法解析为 JSON",
        suggestion: language === "ko"
          ? "구조화 출력을 안정적으로 지원하는 더 강한 모델을 사용하거나 API 응답 형식을 확인하세요."
          : language === "en"
            ? "The model may not support reliable structured output. Try a stronger model or inspect the API response format."
            : "可能是模型不支持结构化输出。尝试换一个更大的模型，或检查 API 返回格式。",
      }],
      summary: language === "ko" ? "감리 출력 해석 실패" : language === "en" ? "Audit output parsing failed" : "审稿输出解析失败",
    };
  }

  private buildReducedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: PromptLanguage,
  ): string {
    const selectedContext = contextPackage.selectedContext
      .map((entry) => `- ${entry.source}: ${entry.reason}${entry.excerpt ? ` | ${entry.excerpt}` : ""}`)
      .join("\n");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : "- none";

    return language !== "zh"
      ? `\n## Chapter Control Inputs (compiled by Planner/Composer)
${chapterIntent}

### Selected Context
${selectedContext || "- none"}

### Rule Stack
- Hard guardrails: ${ruleStack.sections.hard.join(", ") || "(none)"}
- Soft constraints: ${ruleStack.sections.soft.join(", ") || "(none)"}
- Diagnostic rules: ${ruleStack.sections.diagnostic.join(", ") || "(none)"}

### Active Overrides
${overrides}\n`
      : `\n## 本章控制输入（由 Planner/Composer 编译）
${chapterIntent}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }

  private extractBalancedJson(text: string): string | null {
    const start = text.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }

  private tryParseAuditJson(json: string, language: PromptLanguage = "zh"): AuditResult | null {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.passed !== "boolean" && parsed.passed !== undefined) return null;
      const rawScore = parsed.overall_score ?? parsed.overallScore;
      const overallScore = typeof rawScore === "number" && Number.isFinite(rawScore)
        ? Math.round(Math.max(0, Math.min(100, rawScore)))
        : undefined;
      return {
        passed: Boolean(parsed.passed ?? false),
        creativePassed: typeof parsed.creative_passed === "boolean"
          ? parsed.creative_passed
          : Boolean(parsed.passed ?? false),
        researchStatus: normalizeResearchStatus(parsed.research_status ?? parsed.researchStatus),
        issues: Array.isArray(parsed.issues)
	          ? parsed.issues.map((i: Record<string, unknown>) => ({
	              severity: (i.severity as string) ?? "warning",
	              category: (i.category as string) ?? (language === "ko" ? "미분류" : language === "en" ? "Uncategorized" : "未分类"),
	              description: (i.description as string) ?? "",
	              suggestion: (i.suggestion as string) ?? "",
	              repairScope: normalizeRepairScope(i.repair_scope ?? i.repairScope),
	              track: i.track === "research" ? "research" : i.track === "creative" ? "creative" : undefined,
	            }))
          : [],
        summary: String(parsed.summary ?? ""),
        overallScore,
      };
    } catch {
      return null;
    }
  }

  private async loadPreviousChapter(bookDir: string, currentChapter: number): Promise<string> {
    if (currentChapter <= 1) return "";
    const chaptersDir = join(bookDir, "chapters");
    try {
      const files = await readdir(chaptersDir);
      const paddedPrev = String(currentChapter - 1).padStart(4, "0");
      const prevFile = files.find((f) => f.startsWith(paddedPrev) && f.endsWith(".md"));
      if (!prevFile) return "";
      return await readFile(join(chaptersDir, prevFile), "utf-8");
    } catch {
      return "";
    }
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }
}
