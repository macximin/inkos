import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginFictionContentOperation,
  prepareFictionContentInvocation,
  sealFictionContentOperationManifest,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";
import { createProductionAttemptIdentity } from "../production/attempt-identity.js";
import {
  repairChapterCommitEvidence,
  writeChapterCommitReceipt,
} from "../state/chapter-commit-receipt.js";
import type { ChapterMeta } from "../models/chapter.js";

const roots: string[] = [];
const NOW = "2026-08-28T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withRail: boolean) {
  const root = await mkdtemp(join(tmpdir(), "inkos-commit-receipt-"));
  roots.push(root);
  const bookId = "receipt-book";
  const bookDir = join(root, "books", bookId);
  await Promise.all([
    mkdir(join(bookDir, "chapters"), { recursive: true }),
    mkdir(join(bookDir, "story", "snapshots", "1", "state"), { recursive: true }),
  ]);
  const chapter: ChapterMeta = {
    number: 1,
    title: "Receipt",
    status: "ready-for-review",
    wordCount: 4,
    createdAt: NOW,
    updatedAt: NOW,
    auditIssues: [],
    lengthWarnings: [],
    ...(withRail ? { arcProvenance: railProvenance(bookId) } : {}),
  };
  await Promise.all([
    writeFile(join(bookDir, "chapters", "0001_Receipt.md"), "# Chapter 1: Receipt\n\nbody", "utf8"),
    writeFile(join(bookDir, "chapters", "index.json"), `${JSON.stringify([chapter], null, 2)}\n`, "utf8"),
    writeFile(join(bookDir, "story", "current_state.md"), "state", "utf8"),
    writeFile(join(bookDir, "story", "snapshots", "1", "current_state.md"), "state", "utf8"),
    writeFile(join(bookDir, "story", "snapshots", "1", "state", "manifest.json"), `${JSON.stringify({
      schemaVersion: 2,
      language: "en",
      lastAppliedChapter: 1,
      projectionVersion: 1,
      migrationWarnings: [],
    }, null, 2)}\n`, "utf8"),
  ]);
  const productionAttempt = createProductionAttemptIdentity();
  const operation = await beginFictionContentOperation({
    projectRoot: root,
    bookId,
    operationKind: "audit-draft",
    chapterNumber: 1,
    requiredStages: ["auditor"],
    productionAttempt,
    now: () => new Date(NOW),
  });
  const prepared = await prepareFictionContentInvocation({
    projectRoot: root,
    bookId,
    agentName: "auditor",
    stage: "auditor",
    model: "test-model",
    operationId: operation.operationId,
    productionAttempt,
    messages: [{ role: "system", content: "audit" }],
    now: () => new Date(NOW),
  });
  await writeFictionContentInvocationOutcome({
    projectRoot: root,
    prepared,
    output: "completed",
    now: () => new Date(NOW),
  });
  const manifest = await sealFictionContentOperationManifest({
    projectRoot: root,
    operation,
    now: () => new Date(NOW),
  });
  return { root, bookId, bookDir, chapter, productionAttempt, manifest };
}

describe("Chapter commit receipt v1", () => {
  it("records an explicit no-Rail applicability instead of inventing evidence", async () => {
    const f = await fixture(false);
    const receipt = await writeChapterCommitReceipt({
      bookDir: f.bookDir,
      bookId: f.bookId,
      chapterNumber: 1,
      capability: "audit-draft",
      productionAttempt: f.productionAttempt,
      operationManifests: [f.manifest],
      now: () => new Date(NOW),
    });
    expect(receipt.commitState).toBe("verified");
    expect(receipt.railTruth).toEqual({ applicability: "not-applicable", reason: "no-active-rail" });
    expect(receipt.productionOperationId).toBe(f.productionAttempt.productionOperationId);
    expect(receipt.fictionOperationIds).toEqual([f.manifest.operationId]);
  });

  it("gates a Rail-backed commit with missing evidence and repairs only the evidence", async () => {
    const f = await fixture(true);
    const beforeBody = await readFile(join(f.bookDir, "chapters", "0001_Receipt.md"), "utf8");
    const receipt = await writeChapterCommitReceipt({
      bookDir: f.bookDir,
      bookId: f.bookId,
      chapterNumber: 1,
      capability: "audit-draft",
      productionAttempt: f.productionAttempt,
      operationManifests: [f.manifest],
      now: () => new Date(NOW),
    });
    expect(receipt.commitState).toBe("committed-needs-recovery");
    expect(receipt.railTruth).toMatchObject({ applicability: "required", status: "missing" });
    expect(JSON.parse(await readFile(join(f.bookDir, "chapters", "index.json"), "utf8"))[0])
      .toMatchObject({ pendingAuditReason: "production-evidence-needs-recovery" });

    const repair = await repairChapterCommitEvidence({
      bookDir: f.bookDir,
      bookId: f.bookId,
      productionOperationId: f.productionAttempt.productionOperationId,
      receiptId: receipt.receiptId,
      now: () => new Date(NOW),
    });
    expect(repair.originalReceipt.path).toContain(f.productionAttempt.productionOperationId);
    expect(await readFile(join(f.bookDir, "chapters", "0001_Receipt.md"), "utf8")).toBe(beforeBody);
    expect(JSON.parse(await readFile(join(f.bookDir, "chapters", "index.json"), "utf8"))[0])
      .not.toHaveProperty("pendingAuditReason");
    await expect(readFile(join(f.bookDir, "story", "runtime", "chapter-0001.truth-receipt.json"), "utf8"))
      .resolves.toContain('"chapterNumber": 1');
  });
});

function railProvenance(bookId: string): NonNullable<ChapterMeta["arcProvenance"]> {
  return {
    version: 1,
    bookId,
    arcId: "arc-one",
    arcUpdatedAt: NOW,
    arcTitle: "Arc One",
    chapterNumber: 1,
    episodeRole: "promise",
    openingState: "before",
    promise: "promise",
    goal: "goal",
    obstacle: "obstacle",
    pressure: "pressure",
    turn: "turn",
    payoff: "payoff",
    irreversibleChange: "change",
    nextHook: "hook",
    beats: ["beat"],
    endingHook: "hook",
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    storyRail: {
      planUpdatedAt: NOW,
      anchor: {
        id: "A01",
        routeOrder: 1,
        title: "Anchor",
        detailLevel: "compound",
        state: "planned",
        entryState: "entry",
        trigger: "trigger",
        irreversibleChange: "change",
        humanAftermath: "aftermath",
        readerDebt: "debt",
        payoffAxis: "payoff",
        nextPressure: "pressure",
      },
      activeB: {
        bId: "B01",
        routeOrder: 1,
        status: "active",
        targetAnchorId: "A01",
        narrativeFunction: "function",
        payoffAxis: "payoff",
        carriedReaderDebt: "debt",
        contrastRequirement: "contrast",
      },
    },
  };
}
