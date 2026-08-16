import type { InkosEndpoint } from "../types.js";
import { CODEX_DEFAULT_MODEL, CODEX_SERVICE_ID } from "../../codex-cli.js";

/** Local Codex CLI backed by the user's existing ChatGPT subscription sign-in. */
export const CODEX: InkosEndpoint = {
  id: CODEX_SERVICE_ID,
  label: "Codex (ChatGPT 구독)",
  group: "local",
  api: "openai-responses",
  // This URL is only a schema-compatible local sentinel. No HTTP request is sent.
  baseUrl: "http://127.0.0.1/codex-subscription",
  checkModel: CODEX_DEFAULT_MODEL,
  transportDefaults: { apiFormat: "responses", stream: false },
  models: [
    {
      id: CODEX_DEFAULT_MODEL,
      maxOutput: 32768,
      contextWindowTokens: 200000,
      capabilities: { text: true, tools: true, reasoning: true },
    },
  ],
};
