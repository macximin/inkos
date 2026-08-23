import { describe, expect, it } from "vitest";
import {
  buildWritingMethodologySection,
  sanitizeLegacyFunFirstMethodology,
} from "../utils/writing-methodology.js";

describe("fun-first writing methodology", () => {
  it("allows clean closure and present-function quiet scenes in ko/zh/en", () => {
    const ko = buildWritingMethodologySection("ko");
    expect(ko).toContain("완전 수습·후과·자연스러운 다음 선택이나 압력");
    expect(ko).toContain("감정, 관계, 정보, 선택, 지급, 후과");
    expect(ko).not.toContain("다음 회차를 당기는 변화나 질문이 남는가");

    const zh = buildWritingMethodologySection("zh");
    expect(zh).toContain("不必把万物变成未来伏笔");
    expect(zh).toContain("是否为了造钩子扣住了已挣到的兑现");
    expect(zh).not.toContain("章尾是否留了钩子");

    const en = buildWritingMethodologySection("en");
    expect(en).toContain("planting a hook is not required");
    expect(en).toContain("without withholding an earned result");
    expect(en).not.toContain("Does the chapter end with a hook?");
  });

  it("neutralizes exact legacy boilerplate at prompt time without touching unrelated style guidance", () => {
    const legacy = [
      "# 사용자 문체",
      "- 문장을 짧게 쓴다.",
      "5. 회차 끝에 다음 회차를 당기는 변화나 질문이 남는가?",
      "6. 일상 장면도 복선, 관계, 대비 가운데 하나를 수행하는가?",
      "   - 主动欲望（期待感）：作者刻意制造的情绪缺口→读者期待释放→释放超过预期",
      "3. **日常必须为主线服务**：万物皆为\"饵\"。日常段要么埋伏笔，要么推关系，要么建立反差",
      "6. 章尾是否留了钩子？",
      "5. **Desire engine**: Create emotional gap → reader anticipates release → release exceeds expectation",
      "3. **Daily serves mainline**: Every quiet scene must plant a hook, advance a relationship, or build contrast.",
      "6. Does the chapter end with a hook?",
    ].join("\n");

    const sanitized = sanitizeLegacyFunFirstMethodology(legacy);
    expect(sanitized).toContain("# 사용자 문체");
    expect(sanitized).toContain("- 문장을 짧게 쓴다.");
    expect(sanitized).toContain("완전 수습·후과·자연스러운 다음 선택이나 압력");
    expect(sanitized).toContain("不必把万物变成未来伏笔");
    expect(sanitized).toContain("不得扣住已经挣到的结果");
    expect(sanitized).toContain("planting a hook is not required");
    expect(sanitized).toContain("never withhold an earned result");
    expect(sanitized).not.toContain("다음 회차를 당기는 변화나 질문이 남는가");
    expect(sanitized).not.toContain("章尾是否留了钩子");
    expect(sanitized).not.toContain("Does the chapter end with a hook?");
  });
});
