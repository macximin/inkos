/**
 * Publication-compatibility detection — rule-based analysis (no LLM).
 *
 * Detects terms that a downstream publishing platform may flag or block. This
 * report is advisory metadata. It is not a creative verdict and must not be
 * used to rewrite private fiction automatically.
 */

export interface SensitiveWordMatch {
  readonly word: string;
  readonly count: number;
  readonly severity: "block" | "warn";
}

/**
 * Deliberately not assignable to AuditIssue. Publication screening is an
 * export-time compatibility report, not a creative-review issue, so its
 * severity vocabulary cannot accidentally enter audit/revision gates.
 */
export interface PublicationCompatibilityIssue {
  readonly track: "publication-compatibility";
  readonly severity: "block" | "warn";
  readonly category: string;
  readonly description: string;
  readonly suggestion: string;
}

export interface SensitiveWordResult {
  readonly track: "publication-compatibility";
  readonly issues: ReadonlyArray<PublicationCompatibilityIssue>;
  readonly found: ReadonlyArray<SensitiveWordMatch>;
}

type SensitiveWordLanguage = "zh" | "ko" | "en";

// Political terms — severity "block"
const POLITICAL_WORDS: ReadonlyArray<string> = [
  "习近平", "习主席", "习总书记", "共产党", "中国共产党", "共青团",
  "六四", "天安门事件", "天安门广场事件", "法轮功", "法轮大法",
  "台独", "藏独", "疆独", "港独",
  "新疆集中营", "再教育营",
  "维吾尔", "达赖喇嘛", "达赖",
  "刘晓波", "艾未未", "赵紫阳",
  "文化大革命", "文革", "大跃进",
  "反右运动", "镇压", "六四屠杀",
  "中南海", "政治局常委",
  "翻墙", "防火长城",
];

// Sexual terms — severity "warn"
const SEXUAL_WORDS: ReadonlyArray<string> = [
  "性交", "做爱", "口交", "肛交", "自慰", "手淫",
  "阴茎", "阴道", "阴蒂", "乳房", "乳头",
  "射精", "高潮", "潮吹",
  "淫荡", "淫乱", "荡妇", "婊子",
  "强奸", "轮奸",
];

// Extreme violence — severity "warn"
const VIOLENCE_EXTREME: ReadonlyArray<string> = [
  "肢解", "碎尸", "挖眼", "剥皮", "开膛破肚",
  "虐杀", "凌迟", "活剥", "活埋", "烹煮活人",
];

interface WordListEntry {
  readonly words: ReadonlyArray<string>;
  readonly severity: "block" | "warn";
  readonly label: string;
  readonly koreanLabel: string;
  readonly englishLabel: string;
}

const WORD_LISTS: ReadonlyArray<WordListEntry> = [
  { words: POLITICAL_WORDS, severity: "block", label: "政治敏感词", koreanLabel: "정치 민감 표현", englishLabel: "political sensitive terms" },
  { words: SEXUAL_WORDS, severity: "warn", label: "色情敏感词", koreanLabel: "성적 민감 표현", englishLabel: "sexual sensitive terms" },
  { words: VIOLENCE_EXTREME, severity: "warn", label: "极端暴力词", koreanLabel: "극단적 폭력 표현", englishLabel: "extreme violence terms" },
];

/**
 * Analyze text content for publication-compatibility terms.
 *
 * `issues` intentionally uses a publication-only shape and `block`/`warn`
 * severities. Callers must keep this result outside creative pass/fail,
 * scoring, canon, and revision.
 */
export function analyzeSensitiveWords(
  content: string,
  customWords?: ReadonlyArray<string>,
  language: SensitiveWordLanguage = "zh",
): SensitiveWordResult {
  const found: SensitiveWordMatch[] = [];
  const issues: PublicationCompatibilityIssue[] = [];
  const isEnglish = language !== "zh";
  const isKorean = language === "ko";
  const joiner = isEnglish ? ", " : "、";

  // Check built-in word lists
  for (const list of WORD_LISTS) {
    const matches = scanWords(content, list.words, list.severity);
    if (matches.length > 0) {
      found.push(...matches);
      const wordSummary = matches.map((m) => `"${m.word}"×${m.count}`).join(joiner);
      issues.push({
        track: "publication-compatibility",
        severity: list.severity,
        category: isKorean ? "공개 호환성" : isEnglish ? "Publication compatibility" : "发布兼容性",
        description: isKorean
          ? `${list.koreanLabel} 감지: ${wordSummary}`
          : isEnglish
          ? `Detected ${list.englishLabel}: ${wordSummary}`
          : `检测到${list.label}：${wordSummary}`,
        suggestion: isKorean
          ? (list.severity === "block"
              ? "일부 공개 플랫폼에서 차단될 수 있습니다. 원고는 자동 변경되지 않습니다."
              : "일부 공개 플랫폼의 검수 대상이 될 수 있습니다. 원고는 자동 변경되지 않습니다.")
          : isEnglish
          ? (list.severity === "block"
              ? "A publishing platform may block these terms. The manuscript is not changed automatically."
              : `A publishing platform may review these ${list.englishLabel}. The manuscript is not changed automatically.`)
          : (list.severity === "block"
              ? "发布平台可能拦截这些词；正文不会被自动修改。"
              : `发布平台可能审核这些${list.label}；正文不会被自动修改。`),
      });
    }
  }

  // Check custom words
  if (customWords && customWords.length > 0) {
    const customMatches = scanWords(content, customWords, "warn");
    if (customMatches.length > 0) {
      found.push(...customMatches);
      const wordSummary = customMatches.map((m) => `"${m.word}"×${m.count}`).join(joiner);
      issues.push({
        track: "publication-compatibility",
        severity: "warn",
        category: isKorean ? "공개 호환성" : isEnglish ? "Publication compatibility" : "发布兼容性",
        description: isKorean
          ? `사용자 지정 민감 표현 감지: ${wordSummary}`
          : isEnglish
          ? `Detected custom sensitive term(s): ${wordSummary}`
          : `检测到自定义敏感词：${wordSummary}`,
        suggestion: isKorean
          ? "프로젝트의 공개 호환성 규칙과 대조하세요. 원고는 자동 변경되지 않습니다."
          : isEnglish
          ? "Compare these terms with the project's publication rules. The manuscript is not changed automatically."
          : "请对照项目的发布规则检查这些词；正文不会被自动修改。",
      });
    }
  }

  return { track: "publication-compatibility", issues, found };
}

function scanWords(
  content: string,
  words: ReadonlyArray<string>,
  severity: "block" | "warn",
): ReadonlyArray<SensitiveWordMatch> {
  const matches: SensitiveWordMatch[] = [];
  for (const word of words) {
    const regex = new RegExp(escapeRegExp(word), "g");
    const hits = content.match(regex);
    if (hits && hits.length > 0) {
      matches.push({ word, count: hits.length, severity });
    }
  }
  return matches;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
