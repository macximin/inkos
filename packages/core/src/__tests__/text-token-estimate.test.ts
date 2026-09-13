import { describe, expect, it } from "vitest";
import { estimateTextTokens } from "../llm/provider.js";
import { availableAuthorCraftTokens, selectAuthorCraftContext } from "../reference/author-craft.js";

describe("text token budget estimates", () => {
  it("keeps Latin and basic Han behavior while recognizing Hangul, kana, and supplementary Han", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcdefgh")).toBe(2);
    expect(estimateTextTokens("中文汉字")).toBe(4);
    expect(estimateTextTokens("주인공선택")).toBe(5);
    expect(estimateTextTokens("ひらがなカタカナ")).toBe(8);
    expect(estimateTextTokens("𠀀𠀁")).toBe(2);
    expect(estimateTextTokens("한ㄱ")).toBe(4);
    expect(estimateTextTokens("선택abcd中文")).toBe(5);
  });

  it("reserves a long Korean base prompt before adding optional craft references", () => {
    const remaining = availableAuthorCraftTokens({ contextWindow: 1200, outputTokens: 100, reservedText: "가".repeat(1000) });
    expect(remaining).toBe(0);
    const pack = {
      schemaVersion: "author-craft-pack/v1" as const, id: "test", language: "ko" as const, authority: "advisory" as const,
      sources: [{ id: "s", title: "시험", reference: "fixture", readingScope: "fixture only", kind: "research-summary" as const }],
      cases: [{ id: "choice", title: "선택", stages: ["writing" as const], functions: ["choice"], triggers: ["선택"],
        observation: "관찰", method: "선택의 이유를 남긴다.", preserve: [], counterexamples: ["항상 내면을 늘리지 않는다."], sourceIds: ["s"] }],
    };
    const selected = selectAuthorCraftContext({ pack, config: { packSha256: "a".repeat(64), maxCases: 3, maxCharacters: 6000 }, stage: "writing", query: "선택", maxContextTokens: remaining });
    expect(selected.rendered).toBe("");
    expect(selected.receipt.omittedCaseIds).toEqual(["choice"]);
  });
});
