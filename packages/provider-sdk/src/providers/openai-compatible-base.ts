import type { ChatMessage, LLMCallResponse, LLMProviderConfig, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { ProviderCallRequest, ProviderExecutionContext } from "../types";

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const payload: Record<string, unknown> = {
      role: message.role,
      content: message.content
    };

    if (message.role === "tool") {
      payload.tool_call_id = message.toolCallId;
      if (message.name) {
        payload.name = message.name;
      }
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      payload.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }));
    }

    return payload;
  });
}

function toOpenAITools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function parseToolCalls(input: OpenAICompatibleResponse): ToolCall[] {
  const rawCalls = input.choices?.[0]?.message?.tool_calls ?? [];
  return rawCalls
    .map((toolCall, index) => {
      const id = toolCall.id ?? `toolcall_${index}`;
      const name = toolCall.function?.name;
      if (!name) {
        return undefined;
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function?.arguments ?? "{}");
      } catch {
        args = {};
      }

      return {
        id,
        name,
        arguments: args
      } satisfies ToolCall;
    })
    .filter((call): call is ToolCall => Boolean(call));
}

export interface OpenAICompatibleAdapterOptions {
  id: string;
  label: string;
  defaultBaseUrl?: string;
  defaultApiKeyEnv?: string;
  requiresApiKey?: boolean;
  supportsTools: boolean;
}

export async function callOpenAICompatible(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): Promise<LLMCallResponse> {
  const provider: LLMProviderConfig = request.provider;
  const baseUrl = normalizeBaseUrl(provider.baseUrl ?? options.defaultBaseUrl ?? "");
  if (!baseUrl) {
    throw new Error(`Provider ${options.id} requires baseUrl`);
  }

  const secretValue = await context.resolveSecret(provider.secretRef);
  const apiKey =
    secretValue ||
    (typeof provider.extra?.apiKey === "string" ? provider.extra.apiKey : undefined) ||
    (options.defaultApiKeyEnv ? process.env[options.defaultApiKeyEnv] : undefined);

  if (options.requiresApiKey && !apiKey) {
    throw new Error(`Provider ${options.id} requires an API key via secretRef or ${options.defaultApiKeyEnv}`);
  }

  const payload: Record<string, unknown> = {
    model: provider.model,
    messages: toOpenAIMessages(request.messages),
    temperature: provider.temperature ?? 0.2
  };

  if (provider.maxTokens) {
    payload.max_tokens = provider.maxTokens;
  }

  const tools = toOpenAITools(request.tools);
  if (options.supportsTools && tools?.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider ${options.id} request failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as OpenAICompatibleResponse;
  const content = json.choices?.[0]?.message?.content ?? "";

  return {
    content,
    toolCalls: options.supportsTools ? parseToolCalls(json) : [],
    raw: json
  };
}