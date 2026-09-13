import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChapterVersion } from "../state/chapter-workspace.js";
import { ReviserAgent, type ReviseOutput } from "../agents/reviser.js";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import { runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import { computeRevisionExperienceDiff, loadRevisionExperienceContext, recordNormalizedRevisionExperience, recordRevisionExperience, recordRevisionOutcome } from "../planning/revision-experience.js";
import { normalizePostWriteSurface } from "../agents/post-write-validator.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ISSUE: AuditIssue = { severity: "critical", category: "문장 기능", description: "지훈 계약금 설명 반복으로 선택 근거가 묻힌다.", suggestion: "계약금 재설명을 줄이되 선택 근거를 남긴다.", ruleId: "redundant-explanation", dimensionId: 3 };
const before = "🍲 지훈은 계약금 액수를 다시 설명했다. 다시 말해 돈이 많다는 뜻이었다. 딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다.";
const after = "🍲 지훈은 계약금 액수를 확인했다. 딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다.";
const output = (revisedContent = after, extra: Partial<ReviseOutput> = {}): ReviseOutput => ({ revisedContent, wordCount: revisedContent.length, fixedIssues: ["계약금 반복 설명 축소"], updatedState: "", updatedLedger: "", updatedHooks: "", applied: revisedContent !== before, ...extra });
const assessment = (content: string, passed = true, score = 90, parseFailed = false) => ({ content, auditResult: { passed, overallScore: score, parseFailed }, lengthInRange: true });

describe("revision experience keeps source and automatic outcome separate", () => {
  let bookDir: string;
  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "inkos-revision-experience-"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "book-a" }));
  });
  afterEach(async () => { await rm(bookDir, { recursive: true, force: true }); });
  const record = (dir: string, extra: Partial<Parameters<typeof recordRevisionExperience>[1]> = {}) => recordRevisionExperience(dir, { bookId: "book-a", chapterNumber: 2, beforeContent: before, output: output(), issues: [ISSUE], ...extra });
  const load = (dir: string, extra: Partial<Parameters<typeof loadRevisionExperienceContext>[1]> = {}) => loadRevisionExperienceContext(dir, { bookId: "book-a", chapterNumber: 3, issues: [ISSUE], ...extra });
  async function selected(dir: string, id: string) {
    return recordRevisionOutcome(dir, { bookId: "book-a", chapterNumber: 2, experienceId: id, cycleId: "cycle-a", selectedContent: after,
      snapshots: [assessment(before, false, 95), assessment(after, true, 80)] });
  }
  it("stores exact reconstructable diffs, hashes and idempotent candidate receipts", async () => {
    const a = await record(bookDir), b = await record(bookDir);
    expect(a).toEqual(b); expect(a.record.status).toBe("candidate");
    expect(a.record.before.sha256).toBe(sha(before)); expect(a.record.after.sha256).toBe(sha(after));
    const d = a.record.diff;
    expect(before.slice(0, d.beforeStart) + d.added + before.slice(d.beforeEnd)).toBe(after);
    expect(before.slice(d.beforeStart, d.beforeEnd)).toBe(d.removed);
    expect(a.record.qualityVerdict).toBe("not-assessed"); expect(a.record.canonApplied).toBe(false);
    expect((await readdir(join(bookDir, "story/runtime/revision-experiences/texts"))).length).toBe(2);
  });
  it("does not split surrogate pairs and handles insertion, deletion, CRLF and multiple edits", () => {
    for (const [a, b] of [["😀 x", "😁 x"], ["a", "ab"], ["ab", "b"], ["a\r\nb", "a\nb"], ["a x b y c", "a XX b YY c"], ["same", "same"]]) {
      const d = computeRevisionExperienceDiff(a!, b!);
      expect(a!.slice(0, d.beforeStart) + d.added + a!.slice(d.beforeEnd)).toBe(b);
      expect(d.removed).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      expect(d.added).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });
  it("binds a host-normalized candidate to its immutable raw experience and preserves the original diagnosis", async () => {
    const rawAfter = after + "\r\n[reviser-note] 표면 메모\r\n지훈은 펜을 들었다——계약 조건을 적었다.";
    const causalQuote = "딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다.";
    const raw = await record(bookDir, { output: output(rawAfter), revisionInstruction: "반복 설명만 줄이고 선택 근거를 보존한다.",
      preserveQuotes: [{ quote: causalQuote, reason: "근무 조건을 고집하는 이유" }] });
    const originalRecord = await readFile(raw.path, "utf8");
    const effectiveContent = normalizePostWriteSurface(rawAfter, "ko");
    const input = { bookId: "book-a", chapterNumber: 2, experienceId: raw.record.experienceId, effectiveContent, language: "ko" as const };
    const derived = await recordNormalizedRevisionExperience(bookDir, input);
    expect(await recordNormalizedRevisionExperience(bookDir, input)).toEqual(derived);
    expect(derived.record.experienceId).not.toBe(raw.record.experienceId);
    expect(derived.record).toMatchObject({ before: raw.record.before, issues: raw.record.issues, revisionInstruction: raw.record.revisionInstruction,
      sourceAttribution: "host-recorded-post-write-surface-normalization", derivedFrom: { experienceId: raw.record.experienceId, afterSha256: sha(rawAfter), reason: "post-write-surface-normalization", language: "ko" } });
    expect(derived.record.after.sha256).toBe(sha(effectiveContent));
    expect(derived.record.preservedQuotes).toEqual(raw.record.preservedQuotes);
    const diff = derived.record.diff;
    expect(before.slice(0, diff.beforeStart) + diff.added + before.slice(diff.beforeEnd)).toBe(effectiveContent);
    expect(await readFile(raw.path, "utf8")).toBe(originalRecord);
    const rawTextFile = join(bookDir, "story/runtime/revision-experiences/texts", `${raw.record.after.sha256}.txt`);
    expect(await readFile(rawTextFile, "utf8")).toBe(rawAfter);
    await recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 2, experienceId: derived.record.experienceId, cycleId: "normalized",
      selectedContent: effectiveContent, snapshots: [assessment(before, false), assessment(effectiveContent)] });
    const context = await load(bookDir);
    expect(context.records.map(item => item.experienceId)).toEqual([derived.record.experienceId]);
    expect(context.rendered).toContain(`raw experience ${raw.record.experienceId}`);
    await writeFile(rawTextFile, rawAfter + "tampered");
    const changed = await load(bookDir);
    expect(changed.records).toEqual([]);
    expect(changed.diagnostics.find(item => item.id === derived.record.experienceId)?.reason).toBe("revision-text-hash-mismatch");
  });
  it("does not call arbitrary prose edits surface normalization or derive another derived record", async () => {
    const rawAfter = after + "\r\n지훈은 계약서를 접었다.";
    const raw = await record(bookDir, { output: output(rawAfter) });
    const input = { bookId: "book-a", chapterNumber: 2, experienceId: raw.record.experienceId, effectiveContent: rawAfter + "새 사건", language: "ko" as const };
    await expect(recordNormalizedRevisionExperience(bookDir, input)).rejects.toThrow("normalization-content-mismatch");
    const derived = await recordNormalizedRevisionExperience(bookDir, { ...input, effectiveContent: normalizePostWriteSurface(rawAfter, "ko") });
    await expect(recordNormalizedRevisionExperience(bookDir, { ...input, experienceId: derived.record.experienceId, effectiveContent: normalizePostWriteSurface(rawAfter, "ko") }))
      .rejects.toThrow("normalization-source-must-be-raw");
    const unchanged = await record(bookDir);
    const names = await readdir(join(bookDir, "story/runtime/revision-experiences"));
    expect(await recordNormalizedRevisionExperience(bookDir, { ...input, experienceId: unchanged.record.experienceId, effectiveContent: after })).toEqual(unchanged);
    expect(await readdir(join(bookDir, "story/runtime/revision-experiences"))).toEqual(names);
  });
  it("rejects same expected SHA attached to different text and inconsistent parser status", async () => {
    await expect(record(bookDir, { expectedAfterSha256: sha(before) })).rejects.toThrow("expected-text-hash-mismatch");
    await expect(record(bookDir, { output: output(after, { parseFailed: true }) })).rejects.toThrow("status-content-conflict");
    await expect(record(bookDir, { output: output(after, { applied: false }) })).rejects.toThrow("status-content-conflict");
  });
  it("reuses the existing chapter version archive instead of duplicating its body", async () => {
    const archived = await archiveChapterVersion(bookDir, 2, before, "revision");
    const result = await record(bookDir, { beforeVersionId: archived.id });
    expect(result.record.before).toMatchObject({ kind: "chapter-version", versionId: archived.id });
    expect((await readdir(join(bookDir, "story/runtime/revision-experiences/texts"))).length).toBe(1);
    await expect(record(bookDir, { beforeVersionId: archived.id, beforeContent: before + "changed" })).rejects.toThrow("archive-content-mismatch");
  });
  it("records no-op, parse failure and protected original without promoting them", async () => {
    for (const [expected, extra] of [["no-op", {}], ["parse-failed", { parseFailed: true }], ["preserved", { failureReason: "Declared causal anchor would be erased." }]] as const) {
      const result = await record(bookDir, { output: output(before, { applied: false, ...extra }) });
      expect(result.record.status).toBe(expected);
    }
    expect((await load(bookDir)).records).toEqual([]);
  });
  it("does not supply a candidate without an actual selection or explicit preference", async () => {
    const result = await record(bookDir);
    const automatic = await load(bookDir);
    expect(automatic.rendered).toBe(""); expect(automatic.diagnostics[0]!.reason).toBe("unselected-candidate");
    const preferred = await load(bookDir, { preferredExperienceIds: [result.record.experienceId] });
    expect(preferred.records.length).toBe(1); expect(preferred.rendered).toContain("호출자가 명시적으로 고른 참고 후보");
  });
  it("records a hard-gate selection independently of advisory score and human taste", async () => {
    const experience = await record(bookDir);
    const outcome = await selected(bookDir, experience.record.experienceId);
    expect(outcome.record.status).toBe("automatic-selected"); expect(outcome.record.humanPreferenceEstablished).toBe(false);
    expect(await selected(bookDir, experience.record.experienceId)).toEqual(outcome);
    const context = await load(bookDir); expect(context.records.length).toBe(1);
    expect(context.rendered).toContain("사람의 품질·취향 승인이 아닙니다");
  });
  it("distinguishes tie, not selected and invalid assessment and excludes their examples", async () => {
    const experience = await record(bookDir), id = experience.record.experienceId;
    for (const [cycleId, selectedContent, snapshots, status] of [
      ["tie", before, [assessment(before, true, 90), assessment(after, true, 92)], "tie"],
      ["failed", before, [assessment(before, true, 90), assessment(after, false, 100)], "not-selected"],
      ["invalid", before, [assessment(before, true), assessment(after, true, 99, true)], "invalid-assessment"],
      ["unknown", "not a snapshot", [assessment(before), assessment(after)], "invalid-assessment"],
    ] as const) {
      const result = await recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 2, experienceId: id, cycleId, selectedContent, snapshots });
      expect(result.record.status).toBe(status);
    }
    expect((await load(bookDir)).records).toEqual([]);
  });
  it("does not select a different failure cause merely because character and contract words match", async () => {
    const experience = await record(bookDir); await selected(bookDir, experience.record.experienceId);
    const otherCause = { ...ISSUE, description: "지훈 계약금 대사의 화자가 혼동된다.", suggestion: "지훈 계약금 대사의 화자를 명시한다.", ruleId: "speaker-attribution" };
    const result = await load(bookDir, { issues: [otherCause] });
    expect(result.records).toEqual([]); expect(result.diagnostics[0]!.reason).toBe("different-or-insufficient-editing-cause");
    expect((await load(bookDir, { issues: [], query: "지훈 계약금 계약서" })).records).toEqual([]);
    expect((await load(bookDir, { issues: [], query: "지훈 계약금 설명 반복을 줄인다" })).records.length).toBe(1);
  });
  it("never reuses a candidate that erased an explicitly supplied causal quote", async () => {
    const quote = "딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다.";
    const shortened = "🍲 지훈은 계약금 액수를 확인했다.";
    const experience = await record(bookDir, { output: output(shortened), preserveQuotes: [{ quote, reason: "근무 조건을 고집하는 선택 이유" }] });
    await recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 2, experienceId: experience.record.experienceId, cycleId: "short", selectedContent: shortened,
      snapshots: [assessment(before, false, 70), assessment(shortened, true, 95)] });
    const result = await load(bookDir, { preferredExperienceIds: [experience.record.experienceId] });
    expect(result.records).toEqual([]); expect(result.diagnostics[0]!.reason).toBe("declared-causal-evidence-removed");
  });
  it("keeps complete before/after pairs within budget and excludes future or other-Book records", async () => {
    const experience = await record(bookDir); await selected(bookDir, experience.record.experienceId);
    const small = await load(bookDir, { maxCharacters: 50 }); expect(small.rendered).toBe(""); expect(small.diagnostics[0]!.reason).toBe("whole-pair-budget");
    expect((await load(bookDir, { chapterNumber: 1 })).diagnostics[0]!.reason).toBe("future-experience");
    await expect(load(bookDir, { bookId: "other-book" })).rejects.toThrow("book-mismatch");
    expect(await loadRevisionExperienceContext("/missing-book", { bookId: "other", chapterNumber: 1, query: "수정해줘" })).toEqual({ rendered: "", records: [], diagnostics: [] });
  });
  it("detects body and outcome tampering on read instead of relying on successful writes", async () => {
    const experience = await record(bookDir); const outcome = await selected(bookDir, experience.record.experienceId);
    const file = join(bookDir, "story/runtime/revision-experiences/texts", `${experience.record.after.sha256}.txt`);
    await writeFile(file, "different body");
    expect((await load(bookDir)).diagnostics[0]!.reason).toBe("revision-text-hash-mismatch");
    await writeFile(file, after);
    const raw = JSON.parse(await readFile(outcome.path, "utf8")); raw.status = "tie";
    await writeFile(outcome.path, JSON.stringify(raw));
    expect((await load(bookDir)).diagnostics[0]!.reason).toBe("revision-outcome-binding-mismatch");
  });
  it("preserves the actual Reviser parser result including parse-failure fallback", async () => {
    const reviser = Object.create(ReviserAgent.prototype) as { parseOutput: (text: string, genre: { numericalSystem: boolean }, mode: string, original: string, format: string) => ReviseOutput };
    const parsed = reviser.parseOutput("malformed response", { numericalSystem: false }, "auto", before, "allow-full");
    expect(parsed.revisedContent).toBe(before); expect(parsed.parseFailed).toBe(true);
    const result = await record(bookDir, { output: parsed });
    expect(result.record.status).toBe("parse-failed");
  });
  it("records the real existing review cycle's chosen snapshot without changing its selection", async () => {
    const original = before + "가".repeat(140), revised = after + "가".repeat(140);
    const snapshots: Array<{ content: string; auditResult: AuditResult; lengthInRange: boolean }> = [];
    let experienceId = "";
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const result = await runChapterReviewCycle({ book: { genre: "urban" }, bookDir, chapterNumber: 2,
      initialOutput: { content: original, wordCount: original.length, postWriteErrors: [] }, initialUsage: zero,
      lengthSpec: { target: 220, softMin: 160, softMax: 280, hardMin: 130, hardMax: 300, countingMode: "zh_chars", normalizeMode: "none" },
      createReviser: () => ({ reviseChapter: async () => {
        const candidate = output(revised); const stored = await record(bookDir, { beforeContent: original, output: candidate });
        experienceId = stored.record.experienceId; return candidate;
      } }),
      auditor: { auditChapter: async (_dir, content) => {
        const auditResult: AuditResult = { passed: content === revised, issues: content === revised ? [] : [{ ...ISSUE, automaticRevisionEligible: true }], summary: "fixture", overallScore: content === revised ? 80 : 95 };
        snapshots.push({ content, auditResult, lengthInRange: true }); return auditResult;
      } },
      normalizeDraftLengthIfNeeded: async content => ({ content, wordCount: content.length, applied: false }),
      assertChapterContentNotEmpty: () => {}, addUsage: () => zero, analyzeAITells: () => ({ issues: [] }),
      analyzeSensitiveWords: () => ({ track: "publication-compatibility", found: [], issues: [] }), logWarn: () => {}, logStage: () => {},
    });
    expect(result.finalContent).toBe(revised); expect(snapshots.length).toBe(2);
    const outcome = await recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 2, experienceId, cycleId: "real-review-cycle-fixture", selectedContent: result.finalContent, snapshots });
    expect(outcome.record.status).toBe("automatic-selected");
    expect((await load(bookDir)).records.length).toBe(1);
  });
});
