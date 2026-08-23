import { describe, expect, it, vi } from "vitest";
import { runChapterReviewCycle } from "../pipeline/chapter-review-cycle.js";
import type { AuditResult, AuditIssue } from "../agents/continuity.js";
import type { LengthSpec } from "../models/length-governance.js";

const LENGTH_SPEC: LengthSpec = {
  target: 220,
  softMin: 190,
  softMax: 250,
  hardMin: 160,
  hardMax: 280,
  countingMode: "zh_chars",
  normalizeMode: "none",
};

const ZERO_USAGE: { promptTokens: number; completionTokens: number; totalTokens: number } = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

function createAuditResult(overrides?: Partial<AuditResult>): AuditResult {
  return {
    passed: true,
    issues: [],
    summary: "clean",
    overallScore: 90,
    ...overrides,
  };
}

const baseParams = {
  book: { genre: "xuanhuan" },
  bookDir: "/tmp/book",
  chapterNumber: 1,
  lengthSpec: LENGTH_SPEC,
  reducedControlInput: undefined,
  initialUsage: ZERO_USAGE,
  assertChapterContentNotEmpty: () => undefined,
  addUsage: (left: typeof ZERO_USAGE, right?: typeof ZERO_USAGE) => ({
    promptTokens: left.promptTokens + (right?.promptTokens ?? 0),
    completionTokens: left.completionTokens + (right?.completionTokens ?? 0),
    totalTokens: left.totalTokens + (right?.totalTokens ?? 0),
  }),
  analyzeAITells: () => ({ issues: [] as AuditIssue[] }),
  analyzeSensitiveWords: () => ({ found: [] as Array<{ severity: "warn" | "block" }>, issues: [] as AuditIssue[] }),
  logWarn: () => undefined,
  logStage: () => undefined,
} as const;

describe("runChapterReviewCycle v9", () => {
  it("feeds postWriteErrors as extra issues into first assessment", async () => {
    // postWriteErrors are critical → auditResult.passed forced false
    // even though LLM says passed=true. This triggers the repair loop.
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({ overallScore: 90, passed: true }))
      .mockResolvedValueOnce(createAuditResult({ overallScore: 92, passed: true }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: ["fixed"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "b".repeat(200),
        wordCount: 200,
        postWriteErrors: [{
          rule: "chapter-number-reference",
          description: "contains chapter ref",
          suggestion: "remove it",
          severity: "error",
        }],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      // Simulates: the reviser fixed the chapter-ref, so re-check returns empty
      runPostWriteChecks: (content) =>
        content === "b".repeat(200)
          ? [{ severity: "critical" as const, category: "chapter-number-reference", description: "contains chapter ref", suggestion: "remove it" }]
          : [],
    });

    // After repair, postWriteChecks on the revised content returns empty → issue gone
    expect(result.auditResult.issues.some(i => i.category === "chapter-number-reference")).toBe(false);
    // The loop should have run at least once to fix the critical postWriteError
    expect(reviseChapter).toHaveBeenCalled();
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");
  });

  it("keeps pre-audit and post-revision length telemetry distinct", async () => {
    const initialContent = "i".repeat(200);
    const revisedContent = "r".repeat(220);
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({ passed: true, overallScore: 90 }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: ["fixed"],
      updatedState: "state",
      updatedLedger: "",
      updatedHooks: "hooks",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: initialContent,
        wordCount: initialContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 1,
    });

    expect(result.preAuditNormalizedWordCount).toBe(200);
    expect(result.postReviseCount).toBe(220);
    expect(result.finalWordCount).toBe(220);
    expect(result.revised).toBe(true);
  });

  it("does not auto-revise when audit output parsing failed", async () => {
    const originalContent = "b".repeat(200);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      overallScore: 0,
      parseFailed: true,
      summary: "审稿输出解析失败",
      issues: [{
        severity: "critical",
        category: "系统错误",
        description: "审稿输出格式异常，无法解析为 JSON",
        suggestion: "检查模型输出格式",
      }],
    }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: "a".repeat(200),
      wordCount: 200,
      fixedIssues: ["should not run"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.revised).toBe(false);
    expect(result.auditResult.parseFailed).toBe(true);
  });

  it("does not adopt an in-range repair when its re-audit cannot be parsed", async () => {
    const originalContent = "o".repeat(100);
    const revisedContent = "r".repeat(200);
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 0,
        parseFailed: true,
        issues: [{ severity: "critical", category: "system", description: "bad JSON", suggestion: "retry" }],
      }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: ["attempted repair"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockImplementation(async (content: string) => ({
      content,
      wordCount: content.length,
      applied: false,
      tokenUsage: ZERO_USAGE,
    }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe(originalContent);
    expect(result.revised).toBe(false);
    expect(result.auditResult.parseFailed).not.toBe(true);
  });

  it("keeps repairing creative critical issues and accepts the first hard-gate pass", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [
          { severity: "critical", category: "continuity", description: "broken", suggestion: "fix" },
          { severity: "critical", category: "timeline", description: "time order broken", suggestion: "restore order" },
        ],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 69,
        issues: [{ severity: "critical", category: "continuity", description: "still broken", suggestion: "fix again" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 76,
        issues: [{ severity: "warning", category: "pacing", description: "slightly slow", suggestion: "optional trim" }],
      }));

    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        wordCount: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        wordCount: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 2,
    });

    // The first repair lowers critical debt even though its advisory score
    // falls. That hard-gate progress earns the second repair attempt.
    expect(reviseChapter).toHaveBeenCalledTimes(2);
    expect(reviseChapter.mock.calls[0]?.[4]).toBe("auto");

    expect(result.auditResult.overallScore).toBe(76);
    expect(result.finalContent).toBe("b".repeat(200));
    expect(result.revised).toBe(true);
  });

  it("does not let a higher-scoring hard-range failure displace an in-range draft", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 80,
        issues: [{ severity: "critical", category: "continuity", description: "needs work", suggestion: "tighten" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 95,
        issues: [],
      }));

    const reviseChapter = vi.fn().mockResolvedValueOnce({
      revisedContent: "x".repeat(80),
      wordCount: 80,
      fixedIssues: ["tightened"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.finalContent).toBe("c".repeat(200));
    expect(result.finalWordCount).toBe(200);
    expect(result.auditResult.overallScore).toBe(80);
  });

  it("defaults to one automatic repair pass", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: false,
        overallScore: 70,
        issues: [{ severity: "critical", category: "continuity", description: "broken", suggestion: "fix" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 80,
        issues: [{ severity: "warning", category: "pacing", description: "slow", suggestion: "trim" }],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        overallScore: 90,
      }));

    const reviseChapter = vi.fn()
      .mockResolvedValueOnce({
        revisedContent: "a".repeat(200),
        wordCount: 200,
        fixedIssues: ["fixed continuity"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      })
      .mockResolvedValueOnce({
        revisedContent: "b".repeat(200),
        wordCount: 200,
        fixedIssues: ["trimmed pacing"],
        updatedState: "", updatedLedger: "", updatedHooks: "",
        tokenUsage: ZERO_USAGE,
      });

    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "c".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
    });

    expect(reviseChapter).toHaveBeenCalledTimes(1);
    expect(result.auditResult.overallScore).toBe(80);
    expect(result.finalContent).toBe("a".repeat(200));
  });

  it("stops immediately on a creative pass even when the advisory score is low", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 62 }));
    const reviseChapter = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: "d".repeat(200),
        wordCount: 200,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
    });

    // No revision should have been called
    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.auditResult.overallScore).toBe(62);
    expect(result.revised).toBe(false);
  });

  it("never sends research-only findings to automatic prose revision", async () => {
    const originalContent = "미래의 수요는 기억했지만 시험 생산은 오늘 시작했다.".repeat(8);
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: true,
      creativePassed: true,
      researchStatus: "needs-research",
      overallScore: 70,
      issues: [{
        severity: "info",
        track: "research",
        category: "시대 고증",
        description: "당시 설비 단가를 추가 확인해야 한다.",
        suggestion: "별도 리서치로 확인한다.",
      }],
    }));
    const reviseChapter = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      maxReviewIterations: 1,
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.auditResult.creativePassed).toBe(true);
    expect(result.auditResult.researchStatus).toBe("needs-research");
  });

  it("reports a deterministic warning without auto-revising the chapter", async () => {
    const originalContent = "b".repeat(200);
    const revisedContent = "a".repeat(200);
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 97, passed: true }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: ["fixed paragraph fragmentation"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      runPostWriteChecks: (content) => content === originalContent
        ? [{
            severity: "warning" as const,
            category: "문단 파편화",
            description: "짧은 문단이 지나치게 많습니다.",
            suggestion: "이어지는 행동을 한 문단으로 묶으세요.",
          }]
        : [],
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.auditResult.passed).toBe(true);
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "문단 파편화", severity: "warning" }),
    ]));
  });

  it("describes warning-only findings as advisory when the auditor marks them failed", async () => {
    const originalContent = "b".repeat(200);
    const logWarn = vi.fn();
    const auditChapter = vi.fn().mockResolvedValue(createAuditResult({
      passed: false,
      creativePassed: false,
      overallScore: 72,
      issues: [{
        severity: "warning",
        category: "pacing",
        description: "The ending could pull forward more strongly.",
        suggestion: "Consider sharpening the final beat.",
      }],
    }));
    const reviseChapter = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      logWarn,
      maxReviewIterations: 1,
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.auditResult.passed).toBe(true);
    expect(result.auditResult.creativePassed).toBe(true);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("rejects a contradictory pass verdict when creative critical evidence exists", async () => {
    const originalContent = "b".repeat(200);
    const revisedContent = "r".repeat(200);
    const criticalIssue: AuditIssue = {
      severity: "critical",
      track: "creative",
      category: "continuity",
      description: "The protagonist uses knowledge they never acquired.",
      suggestion: "Restore the established information boundary.",
    };
    const auditChapter = vi.fn()
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        creativePassed: true,
        overallScore: 85,
        issues: [criticalIssue],
      }))
      .mockResolvedValueOnce(createAuditResult({
        passed: true,
        creativePassed: true,
        overallScore: 88,
        issues: [],
      }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: ["restored information boundary"],
      updatedState: "state",
      updatedLedger: "",
      updatedHooks: "hooks",
      tokenUsage: ZERO_USAGE,
    });

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded: async (content) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }),
      maxReviewIterations: 1,
    });

    expect(reviseChapter).toHaveBeenCalledOnce();
    expect(result.finalContent).toBe(revisedContent);
    expect(result.auditResult.passed).toBe(true);
    expect(result.auditResult.issues).toEqual([]);
  });

  it("keeps AI-tell warnings and info advisory without automatic repair", async () => {
    const originalContent = "b".repeat(200);
    const revisedContent = "a".repeat(200);
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 97, passed: true }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: ["fixed formulaic transitions"],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      analyzeAITells: (content) => ({
        issues: content === originalContent
          ? [{
              severity: "warning" as const,
              category: "접속어 반복",
              description: "같은 접속어가 반복됩니다.",
              suggestion: "행동으로 장면을 전환하세요.",
            }, {
              severity: "info" as const,
              category: "나열식 문장 구조",
              description: "같은 첫머리가 반복됩니다.",
              suggestion: "문장 첫머리를 바꾸세요.",
            }]
          : [{
              severity: "info" as const,
              category: "나열식 문장 구조",
              description: "같은 첫머리가 반복됩니다.",
              suggestion: "문장 첫머리를 바꾸세요.",
            }],
      }),
    });

    expect(reviseChapter).not.toHaveBeenCalled();
    expect(result.finalContent).toBe(originalContent);
    expect(result.auditResult.passed).toBe(true);
    expect(result.auditResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "접속어 반복", severity: "warning" }),
      expect.objectContaining({ category: "나열식 문장 구조", severity: "info" }),
    ]));
  });

  it("preserves the original when a length repair still fails the creative hard gate", async () => {
    const originalContent = "원".repeat(120);
    const stillBlockedRevision = "수".repeat(200);
    const unresolvedIssue: AuditIssue = {
      severity: "critical",
      category: "독자 보상 누락",
      description: "약속한 핵심 보상 장면이 없습니다.",
      suggestion: "핵심 보상 장면을 실제 행동으로 지급하세요.",
    };
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({
        passed: false,
        overallScore: 50,
        issues: [unresolvedIssue],
      }));
    const reviseChapter = vi.fn().mockResolvedValue({
      revisedContent: stillBlockedRevision,
      wordCount: stillBlockedRevision.length,
      fixedIssues: [],
      updatedState: "",
      updatedLedger: "",
      updatedHooks: "",
      tokenUsage: ZERO_USAGE,
    });
    const normalizeDraftLengthIfNeeded = vi.fn().mockImplementation(async (content: string) => ({
      content,
      wordCount: content.length,
      applied: false,
      tokenUsage: ZERO_USAGE,
    }));

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: originalContent,
        wordCount: originalContent.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
    });

    expect(reviseChapter).toHaveBeenCalledOnce();
    expect(result.finalContent).toBe(originalContent);
    expect(result.finalWordCount).toBe(originalContent.length);
    expect(result.revised).toBe(false);
    expect(result.auditResult.issues).toEqual([unresolvedIssue]);
  });

  it("normalizes deterministic surface blockers before audit and repair", async () => {
    const auditChapter = vi.fn()
      .mockResolvedValue(createAuditResult({ overallScore: 90, passed: true }));
    const reviseChapter = vi.fn();
    const normalizeDraftLengthIfNeeded = vi.fn()
      .mockImplementation(async (content: string) => ({
        content,
        wordCount: content.length,
        applied: false,
        tokenUsage: ZERO_USAGE,
      }));
    const unsafe = `${"雨".repeat(100)}——${"夜".repeat(98)}`;

    const result = await runChapterReviewCycle({
      ...baseParams,
      initialOutput: {
        content: unsafe,
        wordCount: unsafe.length,
        postWriteErrors: [],
      },
      createReviser: () => ({ reviseChapter }),
      auditor: { auditChapter },
      normalizeDraftLengthIfNeeded,
      normalizePostWriteSurface: (content) => content.replace(/——+/g, "，"),
      runPostWriteChecks: (content) =>
        content.includes("——")
          ? [{ severity: "critical" as const, category: "禁止破折号", description: "出现了破折号", suggestion: "用逗号断句" }]
          : [],
    });

    expect(auditChapter.mock.calls[0]?.[1]).not.toContain("——");
    expect(result.finalContent).not.toContain("——");
    expect(result.auditResult.passed).toBe(true);
    expect(reviseChapter).not.toHaveBeenCalled();
  });
});
