import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../state/manager.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { ReferenceTransformationHilStore } from "../reference/hil-store.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { ContinuityAuditor } from "../agents/continuity.js";
import { writeCompletedOperationEvidenceFixture } from "./helpers/fiction-content-evidence.js";
import type { BookConfig } from "../models/book.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const WORKER = join(HERE, "fixtures", "phase2-kill-worker.ts");
const TSX = join(REPO_ROOT, "packages", "core", "node_modules", ".bin", "tsx");
const NOW = "2026-08-28T00:00:00.000Z";

async function createBook(): Promise<{ root: string; state: StateManager; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-phase2-kill-"));
  const state = new StateManager(root);
  const bookId = "kill-book";
  const book: BookConfig = {
    id: bookId,
    title: "Kill Recovery",
    platform: "other",
    genre: "other",
    language: "en",
    status: "active",
    targetChapters: 10,
    chapterWordCount: 1000,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await state.saveBookConfig(bookId, book);
  const bookDir = state.bookDir(bookId);
  await Promise.all([
    mkdir(join(bookDir, "chapters"), { recursive: true }),
    mkdir(join(bookDir, "story"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(bookDir, "chapters", "0001_One.md"), "# Chapter 1: One\n\nold body", "utf8"),
    writeFile(join(bookDir, "story", "current_state.md"), "old state", "utf8"),
    writeFile(join(bookDir, "story", "pending_hooks.md"), "old hooks", "utf8"),
    writeFile(join(bookDir, "story", "particle_ledger.md"), "old ledger", "utf8"),
    state.saveChapterIndex(bookId, [{
      number: 1,
      title: "One",
      status: "ready-for-review",
      wordCount: 2,
      createdAt: NOW,
      updatedAt: NOW,
      auditIssues: [],
      lengthWarnings: [],
    }]),
  ]);
  return { root, state, bookId, bookDir };
}

async function runUntilReadyThenKill(mode: "chapter" | "reference" | "hil", root: string, bookId: string): Promise<void> {
  const child = spawn(TSX, [WORKER, mode, root, bookId], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`kill worker timed out: ${stderr}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timer);
      resolveReady();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`kill worker exited early (${code}): ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const lock = JSON.parse(await readFile(join(root, "books", bookId, ".write.lock"), "utf8")) as { pid?: unknown };
  if (typeof lock.pid !== "number" || lock.pid === process.pid) throw new Error("kill worker lock PID is invalid");
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  process.kill(lock.pid, "SIGKILL");
  child.kill("SIGKILL");
  await exited;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      process.kill(lock.pid, 0);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }
  throw new Error(`kill worker PID ${lock.pid} stayed alive after SIGKILL`);
}

function writerOutput(content: string): WriteChapterOutput {
  return {
    chapterNumber: 1,
    title: "One",
    content,
    wordCount: content.split(/\s+/u).length,
    preWriteCheck: "checked",
    postSettlement: "settled",
    updatedState: "synced state",
    updatedLedger: "synced ledger",
    updatedHooks: "synced hooks",
    chapterSummary: "| 1 | One | synced |",
    updatedSubplots: "",
    updatedEmotionalArcs: "",
    updatedCharacterMatrix: "",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

describe("production kernel phase 2 process-death recovery", () => {
  it("restores the complete Chapter surface after killing a prepared Chapter transaction", async () => {
    const fixture = await createBook();
    try {
      await runUntilReadyThenKill("chapter", fixture.root, fixture.bookId);
      const recovered = new StateManager(fixture.root);
      const release = await recovered.acquireBookLock(fixture.bookId);
      await release();
      await expect(readFile(join(fixture.bookDir, "chapters", "0001_One.md"), "utf8"))
        .resolves.toContain("old body");
      await expect(readFile(join(fixture.bookDir, "story", "current_state.md"), "utf8"))
        .resolves.toBe("old state");
      await expect(recovered.loadChapterIndex(fixture.bookId)).resolves.toHaveLength(1);
      await expect(access(join(fixture.bookDir, "story", "runtime", "chapter-commits", "orphan.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rolls back Book-local reference activation while leaving an unreferenced install harmless", async () => {
    const fixture = await createBook();
    const originalBook = await readFile(join(fixture.bookDir, "book.json"), "utf8");
    try {
      await runUntilReadyThenKill("reference", fixture.root, fixture.bookId);
      const recovered = new StateManager(fixture.root);
      const release = await recovered.acquireBookLock(fixture.bookId);
      await release();
      await expect(readFile(join(fixture.bookDir, "book.json"), "utf8")).resolves.toBe(originalBook);
      for (const relativePath of [
        join("story", "reference_binding.json"),
        join("story", "reference_transformation.json"),
        join("story", "rails", "plan.json"),
      ]) {
        await expect(access(join(fixture.bookDir, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(readFile(join(
        fixture.root,
        ".inkos",
        "reference-packs",
        "objects",
        "orphan-object",
        "reference-pack.json",
      ), "utf8")).resolves.toContain("installed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("resumes an applied HIL candidate after killing its process before resync", async () => {
    const fixture = await createBook();
    const current = await readFile(join(fixture.bookDir, "chapters", "0001_One.md"), "utf8");
    const candidate = "# Chapter 1: One\n\napproved candidate body";
    const hil = new ReferenceTransformationHilStore(fixture.bookDir);
    await hil.prepare({
      chapterNumber: 1,
      candidateId: "kill-candidate",
      currentContent: current,
      candidateContent: candidate,
      transformation: {
        version: 1,
        kind: "reference-transformation",
        bookId: fixture.bookId,
        referencePackId: "pack-one",
        spineReference: "pack-one",
        supportingReferences: [],
        sourceSegments: [{
          id: "segment-one",
          sourceArcIds: ["source-arc"],
          sourceChapterIds: [1],
          targetRailAnchorIds: ["A01"],
          targetArcIds: ["target-arc"],
          retain: ["payoff"],
          varySurface: ["people"],
          linkedConsequences: ["result"],
        }],
        createdAt: NOW,
        updatedAt: NOW,
      },
      sourceTexts: ["source beat"],
    });
    try {
      await runUntilReadyThenKill("hil", fixture.root, fixture.bookId);
      const afterKill = await hil.get(1, "kill-candidate");
      expect(afterKill.candidate.status).toBe("applied");
      expect((await fixture.state.loadChapterIndex(fixture.bookId))[0]?.pendingAuditReason)
        .toBe("hil-applied-pending-resync");

      vi.spyOn(
        WriterAgent.prototype as unknown as {
          settleChapterState: (input: Record<string, unknown>) => Promise<WriteChapterOutput>;
        },
        "settleChapterState",
      ).mockResolvedValue(writerOutput("approved candidate body"));
      vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ passed: true, warnings: [] });
      vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({
        passed: true,
        issues: [],
        summary: "ready",
        overallScore: 90,
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
      const runner = new PipelineRunner({
        client: {
          provider: "openai",
          apiFormat: "chat",
          stream: false,
          defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0 },
        } as ConstructorParameters<typeof PipelineRunner>[0]["client"],
        model: "test-model",
        projectRoot: fixture.root,
        inputGovernanceMode: "legacy",
        testOnlyFictionContentEvidenceWriter: writeCompletedOperationEvidenceFixture,
      });
      const result = await runner.applyReferenceHilCandidate({
        bookId: fixture.bookId,
        chapterNumber: 1,
        candidateId: "kill-candidate",
        actorId: "retrying-owner",
        interface: "studio",
      });
      expect(result.followUpStatus).toBe("complete");
      expect(result.transitions.map((transition) => transition.state)).toEqual([
        "applied-needs-resync",
        "applied-needs-audit",
        "ready",
      ]);
      const receiptNames = await readdir(join(fixture.bookDir, "story", "runtime", "chapter-commits"));
      expect(receiptNames.filter((name) => name.startsWith(result.productionAttempt.productionOperationId)))
        .toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
