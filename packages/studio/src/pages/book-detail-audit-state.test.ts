import { describe, expect, it } from "vitest";
import { memoryReliabilityLabel, researchStatusLabel } from "./BookDetail";

describe("BookDetail audit display labels", () => {
  it("keeps creative review and research status conceptually separate", () => {
    expect(researchStatusLabel("verified")).toBe("확인됨");
    expect(researchStatusLabel("needs-research")).toBe("확인 필요");
    expect(researchStatusLabel("conflict")).toBe("충돌");
    expect(researchStatusLabel("not-applicable")).toBe("해당 없음");
    expect(researchStatusLabel("not-checked")).toBe("미확인");
  });

  it("shows future-memory degradation without treating it as a generic failure", () => {
    expect(memoryReliabilityLabel("intact")).toBe("유지");
    expect(memoryReliabilityLabel("strained")).toBe("흔들림");
    expect(memoryReliabilityLabel("degraded")).toBe("열화");
    expect(memoryReliabilityLabel("unreliable")).toBe("불신 가능");
  });
});
