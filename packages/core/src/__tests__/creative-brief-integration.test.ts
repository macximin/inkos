import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { BookConfigSchema } from "../models/book.js";
import { PlannerAgent } from "../agents/planner.js";
import { WriterAgent } from "../agents/writer.js";
import { ReviserAgent } from "../agents/reviser.js";
import { resolveBookCreativeBrief, recordBookCreativeBrief } from "../planning/creative-brief.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "creative-brief-integration-")); roots.push(root);
  const bookDir = join(root, "book"); await mkdir(join(bookDir, "story"), { recursive: true });
  const book = BookConfigSchema.parse({ id: "creative-book", title: "저녁", genre: "other", platform: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" });
  await writeFile(join(bookDir, "book.json"), JSON.stringify(book));
  await writeFile(join(bookDir, "story/author_intent.md"), "## 독자 약속\n- 돈을 번 뒤 자기 시간을 선택할 자유를 보여 준다.\n");
  return { root, bookDir, book, ctx: { projectRoot: root, bookId: book.id, model: "test", client: { provider: "openai" as const, apiFormat: "chat" as const, stream: false, defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, extra: {} } } } };
}
it.each(["writer", "planner", "reviser"] as const)("delivers source-bound intent through the existing %s call", async (kind) => {
  const f = await fixture();
  const agent = kind === "writer" ? new WriterAgent(f.ctx) : kind === "planner" ? new PlannerAgent(f.ctx) : new ReviserAgent(f.ctx);
  const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  const operation = agent instanceof WriterAgent ? agent.writeChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 4 })
    : agent instanceof PlannerAgent ? agent.planChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 4 })
      : agent.reviseChapter(f.bookDir, "식탁에 수저를 놓았다.", 4, [], "polish", "other");
  await expect(operation).rejects.toThrow("captured");
  expect(chat).toHaveBeenCalledTimes(1);
  const user = (chat.mock.calls[0]![0] as Array<{role:string; content:string}>).find((entry) => entry.role === "user")!.content;
  expect(user).toContain("돈을 번 뒤 자기 시간을 선택할 자유");
  expect(user).toContain("book-direction-document; advisory");
  expect(user).toContain("Source: story/author_intent.md bytes");
  const [file] = await readdir(join(f.bookDir, "story/runtime/creative-brief"));
  const stored = JSON.parse(await readFile(join(f.bookDir, "story/runtime/creative-brief", file!), "utf8"));
  expect(stored.receipt.renderedSha256).toBe(createHash("sha256").update(stored.rendered).digest("hex"));
  expect(user).toContain(stored.rendered);
  expect(stored.receipt.autoEnforcement).toBe(false);
});
it("leaves the creative brief empty when the existing request exhausts context space", async () => {
  const f = await fixture(); Object.defineProperty(f.ctx.client, "_piModel", { value: { contextWindow: 64 } });
  const agent = new PlannerAgent(f.ctx);
  const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(agent.planChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 4 })).rejects.toThrow("captured");
  const user = (chat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content;
  expect(user).not.toContain("book-direction-document; advisory");
  const [file] = await readdir(join(f.bookDir, "story/runtime/creative-brief"));
  expect(JSON.parse(await readFile(join(f.bookDir, "story/runtime/creative-brief", file!), "utf8")).receipt.selectedEntryIds).toEqual([]);
});
it("saves immutable exact context versions and refuses mismatched render metadata", async () => {
  const f = await fixture();
  const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: f.book.id, chapterNumber: 4 });
  const path = await recordBookCreativeBrief(f.bookDir, 4, "planning", context);
  expect(await recordBookCreativeBrief(f.bookDir, 4, "planning", context)).toBe(path);
  await expect(recordBookCreativeBrief(f.bookDir, 4, "planning", { ...context, rendered: "changed" })).rejects.toThrow("receipt mismatch");
  await writeFile(path!, "{}");
  await expect(recordBookCreativeBrief(f.bookDir, 4, "planning", context)).rejects.toThrow("receipt conflict");
});
it("keeps existing Korean Book IDs usable through the actual Planner call", async () => {
  const f = await fixture();
  const koreanBook = { ...f.book, id: "가족" };
  await writeFile(join(f.bookDir, "book.json"), JSON.stringify(koreanBook));
  const planner = new PlannerAgent({ ...f.ctx, bookId: koreanBook.id });
  const chat = vi.spyOn(planner as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  await expect(planner.planChapter({ book: koreanBook, bookDir: f.bookDir, chapterNumber: 4 })).rejects.toThrow("captured");
  expect(chat).toHaveBeenCalledTimes(1);
  expect((chat.mock.calls[0]![0] as Array<{content:string}>)[1]!.content).toContain("돈을 번 뒤 자기 시간을 선택할 자유");
});

it.each(["writer", "planner", "reviser"] as const)("keeps optional receipt failure from blocking the existing %s call", async (kind) => {
  const f = await fixture();
  await mkdir(join(f.bookDir, "story/runtime"), { recursive: true });
  await writeFile(join(f.bookDir, "story/runtime/creative-brief"), "existing ordinary file");
  const agent = kind === "writer" ? new WriterAgent(f.ctx) : kind === "planner" ? new PlannerAgent(f.ctx) : new ReviserAgent(f.ctx);
  const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
  const operation = agent instanceof WriterAgent ? agent.writeChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 4 })
    : agent instanceof PlannerAgent ? agent.planChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 4 })
      : agent.reviseChapter(f.bookDir, "식탁에 수저를 놓았다.", 4, [], "polish", "other");
  await expect(operation).rejects.toThrow("captured"); expect(chat).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.bookDir, "story/runtime/creative-brief"), "utf8")).toBe("existing ordinary file");
});
