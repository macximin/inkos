import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { estimateTextTokens } from "../llm/provider.js";
import { isSafeBookId } from "../utils/book-id.js";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import {
  NarrativeEvidenceChapterSchema, NarrativeEvidenceEntrySchema,
  type NarrativeEvidenceChapter, type NarrativeEvidenceContext, type NarrativeEvidenceDiagnostic,
  type NarrativeEvidenceValidation, type StoredNarrativeEvidence,
} from "../models/narrative-evidence.js";

export const NARRATIVE_EVIDENCE_DIRECTORY = "story/runtime/narrative-evidence";
export const NARRATIVE_EVIDENCE_MARKER = "=== NARRATIVE_EVIDENCE ===";
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown): string => JSON.stringify(value);
const MAX_CHAPTER_BYTES = 4 * 1024 * 1024;
type Language = "ko" | "en" | "zh";

function positions(text: string, quote: string): number[] {
  const found: number[] = [];
  let position = text.indexOf(quote);
  while (position >= 0 && found.length <= 64) {
    found.push(position); position = text.indexOf(quote, position + 1);
  }
  return found;
}

/** Optional extraction is isolated from the required runtime delta and never triggers a model retry. */
export function parseNarrativeEvidenceOutput(output: string): {
  status: "missing" | "parsed" | "invalid"; entries?: unknown[]; diagnostic?: string;
} {
  const markers = [...output.matchAll(/^===\s*NARRATIVE_EVIDENCE\s*===\s*$/gmu)];
  if (markers.length === 0) return { status: "missing" };
  if (markers.length !== 1) return { status: "invalid", diagnostic: "duplicate-optional-marker" };
  let body = output.slice(markers[0]!.index! + markers[0]![0].length).split(/^===\s*[A-Z_]+\s*===\s*$/mu)[0]!.trim();
  if (body.length > 128 * 1024) return { status: "invalid", diagnostic: "optional-body-size-limit" };
  body = /^```(?:json)?\s*\n([\s\S]*?)\n```$/u.exec(body)?.[1] ?? body;
  try {
    const value: unknown = JSON.parse(body);
    if (!Array.isArray(value)) return { status: "invalid", diagnostic: "optional-body-not-array" };
    return { status: "parsed", entries: value };
  } catch { return { status: "invalid", diagnostic: "optional-body-invalid-json" }; }
}

export function validateNarrativeEvidence(input: {
  readonly chapterNumber: number; readonly chapterText: string; readonly entries: unknown;
  readonly allowedThreadIds?: ReadonlyArray<string>;
}): NarrativeEvidenceValidation {
  if (!Number.isSafeInteger(input.chapterNumber) || input.chapterNumber < 1
    || typeof input.chapterText !== "string" || !input.chapterText.trim() || input.chapterText.includes("\0")
    || Buffer.byteLength(input.chapterText) > MAX_CHAPTER_BYTES) throw new Error("Invalid narrative evidence chapter input");
  const diagnostics: NarrativeEvidenceDiagnostic[] = [], accepted: StoredNarrativeEvidence[] = [];
  if (input.entries === undefined) return { entries: [], diagnostics: [{ reason: "optional-missing" }] };
  if (!Array.isArray(input.entries)) return { entries: [], diagnostics: [{ reason: "invalid-array" }] };
  if (input.entries.length > 64) return { entries: [], diagnostics: [{ reason: "entry-count-limit" }] };
  const chapterTextSha256 = hash(input.chapterText), seen = new Set<string>();
  for (const [index, raw] of input.entries.entries()) {
    const parsed = NarrativeEvidenceEntrySchema.safeParse(raw);
    if (!parsed.success) { diagnostics.push({ index, reason: "invalid-entry" }); continue; }
    const entry = parsed.data;
    if ("character" in entry && !entry.evidence.includes(entry.character)) { diagnostics.push({ index, reason: "character-not-in-quote" }); continue; }
    if (entry.kind === "reward" && input.allowedThreadIds !== undefined && !input.allowedThreadIds.includes(entry.threadId)) {
      diagnostics.push({ index, reason: "thread-not-admitted" }); continue;
    }
    const matches = positions(input.chapterText, entry.evidence);
    if (matches.length === 0) { diagnostics.push({ index, reason: "quote-not-found" }); continue; }
    if (entry.occurrence === undefined && matches.length !== 1) { diagnostics.push({ index, reason: "ambiguous-quote" }); continue; }
    const offset = matches[entry.occurrence ?? 0];
    if (offset === undefined) { diagnostics.push({ index, reason: "invalid-occurrence" }); continue; }
    const start = Buffer.byteLength(input.chapterText.slice(0, offset));
    const quote = { coordinate: "original-utf8-byte" as const, relativeTo: "chapter-body" as const, start, end: start + Buffer.byteLength(entry.evidence), sha256: hash(entry.evidence) };
    const { occurrence: _occurrence, ...annotation } = entry;
    const id = `narrative:${hash(encode([input.chapterNumber, chapterTextSha256, annotation, quote])).slice(0, 32)}`;
    if (seen.has(id)) { diagnostics.push({ index, reason: "duplicate-entry" }); continue; }
    seen.add(id); accepted.push({ id, entry, sourceChapter: input.chapterNumber, chapterTextSha256, quote });
  }
  return { entries: accepted, diagnostics };
}

/** Build inside the chapter persistence transaction from the exact serialized chapter bytes. */
export function buildNarrativeEvidenceArtifact(input: {
  readonly bookId: string; readonly chapterNumber: number; readonly chapterText: string;
  readonly chapterPath: string; readonly chapterFileContent: string; readonly entries: unknown;
  readonly allowedThreadIds?: ReadonlyArray<string>;
}): { record: NarrativeEvidenceChapter; writes: ReadonlyArray<AtomicFileWrite> } {
  if (typeof input.chapterFileContent !== "string" || Buffer.byteLength(input.chapterFileContent) > MAX_CHAPTER_BYTES) throw new Error("Invalid narrative evidence chapter file");
  const bodyPositions = positions(input.chapterFileContent, input.chapterText);
  if (bodyPositions.length !== 1) throw new Error("Narrative evidence requires the exact, unambiguous saved chapter body");
  const validated = validateNarrativeEvidence(input);
  const chapterBodyStart = Buffer.byteLength(input.chapterFileContent.slice(0, bodyPositions[0]));
  const payload = { schemaVersion: "narrative-evidence-chapter/v1" as const, bookId: input.bookId,
    chapterNumber: input.chapterNumber, chapterPath: input.chapterPath, chapterFileSha256: hash(input.chapterFileContent),
    chapterTextSha256: hash(input.chapterText), chapterBodyStart, chapterBodyEnd: chapterBodyStart + Buffer.byteLength(input.chapterText),
    entries: validated.entries, diagnostics: validated.diagnostics, authority: "advisory" as const, modelCalls: 0 as const,
    humanReviewRequired: false as const };
  const record = NarrativeEvidenceChapterSchema.parse({ ...payload, recordSha256: hash(encode(payload)) });
  const content = JSON.stringify(record, null, 2) + "\n";
  return { record, writes: [
    { relativePath: `${NARRATIVE_EVIDENCE_DIRECTORY}/records/${record.recordSha256}.json`, content },
    { relativePath: `${NARRATIVE_EVIDENCE_DIRECTORY}/chapters/${String(input.chapterNumber).padStart(6, "0")}.json`, content },
  ] };
}

function isInside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function readBookFile(bookDir: string, path: string, limit: number): Promise<Buffer> {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Narrative evidence path must stay inside the Book");
  const root = await realpath(bookDir), actual = await realpath(resolve(root, path));
  if (!isInside(root, actual)) throw new Error("Narrative evidence symlink escaped the Book");
  const info = await stat(actual);
  if (!info.isFile() || info.size > limit) throw new Error("Narrative evidence file exceeds the allowed size");
  const bytes = await readFile(actual);
  if (bytes.length > limit) throw new Error("Narrative evidence file exceeds the allowed size");
  return bytes;
}

/** Read-only preflight for merging builder writes into the existing chapter transaction. */
export async function validateNarrativeEvidenceArtifactPaths(bookDir: string, writes: ReadonlyArray<AtomicFileWrite>): Promise<void> {
  if (!Array.isArray(writes) || writes.length !== 2) throw new Error("Narrative evidence requires one archive and one current record");
  await assertBookAdvisoryWritePaths(bookDir, writes.map((write) => write.relativePath));
  let archiveSeen = false, currentSeen = false, expectedContent: string | undefined;
  for (const write of writes) {
    const archive = new RegExp(`^${NARRATIVE_EVIDENCE_DIRECTORY}/records/([a-f0-9]{64})\\.json$`, "u").exec(write.relativePath);
    const current = new RegExp(`^${NARRATIVE_EVIDENCE_DIRECTORY}/chapters/(\\d{6,})\\.json$`, "u").exec(write.relativePath);
    if ((!archive && !current) || (archive && archiveSeen) || (current && currentSeen)) throw new Error("Invalid narrative evidence artifact path set");
    if (archive) archiveSeen = true;
    if (current) currentSeen = true;
    const bytes = typeof write.content === "string" ? Buffer.from(write.content) : Buffer.from(write.content);
    if (bytes.length > 512 * 1024) throw new Error("Narrative evidence artifact exceeds the allowed size");
    let content: string, record: NarrativeEvidenceChapter;
    try {
      content = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes);
      record = NarrativeEvidenceChapterSchema.parse(JSON.parse(content));
    } catch { throw new Error("Invalid narrative evidence artifact content"); }
    const { recordSha256, ...payload } = record;
    if (hash(encode(payload)) !== recordSha256 || (archive && archive[1] !== recordSha256)
      || (current && current[1] !== String(record.chapterNumber).padStart(6, "0"))) throw new Error("Narrative evidence artifact path and record do not match");
    if (expectedContent !== undefined && content !== expectedContent) throw new Error("Narrative evidence archive and current record differ");
    expectedContent = content;
    try {
      // This also checks an existing final-component symlink. A dangling leaf is
      // rejected rather than being interpreted as a new empty target.
      await lstat(join(bookDir, write.relativePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let existing: Buffer;
    try { existing = await readBookFile(bookDir, write.relativePath, 512 * 1024); }
    catch { throw new Error("Narrative evidence existing artifact is unreadable or outside the Book"); }
    if (archive && !existing.equals(bytes)) throw new Error("Narrative evidence immutable record was changed");
  }
}

/** Caller holds the existing Book write lock. Writes only advisory sidecars, never manuscript or canon. */
export async function saveNarrativeEvidence(input: Omit<Parameters<typeof buildNarrativeEvidenceArtifact>[0], "chapterFileContent"> & {
  readonly bookDir: string;
}): Promise<{ status: "saved" | "unchanged"; record: NarrativeEvidenceChapter; paths: string[] }> {
  const chapterBytes = await readBookFile(input.bookDir, input.chapterPath, MAX_CHAPTER_BYTES);
  const chapterFileContent = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(chapterBytes);
  const artifact = buildNarrativeEvidenceArtifact({ ...input, chapterFileContent });
  await validateNarrativeEvidenceArtifactPaths(input.bookDir, artifact.writes);
  let currentMatches = false, archiveMatches = false;
  for (const [index, write] of artifact.writes.entries()) {
    try {
      const existing = await readBookFile(input.bookDir, write.relativePath, 512 * 1024);
      const same = existing.toString("utf8") === write.content;
      if (index === 0 && !same) throw new Error("Narrative evidence immutable record was changed");
      if (index === 0 && same) archiveMatches = true;
      if (index === 1 && same) currentMatches = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (currentMatches && archiveMatches) return { status: "unchanged", record: artifact.record, paths: artifact.writes.map((write) => write.relativePath) };
  // The surrounding Book lease serializes this with chapter writes. Recheck the
  // manuscript before installing any evidence if this helper is called separately.
  if (hash(await readBookFile(input.bookDir, input.chapterPath, MAX_CHAPTER_BYTES)) !== artifact.record.chapterFileSha256) throw new Error("Narrative evidence manuscript changed before save");
  await commitAtomicFileSet({ rootDir: input.bookDir, writes: artifact.writes });
  return { status: "saved", record: artifact.record, paths: artifact.writes.map((write) => write.relativePath) };
}

function verifyRecord(record: NarrativeEvidenceChapter, chapterBytes: Buffer): boolean {
  const { recordSha256, ...payload } = record;
  if (hash(encode(payload)) !== recordSha256 || hash(chapterBytes) !== record.chapterFileSha256
    || record.chapterBodyEnd > chapterBytes.length) return false;
  let body: string;
  try { body = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(chapterBytes.subarray(record.chapterBodyStart, record.chapterBodyEnd)); }
  catch { return false; }
  if (hash(body) !== record.chapterTextSha256) return false;
  const validated = validateNarrativeEvidence({ chapterNumber: record.chapterNumber, chapterText: body, entries: record.entries.map((entry) => entry.entry) });
  return validated.diagnostics.length === 0 && encode(validated.entries) === encode(record.entries);
}

export async function readNarrativeEvidenceContext(bookDir: string, options: {
  readonly bookId: string; readonly throughChapter: number; readonly povCharacter?: string;
  readonly language?: Language; readonly query?: string; readonly maxCharacters?: number; readonly maxInputTokens?: number;
  readonly maxChapterRecords?: number;
}): Promise<NarrativeEvidenceContext> {
  const maxCharacters = options.maxCharacters ?? 7000, maxRecords = options.maxChapterRecords ?? 200;
  if (!isSafeBookId(options.bookId)) return renderNarrativeEvidenceContext([], { ...options,
    excluded: [{ path: NARRATIVE_EVIDENCE_DIRECTORY, reason: "invalid-book-id" }] });
  if (!Number.isSafeInteger(options.throughChapter) || options.throughChapter < 0
    || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 24000
    || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000
    || (options.maxInputTokens !== undefined && (!Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 0))) throw new Error("Invalid narrative evidence context options");
  const directory = `${NARRATIVE_EVIDENCE_DIRECTORY}/chapters`;
  const records: NarrativeEvidenceChapter[] = [], excluded: Array<{ path: string; reason: string }> = [];
  let names: string[] = [];
  try {
    const root = await realpath(bookDir), dir = await realpath(join(root, directory));
    if (!isInside(root, dir)) throw new Error("outside-book");
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") excluded.push({ path: directory, reason: "unreadable-directory" });
  }
  const eligible = names.filter((name) => /^\d{6,}\.json$/u.test(name) && Number.isSafeInteger(Number(name.slice(0, -5)))
    && Number(name.slice(0, -5)) > 0 && Number(name.slice(0, -5)) <= options.throughChapter)
    .sort((left, right) => Number(right.slice(0, -5)) - Number(left.slice(0, -5)));
  for (const name of eligible.slice(maxRecords)) excluded.push({ path: `${directory}/${name}`, reason: "chapter-record-count-budget" });
  for (const name of eligible.slice(0, maxRecords)) {
    const path = `${directory}/${name}`;
    let record: NarrativeEvidenceChapter;
    try {
      record = NarrativeEvidenceChapterSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readBookFile(bookDir, path, 512 * 1024))));
      if (record.bookId !== options.bookId || record.chapterNumber !== Number(name.slice(0, -5))) throw new Error("identity");
    } catch { excluded.push({ path, reason: "invalid-record" }); continue; }
    try {
      if (!verifyRecord(record, await readBookFile(bookDir, record.chapterPath, MAX_CHAPTER_BYTES))) {
        excluded.push({ path, reason: "manuscript-or-evidence-changed" }); continue;
      }
    } catch { excluded.push({ path, reason: "manuscript-unavailable" }); continue; }
    records.push(record);
  }
  records.sort((left, right) => left.chapterNumber - right.chapterNumber);
  return renderNarrativeEvidenceContext(records, { ...options, maxCharacters, excluded });
}

/** Groups preserve chronology and never fill a missing reward stage or infer shared knowledge. */
export function renderNarrativeEvidenceContext(records: ReadonlyArray<NarrativeEvidenceChapter>, options: {
  readonly bookId: string; readonly throughChapter: number; readonly povCharacter?: string;
  readonly language?: Language; readonly query?: string; readonly maxCharacters?: number; readonly maxInputTokens?: number;
  readonly excluded?: ReadonlyArray<{ path: string; reason: string }>;
}): NarrativeEvidenceContext {
  const language = options.language ?? "ko", maxCharacters = options.maxCharacters ?? 7000;
  const headings = {
    ko: "## 독자 공개·인물 인지·보상 경과의 본문 근거\n모든 항목은 정확한 본문 인용에 붙인 관찰 분류이며 정사·진위·규칙을 확정하지 않는다. 독자에게 공개된 정보는 모든 등장인물이 아는 정보가 아니다. 인물 인지·무지는 이름이 명시된 그 인물의 해당 시점 근거만 쓰고 다른 시점 인물에게 옮기지 않는다. belief는 사실의 진위와 다르다. 보상 단계는 같은 명시적 threadId와 같은 인물 안에서만 시간순 나열한다. 이름이 같다는 것만으로 별칭·동일인·인과를 확정하지 않는다. 없는 단계를 채우거나 획득을 곧 체감·만족으로 바꾸지 않는다. missing stage는 결함 판정이나 장면 할당량이 아니다.",
    en: "## Manuscript evidence of disclosure, awareness and reward progress\nThese are classifications attached to exact quotations, not canon, objective truth or rules. Reader disclosure does not mean every character knows. Awareness or ignorance applies only to the explicitly named character at that time; never transfer it to another POV. Belief is distinct from truth. Reward stages are ordered only within the same explicit threadId and character. Matching names do not establish aliases, identity or causality. Never invent missing stages or turn acquisition into experienced satisfaction. A missing stage is not a defect verdict or scene quota.",
    zh: "## 读者公开、人物认知与回报进展的正文证据\n这些只是准确引文的观察分类，不确立正史、真相或规则。读者已见不代表所有人物知情。认知或无知仅对应引文明确具名人物当时的状态，不能转移到另一视角；belief 不等于真相。回报阶段仅在相同明确 threadId 与人物内按时间排列；同名不证明别名、身份或因果。不要补造缺失阶段，也不要把获得自动变成体验和满足。缺失阶段不是缺陷裁决或场面配额。",
  };
  if (!(language in headings) || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 24000
    || (options.maxInputTokens !== undefined && (!Number.isSafeInteger(options.maxInputTokens) || options.maxInputTokens < 0))) throw new Error("Invalid narrative evidence rendering budget");
  const pov = options.povCharacter?.trim();
  const eligible = records.filter((record) => record.bookId === options.bookId && record.chapterNumber <= options.throughChapter);
  const groups = new Map<string, StoredNarrativeEvidence[]>(), omittedEntryIds: string[] = [];
  for (const record of eligible) for (const item of record.entries) {
    const entry = item.entry;
    if (pov && "character" in entry && entry.character !== pov) { omittedEntryIds.push(item.id); continue; }
    const key = entry.kind === "reward" ? encode([entry.kind, entry.threadId, entry.character])
      : entry.kind === "character-awareness" ? encode([entry.kind, entry.informationId, entry.character]) : encode([entry.kind, entry.informationId]);
    const list = groups.get(key) ?? []; list.push(item); groups.set(key, list);
  }
  const terms = [...new Set((options.query ?? "").slice(0, 65536).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,120}/gu) ?? [])].slice(0, 64);
  const ranked = [...groups.values()].map((entries) => {
    const items = entries.sort((left, right) => left.sourceChapter - right.sourceChapter || left.quote.start - right.quote.start);
    const texts = items.map((item) => item.entry.evidence.normalize("NFKC").toLowerCase());
    return { items, score: terms.filter((term) => texts.some((text) => text.includes(term))).length };
  });
  ranked.sort((left, right) => right.score - left.score || right.items.at(-1)!.sourceChapter - left.items.at(-1)!.sourceChapter
    || (left.items[0]!.id < right.items[0]!.id ? -1 : 1));
  const selectedEntryIds: string[] = [];
  let rendered = "";
  for (const { items } of ranked) {
    const first = items[0]!.entry;
    const title = first.kind === "reward" ? `reward thread ${first.threadId} · ${first.character}`
      : first.kind === "character-awareness" ? `character-awareness ${first.informationId} · ${first.character}` : `reader-only disclosure ${first.informationId}`;
    let selected: StoredNarrativeEvidence[] | undefined;
    for (const limit of [8, 4, 2, 1]) {
      let window = items.slice(-limit);
      const promise = items.find((item) => item.entry.kind === "reward" && item.entry.stage === "promise");
      if (limit >= 3 && promise && !window.includes(promise)) window = [promise, ...window.slice(-(limit - 1))];
      const skipped = items.length - window.length;
      const block = `\n\n### ${title}\n` + (skipped ? `Selection window: ${skipped} earlier/intermediate quoted events omitted; this is not a complete chronology.\n` : "")
        + window.map((item) => {
          const stage = item.entry.kind === "reward" ? item.entry.stage : item.entry.kind === "character-awareness" ? item.entry.awareness : "reader-disclosure";
          return `Chapter ${item.sourceChapter} · ${stage} · quote SHA-256 ${item.quote.sha256}\n`
            + item.entry.evidence.split(/\r\n|\r|\n/u).map((line) => `> ${line}`).join("\n");
        }).join("\n\n");
      const candidate = (rendered || headings[language]) + block;
      if (candidate.length <= maxCharacters && (options.maxInputTokens === undefined || estimateTextTokens(candidate) <= options.maxInputTokens)) {
        rendered = candidate; selected = window; break;
      }
    }
    const selectedIds = new Set(selected?.map((item) => item.id));
    selectedEntryIds.push(...selectedIds);
    omittedEntryIds.push(...items.filter((item) => !selectedIds.has(item.id)).map((item) => item.id));
  }
  return { rendered, records: eligible, receipt: { schemaVersion: "narrative-evidence-context/v1", bookId: options.bookId,
    throughChapter: options.throughChapter, ...(pov ? { povCharacter: pov } : {}), selectedEntryIds, omittedEntryIds,
    sourceRecords: eligible.map((record) => ({ chapterNumber: record.chapterNumber, recordSha256: record.recordSha256, chapterFileSha256: record.chapterFileSha256 })),
    excluded: options.excluded ?? [], renderedSha256: hash(rendered), characters: rendered.length,
    estimatedTokens: estimateTextTokens(rendered), maxCharacters, ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
    autoEnforcement: false, modelCalls: 0, humanReviewRequired: false } };
}

export function buildNarrativeEvidenceExtractionRules(language: Language = "ko"): string {
  const lead = language === "ko" ? "선택적인 본문 관찰이다. 기존 Settler 응답 끝에 아래 별도 마커와 JSON 배열을 붙일 수 있다. 근거가 없으면 [] 또는 생략하며 이 자료 때문에 장면을 만들거나 모델 호출을 반복하지 않는다."
    : language === "zh" ? "这是可选正文观察，可在现有 Settler 回复末尾添加以下独立标记和 JSON 数组。没有证据时用 [] 或省略；不新增场景或模型调用。"
      : "Optional manuscript observations may be appended to the existing Settler response using the separate marker and JSON array below. Use [] or omit it when evidence is absent; never create scenes or additional model calls for this extraction.";
  return `${lead}\n${NARRATIVE_EVIDENCE_MARKER}\n[]\n`
    + `Allowed whole-entry shapes (do not put these in RUNTIME_STATE_DELTA):\n`
    + `- {"kind":"reader-disclosure","informationId":"stable-explicit-label","evidence":"contiguous exact chapter quote"}\n`
    + `- {"kind":"character-awareness","informationId":"stable-explicit-label","character":"exact name in quote","awareness":"aware|unaware|belief","evidence":"contiguous exact chapter quote"}\n`
    + `- {"kind":"reward","threadId":"explicit-stable-thread-id","character":"exact name in quote","stage":"promise|acquisition|experience|next-desire","evidence":"contiguous exact chapter quote"}\n`
    + `Reuse an existing explicit informationId/threadId only for that same information/reward thread. Never merge threads based on similar words or names. A new explicit promise may have a distinct new threadId; never invent an earlier promise to complete a sequence. Quote only THIS chapter, not the plan or previous chapters. Evidence ≤1600 characters, names ≤120 characters, array ≤64 entries. If the exact quote repeats, add occurrence (zero-based) to identify it.\n`
    + `Reader disclosure is not character awareness. A character-awareness quote must explicitly name the character and show their awareness/ignorance/belief; mere presence in a scene or a public statement is insufficient. Belief is not truth. For rewards, quote the explicit promise, actual acquisition, experienced change in life/treatment/choice, or stated next desire. A money amount alone is not experienced satisfaction. Do not fill missing stages, infer hidden emotions, add summaries, declare rule/canon authority, or create audit requirements.\n`;
}
