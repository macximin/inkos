import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { FanficMode } from "../models/book.js";
import type { ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage } from "./rules-reader.js";
import {
  projectRuleStackToVerifiedBookRules,
  readEffectiveBookRules,
} from "./effective-book-rules.js";
import {
  findUnauthorizedMandatoryMoralCorrectionsInNarrativeEvidence,
  type ArchitectMoralAuthoritySource,
} from "./architect.js";
import { assertProductionContextMoralAuthority } from "./writer.js";
import { getFanficDimensionConfig, FANFIC_DIMENSIONS } from "./fanfic-dimensions.js";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { filterHooks, filterSummaries, filterSubplots, filterEmotionalArcs, filterCharacterMatrix } from "../utils/context-filter.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { sanitizeLegacyFunFirstMethodology } from "../utils/writing-methodology.js";
import {
  readVolumeMap,
  readStoryFrame,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";
import { join } from "node:path";
import {
  FutureAdvantageExecutionCandidateSchema,
  validateFutureAdvantageExecutionCandidate,
  type FutureAdvantageExecutionCandidate,
} from "../models/future-advantage-ledger.js";

export interface AuditResult {
  readonly passed: boolean;
  /** Creative/structural pass, kept separate from real-world verification. */
  readonly creativePassed?: boolean;
  /** Real-world verification state. This never fails creative review by itself. */
  readonly researchStatus?: ResearchStatus;
  /** Body-quoted execution evidence; still non-canon until human approval. */
  readonly futureAdvantageExecution?: FutureAdvantageExecutionCandidate;
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
  /** Typed auditor dimension. Host validation never trusts a category label alone. */
  readonly dimensionId?: number;
  /** Stable name of the supplied evidence section (for example `current-state`). */
  readonly evidenceSource?: string;
  /** Exact, verbatim substring copied from the supplied canonical context. */
  readonly evidenceQuote?: string;
  /** Exact, verbatim substring from the chapter proving the present contradiction. */
  readonly chapterQuote?: string;
  /** Optional hard-rule identifier emitted by provenance-aware rule compilers. */
  readonly ruleId?: string;
  /** False when the host rejected the issue as non-actionable evidence or content policing. */
  readonly revisionEligible?: boolean;
  /** Host-only gate for automatic prose mutation; model output cannot opt itself in. */
  readonly automaticRevisionEligible?: boolean;
  /** True when the host neutralized a publication/morality objection, not a story defect. */
  readonly contentNeutralized?: boolean;
}

export type ResearchStatus = "not-applicable" | "not-checked" | "needs-research" | "verified" | "conflict";

export interface SanitizedLegacyCurrentState {
  readonly text: string;
  readonly removed: ReadonlyArray<string>;
}

/**
 * Legacy Books may contain model-written control instructions inside
 * current_state.md. Keep ordinary state facts and clearly attributed
 * fictional speech/belief, but withhold any line that still carries an
 * unauthorized moral/representation mandate before it reaches the auditor.
 * This is a read-time projection only; the canonical file is never rewritten.
 */
export function sanitizeLegacyCurrentStateForAudit(
  text: string,
  authoritySources: ReadonlyArray<ArchitectMoralAuthoritySource>,
): SanitizedLegacyCurrentState {
  const removed = new Set<string>();
  const kept = segmentLegacyCurrentState(text).flatMap((segment) => {
    const findings = findUnauthorizedMandatoryMoralCorrectionsInNarrativeEvidence(
      segment.join(" "),
      authoritySources,
    );
    for (const finding of findings) removed.add(finding);
    return findings.length === 0 ? segment : [];
  });
  const sanitized = kept.join("\n").trim();
  return {
    text: sanitized || "(legacy current state withheld: unauthorized control text)",
    removed: [...removed],
  };
}

/** Group wrapped Markdown records so line wrapping cannot split obligation from target. */
function segmentLegacyCurrentState(text: string): ReadonlyArray<ReadonlyArray<string>> {
  const lines = text.split("\n");
  const segments: string[][] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim() || isStandaloneLegacyStateLine(line)) {
      segments.push([line]);
      index += 1;
      continue;
    }

    const segment = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (!next.trim() || isStandaloneLegacyStateLine(next) || startsLegacyStateRecord(next)) {
        break;
      }
      segment.push(next);
      index += 1;
    }
    segments.push(segment);
  }
  return segments;
}

function isStandaloneLegacyStateLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/u.test(line) || /^\s*\|/u.test(line);
}

function startsLegacyStateRecord(line: string): boolean {
  return /^\s*(?:[-*+]\s+|\d{1,4}[.)]\s+)/u.test(line);
}

export function isAutomaticRevisionIssue(issue: AuditIssue): boolean {
  // Automatic prose repair is reserved for reader-trust failures. Warnings
  // remain visible editorial advice; promoting them to blockers makes style
  // heuristics silently rewrite otherwise effective scenes.
  return issue.track !== "research"
    && issue.revisionEligible !== false
    && issue.automaticRevisionEligible === true
    && !issue.contentNeutralized
    && issue.severity === "critical";
}

/** Issues an editor may address after an explicit manual revision request. */
export function isRevisionCandidateIssue(issue: AuditIssue): boolean {
  return issue.track !== "research"
    && issue.revisionEligible !== false
    && !issue.contentNeutralized
    && issue.severity !== "info";
}

type PromptLanguage = "zh" | "ko" | "en";

function buildAuditParseFailureIssue(language: PromptLanguage): AuditIssue {
  return {
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
  };
}

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

function normalizeDimensionId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inferIssueTrack(issue: AuditIssue): "creative" | "research" {
  // A host-recognized research *category* wins over an LLM-supplied track so
  // unverified historical claims cannot become prose-rewrite commands. Do not
  // route on a bare word in the description: "research report" can be the
  // object of a real information-boundary violation.
  if (/Era Accuracy|年代考据|시대 고증|고증|research(?: verification| accuracy| claim)?|fact.?check|事实核查/i.test(issue.category)) {
    return "research";
  }
  if (issue.track) return issue.track;
  if (/needs? (?:external )?(?:research|verification)|requires? fact.?check|추가 (?:조사|검증)|별도 (?:조사|검증)|需要(?:研究|核查)|事实核查/i.test(issue.description)) {
    return "research";
  }
  return "creative";
}

interface CanonicalEvidenceSource {
  readonly selector: string;
  readonly content: string;
}

const CONTENT_POLICY_CATEGORY = /(?:sensitive(?: content| words?)?|publication(?: compatibility)?|platform (?:policy|compliance)|content (?:policy|moderation)|safety|ethic(?:s|al)?|moral(?:ity| acceptability)?|representation|diversity|political correctness|appropriateness|offensive content|harmful content|민감(?:어| 표현| 콘텐츠)?|공개 호환성|플랫폼 (?:정책|검수)|콘텐츠 (?:정책|검열)|안전|윤리|도덕|대표성|다양성|정치적 올바름|유해 콘텐츠|부적절성|敏感(?:词|内容)?|发布兼容|平台(?:政策|审核)|内容(?:政策|审核)|安全|伦理|道德|代表性|多样性|政治正确|有害内容|不当内容)/i;
const CONTENT_ACCEPTABILITY_OBJECTION = /(?:immoral|unethical|problematic|offensive|inappropriate|harmful depiction|glorif(?:y|ies|ication)|normaliz(?:e|es|ation)|condemn|denounce|must (?:be )?punish|needs? (?:to )?(?:be )?punish|show remorse|feel guilt|apologi[sz]e|redeem|rehabilitat|learn (?:a |the )?lesson|pay (?:a |the )?(?:moral )?(?:price|cost)|deserves? punishment|도덕적|비윤리|문제적|불쾌|부적절|유해한 묘사|미화|정당화|규탄|비난|처벌해야|벌을 받아|반성해야|죄책감을 느껴|사과해야|속죄|갱생|교훈을 얻|대가를 치러야|道德上|不道德|不伦理|有问题|冒犯|不当|有害描写|美化|合理化|谴责|批判|必须惩罚|应受惩罚|悔过|内疚|道歉|赎罪|改造|吸取教训|付出道德代价)/i;
const ROLE_OR_REPRESENTATION_OBJECTION = /(?:marriage reward|romantic reward|love interest only|victim only|exposition (?:device|source)|exists only to|balanced demographic|lack(?:s|ing)? representation|independent role|agency because (?:she|he|they)|여성 보상|결혼 보상|연애 보상|피해자 역할|설명 도구|도구적 역할|대표성 부족|인구학적 균형|독립적 역할|婚姻奖励|恋爱奖励|受害者角色|说明工具|工具人|代表性不足|人口平衡|独立角色)/i;
const CONCRETE_CAUSAL_MECHANISM = /(?:causal (?:chain|continuity|logic)|timeline|information boundary|canon (?:conflict|contradiction)|established (?:fact|state|rule)|witness(?:es)?|evidence trail|police|law enforcement|investigat(?:e|ion)|security footage|alarm|cover.?up|retaliat(?:e|ion)|victim response|faction response|physical impossibility|travel time|resource ledger|incentive chain|인과(?:관계| 사슬| 단절| 붕괴)|시간선|정보 경계|정본 (?:모순|충돌)|목격자|증거|경찰|수사|보안 영상|경보|은폐|보복|피해자 반응|세력 반응|물리적 불가능|이동 시간|자원 장부|이익 사슬|因果(?:链|连续性|逻辑|断裂)|时间线|信息边界|正典(?:冲突|矛盾)|目击者|证据链|警察|执法|调查|监控录像|警报|掩盖|报复|受害者反应|势力反应|物理上不可能|行程时间|资源账本|利益链)/i;
const CAUSAL_FAILURE_LANGUAGE = /(?:break|collapse|contradict|impossible|without (?:any )?(?:cause|reason|response|explanation)|no (?:response|investigation|cover.?up|reaction)|missing (?:response|step|cause|mechanism)|ignores? (?:the )?(?:evidence|witness|timeline|rule)|무너|붕괴|단절|모순|불가능|이유 없이|반응이 없|수사가 없|은폐 없이|설명 없이|단계가 빠|증거를 무시|목격자를 무시|시간선을 무시|崩塌|断裂|矛盾|不可能|无因|没有(?:回应|调查|掩盖|反应|解释)|缺少(?:回应|步骤|原因|机制)|无视(?:证据|目击者|时间线|规则))/i;

function hasExactCanonicalQuote(
  issue: AuditIssue,
  sources: ReadonlyArray<CanonicalEvidenceSource>,
): boolean {
  const quote = issue.evidenceQuote;
  if (!quote || quote.trim().length < 8) return false;
  const selectedSources = issue.evidenceSource
    ? sources.filter((source) => source.selector === issue.evidenceSource)
    : sources;
  return selectedSources.some((source) => source.content.includes(quote));
}

function hasVerifiedHardRuleEvidence(
  issue: AuditIssue,
  hardRuleRefs: RuleStack["ruleRefs"],
  sources: ReadonlyArray<CanonicalEvidenceSource>,
): boolean {
  if (
    !issue.ruleId
    || issue.evidenceSource !== "rule-stack-hard"
    || !hasExactCanonicalQuote(issue, sources)
  ) {
    return false;
  }
  const quote = issue.evidenceQuote!;
  const verifiedRef = hardRuleRefs?.find((ref) => ref.ruleId === issue.ruleId && ref.strength === "hard");
  if (!verifiedRef) return false;
  return quote === verifiedRef.text
    && createHash("sha256").update(verifiedRef.text, "utf8").digest("hex") === verifiedRef.textSha256;
}

function isConcreteCausalViolation(issue: AuditIssue): boolean {
  const text = `${issue.category} ${issue.description} ${issue.suggestion}`;
  return CONCRETE_CAUSAL_MECHANISM.test(text) && CAUSAL_FAILURE_LANGUAGE.test(text);
}

function hasConcreteCausalViolationEvidence(
  issue: AuditIssue,
  sources: ReadonlyArray<CanonicalEvidenceSource>,
  chapterContent: string,
): boolean {
  if (
    !isConcreteCausalViolation(issue)
    || !issue.evidenceSource
    || !issue.evidenceQuote
    || !issue.chapterQuote
    || issue.evidenceQuote.trim().length < 8
    || issue.chapterQuote.trim().length < 8
  ) {
    return false;
  }
  const source = sources.find((candidate) => candidate.selector === issue.evidenceSource);
  return Boolean(
    source?.content.includes(issue.evidenceQuote)
    && chapterContent.includes(issue.chapterQuote),
  );
}

function isDimension14Finding(issue: AuditIssue): boolean {
  if (issue.dimensionId === 14 || SIDE_CHARACTER_AGENCY_CATEGORY.test(issue.category)) return true;
  const text = `${issue.category} ${issue.description}`;
  return /(?:side|supporting|secondary) character|조연|配角/i.test(text)
    && CHARACTER_CAUSAL_INPUT.test(text);
}

function isContentAcceptabilityObjection(
  issue: AuditIssue,
  sources: ReadonlyArray<CanonicalEvidenceSource>,
  chapterContent: string,
): boolean {
  const text = `${issue.category} ${issue.description} ${issue.suggestion}`;
  const policyCategory = issue.dimensionId === 27 || CONTENT_POLICY_CATEGORY.test(issue.category);
  const acceptabilityText = CONTENT_ACCEPTABILITY_OBJECTION.test(text)
    || ROLE_OR_REPRESENTATION_OBJECTION.test(text);
  // Dimension 27 is publication metadata only. Even an evidence-shaped causal
  // claim must be re-emitted under the actual structural dimension before it
  // may affect creative pass/revision; otherwise policy wording can launder a
  // morality objection into an automatic rewrite.
  if (policyCategory) return true;
  return acceptabilityText
    && !hasConcreteCausalViolationEvidence(issue, sources, chapterContent);
}

function normalizeOverallScoreAfterHostRejection(
  score: number | undefined,
  issues: ReadonlyArray<AuditIssue>,
): number | undefined {
  if (score === undefined) return undefined;
  if (!issues.some((issue) => issue.revisionEligible === false || issue.contentNeutralized)) {
    return score;
  }

  const actionable = issues.filter(isRevisionCandidateIssue);
  if (actionable.some((issue) => issue.severity === "critical")) return score;
  const floor = actionable.some((issue) => issue.severity === "warning") ? 75 : 85;
  return Math.max(score, floor);
}

function normalizeSeparatedAuditResult(
  result: AuditResult,
  options: {
    readonly researchExpected: boolean;
    readonly futureAdvantageActive: boolean;
    readonly futureAdvantageMoveId?: string;
    readonly chapterContent: string;
    readonly canonicalEvidenceSources: ReadonlyArray<CanonicalEvidenceSource>;
    readonly hardRuleEvidenceSources: ReadonlyArray<CanonicalEvidenceSource>;
    readonly hardRuleRefs: RuleStack["ruleRefs"];
  },
): AuditResult {
  const issues = result.issues.map((rawIssue) => {
    const track = inferIssueTrack(rawIssue);
    const verifiedHardRule = hasVerifiedHardRuleEvidence(
      rawIssue,
      options.hardRuleRefs,
      options.hardRuleEvidenceSources,
    );
    let severity = verifiedHardRule
      ? rawIssue.severity
      : normalizeSideCharacterAgencySeverity(rawIssue);
    const text = `${rawIssue.category} ${rawIssue.description}`;
    let revisionEligible = rawIssue.revisionEligible;
    let contentNeutralized = rawIssue.contentNeutralized;
    // A free-form model finding may remain useful for human/editorial review,
    // but it cannot authorize an automatic manuscript mutation. Exact,
    // provenance-verified hard BookRules are the only LLM-audit route that the
    // host opts into here. Deterministic validators run outside this normalizer.
    // LLM findings never authorize an automatic manuscript mutation. Even an
    // exact hard-rule quote proves the rule's authority, not that the quoted
    // chapter passage violates its predicate. Verified hard-rule findings stay
    // critical/manual candidates; deterministic host validators opt in below
    // this layer by setting automaticRevisionEligible=true themselves.
    let automaticRevisionEligible = false;

    if (
      isContentAcceptabilityObjection(
        rawIssue,
        options.canonicalEvidenceSources,
        options.chapterContent,
      )
      && !verifiedHardRule
    ) {
      severity = "info";
      revisionEligible = false;
      contentNeutralized = true;
      automaticRevisionEligible = false;
    } else if (
      rawIssue.severity === "critical"
      && isDimension14Finding(rawIssue)
      && severity !== "critical"
    ) {
      // Unsupported canon claims remain visible as an auditor-quality warning,
      // but must not enter either automatic or manual manuscript revision.
      revisionEligible = false;
      automaticRevisionEligible = false;
    }

    // Missing or disputed research is a verification state, not a prose-repair
    // command. Critical future-advantage findings remain possible only for an
    // actual forbidden shortcut, information-boundary breach, or canon conflict.
    if (track === "research") {
      severity = "info";
      automaticRevisionEligible = false;
    }
    if (
      options.futureAdvantageActive
      && severity === "critical"
      && /future advantage|未来先机|미래 선점|회귀 지식/i.test(text)
      && !/forbidden shortcut|금지된 지름길|禁止.*捷径|information boundary|정보 경계|信息越界|canon conflict|정본 모순|正典.*冲突/i.test(text)
    ) {
      severity = "warning";
    }
    return {
      ...rawIssue,
      severity,
      track,
      revisionEligible,
      automaticRevisionEligible,
      contentNeutralized,
    };
  });
  const creativePassed = !result.parseFailed
    && !issues.some(isAutomaticRevisionIssue);
  const researchIssues = issues.filter((issue) => issue.track === "research");
  const inferredResearchStatus: ResearchStatus = !options.researchExpected
    ? "not-applicable"
    : researchIssues.some((issue) => /conflict|contradict|충돌|모순|冲突/i.test(`${issue.category} ${issue.description}`))
      ? "conflict"
      : researchIssues.length > 0
        ? "needs-research"
        : "not-checked";
  const futureAdvantageExecution = options.futureAdvantageMoveId && result.futureAdvantageExecution
    ? validateFutureAdvantageExecutionCandidate({
        candidate: result.futureAdvantageExecution,
        moveId: options.futureAdvantageMoveId,
        chapterContent: options.chapterContent,
      })
    : undefined;
  return {
    ...result,
    passed: creativePassed,
    creativePassed,
    researchStatus: researchIssues.length > 0
      ? inferredResearchStatus
      : (result.researchStatus ?? inferredResearchStatus),
    issues,
    overallScore: normalizeOverallScoreAfterHostRejection(result.overallScore, issues),
    futureAdvantageExecution,
  };
}

function parseFutureAdvantageMoveId(arcContext: string | undefined): string | undefined {
  return arcContext?.match(/^\s*-\s*Move:\s*(.+?)\s*$/m)?.[1]?.trim();
}

function parseFutureAdvantageExecution(value: unknown): FutureAdvantageExecutionCandidate | undefined {
  const parsed = FutureAdvantageExecutionCandidateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
  14: { zh: "配角能动性与能力一致性", en: "Side Character Agency/Competence Check" },
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

const SIDE_CHARACTER_AGENCY_CATEGORY = /(?:Side Character (?:Agency(?: and |\/)Competence|Instrumentalization)(?: Check)?|配角(?:能动性与能力一致性|工具人化)|조연 (?:능동성|도구화))/i;
const CHARACTER_CAUSAL_INPUT = /(?:desire|goal|motive|objective|information|knowledge|competence|ability|skill|expertise|욕망|목표|동기|의도|정보|지식|능력|역량|欲望|目标|动机|意图|信息|知识|能力)/i;

function normalizeSideCharacterAgencySeverity(
  issue: AuditIssue,
): AuditIssue["severity"] {
  if (issue.severity !== "critical" || !isDimension14Finding(issue)) {
    return issue.severity;
  }
  // Free-form natural-language quotes can prove that two strings exist, but
  // not that their predicates are logically incompatible. Until InkOS has
  // typed, receipt-bound character facts, dimension 14 remains advisory. A
  // provenance-verified hard BookRule bypasses this function at the caller.
  return "warning";
}

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

  if (id === 12 && bookRules?.eraConstraints) {
    const era = bookRules.eraConstraints;
    const parts = [era.period, era.region].filter(Boolean);
    if (parts.length > 0) {
      return language !== "zh"
        ? `Era: ${parts.join(", ")}`
        : `年代：${parts.join("，")}`;
    }
  }

  if (id === 14) {
    if (language === "ko") {
      return "조연의 성별, 정체성, 대표성, 호감도나 도덕성, 연애·악역·피해자·보상·설명 역할 자체는 결함이 아니며 overall_score를 낮추는 근거로도 쓰지 않습니다. 자유형 인용만으로는 논리적 모순을 증명할 수 없으므로 이 차원은 warning이 상한입니다. critical은 별도의 검증된 하드 BookRules 위반으로만 허용합니다. chapter_memo·chapter-control·arc-plan은 그 증명이 될 수 없습니다. 충분한 동기나 압력이 있다면 조연은 비합리적으로 행동하거나 굴복·배신·패배하고 범죄를 저지를 수도 있습니다.";
    }
    return language === "en"
      ? "A side character's gender, identity, representation, likability, morality, or role as a love interest, villain, victim, reward, or exposition source is not a defect and must not lower overall_score. Free-form quotes cannot prove logical predicate incompatibility, so warning is the maximum in this dimension. Critical is allowed only as a separate provenance-verified hard BookRule violation. chapter_memo, chapter-control, and arc-plan cannot prove that rule. Supported pressure or motive may lead a side character to act irrationally, submit, betray, lose, or commit a crime."
      : "配角的性别、身份、代表性、讨喜程度、道德立场，或其恋爱对象、反派、受害者、奖励、说明者等剧情功能本身都不是缺陷，也不得据此降低 overall_score。自由文本引文不能证明谓词在逻辑上互斥，因此本维度最高只能记 warning；critical 只允许作为另一条已验证硬 BookRule 的违规来报告。chapter_memo、chapter-control、arc-plan 不能证明该规则。有充分压力或动机时，配角可以失去理性、屈服、背叛、失败或犯罪。";
  }

  if (id === 27) {
    if (language === "ko") {
      return "공개 플랫폼 호환성 메타데이터만 기록합니다. 허구의 범죄·폭력·비도덕성·불쾌함 자체는 창작 결함이 아니며 severity=info만 허용합니다. 구체적인 인과·시간선·정보 경계·검증된 하드 규칙 위반은 해당 구조 차원으로 별도 보고하세요.";
    }
    return language === "en"
      ? "Publication-platform compatibility metadata only. Fictional crime, violence, immorality, or offensiveness is not a creative defect and may only be logged as info here. Report concrete causality, timeline, information-boundary, or verified hard-rule violations under their structural dimension instead."
      : "这里只记录发布平台兼容性元数据。虚构犯罪、暴力、不道德或冒犯本身不是创作缺陷，在此维度最多只能记 info。具体的因果、时间线、信息边界或已验证硬规则违规，应改在对应结构维度报告。";
  }

  // v10: Enhanced dimension notes with writing methodology awareness
  if (id === 7) {
    if (language === "ko") {
      return "최근 3~5화를 통과 할당량이 아니라 진단 구간으로 봅니다. 목표 변화, 지급, 후과가 전혀 없어 실제로 평평해진 경우만 리듬 정체로 표시하세요. 깨끗한 결산과 필요한 후일담은 합법입니다. 직전 화가 절정이나 큰 반전이었다면 관계, 지위, 비용 같은 변화가 먼저 착지했는지 확인하세요. 일상/전환 장면은 감정, 관계, 정보, 선택, 지급, 후과 가운데 하나를 실제로 바꾸면 충분하며 새 훅이나 다음 주기를 만들 의무는 없습니다.";
    }
    return language === "en"
      ? "Use the recent 3-5 chapters as a diagnostic window, not a pass/fail quota. Flag pacing stagnation only when a run has no recognizable goal movement, payoff, or consequence and genuinely feels flat; clean closure and necessary aftermath are legitimate. If the previous chapter was a climax or major reversal, check that relationships, status, or costs land before a new build-up. A quiet/transition scene earns its place by changing emotion, relationship, information, choice, payoff, or consequence; it need not plant a hook or start the next cycle."
      : "把最近 3-5 章当作诊断窗口，不是通过配额。只有一段连续章节没有可辨认的目标变化、兑现或后果并且确实发平时，才标记节奏停滞；完整收束和必要后效都合法。如果上一章是高潮或大反转，检查关系、地位、代价等改变是否先落地。日常/过渡段落只要实际改变情绪、关系、信息、选择、兑现或后果就成立，不必埋新伏笔或启动下一轮。";
  }

  if (id === 15) {
    const base = gp.satisfactionTypes.length > 0
      ? (language === "ko"
          ? `장르 보상 후보: ${gp.satisfactionTypes.join(", ")}. `
          : language === "en"
            ? `Payoff candidates: ${gp.satisfactionTypes.join(", ")}. `
            : `爽点候选：${gp.satisfactionTypes.join("、")}。`)
      : "";
    if (language === "ko") {
      return `${base}이번 화의 의도에 맞는 독자 가치를 확인하세요. 가시적 지급뿐 아니라 목표 전진, 후과, 관계·감정의 변화, 선택, 쓸모 있는 정보도 성립합니다. 완전히 수습하는 화는 새 감정 공백을 만들 필요가 없습니다. 약속한 지급을 알아볼 수 없게 약화하거나 이미 얻은 결과를 감춘 경우만 지적하고, 비율·새로움·보상 개수로 통과 여부를 정하지 마세요. 후일담이라면 지위, 관계, 자원 같은 구체적 변화 하나가 착지하면 충분합니다.`;
    }
    return language === "en"
      ? `${base}Check for reader value appropriate to the chapter's intended function: a visible payoff, goal movement, consequence, relationship or emotional turn, choice, or useful information can all qualify. Clean closure need not create a new emotional gap. Flag a promised payoff only when it is recognizably weakened or an earned result is withheld; never grade by a percentage, novelty target, or payoff count. In aftermath, one concrete change to status, relationship, or resources is enough.`
      : `${base}检查本章是否提供了符合预定功能的读者价值：情绪、关系、信息、选择、兑现或后果都可以成立，也可以表现为明确的目标推进。完整收束和必要后效都合法，不必制造新的情绪缺口。只有已经承诺的兑现被明显削弱或已经挣到的结果被扣住时才标记；不得按百分比、新奇度或爽点数量判定通过。后效章只要让地位、关系或资源的一项具体变化落地即可。`;
  }

  if (id === 25) {
    return language !== "zh"
      ? "Cross-check character behavior against the 3-question test: (1) Why does the character do this? (2) Does it match their established profile? (3) Would a reader who only read prior chapters find it jarring? Also check if character's emotional state progresses or stagnates."
      : "人设三问检查：(1)角色为什么这么做？(2)符合之前建立的人设吗？(3)只看过前面章节的读者会觉得突兀吗？同时检查角色情绪弧线是否在推进还是停滞。";
  }

  switch (id) {
    case 6:
      if (language === "ko") {
        return "pending_hooks.md의 stale / blocked / core_hook / depends_on / promoted 열은 다음 기획을 위한 부채 진단이지 이번 화의 장면 할당량이 아닙니다. 승격되지 않은 묵은 복선은 info, 승격되었거나 core_hook인 묵은 복선과 6화 이상 막힌 복선은 warning으로 기록해 Planner가 우선 검토하게 하세요. 권말에 이월 계획 없이 남은 승격 핵심 복선도 warning으로 사람과 Planner에게 넘기며, 나이만으로 현재 원고를 critical 또는 자동 재작성 대상으로 만들지 않습니다. 이번 chapter_memo가 특정 hook_id를 advance/resolve 또는 전부 지급 대상으로 명시했는데 장면이 실제로 빠진 경우만 Chapter Memo Drift 기준으로 critical을 판단합니다. 설명에는 정확한 hook_id와 stale/blocked 표식을 인용하세요.";
      }
      return language === "en"
        ? "Treat stale / blocked / core_hook / depends_on / promoted columns in pending_hooks.md as planning-debt diagnostics, not a scene quota for the current chapter. Log non-promoted stale hooks as info; promoted/core stale hooks and hooks blocked for 6+ chapters are warnings for Planner prioritization. Even at volume end, a promoted core hook with no carry-over plan is a warning for human/Planner review, not an age-only critical or automatic prose rewrite. Use critical only through Chapter Memo Drift when this chapter explicitly selected that hook_id for advance/resolve or full payoff and the promised scene is absent. Quote the exact hook_id and stale/blocked marker."
        : "把 pending_hooks.md 的 stale / blocked / core_hook / depends_on / promoted 列当作下一步规划的债务诊断，不是本章场景配额。未升级的陈旧伏笔记 info；升级/核心陈旧伏笔以及受阻 6 章以上的伏笔记 warning，交给 Planner 优先检视。即使在卷尾，升级核心伏笔没有显式转卷计划也只进入人工/Planner warning，不能仅凭年龄判 critical 或自动改写当前正文。只有本章 chapter_memo 明确把某 hook_id 选为 advance/resolve 或完整兑现而正文缺少承诺场景时，才按 Chapter Memo Drift 判 critical。描述中引用准确 hook_id 和 stale/blocked 标记。";
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
      if (language === "ko") {
        return "화말이 이번 화가 의도한 종결 기능—완전한 수습, 보상의 후과, 자연스럽게 생긴 다음 선택이나 압력—을 수행했는지 확인하세요. 약속한 지급이 독자가 알아볼 수 있게 착지하고 압력이 필요한 만큼 풀렸는지 봅니다. 이미 얻은 결과를 인공적인 절벽을 위해 감춘 경우를 표시하세요. 깨끗한 결산 화말은 새 호기심을 점화하지 않아도 합법입니다.";
      }
      return language === "en"
        ? "Check whether the ending performs its intended function: clean settlement, payoff fallout, or a next choice/pressure that grows naturally from the result. Verify that promised payoffs land recognizably and pressure gets the release it has earned. Flag an earned result withheld only to fabricate a cliffhanger. A clean-closure ending does not need to renew curiosity."
        : "检查章尾是否完成了预定功能：完整收束、兑现后的后果，或从结果中自然生出的下一选择/压力。确认已经承诺的兑现让读者清楚看见，压力得到应有释放。若只为制造人造断崖而扣住已经挣到的结果，应当标记。干净结算的章尾不必重新点燃好奇心。";
    case 33:
      if (language === "ko") {
        return "chapter_memo는 방향 계약이지 체크리스트가 아닙니다. critical은 (1) 회차 목표나 핵심 작업이 통째로 빠지거나 반대로 쓰인 경우, (2) 이번 화에 완전 지급하거나 반드시 지급한다고 명시한 장면이 없는 경우, (3) 명시적 금지를 어긴 경우, (4) 약속한 결과나 인과가 깨질 정도로 필수 화말 상태가 빠진 경우에만 사용하세요. 같은 독자 약속과 결과를 다른 유효한 장면으로 구현했다면 문제로 삼지 않습니다. 삼연문답의 논리, 전환 기능의 위치·정도·영향처럼 기획 보조의 자취가 약한 것은 warning만 가능하며 자동 재작성 대상이 아닙니다. 짧고 성긴 memo도 합법입니다.";
      }
      return language === "en"
        ? "Treat chapter_memo as a steering contract, not a checklist. Use critical only when (1) the chapter goal or core task is wholly absent or contradicted, (2) a scene explicitly marked for full / must-pay-this-chapter payoff is absent, (3) an explicit hard prohibition is violated, or (4) a required ending state is missing badly enough to break the promised result or causality. A different valid scene implementation is fine when it delivers the same reader promise and result. Weak literal traces of the three-question rationale or the transition map's placement, degree, and impact are warning-only planning drift, never grounds for automatic rewrite. Sparse memos are legitimate."
        : "把 chapter_memo 当作方向契约，不是逐项打勾的清单。只有以下情况可以判 critical：(1) 本章目标或核心任务整体缺失、被写反；(2) 明确标为本章完整兑现或必须兑现的场景缺失；(3) 违反显式硬禁令；(4) 必需章尾状态缺失到破坏既定结果或因果。只要另一种有效场景实现了同一个读者承诺与结果，就不算问题。三连问的推导、过渡功能的位置/程度/影响等规划辅助没有逐字留痕，只能记 warning，绝不能触发自动重写。稀疏 memo 合法。";
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
  // additionalAuditDimensions is free-form model output. It remains visible
  // in raw BookRules but can never create an automatic review gate. Add new
  // dimensions through a host-owned genre profile or typed code contract.

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
    const [diskCurrentState, diskLedger, diskHooks, styleGuideRaw, subplotBoard, emotionalArcs, characterMatrix, chapterSummaries, parentCanon, fanficCanon, volumeOutline, storyBible, creativeBrief] =
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
        readStoryFrame(bookDir, "(文件不存在)"),
        this.readFileSafe(join(bookDir, "story/brief.md")),
      ]);
    const rawCurrentState = options?.truthFileOverrides?.currentState ?? diskCurrentState;
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
    const effectiveRules = await readEffectiveBookRules(bookDir);
    const bookRules = effectiveRules?.automatic ?? null;
    const verifiedRuleGuidance = effectiveRules?.guidance ?? "";
    const verifiedRuleStack = projectRuleStackToVerifiedBookRules(
      options?.ruleStack,
      effectiveRules,
    );
    const moralAuthoritySources: ArchitectMoralAuthoritySource[] = [
      { kind: "owner-direction", text: creativeBrief },
      { kind: "persisted-book-canon", text: storyBible },
      { kind: "persisted-book-canon", text: volumeOutline },
      ...(effectiveRules?.hardEntries ?? []).map((entry) => ({
        kind: "persisted-book-canon" as const,
        text: entry.text,
      })),
    ];
    const currentState = sanitizeLegacyCurrentStateForAudit(
      rawCurrentState,
      moralAuthoritySources,
    ).text;
    assertProductionContextMoralAuthority([
      styleGuideRaw,
      verifiedRuleStack ? JSON.stringify(verifiedRuleStack) : undefined,
    ], moralAuthoritySources);

    // BookRules prose is display/diagnostic material, never a style fallback.
    const persistedStyleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : "(无文风指南)";

    const resolvedLanguage = bookLanguage ?? gp.language;
    const styleGuide = sanitizeLegacyFunFirstMethodology(persistedStyleGuide);
    const isEnglish = resolvedLanguage !== "zh";
    const fanficMode = hasFanficCanon ? (bookRules?.fanficMode as FanficMode | undefined) : undefined;
    const dimensions = buildDimensionList(gp, bookRules, resolvedLanguage, hasParentCanon, fanficMode);
    const dimList = dimensions
      .map((d) => `${d.id}. ${d.name}${d.note ? (isEnglish ? ` (${d.note})` : `（${d.note}）`) : ""}`)
      .join("\n");
    const genreLabel = resolveGenreLabel(genreId, gp.name, resolvedLanguage);

    const protagonistBlock = bookRules?.protagonist
      ? resolvedLanguage === "ko"
        ? `\n\n주인공 이름: ${bookRules.protagonist.name}. 검증된 행동 제약: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage) || "없음"}. book_rules의 성격 참고값은 자동 감리 근거가 아닙니다.`
        : isEnglish
        ? `\n\nProtagonist name: ${bookRules.protagonist.name}; verified behavioral constraints: ${joinLocalized(bookRules.protagonist.behavioralConstraints, resolvedLanguage) || "none"}. BookRules personality references are not automatic audit evidence.`
        : `\n主角姓名：${bookRules.protagonist.name}；已验证行为约束：${bookRules.protagonist.behavioralConstraints.join("、") || "无"}。book_rules 的性格参考不能作为自动审稿依据。`
      : "";
    const verifiedRulesBlock = verifiedRuleGuidance
      ? `\n\n${resolvedLanguage === "ko" ? "검증된 작품 규칙" : isEnglish ? "Verified Book Rule Guidance" : "已验证本书规则指引"}:\n${verifiedRuleGuidance}`
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
        ? "\n\n## 미래 선점 감리 경계\n- 기억한 미래 결과와 현재 구현 방법을 구분하세요. 결과를 안다는 사실만으로 구현 생략을 허용하지 않습니다.\n- 허용된 역사 분기를 실제 역사에 없었다는 이유만으로 오류 처리하지 마세요.\n- 근거가 없거나 확인되지 않은 현실 주장에는 track=research, severity=info를 사용하고 research_status=needs-research로 기록하세요. 이것은 창작 실패나 자동 수정 사유가 아닙니다.\n- 미래 선점 관련 critical 후보는 금지된 지름길, 인물의 정보 경계 위반, 허용 분기·작품 정본과의 직접 모순뿐입니다. 일반적인 창작 구조 문제는 기존 창작 감리 기준을 따릅니다.\n- move가 실제 실행됐을 때만 future_advantage_execution.implemented=true로 두세요. bridge_evidence, proof_evidence, reward_evidence와 세계·기억 변화의 evidence에는 원고에서 그대로 복사한 짧은 문구만 넣으세요. 계획에만 있고 본문에 없으면 false입니다."
        : resolvedLanguage === "en"
          ? "\n\n## Future Advantage audit boundary\n- Distinguish a remembered later outcome from its present-day implementation. Knowing the outcome does not waive bridge steps, resistance, proof, or cost.\n- Never mark an authorized divergence as an error merely because it did not occur in real history.\n- An unsupported or unverified real-world claim uses track=research, severity=info, and research_status=needs-research. It is not a creative failure or an automatic-revision instruction.\n- Future-advantage-specific critical candidates are limited to forbidden shortcuts, information-boundary breaches, and direct contradictions with authorized divergence or book canon. General creative structural failures still follow the normal creative audit.\n- Set future_advantage_execution.implemented=true only when the move is executed in the body. Every evidence value must be a short verbatim excerpt from the chapter. A planned-only move is false."
          : "\n\n## 未来先机审稿边界\n- 区分主角记得的未来结果与当下实现方法；知道结果不等于可以省略实现步骤、阻力、证据或代价。\n- 已授权的历史分歧不能仅因真实历史中未发生就判错。\n- 缺少依据或尚未核实的现实主张必须使用 track=research、severity=info、research_status=needs-research；它不是创作失败，也不是自动修稿指令。\n- 未来先机专属 critical 只限于禁用捷径、信息边界越界、与授权分歧或作品正典直接矛盾。一般创作结构问题仍按原有创作审稿标准处理。\n- 只有正文实际执行 move 时 future_advantage_execution.implemented 才能为 true。所有 evidence 必须逐字摘自本章；只存在于计划中的 move 必须为 false。";
    const koreanMemoAnchorAuditNote = resolvedLanguage === "ko" && options?.chapterMemo
      ? "\n\nchapter_memo의 '독자가 지금 기다리는 것'은 별도 점수가 아니라 이번 화의 재미 앵커입니다. 원고가 메모 문구를 반복했는지가 아니라 주인공의 선택, 상대의 대응, 반전이나 지급, 눈에 보이는 결과로 구현했는지 봅니다. 일부 지급·더 키움·아직 감춤은 합법이며 자동 실패로 만들지 않습니다. 메모가 '전부 지급' 또는 이번 화의 핵심 작업으로 명시했는데 해당 장면 자체가 없을 때만 Chapter Memo Drift Check의 creative critical로 판정하고 repair_scope=\"structural\"을 씁니다. 장면은 있으나 타격감이 약한 경우 warning으로만 남깁니다."
      : "";
    const contentNeutralityNote = resolvedLanguage === "ko"
      ? "\n\n## 허구 내용 중립 경계\n허구의 범죄, 폭력, 배신, 착취, 비도덕성, 불쾌함은 그 자체로 창작 결함이 아닙니다. 비난, 처벌, 반성, 사과, 속죄, 갱생, 도덕적 성장이나 대가의 부재도 사용자가 정본/하드 규칙으로 요구하지 않은 한 감점·critical·수정 사유가 아닙니다. 오직 제공된 정본에 대한 구체적 모순, 인과·시간선·정보 경계 붕괴, 또는 검증된 하드 규칙 위반만 창작 문제로 판정하세요."
      : resolvedLanguage === "en"
        ? "\n\n## Fiction-content-neutral boundary\nFictional crime, violence, betrayal, exploitation, immorality, or offensiveness is not a creative defect by itself. The absence of condemnation, punishment, remorse, apology, redemption, rehabilitation, moral growth, or a moral cost is not a scoring, critical, or revision reason unless supplied canon or a verified hard rule requires it. Only a concrete contradiction with supplied canon, a causality/timeline/information-boundary failure, or a verified hard-rule violation is a creative issue."
        : "\n\n## 虚构内容中立边界\n虚构犯罪、暴力、背叛、剥削、不道德或冒犯本身不是创作缺陷。除非提供的正典或已验证硬规则明确要求，否则缺少谴责、惩罚、悔过、道歉、赎罪、改造、道德成长或道德代价，不得成为扣分、critical 或修稿理由。只有与已提供正典的具体矛盾、因果/时间线/信息边界崩坏，或已验证硬规则违规，才是创作问题。";

    const systemPromptBase = resolvedLanguage === "ko"
      ? `당신은 엄격한 ${genreLabel} 웹소설 구조 편집자입니다. 문장 윤문이 아니라 회차의 완성도와 구조를 감리합니다.${protagonistBlock}${verifiedRulesBlock}${searchNote}${futureAdvantageAuditNote}${koreanMemoAnchorAuditNote}${contentNeutralityNote}

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
  "future_advantage_execution": null 또는 { "moveId": "계획의 move ID", "implemented": true/false, "bridgeEvidence": ["본문 그대로의 짧은 인용"], "proofEvidence": ["본문 인용"], "rewardEvidence": ["본문 인용"], "worldChanges": [{ "change": "정본화할 변화", "evidence": "본문 인용" }], "memoryReliability": "intact|strained|degraded|unreliable", "memoryEvidence": ["본문 인용"], "note": "짧은 판정 근거" },
  "overall_score": 0-100,
  "issues": [
    {
      "severity": "critical|warning|info",
      "repair_scope": "local|structural|unknown",
      "track": "creative|research",
      "dimension_id": "정수 또는 null",
      "evidence_source": "아래 제공 문맥의 source selector 또는 null",
      "evidence_quote": "해당 source에서 그대로 복사한 정본 근거 또는 null",
      "chapter_quote": "현재 원고에서 모순 행동을 그대로 복사한 짧은 인용 또는 null",
      "rule_id": "검증된 하드 규칙 ID 또는 null",
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
      ? `You are a strict ${genreLabel} web-fiction structural editor. Audit the chapter for completion and structure, not for prose craft. ALL OUTPUT MUST BE IN ENGLISH.${protagonistBlock}${verifiedRulesBlock}${searchNote}${futureAdvantageAuditNote}${contentNeutralityNote}

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
  "future_advantage_execution": null or { "moveId": "planned move ID", "implemented": true/false, "bridgeEvidence": ["short verbatim chapter excerpt"], "proofEvidence": ["verbatim excerpt"], "rewardEvidence": ["verbatim excerpt"], "worldChanges": [{ "change": "canon change", "evidence": "verbatim excerpt" }], "memoryReliability": "intact|strained|degraded|unreliable", "memoryEvidence": ["verbatim excerpt"], "note": "brief verdict" },
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "track": "creative|research",
	      "dimension_id": "integer or null",
	      "evidence_source": "a source selector from supplied context or null",
	      "evidence_quote": "an exact verbatim quote copied from that source or null",
	      "chapter_quote": "an exact verbatim chapter excerpt showing the contradiction or null",
	      "rule_id": "verified hard-rule ID or null",
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
      : `你是一位严格的${gp.name}网络小说结构审稿编辑。你只审完成度 + 结构，不审文笔。${protagonistBlock}${verifiedRulesBlock}${searchNote}${futureAdvantageAuditNote}${contentNeutralityNote}

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
  "future_advantage_execution": null 或 { "moveId": "计划 move ID", "implemented": true/false, "bridgeEvidence": ["正文逐字短引文"], "proofEvidence": ["正文引文"], "rewardEvidence": ["正文引文"], "worldChanges": [{ "change": "正典变化", "evidence": "正文引文" }], "memoryReliability": "intact|strained|degraded|unreliable", "memoryEvidence": ["正文引文"], "note": "简短判定" },
  "overall_score": 0-100,
  "issues": [
	    {
	      "severity": "critical|warning|info",
	      "repair_scope": "local|structural|unknown",
	      "track": "creative|research",
	      "dimension_id": "整数或 null",
	      "evidence_source": "下方提供上下文中的 source selector 或 null",
	      "evidence_quote": "从该 source 逐字复制的正典依据或 null",
	      "chapter_quote": "从当前正文逐字复制、能显示矛盾行为的短引文或 null",
	      "rule_id": "已验证硬规则 ID 或 null",
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
    const bookRulesForFilter = bookRules;
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
    const reducedControlBlock = options?.chapterIntent && options.contextPackage && verifiedRuleStack
      ? this.buildReducedControlBlock(options.chapterIntent, options.contextPackage, verifiedRuleStack, resolvedLanguage)
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

    // Host-trusted state/source whitelist for evidence-backed criticals.
    // Planner/Composer control, chapter memos, and Arc plans remain useful
    // diagnostic context, but they are model-generated plans rather than
    // established story state and therefore cannot prove a dimension-14
    // character contradiction. Rule text enters only through exact ruleRefs.
    const canonicalEvidenceSources: ReadonlyArray<CanonicalEvidenceSource> = [
      { selector: "current-state", content: currentState },
      { selector: "resource-ledger", content: ledgerBlock },
      { selector: "pending-hooks", content: hooksBlock },
      { selector: "volume-summaries", content: volumeSummariesBlock },
      { selector: "subplot-board", content: subplotBlock },
      { selector: "emotional-arcs", content: emotionalBlock },
      { selector: "character-matrix", content: matrixBlock },
      { selector: "chapter-summaries", content: summariesBlock },
      { selector: "parent-canon", content: canonBlock },
      { selector: "fanfic-canon", content: fanficCanonBlock },
      { selector: "previous-chapter", content: prevChapterBlock },
    ].filter((source) => source.content.trim().length > 0 && source.content !== "(文件不存在)");
    const hardRuleEvidenceSources: ReadonlyArray<CanonicalEvidenceSource> = [{
      selector: "rule-stack-hard",
      content: verifiedRuleStack?.ruleRefs?.map((ref) => ref.text).join("\n") ?? "",
    }].filter((source) => source.content.trim().length > 0);
    const selectableEvidenceSources = [...canonicalEvidenceSources, ...hardRuleEvidenceSources];
    const sourceSelectorBlock = resolvedLanguage === "ko"
      ? `\n## 정본 근거 source selector\n${selectableEvidenceSources.map((source) => `- ${source.selector}`).join("\n")}\n`
      : isEnglish
        ? `\n## Canonical evidence source selectors\n${selectableEvidenceSources.map((source) => `- ${source.selector}`).join("\n")}\n`
        : `\n## 正典依据 source selector\n${selectableEvidenceSources.map((source) => `- ${source.selector}`).join("\n")}\n`;

    const userPrompt = resolvedLanguage === "ko"
      ? `제${chapterNumber}화를 감리하세요.
${sourceSelectorBlock}

## 현재 상태
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${arcContextBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## 감리할 원고
${chapterContent}`
      : isEnglish
      ? `Review chapter ${chapterNumber}.
${sourceSelectorBlock}

## Current State Card
${currentState}
${ledgerBlock}
${hooksBlock}${volumeSummariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}${summariesBlock}${canonBlock}${fanficCanonBlock}${reducedControlBlock}${arcContextBlock}${memoBlock}${prevChapterBlock}${styleGuideBlock}

## Chapter Content Under Review
${chapterContent}`
      : `请审查第${chapterNumber}章。
${sourceSelectorBlock}

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
        futureAdvantageMoveId: parseFutureAdvantageMoveId(options?.arcContext),
        chapterContent,
        canonicalEvidenceSources,
        hardRuleEvidenceSources,
        hardRuleRefs: verifiedRuleStack?.ruleRefs,
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
	              dimensionId: normalizeDimensionId(issue.dimension_id ?? issue.dimensionId),
	              evidenceSource: normalizeOptionalString(issue.evidence_source ?? issue.evidenceSource ?? issue.source_selector ?? issue.sourceSelector),
	              evidenceQuote: normalizeOptionalString(issue.evidence_quote ?? issue.evidenceQuote),
	              chapterQuote: normalizeOptionalString(issue.chapter_quote ?? issue.chapterQuote),
	              ruleId: normalizeOptionalString(issue.rule_id ?? issue.ruleId),
	            });
          } catch {
            // skip malformed individual issue
          }
        }
      }
      // A regex recovery proves only that fragments were present, not that the
      // auditor completed its verdict. Keep any readable findings visible, but
      // never promote a truncated `"passed": true` fragment to a trusted pass.
      if (issues.length > 0) {
        return {
          passed: false,
          parseFailed: true,
          creativePassed: false,
          researchStatus: normalizeResearchStatus(content.match(/"research_status"\s*:\s*"([^"]+)"/)?.[1]),
          // Preserve readable findings for diagnosis, but add an explicit
          // system-critical receipt so persistence cannot make a malformed
          // audit look like it failed merely because of an advisory warning.
          issues: [buildAuditParseFailureIssue(language), ...issues],
          summary: summaryMatch?.[1] ?? (language === "ko" ? "감리 출력 일부만 복구됨" : language === "en" ? "Audit output was only partially recovered" : "审稿输出仅部分恢复"),
        };
      }
    }

    return {
      passed: false,
      parseFailed: true,
      creativePassed: false,
      researchStatus: "not-checked",
      issues: [buildAuditParseFailureIssue(language)],
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
    const verifiedHardBookRules = ruleStack.ruleRefs?.length
      ? ruleStack.ruleRefs.map((ref) => `- [${ref.ruleId}] ${ref.text}`).join("\n")
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

### Verified Hard Book Rules
${verifiedHardBookRules}

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

### 已验证硬规则
${verifiedHardBookRules}

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
      // A syntactically valid object is not necessarily a complete audit.
      // Trusted verdicts require the full minimal envelope; otherwise callers
      // could accept `{ "passed": true }` after a truncated model response.
      if (
        typeof parsed.passed !== "boolean"
        || !Array.isArray(parsed.issues)
        || typeof parsed.summary !== "string"
        || parsed.issues.some((issue: unknown) => {
          if (!issue || typeof issue !== "object") return true;
          const candidate = issue as Record<string, unknown>;
          return (candidate.severity !== "critical" && candidate.severity !== "warning" && candidate.severity !== "info")
            || typeof candidate.category !== "string"
            || typeof candidate.description !== "string"
            || typeof candidate.suggestion !== "string";
        })
      ) return null;
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
        futureAdvantageExecution: parseFutureAdvantageExecution(
          parsed.future_advantage_execution ?? parsed.futureAdvantageExecution,
        ),
        issues: Array.isArray(parsed.issues)
          ? parsed.issues.map((i: Record<string, unknown>) => ({
              severity: i.severity as AuditIssue["severity"],
	              category: (i.category as string) ?? (language === "ko" ? "미분류" : language === "en" ? "Uncategorized" : "未分类"),
	              description: (i.description as string) ?? "",
	              suggestion: (i.suggestion as string) ?? "",
	              repairScope: normalizeRepairScope(i.repair_scope ?? i.repairScope),
	              track: i.track === "research" ? "research" : i.track === "creative" ? "creative" : undefined,
	              dimensionId: normalizeDimensionId(i.dimension_id ?? i.dimensionId),
	              evidenceSource: normalizeOptionalString(i.evidence_source ?? i.evidenceSource ?? i.source_selector ?? i.sourceSelector),
	              evidenceQuote: normalizeOptionalString(i.evidence_quote ?? i.evidenceQuote),
	              chapterQuote: normalizeOptionalString(i.chapter_quote ?? i.chapterQuote),
	              ruleId: normalizeOptionalString(i.rule_id ?? i.ruleId),
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
