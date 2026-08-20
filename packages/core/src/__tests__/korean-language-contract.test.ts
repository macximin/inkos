import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectAgent } from "../agents/architect.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { buildObserverSystemPrompt } from "../agents/observer-prompts.js";
import { getPlannerMemoSystemPrompt } from "../agents/planner-prompts.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "../agents/settler-prompts.js";
import { parseCreativeOutput } from "../agents/writer-parser.js";
import { buildAgentSystemPrompt } from "../agent/agent-system-prompt.js";
import { CreateBookActionPayloadSchema } from "../interaction/action-envelope.js";
import { BookCreationDraftSchema } from "../interaction/session.js";
import { BookConfigSchema } from "../models/book.js";
import { ProjectConfigSchema } from "../models/project.js";
import { StateManifestSchema } from "../models/runtime-state.js";
import { renderForecastContextMarkdown } from "../forecast/context-builder.js";
import { buildForecastRepairPrompt, buildForecastSystemPrompt, buildForecastUserPrompt } from "../forecast/prompts.js";
import { renderChapterSummariesProjection, renderCurrentStateProjection, renderHooksProjection } from "../state/state-projections.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import { resolveEpubLanguage } from "../interaction/export-artifact.js";
import { buildStateDegradedIssues, buildStateValidationFeedback } from "../pipeline/chapter-state-recovery.js";
import { renderChapterHeading } from "../pipeline/runner.js";
import { parseCurrentStateFacts } from "../utils/story-markdown.js";
import { renderHookSnapshot } from "../utils/story-markdown.js";
import { parseBookRules } from "../models/book-rules.js";
import { normalizeHookPayoffTiming, normalizeStoredHookStatus } from "../utils/hook-lifecycle.js";
import { readGenreProfile } from "../agents/rules-reader.js";

describe("native Korean writing contracts", () => {
  it("routes Korean chaebol labels and unknown Hangul genres to Korean profiles", async () => {
    const chaebol = await readGenreProfile("/tmp/inkos-no-project-profile", "현대판타지 재벌물");
    const generic = await readGenreProfile("/tmp/inkos-no-project-profile", "법정 회귀 복수물");

    expect(chaebol.profile.id).toBe("chaebol-modern-fantasy-ko");
    expect(chaebol.profile.language).toBe("ko");
    expect(chaebol.profile.name).toBe("현대판타지 재벌물");
    expect(`${chaebol.profile.pacingRule}\n${chaebol.body}`).not.toMatch(/[\u3400-\u9fff]/u);
    expect(generic.profile.id).toBe("other-ko");
    expect(generic.profile.language).toBe("ko");
    expect(`${generic.profile.pacingRule}\n${generic.body}`).not.toMatch(/[\u3400-\u9fff]/u);
  });

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

  it("writes Korean foundation files without Chinese compatibility labels or role paths", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-ko-foundation-"));
    try {
      const architect = new ArchitectAgent({} as never);
      await architect.writeFoundationFiles(bookDir, {
        storyBible: "",
        volumeOutline: "",
        storyFrame: "# 이야기 틀\n\n한서진은 동네 서점을 지킨다.",
        volumeMap: "# 장거리 지도\n\n1화에서 첫 단서를 발견한다.",
        bookRules: "# 작품 규칙\n\n- 현실의 절차를 지킨다.",
        currentState: "",
        pendingHooks: "# 미회수 복선\n\n| 복선 | 상태 |\n| --- | --- |\n",
        roles: [
          { tier: "major", name: "한서진", content: "# 한서진\n\n폐업 직전의 서점주." },
          { tier: "minor", name: "유민아", content: "# 유민아\n\n단골 독자." },
        ],
      }, false, "ko");

      await expect(readdir(join(bookDir, "story", "roles")).then((entries) => entries.sort())).resolves.toEqual(["major", "minor"]);
      const generated = await Promise.all([
        "story_bible.md",
        "character_matrix.md",
        "current_state.md",
        "emotional_arcs.md",
      ].map((name) => readFile(join(bookDir, "story", name), "utf-8")));
      const rendered = generated.join("\n");

      expect(rendered).toContain("# 스토리 바이블");
      expect(rendered).toContain("roles/major/한서진.md");
      expect(rendered).toContain("# 현재 상태");
      expect(rendered).toContain("# 감정선");
      expect(rendered).not.toMatch(/[\u3400-\u9fff]/u);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("parses Korean current-state tables without treating headers as facts", () => {
    const facts = parseCurrentStateFacts(`
# 현재 상태

| 항목 | 값 |
| --- | --- |
| 현재 회차 | 1 |
| 현재 위치 | 해원정밀 회의실 |
| 현재 목표 | 전력 기록을 대조한다 |
`, 1);

    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.predicate)).toEqual(["현재 위치", "현재 목표"]);
    expect(facts.every((fact) => fact.subject === "protagonist")).toBe(true);
  });

  it("parses Korean human-readable book rules", () => {
    const parsed = parseBookRules(`
## 주인공
- 이름: 한서진
- 성격 고정점: 무심한 다정함, 관찰력
- 행동 제약: 타인의 선택을 대신하지 않는다, 예언을 협박에 쓰지 않는다

## 장르 고정
- 주 장르: 현대 판타지
- 금지 요소: 상태창, 손쉬운 기억 복구

## 서술 시점
3인칭

## 금지 사항
- 대가를 취소하지 않는다.
`);

    expect(parsed?.rules.protagonist?.name).toBe("한서진");
    expect(parsed?.rules.protagonist?.personalityLock).toEqual(["무심한 다정함", "관찰력"]);
    expect(parsed?.rules.genreLock?.primary).toBe("현대 판타지");
    expect(parsed?.rules.narrativePerson).toBe("third");
    expect(parsed?.rules.prohibitions).toEqual(["대가를 취소하지 않는다."]);
  });

  it("renders the hook ledger with Korean reader-facing headers", () => {
    const rendered = renderHookSnapshot([{
      hookId: "H001",
      startChapter: 0,
      type: "미래 문장",
      status: "deferred",
      lastAdvancedChapter: 0,
      expectedPayoff: "주문 취소를 막는다",
      payoffTiming: "near-term",
      notes: "초기 신호",
    }], "ko");

    expect(rendered).toContain("| hook_id | 시작 회차 | 유형 | 상태 |");
    expect(rendered).toContain("근시일");
    expect(rendered).not.toMatch(/[\u3400-\u9fff]/u);
    expect(normalizeHookPayoffTiming("근시일")).toBe("near-term");
    expect(normalizeHookPayoffTiming("최종부")).toBe("endgame");
    expect(normalizeStoredHookStatus("해결됨")).toBe("resolved");
    expect(normalizeStoredHookStatus("보류됨")).toBe("deferred");
    expect(normalizeStoredHookStatus("진행 중")).toBe("progressing");
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
    expect(prompt).toContain("공백 포함 5000자");
    expect(prompt).toContain("주인공의 행동, 상대의 대응");
    expect(prompt).not.toContain("Universal Writing Rules");
    expect(prompt).not.toContain("You are a professional");
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
    const settlerUser = buildSettlerUserPrompt({
      chapterNumber: 1,
      title: "첫 감사",
      content: "감사팀이 비자금 장부를 확보했다.",
      currentState: "감사팀이 본사에 있다.",
      ledger: "",
      hooks: "장부의 배후는 아직 드러나지 않았다.",
      chapterSummaries: "",
      subplotBoard: "",
      emotionalArcs: "",
      characterMatrix: "",
      volumeOutline: "승계 전쟁을 추적한다.",
      observations: "감사팀이 장부를 확보함",
      language: "ko",
    });

    expect(planner).toContain("당신은 한국 장르소설의 담당 편집자입니다");
    expect(planner).toContain("주인공의 행동, 상대의 대응, 독자가 확인할 보상");
    expect(planner).toContain("## 회차 목표");
    expect(planner).toContain("## 현재 작업");
    expect(planner).toContain("## 이번 화 훅 장부");
    expect(planner).toContain("- 회수:");
    expect(planner).toContain("- 계속 묻어두기:");
    expect(planner).not.toContain("- 지급:");
    expect(planner).not.toContain("## 本章目标");
    expect(planner).not.toContain("You are this novel's editor-in-chief");
    expect(observer).toContain("모든 관찰 결과를 자연스러운 한국어로 작성하세요");
    expect(observer).not.toMatch(/[\u3400-\u9fff]/u);
    expect(settler).toContain("모든 자연어 값은 자연스러운 한국어로 작성하세요");
    expect(settler).toContain('"hookActivity": "mentor-oath 진전"');
    expect(settler).not.toContain('"hookActivity": "mentor-oath advanced"');
    expect(`${settler}\n${settlerUser}`).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("parses Korean fallback headings and counts Korean characters", () => {
    const body = "감사팀의 불이 켜졌다. ".repeat(12);
    const parsed = parseCreativeOutput(7, `# 7화 사라진 장부\n\n${body}`, "ko_chars");

    expect(parsed.title).toBe("사라진 장부");
    expect(parsed.content).toBe(body.trim());
    expect(parsed.wordCount).toBe(body.trim().replace(/\r?\n/g, "").length);
  });

  it("renders Korean chapter headings for draft and revision persistence", () => {
    expect(renderChapterHeading("ko", 1, "사라진 장부")).toBe("# 1화 사라진 장부");
    expect(renderChapterHeading("en", 1, "Missing Ledger")).toBe("# Chapter 1: Missing Ledger");
    expect(renderChapterHeading("zh", 1, "失踪账本")).toBe("# 第1章 失踪账本");
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
      futureAdvantageEnabled: false,
      sections: {
        authorIntent: "재벌가 내부 감사를 파고든다.",
        currentFocus: "비자금 장부",
        currentState: "감사팀이 장부를 확보했다.",
        pendingHooks: "배후는 미확인",
        bookRules: "## 금지 사항\n- 우연한 해결 금지",
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

  it("builds Korean-native forecast prompts without Chinese fallback", () => {
    const system = buildForecastSystemPrompt("ko");
    const user = buildForecastUserPrompt({
      contextMarkdown: "# 정사 컨텍스트",
      divergence: "주인공이 장부를 공개한다.",
      branchCount: 3,
      horizon: 10,
      baseChapter: 12,
      futureAdvantageEnabled: false,
    }, "ko");
    const repair = buildForecastRepairPrompt("branches가 비었습니다.", "ko");
    const prompt = `${system}\n${user}\n${repair}`;

    expect(prompt).toContain("후보 분기를 정확히 3개");
    expect(prompt).toContain("13화부터 시작");
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it("keeps Korean recovery guidance and EPUB metadata Korean", () => {
    const feedback = buildStateValidationFeedback([], "ko");
    const issues = buildStateDegradedIssues([], "ko");

    expect(feedback).toContain("회차 본문과 모순");
    expect(issues[0]?.description).toContain("검증을 통과하지 못했습니다");
    expect(`${feedback}\n${JSON.stringify(issues)}`).not.toMatch(/[\u3400-\u9fff]/u);
    expect(resolveEpubLanguage("ko")).toBe("ko");
  });
});
