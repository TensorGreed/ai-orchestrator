/**
 * 12.6b — the OpenAI wire format of the /v1 AI gateway: errors (A9), request mapping onto the provider registry's
 * types, and the response, chunk and embedding shapes. No I/O here.
 */
import { parseToolArguments, unsupportedCallOptions, type ProviderCallOptions } from "@ai-orchestrator/provider-sdk";
import { NETWORK_DENIED_MESSAGE } from "@ai-orchestrator/shared";
import type {
  AiGatewayRoute,
  ChatMessage,
  ChatMessageImage,
  LLMFinishReason,
  LLMUsage,
  OpenAiChatCompletionRequest,
  OpenAiChatMessage,
  OpenAiErrorBody,
  ToolCall,
  ToolDefinition
} from "@ai-orchestrator/shared";

/** An error /v1 answers with: the HTTP status and the OpenAI envelope. */
export class AiGatewayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
    readonly code: string | null,
    readonly param: string | null = null,
    /** Seconds for Retry-After (429 and 503). */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AiGatewayHttpError";
  }

  body(): OpenAiErrorBody {
    return { error: { message: this.message, type: this.type, code: this.code, param: this.param } };
  }
}

export const aiGatewayErrors = {
  invalidRequest: (message: string, param: string | null = null, code: string | null = null) =>
    new AiGatewayHttpError(400, message, "invalid_request_error", code, param),
  invalidApiKey: (message: string) => new AiGatewayHttpError(401, message, "invalid_request_error", "invalid_api_key"),
  /** The same body from the deployment's list and the client's own: it never says which list refused, or the address. */
  networkDenied: () => new AiGatewayHttpError(403, NETWORK_DENIED_MESSAGE, "invalid_request_error", "access_denied"),
  modelNotFound: (model: string) =>
    new AiGatewayHttpError(404, `The model '${model}' does not exist or you do not have access to it.`, "invalid_request_error", "model_not_found", "model"),
  modelNotAllowed: (model: string) =>
    new AiGatewayHttpError(403, `The model '${model}' is not allowed by this deployment's model allowlist.`, "invalid_request_error", "model_not_allowed", "model"),
  rateLimited: (message: string, retryAfterSeconds: number) =>
    new AiGatewayHttpError(429, message, "requests", "rate_limit_exceeded", null, retryAfterSeconds),
  insufficientQuota: (message: string, retryAfterSeconds: number) =>
    new AiGatewayHttpError(429, message, "insufficient_quota", "insufficient_quota", null, retryAfterSeconds),
  promptBlocked: (reason: string) => new AiGatewayHttpError(400, reason, "invalid_request_error", "content_filter", "messages"),
  upstream: (status?: number) =>
    new AiGatewayHttpError(
      502,
      status ? `The model provider returned an error (HTTP ${status}).` : "The model provider could not be reached.",
      "server_error",
      "upstream_error"
    ),
  /** The provider failed after part of the answer was sent. */
  upstreamInterrupted: () => new AiGatewayHttpError(502, "The model provider failed before finishing this answer.", "server_error", "upstream_error"),
  internal: () => new AiGatewayHttpError(500, "The gateway could not complete the request.", "server_error", "internal_error"),
  upstreamRateLimited: (retryAfterSeconds: number) =>
    new AiGatewayHttpError(429, "The model provider is rate limiting this route. Try again shortly.", "requests", "upstream_rate_limited", null, retryAfterSeconds),
  unavailable: (message: string) => new AiGatewayHttpError(503, message, "server_error", "service_unavailable", null, 5),
  notFound: () => new AiGatewayHttpError(404, "Unknown endpoint.", "invalid_request_error", "unknown_url")
};

function seconds(value: unknown): number {
  return Math.max(1, Math.ceil(Number(value) || 1));
}
export { seconds as retrySeconds };

/** A zod issue path as an OpenAI `param` (`messages[0].content`). */
export function issueParam(path: ReadonlyArray<PropertyKey>): string | null {
  if (path.length === 0) return null;
  return path.reduce<string>((out, part) => (typeof part === "number" ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part)), "");
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/** The text of a message's content (string, text parts joined, or none). Images go to `images`. */
function contentOf(content: unknown, at: string): { text: string; images: ChatMessageImage[] } {
  if (content === null || content === undefined) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  const texts: string[] = [];
  const images: ChatMessageImage[] = [];
  (content as Array<Record<string, unknown>>).forEach((part, index) => {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    else if (part.type === "image_url") {
      const raw = part.image_url;
      const url = typeof raw === "string" ? raw : raw && typeof raw === "object" ? String((raw as Record<string, unknown>).url ?? "") : "";
      const match = DATA_URL.exec(url.trim());
      if (!match) {
        throw aiGatewayErrors.invalidRequest("Images must be sent as base64 data URLs (data:image/...;base64,...); the gateway does not fetch image URLs.", `${at}[${index}].image_url`);
      }
      images.push({ mimeType: match[1]!.toLowerCase(), data: match[2]!.replace(/\s+/g, "") });
    } else {
      throw aiGatewayErrors.invalidRequest(`Content parts of type '${String(part.type)}' are not supported.`, `${at}[${index}].type`);
    }
  });
  return { text: texts.join("\n"), images };
}

/**
 * Maps OpenAI messages onto the provider registry's: `developer` is a system message; tool call arguments parsed.
 * `untrusted`: the indexes of `user` messages marked `l2m: { untrusted: true }` (D17). The mark, like every field the
 * mapping does not name, is never sent upstream.
 */
export function toChatMessages(messages: OpenAiChatMessage[]): { messages: ChatMessage[]; hasImages: boolean; untrusted: number[] } {
  let hasImages = false;
  const untrusted: number[] = [];
  const out = messages.map((message, index): ChatMessage => {
    const mark = (message as { l2m?: unknown }).l2m;
    if (message.role === "user" && mark && typeof mark === "object" && (mark as { untrusted?: unknown }).untrusted === true) untrusted.push(index);
    const at = `messages[${index}].content`;
    const { text, images } = contentOf((message as { content?: unknown }).content, at);
    if (images.length > 0 && message.role !== "user") throw aiGatewayErrors.invalidRequest("Only user messages may carry images.", at);
    if (images.length > 0) hasImages = true;
    switch (message.role) {
      case "system":
      case "developer":
        return { role: "system", content: text };
      case "user":
        return { role: "user", content: text, ...(message.name ? { name: message.name } : {}), ...(images.length ? { images } : {}) };
      case "assistant": {
        const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments || "{}")
        }));
        return { role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) };
      }
      case "tool":
        return { role: "tool", content: text, toolCallId: message.tool_call_id };
    }
  });
  return { messages: out, hasImages, untrusted };
}

export function toToolDefinitions(request: OpenAiChatCompletionRequest): ToolDefinition[] | undefined {
  if (!request.tools?.length) return undefined;
  return request.tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    inputSchema: (tool.function.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }
  }));
}

/**
 * The request's parameters as provider options (route defaults fill what the request leaves out), refusing what the
 * route's provider would drop (A7: a parameter is never dropped silently).
 */
export function toCallOptions(
  request: OpenAiChatCompletionRequest,
  route: AiGatewayRoute,
  context: { hasImages: boolean; streamUsage: boolean }
): { options: ProviderCallOptions; temperature?: number; maxTokens?: number } {
  if (request.n !== undefined && request.n !== null && request.n > 1) throw aiGatewayErrors.invalidRequest("Only n = 1 is supported.", "n");
  if (request.logprobs) throw aiGatewayErrors.invalidRequest("logprobs are not supported by the gateway.", "logprobs");
  const stop = request.stop === undefined || request.stop === null ? undefined : typeof request.stop === "string" ? [request.stop] : request.stop;
  const choice = request.tool_choice;
  const options: ProviderCallOptions = {
    providerDefaults: true,
    strictStream: true,
    ...(context.streamUsage ? { streamUsage: true } : {}),
    ...(context.hasImages ? { images: true } : {}),
    ...(typeof request.max_completion_tokens === "number" ? { maxCompletionTokens: true } : {}),
    ...(typeof (request.top_p ?? route.defaults.topP) === "number" ? { topP: (request.top_p ?? route.defaults.topP)! } : {}),
    ...(stop?.length ? { stop } : {}),
    ...(typeof request.seed === "number" ? { seed: request.seed } : {}),
    ...(typeof request.presence_penalty === "number" ? { presencePenalty: request.presence_penalty } : {}),
    ...(typeof request.frequency_penalty === "number" ? { frequencyPenalty: request.frequency_penalty } : {}),
    ...(request.user ? { user: request.user } : {}),
    ...(typeof request.parallel_tool_calls === "boolean" ? { parallelToolCalls: request.parallel_tool_calls } : {}),
    ...(choice === undefined ? {} : { toolChoice: typeof choice === "string" ? choice : { name: choice.function.name } }),
    ...(request.response_format
      ? {
          responseFormat:
            request.response_format.type === "json_schema"
              ? {
                  type: "json_schema" as const,
                  jsonSchema: {
                    name: request.response_format.json_schema.name,
                    ...(request.response_format.json_schema.description ? { description: request.response_format.json_schema.description } : {}),
                    ...(request.response_format.json_schema.schema ? { schema: request.response_format.json_schema.schema } : {}),
                    ...(typeof request.response_format.json_schema.strict === "boolean" ? { strict: request.response_format.json_schema.strict } : {})
                  }
                }
              : { type: request.response_format.type }
        }
      : {})
  };
  if (options.toolChoice && typeof options.toolChoice === "object" && !request.tools?.some((tool) => tool.function.name === (options.toolChoice as { name: string }).name)) {
    throw aiGatewayErrors.invalidRequest("tool_choice names a function that is not in tools.", "tool_choice");
  }
  const dropped = unsupportedCallOptions(route.providerId, options, { hasImages: context.hasImages, hasTools: Boolean(request.tools?.length) });
  if (dropped.length > 0) {
    throw aiGatewayErrors.invalidRequest(`The model '${route.alias}' does not support: ${dropped.join(", ")}.`, dropped[0]!, "unsupported_parameter");
  }
  const temperature = request.temperature ?? route.defaults.temperature;
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? route.defaults.maxTokens;
  return { options, ...(typeof temperature === "number" ? { temperature } : {}), ...(typeof maxTokens === "number" ? { maxTokens } : {}) };
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export function toOpenAiUsage(usage: LLMUsage | undefined): OpenAiUsage {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.totalTokens ?? prompt + completion,
    ...(usage?.cachedInputTokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } } : {})
  };
}

export function openAiToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): Array<Record<string, unknown>> {
  return calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
}

/** A non-streaming chat completion. */
export function chatCompletionBody(input: {
  id: string;
  created: number;
  model: string;
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: LLMFinishReason;
  usage: LLMUsage | undefined;
}): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: input.toolCalls.length > 0 && !input.content ? null : input.content,
    refusal: null
  };
  if (input.toolCalls.length > 0) message.tool_calls = openAiToolCalls(input.toolCalls);
  return {
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    system_fingerprint: null,
    choices: [{ index: 0, message, logprobs: null, finish_reason: input.finishReason }],
    usage: toOpenAiUsage(input.usage)
  };
}

/** One streaming chunk (`chat.completion.chunk`). */
export function chatChunk(
  base: { id: string; created: number; model: string },
  delta: Record<string, unknown>,
  finishReason: LLMFinishReason | null = null
): Record<string, unknown> {
  return {
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
  };
}

/** The final usage chunk (`stream_options.include_usage`): no choices. */
export function usageChunk(base: { id: string; created: number; model: string }, usage: LLMUsage | undefined): Record<string, unknown> {
  return { id: base.id, object: "chat.completion.chunk", created: base.created, model: base.model, system_fingerprint: null, choices: [], usage: toOpenAiUsage(usage) };
}

/** A vector as `encoding_format: base64`: little-endian float32, as OpenAI sends it. */
export function base64Embedding(vector: number[]): string {
  const buffer = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer.toString("base64");
}

/** Serialises tool call arguments the way OpenAI sends them (a JSON string). */
export function argumentsText(args: Record<string, unknown>): string {
  return JSON.stringify(args ?? {});
}
