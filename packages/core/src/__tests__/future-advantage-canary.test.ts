import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NarrativeForecastAgent } from "../forecast/agent.js";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { makeForecastBranch, makeFutureAdvantageMove } from "./helpers/forecast-fixture.js";

const CANARIES = [
  ["기술", "차세대 공정 장비"],
  ["금융", "외환위기 뒤 우량 채권"],
  ["경영", "현금흐름 중심 사업 재편"],
  ["유통", "전국 당일 배송망"],
  ["문화", "온라인 음원 유통권"],
  ["인재", "훗날 핵심 엔지니어"],
  ["정책", "예고된 산업 지원 제도"],
  ["복합", "기술·인재·금융을 묶은 생산 연합"],
] as const;

function response(content: string): LLMResponse {
  return { content, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
}

function modelJson(domain: string, target: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    branches: [1, 2].map((number) => {
      const { branchId: _branchId, ...branch } = makeForecastBranch({
        title: `${domain} 카나리 ${number}`,
        futureAdvantageMove: makeFutureAdvantageMove({
          moveId: `FA-CANARY-${domain}-${number}`,
          domain,
          target,
          authorizedDivergences: [`${target} 확보 시점을 실제 역사보다 앞당긴다`],
          memoryRisk: "주인공의 개입으로 경쟁자의 대응 시점과 기억 속 순서가 어긋난다",
          ...overrides,
        }),
      });
      return branch;
    }),
  });
}

function makeAgent(): NarrativeForecastAgent {
  return new NarrativeForecastAgent({
    client: { provider: "openai" } as never,
    model: "canary",
    projectRoot: "/tmp",
  });
}

function spyResponses(contents: ReadonlyArray<string>) {
  const spy = vi.spyOn(
    NarrativeForecastAgent.prototype as unknown as { chat: (messages: ReadonlyArray<LLMMessage>) => Promise<LLMResponse> },
    "chat",
  );
  for (const content of contents) spy.mockResolvedValueOnce(response(content));
  return spy;
}

const INPUT = {
  contextMarkdown: "# 정사 컨텍스트\n\n허용된 역사 분기는 작가 의도다.",
  divergence: "주인공이 미래의 승자를 지금 선점한다.",
  branchCount: 2,
  horizon: 3,
  baseChapter: 0,
  language: "ko" as const,
  futureAdvantageEnabled: true,
};

afterEach(() => vi.restoreAllMocks());

describe("Future Advantage P7 domain canaries", () => {
  it.each(CANARIES)("accepts an authorized early %s move with present execution, cost, and memory risk", async (domain, target) => {
    const spy = spyResponses([modelJson(domain, target)]);

    const output = await makeAgent().generateBranches(INPUT);

    expect(output.branches).toHaveLength(2);
    expect(output.branches.every((branch) => branch.futureAdvantageMove?.domain === domain)).toBe(true);
    expect(output.branches.every((branch) => branch.futureAdvantageMove?.authorizedDivergences[0]?.includes("실제 역사보다"))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects lossless prophecy until a concrete future-memory risk is supplied", async () => {
    const spy = spyResponses([
      modelJson("기술", "차세대 공정 장비", { memoryRisk: undefined }),
      modelJson("기술", "차세대 공정 장비"),
    ]);

    const output = await makeAgent().generateBranches(INPUT);

    expect(output.branches[0]?.futureAdvantageMove?.memoryRisk).toContain("기억 속 순서");
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[1]?.[0].at(-1)?.content ?? "")).toContain("memoryRisk");
  });

  it("rejects a remembered result that skips present-day implementation", async () => {
    const spy = spyResponses([
      modelJson("금융", "외환위기 뒤 우량 채권", { bridgeSteps: [] }),
      modelJson("금융", "외환위기 뒤 우량 채권"),
    ]);

    const output = await makeAgent().generateBranches(INPUT);

    expect(output.branches[0]?.futureAdvantageMove?.bridgeSteps.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[1]?.[0].at(-1)?.content ?? "")).toContain("bridgeSteps");
  });

  it("keeps all eight authorized early-history canaries creative-pass while routing verification to research", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-future-canary-audit-"));
    const bookDir = join(root, "book");
    const storyDir = join(bookDir, "story");
    await mkdir(storyDir, { recursive: true });
    await Promise.all([
      writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "canary", title: "카나리", language: "ko" }), "utf8"),
      ...["current_state", "pending_hooks", "chapter_summaries", "subplot_board", "emotional_arcs", "character_matrix", "volume_outline", "style_guide"]
        .map((name) => writeFile(join(storyDir, `${name}.md`), `# ${name}\n`, "utf8")),
    ]);
    const auditor = new ContinuityAuditor({
      client: { provider: "openai" } as never,
      model: "canary",
      projectRoot: root,
    });
    const chat = vi.spyOn(
      ContinuityAuditor.prototype as unknown as { chat: (messages: ReadonlyArray<LLMMessage>) => Promise<LLMResponse> },
      "chat",
    );
    for (const [domain] of CANARIES) {
      chat.mockResolvedValueOnce(response(JSON.stringify({
        passed: false,
        creative_passed: false,
        research_status: "conflict",
        issues: [{
          severity: "critical",
          track: "creative",
          category: "시대 고증",
          description: `${domain} 성취가 실제 역사보다 빠르다.`,
          suggestion: "실제 역사 시점으로 되돌린다.",
        }],
        summary: "실제 역사보다 빠름",
      })));
    }

    try {
      for (const [domain] of CANARIES) {
        const result = await auditor.auditChapter(
          bookDir,
          `${domain} 선점은 현재의 계약과 실행을 거쳐 성과를 냈다.`,
          1,
          "other",
          { arcContext: `## Future Advantage Move\n- Move: FA-${domain}\n- Authorized divergences: 실제 역사보다 앞당긴다` },
        );
        expect(result.creativePassed, domain).toBe(true);
        expect(result.passed, domain).toBe(true);
        expect(result.researchStatus, domain).toBe("needs-research");
        expect(result.issues[0], domain).toMatchObject({ track: "research", severity: "info" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
