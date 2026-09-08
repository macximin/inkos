import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertApprovedFireflyPlanningAdmission,
  hashEntryContract,
  FireflyEntryContractSchema,
} from "../planning/entry-contract.js";
import {
  buildFireflyPitchReviewPacketV3,
  hashCanonicalJson,
} from "../storyyard/pitch-review-packet.js";

import { renderEntryPlan } from "../planning/webnovel-plan-format.js";

const entryContract = {
  humanDrive: {
    lackOrHumiliation: "가문에서 쫓겨나 전생의 부도 책임까지 뒤집어썼다.",
    personalDesire: "자기 이름으로 그룹의 주인이 되어 다시는 쫓겨나지 않는다.",
    selfInterest: "첫 공장과 현금을 자기 법인의 소유로 확정한다.",
    emotionalCostLimit: "굴욕은 첫 장면에서 끝내고 곧바로 주도권을 행사한다.",
  },
  purpose: {
    seriesWhat: "재벌그룹의 지배권을 자기 이름으로 확보한다.",
    arcWhat: "첫 공장과 운영팀을 소유한 독립 법인 대표가 된다.",
    chapterWant: "오늘 입찰 전에 계약금을 걸고 공장 열쇠를 확보한다.",
    whyNow: "오늘을 놓치면 공장이 철거되고 숨은 수주도 사라진다.",
  },
  commercialPromise: {
    currentSituation: "철거까지 세 시간이 남은 공장에서 비서실장이 출입을 막는다.",
    repeatableReaderFantasy: "남들이 버린 회사를 먼저 사서 자기 기업 제국으로 키운다.",
    howAdvantage: "전생의 부도 시점과 수주를 알고 채권 계약으로 선점한다.",
    firstPayoff: "공장 열쇠와 첫 입금, 자기 법인의 운영권을 얻는다.",
    payoffWitness: "비서실장과 직원들이 그를 대표라고 부르기 시작한다.",
    nextPaymentQuestion: "첫 공장의 수주로 다음 부실 계열사까지 살 수 있는가.",
  },
};

describe("Firefly planning admission", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-entry-contract-"));
    await mkdir(join(root, "story"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("projects all six questions without changing legacy contract bytes or inventing facts", () => {
    const before = JSON.stringify(entryContract);
    const hash = hashEntryContract(entryContract);
    const parsed = FireflyEntryContractSchema.parse(entryContract);
    const brief = renderEntryPlan(parsed, "남들이 버린 공장을 알아보는 전직 실무자");
    for (const label of ["WHO", "WHAT", "HOW", "WHERE", "WHEN", "WHY"]) expect(brief).toContain(label);
    for (const section of Object.values(entryContract)) {
      for (const value of Object.values(section)) expect(brief).toContain(value);
    }
    expect(JSON.stringify(parsed)).toBe(before);
    expect(hashEntryContract(parsed)).toBe(hash);
    expect(JSON.stringify(entryContract)).toBe(before);
  });

  it("fails closed when planning HIL is absent", async () => {
    await expect(assertApprovedFireflyPlanningAdmission({ bookDir: root, bookId: "book-a" }))
      .rejects.toThrow("planning HIL is required");
  });

  it("accepts an approved hash-bound Entry Contract", async () => {
    await writeFile(join(root, "story", "entry-contract.json"), `${JSON.stringify({
      schemaVersion: "firefly_planning_admission/v1",
      bookId: "book-a",
      status: "approved",
      entryContract,
      entryContractSha256: hashEntryContract(entryContract),
      sourceSlateId: "slate-a",
      sourceSlateSha256: createHash("sha256").update("slate").digest("hex"),
      sourceReviewSha256: createHash("sha256").update("review").digest("hex"),
      sourceDecisionSha256: createHash("sha256").update("decision").digest("hex"),
      approvedAt: "2026-09-03T00:00:00.000Z",
    }, null, 2)}\n`);
    const admission = await assertApprovedFireflyPlanningAdmission({ bookDir: root, bookId: "book-a" });
    expect(admission.entryContract.purpose.seriesWhat).toContain("지배권");
  });
});

describe("Storyyard planning HIL packet", () => {
  it("binds the recommendation to a passed Entry Gate and packet hash", () => {
    const independentReview = {
      verdict: "SURVIVE" as const,
      independentScore: { promise: 18, earlyPayoff: 18, repeatEngine: 18, railConversion: 18, longRunSupply: 18, total: 90 },
      entryGate: {
        passed: true,
        protagonistNow: "쫓겨난 실무자",
        personalWant: "자기 그룹을 갖는다",
        whyNow: "오늘 공장이 철거된다",
        repeatableFantasy: "버린 회사를 사서 제국을 만든다",
        chapterGoal: "계약금을 걸고 공장 열쇠를 얻는다",
        failureReasons: [],
      },
      decisiveStrength: "욕망과 첫 지급이 즉시 보인다.",
      decisiveRisk: "중반 인수 방식이 반복될 수 있다.",
      requiredRepair: "Arc별 상대와 승부 수단을 바꾼다.",
    };
    const unsignedCandidate = {
      id: "p01",
      titleCandidates: ["망한 회사를 독식한다"],
      oneLinePromise: "버린 회사를 사서 재벌그룹의 주인이 된다.",
      entryContract,
      protagonist: { startingIdentity: "쫓겨난 실무자", repeatedVerb: "싸게 사서 키운다", firstAsset: "숨은 수주 장부" },
      openingEpisodes: [1, 2, 3, 4].map((episode) => ({ episode, event: `${episode}화 승부`, visiblePayoff: `${episode}화 지급` })),
      firstReward: "공장 열쇠와 첫 입금",
      railA: ["공장", "계열사", "그룹"],
      railB: ["직원 인정", "가족 견제", "공개 역전"],
      arcLadder: [1, 2, 3, 4, 5, 6].map((arc) => ({ arc, externalMove: `${arc}단계 승부`, visibleReward: `${arc}단계 자산`, relationshipConversion: `${arc}단계 대우` })),
      longRunRisk: "인수 반복 위험",
      independentReview,
    };
    const candidate = { ...unsignedCandidate, sha256: hashCanonicalJson(unsignedCandidate) };
    const packet = buildFireflyPitchReviewPacketV3({
      generatedAt: "2026-09-03T00:00:00.000Z",
      purpose: "planning-entry",
      source: { system: "inkos", slateId: "slate-a", sourceRevision: createHash("sha256").update("source").digest("hex") },
      work: { id: "slate-a", title: "기획 HIL", genre: "modern-fantasy-ko", status: "non-canonical", targetChapters: 200 },
      artifact: { id: "slate-a", kind: "pitch-slate", title: "기획 HIL", status: "human-decision-pending" },
      candidates: [candidate],
      recommendation: { candidateId: "p01", reason: "가장 빠르게 욕망과 지급이 보인다." },
      actions: ["select", "hold", "reject"],
      authority: { canon: "inkos", decisionSurface: "storyyard", decisionEffect: "planning-selection", manuscriptApply: false, reverseSync: false },
    });
    expect(packet.packetId).toBe(`frp-${packet.packetSha256.slice(0, 24)}`);
  });
});
