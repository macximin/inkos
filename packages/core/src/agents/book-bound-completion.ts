import { BaseAgent, type AgentContext } from "./base.js";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";

/**
 * Small adapter for Book-bound control-document generation that previously
 * called the provider directly from PipelineRunner. Keeping it on BaseAgent's
 * provider boundary guarantees the same host contract and immutable evidence
 * as the named production agents.
 */
export class BookBoundCompletionAgent extends BaseAgent {
  constructor(
    ctx: AgentContext,
    private readonly agentName: string,
  ) {
    super(ctx);
    if (!agentName.trim()) {
      throw new Error("BookBoundCompletionAgent requires a non-empty agent name.");
    }
  }

  get name(): string {
    return this.agentName;
  }

  async complete(
    messages: ReadonlyArray<LLMMessage>,
    options?: {
      readonly temperature?: number;
      readonly maxTokens?: number;
      readonly onTextDelta?: (text: string) => void;
    },
  ): Promise<LLMResponse> {
    return this.chat(messages, options);
  }
}
