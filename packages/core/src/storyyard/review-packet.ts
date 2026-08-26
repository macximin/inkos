import { createHash } from "node:crypto";
import { z } from "zod";
import type { BookConfig } from "../models/book.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ReferenceTransformationHilCandidateView } from "../reference/hil-store.js";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const FireflyReviewCandidateSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  body: z.string(),
  sha256: Sha256Schema,
  preparedAt: z.string().datetime(),
  commercialScore: z.number().min(0).max(100).nullable(),
  commercialEvaluation: z.record(z.number()).nullable(),
  review: z.object({
    status: z.string().min(1),
    retained: z.array(z.string()),
    variedSurface: z.array(z.string()),
    linkedConsequences: z.array(z.string()),
    exactSurfaceMatches: z.array(z.object({
      tokenCount: z.number().int().min(1),
      text: z.string().min(1),
    }).strict()),
  }).strict(),
}).strict();
export type FireflyReviewCandidate = z.infer<typeof FireflyReviewCandidateSchema>;

export const FireflyReviewPacketSchema = z.object({
  schemaVersion: z.literal("firefly_review_packet/v1"),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  generatedAt: z.string().datetime(),
  source: z.object({
    system: z.literal("inkos"),
    bookId: z.string().min(1),
    sourceRevision: z.string().min(1),
  }).strict(),
  work: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    genre: z.string().min(1),
    status: z.string().min(1),
    targetChapters: z.number().int().min(1),
  }).strict(),
  artifact: z.object({
    id: z.string().min(1),
    kind: z.literal("chapter"),
    chapterNumber: z.number().int().min(1),
    title: z.string(),
    status: z.string().min(1),
    currentContent: z.string(),
    currentContentSha256: Sha256Schema,
  }).strict(),
  candidates: z.array(FireflyReviewCandidateSchema).min(1),
  recommendation: z.object({
    candidateId: z.string().min(1),
    reason: z.string().min(1),
  }).strict().nullable(),
  actions: z.tuple([
    z.literal("approve"),
    z.literal("polish"),
    z.literal("hold"),
    z.literal("reject"),
  ]),
  authority: z.object({
    canon: z.literal("inkos"),
    decisionSurface: z.literal("storyyard"),
    apply: z.literal("inkos"),
    reverseSync: z.literal(false),
  }).strict(),
}).strict();
export type FireflyReviewPacket = z.infer<typeof FireflyReviewPacketSchema>;

export const FireflyReviewDecisionSchema = z.object({
  schemaVersion: z.literal("firefly_review_decision/v1"),
  decisionId: z.string().min(1),
  packetId: z.string().regex(/^frp-[0-9a-f]{24}$/u),
  packetSha256: Sha256Schema,
  workId: z.string().min(1),
  artifactId: z.string().min(1),
  candidateId: z.string().min(1),
  candidateSha256: Sha256Schema,
  decision: z.enum(["approve", "polish", "hold", "reject"]),
  comment: z.string().max(2_000),
  status: z.enum(["pending", "applied", "superseded", "failed"]),
  createdAt: z.string().datetime(),
  appliedAt: z.string().datetime().nullable().optional(),
  applyReceiptPath: z.string().nullable().optional(),
}).strict();
export type FireflyReviewDecision = z.infer<typeof FireflyReviewDecisionSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stablePayload(value: unknown): string {
  return JSON.stringify(value);
}

export function assertFireflyReviewPacketIdentity(packet: FireflyReviewPacket): void {
  const { schemaVersion: _schemaVersion, packetId, packetSha256, generatedAt: _generatedAt, ...body } = packet;
  const actual = sha256(stablePayload(body));
  if (actual !== packetSha256 || packetId !== `frp-${actual.slice(0, 24)}`) {
    throw new Error("Firefly review packet identity or SHA-256 mismatch.");
  }
}

export function buildFireflyReviewPackets(input: {
  readonly book: BookConfig;
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly candidates: ReadonlyArray<ReferenceTransformationHilCandidateView>;
  readonly sourceRevision: string;
  readonly generatedAt?: string;
}): ReadonlyArray<FireflyReviewPacket> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const prepared = input.candidates.filter(({ candidate }) => candidate.status === "prepared");
  const byChapter = new Map<number, ReferenceTransformationHilCandidateView[]>();
  for (const view of prepared) {
    const chapterNumber = view.candidate.chapterNumber;
    const existing = byChapter.get(chapterNumber) ?? [];
    existing.push(view);
    byChapter.set(chapterNumber, existing);
  }
  const packets: FireflyReviewPacket[] = [];

  for (const [chapterNumber, views] of [...byChapter.entries()].sort(([left], [right]) => left - right)) {
    const chapter = input.chapters.find((candidate) => candidate.number === chapterNumber);
    if (!chapter) throw new Error(`Review packet chapter ${chapterNumber} is missing from the Book index.`);
    if (views.some((view) => !view.currentChapterMatchesPreparation)) {
      throw new Error(`Review packet chapter ${chapterNumber} changed after candidate preparation.`);
    }
    const currentHashes = new Set(views.map(({ candidate }) => candidate.currentContentSha256));
    const currentBodies = new Set(views.map(({ currentContent }) => currentContent));
    if (currentHashes.size !== 1 || currentBodies.size !== 1) {
      throw new Error(`Review packet chapter ${chapterNumber} candidates do not share one current manuscript.`);
    }
    const currentContent = views[0]!.currentContent;
    const currentContentSha256 = views[0]!.candidate.currentContentSha256;
    if (sha256(currentContent) !== currentContentSha256) {
      throw new Error(`Review packet chapter ${chapterNumber} current manuscript SHA-256 mismatch.`);
    }

    const candidates = views
      .map(({ candidate, candidateContent, report }) => {
        if (sha256(candidateContent) !== candidate.candidateContentSha256) {
          throw new Error(`Review candidate ${candidate.candidateId} body SHA-256 mismatch.`);
        }
        return FireflyReviewCandidateSchema.parse({
          id: candidate.candidateId,
          status: report.status,
          body: candidateContent,
          sha256: candidate.candidateContentSha256,
          preparedAt: candidate.preparedAt,
          commercialScore: candidate.commercialScore?.overall ?? null,
          commercialEvaluation: candidate.commercialEvaluation ?? null,
          review: {
            status: report.status,
            retained: report.retained,
            variedSurface: report.variedSurface,
            linkedConsequences: report.linkedConsequences,
            exactSurfaceMatches: report.exactSurfaceMatches,
          },
        });
      })
      .sort((left, right) => right.preparedAt.localeCompare(left.preparedAt) || left.id.localeCompare(right.id));

    const scored = candidates.filter((candidate) => candidate.commercialScore !== null)
      .sort((left, right) => (right.commercialScore ?? 0) - (left.commercialScore ?? 0));
    const recommendation = scored[0]
      ? {
          candidateId: scored[0].id,
          reason: `상업성 점수 ${scored[0].commercialScore!.toFixed(1)}로 현재 후보 중 가장 높음. 사람 검토 전에는 정본이 아님.`,
        }
      : null;

    const body = {
      source: { system: "inkos" as const, bookId: input.book.id, sourceRevision: input.sourceRevision },
      work: {
        id: input.book.id,
        title: input.book.title,
        genre: input.book.genre,
        status: input.book.status,
        targetChapters: input.book.targetChapters,
      },
      artifact: {
        id: `chapter-${String(chapterNumber).padStart(4, "0")}`,
        kind: "chapter" as const,
        chapterNumber,
        title: chapter.title,
        status: chapter.status,
        currentContent,
        currentContentSha256,
      },
      candidates,
      recommendation,
      actions: ["approve", "polish", "hold", "reject"] as const,
      authority: {
        canon: "inkos" as const,
        decisionSurface: "storyyard" as const,
        apply: "inkos" as const,
        reverseSync: false as const,
      },
    };
    const packetSha256 = sha256(stablePayload(body));
    packets.push(FireflyReviewPacketSchema.parse({
      schemaVersion: "firefly_review_packet/v1",
      packetId: `frp-${packetSha256.slice(0, 24)}`,
      packetSha256,
      generatedAt,
      ...body,
    }));
  }

  return packets;
}
