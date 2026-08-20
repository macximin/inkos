import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditResult } from "../agents/continuity.js";
import type { ChapterArcProvenance, ChapterMeta } from "../models/chapter.js";
import {
  ChapterFutureAdvantageExecutionSchema,
  FutureAdvantageCanonLedgerSchema,
  FutureAdvantageResearchReceiptStoreSchema,
  hashFutureAdvantageChapterContent,
  validateFutureAdvantageExecutionCandidate,
  type ChapterFutureAdvantageExecution,
  type FutureAdvantageCanonEntry,
} from "../models/future-advantage-ledger.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

export const FUTURE_ADVANTAGE_CANON_PATH = "story/future_advantage_ledger.json";
export const FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH = "story/research/future_advantage_receipts.json";

export function buildChapterFutureAdvantageExecution(params: {
  readonly chapterNumber: number;
  readonly chapterContent: string;
  readonly arcProvenance?: ChapterArcProvenance;
  readonly auditResult: AuditResult;
}): ChapterFutureAdvantageExecution | undefined {
  const move = params.arcProvenance?.futureAdvantageMove;
  const candidate = params.auditResult.futureAdvantageExecution;
  if (!move || !candidate) return undefined;
  const validated = validateFutureAdvantageExecutionCandidate({
    candidate,
    moveId: move.moveId,
    chapterContent: params.chapterContent,
  });
  if (!validated) return undefined;
  return ChapterFutureAdvantageExecutionSchema.parse({
    ...validated,
    version: 1,
    chapterNumber: params.chapterNumber,
    arcId: params.arcProvenance!.arcId,
    move,
    contentSha256: hashFutureAdvantageChapterContent(params.chapterContent),
    researchStatus: params.auditResult.researchStatus ?? "not-checked",
    researchClaimIds: move.researchClaimIds,
    authorizedDivergences: move.authorizedDivergences,
  });
}

export async function rebuildApprovedFutureAdvantageCanon(params: {
  readonly bookDir: string;
  readonly chapters: ReadonlyArray<ChapterMeta>;
}): Promise<{ readonly executedMoveCount: number; readonly changed: boolean }> {
  const hasExecution = params.chapters.some((chapter) => chapter.futureAdvantageExecution);
  const hasExistingCanon = await pathExists(join(params.bookDir, FUTURE_ADVANTAGE_CANON_PATH));
  if (!hasExecution && !hasExistingCanon) return { executedMoveCount: 0, changed: false };

  const entries: FutureAdvantageCanonEntry[] = [];
  for (const chapter of [...params.chapters].sort((a, b) => a.number - b.number)) {
    if (chapter.status !== "approved" && chapter.status !== "published") continue;
    const execution = chapter.futureAdvantageExecution;
    if (!execution) continue;
    const content = await readChapterBody(params.bookDir, chapter.number);
    const contentSha256 = hashFutureAdvantageChapterContent(content);
    if (execution.contentSha256 !== contentSha256) {
      throw new Error(
        `Future Advantage execution receipt for chapter ${chapter.number} is stale; re-audit the edited chapter before approval.`,
      );
    }
    if (execution.chapterNumber !== chapter.number || execution.arcId !== chapter.arcProvenance?.arcId) {
      throw new Error(`Future Advantage execution receipt does not match chapter ${chapter.number} provenance.`);
    }
    entries.push({
      ...execution,
      approvedAt: chapter.updatedAt,
    });
  }

  const uniqueMoveChapter = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.chapterNumber}:${entry.moveId}`;
    if (uniqueMoveChapter.has(key)) throw new Error(`Duplicate Future Advantage canon entry: ${key}`);
    uniqueMoveChapter.add(key);
  }

  const ledger = FutureAdvantageCanonLedgerSchema.parse({ version: 1, executedMoves: entries });
  const receiptStore = FutureAdvantageResearchReceiptStoreSchema.parse({
    version: 1,
    receipts: entries.map((entry) => ({
      version: 1,
      chapterNumber: entry.chapterNumber,
      arcId: entry.arcId,
      moveId: entry.moveId,
      claimIds: entry.researchClaimIds,
      status: entry.researchStatus,
      approvedAt: entry.approvedAt,
    })),
  });
  const snapshots = await listSnapshotNumbers(params.bookDir);
  const writes = [
    jsonWrite(FUTURE_ADVANTAGE_CANON_PATH, ledger),
    jsonWrite(FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH, receiptStore),
    ...snapshots.flatMap((snapshotNumber) => {
      const snapshotEntries = entries.filter((entry) => entry.chapterNumber <= snapshotNumber);
      const snapshotLedger = { version: 1 as const, executedMoves: snapshotEntries };
      const snapshotReceipts = {
        version: 1 as const,
        receipts: receiptStore.receipts.filter((receipt) => receipt.chapterNumber <= snapshotNumber),
      };
      return [
        jsonWrite(`story/snapshots/${snapshotNumber}/future_advantage_ledger.json`, snapshotLedger),
        jsonWrite(`story/snapshots/${snapshotNumber}/research/future_advantage_receipts.json`, snapshotReceipts),
      ];
    }),
  ];
  await commitAtomicFileSet({ rootDir: params.bookDir, writes });
  return { executedMoveCount: entries.length, changed: true };
}

async function readChapterBody(bookDir: string, chapterNumber: number): Promise<string> {
  const chaptersDir = join(bookDir, "chapters");
  const files = await readdir(chaptersDir);
  const prefix = String(chapterNumber).padStart(4, "0");
  const file = files.find((candidate) => candidate.startsWith(prefix) && candidate.endsWith(".md"));
  if (!file) throw new Error(`Chapter ${chapterNumber} file not found while rebuilding Future Advantage canon.`);
  const raw = await readFile(join(chaptersDir, file), "utf8");
  const lines = raw.split("\n");
  const contentStart = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
  return contentStart >= 0 ? lines.slice(contentStart).join("\n") : raw;
}

async function listSnapshotNumbers(bookDir: string): Promise<number[]> {
  const entries = await readdir(join(bookDir, "story", "snapshots"), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number.parseInt(entry.name, 10))
    .sort((a, b) => a - b);
}

function jsonWrite(relativePath: string, value: unknown): { relativePath: string; content: string } {
  return { relativePath, content: `${JSON.stringify(value, null, 2)}\n` };
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}
