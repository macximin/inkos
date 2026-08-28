import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChapterMeta } from "../models/chapter.js";
import { PipelineRunner, type ChapterPipelineResult } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createProductionAttemptIdentity, type ProductionAttemptIdentity } from "../production/attempt-identity.js";
import {
  beginFictionContentOperation,
  prepareFictionContentInvocation,
  readProductionModelCallReadback,
  sealFictionContentOperationManifest,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";
import { createDetachedOwnerDirectionLease } from "../production/detached-payload-store.js";
import {
  type ProductionAuthorizationEvidenceV2,
  type ProductionCommandSource,
} from "../production/production-command.js";
import { writeChapterCommitReceipt, type ChapterCommitReceipt } from "../state/chapter-commit-receipt.js";

const roots: string[] = [];
const NOW = new Date("2026-08-28T04:00:00.000Z");
const BOOK_ID = "phase6-neutral-book";
const OWNER_DIRECTION = "다음 화에서 인수전의 첫 승리를 보여 줘.";
const fixtureUrl = new URL("./fixtures/production-kernel-phase6-neutral-canary.json", import.meta.url);

type KernelLane = "observe-direct" | "enforce-direct" | "enforce-agent" | "enforce-hq";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createLane(id: string): Promise<{
  readonly id: string;
  readonly root: string;
  readonly bookDir: string;
  readonly state: StateManager;
}> {
  const root = await mkdtemp(join(tmpdir(), `inkos-phase6-${id}-`));
  roots.push(root);
  const state = new StateManager(root);
  await state.saveBookConfig(BOOK_ID, {
    id: BOOK_ID,
    title: "Phase 6 neutral runtime canary",
    platform: "other",
    genre: "urban-fantasy",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    writing: { reviewMode: "manual" },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await state.saveChapterIndex(BOOK_ID, []);
  await mkdir(join(state.bookDir(BOOK_ID), "story"), { recursive: true });
  await writeFile(join(state.bookDir(BOOK_ID), "story", "current_state.md"), "before\n", "utf8");
  return { id, root, bookDir: state.bookDir(BOOK_ID), state };
}

async function persistDeterministicChapter(input: {
  readonly root: string;
  readonly bookDir: string;
  readonly productionAttempt: ProductionAttemptIdentity;
}): Promise<ChapterPipelineResult> {
  const operation = await beginFictionContentOperation({
    projectRoot: input.root,
    bookId: BOOK_ID,
    operationKind: "write-next-chapter",
    chapterNumber: 1,
    requiredStages: ["writer"],
    productionAttempt: input.productionAttempt,
    now: () => NOW,
  });
  const prepared = await prepareFictionContentInvocation({
    projectRoot: input.root,
    bookId: BOOK_ID,
    agentName: "writer",
    stage: "writer",
    model: "phase6-deterministic-writer",
    operationId: operation.operationId,
    productionAttempt: input.productionAttempt,
    messages: [
      { role: "system", content: "Write the deterministic Phase 6 fixture." },
      { role: "user", content: OWNER_DIRECTION },
    ],
    now: () => NOW,
  });
  await writeFictionContentInvocationOutcome({
    projectRoot: input.root,
    prepared,
    output: "completed",
    now: () => NOW,
  });
  const manifest = await sealFictionContentOperationManifest({
    projectRoot: input.root,
    operation,
    now: () => NOW,
  });
  const chapter: ChapterMeta = {
    number: 1,
    title: "첫 인수전",
    status: "ready-for-review",
    wordCount: 1800,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    auditIssues: [],
    lengthWarnings: [],
  };
  await mkdir(join(input.bookDir, "chapters"), { recursive: true });
  await Promise.all([
    writeFile(join(input.bookDir, "chapters", "0001_첫-인수전.md"), "# 1화 첫 인수전\n\n본문\n", "utf8"),
    writeFile(join(input.bookDir, "chapters", "index.json"), `${JSON.stringify([chapter], null, 2)}\n`, "utf8"),
    writeFile(join(input.bookDir, "story", "current_state.md"), "after chapter 1\n", "utf8"),
  ]);
  const chapterCommitReceipt: ChapterCommitReceipt = await writeChapterCommitReceipt({
    bookDir: input.bookDir,
    bookId: BOOK_ID,
    chapterNumber: 1,
    capability: "write-next-chapter",
    productionAttempt: input.productionAttempt,
    operationManifests: [manifest],
    now: () => NOW,
  });
  return {
    chapterNumber: 1,
    title: chapter.title,
    wordCount: chapter.wordCount,
    auditResult: { passed: true, issues: [], summary: "ok" },
    revised: false,
    status: "ready-for-review",
    productionAttempt: input.productionAttempt,
    chapterCommitReceipt,
  };
}

function authorizationFor(source: ProductionCommandSource): ProductionAuthorizationEvidenceV2 {
  if (source === "agent") {
    return {
      kind: "confirmed-agent-tool",
      sessionRequestId: "request-phase6",
      proposalReceiptSha256: "a".repeat(64),
      confirmationReceiptSha256: "b".repeat(64),
      toolArgsSha256: "c".repeat(64),
    };
  }
  if (source === "hq") {
    return {
      kind: "authenticated-orchestrator",
      workOrderId: "work-order-phase6",
      workOrderSha256: "a".repeat(64),
      manifestCapabilitySha256: "b".repeat(64),
      ownerDecisionReceiptSha256: "c".repeat(64),
    };
  }
  return {
    kind: "confirmed-cli",
    typedCommandPreviewSha256: "a".repeat(64),
    confirmationReceiptSha256: "b".repeat(64),
  };
}

async function runKernelLane(id: KernelLane, mode: "observe" | "enforce") {
  const lane = await createLane(id);
  const source: ProductionCommandSource = id === "enforce-agent" ? "agent" : id === "enforce-hq" ? "hq" : "cli";
  const ownerDirection = await createDetachedOwnerDirectionLease({
    projectRoot: lane.root,
    receiptId: `owner-${id}`,
    text: OWNER_DIRECTION,
    now: new Date(),
  });
  const pipeline = new PipelineRunner({
    projectRoot: lane.root,
    model: "phase6-deterministic-writer",
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: { temperature: 0, maxTokens: 1, thinkingBudget: 0, extra: {} },
    },
    surfaceGatewayMode: "kernel",
    productionKernelMode: mode,
  });
  let canonCalls = 0;
  pipeline.writeNextChapterWithinBookLock = async (
    _bookId,
    _wordCount,
    _temperatureOverride,
    _directionContext,
    productionAttempt,
  ) => {
    if (!productionAttempt) throw new Error("Phase 6 surface canary requires a production attempt.");
    canonCalls += 1;
    return persistDeterministicChapter({ ...lane, productionAttempt });
  };
  const execution = await pipeline.executeSurfaceWriteNext({
    source,
    idempotencyKey: `idempotency-${id}`,
    bookId: BOOK_ID,
    sessionId: "session-phase6",
    requestId: "request-phase6",
    ...(source === "hq" ? { workOrderId: "work-order-phase6" } : {}),
    ownerDirection,
    expectedSoulBinding: null,
    authorization: authorizationFor(source),
  });
  const modelCalls = await readProductionModelCallReadback({
    projectRoot: lane.root,
    bookId: BOOK_ID,
    productionOperationId: execution.run.productionAttempt.productionOperationId,
    attemptId: execution.run.productionAttempt.attemptId,
  });
  return { ...lane, source, mode, execution, modelCalls, canonCalls };
}

async function canonBytes(bookDir: string): Promise<ReadonlyArray<Buffer>> {
  return Promise.all([
    readFile(join(bookDir, "chapters", "0001_첫-인수전.md")),
    readFile(join(bookDir, "chapters", "index.json")),
    readFile(join(bookDir, "story", "current_state.md")),
  ]);
}

function hilProjection(result: ChapterPipelineResult, approvalStatus: string) {
  return {
    chapterStatus: result.status,
    auditPassed: result.auditResult.passed,
    auditIssues: result.auditResult.issues,
    approvalStatus,
  };
}

describe("Phase 6 neutral runtime canary", () => {
  it("keeps the canary matrix explicit and changes only kernel/surface ingress", async () => {
    const spec = JSON.parse(await readFile(fixtureUrl, "utf8"));
    expect(spec).toMatchObject({
      schemaVersion: "production-kernel-phase6-neutral-canary/v1",
      fixedRuntime: {
        soulBinding: null,
        piWorker: "off",
        retrieval: "legacy",
        fts: "off",
        chapterReviewMode: "manual",
      },
      gates: {
        canonByteParity: true,
        modelCallCountParity: true,
        hilProjectionParity: true,
        singleCanonCall: true,
        commandAttemptReceiptCorrelation: true,
      },
    });
    expect(spec.lanes).toEqual([
      { id: "legacy-baseline", kernel: "off", surface: "legacy", source: "direct" },
      { id: "observe-direct", kernel: "observe", surface: "kernel", source: "cli" },
      { id: "enforce-direct", kernel: "enforce", surface: "kernel", source: "cli" },
      { id: "enforce-agent", kernel: "enforce", surface: "kernel", source: "agent" },
      { id: "enforce-hq", kernel: "enforce", surface: "kernel", source: "hq" },
    ]);
  });

  it("preserves canon bytes, one model call, and HIL projection across legacy, observe, enforce, Agent, and HQ", async () => {
    const baseline = await createLane("legacy-baseline");
    const baselineAttempt = createProductionAttemptIdentity();
    let baselineCanonCalls = 0;
    const release = await baseline.state.acquireBookLock(BOOK_ID);
    let baselineResult: ChapterPipelineResult;
    try {
      baselineCanonCalls += 1;
      baselineResult = await persistDeterministicChapter({ ...baseline, productionAttempt: baselineAttempt });
    } finally {
      await release();
    }
    const baselineModelCalls = await readProductionModelCallReadback({
      projectRoot: baseline.root,
      bookId: BOOK_ID,
      productionOperationId: baselineAttempt.productionOperationId,
      attemptId: baselineAttempt.attemptId,
    });
    const lanes = await Promise.all([
      runKernelLane("observe-direct", "observe"),
      runKernelLane("enforce-direct", "enforce"),
      runKernelLane("enforce-agent", "enforce"),
      runKernelLane("enforce-hq", "enforce"),
    ]);

    expect(baselineCanonCalls).toBe(1);
    expect(baselineModelCalls).toHaveLength(1);
    expect((await baseline.state.loadBookConfig(BOOK_ID)).writing?.reviewMode).toBe("manual");
    const expectedCanon = await canonBytes(baseline.bookDir);
    const expectedHil = hilProjection(baselineResult, "pending");

    for (const lane of lanes) {
      expect((await lane.state.loadBookConfig(BOOK_ID)).writing?.reviewMode).toBe("manual");
      expect(lane.canonCalls).toBe(1);
      expect(lane.modelCalls).toHaveLength(1);
      expect(await canonBytes(lane.bookDir)).toEqual(expectedCanon);
      expect(lane.execution.result).toBeDefined();
      expect(hilProjection(lane.execution.result!, lane.execution.run.approvalStatus)).toEqual(expectedHil);
      expect(lane.execution.run).toMatchObject({
        schemaVersion: "production-run/v1",
        executionStatus: "succeeded",
        completionHealth: "verified",
        projectionOrigin: "direct",
        approvalStatus: "pending",
        command: {
          schemaVersion: "production-command/v2",
          capability: "write-next-chapter",
          source: lane.source,
          binding: { bookId: BOOK_ID, sessionId: "session-phase6", requestId: "request-phase6" },
        },
        context: {
          mode: lane.mode,
          source: lane.source,
          productionInputs: {
            soul: null,
            skills: [expect.objectContaining({ id: "inkos-long-writing", namespace: "trusted-builtin" })],
          },
        },
        evidence: { kind: "verified-commit" },
      });
      expect(lane.execution.run.context.productionOperationId).toBe(lane.execution.run.productionAttempt.productionOperationId);
      expect(lane.execution.run.context.attemptId).toBe(lane.execution.run.productionAttempt.attemptId);
      expect(lane.execution.result!.productionAttempt).toEqual(lane.execution.run.productionAttempt);
      expect(lane.execution.result!.chapterCommitReceipt?.receiptId).toBe(
        lane.execution.run.evidence.kind === "verified-commit" ? lane.execution.run.evidence.receiptId : undefined,
      );
      expect(lane.modelCalls[0]).toMatchObject({
        agentName: "writer",
        stage: "writer",
        model: "phase6-deterministic-writer",
        status: "completed",
      });
    }
    expect(lanes.map((lane) => lane.execution.run.context.mode)).toEqual(["observe", "enforce", "enforce", "enforce"]);
    expect(lanes.map((lane) => {
      const authorization = lane.execution.run.command.authorization;
      if (!("kind" in authorization)) throw new Error("Phase 6 canary requires ProductionCommand v2 authorization.");
      return authorization.kind;
    })).toEqual([
      "confirmed-cli",
      "confirmed-cli",
      "confirmed-agent-tool",
      "authenticated-orchestrator",
    ]);
  });
});
