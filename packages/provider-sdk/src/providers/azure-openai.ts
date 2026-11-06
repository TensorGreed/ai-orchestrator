import type { ProviderDefinition } from "@ai-orchestrator/shared";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "../types";
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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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

/** The endpoint, deployment, api-version and auth header of an Azure OpenAI call (chat and embeddings). */
export async function resolveAzureOpenAIConnection(
  provider: ProviderCallRequest["provider"],
  context: ProviderExecutionContext
): Promise<{
  endpoint: string;
  deployment: string;
  apiVersion: string;
  authHeaderName: "api-key" | "authorization";
  authHeaderValue: string;
}> {
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
    const connection = await resolveAzureOpenAIConnection(provider, context);
    const payload: Record<string, unknown> = {
      messages: toOpenAIMessages(request.messages, { images: request.options?.images === true })
    };
    applyOpenAIParameters(payload, provider, toOpenAITools(request.tools), request.options);

    const timeoutMs = typeof provider.extra?.timeoutMs === "number" ? provider.extra.timeoutMs : 60_000;
    const maxRetries = typeof provider.extra?.maxRetries === "number" ? provider.extra.maxRetries : 3;
    const startedAt = Date.now();
    const response = await resilientFetch(
      `${connection.endpoint}/openai/deployments/${encodeURIComponent(connection.deployment)}/chat/completions?api-version=${encodeURIComponent(connection.apiVersion)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [connection.authHeaderName]: connection.authHeaderValue
        },
        body: JSON.stringify(payload),
        signal: context.signal
      },
      { timeoutMs, maxRetries, provider: "azure_openai", onRetry: context.onRetry }
    );

    const bodyRead = { timeoutMs, signal: context.signal, provider: "azure_openai" };
    if (!response.ok) {
      const body = await readResponseText(response, bodyRead);
      throw providerHttpError("azure_openai", response.status, `Provider azure_openai request failed (${response.status}): ${body}`);
    }

    const json = await readResponseJson<OpenAIWireResponse>(response, bodyRead);
    const content = json.choices?.[0]?.message?.content ?? "";
    const toolCalls = parseOpenAIToolCalls(json);
    return {
      content,
      toolCalls,
      raw: json,
      finishReason: responseFinishReason(json, toolCalls),
      usage: extractOpenAIUsage(json.usage),
      latencyMs: Date.now() - startedAt
    };
  }

  async *generateStream(request: ProviderCallRequest, context: ProviderExecutionContext): AsyncGenerator<LLMStreamChunk> {
    const provider = request.provider;
    const connection = await resolveAzureOpenAIConnection(provider, context);
    const payload: Record<string, unknown> = {
      messages: toOpenAIMessages(request.messages, { images: request.options?.images === true })
    };
    applyOpenAIParameters(payload, provider, toOpenAITools(request.tools), request.options);
    payload.stream = true;
    if (request.options?.streamUsage) payload.stream_options = { include_usage: true };

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
        body: JSON.stringify(payload),
        signal: context.signal
      },
      { timeoutMs, maxRetries, provider: "azure_openai", onRetry: context.onRetry }
    );

    if (!response.ok) {
      const body = await readResponseText(response, { timeoutMs, signal: context.signal, provider: "azure_openai" });
      throw providerHttpError("azure_openai", response.status, `Provider azure_openai stream request failed (${response.status}): ${body}`);
    }
    if (!response.body) {
      throw new Error("Provider azure_openai stream response did not include a body.");
    }

    const idleTimeoutMs = streamIdleTimeoutMs(provider.extra, timeoutMs);
    yield* readOpenAIStream(response.body, {
      idleTimeoutMs,
      signal: context.signal,
      provider: "azure_openai",
      timeoutMessage: `Provider azure_openai stream sent no data for ${idleTimeoutMs}ms; the connection looks stalled. Raise extra.streamIdleTimeoutMs on the model if it needs longer between chunks.`
    });
  }
}
