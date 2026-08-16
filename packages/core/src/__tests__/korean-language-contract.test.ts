import { describe, expect, it } from "vitest";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { buildObserverSystemPrompt } from "../agents/observer-prompts.js";
import { getPlannerMemoSystemPrompt } from "../agents/planner-prompts.js";
import { buildSettlerSystemPrompt } from "../agents/settler-prompts.js";
import { parseCreativeOutput } from "../agents/writer-parser.js";
import { buildAgentSystemPrompt } from "../agent/agent-system-prompt.js";
import { CreateBookActionPayloadSchema } from "../interaction/action-envelope.js";
import { BookCreationDraftSchema } from "../interaction/session.js";
import { BookConfigSchema } from "../models/book.js";
import { ProjectConfigSchema } from "../models/project.js";
import { StateManifestSchema } from "../models/runtime-state.js";
import { renderForecastContextMarkdown } from "../forecast/context-builder.js";
import { renderChapterSummariesProjection, renderCurrentStateProjection, renderHooksProjection } from "../state/state-projections.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

describe("native Korean writing contracts", () => {
  it("accepts ko across project, book, interaction, and runtime schemas", () => {
    const project = ProjectConfigSchema.parse({
      name: "한국어 프로젝트",
      version: "0.1.0",
      language: "ko",
      llm: {
        provider: "custom",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "test-model",
      },
    });
    const book = BookConfigSchema.parse({
      id: "korean-book",
      title: "감사의 밤",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 100,
      chapterWordCount: 5000,
      language: "ko",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    });

    expect(project.language).toBe("ko");
    expect(book.language).toBe("ko");
    expect(CreateBookActionPayloadSchema.parse({ language: "ko" }).language).toBe("ko");
    expect(BookCreationDraftSchema.parse({ concept: "재벌가 내부 감사", language: "ko" }).language).toBe("ko");
    expect(StateManifestSchema.parse({
      schemaVersion: 2,
      language: "ko",
      lastAppliedChapter: 0,
      projectionVersion: 1,
    }).language).toBe("ko");
  });

  it("renders Korean runtime truth projections without Chinese UI labels", () => {
    const hooks = renderHooksProjection({ hooks: [] }, "ko");
    const summaries = renderChapterSummariesProjection({ rows: [] }, "ko");
    const current = renderCurrentStateProjection({ chapter: 0, facts: [] }, "ko");
    const rendered = `${hooks}\n${summaries}\n${current}`;

    expect(rendered).toContain("# 미회수 복선");
    expect(rendered).toContain("# 회차 요약");
    expect(rendered).toContain("# 현재 상태");
    expect(rendered).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("builds a Korean writer route with Korean prose and character-count requirements", () => {
    const book = BookConfigSchema.parse({
      id: "korean-book",
      title: "감사의 밤",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 100,
      chapterWordCount: 5000,
      language: "ko",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    });
    const prompt = buildWriterSystemPrompt(
      book,
      {
        id: "urban",
        name: "urban",
        language: "ko",
        chapterTypes: ["일반 회차"],
        fatigueWords: [],
        numericalSystem: false,
        powerScaling: false,
        eraResearch: false,
        pacingRule: "",
        satisfactionTypes: [],
        auditDimensions: [],
      },
      null,
      "",
      "",
      "",
      undefined,
      1,
      "creative",
      undefined,
      "ko",
      "governed",
      buildLengthSpec(5000, "ko"),
    );

    expect(prompt).toContain("한국어 원고 출력 규칙");
    expect(prompt).toContain("공백을 포함한 5000자");
    expect(prompt).toContain("Korean characters including spaces");
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("routes planner, observer, and settlement outputs to Korean", () => {
    const book = BookConfigSchema.parse({
      id: "korean-book",
      title: "감사의 밤",
      platform: "other",
      genre: "urban",
      status: "active",
      targetChapters: 100,
      chapterWordCount: 5000,
      language: "ko",
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
    });
    const profile = {
      id: "urban",
      name: "현대 재벌물",
      language: "ko" as const,
      chapterTypes: ["일반 회차"],
      fatigueWords: [],
      numericalSystem: false,
      powerScaling: false,
      eraResearch: false,
      pacingRule: "",
      satisfactionTypes: [],
      auditDimensions: [],
    };

    const planner = getPlannerMemoSystemPrompt("ko");
    const observer = buildObserverSystemPrompt(book, profile, "ko");
    const settler = buildSettlerSystemPrompt(book, profile, null, "ko");

    expect(planner).toContain("모든 자연어를 한국어로 작성하세요");
    expect(observer).toContain("모든 관찰 결과를 자연스러운 한국어로 작성하세요");
    expect(observer).not.toMatch(/[\u3400-\u9fff]/u);
    expect(settler).toContain("모두 자연스러운 한국어로 작성하세요");
  });

  it("parses Korean fallback headings and counts Korean characters", () => {
    const body = "감사팀의 불이 켜졌다. ".repeat(12);
    const parsed = parseCreativeOutput(7, `# 7화 사라진 장부\n\n${body}`, "ko_chars");

    expect(parsed.title).toBe("사라진 장부");
    expect(parsed.content).toBe(body.trim());
    expect(parsed.wordCount).toBe(body.trim().replace(/\r?\n/g, "").length);
  });

  it("advertises the Korean 5000-character default in book creation", () => {
    const prompt = buildAgentSystemPrompt(null, "ko", "book-create");

    expect(prompt).toContain("회차당 공백 포함 5000자");
    expect(prompt).toContain("200/5000");
    expect(prompt).not.toContain("200/3000");
  });

  it("renders forecast context headings in Korean", () => {
    const markdown = renderForecastContextMarkdown({
      bookId: "감사의-밤",
      bookTitle: "감사의 밤",
      language: "ko",
      baseChapter: 12,
      contextFingerprint: "test",
      sections: {
        authorIntent: "재벌가 내부 감사를 파고든다.",
        currentFocus: "비자금 장부",
        currentState: "감사팀이 장부를 확보했다.",
        pendingHooks: "배후는 미확인",
        storyFrame: "승계 전쟁",
        volumeMap: "1권",
        recentChapterSummaries: "12화 요약",
        characterContext: "주인공과 감사팀",
        subplotBoard: "언론 대응",
        storyRails: "A-Rail / B-Rail",
      },
    });

    expect(markdown).toContain("# 정사 컨텍스트 (《감사의 밤》, 12화까지 집필 완료)");
    expect(markdown).toContain("## 작가 의도");
    expect(markdown).toContain("## A-Rail / B-Rail 장기 경로");
    expect(markdown).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
