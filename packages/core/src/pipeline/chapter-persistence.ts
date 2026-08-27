import { isAutomaticRevisionIssue, type AuditIssue, type AuditResult } from "../agents/continuity.js";
import type { ChapterArcProvenance, ChapterMeta } from "../models/chapter.js";
import type { LengthTelemetry } from "../models/length-governance.js";
import type { ChapterFutureAdvantageExecution } from "../models/future-advantage-ledger.js";
import {
  beginChapterPersistenceJournal,
  commitChapterPersistenceJournal,
  rollbackChapterPersistenceJournal,
} from "../state/chapter-persistence-journal.js";
import { buildStateDegradedReviewNote } from "./chapter-state-recovery.js";

export interface ChapterPersistenceUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type ChapterPersistenceStatus = "ready-for-review" | "audit-failed" | "state-degraded";

/**
 * Keep the Chapter body and every production truth projection at one logical
 * commit boundary. Individual writers already use atomic file sets, but the
 * pipeline spans several such commits (body/truth, index metadata, book
 * status, snapshot, and revision archive). If a later step fails, restore the
 * exact pre-operation bytes with the same durable atomic-file-set primitive.
 *
 * The caller must hold the Book write lock for the whole callback.
 */
export async function runChapterPersistenceTransaction<T>(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly persist: () => Promise<T>;
}): Promise<T> {
  const journal = await beginChapterPersistenceJournal(params.bookDir, params.chapterNumber);
  try {
    const result = await params.persist();
    await commitChapterPersistenceJournal(journal);
    return result;
  } catch (error) {
    try {
      await rollbackChapterPersistenceJournal(journal);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Chapter ${params.chapterNumber} persistence failed and rollback was incomplete`,
      );
    }
    throw error;
  }
}

export async function persistChapterArtifacts(params: {
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly status: ChapterPersistenceStatus;
  readonly auditResult: AuditResult;
  readonly finalWordCount: number;
  readonly lengthWarnings: ReadonlyArray<string>;
  readonly lengthTelemetry?: LengthTelemetry;
  readonly degradedIssues: ReadonlyArray<AuditIssue>;
  readonly arcProvenance?: ChapterArcProvenance;
  readonly futureAdvantageExecution?: ChapterFutureAdvantageExecution;
  readonly tokenUsage?: ChapterPersistenceUsage;
  readonly loadChapterIndex: () => Promise<ReadonlyArray<ChapterMeta>>;
  readonly saveChapter: () => Promise<void>;
  readonly saveTruthFiles: () => Promise<void>;
  readonly saveChapterIndex: (index: ReadonlyArray<ChapterMeta>) => Promise<void>;
  readonly markBookActiveIfNeeded: () => Promise<void>;
  readonly persistAuditDriftGuidance: (issues: ReadonlyArray<AuditIssue>) => Promise<void>;
  readonly snapshotState: () => Promise<void>;
  readonly syncCurrentStateFactHistory: () => Promise<void>;
  readonly logSnapshotStage: () => void;
  readonly now?: () => string;
}): Promise<{ readonly entry: ChapterMeta }> {
  await params.saveChapter();
  if (params.status !== "state-degraded") {
    await params.saveTruthFiles();
  }

  const existingIndex = await params.loadChapterIndex();
  const now = params.now?.() ?? new Date().toISOString();
  const entry: ChapterMeta = {
    number: params.chapterNumber,
    title: params.chapterTitle,
    status: params.status,
    wordCount: params.finalWordCount,
    createdAt: now,
    updatedAt: now,
    auditIssues: params.auditResult.issues.map((issue) => `[${issue.severity}] ${issue.description}`),
    lengthWarnings: [...params.lengthWarnings],
    reviewNote: params.status === "state-degraded"
      ? buildStateDegradedReviewNote(
          params.auditResult.passed ? "ready-for-review" : "audit-failed",
          params.degradedIssues,
        )
      : undefined,
    lengthTelemetry: params.lengthTelemetry,
    arcProvenance: params.arcProvenance,
    futureAdvantageExecution: params.futureAdvantageExecution,
    tokenUsage: params.tokenUsage,
  };
  const existingIdx = existingIndex.findIndex((e) => e.number === params.chapterNumber);
  const updatedIndex = existingIdx >= 0
    ? existingIndex.map((e, i) => i === existingIdx ? { ...entry, createdAt: e.createdAt } : e)
    : [...existingIndex, entry];
  await params.saveChapterIndex(updatedIndex);
  await params.markBookActiveIfNeeded();

  // An invalid audit is not a clean audit. Preserve the last trustworthy drift
  // receipt instead of translating parse failure into a destructive clear.
  if (!params.auditResult.parseFailed) {
    const driftIssues = params.auditResult.issues.filter(
      isAutomaticRevisionIssue,
    );
    await params.persistAuditDriftGuidance(params.status === "state-degraded" ? [] : driftIssues);
  }

  if (params.status !== "state-degraded") {
    params.logSnapshotStage();
    await params.snapshotState();
    await params.syncCurrentStateFactHistory();
  }

  return { entry };
}
