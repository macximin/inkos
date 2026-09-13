import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthorCraftConfigSchema,
  AuthorCraftContextReceiptSchema,
  AuthorCraftPackSchema,
  AuthorCraftStageSchema,
  type AuthorCraftCase,
  type AuthorCraftConfig,
  type AuthorCraftContext,
  type AuthorCraftPack,
  type AuthorCraftPackReceipt,
  type AuthorCraftStage,
} from "../models/author-craft.js";
import { currentProductionInputBundle } from "../production/production-input.js";
import { estimateTextTokens } from "../llm/provider.js";
import { stripKoreanQueryExclusions } from "../utils/korean-query.js";

const MAX_PACK_BYTES = 384 * 1024;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function readAuthorCraftPackFile(path: string): Promise<{ pack: AuthorCraftPack; bytes: Buffer; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_PACK_BYTES) throw new Error("Author craft pack must be a regular file no larger than 384 KiB");
  const bytes = await readFile(path);
  if (bytes.length > MAX_PACK_BYTES || bytes.includes(0)) throw new Error("Invalid author craft pack bytes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { pack: AuthorCraftPackSchema.parse(JSON.parse(text)), bytes, sha256: sha256(bytes) };
}

export function authorCraftPackPath(projectRoot: string, packSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(packSha256)) throw new Error("Invalid author craft pack SHA-256");
  return join(projectRoot, ".inkos", "author-craft-packs", `${packSha256}.json`);
}

/** Import immutable advisory data only; does not activate a Book or write canon. */
export async function installAuthorCraftPack(projectRoot: string, sourcePath: string) {
  const loaded = await readAuthorCraftPackFile(sourcePath);
  const path = authorCraftPackPath(projectRoot, loaded.sha256);
  await mkdir(join(projectRoot, ".inkos", "author-craft-packs"), { recursive: true });
  try {
    await writeFile(path, loaded.bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (sha256(await readFile(path)) !== loaded.sha256) throw new Error("Installed author craft object has changed; refusing replacement");
  }
  return { packId: loaded.pack.id, packSha256: loaded.sha256, language: loaded.pack.language, path, caseIds: loaded.pack.cases.map((entry) => entry.id) };
}

export async function loadAuthorCraftPack(projectRoot: string, packSha256: string) {
  const loaded = await readAuthorCraftPackFile(authorCraftPackPath(projectRoot, packSha256));
  if (loaded.sha256 !== packSha256) throw new Error("Author craft pack SHA-256 mismatch");
  return loaded.pack;
}

function inputReceipt(pack: AuthorCraftPack, config: AuthorCraftConfig): AuthorCraftPackReceipt {
  return { packId: pack.id, packSha256: config.packSha256, language: pack.language, selectionSha256: sha256(JSON.stringify(AuthorCraftConfigSchema.parse(config))) };
}

export async function resolveAuthorCraftInputReceipt(projectRoot: string, config: AuthorCraftConfig | undefined, language: "ko" | "en" | "zh"): Promise<AuthorCraftPackReceipt | undefined> {
  if (!config) return undefined;
  const parsed = AuthorCraftConfigSchema.parse(config);
  const pack = await loadAuthorCraftPack(projectRoot, parsed.packSha256);
  if (pack.language !== language) throw new Error("Author craft pack language does not match the Book");
  return inputReceipt(pack, parsed);
}

export async function readBookAuthorCraftConfig(bookDir: string): Promise<AuthorCraftConfig | undefined> {
  let text: string;
  try { text = await readFile(join(bookDir, "book.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const config = JSON.parse(text)?.writing?.authorCraft;
  return config === undefined ? undefined : AuthorCraftConfigSchema.parse(config);
}

/** A sidecar records the exact advisory input without changing manuscript/canon. */
export async function recordAuthorCraftContext(bookDir: string, chapterNumber: number, context: AuthorCraftContext | null): Promise<string | undefined> {
  if (!context) return undefined;
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) throw new Error("Invalid author craft chapter number");
  validateAuthorCraftContext(context);
  const dir = join(bookDir, "story", "runtime", "author-craft");
  await mkdir(dir, { recursive: true });
  const receiptSha256 = sha256(JSON.stringify(context.receipt));
  const path = join(dir, `${chapterNumber}-${context.receipt.stage}-${receiptSha256}.json`);
  const text = `${JSON.stringify({ schemaVersion: "author-craft-context/v1", chapterNumber, ...context }, null, 2)}\n`;
  try { await writeFile(path, text, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== text) throw new Error("Author craft context receipt conflict");
  }
  return path;
}

function validateAuthorCraftContext(context: AuthorCraftContext): void {
  const receipt = AuthorCraftContextReceiptSchema.parse(context.receipt);
  if (typeof context.rendered !== "string" || context.rendered.length !== receipt.characters || sha256(context.rendered) !== receipt.renderedSha256) {
    throw new Error("Author craft rendered input does not match its receipt");
  }
  const ids = receipt.selectedCaseIds;
  if (new Set(ids).size !== ids.length || receipt.selectionReasons.length !== ids.length
    || receipt.selectionReasons.some((reason, index) => reason.caseId !== ids[index])
    || receipt.omittedCaseIds.some((id) => ids.includes(id))) throw new Error("Author craft selection receipt is inconsistent");
}

export interface AuthorCraftHistoryEntry {
  readonly path: string;
  readonly chapterNumber: number;
  readonly stage: AuthorCraftStage;
  readonly valid: boolean;
  readonly receipt?: AuthorCraftContext["receipt"];
  readonly error?: string;
}

/** Inspect local selection evidence without exposing rendered sources or changing files. */
export async function readAuthorCraftHistory(bookDir: string, options: { chapterNumber?: number; stage?: AuthorCraftStage } = {}): Promise<AuthorCraftHistoryEntry[]> {
  if (options.chapterNumber !== undefined && (!Number.isSafeInteger(options.chapterNumber) || options.chapterNumber < 1)) throw new Error("Invalid author craft chapter number");
  if (options.stage !== undefined) AuthorCraftStageSchema.parse(options.stage);
  const dir = join(bookDir, "story", "runtime", "author-craft");
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries: AuthorCraftHistoryEntry[] = [];
  for (const name of names.sort()) {
    const match = name.match(/^(\d+)-(planning|writing|revision)-([a-f0-9]{64})\.json$/);
    if (!match) continue;
    const chapterNumber = Number(match[1]), stage = AuthorCraftStageSchema.parse(match[2]);
    if (options.chapterNumber !== undefined && options.chapterNumber !== chapterNumber) continue;
    if (options.stage !== undefined && options.stage !== stage) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 256 * 1024) throw new Error("Invalid author craft receipt file size");
      const bytes = await readFile(path);
      if (bytes.length > 256 * 1024) throw new Error("Invalid author craft receipt file size");
      let stored;
      try { stored = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); }
      catch { throw new Error("Author craft receipt is not valid UTF-8 JSON"); }
      if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1 || stored.schemaVersion !== "author-craft-context/v1" || stored.chapterNumber !== chapterNumber
        || stored.receipt?.stage !== stage || sha256(JSON.stringify(stored.receipt)) !== match[3]) throw new Error("Author craft receipt identity mismatch");
      validateAuthorCraftContext(stored);
      entries.push({ path, chapterNumber, stage, valid: true, receipt: stored.receipt });
    } catch (error) {
      entries.push({ path, chapterNumber, stage, valid: false, error: error instanceof Error ? error.message.slice(0, 240) : "Invalid author craft receipt" });
    }
  }
  return entries.sort((a, b) => b.chapterNumber - a.chapterNumber || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function terms(query: string): string[] {
  return [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => term.length > 1);
}

function meaningfulCraftQuery(query: string): string {
  const label = /^(?:(?:회차|이번\s*화|이번|현재|Chapter|Current|Scene|本章)\s*)?(?:목표|의도|장면|계획|시점|메모|Goal|Intent|Scene|Plan|POV|Memo|目标|意图|场景|计划)\s*[:：]?\s*$/i;
  return stripKoreanQueryExclusions(query).split("\n").map((line) => {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading && label.test(heading[1]!.replace(/[*`]/g, ""))) return "";
    return line;
  }).join("\n").normalize("NFKC").toLowerCase();
}

function triggerMatches(query: string, trigger: string): boolean {
  if (/^[a-z][a-z\s'-]*$/.test(trigger)) {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "u").test(query);
  }
  if (/^[가-힣]$/.test(trigger)) {
    return (query.match(/[가-힣]+/g) ?? []).some((word) => word === trigger
      || (word.startsWith(trigger) && /^(?:은|는|이|가|을|를|의|도|만|으로|부터|까지|보다|처럼)$/.test(word.slice(1))));
  }
  return query.includes(trigger);
}

function scoreCase(entry: AuthorCraftCase, query: string, queryTerms: ReadonlyArray<string>): number {
  const normalizedQuery = meaningfulCraftQuery(query);
  const generic = new Set(["기획", "목표", "장면", "설명", "생각", "독자", "인물", "사건", "원고", "전개", "판단", "반복"]);
  let score = 0;
  let anchored = false;
  for (const trigger of entry.triggers) {
    const normalized = trigger.normalize("NFKC").toLowerCase();
    if (triggerMatches(normalizedQuery, normalized)) { score += generic.has(normalized) ? 2 : 8; anchored = true; }
  }
  if (normalizedQuery.includes(entry.title.normalize("NFKC").toLowerCase())
    || entry.functions.some((value) => normalizedQuery.includes(value.normalize("NFKC").toLowerCase()))) { score += 8; anchored = true; }
  // A common word in a title alone (e.g. "different") is not a scene problem.
  if (!anchored) return 0;
  const relevant = [entry.title, ...entry.functions, ...entry.triggers].join(" ").normalize("NFKC").toLowerCase();
  for (const term of queryTerms) if (relevant.includes(term)) score += 2;
  return score;
}

function renderCase(entry: AuthorCraftCase, pack: AuthorCraftPack): string {
  const sources = entry.sourceIds.map((id) => pack.sources.find((source) => source.id === id)!);
  const labels = craftLabels(pack.language);
  return [
    `### ${entry.title} [${entry.id}]`,
    entry.observation,
    `${labels.method}: ${entry.method}`,
    ...entry.preserve.map((item) => `${labels.preserve}: ${item}`),
    ...entry.counterexamples.map((item) => `${labels.counterexample}: ${item}`),
    ...sources.map((source) => `${labels.source} ${source.id}: ${source.title} — ${source.readingScope}`),
  ].join("\n");
}

function craftLabels(language: AuthorCraftPack["language"]) {
  if (language === "ko") return {
    heading: "선택한 작법 참고", method: "적용할 선택", preserve: "보존", counterexample: "적용하지 않을 경우", source: "근거",
    authority: "아래는 장면 선택을 돕는 참고 자료다. 작품의 사실·인물 지식·필수 규칙·출력 승인으로 사용하지 않는다.",
    application: "해당 문제에 맞는 부분만 사용한다. 표·카드·분석 용어를 원고에 출력하거나 모든 항목을 충족하려고 장면을 늘리지 않는다.",
    stage: "단계", pack: "자료",
  };
  if (language === "en") return {
    heading: "Selected craft references", method: "Possible choice", preserve: "Preserve", counterexample: "When not to apply", source: "Source",
    authority: "These references support scene choices. They do not establish story facts, character knowledge, mandatory rules or approval.",
    application: "Use only what fits the current problem. Do not print cards or analytical labels in prose, or add scenes to satisfy every item.",
    stage: "Stage", pack: "Pack",
  };
  return {
    heading: "已选写作参考", method: "可选做法", preserve: "保留", counterexample: "不适用的情况", source: "依据",
    authority: "以下资料帮助选择场景，不确立故事事实、人物所知、强制规则或输出批准。",
    application: "只采用适合当前问题的部分。不要在正文输出卡片或分析标签，也不要为填满项目而增加场景。",
    stage: "阶段", pack: "资料",
  };
}

/** Reserve existing input and output first; a small context window can omit all cases. */
export function availableAuthorCraftTokens(input: { contextWindow?: number; outputTokens: number; reservedText: string; extraReserve?: number }): number | undefined {
  if (input.contextWindow === undefined) return undefined;
  if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0) return undefined;
  return Math.max(0, Math.floor(input.contextWindow) - Math.max(0, Math.ceil(input.outputTokens))
    - estimateTextTokens(input.reservedText) - Math.max(128, input.extraReserve ?? 128));
}

/** Pure, deterministic selection. An unrelated query selects nothing. */
export function selectAuthorCraftContext(input: {
  readonly pack: AuthorCraftPack;
  readonly config: AuthorCraftConfig;
  readonly stage: AuthorCraftStage;
  readonly query: string;
  readonly maxContextTokens?: number;
}): AuthorCraftContext {
  const config = AuthorCraftConfigSchema.parse(input.config);
  const pack = AuthorCraftPackSchema.parse(input.pack);
  AuthorCraftStageSchema.parse(input.stage);
  if (input.maxContextTokens !== undefined && (!Number.isSafeInteger(input.maxContextTokens) || input.maxContextTokens < 0)) throw new Error("Invalid author craft token budget");
  const known = new Set(pack.cases.map((entry) => entry.id));
  for (const id of config.caseIds ?? []) if (!known.has(id)) throw new Error(`Unknown author craft case: ${id}`);
  const explicit = config.caseIds === undefined ? undefined : new Set(config.caseIds);
  const queryTerms = terms(meaningfulCraftQuery(input.query));
  const ranked = pack.cases
    .filter((entry) => entry.stages.includes(input.stage) && (!explicit || explicit.has(entry.id)))
    .map((entry) => ({ entry, score: scoreCase(entry, input.query, queryTerms) }))
    .filter(({ score }) => explicit !== undefined || score > 0)
    .sort((left, right) => right.score - left.score || (left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0));
  const labels = craftLabels(pack.language);
  const header = [
    `## ${labels.heading}`,
    labels.authority,
    labels.application,
    `${labels.stage}: ${input.stage}; ${labels.pack}: ${pack.id}`,
  ].join("\n");
  const selected: AuthorCraftCase[] = [];
  const blocks: string[] = [];
  const omitted: string[] = [];
  for (const { entry } of ranked) {
    const block = renderCase(entry, pack);
    const candidate = [header, ...blocks, block].join("\n\n");
    if (selected.length >= config.maxCases || candidate.length > config.maxCharacters
      || (input.maxContextTokens !== undefined && estimateTextTokens(candidate) > input.maxContextTokens)) { omitted.push(entry.id); continue; }
    selected.push(entry);
    blocks.push(block);
  }
  // No header-only injection: disabled/unmatched input remains empty.
  const rendered = blocks.length > 0 ? [header, ...blocks].join("\n\n") : "";
  return {
    rendered,
    receipt: {
      ...inputReceipt(pack, config),
      stage: input.stage,
      selectedCaseIds: selected.map((entry) => entry.id),
      sourceIds: [...new Set(selected.flatMap((entry) => entry.sourceIds))].sort(),
      characters: rendered.length,
      renderedSha256: sha256(rendered),
      omittedCaseIds: omitted,
      querySha256: sha256(input.query),
      estimatedTokens: estimateTextTokens(rendered),
      selectionReasons: selected.map((entry) => ({ caseId: entry.id, score: scoreCase(entry, input.query, queryTerms), reason: explicit === undefined ? "query-match" : "explicit" })),
      ...(input.maxContextTokens === undefined ? {} : { tokenBudget: input.maxContextTokens }),
    },
  };
}

export async function resolveAuthorCraftContext(input: {
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly config?: AuthorCraftConfig;
  readonly language: "ko" | "en" | "zh";
  readonly stage: AuthorCraftStage;
  readonly query: string;
  readonly maxContextTokens?: number;
}): Promise<AuthorCraftContext | null> {
  const bundle = currentProductionInputBundle();
  if (bundle && input.bookId !== bundle.bookId) throw new Error("Author craft context belongs to a different production Book");
  if (!input.config) {
    if (bundle?.receipt.authorCraft) throw new Error("Production author craft configuration disappeared");
    return null;
  }
  const config = AuthorCraftConfigSchema.parse(input.config);
  const pack = await loadAuthorCraftPack(input.projectRoot, config.packSha256);
  if (pack.language !== input.language) throw new Error("Author craft pack language does not match the Book");
  if (bundle && JSON.stringify(bundle.receipt.authorCraft) !== JSON.stringify(inputReceipt(pack, config))) throw new Error("Author craft input changed after production admission");
  return selectAuthorCraftContext({ pack, config, stage: input.stage, query: input.query, maxContextTokens: input.maxContextTokens });
}
