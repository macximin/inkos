import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { ArchitectAgent } from "../agents/architect.js";
import { getPlannerMemoSystemPrompt } from "../agents/planner-prompts.js";
import { buildWriterSystemPrompt } from "../agents/writer-prompts.js";
import { buildForecastSystemPrompt } from "../forecast/prompts.js";
import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { FireflyEntryContractSchema, hashEntryContract } from "../planning/entry-contract.js";
import { renderEntryPlan, webnovelPlanGuidance, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION, PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2 } from "../planning/webnovel-plan-format.js";
import { sourceFactRepairHash } from "../planning/source-fact-repair.js";

const book: BookConfig = {
  id: "plan-format-test", title: "내 가게에서 번 돈", genre: "modern-fantasy-ko",
  platform: "other", language: "ko", status: "active", targetChapters: 100,
  chapterWordCount: 5000, createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
};
const profile: GenreProfile = {
  id: "other", name: "현대판타지", language: "ko", chapterTypes: [], fatigueWords: [],
  numericalSystem: false, powerScaling: false, eraResearch: false,
  pacingRule: "", satisfactionTypes: [], auditDimensions: [],
};

// Handwritten transport fixtures only: these do not prove a model's interpretation.
const sourceBriefs = [
  { name: "existing source brief", brief: "박수진은 1998년 인천 창고에서 재고를 골라 판다. 번 돈으로 눈치 보지 않고 쉰다." },
  { name: "prosperous present-day protagonist", brief: "합성 사례의 민서는 안정된 수입과 자기 가게를 갖고 있다. 수리 일을 배우며 쌓은 안목으로 중고 설비를 골라 고친다. 목적은 일을 빨리 끝내고 자기 주말을 누리는 것이다. 회귀나 상실은 이 설정에 해당 없음이다." },
  { name: "distinct limits of source knowledge", brief: "합성 사례의 유나는 지금 자기 배와 항로 지도를 갖고 있다. 원문이 감춘 고향은 미공개다. 제공된 발췌만으로 항해 경력은 제공 범위 미확인이다. 회귀는 이 설정에 해당 없음이다. 가까운 항구로 가는 현재 목적은 자기 배의 연료비를 아끼는 것이다." },
];

function expectOriginGuidance(prompt: string): void {
  expect(prompt).toContain("출발 배경·이전 경험·현재 자원과 관계 → 개인 목적 → 선택·우위 사용");
  for (const status of ["미공개", "제공 범위 미확인", "해당 없음"]) expect(prompt).toContain(status);
  expect(prompt).toContain("일부 발췌에 없다는 이유만으로");
  expect(prompt).toContain("현재형의 유복한 인물도");
  expect(prompt).toContain("회귀·결핍·트라우마·새 능력 보완·실패를 필수 출발점으로 강요하지 않습니다");
}

describe("webnovel plan format transport", () => {
  it("freezes bounded guidance v1 independently of current general planning prose", () => {
    const stages = ["variation", "variation-review", "variation-revision"] as const;
    expect(stages.map((stage) => sourceFactRepairHash(webnovelPlanGuidance(stage, PITCH_VARIATION_PLANNING_GUIDANCE_V1)))).toEqual([
      "465b4881f79b9e3396af8cc5d37a5d0aee4744932219c4a9529d98e5db8234f1",
      "fc6e44708428a114035520cc07ff177e3300aaded374cf6c69e22fd5347d5369",
      "0416d52a7b0266796492a17dceb140f195fc8be850141c1d2fa09811aea4e1de",
    ]);
    const invoke = webnovelPlanGuidance as (stage: string, version?: string) => string;
    for (const stage of stages) {
      expect(() => invoke(stage)).toThrow("missing");
      expect(() => invoke(stage, "webnovel-bounded-variation/v4")).toThrow("Unsupported");
    }
    expect(() => invoke("pitch", PITCH_VARIATION_PLANNING_GUIDANCE_VERSION)).toThrow("does not apply");
  });
  it("preserves all frozen v2 stage bytes while adding reference-led guidance to new requests", () => {
    const stages = ["variation", "variation-review", "variation-revision"] as const;
    expect(stages.map((stage) => sourceFactRepairHash(webnovelPlanGuidance(stage, PITCH_VARIATION_PLANNING_GUIDANCE_V2)))).toEqual([
      "390b07f453488946a481812b45c51948923f42be2e38b4ec03809ea3190d8a30",
      "989a200db1bab66c2979cd1343938cd23b3b4d2b2afd68a93014ca0aa7cc32e5",
      "f7edabd5bee77914e6f5beb899b9cab8716f88d1a5902d3731965cab9cc5fa39",
    ]);
    for (const prompt of [webnovelPlanGuidance("pitch"), webnovelPlanGuidance("review"), webnovelPlanGuidance("foundation"),
      ...stages.map((stage) => webnovelPlanGuidance(stage, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION))]) {
      expect(prompt).toContain("차별점을 기획 항목이나 장점·심사 기준으로 요구하지 않습니다");
      expect(prompt).toContain("어떤 작품들을 참고했고");
      expect(prompt).toContain("시놉시스·분석 자료를 읽은 상태, 원고를 직접 읽은 상태");
      expect(prompt).toContain("주인공을 계속 보고 싶은 이유");
      expect(prompt).toContain("최초 욕망이 어떻게 충족되거나");
      expect(prompt).toContain("선택 항목이나 표의 부재를 새 자동 탈락 조건으로 만들지 않습니다");
    }
  });
  it.each(sourceBriefs)("sends $name through Architect while retaining five sections", async ({ brief }) => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, maxTokensCap: null, extra: {} },
      },
      model: "test", projectRoot: process.cwd(),
    });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockRejectedValue(new Error("captured-before-generation"));
    try {
      await expect(agent.generateFoundation(book, brief)).rejects.toThrow("captured-before-generation");
      const messages = chat.mock.calls[0]![0] as Array<{ content: string }>;
      const prompt = messages[0]!.content;
      expect(prompt).toContain(brief);
      expect(prompt).toContain("작품 기획서 v1 · foundation");
      expectOriginGuidance(prompt);
      expect([...prompt.matchAll(/^=== SECTION: ([a-z_]+) ===$/gm)].map((match) => match[1]))
        .toEqual(["story_frame", "volume_map", "roles", "book_rules", "pending_hooks"]);
      expect(prompt).not.toContain("결과 세 개");
    } finally { chat.mockRestore(); }
  });

  it("specializes Arc, memo, and manuscript instructions without adding output sections", () => {
    const arc = buildForecastSystemPrompt("ko");
    const memo = getPlannerMemoSystemPrompt("ko");
    const writer = buildWriterSystemPrompt(book, profile, null, "", "", "", undefined, 8, "creative", undefined, "ko", "governed");
    expect(arc).toContain("작품 기획서 v1 · arc");
    expect(arc).toContain("1~3화 실행 ArcPacket");
    expect(memo).toContain("작품 기획서 v1 · chapter");
    expect(memo).toContain("## 현재 작업");
    expect(memo).toContain("## 이번 화 훅 장부");
    expect(writer).toContain("작품 기획서 v1 · manuscript");
    expect(writer).toContain("기획서 표, 검수표나 이 지침을 출력하지 않습니다");
    for (const prompt of [arc, memo, writer]) {
      expectOriginGuidance(prompt);
      expect(prompt).toContain("상위 답을 반복 복사하지 말고");
      expect(prompt).toContain("가짜 시한이나 위기를 만들지 않습니다");
      expect(prompt).toContain("현재 사건에 쓰이는 배경·경험·자원과 선택의 연결만 가져오고 인물의 생애를 매번 재설명하지 않습니다");
    }
    // Korean adaptation must not leak into the unchanged upstream languages.
    for (const language of ["zh", "en"] as const) {
      expect(buildForecastSystemPrompt(language)).not.toContain("작품 기획서 v1");
      expect(getPlannerMemoSystemPrompt(language)).not.toContain("작품 기획서 v1");
      expect(buildWriterSystemPrompt(book, profile, null, "", "", "", undefined, 8, "creative", undefined, language))
        .not.toContain("작품 기획서 v1");
    }
  });

  it("routes source rationale and authorized variation through existing pitch and review text", () => {
    const pitch = webnovelPlanGuidance("pitch");
    const review = webnovelPlanGuidance("review");
    for (const prompt of [pitch, review]) expectOriginGuidance(prompt);
    for (const existingField of ["protagonist.startingIdentity", "sourceReconstruction.protagonist", "sourceChoice", "targetChoice/preservedReason", "projectPlan"]) {
      expect(pitch).toContain(existingField);
    }
    expect(pitch).toContain("보조작의 경력·능력을 주인공의 원래 과거로 가져오지 않습니다");
    expect(pitch).toContain("별도 JSON 키를 요구하지 않습니다");
    expect(review).toContain("원작 사실과 승인된 신작 변주를 구별");
    expect(review).toContain("미공개·제공 범위 미확인·해당 없음 자체는 실패가 아니며");
  });

  it("preserves stated source limits and entry bytes in the read-only plan projection", () => {
    const protagonist = sourceBriefs[2]!.brief;
    const entry = FireflyEntryContractSchema.parse({
      humanDrive: {
        lackOrHumiliation: "자기 배와 지도는 보유 중이며 확인된 손실은 없다.",
        personalDesire: "자기 배의 연료비를 아끼고 싶다.", selfInterest: "남은 돈으로 자기 항해를 오래 즐긴다.",
        emotionalCostLimit: "남의 칭찬을 받기 위한 손해는 택하지 않는다.",
      },
      purpose: {
        seriesWhat: "자기 배로 원하는 항구를 다닌다.", arcWhat: "가까운 항구에서 자기 연료를 마련한다.",
        chapterWant: "현재 지도에 표시된 가까운 항구를 고른다.", whyNow: "출항할 연료와 지도가 지금 있다.",
      },
      commercialPromise: {
        currentSituation: "자기 배와 지도를 갖고 출항을 준비 중이다.",
        repeatableReaderFantasy: "자기 자원으로 항로를 고르고 여유를 누린다.",
        howAdvantage: "보유한 지도에서 가까운 항구의 거리를 비교한다.",
        firstPayoff: "가까운 항구에 도착해 남은 연료를 확인한다.",
        payoffWitness: "남은 연료로 다음 행선지를 혼자 고른다.",
        nextPaymentQuestion: "남은 연료로 어느 항구까지 갈 수 있는가.",
      },
    });
    const snapshot = structuredClone(entry);
    const hash = hashEntryContract(entry);
    const projection = renderEntryPlan(entry, protagonist);
    expect(projection).toContain(protagonist);
    for (const group of Object.values(entry)) {
      for (const value of Object.values(group)) expect(projection).toContain(value);
    }
    expect(projection).toContain("출발 조건·확인된 손실");
    expect(entry).toEqual(snapshot);
    expect(hashEntryContract(entry)).toBe(hash);
  });

  it("ships the same source-rationale scope in both native skills and their rubrics", async () => {
    const skillFiles = [
      "inkos-commercial-webnovel-pitch/SKILL.md",
      "inkos-commercial-webnovel-pitch/references/pitch-vitality-rubric.md",
      "inkos-commercial-pitch-review/SKILL.md",
      "inkos-commercial-pitch-review/references/survival-rubric.md",
    ];
    const contents = await Promise.all(skillFiles.map((path) => readFile(new URL(`../../skills/${path}`, import.meta.url), "utf8")));
    for (const content of contents) {
      expect(content).toContain("출발 배경·이전 경험·현재 자원과 관계 → 개인 목적 → 선택·우위 사용");
      for (const marker of ["미공개", "제공 범위 미확인", "해당 없음", "현재형의 유복한 인물", "sourceReconstruction.protagonist", "targetChoice/preservedReason"]) {
        expect(content).toContain(marker);
      }
      expect(content).toContain("생애");
    }
    expect(contents[0]).not.toContain("주인공이 무엇을 빼앗겼고");
    expect(contents[0]).not.toContain("결핍 노출, 기회 포착");
    expect(contents[1]).not.toContain("구체적 결핍·모욕·상실과");
  });
});
