import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import { commitAtomicFileSet, syncDirectory } from "../utils/atomic-file-set.js";

const CHAPTER_TRANSACTION_PREFIX = ".inkos-chapter-txn-";
const CHAPTER_CLEANUP_PREFIX = ".inkos-chapter-cleanup-";
const MANIFEST_FILE = "manifest.json";
const PHASE_FILE = "phase";

const CHAPTER_PERSISTENCE_FILES = [
  "book.json",
  join("chapters", "index.json"),
  join("story", "current_state.md"),
  join("story", "pending_hooks.md"),
  join("story", "particle_ledger.md"),
  join("story", "chapter_summaries.md"),
  join("story", "subplot_board.md"),
  join("story", "emotional_arcs.md"),
  join("story", "character_matrix.md"),
  join("story", "audit_drift.md"),
  join("story", "memory.db"),
  join("story", "memory.db-shm"),
  join("story", "memory.db-wal"),
] as const;

interface ChapterTransactionManifest {
  readonly version: 1;
  readonly chapterNumber: number;
  readonly entries: ReadonlyArray<string>;
}

export interface ChapterPersistenceJournal {
  readonly bookDir: string;
  readonly journalDir: string;
  readonly chapterNumber: number;
  readonly before: ReadonlyMap<string, Uint8Array>;
}

/**
 * Persist the complete pre-operation Chapter surface before the caller starts
 * any logical write. The caller must already own the Book write lock.
 */
export async function beginChapterPersistenceJournal(
  bookDir: string,
  chapterNumber: number,
  additionalRelativePaths: ReadonlyArray<string> = [],
): Promise<ChapterPersistenceJournal> {
  assertChapterNumber(chapterNumber);
  const before = await captureChapterPersistenceState(bookDir, chapterNumber, additionalRelativePaths);
  const journalName = `${CHAPTER_TRANSACTION_PREFIX}${randomUUID()}`;
  const manifest: ChapterTransactionManifest = {
    version: 1,
    chapterNumber,
    entries: [...before.keys()].sort(),
  };
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [
      {
        relativePath: join(journalName, MANIFEST_FILE),
        content: `${JSON.stringify(manifest, null, 2)}\n`,
      },
      {
        relativePath: join(journalName, PHASE_FILE),
        content: "prepared\n",
      },
      ...[...before.entries()].map(([relativePath, content]) => ({
        relativePath: join(journalName, "backup", relativePath),
        content,
      })),
    ],
  });
  return {
    bookDir,
    journalDir: join(bookDir, journalName),
    chapterNumber,
    before,
  };
}

/** Mark the operation committed durably, then remove its now-obsolete backup. */
export async function commitChapterPersistenceJournal(
  journal: ChapterPersistenceJournal,
): Promise<void> {
  await commitAtomicFileSet({
    rootDir: journal.bookDir,
    writes: [{
      relativePath: join(basename(journal.journalDir), PHASE_FILE),
      content: "committed\n",
    }],
  });
  // The committed marker is already durable. Cleanup failure is recoverable
  // and must not make the caller retry a successful logical operation.
  await cleanupChapterJournal(journal.bookDir, journal.journalDir).catch(() => undefined);
}

/** Restore the pre-operation bytes and leave any cleanup failure for recovery. */
export async function rollbackChapterPersistenceJournal(
  journal: ChapterPersistenceJournal,
): Promise<void> {
  await restoreChapterPersistenceState(
    journal.bookDir,
    journal.chapterNumber,
    journal.before,
  );
  await cleanupChapterJournal(journal.bookDir, journal.journalDir).catch(() => undefined);
}

/**
 * Recover an abandoned logical Chapter transaction after lower-level atomic
 * file-set recovery and while holding the same exclusive Book write lock.
 */
export async function recoverChapterPersistenceTransactions(bookDir: string): Promise<void> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(bookDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const recoveryErrors: unknown[] = [];
  for (const entry of directoryEntries) {
    if (entry.isDirectory() && entry.name.startsWith(CHAPTER_CLEANUP_PREFIX)) {
      try {
        await rm(join(bookDir, entry.name), { recursive: true, force: true });
        await syncDirectory(bookDir);
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
  }

  const journals = directoryEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(CHAPTER_TRANSACTION_PREFIX));
  if (journals.length > 1) {
    recoveryErrors.push(new Error(
      `Multiple abandoned Chapter persistence journals require manual inspection: ${journals.map((entry) => entry.name).join(", ")}`,
    ));
  } else if (journals.length === 1) {
    const journalDir = join(bookDir, journals[0]!.name);
    try {
      const phase = await readJournalPhase(journalDir);
      if (phase === "committed") {
        await cleanupChapterJournal(bookDir, journalDir);
      } else if (phase === "prepared") {
        const manifest = await readJournalManifest(journalDir);
        const before = await readJournalSnapshot(journalDir, manifest);
        await restoreChapterPersistenceState(bookDir, manifest.chapterNumber, before);
        await cleanupChapterJournal(bookDir, journalDir);
      } else {
        throw new Error(`Unknown Chapter persistence journal phase: ${JSON.stringify(phase)}`);
      }
    } catch (error) {
      recoveryErrors.push(error);
    }
  }

  if (recoveryErrors.length > 0) {
    throw new AggregateError(
      recoveryErrors,
      "One or more Chapter persistence transactions could not be recovered",
    );
  }
}

async function captureChapterPersistenceState(
  bookDir: string,
  chapterNumber: number,
  additionalRelativePaths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const paths = await collectChapterPersistencePaths(bookDir, chapterNumber, additionalRelativePaths);
  const snapshot = new Map<string, Uint8Array>();
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(bookDir, relativePath);
    try {
      const metadata = await lstat(absolutePath);
      if (!metadata.isFile()) {
        throw new Error(`Chapter persistence surface must be a regular file: ${relativePath}`);
      }
      snapshot.set(relativePath, await readFile(absolutePath));
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
  }
  return snapshot;
}

async function restoreChapterPersistenceState(
  bookDir: string,
  chapterNumber: number,
  before: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const currentPaths = await collectChapterPersistencePaths(bookDir, chapterNumber, [...before.keys()]);
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [...before.entries()].map(([relativePath, content]) => ({ relativePath, content })),
    deletes: [...currentPaths].filter((relativePath) => !before.has(relativePath)),
  });
}

async function collectChapterPersistencePaths(
  bookDir: string,
  chapterNumber: number,
  additionalRelativePaths: ReadonlyArray<string> = [],
): Promise<Set<string>> {
  const paddedChapter = String(chapterNumber).padStart(4, "0");
  const paths = new Set<string>(CHAPTER_PERSISTENCE_FILES);
  paths.add(join("story", "runtime", `chapter-${paddedChapter}.truth-receipt.json`));
  for (const relativePath of additionalRelativePaths) paths.add(safeRelativePath(relativePath));
  const chaptersDir = join(bookDir, "chapters");
  try {
    const entries = await readdir(chaptersDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory()
        && entry.name.startsWith(paddedChapter)
        && entry.name.endsWith(".md")
      ) {
        paths.add(join("chapters", entry.name));
      }
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  await Promise.all([
    collectFilesRecursively(bookDir, join("chapters", ".current-metadata"), paths),
    collectFilesRecursively(bookDir, join("chapters", ".versions", paddedChapter), paths),
    collectFilesRecursively(bookDir, join("story", "state"), paths),
    collectFilesRecursively(bookDir, join("story", "snapshots", String(chapterNumber)), paths),
    collectFilesRecursively(bookDir, join("story", "runtime", "chapter-commits"), paths),
  ]);
  return paths;
}

async function collectFilesRecursively(
  bookDir: string,
  relativeDir: string,
  paths: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(bookDir, relativeDir), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await collectFilesRecursively(bookDir, relativePath, paths);
    } else {
      paths.add(relativePath);
    }
  }
}

async function readJournalManifest(journalDir: string): Promise<ChapterTransactionManifest> {
  const value: unknown = JSON.parse(await readRegularFile(join(journalDir, MANIFEST_FILE), "utf8"));
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Chapter persistence journal manifest in ${journalDir}`);
  }
  const raw = value as {
    version?: unknown;
    chapterNumber?: unknown;
    entries?: unknown;
  };
  if (raw.version !== 1 || !Number.isInteger(raw.chapterNumber) || Number(raw.chapterNumber) < 1) {
    throw new Error(`Invalid Chapter persistence journal header in ${journalDir}`);
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error(`Invalid Chapter persistence journal entries in ${journalDir}`);
  }
  const seen = new Set<string>();
  const entries = raw.entries.map((value) => {
    if (typeof value !== "string") {
      throw new Error(`Invalid Chapter persistence journal entry in ${journalDir}`);
    }
    const relativePath = safeRelativePath(value);
    if (seen.has(relativePath)) {
      throw new Error(`Duplicate Chapter persistence journal entry: ${relativePath}`);
    }
    seen.add(relativePath);
    return relativePath;
  });
  return { version: 1, chapterNumber: Number(raw.chapterNumber), entries };
}

async function readJournalSnapshot(
  journalDir: string,
  manifest: ChapterTransactionManifest,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const before = new Map<string, Uint8Array>();
  for (const relativePath of manifest.entries) {
    before.set(relativePath, await readRegularFile(join(journalDir, "backup", relativePath)));
  }
  return before;
}

async function readJournalPhase(journalDir: string): Promise<string> {
  return (await readRegularFile(join(journalDir, PHASE_FILE), "utf8")).trim();
}

async function readRegularFile(path: string): Promise<Buffer>;
async function readRegularFile(path: string, encoding: "utf8"): Promise<string>;
async function readRegularFile(path: string, encoding?: "utf8"): Promise<Buffer | string> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error(`Chapter persistence journal entry must be a regular file: ${path}`);
  }
  return encoding === "utf8" ? readFile(path, encoding) : readFile(path);
}

async function cleanupChapterJournal(bookDir: string, journalDir: string): Promise<void> {
  const cleanupDir = join(bookDir, `${CHAPTER_CLEANUP_PREFIX}${basename(journalDir)}`);
  await rename(journalDir, cleanupDir);
  await syncDirectory(bookDir);
  await rm(cleanupDir, { recursive: true, force: true });
  await syncDirectory(bookDir);
}

function safeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (
    !relativePath.trim()
    || isAbsolute(relativePath)
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Chapter persistence journal path escapes the Book: ${relativePath}`);
  }
  return normalized;
}

function assertChapterNumber(chapterNumber: number): void {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    throw new Error(`Invalid Chapter persistence journal chapter number: ${chapterNumber}`);
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
