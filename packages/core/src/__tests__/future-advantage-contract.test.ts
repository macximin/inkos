import { describe, expect, it } from "vitest";
import { ArcPacketSchema } from "../arc/schema.js";
import { parseBookRules } from "../models/book-rules.js";
import { ChapterIntentSchema } from "../models/input-governance.js";
import { resolveArcChapterContext } from "../arc/forecast.js";

describe("future-advantage contracts", () => {
  it("parses a Korean future-advantage section without changing legacy rules", () => {
    const legacy = parseBookRules("## 금지 사항\n- 대가를 취소하지 않는다.");
    const parsed = parseBookRules(`
## 미래 선점
- 회귀 기준 시점: 1996년 12월
- 핵심 재미: 20년 뒤의 승자를 먼저 알아보고 지금의 자원으로 당겨온다
- 허용 분야: 기술, 금융, 인재, 정책, 대중문화
- 알고 있는 것: 최종 승자, 큰 실패의 방향
- 모르는 것: 정확한 날짜, 현재 사람들의 선택
- 금지된 지름길: 설계도 완전 암기, 무제한 자금
- 기억 원칙: 역사가 바뀔수록 세부 기억의 신뢰도가 낮아진다
- 검색 정책: 핵심 주장 필수
`);

    expect(legacy?.rules.futureAdvantage).toBeUndefined();
    expect(parsed?.rules.futureAdvantage).toEqual({
      enabled: true,
      originMoment: "1996년 12월",
      corePromise: "20년 뒤의 승자를 먼저 알아보고 지금의 자원으로 당겨온다",
      allowedDomains: ["기술", "금융", "인재", "정책", "대중문화"],
      known: ["최종 승자", "큰 실패의 방향"],
      unknown: ["정확한 날짜", "현재 사람들의 선택"],
      forbiddenShortcuts: ["설계도 완전 암기", "무제한 자금"],
      memoryPolicy: "역사가 바뀔수록 세부 기억의 신뢰도가 낮아진다",
      researchPolicy: "required-for-hard-claims",
    });
  });

  it("accepts a domain-neutral future move and gates ready moves on bridge, proof, and reward", () => {
    const futureAdvantageMove = {
      moveId: "FA-001",
      mode: "recruit",
      domain: "인재",
      target: "훗날 반도체 공정의 병목을 푸는 엔지니어",
      rememberedOutcome: "그가 2007년에 양산 수율을 뒤집는다",
      baselineQuestions: ["1997년에 실제로 어디에서 일했는가"],
      researchClaimIds: ["RC-1997-SEMICON-01"],
      authorizedDivergences: ["1997년부터 공정 장비 투자를 앞당긴다"],
      bridgeSteps: ["부도 위기 연구소의 장비를 인수한다", "실패 책임을 대신 진다"],
      resistance: ["재벌가가 이름 없는 엔지니어 영입을 반대한다"],
      proof: "경쟁사가 포기한 웨이퍼에서 수율이 오른다",
      reward: "그룹이 탐내던 생산 라인을 먼저 확보한다",
      downstreamConsequences: ["기존 기억보다 반도체 투자 시계가 빨라진다"],
    } as const;
    const ready = makeArc({
      status: "ready",
      futureAdvantageMove,
    });

    expect(ArcPacketSchema.parse(ready).futureAdvantageMove?.domain).toBe("인재");
    const chapterContext = resolveArcChapterContext(ArcPacketSchema.parse(ready), 1);
    expect(chapterContext?.markdown).toContain("A-Rail bridge");
    expect(chapterContext?.markdown).toContain("B-Rail aftermath");
    expect(chapterContext?.markdown).toContain("RC-1997-SEMICON-01");
    expect(chapterContext?.markdown).toContain("Authorized divergences");
    expect(chapterContext?.provenance.futureAdvantageMove?.moveId).toBe("FA-001");
    expect(() => ArcPacketSchema.parse(makeArc({
      status: "ready",
      futureAdvantageMove: {
        ...futureAdvantageMove,
        bridgeSteps: [],
        proof: "",
        reward: "",
      },
    }))).toThrow(/bridge step|visible proof|reader reward/);
  });

  it("keeps new chapter-intent routing fields optional for old books", () => {
    const legacy = ChapterIntentSchema.parse({ chapter: 1, goal: "첫 거래를 성사시킨다" });
    const routed = ChapterIntentSchema.parse({
      chapter: 2,
      goal: "미래 지식을 현재 행동으로 바꾼다",
      futureAdvantageMoveIds: ["FA-001"],
      researchClaimIds: ["RC-1997-SEMICON-01"],
      authorizedDivergences: ["1997년부터 비메모리 장비 투자를 앞당긴다"],
    });

    expect(legacy.futureAdvantageMoveIds).toBeUndefined();
    expect(routed.authorizedDivergences).toEqual(["1997년부터 비메모리 장비 투자를 앞당긴다"]);
  });
});

function makeArc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "arc-future-001",
    bookId: "book-a",
    title: "먼저 알아본 사람",
    status: "draft",
    episodeCount: 1,
    chapterNumbers: [1],
    openingState: "외환 위기가 오기 전이다.",
    promise: "주인공은 미래의 승자를 현재로 당겨온다.",
    goal: "핵심 인재를 영입한다.",
    obstacle: "현재의 실적만 보는 임원들이 반대한다.",
    pressure: "경쟁사가 먼저 접촉한다.",
    turn: "주인공이 실패 책임을 떠안는다.",
    payoff: "영입과 첫 기술 증명이 동시에 끝난다.",
    irreversibleChange: "그룹의 투자 순서가 달라진다.",
    nextHook: "바뀐 역사에서 다음 기억은 그대로일까?",
    episodeBeats: [{ chapterNumber: 1, role: "payoff", beats: ["영입을 끝낸다"], endingHook: "투자 순서가 바뀐다" }],
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}
