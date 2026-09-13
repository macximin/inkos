import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
import { extractKoreanQueryTerms } from "../utils/korean-query.js";
import {
  CurrentStateStateSchema,
  RuntimeStateDeltaSchema,
  type RuntimeStateDelta,
  type StoredEntityObservation,
} from "../models/runtime-state.js";

export const ENTITY_OBSERVATION_CONTEXT_SOURCE = "story/state/current_state.json#entity-observations";

/** Observations attest literal mentions; they do not establish canonical identities or aliases. */
export function validateEntityObservations(
  delta: Pick<RuntimeStateDelta, "chapter" | "entityObservations">,
  chapterText?: string,
): StoredEntityObservation[] {
  const parsed = RuntimeStateDeltaSchema.parse(delta);
  const observations = parsed.entityObservations ?? [];
  if (observations.length === 0) return [];
  if (typeof chapterText !== "string") throw new Error("Entity observations require the chapter text");
  const chapterTextHash = createHash("sha256").update(chapterText, "utf8").digest("hex");
  return observations.map((observation, index) => {
    if (!chapterText.includes(observation.evidence)) {
      throw new Error(`Entity observation ${index} evidence is not an exact chapter quotation`);
    }
    if (!observation.evidence.includes(observation.name)) {
      throw new Error(`Entity observation ${index} name is absent from its evidence`);
    }
    return { ...observation, sourceChapter: parsed.chapter, chapterTextHash };
  });
}

/** Read only; never bootstrap state, infer identities, or truncate an evidence quotation. */
export async function readEntityObservationContext(
  bookDir: string,
  options: {
    readonly throughChapter: number;
    readonly query?: string;
    readonly maxChars?: number;
    readonly maxContextTokens?: number;
    readonly language?: "zh" | "ko" | "en";
    readonly povCharacter?: string;
  },
): Promise<string> {
  if (!Number.isSafeInteger(options.throughChapter) || options.throughChapter < 0) {
    throw new Error("Entity observation context requires a nonnegative throughChapter");
  }
  const maxChars = options.maxChars ?? 6000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) throw new Error("Invalid entity observation character budget");
  const maxTokens = options.maxContextTokens;
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0)) {
    throw new Error("Invalid entity observation token budget");
  }
  let raw: string;
  try {
    raw = await readFile(join(bookDir, "story", "state", "current_state.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  const state = CurrentStateStateSchema.parse(JSON.parse(raw));
  const query = (options.query ?? "").normalize("NFKC").trim().toLowerCase();
  const queryTerms = [...new Set([...extractKoreanQueryTerms(query), ...(query.match(/[a-z]{4,}/gi) ?? [])])];
  const matchesQuery = (entry: StoredEntityObservation) => {
    const name = entry.name.normalize("NFKC").toLowerCase();
    return query.length > 0 && (query.includes(name) || name.includes(query));
  };
  const rankedObservations = (state.entityObservations ?? [])
    .filter((entry) => entry.sourceChapter <= options.throughChapter)
    .filter((entry) => !options.povCharacter?.trim() || !entry.perspective || entry.name === options.povCharacter.trim())
    .sort((left, right) => Number(matchesQuery(right)) - Number(matchesQuery(left))
      || perspectiveRelevance(right, queryTerms) - perspectiveRelevance(left, queryTerms)
      || right.sourceChapter - left.sourceChapter);
  // A strong lexical match can otherwise keep repeating an old belief while
  // omitting that person's newer belief. Include the latest same-category record
  // first; preserve both dates and do not infer that one proposition refutes another.
  const observations = withLatestPerspectiveCompanions(rankedObservations);
  const language = options.language ?? "ko";
  const labels = language === "ko" ? {
    heading: "본문에서 확인된 인물·조직 기록",
    explanation: `${options.throughChapter}화까지 본문의 서술 근거입니다. 각 기록은 출처 회차 시점의 관찰이며 현재 상태를 보장하지 않습니다. 인용은 정본 설정·규칙·인물이 아는 사실의 확정이 아닙니다. 같은 종류·이름도 관찰 표시이며 동일 인물·조직이나 별칭 관계를 확정하지 않습니다.`,
    person: "인물", organization: "조직", chapter: (value: number) => `${value}화`,
  } : language === "en" ? {
    heading: "People and organizations observed in the manuscript",
    explanation: `Narrative evidence through chapter ${options.throughChapter}. Each record is an observation at its source chapter, not a guarantee of current state, established canon, rules, or character knowledge. Matching kind and name label observations; they do not establish a shared identity or alias.`,
    person: "Person", organization: "Organization", chapter: (value: number) => `Chapter ${value}`,
  } : {
    heading: "正文中出现的人物与组织记录",
    explanation: `截至第${options.throughChapter}章的叙事证据。每条记录只代表来源章节当时的观察，不保证当前状态，也不自动确立正史设定、规则或人物所知。相同类别和名称只是观察标签，不能据此认定同一身份或别名关系。`,
    person: "人物", organization: "组织", chapter: (value: number) => `第${value}章`,
  };
  const hasPerspective = observations.some((entry) => entry.perspective !== undefined);
  const perspectiveExplanation = !hasPerspective ? "" : language === "ko"
    ? " 믿음·욕망·의도는 그 인물의 당시 관점이며 사실의 진위와 구분합니다. 과거 경험은 지금의 선택에 관련 있을 때만 쓰고, 상반된 최신 근거가 있으면 함께 고려합니다. 분류 자체는 자동 추출이며 인용 밖의 심리를 보충하지 않습니다."
    : language === "en"
      ? " Beliefs, desires and intentions are that character's perspective at the time, separate from objective truth. Use relevant experiences without inventing psychology; consider later contradictory evidence. Perspective labels are automatic classifications of the quotation."
      : " 信念、欲望和意图只表示人物当时的视角，不代表客观真相。只使用与当前选择有关的经历，并考虑后来的相反证据；不要补写引文没有的心理。视角标签是自动分类。";
  const heading = `## ${labels.heading}\n\n${labels.explanation}${perspectiveExplanation}`;
  let context = heading;
  let selected = 0;
  for (const observation of observations) {
    const kind = observation.kind === "person" ? labels.person : labels.organization;
    const perspective = observation.perspective ? ` · ${perspectiveLabel(observation.perspective, language)}` : "";
    const block = `\n\n[${kind}] ${observation.name} · ${labels.chapter(observation.sourceChapter)}${perspective}\n`
      + observation.evidence.split("\n").map((line) => `> ${line}`).join("\n");
    if (context.length + block.length > maxChars) continue;
    const candidate = context + block;
    if (maxTokens !== undefined && estimateTextTokens(candidate) > maxTokens) continue;
    context = candidate;
    selected += 1;
  }
  return selected > 0 ? context : "";
}

function perspectiveRelevance(observation: StoredEntityObservation, terms: string[]): number {
  if (!observation.perspective) return 0;
  const evidence = observation.evidence.normalize("NFKC").toLowerCase();
  return terms.reduce((score, term) => score + Number(evidence.includes(term.toLowerCase())), 0);
}

function withLatestPerspectiveCompanions(ranked: ReadonlyArray<StoredEntityObservation>): StoredEntityObservation[] {
  const latest = new Map<string, StoredEntityObservation>();
  const key = (entry: StoredEntityObservation) => JSON.stringify([entry.name, entry.perspective]);
  const canChange = (entry: StoredEntityObservation) => entry.perspective === "belief" || entry.perspective === "desire" || entry.perspective === "intention";
  for (const entry of ranked) {
    if (!canChange(entry)) continue;
    const previous = latest.get(key(entry));
    if (!previous || entry.sourceChapter > previous.sourceChapter) latest.set(key(entry), entry);
  }
  const ordered: StoredEntityObservation[] = [];
  const seen = new Set<StoredEntityObservation>();
  for (const entry of ranked) {
    const companion = canChange(entry) ? latest.get(key(entry)) : undefined;
    for (const candidate of companion ? [companion, entry] : [entry]) {
      if (!seen.has(candidate)) { ordered.push(candidate); seen.add(candidate); }
    }
  }
  return ordered;
}

function perspectiveLabel(kind: NonNullable<StoredEntityObservation["perspective"]>, language: "zh" | "ko" | "en"): string {
  const labels = {
    ko: { belief: "믿음·오해", desire: "욕망", intention: "행동 의도", experience: "경험", "public-claim": "겉으로 한 말" },
    en: { belief: "Belief", desire: "Desire", intention: "Intention", experience: "Experience", "public-claim": "Public claim" },
    zh: { belief: "信念", desire: "欲望", intention: "行动意图", experience: "经历", "public-claim": "公开说法" },
  };
  return labels[language][kind];
}
