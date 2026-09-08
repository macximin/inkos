import { describe, expect, it } from "vitest";
import {
  BoundVariationSourceSchema, PitchVariationRequestSchema, PitchVariationCandidateSchema,
  PitchVariationReviewSchema, FireflyVariationReviewPacketV5Schema, variationHash,
  validateVariationAgainstRequest, validateVariationReview, buildVariationReviewPacket,
  PITCH_VARIATION_PLANNING_GUIDANCE_VERSION,
  PITCH_VARIATION_PLANNING_GUIDANCE_V1, PITCH_VARIATION_PLANNING_GUIDANCE_V2, VariationProjectPlanSchema, renderVariationProjectPlan, renderPitchVariation,
} from "../planning/pitch-variation.js";
import { sourceFactRepairHash } from "../planning/source-fact-repair.js";
import { variationProjectPlanFixture } from "./fixtures/variation-project-plan-fixture.js";

const excerpt = "  실제 원문 첫 행\r\n다음 행과 결산\n";
const event = (eventId: string, role: "main" | "donor") => ({
  eventId, role, workTitle: "계약 검증용 합성 작품", sourcePath: "/fixture/source.txt", sourceSha256: "a".repeat(64),
  startLine: 1, endLine: 2, chapterRange: "1화", actualEvent: "원작의 실제 선택과 결산을 기록하는 필드",
  privateGoal: "자기 투자 이익", interventionReason: "기회를 차지하려고 개입", advantageUse: "알고 있는 정보를 사용",
  personalGain: "자기 회사에 수익 귀속", readerPleasure: "상대의 예상과 다른 선택", nextGoal: "다음 투자",
  prerequisites: "이미 가진 자금과 실행자", transferUse: "사건의 실행 구조", doNotTransfer: "다른 주인공의 별개 능력",
});
const request = () => PitchVariationRequestSchema.parse({
  schemaVersion: "pitch-variation-request/v1", slateId: "variation-test", baselinePath: "/fixture/p01.json",
  baseline: { slateId: "baseline-test", candidateId: "p01", candidateSha256: "b".repeat(64), planSha256: "c".repeat(64), title: "기준 기획" },
  baselineContext: "검증용 기준안", scope: { episodeStart: 1, episodeEnd: 4, through: "첫 투자 회수" },
  genre: "modern-fantasy-ko", targetChapters: 200, instruction: "사건을 바꾸고 자기 이익과 인과를 보존", directions: ["다른 사건", "다른 배치"],
  sources: [event("main-1", "main"), event("donor-1", "donor")].map((source) => ({ event: source, excerpt, excerptSha256: sourceFactRepairHash(excerpt) })),
});
const candidate = (candidateId: string) => PitchVariationCandidateSchema.parse({
  candidateId, title: "새 사건의 변주", variationIntent: "소품이 아니라 사건을 바꾼다", sourceEventIds: ["main-1", "donor-1"],
  synopsis: "실제 제작 결과가 아닌 구조 검증용 합성 서술이다. ".repeat(25),
  eventComparisons: ["개입 장면", "투자 사건"].map((baselineEvent) => ({ baselineEvent,
    retainedFunction: { personalGoal: "자기 목적", interventionReason: "개입 이유", advantageUse: "정보 우위", personalGain: "자기 이익", readerPleasure: "행동의 쾌감", nextGoal: "다음 획득" },
    donorEventIds: ["donor-1"], redesignedEvent: "다른 사건을 설계", prerequisiteChanges: "연대와 실행 조건을 함께 변경", downstreamConnection: "얻은 수익으로 다음 투자" })),
  openingEpisodes: [1, 2, 3, 4].map((episode) => ({ episode, goal: "목적", action: "선택과 행동", gainOrProgress: "진행", endingPull: "다음 기대" })),
  firstInvestment: { item: "새 투자 대상", informationEdge: "미래 정보", capitalAndExecution: "자기 자금과 실행자", sequence: "실행 이후 회수", realizedReturn: "실제 귀속된 수익", nextUse: "후속 사업" },
  chronologyChanges: "새 선행 조건에 따라 순서를 변경", remainingQuestions: "읽는 맛은 사람이 판단",
});
const fullPlanRequest = (version = PITCH_VARIATION_PLANNING_GUIDANCE_VERSION as string) => {
  const req = request();
  return PitchVariationRequestSchema.parse({ ...req, planningGuidanceVersion: version,
    baseline: { ...req.baseline, planSha256: sourceFactRepairHash(variationProjectPlanFixture.markdown) }, baselineProjectPlan: variationProjectPlanFixture });
};
const review = () => {
  const req = request(); const candidates = [candidate("v01"), candidate("v02")];
  const check = { passed: true, evidence: "구체 원문과 신작의 대응을 검토한 합성 판정" };
  return PitchVariationReviewSchema.parse({ requestSha256: variationHash(req), candidatesSha256: variationHash(candidates),
    verdicts: candidates.map((item) => ({ candidateId: item.candidateId, review: { verdict: "ready", sourceAccuracy: check, selfInterest: check, causalCoherence: check, variationQuality: check,
      readingPleasure: { assessment: "사람 확인 필요", evidence: "합성 자료의 판정 필드" }, requiredRepair: "없음" } })),
    recommendation: { candidateId: "v01", reason: "비교 근거" } });
};

describe("bounded source-grounded planning variation", () => {
  it("keeps legacy requests byte-reproducible and explicitly binds only supported planning guidance", () => {
    const legacy = request();
    const bytes = JSON.stringify(legacy);
    expect(Object.hasOwn(PitchVariationRequestSchema.parse(legacy), "planningGuidanceVersion")).toBe(false);
    expect(JSON.stringify(PitchVariationRequestSchema.parse(legacy))).toBe(bytes);
    const current = fullPlanRequest();
    expect(current.planningGuidanceVersion).toBe("webnovel-bounded-variation/v3");
    expect(PitchVariationRequestSchema.parse({ ...legacy, planningGuidanceVersion: PITCH_VARIATION_PLANNING_GUIDANCE_V1 }).planningGuidanceVersion).toBe("webnovel-bounded-variation/v1");
    expect(variationHash(current)).not.toBe(variationHash(legacy));
    for (const planningGuidanceVersion of ["webnovel-bounded-variation/v4", "", null, 1]) {
      expect(PitchVariationRequestSchema.safeParse({ ...legacy, planningGuidanceVersion }).success).toBe(false);
    }
    expect(() => validateVariationReview(review(), current, [candidate("v01"), candidate("v02")])).toThrow("binding");
  });
  it.each([PITCH_VARIATION_PLANNING_GUIDANCE_V2, PITCH_VARIATION_PLANNING_GUIDANCE_VERSION])("requires a full baseline and complete plan on every %s validation/render/review/export path", (version) => {
    const req = fullPlanRequest(version); const missing = [candidate("v01"), candidate("v02")];
    const reviewValue = { ...review(), requestSha256: variationHash(req), candidatesSha256: variationHash(missing) };
    expect(() => validateVariationAgainstRequest(missing[0]!, req)).toThrow("projectPlan");
    expect(() => renderPitchVariation(missing[0]!, req)).toThrow("projectPlan");
    expect(() => validateVariationReview(reviewValue, req, missing)).toThrow("projectPlan");
    expect(() => buildVariationReviewPacket(req, missing, reviewValue, "2026-09-06T00:00:00.000Z")).toThrow("projectPlan");
    expect(PitchVariationRequestSchema.safeParse({ ...req, baselineProjectPlan: undefined }).success).toBe(false);
    expect(PitchVariationRequestSchema.safeParse({ ...req, baselineProjectPlan: { ...variationProjectPlanFixture, markdown: variationProjectPlanFixture.markdown + "\nchanged" } }).success).toBe(false);
    const baselineWithNewline = { ...variationProjectPlanFixture, markdown: variationProjectPlanFixture.markdown + "\n" };
    const preserved = PitchVariationRequestSchema.parse({ ...req, baseline: { ...req.baseline, planSha256: sourceFactRepairHash(baselineWithNewline.markdown) }, baselineProjectPlan: baselineWithNewline });
    expect(preserved.baselineProjectPlan?.markdown).toBe(baselineWithNewline.markdown);
    const values = missing.map((value) => PitchVariationCandidateSchema.parse({ ...value, projectPlan: variationProjectPlanFixture }));
    const reviewed = { ...reviewValue, candidatesSha256: variationHash(values) };
    const missingBaseline = { ...req, baselineProjectPlan: undefined };
    expect(() => renderPitchVariation(values[0]!, missingBaseline)).toThrow();
    expect(() => buildVariationReviewPacket(missingBaseline, values, { ...reviewed, requestSha256: variationHash(missingBaseline) }, "2026-09-06T00:00:00.000Z")).toThrow();
    const packet = buildVariationReviewPacket(req, values, reviewed, "2026-09-06T00:00:00.000Z");
    expect(renderPitchVariation(values[0]!, req)).toBe(variationProjectPlanFixture.markdown);
    expect(packet.candidates[0]!.markdown).toBe(variationProjectPlanFixture.markdown);
    expect(packet.candidates[0]!.markdown).not.toContain("## 사건을 어떻게 바꾸는가");
    expect(() => renderPitchVariation(values[0]!, request())).toThrow("explicit guidance v2");
  });
  it.each(["WHAT", "HOW"])("rejects missing or empty %s even when a nine-section plan has enough text", (marker) => {
    const markdown = variationProjectPlanFixture.markdown.replace(new RegExp(`^\\| ${marker} \\|.*$`, "mu"), "");
    expect(VariationProjectPlanSchema.safeParse({ ...variationProjectPlanFixture, markdown }).success).toBe(false);
    const empty = variationProjectPlanFixture.markdown.replace(new RegExp(`^\\| ${marker} \\|.*$`, "mu"), `| ${marker} | |`);
    expect(VariationProjectPlanSchema.safeParse({ ...variationProjectPlanFixture, markdown: empty }).success).toBe(false);
  });
  it("keeps the existing nine-section format, accepting nested headings but rejecting missing/reordered sections", () => {
    const nested = { ...variationProjectPlanFixture, markdown: variationProjectPlanFixture.markdown.replace("첫 인재와 회사를 확보한", "### 1. 첫 거래\n첫 인재와 회사를 확보한") };
    expect(renderVariationProjectPlan(nested)).toBe(nested.markdown);
    expect(VariationProjectPlanSchema.safeParse({ ...nested, markdown: nested.markdown.replace("## 9. 기획 의도와 집필 계획", "## 8. 기획 의도와 집필 계획") }).success).toBe(false);
    expect(VariationProjectPlanSchema.safeParse({ format: "other", markdown: nested.markdown }).success).toBe(false);
  });
  it("preserves exact source whitespace and rejects tampered excerpts", () => {
    const source = request().sources[0]!;
    expect(BoundVariationSourceSchema.parse(source).excerpt).toBe(excerpt);
    expect(BoundVariationSourceSchema.safeParse({ ...source, excerpt: excerpt.trim() }).success).toBe(false);
  });
  it("requires an actual main and donor source, unique coordinates and IDs", () => {
    const req = request();
    expect(PitchVariationRequestSchema.safeParse({ ...req, sources: [req.sources[0], req.sources[0]] }).success).toBe(false);
    expect(PitchVariationRequestSchema.safeParse({ ...req, sources: req.sources.map((source) => ({ ...source, event: { ...source.event, role: "main" } })) }).success).toBe(false);
  });
  it("does not require target chronology or item equality, but rejects invented donor references", () => {
    const value = candidate("v01");
    expect(() => validateVariationAgainstRequest(value, request())).not.toThrow();
    expect(() => validateVariationAgainstRequest({ ...value, sourceEventIds: ["main-1", "invented-source"] }, request())).toThrow("invented");
    expect(() => validateVariationAgainstRequest({ ...value, eventComparisons: value.eventComparisons.map((item) => ({ ...item, donorEventIds: ["main-1"] })) }, request())).toThrow("donor");
  });
  it("requires ordered episode coverage and forbids producer score fields", () => {
    const value = candidate("v01");
    expect(PitchVariationCandidateSchema.safeParse({ ...value, commercialScore: 99 }).success).toBe(false);
    expect(PitchVariationCandidateSchema.safeParse({ ...value, openingEpisodes: [...value.openingEpisodes].reverse() }).success).toBe(false);
  });
  it("binds review to exact inputs and rejects omitted, duplicate or failed ready verdicts", () => {
    const req = request(); const values = [candidate("v01"), candidate("v02")]; const result = review();
    expect(() => validateVariationReview(result, req, values)).not.toThrow();
    expect(() => validateVariationReview(result, { ...req, instruction: "changed" }, values)).toThrow("binding");
    expect(() => validateVariationReview({ ...result, verdicts: [result.verdicts[0]!, result.verdicts[0]!] }, req, values)).toThrow("exactly once");
    const failed = structuredClone(result); failed.verdicts[0]!.review.sourceAccuracy.passed = false;
    expect(PitchVariationReviewSchema.safeParse(failed).success).toBe(false);
  });
  it("exports a variation-only HIL packet with stable normalized hashes", () => {
    const packet = buildVariationReviewPacket(request(), [candidate("v01"), candidate("v02")], review(), "2026-09-06T00:00:00.000Z");
    expect(FireflyVariationReviewPacketV5Schema.parse(packet).packetSha256).toBe(packet.packetSha256);
    expect(packet.authority).toMatchObject({ decisionEffect: "variation-selection", bookCreation: false, manuscriptApply: false });
    expect(packet.baseline.candidateId).toBe("p01");
    const changed = structuredClone(packet); changed.candidates[0]!.markdown += "사후 수정";
    expect(FireflyVariationReviewPacketV5Schema.safeParse(changed).success).toBe(false);
  });
});
