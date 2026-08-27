import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import * as llmProvider from "../llm/provider.js";
import { verifyFictionContentInvocationReceipts } from "../production/fiction-content-contract.js";

describe("PipelineRunner Book-bound utility completions", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("routes long style-guide analysis through BaseAgent contract evidence", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-style-contract-"));
    const state = new StateManager(root);
    const bookId = "style-book";
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Style Book",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 3000,
      language: "zh",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "# 文风指南\n\n## 节奏特征\n短句推动冲突。",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    });
    const runner = new PipelineRunner({
      client: { provider: "openai" } as never,
      model: "fake",
      projectRoot: root,
    });

    await runner.generateStyleGuide(
      bookId,
      "雨落在旧厂房的铁皮屋顶。主角没有回头。账本就在桌上。".repeat(30),
      "reference",
    );

    const audit = await verifyFictionContentInvocationReceipts(root, bookId);
    expect(audit.invocations).toEqual([
      expect.objectContaining({
        agentName: "style-analyzer",
        stage: "style-reference",
        status: "completed",
      }),
    ]);
  });
});
