import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindBookSoul: vi.fn(),
  loadActiveBookSoulBinding: vi.fn(),
}));

vi.mock("../production/book-soul-binding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../production/book-soul-binding.js")>();
  return {
    ...actual,
    bindBookSoul: mocks.bindBookSoul,
    loadActiveBookSoulBinding: mocks.loadActiveBookSoulBinding,
  };
});

import { StateManager } from "../state/manager.js";
import {
  HermesInvocationReceiptSchema,
  ProductionExecutionTerminalError,
  createDetachedOwnerDirectionLease,
  createWriteNextProductionCommandV2,
  directionTextSha256,
  executeObserveOnlyWriteNext,
  finalizeAgentOperation,
  importHermesControlOperation,
  loadAgentOperationTerminal,
} from "../index.js";
import {
  CANARY_ISOLATION_RECEIPT_MAX_BYTES,
  CanaryCommonSnapshotReceiptSchema,
  acquireProductionCanaryAgentOperationLease,
  collectProductionCanaryFinalLaneManifestSha256,
  loadCanaryCommonSnapshotReceipt,
  prepareProductionCanaryPair,
  verifyProductionCanaryExecutionRoot,
  verifyProductionCanaryTerminalReplayRoot,
  type PrepareProductionCanaryPairInput,
} from "../production/canary-isolation.js";
import { hashCanonicalJson } from "../production/fiction-content-contract.js";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const roots: string[] = [];
const BINDING_SHA = "b".repeat(64);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture(): Promise<PrepareProductionCanaryPairInput> {
  const root = await mkdtemp(join(tmpdir(), "inkos-canary-isolation-"));
  const referenceLab = await mkdtemp(join(tmpdir(), "inkos-canary-reference-lab-"));
  const inkosEvidence = await mkdtemp(join(tmpdir(), "inkos-canary-evidence-inkos-"));
  const hq = await mkdtemp(join(tmpdir(), "inkos-canary-hq-"));
  roots.push(root, referenceLab, inkosEvidence, hq);
  await writeJson(join(root, "inkos.json"), {
    name: "canary-test",
    version: "0.1.0",
    language: "ko",
    llm: { provider: "openai", model: "gpt-5.6-sol" },
  });
  const genreProfile = `---
name: 한국 현대판타지
id: modern-fantasy-ko
language: ko
chapterTypes: ["현실 진입", "가시적 지급"]
fatigueWords: []
---
fun-first
`;
  await writeFile(join(root, "genres", "modern-fantasy-ko.md"), genreProfile, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(join(root, "genres"), { recursive: true });
    await writeFile(join(root, "genres", "modern-fantasy-ko.md"), genreProfile, "utf8");
  });
  const bookId = "canary-book";
  const state = new StateManager(root);
  await state.saveBookConfig(bookId, {
    id: bookId,
    title: "Canary Book",
    platform: "other",
    genre: "modern-fantasy-ko",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  await writeFile(join(state.bookDir(bookId), "story", "brief.md"), "same source bytes\n", "utf8").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(join(state.bookDir(bookId), "story"), { recursive: true });
    await writeFile(join(state.bookDir(bookId), "story", "brief.md"), "same source bytes\n", "utf8");
  });
  await writeJson(join(inkosEvidence, "souls", "candidate", "manifest.json"), {
    schemaVersion: "soul-package/v1",
    soulId: "male-modern-fantasy-ko",
    version: "v1",
    promptPath: "SOUL.md",
    resources: [],
  });
  await writeFile(join(inkosEvidence, "souls", "candidate", "SOUL.md"), "candidate soul\n", "utf8");
  await writeJson(join(referenceLab, "receipts", "source-registry.json"), { schemaVersion: "source-registry/v1" });
  await writeJson(join(hq, "decisions", "candidate.json"), { schemaVersion: "soul-binding-decision/v2" });
  return {
    projectRoot: root,
    bookId,
    pairId: "pair-001",
    soulId: "male-modern-fantasy-ko",
    soulVersion: "v1",
    soulManifestPath: "souls/candidate/manifest.json",
    sourceRegistryReceipt: { root: referenceLab, path: "receipts/source-registry.json" },
    decisionReceipt: { root: hq, path: "decisions/candidate.json" },
    evidenceRoots: { referenceLab, inkos: inkosEvidence, hq },
    now: () => NOW,
  };
}

async function regularFiles(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await stat(path);
      if (info.isDirectory()) await walk(path, relative);
      else output[relative] = sha256(await readFile(path));
    }
  };
  await walk(root);
  return output;
}

beforeEach(() => {
  mocks.bindBookSoul.mockReset();
  mocks.loadActiveBookSoulBinding.mockReset();
  mocks.loadActiveBookSoulBinding.mockImplementation(async (projectRoot: string) => (
    projectRoot.endsWith("/soul")
      ? { soulId: "male-modern-fantasy-ko", version: "v1", bindingSha256: BINDING_SHA }
      : null
  ));
  mocks.bindBookSoul.mockImplementation(async (input: { projectRoot: string; bookId: string }) => {
    const objectRoot = join(input.projectRoot, ".inkos", "production", "souls", "objects", "a".repeat(64));
    const bindingRoot = join(input.projectRoot, "books", input.bookId, "story", "soul-bindings");
    await writeJson(join(objectRoot, "manifest.json"), { schemaVersion: "soul-package/v1" });
    await writeJson(join(bindingRoot, "decisions", "candidate-001.json"), { decisionId: "candidate-001" });
    await writeJson(join(bindingRoot, "v0001.json"), { bindingSha256: BINDING_SHA });
    await writeJson(join(bindingRoot, "current.json"), { bindingSha256: BINDING_SHA });
    return {
      schemaVersion: "book-soul-binding/v2",
      status: "candidate",
      soulId: "male-modern-fantasy-ko",
      version: "v1",
      bindingSha256: BINDING_SHA,
      adoptionEvidence: { hqAdoption: null },
    };
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production canary isolation", () => {
  it("creates two byte-identical real roots, binds only the Soul lane, and leaves production unchanged", async () => {
    const input = await fixture();
    const productionBefore = await regularFiles(join(input.projectRoot, "books", input.bookId));
    const result = await prepareProductionCanaryPair(input);
    const productionAfter = await regularFiles(join(input.projectRoot, "books", input.bookId));

    expect(productionAfter).toEqual(productionBefore);
    expect(result.replayed).toBe(false);
    expect(result.scopeId).toBe(`canary-pair:${input.pairId}:${input.bookId}`);
    expect(result.lanes.neutral.preBindManifestSha256).toBe(result.lanes.genreSoul.preBindManifestSha256);
    expect(result.lanes.neutral.preBindManifestSha256).toBe(result.lanes.neutral.postBindManifestSha256);
    expect(result.lanes.neutral.expectedSoulBinding).toBeNull();
    expect(result.lanes.genreSoul.expectedSoulBinding).toEqual({
      soulId: input.soulId,
      soulVersion: input.soulVersion,
      bindingSha256: BINDING_SHA,
    });
    expect(result.lanes.genreSoul.allowedDeltaPaths.length).toBeGreaterThan(0);
    expect(result.lanes.genreSoul.allowedDeltaPaths.every((path) => (
      path.startsWith(".inkos/production/souls/objects/")
      || path.startsWith(`books/${input.bookId}/story/soul-bindings/`)
    ))).toBe(true);

    const neutralRoot = join(input.projectRoot, result.lanes.neutral.projectRoot);
    const soulRoot = join(input.projectRoot, result.lanes.genreSoul.projectRoot);
    expect((await stat(neutralRoot)).isDirectory()).toBe(true);
    expect((await stat(soulRoot)).isDirectory()).toBe(true);
    for (const path of ["inkos.json", "genres/modern-fantasy-ko.md", `books/${input.bookId}/story/brief.md`]) {
      expect(await readFile(join(neutralRoot, path))).toEqual(await readFile(join(soulRoot, path)));
      expect(await readFile(join(neutralRoot, path))).toEqual(await readFile(join(input.projectRoot, path)));
    }

    const receiptBytes = await readFile(join(input.projectRoot, result.receipt.path));
    expect(sha256(receiptBytes)).toBe(result.receipt.sha256);
    expect(receiptBytes.byteLength).toBe(result.receipt.byteLength);
    const receipt = CanaryCommonSnapshotReceiptSchema.parse(JSON.parse(receiptBytes.toString("utf8")));
    const { receiptSelfHash, ...unsigned } = receipt;
    expect(hashCanonicalJson(unsigned)).toBe(receiptSelfHash);
    expect(receiptSelfHash).toBe(result.receipt.selfHash);
    await expect(loadCanaryCommonSnapshotReceipt(input.projectRoot, input.pairId)).resolves.toEqual(receipt);
  });

  it("replays without clobbering and rejects a changed source snapshot", async () => {
    const input = await fixture();
    const first = await prepareProductionCanaryPair(input);
    const receiptBefore = await readFile(join(input.projectRoot, first.receipt.path));
    const replay = await prepareProductionCanaryPair(input);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(await readFile(join(input.projectRoot, first.receipt.path))).toEqual(receiptBefore);
    expect(mocks.bindBookSoul).toHaveBeenCalledTimes(1);

    const neutralBrief = join(
      input.projectRoot,
      first.lanes.neutral.projectRoot,
      "books",
      input.bookId,
      "story",
      "brief.md",
    );
    await writeFile(neutralBrief, "changed lane\n", "utf8");
    await expect(prepareProductionCanaryPair(input)).rejects.toThrow(/full immutable prepared snapshot/i);
    await writeFile(neutralBrief, "same source bytes\n", "utf8");

    mocks.loadActiveBookSoulBinding
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => null);
    await expect(prepareProductionCanaryPair(input)).rejects.toThrow(/full immutable prepared snapshot/i);

    await writeFile(join(input.projectRoot, "books", input.bookId, "story", "brief.md"), "changed source\n", "utf8");
    await expect(prepareProductionCanaryPair(input)).rejects.toThrow(/immutable prepare request|source snapshot/i);
    expect(await readFile(join(input.projectRoot, first.receipt.path))).toEqual(receiptBefore);
  });

  it("rejects symlinks before cloning any lane", async () => {
    const input = await fixture();
    const external = join(input.projectRoot, "outside.txt");
    await writeFile(external, "outside\n", "utf8");
    await symlink(external, join(input.projectRoot, "books", input.bookId, "story", "linked.md"));
    await expect(prepareProductionCanaryPair(input)).rejects.toThrow(/symlink/i);
    await expect(stat(join(input.projectRoot, ".inkos", "canaries", input.pairId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.bindBookSoul).not.toHaveBeenCalled();
  });

  it("verifies the exact lane cwd and every pair-level hash before execution", async () => {
    const input = await fixture();
    const prepared = await prepareProductionCanaryPair(input);
    const neutral = await verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    });
    expect(neutral).toMatchObject({
      schemaVersion: "inkos-canary-execution-root-verification/v1",
      lane: "neutral",
      projectRoot: prepared.lanes.neutral.projectRoot,
      laneManifestSha256: prepared.lanes.neutral.postBindManifestSha256,
    });
    const soul = await verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.genreSoul.projectRoot),
      pairId: input.pairId,
      lane: "soul",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: prepared.lanes.genreSoul.expectedSoulBinding,
    });
    expect(soul.laneManifestSha256).toBe(prepared.lanes.genreSoul.postBindManifestSha256);

    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength + 1,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/pair-level isolation receipt/i);

    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: input.projectRoot,
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/canonical lane|real directory|receipt/i);
    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "soul",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: prepared.lanes.genreSoul.expectedSoulBinding,
    })).rejects.toThrow(/canonical lane|cwd/i);
    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: "f".repeat(64),
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/pair-level isolation receipt/i);
    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: "e".repeat(64),
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/pair-level isolation receipt/i);

    const sourceBrief = join(input.projectRoot, "books", input.bookId, "story", "brief.md");
    await writeFile(sourceBrief, "source drift\n", "utf8");
    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/source production Book/i);
    await writeFile(sourceBrief, "same source bytes\n", "utf8");

    const neutralBrief = join(input.projectRoot, prepared.lanes.neutral.projectRoot, "books", input.bookId, "story", "brief.md");
    await writeFile(neutralBrief, "lane drift\n", "utf8");
    await expect(verifyProductionCanaryExecutionRoot({
      projectRoot: join(input.projectRoot, prepared.lanes.neutral.projectRoot),
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    })).rejects.toThrow(/lane changed/i);

    const receiptPath = join(input.projectRoot, prepared.receipt.path);
    const tamperedReceipt = JSON.parse((await readFile(receiptPath)).toString("utf8")) as Record<string, unknown>;
    tamperedReceipt.scopeId = "tampered";
    await writeJson(receiptPath, tamperedReceipt);
    await expect(loadCanaryCommonSnapshotReceipt(input.projectRoot, input.pairId)).rejects.toThrow(/self-hash/i);
  });

  it("emits only v2 canary import/terminal receipts and self-verifies terminal replay", async () => {
    const input = await fixture();
    const prepared = await prepareProductionCanaryPair(input);
    const laneRoot = join(input.projectRoot, prepared.lanes.neutral.projectRoot);
    const canaryIsolation = await verifyProductionCanaryExecutionRoot({
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral",
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
    });
    const workOrderId = "wo-real-canary-v2";
    const sessionId = "hq-agent-real-canary-v2";
    const workOrderBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 2, workOrderId })}\n`, "utf8");
    const workOrderSha256 = sha256(workOrderBytes);
    const guidance = "첫 장면에서 즉시 성취 보상을 보여 줘.";
    const action = {
      schemaVersion: "hermes-control-action/v1" as const,
      action: "write-next" as const,
      workOrderId,
      workOrderSha256,
      bookId: input.bookId,
      sessionId,
      guidance,
      guidanceSha256: directionTextSha256(guidance),
    };
    const actionBytes = Buffer.from(`${JSON.stringify(action)}\n`, "utf8");
    const hermesUnsigned = {
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
        sessionId: "hermes-real-canary-v2",
        startedAt: NOW.toISOString(),
        completedAt: new Date(NOW.getTime() + 1000).toISOString(),
        exitCode: 0 as const,
      },
      promptSha256: "c".repeat(64),
      systemPrompt: { sha256: "d".repeat(64), byteLength: 100 },
      rawOutput: { sha256: "e".repeat(64), byteLength: 100 },
      action: {
        sha256: sha256(actionBytes),
        byteLength: actionBytes.byteLength,
        textSha256: action.guidanceSha256,
      },
      sessionExport: { sha256: "f".repeat(64), byteLength: 100 },
    };
    const hermesReceipt = HermesInvocationReceiptSchema.parse({
      ...hermesUnsigned,
      receiptSelfHash: hashCanonicalJson(hermesUnsigned),
    });
    const imported = await importHermesControlOperation({
      projectRoot: laneRoot,
      bookId: input.bookId,
      sessionId,
      workOrderId,
      workOrderSha256,
      workOrderBytes,
      actionBytes,
      hermesReceiptBytes: Buffer.from(`${JSON.stringify(hermesReceipt)}\n`, "utf8"),
      executionMode: "promotion-canary",
      canaryIsolation,
      profile: {
        profileId: "neutral-baseline-ko",
        soulId: "neutral-baseline-ko",
        soulVersion: "v1",
        profileConfigSha256: "a".repeat(64),
        soulSha256: "b".repeat(64),
      },
      importedAt: NOW,
    });
    expect(imported.importReceipt.schemaVersion).toBe("hermes-control-import/v2");
    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot: laneRoot,
      receiptId: "owner-real-canary-v2",
      text: guidance,
      now: NOW,
    });
    const binding = { bookId: input.bookId, sessionId, requestId: workOrderId, workOrderId };
    const command = createWriteNextProductionCommandV2({
      idempotencyKey: "idem-real-canary-v2",
      source: "hq",
      binding,
      ownerDirection,
      taskGuidance: imported.taskGuidance,
      authorization: {
        kind: "authenticated-orchestrator",
        workOrderId,
        workOrderSha256,
        manifestCapabilitySha256: "1".repeat(64),
        ownerDecisionReceiptSha256: "2".repeat(64),
      },
      now: NOW,
    });
    let run;
    try {
      await executeObserveOnlyWriteNext({
        projectRoot: laneRoot,
        kernelMode: "enforce",
        persistedCommand: command,
        currentBinding: binding,
        executeWithinBookLock: async () => { throw new Error("deterministic canary provider failure"); },
        now: () => NOW,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionExecutionTerminalError);
      run = (error as ProductionExecutionTerminalError).run;
    }
    if (!run) throw new Error("missing deterministic failed production run");
    const terminal = await finalizeAgentOperation({
      projectRoot: laneRoot,
      bookId: input.bookId,
      sessionId,
      workOrderId,
      workOrderSha256,
      executionMode: "promotion-canary",
      canaryIsolation,
      importReceipt: imported.importReceipt,
      productionRun: run,
      completedAt: NOW,
    });
    expect(terminal.schemaVersion).toBe("inkos-agent-operation-terminal/v2");
    if (terminal.schemaVersion !== "inkos-agent-operation-terminal/v2") throw new Error("expected terminal v2");
    expect(terminal.canaryIsolation).toEqual(canaryIsolation);
    expect(terminal.finalLaneManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(loadAgentOperationTerminal({ projectRoot: laneRoot, bookId: input.bookId, workOrderId }))
      .resolves.toEqual(terminal);

    const otherTerminal = join(
      laneRoot,
      "books",
      input.bookId,
      "story",
      "runtime",
      "hermes-control",
      "wo-other-v2",
      "terminal.json",
    );
    await writeJson(otherTerminal, { other: true });
    await expect(loadAgentOperationTerminal({ projectRoot: laneRoot, bookId: input.bookId, workOrderId }))
      .rejects.toThrow(/sealed final manifest/i);
  });

  it("seals the final lane without self-referencing its terminal and rejects replay drift", async () => {
    const input = await fixture();
    const prepared = await prepareProductionCanaryPair(input);
    const laneRoot = join(input.projectRoot, prepared.lanes.neutral.projectRoot);
    const workOrderId = "wo-canary-replay-1";
    const chapterPath = join(laneRoot, "books", input.bookId, "chapters", "0001.md");
    await mkdir(dirname(chapterPath), { recursive: true });
    await writeFile(chapterPath, "# 1화\n", "utf8");
    const finalLaneManifestSha256 = await collectProductionCanaryFinalLaneManifestSha256({
      projectRoot: laneRoot,
      bookId: input.bookId,
      workOrderId,
    });
    const terminalPath = join(
      laneRoot,
      "books",
      input.bookId,
      "story",
      "runtime",
      "hermes-control",
      workOrderId,
      "terminal.json",
    );
    await writeJson(terminalPath, { selfReferentialTerminal: true });
    await expect(collectProductionCanaryFinalLaneManifestSha256({
      projectRoot: laneRoot,
      bookId: input.bookId,
      workOrderId,
    })).resolves.toBe(finalLaneManifestSha256);

    const otherTerminalPath = join(
      laneRoot,
      "books",
      input.bookId,
      "story",
      "runtime",
      "hermes-control",
      "wo-other-operation",
      "terminal.json",
    );
    await writeJson(otherTerminalPath, { otherTerminalMustBeSealed: true });
    await expect(collectProductionCanaryFinalLaneManifestSha256({
      projectRoot: laneRoot,
      bookId: input.bookId,
      workOrderId,
    })).resolves.not.toBe(finalLaneManifestSha256);
    await rm(dirname(otherTerminalPath), { recursive: true, force: true });

    const common = {
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral" as const,
      receiptSha256: prepared.receipt.sha256,
      receiptByteLength: prepared.receipt.byteLength,
      receiptSelfHash: prepared.receipt.selfHash,
      isolationScopeSha256: prepared.isolationScopeSha256,
      commonSnapshotSha256: prepared.commonSnapshotSha256,
      bookId: input.bookId,
      expectedSoulBinding: null,
      workOrderId,
      finalLaneManifestSha256,
    };
    await expect(verifyProductionCanaryTerminalReplayRoot(common)).resolves.toMatchObject({
      pairId: input.pairId,
      lane: "neutral",
      laneManifestSha256: prepared.lanes.neutral.postBindManifestSha256,
    });

    await writeFile(join(laneRoot, "unexpected-replay-drift.txt"), "drift\n", "utf8");
    await expect(verifyProductionCanaryTerminalReplayRoot(common)).rejects.toThrow(/sealed final manifest/i);
  });

  it("serializes one pair/lane outside the lane manifest and never deletes foreign ownership", async () => {
    const input = await fixture();
    const prepared = await prepareProductionCanaryPair(input);
    const laneRoot = join(input.projectRoot, prepared.lanes.neutral.projectRoot);
    const manifestBefore = await collectProductionCanaryFinalLaneManifestSha256({
      projectRoot: laneRoot,
      bookId: input.bookId,
      workOrderId: "wo-lease-probe",
    });
    const release = await acquireProductionCanaryAgentOperationLease({
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral",
    });
    await expect(acquireProductionCanaryAgentOperationLease({
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral",
    })).rejects.toThrow(/already running/i);
    await expect(collectProductionCanaryFinalLaneManifestSha256({
      projectRoot: laneRoot,
      bookId: input.bookId,
      workOrderId: "wo-lease-probe",
    })).resolves.toBe(manifestBefore);

    const lockPath = join(input.projectRoot, ".inkos", "canaries", input.pairId, ".agent-neutral.lock");
    const foreign = {
      schemaVersion: "inkos-canary-lease/v1",
      kind: "agent-operation",
      pairId: input.pairId,
      lane: "neutral",
      pid: process.pid,
      token: "11111111-1111-4111-8111-111111111111",
      startedAt: NOW.toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(foreign)}\n`, "utf8");
    await release();
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(foreign);
    await rm(lockPath);

    const dead = { ...foreign, pid: 424242, token: "22222222-2222-4222-8222-222222222222" };
    await writeFile(lockPath, `${JSON.stringify(dead)}\n`, "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation((((pid: number) => {
      if (pid === 424242) {
        const error = new Error("dead") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill));
    const releaseRecovered = await acquireProductionCanaryAgentOperationLease({
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral",
    });
    await releaseRecovered();
    kill.mockRestore();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(CANARY_ISOLATION_RECEIPT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("lets only one of three independent contenders retire the same dead lane lease", async () => {
    const input = await fixture();
    const prepared = await prepareProductionCanaryPair(input);
    const laneRoot = join(input.projectRoot, prepared.lanes.neutral.projectRoot);
    const lockPath = join(input.projectRoot, ".inkos", "canaries", input.pairId, ".agent-neutral.lock");
    const dead = {
      schemaVersion: "inkos-canary-lease/v1",
      kind: "agent-operation",
      pairId: input.pairId,
      lane: "neutral",
      pid: 424244,
      token: "44444444-4444-4444-8444-444444444444",
      startedAt: NOW.toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(dead)}\n`, "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation((((pid: number) => {
      if (pid === 424244) {
        const error = new Error("dead") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill));
    type LeaseModule = typeof import("../production/canary-isolation.js");
    const sourceUrl = new URL("../production/canary-isolation.ts", import.meta.url);
    const modules = await Promise.all([0, 1, 2].map(async (index) => import(
      /* @vite-ignore */ `${sourceUrl.href}?lease-race=${index}-${randomUUID()}`
    ) as Promise<LeaseModule>));
    const attempts = await Promise.allSettled(modules.map((module) => module.acquireProductionCanaryAgentOperationLease({
      projectRoot: laneRoot,
      pairId: input.pairId,
      lane: "neutral",
    })));
    const acquired = attempts.filter((attempt): attempt is PromiseFulfilledResult<() => Promise<void>> => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected.every((attempt) => /already running|recovery/i.test(String(attempt.reason)))).toBe(true);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).not.toMatchObject({ token: dead.token });
    await acquired[0].value();
    kill.mockRestore();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${lockPath}.recovery`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers only a dead owned prepare lease before creating the pair", async () => {
    const input = await fixture();
    const canariesRoot = join(input.projectRoot, ".inkos", "canaries");
    await mkdir(canariesRoot, { recursive: true });
    const lockPath = join(canariesRoot, `.${input.pairId}.prepare.lock`);
    const dead = {
      schemaVersion: "inkos-canary-lease/v1",
      kind: "prepare",
      pairId: input.pairId,
      lane: null,
      pid: 424243,
      token: "33333333-3333-4333-8333-333333333333",
      startedAt: NOW.toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(dead)}\n`, "utf8");
    const kill = vi.spyOn(process, "kill").mockImplementation((((pid: number) => {
      if (pid === 424243) {
        const error = new Error("dead") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }) as typeof process.kill));
    await expect(prepareProductionCanaryPair(input)).resolves.toMatchObject({ replayed: false });
    kill.mockRestore();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
