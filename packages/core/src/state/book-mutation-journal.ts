import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import { commitAtomicFileSet, syncDirectory } from "../utils/atomic-file-set.js";

const JOURNAL_PREFIX = ".inkos-book-txn-";
const CLEANUP_PREFIX = ".inkos-book-cleanup-";
const MANIFEST_FILE = "manifest.json";
const PHASE_FILE = "phase";

interface BookMutationManifest {
  readonly version: 1;
  readonly kind: string;
  readonly targets: ReadonlyArray<string>;
  readonly existing: ReadonlyArray<string>;
}

export interface BookMutationJournal {
  readonly bookDir: string;
  readonly journalDir: string;
  readonly manifest: BookMutationManifest;
  readonly before: ReadonlyMap<string, Uint8Array>;
}

export async function beginBookMutationJournal(input: {
  readonly bookDir: string;
  readonly kind: string;
  readonly relativePaths: ReadonlyArray<string>;
}): Promise<BookMutationJournal> {
  if (!input.kind.trim()) throw new Error("Book mutation journal kind must be non-empty.");
  const targets = [...new Set(input.relativePaths.map(safeRelativePath))].sort();
  if (targets.length === 0) throw new Error("Book mutation journal requires at least one target.");
  const before = new Map<string, Uint8Array>();
  for (const relativePath of targets) {
    try {
      const metadata = await lstat(join(input.bookDir, relativePath));
      if (!metadata.isFile()) throw new Error(`Book mutation target must be a regular file: ${relativePath}`);
      before.set(relativePath, await readFile(join(input.bookDir, relativePath)));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const journalName = `${JOURNAL_PREFIX}${randomUUID()}`;
  const manifest: BookMutationManifest = {
    version: 1,
    kind: input.kind,
    targets,
    existing: [...before.keys()].sort(),
  };
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: [
      { relativePath: join(journalName, MANIFEST_FILE), content: `${JSON.stringify(manifest, null, 2)}\n` },
      { relativePath: join(journalName, PHASE_FILE), content: "prepared\n" },
      ...[...before].map(([relativePath, content]) => ({
        relativePath: join(journalName, "backup", relativePath),
        content,
      })),
    ],
  });
  return { bookDir: input.bookDir, journalDir: join(input.bookDir, journalName), manifest, before };
}

export async function commitBookMutationJournal(journal: BookMutationJournal): Promise<void> {
  await commitAtomicFileSet({
    rootDir: journal.bookDir,
    writes: [{ relativePath: join(basename(journal.journalDir), PHASE_FILE), content: "committed\n" }],
  });
  await cleanupJournal(journal.bookDir, journal.journalDir).catch(() => undefined);
}

export async function rollbackBookMutationJournal(journal: BookMutationJournal): Promise<void> {
  await restore(journal.bookDir, journal.manifest, journal.before);
  await cleanupJournal(journal.bookDir, journal.journalDir).catch(() => undefined);
}

export async function runBookMutationTransaction<T>(input: {
  readonly bookDir: string;
  readonly kind: string;
  readonly relativePaths: ReadonlyArray<string>;
  readonly persist: () => Promise<T>;
}): Promise<T> {
  const journal = await beginBookMutationJournal(input);
  try {
    const result = await input.persist();
    await commitBookMutationJournal(journal);
    return result;
  } catch (error) {
    try {
      await rollbackBookMutationJournal(journal);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${input.kind} failed and rollback was incomplete`);
    }
    throw error;
  }
}

export async function recoverBookMutationTransactions(bookDir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(bookDir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const errors: unknown[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(CLEANUP_PREFIX)) continue;
    try {
      await rm(join(bookDir, entry.name), { recursive: true, force: true });
      await syncDirectory(bookDir);
    } catch (error) {
      errors.push(error);
    }
  }
  const journals = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(JOURNAL_PREFIX));
  if (journals.length > 1) {
    errors.push(new Error(`Multiple abandoned Book mutation journals require inspection: ${journals.map((entry) => entry.name).join(", ")}`));
  } else if (journals.length === 1) {
    const journalDir = join(bookDir, journals[0]!.name);
    try {
      const phase = (await readRegular(join(journalDir, PHASE_FILE), "utf8")).trim();
      if (phase === "committed") {
        await cleanupJournal(bookDir, journalDir);
      } else if (phase === "prepared") {
        const manifest = parseManifest(JSON.parse(await readRegular(join(journalDir, MANIFEST_FILE), "utf8")));
        const before = new Map<string, Uint8Array>();
        for (const relativePath of manifest.existing) {
          before.set(relativePath, await readRegular(join(journalDir, "backup", relativePath)));
        }
        await restore(bookDir, manifest, before);
        await cleanupJournal(bookDir, journalDir);
      } else {
        throw new Error(`Unknown Book mutation journal phase: ${JSON.stringify(phase)}`);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Book mutation recovery failed");
}

function parseManifest(value: unknown): BookMutationManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid Book mutation journal manifest.");
  const raw = value as { version?: unknown; kind?: unknown; targets?: unknown; existing?: unknown };
  if (raw.version !== 1 || typeof raw.kind !== "string" || !Array.isArray(raw.targets) || !Array.isArray(raw.existing)) {
    throw new Error("Invalid Book mutation journal header.");
  }
  const targets = raw.targets.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid Book mutation target.");
    return safeRelativePath(value);
  });
  const existing = raw.existing.map((value) => {
    if (typeof value !== "string") throw new Error("Invalid Book mutation backup.");
    return safeRelativePath(value);
  });
  if (new Set(targets).size !== targets.length || new Set(existing).size !== existing.length) {
    throw new Error("Duplicate Book mutation journal path.");
  }
  if (existing.some((value) => !targets.includes(value))) throw new Error("Book mutation backup is not a target.");
  return { version: 1, kind: raw.kind, targets, existing };
}

async function restore(
  bookDir: string,
  manifest: BookMutationManifest,
  before: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [...before].map(([relativePath, content]) => ({ relativePath, content })),
    deletes: manifest.targets.filter((relativePath) => !before.has(relativePath)),
  });
}

async function cleanupJournal(bookDir: string, journalDir: string): Promise<void> {
  const cleanupDir = join(bookDir, `${CLEANUP_PREFIX}${basename(journalDir)}`);
  await rename(journalDir, cleanupDir);
  await syncDirectory(bookDir);
  await rm(cleanupDir, { recursive: true, force: true });
  await syncDirectory(bookDir);
}

function safeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (!relativePath.trim() || isAbsolute(relativePath) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Book mutation path must stay inside Book: ${relativePath}`);
  }
  return normalized;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function readRegular(path: string): Promise<Buffer>;
async function readRegular(path: string, encoding: "utf8"): Promise<string>;
async function readRegular(path: string, encoding?: "utf8"): Promise<Buffer | string> {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error(`Book mutation journal entry must be a regular file: ${path}`);
  return encoding === "utf8" ? readFile(path, encoding) : readFile(path);
}
