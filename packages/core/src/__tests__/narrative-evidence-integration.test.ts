import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookConfigSchema } from "../models/book.js";
import { WriterAgent, type WriteChapterOutput, type NarrativeEvidenceObservation } from "../agents/writer.js";
import { PlannerAgent } from "../agents/planner.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { readNarrativeEvidenceContext } from "../state/narrative-evidence.js";
import { runChapterPersistenceTransaction } from "../pipeline/chapter-persistence.js";
let root: string, bookDir: string;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const book = BookConfigSchema.parse({ id: "narrative-book", title: "약속", genre: "other", platform: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" });
const body = "지훈은 새 집 열쇠를 받았다. 서연은 아직 새 집 주소를 몰랐다. 지훈은 처음으로 자기 방에서 문을 잠그고 잠들었다.";
const entries = [
  { kind: "reward", threadId: "own-room", character: "지훈", stage: "acquisition", evidence: "지훈은 새 집 열쇠를 받았다." },
  { kind: "reward", threadId: "own-room", character: "지훈", stage: "experience", evidence: "지훈은 처음으로 자기 방에서 문을 잠그고 잠들었다." },
  { kind: "reader-disclosure", informationId: "new-address", evidence: "지훈은 새 집 열쇠를 받았다." },
  { kind: "character-awareness", informationId: "new-address", character: "서연", awareness: "unaware", evidence: "서연은 아직 새 집 주소를 몰랐다." },
];
const ctx = () => ({ projectRoot: root, bookId: book.id, model: "test", client: { provider: "openai" as const, apiFormat: "chat" as const, stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } });
function output(observation?: NarrativeEvidenceObservation): WriteChapterOutput { return {
  chapterNumber: 1, title: "집", content: body, wordCount: body.length, preWriteCheck: "", postSettlement: "", updatedState: "", updatedLedger: "", updatedHooks: "", chapterSummary: "", updatedSubplots: "", updatedEmotionalArcs: "", updatedCharacterMatrix: "", postWriteErrors: [], postWriteWarnings: [],
  narrativeEvidenceObservation: observation ?? { bookId: book.id, chapterTextSha256: sha(body), entries },
}; }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "narrative-evidence-integration-")); bookDir = join(root, "book"); await mkdir(join(bookDir, "story"), { recursive: true }); await writeFile(join(bookDir, "book.json"), JSON.stringify(book)); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it("extracts in the existing settlement call, saves exact evidence with the Chapter, and delivers to the next Planner", async () => {
  const writer = new WriterAgent(ctx()); const { profile } = await readGenreProfile(root, "other");
  const chat = vi.spyOn(writer as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
    .mockResolvedValueOnce({ content: "=== OBSERVATIONS ===\n관찰", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
    .mockResolvedValueOnce({ content: `=== POST_SETTLEMENT ===\n완료\n=== RUNTIME_STATE_DELTA ===\n${JSON.stringify({ chapter: 1, entityObservations: [] })}\n=== NARRATIVE_EVIDENCE ===\n${JSON.stringify(entries)}`, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  const result = await (writer as unknown as { settle: (input: Record<string, unknown>) => Promise<{settlement:{narrativeEvidenceObservation?: NarrativeEvidenceObservation}}> }).settle({ bookDir,
    book: { ...book, writing: { authorCraft: { packSha256: "0".repeat(64) } } }, genreProfile: profile, bookRules: null, chapterNumber: 1, title: "집", content: body,
    currentState: "", ledger: "", hooks: "", chapterSummaries: "", subplotBoard: "", emotionalArcs: "", characterMatrix: "", volumeOutline: "", originalHooks: "", originalSubplots: "", originalEmotionalArcs: "", originalCharacterMatrix: "",
  });
  expect(chat).toHaveBeenCalledTimes(2);
  expect((chat.mock.calls[1]![0] as Array<{content:string}>)[1]!.content).toContain("NARRATIVE_EVIDENCE");
  await writer.saveChapter(bookDir, output(result.settlement.narrativeEvidenceObservation), false, "ko");
  const read = await readNarrativeEvidenceContext(bookDir, { bookId: book.id, throughChapter: 1 });
  expect(read.receipt.selectedEntryIds).toHaveLength(4);
  const planner = new PlannerAgent(ctx()); const planChat = vi.spyOn(planner as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(planner.planChapter({ book, bookDir, chapterNumber: 2, externalContext: "자기 방" })).rejects.toThrow("captured");
  expect(planChat).toHaveBeenCalledTimes(1);
  const prompt = (planChat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content;
  expect(prompt).toContain("reward thread own-room"); expect(prompt).toContain("acquisition"); expect(prompt).toContain("experience"); expect(prompt).toContain("모든 등장인물이 아는 정보가 아니다");
});
it("delivers POV-safe evidence to the actual Writer and excludes changed source bytes", async () => {
  const writer = new WriterAgent(ctx()); await writer.saveChapter(bookDir, output(), false, "ko");
  await writeFile(join(bookDir, "story/volume_outline.md"), "## 2화\n시점: 지훈\n방에서 잠을 잔다.");
  const chat = vi.spyOn(writer as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(writer.writeChapter({ book, bookDir, chapterNumber: 2 })).rejects.toThrow("captured");
  const prompt = (chat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content;
  expect(prompt).toContain("reward thread own-room"); expect(prompt).not.toContain("character-awareness new-address · 서연");
  await writeFile(join(bookDir, "chapters/0001_집.md"), "# 1화 집\n\n바뀐 원고");
  expect((await readNarrativeEvidenceContext(bookDir, { bookId: book.id, throughChapter: 1 })).rendered).toBe("");
});
it("does not retain pre-revision labels when any body byte changes", async () => {
  const writer = new WriterAgent(ctx()); await writer.saveChapter(bookDir, output(), false, "ko");
  await writer.saveChapter(bookDir, { ...output(), content: body + " 그러나 실제 만족은 아니었다." }, false, "ko");
  const read = await readNarrativeEvidenceContext(bookDir, { bookId: book.id, throughChapter: 1 });
  expect(read.records[0]!.entries).toEqual([]); expect(read.rendered).toBe("");
});
it("rolls the current evidence pointer back together with its manuscript after a later persistence failure", async () => {
  const writer = new WriterAgent(ctx()); await writer.saveChapter(bookDir, output(), false, "ko");
  const pointer = join(bookDir, "story/runtime/narrative-evidence/chapters/000001.json");
  const before = await readFile(pointer, "utf8");
  await expect(runChapterPersistenceTransaction({ bookDir, chapterNumber: 1, persist: async () => { await writer.saveChapter(bookDir, { ...output(), content: body + " 바뀐다." }, false, "ko"); throw new Error("later-failure"); } })).rejects.toThrow("later-failure");
  expect(await readFile(pointer, "utf8")).toBe(before);
  expect((await readNarrativeEvidenceContext(bookDir, { bookId: book.id, throughChapter: 1 })).receipt.selectedEntryIds).toHaveLength(4);
});
it("preserves malformed optional records without overwriting them or blocking chapter persistence", async () => {
  const writer = new WriterAgent(ctx()); await writer.saveChapter(bookDir, output(), false, "ko");
  const pointer = JSON.parse(await readFile(join(bookDir, "story/runtime/narrative-evidence/chapters/000001.json"), "utf8"));
  const immutable = join(bookDir, `story/runtime/narrative-evidence/records/${pointer.recordSha256}.json`);
  await writeFile(immutable, "corrupted");
  await expect(writer.saveChapter(bookDir, output(), false, "ko")).resolves.toBeUndefined();
  expect(await readFile(immutable, "utf8")).toBe("corrupted");
});

it("does not let an optional evidence directory symlink write outside the Book", async () => {
  const outside = join(root, "outside"); await mkdir(outside);
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  await symlink(outside, join(bookDir, "story/runtime/narrative-evidence"));
  const writer = new WriterAgent(ctx());
  await expect(writer.saveChapter(bookDir, output(), false, "ko")).resolves.toBeUndefined();
  expect(await readdir(outside)).toEqual([]);
  expect(await readFile(join(bookDir, "chapters/0001_집.md"), "utf8")).toContain(body);
});
