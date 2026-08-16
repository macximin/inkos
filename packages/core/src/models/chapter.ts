import { z } from "zod";
import { ArcEpisodeRoleSchema, ArcIdSchema } from "../arc/schema.js";
import {
  AnchorDetailLevelSchema,
  AnchorStateSchema,
  StableRailIdSchema,
} from "../arc/rail-schema.js";
import { LengthTelemetrySchema } from "./length-governance.js";

export const ChapterStatusSchema = z.enum([
  "card-generated",
  "drafting",
  "drafted",
  "auditing",
  "audit-passed",
  "audit-failed",
  "state-degraded",
  "revising",
  "ready-for-review",
  "approved",
  "rejected",
  "published",
  "imported",
]);
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;

/**
 * Immutable local slice of the optional A-Rail/B-Rail plan used alongside an
 * active Arc. The full future route is deliberately not copied into a
 * Chapter; only the active B, its target Anchor, and the next provisional B's
 * durable fields are retained.
 */
export const ChapterStoryRailProvenanceSchema = z.object({
  planUpdatedAt: z.string().datetime(),
  anchor: z.object({
    id: StableRailIdSchema,
    routeOrder: z.number().int().min(0),
    title: z.string().min(1),
    detailLevel: AnchorDetailLevelSchema,
    state: AnchorStateSchema,
    entryState: z.string(),
    trigger: z.string(),
    irreversibleChange: z.string(),
    humanAftermath: z.string(),
    readerDebt: z.string(),
    payoffAxis: z.string(),
    nextPressure: z.string(),
  }).strict(),
  activeB: z.object({
    bId: StableRailIdSchema,
    routeOrder: z.number().int().min(0),
    status: z.literal("active"),
    targetAnchorId: StableRailIdSchema,
    narrativeFunction: z.string(),
    payoffAxis: z.string(),
    carriedReaderDebt: z.string(),
    contrastRequirement: z.string(),
  }).strict(),
  nextB: z.object({
    bId: StableRailIdSchema,
    routeOrder: z.number().int().min(0),
    status: z.literal("provisional"),
    targetAnchorId: StableRailIdSchema,
    narrativeFunction: z.string(),
    payoffAxis: z.string(),
    carriedReaderDebt: z.string(),
    contrastRequirement: z.string(),
  }).strict().optional(),
}).strict();
export type ChapterStoryRailProvenance = z.infer<typeof ChapterStoryRailProvenanceSchema>;

/**
 * Immutable snapshot of the optional Arc context that was supplied when a
 * chapter was generated. Chapters remain owned directly by the book; this is
 * provenance only and never becomes a required parent relationship.
 */
export const ChapterArcProvenanceSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  arcId: ArcIdSchema,
  arcUpdatedAt: z.string().datetime(),
  arcTitle: z.string().min(1),
  chapterNumber: z.number().int().min(1),
  episodeRole: ArcEpisodeRoleSchema,
  openingState: z.string(),
  promise: z.string().min(1),
  goal: z.string().min(1),
  obstacle: z.string(),
  pressure: z.string(),
  turn: z.string(),
  payoff: z.string(),
  irreversibleChange: z.string(),
  nextHook: z.string(),
  beats: z.array(z.string().min(1)).min(1),
  endingHook: z.string(),
  characterChanges: z.array(z.string()),
  relationshipChanges: z.array(z.string()),
  worldChanges: z.array(z.string()),
  hookOperations: z.array(z.string()),
  mustKeep: z.array(z.string()),
  mustAvoid: z.array(z.string()),
  styleEmphasis: z.array(z.string()),
  sourceForecast: z.object({
    forecastId: z.string().min(1),
    branchId: z.string().min(1),
  }).optional(),
  storyRail: ChapterStoryRailProvenanceSchema.optional(),
});
export type ChapterArcProvenance = z.infer<typeof ChapterArcProvenanceSchema>;

export const ChapterMetaSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  status: ChapterStatusSchema,
  wordCount: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditIssues: z.array(z.string()).default([]),
  lengthWarnings: z.array(z.string()).default([]),
  reviewNote: z.string().optional(),
  detectionScore: z.number().min(0).max(1).optional(),
  detectionProvider: z.string().optional(),
  detectedAt: z.string().datetime().optional(),
  lengthTelemetry: LengthTelemetrySchema.optional(),
  arcProvenance: ChapterArcProvenanceSchema.optional(),
  tokenUsage: z.object({
    promptTokens: z.number().int().default(0),
    completionTokens: z.number().int().default(0),
    totalTokens: z.number().int().default(0),
  }).optional(),
}).superRefine((chapter, ctx) => {
  if (chapter.arcProvenance && chapter.arcProvenance.chapterNumber !== chapter.number) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["arcProvenance", "chapterNumber"],
      message: "Arc provenance must reference the same chapter number",
    });
  }
});

export type ChapterMeta = z.infer<typeof ChapterMetaSchema>;
