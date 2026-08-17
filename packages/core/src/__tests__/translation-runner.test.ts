import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTranslationProjectFromFile,
  runTranslationProject,
  writeTranslationExport,
  type TranslationModelPort,
} from "../translation/index.js";

describe("translation runner", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-translation-runner-"));
    await mkdir(join(root, "inputs"), { recursive: true });
    await writeFile(join(root, "inputs", "book.md"), [
      "# 第一章 雨夜",
      "",
      "第一段。",
      "",
      "第二段。",
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("translates pending segments, persists review report, and resumes without duplicate model calls", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "zh",
      targetLanguage: "en",
    });
    const translateSegments = vi.fn<TranslationModelPort["translateSegments"]>(async ({ segments }) => ({
      segments: segments.map((segment) => ({
        index: segment.index,
        target: `EN:${segment.source}`,
      })),
      glossary: [{ source: "雨夜", target: "rainy night", note: "chapter tone" }],
    }));
    const reviewChapter = vi.fn<NonNullable<TranslationModelPort["reviewChapter"]>>(async () => ({
      passed: true,
      summary: "ok",
      issues: [],
    }));

    const first = await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, reviewChapter },
      batchSize: 1,
    });
    expect(first.translatedSegments).toBe(2);
    expect(first.reviewedChapters).toBe(1);
    expect(translateSegments).toHaveBeenCalledTimes(2);

    const report = await readFile(join(root, first.reportPath), "utf-8");
    expect(report).toContain("ok");
    expect(report).toContain("雨夜");

    const second = await runTranslationProject(root, created.manifest.id, {
      model: { translateSegments, reviewChapter },
      batchSize: 1,
    });
    expect(second.translatedSegments).toBe(0);
    expect(translateSegments).toHaveBeenCalledTimes(2);

    const exported = await writeTranslationExport(root, created.manifest.id, { format: "md" });
    const markdown = await readFile(exported.outputPath, "utf-8");
    expect(markdown).toContain("EN:第一段。");
    expect(markdown).toContain("EN:第二段。");
    expect(markdown).not.toContain("\n第一段。\n");
  });

  it("writes Korean review headings for a Korean target", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "중국어(간체)",
      targetLanguage: "한국어",
    });
    const model: TranslationModelPort = {
      translateSegments: async ({ segments }) => ({
        segments: segments.map((segment) => ({ index: segment.index, target: `번역:${segment.source}` })),
      }),
      reviewChapter: async () => ({ passed: false, summary: "수정 필요", issues: ["용어 불일치"] }),
    };

    const result = await runTranslationProject(root, created.manifest.id, { model });
    const report = await readFile(join(root, result.reportPath), "utf-8");
    expect(report).toContain("# 번역 검수");
    expect(report).toContain("- 통과: 아니요");
    expect(report).toContain("- 요약: 수정 필요");
    expect(report).toContain("- 문제: 용어 불일치");
    expect(report).not.toContain("Translation Review");
    await expect(writeTranslationExport(root, created.manifest.id, { format: "md" }))
      .rejects.toThrow("have not passed review");
  });

  it("translates the title, auto-revises failed review issues, re-reviews, and exports only the passing result", async () => {
    const created = await createTranslationProjectFromFile(root, {
      filePath: "inputs/book.md",
      sourceLanguage: "중국어(간체)",
      targetLanguage: "한국어",
      title: "자동 수정 카나리",
    });
    const reviewChapter = vi.fn<NonNullable<TranslationModelPort["reviewChapter"]>>()
      .mockResolvedValueOnce({ passed: true, summary: "오역 수정 필요", issues: ["地磅 용어 오역"] })
      .mockResolvedValueOnce({ passed: true, summary: "문제 없음", issues: [] });
    const reviseChapter = vi.fn<NonNullable<TranslationModelPort["reviseChapter"]>>(async ({ segments }) => ({
      translatedTitle: "비 오는 밤",
      segments: segments.map((segment) => ({ index: segment.index, target: `교정:${segment.source}` })),
      glossary: [{ source: "雨夜", target: "비 오는 밤" }],
    }));
    const model: TranslationModelPort = {
      translateTitle: async () => ({ title: "우야" }),
      translateSegments: async ({ segments }) => ({
        segments: segments.map((segment) => ({ index: segment.index, target: `초벌:${segment.source}` })),
      }),
      reviewChapter,
      reviseChapter,
    };

    const result = await runTranslationProject(root, created.manifest.id, {
      model,
      maxReviewRetries: 2,
    });
    expect(result.reviewedChapters).toBe(1);
    expect(result.reviewAttempts).toBe(2);
    expect(result.revisedChapters).toBe(1);
    expect(reviewChapter).toHaveBeenCalledTimes(2);
    expect(reviseChapter).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(await readFile(join(root, created.manifestPath), "utf-8")) as {
      chapters: Array<{ status: string; translatedTitle?: string }>;
    };
    expect(manifest.chapters[0]).toMatchObject({ status: "reviewed", translatedTitle: "비 오는 밤" });

    const exported = await writeTranslationExport(root, created.manifest.id, { format: "md" });
    const markdown = await readFile(exported.outputPath, "utf-8");
    expect(markdown).toContain("## 비 오는 밤");
    expect(markdown).toContain("교정:第一段。");
    expect(markdown).not.toContain("초벌:");

    const report = await readFile(join(root, result.reportPath), "utf-8");
    expect(report).toContain("### 검수 1");
    expect(report).toContain("자동 수정을 적용했습니다.");
    expect(report).toContain("### 검수 2");
    expect(report).toContain("- 통과: 예");
  });
});
