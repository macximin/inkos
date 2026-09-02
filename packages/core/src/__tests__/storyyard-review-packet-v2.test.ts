import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FireflyReviewDecisionV2Schema,
  FireflyReviewPacketV2Schema,
  assertFireflyReviewDecisionV2MatchesPacket,
  assertFireflyReviewPacketV2Identity,
  buildFireflyReviewPacketV2,
  resolveFireflyReviewCandidateV2,
} from "../storyyard/review-packet-v2.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const preparedAt = "2026-09-02T06:00:00.000Z";
const currentContent = "공통 입력 원고";
const isolation = {
  receiptSha256: hash("receipt"),
  receiptSelfHash: hash("receipt-self"),
  isolationScopeSha256: hash("scope"),
  commonSnapshotSha256: hash("snapshot"),
};

function candidate(id: "candidate-A" | "candidate-B", body: string) {
  return {
    id,
    kind: "blind-pair-candidate" as const,
    evaluationBindingSha256: hash(`binding-${id}`),
    canaryIsolation: isolation,
    status: "evaluated",
    body,
    sha256: hash(body),
    preparedAt,
    commercialScore: 88,
    commercialEvaluation: {
      openingPressure: 90, protagonistAgency: 88, resistanceQuality: 86, visiblePayoff: 89,
      endingPropulsion: 91, referenceEngineRetention: 85, transformationIntegrity: 87, styleFidelity: 86,
    },
    commercialEvaluationReceiptSha256: hash(`commercial-${id}`),
    review: {
      status: "unreviewed",
      retained: [], variedSurface: [], linkedConsequences: [],
      emotionalCoherence: { score: 87, evidence: [] },
      contentNeutrality: { passed: true, violations: [] },
      canonContradictions: [],
      surfaceComparison: {
        schemaVersion: "soul_corpus_comparison/v2" as const,
        soulId: "blind-evaluation-corpus", soulVersion: "v2", surfaceIndexSha256: hash("surface-index"),
        surfaceMatches: [], similarityPenaltyApplied: false as const, automaticRewriteApplied: false as const,
        automaticRejectApplied: false as const, humanDecision: "pending" as const,
      },
    },
  };
}

function fixture() {
  return buildFireflyReviewPacketV2({
    generatedAt: preparedAt,
    body: {
      purpose: "promotion-evaluation",
      source: { system: "inkos", bookId: "blind-book", sourceRevision: "revision-one" },
      work: { id: "blind-book", title: "블라인드 작품", genre: "modern-fantasy-ko", status: "active", targetChapters: 200 },
      artifact: { id: "chapter-0001", kind: "chapter", chapterNumber: 1, title: "", status: "promotion-evaluation", currentContent, currentContentSha256: hash(currentContent) },
      comparison: {
        reviewKind: "independent-blind-comparison", pairId: "bp-111111111111111111111111", round: 1,
        blindRunId: "br-222222222222222222222222", blindSessionId: "br-333333333333333333333333",
        commonInputReceiptSha256: hash("common"), pairedGenerationReceiptSha256: hash("paired"),
        labelAssignmentReceiptSha256: hash("labels"), runtimeReceiptSha256: hash("runtime"),
        canaryIsolation: isolation,
        candidateLabelsShuffled: true, generatorMetadataExcluded: true,
        runtime: { kernel: "enforce", piWorker: "off", retrieval: "legacy", fts: "off", model: "gpt-5.6-sol", reasoning: "high" },
      },
      candidates: [candidate("candidate-A", "첫 후보 원고"), candidate("candidate-B", "둘째 후보 원고")],
      sealedGenerationEvidence: {
        candidateEvidenceReceiptSha256s: [hash("candidate-1"), hash("candidate-2")].sort(),
        contentNeutralReceiptSha256s: [hash("neutral-1"), hash("neutral-2")].sort(),
      },
      recommendation: null,
      actions: ["select", "tie", "invalid"],
      authority: { canon: "inkos", decisionSurface: "storyyard", decisionEffect: "advisory", manuscriptApply: false, reverseSync: false },
    },
  });
}

describe("Storyyard review packet v2 evaluation contract", () => {
  it("matches committed evaluation-only semantics and binds generatedAt into identity", () => {
    const packet = fixture();
    expect(FireflyReviewPacketV2Schema.parse(packet)).toEqual(packet);
    expect(() => assertFireflyReviewPacketV2Identity(packet)).not.toThrow();
    expect(packet.actions).toEqual(["select", "tie", "invalid"]);
    expect(packet.authority).toEqual({ canon: "inkos", decisionSurface: "storyyard", decisionEffect: "advisory", manuscriptApply: false, reverseSync: false });
    expect(() => assertFireflyReviewPacketV2Identity({ ...packet, generatedAt: "2026-09-02T06:00:01.000Z" })).toThrow(/identity/u);
  });

  it("enforces select versus tie/invalid candidate null rules", () => {
    const packet = fixture();
    const base = {
      schemaVersion: "firefly_review_decision/v2" as const,
      decisionId: "decision-one", packetId: packet.packetId, packetSha256: packet.packetSha256,
      workId: packet.work.id, artifactId: packet.artifact.id, comment: "",
      purpose: "promotion-evaluation" as const, decisionEffect: "advisory" as const, manuscriptApply: false as const,
      surfaceClassifications: [], status: "pending" as const, createdAt: preparedAt,
      acknowledgedAt: null, ackReceiptPath: null,
    };
    const select = FireflyReviewDecisionV2Schema.parse({
      ...base, candidateId: "candidate-A", candidateSha256: packet.candidates[0].sha256, decision: "select",
    });
    expect(() => assertFireflyReviewDecisionV2MatchesPacket(select, packet)).not.toThrow();
    expect(() => FireflyReviewDecisionV2Schema.parse({ ...base, candidateId: null, candidateSha256: null, decision: "select" })).toThrow();
    expect(() => FireflyReviewDecisionV2Schema.parse({ ...base, candidateId: "candidate-A", candidateSha256: packet.candidates[0].sha256, decision: "tie", comment: "동률" })).toThrow();
    expect(FireflyReviewDecisionV2Schema.parse({ ...base, candidateId: null, candidateSha256: null, decision: "invalid", comment: "페어 무효" }).decision).toBe("invalid");
  });

  it("hard-rejects the former v2 manuscript-apply resolution path", () => {
    const packet = fixture();
    expect(() => resolveFireflyReviewCandidateV2(packet, packet.candidates[0], [])).toThrow("evaluation-only");
    expect(() => FireflyReviewPacketV2Schema.parse({ ...packet, actions: ["approve", "polish", "hold", "reject"] })).toThrow();
  });
});
