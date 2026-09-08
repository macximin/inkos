import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFactRepairHash, PitchVariationCandidateSchema, PitchVariationRequestSchema, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION, PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2, webnovelPlanGuidance, renderPitchVariation } from "@actalk/inkos-core";
import { variationProjectPlanFixture } from "../../../core/dist/__tests__/fixtures/variation-project-plan-fixture.js";
import { preparePitchVariation, generatePitchVariations, sourceLineExcerpt, variationCandidatePrompt, variationReviewPrompt, variationRevisionPrompt } from "../commands/pitch-variation.js";

describe("variation preparation", () => {
  it("extracts complete UTF-8/CRLF lines and rejects coordinates beyond the original", () => {
    const bytes = Buffer.from("첫 행\r\n둘째 행\r\n끝");
    expect(sourceLineExcerpt(bytes, 2, 3)).toBe("둘째 행\r\n끝");
    expect(() => sourceLineExcerpt(bytes, 2, 4)).toThrow("outside");
    expect(() => sourceLineExcerpt(Buffer.from([0xff]), 1, 1)).toThrow();
  });
  it("binds exact originals and keeps producer scores and long-plan duplication out of the request", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-variation-test-"));
    try {
      const sourcePath = join(root, "source.txt");
      const source = "실제 사건의 시작\n선택과 결산\n";
      await writeFile(sourcePath, source);
      const baseline = { candidateId: "p01", titleCandidates: ["기준 기획"], commercialScore: { total: 92 }, decision: "pending", projectPlan: variationProjectPlanFixture, oneLinePromise: "자기 이득을 얻는다", protagonist: { startingIdentity: "재벌 3세" }, entryContract: { purpose: "자기 회사" }, openingEpisodes: [{ episode: 1, event: "기준 사건" }], firstReward: "자기 몫", railB: [] };
      await writeFile(join(root, "baseline.json"), JSON.stringify(baseline));
      const event = { workTitle: "합성 원문", sourcePath, sourceSha256: sourceFactRepairHash(source), startLine: 1, endLine: 2, chapterRange: "1화", actualEvent: "선택과 결산", privateGoal: "자기 이익", interventionReason: "기회", advantageUse: "정보", personalGain: "수익", readerPleasure: "선택과 반응", nextGoal: "확장", prerequisites: "돈과 인재", transferUse: "사건", doNotTransfer: "별개 능력" };
      await writeFile(join(root, "events.json"), JSON.stringify({ events: [{ ...event, eventId: "main-1", role: "main" }, { ...event, eventId: "donor-1", role: "donor" }, { ...event, eventId: "donor-2", role: "donor", actualEvent: "둘째 후보 전용 실제 사건" }] }));
      await writeFile(join(root, "spec.json"), JSON.stringify({ slateId: "new-variation", baselinePath: "baseline.json", baselineSlateId: "old-baseline", eventsPath: "events.json", scope: { episodeStart: 1, episodeEnd: 4, through: "첫 회수" }, instruction: "사건을 바꾼다", directions: ["첫 방향", "둘째 방향"], directionSourceEventIds: [["main-1", "donor-1"], ["main-1", "donor-2"]] }));
      const result = await preparePitchVariation({ projectRoot: root, specPath: "spec.json", outputDir: "prepared" });
      const request = JSON.parse(await readFile(join(root, "prepared", "request.json"), "utf8"));
      expect(request.planningGuidanceVersion).toBe(PITCH_VARIATION_PLANNING_GUIDANCE_VERSION);
      expect(request.baselineProjectPlan).toEqual(baseline.projectPlan);
      expect(result.bytes.baseline).toBeGreaterThan(0);
      expect(request.baseline.planSha256).toBe(sourceFactRepairHash(baseline.projectPlan.markdown));
      expect(request.sources[0].excerpt).toBe(source);
      expect(variationCandidatePrompt(request, 0)).not.toContain("92점");
      expect(variationCandidatePrompt(request, 0)).not.toContain("둘째 후보 전용 실제 사건");
      expect(variationCandidatePrompt(request, 1)).toContain("둘째 후보 전용 실제 사건");
      expect(request.sources).toHaveLength(3);
      for (const prompt of [variationCandidatePrompt(request, 0), variationReviewPrompt(request, [])]) {
        expect(prompt).toContain("baselineContext와 원문에서 확인한 배경→자기 목적→행동·수단의 연결");
        expect(prompt).toContain("보조 작품 인물의 과거 경력을 주인공에게 자동 이식하지 않는다");
        expect(prompt).not.toContain("원작의 사람 판독 능력과 전생의 지식·소비 안목");
      }
      expect(request.baselineContext).not.toContain("commercialScore");
      expect(await readFile(join(root, "baseline.json"), "utf8")).toBe(JSON.stringify(baseline));
      await writeFile(join(root, "prepared", "v01-receipt.json"), "{}");
      await expect(generatePitchVariations(root, join(root, "prepared"))).rejects.toThrow("Partial v01 artifacts");
      await writeFile(sourcePath, "바뀐 원문");
      await expect(preparePitchVariation({ projectRoot: root, specPath: "spec.json", outputDir: "stale" })).rejects.toThrow("Source changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Fixed, schema-valid inputs make these hashes independent of temp paths.
// Captured before introducing versioned guidance; changing the fixture also
// requires checking existing immutable model receipts, not refreshing hashes.
function legacyPromptFixture() {
  const event = { workTitle: "합성 원작", sourcePath: "/fixture/source.txt", sourceSha256: "a".repeat(64), startLine: 1, endLine: 1, chapterRange: "1화", actualEvent: "선택과 결산", privateGoal: "자기 이익", interventionReason: "기회", advantageUse: "기억", personalGain: "수익", readerPleasure: "행동과 반응", nextGoal: "사업", prerequisites: "자금", transferUse: "사건", doNotTransfer: "별개 능력" };
  const request = PitchVariationRequestSchema.parse({ schemaVersion: "pitch-variation-request/v1", slateId: "guidance-fixture",
    baseline: { slateId: "base", candidateId: "p01", candidateSha256: "b".repeat(64), planSha256: "c".repeat(64), title: "기준 기획" }, baselinePath: "/fixture/p01.json", baselineContext: "기존 전체 기획의 주인공과 장기 목적",
    scope: { episodeStart: 1, episodeEnd: 4, through: "첫 투자 회수" }, genre: "modern-fantasy-ko", targetChapters: 751,
    instruction: "자기 이익을 보존하는 사건 변주", directions: ["첫 방향", "둘째 방향"],
    sources: [{ ...event, eventId: "main-1", role: "main" }, { ...event, eventId: "donor-1", role: "donor" }].map((event) => ({ event, excerpt: "선택과 결산\n", excerptSha256: sourceFactRepairHash("선택과 결산\n") })) });
  const candidate = PitchVariationCandidateSchema.parse({ candidateId: "v01", title: "기준 후보", variationIntent: "변주 의도", sourceEventIds: ["main-1", "donor-1"], synopsis: "출발 배경과 자기 목적이 행동과 이익을 설명하는 합성 후보이다. ".repeat(15),
    eventComparisons: ["개입", "투자"].map((baselineEvent) => ({ baselineEvent, retainedFunction: { personalGoal: "자기 목적", interventionReason: "기회", advantageUse: "기억", personalGain: "자기 수익", readerPleasure: "선택과 반응", nextGoal: "자기 회사" }, donorEventIds: ["donor-1"], redesignedEvent: "상대를 만난다", prerequisiteChanges: "실행 시점", downstreamConnection: "다음 투자" })),
    openingEpisodes: [1, 2, 3, 4].map((episode) => ({ episode, goal: "자기 이익", action: "실행", gainOrProgress: "수익", endingPull: "다음 선택" })),
    firstInvestment: { item: "회사", informationEdge: "기억", capitalAndExecution: "기존 자금", sequence: "매수 후 매도", realizedReturn: "20억", nextUse: "자기 사업" }, chronologyChanges: "실행 순서", remainingQuestions: "읽는 맛" });
  const context = { candidateId: "v01", instruction: "인재를 먼저 확보한다.", allowedPaths: ["/openingEpisodes/0/action"] };
  return { request, candidate, context };
}

describe("version-bound variation planning guidance", () => {
  it("reproduces all four legacy prompt byte hashes without appending even an empty guidance line", () => {
    const { request, candidate, context } = legacyPromptFixture();
    expect([
      variationCandidatePrompt(request, 0), variationReviewPrompt(request, [candidate]),
      variationRevisionPrompt(request, candidate, context.instruction, context.allowedPaths), variationReviewPrompt(request, [candidate], context),
    ].map(sourceFactRepairHash)).toEqual([
      "b109c0470bf9a9b806e5eb141f9a1e20c96f47cdbd9c4c0b2e424a6f182ff0de",
      "e92aca385f2aba17ac11babd9f74ff2b54058ab8d90d7ef902193d872e67716a",
      "322646886cfaaad33ef2d9516789bdc427fd4a07c26335fbca2dba2ead905f84",
      "3372a55bc24f47750a8afb16c0a03f1836418f89a8a4a59f0078117ed48608ee",
    ]);
  });

  it("propagates only the explicitly pinned bounded guidance to generation, review, and patch revision", () => {
    const fixture = legacyPromptFixture(); const { candidate, context } = fixture;
    const request = PitchVariationRequestSchema.parse({ ...fixture.request, planningGuidanceVersion: PITCH_VARIATION_PLANNING_GUIDANCE_V1 });
    const prompts = [
      ["variation", variationCandidatePrompt(request, 0)],
      ["variation-review", variationReviewPrompt(request, [candidate])],
      ["variation-revision", variationRevisionPrompt(request, candidate, context.instruction, context.allowedPaths)],
      ["variation-review", variationReviewPrompt(request, [candidate], context)],
    ] as const;
    for (const [stage, prompt] of prompts) {
      expect(prompt).toContain(webnovelPlanGuidance(stage, PITCH_VARIATION_PLANNING_GUIDANCE_V1));
      for (const marker of ["누가(WHO)", "왜(WHY)", "무엇을(WHAT)", "어디(WHERE)", "언제(WHEN)", "어떻게(HOW)", "전체 기획의 장기 목적 → 이번 구간의 자기 목적", "전체 9절 기획서를 다시 만들거나", "통합 완료를 가정하지 않습니다"]) expect(prompt).toContain(marker);
      expect(prompt).not.toContain("## 작품 기획서 v1 · pitch");
    }
    expect(prompts[0][1]).toContain("eventComparisons.prerequisiteChanges");
    expect(prompts[2][1]).toContain("이 지침은 수정 범위를 넓히지 않으며");
    expect(prompts[2][1]).toContain('"changes":[{"path":"/openingEpisodes/0/action"');
  });
  it("preserves all v1 prompt hashes and legacy/v1 readable bytes", () => {
    const { request: legacy, candidate, context } = legacyPromptFixture();
    const request = PitchVariationRequestSchema.parse({ ...legacy, planningGuidanceVersion: PITCH_VARIATION_PLANNING_GUIDANCE_V1 });
    expect([variationCandidatePrompt(request, 0), variationReviewPrompt(request, [candidate]),
      variationRevisionPrompt(request, candidate, context.instruction, context.allowedPaths), variationReviewPrompt(request, [candidate], context)].map(sourceFactRepairHash)).toEqual([
      "e59452d32072efb573bc378e4021484920bc3da523118faf79c7586ac34b6c8c", "1d68f0d2c24f8490aa46f597e0c2be805e398432be1e389fe0ed4e34812cb9c1",
      "d9851856d1372cfb35b3739e02b4d66e1a627b12c8e4bc7d9bb3878f81d97ebe", "28f85bbc6bb3df6fbf9144b6110e6658edac526283df097e8ad9efa2c3b0a528",
    ]);
    for (const req of [legacy, request]) expect(sourceFactRepairHash(renderPitchVariation(candidate, req))).toBe("0035b85149c87f4bbbe46e8706668f16ad45bf90f3f7ce10f476bf408e0ec191");
  });
  it.each([PITCH_VARIATION_PLANNING_GUIDANCE_V2, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION])("requests the complete projectPlan format with %s", (version) => {
    const { request: legacy, candidate: old, context } = legacyPromptFixture();
    const request = PitchVariationRequestSchema.parse({ ...legacy, planningGuidanceVersion: version,
      baseline: { ...legacy.baseline, planSha256: sourceFactRepairHash(variationProjectPlanFixture.markdown) }, baselineProjectPlan: variationProjectPlanFixture });
    const candidate = PitchVariationCandidateSchema.parse({ ...old, projectPlan: variationProjectPlanFixture });
    for (const prompt of [variationCandidatePrompt(request, 0), variationReviewPrompt(request, [candidate]), variationRevisionPrompt(request, candidate, context.instruction, context.allowedPaths)]) {
      expect(prompt).toContain(version);
      expect(prompt.includes("차별점을 기획 항목이나 장점·심사 기준으로 요구하지 않습니다")).toBe(version === PITCH_VARIATION_PLANNING_GUIDANCE_VERSION);
      expect(prompt).toContain("작품 전체의 이야기 흐름과 도착점");
      expect(prompt).toContain("HOW를 첫 장면의 수법이나 유능함 시연만으로 대신하지 않습니다");
      expect(prompt).toContain("모든 작품에 회귀·초능력·실패·결핍을 강요하지 않습니다");
      expect(prompt).not.toContain("전체 기획서·장편·원고를 작성하거나");
      expect(prompt).not.toContain("storyOverview");
    }
    expect(variationCandidatePrompt(request, 0)).toContain('"projectPlan":{"format":"webnovel-project-plan/v1"');
    if (version === PITCH_VARIATION_PLANNING_GUIDANCE_VERSION) {
      const reviewPrompt = variationReviewPrompt(request, [candidate]);
      expect(reviewPrompt).not.toContain("같은 배치/개입/해결을 답습하는지");
      expect(reviewPrompt).not.toContain("실제 사건과 배치가 어떻게 다른가");
      expect(reviewPrompt).toContain("참고한 사건의 배치·개입·해결이 후보의 인물과 목적에 맞는지");
    }
  });
});
