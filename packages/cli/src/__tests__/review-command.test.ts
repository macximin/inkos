import { beforeEach, describe, expect, it, vi } from "vitest";

const loadChapterIndexMock = vi.fn();
const saveChapterIndexMock = vi.fn();
const prepareReflowMock = vi.fn();
const logMock = vi.fn();
const logErrorMock = vi.fn();
const events: string[] = [];

vi.mock("@actalk/inkos-core", () => ({
  StateManager: class {
    bookDir(bookId: string) {
      return `/project/books/${bookId}`;
    }

    async acquireBookLock(bookId: string) {
      events.push(`lock:${bookId}`);
      return async () => {
        events.push(`release:${bookId}`);
      };
    }

    async loadChapterIndex(bookId: string) {
      events.push(`load:${bookId}`);
      return loadChapterIndexMock(bookId);
    }

    async saveChapterIndex(bookId: string, chapters: unknown) {
      events.push(`save:${bookId}`);
      return saveChapterIndexMock(bookId, chapters);
    }
  },
  StoryRailReflowStore: class {
    constructor(readonly bookDir: string) {}

    async prepare(bookId: string, chapters: unknown) {
      events.push(`prepare:${bookId}`);
      return prepareReflowMock(this.bookDir, bookId, chapters);
    }
  },
  formatLengthCount: (count: number) => String(count),
  readGenreProfile: vi.fn(async () => ({ profile: { language: "en" } })),
  resolveLengthCountingMode: vi.fn(() => "words"),
}));

vi.mock("../utils.js", () => ({
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId?: string) => bookId ?? "auto-book"),
  log: logMock,
  logError: logErrorMock,
}));

function chapter(number: number, status: "ready-for-review" | "audit-failed" = "ready-for-review") {
  return {
    number,
    title: `Chapter ${number}`,
    status,
    wordCount: 100,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
  };
}

function pendingResult(status: "pending" | "already-pending" = "pending") {
  return {
    status,
    pending: {
      pendingId: "reflow-one",
      expectedPlanUpdatedAt: "2026-08-09T00:00:00.000Z",
      activeB: {
        bId: "B001",
        arcId: "arc-active",
        targetAnchorId: "A01",
      },
      endpointChapterNumber: 1,
      actualEpisodeCount: 1,
    },
  };
}

describe("review approval Story Rail close trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    loadChapterIndexMock.mockResolvedValue([chapter(1)]);
    saveChapterIndexMock.mockResolvedValue(undefined);
    prepareReflowMock.mockResolvedValue({
      status: "not-eligible",
      reason: "missing-plan",
      message: "No Story Rail plan exists.",
    });
  });

  it("prepares a pending reflow after approve saves status and before releasing the Book lock", async () => {
    prepareReflowMock.mockResolvedValue(pendingResult());
    const { reviewCommand } = await import("../commands/review.js");

    await reviewCommand.parseAsync(
      ["node", "review", "approve", "book-a", "1", "--json"],
      { from: "node" },
    );

    expect(events).toEqual([
      "lock:book-a",
      "load:book-a",
      "save:book-a",
      "prepare:book-a",
      "release:book-a",
    ]);
    const approved = saveChapterIndexMock.mock.calls[0]?.[1];
    expect(approved).toEqual([
      expect.objectContaining({ number: 1, status: "approved" }),
    ]);
    expect(prepareReflowMock).toHaveBeenCalledWith(
      "/project/books/book-a",
      "book-a",
      approved,
    );
    expect(JSON.parse(logMock.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      bookId: "book-a",
      chapter: 1,
      status: "approved",
      railReflow: {
        status: "pending",
        pending: { pendingId: "reflow-one", endpointChapterNumber: 1 },
      },
    });
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("reports approve-all not-eligible without turning approval into a failure", async () => {
    loadChapterIndexMock.mockResolvedValue([
      chapter(1),
      chapter(2, "audit-failed"),
    ]);
    const { reviewCommand } = await import("../commands/review.js");

    await reviewCommand.parseAsync(
      ["node", "review", "approve-all", "book-a", "--json"],
      { from: "node" },
    );

    const approved = saveChapterIndexMock.mock.calls[0]?.[1] as Array<{ status: string }>;
    expect(approved.map((entry) => entry.status)).toEqual(["approved", "approved"]);
    expect(JSON.parse(logMock.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      bookId: "book-a",
      approvedCount: 2,
      railReflow: {
        status: "not-eligible",
        reason: "missing-plan",
      },
    });
    expect(events.at(-1)).toBe("release:book-a");
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it("keeps approve successful and emits a warning when optional prepare throws", async () => {
    prepareReflowMock.mockRejectedValue(new Error("truth receipt unavailable"));
    const { reviewCommand } = await import("../commands/review.js");

    await reviewCommand.parseAsync(
      ["node", "review", "approve", "book-a", "1"],
      { from: "node" },
    );

    const output = logMock.mock.calls.map((call) => call[0] as string).join("\n");
    expect(output).toContain("Chapter 1 approved");
    expect(output).toContain("[warning] Story Rail reflow preparation failed: truth receipt unavailable");
    expect(saveChapterIndexMock).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("release:book-a");
    expect(logErrorMock).not.toHaveBeenCalled();
  });
});
