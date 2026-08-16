import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

export interface AtomicFileWrite {
  readonly relativePath: string;
  readonly content: string | Uint8Array;
}

export interface AtomicFileSet {
  readonly rootDir: string;
  readonly writes: ReadonlyArray<AtomicFileWrite>;
  readonly deletes?: ReadonlyArray<string>;
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

interface TransactionEntry {
  readonly relativePath: string;
  readonly operation: "write" | "delete";
  readonly hadOriginal: boolean;
}

interface TransactionManifest {
  readonly version: 1;
  readonly entries: ReadonlyArray<TransactionEntry>;
}

const TRANSACTION_PREFIX = ".inkos-file-txn-";
const CLEANUP_PREFIX = ".inkos-file-cleanup-";
const MANIFEST_FILE = "manifest.json";
const PHASE_FILE = "phase";

function safeRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (
    !relativePath.trim()
    || isAbsolute(relativePath)
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Atomic file path must stay inside rootDir: ${relativePath}`);
  }
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Commit a Book-local file set. The caller must serialize commits with the
 * Book write lock; recovery relies on that lock to distinguish abandoned
 * transactions from a transaction that is still active in another session.
 */
export async function commitAtomicFileSet(input: AtomicFileSet): Promise<void> {
  const renameFile = input.renameFile ?? rename;
  const writes = input.writes.map((entry) => ({
    ...entry,
    relativePath: safeRelativePath(entry.relativePath),
  }));
  const deletes = [...new Set((input.deletes ?? []).map(safeRelativePath))];
  const writePaths = new Set(writes.map((entry) => entry.relativePath));
  if (writePaths.size !== writes.length) {
    throw new Error("Atomic file set contains duplicate write paths");
  }
  if (deletes.some((relativePath) => writePaths.has(relativePath))) {
    throw new Error("Atomic file set cannot write and delete the same path");
  }

  await mkdir(input.rootDir, { recursive: true });
  const manifest: TransactionManifest = {
    version: 1,
    entries: await Promise.all([
      ...writes.map(async (entry): Promise<TransactionEntry> => ({
        relativePath: entry.relativePath,
        operation: "write",
        hadOriginal: await exists(join(input.rootDir, entry.relativePath)),
      })),
      ...deletes.map(async (relativePath): Promise<TransactionEntry> => ({
        relativePath,
        operation: "delete",
        hadOriginal: await exists(join(input.rootDir, relativePath)),
      })),
    ]),
  };
  const transactionDir = await mkdtemp(join(input.rootDir, TRANSACTION_PREFIX));
  const stagedDir = join(transactionDir, "staged");
  const backupDir = join(transactionDir, "backup");
  let transactionPrepared = false;
  let committedPhaseInstalled = false;

  try {
    await syncDirectory(input.rootDir);
    await writeFileDurably(
      join(transactionDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writePhaseDurably(transactionDir, "prepared");
    transactionPrepared = true;

    for (const entry of writes) {
      const stagedPath = join(stagedDir, entry.relativePath);
      await mkdir(dirname(stagedPath), { recursive: true });
      await writeFileDurably(stagedPath, entry.content);
    }
    if (writes.length > 0) await syncDirectory(stagedDir);

    for (const entry of manifest.entries) {
      if (!entry.hadOriginal) continue;
      const target = join(input.rootDir, entry.relativePath);
      const backup = join(backupDir, entry.relativePath);
      await mkdir(dirname(backup), { recursive: true });
      await renameFile(target, backup);
      await syncDirectory(dirname(target));
      await syncDirectory(dirname(backup));
    }
    if (manifest.entries.some((entry) => entry.hadOriginal)) {
      await syncDirectory(backupDir);
    }

    for (const entry of writes) {
      const target = join(input.rootDir, entry.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await renameFile(join(stagedDir, entry.relativePath), target);
      await syncDirectory(dirname(target));
    }

    await writePhaseDurably(transactionDir, "committed", () => {
      committedPhaseInstalled = true;
    });
  } catch (error) {
    if (!transactionPrepared) {
      await cleanupTransaction(input.rootDir, transactionDir).catch(() => undefined);
      throw error;
    }

    if (committedPhaseInstalled) {
      try {
        await writePhaseDurably(transactionDir, "prepared");
      } catch (phaseError) {
        throw new AggregateError(
          [error, phaseError],
          "Atomic file commit phase was ambiguous; transaction evidence was preserved",
        );
      }
    }

    const rollbackErrors = await rollbackPreparedTransaction(
      input.rootDir,
      transactionDir,
      manifest,
      renameFile,
    );
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Atomic file commit failed and rollback was incomplete; transaction evidence was preserved",
      );
    }

    await cleanupTransaction(input.rootDir, transactionDir).catch(() => undefined);
    throw error;
  }

  // Once the committed marker is durable, cleanup failure must not make a
  // caller retry the already-committed logical operation. Recovery removes it.
  await cleanupTransaction(input.rootDir, transactionDir).catch(() => undefined);
}

/**
 * Recover abandoned file-set transactions below `rootDir`.
 *
 * The caller MUST hold the same exclusive Book write lock used by every
 * `commitAtomicFileSet` caller. Calling recovery without that lock can mistake
 * a live prepared transaction for an abandoned one and roll it back.
 */
export async function recoverAtomicFileSets(rootDir: string): Promise<void> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const recoveryErrors: unknown[] = [];
  for (const directoryEntry of directoryEntries) {
    if (directoryEntry.isDirectory() && directoryEntry.name.startsWith(CLEANUP_PREFIX)) {
      try {
        await rm(join(rootDir, directoryEntry.name), { recursive: true, force: true });
        await syncDirectory(rootDir);
      } catch (error) {
        recoveryErrors.push(error);
      }
      continue;
    }
    if (!directoryEntry.isDirectory() || !directoryEntry.name.startsWith(TRANSACTION_PREFIX)) continue;
    const transactionDir = join(rootDir, directoryEntry.name);
    try {
      const phase = await readTransactionPhase(transactionDir);
      if (phase === "committed") {
        await cleanupTransaction(rootDir, transactionDir);
        continue;
      }
      if (phase !== "prepared" && phase !== null) {
        throw new Error(`Unknown atomic file transaction phase: ${JSON.stringify(phase)}`);
      }

      let manifest: TransactionManifest;
      try {
        manifest = await readTransactionManifest(transactionDir);
      } catch (error) {
        // No target mutation begins before the prepared marker is durable, so
        // a marker-less, partial setup transaction is safe to discard.
        if (phase === null) {
          await cleanupTransaction(rootDir, transactionDir);
          continue;
        }
        throw error;
      }

      const rollbackErrors = await rollbackPreparedTransaction(
        rootDir,
        transactionDir,
        manifest,
        rename,
      );
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          rollbackErrors,
          `Atomic file transaction ${directoryEntry.name} could not be fully recovered`,
        );
      }
      await cleanupTransaction(rootDir, transactionDir);
    } catch (error) {
      recoveryErrors.push(error);
    }
  }

  if (recoveryErrors.length > 0) {
    throw new AggregateError(recoveryErrors, "One or more atomic file transactions could not be recovered");
  }
}

async function rollbackPreparedTransaction(
  rootDir: string,
  transactionDir: string,
  manifest: TransactionManifest,
  renameFile: (from: string, to: string) => Promise<void>,
): Promise<unknown[]> {
  const rollbackErrors: unknown[] = [];
  for (const entry of [...manifest.entries].reverse()) {
    const target = join(rootDir, entry.relativePath);
    const backup = join(transactionDir, "backup", entry.relativePath);
    try {
      if (!entry.hadOriginal) {
        await rm(target, { recursive: true, force: true });
        await syncDirectory(dirname(target));
        continue;
      }

      if (await exists(backup)) {
        await rm(target, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true });
        await renameFile(backup, target);
        await syncDirectory(dirname(backup));
        await syncDirectory(dirname(target));
      } else if (!(await exists(target))) {
        throw new Error(`Cannot restore ${entry.relativePath}: both target and backup are missing`);
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

async function readTransactionManifest(transactionDir: string): Promise<TransactionManifest> {
  const value: unknown = JSON.parse(await readFile(join(transactionDir, MANIFEST_FILE), "utf8"));
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
    throw new Error(`Invalid atomic file transaction manifest in ${transactionDir}`);
  }
  const rawEntries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`Invalid atomic file transaction entries in ${transactionDir}`);
  }

  const seenPaths = new Set<string>();
  const entries = rawEntries.map((entry): TransactionEntry => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid atomic file transaction entry in ${transactionDir}`);
    }
    const raw = entry as { relativePath?: unknown; operation?: unknown; hadOriginal?: unknown };
    if (typeof raw.relativePath !== "string") {
      throw new Error(`Invalid atomic file transaction path in ${transactionDir}`);
    }
    const relativePath = safeRelativePath(raw.relativePath);
    if (seenPaths.has(relativePath)) {
      throw new Error(`Duplicate atomic file transaction path: ${relativePath}`);
    }
    seenPaths.add(relativePath);
    if (raw.operation !== "write" && raw.operation !== "delete") {
      throw new Error(`Invalid atomic file transaction operation for ${relativePath}`);
    }
    if (typeof raw.hadOriginal !== "boolean") {
      throw new Error(`Invalid atomic file transaction original-state flag for ${relativePath}`);
    }
    return { relativePath, operation: raw.operation, hadOriginal: raw.hadOriginal };
  });
  return { version: 1, entries };
}

async function readTransactionPhase(transactionDir: string): Promise<string | null> {
  try {
    return (await readFile(join(transactionDir, PHASE_FILE), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writePhaseDurably(
  transactionDir: string,
  phase: "prepared" | "committed",
  onInstalled?: () => void,
): Promise<void> {
  const nextPath = join(transactionDir, `${PHASE_FILE}.next`);
  const phasePath = join(transactionDir, PHASE_FILE);
  await writeFileDurably(nextPath, `${phase}\n`);
  await rename(nextPath, phasePath);
  onInstalled?.();
  await syncDirectory(transactionDir);
}

async function writeFileDurably(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content);
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function cleanupTransaction(rootDir: string, transactionDir: string): Promise<void> {
  const cleanupDir = join(rootDir, `${CLEANUP_PREFIX}${basename(transactionDir)}`);
  await rename(transactionDir, cleanupDir);
  await syncDirectory(rootDir);
  await rm(cleanupDir, { recursive: true, force: true });
  await syncDirectory(rootDir);
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}
