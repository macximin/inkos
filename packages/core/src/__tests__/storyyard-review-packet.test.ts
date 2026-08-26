import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ReferenceTransformationHilCandidateView } from "../reference/hil-store.js";
import {
  assertFireflyReviewPacketIdentity,
  buildFireflyReviewPackets,
  FireflyReviewDecisionSchema,
  FireflyReviewPacketSchema,
} from "../storyyard/review-packet.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Storyyard review packet", () => {
  it("exports one stable, one-way packet for prepared candidates", () => {
    const currentContent = "현재 원고";
    const candidateContent = "후보 원고";
    const book = {
      id: "book-one",
      title: "작품 하나",
      platform: "other",
      genre: "현대판타지",
      status: "active",
      targetChapters: 200,
      chapterWordCount: 5000,
      language: "ko",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T01:00:00.000Z",
    } satisfies BookConfig;
    const chapters = [{
      number: 1,
      title: "첫 화",
      status: "ready-for-review",
      wordCount: 5,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T01:00:00.000Z",
      auditIssues: [],
      lengthWarnings: [],
    }] satisfies ChapterMeta[];
    const view = {
      candidate: {
        version: 1,
        kind: "reference-transformation-candidate",
        candidateId: "candidate-a",
        chapterNumber: 1,
        status: "prepared",
        currentContentSha256: hash(currentContent),
        candidateContentSha256: hash(candidateContent),
        referencePackId: "reference-one",
        sourceSegmentIds: ["segment-one"],
        commercialEvaluation: {
          openingPressure: 90,
          protagonistAgency: 90,
          resistanceQuality: 90,
          visiblePayoff: 90,
          endingPropulsion: 90,
          referenceEngineRetention: 90,
          transformationIntegrity: 90,
          styleFidelity: 90,
        },
        commercialScore: { formula: "dopamine70-reference30-v1", overall: 90 },
        preparedAt: "2026-08-26T01:00:00.000Z",
      },
      report: {
        version: 1,
        kind: "transformation-comparison",
        chapterNumber: 1,
        candidateId: "candidate-a",
        status: "unreviewed",
        referencePackId: "reference-one",
        spineReference: "spine",
        retained: ["engine"],
        variedSurface: ["names"],
        linkedConsequences: ["payoff"],
        sourceMappings: [],
        exactSurfaceMatches: [],
        automaticRewrite: false,
        similarityPenalty: false,
        createdAt: "2026-08-26T01:00:00.000Z",
      },
      currentContent,
      candidateContent,
      currentChapterMatchesPreparation: true,
    } satisfies ReferenceTransformationHilCandidateView;

    const [packet] = buildFireflyReviewPackets({
      book,
      chapters,
      candidates: [view],
      sourceRevision: "book-revision-one",
      generatedAt: "2026-08-26T02:00:00.000Z",
    });

    expect(FireflyReviewPacketSchema.parse(packet)).toEqual(packet);
    expect(packet?.packetId).toMatch(/^frp-[0-9a-f]{24}$/);
    expect(packet?.recommendation?.candidateId).toBe("candidate-a");
    expect(packet?.authority).toEqual({
      canon: "inkos",
      decisionSurface: "storyyard",
      apply: "inkos",
      reverseSync: false,
    });
    assertFireflyReviewPacketIdentity(packet!);
    expect(() => assertFireflyReviewPacketIdentity({ ...packet!, artifact: { ...packet!.artifact, title: "바뀐 제목" } }))
      .toThrow("identity or SHA-256 mismatch");
    expect(FireflyReviewDecisionSchema.parse({
      schemaVersion: "firefly_review_decision/v1",
      decisionId: "decision-one",
      packetId: packet!.packetId,
      packetSha256: packet!.packetSha256,
      workId: packet!.work.id,
      artifactId: packet!.artifact.id,
      candidateId: packet!.candidates[0]!.id,
      candidateSha256: packet!.candidates[0]!.sha256,
      decision: "approve",
      comment: "",
      status: "pending",
      createdAt: "2026-08-26T03:00:00.000Z",
      appliedAt: null,
      applyReceiptPath: null,
    }).status).toBe("pending");
  });

  it("fails closed when the current chapter changed", () => {
    const currentContent = "현재 원고";
    const candidateContent = "후보 원고";
    expect(() => buildFireflyReviewPackets({
      book: {
        id: "book-one", title: "작품", platform: "other", genre: "현대판타지", status: "active",
        targetChapters: 200, chapterWordCount: 5000, language: "ko",
        createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T01:00:00.000Z",
      },
      chapters: [{
        number: 1, title: "첫 화", status: "ready-for-review", wordCount: 5,
        createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T01:00:00.000Z",
        auditIssues: [], lengthWarnings: [],
      }],
      candidates: [{
        candidate: {
          version: 1, kind: "reference-transformation-candidate", candidateId: "candidate-a",
          chapterNumber: 1, status: "prepared", currentContentSha256: hash(currentContent),
          candidateContentSha256: hash(candidateContent), referencePackId: "reference-one",
          sourceSegmentIds: ["segment-one"], preparedAt: "2026-08-26T01:00:00.000Z",
        },
        report: {
          version: 1, kind: "transformation-comparison", chapterNumber: 1, candidateId: "candidate-a",
          status: "unreviewed", referencePackId: "reference-one", spineReference: "spine",
          retained: [], variedSurface: [], linkedConsequences: [], sourceMappings: [], exactSurfaceMatches: [],
          automaticRewrite: false, similarityPenalty: false, createdAt: "2026-08-26T01:00:00.000Z",
        },
        currentContent, candidateContent, currentChapterMatchesPreparation: false,
      }],
      sourceRevision: "book-revision-one",
    })).toThrow("changed after candidate preparation");
  });
});
