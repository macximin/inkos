import { Command } from "commander";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PipelineRunner,
  createDetachedOwnerDirectionLease,
  directionTextSha256,
  hashCanonicalJson,
  readProductionModelCallReadback,
  toPosixPath,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfigWithDiagnostics } from "../utils.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_WORK_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const WORK_ORDER_KEYS = new Set([
  "schemaVersion", "workOrderId", "idempotencyKey", "repo", "capability", "bookId", "sessionId",
  "instruction", "args", "expectedSoulBinding", "ownerDecision", "runtime", "approvalMode", "approvedInputs", "privateInputs",
  "requestedAt", "timeoutMs",
]);

type WorkOrderV2 = {
  readonly schemaVersion: 2;
  readonly workOrderId: string;
  readonly idempotencyKey: string;
  readonly repo: "inkos";
  readonly capability: "write-next";
  readonly bookId: string;
  readonly sessionId: string;
  readonly instruction: string;
  readonly args: {
    readonly chapterCount: 1;
    readonly targetLength?: { readonly count: number; readonly unit: "ko-chars" | "zh-chars" | "words" };
  };
  readonly expectedSoulBinding: null | {
    readonly soulId: string;
    readonly soulVersion: string;
    readonly bindingSha256: string;
  };
  readonly ownerDecision: {
    readonly receiptId: string;
    readonly status: "approved";
    readonly instructionSha256: string;
    readonly argsSha256: string;
    readonly decidedAt: string;
  };
  readonly runtime: {
    readonly hermesProfile: string;
    readonly model: string;
    readonly reasoning: string;
  };
  readonly approvalMode: "human";
  readonly approvedInputs: readonly unknown[];
  readonly privateInputs?: readonly unknown[];
  readonly requestedAt: string;
  readonly timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWorkOrderV2(value: unknown): WorkOrderV2 {
  if (!isRecord(value)) throw new Error("WorkOrder v2 must be an object.");
  const unknown = Object.keys(value).filter((key) => !WORK_ORDER_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`WorkOrder v2 has unknown field: ${unknown[0]}`);
  if (value.schemaVersion !== 2 || value.repo !== "inkos" || value.capability !== "write-next") {
    throw new Error("Production adapter only accepts InkOS write-next WorkOrder v2.");
  }
  for (const key of ["workOrderId", "idempotencyKey", "bookId", "sessionId", "instruction"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${key} is required.`);
  }
  if (!SAFE_WORK_ORDER_ID.test(String(value.workOrderId)) || !SAFE_IDEMPOTENCY_KEY.test(String(value.idempotencyKey)) || !SAFE_SESSION_ID.test(String(value.sessionId))) {
    throw new Error("WorkOrder v2 identifiers contain unsafe characters.");
  }
  const bookId = String(value.bookId);
  if (bookId.length > 240 || bookId === "." || bookId === ".." || bookId.includes("/") || bookId.includes("\\") || bookId.includes("\0")) {
    throw new Error("WorkOrder v2 bookId must be one safe path segment.");
  }
  if (!isRecord(value.args) || Object.keys(value.args).some((key) => key !== "chapterCount" && key !== "targetLength")) {
    throw new Error("WorkOrder v2 args must be strict.");
  }
  if (value.args.chapterCount !== 1) throw new Error("write-next WorkOrder v2 requires chapterCount=1.");
  if (value.args.targetLength !== undefined) {
    const target = value.args.targetLength;
    if (!isRecord(target) || Object.keys(target).some((key) => key !== "count" && key !== "unit")) {
      throw new Error("targetLength must be strict.");
    }
    if (!Number.isInteger(target.count) || Number(target.count) < 1 || !["ko-chars", "zh-chars", "words"].includes(String(target.unit))) {
      throw new Error("targetLength is invalid.");
    }
  }
  if (!("expectedSoulBinding" in value)) throw new Error("expectedSoulBinding is required.");
  if (value.expectedSoulBinding !== null) {
    if (!isRecord(value.expectedSoulBinding) || Object.keys(value.expectedSoulBinding).some((key) => !["soulId", "soulVersion", "bindingSha256"].includes(key))) {
      throw new Error("expectedSoulBinding must be null or strict.");
    }
    if (
      typeof value.expectedSoulBinding.soulId !== "string" || !value.expectedSoulBinding.soulId.trim() || value.expectedSoulBinding.soulId.length > 240
      || typeof value.expectedSoulBinding.soulVersion !== "string" || !value.expectedSoulBinding.soulVersion.trim() || value.expectedSoulBinding.soulVersion.length > 240
      || !SHA256.test(String(value.expectedSoulBinding.bindingSha256))
    ) throw new Error("expectedSoulBinding is invalid.");
  }
  if (!isRecord(value.ownerDecision) || Object.keys(value.ownerDecision).some((key) => !["receiptId", "status", "instructionSha256", "argsSha256", "decidedAt"].includes(key))) {
    throw new Error("ownerDecision must be strict.");
  }
  if (typeof value.ownerDecision.receiptId !== "string" || !value.ownerDecision.receiptId.trim() || value.ownerDecision.receiptId.length > 240) {
    throw new Error("ownerDecision.receiptId is invalid.");
  }
  if (value.ownerDecision.status !== "approved" || !SHA256.test(String(value.ownerDecision.instructionSha256)) || !SHA256.test(String(value.ownerDecision.argsSha256))) {
    throw new Error("ownerDecision is not an approved hash-bound decision.");
  }
  if (Number.isNaN(Date.parse(String(value.ownerDecision.decidedAt)))) throw new Error("ownerDecision.decidedAt is invalid.");
  if (!isRecord(value.runtime) || Object.keys(value.runtime).some((key) => !["hermesProfile", "model", "reasoning"].includes(key))) {
    throw new Error("runtime must be strict.");
  }
  for (const key of ["hermesProfile", "model", "reasoning"] as const) {
    if (typeof value.runtime[key] !== "string" || !value.runtime[key].trim()) throw new Error(`runtime.${key} is required.`);
  }
  if (value.approvalMode !== "human" || !Array.isArray(value.approvedInputs) || (value.privateInputs !== undefined && !Array.isArray(value.privateInputs))) {
    throw new Error("WorkOrder v2 approval/input fields are invalid.");
  }
  if (value.approvedInputs.length > 0 || (value.privateInputs?.length ?? 0) > 0) {
    throw new Error("write-next WorkOrder v2 does not accept unbound input arrays.");
  }
  if (typeof value.requestedAt !== "string" || Number.isNaN(Date.parse(value.requestedAt))) throw new Error("requestedAt is invalid.");
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000 || Number(value.timeoutMs) > 3600000)) {
    throw new Error("timeoutMs is invalid.");
  }

  const parsed = value as unknown as WorkOrderV2;
  const instructionSha256 = directionTextSha256(parsed.instruction);
  if (instructionSha256 !== parsed.ownerDecision.instructionSha256) throw new Error("ownerDecision instruction hash mismatch.");
  const exactArgsSha256 = hashCanonicalJson({
    capability: parsed.capability,
    bookId: parsed.bookId,
    sessionId: parsed.sessionId,
    args: parsed.args,
    expectedSoulBinding: parsed.expectedSoulBinding,
    instructionSha256,
  });
  if (exactArgsSha256 !== parsed.ownerDecision.argsSha256) throw new Error("ownerDecision args hash mismatch.");
  return parsed;
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const productionCommand = new Command("production")
  .description("Execute strict host-authenticated production commands");

productionCommand.command("write-next")
  .description("Execute one HQ WorkOrder v2 through the ProductionCommand gateway")
  .requiredOption("--work-order-sha <sha256>")
  .requiredOption("--manifest-capability-sha <sha256>")
  .option("--json", "Emit compact receipt/hash JSON")
  .action(async (opts) => {
    const workOrderBytes = await readStdinBytes();
    if (workOrderBytes.byteLength === 0) throw new Error("WorkOrder v2 bytes are required on stdin.");
    const workOrderSha256 = sha256(workOrderBytes);
    if (!SHA256.test(String(opts.workOrderSha)) || workOrderSha256 !== opts.workOrderSha) {
      throw new Error("WorkOrder v2 byte hash mismatch.");
    }
    if (!SHA256.test(String(opts.manifestCapabilitySha))) throw new Error("Manifest capability hash is invalid.");
    const workOrder = parseWorkOrderV2(JSON.parse(workOrderBytes.toString("utf8")));
    const root = findProjectRoot();
    const effective = await loadConfigWithDiagnostics({ projectRoot: root });
    const pipeline = new PipelineRunner({
      ...buildPipelineConfig(effective.config, root, { quiet: true }),
      surfaceGatewayMode: "kernel",
      productionKernelMode: effective.config.production?.kernel === "enforce" ? "enforce" : "observe",
    });
    const effectiveWriter = pipeline.createAgentContext("writer", workOrder.bookId);
    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot: root,
      receiptId: workOrder.ownerDecision.receiptId,
      text: workOrder.instruction,
    });
    const execution = await pipeline.executeSurfaceWriteNext({
      source: "hq",
      idempotencyKey: workOrder.idempotencyKey,
      bookId: workOrder.bookId,
      sessionId: workOrder.sessionId,
      requestId: workOrder.workOrderId,
      workOrderId: workOrder.workOrderId,
      ownerDirection,
      expectedSoulBinding: workOrder.expectedSoulBinding,
      authorization: {
        kind: "authenticated-orchestrator",
        workOrderId: workOrder.workOrderId,
        workOrderSha256,
        manifestCapabilitySha256: opts.manifestCapabilitySha,
        ownerDecisionReceiptSha256: hashCanonicalJson(workOrder.ownerDecision),
      },
      targetLength: workOrder.args.targetLength,
    });
    const runPath = toPosixPath(join("books", workOrder.bookId, "story", "runtime", "production-runs", "terminals", `${execution.run.command.commandId}.json`));
    const runBytes = await readFile(join(root, runPath));
    const modelCalls = await readProductionModelCallReadback({
      projectRoot: root,
      bookId: workOrder.bookId,
      productionOperationId: execution.run.productionAttempt.productionOperationId,
      attemptId: execution.run.productionAttempt.attemptId,
    }).then((calls) => calls.map((call) => ({
      ...call,
      receiptPath: toPosixPath(join("books", workOrder.bookId, call.receiptPath)),
      outcomePath: toPosixPath(join("books", workOrder.bookId, call.outcomePath)),
    })));
    const inkosReasoning = effectiveWriter.reasoningEffort ?? "none";
    const output = {
      schemaVersion: "inkos-production-result/v2",
      workOrder: { id: workOrder.workOrderId, sha256: workOrderSha256 },
      productionRun: {
        commandId: execution.run.command.commandId,
        productionOperationId: execution.run.productionAttempt.productionOperationId,
        attemptId: execution.run.productionAttempt.attemptId,
        path: runPath,
        sha256: sha256(runBytes),
        executionStatus: execution.run.executionStatus,
        approvalStatus: execution.run.approvalStatus,
        completionHealth: execution.run.completionHealth,
        projectionOrigin: execution.run.projectionOrigin,
      },
      effectiveRuntime: {
        hermesE2E: false,
        orchestrator: {
          ...workOrder.runtime,
          invoked: false,
          evidence: "work-order-declaration",
        },
        inkos: {
          configMode: effective.diagnostics.configMode,
          model: effectiveWriter.model,
          reasoning: inkosReasoning,
        },
      },
      modelCalls,
      artifacts: [{ repo: "inkos", path: runPath, sha256: sha256(runBytes), role: "production-run" }],
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
  });
