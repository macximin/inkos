import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseAgent, type AgentContext } from "../agents/base.js";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";
import * as llmProvider from "../llm/provider.js";
import {
  hashCanonicalJson,
  verifyFictionContentInvocationReceipts,
} from "../production/fiction-content-contract.js";

class ProbeAgent extends BaseAgent {
  get name(): string {
    return "contract-probe";
  }

  run(messages: ReadonlyArray<LLMMessage>): Promise<LLMResponse> {
    return this.chat(messages, { temperature: 0.25 });
  }

  search(messages: ReadonlyArray<LLMMessage>): Promise<LLMResponse> {
    return this.chatWithSearch(messages, { maxTokens: 321 });
  }
}

function context(projectRoot: string): AgentContext {
  return {
    client: { provider: "openai" } as never,
    model: "fake-model",
    projectRoot,
    bookId: "demo-book",
  };
}

const RESPONSE: LLMResponse = {
  content: "ok",
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
};

describe("BaseAgent fiction-content boundary", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("governs every Book-bound call and deterministically falls back to the agent name as stage", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-base-contract-"));
    vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue(RESPONSE);

    await new ProbeAgent(context(root)).run([
      { role: "user", content: "Write the scene." },
    ]);

    const audit = await verifyFictionContentInvocationReceipts(root, "demo-book");
    expect(audit.receiptSetEqualityPassed).toBe(true);
    expect(audit.outcomeSetEqualityPassed).toBe(true);
    expect(audit.invocations).toEqual([
      expect.objectContaining({ agentName: "contract-probe", stage: "contract-probe", status: "completed" }),
    ]);
  });

  it("routes native OpenAI search through the governed call and binds webSearch in the request hash", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-base-search-contract-"));
    const provider = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue(RESPONSE);

    await new ProbeAgent(context(root)).search([
      { role: "system", content: "Research a historical detail." },
      { role: "user", content: "Find a primary source." },
    ]);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]?.[3]).toMatchObject({ webSearch: true, maxTokens: 321 });
    const audit = await verifyFictionContentInvocationReceipts(root, "demo-book");
    const invocationId = audit.traceInvocationIds[0]!;
    const trace = JSON.parse(await readFile(join(
      root,
      "books",
      "demo-book",
      "story",
      "runtime",
      "fiction-content-neutral",
      "traces",
      `${invocationId}.json`,
    ), "utf8")) as { logicalRequestPayloadSha256: string };
    expect(trace.logicalRequestPayloadSha256).toBe(hashCanonicalJson({
      model: "fake-model",
      messages: provider.mock.calls[0]?.[2],
      options: { maxTokens: 321, webSearch: true },
    }));
  });

  it("records a provider refusal as non-completed evidence before rethrowing", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-base-refusal-contract-"));
    vi.spyOn(llmProvider, "chatCompletion")
      .mockRejectedValue(new Error("blocked by provider content policy"));

    await expect(new ProbeAgent(context(root)).run([
      { role: "user", content: "Write the scene." },
    ])).rejects.toThrow(/content policy/);

    const audit = await verifyFictionContentInvocationReceipts(root, "demo-book");
    expect(audit.invocations).toEqual([
      expect.objectContaining({ stage: "contract-probe", status: "provider-refused" }),
    ]);
  });

});
