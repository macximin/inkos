import { isAutomaticRevisionIssue, type AuditIssue, type AuditResult } from "../agents/continuity.js";
import type { ReviseMode, ReviseOutput } from "../agents/reviser.js";
import type { SensitiveWordResult } from "../agents/sensitive-words.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import { countChapterLength, isOutsideHardRange } from "../utils/length-metrics.js";

export interface ChapterReviewCycleUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ChapterReviewCycleControlInput {
  readonly chapterIntent: string;
  readonly chapterMemo?: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly ruleStack: RuleStack;
}

export interface ChapterReviewCycleResult {
  readonly finalContent: string;
  readonly finalWordCount: number;
  readonly preAuditNormalizedWordCount: number;
  readonly revised: boolean;
  readonly auditResult: AuditResult;
  /** Advisory publishing-platform preflight; never part of creative review. */
  readonly publicationCompatibility: SensitiveWordResult;
  readonly totalUsage: ChapterReviewCycleUsage;
  readonly postReviseCount: number;
  readonly normalizeApplied: boolean;
}

const DEFAULT_MAX_REVIEW_ITERATIONS = 1;
const NET_IMPROVEMENT_EPSILON = 3;

interface ReviewSnapshot {
  readonly content: string;
  readonly wordCount: number;
  readonly auditResult: AuditResult;
  readonly score: number;
  readonly lengthInRange: boolean;
  readonly publicationCompatibility: SensitiveWordResult;
}

export async function runChapterReviewCycle(params: {
  readonly book: Pick<{ genre: string }, "genre">;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly initialOutput: Pick<WriteChapterOutput, "content" | "wordCount" | "postWriteErrors">;
  readonly reducedControlInput?: ChapterReviewCycleControlInput;
  readonly arcProvenanceContext?: string;
  readonly lengthSpec: LengthSpec;
  readonly initialUsage: ChapterReviewCycleUsage;
  readonly createReviser: () => {
    reviseChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      issues: ReadonlyArray<AuditIssue>,
      mode?: ReviseMode,
      genre?: string,
      options?: {
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        chapterIntentData?: ChapterIntent;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
        lengthSpec?: LengthSpec;
        arcProvenanceContext?: string;
      },
    ) => Promise<ReviseOutput>;
  };
  readonly auditor: {
    auditChapter: (
      bookDir: string,
      chapterContent: string,
      chapterNumber: number,
      genre?: string,
      options?: {
        temperature?: number;
        chapterIntent?: string;
        chapterMemo?: ChapterMemo;
        arcContext?: string;
        contextPackage?: ContextPackage;
        ruleStack?: RuleStack;
      },
    ) => Promise<AuditResult>;
  };
  readonly normalizeDraftLengthIfNeeded: (chapterContent: string) => Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
    tokenUsage?: ChapterReviewCycleUsage;
  }>;
  readonly normalizePostWriteSurface?: (chapterContent: string) => string;
  readonly assertChapterContentNotEmpty: (content: string, stage: string) => void;
  readonly addUsage: (
    left: ChapterReviewCycleUsage,
    right?: ChapterReviewCycleUsage,
  ) => ChapterReviewCycleUsage;
  readonly analyzeAITells: (content: string) => { issues: ReadonlyArray<AuditIssue> };
  readonly analyzeSensitiveWords: (content: string) => SensitiveWordResult;
  /** Re-run deterministic post-write checks (chapter-ref, paragraph shape, etc.) on any content. */
  readonly runPostWriteChecks?: (content: string) => ReadonlyArray<AuditIssue>;
  readonly maxReviewIterations?: number;
  readonly logWarn: (message: { zh: string; en: string }) => void;
  readonly logStage: (message: { zh: string; en: string }) => void;
}): Promise<ChapterReviewCycleResult> {
  let totalUsage = params.initialUsage;
  let normalizeApplied = false;
  let finalContent = params.initialOutput.content;
  let finalWordCount = params.initialOutput.wordCount;

  // Convert initial postWriteErrors into AuditIssues as fallback when runPostWriteChecks isn't provided.
  const initialPostWriteIssues: ReadonlyArray<AuditIssue> = params.initialOutput.postWriteErrors.map((violation) => ({
    severity: "critical" as const,
    category: violation.rule,
    description: violation.description,
    suggestion: violation.suggestion,
    automaticRevisionEligible: true,
  }));

  // ---------------------------------------------------------------------------
  // Length normalization: dedicated step, only runs for clear hard-range drift.
  // Length is NOT mixed into the reviser's issues — normalize handles it.
  // ---------------------------------------------------------------------------
  const normalizeIfHardDrift = async (content: string): Promise<{
    content: string;
    wordCount: number;
    applied: boolean;
  }> => {
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    if (!isOutsideHardRange(wordCount, params.lengthSpec)) {
      return { content, wordCount, applied: false };
    }
    const result = await params.normalizeDraftLengthIfNeeded(content);
    totalUsage = params.addUsage(totalUsage, result.tokenUsage);
    return result;
  };

  const normalizedBeforeAudit = await normalizeIfHardDrift(finalContent);
  finalContent = params.normalizePostWriteSurface?.(normalizedBeforeAudit.content) ?? normalizedBeforeAudit.content;
  finalWordCount = countChapterLength(finalContent, params.lengthSpec.countingMode);
  const preAuditNormalizedWordCount = finalWordCount;
  normalizeApplied = normalizeApplied || normalizedBeforeAudit.applied;
  params.assertChapterContentNotEmpty(finalContent, "draft generation");

  // ---------------------------------------------------------------------------
  // Helper: assess a chapter (audit + deterministic checks + length + score)
  // ---------------------------------------------------------------------------
  const assess = async (
    content: string,
    options?: { temperature?: number },
  ): Promise<{
    auditResult: AuditResult;
    score: number;
    lengthInRange: boolean;
    publicationCompatibility: SensitiveWordResult;
  }> => {
    const auditOptions = {
      ...(params.reducedControlInput ?? {}),
      ...(params.arcProvenanceContext ? { arcContext: params.arcProvenanceContext } : {}),
      ...(options ?? {}),
    };
    const llmAudit = await params.auditor.auditChapter(
      params.bookDir,
      content,
      params.chapterNumber,
      params.book.genre,
      Object.keys(auditOptions).length > 0 ? auditOptions : undefined,
    );
    totalUsage = params.addUsage(totalUsage, llmAudit.tokenUsage);
    const aiTellsResult = params.analyzeAITells(content);
    const publicationCompatibility = params.analyzeSensitiveWords(content);
    const wordCount = countChapterLength(content, params.lengthSpec.countingMode);
    const lengthInRange = !isOutsideHardRange(wordCount, params.lengthSpec);

    // Deterministic post-write checks: run every round, not just the first.
    // If runPostWriteChecks is provided, use it; otherwise fall back to initial postWriteErrors.
    const currentPostWriteIssues = params.runPostWriteChecks
      ? params.runPostWriteChecks(content)
      : [];
    // Writer-reported deterministic violations belong to the initial draft even
    // when the host also supplies a fresh validator. Re-run validators on later
    // snapshots, but do not carry the writer's stale errors after a rewrite.
    const postWriteIssues = content === params.initialOutput.content
      ? [...initialPostWriteIssues, ...currentPostWriteIssues]
      : currentPostWriteIssues;

    const allIssues: AuditIssue[] = [
      ...llmAudit.issues,
      ...aiTellsResult.issues,
      ...postWriteIssues,
    ];

    // Length is NOT added to reviser issues — normalize handles it as a dedicated step.
    // lengthInRange is only used in isPassed() as a hard gate.

    // Verdicts are derived from the trusted issue envelope, not from an LLM's
    // free-standing boolean. This keeps warnings advisory even when a model
    // returns `passed: false`, while still refusing a contradictory
    // `passed: true` whenever a creative critical issue is present.
    const hasCreativeCritical = allIssues.some(isAutomaticRevisionIssue);
    const creativePassed = !llmAudit.parseFailed
      && !hasCreativeCritical;
    const auditResult: AuditResult = {
      passed: creativePassed,
      creativePassed,
      researchStatus: llmAudit.researchStatus ?? "not-applicable",
      issues: allIssues,
      summary: llmAudit.summary,
      parseFailed: llmAudit.parseFailed,
      overallScore: llmAudit.overallScore,
    };

    const score = llmAudit.overallScore ?? 0;

    return { auditResult, score, lengthInRange, publicationCompatibility };
  };

  const isPassed = (assessment: { auditResult: AuditResult; lengthInRange: boolean }): boolean =>
    assessment.auditResult.passed && assessment.lengthInRange;

  // ---------------------------------------------------------------------------
  // Trust-gate loop: assess → revise critical findings → assess. The score is
  // advisory and may compare already-eligible snapshots, but never turns a
  // warning into an automatic rewrite command.
  // ---------------------------------------------------------------------------
  const maxReviewIterations = Math.max(0, Math.floor(params.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS));
  params.logStage({ zh: "审计草稿", en: "auditing draft" });
  const initial = await assess(finalContent);

  const snapshots: ReviewSnapshot[] = [{
    content: finalContent,
    wordCount: finalWordCount,
    auditResult: initial.auditResult,
    score: initial.score,
    lengthInRange: initial.lengthInRange,
    publicationCompatibility: initial.publicationCompatibility,
  }];

  let currentAudit = initial;
  let postReviseCount = 0;

  if (initial.auditResult.parseFailed) {
    params.logWarn({
      zh: "审稿输出解析失败，跳过自动修稿以避免误改正文",
      en: "Audit output parsing failed; skipping automatic repair to avoid rewriting valid prose from an unreliable audit.",
    });
    return {
      finalContent,
      finalWordCount,
      preAuditNormalizedWordCount,
      revised: false,
      auditResult: initial.auditResult,
      publicationCompatibility: initial.publicationCompatibility,
      totalUsage,
      postReviseCount,
      normalizeApplied,
    };
  }

  if (!isPassed(initial)) {
    for (let iteration = 0; iteration < maxReviewIterations; iteration++) {
      params.logStage({
        zh: `修复轮次 ${iteration + 1}/${maxReviewIterations}（当前 ${currentAudit.score} 分）`,
        en: `repair iteration ${iteration + 1}/${maxReviewIterations} (current score: ${currentAudit.score})`,
      });

      const reviser = params.createReviser();
      const automaticRevisionIssues = currentAudit.auditResult.issues.filter(isAutomaticRevisionIssue);
      if (automaticRevisionIssues.length === 0) {
        params.logWarn({
          zh: "当前没有创作性严重问题；警告、研究状态与信息提示保留为建议，不自动修稿",
          en: "No creative critical findings remain; warnings, research status, and informational findings stay advisory, so automatic prose revision is skipped.",
        });
        break;
      }
      const reviseOutput = await reviser.reviseChapter(
        params.bookDir,
        finalContent,
        params.chapterNumber,
        automaticRevisionIssues,
        "auto",
        params.book.genre,
        {
          ...params.reducedControlInput,
          lengthSpec: params.lengthSpec,
          ...(params.arcProvenanceContext
            ? { arcProvenanceContext: params.arcProvenanceContext }
            : {}),
        },
      );
      totalUsage = params.addUsage(totalUsage, reviseOutput.tokenUsage);

      if (reviseOutput.revisedContent.length === 0 || reviseOutput.revisedContent === finalContent) {
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未产出新内容，退出循环`,
          en: `repair iteration ${iteration + 1} produced no new content, exiting loop`,
        });
        break;
      }

      params.assertChapterContentNotEmpty(reviseOutput.revisedContent, `repair iteration ${iteration + 1}`);
      const revisedContent = params.normalizePostWriteSurface?.(reviseOutput.revisedContent) ?? reviseOutput.revisedContent;
      const revisedWordCount = countChapterLength(revisedContent, params.lengthSpec.countingMode);

      // Re-assess revised content. If REVISED_CONTENT drifted on length,
      // lengthInRange will be false → isPassed fails → bestSnapshot picks
      // the earlier in-range version. No in-loop normalize needed.
      const nextAssessment = await assess(revisedContent, { temperature: 0 });

      if (nextAssessment.auditResult.parseFailed) {
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 的复审输出解析失败，保留上一份已验证正文`,
          en: `repair iteration ${iteration + 1} produced an unparseable re-audit; preserving the last verified draft`,
        });
        break;
      }

      snapshots.push({
        content: revisedContent,
        wordCount: revisedWordCount,
        auditResult: nextAssessment.auditResult,
        score: nextAssessment.score,
        lengthInRange: nextAssessment.lengthInRange,
        publicationCompatibility: nextAssessment.publicationCompatibility,
      });

      // Check if passed
      if (isPassed(nextAssessment)) {
        params.logStage({
          zh: `修复后通过硬门槛（参考分 ${nextAssessment.score}），退出循环`,
          en: `repair cleared hard gates (advisory score: ${nextAssessment.score}), exiting loop`,
        });
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        break;
      }

      // Continue only when the automatic hard-gate debt shrinks. Advisory
      // scores may rise or fall, but cannot halt a repair that removed a
      // critical reader-trust failure.
      const currentCriticalCount = currentAudit.auditResult.issues.filter(isAutomaticRevisionIssue).length;
      const nextCriticalCount = nextAssessment.auditResult.issues.filter(isAutomaticRevisionIssue).length;
      if (nextCriticalCount < currentCriticalCount) {
        finalContent = revisedContent;
        finalWordCount = revisedWordCount;
        postReviseCount = revisedWordCount;
        currentAudit = nextAssessment;
        // Continue to next iteration
      } else {
        params.logWarn({
          zh: `修复轮次 ${iteration + 1} 未减少关键问题（${currentCriticalCount} → ${nextCriticalCount}），退出循环`,
          en: `repair iteration ${iteration + 1} did not reduce critical findings (${currentCriticalCount} → ${nextCriticalCount}), exiting loop`,
        });
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pick the safest eligible snapshot. Hard length and creative pass outrank
  // the advisory score. If every repair still fails, preserve the earliest
  // draft instead of silently adopting a different but still-blocked rewrite.
  // ---------------------------------------------------------------------------
  const eligibleSnapshots = snapshots.filter((snapshot) =>
    snapshot.lengthInRange
    && snapshot.auditResult.passed
    && !snapshot.auditResult.parseFailed
  );
  const bestSnapshot = eligibleSnapshots.length === 0
    ? snapshots[0]!
    : eligibleSnapshots.slice(1).reduce(
        (best, snapshot) => snapshot.score >= best.score + NET_IMPROVEMENT_EPSILON
          ? snapshot
          : best,
        eligibleSnapshots[0]!,
      );

  // If the working copy is not the safest eligible snapshot, restore the
  // selected version. This also rejects a repair that remains hard-blocked.
  const shouldRestoreBestSnapshot = bestSnapshot.content !== finalContent;
  if (shouldRestoreBestSnapshot) {
    params.logWarn({
      zh: `回退到最安全的合格版本（参考分 ${bestSnapshot.score} vs 当前 ${currentAudit.score}）`,
      en: `rolling back to the safest eligible version (advisory score: ${bestSnapshot.score} vs ${currentAudit.score})`,
    });
    finalContent = bestSnapshot.content;
    finalWordCount = bestSnapshot.wordCount;
    currentAudit = {
      auditResult: bestSnapshot.auditResult,
      score: bestSnapshot.score,
      lengthInRange: bestSnapshot.lengthInRange,
      publicationCompatibility: bestSnapshot.publicationCompatibility,
    };
  }

  return {
    finalContent,
    finalWordCount,
    preAuditNormalizedWordCount,
    revised: snapshots.length > 1 && finalContent !== params.initialOutput.content,
    auditResult: currentAudit.auditResult,
    publicationCompatibility: currentAudit.publicationCompatibility,
    totalUsage,
    postReviseCount,
    normalizeApplied,
  };
}
