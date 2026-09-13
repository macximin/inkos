import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ArcPacketSchema } from "../arc/schema.js";
import { StoryRailPlanSchema } from "../arc/rail-schema.js";
import { ArcStore } from "../arc/store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { StateManager } from "../state/manager.js";
import { BookConfigSchema, type BookConfig } from "../models/book.js";
import { ReferencePackSchema, ReferenceStoryIndexEntrySchema, ReferenceStyleExampleSchema, ReferenceTransformationSchema } from "../reference/schema.js";
import { ReferencePackStore } from "../reference/store.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { hashCanonicalJson } from "../storyyard/pitch-review-packet.js";
import { FireflyPlanningAdmissionSchema, FireflyEntryContractSchema, hashEntryContract } from "./entry-contract.js";
import { FireflyPitchSourceBindingSchema } from "./human-premise.js";
import { FireflySpineRetentionContractV2Schema } from "./spine-retention.js";
import { VariationProjectPlanSchema } from "./webnovel-plan-format.js";

const Sha = z.string().regex(/^[a-f0-9]{64}$/u);
const SafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u);
const FileRef = z.object({ path: z.string().min(1), sha256: Sha }).strict();
export const HANDOFF_FOUNDATION_PATHS = ["story_bible.md", "volume_outline.md", "character_matrix.md", "book_rules.md", "current_state.md", "pending_hooks.md"] as const;
const FoundationFile = z.object({ target: z.enum(HANDOFF_FOUNDATION_PATHS), file: FileRef }).strict();
const SourceIdentity = z.object({
  slateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u), candidateId: z.string().regex(/^p\d{2}$/u), candidateSha256: Sha,
  sourceSlateSha256: Sha, sourceReviewSha256: Sha, sourceDecisionSha256: Sha,
}).strict();

/** A pitch railA/railB list is not a production A/B rail. Every conversion is explicit. */
export const SourceFirstHandoffMappingSchema = z.object({
  schemaVersion: z.literal("firefly_source_first_handoff_mapping/v1"),
  bookId: SafeId,
  source: SourceIdentity,
  sourceBinding: FireflyPitchSourceBindingSchema,
  files: z.object({ pack: FileRef, source: FileRef, receipt: FileRef }).strict(),
  foundationFiles: z.array(FoundationFile).length(HANDOFF_FOUNDATION_PATHS.length),
  railPlan: StoryRailPlanSchema,
  activeArc: ArcPacketSchema,
  transformation: ReferenceTransformationSchema,
  evidence: z.array(z.object({
    target: z.string().min(1),
    planSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), sha256: Sha }).strict(),
    reason: z.string().trim().min(8).max(2000),
  }).strict()).min(1).max(250),
}).strict();

/** The adapter only reads this authorization. It has no command that creates approval. */
export const SourceFirstHandoffAuthorizationSchema = z.object({
  schemaVersion: z.literal("firefly_source_first_handoff_authorization/v1"),
  mappingSha256: Sha,
  admission: FireflyPlanningAdmissionSchema,
  authorizedBy: z.string().trim().min(1).max(200),
  canonEffect: z.literal("planning-seed-only"),
  manuscriptAuthorized: z.literal(false),
}).strict();

export const SourceFirstHandoffManifestSchema = z.object({
  schemaVersion: z.literal("firefly_source_first_handoff/v1"),
  mapping: FileRef,
  authorization: FileRef,
}).strict();

type SourceIdentity = z.infer<typeof SourceIdentity>;
export interface SourceFirstHandoffSubject extends SourceIdentity {
  readonly bookId: string;
  readonly candidate: Record<string, unknown>;
}
export type ValidatedSourceFirstHandoff = Awaited<ReturnType<typeof validateSourceFirstHandoff>>;
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const fail = (path: string, message: string): never => { throw new Error(`Source-first handoff ${path}: ${message}`); };

async function evidenceFile(projectRoot: string, file: z.infer<typeof FileRef>, label: string, limit = 40 * 1024 * 1024) {
  if (isAbsolute(file.path) || file.path.includes("\\") || file.path.split("/").some((part) => !part || part === "." || part === "..")) fail(label, "path must be a project-relative path without traversal");
  const root = await realpath(projectRoot);
  const path = resolve(root, file.path);
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) fail(label, "path escapes the project root");
  const info = await lstat(actual);
  if (!info.isFile() || info.size > limit) fail(label, `must be a regular file no larger than ${limit} bytes`);
  const bytes = await readFile(actual);
  if (bytes.length > limit || sha(bytes) !== file.sha256) fail(label, "file SHA-256 mismatch or size limit exceeded");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail(label, "must be UTF-8 text"); }
  if (text.includes("\0")) fail(label, "NUL is not allowed in text evidence");
  return { path: actual, bytes, text };
}
function json(text: string, label: string): unknown {
  try { return JSON.parse(text); } catch { return fail(label, "must be valid JSON"); }
}
function equal(a: unknown, b: unknown): boolean { return hashCanonicalJson(a) === hashCanonicalJson(b); }
function jsonLines<T>(text: string, schema: z.ZodType<T>, label: string): T[] {
  return text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => schema.parse(json(line, label)));
}

/** Read-only preflight. All files are read and checked before any Book is created. */
export async function validateSourceFirstHandoff(input: {
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly subject: SourceFirstHandoffSubject;
}) {
  const manifestPath = await realpath(resolve(input.projectRoot, input.manifestPath));
  const manifestRelative = relative(await realpath(input.projectRoot), manifestPath);
  if (manifestRelative === ".." || manifestRelative.startsWith("../") || manifestRelative.startsWith("..\\") || isAbsolute(manifestRelative)) fail("manifest", "path escapes the project root");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > 256 * 1024) fail("manifest", "must be a regular file no larger than 256 KiB");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.length > 256 * 1024) fail("manifest", "size limit exceeded");
  const manifest = SourceFirstHandoffManifestSchema.parse(json(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes), "manifest"));
  const mappingFile = await evidenceFile(input.projectRoot, manifest.mapping, "mapping", 2 * 1024 * 1024);
  const authorizationFile = await evidenceFile(input.projectRoot, manifest.authorization, "authorization", 256 * 1024);
  const mapping = SourceFirstHandoffMappingSchema.parse(json(mappingFile.text, "mapping"));
  const authorization = SourceFirstHandoffAuthorizationSchema.parse(json(authorizationFile.text, "authorization"));
  const subject = input.subject;
  const { bookId: _bookId, candidate: _candidate, ...identity } = subject;
  if (mapping.bookId !== subject.bookId || !equal(mapping.source, identity)) fail("source", "Book, candidate, slate, review or selection differs from the current reviewed input");
  if (sha(mappingFile.bytes) !== authorization.mappingSha256) fail("authorization.mappingSha256", "authorization does not cover these exact mapping bytes");
  if (hashCanonicalJson(subject.candidate) !== subject.candidateSha256) fail("candidateSha256", "candidate content mismatch");
  try {
    const invalidations = z.object({ invalidations: z.array(z.unknown()) }).passthrough().parse(json(await readFile(join(input.projectRoot, "config", "pitch-slate-invalidations.json"), "utf8"), "invalidations"));
    if (invalidations.invalidations.some((value) => value !== null && typeof value === "object"
      && (value as Record<string, unknown>).slateId === subject.slateId && (value as Record<string, unknown>).sourceSlateSha256 === subject.sourceSlateSha256)) fail("native.slate", "selected slate is invalidated");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const nativeDir = `.inkos/pitch-slates/${subject.slateId}`;
  const [nativeSlateFile, nativeReviewFile, nativeDecisionFile] = await Promise.all([
    evidenceFile(input.projectRoot, { path: `${nativeDir}/slate.json`, sha256: subject.sourceSlateSha256 }, "native.slate"),
    evidenceFile(input.projectRoot, { path: `${nativeDir}/survival-review/review.json`, sha256: subject.sourceReviewSha256 }, "native.review"),
    evidenceFile(input.projectRoot, { path: `${nativeDir}/human-decision/decision.json`, sha256: subject.sourceDecisionSha256 }, "native.decision"),
  ]);
  const nativeSlate = z.object({ slateId: z.string(), planningMode: z.literal("source-first"), candidates: z.array(z.record(z.unknown())) }).passthrough().parse(json(nativeSlateFile.text, "native.slate"));
  const nativeReview = z.object({ slateId: z.string(), sourceSlateSha256: Sha, reviewKind: z.literal("independent-blind-comparison") }).passthrough().parse(json(nativeReviewFile.text, "native.review"));
  const nativeDecision = z.object({ slateId: z.string(), candidateId: z.string(), decision: z.literal("select"), sourceSlateSha256: Sha, sourceReviewSha256: Sha,
    canonEffect: z.literal("planning-selection-only"), manuscriptAuthorized: z.literal(false) }).passthrough().parse(json(nativeDecisionFile.text, "native.decision"));
  if ([nativeSlate.slateId, nativeReview.slateId, nativeDecision.slateId].some((id) => id !== subject.slateId)
    || nativeReview.sourceSlateSha256 !== subject.sourceSlateSha256 || nativeDecision.sourceSlateSha256 !== subject.sourceSlateSha256
    || nativeDecision.sourceReviewSha256 !== subject.sourceReviewSha256 || nativeDecision.candidateId !== subject.candidateId
    || !equal(nativeSlate.candidates.find((candidate) => candidate.candidateId === subject.candidateId) ?? null, subject.candidate)) fail("native", "reviewed slate and selection do not match the current candidate");
  const entry = FireflyEntryContractSchema.parse(subject.candidate.entryContract);
  VariationProjectPlanSchema.parse(subject.candidate.projectPlan);
  const planText = (subject.candidate.projectPlan as { markdown: string }).markdown;
  const spine = FireflySpineRetentionContractV2Schema.parse(subject.candidate.spineRetention);
  const admission = authorization.admission;
  if (admission.bookId !== subject.bookId || admission.sourceSlateId !== subject.slateId
    || admission.sourceSlateSha256 !== subject.sourceSlateSha256 || admission.sourceReviewSha256 !== subject.sourceReviewSha256
    || admission.sourceDecisionSha256 !== subject.sourceDecisionSha256 || !equal(admission.entryContract, entry)
    || admission.entryContractSha256 !== hashEntryContract(entry)) fail("authorization.admission", "existing planning admission does not match the selected entry contract and provenance");
  if (new Set(mapping.foundationFiles.map((item) => item.target)).size !== HANDOFF_FOUNDATION_PATHS.length) fail("foundationFiles", "each required foundation file must appear exactly once");
  const foundationFiles = await Promise.all(mapping.foundationFiles.map(async (item) => ({ target: item.target, ...await evidenceFile(input.projectRoot, item.file, `foundationFiles.${item.target}`, 256 * 1024) })));
  if (foundationFiles.some((item) => !item.text.trim())) fail("foundationFiles", "explicit non-empty foundation text required; no model-generated defaults");
  const binding = mapping.sourceBinding;
  if (!equal(spine.primaryReference, { packId: binding.packId, packSha256: binding.packSha256, sourceSha256: binding.sourceSha256 })) fail("sourceBinding", "candidate primary reference differs from the bound pack");
  if (mapping.files.pack.sha256 !== binding.packSha256 || mapping.files.source.sha256 !== binding.sourceSha256) fail("files", "source/pack hashes differ from source binding");
  const [packFile, sourceFile, receiptFile, storyFile, styleFile] = await Promise.all([
    evidenceFile(input.projectRoot, mapping.files.pack, "files.pack"),
    evidenceFile(input.projectRoot, mapping.files.source, "files.source", 100 * 1024 * 1024),
    evidenceFile(input.projectRoot, mapping.files.receipt, "files.receipt", 256 * 1024),
    evidenceFile(input.projectRoot, binding.storyIndex, "sourceBinding.storyIndex"),
    evidenceFile(input.projectRoot, binding.styleExamples, "sourceBinding.styleExamples"),
  ]);
  const pack = ReferencePackSchema.parse(json(packFile.text, "files.pack"));
  const receipt = z.object({ packId: z.string(), packSha256: Sha, sourceSha256: Sha, storyIndexSha256: Sha, styleExamplesSha256: Sha }).passthrough().parse(json(receiptFile.text, "files.receipt"));
  if (pack.id !== binding.packId || pack.source.sourceSha256 !== binding.sourceSha256
    || !binding.sourceWork || !equal(binding.sourceWork, { workSlug: pack.source.workSlug, workTitle: pack.source.workTitle })
    || pack.privateInputs.storyIndexSha256 !== binding.storyIndex.sha256 || pack.privateInputs.styleExamplesSha256 !== binding.styleExamples.sha256
    || receipt.packId !== binding.packId || receipt.packSha256 !== binding.packSha256 || receipt.sourceSha256 !== binding.sourceSha256
    || receipt.storyIndexSha256 !== binding.storyIndex.sha256 || receipt.styleExamplesSha256 !== binding.styleExamples.sha256) fail("sourceBinding", "pack, source receipt and selected evidence are not bound to each other");
  const story = jsonLines(storyFile.text, ReferenceStoryIndexEntrySchema, "story index");
  const styles = jsonLines(styleFile.text, ReferenceStyleExampleSchema, "style examples");
  if (new Set(story.map((item) => item.sequence)).size !== story.length || new Set(styles.map((item) => item.id)).size !== styles.length) fail("sourceBinding", "duplicate story sequence or style ID");
  if (story.length !== pack.storyRetrieval.indexedChapterCount || styles.length !== pack.styleRetrieval.sampleCount) fail("sourceBinding", "index/sample counts differ from pack");
  for (const bound of binding.storyIndex.selected) {
    const found = story.find((item) => item.sequence === bound.sequence);
    if (!found) return fail(`storyIndex.${bound.sequence}`, "selected source beat is absent");
    if (!equal(bound, { sequence: found.sequence, arcId: found.arcId, sourceLineRange: found.sourceLineRange, sourceCharacterRange: found.sourceCharacterRange, rawProseSha256: found.rawProseSha256 })) fail(`storyIndex.${bound.sequence}`, "selected source beat differs from bound index");
    const raw = sourceFile.text.slice(found.sourceCharacterRange.start, found.sourceCharacterRange.end).trim();
    const newline = raw.indexOf("\n");
    const prose = (newline >= 0 ? raw.slice(newline + 1) : raw).trim();
    if (sha(prose) !== found.rawProseSha256) fail(`storyIndex.${bound.sequence}`, "source character range does not reproduce the bound prose");
  }
  for (const style of styles) if (sha(style.prose) !== style.rawProseSha256) fail(`styleExamples.${style.id}`, "prose hash mismatch");
  for (const bound of binding.styleExamples.selected) {
    const found = styles.find((item) => item.id === bound.id);
    if (!found || !equal(bound, { id: found.id, sequence: found.sequence, arcId: found.arcId, rawProseSha256: found.rawProseSha256 })) fail(`styleExamples.${bound.id}`, "selected style example differs from bound index");
  }
  await Promise.all(binding.structureInputs.map((ref) => evidenceFile(input.projectRoot, ref, `structureInputs.${ref.role}`)));
  const boundSequences = new Set(binding.storyIndex.selected.map((item) => item.sequence));
  for (const item of spine.openingEpisodeMappings) if (!binding.storyIndex.selected.some((bound) => bound.sequence === item.sourceBeatSequence && bound.arcId === item.sourceArcId)) fail("spineRetention.openingEpisodeMappings", "opening source beat or Arc is outside the selected binding");
  const rails = mapping.railPlan;
  const arc = mapping.activeArc;
  const transformation = mapping.transformation;
  if ([rails.bookId, arc.bookId, transformation.bookId].some((id) => id !== subject.bookId)) fail("bookId", "Rail, Arc and transformation must target this Book");
  if (rails.anchorRail.status !== "ready" || rails.arcRouteRail.status !== "ready" || arc.status !== "ready") fail("railPlan", "explicit ready A/B Rail and active Arc required for this handoff");
  if (rails.anchorRail.anchors.some((item) => item.state !== "planned") || rails.arcRouteRail.entries.some((item) => item.status === "closed" || item.status === "retired")) fail("railPlan", "a new planning Book cannot import reached, closed or retired history");
  const active = rails.arcRouteRail.entries.find((item) => item.status === "active");
  if (!active || active.arcId !== arc.id || arc.chapterNumbers[0] !== 1) fail("activeArc", "active B must bind the supplied first-chapter Arc");
  if (transformation.referencePackId !== binding.packId || transformation.spineReference !== pack.source.workSlug) fail("transformation", "transformation reference differs from bound source");
  const targets = new Set(rails.anchorRail.anchors.map((item) => item.id));
  const targetArcs = new Set(rails.arcRouteRail.entries.flatMap((item) => item.arcId ? [item.arcId] : []));
  if (new Set(transformation.sourceSegments.map((item) => item.id)).size !== transformation.sourceSegments.length) fail("transformation", "segment IDs must be unique");
  const usedArcs = new Set<string>();
  for (const segment of transformation.sourceSegments) {
    if (segment.sourceChapterIds.some((id) => !boundSequences.has(id)) || segment.sourceArcIds.some((id) => !binding.storyIndex.selected.some((item) => item.arcId === id))
      || segment.targetRailAnchorIds.some((id) => !targets.has(id)) || segment.targetArcIds.some((id) => !targetArcs.has(id))) fail(`transformation.${segment.id}`, "unbound source or target reference");
    for (const sourceId of segment.sourceChapterIds) {
      const sourceArc = binding.storyIndex.selected.find((item) => item.sequence === sourceId)?.arcId;
      if (!sourceArc || !segment.sourceArcIds.includes(sourceArc)) fail(`transformation.${segment.id}`, "selected source chapter does not belong to the declared source Arc");
    }
    for (const targetArc of segment.targetArcIds) {
      const targetAnchor = rails.arcRouteRail.entries.find((item) => item.arcId === targetArc)?.targetAnchorId;
      if (!targetAnchor || !segment.targetRailAnchorIds.includes(targetAnchor)) fail(`transformation.${segment.id}`, "target Arc and target anchor mapping disagree");
    }
    for (const id of segment.targetArcIds) { if (usedArcs.has(id)) fail("transformation", `Arc ${id} has ambiguous source segments`); usedArcs.add(id); }
  }
  if (!usedArcs.has(arc.id)) fail("transformation", "active Arc has no selected source segment");
  const expectedTargets = new Set([
    ...Object.entries(entry).flatMap(([section, fields]) => Object.keys(fields).map((field) => `entryContract/${section}/${field}`)),
    ...mapping.foundationFiles.map((item) => `foundation/${item.target}`),
    ...rails.anchorRail.anchors.map((item) => `anchor/${item.id}`),
    ...rails.arcRouteRail.entries.map((item) => `route/${item.bId}`),
    ...transformation.sourceSegments.map((item) => `transformation/${item.id}`),
    `arc/${arc.id}`,
  ]);
  const seen = new Set<string>();
  for (const evidence of mapping.evidence) {
    if (!expectedTargets.has(evidence.target) || seen.has(evidence.target)) fail("evidence", `unknown or duplicate target ${evidence.target}`);
    seen.add(evidence.target);
    const { start, end, sha256 } = evidence.planSpan;
    if (end <= start || end > planText.length || sha(planText.slice(start, end)) !== sha256) fail(`evidence.${evidence.target}`, "plan span does not match the selected project plan (UTF-16, half-open)");
  }
  const missing = [...expectedTargets].filter((target) => !seen.has(target));
  if (missing.length) fail("evidence", `missing explicit mappings: ${missing.join(", ")}`);
  return {
    status: "validated-handoff" as const,
    manifest, mapping, authorization, subject, foundationFiles, manifestPath,
    manifestSha256: sha(manifestBytes), mappingSha256: manifest.mapping.sha256, authorizationSha256: manifest.authorization.sha256,
    paths: { packPath: packFile.path, sourcePath: sourceFile.path, storyIndexPath: storyFile.path, styleExamplesPath: styleFile.path },
    sourceOrigin: nativeSlate.sourceOrigin ?? null,
    sourceReadScope: "full-source-hash-and-selected-chapter-body-verification" as const,
    semanticMappingReviewPerformed: false as const,
    modelCalls: 0 as const,
    manuscriptAuthorized: false as const,
  };
}

/** Called only by InkOS after a new planning Book has been created; never accepts an existing Book seed. */
export async function applySourceFirstHandoff(input: {
  readonly projectRoot: string;
  readonly bookDir: string;
  readonly book: BookConfig;
  readonly handoff: ValidatedSourceFirstHandoff;
  readonly now?: () => Date;
}) {
  const { handoff, book, bookDir, projectRoot } = input;
  if (book.id !== handoff.mapping.bookId || book.targetChapters !== handoff.mapping.railPlan.routeCapacity.targetChaptersSnapshot) fail("Book", "Book identity or target count differs from validated mapping");
  // Re-read every original artifact at the mutation boundary; no stale preflight object may authorize changed input.
  const fresh = await validateSourceFirstHandoff({ projectRoot, manifestPath: handoff.manifestPath, subject: handoff.subject });
  if (fresh.manifestSha256 !== handoff.manifestSha256) fail("manifest", "manifest changed after preflight");
  try {
    const chapterFiles = await readdir(join(bookDir, "chapters"));
    if (chapterFiles.some((file) => /^\d+.*\.md$/u.test(file))) fail("Book", "refusing to attach an opening handoff to a Book with manuscript chapters");
    if (chapterFiles.includes("index.json")) {
      const index = json(await readFile(join(bookDir, "chapters", "index.json"), "utf8"), "chapter index");
      if (!Array.isArray(index) || index.length > 0) fail("Book", "opening handoff requires an empty chapter index");
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existingPaths = ["story/reference_binding.json", "story/reference_transformation.json", "story/rails/plan.json", "story/arcs/active.json", "story/planning-handoff.json"];
  for (const path of existingPaths) {
    try { await lstat(join(bookDir, path)); fail(path, "refusing to overwrite existing planning state"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const store = new ReferencePackStore(projectRoot, bookDir);
  const binding = await store.bind({ bookId: book.id, ...fresh.paths, spineReference: fresh.mapping.transformation.spineReference, now: input.now });
  await new StoryRailStore(bookDir, { now: input.now }).save(fresh.mapping.railPlan);
  const arcs = new ArcStore(bookDir, { now: input.now });
  await arcs.save(fresh.mapping.activeArc);
  await arcs.setActive(fresh.mapping.activeArc.id);
  const receipt = { schemaVersion: "firefly_source_first_handoff_receipt/v1", status: "planning-seed-imported", bookId: book.id,
    source: fresh.mapping.source, sourceOrigin: fresh.sourceOrigin, manifestSha256: fresh.manifestSha256, mappingSha256: fresh.mappingSha256, authorizationSha256: fresh.authorizationSha256,
    sourceReadScope: fresh.sourceReadScope, semanticMappingReviewPerformed: false, manuscriptAuthorized: false,
    referenceBinding: binding, activeArcId: fresh.mapping.activeArc.id,
  };
  await commitAtomicFileSet({ rootDir: bookDir, writes: [
    { relativePath: "story/reference_transformation.json", content: `${JSON.stringify(fresh.mapping.transformation, null, 2)}\n` },
    { relativePath: "story/planning-handoff.json", content: `${JSON.stringify(receipt, null, 2)}\n` },
    { relativePath: "story/planning-handoff-mapping.json", content: `${JSON.stringify(fresh.mapping, null, 2)}\n` },
    { relativePath: "story/planning-handoff-authorization.json", content: `${JSON.stringify(fresh.authorization, null, 2)}\n` },
  ] });
  await store.buildWriterContext({ book, chapterNumber: 1, arcId: fresh.mapping.activeArc.id });
  return receipt;
}


/** Model-free planning import. The supplied foundation is copied exactly, never generated from the plan. */
export async function initializeSourceFirstHandoffBook(input: {
  readonly projectRoot: string;
  readonly book: BookConfig;
  readonly brief: string;
  readonly handoff: ValidatedSourceFirstHandoff;
  readonly now?: () => Date;
}) {
  const book = BookConfigSchema.parse(input.book);
  if (book.id !== input.handoff.mapping.bookId || book.targetChapters !== input.handoff.mapping.railPlan.routeCapacity.targetChaptersSnapshot) fail("Book", "Book identity or target count differs from the validated mapping");
  if (book.status !== "outlining" || book.writing?.reviewMode !== "manual") fail("Book", "handoff creates an outlining Book with the existing manual review mode");
  const bookDir = join(input.projectRoot, "books", book.id);
  try { await lstat(bookDir); fail("Book", "target Book already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const fresh = await validateSourceFirstHandoff({ projectRoot: input.projectRoot, manifestPath: input.handoff.manifestPath, subject: input.handoff.subject });
  if (fresh.manifestSha256 !== input.handoff.manifestSha256) fail("manifest", "manifest changed after preflight");
  const booksDir = join(input.projectRoot, "books");
  await mkdir(booksDir, { recursive: true });
  const staging = await mkdtemp(join(booksDir, ".tmp-handoff-"));
  try {
    const state = new StateManager(input.projectRoot);
    await state.saveBookConfigAt(staging, book);
    await commitAtomicFileSet({ rootDir: staging, writes: [
      ...fresh.foundationFiles.map((item) => ({ relativePath: `story/${item.target}`, content: item.text })),
      { relativePath: "story/entry-contract.json", content: `${JSON.stringify(fresh.authorization.admission, null, 2)}\n` },
      { relativePath: "story/brief.md", content: input.brief },
      { relativePath: "story/project-plan.md", content: String((fresh.subject.candidate.projectPlan as { markdown: string }).markdown) },
    ] });
    await state.ensureControlDocumentsAt(staging, book.language ?? "ko", input.brief);
    await state.saveChapterIndexAt(staging, []);
    const receipt = await applySourceFirstHandoff({ ...input, book, bookDir: staging, handoff: fresh });
    await state.snapshotStateAt(staging, 0);
    if (!await state.isCompleteBookDirectory(staging)) fail("Book", "staged planning Book is incomplete");
    try { await lstat(bookDir); fail("Book", "target Book appeared during preparation"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rename(staging, bookDir);
    return receipt;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export const DailyPlanningCandidateMappingSchema = z.object({
  schemaVersion: z.literal("firefly_daily_planning_candidate_mapping/v1"),
  canaryId: z.string().regex(/^fcp-[a-f0-9]{24}$/u),
  canarySha256: Sha,
  outputSha256: Sha,
  candidate: z.record(z.unknown()),
}).strict();

/** Copies an owner-supplied structured mapping; does not infer candidate fields or manufacture a review. */
export function mapDailyPlanningCandidate(input: { canaryBytes: Uint8Array; mappingBytes: Uint8Array }) {
  if (input.canaryBytes.length > 1024 * 1024 || input.mappingBytes.length > 1024 * 1024) fail("dailyPlanning", "input exceeds 1 MiB");
  const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const canary = z.object({
    schemaVersion: z.literal("firefly-planning-canary/v1"), id: z.string().regex(/^fcp-[a-f0-9]{24}$/u), batchId: z.string().min(1),
    state: z.literal("complete"), markdown: z.string().max(100000), inputSha256: Sha, outputSha256: Sha,
    generatedAt: z.string().datetime(), author: z.object({ route: z.string().min(1), model: z.string().min(1) }).passthrough(),
    receipt: z.object({ inputSha256: Sha, outputSha256: Sha }).passthrough(),
  }).passthrough().parse(json(decode(input.canaryBytes), "dailyPlanning.canary"));
  const mapping = DailyPlanningCandidateMappingSchema.parse(json(decode(input.mappingBytes), "dailyPlanning.mapping"));
  if (sha(canary.markdown) !== canary.outputSha256 || canary.receipt.inputSha256 !== canary.inputSha256 || canary.receipt.outputSha256 !== canary.outputSha256) fail("dailyPlanning.canary", "body and provenance hashes disagree");
  if (mapping.canaryId !== canary.id || mapping.canarySha256 !== sha(input.canaryBytes) || mapping.outputSha256 !== canary.outputSha256) fail("dailyPlanning.mapping", "mapping does not bind the exact original canary bytes and manuscript-free plan");
  VariationProjectPlanSchema.parse(mapping.candidate.projectPlan);
  if ((mapping.candidate.projectPlan as { markdown: string }).markdown !== canary.markdown) fail("dailyPlanning.mapping.candidate.projectPlan", "the reviewed plan must be copied exactly; changed plans require their own source artifact");
  FireflyEntryContractSchema.parse(mapping.candidate.entryContract);
  FireflySpineRetentionContractV2Schema.parse(mapping.candidate.spineRetention);
  return {
    candidate: mapping.candidate,
    sourceOrigin: { schemaVersion: "firefly_daily_planning_origin/v1", system: "v3_ff_foundry", canaryId: canary.id, batchId: canary.batchId,
      canarySha256: mapping.canarySha256, outputSha256: canary.outputSha256, inputSha256: canary.inputSha256,
      candidateMappingSha256: sha(input.mappingBytes), originalAuthor: canary.author, originalGeneratedAt: canary.generatedAt },
    reviewStatus: "pending" as const, canonStatus: "non-canonical" as const, modelCalls: 0 as const, manuscriptAuthorized: false as const,
  };
}
