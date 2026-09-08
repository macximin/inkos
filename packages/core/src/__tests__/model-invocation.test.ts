import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginCodexInvocation, currentModelInvocation, normalizeCodexUsage, runWithModelInvocation } from "../llm/model-invocation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Codex invocation evidence", () => {
  it("keeps missing counters distinct from zero and does not add cache or reasoning twice", () => {
    expect(normalizeCodexUsage({ input_tokens: 20, output_tokens: 8, cached_input_tokens: 10, reasoning_output_tokens: 6, cache_write_input_tokens: 0 })).toEqual({
      inputTokens: 20, outputTokens: 8, cachedInputTokens: 10, cacheWriteInputTokens: 0, reasoningOutputTokens: 6, totalTokens: 28,
    });
    expect(normalizeCodexUsage({ output_tokens: 0 })).toEqual({ inputTokens: null, outputTokens: 0, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null, totalTokens: null });
    expect(normalizeCodexUsage({ input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } })).toMatchObject({ cachedInputTokens: 3, reasoningOutputTokens: 2 });
  });

  it("persists all usage observations and only normalizes the final completed turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-usage-")); roots.push(root);
    const journal = await beginCodexInvocation({ invocation: { projectRoot: root, stage: "review", sessionId: "s", requestId: "r", candidateId: "p01", attempt: 2 }, model: "gpt-6-astra", executable: "/codex", prompt: "PRIVATE SOURCE", context: { systemPrompt: "SECRET INSTRUCTIONS", messages: ["PRIVATE SOURCE"] } });
    journal.observeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 4, future_counter: 9 } }));
    journal.observeLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10 } } } }));
    journal.observeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 3 } }));
    journal.observeLine(JSON.stringify({ type: "item.completed", item: { text: "PRIVATE OUTPUT" } }));
    await journal.finish({ status: "failed", phase: "response-validation", exitCode: 0, errorName: "Error" });
    const requestText = await readFile(join(journal.directory, "request.json"), "utf8");
    const resultText = await readFile(join(journal.directory, "result.json"), "utf8");
    const request = JSON.parse(requestText); const result = JSON.parse(resultText);
    expect(request).toMatchObject({ stage: "review", candidateId: "p01", attempt: 2, sessionId: "s", requestId: "r", toolCount: 0 });
    expect(result.usageEvents).toHaveLength(3);
    expect(result.usageEvents[0].usage.future_counter).toBe(9);
    expect(result.normalizedUsage).toMatchObject({ inputTokens: 20, outputTokens: 3, totalTokens: 23, cachedInputTokens: null, reasoningOutputTokens: null });
    expect(result.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(request.startedAt));
    expect(requestText + resultText).not.toMatch(/PRIVATE|SECRET/);
  });

  it("does not reuse an earlier usage value when the final completed event omits usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-usage-missing-")); roots.push(root);
    const journal = await beginCodexInvocation({ invocation: { projectRoot: root, stage: "probe" }, model: "gpt-6-astra", executable: "/codex", prompt: "fixture", context: { messages: [] } });
    journal.observeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
    journal.observeLine(JSON.stringify({ type: "turn.completed" }));
    await journal.finish({ status: "succeeded", phase: "completed", exitCode: 0 });
    const result = JSON.parse(await readFile(join(journal.directory, "result.json"), "utf8"));
    expect(result.usageEvents).toHaveLength(1);
    expect(result.normalizedUsage.inputTokens).toBeNull();
    expect(result.normalizationBasis).toBe("unavailable");
  });

  it("isolates stages for concurrent requests and restores outer context", async () => {
    expect(currentModelInvocation()).toBeUndefined();
    const seen = await Promise.all(["generation", "repair"].map((stage) => runWithModelInvocation({ projectRoot: "/tmp", stage }, async () => {
      await new Promise((resolve) => setTimeout(resolve, stage === "generation" ? 5 : 1));
      return currentModelInvocation()?.stage;
    })));
    expect(seen).toEqual(["generation", "repair"]);
    expect(currentModelInvocation()).toBeUndefined();
    expect(() => runWithModelInvocation({ projectRoot: "/tmp", stage: "", attempt: 0 }, () => {})).toThrow();
  });
});
