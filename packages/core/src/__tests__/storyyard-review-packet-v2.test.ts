import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReferenceTransformationHilCandidateView } from "../reference/hil-store.js";
import {
  FireflyReviewPacketV2Schema,
  assertFireflyReviewDecisionV2MatchesPacket,
  assertFireflyReviewPacketV2Identity,
  buildFireflyReviewPacketV2,
  fireflyApplicationBindingSha256,
  resolveFireflyReviewCandidateV2,
} from "../storyyard/review-packet-v2.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const preparedAt = "2026-08-28T06:00:00.000Z";
const currentContent = "현재 원고";

function candidateSpan(body: string, text: string) {
  const characterStart = body.indexOf(text);
  const startByte = Buffer.byteLength(body.slice(0, characterStart));
  const endByte = startByte + Buffer.byteLength(text);
  return { coordinateKind: "utf8-byte" as const, startByte, endByte, sliceSha256: hash(text) };
}

function publicCandidate(blindId: "candidate-A" | "candidate-B", internalId: string, body: string, withMatch: boolean) {
  const bodySha = hash(body);
  const span = candidateSpan(body, "압박");
  const candidateSelector = {
    coordinateKind: "utf8-byte" as const,
    candidateContentSha256: bodySha,
    startByte: span.startByte,
    endByte: span.endByte,
    candidateSliceSha256: span.sliceSha256,
  };
  const sourceSelector = {
    coordinateKind: "utf8-byte" as const,
    sourceId: `gdrive-${blindId}`,
    sourceSha256: hash(`source-${blindId}`),
    startByte: 0,
    endByte: Buffer.byteLength("원문 압박"),
    sliceSha256: hash("원문 압박"),
  };
  const selectorBody = {
    provenanceBridgeReceiptSha256: hash(`bridge-${blindId}`),
    matchMethod: "exact-token-12" as const,
    candidate: candidateSelector,
    source: sourceSelector,
  };
  const selectorSha256 = hash(JSON.stringify(selectorBody));
  return {
    id: blindId,
    applicationBindingSha256: fireflyApplicationBindingSha256({
      bookId: "blind-book", artifactId: "chapter-0001", candidateId: internalId, candidateSha256: bodySha,
    }),
    status: "unreviewed",
    body,
    sha256: bodySha,
    preparedAt,
    commercialScore: 88,
    commercialEvaluation: {
      openingPressure: 90, protagonistAgency: 88, resistanceQuality: 86, visiblePayoff: 89,
      endingPropulsion: 91, referenceEngineRetention: 85, transformationIntegrity: 87, styleFidelity: 86,
    },
    commercialEvaluationReceiptSha256: hash(`commercial-${blindId}`),
    review: {
      status: "unreviewed",
      retained: ["engine"], variedSurface: ["people"], linkedConsequences: ["money"],
      emotionalCoherence: { score: 87, evidence: [span] },
      contentNeutrality: { passed: true, violations: [] },
      canonContradictions: [],
      surfaceComparison: {
        schemaVersion: "soul_corpus_comparison/v2" as const,
        soulId: "male-modern-fantasy-ko", soulVersion: "v1", surfaceIndexSha256: hash("surface-index"),
        surfaceMatches: withMatch ? [{
          matchId: `fsm-${selectorSha256.slice(0, 24)}`, selectorSha256, ...selectorBody, classification: "pending" as const,
        }] : [],
        similarityPenaltyApplied: false as const, automaticRewriteApplied: false as const,
        automaticRejectApplied: false as const, humanDecision: "pending" as const,
      },
    },
  };
}

function view(internalId: string, body: string): ReferenceTransformationHilCandidateView {
  return {
    candidate: {
      version: 1, kind: "reference-transformation-candidate", candidateId: internalId, chapterNumber: 1,
      status: "prepared", currentContentSha256: hash(currentContent), candidateContentSha256: hash(body),
      referencePackId: "reference-one", sourceSegmentIds: ["segment-one"], preparedAt,
    },
    report: {
      version: 1, kind: "transformation-comparison", chapterNumber: 1, candidateId: internalId,
      status: "unreviewed", referencePackId: "reference-one", spineReference: "spine",
      retained: [], variedSurface: [], linkedConsequences: [], sourceMappings: [], exactSurfaceMatches: [],
      automaticRewrite: false, similarityPenalty: false, createdAt: preparedAt,
    },
    currentContent,
    candidateContent: body,
    currentChapterMatchesPreparation: true,
  };
}

function fixture() {
  const firstBody = "첫 후보의 압박 장면";
  const secondBody = "둘째 후보의 압박 장면";
  const first = publicCandidate("candidate-A", "internal-soul", firstBody, true);
  const second = publicCandidate("candidate-B", "internal-neutral", secondBody, false);
  const body = {
    source: { system: "inkos", bookId: "blind-book", sourceRevision: "revision-one" },
    work: { id: "blind-book", title: "블라인드 작품", genre: "현대판타지", status: "active", targetChapters: 200 },
    artifact: { id: "chapter-0001", kind: "chapter", chapterNumber: 1, title: "첫 화", status: "ready-for-review", currentContent, currentContentSha256: hash(currentContent) },
    comparison: {
      reviewKind: "independent-blind-comparison", pairId: "pair-one", round: 1,
      blindRunId: "blind-run-one", blindSessionId: "blind-session-one",
      commonInputReceiptSha256: hash("common"), pairedGenerationReceiptSha256: hash("paired"),
      labelAssignmentReceiptSha256: hash("labels"), runtimeReceiptSha256: hash("runtime"),
      candidateLabelsShuffled: true, generatorMetadataExcluded: true,
      runtime: { kernel: "enforce", piWorker: "off", retrieval: "legacy", fts: "off", model: "gpt-5.6-sol", reasoning: "high" },
    },
    candidates: [first, second],
    sealedGenerationEvidence: {
      candidateEvidenceReceiptSha256s: [hash("candidate-1"), hash("candidate-2")].sort(),
      contentNeutralReceiptSha256s: [hash("neutral-1"), hash("neutral-2")].sort(),
    },
    recommendation: null,
    actions: ["approve", "polish", "hold", "reject"],
    authority: { canon: "inkos", decisionSurface: "storyyard", apply: "inkos", reverseSync: false },
  };
  return { packet: buildFireflyReviewPacketV2({ generatedAt: preparedAt, body }), views: [view("internal-soul", firstBody), view("internal-neutral", secondBody)] };
}

describe("Storyyard review packet v2", () => {
  it("binds a strict blind pair to live InkOS candidates without exposing lane IDs", () => {
    const { packet, views } = fixture();
    expect(FireflyReviewPacketV2Schema.parse(packet)).toEqual(packet);
    assertFireflyReviewPacketV2Identity(packet);
    expect(JSON.stringify(packet)).not.toContain("internal-soul");
    expect(JSON.stringify(packet)).not.toContain("internal-neutral");
    expect(resolveFireflyReviewCandidateV2(packet, packet.candidates[0], views).candidate.candidateId).toBe("internal-soul");
  });

  it("requires complete human classification and blocks canon-leak approval", () => {
    const { packet } = fixture();
    const match = packet.candidates[0].review.surfaceComparison.surfaceMatches[0]!;
    const decision = {
      schemaVersion: "firefly_review_decision/v2" as const,
      decisionId: "decision-one", packetId: packet.packetId, packetSha256: packet.packetSha256,
      workId: packet.work.id, artifactId: packet.artifact.id, candidateId: packet.candidates[0].id,
      candidateSha256: packet.candidates[0].sha256, decision: "approve" as const, comment: "",
      surfaceClassifications: [{
        matchId: match.matchId, selectorSha256: match.selectorSha256, classification: "engine" as const,
        classifiedByActorId: "owner", classifiedByRole: "admin" as const, ownerScope: "owner-scope", classifiedAt: preparedAt,
      }],
      status: "pending" as const, createdAt: preparedAt, appliedAt: null, applyReceiptPath: null,
    };
    expect(() => assertFireflyReviewDecisionV2MatchesPacket(decision, packet)).not.toThrow();
    expect(() => assertFireflyReviewDecisionV2MatchesPacket({
      ...decision,
      surfaceClassifications: [{ ...decision.surfaceClassifications[0]!, classification: "canon-leak" }],
    }, packet)).toThrow("cannot be approved");
  });

  it("rejects raw source fields and candidate byte drift", () => {
    const { packet } = fixture();
    const leaked = structuredClone(packet) as unknown as Record<string, unknown>;
    const candidates = leaked.candidates as Array<Record<string, unknown>>;
    const review = candidates[0]!.review as Record<string, unknown>;
    const comparison = review.surfaceComparison as Record<string, unknown>;
    const matches = comparison.surfaceMatches as Array<Record<string, unknown>>;
    (matches[0]!.source as Record<string, unknown>).rawText = "원문";
    expect(() => FireflyReviewPacketV2Schema.parse(leaked)).toThrow();
    expect(() => assertFireflyReviewPacketV2Identity({ ...packet, candidates: [{ ...packet.candidates[0], body: `${packet.candidates[0].body}변경` }, packet.candidates[1]] })).toThrow(/identity|body SHA-256 mismatch/u);
  });
});
