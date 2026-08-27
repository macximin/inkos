import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseMarkdownTableRows } from "../utils/story-markdown.js";
import { readCharacterContext, readRoleCards } from "../utils/outline-paths.js";
import { readBookRules as readStructuredBookRules } from "./rules-reader.js";
import { readEffectiveBookRules } from "./effective-book-rules.js";
import type { StoredHook } from "../state/memory-db.js";

type PlannerContextLanguage = "zh" | "ko" | "en";

function localized(
  language: PlannerContextLanguage,
  values: { readonly zh: string; readonly ko: string; readonly en: string },
): string {
  return values[language];
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Phase 5: prefer roles/ directory; fall back to legacy character_matrix.md.
 * storyDir is <bookDir>/story, so the caller indirectly points us at bookDir
 * via dirname().
 */
export async function readCharacterMatrix(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  const [cards, parsedRules] = await Promise.all([
    readRoleCards(bookDir),
    readStructuredBookRules(bookDir),
  ]);
  if (cards.length === 0) {
    return readCharacterContext(bookDir, "");
  }

  const configuredProtagonist = parsedRules?.rules.protagonist?.name.trim() ?? "";
  const sanitizedConfiguredProtagonist = configuredProtagonist
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim();
  const configuredCard = cards.find((card) =>
    card.name.trim() === configuredProtagonist
    || card.name.trim() === sanitizedConfiguredProtagonist
  );
  const majorCards = cards.filter((card) => card.tier === "major");
  const inferredProtagonist = configuredCard?.name
    || (majorCards.length === 1 ? majorCards[0]?.name : "")
    || "";

  return [...cards]
    .sort((a, b) => {
      const protagonistOrder = Number(b.name === inferredProtagonist) - Number(a.name === inferredProtagonist);
      if (protagonistOrder !== 0) return protagonistOrder;
      if (a.tier !== b.tier) return a.tier === "major" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((card) => [
      "---ROLE---",
      `tier: ${card.tier}`,
      `name: ${card.name}`,
      `protagonist: ${card.name === inferredProtagonist ? "true" : "false"}`,
      "---CONTENT---",
      card.content.trim(),
    ].join("\n"))
    .join("\n\n");
}

export async function readSubplotBoard(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "subplot_board.md"));
}

export async function readEmotionalArcs(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "emotional_arcs.md"));
}

export async function readPendingHooks(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "pending_hooks.md"));
}

export async function readBrief(storyDir: string): Promise<string> {
  return readOrEmpty(join(storyDir, "brief.md"));
}

/**
 * Render non-restriction canon facts plus provenance-labelled guidance for the
 * planner prompt. Raw Markdown stays display-only; enforcement-sensitive lists
 * appear here only when the host-owned sidecar authorizes them.
 */
export async function readBookRules(storyDir: string): Promise<string> {
  const bookDir = dirname(storyDir);
  const effective = await readEffectiveBookRules(bookDir);
  if (!effective) return "";

  const rules = effective.automatic;
  const lines: string[] = [];

  if (rules.protagonist) {
    const proto = rules.protagonist;
    const constraints = proto.behavioralConstraints.join("、");
    // personalityLock is intentionally absent here. Even an advisory label can
    // be laundered by the planner into a chapter goal or prohibition, which the
    // downstream auditor may then mistake for an executable mandate. The writer
    // still receives it as characterization advice; only provenance-verified
    // behavioral constraints are allowed onto the chapter-control surface.
    lines.push(`- 主角 ${proto.name}${constraints ? ` / 已验证行为约束：${constraints}` : ""}`);
  }

  if (rules.prohibitions.length > 0) {
    lines.push("- 本书禁忌：");
    for (const p of rules.prohibitions) {
      lines.push(`  - ${p}`);
    }
  }

  if (rules.genreLock) {
    const forbidden = rules.genreLock.forbidden.join("、");
    lines.push(`- 题材锁：${rules.genreLock.primary}${forbidden ? ` / 禁止混入：${forbidden}` : ""}`);
  }

  if (rules.fanficMode) {
    lines.push(`- 同人模式：${rules.fanficMode}`);
  }

  if (effective.guidance) {
    lines.push("", "- Provenance-labelled rule guidance:", effective.guidance);
  }

  return lines.join("\n").trim();
}

/**
 * Grab the last N row(s) from chapter_summaries.md formatted as markdown
 * table. Returns original table slice (with header) so the planner gets
 * column meaning implicitly.
 */
export function formatRecentSummaries(
  chapterSummariesRaw: string,
  chapterNumber: number,
  limit: number,
  language: PlannerContextLanguage = "zh",
): string {
  const rows = parseMarkdownTableRows(chapterSummariesRaw)
    .filter((row) => /^\d+$/.test(row[0] ?? ""))
    .filter((row) => parseInt(row[0]!, 10) < chapterNumber)
    .sort((a, b) => parseInt(a[0]!, 10) - parseInt(b[0]!, 10));

  const recent = rows.slice(-limit);
  if (recent.length === 0) {
    return localized(language, {
      zh: "（暂无前章摘要）",
      ko: "(직전 회차 요약 없음)",
      en: "(no previous chapter summaries)",
    });
  }

  const header = localized(language, {
    zh: "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
    ko: "| 회차 | 제목 | 등장인물 | 핵심 사건 | 상태 변화 | 복선 변화 | 정서 | 회차 유형 |",
    en: "| Chapter | Title | Characters | Key event | State change | Hook change | Emotion | Chapter type |",
  });
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = recent.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [header, divider, body].join("\n");
}

/**
 * Option A: temporarily compose current_arc prose from subplot_board.md
 * active rows + emotional_arcs.md recent rows. Phase 8 will replace this
 * source with a dedicated tier2_current_arc.md file.
 */
export function composeCurrentArcProse(
  subplotBoardRaw: string,
  emotionalArcsRaw: string,
  chapterNumber: number,
  language: PlannerContextLanguage = "zh",
): string {
  const activeSubplots = extractActiveSubplotLines(subplotBoardRaw);
  const recentArcs = extractRecentEmotionalArcLines(emotionalArcsRaw, chapterNumber, 3);

  const parts: string[] = [];
  if (activeSubplots.length > 0) {
    const label = localized(language, {
      zh: "活跃支线：",
      ko: "활성 보조 줄기:",
      en: "Active subplots:",
    });
    parts.push(label + "\n" + activeSubplots.map((line) => `- ${line}`).join("\n"));
  }
  if (recentArcs.length > 0) {
    const label = localized(language, {
      zh: "近期情感线：",
      ko: "최근 감정선:",
      en: "Recent emotional arcs:",
    });
    parts.push(label + "\n" + recentArcs.map((line) => `- ${line}`).join("\n"));
  }
  if (parts.length === 0) {
    return localized(language, {
      zh: "（暂无 arc 数据——可能是新书起始阶段）",
      ko: "(현재 Arc 자료 없음 — 신작 시작 단계일 수 있음)",
      en: "(no Arc data — possibly a new-work opening)",
    });
  }
  return parts.join("\n\n");
}

function extractActiveSubplotLines(raw: string): string[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => line.replace(/^-\s*/, ""))
      .filter(Boolean)
      .slice(0, 6);
  }
  return rows
    .filter((row) => !/^(id|subplot_id|subplot|status|状态)$/i.test(row[0] ?? ""))
    .filter((row) => {
      const status = (row.find((cell) => /进行|推进|高压|激活|activ|progress|partial/i.test(cell)) ?? "");
      const dormant = row.find((cell) => /暂稳待续|暂挂|dormant|paused/i.test(cell));
      return Boolean(status) && !dormant;
    })
    .map((row) => row.filter(Boolean).join(" | "))
    .slice(0, 6);
}

function extractRecentEmotionalArcLines(raw: string, chapterNumber: number, limit: number): string[] {
  const rows = parseMarkdownTableRows(raw);
  if (rows.length === 0) {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .slice(-limit)
      .map((line) => line.replace(/^-\s*/, ""));
  }
  // emotional_arcs.md column layout: 角色 | 章节 | 情绪状态 | 触发事件 | 强度 | 弧线方向
  // Chapter number lives in column index 1 (row[1]), not column 0.
  return rows
    .filter((row) => /^\d+$/.test(row[1] ?? ""))
    .filter((row) => parseInt(row[1]!, 10) < chapterNumber)
    .slice(-limit)
    .map((row) => row.filter(Boolean).join(" | "));
}

const CHARACTER_MATRIX_HEADER_CELLS = /^(角色|character|name|核心标签|与主角关系|relation)$/i;

interface PlannerRoleCard {
  readonly tier: "major" | "minor";
  readonly name: string;
  readonly protagonist: boolean;
  readonly content: string;
}

function parsePlannerRoleCards(raw: string): ReadonlyArray<PlannerRoleCard> {
  const chunks = raw.split(/^---ROLE---\s*$/m).slice(1);
  const cards: PlannerRoleCard[] = [];
  for (const chunk of chunks) {
    const sections = chunk.split(/^---CONTENT---\s*$/m);
    if (sections.length < 2) continue;
    const metadata = sections.shift() ?? "";
    const content = sections.join("\n---CONTENT---\n").trim();
    const tier = /^tier:\s*(major|minor)\s*$/im.exec(metadata)?.[1];
    const name = /^name:\s*(.+?)\s*$/im.exec(metadata)?.[1]?.trim() ?? "";
    if ((tier !== "major" && tier !== "minor") || !name || !content) continue;
    cards.push({
      tier,
      name,
      protagonist: /^protagonist:\s*true\s*$/im.test(metadata),
      content,
    });
  }
  return cards;
}

function renderPlannerRoleCard(card: PlannerRoleCard): string {
  return `### ${card.name}\n\n${card.content}`;
}

function renderPlannerRelationSummary(card: PlannerRoleCard, evidence: string): string {
  const compactEvidence = evidence.replace(/\s+/g, " ").trim().slice(0, 320);
  return `- ${card.name} (${card.tier}): ${compactEvidence}`;
}

function isLikelyHeaderRow(row: ReadonlyArray<string>): boolean {
  return row.some((cell) => CHARACTER_MATRIX_HEADER_CELLS.test(cell.trim()));
}

/**
 * Extract the protagonist row from character_matrix.md. Protagonist is detected
 * by a cell in the 与主角关系 column matching "主角本人" / "主角" / "protagonist"
 * (case-insensitive). Falls back to the first non-header data row if no
 * explicit match is found — that row is almost always the protagonist by
 * convention.
 */
export function extractProtagonistRow(
  characterMatrixRaw: string,
  language: PlannerContextLanguage = "zh",
): string {
  const roleCards = parsePlannerRoleCards(characterMatrixRaw);
  if (roleCards.length > 0) {
    const protagonist = roleCards.find((card) => card.protagonist);
    if (protagonist) return renderPlannerRoleCard(protagonist);
    return localized(language, {
      zh: "（角色卡未能可靠识别主角——请检查 book_rules 与 roles）",
      ko: "(역할 카드에서 주인공을 신뢰성 있게 식별하지 못함 — book_rules와 roles 확인 필요)",
      en: "(protagonist could not be identified reliably from role cards — check book_rules and roles)",
    });
  }

  const rows = parseMarkdownTableRows(characterMatrixRaw);
  const protagonist = rows.find((row) =>
    row.some((cell) => /^(主角本人|主角|protagonist)$/i.test(cell.trim())),
  );
  if (protagonist) {
    return `| ${protagonist.join(" | ")} |`;
  }
  const firstDataRow = rows.find((row) => !isLikelyHeaderRow(row));
  if (firstDataRow) {
    return `| ${firstDataRow.join(" | ")} |`;
  }
  return localized(language, {
    zh: "（未找到主角行——请检查 character_matrix.md）",
    ko: "(주인공 행을 찾지 못함 — character_matrix.md 확인 필요)",
    en: "(protagonist row not found — check character_matrix.md)",
  });
}

const OPPONENT_PATTERNS = /敌对|对手|阻力|仇敌|回收对象|\b(?:opponent|antagonist|foe|enemy|rival|recovery target)\b|적대|대립|경쟁자|원수|회수\s*대상(?:으로)?|(?:^|[^\p{L}\p{N}])적(?:(?:이다|이지만|이며|이고|이라|으로|과|인)|(?=$|[^\p{L}\p{N}]))/iu;
const COLLABORATOR_PATTERNS = /协力|盟友|临时助力|合作|同盟|朋友|\b(?:ally|collaborator|mentor|partner|friend)\b|동업|동맹|협력|조력|멘토|스승|공동\s*전선|친구/iu;
const NEUTRAL_RELATION_PATTERNS = /\bneutral\b|중립|中立|无关/iu;

const RELATION_SECTION_HEADINGS = /^(?:관계망|인간관계|주인공과 얽히는 일|주인공과의 관계|关系网络|与主角关系|关系网|Relationship_Network|Relationship_to_Protagonist|Relationships?)$/i;
const PROTAGONIST_SCOPED_RELATION_HEADINGS = /^(?:주인공과 얽히는 일|주인공과의 관계|与主角关系|Relationship_to_Protagonist)$/i;

interface RoleRelationSection {
  readonly text: string;
  readonly protagonistScoped: boolean;
}

function extractRoleRelationSection(content: string): RoleRelationSection | null {
  const lines = content.split("\n");
  const selected: string[] = [];
  let active = false;
  let protagonistScoped = false;
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.trim();
    if (heading !== undefined) {
      if (active) break;
      active = RELATION_SECTION_HEADINGS.test(heading);
      protagonistScoped = active && PROTAGONIST_SCOPED_RELATION_HEADINGS.test(heading);
      continue;
    }
    if (active) selected.push(line);
  }
  const text = selected.join("\n").trim();
  return text ? { text, protagonistScoped } : null;
}

function stripNegatedRelationLabels(value: string): string {
  return value
    .replace(/\b(?:is|are|was|were|does|do|did)n['’]t\s+(?:act\s+as\s+|remain\s+)?(?:(?:currently|now|really|actually)\s+){0,2}(?:an?\s+)?(?:opponent|antagonist|foe|enemy|rival|ally|collaborator|mentor|partner|friend)\b/giu, "")
    .replace(/\b(?:not|never|no|no longer)\s+(?:(?:currently|now|really|actually)\s+){0,2}(?:an?\s+)?(?:opponent|antagonist|foe|enemy|rival|ally|collaborator|mentor|partner|friend)\b/giu, "")
    .replace(/(?:并非|不是|不再是|非)\s*(?:主角(?:的)?)?(?:敌人|敌对|对手|阻力|仇敌|盟友|协力|合作|同盟|伙伴|朋友)/gu, "")
    .replace(/主角\s*(?:并不|不再|从不|没有)\s*(?:敌对|对立|竞争|协力|合作|结盟|同盟)/gu, "")
    .replace(/(?:敌对|对立|竞争|协力|合作|结盟|同盟)\s*(?:并不|不再|从不)/gu, "")
    .replace(/(?:적대|대립|경쟁|협력|동맹|조력)\s*하?지\s*않(?:는다|다|고|지만|으며|음)/gu, "")
    .replace(/(?:적|적대|대립|경쟁자|원수|동업자?|동맹|협력자?|조력자?|멘토|스승|친구)(?:이|가|은|는)?\s*(?:아니(?:다|며|고|지만|었던|라고)|아님)/gu, "");
}

function buildNamedProtagonistReference(name: string): string {
  const escaped = escapeRegExp(name);
  let namedReference: string;
  if (/^[\x00-\x7F]+$/.test(name)) {
    namedReference = `\\b${escaped}\\b`;
  } else if (/\p{Script=Hangul}/u.test(name)) {
    namedReference = `${escaped}(?=(?:에게는|에게|한테|과는|와는|으로|로|의|과|와|은|는|이|가|을|를|도)?(?:$|[^\\p{L}\\p{N}_]))`;
  } else {
    namedReference = `${escaped}(?=(?:的|与|和|跟)?(?:$|[^\\p{L}\\p{N}_]))`;
  }
  return namedReference;
}

function deriveUniqueKoreanProtagonistAliases(
  protagonistName: string,
  roleNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const characters = [...protagonistName.trim()];
  if (characters.length < 3 || !characters.every((character) => /\p{Script=Hangul}/u.test(character))) {
    return [];
  }
  const alias = characters.slice(-2).join("");
  const collision = roleNames.some((roleName) => {
    const candidate = roleName.trim();
    return candidate !== protagonistName && (candidate === alias || candidate.endsWith(alias));
  });
  return collision ? [] : [alias];
}

function buildProtagonistReferencePattern(
  protagonistName: string,
  aliases: ReadonlyArray<string> = [],
): RegExp {
  const namedReferences = [protagonistName, ...aliases]
    .filter(Boolean)
    .map(buildNamedProtagonistReference);
  const namedPattern = namedReferences.length > 0 ? `${namedReferences.join("|")}|` : "";
  return new RegExp(`${namedPattern}주인공|主角|\\bprotagonist\\b`, "iu");
}

function containsRelationLabel(value: string): boolean {
  return OPPONENT_PATTERNS.test(value) || COLLABORATOR_PATTERNS.test(value);
}

function continuesPriorProtagonistRelation(segment: string, cardName: string): boolean {
  if (!containsRelationLabel(segment) && !NEUTRAL_RELATION_PATTERNS.test(segment)) return false;
  const trimmed = segment.trim();
  return /^(?:현재|지금|이후|나중|그는|그녀는|그들은|currently|now\b|later\b|then\b|she\b|he\b|they\b|如今|目前|现在|后来|此后|他|她)/iu.test(trimmed)
    || trimmed.startsWith(cardName);
}

function selectCurrentRelationEvidence(value: string): string {
  const currentMarkers = [...value.matchAll(/현재(?:는|의|도)?|지금|이후|나중에는|(?:되었|됐|된다)|currently|\bnow\b|\blater\b|\bthen\b|\bbecame\b|\bbecomes\b|如今|目前|现在|后来|此后|成为|变成/giu)];
  const lastCurrent = currentMarkers.at(-1);
  if (lastCurrent?.index === undefined) return value;
  const fromCurrent = value.slice(lastCurrent.index);
  if (NEUTRAL_RELATION_PATTERNS.test(fromCurrent)) return "";
  // If the current clause names a relation, it supersedes any earlier state
  // regardless of whether the author used "but", a period, or a new line.
  // When the label itself precedes "currently" ("Alex's partner currently"),
  // keep the whole segment so the relation is not sliced away.
  return containsRelationLabel(fromCurrent) ? fromCurrent : value;
}

function describesNamedThirdParty(
  segment: string,
  cardName: string,
  protagonistName: string,
  protagonistAliases: ReadonlyArray<string>,
): boolean {
  const protagonistNames = [protagonistName, ...protagonistAliases]
    .filter(Boolean)
    .map(escapeRegExp)
    .join("|");
  if (!protagonistNames) return false;
  const relation = "opponent|antagonist|foe|enemy|rival|ally|collaborator|mentor|partner";
  const match = new RegExp(`(?:${protagonistNames})['’]s\\s+(?:${relation})\\s+(?:is|was)\\s+(.+)$`, "iu")
    .exec(segment);
  if (!match?.[1]) return false;
  const target = match[1].replace(/^(?:an?|the)\s+/iu, "").trim();
  const cardPattern = new RegExp(`^${escapeRegExp(cardName)}(?:\\b|$)`, "iu");
  return !cardPattern.test(target);
}

function relationEvidenceForRole(
  card: PlannerRoleCard,
  protagonistName: string,
  protagonistAliases: ReadonlyArray<string> = [],
): string {
  const relationSection = extractRoleRelationSection(card.content);
  if (!relationSection) return "";

  const segments = relationSection.text
    .split(/[\n。.!?！？]+/)
    .map((clause) => clause.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((segment) => !describesNamedThirdParty(
      segment,
      card.name,
      protagonistName,
      protagonistAliases,
    ));
  const protagonistPattern = buildProtagonistReferencePattern(protagonistName, protagonistAliases);
  const explicitlyScopedSegments = segments.filter((segment, index) =>
        protagonistPattern.test(segment)
        || (
          index > 0
          && protagonistPattern.test(segments[index - 1] ?? "")
          && (
            /^(?:현재|지금|이후|나중|currently|now\b|later\b|then\b|如今|目前|现在|后来|此后|而|但是|but\b)/i.test(segment)
            || (
              /현재(?:는|의|도)?|지금|currently|\bnow\b|如今|目前|现在/iu.test(segment)
              && (containsRelationLabel(segment) || NEUTRAL_RELATION_PATTERNS.test(segment))
            )
            || continuesPriorProtagonistRelation(segment, card.name)
          )
        )
      );
  const scopedSegments = explicitlyScopedSegments.length > 0
    ? explicitlyScopedSegments
    : relationSection.protagonistScoped
      ? segments
      : [];
  if (scopedSegments.length === 0) return "";
  const scoped = stripNegatedRelationLabels(scopedSegments.join(". "));
  return stripNegatedRelationLabels(selectCurrentRelationEvidence(scoped));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractOpponentRows(
  characterMatrixRaw: string,
  limit: number,
  language: PlannerContextLanguage = "zh",
): string {
  return extractRowsByRelation(characterMatrixRaw, OPPONENT_PATTERNS, limit, localized(language, {
    zh: "（暂无明确对手登场）",
    ko: "(이번 화에 확인된 주요 상대 없음)",
    en: "(no clear opponent for this chapter)",
  }));
}

export function extractCollaboratorRows(
  characterMatrixRaw: string,
  limit: number,
  language: PlannerContextLanguage = "zh",
): string {
  return extractRowsByRelation(characterMatrixRaw, COLLABORATOR_PATTERNS, limit, localized(language, {
    zh: "（暂无明确协作者登场）",
    ko: "(이번 화에 확인된 주요 협력자 없음)",
    en: "(no clear collaborator for this chapter)",
  }));
}

function extractRowsByRelation(
  characterMatrixRaw: string,
  pattern: RegExp,
  limit: number,
  emptyText: string,
): string {
  const roleCards = parsePlannerRoleCards(characterMatrixRaw);
  if (roleCards.length > 0) {
    const protagonistCard = roleCards.find((card) => card.protagonist);
    if (!protagonistCard) return emptyText;
    const protagonistName = protagonistCard?.name ?? "";
    const protagonistAliases = deriveUniqueKoreanProtagonistAliases(
      protagonistName,
      roleCards.map((card) => card.name),
    );
    const matches = roleCards
      .filter((card) => card !== protagonistCard)
      .map((card) => ({
        card,
        evidence: relationEvidenceForRole(card, protagonistName, protagonistAliases),
      }))
      .filter(({ evidence }) => pattern.test(evidence))
      // A genuinely mixed current relation is supplied once, under the
      // collaborator/context section, instead of duplicating a whole card in
      // both opponent and collaborator prompt blocks.
      .filter(({ evidence }) => pattern !== OPPONENT_PATTERNS || !COLLABORATOR_PATTERNS.test(evidence))
      .slice(0, limit);
    if (matches.length === 0) return emptyText;
    return matches.map(({ card, evidence }) => renderPlannerRelationSummary(card, evidence)).join("\n");
  }

  const rows = parseMarkdownTableRows(characterMatrixRaw)
    .filter((row) => row.some((cell) => pattern.test(cell)))
    .filter((row) => !row.some((cell) => /^(主角|protagonist)$/i.test(cell.trim())))
    .slice(0, limit);
  if (rows.length === 0) {
    return emptyText;
  }
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

const RELEVANT_THREAD_STATUS_PATTERN = /activat|partial_payoff|pressured|near[_\s-]?payoff|推进|高压|open|progress/i;
const STALE_STATUS_PATTERN = /resolved|deferred|dormant|暂稳待续|暂挂|已回收/i;

export function extractRelevantThreads(
  pendingHooksRaw: string,
  subplotBoardRaw: string,
  language: PlannerContextLanguage = "zh",
): string {
  const hookRows = parseMarkdownTableRows(pendingHooksRaw)
    .filter((row) => !/^(hook_id)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const subplotRows = parseMarkdownTableRows(subplotBoardRaw)
    .filter((row) => !/^(id|subplot_id|subplot)$/i.test(row[0] ?? ""))
    .filter((row) => row.some((cell) => RELEVANT_THREAD_STATUS_PATTERN.test(cell)))
    .filter((row) => !row.some((cell) => STALE_STATUS_PATTERN.test(cell)))
    .map((row) => `- ${row[0]}: ${row.slice(1).filter(Boolean).join(" | ")}`);

  const lines = [...hookRows, ...subplotRows];
  if (lines.length === 0) {
    return localized(language, {
      zh: "（暂无活跃线索）",
      ko: "(현재 건드릴 수 있는 활성 복선이나 보조 줄기 없음)",
      en: "(no active hooks or subplots available)",
    });
  }
  return lines.join("\n");
}

/**
 * Phase 9-2: render stale-hook review candidates for the chapter memo.
 * These are already filtered by
 * computeRecyclableHooks; here we just format them for the prompt.
 *
 * Language switch mirrors the rest of the planner prompt: zh by default,
 * en for English books.
 */
export function formatRecyclableHooks(
  hooks: ReadonlyArray<StoredHook>,
  chapterNumber: number,
  language: PlannerContextLanguage = "zh",
): string {
  if (hooks.length === 0) {
    return localized(language, {
      zh: "（暂无陈旧 hook——账本干净）",
      ko: "(우선 검토할 묵은 복선 없음 — 장부가 깨끗함)",
      en: "(no stale hooks — the ledger is clean)",
    });
  }

  const topSlice = hooks.slice(0, 6);
  const lines = topSlice.map((hook) => {
    const lastTouch = Math.max(hook.startChapter, hook.lastAdvancedChapter);
    const silence = lastTouch <= 0 ? chapterNumber : Math.max(0, chapterNumber - lastTouch);
    const payoff = hook.expectedPayoff?.trim() || hook.notes?.trim() || "";
    const core = hook.coreHook === true
      ? localized(language, { zh: " [核心]", ko: " [핵심]", en: " [core]" })
      : "";
    if (language === "ko") {
      return `- ${hook.hookId} "${payoff}" — 상태=${hook.status}, ${silence}화 동안 진전 없음${core}`;
    }
    return language === "en"
      ? `- ${hook.hookId} "${payoff}" — status=${hook.status}, silent ${silence} ch${core}`
      : `- ${hook.hookId} "${payoff}" — 状态=${hook.status}，已沉默 ${silence} 章${core}`;
  });

  const header = localized(language, {
    zh: "以下是优先检视候选，不是场景配额。逐项选择 advance / resolve / defer；只有能强化本章当前任务与最强兑现的才推进，defer 时写理由和下一检查时点：",
    ko: "아래 항목은 우선 검토 후보이지 장면 할당량이 아닙니다. 현재 작업과 가장 강한 지급을 살릴 때만 advance / resolve하고, 아니면 이유와 다음 점검 시점을 적어 defer합니다:",
    en: "These are priority review candidates, not a scene quota. Classify each as advance / resolve / defer; advance only what strengthens the current task and strongest payoff, and give a reason plus next review point when deferring:",
  });
  return [header, ...lines].join("\n");
}
