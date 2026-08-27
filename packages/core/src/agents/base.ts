import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress } from "../llm/provider.js";
import { chatCompletion } from "../llm/provider.js";
import { appendPromptPackGuidance } from "../prompts/prompt-pack.js";
import { searchWeb, fetchUrl } from "../utils/web-search.js";
import type { Logger } from "../utils/logger.js";
import { CODEX_SERVICE_ID } from "../llm/codex-cli.js";
import {
  prepareFictionContentInvocation,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";
import { isLlmStubEnabled } from "../agent/llm-stub.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly signal?: AbortSignal;
  readonly fictionContentStage?: string;
  readonly reasoningEffort?: string;
  /** Host-validated staging directory used only during atomic Book creation. */
  readonly fictionContentEvidenceBookDir?: string;
}

interface AgentChatOptions {
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly webSearch?: boolean;
  readonly onTextDelta?: (text: string) => void;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: AgentChatOptions,
  ): Promise<LLMResponse> {
    return this.runChat(messages, options);
  }

  /**
   * The single provider-call boundary for every BaseAgent invocation. A Book
   * context is sufficient to turn governance on: callers cannot bypass the
   * host contract merely by omitting an optional stage hint.
   */
  private async runChat(
    messages: ReadonlyArray<LLMMessage>,
    options?: AgentChatOptions,
  ): Promise<LLMResponse> {
    if (this.ctx.bookId && isLlmStubEnabled()) {
      throw new Error(
        "INKOS_AGENT_LLM_STUB cannot execute a Book-bound model call or satisfy production evidence.",
      );
    }
    const agentName = this.name.trim();
    if (!agentName) {
      throw new Error("BaseAgent.name must be non-empty.");
    }
    const stage = this.ctx.bookId
      ? this.ctx.fictionContentStage?.trim() || agentName
      : undefined;
    const prepared = stage && this.ctx.bookId
      ? await prepareFictionContentInvocation({
          projectRoot: this.ctx.projectRoot,
          bookId: this.ctx.bookId,
          agentName,
          stage,
          model: this.ctx.model,
          reasoningEffort: this.ctx.reasoningEffort,
          messages,
          options: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            webSearch: options?.webSearch,
          },
          evidenceBookDir: this.ctx.fictionContentEvidenceBookDir,
        })
      : null;
    let response: LLMResponse;
    try {
      response = await chatCompletion(
        this.ctx.client,
        this.ctx.model,
        prepared?.messages ?? messages,
        {
          ...options,
          onStreamProgress: this.ctx.onStreamProgress,
          signal: this.ctx.signal,
        },
      );
    } catch (error) {
      if (prepared) {
        await writeFictionContentInvocationOutcome({
          projectRoot: this.ctx.projectRoot,
          prepared,
          error,
        });
      }
      throw error;
    }
    if (prepared) {
      await writeFictionContentInvocationOutcome({
        projectRoot: this.ctx.projectRoot,
        prepared,
        output: response.content,
      });
    }
    return response;
  }

  protected async withPromptPackGuidance(basePrompt: string, promptId: string): Promise<string> {
    return appendPromptPackGuidance(basePrompt, {
      promptId,
      projectRoot: this.ctx.projectRoot,
    });
  }

  /**
   * Chat with web search enabled.
   * OpenAI: uses native web_search_options / web_search_preview.
   * Other providers: searches via Tavily API (TAVILY_API_KEY), injects results into prompt.
   */
  protected async chatWithSearch(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number },
  ): Promise<LLMResponse> {
    // OpenAI has native search — use it directly
    if (this.ctx.client.provider === "openai" && this.ctx.client.service !== CODEX_SERVICE_ID) {
      return this.runChat(messages, {
        ...options,
        webSearch: true,
      });
    }

    // Other providers: self-hosted search → inject results into prompt
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) {
      return this.chat(messages, options);
    }

    try {
      // Extract search query from user message (first 200 chars)
      const query = lastUserMsg.content.slice(0, 200);
      this.log?.info(`[search] Searching: ${query.slice(0, 60)}...`);

      const results = await searchWeb(query, 3);
      if (results.length === 0) {
        this.log?.warn("[search] No results found, falling back to regular chat");
        return this.chat(messages, options);
      }

      // Fetch top result for full content
      let fullContent = "";
      try {
        fullContent = await fetchUrl(results[0]!.url, 4000);
      } catch {
        // Fetch failed, use snippets only
      }

      const searchContext = [
        "## Web Search Results\n",
        ...results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`),
        ...(fullContent ? [`\n## Full Content (Top Result)\n${fullContent}`] : []),
      ].join("\n");

      // Inject search results before the last user message
      const augmentedMessages: LLMMessage[] = messages.map((m) =>
        m === lastUserMsg
          ? { ...m, content: `${searchContext}\n\n---\n\n${m.content}` }
          : m,
      );

      return this.chat(augmentedMessages, options);
    } catch (e) {
      this.log?.warn(`[search] Search failed: ${e}, falling back to regular chat`);
      return this.chat(messages, options);
    }
  }

  abstract get name(): string;
}
