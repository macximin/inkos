import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { directionTextSha256, hashCanonicalJson, PipelineRunner } from "@actalk/inkos-core";
import {
  assertAgentOperatePipelineRuntime,
  assertAgentOperateWriterRuntime,
  parseAgentOperationIpcEnvelope,
  parseAgentWorkOrderV2,
} from "../commands/production.js";
import { buildPipelineConfig, loadConfigWithDiagnostics } from "../utils.js";

function agentWorkOrder() {
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
    isolationReceiptSha256: "d".repeat(64),
  };
  const bookId = "neutral-canary";
  const expectedSoulBinding = null;
  const sessionId = `hq-agent-${hashCanonicalJson({
    v: 1,
    bookId,
    lane: modeEvidence.lane,
    profileId: modeEvidence.profileId,
    soulId: modeEvidence.soulId,
    soulVersion: modeEvidence.soulVersion,
    bindingSha256: null,
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
    runtime: { hermesProfile: modeEvidence.profileId, model: "gpt-5.6-sol", reasoning: "high" },
    approvalMode: "human" as const,
    approvedInputs: [{
      repo: "firefly_studio",
      commit: "1".repeat(40),
      path: "adoptions/canaries/neutral-isolation.json",
      sha256: modeEvidence.isolationReceiptSha256,
      role: "promotion-canary-isolation",
    }],
    privateInputs: [],
    requestedAt: "2026-09-02T00:00:00.000Z",
    timeoutMs: 600000,
    executionMode: "promotion-canary" as const,
    modeEvidence,
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
  it("keeps terra as the project default while a global sol override governs the InkOS writer", async () => {
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
            models: ["gpt-5.6-terra", "gpt-5.6-sol"],
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
        cli: { service: "codex", model: "gpt-5.6-sol" },
      });
      const writer = new PipelineRunner(buildPipelineConfig(effective.config, projectRoot, { quiet: true }))
        .createAgentContext("writer", "contract-probe");
      expect(writer.model).toBe("gpt-5.6-sol");
      expect(writer.reasoningEffort).toBe("high");
      expect(() => assertAgentOperateWriterRuntime(writer)).not.toThrow();
      expect(() => assertAgentOperateWriterRuntime({ ...writer, model: "gpt-5.6-terra" }))
        .toThrow(/gpt-5\.6-sol\/high/i);
      expect(() => assertAgentOperatePipelineRuntime({
        createAgentContext: (role: string) => ({
          ...writer,
          model: role === "auditor" ? "gpt-5.6-terra" : writer.model,
        }),
      }, "contract-probe")).toThrow(/auditor runtime gpt-5\.6-sol\/high/i);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("accepts the deterministic neutral canary contract", () => {
    expect(parseAgentWorkOrderV2(agentWorkOrder())).toEqual(agentWorkOrder());
  });

  it("rejects session, isolation, and lane/mode drift", () => {
    const workOrder = agentWorkOrder();
    expect(() => parseAgentWorkOrderV2({ ...workOrder, sessionId: "hq-agent-wrong" })).toThrow(/deterministic/i);
    const { isolationReceiptSha256: _isolation, ...withoutIsolation } = workOrder.modeEvidence;
    expect(() => parseAgentWorkOrderV2({ ...workOrder, modeEvidence: withoutIsolation })).toThrow(/isolation/i);
    expect(() => parseAgentWorkOrderV2({ ...workOrder, executionMode: "production" })).toThrow(/production mode/i);
  });

  it("decodes only exact canonical base64 artifacts", () => {
    const workOrderBytes = Buffer.from(`${JSON.stringify(agentWorkOrder())}\n`, "utf8");
    const actionBytes = Buffer.from('{"schemaVersion":"hermes-control-action/v1"}\n', "utf8");
    const receiptBytes = Buffer.from('{"schemaVersion":"hermes-invocation-receipt/v1"}\n', "utf8");
    const envelope = {
      schemaVersion: "inkos-agent-operation-request/v1",
      workOrder: artifact(workOrderBytes),
      hermesAction: { ...artifact(actionBytes), textSha256: "e".repeat(64) },
      hermesReceipt: artifact(receiptBytes),
    };
    expect(parseAgentOperationIpcEnvelope(envelope).workOrderBytes).toEqual(workOrderBytes);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      workOrder: { ...envelope.workOrder, unexpected: true },
    })).toThrow(/strict/i);
    expect(() => parseAgentOperationIpcEnvelope({
      ...envelope,
      hermesAction: { ...envelope.hermesAction, bytes: `${envelope.hermesAction.bytes}\n` },
    })).toThrow(/base64/i);
  });
});
