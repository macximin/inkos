import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harness = vi.hoisted(() => ({
  root: "",
  events: [] as string[],
  preflight: vi.fn(),
  writeWithinLock: vi.fn(),
  legacyWrite: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {
    async assertChapterProductionReadyWithinBookLock(bookId: string) {
      harness.events.push(`preflight:${bookId}`);
      return harness.preflight(bookId);
    }

    async writeNextChapterWithinBookLock(bookId: string, wordCount?: number) {
      harness.events.push(`write-within-lock:${bookId}`);
      return harness.writeWithinLock(bookId, wordCount);
    }

    async writeNextChapter(bookId: string, wordCount?: number) {
      harness.events.push(`legacy-write:${bookId}`);
      return harness.legacyWrite(bookId, wordCount);
    }
  },
  StateManager: class {
    bookDir(bookId: string) {
      return join(harness.root, "books", bookId);
    }

    async loadBookConfig(bookId: string) {
      return { id: bookId, title: "Book A", language: "en", writing: {} };
    }

    async acquireBookLock(bookId: string) {
      harness.events.push(`lock:${bookId}`);
      return async () => {
        harness.events.push(`release:${bookId}`);
      };
    }

    async loadChapterIndex(bookId: string) {
      harness.events.push(`load-index:${bookId}`);
      return [1, 2, 3].map((number) => ({ number }));
    }

    async saveChapterIndex(bookId: string, chapters: ReadonlyArray<{ number: number }>) {
      harness.events.push(`save-index:${bookId}:${chapters.map((chapter) => chapter.number).join(",")}`);
    }

    async restoreState(bookId: string, chapterNumber: number) {
      harness.events.push(`restore:${bookId}:${chapterNumber}`);
      return true;
    }

    async getNextChapterNumber(bookId: string) {
      harness.events.push(`next:${bookId}`);
      return 2;
    }
  },
  resolveChapterReviewMode: vi.fn(() => "auto"),
}));

vi.mock("../utils.js", () => ({
  loadConfig: vi.fn(async () => ({ llm: {}, writing: {} })),
  buildPipelineConfig: vi.fn(() => ({})),
  findProjectRoot: vi.fn(() => harness.root),
  getLegacyMigrationHint: vi.fn(async () => null),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "book-a"),
  resolveContext: vi.fn(async () => undefined),
  log: harness.log,
  logError: harness.logError,
}));

vi.mock("../localization.js", () => ({
  formatNotifyBatchWriteBody: vi.fn(() => "done"),
  formatNotifyCommandTitle: vi.fn(() => "rewrite"),
  formatNotifyFailureBody: vi.fn(() => "failed"),
  formatWriteNextComplete: vi.fn(() => "done"),
  formatWriteNextProgress: vi.fn(() => "progress"),
  formatWriteNextResultLines: vi.fn(() => ["ok"]),
  resolveCliLanguage: vi.fn(() => "en"),
}));

vi.mock("../notify-helper.js", () => ({
  sendCommandNotification: vi.fn(async () => undefined),
}));

describe("write rewrite Book lock", () => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    harness.events.length = 0;
    root = await mkdtemp(join(tmpdir(), "inkos-rewrite-lock-"));
    harness.root = root;
    const bookDir = join(root, "books", "book-a");
    await Promise.all([
      mkdir(join(bookDir, "chapters"), { recursive: true }),
      mkdir(join(bookDir, "story", "snapshots", "1"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(bookDir, "chapters", "0002_Old.md"), "old two", "utf8"),
      writeFile(join(bookDir, "chapters", "0003_Later.md"), "old three", "utf8"),
    ]);
    harness.preflight.mockResolvedValue(undefined);
    harness.writeWithinLock.mockResolvedValue({
      chapterNumber: 2,
      title: "Replacement",
      wordCount: 100,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("holds one Book lock across preflight, trim, restore, and replacement generation", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(
        ["node", "write", "rewrite", "book-a", "2", "--force", "--json"],
        { from: "node" },
      );

      expect(harness.events).toEqual([
        "lock:book-a",
        "preflight:book-a",
        "load-index:book-a",
        "save-index:book-a:1",
        "restore:book-a:1",
        "next:book-a",
        "write-within-lock:book-a",
        "release:book-a",
      ]);
      expect(harness.legacyWrite).not.toHaveBeenCalled();
      await expect(readFile(join(root, "books", "book-a", "chapters", "0002_Old.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(root, "books", "book-a", "chapters", "0003_Later.md"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("checks a pending reflow before deleting any Chapter and still releases the lock", async () => {
    harness.preflight.mockRejectedValue(new Error("apply or discard pending reflow"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const { writeCommand } = await import("../commands/write.js");
      await writeCommand.parseAsync(
        ["node", "write", "rewrite", "book-a", "2", "--force", "--json"],
        { from: "node" },
      );

      expect(harness.events).toEqual([
        "lock:book-a",
        "preflight:book-a",
        "release:book-a",
      ]);
      await expect(readFile(join(root, "books", "book-a", "chapters", "0002_Old.md"), "utf8"))
        .resolves.toBe("old two");
      await expect(readFile(join(root, "books", "book-a", "chapters", "0003_Later.md"), "utf8"))
        .resolves.toBe("old three");
      expect(harness.writeWithinLock).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });
});
