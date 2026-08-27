import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../state/manager.js";
import { evaluateBookQuality } from "../utils/book-eval.js";

describe("evaluateBookQuality", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("computes a reusable quality report from a persisted book", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-book-eval-"));
    const state = new StateManager(root);
    const now = new Date().toISOString();
    const book = {
      id: "demo-book",
      title: "Demo Book",
      platform: "other" as const,
      genre: "other" as const,
      status: "active" as const,
      targetChapters: 10,
      chapterWordCount: 1200,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(book.id, book);
    await state.ensureControlDocuments(book.id);
    await state.saveChapterIndex(book.id, [
      { number: 1, title: "第一章", status: "approved", wordCount: 1200, auditIssues: [], lengthWarnings: [], createdAt: now, updatedAt: now },
      { number: 2, title: "第一章", status: "audit-failed", wordCount: 900, auditIssues: ["pov drift"], lengthWarnings: [], createdAt: now, updatedAt: now },
    ]);
    const bookDir = state.bookDir(book.id);
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_第一章.md"), "# 第一章\n\n他推开门，发现灯还亮着。", "utf-8");
    await writeFile(join(bookDir, "chapters", "0002_第一章.md"), "# 第一章\n\n她沉默。\n\n然后转身。", "utf-8");
    await writeFile(join(bookDir, "story", "pending_hooks.md"), "| 伏笔 | 状态 |\n| --- | --- |\n| 旧信 | 已回收 |\n", "utf-8");

    const report = await evaluateBookQuality({ state, bookId: book.id });

    expect(report).toMatchObject({
      bookId: "demo-book",
      totalChapters: 2,
      duplicateTitles: 1,
      hookResolveRate: 100,
    });
    expect(report.qualityScore).toBeGreaterThanOrEqual(0);
    expect(report.qualityTrend).toHaveLength(2);
    expect(report.chapters[1]).toMatchObject({
      number: 2,
      auditIssueCount: 1,
      status: "audit-failed",
    });
  });

  it("keeps informational Korean signals out of quality penalties", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-book-eval-ko-"));
    const state = new StateManager(root);
    const now = new Date().toISOString();
    const book = {
      id: "ko-demo-book",
      title: "계약의 주인",
      language: "ko" as const,
      platform: "other" as const,
      genre: "현대판타지 재벌물",
      status: "active" as const,
      targetChapters: 10,
      chapterWordCount: 5000,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(book.id, book);
    await state.ensureControlDocuments(book.id);
    await state.saveChapterIndex(book.id, [
      { number: 1, title: "계약의 주인", status: "approved", wordCount: 5000, auditIssues: [], lengthWarnings: [], createdAt: now, updatedAt: now },
    ]);
    const bookDir = state.bookDir(book.id);
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_계약의_주인.md"), [
      "승부는 돈이 아니라 권리였다.",
      "필요한 건 약속이 아니라 계약이었다.",
      "그가 원한 것은 칭찬이 아니라 지분이었다.",
      "상대가 내민 것은 사과가 아니라 담보였다.",
      "마지막에 남은 건 체면이 아니라 현금이었다.",
    ].join(" "), "utf-8");

    const report = await evaluateBookQuality({ state, bookId: book.id });

    expect(report.chapters[0]).toMatchObject({
      aiTellCount: 0,
      aiTellDensity: 0,
    });
  });

  it("uses the persisted Korean book language for quality evaluation", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-book-eval-ko-language-"));
    const state = new StateManager(root);
    const now = new Date().toISOString();
    const book = {
      id: "ko-language-book",
      title: "원고 검수",
      language: "ko" as const,
      platform: "other" as const,
      genre: "현대판타지 재벌물",
      status: "active" as const,
      targetChapters: 10,
      chapterWordCount: 5000,
      createdAt: now,
      updatedAt: now,
    };
    await state.saveBookConfig(book.id, book);
    await state.ensureControlDocuments(book.id);
    await state.saveChapterIndex(book.id, [
      { number: 1, title: "원고 검수", status: "approved", wordCount: 5000, auditIssues: [], lengthWarnings: [], createdAt: now, updatedAt: now },
    ]);
    const bookDir = state.bookDir(book.id);
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_원고_검수.md"), "요청하신 수정본입니다.\n\n남자는 계약서를 접었다.", "utf-8");

    const report = await evaluateBookQuality({ state, bookId: book.id });

    expect(report.chapters[0]!.aiTellCount).toBe(1);
    expect(report.chapters[0]!.aiTellDensity).toBeGreaterThan(0);
  });
});
