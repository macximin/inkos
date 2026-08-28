import { readTranscriptEventsStrict } from "../interaction/session-transcript.js";
import {
  ModelMediatedTaskGuidanceReferenceSchema,
  directionTextSha256,
  type ModelMediatedTaskGuidanceReference,
  type ResolvedModelMediatedTaskGuidance,
} from "./direction-context.js";

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
