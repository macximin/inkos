import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ChapterMetaSchema } from "../models/chapter.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { safeNonSymlinkChildPath } from "../utils/path-safety.js";
import { ReferenceTransformationSchema } from "./schema.js";

const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
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

export const COMMERCIAL_EVALUATION_FORMULA = "dopamine70-reference30-v1" as const;

export function scoreCommercialEvaluation(evaluation: CommercialEvaluation): number {
  const front = (
    evaluation.openingPressure
    + evaluation.protagonistAgency
    + evaluation.resistanceQuality
    + evaluation.visiblePayoff
    + evaluation.endingPropulsion
  ) / 5;
  const reference = (
    evaluation.referenceEngineRetention
    + evaluation.transformationIntegrity
    + evaluation.styleFidelity
  ) / 3;
  return Math.round(((front * 0.7) + (reference * 0.3)) * 10) / 10;
}

const CandidateMetaSchema = z.object({
  version: z.literal(1),
  kind: z.literal("reference-transformation-candidate"),
  candidateId: z.string().regex(CANDIDATE_ID_PATTERN),
  chapterNumber: z.number().int().min(1),
  status: CandidateStatusSchema,
  currentContentSha256: z.string().length(64),
  candidateContentSha256: z.string().length(64),
  referencePackId: z.string().min(1),
  sourceSegmentIds: z.array(z.string().min(1)).min(1),
  commercialEvaluation: CommercialEvaluationSchema.optional(),
  commercialScore: z.object({
    formula: z.literal(COMMERCIAL_EVALUATION_FORMULA),
    overall: z.number().min(0).max(100),
  }).strict().optional(),
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
  decidedAt: z.string().datetime().optional(),
}).strict();
export type TransformationComparisonReport = z.infer<typeof ComparisonReportSchema>;

export interface ReferenceTransformationHilCandidateView {
  readonly candidate: ReferenceTransformationCandidate;
  readonly report: TransformationComparisonReport;
  readonly currentContent: string;
  readonly candidateContent: string;
  readonly currentChapterMatchesPreparation: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCandidateLocator(chapterNumber: number, candidateId?: string): void {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error(`Invalid Reference HIL chapter number: ${chapterNumber}.`);
  }
  if (candidateId !== undefined && !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error(`Invalid Reference HIL candidate id: ${JSON.stringify(candidateId)}.`);
  }
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
    assertCandidateLocator(chapterNumber);
    return join("chapters", ".candidates", String(chapterNumber));
  }

  reviewDir(chapterNumber: number): string {
    assertCandidateLocator(chapterNumber);
    return join("chapters", ".reviews", String(chapterNumber));
  }

  comparisonReportPath(chapterNumber: number, candidateId: string): string {
    assertCandidateLocator(chapterNumber, candidateId);
    return join(this.reviewDir(chapterNumber), `${candidateId}-transformation-comparison.json`);
  }

  latestComparisonReportPath(chapterNumber: number): string {
    return join(this.reviewDir(chapterNumber), "transformation-comparison.json");
  }

  async list(): Promise<ReadonlyArray<ReferenceTransformationHilCandidateView>> {
    const root = join(this.bookDir, "chapters", ".candidates");
    const chapterDirs = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw error;
    });
    const results: ReferenceTransformationHilCandidateView[] = [];
    for (const chapterDir of chapterDirs) {
      if (!chapterDir.isDirectory() || !/^\d+$/.test(chapterDir.name)) continue;
      const chapterNumber = Number.parseInt(chapterDir.name, 10);
      const files = await readdir(join(root, chapterDir.name)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
        throw error;
      });
      for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
        const candidateId = file.slice(0, -".json".length);
        results.push(await this.get(chapterNumber, candidateId));
      }
    }
    return results.sort((left, right) =>
      right.candidate.preparedAt.localeCompare(left.candidate.preparedAt)
      || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
  }

  async get(chapterNumber: number, candidateId: string): Promise<ReferenceTransformationHilCandidateView> {
    assertCandidateLocator(chapterNumber, candidateId);
    const candidate = CandidateMetaSchema.parse(JSON.parse(await readFile(
      join(this.bookDir, this.candidateDir(chapterNumber), `${candidateId}.json`),
      "utf8",
    )));
    const [report, candidateContent, currentContent] = await Promise.all([
      this.loadCandidateReportForDisplay(chapterNumber, candidateId),
      readFile(join(this.bookDir, this.candidateDir(chapterNumber), `${candidateId}.md`), "utf8"),
      this.readCurrentChapter(chapterNumber),
    ]);
    return {
      candidate,
      report,
      currentContent,
      candidateContent,
      currentChapterMatchesPreparation: sha256(currentContent) === candidate.currentContentSha256,
    };
  }

  async prepare(input: {
    readonly chapterNumber: number;
    readonly candidateId: string;
    readonly currentContent: string;
    readonly candidateContent: string;
    readonly transformation: unknown;
    readonly sourceSegmentIds?: ReadonlyArray<string>;
    readonly sourceTexts: ReadonlyArray<string>;
    readonly commercialEvaluation?: CommercialEvaluation;
  }): Promise<{ candidate: ReferenceTransformationCandidate; report: TransformationComparisonReport }> {
    const transformation = ReferenceTransformationSchema.parse(input.transformation);
    const selectedSegments = input.sourceSegmentIds
      ? input.sourceSegmentIds.map((segmentId) => {
          const segment = transformation.sourceSegments.find((candidate) => candidate.id === segmentId);
          if (!segment) throw new Error(`Reference transformation segment ${JSON.stringify(segmentId)} is missing.`);
          return segment;
        })
      : transformation.sourceSegments;
    if (selectedSegments.length === 0) throw new Error("Reference HIL requires at least one source segment.");
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
      sourceSegmentIds: selectedSegments.map((segment) => segment.id),
      commercialEvaluation: input.commercialEvaluation,
      commercialScore: input.commercialEvaluation
        ? {
            formula: COMMERCIAL_EVALUATION_FORMULA,
            overall: scoreCommercialEvaluation(input.commercialEvaluation),
          }
        : undefined,
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
      retained: [...new Set(selectedSegments.flatMap((segment) => segment.retain))],
      variedSurface: [...new Set(selectedSegments.flatMap((segment) => segment.varySurface))],
      linkedConsequences: [...new Set(selectedSegments.flatMap((segment) => segment.linkedConsequences))],
      sourceMappings: selectedSegments.map((segment) => ({
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
    const priorLatestArchive = await this.archiveLatestReportIfNeeded(input.chapterNumber, input.candidateId);
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        ...priorLatestArchive,
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.md`),
          content: input.candidateContent,
        },
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.json`),
          content: `${JSON.stringify(candidate, null, 2)}\n`,
        },
        {
          relativePath: this.comparisonReportPath(input.chapterNumber, input.candidateId),
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        {
          relativePath: this.latestComparisonReportPath(input.chapterNumber),
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
    assertCandidateLocator(input.chapterNumber, input.candidateId);
    const metaPath = join(this.bookDir, this.candidateDir(input.chapterNumber), `${input.candidateId}.json`);
    const bodyPath = join(this.bookDir, this.candidateDir(input.chapterNumber), `${input.candidateId}.md`);
    const expectedPrefix = String(input.chapterNumber).padStart(4, "0");
    const normalizedTarget = input.targetChapterRelativePath.replaceAll("\\", "/");
    const targetParts = normalizedTarget.split("/");
    if (
      !normalizedTarget.startsWith("chapters/")
      || targetParts.length !== 2
      || targetParts.includes("..")
      || !targetParts[1]?.startsWith(expectedPrefix)
      || !targetParts[1]?.endsWith(".md")
    ) {
      throw new Error(`Reference HIL target does not match chapter ${input.chapterNumber}.`);
    }
    const targetChapterPath = await safeNonSymlinkChildPath(this.bookDir, input.targetChapterRelativePath);
    const candidate = CandidateMetaSchema.parse(JSON.parse(await readFile(metaPath, "utf8")));
    if (candidate.status !== "prepared") throw new Error(`Candidate is already ${candidate.status}.`);
    const [candidateBody, currentBody, rawIndex] = await Promise.all([
      readFile(bodyPath, "utf8"),
      readFile(targetChapterPath, "utf8"),
      readFile(join(this.bookDir, "chapters", "index.json"), "utf8"),
    ]);
    if (sha256(candidateBody) !== candidate.candidateContentSha256) {
      throw new Error("Candidate body SHA-256 mismatch.");
    }
    if (sha256(currentBody) !== candidate.currentContentSha256) {
      throw new Error("Current chapter changed after candidate preparation; prepare a new comparison.");
    }
    const index = ChapterMetaSchema.array().parse(JSON.parse(rawIndex));
    const targetIndex = index.findIndex((chapter) => chapter.number === input.chapterNumber);
    if (targetIndex < 0) throw new Error(`Chapter ${input.chapterNumber} is missing from the chapter index.`);
    const latestChapter = Math.max(...index.map((chapter) => chapter.number));
    if (latestChapter !== input.chapterNumber) {
      throw new Error(
        `Reference HIL can only replace the latest persisted chapter (latest is ${latestChapter}).`,
      );
    }
    const decided = CandidateMetaSchema.parse({
      ...candidate,
      status: "applied",
      decidedAt: this.now().toISOString(),
    });
    const report = await this.loadCandidateReport(input.chapterNumber, input.candidateId);
    const decidedReport = ComparisonReportSchema.parse({
      ...report,
      status: "accepted",
      decidedAt: decided.decidedAt,
    });
    const updatedIndex = index.map((chapter) => chapter.number === input.chapterNumber
      ? ChapterMetaSchema.parse({
          ...chapter,
          status: "drafted",
          updatedAt: decided.decidedAt,
          auditIssues: [],
          reviewNote: undefined,
          pendingAuditReason: "hil-applied-pending-resync",
          futureAdvantageExecution: undefined,
        })
      : chapter);
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        {
          relativePath: join(this.reviewDir(input.chapterNumber), `${input.candidateId}-pre-apply.md`),
          content: currentBody,
        },
        { relativePath: input.targetChapterRelativePath, content: candidateBody },
        {
          relativePath: join("chapters", "index.json"),
          content: `${JSON.stringify(updatedIndex, null, 2)}\n`,
        },
        {
          relativePath: join(this.candidateDir(input.chapterNumber), `${input.candidateId}.json`),
          content: `${JSON.stringify(decided, null, 2)}\n`,
        },
        {
          relativePath: this.comparisonReportPath(input.chapterNumber, input.candidateId),
          content: `${JSON.stringify(decidedReport, null, 2)}\n`,
        },
        {
          relativePath: this.latestComparisonReportPath(input.chapterNumber),
          content: `${JSON.stringify(decidedReport, null, 2)}\n`,
        },
      ],
    });
    return decided;
  }

  async requestPolish(
    chapterNumber: number,
    candidateId: string,
  ): Promise<TransformationComparisonReport> {
    assertCandidateLocator(chapterNumber, candidateId);
    const candidate = CandidateMetaSchema.parse(JSON.parse(await readFile(
      join(this.bookDir, this.candidateDir(chapterNumber), `${candidateId}.json`),
      "utf8",
    )));
    if (candidate.status !== "prepared") throw new Error(`Candidate is already ${candidate.status}.`);
    const report = await this.loadCandidateReport(chapterNumber, candidateId);
    const polished = ComparisonReportSchema.parse({ ...report, status: "polish-requested" });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        {
          relativePath: this.comparisonReportPath(chapterNumber, candidateId),
          content: `${JSON.stringify(polished, null, 2)}\n`,
        },
        {
          relativePath: this.latestComparisonReportPath(chapterNumber),
          content: `${JSON.stringify(polished, null, 2)}\n`,
        },
      ],
    });
    return polished;
  }

  async reject(chapterNumber: number, candidateId: string): Promise<ReferenceTransformationCandidate> {
    assertCandidateLocator(chapterNumber, candidateId);
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
    const report = await this.loadCandidateReport(chapterNumber, candidateId);
    const rejectedReport = ComparisonReportSchema.parse({
      ...report,
      status: "rejected",
      decidedAt: rejected.decidedAt,
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        { relativePath: relative, content: `${JSON.stringify(rejected, null, 2)}\n` },
        {
          relativePath: this.comparisonReportPath(chapterNumber, candidateId),
          content: `${JSON.stringify(rejectedReport, null, 2)}\n`,
        },
        {
          relativePath: this.latestComparisonReportPath(chapterNumber),
          content: `${JSON.stringify(rejectedReport, null, 2)}\n`,
        },
      ],
    });
    return rejected;
  }

  private async loadCandidateReport(
    chapterNumber: number,
    candidateId: string,
  ): Promise<TransformationComparisonReport> {
    const dedicated = join(this.bookDir, this.comparisonReportPath(chapterNumber, candidateId));
    let raw: string;
    try {
      raw = await readFile(dedicated, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      raw = await readFile(join(this.bookDir, this.latestComparisonReportPath(chapterNumber)), "utf8");
    }
    const report = ComparisonReportSchema.parse(JSON.parse(raw));
    if (report.candidateId !== candidateId) {
      throw new Error(`Comparison report belongs to candidate ${JSON.stringify(report.candidateId)}, not ${JSON.stringify(candidateId)}.`);
    }
    if (report.status !== "unreviewed" && report.status !== "polish-requested") {
      throw new Error(`Comparison report is already ${report.status}.`);
    }
    return report;
  }

  private async loadCandidateReportForDisplay(
    chapterNumber: number,
    candidateId: string,
  ): Promise<TransformationComparisonReport> {
    return ComparisonReportSchema.parse(JSON.parse(await readFile(
      join(this.bookDir, this.comparisonReportPath(chapterNumber, candidateId)),
      "utf8",
    )));
  }

  private async readCurrentChapter(chapterNumber: number): Promise<string> {
    const files = await readdir(join(this.bookDir, "chapters"));
    const prefix = String(chapterNumber).padStart(4, "0");
    const matches = files.filter((file) => file.startsWith(prefix) && file.endsWith(".md"));
    if (matches.length !== 1) {
      throw new Error(`Chapter ${chapterNumber} needs exactly one manuscript file; found ${matches.length}.`);
    }
    return readFile(await safeNonSymlinkChildPath(this.bookDir, join("chapters", matches[0]!)), "utf8");
  }

  private async archiveLatestReportIfNeeded(
    chapterNumber: number,
    incomingCandidateId: string,
  ): Promise<Array<{ relativePath: string; content: string }>> {
    let raw: string;
    try {
      raw = await readFile(join(this.bookDir, this.latestComparisonReportPath(chapterNumber)), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw error;
    }
    const report = ComparisonReportSchema.parse(JSON.parse(raw));
    if (report.candidateId === incomingCandidateId) return [];
    const dedicatedRelative = this.comparisonReportPath(report.chapterNumber, report.candidateId);
    try {
      await readFile(join(this.bookDir, dedicatedRelative), "utf8");
      return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
    return [{ relativePath: dedicatedRelative, content: `${JSON.stringify(report, null, 2)}\n` }];
  }
}

export { CandidateMetaSchema as ReferenceTransformationCandidateSchema, ComparisonReportSchema as TransformationComparisonReportSchema };
