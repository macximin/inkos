import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let projectRoot = "";
const consolidateMock = vi.fn(async () => ({ archivedVolumes: 1, retainedChapters: 8 }));
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    ConsolidatorAgent: class {
      consolidate = consolidateMock;
    },
  };
});

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  loadConfig: async () => ({}),
  buildPipelineConfig: () => ({ client: {}, model: "test-model" }),
  findProjectRoot: () => projectRoot,
  resolveBookId: async (bookId: string | undefined) => bookId ?? "demo-book",
  log: (message: string) => logMock(message),
  logError: (message: string) => logErrorMock(message),
}));

describe("inkos consolidate locking", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-consolidate-lock-"));
    const { StateManager } = await import("@actalk/inkos-core");
    await new StateManager(projectRoot).saveBookConfig("demo-book", {
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

  it("does not consolidate while busy and releases the Book lock after success", async () => {
    const { StateManager } = await import("@actalk/inkos-core");
    const state = new StateManager(projectRoot);
    const competingRelease = await state.acquireBookLock("demo-book");
    let competingReleased = false;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { consolidateCommand } = await import("../commands/consolidate.js");

    try {
      await consolidateCommand.parseAsync([
        "node", "consolidate", "demo-book", "--json",
      ], { from: "node" });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consolidateMock).not.toHaveBeenCalled();

      await competingRelease();
      competingReleased = true;
      exitSpy.mockClear();
      await consolidateCommand.parseAsync([
        "node", "consolidate", "demo-book", "--json",
      ], { from: "node" });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(consolidateMock).toHaveBeenCalledOnce();
      const releaseAgain = await state.acquireBookLock("demo-book");
      await releaseAgain();
    } finally {
      exitSpy.mockRestore();
      if (!competingReleased) await competingRelease();
    }
  });
});
