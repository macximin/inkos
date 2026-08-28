import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgentSession: vi.fn(async () => ({ responseText: "ok", messages: [] })),
  resolveContext: vi.fn(async () => "상업 지급을 전면에 둔다."),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class PipelineRunnerMock {
    constructor(_config: unknown) {}
  },
  runAgentSession: mocks.runAgentSession,
}));

vi.mock("../utils.js", () => ({
  buildPipelineConfig: vi.fn(() => ({})),
  loadConfig: vi.fn(async () => ({
    llm: { provider: "openai", model: "gpt-5.6-sol" },
    language: "ko",
  })),
  createClient: vi.fn(() => ({
    _piModel: { provider: "openai", id: "gpt-5.6-sol" },
    _apiKey: "test-key",
  })),
  findProjectRoot: vi.fn(() => "/project"),
  resolveBookId: vi.fn(async (bookId: string) => bookId),
  resolveContext: mocks.resolveContext,
  log: mocks.log,
  logError: mocks.logError,
}));

describe("agent command owner direction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("keeps context separate so /write remains a confirmed intent", async () => {
    const { agentCommand } = await import("../commands/agent.js");

    await agentCommand.parseAsync(
      ["node", "agent", "/write", "--book", "book-one", "--context-file", "guidance.md", "--json"],
      { from: "node" },
    );

    expect(mocks.runAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: "book-one",
        actionSource: "slash",
        requestedIntent: "write_next",
        ownerDirectionText: "상업 지급을 전면에 둔다.",
      }),
      "/write",
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("keeps additional context visible for non-production agent prompts", async () => {
    const { agentCommand } = await import("../commands/agent.js");

    await agentCommand.parseAsync(
      ["node", "agent", "상태를 설명해", "--book", "book-one", "--context-file", "guidance.md"],
      { from: "node" },
    );

    expect(mocks.runAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ requestedIntent: undefined, ownerDirectionText: undefined }),
      expect.stringContaining("补充信息：상업 지급을 전면에 둔다."),
    );
  });
});
