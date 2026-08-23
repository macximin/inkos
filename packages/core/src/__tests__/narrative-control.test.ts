import { describe, expect, it } from "vitest";
import { renderMemoAsNarrativeBlock } from "../utils/narrative-control.js";

const GOLDEN_MEMO = {
  chapter: 1,
  goal: "Make the first concrete choice visible.",
  isGoldenOpening: true,
  body: "## Current task\nComplete the first negotiation.",
  threadRefs: [],
};

describe("renderMemoAsNarrativeBlock", () => {
  it("defines golden openings by visible conflict, choice, and payoff rather than hook density", () => {
    const zh = renderMemoAsNarrativeBlock(GOLDEN_MEMO, undefined, "zh");
    expect(zh).toContain("核心冲突、主角选择和具体兑现可见");
    expect(zh).toContain("不增加钩子密度");
    expect(zh).not.toContain("优先钩子密集");

    const ko = renderMemoAsNarrativeBlock(GOLDEN_MEMO, undefined, "ko");
    expect(ko).toContain("핵심 갈등, 주인공의 선택, 구체적 지급");
    expect(ko).toContain("복선 밀도를 늘리거나 이미 얻은 결과를 감추지 않습니다");
    expect(ko).not.toContain("복선 밀도와 빠른 전개를 우선");

    const en = renderMemoAsNarrativeBlock(GOLDEN_MEMO, undefined, "en");
    expect(en).toContain("core conflict, protagonist choice, and concrete payoff visible first");
    expect(en).toContain("do not increase hook density or withhold an earned result");
    expect(en).not.toContain("prioritize hook-dense");
  });
});
