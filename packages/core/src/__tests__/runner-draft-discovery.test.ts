import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { BookConfigSchema } from "../models/book.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { LengthNormalizerAgent } from "../agents/length-normalizer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import * as ReviewCycle from "../pipeline/chapter-review-cycle.js";
import * as Discovery from "../planning/draft-discovery-runtime.js";
import { installReadyFixture } from "./fixtures/draft-discovery-fixture.js";
import { writeCompletedOperationEvidenceFixture } from "./helpers/fiction-content-evidence.js";

let root: string, bookDir: string, state: StateManager, runner: PipelineRunner;
let fixture: Awaited<ReturnType<typeof installReadyFixture>>;
const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const body = "지훈은 계약서의 퇴근 시간을 여섯 시로 고쳤다. 딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.";
const suggestions = [{ kind: "new-desire", evidence: "딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.", observation: "딸과의 저녁을 먼저 골랐다.", implication: "보상을 생활에서 쓸 시간을 다음 선택에서 지킨다.",
  futureRevisions: [{ bId: "B002", revision: { narrativeFunction: "퇴근을 지키는 협상", payoffAxis: "함께 먹는 저녁", carriedReaderDebt: "실제로 시간을 지키는가", contrastRequirement: "돈과 시간의 선택" } }] }];
const book = BookConfigSchema.parse({ id: "book-a", title: "저녁", targetChapters: 17, chapterWordCount: 2000,
  genre: "other", platform: "other", status: "active", language: "ko", writing: { reviewMode: "manual" },
  createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runner-discovery-")); state = new StateManager(root); bookDir = state.bookDir(book.id);
  await state.saveBookConfig(book.id, book); await mkdir(join(bookDir, "story"), { recursive: true });
  fixture = await installReadyFixture(bookDir); await state.saveChapterIndex(book.id, fixture.chapters);
  runner = new PipelineRunner({ projectRoot: root, model: "test", inputGovernanceMode: "legacy",
    client: { provider: "openai", apiFormat: "chat", stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } },
    testOnlyFictionContentEvidenceWriter: writeCompletedOperationEvidenceFixture });
  vi.spyOn(LengthNormalizerAgent.prototype, "normalizeChapter").mockImplementation(async ({ chapterContent }) => ({
    normalizedContent: chapterContent, finalCount: chapterContent.length, applied: false, mode: "none", tokenUsage: zero,
  }));
  vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function nextChapterFixture() {
  await rm(join(bookDir, "chapters/0002_Chapter_2.md"));
  await state.saveChapterIndex(book.id, fixture.chapters.filter((chapter) => chapter.number === 1));
}
async function output(): Promise<WriteChapterOutput> {
  const request = await Discovery.prepareDraftDiscoveryRequest(bookDir, book.id, "ko");
  expect(request.basePlanSha256).toBeTruthy();
  return { chapterNumber: 2, title: "Chapter 2", content: body, wordCount: body.length, preWriteCheck: "", postSettlement: "", updatedState: "settled state", updatedLedger: "", updatedHooks: "settled hooks",
    chapterSummary: "| 2 | 저녁 | 지훈 | 계약서의 시간을 바꿈 | 약속을 지킴 | | | |", updatedSubplots: "", updatedEmotionalArcs: "", updatedCharacterMatrix: "", postWriteErrors: [], postWriteWarnings: [], tokenUsage: zero,
    arcProvenance: fixture.chapters[1]!.arcProvenance,
    draftDiscoveryObservation: Discovery.bindDraftDiscoveryObservation({ bookId: book.id, chapter: 2, content: body, basePlanSha256: request.basePlanSha256!, suggestions }),
  };
}
async function discoveryNames() { return readdir(join(bookDir, "story/runtime/draft-discoveries")).catch(() => [] as string[]); }
function observeCommittedCall() {
  const persist = Discovery.persistDraftDiscoveryObservation;
  return vi.spyOn(Discovery, "persistDraftDiscoveryObservation").mockImplementation(async (directory, observation) => {
    expect((await state.loadChapterIndex(book.id)).some((chapter) => chapter.number === 2)).toBe(true);
    expect(await readFile(join(bookDir, "chapters/0002_Chapter_2.md"), "utf8")).toContain(body);
    expect((await readdir(bookDir)).some((name) => name.startsWith(".inkos-chapter-txn-"))).toBe(false);
    return persist(directory, observation);
  });
}

it("records writeDraft evidence after real chapter/index commit and delivers it to the next planning read", async () => {
  await nextChapterFixture(); const generated = await output(); const write = vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(generated);
  const persisted = observeCommittedCall(); const result = await runner.writeDraft(book.id);
  expect(result.chapterNumber).toBe(2); expect(write).toHaveBeenCalledTimes(1); expect(persisted).toHaveBeenCalledTimes(1);
  expect(await discoveryNames()).toHaveLength(1);
  expect((await Discovery.readDraftDiscoveryPlanningContext(bookDir, book.id, "ko", undefined, 2)).rendered).toContain("퇴근을 지키는 협상");
});

it("does not rebind the original observation after draft length normalization changes the body", async () => {
  await nextChapterFixture(); vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(await output());
  vi.mocked(LengthNormalizerAgent.prototype.normalizeChapter).mockResolvedValue({ normalizedContent: body + " 추가된 본문.", finalCount: body.length + 9, applied: true, mode: "expand", tokenUsage: zero });
  await runner.writeDraft(book.id); expect(await discoveryNames()).toEqual([]);
  expect(await readFile(join(bookDir, "chapters/0002_Chapter_2.md"), "utf8")).toContain("추가된 본문");
});

it("does not create an advisory record when a late draft snapshot failure rolls the chapter back", async () => {
  await nextChapterFixture(); vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(await output());
  const persisted = vi.spyOn(Discovery, "persistDraftDiscoveryObservation");
  vi.spyOn(StateManager.prototype, "snapshotState").mockRejectedValueOnce(new Error("late-snapshot-failure"));
  await expect(runner.writeDraft(book.id)).rejects.toThrow("late-snapshot-failure");
  expect(persisted).not.toHaveBeenCalled(); expect(await discoveryNames()).toEqual([]);
  expect((await state.loadChapterIndex(book.id)).map((chapter) => chapter.number)).toEqual([1]);
});

it.each(["repair", "resync"] as const)("records fresh %s settlement evidence after its real artifact transaction", async (kind) => {
  const generated = await output();
  if (kind === "repair") await state.saveChapterIndex(book.id, fixture.chapters.map((chapter) => chapter.number === 2
    ? { ...chapter, status: "state-degraded", reviewNote: JSON.stringify({ kind: "state-degraded", baseStatus: "ready-for-review", injectedIssues: [] }) } : chapter));
  const settle = vi.spyOn(WriterAgent.prototype, "settleChapterState").mockResolvedValue(generated);
  const persisted = observeCommittedCall();
  const result = kind === "repair" ? await runner.repairChapterState(book.id, 2) : await runner.resyncChapterArtifacts(book.id, 2);
  expect(result.chapterNumber).toBe(2); expect(settle).toHaveBeenCalledTimes(1); expect(persisted).toHaveBeenCalledTimes(1);
  expect(await discoveryNames()).toHaveLength(1);
});

it("records existing observations after an import replay commit without requesting any new extraction", async () => {
  await nextChapterFixture(); const generated = await output();
  const analyze = vi.spyOn(ChapterAnalyzerAgent.prototype, "analyzeChapter").mockResolvedValue(generated);
  const persisted = observeCommittedCall();
  const result = await runner.importChapters({ bookId: book.id, resumeFrom: 2, chapters: [{ title: "Chapter 1", content: body }, { title: "Chapter 2", content: body }] });
  expect(result.importedCount).toBe(1); expect(analyze).toHaveBeenCalledTimes(1); expect(persisted).toHaveBeenCalledTimes(1);
  expect(await discoveryNames()).toHaveLength(1);
});

it("keeps write-next evidence after commit and supplies the resolved language to its existing review cycle", async () => {
  await nextChapterFixture(); await state.saveBookConfig(book.id, { ...book, writing: { reviewMode: "auto" } });
  const generated = await output(); vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue(generated);
  const review = vi.spyOn(ReviewCycle, "runChapterReviewCycle").mockResolvedValue({ finalContent: body, finalWordCount: body.length, preAuditNormalizedWordCount: body.length,
    revised: false, auditResult: { passed: true, issues: [], summary: "fixture" }, publicationCompatibility: { track: "publication-compatibility", issues: [], found: [] }, totalUsage: zero, postReviseCount: 0, normalizeApplied: false });
  const persisted = observeCommittedCall(); await runner.writeNextChapter(book.id);
  expect(review).toHaveBeenCalledWith(expect.objectContaining({ book: { id: book.id, genre: book.genre, language: "ko" } }));
  expect(persisted).toHaveBeenCalledTimes(1); expect(await discoveryNames()).toHaveLength(1);
});

it("excludes a mismatched observation Chapter even when another saved Chapter has identical body bytes", async () => {
  await nextChapterFixture(); const generated = await output();
  vi.spyOn(WriterAgent.prototype, "writeChapter").mockResolvedValue({ ...generated, draftDiscoveryObservation: { ...generated.draftDiscoveryObservation!, chapter: 1 } });
  const persisted = vi.spyOn(Discovery, "persistDraftDiscoveryObservation");
  await runner.writeDraft(book.id); expect(persisted).not.toHaveBeenCalled(); expect(await discoveryNames()).toEqual([]);
});
