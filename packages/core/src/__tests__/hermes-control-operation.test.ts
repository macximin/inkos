import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HermesInvocationReceiptSchema,
  ProductionExecutionTerminalError,
  StateManager,
  createDetachedOwnerDirectionLease,
  createWriteNextProductionCommandV2,
  directionTextSha256,
  executeObserveOnlyWriteNext,
  finalizeAgentOperation,
  hashCanonicalJson,
  hermesControlOperationPaths,
  importHermesControlOperation,
  loadAgentOperationTerminal,
  resolveTaskGuidance,
} from "../index.js";
import type { ChapterMeta } from "../models/chapter.js";
import type { ChapterPipelineResult } from "../pipeline/runner.js";
import type { ProductionAttemptIdentity } from "../production/attempt-identity.js";
import type { ProductionCommandV2 } from "../production/production-command.js";
import {
  beginFictionContentOperation,
  prepareFictionContentInvocation,
  sealFictionContentOperationManifest,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";
import { HERMES_CONTROL_TRANSPORT_POLICY } from "../production/hermes-control-operation.js";
import { writeChapterCommitReceipt } from "../state/chapter-commit-receipt.js";

const roots: string[] = [];
const NOW = new Date("2026-09-02T01:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256Bytes(bytes: Uint8Array): string {
  return directionTextSha256(Buffer.from(bytes).toString("utf8"));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-hermes-control-"));
  roots.push(root);
  const bookId = "agent-canary";
  const state = new StateManager(root);
  await state.saveBookConfig(bookId, {
    id: bookId,
    title: "Agent canary",
    platform: "other",
    genre: "urban-fantasy",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await state.saveChapterIndex(bookId, []);
  const workOrderId = "wo-agent-1";
  const sessionId = "hq-agent-session-1";
  const workOrderBytes = Buffer.from('{"schemaVersion":2,"workOrderId":"wo-agent-1"}\n', "utf8");
  const workOrderSha256 = sha256Bytes(workOrderBytes);
  const guidance = "첫 장면에서 계약의 함정을 역이용하고 즉시 보상을 보여 줘.";
  const action = {
    schemaVersion: "hermes-control-action/v1",
    action: "write-next",
    workOrderId,
    workOrderSha256,
    bookId,
    sessionId,
    guidance,
    guidanceSha256: directionTextSha256(guidance),
  } as const;
  const actionBytes = Buffer.from(`${JSON.stringify(action)}\n`, "utf8");
  const receiptUnsigned = {
    schemaVersion: "hermes-invocation-receipt/v1" as const,
    status: "completed" as const,
    workOrderId,
    workOrderSha256,
    profile: {
      profileId: "neutral-baseline-ko",
      soulId: "neutral-baseline-ko",
      soulVersion: "v1",
      configSha256: "a".repeat(64),
      soulSha256: "b".repeat(64),
    },
    runtime: {
      provider: "openai-codex" as const,
      model: "gpt-5.6-sol" as const,
      reasoning: "high" as const,
      platform: "cli" as const,
      openaiRuntime: "auto" as const,
      transport: "codex_responses" as const,
      toolsCount: 0 as const,
      toolCallCount: 0 as const,
    },
    invocation: {
      sessionId: "hermes-session-1",
      startedAt: NOW.toISOString(),
      completedAt: new Date(NOW.getTime() + 1000).toISOString(),
      exitCode: 0 as const,
    },
    promptSha256: "c".repeat(64),
    systemPrompt: { sha256: "f".repeat(64), byteLength: 300 },
    rawOutput: { sha256: "d".repeat(64), byteLength: 100 },
    action: {
      sha256: sha256Bytes(actionBytes),
      byteLength: actionBytes.byteLength,
      textSha256: action.guidanceSha256,
    },
    sessionExport: { sha256: "e".repeat(64), byteLength: 200 },
  };
  const receipt = HermesInvocationReceiptSchema.parse({
    ...receiptUnsigned,
    receiptSelfHash: hashCanonicalJson(receiptUnsigned),
  });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8");
  return { root, state, bookId, workOrderId, sessionId, workOrderBytes, workOrderSha256, guidance, action, actionBytes, receiptBytes };
}

async function persistSuccessfulChapter(input: {
  readonly root: string;
  readonly bookId: string;
  readonly bookDir: string;
  readonly productionAttempt: ProductionAttemptIdentity;
}): Promise<ChapterPipelineResult> {
  const operation = await beginFictionContentOperation({
    projectRoot: input.root,
    bookId: input.bookId,
    operationKind: "write-next-chapter",
    chapterNumber: 1,
    requiredStages: ["writer"],
    productionAttempt: input.productionAttempt,
    now: () => NOW,
  });
  const prepared = await prepareFictionContentInvocation({
    projectRoot: input.root,
    bookId: input.bookId,
    agentName: "writer",
    stage: "writer",
    model: "deterministic-agent-operate-test",
    operationId: operation.operationId,
    productionAttempt: input.productionAttempt,
    messages: [{ role: "system", content: "write" }, { role: "user", content: "다음 화를 집필해." }],
    now: () => NOW,
  });
  await writeFictionContentInvocationOutcome({ projectRoot: input.root, prepared, output: "completed", now: () => NOW });
  const manifest = await sealFictionContentOperationManifest({ projectRoot: input.root, operation, now: () => NOW });
  const chapter: ChapterMeta = {
    number: 1,
    title: "첫 성취",
    status: "ready-for-review",
    wordCount: 1800,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    auditIssues: [],
    lengthWarnings: [],
  };
  await mkdir(join(input.bookDir, "chapters"), { recursive: true });
  await Promise.all([
    writeFile(join(input.bookDir, "chapters", "0001_first.md"), "# 1화 첫 성취\n\n본문\n", "utf8"),
    writeFile(join(input.bookDir, "chapters", "index.json"), `${JSON.stringify([chapter], null, 2)}\n`, "utf8"),
  ]);
  const chapterCommitReceipt = await writeChapterCommitReceipt({
    bookDir: input.bookDir,
    bookId: input.bookId,
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

function asLegacyLeaseBoundV2(command: ProductionCommandV2): ProductionCommandV2 {
  const { workOrderId: _workOrderId, ...stableBinding } = command.binding;
  const intentDigest = hashCanonicalJson({
    capability: command.capability,
    source: command.source,
    binding: stableBinding,
    authorization: command.authorization,
    args: command.args,
    activatedSkills: [...command.activatedSkills],
    ...(command.disabledSkills ? { disabledSkills: [...command.disabledSkills] } : {}),
  });
  const { commandSelfHash: _self, ...unsigned } = command;
  const legacyUnsigned = { ...unsigned, intentDigest };
  return { ...legacyUnsigned, commandSelfHash: hashCanonicalJson(legacyUnsigned) };
}

describe("Book-local Hermes control operation", () => {
  it("imports exact zero-tool evidence once and resolves guidance without a transcript", async () => {
    const f = await fixture();
    const input = {
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    } as const;
    const imported = await importHermesControlOperation(input);
    await expect(resolveTaskGuidance({ projectRoot: f.root, reference: imported.taskGuidance }))
      .resolves.toMatchObject({ source: "hermes-control-action", text: f.guidance });
    const replay = await importHermesControlOperation({ ...input, importedAt: new Date(NOW.getTime() + 5000) });
    expect(replay.importReceipt).toEqual(imported.importReceipt);
    const paths = hermesControlOperationPaths(f.workOrderId);
    await expect(readFile(join(f.state.bookDir(f.bookId), paths.request))).resolves.toEqual(f.workOrderBytes);
    await expect(readFile(join(f.state.bookDir(f.bookId), paths.action))).resolves.toEqual(f.actionBytes);

    const storedImportBytes = await readFile(join(f.state.bookDir(f.bookId), paths.importReceipt));
    const normalizedOnly = JSON.parse(storedImportBytes.toString("utf8"));
    normalizedOnly.sessionId = ` ${normalizedOnly.sessionId} `;
    await writeFile(join(f.state.bookDir(f.bookId), paths.importReceipt), `${JSON.stringify(normalizedOnly, null, 2)}\n`);
    await expect(importHermesControlOperation(input)).rejects.toThrow(/raw self hash/i);

    const nonCanonical = JSON.parse(storedImportBytes.toString("utf8"));
    nonCanonical.request.path = `${dirname(nonCanonical.request.path)}/request-copy.json`;
    const { receiptSelfHash: _canonicalSelf, ...nonCanonicalUnsigned } = nonCanonical;
    nonCanonical.receiptSelfHash = hashCanonicalJson(nonCanonicalUnsigned);
    await writeFile(join(f.state.bookDir(f.bookId), paths.importReceipt), `${JSON.stringify(nonCanonical, null, 2)}\n`);
    await expect(importHermesControlOperation(input)).rejects.toThrow(/paths are not canonical/i);
    await writeFile(join(f.state.bookDir(f.bookId), paths.importReceipt), storedImportBytes);

    const storedImport = JSON.parse(storedImportBytes.toString("utf8"));
    storedImport.sessionId = "different-session";
    const { receiptSelfHash: _self, ...unsigned } = storedImport;
    storedImport.receiptSelfHash = hashCanonicalJson(unsigned);
    await writeFile(join(f.state.bookDir(f.bookId), paths.importReceipt), `${JSON.stringify(storedImport, null, 2)}\n`, "utf8");
    await expect(importHermesControlOperation(input)).rejects.toThrow(/different immutable evidence/i);
  });

  it("rejects profile drift, action tampering, and nonzero tool evidence", async () => {
    const f = await fixture();
    const common = {
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    } as const;
    await expect(importHermesControlOperation({
      ...common,
      profile: { ...common.profile, profileConfigSha256: "f".repeat(64) },
    })).rejects.toThrow(/profile/i);

    const imported = await importHermesControlOperation(common);
    const paths = hermesControlOperationPaths(f.workOrderId);
    await writeFile(join(f.state.bookDir(f.bookId), paths.action), "{}\n", "utf8");
    await expect(resolveTaskGuidance({ projectRoot: f.root, reference: imported.taskGuidance }))
      .rejects.toThrow(/bytes no longer match/i);

    const receipt = JSON.parse(f.receiptBytes.toString("utf8"));
    receipt.runtime.toolCallCount = 1;
    const { receiptSelfHash: _self, ...unsigned } = receipt;
    receipt.receiptSelfHash = hashCanonicalJson(unsigned);
    await expect(HermesInvocationReceiptSchema.parseAsync(receipt)).rejects.toThrow();

    const currentReceipt = JSON.parse(f.receiptBytes.toString("utf8"));
    currentReceipt.runtime.transportPolicy = { ...HERMES_CONTROL_TRANSPORT_POLICY };
    const { receiptSelfHash: _historicalSelf, ...currentUnsigned } = currentReceipt;
    currentReceipt.receiptSelfHash = hashCanonicalJson(currentUnsigned);
    expect(HermesInvocationReceiptSchema.parse(currentReceipt).runtime.transportPolicy)
      .toEqual(HERMES_CONTROL_TRANSPORT_POLICY);

    const tamperedPolicyReceipt = structuredClone(currentReceipt);
    tamperedPolicyReceipt.runtime.transportPolicy.invocationTimeoutMs = 1;
    const { receiptSelfHash: _currentSelf, ...tamperedUnsigned } = tamperedPolicyReceipt;
    tamperedPolicyReceipt.receiptSelfHash = hashCanonicalJson(tamperedUnsigned);
    await expect(HermesInvocationReceiptSchema.parseAsync(tamperedPolicyReceipt)).rejects.toThrow();
  });

  it("rejects a Hermes action whose ancestor is swapped to a symlink after import", async () => {
    const f = await fixture();
    const imported = await importHermesControlOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    });
    const paths = hermesControlOperationPaths(f.workOrderId);
    const operationDir = dirname(join(f.state.bookDir(f.bookId), paths.action));
    const movedDir = `${operationDir}-real`;
    await rename(operationDir, movedDir);
    await symlink(movedDir, operationDir, "dir");

    await expect(resolveTaskGuidance({ projectRoot: f.root, reference: imported.taskGuidance }))
      .rejects.toThrow(/symbolic-link/i);
  });

  it("persists a failed kernel terminal once and returns the exact terminal on replay", async () => {
    const f = await fixture();
    const imported = await importHermesControlOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    });
    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot: f.root,
      receiptId: "owner-1",
      text: "다음 화를 집필해.",
      now: NOW,
    });
    const binding = {
      bookId: f.bookId,
      sessionId: f.sessionId,
      requestId: f.workOrderId,
      workOrderId: f.workOrderId,
    };
    const command = createWriteNextProductionCommandV2({
      idempotencyKey: "idem-agent-failed",
      source: "hq",
      binding,
      ownerDirection,
      taskGuidance: imported.taskGuidance,
      authorization: {
        kind: "authenticated-orchestrator",
        workOrderId: f.workOrderId,
        workOrderSha256: f.workOrderSha256,
        manifestCapabilitySha256: "c".repeat(64),
        ownerDecisionReceiptSha256: "d".repeat(64),
      },
      now: NOW,
    });
    let run;
    try {
      await executeObserveOnlyWriteNext({
        projectRoot: f.root,
        kernelMode: "enforce",
        persistedCommand: command,
        currentBinding: binding,
        executeWithinBookLock: async () => { throw new Error("provider failed before commit"); },
        now: () => NOW,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionExecutionTerminalError);
      run = (error as ProductionExecutionTerminalError).run;
    }
    expect(run).toBeDefined();
    const first = await finalizeAgentOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      executionMode: "production",
      canaryIsolation: null,
      importReceipt: imported.importReceipt,
      productionRun: run!,
      completedAt: NOW,
    });
    expect(first.status).toBe("failed");
    expect(imported.importReceipt.schemaVersion).toBe("hermes-control-import/v2");
    if (imported.importReceipt.schemaVersion !== "hermes-control-import/v2") throw new Error("expected import v2");
    expect(first.schemaVersion).toBe("inkos-agent-operation-terminal/v2");
    if (first.schemaVersion !== "inkos-agent-operation-terminal/v2") throw new Error("expected terminal v2");
    expect(imported.importReceipt.canaryIsolation).toBeNull();
    expect(first.canaryIsolation).toBeNull();
    expect(first.finalLaneManifestSha256).toBeNull();
    const replay = await finalizeAgentOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      executionMode: "production",
      canaryIsolation: null,
      importReceipt: imported.importReceipt,
      productionRun: run!,
      completedAt: new Date(NOW.getTime() + 60_000),
    });
    expect(replay).toEqual(first);
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .resolves.toEqual(first);

    const operationPaths = hermesControlOperationPaths(f.workOrderId);
    const terminalV2Bytes = await readFile(join(f.state.bookDir(f.bookId), operationPaths.terminal));
    const normalizedTerminal = JSON.parse(terminalV2Bytes.toString("utf8"));
    normalizedTerminal.sessionId = ` ${normalizedTerminal.sessionId} `;
    await writeFile(join(f.state.bookDir(f.bookId), operationPaths.terminal), `${JSON.stringify(normalizedTerminal)}\n`);
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .rejects.toThrow(/raw self hash/i);

    const nonCanonicalTerminal = JSON.parse(terminalV2Bytes.toString("utf8"));
    nonCanonicalTerminal.productionRun.path = "story/runtime/production-runs/terminals/not-the-command-id.json";
    const { receiptSelfHash: _nonCanonicalSelf, ...nonCanonicalTerminalUnsigned } = nonCanonicalTerminal;
    nonCanonicalTerminal.receiptSelfHash = hashCanonicalJson(nonCanonicalTerminalUnsigned);
    await writeFile(join(f.state.bookDir(f.bookId), operationPaths.terminal), `${JSON.stringify(nonCanonicalTerminal)}\n`);
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .rejects.toThrow(/paths are not canonical/i);
    await writeFile(join(f.state.bookDir(f.bookId), operationPaths.terminal), terminalV2Bytes);

    const importV2 = JSON.parse(await readFile(join(f.state.bookDir(f.bookId), operationPaths.importReceipt), "utf8"));
    const {
      schemaVersion: _importSchema,
      canaryIsolation: _importCanary,
      receiptSelfHash: _importSelf,
      ...importFields
    } = importV2;
    const importV1Unsigned = { schemaVersion: "hermes-control-import/v1", ...importFields };
    const importV1 = { ...importV1Unsigned, receiptSelfHash: hashCanonicalJson(importV1Unsigned) };
    const importV1Bytes = Buffer.from(`${JSON.stringify(importV1, null, 2)}\n`, "utf8");
    await writeFile(join(f.state.bookDir(f.bookId), operationPaths.importReceipt), importV1Bytes);

    const {
      schemaVersion: _terminalSchema,
      canaryIsolation: _terminalCanary,
      finalLaneManifestSha256: _finalManifest,
      receiptSelfHash: _terminalSelf,
      ...terminalFields
    } = first;
    const terminalV1Unsigned = {
      schemaVersion: "inkos-agent-operation-terminal/v1",
      ...terminalFields,
      importReceipt: {
        ...first.importReceipt,
        sha256: sha256Bytes(importV1Bytes),
        byteLength: importV1Bytes.byteLength,
      },
    };
    const terminalV1 = { ...terminalV1Unsigned, receiptSelfHash: hashCanonicalJson(terminalV1Unsigned) };
    await writeFile(
      join(f.state.bookDir(f.bookId), operationPaths.terminal),
      `${JSON.stringify(terminalV1, null, 2)}\n`,
    );
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .resolves.toMatchObject({ schemaVersion: "inkos-agent-operation-terminal/v1", executionMode: "production" });
    await expect(importHermesControlOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
    })).resolves.toMatchObject({ importReceipt: { schemaVersion: "hermes-control-import/v1" } });

    const legacyCanaryUnsigned = { ...terminalV1Unsigned, executionMode: "promotion-canary" };
    await writeFile(join(f.state.bookDir(f.bookId), operationPaths.terminal), `${JSON.stringify({
      ...legacyCanaryUnsigned,
      receiptSelfHash: hashCanonicalJson(legacyCanaryUnsigned),
    }, null, 2)}\n`);
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .rejects.toThrow(/legacy.*production replay/i);
    await writeFile(
      join(f.state.bookDir(f.bookId), operationPaths.terminal),
      `${JSON.stringify(terminalV1, null, 2)}\n`,
    );

    await rm(join(f.state.bookDir(f.bookId), first.productionRun.path));
    await expect(loadAgentOperationTerminal({ projectRoot: f.root, bookId: f.bookId, workOrderId: f.workOrderId }))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the imported guidance to one verified Chapter commit and never reruns the writer on replay", async () => {
    const f = await fixture();
    const imported = await importHermesControlOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      workOrderBytes: f.workOrderBytes,
      actionBytes: f.actionBytes,
      hermesReceiptBytes: f.receiptBytes,
      executionMode: "production",
      canaryIsolation: null,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    });
    const binding = {
      bookId: f.bookId,
      sessionId: f.sessionId,
      requestId: f.workOrderId,
      workOrderId: f.workOrderId,
    };
    const authorization = {
      kind: "authenticated-orchestrator" as const,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      manifestCapabilitySha256: "c".repeat(64),
      ownerDecisionReceiptSha256: "d".repeat(64),
    };
    const createCommand = async () => createWriteNextProductionCommandV2({
      idempotencyKey: "idem-agent-success",
      source: "hq",
      binding,
      ownerDirection: await createDetachedOwnerDirectionLease({
        projectRoot: f.root,
        receiptId: "owner-success",
        text: "다음 화를 집필해.",
        now: NOW,
      }),
      taskGuidance: imported.taskGuidance,
      authorization,
      now: NOW,
    });
    let writerCalls = 0;
    const executeWithinBookLock = async (input: {
      readonly productionAttempt: ProductionAttemptIdentity;
      readonly directionContext: { readonly taskGuidance?: { readonly text: string } };
    }) => {
      writerCalls += 1;
      expect(input.directionContext.taskGuidance?.text).toBe(f.guidance);
      return persistSuccessfulChapter({
        root: f.root,
        bookId: f.bookId,
        bookDir: f.state.bookDir(f.bookId),
        productionAttempt: input.productionAttempt,
      });
    };
    const stableFirstCommand = await createCommand();
    const legacyFirstCommand = asLegacyLeaseBoundV2(stableFirstCommand);
    expect(legacyFirstCommand.intentDigest).not.toBe(stableFirstCommand.intentDigest);
    const first = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "enforce",
      persistedCommand: legacyFirstCommand,
      currentBinding: binding,
      executeWithinBookLock,
      now: () => NOW,
    });
    expect(first.run.executionStatus).toBe("succeeded");
    expect(writerCalls).toBe(1);
    const terminal = await finalizeAgentOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      executionMode: "production",
      canaryIsolation: null,
      importReceipt: imported.importReceipt,
      productionRun: first.run,
      completedAt: NOW,
    });
    expect(terminal).toMatchObject({ status: "succeeded", chapterCommit: { receiptSelfHash: expect.any(String) } });

    const replay = await executeObserveOnlyWriteNext({
      projectRoot: f.root,
      kernelMode: "enforce",
      persistedCommand: await createCommand(),
      currentBinding: binding,
      executeWithinBookLock,
      now: () => new Date(NOW.getTime() + 1000),
    });
    expect(replay.reused).toBe(true);
    expect(replay.run).toEqual(first.run);
    expect(writerCalls).toBe(1);
    await expect(finalizeAgentOperation({
      projectRoot: f.root,
      bookId: f.bookId,
      sessionId: f.sessionId,
      workOrderId: f.workOrderId,
      workOrderSha256: f.workOrderSha256,
      executionMode: "production",
      canaryIsolation: null,
      importReceipt: imported.importReceipt,
      productionRun: replay.run,
      completedAt: new Date(NOW.getTime() + 10_000),
    })).resolves.toEqual(terminal);
  });
});
