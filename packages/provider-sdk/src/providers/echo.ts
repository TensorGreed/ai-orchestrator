import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext, ProviderTestResult } from "../types";

/**
 * In-process zero-dependency LLM provider that echoes back the last user
 * message. Lets the seed `Basic LLM Flow` and any "smoke test" workflow run
 * end-to-end on a fresh install with no Ollama, no OpenAI key, no Pinecone —
 * just `pnpm dev` and click Run.
 *
 * Behaviour:
 * - Returns the last user message content prefixed with `prefix` (default
 *   "Echo: "), or a friendly hint when no user message is present.
 * - Declares `supportsTools: true` but never emits tool calls — agents using
 *   this provider will exit on the first turn with a final answer.
 * - testConnection always succeeds (it's in-process).
 *
 * NOT meant for production agentic work; swap in a real provider when ready.
 */
export class EchoProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "echo",
    label: "Echo (built-in demo)",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          default: "Echo: ",
          description:
            "Prepended to the echoed user message. Default 'Echo: ' makes it obvious this is the demo provider, not a real LLM."
        }
      }
    }
  };

  async generate(request: ProviderCallRequest, _context: ProviderExecutionContext) {
    const provider = request.provider as unknown as Record<string, unknown>;
    const prefix = typeof provider.prefix === "string" ? provider.prefix : "Echo: ";

    const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

    if (!userText.trim()) {
      return {
        content:
          "Echo provider received no user message. Wire a Text Input or Prompt Template into this LLM Call to see the echo.",
        toolCalls: []
      };
    }

    return {
      content: `${prefix}${userText}`,
      toolCalls: []
    };
  }

  async testConnection(): Promise<ProviderTestResult> {
    return { ok: true, message: "Echo provider is built in — no connection required.", latencyMs: 0 };
  }
}
