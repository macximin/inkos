import type { ChapterMeta } from "../models/chapter.js";
import { verifyChapterTruthReceipt } from "./chapter-truth-receipt.js";

export async function assertChapterApprovalReady(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly chapter: ChapterMeta;
}): Promise<void> {
  if (input.chapter.status !== "ready-for-review") {
    throw new Error(
      `Chapter ${input.chapter.number} must be ready-for-review before approval (current: ${input.chapter.status}).`,
    );
  }
  if (input.chapter.pendingAuditReason) {
    throw new Error(
      `Chapter ${input.chapter.number} still requires audit (${input.chapter.pendingAuditReason}).`,
    );
  }
  if (input.chapter.arcProvenance?.storyRail) {
    await verifyChapterTruthReceipt(input.bookDir, input.bookId, input.chapter);
  }
}
