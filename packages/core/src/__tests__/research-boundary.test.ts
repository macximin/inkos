import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuityAuditor } from "../agents/continuity.js";
import { runResearchReport } from "../agents/researcher.js";
import { readResearchProjectSettings } from "../utils/research-project-settings.js";

const tempRoots: string[] = [];
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("explicit research boundary", () => {
  it("uses Korean queries and a Korean report for a Korean project", async () => {
    const report = await runResearchReport({
      topic: "1997년 한국 반도체 장비 투자",
      purpose: "era",
      depth: "standard",
      language: "ko",
    }, {
      search: async () => [],
    });

    expect(report.queryLog).toEqual([
      "1997년 한국 반도체 장비 투자 시대 배경 제도 물가 생활상",
      "1997년 한국 반도체 장비 투자 자료 출처",
    ]);
    expect(report.queryLog.join("\n")).not.toMatch(/[\u3400-\u9fff]/u);
    expect(report.markdown).toContain("# 리서치: 1997년 한국 반도체 장비 투자");
    expect(report.markdown).toContain("## 미확인 사항");
    expect(report.markdown).not.toContain("## Unknowns");
  });

  it("reads language and search configuration together and fails closed", async () => {
    const configuredRoot = await makeTempRoot();
    await writeFile(join(configuredRoot, "inkos.json"), JSON.stringify({
      language: "ko",
      researchSearch: {
        enabled: true,
        provider: "tavily",
        apiKeyEnv: "TEST_TAVILY_KEY",
      },
    }), "utf-8");

    expect(await readResearchProjectSettings(configuredRoot)).toEqual({
      language: "ko",
      search: {
        enabled: true,
        provider: "tavily",
        apiKeyEnv: "TEST_TAVILY_KEY",
      },
    });

    const malformedRoot = await makeTempRoot();
    await writeFile(join(malformedRoot, "inkos.json"), "{broken", "utf-8");
    expect(await readResearchProjectSettings(malformedRoot)).toEqual({
      language: "zh",
      search: { enabled: false, provider: "tavily" },
    });
  });

  it("never starts live search from an era-enabled chapter audit", async () => {
    const root = await makeTempRoot();
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "audit-ko",
      title: "미래를 먼저 산 재벌 3세",
      genre: "chaebol-modern-fantasy-ko",
      platform: "other",
      chapterWordCount: 5000,
      targetChapters: 100,
      status: "active",
      language: "ko",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    }), "utf-8");

    const auditor = new ContinuityAuditor({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          maxTokensCap: null,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: root,
    });
    const chat = vi.spyOn(ContinuityAuditor.prototype as never, "chat" as never).mockResolvedValue({
      content: JSON.stringify({ passed: true, issues: [], summary: "문제없음" }),
      usage: ZERO_USAGE,
    } as never);
    const chatWithSearch = vi.spyOn(ContinuityAuditor.prototype as never, "chatWithSearch" as never);

    await auditor.auditChapter(bookDir, "주인공은 부도 직전 장비 회사를 먼저 찾아갔다.", 1, "chaebol-modern-fantasy-ko");

    expect(chat).toHaveBeenCalledOnce();
    expect(chatWithSearch).not.toHaveBeenCalled();
    const messages = chat.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
    expect(messages[0]?.content).toContain("실시간 웹 검색을 수행하지");
    expect(messages[0]?.content).toContain("허용된 가상 분기");
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inkos-research-boundary-"));
  tempRoots.push(root);
  return root;
}
