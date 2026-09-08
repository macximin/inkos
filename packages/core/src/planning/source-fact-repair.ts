import { createHash } from "node:crypto";
import { z } from "zod";

type JsonObject = Record<string, unknown>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const textSchema = z.string().min(1);
const rangeSchema = z.object({ startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() }).strict();
const authoritySchema = z.object({ candidateId: idSchema.optional(), pointer: textSchema, sha256: hashSchema }).strict();
const anchorSchema = z.object({
  anchorId: idSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  sha256: hashSchema,
}).strict();
const occurrenceSchema = z.object({
  occurrenceId: idSchema,
  candidateId: idSchema,
  pointer: textSchema,
  fieldSha256: hashSchema,
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().positive(),
  before: textSchema,
  context: rangeSchema,
  role: z.enum(["source-claim", "preserved-target", "intentional-variation"]),
  variationAuthority: authoritySchema.optional(),
}).strict();
const factSchema = z.object({
  factId: idSchema,
  diagnosis: textSchema,
  anchorIds: z.array(idSchema).min(1),
  occurrences: z.array(occurrenceSchema).min(1),
}).strict();

/** A reviewed list of known occurrences, never a claim of semantic exhaustiveness. */
export const SourceFactRepairIndexSchema = z.object({
  schemaVersion: z.literal("source-fact-repair-index/v1"),
  sourceSlateSha256: hashSchema,
  sourceSha256: hashSchema,
  coverage: z.literal("declared-occurrences-only"),
  coverageNote: textSchema,
  anchors: z.array(anchorSchema).min(1),
  facts: z.array(factSchema).min(1),
}).strict();
export type SourceFactRepairIndex = z.infer<typeof SourceFactRepairIndexSchema>;

export const SourceFactRepairRequestSchema = z.object({
  schemaVersion: z.literal("source-fact-repair-request/v1"),
  index: SourceFactRepairIndexSchema,
  sourceSlateId: idSchema,
  candidateSha256: z.record(hashSchema),
  instruction: textSchema,
  instructionSha256: hashSchema,
  sourceBindingSha256: hashSchema,
  referenceInputsSha256: hashSchema,
  sourceAnchors: z.array(anchorSchema.extend({ text: textSchema, startByte: z.number().int().nonnegative(), endByte: z.number().int().positive() }).strict()).min(1),
  contexts: z.array(z.object({
    candidateId: idSchema, pointer: textSchema,
    startByte: z.number().int().nonnegative(), endByte: z.number().int().positive(),
    text: textSchema, sha256: hashSchema,
  }).strict()).min(1),
  variationAuthorities: z.array(authoritySchema.extend({ text: textSchema }).strict()),
  independentFullSourceReviewRequired: z.literal(true),
}).strict();
export type SourceFactRepairRequest = z.infer<typeof SourceFactRepairRequestSchema>;

const decisionSchema = z.object({
  occurrenceId: idSchema,
  action: z.enum(["replace", "keep"]),
  after: textSchema.optional(),
  anchorIds: z.array(idSchema).min(1),
  reason: textSchema,
}).strict();
export const SourceFactRepairResultSchema = z.object({
  schemaVersion: z.literal("source-fact-repair-result/v1"),
  requestSha256: hashSchema,
  decisions: z.array(decisionSchema).min(1),
}).strict();
export type SourceFactRepairResult = z.infer<typeof SourceFactRepairResultSchema>;

export function sourceFactRepairHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic serialization for artifacts that are parsed and written again. */
export function sourceFactRepairJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sourceFactRepairJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as JsonObject;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${sourceFactRepairJson(object[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Repair data must contain only JSON values");
  return result;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("Invalid UTF-8 or a span splits a UTF-8 character"); }
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new Error(`Invalid JSON pointer: ${pointer}`);
  const parts = pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Unsafe JSON pointer");
  return parts;
}

function atPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const part of pointerParts(pointer)) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) throw new Error(`Missing JSON pointer: ${pointer}`);
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(part)) throw new Error(`Invalid array pointer: ${pointer}`);
    current = (current as JsonObject)[part];
  }
  return current;
}

function writablePointer(pointer: string): void {
  pointerParts(pointer);
  const allowed = /^(?:\/(?:oneLinePromise|primaryReference|firstReward|surfaceVariation|longRunRisk)|\/(?:preservedSkeleton|linkedCausalAdjustments|railA|railB)\/\d+|\/protagonist\/(?:startingIdentity|repeatedVerb|firstAsset)|\/entryContract\/(?:humanDrive|purpose|commercialPromise)\/[^/]+|\/openingEpisodes\/\d+\/(?:event|visiblePayoff)|\/arcLadder\/\d+\/(?:externalMove|visibleReward|relationshipConversion)|\/supportingReferenceRoutes\/\d+\/(?:reference|role|targetArc)|\/projectPlan\/markdown|\/spineRetention\/(?:sourceReconstruction|preservedEngine)\/[^/]+|\/spineRetention\/referenceDisclosure\/(?:selectionReason|preservedElements\/\d+|transformedElements\/\d+)|\/spineRetention\/(?:openingEpisodeMappings|surfaceChanges|rewards|decisionComparisons|hookProgression)\/\d+\/[^/]+)$/;
  if (!allowed.test(pointer)) throw new Error(`Not a repairable candidate prose field: ${pointer}`);
  // Identifiers and source coordinates remain exact even when they happen to be strings.
  if (/\/(?:schemaVersion|sourceArcId|sourceBeatSequence|sourceSequenceStart|sourceSequenceEnd|layer|kind|episode|packId|workSlug|workTitle|sha256|sourceSha256|packSha256|id|field)$/.test(pointer)) {
    throw new Error(`Source metadata is not repairable prose: ${pointer}`);
  }
}

function sliceText(text: string, start: number, end: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (start < 0 || end <= start || end > bytes.length) throw new Error("Invalid UTF-8 byte range");
  // Check both sides too: empty range edges otherwise conceal split codepoints.
  utf8(bytes.subarray(0, start)); utf8(bytes.subarray(end));
  return utf8(bytes.subarray(start, end));
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}

function parseSlate(slateBytes: Uint8Array): { slate: JsonObject; candidates: Map<string, JsonObject> } {
  const slate = object(JSON.parse(utf8(slateBytes)), "slate");
  if (slate.schemaVersion !== 2 || slate.planningMode !== "source-first" || slate.canonStatus !== "non-canonical") throw new Error("Fact repair requires a non-canonical source-first slate with native schemaVersion 2");
  idSchema.parse(slate.slateId);
  if (!Array.isArray(slate.candidates) || !slate.candidates.length) throw new Error("Slate candidates are missing");
  const candidates = new Map<string, JsonObject>();
  for (const value of slate.candidates) {
    const candidate = object(value, "candidate");
    const id = idSchema.parse(candidate.candidateId);
    if (!/^p\d{2}$/.test(id)) throw new Error("Candidate IDs must match the native pitch review pNN contract");
    if (candidates.has(id)) throw new Error("Duplicate candidate ID");
    candidates.set(id, candidate);
  }
  if (slate.candidateCount !== candidates.size) throw new Error("Candidate count mismatch");
  return { slate, candidates };
}

export function buildSourceFactRepairRequest(params: {
  slateBytes: Uint8Array; sourceBytes: Uint8Array; index: unknown;
}): SourceFactRepairRequest {
  const index = SourceFactRepairIndexSchema.parse(params.index);
  if (sourceFactRepairHash(params.slateBytes) !== index.sourceSlateSha256) throw new Error("Stale source slate SHA");
  if (sourceFactRepairHash(params.sourceBytes) !== index.sourceSha256) throw new Error("Stale original source SHA");
  const { slate, candidates } = parseSlate(params.slateBytes);
  const binding = object(slate.sourceFirstReference, "source binding");
  if (binding.sourceSha256 !== index.sourceSha256) throw new Error("Original source SHA does not match the slate binding");
  const instruction = textSchema.parse(slate.instruction);
  if (sourceFactRepairHash(instruction) !== slate.instructionSha256) throw new Error("Stale instruction SHA");
  if (!Array.isArray(slate.referenceInputs) || !slate.referenceInputs.length) throw new Error("Missing reference inputs");
  unique(index.anchors.map((anchor) => anchor.anchorId), "anchor ID");
  unique(index.facts.map((fact) => fact.factId), "fact ID");
  unique(index.facts.flatMap((fact) => fact.occurrences.map((item) => item.occurrenceId)), "occurrence ID");
  utf8(params.sourceBytes);
  const starts = [0];
  for (let offset = 0; offset < params.sourceBytes.length; offset++) if (params.sourceBytes[offset] === 10 && offset + 1 < params.sourceBytes.length) starts.push(offset + 1);
  const sourceAnchors = index.anchors.map((anchor) => {
    if (anchor.endLine < anchor.startLine || anchor.endLine > starts.length) throw new Error("Invalid source line range");
    const startByte = starts[anchor.startLine - 1]!;
    const endByte = starts[anchor.endLine] ?? params.sourceBytes.length;
    const bytes = params.sourceBytes.subarray(startByte, endByte);
    if (sourceFactRepairHash(bytes) !== anchor.sha256) throw new Error(`Stale source anchor SHA: ${anchor.anchorId}`);
    return { ...anchor, startByte, endByte, text: utf8(bytes) };
  });
  const anchors = new Set(index.anchors.map((item) => item.anchorId));
  const contexts = new Map<string, SourceFactRepairRequest["contexts"][number]>();
  const authorities = new Map<string, SourceFactRepairRequest["variationAuthorities"][number]>();
  const spans = new Map<string, Array<{ start: number; end: number }>>();
  for (const fact of index.facts) {
    unique(fact.anchorIds, "fact anchor");
    if (fact.anchorIds.some((id) => !anchors.has(id))) throw new Error(`Unknown anchor in fact ${fact.factId}`);
    for (const occurrence of fact.occurrences) {
      const candidate = candidates.get(occurrence.candidateId);
      if (!candidate) throw new Error(`Unknown candidate: ${occurrence.candidateId}`);
      writablePointer(occurrence.pointer);
      const field = textSchema.parse(atPointer(candidate, occurrence.pointer));
      if (sourceFactRepairHash(field) !== occurrence.fieldSha256) throw new Error(`Stale field SHA: ${occurrence.occurrenceId}`);
      if (sliceText(field, occurrence.startByte, occurrence.endByte) !== occurrence.before) throw new Error(`Stale before span: ${occurrence.occurrenceId}`);
      if (occurrence.context.startByte > occurrence.startByte || occurrence.context.endByte < occurrence.endByte) throw new Error("Context must contain its complete occurrence");
      const contextText = sliceText(field, occurrence.context.startByte, occurrence.context.endByte);
      const contextKey = sourceFactRepairJson([occurrence.candidateId, occurrence.pointer, occurrence.context]);
      contexts.set(contextKey, { candidateId: occurrence.candidateId, pointer: occurrence.pointer, ...occurrence.context, text: contextText, sha256: sourceFactRepairHash(contextText) });
      const fieldKey = sourceFactRepairJson([occurrence.candidateId, occurrence.pointer]);
      const knownSpans = spans.get(fieldKey) ?? [];
      if (knownSpans.some((span) => occurrence.startByte < span.end && span.start < occurrence.endByte)) throw new Error("Overlapping declared occurrences");
      knownSpans.push({ start: occurrence.startByte, end: occurrence.endByte }); spans.set(fieldKey, knownSpans);
      if (occurrence.role === "intentional-variation" && !occurrence.variationAuthority) throw new Error("Intentional variation requires an existing variation authority");
      if (occurrence.variationAuthority) {
        const authority = occurrence.variationAuthority;
        const owner = authority.candidateId ? candidates.get(authority.candidateId) : slate;
        if (!owner || (!authority.candidateId && authority.pointer !== "/instruction")) throw new Error("Variation authority must be instruction or an existing candidate prose field");
        if (authority.candidateId) writablePointer(authority.pointer);
        const text = textSchema.parse(atPointer(owner, authority.pointer));
        if (sourceFactRepairHash(text) !== authority.sha256) throw new Error("Stale variation authority SHA");
        authorities.set(sourceFactRepairJson(authority), { ...authority, text });
      }
    }
  }
  return SourceFactRepairRequestSchema.parse({
    schemaVersion: "source-fact-repair-request/v1", index, sourceSlateId: slate.slateId,
    candidateSha256: Object.fromEntries([...candidates].map(([id, candidate]) => [id, sourceFactRepairHash(sourceFactRepairJson(candidate))])),
    instruction, instructionSha256: slate.instructionSha256,
    sourceBindingSha256: sourceFactRepairHash(sourceFactRepairJson(binding)),
    referenceInputsSha256: sourceFactRepairHash(sourceFactRepairJson(slate.referenceInputs)),
    sourceAnchors, contexts: [...contexts.values()], variationAuthorities: [...authorities.values()],
    independentFullSourceReviewRequired: true,
  });
}

export function validateSourceFactRepairResult(requestInput: unknown, resultInput: unknown): SourceFactRepairResult {
  const request = SourceFactRepairRequestSchema.parse(requestInput);
  const result = SourceFactRepairResultSchema.parse(resultInput);
  if (result.requestSha256 !== sourceFactRepairHash(sourceFactRepairJson(request))) throw new Error("Repair response request SHA mismatch");
  unique(result.decisions.map((item) => item.occurrenceId), "repair decision");
  const decisions = new Map(result.decisions.map((item) => [item.occurrenceId, item]));
  const occurrences = request.index.facts.flatMap((fact) => fact.occurrences);
  if (decisions.size !== occurrences.length) throw new Error("Every declared occurrence requires exactly one replace or keep decision");
  for (const fact of request.index.facts) {
    for (const occurrence of fact.occurrences) {
      const decision = decisions.get(occurrence.occurrenceId);
      if (!decision) throw new Error(`Missing decision for declared occurrence: ${occurrence.occurrenceId}`);
      unique(decision.anchorIds, "decision anchor");
      if (decision.anchorIds.some((id) => !fact.anchorIds.includes(id))) throw new Error("Decision cites an anchor outside its fact");
      if (decision.action === "keep" && decision.after !== undefined) throw new Error("Keep decisions must not contain after text");
      if (decision.action === "replace") {
        if (occurrence.role === "intentional-variation") throw new Error("Intentional variation is protected from factual repair");
        if (!decision.after?.trim() || decision.after === occurrence.before || decision.after.includes("\0")) throw new Error("Replacement requires different, nonempty prose");
        // Buffer.from silently replaces lone surrogates; never silently change a response.
        if (Buffer.from(decision.after).toString("utf8") !== decision.after) throw new Error("Invalid replacement Unicode");
      }
    }
  }
  return result;
}

/** Pure candidate patching. CLI performs whole-candidate validation and immutable publication. */
export function applySourceFactRepairResult(params: {
  slateBytes: Uint8Array; sourceBytes: Uint8Array; request: unknown; result: unknown;
}): { candidates: JsonObject[]; changedFields: Array<{ candidateId: string; pointer: string; beforeSha256: string; afterSha256: string }>; coverage: "declared-occurrences-only"; semanticFidelity: "unverified" } {
  const request = SourceFactRepairRequestSchema.parse(params.request);
  const rebuilt = buildSourceFactRepairRequest({ ...params, index: request.index });
  if (sourceFactRepairJson(rebuilt) !== sourceFactRepairJson(request)) throw new Error("Prepared repair request no longer matches its source data");
  const result = validateSourceFactRepairResult(request, params.result);
  const { candidates } = parseSlate(params.slateBytes);
  const decisions = new Map(result.decisions.map((item) => [item.occurrenceId, item]));
  const groups = new Map<string, { candidateId: string; pointer: string; edits: Array<{ startByte: number; endByte: number; after: string }> }>();
  for (const occurrence of request.index.facts.flatMap((fact) => fact.occurrences)) {
    const decision = decisions.get(occurrence.occurrenceId)!;
    if (decision.action === "keep") continue;
    const key = sourceFactRepairJson([occurrence.candidateId, occurrence.pointer]);
    const group = groups.get(key) ?? { candidateId: occurrence.candidateId, pointer: occurrence.pointer, edits: [] };
    group.edits.push({ startByte: occurrence.startByte, endByte: occurrence.endByte, after: decision.after! }); groups.set(key, group);
  }
  const changedFields: Array<{ candidateId: string; pointer: string; beforeSha256: string; afterSha256: string }> = [];
  for (const group of groups.values()) {
    const candidate = candidates.get(group.candidateId)!;
    const before = atPointer(candidate, group.pointer) as string;
    let bytes = Buffer.from(before, "utf8");
    for (const edit of group.edits.sort((a, b) => b.startByte - a.startByte)) {
      bytes = Buffer.concat([bytes.subarray(0, edit.startByte), Buffer.from(edit.after, "utf8"), bytes.subarray(edit.endByte)]);
    }
    const after = utf8(bytes);
    const parts = pointerParts(group.pointer); const leaf = parts.pop()!;
    let owner: unknown = candidate;
    for (const part of parts) owner = (owner as JsonObject)[part];
    (owner as JsonObject)[leaf] = after;
    changedFields.push({ candidateId: group.candidateId, pointer: group.pointer, beforeSha256: sourceFactRepairHash(before), afterSha256: sourceFactRepairHash(after) });
  }
  return { candidates: [...candidates.values()], changedFields, coverage: "declared-occurrences-only", semanticFidelity: "unverified" };
}
