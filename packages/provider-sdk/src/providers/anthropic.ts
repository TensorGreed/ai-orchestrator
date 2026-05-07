import type { LLMCallResponse, LLMUsage, ProviderDefinition, ToolCall, ChatMessage } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { resilientFetch } from "../resilient-fetch";

export class AnthropicProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "anthropic",
    label: "Anthropic Claude",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri" },
        model: { type: "string", default: "claude-3-5-sonnet-latest" },
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      },
      required: ["model"]
    }
  };

  async generate(request: ProviderCallRequest, context: ProviderExecutionContext): Promise<LLMCallResponse> {
    const apiKey = (await context.resolveSecret(request.provider.secretRef)) || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Anthropic requires API key via secretRef or ANTHROPIC_API_KEY env var");
    }

    const model = request.provider.model || "claude-3-5-sonnet-latest";
    const rawBaseUrl = request.provider.baseUrl || "https://api.anthropic.com/v1";
    const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
    const endpoint = normalizedBaseUrl.endsWith("/messages") ? normalizedBaseUrl : `${normalizedBaseUrl}/messages`;

    // Extract system prompt
    let system = "";
    const anthropicMessages: any[] = [];
    
    for (const msg of request.messages) {
      if (msg.role === "system") {
         system += msg.content + "\n";
      } else if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
         const contentParts = [];
         if (msg.content) contentParts.push({ type: "text", text: msg.content });
         for (const tc of msg.toolCalls) {
            contentParts.push({
               type: "tool_use",
               id: tc.id,
               name: tc.name,
               input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments
            });
         }
         anthropicMessages.push({ role: "assistant", content: contentParts });
      } else if (msg.role === "tool") {
         anthropicMessages.push({
            role: "user",
            content: [{
               type: "tool_result",
               tool_use_id: msg.toolCallId || msg.name || "unknown",
               content: msg.content
            }]
         });
      } else {
         anthropicMessages.push({
            role: msg.role === "assistant" ? "assistant" : "user",
            content: msg.content
         });
      }
    }

    const tools = request.tools?.map(t => ({
       name: t.name,
       description: t.description || "",
       input_schema: t.inputSchema || { type: "object", properties: {} }
    }));

    const body: any = {
      model,
      system: system.trim() || undefined,
      messages: anthropicMessages,
      max_tokens: request.provider.maxTokens || 4096,
      temperature: request.provider.temperature ?? 0.2
    };

    if (request.provider.extra?.enableThinking === true) {
      const thinkingTokens =
        typeof request.provider.extra.thinkingTokens === "number" && Number.isFinite(request.provider.extra.thinkingTokens)
          ? Math.max(1, Math.floor(request.provider.extra.thinkingTokens))
          : 1024;
      body.thinking = {
        type: "enabled",
        budget_tokens: thinkingTokens
      };
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const startedAt = Date.now();
    const response = await resilientFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    }, { timeoutMs: 60_000, maxRetries: 3, provider: "anthropic" });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Anthropic request failed (${response.status}): ${respBody}`);
    }

    const json = (await response.json()) as any;
    
    let content = "";
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(json.content)) {
      for (const block of json.content) {
         if (block.type === "text") {
            content += block.text;
         } else if (block.type === "tool_use") {
            toolCalls.push({
               id: block.id,
               name: block.name,
               arguments: block.input
            });
         }
      }
    }

    let usage: LLMUsage | undefined;
    if (json.usage && typeof json.usage === "object") {
      usage = {};
      if (typeof json.usage.input_tokens === "number") usage.inputTokens = json.usage.input_tokens;
      if (typeof json.usage.output_tokens === "number") usage.outputTokens = json.usage.output_tokens;
      if (typeof json.usage.cache_read_input_tokens === "number") usage.cachedInputTokens = json.usage.cache_read_input_tokens;
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        usage.totalTokens = usage.inputTokens + usage.outputTokens;
      }
      if (Object.keys(usage).length === 0) usage = undefined;
    }

    return {
      content,
      toolCalls,
      raw: json,
      usage,
      latencyMs: Date.now() - startedAt
    };
  }
}
