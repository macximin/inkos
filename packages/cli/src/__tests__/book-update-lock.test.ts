import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "@actalk/inkos-core";

let projectRoot = "";
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  findProjectRoot: () => projectRoot,
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

describe("inkos book update locking", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-book-update-lock-"));
    const state = new StateManager(projectRoot);
    await state.saveBookConfig("demo-book", {
      id: "demo-book",
      title: "Demo Book",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 100,
      chapterWordCount: 3000,
      language: "en",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("leaves targetChapters unchanged while busy and releases after a successful update", async () => {
    const state = new StateManager(projectRoot);
    const competingRelease = await state.acquireBookLock("demo-book");
    let competingReleased = false;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { bookCommand } = await import("../commands/book.js");

    try {
      await bookCommand.parseAsync([
        "node", "book", "update", "demo-book", "--target-chapters", "120", "--json",
      ], { from: "node" });
      expect(exitSpy).toHaveBeenCalledWith(1);
      await expect(state.loadBookConfig("demo-book")).resolves.toMatchObject({ targetChapters: 100 });

      await competingRelease();
      competingReleased = true;
      exitSpy.mockClear();
      await bookCommand.parseAsync([
        "node", "book", "update", "demo-book", "--target-chapters", "120", "--json",
      ], { from: "node" });
      expect(exitSpy).not.toHaveBeenCalled();
      await expect(state.loadBookConfig("demo-book")).resolves.toMatchObject({ targetChapters: 120 });
      const releaseAgain = await state.acquireBookLock("demo-book");
      await releaseAgain();
    } finally {
      exitSpy.mockRestore();
      if (!competingReleased) await competingRelease();
    }
  });
});
