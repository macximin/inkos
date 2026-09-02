import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  structural: vi.fn(),
  pristine: vi.fn(),
  acquireLease: vi.fn(),
  loadTerminal: vi.fn(),
  importOperation: vi.fn(),
  finalizeOperation: vi.fn(),
  loadBinding: vi.fn(),
  createDirection: vi.fn(),
  readModelCalls: vi.fn(),
  executeWriteNext: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  class MockPipelineRunner {
    createAgentContext(role: string) {
      return { role, model: "gpt-5.6-sol", reasoningEffort: "high" };
    }

    executeSurfaceWriteNext(input: unknown) {
      return mocks.executeWriteNext(input);
    }
  }
  return {
    ...actual,
    PipelineRunner: MockPipelineRunner,
    verifyProductionCanaryStructuralRoot: mocks.structural,
    verifyProductionCanaryExecutionRoot: mocks.pristine,
    acquireProductionCanaryAgentOperationLease: mocks.acquireLease,
    loadAgentOperationTerminal: mocks.loadTerminal,
    importHermesControlOperation: mocks.importOperation,
    finalizeAgentOperation: mocks.finalizeOperation,
    loadActiveBookSoulBinding: mocks.loadBinding,
    createDetachedOwnerDirectionLease: mocks.createDirection,
    readProductionModelCallReadback: mocks.readModelCalls,
  };
});

import { directionTextSha256, hashCanonicalJson, hermesControlOperationPaths } from "@actalk/inkos-core";
import { productionCommand } from "../commands/production.js";

const roots: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(bytes: Buffer) {
  return {
    encoding: "base64" as const,
    bytes: bytes.toString("base64"),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.events.splice(0);
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  process.exitCode = undefined;
});

describe("production agent-operate CLI end-to-end orchestration", () => {
  it("holds the pair/lane lease from pristine verification through v2 terminal readback", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "inkos-agent-cli-e2e-"));
    roots.push(sourceRoot);
    const pairId = "pair-cli-e2e";
    const bookId = "book-cli-e2e";
    const laneRoot = join(sourceRoot, ".inkos", "canaries", pairId, "neutral");
    await mkdir(join(laneRoot, "books", bookId), { recursive: true });
    await writeFile(join(laneRoot, "inkos.json"), JSON.stringify({
      name: "agent-cli-e2e",
      version: "0.1.0",
      language: "ko",
      llm: {
        provider: "openai",
        service: "codex",
        configSource: "studio",
        baseUrl: "http://127.0.0.1/codex-subscription",
        model: "gpt-5.6-sol",
        apiFormat: "responses",
        stream: false,
        services: [{ service: "codex", models: ["gpt-5.6-sol"], apiFormat: "responses", stream: false }],
        defaultModel: "gpt-5.6-sol",
        extra: { codexReasoningEffort: "high" },
      },
      notify: [],
      inputGovernanceMode: "v2",
    }));
    await writeFile(join(laneRoot, "books", bookId, "book.json"), JSON.stringify({ id: bookId }));

    const sourceBookManifestSha256 = "1".repeat(64);
    const isolationScopeSha256 = "2".repeat(64);
    const commonSnapshotSha256 = "3".repeat(64);
    const receiptUnsigned = {
      schemaVersion: "inkos-canary-common-snapshot/v1" as const,
      pairId,
      bookId,
      scopeId: `canary-pair:${pairId}:${bookId}`,
      sourceProjectRootFingerprint: "4".repeat(64),
      sourceConfig: { path: "inkos.json", sha256: "5".repeat(64), byteLength: 10 },
      sourceGenres: { state: "absent" as const, files: [], manifestSha256: "6".repeat(64) },
      sourceBook: { files: [], manifestSha256: sourceBookManifestSha256 },
      commonSnapshotSha256,
      isolationScopeSha256,
      soulBindingInputs: {
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        artifacts: [
          { role: "soul-binding-decision" as const, path: "decision.json", sha256: "7".repeat(64), byteLength: 10 },
          { role: "soul-package-manifest" as const, path: "manifest.json", sha256: "8".repeat(64), byteLength: 10 },
          { role: "source-registry-receipt" as const, path: "registry.json", sha256: "9".repeat(64), byteLength: 10 },
        ],
      },
      lanes: {
        neutral: {
          projectRoot: `.inkos/canaries/${pairId}/neutral`,
          preBindManifestSha256: "a".repeat(64),
          postBindManifestSha256: "a".repeat(64),
          allowedDeltaPaths: [],
          allowedDeltaManifestSha256: "b".repeat(64),
          expectedSoulBinding: null,
        },
        genreSoul: {
          projectRoot: `.inkos/canaries/${pairId}/soul`,
          preBindManifestSha256: "a".repeat(64),
          postBindManifestSha256: "c".repeat(64),
          allowedDeltaPaths: ["books/book-cli-e2e/story/soul-bindings/current.json"],
          allowedDeltaManifestSha256: "d".repeat(64),
          expectedSoulBinding: { soulId: "candidate", soulVersion: "v1", bindingSha256: "e".repeat(64) },
        },
      },
      productionBookFingerprint: {
        before: sourceBookManifestSha256,
        after: sourceBookManifestSha256,
        unchanged: true as const,
      },
      excludedTransientBookPaths: [".soul-turn.lock" as const, ".write.lock" as const],
      createdAt: "2026-09-02T00:00:00.000Z",
    };
    const receipt = { ...receiptUnsigned, receiptSelfHash: hashCanonicalJson(receiptUnsigned) };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    const receiptPath = join(sourceRoot, ".inkos", "canaries", pairId, "common-snapshot.json");
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, receiptBytes);

    const canaryIsolation = {
      schemaVersion: "inkos-canary-execution-root-verification/v1" as const,
      scopeId: receipt.scopeId,
      pairId,
      bookId,
      lane: "neutral" as const,
      projectRoot: receipt.lanes.neutral.projectRoot,
      sourceProjectRootFingerprint: receipt.sourceProjectRootFingerprint,
      sourceBookManifestSha256,
      laneManifestSha256: receipt.lanes.neutral.postBindManifestSha256,
      receipt: {
        path: `.inkos/canaries/${pairId}/common-snapshot.json`,
        sha256: sha256(receiptBytes),
        byteLength: receiptBytes.byteLength,
        selfHash: receipt.receiptSelfHash,
      },
      isolationScopeSha256,
      commonSnapshotSha256,
      expectedSoulBinding: null,
    };
    mocks.structural.mockResolvedValue(canaryIsolation);
    mocks.pristine.mockImplementation(async () => {
      mocks.events.push("pristine");
      return canaryIsolation;
    });
    const release = vi.fn(async () => { mocks.events.push("release"); });
    mocks.acquireLease.mockImplementation(async () => {
      mocks.events.push("lease");
      return release;
    });
    mocks.loadTerminal.mockResolvedValue(undefined);
    mocks.loadBinding.mockResolvedValue(null);
    mocks.createDirection.mockResolvedValue({ receiptId: "owner-cli-e2e" });
    mocks.readModelCalls.mockResolvedValue([]);

    const modeEvidence = {
      lane: "neutral-baseline" as const,
      profileId: "neutral-baseline-ko",
      profileConfigSha256: "f".repeat(64),
      profileLifecycle: "baseline" as const,
      productionEnabled: false,
      adoptionRegistrySha256: "0".repeat(64),
      activeMatchingCount: 0 as const,
      soulId: "neutral-baseline-ko",
      soulVersion: "v1",
      soulSha256: "1".repeat(64),
      promotionDecisionSha256: null,
      canaryIsolation: {
        pairId,
        path: canaryIsolation.receipt.path,
        sha256: canaryIsolation.receipt.sha256,
        byteLength: canaryIsolation.receipt.byteLength,
        receiptSelfHash: canaryIsolation.receipt.selfHash,
        isolationScopeSha256,
        commonSnapshotSha256,
      },
    };
    const sessionId = `hq-agent-${hashCanonicalJson({
      v: 1,
      bookId,
      lane: modeEvidence.lane,
      profileId: modeEvidence.profileId,
      soulId: modeEvidence.soulId,
      soulVersion: modeEvidence.soulVersion,
      bindingSha256: null,
      isolationScopeSha256,
    }).slice(0, 40)}`;
    const instruction = "다음 화에서 즉시 보상을 보여 줘.";
    const args = { chapterCount: 1 as const, targetLength: { count: 1800, unit: "ko-chars" as const } };
    const instructionSha256 = directionTextSha256(instruction);
    const ownerDecision = {
      receiptId: "owner-cli-e2e",
      status: "approved" as const,
      instructionSha256,
      argsSha256: hashCanonicalJson({
        capability: "agent-operate",
        bookId,
        sessionId,
        args,
        expectedSoulBinding: null,
        executionMode: "promotion-canary",
        modeEvidence,
        instructionSha256,
      }),
      decidedAt: "2026-09-02T00:00:00.000Z",
    };
    const workOrder = {
      schemaVersion: 2 as const,
      workOrderId: "wo-cli-e2e",
      idempotencyKey: "idem-cli-e2e",
      repo: "inkos" as const,
      capability: "agent-operate" as const,
      bookId,
      sessionId,
      instruction,
      args,
      expectedSoulBinding: null,
      ownerDecision,
      runtime: { hermesProfile: "neutral-baseline-ko", model: "gpt-5.6-sol", reasoning: "high" },
      approvalMode: "human" as const,
      approvedInputs: [],
      privateInputs: [],
      requestedAt: "2026-09-02T00:00:00.000Z",
      timeoutMs: 600000,
      executionMode: "promotion-canary" as const,
      modeEvidence,
    };
    const workOrderBytes = Buffer.from(`${JSON.stringify(workOrder)}\n`, "utf8");
    const workOrderSha256 = sha256(workOrderBytes);
    const guidance = "첫 장면에서 계약을 뒤집어라.";
    const action = {
      schemaVersion: "hermes-control-action/v1",
      action: "write-next",
      workOrderId: workOrder.workOrderId,
      workOrderSha256,
      bookId,
      sessionId,
      guidance,
      guidanceSha256: directionTextSha256(guidance),
    };
    const actionBytes = Buffer.from(`${JSON.stringify(action)}\n`, "utf8");
    const hermesReceiptBytes = Buffer.from("{}\n", "utf8");
    const ipcBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: "inkos-agent-operation-request/v1",
      workOrder: artifact(workOrderBytes),
      hermesAction: { ...artifact(actionBytes), textSha256: action.guidanceSha256 },
      hermesReceipt: artifact(hermesReceiptBytes),
      canaryIsolationReceipt: { ...artifact(receiptBytes), selfHash: receipt.receiptSelfHash },
    })}\n`, "utf8");

    const paths = hermesControlOperationPaths(workOrder.workOrderId);
    const bookRoot = join(laneRoot, "books", bookId);
    const taskGuidance = {
      source: "hermes-control-action" as const,
      bookId,
      workOrderId: workOrder.workOrderId,
      actionRef: { path: paths.action, sha256: sha256(actionBytes), byteLength: actionBytes.byteLength },
      textSha256: action.guidanceSha256,
    };
    const importReceipt = {
      schemaVersion: "hermes-control-import/v2" as const,
      workOrderId: workOrder.workOrderId,
      workOrderSha256,
      bookId,
      sessionId,
      request: { path: paths.request, sha256: workOrderSha256, byteLength: workOrderBytes.byteLength },
      action: taskGuidance.actionRef,
      hermesReceipt: { path: paths.hermesReceipt, sha256: sha256(hermesReceiptBytes), byteLength: hermesReceiptBytes.byteLength },
      taskGuidance,
      canaryIsolation,
      importedAt: "2026-09-02T00:00:00.000Z",
      receiptSelfHash: "2".repeat(64),
    };
    mocks.importOperation.mockImplementation(async () => {
      mocks.events.push("import");
      await mkdir(dirname(join(bookRoot, paths.request)), { recursive: true });
      await Promise.all([
        writeFile(join(bookRoot, paths.request), workOrderBytes, { flag: "w" }),
        writeFile(join(bookRoot, paths.action), actionBytes, { flag: "w" }),
        writeFile(join(bookRoot, paths.hermesReceipt), hermesReceiptBytes, { flag: "w" }),
        writeFile(join(bookRoot, paths.importReceipt), `${JSON.stringify(importReceipt)}\n`, { flag: "w" }),
      ]);
      return {
        action,
        hermesReceipt: { invocation: { sessionId: "hermes-cli-e2e" } },
        importReceipt,
        taskGuidance,
      };
    });
    const runPath = "story/runtime/production-runs/terminals/11111111-1111-4111-8111-111111111111.json";
    const run = {
      command: { commandId: "11111111-1111-4111-8111-111111111111" },
      productionAttempt: {
        productionOperationId: "22222222-2222-4222-8222-222222222222",
        attemptId: "33333333-3333-4333-8333-333333333333",
      },
    };
    mocks.executeWriteNext.mockImplementation(async () => {
      mocks.events.push("pipeline");
      return { run };
    });
    const terminal = {
      schemaVersion: "inkos-agent-operation-terminal/v2" as const,
      status: "succeeded" as const,
      workOrderId: workOrder.workOrderId,
      workOrderSha256,
      bookId,
      sessionId,
      executionMode: "promotion-canary" as const,
      canaryIsolation,
      finalLaneManifestSha256: "3".repeat(64),
      importReceipt: { path: paths.importReceipt, sha256: "4".repeat(64), byteLength: 10 },
      productionRun: {
        path: runPath,
        sha256: "5".repeat(64),
        byteLength: 10,
        commandId: run.command.commandId,
        productionOperationId: run.productionAttempt.productionOperationId,
        attemptId: run.productionAttempt.attemptId,
      },
      completedAt: "2026-09-02T00:00:01.000Z",
      receiptSelfHash: "6".repeat(64),
      chapterCommit: {
        path: "story/runtime/chapter-commits/probe.json",
        sha256: "7".repeat(64),
        byteLength: 10,
        receiptId: "44444444-4444-4444-8444-444444444444",
        receiptSelfHash: "8".repeat(64),
      },
    };
    mocks.finalizeOperation.mockImplementation(async () => {
      mocks.events.push("finalize");
      await mkdir(dirname(join(bookRoot, runPath)), { recursive: true });
      await mkdir(dirname(join(bookRoot, paths.terminal)), { recursive: true });
      await writeFile(join(bookRoot, runPath), `${JSON.stringify({
        executionStatus: "succeeded",
        approvalStatus: "approved",
        completionHealth: "verified",
        projectionOrigin: "live-execution",
      })}\n`);
      await writeFile(join(bookRoot, paths.terminal), `${JSON.stringify(terminal)}\n`);
      return terminal;
    });

    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from([ipcBytes]) as typeof process.stdin);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousCwd = process.cwd();
    process.chdir(laneRoot);
    try {
      const command = productionCommand.commands.find((candidate) => candidate.name() === "agent-operate");
      if (!command) throw new Error("agent-operate command is missing");
      await command.parseAsync([
        "--work-order-sha", workOrderSha256,
        "--manifest-capability-sha", "9".repeat(64),
        "--json",
      ], { from: "user" });
    } finally {
      process.chdir(previousCwd);
      stdin.mockRestore();
    }

    expect(mocks.events).toEqual(["lease", "pristine", "import", "pipeline", "finalize", "release"]);
    expect(release).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"schemaVersion":"inkos-agent-operation-result/v1"'));
    const storedTerminal = JSON.parse(await readFile(join(bookRoot, paths.terminal), "utf8"));
    expect(storedTerminal.schemaVersion).toBe("inkos-agent-operation-terminal/v2");
  });
});
