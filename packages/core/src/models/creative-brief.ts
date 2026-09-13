import { z } from "zod";
import { isSafeBookId } from "../utils/book-id.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const RelativePath = z.string().min(1).max(1000).refine((value) => (
  !value.includes("\\") && !value.includes("\0") && !value.startsWith("/")
  && value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
), "Expected a normalized Book-relative path");

export const CREATIVE_BRIEF_DOCUMENT_PATHS = [
  "story/author_intent.md", "story/current_focus.md", "story/brief.md",
] as const;
export const CREATIVE_BRIEF_SOURCES_PATH = "story/creative_brief.sources.json";
export const CreativeBriefCategorySchema = z.enum([
  "reader-promise", "personal-desire", "preference", "avoid", "preserve", "voice", "current-focus", "direction",
]);
export type CreativeBriefCategory = z.infer<typeof CreativeBriefCategorySchema>;

const ChapterScope = z.object({
  fromChapter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  throughChapter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine((scope) => scope.fromChapter === undefined || scope.throughChapter === undefined
  || scope.fromChapter <= scope.throughChapter, "Chapter scope is reversed");
export type CreativeBriefChapterScope = z.infer<typeof ChapterScope>;

/** A source binding proves exact bytes, not owner adoption or hard-rule authority. */
export const CreativeBriefSourcesSchema = z.object({
  schemaVersion: z.literal("book-creative-brief-sources/v1"),
  bookId: z.string().refine(isSafeBookId, "Invalid Book id"),
  documentScopes: z.array(z.object({
    path: z.enum(CREATIVE_BRIEF_DOCUMENT_PATHS),
    sha256: Sha256,
    scope: ChapterScope,
  }).strict()).max(3).default([]),
  sources: z.array(z.object({
    id: Id,
    path: RelativePath,
    sha256: Sha256,
    kind: z.enum(["preference-evidence", "reference-analysis"]),
    scope: ChapterScope.optional(),
    reviewedText: z.array(z.object({
      path: RelativePath,
      sha256: Sha256,
      start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      quoteSha256: Sha256,
    }).strict().refine((value) => value.end > value.start, "Reviewed text range is reversed")).min(1).max(4).optional(),
    selections: z.array(z.object({
      category: CreativeBriefCategorySchema,
      start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      quoteSha256: Sha256,
    }).strict().refine((value) => value.end > value.start, "Quote range is reversed")).min(1).max(32),
  }).strict()).max(32),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.sources.map((source) => source.id)).size !== manifest.sources.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "Duplicate source IDs" });
  }
  if (new Set(manifest.documentScopes.map((source) => source.path)).size !== manifest.documentScopes.length) {
    context.addIssue({ code: "custom", path: ["documentScopes"], message: "Duplicate document scopes" });
  }
  for (const source of manifest.sources) {
    if (source.kind === "preference-evidence" && !source.reviewedText?.length) {
      context.addIssue({ code: "custom", path: ["sources"], message: "Preference evidence requires the exact reviewed text" });
    }
    if (source.id === "source-manifest") {
      context.addIssue({ code: "custom", path: ["sources"], message: "Reserved source ID" });
    }
    if ([...CREATIVE_BRIEF_DOCUMENT_PATHS, CREATIVE_BRIEF_SOURCES_PATH].includes(source.path)) {
      context.addIssue({ code: "custom", path: ["sources"], message: "Bound sources cannot alias control documents" });
    }
  }
});
export type CreativeBriefSources = z.infer<typeof CreativeBriefSourcesSchema>;

export interface CreativeBriefSourceReceipt {
  readonly id: string;
  readonly path: string;
  readonly kind: "book-direction-document" | "preference-evidence" | "reference-analysis" | "source-manifest";
  readonly status: "current" | "missing" | "unreadable" | "invalid" | "stale" | "out-of-scope" | "scope-unresolved";
  readonly sha256?: string;
  readonly expectedSha256?: string;
  readonly scope?: CreativeBriefChapterScope;
  readonly change: "not-compared" | "unchanged" | "added" | "changed";
}

export interface CreativeBriefEntry {
  readonly id: string;
  readonly category: CreativeBriefCategory;
  readonly quote: string;
  readonly sourceId: string;
  readonly sourceKind: Exclude<CreativeBriefSourceReceipt["kind"], "source-manifest">;
  readonly path: string;
  readonly sourceSha256: string;
  readonly coordinate: "original-utf8-byte";
  readonly start: number;
  readonly end: number;
  readonly quoteSha256: string;
  readonly scope?: CreativeBriefChapterScope;
  readonly reviewedText?: ReadonlyArray<{
    readonly quote: string;
    readonly path: string;
    readonly sourceSha256: string;
    readonly start: number;
    readonly end: number;
    readonly quoteSha256: string;
  }>;
  readonly authority: "advisory";
}

export interface BookCreativeBrief {
  readonly schemaVersion: "book-creative-brief/v1";
  readonly bookId: string;
  readonly chapterNumber?: number;
  readonly authority: "advisory";
  readonly entries: ReadonlyArray<CreativeBriefEntry>;
  readonly unknownCategories: ReadonlyArray<CreativeBriefCategory>;
  readonly sources: ReadonlyArray<CreativeBriefSourceReceipt>;
  readonly omitted: ReadonlyArray<{ readonly sourceId: string; readonly entryId?: string; readonly reason: string }>;
  readonly projectionSha256: string;
}

export interface BookCreativeBriefReceipt {
  readonly schemaVersion: "book-creative-brief-context/v1";
  readonly bookId: string;
  readonly chapterNumber?: number;
  readonly projectionSha256: string;
  readonly sources: ReadonlyArray<CreativeBriefSourceReceipt>;
  readonly selectedEntryIds: ReadonlyArray<string>;
  readonly omittedEntryIds: ReadonlyArray<string>;
  readonly unknownCategories: ReadonlyArray<CreativeBriefCategory>;
  readonly renderedSha256: string;
  readonly characters: number;
  readonly estimatedTokens: number;
  readonly maxCharacters: number;
  readonly maxInputTokens?: number;
  readonly modelCalls: 0;
  readonly humanReviewRequired: false;
  readonly autoEnforcement: false;
}

export interface BookCreativeBriefContext {
  readonly projection: BookCreativeBrief;
  readonly rendered: string;
  readonly receipt: BookCreativeBriefReceipt;
}
