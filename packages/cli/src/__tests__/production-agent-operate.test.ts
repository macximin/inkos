import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { directionTextSha256, hashCanonicalJson, PipelineRunner } from "@actalk/inkos-core";
import {
  assertAgentOperatePipelineRuntime,
  assertAgentOperateWriterRuntime,
  assertBoundProductionRuntime,
  parseAgentOperationIpcEnvelope,
  parseAgentWorkOrderV2,
} from "../commands/production.js";
import { buildPipelineConfig, loadConfigWithDiagnostics } from "../utils.js";

function agentWorkOrder(model: "gpt-5.6-sol" | "gpt-6-astra" = "gpt-5.6-sol") {
  const instruction = "다음 화에서 즉시 성취 보상을 보여 줘.";
  const modeEvidence = {
    lane: "neutral-baseline" as const,
    profileId: "neutral-baseline-ko",
    profileConfigSha256: "a".repeat(64),
    profileLifecycle: "baseline" as const,
    productionEnabled: false,
    adoptionRegistrySha256: "b".repeat(64),
    activeMatchingCount: 0 as const,
    soulId: "neutral-baseline-ko",
    soulVersion: "v1",
    soulSha256: "c".repeat(64),
    promotionDecisionSha256: null,
    canaryIsolation: {
      pairId: "pair-neutral-1",
      path: ".inkos/canaries/pair-neutral-1/common-snapshot.json",
      sha256: "d".repeat(64),
      byteLength: 4096,
      receiptSelfHash: "e".repeat(64),
      isolationScopeSha256: "f".repeat(64),
      commonSnapshotSha256: "0".repeat(64),
    },
  };
  const bookId = "neutral-canary";
  const expectedSoulBinding = null;
  const runtime = { hermesProfile: modeEvidence.profileId, model, reasoning: "high" };
  const sessionId = `hq-agent-${hashCanonicalJson({
    v: model === "gpt-6-astra" ? 2 : 1,
    bookId,
    lane: modeEvidence.lane,
    profileId: modeEvidence.profileId,
    soulId: modeEvidence.soulId,
    soulVersion: modeEvidence.soulVersion,
    bindingSha256: null,
    isolationScopeSha256: modeEvidence.canaryIsolation.isolationScopeSha256,
    ...(model === "gpt-6-astra" ? { runtime, profileConfigSha256: modeEvidence.profileConfigSha256 } : {}),
  }).slice(0, 40)}`;
  const args = { chapterCount: 1 as const, targetLength: { count: 1800, unit: "ko-chars" as const } };
  const instructionSha256 = directionTextSha256(instruction);
  const argsSha256 = hashCanonicalJson({
    capability: "agent-operate",
    bookId,
    sessionId,
    args,
    expectedSoulBinding,
    executionMode: "promotion-canary",
    modeEvidence,
    instructionSha256,
  });
  return {
    schemaVersion: 2 as const,
    workOrderId: "wo-neutral-1",
    idempotencyKey: "idem-neutral-1",
    repo: "inkos" as const,
    capability: "agent-operate" as const,
    bookId,
    sessionId,
    instruction,
    args,
    expectedSoulBinding,
    ownerDecision: {
      receiptId: "owner-neutral-1",
      status: "approved" as const,
      instructionSha256,
      argsSha256,
      decidedAt: "2026-09-02T00:00:00.000Z",
    },
    runtime,
    approvalMode: "human" as const,
    approvedInputs: [],
    privateInputs: [],
    requestedAt: "2026-09-02T00:00:00.000Z",
    timeoutMs: 600000,
    executionMode: "promotion-canary" as const,
    modeEvidence,
  };
}

function productionWorkOrder() {
  const base = agentWorkOrder();
  const modeEvidence = {
    lane: "genre-soul" as const,
    profileId: "male-modern-fantasy-ko",
    profileConfigSha256: "1".repeat(64),
    profileLifecycle: "promoted" as const,
    productionEnabled: true,
    adoptionRegistrySha256: "2".repeat(64),
    activeMatchingCount: 1 as const,
    soulId: "male-modern-fantasy-ko",
    soulVersion: "v1",
    soulSha256: "3".repeat(64),
    promotionDecisionSha256: "4".repeat(64),
  };
  const expectedSoulBinding = {
    soulId: modeEvidence.soulId,
    soulVersion: modeEvidence.soulVersion,
    bindingSha256: "5".repeat(64),
  };
  const sessionId = `hq-agent-${hashCanonicalJson({
    v: 1,
    bookId: base.bookId,
    lane: modeEvidence.lane,
    profileId: modeEvidence.profileId,
    soulId: modeEvidence.soulId,
    soulVersion: modeEvidence.soulVersion,
    bindingSha256: expectedSoulBinding.bindingSha256,
    isolationScopeSha256: null,
  }).slice(0, 40)}`;
  const ownerDecision = {
    ...base.ownerDecision,
    argsSha256: hashCanonicalJson({
      capability: "agent-operate",
      bookId: base.bookId,
      sessionId,
      args: base.args,
      expectedSoulBinding,
      executionMode: "production",
      modeEvidence,
      instructionSha256: base.ownerDecision.instructionSha256,
    }),
  };
  return {
    ...base,
    sessionId,
    expectedSoulBinding,
    ownerDecision,
    runtime: { ...base.runtime, hermesProfile: modeEvidence.profileId },
    executionMode: "production" as const,
    modeEvidence,
  };
}

function withBookId(bookId: string) {
  const base = agentWorkOrder();
  const sessionId = `hq-agent-${hashCanonicalJson({
    v: 1,
    bookId,
    lane: base.modeEvidence.lane,
    profileId: base.modeEvidence.profileId,
    soulId: base.modeEvidence.soulId,
    soulVersion: base.modeEvidence.soulVersion,
    bindingSha256: null,
    isolationScopeSha256: base.modeEvidence.canaryIsolation.isolationScopeSha256,
  }).slice(0, 40)}`;
  return {
    ...base,
    bookId,
    sessionId,
    ownerDecision: {
      ...base.ownerDecision,
      argsSha256: hashCanonicalJson({
        capability: "agent-operate",
        bookId,
        sessionId,
        args: base.args,
        expectedSoulBinding: base.expectedSoulBinding,
        executionMode: base.executionMode,
        modeEvidence: base.modeEvidence,
        instructionSha256: base.ownerDecision.instructionSha256,
      }),
    },
  };
}

function artifact(bytes: Buffer) {
  return {
    encoding: "base64" as const,
    bytes: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

describe("production agent-operate strict ingress", () => {
  it.each(["gpt-5.6-sol", "gpt-6-astra"])("resolves an explicit %s override but only executes the current Firefly model", async (model) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "inkos-agent-operate-config-"));
    try {
      await writeFile(join(projectRoot, "inkos.json"), JSON.stringify({
        name: "agent-operate-config-probe",
        version: "0.1.0",
        language: "ko",
        llm: {
          provider: "openai",
          service: "codex",
          configSource: "studio",
          baseUrl: "http://127.0.0.1/codex-subscription",
          model: "gpt-5.6-terra",
          apiFormat: "responses",
          stream: false,
          services: [{
            service: "codex",
            models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"],
            temperature: 0.7,
            apiFormat: "responses",
            stream: false,
          }],
          defaultModel: "gpt-5.6-terra",
          temperature: 0.7,
          extra: { codexReasoningEffort: "high" },
        },
        notify: [],
        inputGovernanceMode: "v2",
      }), "utf8");
      const defaultConfig = await loadConfigWithDiagnostics({ projectRoot, cli: { service: "codex" } });
      expect(defaultConfig.config.llm.model).toBe("gpt-5.6-terra");

      const effective = await loadConfigWithDiagnostics({
        projectRoot,
        cli: { service: "codex", model },
      });
      const writer = new PipelineRunner(buildPipelineConfig(effective.config, projectRoot, { quiet: true }))
        .createAgentContext("writer", "contract-probe");
      expect(writer.model).toBe(model);
      expect(writer.reasoningEffort).toBe("high");
      if (model === "gpt-5.6-sol") {
        expect(() => assertAgentOperateWriterRuntime(writer)).toThrow(/gpt-6-astra\/high/i);
        return;
      }
      expect(() => assertAgentOperateWriterRuntime(writer)).not.toThrow();
      expect(() => assertAgentOperateWriterRuntime({ ...writer, model: "gpt-5.6-terra" }))
        .toThrow(/gpt-6-astra\/high/i);
      expect(() => assertAgentOperatePipelineRuntime({
        createAgentContext: (role: string) => ({
          ...writer,
          model: role === "auditor" ? "gpt-5.6-terra" : writer.model,
        }),
      }, "contract-probe")).toThrow(/auditor runtime gpt-6-astra\/high/i);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("accepts the deterministic neutral canary contract", () => {
    expect(agentWorkOrder().sessionId).toBe("hq-agent-2214ce47dfd0eba6202c3c6b657ff759c1fc5882");
    expect(parseAgentWorkOrderV2(agentWorkOrder())).toEqual(agentWorkOrder());
    expect(parseAgentWorkOrderV2(productionWorkOrder())).toEqual(productionWorkOrder());
  });

  it("isolates Astra sessions from legacy Sol and binds the current runtime and profile bytes", () => {
    const current = agentWorkOrder("gpt-6-astra");
    expect(parseAgentWorkOrderV2(current)).toEqual(current);
    expect(current.sessionId).not.toBe(agentWorkOrder().sessionId);
    expect(() => parseAgentWorkOrderV2({ ...current, runtime: { ...current.runtime, model: "gpt-5.6-sol" } })).toThrow(/deterministic/i);
    expect(() => parseAgentWorkOrderV2({ ...current, runtime: { ...current.runtime, reasoning: "medium" } })).toThrow(/deterministic/i);
    expect(() => parseAgentWorkOrderV2({ ...current, modeEvidence: { ...current.modeEvidence, profileConfigSha256: "0".repeat(64) } })).toThrow(/deterministic/i);
  });

  it("rejects a requested model or reasoning different from the effective runtime", () => {
    const requested = { model: "gpt-6-astra", reasoning: "high" };
    expect(() => assertBoundProductionRuntime(requested, { model: "gpt-6-astra", reasoningEffort: "high" })).not.toThrow();
    expect(() => assertBoundProductionRuntime(requested, { model: "gpt-5.6-sol", reasoningEffort: "high" })).toThrow(/differs/);
    expect(() => assertBoundProductionRuntime(requested, { model: "gpt-6-astra", reasoningEffort: "medium" })).toThrow(/differs/);
    expect(() => assertBoundProductionRuntime({ model: "gpt-5.6-sol", reasoning: "high" }, { model: "gpt-5.6-sol", reasoningEffort: "high" })).not.toThrow();
  });

  it("rejects session, isolation, and lane/mode drift", () => {
    const workOrder = agentWorkOrder();
    expect(() => parseAgentWorkOrderV2({ ...workOrder, sessionId: "hq-agent-wrong" })).toThrow(/deterministic/i);
    const { canaryIsolation: _isolation, ...withoutIsolation } = workOrder.modeEvidence;
    expect(() => parseAgentWorkOrderV2({ ...workOrder, modeEvidence: withoutIsolation })).toThrow(/isolation/i);
    expect(() => parseAgentWorkOrderV2({
      ...workOrder,
      modeEvidence: { ...workOrder.modeEvidence, isolationReceiptSha256: "d".repeat(64) },
    })).toThrow(/unknown field/i);
    expect(() => parseAgentWorkOrderV2({
      ...workOrder,
      approvedInputs: [{ role: "promotion-canary-isolation" }],
    })).toThrow(/approvedInputs/i);
    expect(() => parseAgentWorkOrderV2({
      ...workOrder,
      modeEvidence: {
        ...workOrder.modeEvidence,
        canaryIsolation: { ...workOrder.modeEvidence.canaryIsolation, path: "wrong.json" },
      },
    })).toThrow(/canaryIsolation/i);
    expect(() => parseAgentWorkOrderV2({ ...workOrder, executionMode: "production" })).toThrow(/production mode/i);
    for (const bookId of [" book", "book..id", "book:id", "book\u0001id", "x".repeat(121)]) {
      expect(() => parseAgentWorkOrderV2(withBookId(bookId))).toThrow(/bookId.*safe path segment/i);
    }
    expect(() => parseAgentWorkOrderV2({
      ...workOrder,
      modeEvidence: {
        ...workOrder.modeEvidence,
        canaryIsolation: {
          ...workOrder.modeEvidence.canaryIsolation,
          byteLength: 10 * 1024 * 1024 + 1,
        },
      },
    })).toThrow(/canaryIsolation/i);
    const production = productionWorkOrder();
    expect(() => parseAgentWorkOrderV2({
      ...production,
      modeEvidence: { ...production.modeEvidence, canaryIsolation: workOrder.modeEvidence.canaryIsolation },
    })).toThrow(/forbids canaryIsolation/i);
  });

  it("decodes only exact canonical base64 artifacts", () => {
    const workOrderBytes = Buffer.from(`${JSON.stringify(agentWorkOrder())}\n`, "utf8");
    const actionBytes = Buffer.from('{"schemaVersion":"hermes-control-action/v1"}\n', "utf8");
    const receiptBytes = Buffer.from('{"schemaVersion":"hermes-invocation-receipt/v1"}\n', "utf8");
    const canaryReceiptBytes = Buffer.from('{"schemaVersion":"inkos-canary-common-snapshot/v1"}\n', "utf8");
    const envelope = {
      schemaVersion: "inkos-agent-operation-request/v1",
      workOrder: artifact(workOrderBytes),
      hermesAction: { ...artifact(actionBytes), textSha256: "e".repeat(64) },
      hermesReceipt: artifact(receiptBytes),
      canaryIsolationReceipt: { ...artifact(canaryReceiptBytes), selfHash: "f".repeat(64) },
    };
    const parsed = parseAgentOperationIpcEnvelope(envelope);
    expect(parsed.workOrderBytes).toEqual(workOrderBytes);
    expect(parsed.canaryIsolationReceiptBytes).toEqual(canaryReceiptBytes);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      workOrder: { ...envelope.workOrder, unexpected: true },
    })).toThrow(/strict/i);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      hermesAction: { ...envelope.hermesAction, bytes: `${envelope.hermesAction.bytes}\n` },
    })).toThrow(/base64/i);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      canaryIsolationReceipt: { ...envelope.canaryIsolationReceipt, byteLength: canaryReceiptBytes.byteLength + 1 },
    })).toThrow(/hash\/length/i);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      canaryIsolationReceipt: { ...envelope.canaryIsolationReceipt, selfHash: "wrong" },
    })).toThrow(/selfHash/i);
  });
});
