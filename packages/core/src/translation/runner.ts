import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadTranslationChapter,
  loadTranslationGlossary,
  loadTranslationManifest,
  mergeGlossaryTerms,
  saveTranslationChapter,
  saveTranslationGlossary,
  saveTranslationManifest,
  translationProjectDir,
} from "./run-store.js";
import type {
  RunTranslationProjectResult,
  TranslationChapterFile,
  TranslationModelPort,
  TranslationProjectManifest,
  TranslationSegment,
} from "./types.js";

export async function runTranslationProject(
  projectRoot: string,
  projectId: string,
  options: {
    readonly model: TranslationModelPort;
    readonly batchSize?: number;
    readonly maxReviewRetries?: number;
  },
): Promise<RunTranslationProjectResult> {
  let manifest = await loadTranslationManifest(projectRoot, projectId);
  let glossary = [...await loadTranslationGlossary(projectRoot, projectId)];
  const reportCopy = translationReviewCopy(manifest.targetLanguage);
  const reportLines = [`# ${reportCopy.title}`, ""];
  let translatedSegments = 0;
  let reviewedChapters = 0;
  let reviewAttempts = 0;
  let revisedChapters = 0;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 8, 32));
  const maxReviewRetries = Math.max(0, Math.min(options.maxReviewRetries ?? 2, 4));

  for (const chapterInfo of manifest.chapters) {
    const source = await loadTranslationChapter(projectRoot, chapterInfo.sourcePath);
    const translated = await loadTranslationChapter(projectRoot, chapterInfo.translatedPath).catch(() => ({
      ...source,
      segments: [],
    } satisfies TranslationChapterFile));
    const translatedByIndex = new Map(translated.segments.map((segment) => [segment.index, segment]));
    let translatedTitle = translated.translatedTitle?.trim() || chapterInfo.translatedTitle?.trim() || "";
    if (!translatedTitle && options.model.translateTitle) {
      const titleResult = await options.model.translateTitle({
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        title: source.title,
        glossary,
      });
      translatedTitle = titleResult.title.trim();
      if (!translatedTitle) throw new Error(`Translation model returned an empty title for chapter ${chapterInfo.number}.`);
    }
    const pending = source.segments.filter((segment) => !translatedByIndex.get(segment.index)?.target?.trim());

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      const batch = pending.slice(offset, offset + batchSize);
      const result = await options.model.translateSegments({
        sourceLanguage: manifest.sourceLanguage,
        targetLanguage: manifest.targetLanguage,
        chapterTitle: source.title,
        segments: batch,
        glossary,
      });
      assertCompleteSegmentResult(batch, result.segments, "Translation");
      for (const item of result.segments) {
        const original = source.segments.find((segment) => segment.index === item.index);
        if (!original) continue;
        translatedByIndex.set(item.index, {
          ...original,
          target: item.target,
          ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
        });
        translatedSegments++;
      }
      if (result.glossary?.length) {
        glossary = [...mergeGlossaryTerms([...glossary, ...result.glossary])];
      }
      await saveTranslationGlossary(projectRoot, projectId, glossary);
      await saveTranslationChapter(projectRoot, chapterInfo.translatedPath, {
        ...source,
        ...(translatedTitle ? { translatedTitle } : {}),
        segments: orderedTranslatedSegments(source.segments, translatedByIndex),
      });
    }

    let completedSegments = orderedTranslatedSegments(source.segments, translatedByIndex);
    await saveTranslationChapter(projectRoot, chapterInfo.translatedPath, {
      ...source,
      ...(translatedTitle ? { translatedTitle } : {}),
      segments: completedSegments,
    });
    let status: "translated" | "reviewed" = "translated";
    if (options.model.reviewChapter && completedSegments.length > 0 && completedSegments.every((segment) => segment.target?.trim())) {
      reviewedChapters++;
      const reportHeadingIndex = reportLines.length;
      reportLines.push(`## ${translatedTitle || source.title}`, "", `> ${source.title}`, "");
      let revisionsApplied = 0;
      let chapterRevised = false;
      while (true) {
        reviewAttempts++;
        const review = await options.model.reviewChapter({
          sourceLanguage: manifest.sourceLanguage,
          targetLanguage: manifest.targetLanguage,
          chapterTitle: source.title,
          ...(translatedTitle ? { translatedTitle } : {}),
          segments: completedSegments,
          glossary,
        });
        const passed = review.passed && review.issues.length === 0;
        reportLines.push(
          `### ${reportCopy.attempt} ${revisionsApplied + 1}`,
          "",
          `- ${reportCopy.passed}: ${passed ? reportCopy.yes : reportCopy.no}`,
          `- ${reportCopy.summary}: ${review.summary}`,
          "",
        );
        for (const issue of review.issues) {
          reportLines.push(`- ${reportCopy.issue}: ${issue}`);
        }
        reportLines.push("");
        if (passed) {
          status = "reviewed";
          break;
        }
        if (!options.model.reviseChapter || revisionsApplied >= maxReviewRetries) break;

        const revision = await options.model.reviseChapter({
          sourceLanguage: manifest.sourceLanguage,
          targetLanguage: manifest.targetLanguage,
          chapterTitle: source.title,
          ...(translatedTitle ? { translatedTitle } : {}),
          segments: completedSegments,
          glossary,
          issues: review.issues.length > 0 ? review.issues : [review.summary],
        });
        assertCompleteSegmentResult(source.segments, revision.segments, "Translation revision");
        for (const item of revision.segments) {
          const original = source.segments.find((segment) => segment.index === item.index)!;
          translatedByIndex.set(item.index, {
            ...original,
            target: item.target,
            ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
          });
        }
        if (revision.translatedTitle?.trim()) translatedTitle = revision.translatedTitle.trim();
        if (revision.glossary?.length) {
          glossary = [...mergeGlossaryTerms([...glossary, ...revision.glossary])];
          await saveTranslationGlossary(projectRoot, projectId, glossary);
        }
        completedSegments = orderedTranslatedSegments(source.segments, translatedByIndex);
        await saveTranslationChapter(projectRoot, chapterInfo.translatedPath, {
          ...source,
          ...(translatedTitle ? { translatedTitle } : {}),
          segments: completedSegments,
        });
        revisionsApplied++;
        chapterRevised = true;
        reportLines.push(`- ${reportCopy.revisionApplied}`, "");
      }
      reportLines[reportHeadingIndex] = `## ${translatedTitle || source.title}`;
      if (chapterRevised) revisedChapters++;
    }
    manifest = updateChapterStatus(manifest, chapterInfo.number, status, translatedTitle);
    await saveTranslationManifest(projectRoot, manifest);
  }

  const reportPathAbs = join(translationProjectDir(projectRoot, projectId), "review-report.md");
  await writeFile(reportPathAbs, reportLines.join("\n").trimEnd() + "\n", "utf-8");
  return {
    projectId,
    translatedSegments,
    reviewedChapters,
    reviewAttempts,
    revisedChapters,
    reportPath: `translations/${projectId}/review-report.md`,
  };
}

function translationReviewCopy(targetLanguage: string): {
  readonly title: string;
  readonly passed: string;
  readonly summary: string;
  readonly issue: string;
  readonly yes: string;
  readonly no: string;
  readonly attempt: string;
  readonly revisionApplied: string;
} {
  if (/한국어|korean|\bko\b/iu.test(targetLanguage)) {
    return { title: "번역 검수", passed: "통과", summary: "요약", issue: "문제", yes: "예", no: "아니요", attempt: "검수", revisionApplied: "자동 수정을 적용했습니다." };
  }
  if (/中文|汉语|漢語|chinese|\bzh\b/iu.test(targetLanguage)) {
    return { title: "翻译审校", passed: "通过", summary: "摘要", issue: "问题", yes: "是", no: "否", attempt: "审校", revisionApplied: "已应用自动修订。" };
  }
  return { title: "Translation Review", passed: "passed", summary: "summary", issue: "issue", yes: "yes", no: "no", attempt: "Review", revisionApplied: "Automatic revision applied." };
}

function assertCompleteSegmentResult(
  sourceSegments: ReadonlyArray<TranslationSegment>,
  returnedSegments: ReadonlyArray<{ readonly index: number }>,
  label: string,
): void {
  const returnedIndexes = new Set(returnedSegments.map((segment) => segment.index));
  const missing = sourceSegments.map((segment) => segment.index).filter((index) => !returnedIndexes.has(index));
  if (missing.length > 0) throw new Error(`${label} omitted segments: ${missing.join(", ")}`);
}

function orderedTranslatedSegments(
  sourceSegments: ReadonlyArray<TranslationSegment>,
  translatedByIndex: ReadonlyMap<number, TranslationSegment>,
): ReadonlyArray<TranslationSegment> {
  return sourceSegments.map((segment) => translatedByIndex.get(segment.index) ?? segment);
}

function updateChapterStatus(
  manifest: TranslationProjectManifest,
  chapterNumber: number,
  status: "translated" | "reviewed",
  translatedTitle: string,
): TranslationProjectManifest {
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    chapters: manifest.chapters.map((chapter) =>
      chapter.number === chapterNumber
        ? { ...chapter, status, ...(translatedTitle ? { translatedTitle } : {}) }
        : chapter,
    ),
  };
}
