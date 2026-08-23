import { describe, expect, it } from "vitest";
import {
  memoryReliabilityLabel,
  productionReadinessStatusLabel,
  reviewModeLabel,
  reviewModeTitle,
  researchStatusLabel,
  worstReadinessStatus,
} from "./BookDetail";

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

  it("uses the strictest readiness state while keeping not-applicable explicit", () => {
    expect(worstReadinessStatus(["current", "pending"])).toBe("pending");
    expect(worstReadinessStatus(["current", "missing", "stale"])).toBe("stale");
    expect(productionReadinessStatusLabel("current")).toBe("준비됨");
    expect(productionReadinessStatusLabel("not-applicable")).toBe("해당 없음");
  });

  it("keeps the Korean book header free of Chinese review-mode copy", () => {
    expect(reviewModeLabel("auto")).toBe("검수: 자동");
    expect(reviewModeLabel("manual")).toBe("검수: 수동·집필 후 멈춤");
    expect(reviewModeTitle("auto")).not.toMatch(/[\u3400-\u9fff]/u);
    expect(reviewModeTitle("manual")).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
