import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadTerminal: vi.fn() }));
vi.mock("../production/hermes-control-operation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../production/hermes-control-operation.js")>();
  return { ...actual, loadAgentOperationTerminal: mocks.loadTerminal };
});

import { StateManager } from "../state/manager.js";
import { hashCanonicalJson } from "../production/fiction-content-contract.js";
import {
  acknowledgeStoryyardEvaluation,
  blindPairMappingRelativePath,
  materializeBlindPair,
  prepareBlindPair,
  storyyardEvaluationAckRelativePath,
  type BlindPairEvaluationTransfer,
} from "../storyyard/blind-pair-materialization.js";

const roots: string[] = [];
const NOW = "2026-09-02T12:00:00.000Z";
const BOOK_ID = "blind-book";
const PAIR_ID = "source-pair-001";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

async function writeJson(path: string, value: unknown): Promise<Buffer> {
  const bytes = jsonBytes(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

function selfHashed<T extends Record<string, unknown>>(unsigned: T): T & { receiptSelfHash: string } {
  return { ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) };
}

interface PairFixture {
  readonly root: string;
  readonly terminals: Record<"neutral" | "soul", Record<string, unknown>>;
  readonly bodies: Record<"neutral" | "soul", string>;
  readonly artifactPaths: Record<"neutral" | "soul", string>;
}

async function pairFixture(options: { sameBody?: boolean; terminalPairId?: string } = {}): Promise<PairFixture> {
  const root = await mkdtemp(join(tmpdir(), "inkos-blind-pair-"));
  roots.push(root);
  await mkdir(join(root, "books"), { recursive: true });
  const state = new StateManager(root);
  await state.saveBookConfig(BOOK_ID, {
    id: BOOK_ID,
    title: "블라인드 카나리",
    platform: "other",
    genre: "modern-fantasy-ko",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const bodies = {
    neutral: "중립 후보는 계약서를 뒤집고 바로 회사를 샀다.",
    soul: options.sameBody ? "중립 후보는 계약서를 뒤집고 바로 회사를 샀다." : "장르 후보는 주가를 꿰뚫고 회사를 통째로 삼켰다.",
  };
  const terminals = {} as Record<"neutral" | "soul", Record<string, unknown>>;
  const artifactPaths = {} as Record<"neutral" | "soul", string>;
  for (const lane of ["neutral", "soul"] as const) {
    const laneRoot = join(root, ".inkos", "canaries", PAIR_ID, lane);
    const bookDir = join(laneRoot, "books", BOOK_ID);
    const workOrderId = lane === "neutral" ? "wo-neutral-001" : "wo-soul-001";
    const sessionId = lane === "neutral" ? "session-neutral" : "session-soul";
    const profileId = lane === "neutral" ? "neutral-baseline-ko" : "male-modern-fantasy-ko";
    const expectedSoulBinding = lane === "neutral" ? null : {
      soulId: "male-modern-fantasy-ko", soulVersion: "v1", bindingSha256: "9".repeat(64),
    };
    const canary = {
      schemaVersion: "inkos-canary-execution-root-verification/v1" as const,
      scopeId: `canary-pair:${options.terminalPairId ?? PAIR_ID}:${BOOK_ID}`,
      pairId: options.terminalPairId ?? PAIR_ID,
      bookId: BOOK_ID,
      lane,
      projectRoot: `.inkos/canaries/${options.terminalPairId ?? PAIR_ID}/${lane}`,
      sourceProjectRootFingerprint: "1".repeat(64),
      sourceBookManifestSha256: "2".repeat(64),
      laneManifestSha256: lane === "neutral" ? "3".repeat(64) : "4".repeat(64),
      receipt: {
        path: `.inkos/canaries/${options.terminalPairId ?? PAIR_ID}/common-snapshot.json`,
        sha256: "5".repeat(64), byteLength: 100, selfHash: "6".repeat(64),
      },
      isolationScopeSha256: "7".repeat(64),
      commonSnapshotSha256: "8".repeat(64),
      expectedSoulBinding,
    };
    const actionPath = `story/runtime/hermes-control/${workOrderId}/action.json`;
    const request = {
      schemaVersion: 2,
      workOrderId,
      repo: "inkos",
      capability: "agent-operate",
      bookId: BOOK_ID,
      sessionId,
      expectedSoulBinding,
      executionMode: "promotion-canary",
      runtime: { hermesProfile: profileId, model: "gpt-5.6-sol", reasoning: "high" },
      modeEvidence: {
        lane: lane === "neutral" ? "neutral-baseline" : "genre-soul",
        profileId,
        soulId: lane === "neutral" ? "neutral-baseline-ko" : expectedSoulBinding!.soulId,
        soulVersion: lane === "neutral" ? "v1" : expectedSoulBinding!.soulVersion,
        canaryIsolation: { pairId: options.terminalPairId ?? PAIR_ID },
      },
    };
    const requestPath = `story/runtime/hermes-control/${workOrderId}/request.json`;
    const requestBytes = await writeJson(join(bookDir, requestPath), request);
    const importPath = `story/runtime/hermes-control/${workOrderId}/import-receipt.json`;
    const hermesPath = `story/runtime/hermes-control/${workOrderId}/hermes-invocation.json`;
    const hermesUnsigned = {
      schemaVersion: "hermes-invocation-receipt/v1" as const,
      status: "completed" as const,
      workOrderId,
      workOrderSha256: sha(requestBytes),
      profile: {
        profileId,
        soulId: request.modeEvidence.soulId,
        soulVersion: request.modeEvidence.soulVersion,
        configSha256: "1".repeat(64),
        soulSha256: "2".repeat(64),
      },
      runtime: {
        provider: "openai-codex" as const, model: "gpt-5.6-sol" as const, reasoning: "high" as const,
        platform: "cli" as const, openaiRuntime: "auto" as const, transport: "codex_responses" as const,
        toolsCount: 0 as const, toolCallCount: 0 as const,
      },
      invocation: { sessionId: `hermes-${lane}`, startedAt: NOW, completedAt: NOW, exitCode: 0 as const },
      promptSha256: "3".repeat(64),
      systemPrompt: { sha256: "4".repeat(64), byteLength: 10 },
      rawOutput: { sha256: "5".repeat(64), byteLength: 10 },
      action: { sha256: "a".repeat(64), byteLength: 10, textSha256: "c".repeat(64) },
      sessionExport: { sha256: "6".repeat(64), byteLength: 10 },
    };
    const hermesReceipt = selfHashed(hermesUnsigned);
    const hermesBytes = await writeJson(join(bookDir, hermesPath), hermesReceipt);
    const importUnsigned = {
      schemaVersion: "hermes-control-import/v2" as const,
      workOrderId,
      workOrderSha256: sha(requestBytes),
      bookId: BOOK_ID,
      sessionId,
      request: { path: requestPath, sha256: sha(requestBytes), byteLength: requestBytes.byteLength },
      action: { path: actionPath, sha256: "a".repeat(64), byteLength: 10 },
      hermesReceipt: { path: hermesPath, sha256: sha(hermesBytes), byteLength: hermesBytes.byteLength },
      taskGuidance: {
        source: "hermes-control-action" as const,
        bookId: BOOK_ID,
        workOrderId,
        actionRef: { path: actionPath, sha256: "a".repeat(64), byteLength: 10 },
        textSha256: "c".repeat(64),
      },
      canaryIsolation: canary,
      importedAt: NOW,
    };
    const importReceipt = selfHashed(importUnsigned);
    const importBytes = await writeJson(join(bookDir, importPath), importReceipt);
    const artifactRelative = "chapters/0001.md";
    const artifactBytes = Buffer.from(bodies[lane], "utf8");
    const artifactAbsolute = join(bookDir, artifactRelative);
    await mkdir(dirname(artifactAbsolute), { recursive: true });
    await writeFile(artifactAbsolute, artifactBytes);
    artifactPaths[lane] = artifactAbsolute;
    const productionOperationId = randomUUID();
    const attemptId = randomUUID();
    const receiptId = randomUUID();
    const chapterPath = `story/runtime/chapter-commits/${productionOperationId}--${receiptId}.json`;
    const chapterUnsigned = {
      schemaVersion: "chapter-commit-receipt/v1" as const,
      receiptId,
      bookId: BOOK_ID,
      chapterNumber: 1,
      capability: "write-next-chapter" as const,
      productionOperationId,
      attemptId,
      fictionOperationIds: [receiptId],
      operationManifests: [{ operationId: receiptId, artifact: { path: `story/runtime/fiction-content-neutral/operations/${receiptId}.json`, sha256: "d".repeat(64) } }],
      chapterArtifact: { path: artifactRelative, sha256: sha(artifactBytes) },
      indexArtifact: { path: "chapters/index.json", sha256: "e".repeat(64) },
      currentStateArtifact: null,
      railTruth: { applicability: "not-applicable" as const, reason: "no-active-rail" as const },
      commitState: "verified" as const,
      committedAt: NOW,
    };
    const chapter = selfHashed(chapterUnsigned);
    const chapterBytes = await writeJson(join(bookDir, chapterPath), chapter);
    const terminalPath = `story/runtime/hermes-control/${workOrderId}/terminal.json`;
    const runId = randomUUID();
    const terminalUnsigned = {
      schemaVersion: "inkos-agent-operation-terminal/v2" as const,
      status: "succeeded" as const,
      workOrderId,
      workOrderSha256: sha(requestBytes),
      bookId: BOOK_ID,
      sessionId,
      executionMode: "promotion-canary" as const,
      canaryIsolation: canary,
      finalLaneManifestSha256: "f".repeat(64),
      importReceipt: { path: importPath, sha256: sha(importBytes), byteLength: importBytes.byteLength },
      productionRun: {
        path: `story/runtime/production-runs/terminals/${runId}.json`, sha256: "0".repeat(64), byteLength: 10,
        commandId: runId, productionOperationId, attemptId,
      },
      completedAt: NOW,
      chapterCommit: {
        path: chapterPath, sha256: sha(chapterBytes), byteLength: chapterBytes.byteLength,
        receiptId, receiptSelfHash: chapter.receiptSelfHash,
      },
    };
    const terminal = selfHashed(terminalUnsigned);
    await writeJson(join(bookDir, terminalPath), terminal);
    terminals[lane] = terminal;
  }
  mocks.loadTerminal.mockImplementation(async ({ projectRoot }: { projectRoot: string }) =>
    projectRoot.endsWith("/neutral") ? terminals.neutral : terminals.soul);
  return { root, terminals, bodies, artifactPaths };
}

function exactSpan(body: string) {
  const bytes = Buffer.from(body, "utf8");
  const endByte = Buffer.from([...body][0]!, "utf8").byteLength;
  return { coordinateKind: "utf8-byte" as const, startByte: 0, endByte, sliceSha256: sha(bytes.subarray(0, endByte)) };
}

function evaluation(transfer: BlindPairEvaluationTransfer, bodies: Record<"candidate-A" | "candidate-B", string>, canonLeak = false) {
  const candidateEvaluation = (id: "candidate-A" | "candidate-B") => {
    const span = exactSpan(bodies[id]);
    return {
      candidateSha256: transfer.candidates.find((candidate) => candidate.id === id)!.sha256,
      commercialEvaluation: {
        openingPressure: 80, protagonistAgency: 80, resistanceQuality: 80, visiblePayoff: 80,
        endingPropulsion: 80, referenceEngineRetention: 80, transformationIntegrity: 80, styleFidelity: 80,
      },
      commercialScore: 80,
      emotionalCoherence: { score: 80, evidence: [span] },
      contentNeutrality: { passed: true, violations: [] },
      canonContradictions: [],
      canonLeaks: canonLeak && id === "candidate-A" ? [{ code: "canon-leak" as const, evidence: [span] }] : [],
      genreIdentity: {
        worldConstraintEvidence: [span], repeatableVerbEvidence: [span], oppositionFormEvidence: [span],
        rewardStatusCurrencyEvidence: [span], nextEpisodeActionEvidence: [span], pass: true,
      },
    };
  };
  return {
    schemaVersion: "firefly-blind-pair-evaluator-result/v2",
    pairId: transfer.pairId,
    round: transfer.round,
    blindRunId: transfer.blindRunId,
    pairedGenerationReceiptSha256: transfer.pairedGenerationReceiptSha256,
    winner: "candidate-A",
    rankingReason: "첫 후보의 상업적 압력이 더 선명함.",
    evaluations: { "candidate-A": candidateEvaluation("candidate-A"), "candidate-B": candidateEvaluation("candidate-B") },
    humanDecision: "pending",
    authority: { scope: "analysis-only", mayWriteInkOSCanon: false, mayPromoteSoul: false, ownerDecisionRequired: true },
  };
}

function surfaceScan(transfer: BlindPairEvaluationTransfer, id: "candidate-A" | "candidate-B") {
  const candidate = transfer.candidates.find((item) => item.id === id)!;
  const unsigned = {
    schemaVersion: "firefly-blind-pair-surface-scan/v1" as const,
    candidateId: id,
    candidateSha256: candidate.sha256,
    candidateByteLength: candidate.byteLength,
    scanner: { version: "genre-soul-surface-scanner/v1" as const, exactTokenCount: 12 as const, exactByteLength: 120 as const },
    corpus: {
      privateRegistrySha256: sha("registry"), availableSourceCount: 2,
      observedSourceSetSha256: sha("sources"), surfaceIndexSha256: sha(`index-${id}`),
    },
    upstreamScanSha256: sha(`upstream-${id}`),
    status: "completed-no-match" as const,
    matchCount: 0,
    matches: [],
    truncated: false as const,
    automaticRewriteApplied: false as const,
    automaticRejectApplied: false as const,
    humanDecision: "pending" as const,
  };
  return { ...unsigned, receiptSelfHash: sha(jsonBytes(unsigned)) };
}

async function writeRefLabEvidence(
  root: string,
  transfer: BlindPairEvaluationTransfer,
  result: ReturnType<typeof evaluation>,
) {
  const input = {
    schemaVersion: "firefly-blind-pair-evaluation-input/v2",
    genre: "modern-fantasy-ko",
    pairId: transfer.pairId,
    round: transfer.round,
    blindRunId: transfer.blindRunId,
    blindSessionId: transfer.blindSessionId,
    reviewPacket: { path: "exports/review-packet.json", sha256: sha("review-packet"), byteLength: 10 },
    commonContext: transfer.commonContext,
    commonInputReceiptSha256: transfer.commonInputReceiptSha256,
    pairedGenerationReceiptSha256: transfer.pairedGenerationReceiptSha256,
    labelAssignmentReceiptSha256: transfer.labelAssignmentReceiptSha256,
    candidates: transfer.candidates.map(({ id, sha256: candidateSha256, byteLength }) => ({ id, sha256: candidateSha256, byteLength })),
    producerActors: [
      { lane: "neutral", actorId: "producer-neutral", profileId: "producer-neutral-profile", terminalReceiptSha256: sha("neutral-terminal") },
      { lane: "soul", actorId: "producer-soul", profileId: "producer-soul-profile", terminalReceiptSha256: sha("soul-terminal") },
    ],
    reviewer: {
      actorId: "blind-reviewer", profileId: "inkos_blind_evaluator", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high",
      configSha256: "4124e16bc40d28732d1dd02f9f2e8b78127a202313e1ace21021f16fca809f46",
      soulSha256: "5c4cca60c9971312682f7b71cac5d4d61b6f9e2c42d19af99c8fe6daedacd94b",
    },
    contentContract: { id: "fiction-content-neutral-ko/v1", sha256: sha("contract"), intensityDirectiveSha256: sha("directive") },
    authority: { scope: "analysis-only", mayWriteInkOSCanon: false, mayPromoteSoul: false, ownerDecisionRequired: true },
  };
  const inputBytes = await writeJson(join(root, "evidence", "input.json"), input);
  const resultBytes = await writeJson(join(root, "evidence", "result.json"), result);
  const scanA = surfaceScan(transfer, "candidate-A");
  const scanB = surfaceScan(transfer, "candidate-B");
  const scanABytes = await writeJson(join(root, "evidence", "scan-a.json"), scanA);
  const scanBBytes = await writeJson(join(root, "evidence", "scan-b.json"), scanB);
  const hostReceipt = {
    role: "blind-pair-commercial-evaluator",
    runId: "review-run-001",
    profileId: "inkos_blind_evaluator",
    profileConfigSha256: input.reviewer.configSha256,
    soulSha256: input.reviewer.soulSha256,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    inputDigest: sha("sealed-evaluator-input"),
    inputSha256: sha("harness-input"),
    expectedReadCount: 1,
    exactReadCount: 1,
    exactReadSha256s: [sha(inputBytes)],
    resultSha256: sha(resultBytes),
    completedAt: NOW,
  };
  const hostReceiptBytes = await writeJson(join(root, "evidence", "host-receipt.json"), hostReceipt);
  const triple = {
    evaluatorInputSha256: sha(inputBytes), evaluatorResultSha256: sha(resultBytes), hostReceiptSha256: sha(hostReceiptBytes),
  };
  const bindings = Object.fromEntries((["candidate-A", "candidate-B"] as const).map((id, index) => {
    const scan = index === 0 ? scanA : scanB;
    const scanBytes = index === 0 ? scanABytes : scanBBytes;
    const candidateSha256 = transfer.candidates[index]!.sha256;
    return [id, {
      candidateSha256,
      evaluationBindingSha256: sha(jsonBytes({ schemaVersion: "firefly-blind-evaluation-binding/v1", candidateSha256, ...triple, surfaceScanReceiptSha256: sha(scanBytes) })),
      surfaceScanReceiptSha256: sha(scanBytes), surfaceIndexSha256: scan.corpus.surfaceIndexSha256,
      surfaceScanStatus: scan.status, surfaceMatchCount: scan.matchCount,
    }];
  }));
  const unsigned = {
    schemaVersion: "firefly-blind-review-receipt/v2",
    genre: input.genre, pairId: input.pairId, round: input.round, blindRunId: input.blindRunId, blindSessionId: input.blindSessionId,
    sealedInputSha256: sha(inputBytes), commonContextSha256: input.commonContext.sha256, commonContextByteLength: input.commonContext.byteLength,
    evaluatorBinding: { ...triple, tripleBindingSha256: sha(jsonBytes(triple)) }, reviewPacketSha256: input.reviewPacket.sha256,
    commonInputReceiptSha256: input.commonInputReceiptSha256, pairedGenerationReceiptSha256: input.pairedGenerationReceiptSha256,
    labelAssignmentReceiptSha256: input.labelAssignmentReceiptSha256,
    reviewer: { actorId: input.reviewer.actorId, profileId: input.reviewer.profileId, configSha256: input.reviewer.configSha256, soulSha256: input.reviewer.soulSha256, model: "gpt-5.6-sol", reasoning: "high", actorDistinctFromProducers: true, runId: "review-run-001" },
    candidateBindings: bindings,
    outcome: {
      winner: result.winner,
      commercialScores: Object.fromEntries((["candidate-A", "candidate-B"] as const).map((id) => [id, result.evaluations[id].commercialScore])),
      emotionalCoherenceScores: Object.fromEntries((["candidate-A", "candidate-B"] as const).map((id) => [id, result.evaluations[id].emotionalCoherence.score])),
      genreIdentityPassed: Object.fromEntries((["candidate-A", "candidate-B"] as const).map((id) => [id, result.evaluations[id].genreIdentity.pass])),
      contentNeutralViolationCounts: Object.fromEntries((["candidate-A", "candidate-B"] as const).map((id) => [id, result.evaluations[id].contentNeutrality.violations.length])),
      hardContradictionCount: 0, canonLeakCount: Object.values(result.evaluations).reduce((count, value) => count + value.canonLeaks.length, 0), humanDecision: "pending",
    },
    storyyardProjection: { purpose: "promotion-evaluation", actions: ["select", "tie", "invalid"], decisionEffect: "advisory", manuscriptApply: false, canonLeakPolicy: "block-on-nonzero" },
    authority: input.authority, createdAt: NOW,
  };
  await writeJson(join(root, "evidence", "review-receipt.json"), { ...unsigned, receiptSelfHash: sha(jsonBytes(unsigned)) });
}

async function prepareAndEvidence(fixture: PairFixture, canonLeak = false) {
  const prepared = await prepareBlindPair({
    projectRoot: fixture.root,
    pairId: PAIR_ID,
    bookId: BOOK_ID,
    neutralWorkOrderId: "wo-neutral-001",
    soulWorkOrderId: "wo-soul-001",
    commonContextBytes: Buffer.from("동일한 장면 목표와 정본 상태", "utf8"),
    now: () => new Date(NOW),
  });
  const transfer = prepared.transfer.value;
  const mapping = JSON.parse(await readFile(join(fixture.root, ...blindPairMappingRelativePath(PAIR_ID).split("/")), "utf8"));
  const bodies = Object.fromEntries(mapping.mappings.map((item: { candidateId: string; lane: "neutral" | "soul" }) => [item.candidateId, fixture.bodies[item.lane]])) as Record<"candidate-A" | "candidate-B", string>;
  const result = evaluation(transfer, bodies, canonLeak);
  await writeRefLabEvidence(fixture.root, transfer, result);
  return { prepared, transfer, mapping, bodies };
}

afterEach(async () => {
  mocks.loadTerminal.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("blind-pair materialization", () => {
  it("roundtrips exact terminal manuscripts into an opaque, evaluation-only packet and immutable ACK", async () => {
    const fixture = await pairFixture();
    const sourceBookBefore = await readFile(join(fixture.root, "books", BOOK_ID, "book.json"));
    const laneBodiesBefore = await Promise.all(Object.values(fixture.artifactPaths).map((path) => readFile(path)));
    const { prepared, transfer, mapping } = await prepareAndEvidence(fixture);
    const publicJson = JSON.stringify(transfer);
    for (const secret of [PAIR_ID, "wo-neutral-001", "wo-soul-001", "neutral-baseline-ko", "male-modern-fantasy-ko", "session-neutral", "session-soul"]) {
      expect(publicJson).not.toContain(secret);
    }
    expect(mapping.mappings.map((item: { candidateId: string }) => item.candidateId)).toEqual(["candidate-A", "candidate-B"]);
    expect(prepared.mapping.sha256).toBe(transfer.labelAssignmentReceiptSha256);
    expect(transfer.candidates.map((candidate) => candidate.body).sort()).toEqual(Object.values(fixture.bodies).sort());
    for (const candidate of transfer.candidates) {
      expect(Buffer.byteLength(candidate.body, "utf8")).toBe(candidate.byteLength);
      expect(sha(candidate.body)).toBe(candidate.sha256);
    }

    const materialized = await materializeBlindPair({
      projectRoot: fixture.root,
      pairId: PAIR_ID,
      evaluatorInputPath: "evidence/input.json",
      evaluatorResultPath: "evidence/result.json",
      evaluatorHostReceiptPath: "evidence/host-receipt.json",
      reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
      generatedAt: NOW,
    });
    expect(materialized.packet.purpose).toBe("promotion-evaluation");
    expect(materialized.packet.actions).toEqual(["select", "tie", "invalid"]);
    expect(materialized.packet.authority.manuscriptApply).toBe(false);
    expect(materialized.packet.candidates.map((candidate) => candidate.body).sort()).toEqual(Object.values(fixture.bodies).sort());
    for (const secret of [PAIR_ID, "wo-neutral-001", "wo-soul-001", "neutral-baseline-ko", "male-modern-fantasy-ko"]) {
      expect(JSON.stringify(materialized.packet)).not.toContain(secret);
    }
    const decision = {
      schemaVersion: "firefly_review_decision/v2",
      decisionId: "decision-001",
      packetId: materialized.packet.packetId,
      packetSha256: materialized.packet.packetSha256,
      workId: BOOK_ID,
      artifactId: materialized.packet.artifact.id,
      candidateId: "candidate-A",
      candidateSha256: materialized.packet.candidates[0].sha256,
      decision: "select",
      comment: "A 선택",
      purpose: "promotion-evaluation",
      decisionEffect: "advisory",
      manuscriptApply: false,
      surfaceClassifications: [],
      status: "pending",
      createdAt: NOW,
      acknowledgedAt: null,
      ackReceiptPath: null,
    };
    await writeJson(join(fixture.root, "decision.json"), decision);
    const ack = await acknowledgeStoryyardEvaluation({
      projectRoot: fixture.root,
      pairId: PAIR_ID,
      packetPath: materialized.artifact.path,
      decisionPath: "decision.json",
      now: () => new Date("2026-09-02T12:01:00.000Z"),
    });
    expect(ack).toMatchObject({ canonEffect: "none", manuscriptApply: false, status: "acknowledged" });
    expect(ack.ackReceiptPath).toBe(storyyardEvaluationAckRelativePath(PAIR_ID, "decision-001"));
    await expect(acknowledgeStoryyardEvaluation({
      projectRoot: fixture.root, pairId: PAIR_ID, packetPath: materialized.artifact.path,
      decisionPath: "decision.json",
      now: () => new Date("2026-09-02T12:01:00.000Z"),
    })).rejects.toThrow("no-clobber");
    expect(await readFile(join(fixture.root, "books", BOOK_ID, "book.json"))).toEqual(sourceBookBefore);
    const laneBodiesAfter = await Promise.all(Object.values(fixture.artifactPaths).map((path) => readFile(path)));
    expect(laneBodiesAfter).toEqual(laneBodiesBefore);
  });

  it("rejects cross-pair terminals and identical candidates before creating a mapping", async () => {
    const cross = await pairFixture({ terminalPairId: "another-pair" });
    await expect(prepareBlindPair({
      projectRoot: cross.root, pairId: PAIR_ID, bookId: BOOK_ID,
      neutralWorkOrderId: "wo-neutral-001", soulWorkOrderId: "wo-soul-001",
      commonContextBytes: Buffer.from("공통 입력"),
    })).rejects.toThrow(/cross-bound/u);
    const same = await pairFixture({ sameBody: true });
    await expect(prepareBlindPair({
      projectRoot: same.root, pairId: PAIR_ID, bookId: BOOK_ID,
      neutralWorkOrderId: "wo-neutral-001", soulWorkOrderId: "wo-soul-001",
      commonContextBytes: Buffer.from("공통 입력"),
    })).rejects.toThrow("same candidate manuscript");
  });

  it("fails closed on candidate tamper and symlink replacement", async () => {
    const tampered = await pairFixture();
    await prepareAndEvidence(tampered);
    await writeFile(tampered.artifactPaths.neutral, "변조된 원고");
    await expect(materializeBlindPair({
      projectRoot: tampered.root, pairId: PAIR_ID, evaluatorResultPath: "evidence/result.json",
      evaluatorInputPath: "evidence/input.json", evaluatorHostReceiptPath: "evidence/host-receipt.json", reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow(/SHA-256 mismatch|changed after preparation/u);

    const linked = await pairFixture();
    await prepareAndEvidence(linked);
    const outside = join(linked.root, "outside.md");
    await writeFile(outside, linked.bodies.soul);
    await unlink(linked.artifactPaths.soul);
    await symlink(outside, linked.artifactPaths.soul);
    await expect(materializeBlindPair({
      projectRoot: linked.root, pairId: PAIR_ID, evaluatorResultPath: "evidence/result.json",
      evaluatorInputPath: "evidence/input.json", evaluatorHostReceiptPath: "evidence/host-receipt.json", reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow(/symlink/u);
  });

  it("rejects cross-pair evaluator results and duplicate surface candidates", async () => {
    const fixture = await pairFixture();
    const { transfer, bodies } = await prepareAndEvidence(fixture);
    await writeJson(join(fixture.root, "evidence", "result.json"), { ...evaluation(transfer, bodies), pairId: "bp-ffffffffffffffffffffffff" });
    await expect(materializeBlindPair({
      projectRoot: fixture.root, pairId: PAIR_ID, evaluatorResultPath: "evidence/result.json",
      evaluatorInputPath: "evidence/input.json", evaluatorHostReceiptPath: "evidence/host-receipt.json", reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow(/opaque IDs\/digests/u);
    await writeJson(join(fixture.root, "evidence", "result.json"), evaluation(transfer, bodies));
    await writeJson(join(fixture.root, "evidence", "scan-b.json"), surfaceScan(transfer, "candidate-A"));
    await expect(materializeBlindPair({
      projectRoot: fixture.root, pairId: PAIR_ID, evaluatorResultPath: "evidence/result.json",
      evaluatorInputPath: "evidence/input.json", evaluatorHostReceiptPath: "evidence/host-receipt.json", reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow("cover candidate-A and candidate-B");
  });

  it("fails closed when the RefLab evaluator host receipt is missing, drifts, or is a symlink", async () => {
    const missing = await pairFixture();
    await prepareAndEvidence(missing);
    await expect(materializeBlindPair({
      projectRoot: missing.root, pairId: PAIR_ID, evaluatorInputPath: "evidence/input.json",
      evaluatorResultPath: "evidence/result.json", evaluatorHostReceiptPath: "evidence/missing-host-receipt.json",
      reviewReceiptPath: "evidence/review-receipt.json", surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow(/ENOENT/u);

    const drifted = await pairFixture();
    await prepareAndEvidence(drifted);
    const hostReceiptPath = join(drifted.root, "evidence", "host-receipt.json");
    const hostReceipt = JSON.parse(await readFile(hostReceiptPath, "utf8"));
    await writeJson(hostReceiptPath, { ...hostReceipt, completedAt: "2026-09-02T12:01:00.000Z" });
    await expect(materializeBlindPair({
      projectRoot: drifted.root, pairId: PAIR_ID, evaluatorInputPath: "evidence/input.json",
      evaluatorResultPath: "evidence/result.json", evaluatorHostReceiptPath: "evidence/host-receipt.json",
      reviewReceiptPath: "evidence/review-receipt.json", surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow("host receipt does not bind the exact evaluator input/result/review evidence");

    const linked = await pairFixture();
    await prepareAndEvidence(linked);
    const linkedHostReceipt = join(linked.root, "evidence", "host-receipt.json");
    const outside = join(linked.root, "outside-host-receipt.json");
    await writeFile(outside, await readFile(linkedHostReceipt));
    await unlink(linkedHostReceipt);
    await symlink(outside, linkedHostReceipt);
    await expect(materializeBlindPair({
      projectRoot: linked.root, pairId: PAIR_ID, evaluatorInputPath: "evidence/input.json",
      evaluatorResultPath: "evidence/result.json", evaluatorHostReceiptPath: "evidence/host-receipt.json",
      reviewReceiptPath: "evidence/review-receipt.json", surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow(/symlink/u);
  });

  it("blocks Storyyard materialization when Reference Lab reports any canon leak", async () => {
    const fixture = await pairFixture();
    await prepareAndEvidence(fixture, true);
    await expect(materializeBlindPair({
      projectRoot: fixture.root, pairId: PAIR_ID, evaluatorResultPath: "evidence/result.json",
      evaluatorInputPath: "evidence/input.json", evaluatorHostReceiptPath: "evidence/host-receipt.json", reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/scan-a.json", "evidence/scan-b.json"],
    })).rejects.toThrow("reported 1 canon leak");
  });
});
