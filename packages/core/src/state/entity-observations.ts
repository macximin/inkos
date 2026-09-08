import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
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
  const query = (options.query ?? "").trim().toLocaleLowerCase();
  const matchesQuery = (entry: StoredEntityObservation) => {
    const name = entry.name.toLocaleLowerCase();
    return query.length > 0 && (query.includes(name) || name.includes(query));
  };
  const observations = (state.entityObservations ?? [])
    .filter((entry) => entry.sourceChapter <= options.throughChapter)
    .sort((left, right) => Number(matchesQuery(right)) - Number(matchesQuery(left))
      || right.sourceChapter - left.sourceChapter);
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
  const heading = `## ${labels.heading}\n\n${labels.explanation}`;
  let context = heading;
  let selected = 0;
  for (const observation of observations) {
    const kind = observation.kind === "person" ? labels.person : labels.organization;
    const block = `\n\n[${kind}] ${observation.name} · ${labels.chapter(observation.sourceChapter)}\n`
      + observation.evidence.split("\n").map((line) => `> ${line}`).join("\n");
    if (context.length + block.length > maxChars) continue;
    const candidate = context + block;
    if (maxTokens !== undefined && estimateTextTokens(candidate) > maxTokens) continue;
    context = candidate;
    selected += 1;
  }
  return selected > 0 ? context : "";
}
