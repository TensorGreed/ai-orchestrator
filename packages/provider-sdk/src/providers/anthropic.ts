import type { LLMCallResponse, LLMUsage, ProviderDefinition, ToolCall, ChatMessage } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { readResponseJson, readResponseText, resilientFetch } from "../resilient-fetch";

const ANTHROPIC_TIMEOUT_MS = 60_000;

/** Model used when an Anthropic provider config names none. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

const SAMPLING_PARAMS = ["temperature", "top_p", "top_k"] as const;

/**
 * True for Claude models that reject the sampling parameters (temperature,
 * top_p, top_k) and budget-based extended thinking: the Fable / Mythos
 * families, every 5-generation model, and Opus 4.7 / 4.8. Older models
 * (Claude 3.x, 4.0 - 4.6) still accept them.
 */
export function anthropicModelRejectsSampling(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(normalized);
  if (!match) {
    return false;
  }
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] ? Number(match[3]) : 0;
  if (family === "fable" || family === "mythos") {
    return true;
  }
  if (major >= 5) {
    return true;
  }
  return major === 4 && minor >= 7;
}

interface AnthropicErrorBody {
  type?: string;
  message?: string;
}

function parseAnthropicError(body: string): AnthropicErrorBody {
  try {
    const parsed = JSON.parse(body) as { error?: AnthropicErrorBody };
    return parsed && typeof parsed.error === "object" && parsed.error ? parsed.error : {};
  } catch {
    return {};
  }
}

/** Names the sampling parameter a 400 response says the model rejects, if any. */
function rejectedSamplingParam(body: Record<string, unknown>, error: AnthropicErrorBody): (typeof SAMPLING_PARAMS)[number] | undefined {
  if (error.type !== "invalid_request_error" || typeof error.message !== "string") {
    return undefined;
  }
  const message = error.message;
  return SAMPLING_PARAMS.find((param) => param in body && message.includes(param));
}

/** Builds the error thrown for a failed Anthropic request, with guidance for known cases. */
export function describeAnthropicFailure(status: number, body: string, model: string): string {
  const error = parseAnthropicError(body);
  if (status === 404 && error.type === "not_found_error" && /model/i.test(error.message ?? "")) {
    return (
      `Anthropic model "${model}" is not available (404 not_found_error). It may be retired or misspelled. ` +
      `Pick a current model, for example ${DEFAULT_ANTHROPIC_MODEL}, in the chat model node's Model field and save the node.`
    );
  }
  return `Anthropic request failed (${status}): ${body}`;
}

export class AnthropicProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "anthropic",
    label: "Anthropic Claude",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri" },
        model: { type: "string", default: DEFAULT_ANTHROPIC_MODEL },
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

    const model = request.provider.model || DEFAULT_ANTHROPIC_MODEL;
    const rejectsSampling = anthropicModelRejectsSampling(model);
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
      max_tokens: request.provider.maxTokens || 4096
    };

    // Newer models reject sampling parameters outright, so they are only sent to
    // models that accept them, and only when the config sets one.
    if (!rejectsSampling && typeof request.provider.temperature === "number" && Number.isFinite(request.provider.temperature)) {
      body.temperature = request.provider.temperature;
    }

    if (request.provider.extra?.enableThinking === true && rejectsSampling) {
      body.thinking = { type: "adaptive" };
    } else if (request.provider.extra?.enableThinking === true) {
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
    const send = () =>
      resilientFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body),
        signal: context.signal
      }, { timeoutMs: ANTHROPIC_TIMEOUT_MS, maxRetries: 3, provider: "anthropic", onRetry: context.onRetry });
    const bodyRead = { timeoutMs: ANTHROPIC_TIMEOUT_MS, signal: context.signal, provider: "anthropic" };

    let response = await send();

    if (!response.ok && response.status === 400) {
      // A model the capability check does not know yet may still reject a
      // sampling parameter; drop the one it names and retry once.
      const respBody = await readResponseText(response, bodyRead);
      const rejected = rejectedSamplingParam(body, parseAnthropicError(respBody));
      if (!rejected) {
        throw new Error(describeAnthropicFailure(response.status, respBody, model));
      }
      delete body[rejected];
      response = await send();
    }

    if (!response.ok) {
      const respBody = await readResponseText(response, bodyRead);
      throw new Error(describeAnthropicFailure(response.status, respBody, model));
    }

    const json = await readResponseJson<any>(response, bodyRead);
    
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
