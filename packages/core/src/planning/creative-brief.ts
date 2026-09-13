import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
import { isSafeBookId } from "../utils/book-id.js";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";
import {
  CREATIVE_BRIEF_DOCUMENT_PATHS, CREATIVE_BRIEF_SOURCES_PATH,
  CreativeBriefCategorySchema, CreativeBriefSourcesSchema,
  type BookCreativeBrief, type BookCreativeBriefContext, type BookCreativeBriefReceipt,
  type CreativeBriefCategory, type CreativeBriefChapterScope, type CreativeBriefEntry,
  type CreativeBriefSourceReceipt, type CreativeBriefSources,
} from "../models/creative-brief.js";

const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const MAX_FILE_BYTES = 512 * 1024;
const MAX_QUOTE_BYTES = 12 * 1024;
const CATEGORIES = CreativeBriefCategorySchema.options;
type Language = "ko" | "en" | "zh";
type ReadResult = { status: "current"; bytes: Buffer; sha256: string } | { status: "missing" | "unreadable" | "invalid" };

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Bound files are local Book inputs. Missing private evidence is a status, not a new HIL task. */
async function readLocalSource(bookDir: string, path: string): Promise<ReadResult> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((part) => !part || part === "." || part === "..")) return { status: "invalid" };
  try {
    const root = await realpath(bookDir);
    const actual = await realpath(resolve(root, path));
    if (!inside(root, actual)) return { status: "invalid" };
    const info = await stat(actual);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return { status: "unreadable" };
    const bytes = await readFile(actual);
    if (bytes.length > MAX_FILE_BYTES) return { status: "unreadable" };
    // Preserve the original BOM and line endings for all exact quote coordinates.
    new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (bytes.includes(0)) return { status: "invalid" };
    return { status: "current", bytes, sha256: hash(bytes) };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function scopeStatus(scope: CreativeBriefChapterScope | undefined, chapterNumber: number | undefined):
  "current" | "out-of-scope" | "scope-unresolved" {
  if (!scope || (scope.fromChapter === undefined && scope.throughChapter === undefined)) return "current";
  if (chapterNumber === undefined) return "scope-unresolved";
  return (scope.fromChapter !== undefined && chapterNumber < scope.fromChapter)
    || (scope.throughChapter !== undefined && chapterNumber > scope.throughChapter) ? "out-of-scope" : "current";
}

function categoryOf(value: string): CreativeBriefCategory | undefined {
  const label = value.normalize("NFKC").replace(/[*_`]/gu, "").trim().toLowerCase();
  const groups: ReadonlyArray<[CreativeBriefCategory, RegExp]> = [
    ["reader-promise", /^(?:독자\s*약속|독자에게\s*(?:줄|보여\s*줄)\s*(?:즐거움|순간)|반복\s*쾌감|reader\s*promise|reader\s*pleasure|读者承诺|读者爽点)$/u],
    ["personal-desire", /^(?:주인공의?\s*(?:사적\s*)?욕망|사적\s*욕망|personal\s*desire|protagonist(?:'s)?\s*desire|主角欲望|私人欲望)$/u],
    ["preference", /^(?:선호|좋아하는\s*것|보고\s*싶은\s*(?:것|순간)|preferences?|wanted\s*moments?|偏好|想看的内容)$/u],
    ["avoid", /^(?:피할\s*것|피해야\s*할\s*것|금지|비선호|싫어하는\s*것|avoid|must\s*avoid|do\s*not|禁忌|避免)$/u],
    ["preserve", /^(?:보존할\s*것|유지할\s*것|지킬\s*것|반드시\s*유지|preserve|must\s*keep|keep|保留|必须保留)$/u],
    ["voice", /^(?:목소리|문체|유지할\s*목소리|voice|style|文风|声音)$/u],
    ["current-focus", /^(?:현재\s*집중점|이번\s*집중점|우선\s*전개|current\s*focus|active\s*focus|当前聚焦|当前重点)$/u],
    ["direction", /^(?:작가\s*의도|작품\s*의도|창작\s*방향|author\s*intent|creative\s*direction|作者意图|创作方向)$/u],
  ];
  return groups.find(([, pattern]) => pattern.test(label))?.[0];
}

function isPlaceholder(value: string): boolean {
  const text = value.replace(/^[-*+]\s+/u, "").trim();
  return !text || /^(?:\(?\s*(?:미정|없음|해당\s*없음|기입|tbd|todo|n\/a|none|未定|暂无)\s*\)?\.?|\[[^\]]{0,100}\])$/iu.test(text)
    || /^\((?:이 작품의 장기 창작 방향을 적으세요\.|앞으로 1-3화에서 가장 먼저 진행할 내용을 적으세요\.|Describe the (?:long-horizon vision for this book here|next 1-3 chapters.*)\.|Describe what the next 1-3 chapters should prioritize\.)\)$/u.test(text)
    || /^（(?:在这里描述这本书的长期创作方向。|描述接下来 1-3 章最需要优先推进的内容。)）$/u.test(text);
}

function entryFor(source: CreativeBriefSourceReceipt, category: CreativeBriefCategory,
  bytes: Buffer, start: number, end: number): CreativeBriefEntry | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
    || end > bytes.length || end - start > MAX_QUOTE_BYTES || !source.sha256 || source.kind === "source-manifest") return null;
  let quote: string;
  try { quote = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end)); }
  catch { return null; }
  if (!quote.trim() || isPlaceholder(quote)) return null;
  const quoteSha256 = hash(quote);
  const id = `brief:${hash(JSON.stringify([source.id, source.sha256, category, start, end, quoteSha256])).slice(0, 32)}`;
  return { id, category, quote, sourceId: source.id, sourceKind: source.kind, path: source.path,
    sourceSha256: source.sha256, coordinate: "original-utf8-byte", start, end, quoteSha256,
    ...(source.scope ? { scope: source.scope } : {}), authority: "advisory" };
}

/** Classify only explicit labels. Unlabelled author/focus paragraphs retain generic direction scope. */
export function projectCreativeBriefDocument(source: CreativeBriefSourceReceipt, bytes: Buffer):
  { entries: CreativeBriefEntry[]; omitted: BookCreativeBrief["omitted"] } {
  const entries: CreativeBriefEntry[] = [], omitted: Array<{ sourceId: string; reason: string }> = [];
  const text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const fallback: CreativeBriefCategory | undefined = source.path === "story/author_intent.md" ? "direction"
    : source.path === "story/current_focus.md" ? "current-focus" : undefined;
  const stack: Array<{ level: number; category?: CreativeBriefCategory; reference: boolean }> = [];
  let offset = 0, fence: string | undefined, comment = false, frontmatter = false;
  for (const [index, physical] of (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? []).entries()) {
    const line = physical.replace(/\r?\n$|\r$/u, "");
    const start = offset;
    offset += Buffer.byteLength(physical);
    const clean = line.replace(/^\uFEFF/u, "").trim();
    if (index === 0 && clean === "---") { frontmatter = true; continue; }
    if (frontmatter) { if (clean === "---" || clean === "...") frontmatter = false; continue; }
    if (clean.includes("<!--")) comment = true;
    if (comment) { if (clean.includes("-->")) comment = false; continue; }
    const delimiter = /^(`{3,}|~{3,})/u.exec(clean)?.[1];
    if (delimiter) { if (!fence) fence = delimiter; else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined; continue; }
    if (fence || !clean || /^[-*_]{3,}$/u.test(clean)) continue;
    const heading = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/u.exec(clean);
    if (heading) {
      const level = heading[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, category: categoryOf(heading[2]!), reference: /^(?:참고(?:\s*작품|작품?|자료|\s*사례|\s*분석)?|원작(?:\s*분석|\s*참조|\s*발췌)?|작품\s*분석|시장\s*(?:신호|관측)|예시|references?|reference\s*(?:analysis|work|notes)|examples?|market\s*signal|参考作品|原作分析)(?:\s|[:：]|$)/iu.test(heading[2]!.trim()) });
      continue;
    }
    // A quoted novel paragraph is not an explicit preference statement.
    if (/^>/u.test(clean) || stack.some((section) => section.reference)) continue;
    const labelled = /^(?:[-*+]\s+)?(?:\*\*)?([^:：]{1,60}?)(?:\*\*)?\s*[:：]\s*(.+)$/u.exec(clean);
    const inlineCategory = labelled ? categoryOf(labelled[1]!) : undefined;
    if (inlineCategory && isPlaceholder(labelled![2]!)) continue;
    const category = inlineCategory ?? [...stack].reverse().find((section) => section.category)?.category ?? fallback;
    if (!category || isPlaceholder(clean)) continue;
    const entry = entryFor(source, category, bytes, start, start + Buffer.byteLength(line));
    if (entry) entries.push(entry);
    else omitted.push({ sourceId: source.id, reason: "empty-placeholder-or-whole-quote-size-limit" });
    if (entries.length >= 128) { omitted.push({ sourceId: source.id, reason: "document-entry-count-limit" }); break; }
  }
  return { entries, omitted };
}

export async function readBookCreativeBrief(input: {
  readonly bookDir: string; readonly bookId: string; readonly chapterNumber?: number;
  readonly previousReceipt?: BookCreativeBriefReceipt;
}): Promise<BookCreativeBrief> {
  if (!isSafeBookId(input.bookId)) {
    const empty = { schemaVersion: "book-creative-brief/v1" as const, bookId: typeof input.bookId === "string" ? input.bookId : "",
      authority: "advisory" as const, entries: [], unknownCategories: [...CATEGORIES], sources: [],
      omitted: [{ sourceId: "book", reason: "invalid-book-id" }] };
    return { ...empty, projectionSha256: hash(JSON.stringify(empty)) };
  }
  if (input.chapterNumber !== undefined && (!Number.isSafeInteger(input.chapterNumber) || input.chapterNumber < 1)) throw new Error("Invalid creative brief chapter number");
  if (input.previousReceipt && input.previousReceipt.bookId !== input.bookId) throw new Error("Previous creative brief belongs to another Book");
  const sources: CreativeBriefSourceReceipt[] = [], entries: CreativeBriefEntry[] = [];
  const omitted: Array<{ sourceId: string; entryId?: string; reason: string }> = [];
  const previous = new Map(input.previousReceipt?.sources.map((source) => [source.id, source]));
  const record = (value: Omit<CreativeBriefSourceReceipt, "change">): CreativeBriefSourceReceipt => {
    const before = previous.get(value.id);
    const source: CreativeBriefSourceReceipt = { ...value, change: !input.previousReceipt ? "not-compared" : !before ? "added"
      : before.sha256 === value.sha256 && before.status === value.status && before.path === value.path ? "unchanged" : "changed" };
    sources.push(source);
    return source;
  };
  const manifestRead = await readLocalSource(input.bookDir, CREATIVE_BRIEF_SOURCES_PATH);
  let manifest: CreativeBriefSources | undefined;
  let manifestStatus: CreativeBriefSourceReceipt["status"] = manifestRead.status;
  if (manifestRead.status === "current") {
    try {
      const parsed = CreativeBriefSourcesSchema.parse(JSON.parse(manifestRead.bytes.toString("utf8")));
      if (parsed.bookId !== input.bookId) throw new Error("wrong-book");
      manifest = parsed;
    } catch { manifestStatus = "invalid"; }
  }
  record({ id: "source-manifest", path: CREATIVE_BRIEF_SOURCES_PATH, kind: "source-manifest", status: manifestStatus,
    ...(manifestRead.status === "current" ? { sha256: manifestRead.sha256 } : {}) });
  if (manifestStatus === "invalid" || manifestStatus === "unreadable") {
    // Unknown scopes could otherwise reactivate old current_focus statements.
    omitted.push({ sourceId: "source-manifest", reason: "invalid-source-manifest-no-directives-projected" });
  } else {
    for (const path of CREATIVE_BRIEF_DOCUMENT_PATHS) {
      const read = await readLocalSource(input.bookDir, path);
      const declared = manifest?.documentScopes.find((scope) => scope.path === path);
      const status = read.status !== "current" ? read.status : declared && read.sha256 !== declared.sha256 ? "stale"
        : scopeStatus(declared?.scope, input.chapterNumber);
      const source = record({ id: path, path, kind: "book-direction-document", status,
        ...(read.status === "current" ? { sha256: read.sha256 } : {}),
        ...(declared ? { expectedSha256: declared.sha256, scope: declared.scope } : {}) });
      if (status !== "current" || read.status !== "current") continue;
      const result = projectCreativeBriefDocument(source, read.bytes);
      entries.push(...result.entries); omitted.push(...result.omitted);
    }
    for (const binding of manifest?.sources ?? []) {
      const read = await readLocalSource(input.bookDir, binding.path);
      let status: CreativeBriefSourceReceipt["status"] = read.status !== "current" ? read.status : read.sha256 !== binding.sha256 ? "stale"
        : scopeStatus(binding.scope, input.chapterNumber);
      const pending: CreativeBriefEntry[] = [];
      const reviewedText: NonNullable<CreativeBriefEntry["reviewedText"]>[number][] = [];
      for (const [index, target] of (binding.reviewedText ?? []).entries()) {
        const body = await readLocalSource(input.bookDir, target.path);
        let bodyStatus: CreativeBriefSourceReceipt["status"] = body.status !== "current" ? body.status
          : body.sha256 !== target.sha256 ? "stale" : "current";
        let quote: string | undefined;
        if (body.status === "current" && bodyStatus === "current") {
          try {
            if (target.end > body.bytes.length || target.end - target.start > MAX_QUOTE_BYTES) throw new Error("range");
            quote = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(body.bytes.subarray(target.start, target.end));
            if (!quote.trim() || hash(quote) !== target.quoteSha256) throw new Error("quote");
          } catch { bodyStatus = "invalid"; }
        }
        record({ id: `${binding.id}#reviewed-${index}`, path: target.path, kind: binding.kind,
          status: bodyStatus, expectedSha256: target.sha256,
          ...(body.status === "current" ? { sha256: body.sha256 } : {}) });
        if (bodyStatus !== "current") status = "invalid";
        else if (quote !== undefined) reviewedText.push({ quote, path: target.path, sourceSha256: target.sha256,
          start: target.start, end: target.end, quoteSha256: target.quoteSha256 });
      }
      if (status === "current" && read.status === "current") {
        const candidate = { id: binding.id, path: binding.path, kind: binding.kind, status,
          sha256: read.sha256, scope: binding.scope, change: "not-compared" } as const;
        for (const selection of binding.selections) {
          const entry = entryFor(candidate, selection.category, read.bytes, selection.start, selection.end);
          if (!entry || entry.quoteSha256 !== selection.quoteSha256) { status = "invalid"; break; }
          pending.push(reviewedText.length ? { ...entry, reviewedText,
            id: `brief:${hash(JSON.stringify([entry.id, reviewedText])).slice(0, 32)}` } : entry);
        }
      }
      record({ id: binding.id, path: binding.path, kind: binding.kind, status, expectedSha256: binding.sha256,
        ...(read.status === "current" ? { sha256: read.sha256 } : {}), ...(binding.scope ? { scope: binding.scope } : {}) });
      if (status === "current") entries.push(...pending);
      else omitted.push({ sourceId: binding.id, reason: status });
    }
  }
  const body = { schemaVersion: "book-creative-brief/v1" as const, bookId: input.bookId,
    ...(input.chapterNumber === undefined ? {} : { chapterNumber: input.chapterNumber }), authority: "advisory" as const,
    entries, unknownCategories: CATEGORIES.filter((category) => !entries.some((entry) => entry.category === category
      && entry.sourceKind !== "reference-analysis")), sources, omitted };
  // Change annotations depend on the optional comparison, not the underlying projection identity.
  const identity = { ...body, sources: sources.map(({ change: _change, ...source }) => source) };
  return { ...body, projectionSha256: hash(JSON.stringify(identity)) };
}

const HEADERS: Record<Language, string> = {
  ko: "## 작품별 창작 의도 — 출처가 있는 참고\n아래는 현재 Book 문서와 검증한 구간의 정확한 인용이다. 문서에 적힌 취향과 참고작 분석을 구별하며, 인용만으로 사람의 승인이나 강제 규칙을 추정하지 않는다. 기존 verified Book rules는 별도로 적용한다. 이 자료를 mustAvoid·자동 감사·수정 명령으로 승격하지 않는다. 서로 다른 뜻이 함께 있으면 임의로 합의하거나 없는 욕망을 채우지 않는다. 회차 범위 미지정은 과거 회차에도 맞는다는 뜻이 아니다.",
  en: "## Book creative intent — source-bound guidance\nThese are exact statements from current Book documents and verified source ranges. Distinguish stated preferences from reference analysis. A quotation does not prove owner adoption or establish an enforceable rule. Existing verified Book rules remain separate. Do not promote these excerpts into mustAvoid, automatic audit, or revision controls. Preserve unresolved differences; do not invent missing desires. An unscoped statement is not proof of historical applicability.",
  zh: "## 作品创作意图 — 带来源的参考\n以下是当前 Book 文档和已核验片段中的原文。区分偏好陈述与参考作品分析；引用不等于作者采纳或强制规则。既有 verified Book rules 单独生效。不要把这些引用升级为 mustAvoid、自动审查或修改命令。保留未解决的分歧，不补造欲望。未注明章节范围不证明适用于过去章节。",
};

export function renderBookCreativeBrief(projection: BookCreativeBrief, options: {
  readonly language?: Language; readonly maxCharacters?: number; readonly maxInputTokens?: number;
} = {}): BookCreativeBriefContext {
  const language = options.language ?? "ko", maxCharacters = options.maxCharacters ?? 6500;
  if (!(language in HEADERS) || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 24000
    || (options.maxInputTokens !== undefined && (!Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 0))) throw new Error("Invalid creative brief input budget");
  const selectedEntryIds: string[] = [], omittedEntryIds: string[] = [];
  let rendered = "";
  // Keep a long generic author note from consuming every slot before an explicit
  // reader promise or current focus. This is context allocation, not rule priority.
  const sourceOrder = { "book-direction-document": 0, "preference-evidence": 1, "reference-analysis": 2 };
  const queues = CATEGORIES.map((category) => projection.entries.filter((entry) => entry.category === category)
    .sort((left, right) => sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind]));
  const ordered: CreativeBriefEntry[] = [];
  while (queues.some((queue) => queue.length)) {
    for (const queue of queues) { const next = queue.shift(); if (next) ordered.push(next); }
  }
  for (const entry of ordered) {
    const scope = entry.scope ? `${entry.scope.fromChapter ?? "?"}–${entry.scope.throughChapter ?? "?"}` : "unspecified";
    const contextQuotes = (entry.reviewedText ?? []).map((target) => `\n\nReviewed text (context only): ${target.path} bytes ${target.start}..${target.end}; file SHA-256 ${target.sourceSha256}; quote SHA-256 ${target.quoteSha256}\n`
      + target.quote.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n")).join("");
    const block = `\n\n### ${entry.category} [${entry.sourceKind}; advisory]\n`
      + `Source: ${entry.path} bytes ${entry.start}..${entry.end}; file SHA-256 ${entry.sourceSha256}; quote SHA-256 ${entry.quoteSha256}; chapters ${scope}\n`
      + entry.quote.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n") + contextQuotes;
    const candidate = (rendered || HEADERS[language]) + block;
    if (candidate.length > maxCharacters || (options.maxInputTokens !== undefined && estimateTextTokens(candidate) > options.maxInputTokens)) {
      omittedEntryIds.push(entry.id); continue;
    }
    selectedEntryIds.push(entry.id); rendered = candidate;
  }
  return { projection, rendered, receipt: { schemaVersion: "book-creative-brief-context/v1", bookId: projection.bookId,
    ...(projection.chapterNumber === undefined ? {} : { chapterNumber: projection.chapterNumber }),
    projectionSha256: projection.projectionSha256, sources: projection.sources, selectedEntryIds, omittedEntryIds,
    unknownCategories: projection.unknownCategories, renderedSha256: hash(rendered), characters: rendered.length,
    estimatedTokens: estimateTextTokens(rendered), maxCharacters, ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
    modelCalls: 0, humanReviewRequired: false, autoEnforcement: false } };
}

export async function resolveBookCreativeBrief(input: Parameters<typeof readBookCreativeBrief>[0] & Parameters<typeof renderBookCreativeBrief>[1]):
  Promise<BookCreativeBriefContext> {
  return renderBookCreativeBrief(await readBookCreativeBrief(input), input);
}

/** Re-read the declared source set before reusing a cached context. No receipt/Book mutation. */
export async function verifyBookCreativeBriefSources(bookDir: string, receipt: BookCreativeBriefReceipt):
  Promise<{ current: boolean; changedSourceIds: string[] }> {
  if (receipt?.schemaVersion !== "book-creative-brief-context/v1" || !Array.isArray(receipt.sources)
    || receipt.sources.length === 0 || receipt.sources.length > 200
    || receipt.sources.some((source) => !source || typeof source.id !== "string" || typeof source.path !== "string"
      || typeof source.status !== "string" || (source.sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(source.sha256)))
    || new Set(receipt.sources.map((source) => source.id)).size !== receipt.sources.length
    || !receipt.sources.some((source) => source.id === "source-manifest" && source.path === CREATIVE_BRIEF_SOURCES_PATH)) {
    throw new Error("Invalid creative brief source receipt");
  }
  const changedSourceIds: string[] = [];
  for (const source of receipt.sources) {
    const read = await readLocalSource(bookDir, source.path);
    const same = source.sha256 !== undefined ? read.status === "current" && read.sha256 === source.sha256
      : read.status === source.status;
    if (!same) changedSourceIds.push(source.id);
  }
  return { current: changedSourceIds.length === 0, changedSourceIds };
}

/** Save the exact optional context delivered by an existing agent call. */
export async function recordBookCreativeBrief(bookDir: string, chapter: number, stage: "planning" | "writing" | "revision", context: BookCreativeBriefContext): Promise<string | undefined> {
  if (!isSafeBookId(context.projection.bookId)) return undefined;
  if (!Number.isSafeInteger(chapter) || chapter < 1 || !["planning", "writing", "revision"].includes(stage)) throw new Error("Invalid creative brief receipt scope");
  if (context.receipt.chapterNumber !== chapter || context.receipt.bookId !== context.projection.bookId
    || context.receipt.renderedSha256 !== hash(context.rendered) || context.receipt.characters !== context.rendered.length
    || context.receipt.estimatedTokens !== estimateTextTokens(context.rendered)
    || context.receipt.projectionSha256 !== context.projection.projectionSha256) throw new Error("Creative brief receipt mismatch");
  if (!context.projection.entries.length && context.projection.sources.every((source) => source.status === "missing")) return undefined;
  const directory = join(bookDir, "story", "runtime", "creative-brief");
  const text = JSON.stringify({ stage, ...context }, null, 2) + "\n";
  const relativePath = `story/runtime/creative-brief/${chapter}-${stage}-${hash(text)}.json`;
  const path = join(bookDir, relativePath);
  await assertBookAdvisoryWritePaths(bookDir, [relativePath]);
  await mkdir(directory, { recursive: true });
  try { await writeFile(path, text, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== text) throw new Error("Creative brief receipt conflict");
  }
  return path;
}
