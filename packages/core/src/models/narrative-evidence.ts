import { z } from "zod";
import { isSafeBookId } from "../utils/book-id.js";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Evidence = z.string().min(1).max(1600).refine((text) => text.trim().length > 0 && !text.includes("\0"), "Evidence must contain text");
const Character = z.string().min(1).max(120).refine((text) => text.trim() === text && !/[\r\n\0]/u.test(text), "Character must be an exact single-line name");
const QuoteFields = { evidence: Evidence, occurrence: z.number().int().nonnegative().max(63).optional() };

/** These are extraction labels, not an objective truth or knowledge database. */
export const NarrativeEvidenceEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reader-disclosure"), informationId: Id, ...QuoteFields }).strict(),
  z.object({ kind: z.literal("character-awareness"), informationId: Id, character: Character,
    awareness: z.enum(["aware", "unaware", "belief"]), ...QuoteFields }).strict(),
  z.object({ kind: z.literal("reward"), threadId: Id, character: Character,
    stage: z.enum(["promise", "acquisition", "experience", "next-desire"]), ...QuoteFields }).strict(),
]);
export type NarrativeEvidenceEntry = z.infer<typeof NarrativeEvidenceEntrySchema>;

export const NarrativeEvidenceDiagnosticSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  reason: z.enum(["optional-missing", "invalid-array", "entry-count-limit", "invalid-entry", "quote-not-found",
    "ambiguous-quote", "invalid-occurrence", "character-not-in-quote", "thread-not-admitted", "duplicate-entry"]),
}).strict();
export type NarrativeEvidenceDiagnostic = z.infer<typeof NarrativeEvidenceDiagnosticSchema>;

export const StoredNarrativeEvidenceSchema = z.object({
  id: z.string().regex(/^narrative:[a-f0-9]{32}$/),
  entry: NarrativeEvidenceEntrySchema,
  sourceChapter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chapterTextSha256: Sha256,
  quote: z.object({ coordinate: z.literal("original-utf8-byte"), relativeTo: z.literal("chapter-body"),
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), sha256: Sha256,
  }).strict().refine((quote) => quote.end > quote.start, "Quote range must be nonempty"),
}).strict();
export type StoredNarrativeEvidence = z.infer<typeof StoredNarrativeEvidenceSchema>;

export const NarrativeEvidenceChapterSchema = z.object({
  schemaVersion: z.literal("narrative-evidence-chapter/v1"),
  bookId: z.string().refine(isSafeBookId, "Invalid Book id"),
  chapterNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  chapterPath: z.string().max(1000).refine((path) => path.startsWith("chapters/") && path.endsWith(".md")
    && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part && part !== "." && part !== ".."), "Expected a Book-relative chapter Markdown path"),
  chapterFileSha256: Sha256,
  chapterTextSha256: Sha256,
  chapterBodyStart: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chapterBodyEnd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(StoredNarrativeEvidenceSchema).max(64),
  diagnostics: z.array(NarrativeEvidenceDiagnosticSchema).max(65),
  authority: z.literal("advisory"),
  modelCalls: z.literal(0),
  humanReviewRequired: z.literal(false),
  recordSha256: Sha256,
}).strict().superRefine((record, context) => {
  if (record.chapterBodyEnd <= record.chapterBodyStart) context.addIssue({ code: "custom", path: ["chapterBodyEnd"], message: "Chapter body range must be nonempty" });
  if (new Set(record.entries.map((entry) => entry.id)).size !== record.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "Duplicate narrative evidence IDs" });
  record.entries.forEach((entry, index) => {
    if (entry.sourceChapter !== record.chapterNumber || entry.chapterTextSha256 !== record.chapterTextSha256) {
      context.addIssue({ code: "custom", path: ["entries", index], message: "Entry must bind the same chapter and manuscript" });
    }
  });
});
export type NarrativeEvidenceChapter = z.infer<typeof NarrativeEvidenceChapterSchema>;

export interface NarrativeEvidenceValidation {
  readonly entries: ReadonlyArray<StoredNarrativeEvidence>;
  readonly diagnostics: ReadonlyArray<NarrativeEvidenceDiagnostic>;
}

export interface NarrativeEvidenceContext {
  readonly rendered: string;
  readonly records: ReadonlyArray<NarrativeEvidenceChapter>;
  readonly receipt: {
    readonly schemaVersion: "narrative-evidence-context/v1";
    readonly bookId: string;
    readonly throughChapter: number;
    readonly povCharacter?: string;
    readonly selectedEntryIds: ReadonlyArray<string>;
    readonly omittedEntryIds: ReadonlyArray<string>;
    readonly sourceRecords: ReadonlyArray<{ readonly chapterNumber: number; readonly recordSha256: string; readonly chapterFileSha256: string }>;
    readonly excluded: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
    readonly renderedSha256: string;
    readonly characters: number;
    readonly estimatedTokens: number;
    readonly maxCharacters: number;
    readonly maxInputTokens?: number;
    readonly autoEnforcement: false;
    readonly modelCalls: 0;
    readonly humanReviewRequired: false;
  };
}
