import { describe, expect, it } from "vitest";
import { expansionPrompt, validateExpansionCandidate, validateHumanPremiseCandidate, validateHumanPremiseReviewResponse } from "../commands/human-premise.js";

const digest = "a".repeat(64);
const binding = {
  schemaVersion: "firefly_pitch_source_binding/v1" as const,
  packId: "pack",
  packSha256: digest,
  sourceSha256: digest,
  storyIndex: { path: "index", sha256: digest, selected: [{ sequence: 1, arcId: "a", sourceLineRange: { start: 1, end: 2 }, sourceCharacterRange: { start: 0, end: 10 }, rawProseSha256: digest }] },
  styleExamples: { path: "style", sha256: digest, selected: [{ id: "s1", sequence: 1, arcId: "a", rawProseSha256: digest }] },
  structureInputs: [
    { role: "project-bible" as const, path: "b", sha256: digest },
    { role: "chapter-map" as const, path: "c", sha256: digest },
    { role: "arc-atlas" as const, path: "a", sha256: digest },
  ],
};

function raw(privateWant: string) {
  return {
    candidateId: "p01",
    titleCandidates: ["제목"],
    oneLineHumanPromise: "한 사람이 마지막 가족의 믿음을 되찾으려 오늘 움직인다.",
    humanPremise: {
      protagonistAsPerson: "사랑받은 기억 하나로 실패한 세월을 버틴 사람이다.",
      privateWant,
      feltLack: "죽을 때까지 누구에게도 믿음받지 못했다는 외로움이다.",
      targetPerson: "할아버지",
      whyToday: "오늘 돌아서면 가족을 잃는 사건이 다시 시작되기 때문이다.",
      firstChoice: "모두가 보는 자리에서 거짓말을 직접 폭로하기로 한다.",
      emotionalPayment: "할아버지가 처음으로 자기 편이라고 인정하며 손을 잡는다.",
      stillHumanWithoutPower: "재산이 없어도 마지막 가족에게 버려지지 않고 싶다는 마음이다.",
    },
    firstScene: { currentSituation: "가족 연회가 깨지기 직전이다.", pressure: "어린애 말은 아무도 믿지 않는다.", action: "사기꾼의 거짓을 직접 가리킨다.", witnessedChange: "할아버지가 손자의 말을 듣기 시작한다." },
    sourceBeatSequences: [1],
    styleExampleIds: ["s1"],
    retainedReferenceTraits: ["회귀 후 가족 회복", "즉시 행동과 지급"],
    surfaceVariation: "인물과 가문, 폭로 소품을 바꾼다.",
  };
}

function expansion(humanPremise: ReturnType<typeof raw>["humanPremise"]) {
  const events = [1, 2, 3, 4].map((episode) => `${episode}화에서 원문 기능을 보존한 인수 행동`);
  return {
    candidateId: "p01",
    titleCandidates: ["부도 회사를 먹는 재벌 장손"],
    oneLinePromise: "가족에게 버림받은 장손이 망한 회사를 사서 자기 그룹과 가족의 자리를 되찾는다.",
    primaryReference: "독식하는 재벌 3세의 기업 성장과 가족 지급 엔진",
    preservedSkeleton: ["기업 인수", "싸게 사고 정상화", "공장에서 그룹으로", "돈과 가족 대우의 동시 지급"],
    surfaceVariation: "인물 이름과 회사, 첫 공장 위치와 증거 소품을 바꾼다.",
    linkedCausalAdjustments: ["공장 업종 변경에 맞춰 담보와 첫 수주를 함께 조정한다."],
    humanPremise,
    spineRetention: {
      schemaVersion: "firefly_spine_retention/v1",
      primaryReference: { packId: "pack", packSha256: digest, sourceSha256: digest },
      referenceDisclosure: {
        workSlug: "doksik-chaebol3", workTitle: "독식하는 재벌 3세",
        usageRoles: ["commercial-engine", "opening-event", "relationship", "payoff", "style"],
        selectionReason: "기업 성장과 가족 대우 지급이 함께 반복되는 주축 작품이다.",
        preservedElements: ["기업 인수", "반복 정상화", "성장 사다리", "물질과 관계의 동시 지급"],
        transformedElements: ["인명과 회사, 첫 공장의 위치를 변경한다."],
      },
      preservedEngine: { industry: "기업 인수", repeatedVerb: "싸게 사고 정상화한다", progressionLadder: "공장에서 그룹으로", rewardGrammar: "돈과 가족 대우를 함께 지급한다" },
      openingEpisodeMappings: events.map((event, index) => ({ episode: index + 1, sourceBeatSequence: index < 2 ? 1 : 2, sourceArcId: "a", retainedFunction: "위기를 정보와 실행으로 뒤집는다", transformedEvent: event })),
      relationshipConversion: { sourceFunction: "무시하던 가족이 선택을 인정한다", transformedExpression: "가족과 직원이 대표라고 부른다" },
      hookProgression: [{ sourceArcId: "a", retainedFunction: "첫 자산 지급", transformedHook: "다음 부도 기업" }, { sourceArcId: "a", retainedFunction: "가족 반격", transformedHook: "장남의 대응" }],
      surfaceChanges: [{ layer: "people", change: "조손 관계를 장손과 아버지로 변경", causalAdjustment: "승계 순서를 함께 조정" }],
      payoffPair: { material: "공장과 첫 현금", emotional: "아버지의 공개 인정", witness: "직원과 가족" },
    },
    protagonist: { startingIdentity: "쫓겨난 구조조정 실무자", repeatedVerb: "싸게 사고 정상화한다", firstAsset: "숨은 수주 장부" },
    entryContract: {
      humanDrive: { lackOrHumiliation: "가족에게 버림받고 실패 책임을 뒤집어썼다.", personalDesire: humanPremise.privateWant, selfInterest: "자기 이름의 첫 회사를 소유한다.", emotionalCostLimit: "첫 모욕 뒤 즉시 주도권을 잡는다." },
      purpose: { seriesWhat: "자기 이름의 그룹을 완성한다.", arcWhat: "첫 공장을 정상화한다.", chapterWant: "오늘 공장 열쇠를 얻는다.", whyNow: humanPremise.whyToday },
      commercialPromise: { currentSituation: "철거 입찰까지 세 시간이 남았다.", repeatableReaderFantasy: "버려진 회사를 사서 기업 제국을 만든다.", howAdvantage: "전생 지식과 실무로 저평가 자산을 찾는다.", firstPayoff: "공장 소유권과 아버지의 인정을 함께 얻는다.", payoffWitness: "직원과 가족이 대표라고 부른다.", nextPaymentQuestion: "다음 부도 기업도 선점할 수 있는가." },
    },
    openingEpisodes: events.map((event, index) => ({ episode: index + 1, event, visiblePayoff: `${index + 1}화 물질과 관계 지급` })),
    firstReward: "공장 소유권과 가족의 공개 인정",
    railA: ["첫 공장", "계열사", "그룹"],
    railB: ["아버지 인정", "형제 견제", "직원 충성"],
    arcLadder: [1, 2, 3, 4, 5, 6].map((arc) => ({ arc, externalMove: `${arc}단계 인수`, visibleReward: `${arc}단계 자산`, relationshipConversion: `${arc}단계 대우 변화` })),
    supportingReferenceRoutes: [{ reference: "주축 팩 내부 사건", role: "가족 보상", targetArc: "Arc 1" }],
    longRunRisk: "인수 승부의 수단이 반복될 수 있다.",
    commercialScore: { promise: 19, earlyPayoff: 19, repeatEngine: 18, railConversion: 18, longRunSupply: 17, total: 91 },
    decision: "pending",
  };
}

describe("Human Premise deterministic guard", () => {
  it("binds the actual Astra review runtime even when the model echoes conflicting host fields", () => {
    const host = {
      slateId: "astra-current", sourceSlateSha256: digest, reviewedAt: "2026-09-05T00:00:00.000Z",
      reviewerRuntimeReceipt: {
        schemaVersion: "firefly_pitch_runtime/v1" as const, provider: "codex-cli" as const,
        model: "gpt-6-astra" as const, reasoning: "high" as const,
        soul: { mode: "canary-scoped" as const, soulId: "male-modern-fantasy-ko" as const, version: "v1" as const, manifestSha256: digest, promptSha256: digest, resourceSha256: digest },
      },
    };
    const parsed = validateHumanPremiseReviewResponse({
      schemaVersion: "wrong", slateId: "sol-history", sourceSlateSha256: "b".repeat(64), reviewedAt: "2020-01-01T00:00:00.000Z",
      reviewerRuntimeReceipt: { ...host.reviewerRuntimeReceipt, model: "gpt-5.6-sol" }, humanDecision: "approved",
      winnerCandidateId: null, ranking: ["p01"], comparisonReason: "전제의 부족한 근거를 보완해야 한다.",
      verdicts: [{ candidateId: "p01", verdict: "HOLD", gates: { humanDesire: true, sourceGrounded: false, sceneableToday: true, nonMechanical: true, voiceGrounded: true }, decisiveStrength: "구체적 선택", decisiveRisk: "원작 근거 부족", requiredRepair: "장면 대조 보완" }],
    }, host);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ ...host, schemaVersion: "firefly_human_premise_review/v1", humanDecision: "pending" });
  });

  it("rejects a private want made only of mechanical authority objects", () => {
    const checked = validateHumanPremiseCandidate(raw("접근권 권한 계약권 통제권 승인권"), "p01", binding);
    expect(checked.errors).toContain("privateWant collapses into mechanical authority objects");
  });

  it("accepts a source-bound human desire for semantic review", () => {
    const checked = validateHumanPremiseCandidate(raw("할아버지에게 이번에는 끝까지 자기 편이라는 말을 듣고 싶다."), "p01", binding);
    expect(checked.errors).toEqual([]);
    expect(checked.candidate?.candidateId).toBe("p01");
  });

  it("accepts only an immutable-premise, source-spine-bound commercial expansion", () => {
    const premise = raw("할아버지에게 이번에는 끝까지 자기 편이라는 말을 듣고 싶다.");
    const checkedPremise = validateHumanPremiseCandidate(premise, "p01", binding).candidate;
    expect(checkedPremise).toBeDefined();
    const valid = expansion(checkedPremise!.humanPremise);
    const referenceIdentity = { workSlug: "doksik-chaebol3", workTitle: "독식하는 재벌 3세" };
    expect(validateExpansionCandidate(valid, checkedPremise!, referenceIdentity).errors).toEqual([]);
    expect(validateExpansionCandidate({ ...valid, humanPremise: { ...valid.humanPremise, privateWant: "다른 욕망으로 변경한다." } }, checkedPremise!, referenceIdentity).errors)
      .toContain("humanPremise must remain byte-equivalent JSON to the selected premise");
    expect(validateExpansionCandidate({ ...valid, protagonist: { ...valid.protagonist, repeatedVerb: "새 엔진을 발명한다" } }, checkedPremise!, referenceIdentity).errors)
      .toContain("protagonist.repeatedVerb must equal spineRetention.preservedEngine.repeatedVerb");
    expect(validateExpansionCandidate({ ...valid, spineRetention: { ...valid.spineRetention, referenceDisclosure: { ...valid.spineRetention.referenceDisclosure, workTitle: "다른 작품" } } }, checkedPremise!, referenceIdentity).errors)
      .toContain("referenceDisclosure must use the exact source work title and slug from the bound reference pack");
  });
});


describe("commercial expansion plan format", () => {
  it("carries the final format alongside the unchanged selected premise and source beats", () => {
    const selected = validateHumanPremiseCandidate(raw("할아버지에게 이번에는 끝까지 자기 편이라는 말을 듣고 싶다."), "p01", binding).candidate!;
    const before = JSON.stringify(selected);
    const prompt = expansionPrompt({
      candidate: selected,
      sourceBinding: { ...binding, storyIndex: { ...binding.storyIndex, selected: [binding.storyIndex.selected[0]!, { ...binding.storyIndex.selected[0]!, sequence: 2 }] } },
      referenceIdentity: { workSlug: "doksik-chaebol3", workTitle: "독식하는 재벌 3세" },
      instruction: "현재 선택을 유지한다.",
    });
    expect(prompt).toContain("작품 기획서 v1 · pitch");
    expect(prompt).toContain(JSON.stringify(selected.humanPremise));
    expect(prompt).toContain("1:a, 2:a");
    expect(prompt).toContain("아직 Book이나 원고를 만들지 않습니다");
    expect(JSON.stringify(selected)).toBe(before);
  });
});
