import { afterEach, describe, expect, it } from "vitest";
import { localizeKnownRuntimeMessage } from "./error-copy";
import { setAppLanguage } from "./app-language";

afterEach(() => setAppLanguage("zh"));

describe("localizeKnownRuntimeMessage", () => {
  it("localizes the state-degraded continuation blocker", () => {
    expect(localizeKnownRuntimeMessage(
      "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    )).toBe("最新第 1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。");
  });

  it("localizes related state repair errors while preserving unknown messages", () => {
    expect(localizeKnownRuntimeMessage("Chapter 3 is not state-degraded.")).toBe(
      "第 3 章不是状态降级（state-degraded），无需按状态修复。",
    );
    expect(localizeKnownRuntimeMessage(
      "Only the latest state-degraded chapter can be repaired safely (latest is 5).",
    )).toBe("只能安全修复最新的状态降级（state-degraded）章节；当前最新章是第 5 章。");
    expect(localizeKnownRuntimeMessage("Bad request")).toBe("Bad request");
  });

  it("localizes common LLM configuration errors", () => {
    const studioMessage = localizeKnownRuntimeMessage(
      "Studio LLM API key not set. Open Studio services and save an API key for the selected service.",
    );
    expect(studioMessage).toContain("Studio 模型 API Key 未设置");
    expect(studioMessage).not.toMatch(/kkaiapi/i);

    const cliMessage = localizeKnownRuntimeMessage(
      "INKOS_LLM_API_KEY not set. Run 'inkos config set-global' or add it to project .env file.",
    );
    expect(cliMessage).toContain("INKOS_LLM_API_KEY 未设置");
    expect(cliMessage).not.toMatch(/kkaiapi/i);
  });

  it("localizes restored write results and state errors in Korean mode", () => {
    setAppLanguage("ko");
    expect(localizeKnownRuntimeMessage(
      "Wrote chapter 1 \"다섯 시의 흰 종이\" for 한국어화-카나리: 900 words, but the review did not pass (status: state-degraded). Manual review is required before continuing.",
    )).toBe(
      "한국어화-카나리의 1화 집필을 마쳤습니다. 분량은 900자이며, 검수를 통과하지 못했습니다(상태: state-degraded). 계속하기 전에 사람이 확인해야 합니다.",
    );
    expect(localizeKnownRuntimeMessage(
      "Latest chapter 1 is state-degraded. Repair state or rewrite that chapter before continuing.",
    )).toBe(
      "최신 1화가 상태 저하(state-degraded)입니다. 다음 화를 쓰기 전에 상태를 복구하거나 해당 회차를 다시 써 주세요.",
    );
    expect(localizeKnownRuntimeMessage(
      "Translation export blocked: 2 chapter(s) have not passed review.",
    )).toBe("번역 내보내기가 차단되었습니다. 검수를 통과하지 못한 회차가 2개 있습니다.");
  });
});
