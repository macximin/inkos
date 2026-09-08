import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ModelInvocationMetadata {
  readonly stage: string;
  readonly candidateId?: string;
  readonly attempt?: number;
}

export interface ModelInvocationContext extends ModelInvocationMetadata {
  readonly projectRoot: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly bookId?: string;
  /** Transport retries are separate from a generation/repair attempt. */
  readonly transportAttempt?: number;
}

const invocationStorage = new AsyncLocalStorage<ModelInvocationContext>();

export function currentModelInvocation(): ModelInvocationContext | undefined {
  return invocationStorage.getStore();
}

function validateInvocationContext(input: ModelInvocationContext): void {
  if (!input.projectRoot.trim() || !input.stage.trim()) throw new Error("Model invocation requires projectRoot and stage");
  for (const value of [input.attempt, input.transportAttempt]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Model invocation attempts must be positive integers");
    }
  }
}

export function runWithModelInvocation<T>(input: ModelInvocationContext, task: () => T): T {
  validateInvocationContext(input);
  return invocationStorage.run({ ...input }, task);
}

export function invocationSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeCodexUsage(value: unknown) {
  const raw = record(value);
  const input = count(raw.input_tokens);
  const output = count(raw.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: count(raw.cached_input_tokens) ?? count(record(raw.input_tokens_details).cached_tokens),
    cacheWriteInputTokens: count(raw.cache_write_input_tokens),
    reasoningOutputTokens: count(raw.reasoning_output_tokens) ?? count(record(raw.output_tokens_details).reasoning_tokens),
    totalTokens: input !== null && output !== null ? input + output : null,
  };
}

/** Only usage subobjects are retained. Prompts, completions, stderr and auth never enter this journal. */
export async function beginCodexInvocation(input: {
  readonly invocation?: ModelInvocationContext;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly executable: string;
  readonly prompt: string;
  readonly context: { systemPrompt?: string; messages: readonly unknown[]; tools?: readonly unknown[] };
  readonly modelCatalog?: { path: string; sha256: string };
  readonly modelInstructions?: { path: string; sha256: string };
}) {
  const scope = input.invocation ?? currentModelInvocation() ?? { projectRoot: process.cwd(), stage: "codex-completion" };
  validateInvocationContext(scope);
  const invocationId = randomUUID();
  const startedAt = new Date().toISOString();
  const directory = join(resolve(scope.projectRoot), ".inkos", "model-invocations", "codex", invocationId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const request = {
    schemaVersion: "inkos-model-invocation/v1", invocationId, startedAt,
    scopeSource: input.invocation ? "explicit" : currentModelInvocation() ? "async-local" : "cwd-fallback",
    stage: scope.stage, candidateId: scope.candidateId ?? null, attempt: scope.attempt ?? null,
    transportAttempt: scope.transportAttempt ?? null,
    sessionId: scope.sessionId ?? null, requestId: scope.requestId ?? null, bookId: scope.bookId ?? null,
    model: input.model, reasoningEffort: input.reasoningEffort ?? null,
    executable: input.executable,
    modelCatalog: input.modelCatalog ? { path: input.modelCatalog.path, sha256: input.modelCatalog.sha256 } : null,
    modelInstructions: input.modelInstructions ? { path: input.modelInstructions.path, sha256: input.modelInstructions.sha256 } : null,
    promptSha256: invocationSha256(input.prompt), promptBytes: Buffer.byteLength(input.prompt),
    systemPromptSha256: invocationSha256(input.context.systemPrompt ?? ""),
    systemPromptBytes: Buffer.byteLength(input.context.systemPrompt ?? ""),
    messagesSha256: invocationSha256(JSON.stringify(input.context.messages)), messageCount: input.context.messages.length,
    toolsSha256: invocationSha256(JSON.stringify(input.context.tools ?? [])), toolCount: input.context.tools?.length ?? 0,
  };
  const requestBytes = JSON.stringify(request, null, 2) + "\n";
  await writeFile(join(directory, "request.json"), requestBytes, { flag: "wx", mode: 0o600 });
  const usageEvents: Array<{ eventType: string; observedAt: string; usage: unknown }> = [];
  let completedUsage: unknown;
  return {
    invocationId,
    directory,
    observeLine(line: string) {
      let event: Record<string, unknown>;
      try { event = record(JSON.parse(line)); } catch { return; }
      if (event.usage !== undefined) {
        usageEvents.push({ eventType: String(event.type ?? "unknown"), observedAt: new Date().toISOString(), usage: event.usage });
      }
      if (event.type === "turn.completed") completedUsage = event.usage;
      const payload = record(event.payload);
      if (event.type === "event_msg" && payload.type === "token_count" && payload.info !== undefined) {
        usageEvents.push({ eventType: "event_msg.token_count", observedAt: new Date().toISOString(), usage: payload.info });
      }
    },
    async finish(outcome: {
      status: "succeeded" | "failed" | "aborted";
      phase: string;
      exitCode?: number | null;
      errorName?: string;
      completionStartedAt?: string | null;
      completionFinishedAt?: string | null;
    }) {
      await writeFile(join(directory, "result.json"), JSON.stringify({
        schemaVersion: "inkos-model-invocation-result/v1", invocationId,
        requestSha256: invocationSha256(requestBytes), startedAt, finishedAt: new Date().toISOString(),
        ...outcome, exitCode: outcome.exitCode ?? null,
        completionStartedAt: outcome.completionStartedAt ?? null, completionFinishedAt: outcome.completionFinishedAt ?? null, usageEvents,
        normalizedUsage: normalizeCodexUsage(completedUsage),
        normalizationBasis: completedUsage === undefined ? "unavailable" : "last-turn.completed",
        semantics: { cachedInputIsSubsetOfInput: true, reasoningOutputIsSubsetOfOutput: true, eventsAreNotSummed: true },
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    },
  };
}
