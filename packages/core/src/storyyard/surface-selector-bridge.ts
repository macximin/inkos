import { createHash } from "node:crypto";
import { z } from "zod";

import {
  FireflySurfaceMatchV2Schema,
  type FireflySurfaceMatchV2,
} from "./review-packet-v2.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const Sha256Schema = z.string().regex(SHA256);

const Utf8SpanSchema = z.object({
  coordinateKind: z.literal("utf8-byte"),
  startByte: z.number().int().min(0),
  endByte: z.number().int().min(1),
  sliceSha256: Sha256Schema,
}).strict();

const StoryBridgeInputSchema = z.object({
  kind: z.literal("story-index-utf16"),
  provenanceId: z.string().min(1),
  sourceCharacterRange: z.object({
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  }).strict(),
  rawProseSha256: Sha256Schema,
}).strict();

const StyleBridgeInputSchema = z.object({
  kind: z.literal("style-example-prose"),
  provenanceId: z.string().min(1),
  rawProseSha256: Sha256Schema,
  prose: z.string().min(1),
  importedSourceSelector: Utf8SpanSchema.nullable().optional(),
}).strict();

export const FireflySurfaceProvenanceInputV1Schema = z.discriminatedUnion("kind", [
  StoryBridgeInputSchema,
  StyleBridgeInputSchema,
]);
export type FireflySurfaceProvenanceInputV1 = z.infer<typeof FireflySurfaceProvenanceInputV1Schema>;

export const FireflySurfaceProvenanceBridgeReceiptV1Schema = z.object({
  schemaVersion: z.literal("firefly_surface_provenance_bridge/v1"),
  converterVersion: z.literal("inkos-utf8-selector-bridge/1"),
  receiptSha256: Sha256Schema,
  sourceId: z.string().min(1),
  sourceSha256: Sha256Schema,
  provenance: z.object({
    kind: z.enum(["story-index-utf16", "style-example-prose"]),
    provenanceId: z.string().min(1),
    rawProseSha256: Sha256Schema,
    mappingMode: z.enum(["range-validated", "unique-exact-reverse-map", "imported-utf8-selector"]),
    inputRange: z.object({
      coordinateKind: z.literal("utf16-code-unit"),
      start: z.number().int().min(0),
      end: z.number().int().min(1),
    }).strict().nullable(),
    importedSelectorSha256: Sha256Schema.nullable(),
  }).strict(),
  match: z.object({
    method: z.literal("exact-token-12"),
    tokenCount: z.literal(12),
    tokenSequenceSha256: Sha256Schema,
  }).strict(),
  candidate: z.object({
    candidateContentSha256: Sha256Schema,
    startByte: z.number().int().min(0),
    endByte: z.number().int().min(1),
    candidateSliceSha256: Sha256Schema,
  }).strict(),
  source: z.object({
    startByte: z.number().int().min(0),
    endByte: z.number().int().min(1),
    sliceSha256: Sha256Schema,
  }).strict(),
}).strict();
export type FireflySurfaceProvenanceBridgeReceiptV1 = z.infer<typeof FireflySurfaceProvenanceBridgeReceiptV1Schema>;

interface TokenSpan {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface CharacterRange {
  readonly start: number;
  readonly end: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertFireflySurfaceProvenanceBridgeReceiptV1Identity(
  input: FireflySurfaceProvenanceBridgeReceiptV1,
): void {
  const receipt = FireflySurfaceProvenanceBridgeReceiptV1Schema.parse(input);
  if (receipt.candidate.endByte <= receipt.candidate.startByte || receipt.source.endByte <= receipt.source.startByte) {
    throw new Error("Surface provenance bridge receipt contains an empty selector.");
  }
  if (receipt.provenance.kind === "story-index-utf16") {
    if (receipt.provenance.mappingMode !== "range-validated"
      || !receipt.provenance.inputRange
      || receipt.provenance.importedSelectorSha256 !== null) {
      throw new Error("Story provenance bridge receipt has inconsistent mapping evidence.");
    }
  } else if (receipt.provenance.inputRange !== null
    || (receipt.provenance.mappingMode === "range-validated")
    || (receipt.provenance.mappingMode === "imported-utf8-selector") !== (receipt.provenance.importedSelectorSha256 !== null)) {
    throw new Error("Style provenance bridge receipt has inconsistent mapping evidence.");
  }
  const { receiptSha256, ...body } = receipt;
  if (sha256(JSON.stringify(body)) !== receiptSha256) {
    throw new Error("Surface provenance bridge receipt identity or SHA-256 mismatch.");
  }
}

function tokenize(value: string): ReadonlyArray<TokenSpan> {
  return [...value.matchAll(/[가-힣A-Za-z0-9]+/gu)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function assertUtf16Boundary(value: string, offset: number, label: string): void {
  if (offset < 0 || offset > value.length) throw new Error(`${label} is outside the source.`);
  if (offset > 0 && offset < value.length) {
    const previous = value.charCodeAt(offset - 1);
    const current = value.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      throw new Error(`${label} splits a UTF-16 surrogate pair.`);
    }
  }
}

function utf8Span(value: string, range: CharacterRange): { startByte: number; endByte: number; sliceSha256: string } {
  assertUtf16Boundary(value, range.start, "selector start");
  assertUtf16Boundary(value, range.end, "selector end");
  if (range.end <= range.start) throw new Error("Selector character range is empty.");
  const slice = value.slice(range.start, range.end);
  return {
    startByte: Buffer.byteLength(value.slice(0, range.start), "utf8"),
    endByte: Buffer.byteLength(value.slice(0, range.end), "utf8"),
    sliceSha256: sha256(slice),
  };
}

function decodeUtf8Span(value: string, span: z.infer<typeof Utf8SpanSchema>, label: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (span.endByte <= span.startByte || span.endByte > bytes.byteLength) {
    throw new Error(`${label} byte range is invalid.`);
  }
  const selected = bytes.subarray(span.startByte, span.endByte);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(selected);
  if (sha256(selected) !== span.sliceSha256) throw new Error(`${label} slice SHA-256 mismatch.`);
  if (Buffer.from(decoded, "utf8").compare(selected) !== 0) throw new Error(`${label} is not canonical UTF-8.`);
  return decoded;
}

function exactOccurrences(value: string, needle: string): ReadonlyArray<number> {
  const offsets: number[] = [];
  let cursor = value.indexOf(needle);
  while (cursor >= 0) {
    offsets.push(cursor);
    cursor = value.indexOf(needle, cursor + 1);
  }
  return offsets;
}

function locateTokenSequence(value: string, expectedTokens: ReadonlyArray<string>, label: string): CharacterRange {
  const tokens = tokenize(value);
  const matches: CharacterRange[] = [];
  for (let index = 0; index <= tokens.length - expectedTokens.length; index += 1) {
    if (expectedTokens.every((token, offset) => tokens[index + offset]?.value === token)) {
      matches.push({ start: tokens[index]!.start, end: tokens[index + expectedTokens.length - 1]!.end });
    }
  }
  if (matches.length !== 1) {
    throw new Error(`${label} token sequence must resolve exactly once; found ${matches.length}.`);
  }
  return matches[0]!;
}

function storyProse(value: string): string {
  const trimmed = value.trim();
  const newline = trimmed.indexOf("\n");
  return (newline >= 0 ? trimmed.slice(newline + 1) : trimmed).trim();
}

function resolveStoryProvenance(input: {
  readonly sourceText: string;
  readonly provenance: z.infer<typeof StoryBridgeInputSchema>;
}): { prose: string; proseStart: number; mappingMode: "range-validated" } {
  const { start, end } = input.provenance.sourceCharacterRange;
  assertUtf16Boundary(input.sourceText, start, "story sourceCharacterRange.start");
  assertUtf16Boundary(input.sourceText, end, "story sourceCharacterRange.end");
  if (end <= start || end > input.sourceText.length) throw new Error("Story sourceCharacterRange is invalid.");
  const rangeText = input.sourceText.slice(start, end);
  const prose = storyProse(rangeText);
  if (!prose || sha256(prose) !== input.provenance.rawProseSha256) {
    throw new Error("Story provenance prose SHA-256 mismatch.");
  }
  const offsets = exactOccurrences(rangeText, prose);
  if (offsets.length !== 1) throw new Error("Story provenance prose must resolve exactly once inside its UTF-16 range.");
  return { prose, proseStart: start + offsets[0]!, mappingMode: "range-validated" };
}

function resolveStyleProvenance(input: {
  readonly sourceText: string;
  readonly provenance: z.infer<typeof StyleBridgeInputSchema>;
}): { prose: string; proseStart: number; mappingMode: "unique-exact-reverse-map" | "imported-utf8-selector"; importedSelectorSha256: string | null } {
  const prose = input.provenance.prose;
  if (sha256(prose) !== input.provenance.rawProseSha256) throw new Error("Style provenance prose SHA-256 mismatch.");
  const imported = input.provenance.importedSourceSelector ?? null;
  if (imported) {
    const selected = decodeUtf8Span(input.sourceText, imported, "Imported style source selector");
    if (selected !== prose) throw new Error("Imported style source selector does not equal the provenanced prose.");
    const prefix = Buffer.from(input.sourceText, "utf8").subarray(0, imported.startByte);
    const prefixText = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
    return {
      prose,
      proseStart: prefixText.length,
      mappingMode: "imported-utf8-selector",
      importedSelectorSha256: sha256(JSON.stringify(imported)),
    };
  }
  const offsets = exactOccurrences(input.sourceText, prose);
  if (offsets.length !== 1) {
    throw new Error(`Style provenance prose must resolve exactly once or carry an imported UTF-8 selector; found ${offsets.length}.`);
  }
  return { prose, proseStart: offsets[0]!, mappingMode: "unique-exact-reverse-map", importedSelectorSha256: null };
}

export function bridgeExactTokenSurfaceMatchV2(input: {
  readonly candidateContent: string;
  readonly candidateContentSha256: string;
  readonly sourceId: string;
  readonly sourceText: string;
  readonly sourceSha256: string;
  readonly exactMatch: { readonly tokenCount: number; readonly text: string };
  readonly provenance: FireflySurfaceProvenanceInputV1;
}): { readonly match: FireflySurfaceMatchV2; readonly receipt: FireflySurfaceProvenanceBridgeReceiptV1 } {
  if (!input.sourceId) throw new Error("Surface bridge sourceId is required.");
  if (!SHA256.test(input.candidateContentSha256) || sha256(input.candidateContent) !== input.candidateContentSha256) {
    throw new Error("Surface bridge candidate SHA-256 mismatch.");
  }
  if (!SHA256.test(input.sourceSha256) || sha256(input.sourceText) !== input.sourceSha256) {
    throw new Error("Surface bridge source SHA-256 mismatch.");
  }
  if (input.exactMatch.tokenCount !== 12) throw new Error("Surface bridge accepts only exact-token-12 matches.");
  const matchTokens = tokenize(input.exactMatch.text).map((token) => token.value);
  if (matchTokens.length !== 12 || matchTokens.join(" ") !== input.exactMatch.text) {
    throw new Error("Surface bridge exact match text is not a canonical 12-token sequence.");
  }
  const provenance = FireflySurfaceProvenanceInputV1Schema.parse(input.provenance);
  const candidateCharacters = locateTokenSequence(input.candidateContent, matchTokens, "Candidate");
  const candidate = utf8Span(input.candidateContent, candidateCharacters);

  const resolved = provenance.kind === "story-index-utf16"
    ? { ...resolveStoryProvenance({ sourceText: input.sourceText, provenance }), importedSelectorSha256: null }
    : resolveStyleProvenance({ sourceText: input.sourceText, provenance });
  const localSourceCharacters = locateTokenSequence(resolved.prose, matchTokens, "Source provenance");
  const source = utf8Span(input.sourceText, {
    start: resolved.proseStart + localSourceCharacters.start,
    end: resolved.proseStart + localSourceCharacters.end,
  });
  if (source.endByte - source.startByte > 32_768) throw new Error("Surface bridge source selector exceeds the review boundary.");

  const receiptBody = {
    schemaVersion: "firefly_surface_provenance_bridge/v1" as const,
    converterVersion: "inkos-utf8-selector-bridge/1" as const,
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
    provenance: {
      kind: provenance.kind,
      provenanceId: provenance.provenanceId,
      rawProseSha256: provenance.rawProseSha256,
      mappingMode: resolved.mappingMode,
      inputRange: provenance.kind === "story-index-utf16"
        ? { coordinateKind: "utf16-code-unit" as const, ...provenance.sourceCharacterRange }
        : null,
      importedSelectorSha256: resolved.importedSelectorSha256,
    },
    match: {
      method: "exact-token-12" as const,
      tokenCount: 12 as const,
      tokenSequenceSha256: sha256(input.exactMatch.text),
    },
    candidate: {
      candidateContentSha256: input.candidateContentSha256,
      startByte: candidate.startByte,
      endByte: candidate.endByte,
      candidateSliceSha256: candidate.sliceSha256,
    },
    source: {
      startByte: source.startByte,
      endByte: source.endByte,
      sliceSha256: source.sliceSha256,
    },
  };
  const receipt = FireflySurfaceProvenanceBridgeReceiptV1Schema.parse({
    ...receiptBody,
    receiptSha256: sha256(JSON.stringify(receiptBody)),
  });
  assertFireflySurfaceProvenanceBridgeReceiptV1Identity(receipt);
  const selectorBody = {
    provenanceBridgeReceiptSha256: receipt.receiptSha256,
    matchMethod: "exact-token-12" as const,
    candidate: { coordinateKind: "utf8-byte" as const, ...receipt.candidate },
    source: {
      coordinateKind: "utf8-byte" as const,
      sourceId: receipt.sourceId,
      sourceSha256: receipt.sourceSha256,
      ...receipt.source,
    },
  };
  const selectorSha256 = sha256(JSON.stringify(selectorBody));
  const match = FireflySurfaceMatchV2Schema.parse({
    matchId: `fsm-${selectorSha256.slice(0, 24)}`,
    selectorSha256,
    ...selectorBody,
    classification: "pending",
  });
  return { match, receipt };
}
