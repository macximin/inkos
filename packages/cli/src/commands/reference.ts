import { Command } from "commander";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  ArcStore,
  BookConfigSchema,
  ReferencePackStore,
  ReferenceTransformationHilStore,
  StateManager,
  ensureFireflyLongformPreflight,
} from "@actalk/inkos-core";
import { findProjectRoot, log, logError, resolveBookId } from "../utils.js";

async function referenceArtifact(root: string, path: string, role: string) {
  return {
    repo: "inkos",
    path: relative(root, path).split(sep).join("/"),
    sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    role,
  };
}

interface FileSnapshot {
  readonly path: string;
  readonly bytes: Buffer | null;
}

async function snapshotFiles(paths: ReadonlyArray<string>): Promise<ReadonlyArray<FileSnapshot>> {
  return Promise.all(paths.map(async (path) => {
    try {
      return { path, bytes: await readFile(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { path, bytes: null };
      throw error;
    }
  }));
}

async function restoreFiles(snapshots: ReadonlyArray<FileSnapshot>): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.bytes === null) {
      await rm(snapshot.path, { force: true });
      continue;
    }
    await mkdir(dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, snapshot.bytes);
  }
}

export const referenceCommand = new Command("reference")
  .description("Bind full-corpus reference packs and operate transformation HIL");

referenceCommand
  .command("bind")
  .description("Validate and bind tracked/private reference inputs to a Book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .requiredOption("--pack <path>", "Tracked reference-pack.json")
  .requiredOption("--story-index <path>", "Private story-index.jsonl")
  .requiredOption("--style-examples <path>", "Private style-examples.jsonl")
  .requiredOption("--source <path>", "Private raw source text")
  .option("--spine <slug>", "Spine reference slug")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const book = await state.loadBookConfig(bookId);
      const store = new ReferencePackStore(root, state.bookDir(bookId));
      const release = await state.acquireBookLock(bookId);
      try {
        const packId = JSON.parse(await readFile(opts.pack, "utf8"))?.id;
        if (typeof packId !== "string" || !packId.trim()) throw new Error("Reference pack id is missing.");
        const bookDir = state.bookDir(bookId);
        const installedDir = store.packDir(packId);
        const snapshots = await snapshotFiles([
          join(bookDir, "book.json"),
          store.bindingPath,
          store.transformationPath,
          join(bookDir, "story", "rails", "plan.json"),
          join(installedDir, "reference-pack.json"),
          join(installedDir, "story-index.jsonl"),
          join(installedDir, "style-examples.jsonl"),
        ]);
        try {
          const binding = await store.bind({
            bookId,
            packPath: opts.pack,
            storyIndexPath: opts.storyIndex,
            styleExamplesPath: opts.styleExamples,
            sourcePath: opts.source,
            spineReference: opts.spine,
          });
          const updated = BookConfigSchema.parse({
            ...book,
            writing: {
              ...book.writing,
              reviewMode: "manual",
              railPolicy: "auto-required",
              referencePolicy: "auto-required",
              referencePackId: binding.referencePackId,
              spineReference: binding.spineReference,
            },
            updatedAt: new Date().toISOString(),
          });
          await state.saveBookConfig(bookId, updated);
          const preflight = await ensureFireflyLongformPreflight({
            projectRoot: root,
            bookDir,
            book: updated,
          });
          const artifacts = await Promise.all([
            referenceArtifact(root, join(bookDir, "book.json"), "book-config"),
            referenceArtifact(root, store.bindingPath, "reference-binding"),
            referenceArtifact(root, store.transformationPath, "reference-transformation"),
            referenceArtifact(root, join(bookDir, "story", "rails", "plan.json"), "story-rail-plan"),
          ]);
          log(JSON.stringify({ bookId, binding, writing: updated.writing, preflight, artifacts }, null, opts.json ? 2 : 2));
        } catch (error) {
          try {
            await restoreFiles(snapshots);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Reference bind failed and rollback was incomplete.");
          }
          throw error;
        }
      } finally {
        await release();
      }
    } catch (error) {
      logError(`Reference bind failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });

referenceCommand
  .command("preflight")
  .description("Auto-complete and validate required transformation/Rail state")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined) => {
    const root = findProjectRoot();
    const bookId = await resolveBookId(bookIdArg, root);
    const state = new StateManager(root);
    const release = await state.acquireBookLock(bookId);
    try {
      const receipt = await ensureFireflyLongformPreflight({
        projectRoot: root,
        bookDir: state.bookDir(bookId),
        book: await state.loadBookConfig(bookId),
      });
      log(JSON.stringify(receipt, null, 2));
    } catch (error) {
      logError(`Reference preflight failed: ${String(error)}`);
      process.exitCode = 1;
    } finally {
      await release();
    }
  });

referenceCommand
  .command("context")
  .description("Render the exact story/style reference context for one chapter")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .requiredOption("--chapter <n>", "Chapter number")
  .option("--arc <id>", "Target Arc id")
  .option("--json", "Output metadata instead of full private context")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const activeArc = await new ArcStore(state.bookDir(bookId)).getActive();
      const context = await new ReferencePackStore(root, state.bookDir(bookId)).buildWriterContext({
        book: await state.loadBookConfig(bookId),
        chapterNumber: Number.parseInt(opts.chapter, 10),
        arcId: opts.arc ?? activeArc?.id,
      });
      if (!context) throw new Error("Book has no reference binding.");
      log(opts.json
        ? JSON.stringify({
            packId: context.packId,
            spineReference: context.spineReference,
            storyChapters: context.storyEntries.map((entry) => entry.sequence),
            styleExamples: context.styleExamples.map((example) => example.id),
          }, null, 2)
        : context.rendered);
    } catch (error) {
      logError(`Reference context failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });

const hil = referenceCommand.command("hil").description("Prepare, apply, or reject non-overwriting HIL candidates");

hil.command("prepare")
  .argument("[book-id]", "Book ID")
  .requiredOption("--chapter <n>", "Chapter number")
  .requiredOption("--candidate-id <id>", "Stable candidate id")
  .requiredOption("--current <path>", "Current chapter file")
  .requiredOption("--candidate <path>", "Candidate body file")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const store = new ReferencePackStore(root, state.bookDir(bookId));
      const transformation = await store.loadTransformation(true);
      if (!transformation) throw new Error("Reference transformation is missing.");
      const activeArc = await new ArcStore(state.bookDir(bookId)).getActive();
      if (!activeArc) throw new Error("Reference HIL prepare requires an active Arc.");
      const context = await store.buildWriterContext({
        book: await state.loadBookConfig(bookId),
        chapterNumber: Number.parseInt(opts.chapter, 10),
        arcId: activeArc.id,
      });
      if (!context) throw new Error("Reference context is missing.");
      const result = await new ReferenceTransformationHilStore(state.bookDir(bookId)).prepare({
        chapterNumber: Number.parseInt(opts.chapter, 10),
        candidateId: opts.candidateId,
        currentContent: await readFile(opts.current, "utf8"),
        candidateContent: await readFile(opts.candidate, "utf8"),
        transformation,
        sourceSegmentIds: [context.sourceSegment.id],
        sourceTexts: [
          ...context.storyEntries.map((entry) => entry.prose),
          ...context.styleExamples.map((example) => example.prose),
        ],
      });
      log(JSON.stringify(result, null, 2));
    } catch (error) {
      logError(`Reference HIL prepare failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });

hil.command("apply")
  .argument("[book-id]", "Book ID")
  .requiredOption("--chapter <n>", "Chapter number")
  .requiredOption("--candidate-id <id>", "Candidate id")
  .requiredOption("--target <relative-path>", "Current chapter path relative to Book root")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const result = await new ReferenceTransformationHilStore(state.bookDir(bookId)).apply({
        chapterNumber: Number.parseInt(opts.chapter, 10),
        candidateId: opts.candidateId,
        targetChapterRelativePath: opts.target,
      });
      log(JSON.stringify(result, null, 2));
    } catch (error) {
      logError(`Reference HIL apply failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });

hil.command("reject")
  .argument("[book-id]", "Book ID")
  .requiredOption("--chapter <n>", "Chapter number")
  .requiredOption("--candidate-id <id>", "Candidate id")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const result = await new ReferenceTransformationHilStore(state.bookDir(bookId)).reject(
        Number.parseInt(opts.chapter, 10),
        opts.candidateId,
      );
      log(JSON.stringify(result, null, 2));
    } catch (error) {
      logError(`Reference HIL reject failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });
