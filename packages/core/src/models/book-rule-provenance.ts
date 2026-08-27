import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { BookRulesSchema, type BookRules } from "./book-rules.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const EnforcementFieldPathSchema = z.string().regex(
  /^(?:protagonist\.behavioralConstraints|genreLock\.forbidden|prohibitions|futureAdvantage\.forbiddenShortcuts)\[(?:0|[1-9]\d*)\]$/,
);
const RelativeArtifactPathSchema = z.string().min(1).refine((value) => {
  if (value.includes("\0") || value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}, "artifactPath must be a normalized repository-relative path");

export const BOOK_RULE_PROVENANCE_VERSION = 1 as const;
export const BOOK_RULE_PROVENANCE_PATH = "story/book_rules.provenance.json" as const;
export const BOOK_RULES_PATH = "story/book_rules.md" as const;
export const BOOK_RULE_PROVENANCE_SCOPE = "enforcement-sensitive-v1" as const;
export const BOOK_RULE_PROVENANCE_COLLECTIONS = [
  "protagonist.behavioralConstraints",
  "genreLock.forbidden",
  "prohibitions",
  "futureAdvantage.forbiddenShortcuts",
] as const;

export type BookRuleProvenanceCollection = typeof BOOK_RULE_PROVENANCE_COLLECTIONS[number];
export type BookRuleFieldPath = `${BookRuleProvenanceCollection}[${number}]`;

export const BookRuleOwnerDecisionDraftSchema = z.object({
  collection: z.enum(BOOK_RULE_PROVENANCE_COLLECTIONS),
  text: z.string().trim().min(1).max(4_000),
  decision: z.literal("adopt"),
}).strict();
export type BookRuleOwnerDecisionDraft = z.infer<typeof BookRuleOwnerDecisionDraftSchema>;

/** Host-authenticated owner decision after a distinct Studio HIL confirmation. */
export const BookRuleOwnerDecisionInputSchema = BookRuleOwnerDecisionDraftSchema.extend({
  decisionId: StableIdSchema,
  adoptedByActorId: StableIdSchema,
}).strict();
export type BookRuleOwnerDecisionInput = z.infer<typeof BookRuleOwnerDecisionInputSchema>;

export const ExactBookRulesSelectorSchema = z.object({
  path: z.literal(BOOK_RULES_PATH),
  coordinate: z.literal("utf8-byte"),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  textSha256: Sha256Schema,
  selectorSha256: Sha256Schema,
}).strict().superRefine((selector, ctx) => {
  if (selector.end <= selector.start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end"],
      message: "book-rules selector end must be greater than start",
    });
  }
  if (selector.selectorSha256 !== hashCanonicalJson(bookRulesSelectorPayload(selector))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectorSha256"],
      message: "book-rules selector self-hash does not match its payload",
    });
  }
});
export type ExactBookRulesSelector = z.infer<typeof ExactBookRulesSelectorSchema>;

export const BookRuleSourceSchema = z.enum([
  "user-explicit",
  "premise-explicit",
  "book-canon",
  "genre",
  "model-suggested",
]);
export type BookRuleSource = z.infer<typeof BookRuleSourceSchema>;

export const BookRuleStrengthSchema = z.enum(["hard", "soft", "diagnostic"]);
export type BookRuleStrength = z.infer<typeof BookRuleStrengthSchema>;

export const BookRuleKindSchema = z.enum([
  "fact",
  "prohibition",
  "content-intensity",
  "craft-diagnostic",
]);
export type BookRuleKind = z.infer<typeof BookRuleKindSchema>;

export const ExactBookRuleSourceSelectorSchema = z.object({
  artifactPath: RelativeArtifactPathSchema,
  artifactSha256: Sha256Schema,
  rangeEncoding: z.literal("utf8-byte"),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  selectedTextSha256: Sha256Schema,
  selectorSha256: Sha256Schema,
}).strict().superRefine((selector, ctx) => {
  if (selector.end <= selector.start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end"],
      message: "source selector end must be greater than start",
    });
  }
  const expected = hashCanonicalJson(sourceSelectorPayload(selector));
  if (selector.selectorSha256 !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectorSha256"],
      message: "source selector self-hash does not match its payload",
    });
  }
});
export type ExactBookRuleSourceSelector = z.infer<typeof ExactBookRuleSourceSelectorSchema>;

const DirectBookRuleSourceSchema = z.enum([
  "user-explicit",
  "premise-explicit",
  "book-canon",
]);

export const BookRuleAuthorityOriginSchema = z.enum([
  "authenticated-owner-instruction",
  "authenticated-human-hil",
  "persisted-book-canon",
]);
export type BookRuleAuthorityOrigin = z.infer<typeof BookRuleAuthorityOriginSchema>;

export const BookRuleSourceAuthorityReferenceSchema = z.object({
  decision: z.literal("authorize"),
  authorityOrigin: BookRuleAuthorityOriginSchema,
  intent: z.literal("authorize-rule"),
  decisionId: StableIdSchema,
  authorizedByActorId: StableIdSchema,
  receiptPath: RelativeArtifactPathSchema,
  receiptFileSha256: Sha256Schema,
}).strict();
export type BookRuleSourceAuthorityReference = z.infer<
  typeof BookRuleSourceAuthorityReferenceSchema
>;

export const BookRuleOwnerAdoptionSchema = z.object({
  decision: z.literal("adopt"),
  decisionId: StableIdSchema,
  adoptedByActorId: StableIdSchema,
  receiptPath: RelativeArtifactPathSchema,
  receiptFileSha256: Sha256Schema,
}).strict();
export type BookRuleOwnerAdoption = z.infer<typeof BookRuleOwnerAdoptionSchema>;

const RuleAuthorityBindingShape = {
  bookId: z.string().min(1),
  ruleId: StableIdSchema,
  kind: BookRuleKindSchema,
  fieldPath: EnforcementFieldPathSchema,
  ruleTextSha256: Sha256Schema,
} as const;

const SourceAuthorityReceiptShape = {
  version: z.literal(BOOK_RULE_PROVENANCE_VERSION),
  receiptType: z.literal("book-rule-source-authority"),
  ...RuleAuthorityBindingShape,
  source: DirectBookRuleSourceSchema,
  decision: z.literal("authorize"),
  authorityOrigin: BookRuleAuthorityOriginSchema,
  intent: z.literal("authorize-rule"),
  decisionId: StableIdSchema,
  authorizedByActorId: StableIdSchema,
  artifactPath: RelativeArtifactPathSchema,
  artifactSha256: Sha256Schema,
  selectorSha256: Sha256Schema,
  selectedTextSha256: Sha256Schema,
  createdAt: z.string().datetime(),
} as const;

export const BookRuleSourceAuthorityReceiptSchema = z.object({
  ...SourceAuthorityReceiptShape,
  receiptSha256: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  if (receipt.receiptSha256 !== hashCanonicalJson(payload)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receiptSha256"],
      message: "source authority receipt self-hash does not match its payload",
    });
  }
});
export type BookRuleSourceAuthorityReceipt = z.infer<
  typeof BookRuleSourceAuthorityReceiptSchema
>;

const OwnerAdoptionReceiptShape = {
  version: z.literal(BOOK_RULE_PROVENANCE_VERSION),
  receiptType: z.literal("book-rule-owner-adoption"),
  ...RuleAuthorityBindingShape,
  decision: z.literal("adopt"),
  decisionId: StableIdSchema,
  adoptedByActorId: StableIdSchema,
  createdAt: z.string().datetime(),
} as const;

export const BookRuleOwnerAdoptionReceiptSchema = z.object({
  ...OwnerAdoptionReceiptShape,
  receiptSha256: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  if (receipt.receiptSha256 !== hashCanonicalJson(payload)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receiptSha256"],
      message: "owner adoption receipt self-hash does not match its payload",
    });
  }
});
export type BookRuleOwnerAdoptionReceipt = z.infer<
  typeof BookRuleOwnerAdoptionReceiptSchema
>;

export const BookRuleProvenanceEntrySchema = z.object({
  ruleId: StableIdSchema,
  kind: BookRuleKindSchema,
  fieldPath: EnforcementFieldPathSchema,
  text: z.string(),
  textSha256: Sha256Schema,
  bookRulesSelector: ExactBookRulesSelectorSchema,
  bookRulesSelectorSha256: Sha256Schema,
  source: BookRuleSourceSchema,
  strength: BookRuleStrengthSchema,
  sourceSelector: ExactBookRuleSourceSelectorSchema.optional(),
  sourceAuthority: BookRuleSourceAuthorityReferenceSchema.optional(),
  ownerAdoption: BookRuleOwnerAdoptionSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.textSha256 !== sha256(entry.text)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["textSha256"],
      message: "rule text hash does not match the exact rule text",
    });
  }
  if (
    entry.bookRulesSelector.textSha256 !== entry.textSha256
    || entry.bookRulesSelectorSha256 !== entry.bookRulesSelector.selectorSha256
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bookRulesSelectorSha256"],
      message: "book-rules selector and exact rule text hashes must agree",
    });
  }
  if (entry.sourceAuthority && !entry.sourceSelector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceAuthority"],
      message: "source authority receipt requires an exact source selector",
    });
  }
  if (entry.sourceAuthority && !DirectBookRuleSourceSchema.safeParse(entry.source).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceAuthority"],
      message: "source authority receipt requires user-explicit, premise-explicit, or book-canon source",
    });
  }
  if (entry.sourceAuthority && entry.ownerAdoption) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ownerAdoption"],
      message: "a rule must use one authority route, not both source authority and owner adoption",
    });
  }
  if (entry.strength === "hard" && !hasDeclaredHardEvidence(entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["strength"],
      message: "hard rules require a referenced exact-source authority receipt or owner-adoption receipt",
    });
  }
});
export type BookRuleProvenanceEntry = z.infer<typeof BookRuleProvenanceEntrySchema>;

const ReceiptShape = {
  version: z.literal(BOOK_RULE_PROVENANCE_VERSION),
  compiler: z.literal("host"),
  bookId: z.string().min(1),
  bookRulesPath: z.literal(BOOK_RULES_PATH),
  provenancePath: z.literal(BOOK_RULE_PROVENANCE_PATH),
  scope: z.literal(BOOK_RULE_PROVENANCE_SCOPE),
  coveredCollections: z.tuple([
    z.literal("protagonist.behavioralConstraints"),
    z.literal("genreLock.forbidden"),
    z.literal("prohibitions"),
    z.literal("futureAdvantage.forbiddenShortcuts"),
  ]),
  unparsedMarkdownPolicy: z.literal("display-only-no-auto-action"),
  rulesFileSha256: Sha256Schema,
  bookRuleEntryCount: z.number().int().min(0),
  provenanceRuleCount: z.number().int().min(0),
  hardRuleCount: z.number().int().min(0),
  authorizedHardRuleCount: z.number().int().min(0),
  softRuleCount: z.number().int().min(0),
  diagnosticRuleCount: z.number().int().min(0),
  unauthorizedHardRuleCount: z.number().int().min(0),
  coveragePassed: z.boolean(),
  rules: z.array(BookRuleProvenanceEntrySchema),
  createdAt: z.string().datetime(),
} as const;

const BookRuleProvenanceReceiptPayloadSchema = z.object(ReceiptShape).strict()
  .superRefine(validateReceiptCounts);

export const BookRuleProvenanceReceiptSchema = z.object({
  ...ReceiptShape,
  receiptSha256: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  validateReceiptCounts(receipt, ctx);
  const { receiptSha256: _receiptSha256, ...payload } = receipt;
  if (receipt.receiptSha256 !== hashCanonicalJson(payload)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["receiptSha256"],
      message: "book-rule provenance receipt self-hash does not match its payload",
    });
  }
});
export type BookRuleProvenanceReceipt = z.infer<typeof BookRuleProvenanceReceiptSchema>;

export interface ExactBookRuleSourceSelectorInput {
  readonly artifactPath: string;
  readonly artifactContent: string;
  /** JavaScript string offsets; compiled receipts store canonical UTF-8 byte offsets. */
  readonly start: number;
  readonly end: number;
}

export interface CompileBookRuleSourceAuthorityReceiptInput {
  readonly bookId: string;
  readonly source: "user-explicit" | "premise-explicit" | "book-canon";
  readonly authorityOrigin: BookRuleAuthorityOrigin;
  readonly intent: "authorize-rule";
  readonly decisionId: string;
  readonly authorizedByActorId: string;
  readonly fieldPath: BookRuleFieldPath;
  readonly text: string;
  readonly sourceSelector: ExactBookRuleSourceSelectorInput;
  readonly now?: () => Date;
}

export interface CompileBookRuleOwnerAdoptionReceiptInput {
  readonly bookId: string;
  readonly decisionId: string;
  readonly adoptedByActorId: string;
  readonly fieldPath: BookRuleFieldPath;
  readonly text: string;
  readonly now?: () => Date;
}

export interface BookRuleAuthorityReceiptFileInput {
  readonly receiptPath: string;
  /** Exact immutable JSON file bytes decoded as UTF-8. */
  readonly receiptContent: string;
}

export interface BookRuleAuthorityAssignment {
  readonly fieldPath: BookRuleFieldPath;
  readonly text: string;
  readonly source: BookRuleSource;
  readonly strength: BookRuleStrength;
  readonly sourceSelector?: ExactBookRuleSourceSelectorInput;
  readonly sourceAuthorityReceipt?: BookRuleAuthorityReceiptFileInput;
  readonly ownerAdoptionReceipt?: BookRuleAuthorityReceiptFileInput;
}

export interface CompileBookRuleProvenanceInput {
  readonly bookId: string;
  readonly rulesFileContent: string;
  readonly rules: BookRules;
  /** Host-verified overrides. Unassigned Architect output defaults to diagnostic. */
  readonly assignments?: ReadonlyArray<BookRuleAuthorityAssignment>;
  /** Entries returned by carryForwardBookRuleProvenanceEntries only. */
  readonly carriedEntries?: ReadonlyArray<BookRuleProvenanceEntry>;
  readonly now?: () => Date;
}

interface RawEnforcementRule {
  readonly fieldPath: BookRuleFieldPath;
  readonly text: string;
  readonly kind: BookRuleKind;
}

export function compileBookRuleSourceAuthorityReceipt(
  input: CompileBookRuleSourceAuthorityReceiptInput,
): BookRuleSourceAuthorityReceipt {
  const fieldPath = EnforcementFieldPathSchema.parse(input.fieldPath) as BookRuleFieldPath;
  const kind = kindForFieldPath(fieldPath);
  const textSha256 = sha256(input.text);
  const selector = compileExactSourceSelector(input.sourceSelector);
  if (selector.selectedTextSha256 !== textSha256) {
    throw new Error("exact selected source text must equal the authorized rule text");
  }
  assertAuthorityOriginMatchesSource(input.authorityOrigin, input.source);
  const payload = {
    version: BOOK_RULE_PROVENANCE_VERSION,
    receiptType: "book-rule-source-authority" as const,
    bookId: input.bookId,
    ruleId: ruleIdFor(kind, fieldPath, textSha256),
    kind,
    fieldPath,
    ruleTextSha256: textSha256,
    source: input.source,
    decision: "authorize" as const,
    authorityOrigin: input.authorityOrigin,
    intent: input.intent,
    decisionId: input.decisionId,
    authorizedByActorId: input.authorizedByActorId,
    artifactPath: selector.artifactPath,
    artifactSha256: selector.artifactSha256,
    selectorSha256: selector.selectorSha256,
    selectedTextSha256: selector.selectedTextSha256,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return BookRuleSourceAuthorityReceiptSchema.parse({
    ...payload,
    receiptSha256: hashCanonicalJson(payload),
  });
}

export function compileBookRuleOwnerAdoptionReceipt(
  input: CompileBookRuleOwnerAdoptionReceiptInput,
): BookRuleOwnerAdoptionReceipt {
  const fieldPath = EnforcementFieldPathSchema.parse(input.fieldPath) as BookRuleFieldPath;
  const kind = kindForFieldPath(fieldPath);
  const textSha256 = sha256(input.text);
  const payload = {
    version: BOOK_RULE_PROVENANCE_VERSION,
    receiptType: "book-rule-owner-adoption" as const,
    bookId: input.bookId,
    ruleId: ruleIdFor(kind, fieldPath, textSha256),
    kind,
    fieldPath,
    ruleTextSha256: textSha256,
    decision: "adopt" as const,
    decisionId: input.decisionId,
    adoptedByActorId: input.adoptedByActorId,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return BookRuleOwnerAdoptionReceiptSchema.parse({
    ...payload,
    receiptSha256: hashCanonicalJson(payload),
  });
}

export function renderBookRuleSourceAuthorityReceipt(
  receipt: BookRuleSourceAuthorityReceipt,
): string {
  return `${JSON.stringify(BookRuleSourceAuthorityReceiptSchema.parse(receipt), null, 2)}\n`;
}

export function renderBookRuleOwnerAdoptionReceipt(
  receipt: BookRuleOwnerAdoptionReceipt,
): string {
  return `${JSON.stringify(BookRuleOwnerAdoptionReceiptSchema.parse(receipt), null, 2)}\n`;
}

export function compileBookRuleProvenance(
  input: CompileBookRuleProvenanceInput,
): BookRuleProvenanceReceipt {
  const rules = BookRulesSchema.parse(input.rules);
  const rawEntries = enumerateEnforcementRules(rules);
  const bookRulesSelectors = locateExactBookRulesSelectors(input.rulesFileContent, rawEntries);
  const currentByKey = new Map(rawEntries.map((entry) => [ruleKey(entry.fieldPath, entry.text), entry]));
  const assignments = indexAssignments(input.assignments ?? [], currentByKey);
  const carried = indexCarriedEntries(input.carriedEntries ?? [], currentByKey);

  const provenanceEntries = rawEntries.map((rawEntry, index) => {
    const key = ruleKey(rawEntry.fieldPath, rawEntry.text);
    const assignment = assignments.get(key);
    const carriedEntry = carried.get(key);
    const textSha256 = sha256(rawEntry.text);
    const bookRulesSelector = bookRulesSelectors[index]!;
    const base = {
      ruleId: ruleIdFor(rawEntry.kind, rawEntry.fieldPath, textSha256),
      kind: rawEntry.kind,
      fieldPath: rawEntry.fieldPath,
      text: rawEntry.text,
      textSha256,
      bookRulesSelector,
      bookRulesSelectorSha256: bookRulesSelector.selectorSha256,
    };

    if (assignment) {
      const sourceSelector = assignment.sourceSelector
        ? compileExactSourceSelector(assignment.sourceSelector)
        : undefined;
      const sourceAuthority = assignment.sourceAuthorityReceipt
        ? compileSourceAuthorityReference({
            file: assignment.sourceAuthorityReceipt,
            bookId: input.bookId,
            source: assignment.source,
            selector: sourceSelector,
            rule: base,
          })
        : undefined;
      const ownerAdoption = assignment.ownerAdoptionReceipt
        ? compileOwnerAdoptionReference({
            file: assignment.ownerAdoptionReceipt,
            bookId: input.bookId,
            rule: base,
          })
        : undefined;
      return BookRuleProvenanceEntrySchema.parse({
        ...base,
        source: assignment.source,
        strength: assignment.strength,
        ...(sourceSelector ? { sourceSelector } : {}),
        ...(sourceAuthority ? { sourceAuthority } : {}),
        ...(ownerAdoption ? { ownerAdoption } : {}),
      });
    }

    if (carriedEntry) {
      return BookRuleProvenanceEntrySchema.parse({
        ...base,
        source: carriedEntry.source,
        strength: carriedEntry.strength,
        ...(carriedEntry.sourceSelector ? { sourceSelector: carriedEntry.sourceSelector } : {}),
        ...(carriedEntry.sourceAuthority ? { sourceAuthority: carriedEntry.sourceAuthority } : {}),
        ...(carriedEntry.ownerAdoption ? { ownerAdoption: carriedEntry.ownerAdoption } : {}),
      });
    }

    return BookRuleProvenanceEntrySchema.parse({
      ...base,
      source: "model-suggested",
      strength: "diagnostic",
    });
  });

  const hardRuleCount = provenanceEntries.filter((entry) => entry.strength === "hard").length;
  const authorizedHardRuleCount = provenanceEntries.filter(
    (entry) => entry.strength === "hard" && hasDeclaredHardEvidence(entry),
  ).length;
  const payload = BookRuleProvenanceReceiptPayloadSchema.parse({
    version: BOOK_RULE_PROVENANCE_VERSION,
    compiler: "host",
    bookId: input.bookId,
    bookRulesPath: BOOK_RULES_PATH,
    provenancePath: BOOK_RULE_PROVENANCE_PATH,
    scope: BOOK_RULE_PROVENANCE_SCOPE,
    coveredCollections: [...BOOK_RULE_PROVENANCE_COLLECTIONS],
    unparsedMarkdownPolicy: "display-only-no-auto-action",
    rulesFileSha256: sha256(input.rulesFileContent),
    bookRuleEntryCount: rawEntries.length,
    provenanceRuleCount: provenanceEntries.length,
    hardRuleCount,
    authorizedHardRuleCount,
    softRuleCount: provenanceEntries.filter((entry) => entry.strength === "soft").length,
    diagnosticRuleCount: provenanceEntries.filter((entry) => entry.strength === "diagnostic").length,
    unauthorizedHardRuleCount: hardRuleCount - authorizedHardRuleCount,
    coveragePassed: rawEntries.length === provenanceEntries.length,
    rules: provenanceEntries,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
  });
  return BookRuleProvenanceReceiptSchema.parse({
    ...payload,
    receiptSha256: hashCanonicalJson(payload),
  });
}

export function renderBookRuleProvenance(receipt: BookRuleProvenanceReceipt): string {
  return `${JSON.stringify(BookRuleProvenanceReceiptSchema.parse(receipt), null, 2)}\n`;
}

export async function storeBookRuleProvenance(
  bookDir: string,
  receiptValue: BookRuleProvenanceReceipt,
  rulesValue: BookRules,
  options: { readonly authorityRootDir?: string } = {},
): Promise<BookRuleProvenanceReceipt> {
  const receipt = BookRuleProvenanceReceiptSchema.parse(receiptValue);
  const rulesFileContent = await readFile(join(bookDir, BOOK_RULES_PATH), "utf8");
  const verification = verifyBookRuleProvenance(receipt, {
    bookId: receipt.bookId,
    rulesFileContent,
    rules: rulesValue,
  });
  if (verification.status !== "current") {
    throw new Error(`Cannot store ${BOOK_RULE_PROVENANCE_PATH}: ${verification.reason}`);
  }
  const authority = await verifyBookRuleAuthorityEvidence(
    verification.receipt,
    options.authorityRootDir ?? bookDir,
  );
  if (authority.status !== "verified") {
    throw new Error(`Cannot store ${BOOK_RULE_PROVENANCE_PATH}: ${authority.reason}`);
  }
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: BOOK_RULE_PROVENANCE_PATH,
      content: renderBookRuleProvenance(receipt),
    }],
  });
  return receipt;
}

/**
 * Atomically persists the canonical BookRules text and its matching sidecar.
 * Authority artifacts and immutable decision receipts must already exist.
 */
export async function persistBookRulesPair(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly rulesFileContent: string;
  readonly rules: BookRules;
  readonly receipt: BookRuleProvenanceReceipt;
  readonly authorityRootDir?: string;
}): Promise<BookRuleProvenanceReceipt> {
  const receipt = BookRuleProvenanceReceiptSchema.parse(input.receipt);
  const verification = verifyBookRuleProvenance(receipt, {
    bookId: input.bookId,
    rulesFileContent: input.rulesFileContent,
    rules: input.rules,
  });
  if (verification.status !== "current") {
    throw new Error(`Cannot persist BookRules pair: ${verification.reason}`);
  }
  const authority = await verifyBookRuleAuthorityEvidence(
    receipt,
    input.authorityRootDir ?? input.bookDir,
  );
  if (authority.status !== "verified") {
    throw new Error(`Cannot persist BookRules pair: ${authority.reason}`);
  }
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: [
      { relativePath: BOOK_RULES_PATH, content: input.rulesFileContent },
      { relativePath: BOOK_RULE_PROVENANCE_PATH, content: renderBookRuleProvenance(receipt) },
    ],
  });
  return receipt;
}

export type BookRuleProvenanceReadResult =
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly rawSidecar: string; readonly reason: string }
  | { readonly status: "loaded"; readonly rawSidecar: string; readonly value: unknown };

export async function readBookRuleProvenance(
  bookDir: string,
): Promise<BookRuleProvenanceReadResult> {
  let rawSidecar: string;
  try {
    rawSidecar = await readFile(join(bookDir, BOOK_RULE_PROVENANCE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }
  try {
    return { status: "loaded", rawSidecar, value: JSON.parse(rawSidecar) };
  } catch {
    return {
      status: "invalid",
      rawSidecar,
      reason: "sidecar is not valid JSON",
    };
  }
}

export interface VerifyBookRuleProvenanceContext {
  readonly bookId: string;
  readonly rulesFileContent: string;
  readonly rules: BookRules;
}

export type BookRuleProvenanceVerification =
  | {
      readonly status: "current";
      readonly receipt: BookRuleProvenanceReceipt;
      readonly rawSidecar?: string;
    }
  | {
      readonly status: "missing";
      readonly reason: "sidecar-missing";
    }
  | {
      readonly status: "invalid";
      readonly reason: string;
      readonly rawSidecar?: string;
    }
  | {
      readonly status: "stale";
      readonly reason: "rules-file-changed" | "rule-surface-changed";
      readonly receipt: BookRuleProvenanceReceipt;
      readonly rawSidecar?: string;
    };

export function verifyBookRuleProvenance(
  candidate: unknown,
  context: VerifyBookRuleProvenanceContext,
): BookRuleProvenanceVerification {
  const normalized = unwrapReadResult(candidate);
  if (normalized.status === "missing") {
    return { status: "missing", reason: "sidecar-missing" };
  }
  if (normalized.status === "invalid") {
    return {
      status: "invalid",
      reason: normalized.reason,
      rawSidecar: normalized.rawSidecar,
    };
  }
  const parsed = BookRuleProvenanceReceiptSchema.safeParse(normalized.value);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      ...(normalized.rawSidecar ? { rawSidecar: normalized.rawSidecar } : {}),
    };
  }
  const receipt = parsed.data;
  if (receipt.bookId !== context.bookId) {
    return {
      status: "invalid",
      reason: "sidecar belongs to another Book",
      ...(normalized.rawSidecar ? { rawSidecar: normalized.rawSidecar } : {}),
    };
  }
  if (receipt.rulesFileSha256 !== sha256(context.rulesFileContent)) {
    return {
      status: "stale",
      reason: "rules-file-changed",
      receipt,
      ...(normalized.rawSidecar ? { rawSidecar: normalized.rawSidecar } : {}),
    };
  }
  const current = enumerateEnforcementRules(BookRulesSchema.parse(context.rules));
  const currentByPath = new Map(current.map((entry) => [entry.fieldPath, entry]));
  const rulesFileBytes = Buffer.from(context.rulesFileContent, "utf8");
  const selectorRanges = receipt.rules.map((entry) => ({
    start: entry.bookRulesSelector.start,
    end: entry.bookRulesSelector.end,
  }));
  const selectorsDoNotOverlap = selectorRanges.every((range, index) => (
    selectorRanges.every((other, otherIndex) => (
      index === otherIndex || range.end <= other.start || other.end <= range.start
    ))
  ));
  const exactCoverage = current.length === receipt.rules.length
    && selectorsDoNotOverlap
    && receipt.rules.every((entry) => {
      const raw = currentByPath.get(entry.fieldPath as BookRuleFieldPath);
      const selectedBytes = rulesFileBytes.subarray(
        entry.bookRulesSelector.start,
        entry.bookRulesSelector.end,
      );
      return raw?.text === entry.text
        && entry.textSha256 === sha256(raw.text)
        && entry.bookRulesSelector.end <= rulesFileBytes.byteLength
        && selectedBytes.toString("utf8") === entry.text
        && sha256(selectedBytes) === entry.textSha256
        && entry.bookRulesSelectorSha256 === entry.bookRulesSelector.selectorSha256;
    });
  if (!exactCoverage) {
    return {
      status: "stale",
      reason: "rule-surface-changed",
      receipt,
      ...(normalized.rawSidecar ? { rawSidecar: normalized.rawSidecar } : {}),
    };
  }
  return {
    status: "current",
    receipt,
    ...(normalized.rawSidecar ? { rawSidecar: normalized.rawSidecar } : {}),
  };
}

export type BookRuleAuthorityEvidenceVerification =
  | {
      readonly status: "verified";
      readonly verifiedHardRuleIds: ReadonlySet<string>;
    }
  | {
      readonly status: "invalid";
      readonly reason: string;
    };

/**
 * Host-only authority verification. This function re-reads every referenced
 * artifact and immutable decision receipt; sidecar declarations alone never
 * authorize an automatic action.
 */
export async function verifyBookRuleAuthorityEvidence(
  receiptValue: BookRuleProvenanceReceipt,
  authorityRootDir: string,
): Promise<BookRuleAuthorityEvidenceVerification> {
  const parsed = BookRuleProvenanceReceiptSchema.safeParse(receiptValue);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: `invalid provenance receipt: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }
  const verifiedHardRuleIds = new Set<string>();
  for (const entry of parsed.data.rules) {
    if (entry.strength !== "hard") continue;
    try {
      if (entry.ownerAdoption) {
        await verifyOwnerAdoptionEvidence(parsed.data.bookId, entry, authorityRootDir);
      } else {
        await verifySourceAuthorityEvidence(parsed.data.bookId, entry, authorityRootDir);
      }
      verifiedHardRuleIds.add(entry.ruleId);
    } catch (error) {
      return {
        status: "invalid",
        reason: `${entry.fieldPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (verifiedHardRuleIds.size !== parsed.data.hardRuleCount) {
    return {
      status: "invalid",
      reason: "verified hard-rule evidence count does not match the sidecar",
    };
  }
  return { status: "verified", verifiedHardRuleIds };
}

type ProtagonistRules = NonNullable<BookRules["protagonist"]>;
type GenreLockRules = NonNullable<BookRules["genreLock"]>;
type FutureAdvantageRules = NonNullable<BookRules["futureAdvantage"]>;

export type BookRuleCanonFacts = Omit<
  BookRules,
  "protagonist" | "genreLock" | "futureAdvantage" | "prohibitions"
> & {
  readonly protagonist?: Omit<ProtagonistRules, "behavioralConstraints">;
  readonly genreLock?: Omit<GenreLockRules, "forbidden">;
  readonly futureAdvantage?: Omit<FutureAdvantageRules, "forbiddenShortcuts">;
};

export interface ProjectedBookRule {
  readonly fieldPath: BookRuleFieldPath;
  readonly text: string;
  readonly kind: BookRuleKind;
  readonly provenance: BookRuleProvenanceEntry | null;
  readonly effectiveStrength: BookRuleStrength;
  readonly authorizedForAutoAction: boolean;
}

export interface BookRuleProjection {
  readonly status: BookRuleProvenanceVerification["status"];
  readonly reason?: string;
  /** Whether immutable host evidence was actually read, not merely declared. */
  readonly authorityEvidence: "not-required" | "unverified" | "verified" | "invalid";
  /** Exact Markdown bytes decoded as UTF-8. Unknown paragraphs remain display-only. */
  readonly rawRulesFileContent: string;
  /** Full parsed structure is retained for display and non-restriction consumers. */
  readonly rawRules: BookRules;
  /** Typed non-restriction facts, separated from auto-enforcement candidates. */
  readonly canonFacts: BookRuleCanonFacts;
  readonly rules: ReadonlyArray<ProjectedBookRule>;
  readonly receipt?: BookRuleProvenanceReceipt;
  readonly rawSidecar?: string;
}

export interface ProjectBookRulesInput extends VerifyBookRuleProvenanceContext {
  readonly sidecar?: unknown;
}

export function projectBookRules(input: ProjectBookRulesInput): BookRuleProjection {
  const rawRules = BookRulesSchema.parse(input.rules);
  const verification = verifyBookRuleProvenance(input.sidecar, {
    bookId: input.bookId,
    rulesFileContent: input.rulesFileContent,
    rules: rawRules,
  });
  const authorityEvidence = verification.status === "current"
    ? verification.receipt.hardRuleCount === 0 ? "not-required" : "unverified"
    : "invalid";
  return buildBookRuleProjection({
    rawRules,
    rulesFileContent: input.rulesFileContent,
    verification,
    authorityEvidence,
    verifiedHardRuleIds: new Set(),
  });
}

function buildBookRuleProjection(input: {
  readonly rawRules: BookRules;
  readonly rulesFileContent: string;
  readonly verification: BookRuleProvenanceVerification;
  readonly authorityEvidence: BookRuleProjection["authorityEvidence"];
  readonly verifiedHardRuleIds: ReadonlySet<string>;
  readonly authorityFailureReason?: string;
}): BookRuleProjection {
  const { verification, rawRules } = input;
  const receiptByPath = verification.status === "current"
    ? new Map(verification.receipt.rules.map((entry) => [entry.fieldPath, entry]))
    : new Map<string, BookRuleProvenanceEntry>();
  const rules = enumerateEnforcementRules(rawRules).map((entry): ProjectedBookRule => {
    const provenance = receiptByPath.get(entry.fieldPath) ?? null;
    const authorizedForAutoAction = verification.status === "current"
      && provenance?.strength === "hard"
      && input.authorityEvidence === "verified"
      && input.verifiedHardRuleIds.has(provenance.ruleId);
    return {
      fieldPath: entry.fieldPath,
      text: entry.text,
      kind: entry.kind,
      provenance,
      effectiveStrength: provenance?.strength === "hard" && !authorizedForAutoAction
        ? "diagnostic"
        : provenance?.strength ?? "diagnostic",
      authorizedForAutoAction,
    };
  });
  const status = input.authorityFailureReason ? "invalid" : verification.status;
  return {
    status,
    ...(input.authorityFailureReason
      ? { reason: `authority-evidence-invalid: ${input.authorityFailureReason}` }
      : verification.status !== "current" && "reason" in verification
      ? { reason: verification.reason }
      : {}),
    authorityEvidence: input.authorityEvidence,
    rawRulesFileContent: input.rulesFileContent,
    rawRules,
    canonFacts: projectCanonFacts(rawRules),
    rules,
    ...(verification.status === "current" || verification.status === "stale"
      ? { receipt: verification.receipt }
      : {}),
    ...("rawSidecar" in verification && verification.rawSidecar
      ? { rawSidecar: verification.rawSidecar }
      : {}),
  };
}

export async function readBookRuleProjection(input: {
  readonly bookDir: string;
  readonly bookId: string;
  readonly rules: BookRules;
  readonly authorityRootDir?: string;
}): Promise<BookRuleProjection> {
  const rulesFileContent = await readFile(join(input.bookDir, BOOK_RULES_PATH), "utf8");
  const sidecar = await readBookRuleProvenance(input.bookDir);
  const rawRules = BookRulesSchema.parse(input.rules);
  const verification = verifyBookRuleProvenance(sidecar, {
    bookId: input.bookId,
    rulesFileContent,
    rules: rawRules,
  });
  if (verification.status !== "current") {
    return buildBookRuleProjection({
      rawRules,
      rulesFileContent,
      verification,
      authorityEvidence: "invalid",
      verifiedHardRuleIds: new Set(),
    });
  }
  if (verification.receipt.hardRuleCount === 0) {
    return buildBookRuleProjection({
      rawRules,
      rulesFileContent,
      verification,
      authorityEvidence: "not-required",
      verifiedHardRuleIds: new Set(),
    });
  }
  const authority = await verifyBookRuleAuthorityEvidence(
    verification.receipt,
    input.authorityRootDir ?? input.bookDir,
  );
  if (authority.status !== "verified") {
    return buildBookRuleProjection({
      rawRules,
      rulesFileContent,
      verification,
      authorityEvidence: "invalid",
      verifiedHardRuleIds: new Set(),
      authorityFailureReason: authority.reason,
    });
  }
  return buildBookRuleProjection({
    rawRules,
    rulesFileContent,
    verification,
    authorityEvidence: "verified",
    verifiedHardRuleIds: authority.verifiedHardRuleIds,
  });
}

export function rulesForAutoAction(
  projection: BookRuleProjection,
): ReadonlyArray<BookRuleProvenanceEntry> {
  if (projection.status !== "current" || projection.authorityEvidence !== "verified") return [];
  return projection.rules.flatMap((rule) => (
    rule.authorizedForAutoAction && rule.provenance ? [rule.provenance] : []
  ));
}

export function renderBookRules(
  projection: BookRuleProjection,
  mode: "raw-display" | "auto-action",
): string {
  if (mode === "raw-display") return projection.rawRulesFileContent;
  const rules = rulesForAutoAction(projection);
  if (rules.length === 0) return "(no authorized hard book rules)";
  return rules.map((entry) => `- [${entry.fieldPath}] ${entry.text}`).join("\n");
}

export function carryForwardBookRuleProvenanceEntries(
  previousVerification: BookRuleProvenanceVerification,
  nextRulesValue: BookRules,
): ReadonlyArray<BookRuleProvenanceEntry> {
  if (previousVerification.status !== "current") return [];
  const nextRules = enumerateEnforcementRules(BookRulesSchema.parse(nextRulesValue));
  const exactKeys = new Set(nextRules.map((entry) => ruleKey(entry.fieldPath, entry.text)));
  return previousVerification.receipt.rules.filter((entry) => (
    exactKeys.has(ruleKey(entry.fieldPath as BookRuleFieldPath, entry.text))
  ));
}

function enumerateEnforcementRules(rules: BookRules): RawEnforcementRule[] {
  const result: RawEnforcementRule[] = [];
  const pushAll = (
    collection: BookRuleProvenanceCollection,
    values: ReadonlyArray<string>,
    kind: BookRuleKind,
  ): void => {
    values.forEach((text, index) => {
      result.push({
        fieldPath: `${collection}[${index}]`,
        text,
        kind,
      });
    });
  };
  pushAll(
    "protagonist.behavioralConstraints",
    rules.protagonist?.behavioralConstraints ?? [],
    "fact",
  );
  pushAll("genreLock.forbidden", rules.genreLock?.forbidden ?? [], "prohibition");
  pushAll("prohibitions", rules.prohibitions, "prohibition");
  pushAll(
    "futureAdvantage.forbiddenShortcuts",
    rules.futureAdvantage?.forbiddenShortcuts ?? [],
    "prohibition",
  );
  return result;
}

function projectCanonFacts(rules: BookRules): BookRuleCanonFacts {
  const {
    protagonist,
    genreLock,
    futureAdvantage,
    prohibitions: _prohibitions,
    ...rest
  } = rules;
  return {
    ...rest,
    ...(protagonist
      ? {
          protagonist: {
            name: protagonist.name,
            personalityLock: protagonist.personalityLock,
          },
        }
      : {}),
    ...(genreLock ? { genreLock: { primary: genreLock.primary } } : {}),
    ...(futureAdvantage
      ? {
          futureAdvantage: {
            enabled: futureAdvantage.enabled,
            originMoment: futureAdvantage.originMoment,
            corePromise: futureAdvantage.corePromise,
            allowedDomains: futureAdvantage.allowedDomains,
            known: futureAdvantage.known,
            unknown: futureAdvantage.unknown,
            memoryPolicy: futureAdvantage.memoryPolicy,
            researchPolicy: futureAdvantage.researchPolicy,
          },
        }
      : {}),
  };
}

function compileExactSourceSelector(
  input: ExactBookRuleSourceSelectorInput,
): ExactBookRuleSourceSelector {
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end)) {
    throw new Error("source selector offsets must be integers");
  }
  if (input.start < 0 || input.end <= input.start || input.end > input.artifactContent.length) {
    throw new Error("source selector range is outside the exact source artifact");
  }
  const selectedText = input.artifactContent.slice(input.start, input.end);
  if (!selectedText) throw new Error("source selector must select non-empty text");
  const byteStart = Buffer.byteLength(input.artifactContent.slice(0, input.start), "utf8");
  const byteEnd = Buffer.byteLength(input.artifactContent.slice(0, input.end), "utf8");
  const payload = {
    artifactPath: input.artifactPath,
    artifactSha256: sha256(input.artifactContent),
    rangeEncoding: "utf8-byte" as const,
    start: byteStart,
    end: byteEnd,
    selectedTextSha256: sha256(selectedText),
  };
  return ExactBookRuleSourceSelectorSchema.parse({
    ...payload,
    selectorSha256: hashCanonicalJson(payload),
  });
}

function compileSourceAuthorityReference(input: {
  readonly file: BookRuleAuthorityReceiptFileInput;
  readonly bookId: string;
  readonly source: BookRuleSource;
  readonly selector?: ExactBookRuleSourceSelector;
  readonly rule: {
    readonly ruleId: string;
    readonly kind: BookRuleKind;
    readonly fieldPath: BookRuleFieldPath;
    readonly textSha256: string;
  };
}): BookRuleSourceAuthorityReference {
  if (!input.selector) {
    throw new Error("source authority receipt requires an exact source selector");
  }
  const receipt = parseReceiptFile(
    input.file.receiptContent,
    BookRuleSourceAuthorityReceiptSchema,
    "source authority receipt",
  );
  assertSourceAuthorityReceiptBinding({
    receipt,
    bookId: input.bookId,
    source: input.source,
    selector: input.selector,
    rule: input.rule,
  });
  return BookRuleSourceAuthorityReferenceSchema.parse({
    decision: receipt.decision,
    authorityOrigin: receipt.authorityOrigin,
    intent: receipt.intent,
    decisionId: receipt.decisionId,
    authorizedByActorId: receipt.authorizedByActorId,
    receiptPath: input.file.receiptPath,
    receiptFileSha256: sha256(input.file.receiptContent),
  });
}

function compileOwnerAdoptionReference(input: {
  readonly file: BookRuleAuthorityReceiptFileInput;
  readonly bookId: string;
  readonly rule: {
    readonly ruleId: string;
    readonly kind: BookRuleKind;
    readonly fieldPath: BookRuleFieldPath;
    readonly textSha256: string;
  };
}): BookRuleOwnerAdoption {
  const receipt = parseReceiptFile(
    input.file.receiptContent,
    BookRuleOwnerAdoptionReceiptSchema,
    "owner adoption receipt",
  );
  assertOwnerAdoptionReceiptBinding(receipt, input.bookId, input.rule);
  return BookRuleOwnerAdoptionSchema.parse({
    decision: receipt.decision,
    decisionId: receipt.decisionId,
    adoptedByActorId: receipt.adoptedByActorId,
    receiptPath: input.file.receiptPath,
    receiptFileSha256: sha256(input.file.receiptContent),
  });
}

async function verifySourceAuthorityEvidence(
  bookId: string,
  entry: BookRuleProvenanceEntry,
  authorityRootDir: string,
): Promise<void> {
  if (!entry.sourceSelector || !entry.sourceAuthority) {
    throw new Error("hard source rule is missing its exact selector or authority receipt reference");
  }
  const artifact = await readExactUtf8Artifact(
    authorityRootDir,
    entry.sourceSelector.artifactPath,
    "source artifact",
  );
  if (artifact.fileSha256 !== entry.sourceSelector.artifactSha256) {
    throw new Error("source artifact bytes no longer match artifactSha256");
  }
  const artifactBytes = Buffer.from(artifact.content, "utf8");
  if (entry.sourceSelector.end > artifactBytes.byteLength) {
    throw new Error("source selector range is outside the current artifact");
  }
  const selectedBytes = artifactBytes.subarray(
    entry.sourceSelector.start,
    entry.sourceSelector.end,
  );
  const selectedText = selectedBytes.toString("utf8");
  if (
    !selectedText
    || !Buffer.from(selectedText, "utf8").equals(selectedBytes)
    || sha256(selectedText) !== entry.sourceSelector.selectedTextSha256
  ) {
    throw new Error("source selector text no longer matches selectedTextSha256");
  }

  const receiptFile = await readExactUtf8Artifact(
    authorityRootDir,
    entry.sourceAuthority.receiptPath,
    "source authority receipt",
  );
  if (receiptFile.fileSha256 !== entry.sourceAuthority.receiptFileSha256) {
    throw new Error("source authority receipt bytes do not match receiptFileSha256");
  }
  const receipt = parseReceiptFile(
    receiptFile.content,
    BookRuleSourceAuthorityReceiptSchema,
    "source authority receipt",
  );
  assertSourceAuthorityReceiptBinding({
    receipt,
    bookId,
    source: entry.source,
    selector: entry.sourceSelector,
    rule: entry,
  });
  if (
    receipt.authorityOrigin !== entry.sourceAuthority.authorityOrigin
    || receipt.intent !== entry.sourceAuthority.intent
    || receipt.decisionId !== entry.sourceAuthority.decisionId
    || receipt.authorizedByActorId !== entry.sourceAuthority.authorizedByActorId
  ) {
    throw new Error("source authority origin, intent, decision, or actor does not match the sidecar reference");
  }
}

async function verifyOwnerAdoptionEvidence(
  bookId: string,
  entry: BookRuleProvenanceEntry,
  authorityRootDir: string,
): Promise<void> {
  if (!entry.ownerAdoption) throw new Error("hard rule is missing owner adoption evidence");
  const receiptFile = await readExactUtf8Artifact(
    authorityRootDir,
    entry.ownerAdoption.receiptPath,
    "owner adoption receipt",
  );
  if (receiptFile.fileSha256 !== entry.ownerAdoption.receiptFileSha256) {
    throw new Error("owner adoption receipt bytes do not match receiptFileSha256");
  }
  const receipt = parseReceiptFile(
    receiptFile.content,
    BookRuleOwnerAdoptionReceiptSchema,
    "owner adoption receipt",
  );
  assertOwnerAdoptionReceiptBinding(receipt, bookId, entry);
  if (
    receipt.decisionId !== entry.ownerAdoption.decisionId
    || receipt.adoptedByActorId !== entry.ownerAdoption.adoptedByActorId
  ) {
    throw new Error("owner adoption actor or decision does not match the sidecar reference");
  }
}

function assertSourceAuthorityReceiptBinding(input: {
  readonly receipt: BookRuleSourceAuthorityReceipt;
  readonly bookId: string;
  readonly source: BookRuleSource;
  readonly selector: ExactBookRuleSourceSelector;
  readonly rule: {
    readonly ruleId: string;
    readonly kind: BookRuleKind;
    readonly fieldPath: string;
    readonly textSha256: string;
  };
}): void {
  const { receipt, selector, rule } = input;
  if (!DirectBookRuleSourceSchema.safeParse(input.source).success) {
    throw new Error("source authority cannot authorize genre or model-suggested output");
  }
  assertAuthorityOriginMatchesSource(receipt.authorityOrigin, receipt.source);
  if (selector.selectedTextSha256 !== rule.textSha256) {
    throw new Error("exact selected source text must equal the authorized rule text");
  }
  if (
    receipt.bookId !== input.bookId
    || receipt.ruleId !== rule.ruleId
    || receipt.kind !== rule.kind
    || receipt.fieldPath !== rule.fieldPath
    || receipt.ruleTextSha256 !== rule.textSha256
    || receipt.source !== input.source
    || receipt.artifactPath !== selector.artifactPath
    || receipt.artifactSha256 !== selector.artifactSha256
    || receipt.selectorSha256 !== selector.selectorSha256
    || receipt.selectedTextSha256 !== selector.selectedTextSha256
  ) {
    throw new Error("source authority receipt is not bound to this Book, rule, and exact selector");
  }
}

function assertAuthorityOriginMatchesSource(
  authorityOrigin: BookRuleAuthorityOrigin,
  source: "user-explicit" | "premise-explicit" | "book-canon",
): void {
  if (authorityOrigin === "persisted-book-canon" && source !== "book-canon") {
    throw new Error("persisted-book-canon authority may only bind persisted Book canon");
  }
  if (authorityOrigin !== "persisted-book-canon" && source === "book-canon") {
    throw new Error("book-canon authority requires the persisted-book-canon origin");
  }
}

function assertOwnerAdoptionReceiptBinding(
  receipt: BookRuleOwnerAdoptionReceipt,
  bookId: string,
  rule: {
    readonly ruleId: string;
    readonly kind: BookRuleKind;
    readonly fieldPath: string;
    readonly textSha256: string;
  },
): void {
  if (
    receipt.bookId !== bookId
    || receipt.ruleId !== rule.ruleId
    || receipt.kind !== rule.kind
    || receipt.fieldPath !== rule.fieldPath
    || receipt.ruleTextSha256 !== rule.textSha256
  ) {
    throw new Error("owner adoption receipt is not bound to this Book and exact rule identity");
  }
}

function parseReceiptFile<T>(
  rawContent: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(rawContent);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

async function readExactUtf8Artifact(
  rootDir: string,
  relativePath: string,
  label: string,
): Promise<{ readonly content: string; readonly fileSha256: string }> {
  const safePath = RelativeArtifactPathSchema.parse(relativePath);
  let bytes: Buffer;
  try {
    bytes = await readFile(join(rootDir, safePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(`${label} is missing at ${safePath}`);
    }
    throw error;
  }
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    throw new Error(`${label} must contain canonical UTF-8 bytes`);
  }
  return { content, fileSha256: sha256(bytes) };
}

function locateExactBookRulesSelectors(
  rulesFileContent: string,
  entries: ReadonlyArray<RawEnforcementRule>,
): ReadonlyArray<ExactBookRulesSelector> {
  const selectedCharacterRanges: Array<{ start: number; end: number }> = [];
  const byFieldPath = new Map<BookRuleFieldPath, ExactBookRulesSelector>();
  // Longer strings claim their exact occurrence first so a short rule cannot
  // consume a substring inside a longer rule-bearing line.
  const longestFirst = [...entries].sort((left, right) => (
    right.text.length - left.text.length || left.fieldPath.localeCompare(right.fieldPath)
  ));
  for (const entry of longestFirst) {
    if (!entry.text) {
      throw new Error(`Book rule ${entry.fieldPath} has empty text and cannot receive an exact selector`);
    }
    let characterStart = rulesFileContent.indexOf(entry.text);
    while (characterStart >= 0) {
      const characterEnd = characterStart + entry.text.length;
      const overlaps = selectedCharacterRanges.some((range) => (
        characterStart < range.end && range.start < characterEnd
      ));
      if (!overlaps) {
        const payload = {
          path: BOOK_RULES_PATH,
          coordinate: "utf8-byte" as const,
          start: Buffer.byteLength(rulesFileContent.slice(0, characterStart), "utf8"),
          end: Buffer.byteLength(rulesFileContent.slice(0, characterEnd), "utf8"),
          textSha256: sha256(entry.text),
        };
        const selector = ExactBookRulesSelectorSchema.parse({
          ...payload,
          selectorSha256: hashCanonicalJson(payload),
        });
        selectedCharacterRanges.push({ start: characterStart, end: characterEnd });
        byFieldPath.set(entry.fieldPath, selector);
        break;
      }
      characterStart = rulesFileContent.indexOf(entry.text, characterStart + 1);
    }
    if (!byFieldPath.has(entry.fieldPath)) {
      throw new Error(
        `Book rule ${entry.fieldPath} does not have a distinct exact-text selector in ${BOOK_RULES_PATH}`,
      );
    }
  }
  return entries.map((entry) => byFieldPath.get(entry.fieldPath)!);
}

function indexAssignments(
  values: ReadonlyArray<BookRuleAuthorityAssignment>,
  currentByKey: ReadonlyMap<string, RawEnforcementRule>,
): Map<string, BookRuleAuthorityAssignment> {
  const result = new Map<string, BookRuleAuthorityAssignment>();
  for (const value of values) {
    const key = ruleKey(value.fieldPath, value.text);
    if (!currentByKey.has(key)) {
      throw new Error(`Book rule assignment does not match exact fieldPath and text: ${value.fieldPath}`);
    }
    if (result.has(key)) {
      throw new Error(`Duplicate Book rule authority assignment: ${value.fieldPath}`);
    }
    result.set(key, value);
  }
  return result;
}

function indexCarriedEntries(
  values: ReadonlyArray<BookRuleProvenanceEntry>,
  currentByKey: ReadonlyMap<string, RawEnforcementRule>,
): Map<string, BookRuleProvenanceEntry> {
  const result = new Map<string, BookRuleProvenanceEntry>();
  for (const value of values) {
    const entry = BookRuleProvenanceEntrySchema.parse(value);
    const key = ruleKey(entry.fieldPath as BookRuleFieldPath, entry.text);
    if (!currentByKey.has(key)) {
      throw new Error(`Carried Book rule does not match exact fieldPath and text: ${entry.fieldPath}`);
    }
    if (result.has(key)) throw new Error(`Duplicate carried Book rule: ${entry.fieldPath}`);
    result.set(key, entry);
  }
  return result;
}

function validateReceiptCounts(
  receipt: {
    readonly bookRuleEntryCount: number;
    readonly provenanceRuleCount: number;
    readonly hardRuleCount: number;
    readonly authorizedHardRuleCount: number;
    readonly softRuleCount: number;
    readonly diagnosticRuleCount: number;
    readonly unauthorizedHardRuleCount: number;
    readonly coveragePassed: boolean;
    readonly rules: ReadonlyArray<BookRuleProvenanceEntry>;
  },
  ctx: z.RefinementCtx,
): void {
  const counts = {
    hard: receipt.rules.filter((entry) => entry.strength === "hard").length,
    authorizedHard: receipt.rules.filter(
      (entry) => entry.strength === "hard" && hasDeclaredHardEvidence(entry),
    ).length,
    soft: receipt.rules.filter((entry) => entry.strength === "soft").length,
    diagnostic: receipt.rules.filter((entry) => entry.strength === "diagnostic").length,
  };
  const uniqueRuleIds = new Set(receipt.rules.map((entry) => entry.ruleId));
  const uniqueFieldPaths = new Set(receipt.rules.map((entry) => entry.fieldPath));
  const valid = receipt.bookRuleEntryCount === receipt.rules.length
    && receipt.provenanceRuleCount === receipt.rules.length
    && receipt.hardRuleCount === counts.hard
    && receipt.authorizedHardRuleCount === counts.authorizedHard
    && receipt.softRuleCount === counts.soft
    && receipt.diagnosticRuleCount === counts.diagnostic
    && receipt.unauthorizedHardRuleCount === counts.hard - counts.authorizedHard
    && receipt.hardRuleCount + receipt.softRuleCount + receipt.diagnosticRuleCount === receipt.rules.length
    && receipt.authorizedHardRuleCount === receipt.hardRuleCount
    && receipt.unauthorizedHardRuleCount === 0
    && uniqueRuleIds.size === receipt.rules.length
    && uniqueFieldPaths.size === receipt.rules.length;
  if (!valid || receipt.coveragePassed !== valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coveragePassed"],
      message: "Book rule counts, coverage, uniqueness, and authorized hard-rule counts must agree exactly",
    });
  }
}

function hasDeclaredHardEvidence(
  entry: Pick<
    BookRuleProvenanceEntry,
    "source" | "sourceSelector" | "sourceAuthority" | "ownerAdoption"
  >,
): boolean {
  if (entry.ownerAdoption) return true;
  return Boolean(
    entry.sourceSelector
    && entry.sourceAuthority
    && DirectBookRuleSourceSchema.safeParse(entry.source).success,
  );
}

function kindForFieldPath(fieldPath: BookRuleFieldPath): BookRuleKind {
  return fieldPath.startsWith("protagonist.behavioralConstraints[") ? "fact" : "prohibition";
}

function sourceSelectorPayload(selector: Omit<ExactBookRuleSourceSelector, "selectorSha256">): object {
  return {
    artifactPath: selector.artifactPath,
    artifactSha256: selector.artifactSha256,
    rangeEncoding: selector.rangeEncoding,
    start: selector.start,
    end: selector.end,
    selectedTextSha256: selector.selectedTextSha256,
  };
}

function bookRulesSelectorPayload(selector: Omit<ExactBookRulesSelector, "selectorSha256">): object {
  return {
    path: selector.path,
    coordinate: selector.coordinate,
    start: selector.start,
    end: selector.end,
    textSha256: selector.textSha256,
  };
}

function unwrapReadResult(candidate: unknown):
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly rawSidecar: string; readonly reason: string }
  | { readonly status: "loaded"; readonly rawSidecar?: string; readonly value: unknown } {
  if (candidate === null || candidate === undefined) return { status: "missing" };
  if (typeof candidate === "object" && candidate && "status" in candidate) {
    const status = (candidate as { status?: unknown }).status;
    if (status === "missing") return { status: "missing" };
    if (status === "invalid") {
      const read = candidate as Extract<BookRuleProvenanceReadResult, { status: "invalid" }>;
      return { status: "invalid", rawSidecar: read.rawSidecar, reason: read.reason };
    }
    if (status === "loaded") {
      const read = candidate as Extract<BookRuleProvenanceReadResult, { status: "loaded" }>;
      return { status: "loaded", rawSidecar: read.rawSidecar, value: read.value };
    }
  }
  return { status: "loaded", value: candidate };
}

function ruleIdFor(kind: BookRuleKind, fieldPath: BookRuleFieldPath, textSha256: string): string {
  return `brp:${hashCanonicalJson({ kind, fieldPath, textSha256 }).slice(0, 32)}`;
}

function ruleKey(fieldPath: BookRuleFieldPath, text: string): string {
  return `${fieldPath}\0${text}`;
}

function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
