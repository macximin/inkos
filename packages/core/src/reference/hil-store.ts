import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { ReferenceTransformationSchema } from "./schema.js";

const CandidateStatusSchema = z.enum(["prepared", "applied", "rejected"]);

const CommercialEvaluationSchema = z.object({
  openingPressure: z.number().min(0).max(100),
  protagonistAgency: z.number().min(0).max(100),
  resistanceQuality: z.number().min(0).max(100),
  visiblePayoff: z.number().min(0).max(100),
  endingPropulsion: z.number().min(0).max(100),
  referenceEngineRetention: z.number().min(0).max(100),
  transformationIntegrity: z.number().min(0).max(100),
  styleFidelity: z.number().min(0).max(100),
}).strict();
export type CommercialEvaluation = z.infer<typeof CommercialEvaluationSchema>;

const CandidateMetaSchema = z.object({
  version: z.literal(1),
  kind: z.literal("reference-transformation-candidate"),
  candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u),
  chapterNumber: z.number().int().min(1),
  status: CandidateStatusSchema,
  currentContentSha256: z.string().length(64),
  candidateContentSha256: z.string().length(64),
  referencePackId: z.string().min(1),
  sourceSegmentIds: z.array(z.string().min(1)).min(1),
  commercialEvaluation: CommercialEvaluationSchema.optional(),
  preparedAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
}).strict();
export type ReferenceTransformationCandidate = z.infer<typeof CandidateMetaSchema>;

const ComparisonReportSchema = z.object({
  version: z.literal(1),
  kind: z.literal("transformation-comparison"),
  chapterNumber: z.number().int().min(1),
  candidateId: z.string().min(1),
  status: z.enum(["unreviewed", "accepted", "polish-requested", "rejected"]),
  referencePackId: z.string().min(1),
  spineReference: z.string().min(1),
  retained: z.array(z.string()),
  variedSurface: z.array(z.string()),
  linkedConsequences: z.array(z.string()),
  sourceMappings: z.array(z.object({
    segmentId: z.string(),
    sourceArcIds: z.array(z.string()),
    sourceChapterIds: z.array(z.number()),
    targetRailAnchorIds: z.array(z.string()),
    targetArcIds: z.array(z.string()),
  }).strict()),
  exactSurfaceMatches: z.array(z.object({
    tokenCount: z.number().int().min(1),
    text: z.string().min(1),
  }).strict()),
  automaticRewrite: z.literal(false),
  similarityPenalty: z.literal(false),
  createdAt: z.string().datetime(),
}).strict();
export type TransformationComparisonReport = z.infer<typeof ComparisonReportSchema>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findExactMatches(candidate: string, sources: ReadonlyArray<string>, width = 12) {
  const tokenize = (value: string) => value.match(/[가-힣A-Za-z0-9]+/gu) ?? [];
  const candidateTokens = tokenize(candidate);
  const sourceShingles = new Map<string, string>();
  for (const source of sources) {
    const tokens = tokenize(source);
    for (let index = 0; index <= tokens.length - width; index += 1) {
      const text = tokens.slice(index, index + width).join(" ");
      sourceShingles.set(text, text);
    }
  }
  const matches = new Map<string, { tokenCount: number; text: string }>();
  for (let index = 0; index <= candidateTokens.length - width; index += 1) {
    const text = candidateTokens.slice(index, index + width).join(" ");
    if (sourceShingles.has(text)) matches.set(text, { tokenCount: width, text });
  }
  return [...matches.values()].slice(0, 100);
}

export class ReferenceTransformationHilStore {
  constructor(
    private readonly bookDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  candidateDir(chapterNumber: number): string {
    return join("chapters", ".candidates", String(chapterNumber));
  }

  reviewDir(chapterNumber: number): string {
    return join("chapters", ".reviews", String(chapterNumber));
  }

  async prepare(input: {
    readonly chapterNumber: number;
    readonly candidateId: string;
    readonly currentContent: string;
    readonly candidateContent: string;
    readonly transformation: unknown;
    readonly sourceTexts: ReadonlyArray<string>;
    readonly commercialEvaluation?: CommercialEvaluation;
  }): Promise<{ candidate: ReferenceTransformationCandidate; report: TransformationComparisonReport }> {
    const transformation = ReferenceTransformationSchema.parse(input.transformation);
    const timestamp = this.now().toISOString();
    const candidate = CandidateMetaSchema.parse({
      version: 1,
      kind: "reference-transformation-candidate",
      candidateId: input.candidateId,
      chapterNumber: input.chapterNumber,
      status: "prepared",
      currentContentSha256: sha256(input.currentContent),
      candidateContentSha256: sha256(input.candidateContent),
      referencePackId: transformation.referencePackId,
      sourceSegmentIds: transformation.sourceSegments.map((segment) => segment.id),
      commercialEvaluation: input.commercialEvaluation,
      preparedAt: timestamp,
    });
    const report = ComparisonReportSchema.parse({
      version: 1,
      kind: "transformation-comparison",
      chapterNumber: input.chapterNumber,
      candidateId: input.candidateId,
      status: "unreviewed",
      referencePackId: transformation.referencePackId,
      spineReference: transformation.spineReference,
      retained: [...new Set(transformation.sourceSegments.flatMap((segment) => segment.retain))],
      variedSurface: [...new Set(transformation.sourceSegments.flatMap((segment) => segment.varySurface))],
      linkedConsequences: [...new Set(transformation.sourceSegments.flatMap((segment) => segment.linkedConsequences))],
      sourceMappings: transformation.sourceSegments.map((segment) => ({
        segmentId: segment.id,
        sourceArcIds: segment.sourceArcIds,
        sourceChapterIds: segment.sourceChapterIds,
        targetRailAnchorIds: segment.targetRailAnchorIds,
        targetArcIds: segment.targetArcIds,
      })),
      exactSurfaceMatches: findExactMatches(input.candidateContent, input.sourceTexts),
      automaticRewrite: false,
      similarityPenalty: false,
      createdAt: timestamp,
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.md`),
          content: input.candidateContent,
        },
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.json`),
          content: `${JSON.stringify(candidate, null, 2)}\n`,
        },
        {
          relativePath: join(this.reviewDir(input.chapterNumber), "transformation-comparison.json"),
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
      ],
    });
    return { candidate, report };
  }

  async apply(input: {
    readonly chapterNumber: number;
    readonly candidateId: string;
    readonly targetChapterRelativePath: string;
  }): Promise<ReferenceTransformationCandidate> {
    const metaPath = join(this.bookDir, this.candidateDir(input.chapterNumber), `${input.candidateId}.json`);
    const bodyPath = join(this.bookDir, this.candidateDir(input.chapterNumber), `${input.candidateId}.md`);
    const candidate = CandidateMetaSchema.parse(JSON.parse(await readFile(metaPath, "utf8")));
    if (candidate.status !== "prepared") throw new Error(`Candidate is already ${candidate.status}.`);
    const [candidateBody, currentBody] = await Promise.all([
      readFile(bodyPath, "utf8"),
      readFile(join(this.bookDir, input.targetChapterRelativePath), "utf8"),
    ]);
    if (sha256(candidateBody) !== candidate.candidateContentSha256) {
      throw new Error("Candidate body SHA-256 mismatch.");
    }
    if (sha256(currentBody) !== candidate.currentContentSha256) {
      throw new Error("Current chapter changed after candidate preparation; prepare a new comparison.");
    }
    const decided = CandidateMetaSchema.parse({
      ...candidate,
      status: "applied",
      decidedAt: this.now().toISOString(),
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        {
          relativePath: join(this.reviewDir(input.chapterNumber), `${input.candidateId}-pre-apply.md`),
          content: currentBody,
        },
        { relativePath: input.targetChapterRelativePath, content: candidateBody },
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.json`),
          content: `${JSON.stringify(decided, null, 2)}\n`,
        },
      ],
    });
    return decided;
  }

  async reject(chapterNumber: number, candidateId: string): Promise<ReferenceTransformationCandidate> {
    const relative = join(this.candidateDir(chapterNumber), `${candidateId}.json`);
    const candidate = CandidateMetaSchema.parse(
      JSON.parse(await readFile(join(this.bookDir, relative), "utf8")),
    );
    if (candidate.status !== "prepared") throw new Error(`Candidate is already ${candidate.status}.`);
    const rejected = CandidateMetaSchema.parse({
      ...candidate,
      status: "rejected",
      decidedAt: this.now().toISOString(),
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [{ relativePath: relative, content: `${JSON.stringify(rejected, null, 2)}\n` }],
    });
    return rejected;
  }
}

export { CandidateMetaSchema as ReferenceTransformationCandidateSchema, ComparisonReportSchema as TransformationComparisonReportSchema };
