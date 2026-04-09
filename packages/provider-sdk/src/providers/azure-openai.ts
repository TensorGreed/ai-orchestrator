import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { ChatMessage, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { resilientFetch } from "../resilient-fetch";
import { parseToolArguments } from "../tool-arg-parser";

interface AzureOpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
}

interface AzureOpenAIStreamResponse {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

function parseToolCalls(input: AzureOpenAIResponse): ToolCall[] {
  const rawCalls = input.choices?.[0]?.message?.tool_calls ?? [];
  return rawCalls
    .map((toolCall, index) => {
      const id = toolCall.id ?? `toolcall_${index}`;
      const name = toolCall.function?.name;
      if (!name) {
        return undefined;
      }

      const args = parseToolArguments(toolCall.function?.arguments ?? "{}");

      return {
        id,
        name,
        arguments: args
      } satisfies ToolCall;
    })
    .filter((entry): entry is ToolCall => Boolean(entry));
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
  return unixBoundary < windowsBoundary
    ? { index: unixBoundary, separatorLength: 2 }
    : { index: windowsBoundary, separatorLength: 4 };
}

function normalizeApiKey(secretValue: string | undefined): string | undefined {
  const trimmed = typeof secretValue === "string" ? secretValue.trim() : "";
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const keyCandidate = typeof parsed.apiKey === "string"
      ? parsed.apiKey
      : typeof parsed.api_key === "string"
        ? parsed.api_key
        : typeof parsed.key === "string"
          ? parsed.key
          : "";
    const tokenCandidate = typeof parsed.accessToken === "string"
      ? parsed.accessToken
      : typeof parsed.access_token === "string"
        ? parsed.access_token
        : typeof parsed.token === "string"
          ? parsed.token
          : "";
    const normalized = keyCandidate.trim() || tokenCandidate.trim();
    return normalized || undefined;
  } catch {
    return trimmed;
  }
}

async function resolveConnection(
  request: ProviderCallRequest,
  context: ProviderExecutionContext
): Promise<{
  endpoint: string;
  deployment: string;
  apiVersion: string;
  authHeaderName: "api-key" | "authorization";
  authHeaderValue: string;
}> {
  const provider = request.provider;
  const extra = toRecord(provider.extra);
  const endpoint = normalizeBaseUrl(
    (typeof provider.baseUrl === "string" && provider.baseUrl.trim()) ||
      (typeof extra.endpoint === "string" && extra.endpoint.trim()) ||
      process.env.AZURE_OPENAI_ENDPOINT ||
      ""
  );
  if (!endpoint) {
    throw new Error("Provider azure_openai requires endpoint/baseUrl.");
  }

  const deployment =
    (typeof extra.deployment === "string" && extra.deployment.trim()) ||
    (typeof provider.model === "string" && provider.model.trim()) ||
    "";
  if (!deployment) {
    throw new Error("Provider azure_openai requires deployment/model.");
  }

  const apiVersion =
    (typeof extra.apiVersion === "string" && extra.apiVersion.trim()) ||
    process.env.AZURE_OPENAI_API_VERSION ||
    "2024-10-21";

  const resolvedSecret = normalizeApiKey(await context.resolveSecret(provider.secretRef));
  const explicitApiKey = normalizeApiKey(typeof extra.apiKey === "string" ? extra.apiKey : undefined);
  const envApiKey = normalizeApiKey(process.env.AZURE_OPENAI_API_KEY);
  const authValue = resolvedSecret ?? explicitApiKey ?? envApiKey;
  if (!authValue) {
    throw new Error("Provider azure_openai requires an API key via secretRef or AZURE_OPENAI_API_KEY.");
  }

  const useBearer = authValue.split(".").length === 3 || /^bearer\s+/i.test(authValue);
  if (useBearer) {
    const token = authValue.replace(/^bearer\s+/i, "").trim();
    return {
      endpoint,
      deployment,
      apiVersion,
      authHeaderName: "authorization",
      authHeaderValue: `Bearer ${token}`
    };
  }

  return {
    endpoint,
    deployment,
    apiVersion,
    authHeaderName: "api-key",
    authHeaderValue: authValue
  };
}

export class AzureOpenAIProviderAdapter implements LLMProviderAdapter {
  readonly definition: ProviderDefinition = {
    id: "azure_openai",
    label: "Azure OpenAI",
    supportsTools: true,
    configSchema: {
      type: "object",
      properties: {
        baseUrl: { type: "string", format: "uri" },
        model: { type: "string", description: "Azure deployment name" },
        secretRef: { type: "object", properties: { secretId: { type: "string" } } },
        extra: {
          type: "object",
          properties: {
            deployment: { type: "string" },
            apiVersion: { type: "string" }
          }
        }
      },
      required: ["baseUrl", "model"]
    }
  };

  async generate(request: ProviderCallRequest, context: ProviderExecutionContext) {
    const provider = request.provider;
    const connection = await resolveConnection(request, context);
    const payload: Record<string, unknown> = {
      messages: toOpenAIMessages(request.messages),
      temperature: provider.temperature ?? 0.2
    };

    if (provider.maxTokens) {
      payload.max_tokens = provider.maxTokens;
    }

    const tools = toOpenAITools(request.tools);
    if (tools?.length) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    const timeoutMs = typeof provider.extra?.timeoutMs === "number" ? provider.extra.timeoutMs : 60_000;
    const maxRetries = typeof provider.extra?.maxRetries === "number" ? provider.extra.maxRetries : 3;
    const response = await resilientFetch(
      `${connection.endpoint}/openai/deployments/${encodeURIComponent(connection.deployment)}/chat/completions?api-version=${encodeURIComponent(connection.apiVersion)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [connection.authHeaderName]: connection.authHeaderValue
        },
        body: JSON.stringify(payload)
      },
      { timeoutMs, maxRetries, provider: "azure_openai" }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Provider azure_openai request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as AzureOpenAIResponse;
    const content = json.choices?.[0]?.message?.content ?? "";
    return {
      content,
      toolCalls: parseToolCalls(json),
      raw: json
    };
  }

  async *generateStream(request: ProviderCallRequest, context: ProviderExecutionContext): AsyncGenerator<LLMStreamChunk> {
    const provider = request.provider;
    const connection = await resolveConnection(request, context);
    const payload: Record<string, unknown> = {
      messages: toOpenAIMessages(request.messages),
      temperature: provider.temperature ?? 0.2,
      stream: true
    };

    if (provider.maxTokens) {
      payload.max_tokens = provider.maxTokens;
    }
    const tools = toOpenAITools(request.tools);
    if (tools?.length) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }

    const timeoutMs = typeof provider.extra?.timeoutMs === "number" ? provider.extra.timeoutMs : 120_000;
    const maxRetries = typeof provider.extra?.maxRetries === "number" ? provider.extra.maxRetries : 3;
    const response = await resilientFetch(
      `${connection.endpoint}/openai/deployments/${encodeURIComponent(connection.deployment)}/chat/completions?api-version=${encodeURIComponent(connection.apiVersion)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [connection.authHeaderName]: connection.authHeaderValue
        },
        body: JSON.stringify(payload)
      },
      { timeoutMs, maxRetries, provider: "azure_openai" }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Provider azure_openai stream request failed (${response.status}): ${body}`);
    }
    if (!response.body) {
      throw new Error("Provider azure_openai stream response did not include a body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

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
        const payloadChunk = parseSSEEventPayload(rawEvent);
        if (!payloadChunk || payloadChunk === "[DONE]") {
          continue;
        }

        let parsed: AzureOpenAIStreamResponse;
        try {
          parsed = JSON.parse(payloadChunk) as AzureOpenAIStreamResponse;
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield {
            type: "text_delta",
            textDelta: delta.content
          };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (!toolCall.id && !toolCall.function?.name && !toolCall.function?.arguments) {
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
      }
    }
  }
}
