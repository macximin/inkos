import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PipelineRunner,
  createWriteNextProductionCommandV2,
  directionTextSha256,
  hashCanonicalJson,
  parsePersistedProductionCommand,
  resolveModelMediatedTaskGuidance,
  type OwnerDirectionReference,
  type ProductionAuthorizationEvidenceV2,
} from "../index.js";
import { appendTranscriptEvents } from "../interaction/session-transcript.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ownerDirection(): OwnerDirectionReference {
  const textSha256 = "a".repeat(64);
  return {
    source: "owner-confirmed",
    receiptId: "owner-decision",
    sourceRef: {
      kind: "detached-payload-lease",
      leaseId: "00000000-0000-4000-8000-000000000001",
      payloadSha256: textSha256,
      byteLength: 12,
      expiresAt: "2099-01-01T00:00:00.000Z",
      leaseReceiptSha256: "b".repeat(64),
    },
    textSha256,
  };
}

const cases: ReadonlyArray<{
  source: "studio" | "cli" | "tui" | "agent" | "hq";
  authorization: ProductionAuthorizationEvidenceV2;
  workOrderId?: string;
}> = [
  { source: "studio", authorization: { kind: "confirmed-ui", actionEnvelopeSha256: "c".repeat(64), confirmationReceiptSha256: "d".repeat(64) } },
  { source: "cli", authorization: { kind: "confirmed-cli", typedCommandPreviewSha256: "c".repeat(64), confirmationReceiptSha256: "d".repeat(64) } },
  { source: "tui", authorization: { kind: "confirmed-cli", typedCommandPreviewSha256: "c".repeat(64), confirmationReceiptSha256: "d".repeat(64) } },
  { source: "agent", authorization: { kind: "confirmed-agent-tool", sessionRequestId: "request-1", proposalReceiptSha256: "c".repeat(64), confirmationReceiptSha256: "d".repeat(64), toolArgsSha256: "e".repeat(64) } },
  { source: "hq", workOrderId: "wo-1", authorization: { kind: "authenticated-orchestrator", workOrderId: "wo-1", workOrderSha256: "c".repeat(64), manifestCapabilitySha256: "d".repeat(64), ownerDecisionReceiptSha256: "e".repeat(64) } },
];

describe("Phase-5 ProductionCommand v2", () => {
  it.each(cases)("accepts strict $source authorization", ({ source, authorization, workOrderId }) => {
    const command = createWriteNextProductionCommandV2({
      idempotencyKey: `idem-${source}`,
      source,
      binding: { bookId: "demo", sessionId: "session-1", requestId: "request-1", ...(workOrderId ? { workOrderId } : {}) },
      ownerDirection: ownerDirection(),
      authorization,
      commandId: "00000000-0000-4000-8000-000000000002",
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    expect(parsePersistedProductionCommand(command)).toEqual(command);
    expect(command.authorization.argsSha256).toBe(hashCanonicalJson(command.args));
  });

  it("rejects source-kind, exact args, and orchestrator binding drift", () => {
    const command = createWriteNextProductionCommandV2({
      idempotencyKey: "idem-hq",
      source: "hq",
      binding: { bookId: "demo", sessionId: "session-1", requestId: "request-1", workOrderId: "wo-1" },
      ownerDirection: ownerDirection(),
      authorization: cases[4]!.authorization,
    });
    expect(() => parsePersistedProductionCommand({ ...command, source: "studio" })).toThrow();
    expect(() => parsePersistedProductionCommand({ ...command, args: { ...command.args, targetLength: { count: 1, unit: "words" } } })).toThrow();
    expect(() => parsePersistedProductionCommand({ ...command, binding: { ...command.binding, workOrderId: "wo-2" } })).toThrow();
  });

  it("binds Hermes task guidance to the exact safe Book and WorkOrder", () => {
    const taskGuidance = {
      source: "hermes-control-action" as const,
      bookId: "demo",
      workOrderId: "wo-1",
      actionRef: {
        path: "story/runtime/hermes-control/wo-1/action.json",
        sha256: "f".repeat(64),
        byteLength: 123,
      },
      textSha256: "9".repeat(64),
    };
    expect(() => createWriteNextProductionCommandV2({
      idempotencyKey: "idem-hermes-mismatch",
      source: "hq",
      binding: { bookId: "other", sessionId: "session-1", requestId: "request-1", workOrderId: "wo-1" },
      ownerDirection: ownerDirection(),
      taskGuidance,
      authorization: cases[4]!.authorization,
    })).toThrow(/task guidance bookId/i);
    expect(() => createWriteNextProductionCommandV2({
      idempotencyKey: "idem-hermes-traversal",
      source: "hq",
      binding: { bookId: "demo", sessionId: "session-1", requestId: "request-1", workOrderId: "wo-1" },
      ownerDirection: ownerDirection(),
      taskGuidance: { ...taskGuidance, bookId: "../demo" },
      authorization: cases[4]!.authorization,
    })).toThrow(/safe path segment/i);
  });

  it("keeps V2 retry identity stable across detached owner lease rotation", () => {
    const firstOwner = ownerDirection();
    const secondOwner: OwnerDirectionReference = {
      ...firstOwner,
      sourceRef: {
        ...firstOwner.sourceRef,
        leaseId: "00000000-0000-4000-8000-000000000099",
        expiresAt: "2099-02-01T00:00:00.000Z",
        leaseReceiptSha256: "f".repeat(64),
      },
    };
    const create = (owner: OwnerDirectionReference) => createWriteNextProductionCommandV2({
      idempotencyKey: "idem-stable-lease",
      source: "hq",
      binding: { bookId: "demo", sessionId: "session-1", requestId: "request-1", workOrderId: "wo-1" },
      ownerDirection: owner,
      authorization: cases[4]!.authorization,
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    expect(create(secondOwner).intentDigest).toBe(create(firstOwner).intentDigest);
    expect(create({
      ...firstOwner,
      receiptId: "different-owner-decision",
    }).intentDigest).not.toBe(create(firstOwner).intentDigest);
  });

  it("fails closed on direct writer entry while the surface gateway is active", async () => {
    const runner = new PipelineRunner({
      projectRoot: "/nonexistent-phase5",
      model: "test-model",
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: { temperature: 0, maxTokens: 1, thinkingBudget: 0, extra: {} },
      },
      surfaceGatewayMode: "kernel",
      productionKernelMode: "observe",
    });
    await expect(runner.writeNextChapter("demo")).rejects.toThrow("Direct writeNextChapter is disabled");
    await expect(runner.executeSurfaceWriteNext({
      source: "studio",
      idempotencyKey: "unsafe-book",
      bookId: "../escape",
      sessionId: "session-1",
      requestId: "request-1",
      ownerDirection: ownerDirection(),
      authorization: cases[0]!.authorization,
    })).rejects.toThrow('Invalid bookId: "../escape"');
  });
});

describe("model-mediated task guidance", () => {
  it("resolves exactly one transcript tool call and rejects hash drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-phase5-guidance-"));
    roots.push(root);
    const sessionId = "session-1";
    const requestId = "request-1";
    const toolCallId = "tool-1";
    const instruction = "주인공이 계약서의 함정을 역이용하게 써.";
    await appendTranscriptEvents(root, sessionId, () => [{
      type: "session_created",
      version: 1,
      sessionId,
      seq: 1,
      timestamp: 1,
      bookId: "demo",
      sessionKind: "book",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    }, {
      type: "request_started",
      version: 1,
      sessionId,
      requestId,
      seq: 2,
      timestamp: 2,
      sessionKind: "book",
      input: "다음 화",
    }, {
      type: "message",
      version: 1,
      sessionId,
      requestId,
      seq: 3,
      timestamp: 3,
      uuid: "message-1",
      parentUuid: null,
      role: "assistant",
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "sub_agent", arguments: { agent: "writer", instruction } }] },
    }]);
    const reference = {
      source: "model-mediated" as const,
      transcriptRef: { sessionId, requestId, toolCallId },
      textSha256: directionTextSha256(instruction),
    };
    await expect(resolveModelMediatedTaskGuidance({ projectRoot: root, reference })).resolves.toEqual({ ...reference, text: instruction });
    await expect(resolveModelMediatedTaskGuidance({ projectRoot: root, reference: { ...reference, textSha256: "f".repeat(64) } })).rejects.toThrow("no longer match");
  });
});
