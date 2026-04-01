import type { ChatMessage, LLMCallResponse, LLMProviderConfig, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "../types";

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

interface OpenAICompatibleStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
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

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

export interface OpenAICompatibleAdapterOptions {
  id: string;
  label: string;
  defaultBaseUrl?: string;
  defaultApiKeyEnv?: string;
  requiresApiKey?: boolean;
  supportsTools: boolean;
}

async function resolveProviderConnection(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): Promise<{
  baseUrl: string;
  apiKey: string | undefined;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
}> {
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

  return {
    baseUrl,
    apiKey,
    payload,
    headers: buildAuthHeaders(apiKey)
  };
}

function parseSSEEventPayload(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!dataLines.length) {
    return null;
  }
  return dataLines.join("\n");
}

function findSSEBoundary(buffer: string): { index: number; separatorLength: number } | null {
  const unixBoundary = buffer.indexOf("\n\n");
  const windowsBoundary = buffer.indexOf("\r\n\r\n");

  if (unixBoundary < 0 && windowsBoundary < 0) {
    return null;
  }

  if (unixBoundary < 0) {
    return { index: windowsBoundary, separatorLength: 4 };
  }

  if (windowsBoundary < 0) {
    return { index: unixBoundary, separatorLength: 2 };
  }

  if (unixBoundary < windowsBoundary) {
    return { index: unixBoundary, separatorLength: 2 };
  }

  return { index: windowsBoundary, separatorLength: 4 };
}

export async function callOpenAICompatible(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): Promise<LLMCallResponse> {
  const connection = await resolveProviderConnection(request, context, options);
  const response = await fetch(`${connection.baseUrl}/chat/completions`, {
    method: "POST",
    headers: connection.headers,
    body: JSON.stringify(connection.payload)
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

export async function* callOpenAICompatibleStream(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): AsyncGenerator<LLMStreamChunk> {
  const connection = await resolveProviderConnection(request, context, options);
  const response = await fetch(`${connection.baseUrl}/chat/completions`, {
    method: "POST",
    headers: connection.headers,
    body: JSON.stringify({
      ...connection.payload,
      stream: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Provider ${options.id} stream request failed (${response.status}): ${body}`);
  }

  if (!response.body) {
    throw new Error(`Provider ${options.id} stream response did not include a body.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const processEventPayload = async function* (payload: string): AsyncGenerator<LLMStreamChunk> {
    if (payload === "[DONE]") {
      return;
    }

    let parsed: OpenAICompatibleStreamResponse;
    try {
      parsed = JSON.parse(payload) as OpenAICompatibleStreamResponse;
    } catch {
      return;
    }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) {
      return;
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield {
        type: "text_delta",
        textDelta: delta.content
      };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const hasData =
          typeof toolCall.id === "string" ||
          typeof toolCall.function?.name === "string" ||
          typeof toolCall.function?.arguments === "string";
        if (!hasData) {
          continue;
        }
        yield {
          type: "tool_call_delta",
          toolCallId: toolCall.id,
          name: toolCall.function?.name,
          argumentsDelta: toolCall.function?.arguments
        };
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = findSSEBoundary(buffer);
      if (!boundary) {
        break;
      }

      const rawEvent = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);
      const payload = parseSSEEventPayload(rawEvent);
      if (!payload) {
        continue;
      }

      for await (const chunk of processEventPayload(payload)) {
        yield chunk;
      }
    }
  }

  if (buffer.trim().length > 0) {
    const trailingPayload = parseSSEEventPayload(buffer);
    if (trailingPayload) {
      for await (const chunk of processEventPayload(trailingPayload)) {
        yield chunk;
      }
    }
  }
}
