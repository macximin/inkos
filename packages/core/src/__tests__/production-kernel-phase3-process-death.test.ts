import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../state/manager.js";
import { executeObserveOnlyWriteNext } from "../production/production-kernel.js";
import { ProductionRunSnapshotSchema } from "../production/run-projection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const WORKER = join(HERE, "fixtures", "phase3-kill-worker.ts");
const TSX = join(REPO_ROOT, "packages", "core", "node_modules", ".bin", "tsx");
const roots: string[] = [];
const NOW = "2026-08-28T02:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function killAfterReady(root: string, bookId: string): Promise<void> {
  const child = spawn(TSX, [WORKER, root, bookId], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`phase3 kill worker timed out: ${stderr}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timer);
      resolveReady();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`phase3 kill worker exited early (${code}): ${stderr}`));
    });
    child.once("error", reject);
  });
  const lock = JSON.parse(await readFile(join(root, "books", bookId, ".write.lock"), "utf8")) as { pid?: unknown };
  if (typeof lock.pid !== "number" || lock.pid === process.pid) throw new Error("phase3 kill worker lock PID is invalid");
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  process.kill(lock.pid, "SIGKILL");
  child.kill("SIGKILL");
  await exited;
}

describe("Phase 3 production projection process-death recovery", () => {
  it("reconciles an OS-killed crash-after-commit without rerunning the writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-phase3-kill-"));
    roots.push(root);
    const bookId = "phase3-kill-book";
    const state = new StateManager(root);
    await state.saveBookConfig(bookId, {
      id: bookId,
      title: "Phase 3 Kill",
      platform: "other",
      genre: "other",
      language: "en",
      status: "active",
      targetChapters: 10,
      chapterWordCount: 1000,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await state.saveChapterIndex(bookId, []);
    await killAfterReady(root, bookId);

    const snapshotNames = await readdir(join(state.bookDir(bookId), "story", "runtime", "production-runs", "snapshots"));
    expect(snapshotNames).toHaveLength(1);
    const snapshot = ProductionRunSnapshotSchema.parse(JSON.parse(await readFile(join(
      state.bookDir(bookId),
      "story",
      "runtime",
      "production-runs",
      "snapshots",
      snapshotNames[0]!,
    ), "utf8")));
    const execute = vi.fn(async () => { throw new Error("writer must not rerun after process death"); });
    const result = await executeObserveOnlyWriteNext({
      projectRoot: root,
      kernelMode: "observe",
      persistedCommand: snapshot.command,
      currentBinding: snapshot.command.binding,
      executeWithinBookLock: execute,
      now: () => new Date(NOW),
    });
    expect(result.run).toMatchObject({
      executionStatus: "succeeded",
      projectionOrigin: "reconciled",
      chapter: { chapterNumber: 1, title: "Killed after commit" },
    });
    expect(result.reused).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  }, 30_000);
});
