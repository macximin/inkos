import { describe, expect, it } from "vitest";
import { formatModeLabel, getTuiCopy, normalizeStageLabel, resolveTuiLocale } from "../tui/i18n.js";

describe("tui i18n", () => {
  it("defaults to Chinese and supports explicit Korean and English overrides", () => {
    expect(resolveTuiLocale({})).toBe("zh-CN");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "ko-KR" })).toBe("ko");
    expect(resolveTuiLocale({ LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(resolveTuiLocale({ INKOS_TUI_LOCALE: "en" })).toBe("en");
    expect(resolveTuiLocale({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveTuiLocale({}, "en")).toBe("en");
  });

  it("normalizes common activity labels for Chinese chrome", () => {
    const copy = getTuiCopy("zh-CN");
    expect(normalizeStageLabel("writing chapter", copy)).toBe("写作中");
    expect(normalizeStageLabel("thinking ...", copy)).toBe("思考中");
    expect(normalizeStageLabel("idle", copy)).toBe("就绪");
    expect(normalizeStageLabel("waiting_human", copy)).toBe("等待你的决定");
    expect(normalizeStageLabel("completed", copy)).toBe("已完成");
    expect(formatModeLabel("semi", copy)).toBe("半自动");
    expect(formatModeLabel("auto", copy)).toBe("自动");
  });

  it("renders Korean TUI copy without Chinese fallback", () => {
    const copy = getTuiCopy("ko");
    expect(copy.labels.project).toBe("프로젝트");
    expect(copy.composer.emptyConversation).toContain("InkOS");
    expect(copy.activity.writing).toBe("작성 중");
    expect(normalizeStageLabel("waiting_human", copy)).toBe("사용자 결정 대기");
  });
});
