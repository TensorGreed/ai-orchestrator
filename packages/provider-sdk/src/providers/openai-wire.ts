/**
 * The OpenAI chat-completions wire format, shared by the OpenAI-family adapters (openai, openai_compatible, ollama,
 * azure_openai): message and tool mapping, the request parameters of `ProviderCallOptions`, finish reasons, usage,
 * and reading an SSE stream into `LLMStreamChunk`s.
 */
import type { ChatMessage, LLMFinishReason, LLMProviderConfig, LLMUsage, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";
import type { LLMStreamChunk, ProviderCallOptions } from "../types";
import { ErrorCategory, LLMProviderError, readStreamChunk } from "../resilient-fetch";
import { parseToolArguments } from "../tool-arg-parser";

export interface OpenAIWireToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIWireResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: OpenAIWireToolCall[] };
  }>;
  usage?: OpenAIWireUsage | null;
}

export interface OpenAIWireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIWireStreamResponse {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: { content?: string | null; tool_calls?: OpenAIWireToolCall[] };
  }>;
  usage?: OpenAIWireUsage | null;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function toOpenAIMessages(messages: ChatMessage[], wire: { images?: boolean } = {}): Array<Record<string, unknown>> {
  const sendImages = wire.images !== false;
  return messages.map((message) => {
    const payload: Record<string, unknown> = { role: message.role };
    // Multipart content with images (OpenAI vision format).
    const validImages = sendImages ? (message.images ?? []).filter((img) => img.data && img.mimeType && img.mimeType.startsWith("image/")) : [];
    if (validImages.length > 0 && message.role === "user") {
      const parts: Array<Record<string, unknown>> = [{ type: "text", text: message.content }];
      for (const img of validImages) {
        parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      }
      payload.content = parts;
    } else {
      payload.content = message.content;
    }
    if (message.role === "tool") {
      payload.tool_call_id = message.toolCallId;
      if (message.name) payload.name = message.name;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      payload.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }
      }));
    }
    return payload;
  });
}

export function toOpenAITools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
  }));
}

/**
 * The sampling and tool parameters of a chat-completions body. Without `options` this is what the adapters always
 * sent: temperature (0.2 unless set), max_tokens when set, and tool_choice "auto" with tools.
 */
export function applyOpenAIParameters(
  payload: Record<string, unknown>,
  provider: LLMProviderConfig,
  tools: Array<Record<string, unknown>> | undefined,
  options: ProviderCallOptions | undefined
): void {
  if (typeof provider.temperature === "number") payload.temperature = provider.temperature;
  else if (!options?.providerDefaults) payload.temperature = 0.2;
  if (provider.maxTokens) {
    payload[options?.maxCompletionTokens && provider.providerId === "openai" ? "max_completion_tokens" : "max_tokens"] = provider.maxTokens;
  }
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = openAIToolChoice(options?.toolChoice) ?? "auto";
    if (typeof options?.parallelToolCalls === "boolean") payload.parallel_tool_calls = options.parallelToolCalls;
  }
  if (!options) return;
  if (typeof options.topP === "number") payload.top_p = options.topP;
  if (options.stop?.length) payload.stop = options.stop;
  if (typeof options.seed === "number") payload.seed = options.seed;
  if (typeof options.presencePenalty === "number") payload.presence_penalty = options.presencePenalty;
  if (typeof options.frequencyPenalty === "number") payload.frequency_penalty = options.frequencyPenalty;
  if (options.user) payload.user = options.user;
  const format = options.responseFormat;
  if (format && format.type === "json_object") payload.response_format = { type: "json_object" };
  else if (format && format.type === "json_schema") {
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: format.jsonSchema.name,
        ...(format.jsonSchema.description ? { description: format.jsonSchema.description } : {}),
        ...(format.jsonSchema.schema ? { schema: format.jsonSchema.schema } : {}),
        ...(typeof format.jsonSchema.strict === "boolean" ? { strict: format.jsonSchema.strict } : {})
      }
    };
  }
}

function openAIToolChoice(choice: ProviderCallOptions["toolChoice"]): unknown {
  if (!choice) return undefined;
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

/** The OpenAI finish reason, or undefined for a value outside the vocabulary (or none). */
export function openAIFinishReason(value: unknown): LLMFinishReason | undefined {
  if (value === "stop" || value === "length" || value === "tool_calls" || value === "content_filter") return value;
  // Older servers still say `function_call`.
  if (value === "function_call") return "tool_calls";
  return undefined;
}

export function extractOpenAIUsage(raw: OpenAIWireUsage | null | undefined): LLMUsage | undefined {
  if (!raw) return undefined;
  const usage: LLMUsage = {};
  if (typeof raw.prompt_tokens === "number") usage.inputTokens = raw.prompt_tokens;
  if (typeof raw.completion_tokens === "number") usage.outputTokens = raw.completion_tokens;
  if (typeof raw.total_tokens === "number") usage.totalTokens = raw.total_tokens;
  if (typeof raw.prompt_tokens_details?.cached_tokens === "number") usage.cachedInputTokens = raw.prompt_tokens_details.cached_tokens;
  return Object.keys(usage).length ? usage : undefined;
}

export function parseOpenAIToolCalls(input: OpenAIWireResponse): ToolCall[] {
  const rawCalls = input.choices?.[0]?.message?.tool_calls ?? [];
  return rawCalls
    .map((toolCall, index) => {
      const name = toolCall.function?.name;
      if (!name) return undefined;
      return { id: toolCall.id ?? `toolcall_${index}`, name, arguments: parseToolArguments(toolCall.function?.arguments ?? "{}") } satisfies ToolCall;
    })
    .filter((call): call is ToolCall => Boolean(call));
}

/** The finish reason of a non-streaming answer: the provider's, else `tool_calls` when it asked for tools, else `stop`. */
export function responseFinishReason(json: OpenAIWireResponse, toolCalls: ToolCall[]): LLMFinishReason {
  return openAIFinishReason(json.choices?.[0]?.finish_reason) ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
}

function parseSSEEventPayload(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.length ? dataLines.join("\n") : null;
}

function findSSEBoundary(buffer: string): { index: number; separatorLength: number } | null {
  const unixBoundary = buffer.indexOf("\n\n");
  const windowsBoundary = buffer.indexOf("\r\n\r\n");
  if (unixBoundary < 0 && windowsBoundary < 0) return null;
  if (unixBoundary < 0) return { index: windowsBoundary, separatorLength: 4 };
  if (windowsBoundary < 0) return { index: unixBoundary, separatorLength: 2 };
  return unixBoundary < windowsBoundary ? { index: unixBoundary, separatorLength: 2 } : { index: windowsBoundary, separatorLength: 4 };
}

function chunksOfEvent(payload: string): LLMStreamChunk[] {
  if (payload === "[DONE]") return [];
  let parsed: OpenAIWireStreamResponse;
  try {
    parsed = JSON.parse(payload) as OpenAIWireStreamResponse;
  } catch {
    return [];
  }
  const out: LLMStreamChunk[] = [];
  const choice = parsed.choices?.[0];
  const delta = choice?.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) out.push({ type: "text_delta", textDelta: delta.content });
    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const hasData = typeof toolCall.id === "string" || typeof toolCall.function?.name === "string" || typeof toolCall.function?.arguments === "string";
        if (!hasData) continue;
        out.push({
          type: "tool_call_delta",
          ...(typeof toolCall.index === "number" ? { index: toolCall.index } : {}),
          toolCallId: toolCall.id,
          name: toolCall.function?.name,
          argumentsDelta: toolCall.function?.arguments
        });
      }
    }
  }
  const reason = openAIFinishReason(choice?.finish_reason);
  if (reason) out.push({ type: "finish", reason });
  const usage = extractOpenAIUsage(parsed.usage);
  if (usage) out.push({ type: "usage", usage });
  return out;
}

function streamFailure(provider: string, what: string): LLMProviderError {
  // The upstream's own text stays out: it can name hosts or echo the prompt.
  return new LLMProviderError({ message: `Provider ${provider} ${what}.`, provider, category: ErrorCategory.PROVIDER_TRANSIENT, retryAttempts: 0, retryable: false });
}

/**
 * What a strict read learns from one event: whether it is a failure (throws) and whether it shows an orderly end. A
 * finish reason of any spelling counts, as does `[DONE]` or a usage frame: compatible servers differ in which of these
 * they send, and only a stream with none of them looks cut off.
 */
function orderlyEndIn(rawEvent: string, payload: string, provider: string): boolean {
  if (payload === "[DONE]") return true;
  if (/^event:\s*error\s*$/m.test(rawEvent)) throw streamFailure(provider, "sent an error event inside the stream");
  let parsed: (OpenAIWireStreamResponse & { error?: unknown; object?: unknown }) | null;
  try {
    parsed = JSON.parse(payload) as OpenAIWireStreamResponse & { error?: unknown; object?: unknown };
  } catch {
    return false;
  }
  if (parsed?.error || parsed?.object === "error") throw streamFailure(provider, "sent an error frame inside the stream");
  const reason = parsed?.choices?.[0]?.finish_reason;
  // Some servers end a failed stream with a finish reason that names the failure, and then send [DONE].
  if (reason === "error" || reason === "abort") throw streamFailure(provider, "ended the stream with a failure");
  return (typeof reason === "string" && reason.length > 0) || Boolean(parsed?.usage);
}

/**
 * Reads an OpenAI-style SSE body into chunks. A consumer that stops early (a canceled run, a client that went away)
 * or a failed read cancels the body, so the upstream connection is freed.
 *
 * `strict` (`ProviderCallOptions.strictStream`) throws on an error frame and on a body that ends with no sign of an
 * orderly end. Without it both read as a normal end, as they always have for workflow runs.
 */
export async function* readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  input: { idleTimeoutMs: number; signal?: AbortSignal; provider: string; timeoutMessage: string; strict?: boolean }
): AsyncGenerator<LLMStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finished = false;
  let orderly = false;
  const observe = (rawEvent: string, payload: string) => {
    if (input.strict && orderlyEndIn(rawEvent, payload, input.provider)) orderly = true;
  };
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, {
        timeoutMs: input.idleTimeoutMs,
        signal: input.signal,
        provider: input.provider,
        timeoutMessage: input.timeoutMessage
      });
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const boundary = findSSEBoundary(buffer);
        if (!boundary) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.separatorLength);
        const payload = parseSSEEventPayload(rawEvent);
        if (!payload) continue;
        observe(rawEvent, payload);
        for (const chunk of chunksOfEvent(payload)) yield chunk;
      }
    }
  } finally {
    if (!finished) {
      // The consumer stopped early (run canceled) or the read failed: free the connection.
      void reader.cancel().catch(() => undefined);
    }
  }
  if (buffer.trim().length > 0) {
    const trailing = parseSSEEventPayload(buffer);
    if (trailing) {
      observe(buffer, trailing);
      for (const chunk of chunksOfEvent(trailing)) yield chunk;
    }
  }
  if (input.strict && !orderly) throw streamFailure(input.provider, "ended the stream without finishing");
}
