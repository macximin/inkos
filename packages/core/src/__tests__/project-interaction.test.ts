import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createProjectSession,
  loadProjectSession,
  persistProjectSession,
  resolveSessionActiveBook,
} from "../interaction/project-session-store.js";
import { processProjectInteractionRequest } from "../interaction/project-control.js";

let projectRoot: string;

describe("project interaction control", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-project-control-"));
    await mkdir(join(projectRoot, "books", "harbor"), { recursive: true });
    await writeFile(join(projectRoot, "books", "harbor", "book.json"), "{}", "utf-8");
  });

  afterAll(async () => {
    // tmpdir cleanup omitted
  });

  it("persists structured create_book requests into the shared project session", async () => {
    await persistProjectSession(projectRoot, createProjectSession(projectRoot));

    const tools = {
      listBooks: vi.fn(async () => ["harbor"]),
      createBook: vi.fn(async () => ({
        bookId: "night-harbor",
        title: "Night Harbor",
        __interaction: {
          responseText: "Created Night Harbor.",
        },
      })),
      exportBook: vi.fn(async () => ({ ok: true })),
      writeNextChapter: vi.fn(async () => ({ ok: true })),
      reviseDraft: vi.fn(async () => ({ ok: true })),
      patchChapterText: vi.fn(async () => ({ ok: true })),
      replaceChapterText: vi.fn(async () => ({ ok: true })),
      renameEntity: vi.fn(async () => ({ ok: true })),
      updateCurrentFocus: vi.fn(async () => ({ ok: true })),
      updateAuthorIntent: vi.fn(async () => ({ ok: true })),
      writeTruthFile: vi.fn(async () => ({ ok: true })),
    };

    const result = await processProjectInteractionRequest({
      projectRoot,
      request: {
        intent: "create_book",
        title: "Night Harbor",
        genre: "urban",
        platform: "tomato",
        chapterWordCount: 2800,
        targetChapters: 120,
        hardRules: [{
          collection: "prohibitions",
          text: "Never resolve the central debt off-page.",
          decision: "adopt",
          decisionId: "studio-hil:decision-1",
          adoptedByActorId: "studio-local-owner",
        }],
      },
      tools,
    });

    expect(tools.createBook).toHaveBeenCalledWith({
      title: "Night Harbor",
      genre: "urban",
      platform: "tomato",
      chapterWordCount: 2800,
      targetChapters: 120,
      hardRules: [{
        collection: "prohibitions",
        text: "Never resolve the central debt off-page.",
        decision: "adopt",
        decisionId: "studio-hil:decision-1",
        adoptedByActorId: "studio-local-owner",
      }],
    });
    expect(result.session.activeBookId).toBe("night-harbor");

    const persisted = await loadProjectSession(projectRoot);
    expect(persisted.activeBookId).toBe("night-harbor");
  });

  it("detects Korean project language without folding it into Chinese", async () => {
    await writeFile(join(projectRoot, "inkos.json"), JSON.stringify({ language: "ko" }), "utf-8");
    await persistProjectSession(projectRoot, createProjectSession(projectRoot));

    const result = await processProjectInteractionRequest({
      projectRoot,
      request: { intent: "list_books" },
      tools: {
        listBooks: vi.fn(async () => ["harbor"]),
        writeNextChapter: vi.fn(async () => ({ ok: true })),
        reviseDraft: vi.fn(async () => ({ ok: true })),
        patchChapterText: vi.fn(async () => ({ ok: true })),
        replaceChapterText: vi.fn(async () => ({ ok: true })),
        renameEntity: vi.fn(async () => ({ ok: true })),
        updateCurrentFocus: vi.fn(async () => ({ ok: true })),
        updateAuthorIntent: vi.fn(async () => ({ ok: true })),
        writeTruthFile: vi.fn(async () => ({ ok: true })),
      },
    });

    expect(result.request.language).toBe("ko");
    expect(result.responseText).toBe("작품 목록: harbor");
  });

});

describe("project session canonical Book discovery", () => {
  async function createCompleteBook(root: string, bookId: string): Promise<void> {
    const bookDir = join(root, "books", bookId);
    await Promise.all([
      mkdir(join(bookDir, "story", "outline"), { recursive: true }),
      mkdir(join(bookDir, "chapters"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({ id: bookId }), "utf-8"),
      writeFile(join(bookDir, "story", "book_rules.md"), "# Rules\n", "utf-8"),
      writeFile(join(bookDir, "story", "current_state.md"), "# State\n", "utf-8"),
      writeFile(join(bookDir, "story", "pending_hooks.md"), "# Hooks\n", "utf-8"),
      writeFile(join(bookDir, "story", "outline", "story_frame.md"), "# Story\n", "utf-8"),
      writeFile(join(bookDir, "story", "outline", "volume_map.md"), "# Volume\n", "utf-8"),
      writeFile(join(bookDir, "chapters", "index.json"), "[]\n", "utf-8"),
    ]);
  }

  it("never auto-selects staging or quarantine directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-session-internal-books-"));
    await createCompleteBook(root, ".tmp-book-create-draft-123");
    await mkdir(join(root, "books", ".failed-book-creations", "failed-draft"), { recursive: true });
    await writeFile(
      join(root, "books", ".failed-book-creations", "failed-draft", "book.json"),
      JSON.stringify({ id: "failed-draft" }),
      "utf-8",
    );

    await expect(resolveSessionActiveBook(root, createProjectSession(root))).resolves.toBeUndefined();
  });

  it("auto-selects the sole complete canonical Book while internal dirs exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-session-canonical-book-"));
    await createCompleteBook(root, "real-book");
    await createCompleteBook(root, ".tmp-book-create-draft-456");
    await mkdir(join(root, "books", ".failed-book-creations"), { recursive: true });

    await expect(resolveSessionActiveBook(root, createProjectSession(root))).resolves.toBe("real-book");
  });
});
