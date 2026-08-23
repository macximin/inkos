import { describe, expect, it } from "vitest";
import {
  buildShortFictionOutlineUserPrompt,
  buildShortFictionWriterSystemPrompt,
  buildShortFictionWriterUserPrompt,
} from "../prompts/short-fiction.js";

describe("short-fiction writer craft prompt", () => {
  const prompt = buildShortFictionWriterUserPrompt({
    direction: "悬疑短篇 旧书店失踪案 反转",
    outlineMarkdown: "## 大纲\n第1章 入局",
    chapterCount: 12,
    charsPerChapter: 1000,
  });

  it("tells the writer to play out the climax as a scene, not summarize it (B3)", () => {
    expect(prompt).toContain("高潮即场景");
    expect(prompt).toContain("不要梗概"); // already-present discipline still holds
  });

  it("restrains simile over-reliance (B2)", () => {
    expect(prompt).toContain("明喻节制");
  });

  it("allows the final chapter to complete its payoff without a forced next-read hook", () => {
    const outline = buildShortFictionOutlineUserPrompt({
      direction: "悬疑短篇 旧书店失踪案 反转",
      chapterCount: 12,
      charsPerChapter: 1000,
    });
    const writer = buildShortFictionWriterSystemPrompt();
    expect(outline).toContain("最终章必须落下承诺回报，可以完整收束");
    expect(writer).toContain("最终章必须完成故事，可以完整收束");
    expect(writer).toContain("不能扣住已经挣到的回报来强造续读");
    expect(writer).not.toContain("每章都要有当场发生的戏：人物行动、对话或反应、局面变化、章尾继续读的理由");
  });
});
