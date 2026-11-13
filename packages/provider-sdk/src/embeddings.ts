/**
 * 12.6b — embedding adapters: a batch of texts in, one vector per text and the token usage out. The OpenAI family
 * (openai, openai_compatible, ollama, azure_openai) all speak the `/embeddings` shape. `createDefaultEmbeddingRegistry`
 * is the extension seam, like `createDefaultProviderRegistry`.
 */
import type { LLMProviderConfig } from "@ai-orchestrator/shared";
import type { ProviderExecutionContext } from "./types";
import { providerDefaultBaseUrl, PROVIDER_DEFAULT_BASE_URLS } from "./default-base-urls";
import { providerHttpError, readResponseJson, readResponseText, resilientFetch } from "./resilient-fetch";
import { resolveOpenAICompatibleEndpoint } from "./providers/openai-compatible-base";
import { resolveAzureOpenAIConnection } from "./providers/azure-openai";

export interface EmbeddingRequest {
  /** The model (Azure: the deployment), base URL, secret and `extra` (timeoutMs, maxRetries, apiVersion). */
  provider: LLMProviderConfig;
  /** One or more texts; the answer has one vector per text, in order. */
  input: string[];
  /** Output dimensions, for models that can shorten their vectors. */
  dimensions?: number;
  /** An end-user id for the provider's abuse monitoring. */
  user?: string;
}

export interface EmbeddingUsage {
  inputTokens?: number;
  totalTokens?: number;
}

export interface EmbeddingResponse {
  /** One vector per input, in input order. */
  embeddings: number[][];
  usage?: EmbeddingUsage;
  /** The model the provider says answered, when it says. */
  model?: string;
  latencyMs: number;
}

export interface EmbeddingProviderAdapter {
  /** The provider id (the same ids as the chat adapters). */
  id: string;
  embed(request: EmbeddingRequest, context: ProviderExecutionContext): Promise<EmbeddingResponse>;
}

export class EmbeddingProviderRegistry {
  private readonly adapters = new Map<string, EmbeddingProviderAdapter>();

  register(adapter: EmbeddingProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(providerId: string): EmbeddingProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`No embedding adapter for provider: ${providerId}`);
    return adapter;
  }

  tryGet(providerId: string): EmbeddingProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Runs an embedder that is not one of this registry's adapters (a RAG or knowledge-base embedder with its own
   * transport) the way this registry runs its own: here it is called as it is; an instrumented registry records it
   * like any embeddings call (span and metrics).
   */
  async embedWith(adapter: EmbeddingProviderAdapter, request: EmbeddingRequest, context: ProviderExecutionContext): Promise<EmbeddingResponse> {
    return await adapter.embed(request, context);
  }
}

interface OpenAIEmbeddingsBody {
  data?: Array<{ index?: number; embedding?: unknown }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

function numberSetting(extra: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = extra?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Reads an OpenAI-shaped embeddings answer: vectors put back in input order, usage when reported. */
export function parseOpenAIEmbeddings(json: OpenAIEmbeddingsBody, inputCount: number, provider: string): Omit<EmbeddingResponse, "latencyMs"> {
  const rows = Array.isArray(json.data) ? json.data : [];
  const embeddings: Array<number[] | undefined> = new Array(inputCount).fill(undefined);
  rows.forEach((row, position) => {
    const index = typeof row.index === "number" ? row.index : position;
    if (index < 0 || index >= inputCount || !Array.isArray(row.embedding)) return;
    embeddings[index] = row.embedding.map((value) => Number(value));
  });
  if (embeddings.some((vector) => vector === undefined)) {
    throw new Error(`Provider ${provider} returned ${rows.length} embeddings for ${inputCount} inputs.`);
  }
  const usage: EmbeddingUsage = {};
  if (typeof json.usage?.prompt_tokens === "number") usage.inputTokens = json.usage.prompt_tokens;
  if (typeof json.usage?.total_tokens === "number") usage.totalTokens = json.usage.total_tokens;
  return {
    embeddings: embeddings as number[][],
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(typeof json.model === "string" ? { model: json.model } : {})
  };
}

async function postEmbeddings(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  request: EmbeddingRequest,
  context: ProviderExecutionContext,
  provider: string
): Promise<EmbeddingResponse> {
  const timeoutMs = numberSetting(request.provider.extra, "timeoutMs", 60_000);
  const maxRetries = numberSetting(request.provider.extra, "maxRetries", 3);
  const startedAt = Date.now();
  const response = await resilientFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(body), signal: context.signal },
    { timeoutMs, maxRetries, provider, onRetry: context.onRetry, traceHeaders: context.traceHeaders }
  );
  const bodyRead = { timeoutMs, signal: context.signal, provider };
  if (!response.ok) {
    const text = await readResponseText(response, bodyRead);
    throw providerHttpError(provider, response.status, `Provider ${provider} embeddings request failed (${response.status}): ${text}`);
  }
  const json = await readResponseJson<OpenAIEmbeddingsBody>(response, bodyRead);
  return { ...parseOpenAIEmbeddings(json, request.input.length, provider), latencyMs: Date.now() - startedAt };
}

/** openai, openai_compatible and ollama: `POST <baseUrl>/embeddings` with a bearer key when there is one. */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingProviderAdapter {
  constructor(
    readonly id: string,
    private readonly options: { defaultBaseUrl?: () => string | undefined; defaultApiKeyEnv?: string; requiresApiKey?: boolean } = {}
  ) {}

  async embed(request: EmbeddingRequest, context: ProviderExecutionContext): Promise<EmbeddingResponse> {
    const endpoint = await resolveOpenAICompatibleEndpoint(request.provider, context, {
      id: this.id,
      ...(this.options.defaultBaseUrl ? { defaultBaseUrl: this.options.defaultBaseUrl() } : {}),
      ...(this.options.defaultApiKeyEnv ? { defaultApiKeyEnv: this.options.defaultApiKeyEnv } : {}),
      requiresApiKey: this.options.requiresApiKey ?? false
    });
    const body: Record<string, unknown> = { model: request.provider.model, input: request.input, encoding_format: "float" };
    if (request.dimensions !== undefined) body.dimensions = request.dimensions;
    if (request.user) body.user = request.user;
    return await postEmbeddings(`${endpoint.baseUrl}/embeddings`, endpoint.headers, body, request, context, this.id);
  }
}

/** azure_openai: `POST <endpoint>/openai/deployments/<deployment>/embeddings?api-version=…`. */
export class AzureOpenAIEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly id = "azure_openai";

  async embed(request: EmbeddingRequest, context: ProviderExecutionContext): Promise<EmbeddingResponse> {
    const connection = await resolveAzureOpenAIConnection(request.provider, context);
    const body: Record<string, unknown> = { input: request.input, encoding_format: "float" };
    if (request.dimensions !== undefined) body.dimensions = request.dimensions;
    if (request.user) body.user = request.user;
    const url = `${connection.endpoint}/openai/deployments/${encodeURIComponent(connection.deployment)}/embeddings?api-version=${encodeURIComponent(connection.apiVersion)}`;
    return await postEmbeddings(url, { "content-type": "application/json", [connection.authHeaderName]: connection.authHeaderValue }, body, request, context, this.id);
  }
}

export function createDefaultEmbeddingRegistry(): EmbeddingProviderRegistry {
  const registry = new EmbeddingProviderRegistry();
  registry.register(
    new OpenAICompatibleEmbeddingAdapter("openai", { defaultBaseUrl: () => PROVIDER_DEFAULT_BASE_URLS.openai, defaultApiKeyEnv: "OPENAI_API_KEY", requiresApiKey: true })
  );
  registry.register(new OpenAICompatibleEmbeddingAdapter("openai_compatible"));
  registry.register(new OpenAICompatibleEmbeddingAdapter("ollama", { defaultBaseUrl: () => providerDefaultBaseUrl("ollama") }));
  registry.register(new AzureOpenAIEmbeddingAdapter());
  return registry;
}
