import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { StateManager } from "../state/manager.js";
import { safeNonSymlinkChildPath } from "../utils/path-safety.js";
import { readTranscriptEventsStrict } from "../interaction/session-transcript.js";
import {
  HermesControlTaskGuidanceReferenceSchema,
  ModelMediatedTaskGuidanceReferenceSchema,
  TaskGuidanceReferenceSchema,
  directionTextSha256,
  type HermesControlTaskGuidanceReference,
  type ModelMediatedTaskGuidanceReference,
  type ResolvedModelMediatedTaskGuidance,
  type ResolvedHermesControlTaskGuidance,
  type ResolvedTaskGuidance,
  type TaskGuidanceReference,
} from "./direction-context.js";
import { HermesControlActionSchema } from "./hermes-control-operation.js";

function instructionFromAssistantMessage(message: unknown, toolCallId: string): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = (message as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "toolCall" || record.id !== toolCallId) continue;
    const args = record.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    const instruction = (args as Record<string, unknown>).instruction;
    return typeof instruction === "string" && instruction.trim() ? instruction : undefined;
  }
  return undefined;
}

/** Resolve model-mediated guidance from the exact immutable transcript tool call. */
export async function resolveModelMediatedTaskGuidance(input: {
  readonly projectRoot: string;
  readonly reference: ModelMediatedTaskGuidanceReference;
}): Promise<ResolvedModelMediatedTaskGuidance> {
  const reference = ModelMediatedTaskGuidanceReferenceSchema.parse(input.reference);
  const events = await readTranscriptEventsStrict(input.projectRoot, reference.transcriptRef.sessionId);
  const matches = events.flatMap((event) => {
    if (
      event.type !== "message"
      || event.role !== "assistant"
      || event.requestId !== reference.transcriptRef.requestId
    ) return [];
    const text = instructionFromAssistantMessage(event.message, reference.transcriptRef.toolCallId);
    return text === undefined ? [] : [text];
  });
  if (matches.length !== 1) {
    throw new Error("Model-mediated task guidance must resolve to exactly one persisted transcript tool call.");
  }
  const text = matches[0]!;
  if (directionTextSha256(text) !== reference.textSha256) {
    throw new Error("Model-mediated task guidance bytes no longer match the ProductionCommand.");
  }
  return { ...reference, text };
}

/** Resolve the exact immutable external-Hermes action imported into one Book. */
export async function resolveHermesControlTaskGuidance(input: {
  readonly projectRoot: string;
  readonly reference: HermesControlTaskGuidanceReference;
}): Promise<ResolvedHermesControlTaskGuidance> {
  const reference = HermesControlTaskGuidanceReferenceSchema.parse(input.reference);
  const state = new StateManager(input.projectRoot);
  const path = await safeNonSymlinkChildPath(state.bookDir(reference.bookId), reference.actionRef.path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Hermes control task guidance must resolve to one regular Book-local action file.");
  }
  const bytes = await readFile(path);
  if (
    bytes.byteLength !== reference.actionRef.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== reference.actionRef.sha256
  ) throw new Error("Hermes control action bytes no longer match the ProductionCommand.");
  const action = HermesControlActionSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (
    action.bookId !== reference.bookId
    || action.workOrderId !== reference.workOrderId
    || action.guidanceSha256 !== reference.textSha256
  ) throw new Error("Hermes control action identity no longer matches the ProductionCommand.");
  return { ...reference, text: action.guidance };
}

export async function resolveTaskGuidance(input: {
  readonly projectRoot: string;
  readonly reference: TaskGuidanceReference;
}): Promise<ResolvedTaskGuidance> {
  const reference = TaskGuidanceReferenceSchema.parse(input.reference);
  return reference.source === "model-mediated"
    ? resolveModelMediatedTaskGuidance({ projectRoot: input.projectRoot, reference })
    : resolveHermesControlTaskGuidance({ projectRoot: input.projectRoot, reference });
}
