import { describe, expect, it } from "vitest";
import { getTranslationLanguageOptions } from "./TranslationManager";

describe("getTranslationLanguageOptions", () => {
  it("defaults Korean UI to auto-detect source and Korean target", () => {
    const options = getTranslationLanguageOptions("ko");
    expect(options.autoDetectLabel).toBe("자동 감지");
    expect(options.defaultTargetLanguage).toBe("한국어");
    expect(options.presets).toContain("중국어(간체)");
    expect(options.presets).not.toContain("Auto detect");
  });

  it("preserves Chinese and English defaults", () => {
    expect(getTranslationLanguageOptions("zh").defaultTargetLanguage).toBe("中文（简体）");
    expect(getTranslationLanguageOptions("en").defaultTargetLanguage).toBe("English");
  });
});
