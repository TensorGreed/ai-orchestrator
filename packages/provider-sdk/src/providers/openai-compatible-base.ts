import type { LLMCallResponse, LLMProviderConfig } from "@ai-orchestrator/shared";
import type { LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "../types";
import { providerHttpError, readResponseJson, readResponseText, resilientFetch, streamIdleTimeoutMs } from "../resilient-fetch";
import {
  applyOpenAIParameters,
  extractOpenAIUsage,
  normalizeBaseUrl,
  parseOpenAIToolCalls,
  readOpenAIStream,
  responseFinishReason,
  toOpenAIMessages,
  toOpenAITools,
  type OpenAIWireResponse
} from "./openai-wire";

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

/** The base URL and auth headers of an OpenAI-family endpoint (shared by chat and embeddings). */
export async function resolveOpenAICompatibleEndpoint(
  provider: LLMProviderConfig,
  context: ProviderExecutionContext,
  options: Omit<OpenAICompatibleAdapterOptions, "supportsTools" | "label">
): Promise<{ baseUrl: string; apiKey: string | undefined; headers: Record<string, string> }> {
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
  return { baseUrl, apiKey, headers: buildAuthHeaders(apiKey) };
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
  const endpoint = await resolveOpenAICompatibleEndpoint(provider, context, options);

  const payload: Record<string, unknown> = {
    model: provider.model,
    messages: toOpenAIMessages(request.messages)
  };
  applyOpenAIParameters(payload, provider, options.supportsTools ? toOpenAITools(request.tools) : undefined, request.options);

  return {
    ...endpoint,
    payload
  };
}

export async function callOpenAICompatible(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): Promise<LLMCallResponse> {
  const connection = await resolveProviderConnection(request, context, options);
  const timeoutMs = typeof request.provider.extra?.timeoutMs === "number" ? request.provider.extra.timeoutMs : 60_000;
  const maxRetries = typeof request.provider.extra?.maxRetries === "number" ? request.provider.extra.maxRetries : 3;
  const startedAt = Date.now();
  const response = await resilientFetch(
    `${connection.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: connection.headers,
      body: JSON.stringify(connection.payload),
      signal: context.signal
    },
    { timeoutMs, maxRetries, provider: options.id, onRetry: context.onRetry, traceHeaders: context.traceHeaders }
  );

  const bodyRead = { timeoutMs, signal: context.signal, provider: options.id };
  if (!response.ok) {
    const body = await readResponseText(response, bodyRead);
    throw providerHttpError(options.id, response.status, `Provider ${options.id} request failed (${response.status}): ${body}`);
  }

  const json = await readResponseJson<OpenAIWireResponse>(response, bodyRead);
  const content = json.choices?.[0]?.message?.content ?? "";
  const toolCalls = options.supportsTools ? parseOpenAIToolCalls(json) : [];

  return {
    content,
    toolCalls,
    raw: json,
    finishReason: responseFinishReason(json, toolCalls),
    usage: extractOpenAIUsage(json.usage),
    latencyMs: Date.now() - startedAt
  };
}

export async function* callOpenAICompatibleStream(
  request: ProviderCallRequest,
  context: ProviderExecutionContext,
  options: OpenAICompatibleAdapterOptions
): AsyncGenerator<LLMStreamChunk> {
  const connection = await resolveProviderConnection(request, context, options);
  const timeoutMs = typeof request.provider.extra?.timeoutMs === "number" ? request.provider.extra.timeoutMs : 120_000;
  const maxRetries = typeof request.provider.extra?.maxRetries === "number" ? request.provider.extra.maxRetries : 3;
  const response = await resilientFetch(
    `${connection.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: connection.headers,
      body: JSON.stringify({
        ...connection.payload,
        stream: true,
        ...(request.options?.streamUsage ? { stream_options: { include_usage: true } } : {})
      }),
      signal: context.signal
    },
    { timeoutMs, maxRetries, provider: options.id, onRetry: context.onRetry, traceHeaders: context.traceHeaders }
  );

  if (!response.ok) {
    const body = await readResponseText(response, { timeoutMs, signal: context.signal, provider: options.id });
    throw providerHttpError(options.id, response.status, `Provider ${options.id} stream request failed (${response.status}): ${body}`);
  }

  if (!response.body) {
    throw new Error(`Provider ${options.id} stream response did not include a body.`);
  }

  const idleTimeoutMs = streamIdleTimeoutMs(request.provider.extra, timeoutMs);
  yield* readOpenAIStream(response.body, {
    idleTimeoutMs,
    signal: context.signal,
    provider: options.id,
    strict: request.options?.strictStream === true,
    timeoutMessage: `Provider ${options.id} stream sent no data for ${idleTimeoutMs}ms; the connection looks stalled. Raise extra.streamIdleTimeoutMs on the model if it needs longer between chunks.`
  });
}
