import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../../../lib/app-language";
import { QuickActions } from "../QuickActions";

describe("QuickActions", () => {
  afterEach(() => setAppLanguage("zh"));

  it("renders the Korean action labels in the Korean UI", () => {
    setAppLanguage("ko");
    const html = renderToStaticMarkup(
      React.createElement(QuickActions, { onAction: vi.fn(), disabled: false }),
    );

    expect(html).toContain("다음 화 쓰기");
    expect(html).toContain("검수");
    expect(html).toContain("내보내기");
    expect(html).toContain("시장 레이더");
    expect(html).not.toContain("Write next");
  });
});
