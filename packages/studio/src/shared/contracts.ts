/**
 * Shared TypeScript contracts for Studio API/UI communication.
 * Ported from PR #96 (Te9ui1a) — prevents client/server type drift.
 */

// --- Health ---

export interface HealthStatus {
  readonly status: "ok";
  readonly projectRoot: string;
  readonly projectConfigFound: boolean;
  readonly envFound: boolean;
  readonly projectEnvFound: boolean;
  readonly globalConfigFound: boolean;
  readonly bookCount: number;
  readonly provider: string | null;
  readonly model: string | null;
}

// --- Books ---

export interface BookSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly platform: string;
  readonly genre: string;
  readonly targetChapters: number;
  readonly chapters: number;
  readonly chapterCount: number;
  readonly lastChapterNumber: number;
  readonly totalWords: number;
  readonly approvedChapters: number;
  readonly pendingReview: number;
  readonly pendingReviewChapters: number;
  readonly failedReview: number;
  readonly failedChapters: number;
  readonly recentRunStatus?: string | null;
  readonly updatedAt: string;
}

export interface BookDetail extends BookSummary {
  readonly createdAt: string;
  readonly chapterWordCount: number;
  readonly language: "zh" | "ko" | "en" | null;
}

export type ProductionReadinessStatus = "current" | "pending" | "stale" | "missing";

export interface BookProductionReadiness {
  readonly version: 1;
  readonly bookId: string;
  readonly inspectedAt: string;
  readonly status: ProductionReadinessStatus;
  readonly controlFiles: {
    readonly pitch: { readonly path: "story/project_pitch.md"; readonly status: "current" | "missing" };
    readonly bookRules: { readonly path: "story/book_rules.md"; readonly status: "current" | "missing" };
  };
  readonly references: ReadonlyArray<{ readonly materialId: string; readonly status: "unverified" | "missing" }>;
  readonly goldRoutes: ReadonlyArray<{ readonly receiptId: string; readonly status: "current" | "stale" | "missing" }>;
  readonly storyRail: { readonly status: ProductionReadinessStatus; readonly reason?: string };
  readonly narrativeArcs: ReadonlyArray<{ readonly allocationId: string; readonly narrativeArcId: string; readonly status: ProductionReadinessStatus }>;
  readonly arcPackets: ReadonlyArray<{ readonly arcPacketId: string; readonly status: ProductionReadinessStatus; readonly reason?: string }>;
  readonly latestChapterTruth: {
    readonly status: ProductionReadinessStatus | "not-applicable";
    readonly chapterNumber?: number;
    readonly chapterStatus?: string;
    readonly reason?: string;
  };
  readonly ownerLock: { readonly status: "clear" | "active" | "stale" };
  readonly openIssues: ReadonlyArray<{
    readonly kind: "chapter-audit" | "chapter-length" | "research";
    readonly status: "pending" | "stale";
    readonly message: string;
  }>;
}

// --- Chapters ---

export interface ChapterSummary {
  readonly number: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly auditIssueCount: number;
  readonly updatedAt: string;
  readonly fileName: string | null;
}

export interface ChapterDetail extends ChapterSummary {
  readonly auditIssues: ReadonlyArray<string>;
  readonly reviewNote?: string;
  readonly content: string;
}

export interface SaveChapterPayload {
  readonly content: string;
}

// --- Truth Files ---

export interface TruthFileSummary {
  readonly name: string;
  readonly label: string;
  readonly exists: boolean;
  readonly path: string;
  readonly optional: boolean;
  readonly available: boolean;
}

export interface TruthFileDetail extends TruthFileSummary {
  readonly content: string | null;
}

// --- Review ---

export interface ReviewActionPayload {
  readonly chapterNumber: number;
  readonly reason?: string;
}

// --- Runs ---

export type RunAction = "draft" | "audit" | "revise" | "write-next";

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface RunLogEntry {
  readonly timestamp: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
}

export interface RunActionPayload {
  readonly chapterNumber?: number;
}

export interface StudioRun {
  readonly id: string;
  readonly bookId: string;
  readonly chapter: number | null;
  readonly chapterNumber: number | null;
  readonly action: RunAction;
  readonly status: RunStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly logs: ReadonlyArray<RunLogEntry>;
  readonly result?: unknown;
  readonly error?: string;
}

export interface RunStreamEvent {
  readonly type: "snapshot" | "status" | "stage" | "log";
  readonly runId: string;
  readonly run?: StudioRun;
  readonly status?: RunStatus;
  readonly stage?: string;
  readonly log?: RunLogEntry;
  readonly result?: unknown;
  readonly error?: string;
}

// --- API Error Response ---

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
