import { describe, expect, it } from "vitest";
import { assertChapterApprovalReady } from "../state/chapter-approval.js";
import type { ChapterMeta } from "../models/chapter.js";

const BASE: ChapterMeta = {
  number: 1,
  title: "첫 출고",
  status: "ready-for-review",
  wordCount: 3000,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  auditIssues: [],
  lengthWarnings: [],
};

describe("chapter approval gate", () => {
  it("accepts an audited chapter without pending repair state", async () => {
    await expect(assertChapterApprovalReady({
      bookDir: "/tmp/unused-book",
      bookId: "book-a",
      chapter: BASE,
    })).resolves.toBeUndefined();
  });

  it("blocks a HIL-applied chapter until resync and audit finish", async () => {
    await expect(assertChapterApprovalReady({
      bookDir: "/tmp/unused-book",
      bookId: "book-a",
      chapter: {
        ...BASE,
        status: "drafted",
        pendingAuditReason: "hil-applied-pending-resync",
      },
    })).rejects.toThrow(/must be ready-for-review/u);
  });
});
