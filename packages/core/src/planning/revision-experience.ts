import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { ReviseOutput, ReviseMode } from "../agents/reviser.js";
import { readChapterVersion } from "../state/chapter-workspace.js";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";
import { normalizePostWriteSurface } from "../agents/post-write-validator.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Chapter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Text = z.string().trim().min(1).max(6000);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const IssueSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]), category: Text, description: Text,
  suggestion: z.string().max(6000), ruleId: z.string().min(1).max(200).optional(),
  dimensionId: z.number().int().optional(), repairScope: z.enum(["local", "structural", "unknown"]).optional(),
  chapterQuote: z.string().max(6000).optional(), evidenceQuote: z.string().max(6000).optional(),
}).strict();
const TextReference = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blob"), sha256: Hash }).strict(),
  z.object({ kind: z.literal("chapter-version"), sha256: Hash, versionId: z.string().regex(/^\d{13}_(?:manual|agent|revision|regeneration|restore)_[0-9a-f-]{36}$/) }).strict(),
]);
const DiffSchema = z.object({
  coordinateKind: z.literal("utf16-code-units"),
  beforeStart: z.number().int().min(0), beforeEnd: z.number().int().min(0),
  afterStart: z.number().int().min(0), afterEnd: z.number().int().min(0),
  removed: z.string().max(500000), added: z.string().max(500000),
}).strict();
export const RevisionExperienceSchema = z.object({
  schemaVersion: z.literal("revision-experience/v1"), experienceId: Hash,
  bookId: z.string().min(1), chapterNumber: Chapter,
  mode: z.enum(["auto", "polish", "rewrite", "rework", "anti-detect", "spot-fix"]),
  status: z.enum(["candidate", "no-op", "parse-failed", "preserved"]),
  before: TextReference, after: TextReference, diff: DiffSchema,
  issues: z.array(IssueSchema).max(100), revisionInstruction: z.string().max(12000),
  reportedFixedIssues: z.array(z.string().max(6000)).max(100),
  failureReason: z.string().max(6000).optional(),
  preservedQuotes: z.array(z.object({ quote: Text, reason: Text, presentAfter: z.boolean() }).strict()).max(30),
  sourceAttribution: z.enum(["host-recorded-reviser-output", "host-recorded-post-write-surface-normalization"]),
  derivedFrom: z.object({
    experienceId: Hash, afterSha256: Hash,
    reason: z.literal("post-write-surface-normalization"), language: z.enum(["ko", "en", "zh"]),
  }).strict().optional(),
  qualityVerdict: z.literal("not-assessed"), canonApplied: z.literal(false),
}).strict().refine(record => (record.sourceAttribution === "host-recorded-post-write-surface-normalization") === !!record.derivedFrom,
  { message: "revision-normalization-source-attribution-mismatch" });
export type RevisionExperience = z.infer<typeof RevisionExperienceSchema>;
const AssessmentSchema = z.object({
  contentSha256: Hash, passed: z.boolean(), parseFailed: z.boolean(), lengthInRange: z.boolean(),
  score: z.number().finite().min(0).max(100).nullable(),
}).strict();
export const RevisionOutcomeSchema = z.object({
  schemaVersion: z.literal("revision-outcome/v1"), outcomeId: Hash,
  experienceId: Hash, bookId: z.string().min(1), chapterNumber: Chapter,
  cycleId: z.string().trim().min(1).max(200),
  status: z.enum(["automatic-selected", "not-selected", "tie", "invalid-assessment"]),
  selectedContentSha256: Hash,
  assessments: z.array(AssessmentSchema).max(20),
  reason: Text,
  selectionAuthority: z.literal("automatic-review-cycle"),
  humanPreferenceEstablished: z.literal(false),
}).strict();
export type RevisionOutcome = z.infer<typeof RevisionOutcomeSchema>;

function directory(bookDir: string) { return join(bookDir, "story", "runtime", "revision-experiences"); }
function checkText(value: string) { if (typeof value !== "string" || value.length > 500000) throw new Error("revision-text-too-large-or-invalid"); return value; }
function insideSurrogate(text: string, index: number) { return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]!) && /[\uDC00-\uDFFF]/.test(text[index]!); }
/** One minimal enclosing replacement, exact even for several disjoint edits. */
export function computeRevisionExperienceDiff(before: string, after: string): RevisionExperience["diff"] {
  checkText(before); checkText(after);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  if (insideSurrogate(before, prefix) || insideSurrogate(after, prefix)) prefix--;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  if (insideSurrogate(before, before.length - suffix) || insideSurrogate(after, after.length - suffix)) suffix--;
  return { coordinateKind: "utf16-code-units", beforeStart: prefix, beforeEnd: before.length - suffix,
    afterStart: prefix, afterEnd: after.length - suffix, removed: before.slice(prefix, before.length - suffix), added: after.slice(prefix, after.length - suffix) };
}
async function immutable(file: string, text: string) {
  try { await writeFile(file, text, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== text) throw new Error("revision-immutable-content-conflict");
  }
}
async function verifyBook(bookDir: string, bookId: string) {
  const book = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
  if (!bookId || book.id !== bookId) throw new Error("revision-experience-book-mismatch");
}
async function reference(bookDir: string, chapter: number, text: string, versionId?: string): Promise<RevisionExperience["before"]> {
  const sha256 = sha(text);
  if (versionId !== undefined) {
    if (await readChapterVersion(bookDir, chapter, versionId) !== text) throw new Error("revision-archive-content-mismatch");
    return TextReference.parse({ kind: "chapter-version", sha256, versionId });
  }
  const dir = join(directory(bookDir), "texts");
  await assertBookAdvisoryWritePaths(bookDir, [`story/runtime/revision-experiences/texts/${sha256}.txt`]);
  await mkdir(dir, { recursive: true });
  await immutable(join(dir, `${sha256}.txt`), text);
  return { kind: "blob", sha256 };
}
async function readReference(bookDir: string, chapter: number, reference: RevisionExperience["before"]): Promise<string> {
  const ref = TextReference.parse(reference);
  let text: string;
  if (ref.kind === "chapter-version") text = await readChapterVersion(bookDir, chapter, ref.versionId);
  else {
    const file = join(directory(bookDir), "texts", `${ref.sha256}.txt`), stat = await lstat(file);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error("revision-invalid-text-file");
    text = await readFile(file, "utf8");
  }
  if (sha(checkText(text)) !== ref.sha256) throw new Error("revision-text-hash-mismatch");
  return text;
}
function parseIssues(issues: ReadonlyArray<AuditIssue>) {
  return issues.map(issue => IssueSchema.parse({ severity: issue.severity, category: issue.category, description: issue.description, suggestion: issue.suggestion,
    ...(issue.ruleId ? { ruleId: issue.ruleId } : {}), ...(issue.dimensionId !== undefined ? { dimensionId: issue.dimensionId } : {}),
    ...(issue.repairScope ? { repairScope: issue.repairScope } : {}), ...(issue.chapterQuote ? { chapterQuote: issue.chapterQuote } : {}),
    ...(issue.evidenceQuote ? { evidenceQuote: issue.evidenceQuote } : {}),
  }));
}
export async function recordRevisionExperience(bookDir: string, input: {
  readonly bookId: string; readonly chapterNumber: number; readonly beforeContent: string;
  readonly output: Pick<ReviseOutput, "revisedContent" | "fixedIssues" | "applied" | "parseFailed" | "failureReason">;
  readonly issues: ReadonlyArray<AuditIssue>; readonly revisionInstruction?: string; readonly mode?: ReviseMode;
  readonly expectedBeforeSha256?: string; readonly expectedAfterSha256?: string;
  readonly beforeVersionId?: string; readonly afterVersionId?: string;
  readonly preserveQuotes?: ReadonlyArray<{ readonly quote: string; readonly reason: string }>;
}): Promise<{ path: string; record: RevisionExperience }> {
  await verifyBook(bookDir, input.bookId); Chapter.parse(input.chapterNumber);
  const before = checkText(input.beforeContent), after = checkText(input.output.revisedContent);
  if ((input.expectedBeforeSha256 !== undefined && input.expectedBeforeSha256 !== sha(before)) || (input.expectedAfterSha256 !== undefined && input.expectedAfterSha256 !== sha(after))) throw new Error("revision-expected-text-hash-mismatch");
  if ((input.output.applied === false || input.output.parseFailed) && before !== after) throw new Error("revision-output-status-content-conflict");
  const status = input.output.parseFailed ? "parse-failed" as const : input.output.applied === false && input.output.failureReason ? "preserved" as const : before === after ? "no-op" as const : "candidate" as const;
  const preservedQuotes = (input.preserveQuotes ?? []).map(item => {
    Text.parse(item.quote); Text.parse(item.reason);
    const start = before.indexOf(item.quote);
    if (start < 0 || before.indexOf(item.quote, start + 1) !== -1) throw new Error("revision-preservation-quote-not-unique");
    return { ...item, presentAfter: after.includes(item.quote) };
  });
  // Validate the complete record before creating blobs or references.
  const content: Omit<RevisionExperience, "experienceId"> = { schemaVersion: "revision-experience/v1" as const, bookId: input.bookId, chapterNumber: input.chapterNumber,
    mode: input.mode ?? "auto", status, before: { kind: "blob" as const, sha256: sha(before) }, after: { kind: "blob" as const, sha256: sha(after) },
    diff: computeRevisionExperienceDiff(before, after), issues: parseIssues(input.issues), revisionInstruction: input.revisionInstruction ?? "",
    reportedFixedIssues: [...input.output.fixedIssues], ...(input.output.failureReason ? { failureReason: input.output.failureReason } : {}),
    preservedQuotes, sourceAttribution: "host-recorded-reviser-output" as const, qualityVerdict: "not-assessed" as const, canonApplied: false as const };
  RevisionExperienceSchema.parse({ ...content, experienceId: "0".repeat(64) });
  content.before = await reference(bookDir, input.chapterNumber, before, input.beforeVersionId);
  content.after = await reference(bookDir, input.chapterNumber, after, input.afterVersionId);
  return storeExperience(bookDir, content);
}
async function storeExperience(bookDir: string, content: Omit<RevisionExperience, "experienceId">): Promise<{ path: string; record: RevisionExperience }> {
  const record = RevisionExperienceSchema.parse({ ...content, experienceId: sha(canonical(content)) });
  const dir = directory(bookDir);
  await assertBookAdvisoryWritePaths(bookDir, [`story/runtime/revision-experiences/${record.chapterNumber}-${record.experienceId}.json`]);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${record.chapterNumber}-${record.experienceId}.json`);
  await immutable(file, JSON.stringify(record, null, 2) + "\n");
  return { path: file, record };
}
async function readExperience(bookDir: string, bookId: string, chapter: number, id: string, requireRaw = false): Promise<{ record: RevisionExperience; before: string; after: string }> {
  Hash.parse(id); Chapter.parse(chapter);
  const file = join(directory(bookDir), `${chapter}-${id}.json`), stat = await lstat(file);
  if (!stat.isFile() || stat.size > 4_000_000) throw new Error("revision-invalid-record-file");
  const record = RevisionExperienceSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const { experienceId, ...content } = record;
  if (record.bookId !== bookId || record.chapterNumber !== chapter || experienceId !== id || sha(canonical(content)) !== experienceId) throw new Error("revision-record-binding-mismatch");
  if (requireRaw && record.derivedFrom) throw new Error("revision-normalization-source-must-be-raw");
  const [before, after] = await Promise.all([readReference(bookDir, chapter, record.before), readReference(bookDir, chapter, record.after)]);
  if (canonical(computeRevisionExperienceDiff(before, after)) !== canonical(record.diff)) throw new Error("revision-diff-mismatch");
  if (record.derivedFrom) {
    const source = await readExperience(bookDir, bookId, chapter, record.derivedFrom.experienceId, true);
    const { experienceId: _sourceId, after: _sourceAfter, diff: _sourceDiff, status: _sourceStatus,
      sourceAttribution: _sourceAttribution, preservedQuotes: _sourceQuotes, ...sourceContext } = source.record;
    const { experienceId: _derivedId, after: _derivedAfter, diff: _derivedDiff, status: _derivedStatus,
      sourceAttribution: _derivedAttribution, preservedQuotes: _derivedQuotes, derivedFrom: _derivedFrom, ...derivedContext } = record;
    const expectedQuotes = source.record.preservedQuotes.map(item => ({ ...item, presentAfter: after.includes(item.quote) }));
    if (source.record.status !== "candidate" || source.record.after.sha256 !== record.derivedFrom.afterSha256
      || source.after === after || normalizePostWriteSurface(source.after, record.derivedFrom.language) !== after
      || canonical(sourceContext) !== canonical(derivedContext) || canonical(expectedQuotes) !== canonical(record.preservedQuotes)
      || record.status !== (before === after ? "no-op" : "candidate")) throw new Error("revision-normalization-source-binding-mismatch");
  }
  return { record, before, after };
}
/** Record only the host's existing deterministic surface transform, never another model edit. */
export async function recordNormalizedRevisionExperience(bookDir: string, input: {
  readonly bookId: string; readonly chapterNumber: number; readonly experienceId: string;
  readonly effectiveContent: string; readonly language: "ko" | "en" | "zh";
}): Promise<{ path: string; record: RevisionExperience }> {
  await verifyBook(bookDir, input.bookId);
  const source = await readExperience(bookDir, input.bookId, input.chapterNumber, input.experienceId, true);
  const after = checkText(input.effectiveContent);
  z.enum(["ko", "en", "zh"]).parse(input.language);
  if (normalizePostWriteSurface(source.after, input.language) !== after) throw new Error("revision-normalization-content-mismatch");
  if (source.after === after) return { path: join(directory(bookDir), `${source.record.chapterNumber}-${source.record.experienceId}.json`), record: source.record };
  if (source.record.status !== "candidate") throw new Error("revision-normalization-requires-candidate");
  const { experienceId: _experienceId, ...raw } = source.record;
  const content: Omit<RevisionExperience, "experienceId"> = {
    ...raw, after: await reference(bookDir, input.chapterNumber, after),
    diff: computeRevisionExperienceDiff(source.before, after), status: source.before === after ? "no-op" : "candidate",
    preservedQuotes: source.record.preservedQuotes.map(item => ({ ...item, presentAfter: after.includes(item.quote) })),
    sourceAttribution: "host-recorded-post-write-surface-normalization",
    derivedFrom: { experienceId: source.record.experienceId, afterSha256: source.record.after.sha256,
      reason: "post-write-surface-normalization", language: input.language },
  };
  return storeExperience(bookDir, content);
}
export async function recordRevisionOutcome(bookDir: string, input: {
  readonly bookId: string; readonly chapterNumber: number; readonly experienceId: string; readonly cycleId: string;
  readonly selectedContent: string;
  readonly snapshots: ReadonlyArray<{ readonly content: string; readonly auditResult: Pick<AuditResult, "passed" | "parseFailed" | "overallScore">; readonly lengthInRange: boolean }>;
}): Promise<{ path: string; record: RevisionOutcome }> {
  await verifyBook(bookDir, input.bookId);
  const experience = (await readExperience(bookDir, input.bookId, input.chapterNumber, input.experienceId)).record;
  const assessments = input.snapshots.map(snapshot => AssessmentSchema.parse({ contentSha256: sha(checkText(snapshot.content)),
    passed: snapshot.auditResult.passed, parseFailed: snapshot.auditResult.parseFailed ?? false,
    lengthInRange: snapshot.lengthInRange, score: snapshot.auditResult.overallScore ?? null }));
  const selectedContentSha256 = sha(checkText(input.selectedContent));
  const before = assessments.filter(item => item.contentSha256 === experience.before.sha256);
  const after = assessments.filter(item => item.contentSha256 === experience.after.sha256);
  const eligible = (assessment: z.infer<typeof AssessmentSchema>) => assessment.passed && !assessment.parseFailed && assessment.lengthInRange;
  let status: RevisionOutcome["status"], reason: string;
  const ambiguous = [...new Set(assessments.map(item => item.contentSha256))].some(hash => new Set(assessments.filter(item => item.contentSha256 === hash).map(canonical)).size > 1);
  if (ambiguous || before.length === 0 || after.length === 0 || !assessments.some(item => item.contentSha256 === selectedContentSha256) || before.some(item => item.parseFailed) || after.some(item => item.parseFailed)) {
    status = "invalid-assessment"; reason = "Missing, conflicting or unparseable assessment evidence; final selection is recorded without claiming improvement.";
  } else if (experience.status !== "candidate") {
    status = "not-selected"; reason = "No distinct valid revision candidate existed.";
  } else if (eligible(before[0]!) && eligible(after[0]!) && before[0]!.score !== null && after[0]!.score !== null && Math.abs(after[0]!.score! - before[0]!.score!) < 3) {
    status = "tie"; reason = "Both versions passed hard gates; advisory scores differ by less than the existing 3-point selection threshold.";
  } else if (selectedContentSha256 === experience.after.sha256 && eligible(after[0]!)) {
    status = "automatic-selected"; reason = "The existing automatic review cycle selected this exact candidate after its assessment passed hard gates; no human preference was established.";
  } else {
    status = "not-selected"; reason = "The actual selected snapshot was another version, or this candidate remained ineligible.";
  }
  const content = { schemaVersion: "revision-outcome/v1" as const, experienceId: experience.experienceId, bookId: input.bookId,
    chapterNumber: input.chapterNumber, cycleId: input.cycleId, status, selectedContentSha256, assessments, reason,
    selectionAuthority: "automatic-review-cycle" as const, humanPreferenceEstablished: false as const };
  const record = RevisionOutcomeSchema.parse({ ...content, outcomeId: sha(canonical(content)) });
  const dir = join(directory(bookDir), "outcomes");
  await assertBookAdvisoryWritePaths(bookDir, [`story/runtime/revision-experiences/outcomes/${record.experienceId}-${record.outcomeId}.json`]);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${record.experienceId}-${record.outcomeId}.json`);
  await immutable(file, JSON.stringify(record, null, 2) + "\n");
  return { path: file, record };
}

const STOP = new Set(["수정", "수정해", "수정해줘", "검토", "이번", "본문", "장면", "문장", "원고", "문제", "요청", "지적", "개선", "현재", "때문", "해서", "한다", "있다", "없다", "please", "revise", "revision", "chapter", "issue", "fix", "the", "and", "with", "this", "that"]);
function terms(value: string): Set<string> {
  return new Set((value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(token => {
    if (!/^[가-힣]+$/.test(token)) return token;
    const stem = token.replace(/(?:으로부터|에게서|께서는|에서는|으로는|에게는|에서|에게|한테|께서|으로|부터|까지|처럼|보다|하고|과|와|을|를|은|는|이|가|의|도|만|로)$/, "");
    return stem.length >= 2 ? stem : token;
  }).filter(token => token.length >= 2 && !STOP.has(token)));
}
function overlap(left: string, right: string) { const a = terms(left), b = terms(right); return [...a].filter(item => b.has(item)).length; }
const CAUSES: ReadonlyArray<readonly [string, RegExp]> = [
  ["repetition", /반복|중복|재설명|되풀이|repetit|redundan|duplicate/iu],
  ["speaker", /화자|누구(?:의)?\s*(?:말|대사)|발화자|speaker|attribution/iu],
  ["knowledge", /정보\s*(?:누수|경계)|알\s*수\s*없|아직\s*모르|미리\s*(?:알|안다)|knowledge|unaware/iu],
  ["causal-choice", /선택\s*(?:이유|근거)|동기|인과|판단\s*(?:근거|과정)|motivation|causality|causal|decision\s*(?:reason|basis)/iu],
  ["payoff", /보상|약속\s*(?:회수|이행)|복선\s*회수|payoff|unpaid\s*promise/iu],
  ["time", /시간\s*(?:순서|모순)|날짜\s*(?:모순|불일치)|chronolog|timeline/iu],
  ["identity", /이름\s*(?:오류|불일치)|인명\s*(?:오류|불일치)|name\s*(?:error|mismatch)/iu],
  ["voice", /말투|어조|voice|register/iu],
  ["length", /분량|글자\s*수|word\s*count|length/iu],
  ["grammar", /맞춤법|오탈자|문법|grammar|typo|spelling/iu],
];
function causes(text: string) { return new Set(CAUSES.filter(([, pattern]) => pattern.test(text)).map(([cause]) => cause)); }
function matchingCause(left: string, right: string) {
  const a = causes(left), b = causes(right);
  return [...a].some(cause => b.has(cause));
}
function relevance(record: RevisionExperience, issues: ReadonlyArray<AuditIssue>, query: string): number {
  let score = 0;
  for (const current of issues) for (const old of record.issues) {
    if (current.ruleId && old.ruleId && current.ruleId !== old.ruleId) continue;
    const shared = overlap(`${current.description} ${current.suggestion}`, `${old.description} ${old.suggestion}`);
    const sameCause = current.ruleId && current.ruleId === old.ruleId;
    const sameDimension = current.dimensionId !== undefined && current.dimensionId === old.dimensionId;
    if (current.dimensionId !== undefined && old.dimensionId !== undefined && current.dimensionId !== old.dimensionId && !sameCause) continue;
    const sameCategory = current.category.normalize("NFKC").toLowerCase() === old.category.normalize("NFKC").toLowerCase();
    const currentText = `${current.description} ${current.suggestion}`, oldText = `${old.description} ${old.suggestion}`;
    const exactDescription = current.description.normalize("NFKC").trim() === old.description.normalize("NFKC").trim();
    if ((sameCause || sameDimension || sameCategory) && shared >= 2 && (matchingCause(currentText, oldText) || exactDescription)) score = Math.max(score, shared + (sameCause ? 8 : sameDimension ? 4 : 0));
  }
  // Free-text requests need at least three meaningful shared terms. One shared
  // subject (money, contract, dinner) never establishes the same editing cause.
  const oldRequest = [record.revisionInstruction, ...record.issues.map(issue => `${issue.description} ${issue.suggestion}`)].join(" ");
  const instructionMatch = overlap(query, oldRequest);
  if (instructionMatch >= 3 && matchingCause(query, oldRequest)) score = Math.max(score, instructionMatch);
  return score;
}
function renderExperience(record: RevisionExperience, outcomes: ReadonlyArray<RevisionOutcome>, preferred: boolean, before: string, after: string, language: "ko" | "en" | "zh"): string {
  const d = record.diff;
  const excerpt = (body: string, start: number, end: number) => {
    let a = Math.max(0, start - 120), b = Math.min(body.length, end + 120);
    if (insideSurrogate(body, a)) a--; if (insideSurrogate(body, b)) b++;
    return body.slice(a, b);
  };
  const title = language === "ko" ? "같은 작품의 이전 수정 사례" : language === "zh" ? "同一作品的既有修改案例" : "Prior revision from this Book";
  const selection = language === "ko"
    ? `${preferred ? "호출자가 명시적으로 고른 참고 후보입니다." : "자동 검토에서 선택된 후보이며 사람의 품질·취향 승인이 아닙니다."} 동일한 결함 원인이 있는 범위에서만 참고하고 설정·사건·표현을 복사하지 마세요.`
    : language === "zh" ? `${preferred ? "调用者明确选择了这个参考候选。" : "自动审核选中了此候选，并非人的质量或偏好认可。"}仅参考相同缺陷原因的修改，不要复制设定、事件或表达。`
      : `${preferred ? "The caller explicitly selected this reference candidate." : "An automatic review selected this candidate; this is not human quality or preference approval."} Use only for the same editing cause. Do not copy setting, events or wording.`;
  return `## ${title}\n${selection}\n`
    + `Chapter ${record.chapterNumber}; experience ${record.experienceId}\nBefore SHA-256: ${record.before.sha256}\nAfter SHA-256: ${record.after.sha256}\nRecorded automatic outcomes: ${outcomes.length ? [...new Set(outcomes.map(outcome => outcome.status))].sort().join(", ") : "none (candidate only)"}\n`
    + (record.derivedFrom ? `Host surface normalization (${record.derivedFrom.language}); raw experience ${record.derivedFrom.experienceId}; raw after SHA-256: ${record.derivedFrom.afterSha256}\n` : "")
    + `Requested: ${JSON.stringify(record.revisionInstruction)}\nIssues: ${record.issues.map(issue => `${issue.category}: ${issue.description} / ${issue.suggestion}`).join("; ")}\n`
    + `Before (${d.beforeStart}:${d.beforeEnd} UTF-16 changed range, with nearby context):\n${JSON.stringify(excerpt(before, d.beforeStart, d.beforeEnd))}\n`
    + `After (${d.afterStart}:${d.afterEnd} UTF-16 changed range, with nearby context):\n${JSON.stringify(excerpt(after, d.afterStart, d.afterEnd))}\n`
    + `Preservation evidence: ${record.preservedQuotes.length ? record.preservedQuotes.map(item => `${JSON.stringify(item.quote)} — ${item.reason}`).join("; ") : "No explicit preservation quotes were supplied; causal fidelity has not been proven."}`;
}
export async function loadRevisionExperienceContext(bookDir: string, input: {
  readonly bookId: string; readonly chapterNumber: number; readonly issues?: ReadonlyArray<AuditIssue>; readonly query?: string;
  readonly preferredExperienceIds?: ReadonlyArray<string>; readonly maxCharacters?: number; readonly maxCases?: number;
  readonly language?: "ko" | "en" | "zh";
}): Promise<{ rendered: string; records: RevisionExperience[]; diagnostics: Array<{ id: string; reason: string }> }> {
  const empty = { rendered: "", records: [] as RevisionExperience[], diagnostics: [] as Array<{ id: string; reason: string }> };
  const query = input.query ?? "", issues = input.issues ?? [];
  if (!issues.length && terms(query).size < 3) return empty;
  await verifyBook(bookDir, input.bookId); Chapter.parse(input.chapterNumber);
  const budget = input.maxCharacters ?? 6000, maxCases = input.maxCases ?? 2;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > 24000 || !Number.isSafeInteger(maxCases) || maxCases < 0 || maxCases > 6) throw new Error("Invalid revision experience budget");
  const preferred = new Set((input.preferredExperienceIds ?? []).map(id => Hash.parse(id)));
  let names: string[], outcomeNames: string[];
  try { names = await readdir(directory(bookDir)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw error; }
  try { outcomeNames = await readdir(join(directory(bookDir), "outcomes")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") outcomeNames = []; else throw error; }
  const candidates: Array<{ record: RevisionExperience; block: string; score: number }> = [];
  for (const name of names.filter(name => /^\d+-[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const [chapterString, idWithSuffix] = name.split("-"), id = idWithSuffix!.slice(0, -5), chapter = Number(chapterString);
    if (chapter > input.chapterNumber) { empty.diagnostics.push({ id, reason: "future-experience" }); continue; }
    try {
      const { record, before, after } = await readExperience(bookDir, input.bookId, chapter, id);
      if (record.status !== "candidate") { empty.diagnostics.push({ id, reason: record.status }); continue; }
      if (record.preservedQuotes.some(item => !item.presentAfter)) { empty.diagnostics.push({ id, reason: "declared-causal-evidence-removed" }); continue; }
      const score = relevance(record, issues, query);
      if (!score) { empty.diagnostics.push({ id, reason: "different-or-insufficient-editing-cause" }); continue; }
      const outcomes: RevisionOutcome[] = [];
      for (const outcomeName of outcomeNames.filter(name => name.startsWith(`${id}-`) && /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name))) {
        const file = join(directory(bookDir), "outcomes", outcomeName), stat = await lstat(file);
        if (!stat.isFile() || stat.size > 128000) throw new Error("revision-invalid-outcome-file");
        const outcome = RevisionOutcomeSchema.parse(JSON.parse(await readFile(file, "utf8")));
        const { outcomeId, ...rest } = outcome;
        if (outcome.bookId !== input.bookId || outcome.experienceId !== id || outcome.chapterNumber !== chapter || outcomeName !== `${id}-${outcomeId}.json` || sha(canonical(rest)) !== outcomeId) throw new Error("revision-outcome-binding-mismatch");
        outcomes.push(outcome);
      }
      const automatic = outcomes.find(outcome => outcome.status === "automatic-selected");
      // Conflicting automatic outcomes are not reduced to whichever file was read first.
      if (!preferred.has(id) && (!automatic || outcomes.some(outcome => outcome.status !== "automatic-selected"))) { empty.diagnostics.push({ id, reason: outcomes.length ? "unselected-tied-invalid-or-conflicting-outcome" : "unselected-candidate" }); continue; }
      candidates.push({ record, score, block: renderExperience(record, outcomes, preferred.has(id), before, after, input.language ?? "ko") });
    } catch (error) { empty.diagnostics.push({ id, reason: error instanceof Error ? error.message : "unreadable-experience" }); }
  }
  candidates.sort((a, b) => b.score - a.score || b.record.chapterNumber - a.record.chapterNumber || (a.record.experienceId < b.record.experienceId ? -1 : 1));
  const blocks: string[] = []; let used = 0;
  for (const candidate of candidates) {
    if (empty.records.length >= maxCases || used + candidate.block.length + (blocks.length ? 2 : 0) > budget) { empty.diagnostics.push({ id: candidate.record.experienceId, reason: "whole-pair-budget" }); continue; }
    blocks.push(candidate.block); empty.records.push(candidate.record); used += candidate.block.length + (blocks.length > 1 ? 2 : 0);
  }
  empty.rendered = blocks.join("\n\n");
  return empty;
}
