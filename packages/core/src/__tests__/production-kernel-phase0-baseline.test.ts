import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WriteNextActionPayloadSchema } from "../interaction/action-envelope.js";
import { deriveBookSessionFromTranscript } from "../interaction/session-transcript-restore.js";
import { appendTranscriptEvents } from "../interaction/session-transcript.js";
import { createSkillRegistry } from "../skills/registry.js";

interface Phase0Baseline {
  readonly schemaVersion: string;
  readonly localBaselineCommit: string;
  readonly upstreamBenchmarkCommit: string;
  readonly packageBaseline: {
    readonly version: string;
    readonly nodeEngine: string;
    readonly pnpmEngine: string;
    readonly requiredScripts: ReadonlyArray<string>;
  };
  readonly preservedContracts: ReadonlyArray<{
    readonly id: string;
    readonly testFiles: ReadonlyArray<string>;
  }>;
  readonly upstreamNonAdoption: {
    readonly status: string;
    readonly byteFrozenSurfaces: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
    readonly deferredUpstreamPaths: ReadonlyArray<string>;
  };
  readonly legacyTransitionBaseline: {
    readonly metadataAllowsNullToBook: boolean;
    readonly metadataCurrentlyAllowsBookToBook: boolean;
    readonly actionEnvelopeWriteNextMaximumChapterCount: number;
    readonly batchUsesOneBookLock: boolean;
    readonly phase1TargetRejectsBookToBook: boolean;
    readonly phase3WriteNextTargetChapterCount: number;
  };
  readonly completionEvidence: ReadonlyArray<{
    readonly capability: string;
    readonly currentEvidence: ReadonlyArray<string>;
    readonly railTruth: string;
  }>;
}

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureUrl = new URL("./fixtures/production-kernel-phase0-baseline.json", import.meta.url);
const temporaryRoots: string[] = [];

async function loadBaseline(): Promise<Phase0Baseline> {
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as Phase0Baseline;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("Production Kernel Phase 0 baseline", () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("pins the selected-fork and upstream benchmark identities", async () => {
    const baseline = await loadBaseline();
    expect(baseline.schemaVersion).toBe("production-kernel-phase0-baseline/v1");
    expect(baseline.localBaselineCommit).toBe("44eeaeca508bf3aa6dffb1cf5a6a142e2b2042c8");
    expect(baseline.upstreamBenchmarkCommit).toBe("091048383f411eb99948a8764f42b6fd13006f9b");
  });

  it("keeps every preserved contract backed by an executable characterization file", async () => {
    const baseline = await loadBaseline();
    expect(baseline.preservedContracts.map((entry) => entry.id)).toEqual([
      "book-arc-rail",
      "book-rules-provenance-and-content-neutrality",
      "reference-hil-and-storyyard",
      "chapter-journal-and-truth",
      "session-action-and-batch",
    ]);
    for (const contract of baseline.preservedContracts) {
      expect(contract.testFiles.length, `${contract.id} has no characterization files`).toBeGreaterThan(0);
      await Promise.all(contract.testFiles.map((path) => access(join(repositoryRoot, path))));
    }
  });

  it("freezes prompt, Skill, and LengthNormalizer bytes until their named later phase", async () => {
    const baseline = await loadBaseline();
    expect(baseline.upstreamNonAdoption.status).toBe("deferred-to-explicit-later-phases");
    for (const surface of baseline.upstreamNonAdoption.byteFrozenSurfaces) {
      await expect(sha256(join(repositoryRoot, surface.path))).resolves.toBe(surface.sha256);
    }
    for (const path of baseline.upstreamNonAdoption.deferredUpstreamPaths) {
      await expect(stat(join(repositoryRoot, path))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("pins package and validation script policy without raising the Node floor", async () => {
    const baseline = await loadBaseline();
    const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      version: string;
      engines: { node: string; pnpm: string };
      scripts: Record<string, string>;
    };
    expect(packageManifest.version).toBe(baseline.packageBaseline.version);
    expect(packageManifest.engines).toEqual({
      node: baseline.packageBaseline.nodeEngine,
      pnpm: baseline.packageBaseline.pnpmEngine,
    });
    for (const script of baseline.packageBaseline.requiredScripts) {
      expect(packageManifest.scripts[script], `missing package script ${script}`).toBeTypeOf("string");
    }
  });

  it("characterizes legacy session rebinding that Phase 1 must close", async () => {
    const baseline = await loadBaseline();
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-phase0-session-"));
    temporaryRoots.push(projectRoot);
    const sessionId = "phase0-session";
    await appendTranscriptEvents(projectRoot, sessionId, () => [
      {
        type: "session_created",
        version: 1,
        sessionId,
        seq: 1,
        timestamp: 1,
        bookId: null,
        title: null,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        type: "session_metadata_updated",
        version: 1,
        sessionId,
        seq: 2,
        timestamp: 2,
        bookId: "book-a",
        updatedAt: 2,
      },
    ]);

    expect(baseline.legacyTransitionBaseline.metadataAllowsNullToBook).toBe(true);
    expect(baseline.legacyTransitionBaseline.metadataCurrentlyAllowsBookToBook).toBe(true);
    expect(baseline.legacyTransitionBaseline.phase1TargetRejectsBookToBook).toBe(true);
    await expect(appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [{
      type: "session_metadata_updated",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: 3,
      bookId: "book-b",
      updatedAt: 3,
    }])).rejects.toThrow("bookId cannot transition");
    await expect(deriveBookSessionFromTranscript(projectRoot, sessionId)).resolves.toMatchObject({
      bookId: "book-a",
    });
  });

  it("characterizes the legacy 1-20 chapter action while reserving write-next/v1 for one chapter", async () => {
    const baseline = await loadBaseline();
    const current = WriteNextActionPayloadSchema.parse({
      chapterCount: baseline.legacyTransitionBaseline.actionEnvelopeWriteNextMaximumChapterCount,
    });
    expect(current.chapterCount).toBe(20);
    expect(baseline.legacyTransitionBaseline.batchUsesOneBookLock).toBe(true);
    expect(baseline.legacyTransitionBaseline.phase3WriteNextTargetChapterCount).toBe(1);
  });

  it("characterizes current last-write-wins Skill resolution until Phase 4", () => {
    const registry = createSkillRegistry({
      skills: [
        { id: "long-writing", name: "Builtin", description: "builtin", body: "builtin", source: "builtin" },
        { id: "long-writing", name: "Project", description: "project", body: "project", source: "project" },
      ],
    });
    expect(registry.getSkill("long-writing")).toMatchObject({ source: "project", body: "project" });
  });

  it("records capability evidence and Rail applicability without inventing a universal truth receipt", async () => {
    const baseline = await loadBaseline();
    expect(baseline.completionEvidence.map((entry) => entry.capability)).toEqual([
      "write-next",
      "audit",
      "revise",
      "resync",
      "hil-apply",
      "reference-bind",
    ]);
    expect(baseline.completionEvidence.find((entry) => entry.capability === "write-next")?.railTruth)
      .toBe("required-when-active-rail-otherwise-explicit-not-applicable");
    expect(baseline.completionEvidence.filter((entry) => entry.railTruth === "not-applicable"))
      .toHaveLength(1);
    expect(baseline.completionEvidence.every((entry) => entry.currentEvidence.length > 0)).toBe(true);
  });
});
