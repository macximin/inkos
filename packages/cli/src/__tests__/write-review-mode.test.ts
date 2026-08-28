import { beforeEach, describe, expect, it, vi } from "vitest";

const writeNextChapterMock = vi.fn();
const executeSurfaceWriteNextMock = vi.fn();
const createDetachedOwnerDirectionLeaseMock = vi.fn();
const buildPipelineConfigMock = vi.fn();
const loadConfigMock = vi.fn();
const loadBookConfigMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class {
    writeNextChapter = writeNextChapterMock;
    executeSurfaceWriteNext = executeSurfaceWriteNextMock;
  },
  StateManager: class {
    async loadBookConfig() {
      return loadBookConfigMock();
    }
  },
  // Mirrors the real core implementation: book-level overrides project-level,
  // both unset falls back to "auto". The real function is unit-tested in
  // packages/core/src/__tests__/chapter-review-mode.test.ts.
  resolveChapterReviewMode: (
    book: { writing?: { reviewMode?: "auto" | "manual" } },
    projectWriting?: { reviewMode?: "auto" | "manual" },
  ) => book.writing?.reviewMode ?? projectWriting?.reviewMode ?? "auto",
  createDetachedOwnerDirectionLease: createDetachedOwnerDirectionLeaseMock,
  hashCanonicalJson: (value: unknown) => `hash:${JSON.stringify(value)}`,
}));

vi.mock("../utils.js", () => ({
  loadConfig: loadConfigMock,
  buildPipelineConfig: buildPipelineConfigMock,
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  getLegacyMigrationHint: vi.fn(async () => null),
  resolveContext: vi.fn(async () => undefined),
  log: logMock,
  logError: logErrorMock,
}));

vi.mock("../localization.js", () => ({
  formatWriteNextProgress: vi.fn(() => "progress"),
  formatWriteNextResultLines: vi.fn(() => ["ok"]),
  formatWriteNextComplete: vi.fn(() => "done"),
  resolveCliLanguage: vi.fn(() => "zh"),
}));

describe("inkos write next review mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeNextChapterMock.mockResolvedValue({
      chapterNumber: 4,
      title: "第四章",
      wordCount: 3000,
      auditResult: { passed: true, issues: [], summary: "ok" },
      revised: false,
      status: "ready-for-review",
    });
    executeSurfaceWriteNextMock.mockResolvedValue({
      run: { command: { commandId: "00000000-0000-4000-8000-000000000001" } },
      result: {
        chapterNumber: 4,
        title: "第四章",
        wordCount: 3000,
        auditResult: { passed: true, issues: [], summary: "ok" },
        revised: false,
        status: "ready-for-review",
      },
      reused: false,
    });
    createDetachedOwnerDirectionLeaseMock.mockResolvedValue({
      source: "owner-confirmed",
      receiptId: "cli-receipt",
      sourceRef: {
        kind: "detached-payload-lease",
        leaseId: "00000000-0000-4000-8000-000000000002",
        payloadSha256: "a".repeat(64),
        byteLength: 10,
        expiresAt: "2099-01-01T00:00:00.000Z",
        leaseReceiptSha256: "b".repeat(64),
      },
      textSha256: "a".repeat(64),
    });
    buildPipelineConfigMock.mockReturnValue({});
  });

  it("passes book-level reviewMode into the pipeline config", async () => {
    loadBookConfigMock.mockResolvedValue({
      language: "zh",
      writing: { reviewMode: "manual" },
    });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, reviewMode: "auto" },
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "manual" }),
    );
    expect(writeNextChapterMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the project-level reviewMode when the book does not set one", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1, reviewMode: "manual" },
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "manual" }),
    );
  });

  it("defaults to auto when neither book nor project sets a reviewMode", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "zh" });
    loadConfigMock.mockResolvedValue({ llm: {}, writing: { reviewRetries: 1 } });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book"], { from: "node" });

    expect(buildPipelineConfigMock).toHaveBeenCalledWith(
      expect.anything(),
      "/project",
      expect.objectContaining({ chapterReviewMode: "auto" }),
    );
  });

  it("routes typed CLI write-next through the Phase-5 surface gateway", async () => {
    loadBookConfigMock.mockResolvedValue({ language: "ko" });
    loadConfigMock.mockResolvedValue({
      llm: {},
      writing: { reviewRetries: 1 },
      production: { kernel: "off", surfaceGateway: "dual" },
    });

    const { writeCommand } = await import("../commands/write.js");
    await writeCommand.parseAsync(["node", "write", "next", "demo-book", "--words", "5500"], { from: "node" });

    expect(executeSurfaceWriteNextMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "cli",
      bookId: "demo-book",
      ownerDirection: expect.objectContaining({ source: "owner-confirmed" }),
      authorization: expect.objectContaining({ kind: "confirmed-cli" }),
      targetLength: { count: 5500, unit: "ko-chars" },
    }));
    expect(writeNextChapterMock).not.toHaveBeenCalled();
  });
});
