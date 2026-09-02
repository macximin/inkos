import { Command } from "commander";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CANARY_ISOLATION_RECEIPT_MAX_BYTES,
  PipelineRunner,
  HermesControlActionSchema,
  ProductionExecutionTerminalError,
  createDetachedOwnerDirectionLease,
  directionTextSha256,
  finalizeAgentOperation,
  hashCanonicalJson,
  hermesControlOperationPaths,
  importHermesControlOperation,
  isSafeBookId,
  loadActiveBookSoulBinding,
  prepareProductionCanaryPair,
  loadAgentOperationTerminal,
  readProductionModelCallReadback,
  parseCanaryCommonSnapshotReceiptBytes,
  toPosixPath,
  acquireProductionCanaryAgentOperationLease,
  verifyProductionCanaryExecutionRoot,
  verifyProductionCanaryStructuralRoot,
  type ProductionCanaryExecutionRootVerification,
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

type AgentExecutionMode = "promotion-canary" | "production";
type AgentCanaryIsolationEvidence = {
  readonly pairId: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly receiptSelfHash: string;
  readonly isolationScopeSha256: string;
  readonly commonSnapshotSha256: string;
};
type AgentModeEvidence = {
  readonly lane: "genre-soul" | "neutral-baseline";
  readonly profileId: string;
  readonly profileConfigSha256: string;
  readonly profileLifecycle: "candidate" | "promoted" | "baseline";
  readonly productionEnabled: boolean;
  readonly adoptionRegistrySha256: string;
  readonly activeMatchingCount: 0 | 1;
  readonly soulId: string;
  readonly soulVersion: string;
  readonly soulSha256: string;
  readonly promotionDecisionSha256: string | null;
  readonly canaryIsolation?: AgentCanaryIsolationEvidence;
};
type AgentWorkOrderV2 = Omit<WorkOrderV2, "capability"> & {
  readonly capability: "agent-operate";
  readonly executionMode: AgentExecutionMode;
  readonly modeEvidence: AgentModeEvidence;
};

type Base64ArtifactEnvelope = {
  readonly encoding: "base64";
  readonly bytes: string;
  readonly sha256: string;
  readonly byteLength: number;
};
type AgentOperationIpcEnvelope = {
  readonly schemaVersion: "inkos-agent-operation-request/v1";
  readonly workOrder: Base64ArtifactEnvelope;
  readonly hermesAction: Base64ArtifactEnvelope & { readonly textSha256: string };
  readonly hermesReceipt: Base64ArtifactEnvelope;
  readonly canaryIsolationReceipt?: Base64ArtifactEnvelope & { readonly selfHash: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWriteNextWorkOrderV2(value: unknown): WorkOrderV2 {
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
  if (!isSafeBookId(bookId)) {
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

const AGENT_WORK_ORDER_KEYS = new Set([...WORK_ORDER_KEYS, "executionMode", "modeEvidence"]);
const MODE_EVIDENCE_KEYS = new Set([
  "lane", "profileId", "profileConfigSha256", "profileLifecycle", "productionEnabled",
  "adoptionRegistrySha256", "activeMatchingCount", "soulId", "soulVersion", "soulSha256",
  "promotionDecisionSha256", "canaryIsolation",
]);
const CANARY_ISOLATION_KEYS = new Set([
  "pairId", "path", "sha256", "byteLength", "receiptSelfHash", "isolationScopeSha256", "commonSnapshotSha256",
]);
const SAFE_CANARY_PAIR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

export function parseAgentWorkOrderV2(value: unknown): AgentWorkOrderV2 {
  if (!isRecord(value)) throw new Error("Agent WorkOrder v2 must be an object.");
  const unknown = Object.keys(value).filter((key) => !AGENT_WORK_ORDER_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Agent WorkOrder v2 has unknown field: ${unknown[0]}`);
  if (value.schemaVersion !== 2 || value.repo !== "inkos" || value.capability !== "agent-operate") {
    throw new Error("Agent operation only accepts InkOS agent-operate WorkOrder v2.");
  }
  if (value.executionMode !== "promotion-canary" && value.executionMode !== "production") {
    throw new Error("Agent WorkOrder executionMode is invalid.");
  }
  if (!isRecord(value.modeEvidence)) throw new Error("Agent WorkOrder modeEvidence must be an object.");
  const evidenceUnknown = Object.keys(value.modeEvidence).filter((key) => !MODE_EVIDENCE_KEYS.has(key));
  if (evidenceUnknown.length > 0) throw new Error(`Agent WorkOrder modeEvidence has unknown field: ${evidenceUnknown[0]}`);
  const evidence = value.modeEvidence;
  if (evidence.lane !== "genre-soul" && evidence.lane !== "neutral-baseline") throw new Error("modeEvidence.lane is invalid.");
  for (const key of ["profileId", "profileConfigSha256", "adoptionRegistrySha256"] as const) {
    if (typeof evidence[key] !== "string" || !evidence[key].trim()) throw new Error(`modeEvidence.${key} is required.`);
  }
  if (!SHA256.test(String(evidence.profileConfigSha256)) || !SHA256.test(String(evidence.adoptionRegistrySha256))) {
    throw new Error("modeEvidence profile/registry hashes are invalid.");
  }
  if (!(["candidate", "promoted", "baseline"] as const).includes(evidence.profileLifecycle as never)) {
    throw new Error("modeEvidence.profileLifecycle is invalid.");
  }
  if (typeof evidence.productionEnabled !== "boolean" || (evidence.activeMatchingCount !== 0 && evidence.activeMatchingCount !== 1)) {
    throw new Error("modeEvidence production/registry state is invalid.");
  }
  const requiredIdentity = (key: "soulId" | "soulVersion") => {
    if (typeof evidence[key] !== "string" || !evidence[key].trim() || evidence[key].length > 240) {
      throw new Error(`modeEvidence.${key} is invalid.`);
    }
  };
  requiredIdentity("soulId");
  requiredIdentity("soulVersion");
  if (!SHA256.test(String(evidence.soulSha256))) throw new Error("modeEvidence.soulSha256 is invalid.");
  if (evidence.promotionDecisionSha256 !== null && !SHA256.test(String(evidence.promotionDecisionSha256))) {
    throw new Error("modeEvidence.promotionDecisionSha256 is invalid.");
  }
  if (value.executionMode === "promotion-canary") {
    if (!isRecord(evidence.canaryIsolation)) throw new Error("promotion-canary requires canaryIsolation.");
    const canaryUnknown = Object.keys(evidence.canaryIsolation).filter((key) => !CANARY_ISOLATION_KEYS.has(key));
    if (canaryUnknown.length > 0 || Object.keys(evidence.canaryIsolation).length !== CANARY_ISOLATION_KEYS.size) {
      throw new Error(`modeEvidence.canaryIsolation must be exact${canaryUnknown[0] ? `; unknown field: ${canaryUnknown[0]}` : ""}.`);
    }
    const canary = evidence.canaryIsolation;
    if (
      typeof canary.pairId !== "string"
      || !SAFE_CANARY_PAIR_ID.test(canary.pairId)
      || canary.path !== `.inkos/canaries/${canary.pairId}/common-snapshot.json`
      || !SHA256.test(String(canary.sha256))
      || !Number.isInteger(canary.byteLength)
      || Number(canary.byteLength) < 1
      || Number(canary.byteLength) > CANARY_ISOLATION_RECEIPT_MAX_BYTES
      || !SHA256.test(String(canary.receiptSelfHash))
      || !SHA256.test(String(canary.isolationScopeSha256))
      || !SHA256.test(String(canary.commonSnapshotSha256))
    ) throw new Error("modeEvidence.canaryIsolation is invalid.");
    if (evidence.productionEnabled !== false || evidence.activeMatchingCount !== 0 || evidence.promotionDecisionSha256 !== null) {
      throw new Error("promotion-canary must be disabled, inactive, and unpromoted.");
    }
    if (evidence.lane === "genre-soul" && evidence.profileLifecycle !== "candidate") {
      throw new Error("Genre promotion-canary requires a candidate profile.");
    }
    if (evidence.lane === "neutral-baseline" && evidence.profileLifecycle !== "baseline") {
      throw new Error("Neutral promotion-canary requires a baseline profile.");
    }
    if (!Array.isArray(value.approvedInputs) || value.approvedInputs.length !== 0) {
      throw new Error("promotion-canary Agent operation does not accept approvedInputs.");
    }
  } else {
    if ("canaryIsolation" in evidence) throw new Error("production mode forbids canaryIsolation.");
    if (
      evidence.lane !== "genre-soul"
      || evidence.profileLifecycle !== "promoted"
      || evidence.productionEnabled !== true
      || evidence.activeMatchingCount !== 1
      || !SHA256.test(String(evidence.promotionDecisionSha256))
    ) throw new Error("production mode requires one active promoted genre Soul.");
    if (!Array.isArray(value.approvedInputs) || value.approvedInputs.length !== 0) {
      throw new Error("production Agent operation does not accept approvedInputs.");
    }
  }
  if (!Array.isArray(value.privateInputs) || value.privateInputs.length !== 0) {
    throw new Error("Agent operation privateInputs must be an explicit empty array.");
  }
  if (evidence.lane === "neutral-baseline") {
    if (evidence.promotionDecisionSha256 !== null) throw new Error("Neutral baseline mode forbids a promotion decision.");
    if (value.expectedSoulBinding !== null) throw new Error("Neutral baseline mode requires expectedSoulBinding=null.");
  } else {
    if (
      !isRecord(value.expectedSoulBinding)
      || value.expectedSoulBinding.soulId !== evidence.soulId
      || value.expectedSoulBinding.soulVersion !== evidence.soulVersion
    ) throw new Error("Genre Soul mode evidence must match expectedSoulBinding.");
  }
  const expectedSessionId = `hq-agent-${hashCanonicalJson({
    v: 1,
    bookId: value.bookId,
    lane: evidence.lane,
    profileId: evidence.profileId,
    soulId: evidence.soulId,
    soulVersion: evidence.soulVersion,
    bindingSha256: isRecord(value.expectedSoulBinding) ? value.expectedSoulBinding.bindingSha256 : null,
    isolationScopeSha256: isRecord(evidence.canaryIsolation) ? evidence.canaryIsolation.isolationScopeSha256 : null,
  }).slice(0, 40)}`;
  if (value.sessionId !== expectedSessionId) {
    throw new Error("Agent WorkOrder sessionId is not the deterministic Book/profile/Soul session.");
  }

  // Reuse the proven strict base parser with a synthetic write-next args hash;
  // the real agent-operate hash is checked immediately below.
  if (!isRecord(value.ownerDecision)) throw new Error("ownerDecision must be strict.");
  const { executionMode: _mode, modeEvidence: _evidence, ...base } = value;
  const instructionSha256 = directionTextSha256(String(value.instruction));
  const syntheticArgsSha256 = hashCanonicalJson({
    capability: "write-next",
    bookId: value.bookId,
    sessionId: value.sessionId,
    args: value.args,
    expectedSoulBinding: value.expectedSoulBinding,
    instructionSha256,
  });
  parseWriteNextWorkOrderV2({
    ...base,
    capability: "write-next",
    approvedInputs: [],
    privateInputs: [],
    ownerDecision: { ...value.ownerDecision, argsSha256: syntheticArgsSha256 },
  });
  const exactArgsSha256 = hashCanonicalJson({
    capability: "agent-operate",
    bookId: value.bookId,
    sessionId: value.sessionId,
    args: value.args,
    expectedSoulBinding: value.expectedSoulBinding,
    executionMode: value.executionMode,
    modeEvidence: value.modeEvidence,
    instructionSha256,
  });
  if (value.ownerDecision.argsSha256 !== exactArgsSha256) throw new Error("Agent WorkOrder ownerDecision args hash mismatch.");
  return value as unknown as AgentWorkOrderV2;
}

function decodeBase64Artifact(
  value: unknown,
  label: string,
  maxBytes: number,
  allowTextSha256 = false,
  allowSelfHash = false,
): { readonly envelope: Base64ArtifactEnvelope; readonly bytes: Buffer } {
  const allowed = ["encoding", "bytes", "sha256", "byteLength"];
  if (allowTextSha256) allowed.push("textSha256");
  if (allowSelfHash) allowed.push("selfHash");
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} envelope must be strict.`);
  }
  if (value.encoding !== "base64" || typeof value.bytes !== "string" || !value.bytes || typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new Error(`${label} envelope is invalid.`);
  }
  if (!Number.isInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > maxBytes) {
    throw new Error(`${label} byteLength is invalid.`);
  }
  const bytes = Buffer.from(value.bytes, "base64");
  if (bytes.toString("base64") !== value.bytes || bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    throw new Error(`${label} base64 bytes/hash/length mismatch.`);
  }
  return { envelope: value as unknown as Base64ArtifactEnvelope, bytes };
}

export function parseAgentOperationIpcEnvelope(value: unknown): {
  readonly envelope: AgentOperationIpcEnvelope;
  readonly workOrderBytes: Buffer;
  readonly actionBytes: Buffer;
  readonly receiptBytes: Buffer;
  readonly canaryIsolationReceiptBytes?: Buffer;
} {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "schemaVersion", "workOrder", "hermesAction", "hermesReceipt", "canaryIsolationReceipt",
  ].includes(key))) {
    throw new Error("Agent operation IPC envelope must be strict.");
  }
  if (value.schemaVersion !== "inkos-agent-operation-request/v1") throw new Error("Agent operation IPC schemaVersion is invalid.");
  const workOrder = decodeBase64Artifact(value.workOrder, "workOrder", 1024 * 1024);
  const action = decodeBase64Artifact(value.hermesAction, "hermesAction", 256 * 1024, true);
  const receipt = decodeBase64Artifact(value.hermesReceipt, "hermesReceipt", 1024 * 1024);
  const canaryReceipt = value.canaryIsolationReceipt === undefined
    ? undefined
    : decodeBase64Artifact(
      value.canaryIsolationReceipt,
      "canaryIsolationReceipt",
      CANARY_ISOLATION_RECEIPT_MAX_BYTES,
      false,
      true,
    );
  if (!isRecord(value.hermesAction) || !SHA256.test(String(value.hermesAction.textSha256))) {
    throw new Error("hermesAction.textSha256 is invalid.");
  }
  if (value.canaryIsolationReceipt !== undefined && (
    !isRecord(value.canaryIsolationReceipt)
    || !SHA256.test(String(value.canaryIsolationReceipt.selfHash))
  )) {
    throw new Error("canaryIsolationReceipt.selfHash is invalid.");
  }
  return {
    envelope: value as unknown as AgentOperationIpcEnvelope,
    workOrderBytes: workOrder.bytes,
    actionBytes: action.bytes,
    receiptBytes: receipt.bytes,
    ...(canaryReceipt ? { canaryIsolationReceiptBytes: canaryReceipt.bytes } : {}),
  };
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyAgentCanaryIsolationIngress(input: {
  readonly projectRoot: string;
  readonly workOrder: AgentWorkOrderV2;
  readonly ipc: ReturnType<typeof parseAgentOperationIpcEnvelope>;
}): Promise<ProductionCanaryExecutionRootVerification | null> {
  const workOrderIsolation = input.workOrder.modeEvidence.canaryIsolation;
  const envelopeIsolation = input.ipc.envelope.canaryIsolationReceipt;
  const receiptBytes = input.ipc.canaryIsolationReceiptBytes;
  if (input.workOrder.executionMode === "production") {
    if (workOrderIsolation !== undefined || envelopeIsolation !== undefined || receiptBytes !== undefined) {
      throw new Error("Production Agent operation forbids canary isolation evidence.");
    }
    return null;
  }
  if (!workOrderIsolation || !envelopeIsolation || !receiptBytes) {
    throw new Error("Promotion canary requires an exact canaryIsolationReceipt IPC artifact.");
  }
  if (
    envelopeIsolation.sha256 !== workOrderIsolation.sha256
    || envelopeIsolation.byteLength !== workOrderIsolation.byteLength
    || envelopeIsolation.selfHash !== workOrderIsolation.receiptSelfHash
  ) {
    throw new Error("Canary isolation IPC artifact does not match the WorkOrder evidence.");
  }
  const receipt = parseCanaryCommonSnapshotReceiptBytes(receiptBytes);
  const { receiptSelfHash, ...unsignedReceipt } = receipt;
  const physicalLane = input.workOrder.modeEvidence.lane === "neutral-baseline" ? "neutral" : "soul";
  const receiptLane = physicalLane === "neutral" ? receipt.lanes.neutral : receipt.lanes.genreSoul;
  if (
    hashCanonicalJson(unsignedReceipt) !== receiptSelfHash
    || receiptSelfHash !== workOrderIsolation.receiptSelfHash
    || receipt.pairId !== workOrderIsolation.pairId
    || receipt.bookId !== input.workOrder.bookId
    || receipt.isolationScopeSha256 !== workOrderIsolation.isolationScopeSha256
    || receipt.commonSnapshotSha256 !== workOrderIsolation.commonSnapshotSha256
    || hashCanonicalJson(receiptLane.expectedSoulBinding) !== hashCanonicalJson(input.workOrder.expectedSoulBinding)
  ) {
    throw new Error("Canary isolation IPC receipt is not exactly bound to the Agent WorkOrder lane.");
  }
  const verification = await verifyProductionCanaryStructuralRoot({
    projectRoot: input.projectRoot,
    pairId: workOrderIsolation.pairId,
    lane: physicalLane,
    receiptSha256: workOrderIsolation.sha256,
    receiptByteLength: workOrderIsolation.byteLength,
    receiptSelfHash: workOrderIsolation.receiptSelfHash,
    isolationScopeSha256: workOrderIsolation.isolationScopeSha256,
    commonSnapshotSha256: workOrderIsolation.commonSnapshotSha256,
    bookId: input.workOrder.bookId,
    expectedSoulBinding: input.workOrder.expectedSoulBinding,
  });
  const canonicalReceiptBytes = await readFile(resolve(
    input.projectRoot,
    "../../../..",
    workOrderIsolation.path,
  ));
  if (!canonicalReceiptBytes.equals(receiptBytes)) {
    throw new Error("Canary isolation IPC raw bytes differ from the canonical local receipt.");
  }
  return verification;
}

async function assertAgentModeGate(projectRoot: string, workOrder: AgentWorkOrderV2): Promise<void> {
  const evidence = workOrder.modeEvidence;
  if (
    workOrder.runtime.hermesProfile !== evidence.profileId
    || workOrder.runtime.model !== "gpt-5.6-sol"
    || workOrder.runtime.reasoning !== "high"
  ) throw new Error("Agent WorkOrder runtime does not match the owner-approved Executor Soul profile.");
  const binding = await loadActiveBookSoulBinding(projectRoot, workOrder.bookId);
  if (evidence.lane === "neutral-baseline") {
    if (binding !== null || workOrder.expectedSoulBinding !== null) {
      throw new Error("Neutral baseline lane requires a Book with no active Writer Soul binding.");
    }
    return;
  }
  if (!binding || binding.schemaVersion !== "book-soul-binding/v2") {
    throw new Error("Genre Soul Agent operation requires an active evidence-bound Book Soul v2.");
  }
  if (
    binding.soulId !== evidence.soulId
    || binding.version !== evidence.soulVersion
    || binding.bindingSha256 !== workOrder.expectedSoulBinding?.bindingSha256
    || binding.adoptionEvidence.executorSoul.profileId !== evidence.profileId
    || binding.adoptionEvidence.executorSoul.configSha256 !== evidence.profileConfigSha256
    || binding.adoptionEvidence.executorSoul.soulSha256 !== evidence.soulSha256
  ) throw new Error("Active Book Soul does not match the Agent WorkOrder mode evidence.");
  if (workOrder.executionMode === "promotion-canary") {
    if (binding.status !== "candidate" || binding.adoptionEvidence.hqAdoption !== null) {
      throw new Error("Genre promotion-canary requires an unpromoted candidate Book Soul.");
    }
    return;
  }
  const hqAdoption = binding.adoptionEvidence.hqAdoption;
  if (
    binding.status !== "promoted"
    || !hqAdoption
    || hqAdoption.decision.sha256 !== evidence.promotionDecisionSha256
    || hqAdoption.activeRegistry.sha256 !== evidence.adoptionRegistrySha256
  ) throw new Error("Production Agent operation requires exact promoted HQ adoption evidence.");
}

export function assertAgentOperateWriterRuntime(input: {
  readonly model: string;
  readonly reasoningEffort?: string;
}): void {
  if (input.model !== "gpt-5.6-sol" || input.reasoningEffort !== "high") {
    throw new Error("Agent operation requires the InkOS Writer runtime gpt-5.6-sol/high.");
  }
}

const AGENT_OPERATE_MODEL_ROLES = [
  "planner",
  "composer",
  "writer",
  "length-normalizer",
  "auditor",
  "reviser",
  "state-validator",
] as const;

export function assertAgentOperatePipelineRuntime(
  pipeline: Pick<PipelineRunner, "createAgentContext">,
  bookId: string,
): ReturnType<PipelineRunner["createAgentContext"]> {
  let writer: ReturnType<PipelineRunner["createAgentContext"]> | undefined;
  for (const role of AGENT_OPERATE_MODEL_ROLES) {
    const context = pipeline.createAgentContext(role, bookId);
    try {
      assertAgentOperateWriterRuntime(context);
    } catch {
      throw new Error(`Agent operation requires the InkOS ${role} runtime gpt-5.6-sol/high.`);
    }
    if (role === "writer") writer = context;
  }
  return writer!;
}

async function buildAgentOperationOutput(input: {
  readonly root: string;
  readonly workOrder: AgentWorkOrderV2;
  readonly workOrderSha256: string;
  readonly terminal: Awaited<ReturnType<typeof finalizeAgentOperation>>;
  readonly importReceipt: Awaited<ReturnType<typeof importHermesControlOperation>>["importReceipt"];
  readonly hermesSessionId: string;
  readonly configMode: string;
  readonly inkosModel: string;
  readonly inkosReasoning: string;
}): Promise<Record<string, unknown>> {
  const paths = hermesControlOperationPaths(input.workOrder.workOrderId);
  const [terminalBytes, importBytes, actionBytes, hermesReceiptBytes, runBytes] = await Promise.all([
    readFile(join(input.root, "books", input.workOrder.bookId, paths.terminal)),
    readFile(join(input.root, "books", input.workOrder.bookId, paths.importReceipt)),
    readFile(join(input.root, "books", input.workOrder.bookId, paths.action)),
    readFile(join(input.root, "books", input.workOrder.bookId, paths.hermesReceipt)),
    readFile(join(input.root, "books", input.workOrder.bookId, input.terminal.productionRun.path)),
  ]);
  const modelCalls = await readProductionModelCallReadback({
    projectRoot: input.root,
    bookId: input.workOrder.bookId,
    productionOperationId: input.terminal.productionRun.productionOperationId,
    attemptId: input.terminal.productionRun.attemptId,
  }).then((calls) => calls.map((call) => ({
    ...call,
    receiptPath: toPosixPath(join("books", input.workOrder.bookId, call.receiptPath)),
    outcomePath: toPosixPath(join("books", input.workOrder.bookId, call.outcomePath)),
  })));
  const run = JSON.parse(runBytes.toString("utf8")) as Record<string, unknown>;
  const terminalCanaryIsolation = input.terminal.schemaVersion === "inkos-agent-operation-terminal/v2"
    ? input.terminal.canaryIsolation
    : null;
  const finalLaneManifestSha256 = input.terminal.schemaVersion === "inkos-agent-operation-terminal/v2"
    ? input.terminal.finalLaneManifestSha256
    : null;
  return {
    schemaVersion: "inkos-agent-operation-result/v1",
    workOrder: { id: input.workOrder.workOrderId, sha256: input.workOrderSha256 },
    agentOperation: {
      status: input.terminal.status,
      executionMode: input.workOrder.executionMode,
      canaryIsolation: terminalCanaryIsolation,
      finalLaneManifestSha256,
      receipt: { path: toPosixPath(join("books", input.workOrder.bookId, paths.terminal)), sha256: sha256(terminalBytes) },
      importReceipt: { path: toPosixPath(join("books", input.workOrder.bookId, paths.importReceipt)), sha256: sha256(importBytes) },
      action: {
        path: toPosixPath(join("books", input.workOrder.bookId, paths.action)),
        sha256: sha256(actionBytes),
        textSha256: input.importReceipt.taskGuidance.textSha256,
      },
      hermesReceipt: { path: toPosixPath(join("books", input.workOrder.bookId, paths.hermesReceipt)), sha256: sha256(hermesReceiptBytes) },
    },
    productionRun: {
      commandId: input.terminal.productionRun.commandId,
      productionOperationId: input.terminal.productionRun.productionOperationId,
      attemptId: input.terminal.productionRun.attemptId,
      path: toPosixPath(join("books", input.workOrder.bookId, input.terminal.productionRun.path)),
      sha256: sha256(runBytes),
      executionStatus: run.executionStatus,
      approvalStatus: run.approvalStatus,
      completionHealth: run.completionHealth,
      projectionOrigin: run.projectionOrigin,
    },
    effectiveRuntime: {
      hermesE2E: true,
      orchestrator: {
        ...input.workOrder.runtime,
        invoked: true,
        evidence: "verified-hermes-invocation-receipt",
        sessionId: input.hermesSessionId,
        toolsCount: 0,
        toolCallCount: 0,
      },
      inkos: {
        configMode: input.configMode,
        model: input.inkosModel,
        reasoning: input.inkosReasoning,
      },
    },
    modelCalls,
    artifacts: [
      { repo: "inkos", path: toPosixPath(join("books", input.workOrder.bookId, paths.action)), sha256: sha256(actionBytes), role: "hermes-control-action" },
      { repo: "inkos", path: toPosixPath(join("books", input.workOrder.bookId, paths.hermesReceipt)), sha256: sha256(hermesReceiptBytes), role: "hermes-invocation-receipt" },
      { repo: "inkos", path: toPosixPath(join("books", input.workOrder.bookId, paths.terminal)), sha256: sha256(terminalBytes), role: "agent-operation-receipt" },
      { repo: "inkos", path: toPosixPath(join("books", input.workOrder.bookId, input.terminal.productionRun.path)), sha256: sha256(runBytes), role: "production-run" },
    ],
  };
}

export const productionCommand = new Command("production")
  .description("Execute strict host-authenticated production commands");

productionCommand.command("canary-prepare")
  .description("Create one immutable neutral/Soul canary pair in isolated real project roots")
  .requiredOption("--book <bookId>")
  .requiredOption("--pair <pairId>")
  .requiredOption("--soul <soulId>")
  .requiredOption("--version <soulVersion>")
  .requiredOption("--soul-manifest <repoRelativePath>")
  .requiredOption("--source-registry-root <path>")
  .requiredOption("--source-registry-receipt <relativePath>")
  .requiredOption("--decision-root <path>")
  .requiredOption("--decision-receipt <relativePath>")
  .requiredOption("--reference-lab-evidence-root <path>")
  .requiredOption("--inkos-evidence-root <path>")
  .requiredOption("--hq-evidence-root <path>")
  .option("--json", "Emit the exact compact isolation receipt projection")
  .action(async (opts) => {
    const root = findProjectRoot();
    const result = await prepareProductionCanaryPair({
      projectRoot: root,
      bookId: String(opts.book),
      pairId: String(opts.pair),
      soulId: String(opts.soul),
      soulVersion: String(opts.version),
      soulManifestPath: String(opts.soulManifest),
      sourceRegistryReceipt: {
        root: resolve(root, String(opts.sourceRegistryRoot)),
        path: String(opts.sourceRegistryReceipt),
      },
      decisionReceipt: {
        root: resolve(root, String(opts.decisionRoot)),
        path: String(opts.decisionReceipt),
      },
      evidenceRoots: {
        referenceLab: resolve(root, String(opts.referenceLabEvidenceRoot)),
        inkos: resolve(root, String(opts.inkosEvidenceRoot)),
        hq: resolve(root, String(opts.hqEvidenceRoot)),
      },
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write([
      `Prepared canary pair ${result.pairId} for ${result.bookId}.`,
      `Neutral root: ${result.lanes.neutral.projectRoot}`,
      `Genre Soul root: ${result.lanes.genreSoul.projectRoot}`,
      `Receipt: ${result.receipt.path} (${result.receipt.sha256})`,
      result.replayed ? "Existing immutable pair replayed." : "New immutable pair created.",
      "",
    ].join("\n"));
  });

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
    const workOrder = parseWriteNextWorkOrderV2(JSON.parse(workOrderBytes.toString("utf8")));
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

productionCommand.command("agent-operate")
  .description("Import one verified zero-tool Hermes action and execute one InkOS production kernel call")
  .requiredOption("--work-order-sha <sha256>")
  .requiredOption("--manifest-capability-sha <sha256>")
  .option("--json", "Emit compact receipt/hash JSON")
  .action(async (opts) => {
    const ipcBytes = await readStdinBytes();
    if (ipcBytes.byteLength === 0) throw new Error("Agent operation IPC bytes are required on stdin.");
    const ipc = parseAgentOperationIpcEnvelope(JSON.parse(ipcBytes.toString("utf8")));
    const workOrderSha256 = sha256(ipc.workOrderBytes);
    if (
      !SHA256.test(String(opts.workOrderSha))
      || workOrderSha256 !== opts.workOrderSha
      || workOrderSha256 !== ipc.envelope.workOrder.sha256
    ) throw new Error("Agent WorkOrder v2 byte hash mismatch.");
    if (!SHA256.test(String(opts.manifestCapabilitySha))) throw new Error("Manifest capability hash is invalid.");
    const workOrder = parseAgentWorkOrderV2(JSON.parse(ipc.workOrderBytes.toString("utf8")));
    const root = findProjectRoot();
    const canonicalAction = HermesControlActionSchema.parse(JSON.parse(ipc.actionBytes.toString("utf8")));
    if (canonicalAction.guidanceSha256 !== ipc.envelope.hermesAction.textSha256) {
      throw new Error("Agent operation envelope text hash does not match the canonical Hermes action.");
    }
    const canaryIsolation = await verifyAgentCanaryIsolationIngress({ projectRoot: root, workOrder, ipc });
    const importExactEvidence = () => importHermesControlOperation({
      projectRoot: root,
      bookId: workOrder.bookId,
      sessionId: workOrder.sessionId,
      workOrderId: workOrder.workOrderId,
      workOrderSha256,
      workOrderBytes: ipc.workOrderBytes,
      actionBytes: ipc.actionBytes,
      hermesReceiptBytes: ipc.receiptBytes,
      executionMode: workOrder.executionMode,
      canaryIsolation,
      profile: {
        profileId: workOrder.modeEvidence.profileId,
        soulId: workOrder.modeEvidence.soulId,
        soulVersion: workOrder.modeEvidence.soulVersion,
        profileConfigSha256: workOrder.modeEvidence.profileConfigSha256,
        soulSha256: workOrder.modeEvidence.soulSha256,
      },
    });
    const readTerminal = () => loadAgentOperationTerminal({
      projectRoot: root,
      bookId: workOrder.bookId,
      workOrderId: workOrder.workOrderId,
    });
    const assertReplayIdentity = (terminal: NonNullable<Awaited<ReturnType<typeof loadAgentOperationTerminal>>>) => {
      const terminalIsolation = terminal.schemaVersion === "inkos-agent-operation-terminal/v2"
        ? terminal.canaryIsolation
        : null;
      if (
        terminal.workOrderSha256 !== workOrderSha256
        || terminal.sessionId !== workOrder.sessionId
        || terminal.executionMode !== workOrder.executionMode
        || hashCanonicalJson(terminalIsolation) !== hashCanonicalJson(canaryIsolation)
      ) throw new Error("Agent operation terminal does not match the exact replay request.");
    };
    const verifyTerminalReplay = async (terminal: NonNullable<Awaited<ReturnType<typeof loadAgentOperationTerminal>>>) => {
      assertReplayIdentity(terminal);
      if (canaryIsolation) {
        if (
          terminal.schemaVersion !== "inkos-agent-operation-terminal/v2"
          || !terminal.finalLaneManifestSha256
        ) {
          throw new Error("Promotion canary terminal is missing its final lane manifest seal.");
        }
      } else if (
        terminal.schemaVersion === "inkos-agent-operation-terminal/v2"
        && terminal.finalLaneManifestSha256 !== null
      ) {
        throw new Error("Production Agent terminal must not contain a canary final lane manifest.");
      }
    };
    const emitTerminalReplay = async (
      terminal: NonNullable<Awaited<ReturnType<typeof loadAgentOperationTerminal>>>,
    ): Promise<void> => {
      await verifyTerminalReplay(terminal);
      const imported = await importExactEvidence();
      if (imported.action.guidanceSha256 !== ipc.envelope.hermesAction.textSha256) {
        throw new Error("Agent operation envelope text hash does not match the canonical Hermes action.");
      }
      const output = await buildAgentOperationOutput({
        root,
        workOrder,
        workOrderSha256,
        terminal,
        importReceipt: imported.importReceipt,
        hermesSessionId: imported.hermesReceipt.invocation.sessionId,
        configMode: "immutable-terminal-replay",
        inkosModel: "gpt-5.6-sol",
        inkosReasoning: "high",
      });
      process.stdout.write(`${JSON.stringify(output)}\n`);
      if (terminal.status !== "succeeded") process.exitCode = 1;
    };
    const existingTerminal = await readTerminal();
    if (existingTerminal) {
      await emitTerminalReplay(existingTerminal);
      return;
    }

    const releaseCanaryLease = canaryIsolation
      ? await acquireProductionCanaryAgentOperationLease({
        projectRoot: root,
        pairId: canaryIsolation.pairId,
        lane: canaryIsolation.lane,
      })
      : undefined;
    try {
      const terminalAfterLease = await readTerminal();
      if (terminalAfterLease) {
        await emitTerminalReplay(terminalAfterLease);
        return;
      }

    if (canaryIsolation) {
      const evidence = workOrder.modeEvidence.canaryIsolation!;
      const pristineVerification = await verifyProductionCanaryExecutionRoot({
        projectRoot: root,
        pairId: evidence.pairId,
        lane: canaryIsolation.lane,
        receiptSha256: evidence.sha256,
        receiptByteLength: evidence.byteLength,
        receiptSelfHash: evidence.receiptSelfHash,
        isolationScopeSha256: evidence.isolationScopeSha256,
        commonSnapshotSha256: evidence.commonSnapshotSha256,
        bookId: workOrder.bookId,
        expectedSoulBinding: workOrder.expectedSoulBinding,
      });
      if (hashCanonicalJson(pristineVerification) !== hashCanonicalJson(canaryIsolation)) {
        throw new Error("Canary pristine execution root differs from its structural projection.");
      }
    }

    await assertAgentModeGate(root, workOrder);
    const effective = await loadConfigWithDiagnostics({ projectRoot: root });
    const pipeline = new PipelineRunner({
      ...buildPipelineConfig(effective.config, root, { quiet: true }),
      surfaceGatewayMode: "kernel",
      productionKernelMode: effective.config.production?.kernel === "enforce" ? "enforce" : "observe",
    });
    const effectiveWriter = assertAgentOperatePipelineRuntime(pipeline, workOrder.bookId);
    const imported = await importExactEvidence();
    if (imported.action.guidanceSha256 !== ipc.envelope.hermesAction.textSha256) {
      throw new Error("Agent operation envelope text hash does not match the canonical Hermes action.");
    }
    const outputFor = async (terminal: Awaited<ReturnType<typeof finalizeAgentOperation>>) => buildAgentOperationOutput({
      root,
      workOrder,
      workOrderSha256,
      terminal,
      importReceipt: imported.importReceipt,
      hermesSessionId: imported.hermesReceipt.invocation.sessionId,
      configMode: effective.diagnostics.configMode,
      inkosModel: effectiveWriter.model,
      inkosReasoning: effectiveWriter.reasoningEffort ?? "none",
    });
    const racedTerminal = await readTerminal();
    if (racedTerminal) {
      await verifyTerminalReplay(racedTerminal);
      process.stdout.write(`${JSON.stringify(await outputFor(racedTerminal))}\n`);
      if (racedTerminal.status !== "succeeded") process.exitCode = 1;
      return;
    }

    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot: root,
      receiptId: workOrder.ownerDecision.receiptId,
      text: workOrder.instruction,
    });
    let run: Awaited<ReturnType<PipelineRunner["executeSurfaceWriteNext"]>>["run"];
    try {
      const execution = await pipeline.executeSurfaceWriteNext({
        source: "hq",
        idempotencyKey: workOrder.idempotencyKey,
        bookId: workOrder.bookId,
        sessionId: workOrder.sessionId,
        requestId: workOrder.workOrderId,
        workOrderId: workOrder.workOrderId,
        ownerDirection,
        taskGuidance: imported.taskGuidance,
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
      run = execution.run;
    } catch (error) {
      if (!(error instanceof ProductionExecutionTerminalError)) throw error;
      run = error.run;
    }
    const terminal = await finalizeAgentOperation({
      projectRoot: root,
      bookId: workOrder.bookId,
      sessionId: workOrder.sessionId,
      workOrderId: workOrder.workOrderId,
      workOrderSha256,
      executionMode: workOrder.executionMode,
      canaryIsolation,
      importReceipt: imported.importReceipt,
      productionRun: run,
    });
    process.stdout.write(`${JSON.stringify(await outputFor(terminal))}\n`);
    if (terminal.status !== "succeeded") process.exitCode = 1;
    } finally {
      await releaseCanaryLease?.();
    }
  });
