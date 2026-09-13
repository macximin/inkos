import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviserAgent } from "../agents/reviser.js";
import { normalizePostWriteSurface } from "../agents/post-write-validator.js";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { LLMClient } from "../llm/provider.js";
import type { LengthSpec } from "../models/length-governance.js";
import { runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import { loadRevisionExperienceContext, recordRevisionOutcome, RevisionExperienceSchema, RevisionOutcomeSchema } from "../planning/revision-experience.js";

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const LENGTH: LengthSpec = { target: 220, softMin: 100, softMax: 350, hardMin: 70, hardMax: 400, countingMode: "ko_chars", normalizeMode: "none" };
const ISSUE: AuditIssue = { severity: "critical", category: "선택 근거", description: "지훈 계약금 설명 반복으로 선택 근거가 묻힌다.",
  suggestion: "계약금 재설명을 줄이되 선택 근거를 보존한다.", repairScope: "structural", ruleId: "redundant-explanation", dimensionId: 3, automaticRevisionEligible: true };
const BEFORE = "지훈은 계약금 액수를 다시 설명했다. 다시 말해 돈이 많다는 뜻이었다. 딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다. " + "계약서의 마지막 줄에 퇴근 시간이 적혀 있었다. ".repeat(3).trim();
const AFTER = "지훈은 계약금 액수를 확인했다. 딸과 저녁을 먹겠다는 약속 때문에 근무 조건을 고집했다. " + "계약서의 마지막 줄에 퇴근 시간이 적혀 있었다. ".repeat(3).trim();
const NEXT = "준서는 계약금 설명을 되풀이했다. 계약금이 충분하다는 뜻이었다. 동생에게 약속한 날을 지키려고 방문 일정을 고집했다. " + "약속한 날짜는 다음 주 금요일이었다. ".repeat(3).trim();
const NEXT_AFTER = "준서는 계약금을 확인했다. 동생에게 약속한 날을 지키려고 방문 일정을 고집했다. " + "약속한 날짜는 다음 주 금요일이었다. ".repeat(3).trim();
function envelope(body: string) {
  return ["=== FIXED_ISSUES ===", "- 반복 설명을 축소하고 선택 이유를 유지했다.", "=== REVISED_CONTENT ===", body,
    "=== UPDATED_STATE ===", "# 현재 상태\n\n| 항목 | 값 |\n| --- | --- |\n| 현재 회차 | 2 |",
    "=== UPDATED_LEDGER ===", "# 자원 장부\n\n| item | value |\n| --- | --- |\n| balance | 0 |",
    "=== UPDATED_HOOKS ===", "# 복선\n\n| hook_id | status |\n| --- | --- |", "=== REVISION_COMPLETE ==="].join("\n");
}

describe("real Reviser and review-cycle editing experience integration", () => {
  let root: string, bookDir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-revision-integration-")); bookDir = join(root, "books", "book-a");
    await mkdir(join(bookDir, "story"), { recursive: true }); await mkdir(join(bookDir, "chapters"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "book-a", title: "저녁을 지키는 식당", genre: "urban", platform: "other", status: "active", language: "ko",
      targetChapters: 30, chapterWordCount: 220, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:00:00.000Z" }));
    await writeFile(join(bookDir, "chapters", "0002_계약.md"), BEFORE);
    await writeFile(join(bookDir, "story", "current_state.md"), "# 현재 상태\n\n지훈은 계약서를 검토하고 있다.");
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
  function reviser(contextWindow?: number) {
    const client: LLMClient = { provider: "openai", apiFormat: "chat", stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      ...(contextWindow !== undefined ? { _piModel: { contextWindow } as NonNullable<LLMClient["_piModel"]> } : {}),
    };
    return new ReviserAgent({ client, model: "mocked-chat-boundary", projectRoot: root, bookId: "book-a" });
  }
  function mockChat() {
    return vi.spyOn(ReviserAgent.prototype as never, "chat" as never).mockResolvedValueOnce({ content: envelope(AFTER), usage: ZERO })
      .mockResolvedValue({ content: envelope(NEXT_AFTER), usage: ZERO });
  }
  async function cycle(invalidAfter = false, normalizeSurface = false) {
    const auditChapter = vi.fn().mockImplementation(async (_dir: string, content: string): Promise<AuditResult> => content === BEFORE
      ? { passed: false, issues: [ISSUE], summary: "반복 설명 때문에 선택 근거가 흐려졌다.", overallScore: 95 }
      : { passed: true, issues: [], summary: "지적된 반복을 줄였다.", overallScore: 80, ...(invalidAfter ? { parseFailed: true } : {}) });
    const normalize = vi.fn(async (content: string) => ({ content, wordCount: content.length, applied: false }));
    const result = await runChapterReviewCycle({ book: { id: "book-a", genre: "urban", language: "ko" }, bookDir, chapterNumber: 2,
      initialOutput: { content: BEFORE, wordCount: BEFORE.length, postWriteErrors: [] }, initialUsage: ZERO, lengthSpec: LENGTH,
      createReviser: () => reviser(), auditor: { auditChapter }, normalizeDraftLengthIfNeeded: normalize,
      ...(normalizeSurface ? { normalizePostWriteSurface: (content: string) => normalizePostWriteSurface(content, "ko") } : {}),
      assertChapterContentNotEmpty: content => { expect(content.length).toBeGreaterThan(0); }, addUsage: () => ZERO,
      analyzeAITells: () => ({ issues: [] }), analyzeSensitiveWords: () => ({ track: "publication-compatibility", found: [], issues: [] }),
      logWarn: () => {}, logStage: () => {},
    });
    expect(auditChapter).toHaveBeenCalledTimes(2); expect(normalize).not.toHaveBeenCalled();
    return result;
  }
  async function outcomes() {
    const dir = join(bookDir, "story/runtime/revision-experiences/outcomes");
    return Promise.all((await readdir(dir)).map(async name => RevisionOutcomeSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")))));
  }
  async function chapterTwoExperience() {
    const dir = join(bookDir, "story/runtime/revision-experiences");
    const name = (await readdir(dir)).find(name => /^2-[a-f0-9]{64}\.json$/.test(name))!;
    return RevisionExperienceSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")));
  }
  function promptAt(chat: ReturnType<typeof mockChat>, index: number) {
    return (chat.mock.calls[index]?.[0] as unknown as ReadonlyArray<{ content: string }>).map(message => message.content).join("\n");
  }

  it("runs actual Reviser → experience → review outcome → next Reviser prompt with no extra model call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids live model/network"));
    const chat = mockChat();
    const unchangedPaths = [join(bookDir, "book.json"), join(bookDir, "chapters/0002_계약.md"), join(bookDir, "story/current_state.md")];
    const originals = await Promise.all(unchangedPaths.map(file => readFile(file, "utf8")));
    const result = await cycle(); expect(result.finalContent).toBe(AFTER); expect(chat).toHaveBeenCalledTimes(1);
    const experience = await chapterTwoExperience(); expect(experience.status).toBe("candidate");
    const recorded = await outcomes(); expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ experienceId: experience.experienceId, status: "automatic-selected", humanPreferenceEstablished: false });
    expect(promptAt(chat, 0)).not.toContain("같은 작품의 이전 수정 사례");
    const next = await reviser().reviseChapter(bookDir, NEXT, 3, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    expect(next.revisionExperienceId).toMatch(/^[a-f0-9]{64}$/); expect(chat).toHaveBeenCalledTimes(2);
    const reused = promptAt(chat, 1);
    expect(reused).toContain("같은 작품의 이전 수정 사례"); expect(reused).toContain(experience.experienceId);
    expect(reused).toContain("사람의 품질·취향 승인이 아닙니다"); expect(reused).toContain(experience.before.sha256); expect(reused).toContain(experience.after.sha256);
    expect(reused).toContain("계약금 액수를 다시 설명했다"); expect(reused).toContain("계약금 액수를 확인했다");
    expect(await Promise.all(unchangedPaths.map(file => readFile(file, "utf8")))).toEqual(originals);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("keeps the original after actual re-audit parse failure and withholds that experience from the next prompt", async () => {
    const chat = mockChat();
    const result = await cycle(true); expect(result.finalContent).toBe(BEFORE);
    const recorded = await outcomes(); expect(recorded[0]!.status).toBe("invalid-assessment");
    await reviser().reviseChapter(bookDir, NEXT, 3, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    expect(promptAt(chat, 1)).not.toContain("같은 작품의 이전 수정 사례"); expect(chat).toHaveBeenCalledTimes(2);
    expect(await readFile(join(bookDir, "chapters/0002_계약.md"), "utf8")).toBe(BEFORE);
  });
  it("links actual surface-normalized selection to a distinct experience while preserving the raw Reviser candidate", async () => {
    const rawAfter = AFTER + "\r\n[reviser-note] 이 메모는 원고 밖으로 정리한다.\r\n지훈은 펜을 들었다——계약 조건을 적었다.";
    const effective = normalizePostWriteSurface(rawAfter, "ko");
    const chat = vi.spyOn(ReviserAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({ content: envelope(rawAfter), usage: ZERO }).mockResolvedValue({ content: envelope(NEXT_AFTER), usage: ZERO });
    const result = await cycle(false, true);
    expect(result.finalContent).toBe(effective); expect(chat).toHaveBeenCalledTimes(1);
    const dir = join(bookDir, "story/runtime/revision-experiences");
    const records = await Promise.all((await readdir(dir)).filter(name => /^2-[a-f0-9]{64}\.json$/.test(name))
      .map(async name => RevisionExperienceSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")))));
    expect(records).toHaveLength(2);
    const raw = records.find(record => record.sourceAttribution === "host-recorded-reviser-output")!;
    const derived = records.find(record => record.sourceAttribution === "host-recorded-post-write-surface-normalization")!;
    expect(derived.derivedFrom).toMatchObject({ experienceId: raw.experienceId, afterSha256: raw.after.sha256, language: "ko" });
    const rawPath = join(dir, `2-${raw.experienceId}.json`), rawReceipt = await readFile(rawPath, "utf8");
    expect(await readFile(join(dir, "texts", `${raw.after.sha256}.txt`), "utf8")).toBe(rawAfter);
    expect(await readFile(join(dir, "texts", `${derived.after.sha256}.txt`), "utf8")).toBe(effective);
    const recorded = await outcomes();
    expect(recorded.find(record => record.experienceId === derived.experienceId)?.status).toBe("automatic-selected");
    expect(recorded.some(record => record.experienceId === raw.experienceId && record.status === "automatic-selected")).toBe(false);
    await reviser().reviseChapter(bookDir, NEXT, 3, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    const reused = promptAt(chat, 1);
    expect(reused).toContain(`experience ${derived.experienceId}`);
    expect(reused).toContain(`raw experience ${raw.experienceId}`);
    expect(reused).not.toContain("이 메모는 원고 밖으로 정리한다.");
    expect(chat).toHaveBeenCalledTimes(2); expect(await readFile(rawPath, "utf8")).toBe(rawReceipt);
    expect(await readFile(join(bookDir, "chapters/0002_계약.md"), "utf8")).toBe(BEFORE);
  });
  it("does not reuse a tied outcome even when the candidate came from the actual Reviser", async () => {
    const chat = mockChat();
    const candidate = await reviser().reviseChapter(bookDir, BEFORE, 2, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    expect(candidate.revisedContent).toBe(AFTER);
    // Current review cycles stop when the first candidate passes; they do not
    // naturally produce two eligible tied candidates. Exercise the same outcome
    // boundary with explicit fixture snapshots, then the actual next Reviser.
    await recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 2, experienceId: candidate.revisionExperienceId!, cycleId: "tie-integration-fixture",
      selectedContent: BEFORE, snapshots: [
        { content: BEFORE, auditResult: { passed: true, overallScore: 90 }, lengthInRange: true },
        { content: AFTER, auditResult: { passed: true, overallScore: 92 }, lengthInRange: true },
      ] });
    expect((await outcomes())[0]!.status).toBe("tie");
    await reviser().reviseChapter(bookDir, NEXT, 3, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    expect(promptAt(chat, 1)).not.toContain("같은 작품의 이전 수정 사례"); expect(chat).toHaveBeenCalledTimes(2);
  });
  it("omits the entire prior pair when the real Reviser has no remaining input budget", async () => {
    const chat = mockChat(); await cycle();
    const direct = await loadRevisionExperienceContext(bookDir, { bookId: "book-a", chapterNumber: 3, issues: [ISSUE], maxCharacters: 10 });
    expect(direct.rendered).toBe(""); expect(direct.diagnostics.some(item => item.reason === "whole-pair-budget")).toBe(true);
    await reviser(256).reviseChapter(bookDir, NEXT, 3, [ISSUE], "auto", "urban", { lengthSpec: LENGTH });
    expect(promptAt(chat, 1)).not.toContain("같은 작품의 이전 수정 사례"); expect(chat).toHaveBeenCalledTimes(2);
  });
  it("keeps different editing causes and no-work calls out of the real prompt path", async () => {
    const chat = mockChat(); await cycle();
    const otherCause = { ...ISSUE, ruleId: "speaker-attribution", description: "지훈 계약금 대사의 화자가 혼동된다.", suggestion: "계약금 대사의 화자를 명시한다." };
    await reviser().reviseChapter(bookDir, NEXT, 3, [otherCause], "auto", "urban", { lengthSpec: LENGTH });
    expect(promptAt(chat, 1)).not.toContain("같은 작품의 이전 수정 사례");
    const filesBefore = await readdir(join(bookDir, "story/runtime/revision-experiences"));
    const noWork = await reviser().reviseChapter(bookDir, NEXT, 4, [], "auto", "urban", { lengthSpec: LENGTH });
    expect(noWork.revisionExperienceId).toBeUndefined(); expect(chat).toHaveBeenCalledTimes(2);
    expect(await readdir(join(bookDir, "story/runtime/revision-experiences"))).toEqual(filesBefore);
  });
});
