import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FireflyHumanPremiseReviewSchema,
  FireflyHumanPremiseSlateSchema,
  FireflyHumanPremiseDecisionSchema,
  FireflyHumanPremiseReviewPacketV4Schema,
  FireflySpineRetentionContractSchema,
  buildFireflyHumanPremiseReviewPacketV4,
  hashPitchReviewCanonicalJson,
} from "../index.js";

const digest = (character: string) => character.repeat(64);

function runtime() {
  return {
    schemaVersion: "firefly_pitch_runtime/v1" as const,
    provider: "codex-cli" as const,
    model: "gpt-5.6-sol" as const,
    reasoning: "high" as const,
    soul: {
      mode: "canary-scoped" as const,
      soulId: "male-modern-fantasy-ko" as const,
      version: "v1" as const,
      manifestSha256: digest("1"),
      promptSha256: digest("2"),
      resourceSha256: digest("3"),
    },
  };
}

function binding() {
  return {
    schemaVersion: "firefly_pitch_source_binding/v1" as const,
    packId: "doksik-chaebol3-ko-v1",
    packSha256: digest("4"),
    sourceSha256: digest("5"),
    storyIndex: { path: "story-index.jsonl", sha256: digest("6"), selected: [{ sequence: 1, arcId: "DCA-N01", sourceLineRange: { start: 1, end: 255 }, sourceCharacterRange: { start: 0, end: 6008 }, rawProseSha256: digest("7") }] },
    styleExamples: { path: "style-examples.jsonl", sha256: digest("8"), selected: [{ id: "phase-1-entry-1", sequence: 1, arcId: "DCA-N01", rawProseSha256: digest("7") }] },
    structureInputs: [
      { role: "project-bible" as const, path: "project_bible.md", sha256: digest("9") },
      { role: "chapter-map" as const, path: "chapter_map.csv", sha256: digest("a") },
      { role: "arc-atlas" as const, path: "arc_atlas.md", sha256: digest("b") },
    ],
  };
}

function candidate() {
  const unsigned = {
    candidateId: "p01",
    titleCandidates: ["할아버지가 내 이름을 다시 불렀다"],
    oneLineHumanPromise: "버림받은 손자가 마지막 가족의 믿음을 되찾기 위해 오늘 먼저 손을 내민다.",
    humanPremise: {
      protagonistAsPerson: "사랑받았다는 기억 하나로 실패한 스무 해를 버틴 손자다.",
      privateWant: "할아버지에게 이번에는 끝까지 곁에 있겠다는 말을 듣고 싶다.",
      feltLack: "죽을 때까지 누구에게도 믿음받지 못했다는 수치와 외로움이 남았다.",
      targetPerson: "할아버지",
      whyToday: "오늘 연회에서 등을 돌리면 가족이 무너지는 첫 배신을 다시 놓친다.",
      firstChoice: "모두가 지켜보는 자리에서 거짓말하는 어른을 직접 가리킨다.",
      emotionalPayment: "할아버지가 처음으로 손자를 후계자가 아닌 자기 편이라고 부른다.",
      stillHumanWithoutPower: "모든 재산을 잃어도 유일한 가족에게 이번에는 버려지지 않고 싶다.",
    },
    firstScene: {
      currentSituation: "생일 연회에서 할아버지의 체면이 무너지기 직전이다.",
      pressure: "열일곱 살 손자의 말은 누구도 진지하게 듣지 않는다.",
      action: "주인공이 사기꾼의 손목을 가리켜 거짓을 폭로한다.",
      witnessedChange: "할아버지가 웃음을 거두고 손자의 말을 끝까지 듣는다.",
    },
    sourceBeatSequences: [1],
    styleExampleIds: ["phase-1-entry-1"],
    retainedReferenceTraits: ["가족 상실에서 출발하는 회귀", "짧은 문장 뒤 즉시 행동과 지급"],
    surfaceVariation: "가문과 업종, 연회 소품, 폭로 대상의 사정을 교체한다.",
  };
  return { ...unsigned, sha256: hashPitchReviewCanonicalJson(unsigned) };
}

describe("Firefly Human Premise P0", () => {
  it.each(["gpt-5.6-sol", "gpt-6-astra"] as const)("accepts source-bound %s/high candidate-Soul slates", (model) => {
    expect(FireflyHumanPremiseSlateSchema.parse({
      schemaVersion: "firefly_human_premise_slate/v1",
      slateId: "canary",
      canonStatus: "non-canonical",
      reviewStatus: "pending",
      genre: "modern-fantasy-ko",
      instruction: "현대판타지 재벌물",
      instructionSha256: createHash("sha256").update("현대판타지 재벌물").digest("hex"),
      sourceBinding: binding(),
      runtimeReceipt: { ...runtime(), model },
      generatedAt: "2026-09-04T00:00:00.000Z",
      candidates: [candidate()],
    }).candidates[0]?.candidateId).toBe("p01");
  });

  it("rejects instruction tampering and duplicate candidate identities", () => {
    const base = {
      schemaVersion: "firefly_human_premise_slate/v1",
      slateId: "canary",
      canonStatus: "non-canonical",
      reviewStatus: "pending",
      genre: "modern-fantasy-ko",
      instruction: "현대판타지 재벌물",
      instructionSha256: createHash("sha256").update("현대판타지 재벌물").digest("hex"),
      sourceBinding: binding(),
      runtimeReceipt: runtime(),
      generatedAt: "2026-09-04T00:00:00.000Z",
      candidates: [candidate()],
    } as const;
    expect(() => FireflyHumanPremiseSlateSchema.parse({ ...base, instructionSha256: digest("c") })).toThrow(/instruction SHA-256/u);
    expect(() => FireflyHumanPremiseSlateSchema.parse({ ...base, candidates: [candidate(), candidate()] })).toThrow(/candidate IDs must be unique/u);
  });

  it("rejects a mechanical legacy pitch that has no Human Premise contract", () => {
    const legacy = { candidateId: "p01", oneLinePromise: "접근권을 독점해 물류권을 장악한다", entryContract: {} };
    expect(() => FireflyHumanPremiseSlateSchema.parse({ candidates: [legacy] })).toThrow();
  });

  it("forbids SURVIVE whenever an independent grounding gate fails", () => {
    expect(() => FireflyHumanPremiseReviewSchema.parse({
      schemaVersion: "firefly_human_premise_review/v1",
      reviewKind: "independent-human-grounding",
      slateId: "canary",
      sourceSlateSha256: digest("d"),
      reviewerRuntimeReceipt: runtime(),
      reviewedAt: "2026-09-04T00:00:00.000Z",
      winnerCandidateId: "p01",
      ranking: ["p01"],
      verdicts: [{ candidateId: "p01", verdict: "SURVIVE", gates: { humanDesire: false, sourceGrounded: true, sceneableToday: true, nonMechanical: true, voiceGrounded: true }, decisiveStrength: "행동", decisiveRisk: "욕망", requiredRepair: "욕망 복구" }],
      comparisonReason: "비교",
      humanDecision: "pending",
    })).toThrow(/cannot SURVIVE/u);
  });

  it.each(["gpt-5.6-sol", "gpt-6-astra"] as const)("builds a hash-bound %s v4 packet and rejects mixed reviewer models", (model) => {
    const review = { candidateId: "p01", verdict: "SURVIVE" as const, gates: { humanDesire: true, sourceGrounded: true, sceneableToday: true, nonMechanical: true, voiceGrounded: true }, decisiveStrength: "사람", decisiveRisk: "없음", requiredRepair: "없음" };
    const { candidateId: _candidateId, ...packetCandidate } = candidate();
    const packet = buildFireflyHumanPremiseReviewPacketV4({
      generatedAt: "2026-09-04T00:00:00.000Z",
      purpose: "human-premise",
      source: { system: "inkos", slateId: "canary", sourceRevision: digest("e") },
      work: { id: "canary", title: "HIL", genre: "modern-fantasy-ko", status: "non-canonical" },
      artifact: { id: "canary", kind: "human-premise-slate", title: "HIL", status: "human-decision-pending" },
      sourceBinding: binding(),
      runtimeReceipt: { ...runtime(), model },
      reviewerRuntimeReceipt: { ...runtime(), model },
      candidates: [{ id: "p01", ...packetCandidate, independentReview: review }],
      recommendation: { candidateId: "p01", reason: "사람 욕망" },
      actions: ["select", "hold", "reject"],
      authority: { canon: "inkos", decisionSurface: "storyyard", decisionEffect: "human-premise-selection", commercialExpansion: false, bookCreation: false, manuscriptApply: false, reverseSync: false },
    });
    expect(packet.schemaVersion).toBe("firefly_review_packet/v4");
    expect(packet.authority.commercialExpansion).toBe(false);
    const otherModel = model === "gpt-5.6-sol" ? "gpt-6-astra" : "gpt-5.6-sol";
    expect(() => FireflyHumanPremiseReviewPacketV4Schema.parse({ ...packet, reviewerRuntimeReceipt: { ...packet.reviewerRuntimeReceipt, model: otherModel } })).toThrow();
    const { schemaVersion: _schema, packetId: _id, packetSha256: _hash, ...unsigned } = packet;
    expect(() => buildFireflyHumanPremiseReviewPacketV4({ ...unsigned, reviewerRuntimeReceipt: { ...packet.reviewerRuntimeReceipt, model: otherModel } })).toThrow(/models must match/);
  });

  it("allows only a selected Human Premise to authorize commercial expansion", () => {
    expect(FireflyHumanPremiseDecisionSchema.parse({
      schemaVersion: "firefly_human_premise_decision/v1",
      decisionId: `hpd-${"1".repeat(24)}`,
      slateId: "canary",
      candidateId: "p01",
      candidateSha256: digest("2"),
      decision: "select",
      comment: "상업 엔진을 살려 확장",
      decidedAt: "2026-09-04T00:00:00.000Z",
      sourceSlateSha256: digest("3"),
      sourceReviewSha256: digest("4"),
      canonEffect: "commercial-expansion-authorized",
      manuscriptAuthorized: false,
    }).canonEffect).toBe("commercial-expansion-authorized");
    expect(() => FireflyHumanPremiseDecisionSchema.parse({
      schemaVersion: "firefly_human_premise_decision/v1",
      decisionId: `hpd-${"1".repeat(24)}`,
      slateId: "canary",
      candidateId: "p01",
      candidateSha256: digest("2"),
      decision: "reject",
      comment: "",
      decidedAt: "2026-09-04T00:00:00.000Z",
      sourceSlateSha256: digest("3"),
      sourceReviewSha256: digest("4"),
      canonEffect: "none",
      manuscriptAuthorized: false,
    })).toThrow(/comment/u);
  });

  it("requires a source-spine map across at least two bound beats and paired payoffs", () => {
    const contract = {
      schemaVersion: "firefly_spine_retention/v1",
      primaryReference: { packId: "pack", packSha256: digest("1"), sourceSha256: digest("2") },
      referenceDisclosure: {
        workSlug: "doksik-chaebol3", workTitle: "독식하는 재벌 3세",
        usageRoles: ["commercial-engine", "opening-event", "relationship", "payoff", "style"],
        selectionReason: "기업 성장과 가족 대우 지급이 함께 반복되는 주축 작품이다.",
        preservedElements: ["기업 인수", "반복 정상화", "성장 사다리", "물질과 관계의 동시 지급"],
        transformedElements: ["인명과 회사, 첫 공장의 위치를 변경한다."],
      },
      preservedEngine: { industry: "기업 인수", repeatedVerb: "싸게 사고 정상화한다", progressionLadder: "공장에서 그룹으로", rewardGrammar: "돈과 대우를 함께 지급" },
      openingEpisodeMappings: [1, 2, 3, 4].map((episode) => ({ episode, sourceBeatSequence: episode < 3 ? 1 : 2, sourceArcId: "DCA-N01", retainedFunction: "압박을 행동으로 뒤집는다", transformedEvent: `${episode}화 사건` })),
      relationshipConversion: { sourceFunction: "무시에서 인정으로", transformedExpression: "직원이 대표라고 부른다" },
      hookProgression: [{ sourceArcId: "DCA-N01", retainedFunction: "첫 자산 지급", transformedHook: "다음 인수" }, { sourceArcId: "DCA-N02", retainedFunction: "상대의 반격", transformedHook: "가족 대응" }],
      surfaceChanges: [{ layer: "people", change: "가족 인물을 교체", causalAdjustment: "상속 순서를 조정" }],
      payoffPair: { material: "공장 소유권", emotional: "가족의 인정", witness: "직원과 가족" },
    } as const;
    expect(FireflySpineRetentionContractSchema.parse(contract).payoffPair.material).toBe("공장 소유권");
    expect(() => FireflySpineRetentionContractSchema.parse({
      ...contract,
      openingEpisodeMappings: contract.openingEpisodeMappings.map((item) => ({ ...item, sourceBeatSequence: 1 })),
    })).toThrow(/at least two source beats/u);
  });
});
