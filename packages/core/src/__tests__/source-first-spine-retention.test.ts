import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  FireflySpineRetentionContractSchema,
  FireflySpineRetentionContractV2Schema,
  FireflySpineRetentionContractUnionSchema,
} from "../planning/spine-retention.js";
import {
  FireflyPitchReviewCandidateV3Schema,
  FireflyPitchReviewPacketV3Schema,
  hashCanonicalJson,
} from "../storyyard/pitch-review-packet.js";
import {
  makeSourceFirstPitchReviewPacketFixture,
  makeSourceFirstSpineFixture,
} from "./fixtures/source-first-pitch-review-fixture.js";

function signCandidate(candidate: object) {
  const unsigned = { ...candidate } as Record<string, unknown>;
  delete unsigned.sha256;
  return { ...unsigned, sha256: hashCanonicalJson(unsigned) };
}

function signPacket(packet: object) {
  const unsigned = { ...packet } as Record<string, unknown>;
  delete unsigned.schemaVersion;
  delete unsigned.packetId;
  delete unsigned.packetSha256;
  const packetSha256 = hashCanonicalJson(unsigned);
  return { schemaVersion: "firefly_review_packet/v3", ...unsigned, packetSha256, packetId: `frp-${packetSha256.slice(0, 24)}` };
}

function legacyCandidate() {
  const { spineRetention: _spine, projectPlan: _plan, ...base } = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
  const { sourceChecks: _checks, ...independentReview } = base.independentReview;
  return {
    ...base,
    independentReview,
    railB: ["거래 상대의 경계", "직원들의 대우", "경쟁자의 대응"],
    arcLadder: base.arcLadder.map((arc) => ({ ...arc, relationshipConversion: "거래 상대가 주인공을 다르게 대한다." })),
  };
}

function legacySpine() {
  const {
    sourceReconstruction: _reconstruction, decisionComparisons: _decisions, rewards: _rewards,
    ...common
  } = makeSourceFirstSpineFixture();
  return {
    ...common,
    schemaVersion: "firefly_spine_retention/v1",
    relationshipConversion: { sourceFunction: "거래 상대의 대우가 달라진다.", transformedExpression: "직원들이 주인공의 결정을 받아들인다." },
    hookProgression: ["TEST-N01", "TEST-N02"].map((sourceArcId) => ({ sourceArcId, retainedFunction: "다음 거래의 기대를 이어 간다.", transformedHook: "다음 공장을 인수할 기회가 열린다." })),
    payoffPair: { material: "첫 공장 소유권이 지급된다.", emotional: "주인공이 자기 선택에 만족한다.", witness: "거래 상대가 소유권 이전을 확인한다." },
  };
}

const premise = {
  slateId: "legacy-premise-fixture", candidateId: "p01", candidateSha256: "a".repeat(64),
  privateWant: "자기 기업의 주인이 되고 싶다.", firstChoice: "첫 공장 인수에 자기 돈을 건다.", emotionalPayment: "자기 선택으로 얻은 결과에 만족한다.",
};

describe("source-first spine v2", () => {
  it("records source choices and rewards with explicit absent relationships and witnesses", () => {
    const spine = FireflySpineRetentionContractV2Schema.parse(makeSourceFirstSpineFixture());
    expect(spine.relationshipConversion).toBeNull();
    expect(spine.rewards[0]!.witness).toBeNull();
    expect(spine.hookProgression).toEqual([]);
    expect(spine.decisionComparisons[0]!.sourceChoice).toContain("지분");
    expect(FireflySpineRetentionContractUnionSchema.parse(spine)).toEqual(spine);
    expect(FireflySpineRetentionContractSchema.safeParse(spine).success).toBe(false);
  });

  it("preserves the legacy v1 shape and requires its original relationship and payoff fields", () => {
    const spine = legacySpine();
    const parsed = FireflySpineRetentionContractSchema.parse(spine);
    expect(hashCanonicalJson(parsed)).toBe(hashCanonicalJson(spine));
    expect(FireflySpineRetentionContractUnionSchema.parse(spine)).toEqual(parsed);
    expect(FireflySpineRetentionContractSchema.safeParse({ ...spine, relationshipConversion: null }).success).toBe(false);
    expect(FireflySpineRetentionContractSchema.safeParse({ ...spine, payoffPair: { ...spine.payoffPair, witness: null } }).success).toBe(false);
  });

  it("accepts short beneficiary names without weakening the reward evidence requirements", () => {
    const spine = makeSourceFirstSpineFixture();
    const reward = spine.rewards[0]!;
    for (const beneficiary of ["서준혁", "나"]) {
      const parsed = FireflySpineRetentionContractV2Schema.parse({
        ...spine, rewards: [{ ...reward, beneficiary: ` ${beneficiary} ` }],
      });
      expect(parsed.rewards[0]!.beneficiary).toBe(beneficiary);
    }
    const { beneficiary: _beneficiary, ...missingBeneficiary } = reward;
    for (const invalidReward of [
      missingBeneficiary,
      { ...reward, beneficiary: " \n\t " },
      { ...reward, beneficiary: "x".repeat(2_001) },
      { ...reward, sourceReward: "돈" },
      { ...reward, targetReward: "돈" },
      { ...reward, witness: "왕" },
    ]) {
      expect(FireflySpineRetentionContractV2Schema.safeParse({ ...spine, rewards: [invalidReward] }).success).toBe(false);
    }
  });

  it("rejects missing, blank, unsafe, reversed, and unbound source evidence", () => {
    const spine = makeSourceFirstSpineFixture();
    const { relationshipConversion: _relationship, ...missingRelationship } = spine;
    const { witness: _witness, ...missingWitness } = spine.rewards[0]!;
    const invalid = [
      missingRelationship,
      { ...spine, rewards: [{ ...spine.rewards[0], witness: "   " }] },
      { ...spine, rewards: [missingWitness] },
      { ...spine, decisionComparisons: [] },
      { ...spine, decisionComparisons: [{ ...spine.decisionComparisons[0], sourceSequenceStart: 0 }] },
      { ...spine, decisionComparisons: [{ ...spine.decisionComparisons[0], sourceSequenceStart: 5, sourceSequenceEnd: 4 }] },
      { ...spine, decisionComparisons: [{ ...spine.decisionComparisons[0], sourceSequenceEnd: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...spine, primaryReference: { ...spine.primaryReference, sourceSha256: "not-a-sha" } },
      { ...spine, sourceReconstruction: { ...spine.sourceReconstruction, verifiedScope: " " } },
      { ...spine, openingEpisodeMappings: spine.openingEpisodeMappings.map((mapping) => ({ ...mapping, sourceBeatSequence: 1 })) },
      { ...spine, openingEpisodeMappings: [...spine.openingEpisodeMappings].reverse() },
      { ...spine, rawProse: "An undeclared manuscript field must not travel in the review packet." },
    ];
    for (const value of invalid) expect(FireflySpineRetentionContractV2Schema.safeParse(value).success).toBe(false);
  });
});

describe("source-first planning review v3 compatibility", () => {
  it("ships the same immutable InkOS-built fixture to the Storyyard reader", async () => {
    const packet = makeSourceFirstPitchReviewPacketFixture();
    const serialized = JSON.parse(await readFile(new URL("./fixtures/source-first-pitch-review-v3.json", import.meta.url), "utf8"));
    expect(serialized).toEqual(packet);
    expect(FireflyPitchReviewPacketV3Schema.parse(serialized)).toEqual(packet);
    expect(packet.authority.manuscriptApply).toBe(false);
    expect(packet.recommendation).toBeNull();
    expect(packet.candidates[0]!.projectPlan?.markdown).toContain("## 9. 기획 의도와 집필 계획");
  });

  it("accepts only ordinary, premise-plus-v1, and source-first-without-premise candidate combinations", () => {
    const ordinary = legacyCandidate();
    const sourceFirst = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    for (const candidate of [ordinary, { ...ordinary, sourcePremise: premise, spineRetention: legacySpine() }, sourceFirst]) {
      expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate(candidate)).success).toBe(true);
    }
    for (const candidate of [
      { ...ordinary, sourcePremise: premise },
      { ...ordinary, spineRetention: legacySpine() },
      { ...sourceFirst, sourcePremise: premise },
    ]) expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate(candidate)).success).toBe(false);
  });

  it("allows absent relationships only in v2 and rejects omitted or blank relationship fields", () => {
    const sourceFirst = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    const ordinary = legacyCandidate();
    const { railB: _rail, ...missingRail } = sourceFirst;
    const { relationshipConversion: _relationship, ...missingArcRelationship } = sourceFirst.arcLadder[0]!;
    for (const candidate of [
      missingRail,
      { ...sourceFirst, railB: [""] },
      { ...sourceFirst, railB: ["  "] },
      { ...sourceFirst, arcLadder: [{ ...sourceFirst.arcLadder[0], relationshipConversion: " " }, ...sourceFirst.arcLadder.slice(1)] },
      { ...sourceFirst, arcLadder: [missingArcRelationship, ...sourceFirst.arcLadder.slice(1)] },
      { ...ordinary, railB: [] },
      { ...ordinary, arcLadder: sourceFirst.arcLadder },
    ]) expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate(candidate)).success).toBe(false);
  });

  it("requires the full project plan only for v2 and retains the existing entry and six-step constraints", () => {
    const sourceFirst = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    const { projectPlan: _plan, ...missingPlan } = sourceFirst;
    for (const candidate of [
      missingPlan,
      { ...sourceFirst, projectPlan: { format: "webnovel-project-plan/v1", markdown: "A title alone is not a project plan." } },
      { ...sourceFirst, projectPlan: { format: "webnovel-project-plan/v2", markdown: sourceFirst.projectPlan!.markdown } },
      { ...sourceFirst, projectPlan: { ...sourceFirst.projectPlan, markdown: "x".repeat(30_001) } },
      { ...legacyCandidate(), projectPlan: sourceFirst.projectPlan },
      { ...sourceFirst, entryContract: { ...sourceFirst.entryContract, commercialPromise: { ...sourceFirst.entryContract.commercialPromise, payoffWitness: null } } },
      { ...sourceFirst, arcLadder: sourceFirst.arcLadder.slice(0, 5) },
      { ...sourceFirst, openingEpisodes: [...sourceFirst.openingEpisodes].reverse() },
    ]) expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate(candidate)).success).toBe(false);
  });

  it("rejects changed source evidence and a changed project plan without a new candidate hash", () => {
    const sourceFirst = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    expect(FireflyPitchReviewCandidateV3Schema.safeParse({ ...sourceFirst, spineRetention: { ...makeSourceFirstSpineFixture(), primaryReference: { ...makeSourceFirstSpineFixture().primaryReference, sourceSha256: "b".repeat(64) } } }).success).toBe(false);
    expect(FireflyPitchReviewCandidateV3Schema.safeParse({ ...sourceFirst, projectPlan: { ...sourceFirst.projectPlan, markdown: `${sourceFirst.projectPlan!.markdown}\nChanged after review.` } }).success).toBe(false);
  });

  it("rejects a failed entry gate even when the candidate is re-signed with a SURVIVE verdict", () => {
    const candidate = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate({
      ...candidate,
      independentReview: { ...candidate.independentReview, verdict: "SURVIVE", entryGate: { ...candidate.independentReview.entryGate, passed: false, failureReasons: ["원작의 자기 이익을 지우고 타인의 칭찬으로 바꾸었다."] } },
    })).success).toBe(false);
  });

  it("requires independent source checks for v2 and preserves all three judgments without normalizing their bytes", () => {
    const candidate = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    const checks = candidate.independentReview.sourceChecks!;
    const padded = { ...checks, selfInterest: { ...checks.selfInterest, evidence: `\n${checks.selfInterest.evidence}\n` } };
    const parsed = FireflyPitchReviewCandidateV3Schema.parse(signCandidate({
      ...candidate, independentReview: { ...candidate.independentReview, sourceChecks: padded },
    }));
    expect(parsed.independentReview.sourceChecks).toEqual(padded);
    const { sourceChecks: _checks, ...missingChecks } = candidate.independentReview;
    const { evidence: _evidence, ...missingEvidence } = checks.selfInterest;
    for (const value of [
      { ...candidate, independentReview: missingChecks },
      { ...candidate, independentReview: { ...candidate.independentReview, sourceChecks: { ...checks, selfInterest: missingEvidence } } },
      { ...candidate, independentReview: { ...candidate.independentReview, sourceChecks: { ...checks, commercialReading: { assessment: " ", evidence: "확인한 근거" } } } },
      { ...legacyCandidate(), independentReview: candidate.independentReview },
    ]) expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate(value)).success).toBe(false);
  });

  it("binds either failed source judgment to a failed entry gate and forbids SURVIVE", () => {
    const candidate = makeSourceFirstPitchReviewPacketFixture().candidates[0]!;
    for (const key of ["selfInterest", "sourceFidelity"] as const) {
      const sourceChecks = {
        ...candidate.independentReview.sourceChecks!,
        [key]: { passed: false, evidence: "원작의 자기 이익 또는 선택의 인과가 후보에서 바뀌었다." },
      };
      const failed = { ...candidate.independentReview, sourceChecks };
      expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate({ ...candidate, independentReview: failed })).success).toBe(false);
      const held = { ...failed, entryGate: { ...failed.entryGate, passed: false, failureReasons: [sourceChecks[key].evidence] } };
      expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate({ ...candidate, independentReview: held })).success).toBe(true);
      expect(FireflyPitchReviewCandidateV3Schema.safeParse(signCandidate({ ...candidate, independentReview: { ...held, verdict: "SURVIVE" } })).success).toBe(false);
    }
  });

  it("requires work and artifact IDs to identify the source slate even when the packet is re-signed", () => {
    const packet = makeSourceFirstPitchReviewPacketFixture();
    for (const changed of [
      { ...packet, work: { ...packet.work, id: "other-slate" } },
      { ...packet, artifact: { ...packet.artifact, id: "other-slate" } },
    ]) expect(FireflyPitchReviewPacketV3Schema.safeParse(signPacket(changed)).success).toBe(false);
  });

  it("rejects a changed packet with unchanged packet identity", () => {
    const packet = makeSourceFirstPitchReviewPacketFixture();
    expect(FireflyPitchReviewPacketV3Schema.safeParse({ ...packet, artifact: { ...packet.artifact, title: "Changed after export" } }).success).toBe(false);
  });
});
