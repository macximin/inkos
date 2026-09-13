import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installReadyFixture, makeApplyInput } from "./fixtures/draft-discovery-fixture.js";
import { BookConfigSchema } from "../models/book.js";
import { WriterAgent } from "../agents/writer.js";
import { PlannerAgent } from "../agents/planner.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { StoryRailReflowStore } from "../arc/reflow-store.js";
import { createGetStoryRailsTool } from "../agent/story-rail-tools.js";
import { parseDraftDiscoverySuggestions, buildDraftDiscoveryReflowInput } from "../planning/draft-discovery.js";
import { bindDraftDiscoveryObservation, readDraftDiscoveryBookContext, readDraftDiscoveryChapterText, prepareDraftDiscoveryRequest, persistDraftDiscoveryObservation, readDraftDiscoveryPlanningContext, type DraftDiscoveryObservation } from "../planning/draft-discovery-runtime.js";
let root: string, bookDir: string;
const book = BookConfigSchema.parse({ id: "book-a", title: "가족", genre: "other", platform: "other", language: "ko", status: "active", targetChapters: 17, createdAt: "2026-08-09T00:00:00Z", updatedAt: "2026-08-09T00:00:00Z" });
const content = "지훈은 계약서의 퇴근 시간을 여섯 시로 고쳤다. 딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.";
const suggestions = [{ kind: "new-desire", evidence: "딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.", observation: "딸과의 저녁을 먼저 골랐다.", implication: "보상을 생활에서 쓸 시간을 다음 선택에서 지킨다.", futureRevisions: [{ bId: "B002", revision: { narrativeFunction: "퇴근을 지키는 협상", payoffAxis: "함께 먹는 저녁", carriedReaderDebt: "실제로 시간을 지키는가", contrastRequirement: "돈과 시간의 선택" } }] }];
const ctx = () => ({ projectRoot: root, bookId: book.id, model: "test", client: { provider: "openai" as const, apiFormat: "chat" as const, stream: false, defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} } } });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "draft-discovery-runtime-")); bookDir = join(root, "books", book.id);
  const { mkdir } = await import("node:fs/promises"); await mkdir(bookDir, { recursive: true });
  await writeFile(join(bookDir, "book.json"), JSON.stringify(book));
  const fixture = await installReadyFixture(bookDir);
  await writeFile(join(bookDir, "chapters/index.json"), JSON.stringify(fixture.chapters));
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function observation() {
  const request = await prepareDraftDiscoveryRequest(bookDir, book.id, "ko");
  return bindDraftDiscoveryObservation({ bookId: book.id, chapter: 2, content, basePlanSha256: request.basePlanSha256!, suggestions })!;
}
it("takes optional discoveries from the existing two settlement calls and persists only current manuscript evidence", async () => {
  const writer = new WriterAgent(ctx()); const { profile } = await readGenreProfile(root, "other");
  const chat = vi.spyOn(writer as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
    .mockResolvedValueOnce({ content: "=== OBSERVATIONS ===\n관찰", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
    .mockResolvedValueOnce({ content: `=== POST_SETTLEMENT ===\n완료\n=== RUNTIME_STATE_DELTA ===\n${JSON.stringify({ chapter: 2, entityObservations: [] })}\n=== DRAFT_DISCOVERIES ===\n${JSON.stringify(suggestions)}`, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  const result = await (writer as unknown as { settle: (input: Record<string, unknown>) => Promise<{settlement:{draftDiscoveryObservation?: DraftDiscoveryObservation}}> }).settle({
    bookDir, book: { ...book, writing: { authorCraft: { packSha256: "0".repeat(64) } } }, genreProfile: profile, bookRules: null,
    chapterNumber: 2, title: "저녁", content, currentState: "", ledger: "", hooks: "", chapterSummaries: "", subplotBoard: "", emotionalArcs: "", characterMatrix: "", volumeOutline: "", originalHooks: "", originalSubplots: "", originalEmotionalArcs: "", originalCharacterMatrix: "",
  });
  expect(chat).toHaveBeenCalledTimes(2);
  expect((chat.mock.calls[1]![0] as Array<{content:string}>)[1]!.content).toContain("Writable future B directions");
  expect(result.settlement.draftDiscoveryObservation?.suggestions).toEqual(suggestions);
  const saved = await persistDraftDiscoveryObservation(bookDir, result.settlement.draftDiscoveryObservation);
  expect(saved.path).toBeTruthy(); expect(saved.diagnostics).toEqual([]);
  const context = await readDraftDiscoveryPlanningContext(bookDir, book.id, "ko");
  expect(context.rendered).toContain("함께 먹는 저녁");
  expect(context.rendered).toContain("아직 일어난 사건이나 확정 계획이 아닙니다");
});
it("delivers a current proposal to the actual Planner and Rail inspection tool", async () => {
  await persistDraftDiscoveryObservation(bookDir, await observation());
  const planner = new PlannerAgent(ctx());
  const chat = vi.spyOn(planner as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(planner.planChapter({ book, bookDir, chapterNumber: 3 })).rejects.toThrow("captured");
  expect(chat).toHaveBeenCalledTimes(1);
  expect((chat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content).toContain("퇴근을 지키는 협상");
  const tool = createGetStoryRailsTool(book.id, root);
  const result = await tool.execute("inspect", {});
  expect(JSON.stringify(result)).toContain("퇴근을 지키는 협상");
});
it("preserves the full saved-file hash expected by existing reflow truth receipts", async () => {
  const saved = await persistDraftDiscoveryObservation(bookDir, await observation());
  const packet = JSON.parse(await readFile(saved.path!, "utf8"));
  const context = (await readDraftDiscoveryBookContext(bookDir, book.id))!;
  const store = new StoryRailReflowStore(bookDir);
  const prepared = await store.prepare(book.id, context.chapters);
  if (!("pending" in prepared)) throw new Error("fixture reflow not prepared");
  const { pending } = prepared;
  const input = buildDraftDiscoveryReflowInput({ packet, context, chapterText: await readDraftDiscoveryChapterText(bookDir, 2), pending,
    closeout: makeApplyInput(pending.pendingId, pending.expectedPlanUpdatedAt).closeout, nextActiveBId: "B002" });
  expect(input.decisions.find((entry) => entry.bId === "B002")?.action).toBe("revise");
});
it("excludes changed manuscripts and plans, missing inventory, and exhausted prompt space without new model calls", async () => {
  const original = await observation();
  await writeFile(join(bookDir, "chapters/0002_Chapter_2.md"), `# Chapter 2\n\n${content} 바뀌었다.`);
  expect((await persistDraftDiscoveryObservation(bookDir, original)).path).toBeUndefined();
  expect((await prepareDraftDiscoveryRequest(bookDir, book.id, "ko", 0)).rendered).toBe("");
  expect(parseDraftDiscoverySuggestions("=== DRAFT_DISCOVERIES ===\n{bad}").status).toBe("invalid");
  await rm(join(bookDir, "chapters/index.json"));
  expect((await prepareDraftDiscoveryRequest(bookDir, book.id, "ko")).rendered).toBe("");
});

it("excludes future discoveries during an earlier chapter replay", async () => {
  await persistDraftDiscoveryObservation(bookDir, await observation());
  expect((await readDraftDiscoveryPlanningContext(bookDir, book.id, "ko", undefined, 1)).rendered).toBe("");
  const planner = new PlannerAgent(ctx());
  const chat = vi.spyOn(planner as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(planner.planChapter({ book, bookDir, chapterNumber: 1 })).rejects.toThrow("captured");
  expect((chat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content).not.toContain("퇴근을 지키는 협상");
});
