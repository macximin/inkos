import type { ContextPackage } from "../models/input-governance.js";

export function buildGovernedMemoryEvidenceBlocks(
  contextPackage: ContextPackage,
  language?: "zh" | "ko" | "en",
): {
  readonly hookDebtBlock?: string;
  readonly hooksBlock?: string;
  readonly summariesBlock?: string;
  readonly volumeSummariesBlock?: string;
  readonly titleHistoryBlock?: string;
  readonly moodTrailBlock?: string;
  readonly canonBlock?: string;
} {
  const resolvedLanguage = language ?? "zh";
  const hookEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source.startsWith("story/pending_hooks.md#"),
  );
  const hookDebtEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source.startsWith("runtime/hook_debt#"),
  );
  const summaryEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source.startsWith("story/chapter_summaries.md#"),
  );
  const volumeSummaryEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source.startsWith("story/volume_summaries.md#"),
  );
  const titleHistoryEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source === "story/chapter_summaries.md#recent_titles",
  );
  const moodTrailEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source === "story/chapter_summaries.md#recent_mood_type_trail",
  );
  const canonEntries = contextPackage.selectedContext.filter((entry) =>
    entry.source === "story/parent_canon.md"
    || entry.source === "story/fanfic_canon.md",
  );

  return {
    hookDebtBlock: hookDebtEntries.length > 0
      ? renderHookDebtBlock(
          resolvedLanguage === "ko" ? "복선 부채 요약" : "Hook Debt Briefs",
          hookDebtEntries,
        )
      : undefined,
    hooksBlock: hookEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "선택된 복선 근거" : resolvedLanguage === "en" ? "Selected Hook Evidence" : "已选伏笔证据",
          hookEntries,
        )
      : undefined,
    summariesBlock: summaryEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "선택된 회차 요약 근거" : resolvedLanguage === "en" ? "Selected Chapter Summary Evidence" : "已选章节摘要证据",
          summaryEntries,
        )
      : undefined,
    volumeSummariesBlock: volumeSummaryEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "선택된 권 요약 근거" : resolvedLanguage === "en" ? "Selected Volume Summary Evidence" : "已选卷级摘要证据",
          volumeSummaryEntries,
        )
      : undefined,
    titleHistoryBlock: titleHistoryEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "최근 제목 기록" : resolvedLanguage === "en" ? "Recent Title History" : "近期标题历史",
          titleHistoryEntries,
        )
      : undefined,
    moodTrailBlock: moodTrailEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "최근 정서 / 회차 유형 기록" : resolvedLanguage === "en" ? "Recent Mood / Chapter Type Trail" : "近期情绪/章节类型轨迹",
          moodTrailEntries,
        )
      : undefined,
    canonBlock: canonEntries.length > 0
      ? renderEvidenceBlock(
          resolvedLanguage === "ko" ? "정전 근거" : resolvedLanguage === "en" ? "Canon Evidence" : "正典约束证据",
          canonEntries,
        )
      : undefined,
  };
}

function renderHookDebtBlock(
  heading: string,
  entries: ContextPackage["selectedContext"],
): string {
  return `\n## ${heading}\n${entries.map((entry) => `- ${entry.excerpt ?? entry.reason}`).join("\n")}\n`;
}

function renderEvidenceBlock(
  heading: string,
  entries: ContextPackage["selectedContext"],
): string {
  const lines = entries.map((entry) =>
    `- ${entry.source}: ${entry.excerpt ?? entry.reason}`,
  );

  return `\n## ${heading}\n${lines.join("\n")}\n`;
}
