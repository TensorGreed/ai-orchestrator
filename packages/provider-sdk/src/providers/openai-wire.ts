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
 *
 * Some OpenAI-compatible servers ignore `stream: true` and answer with one plain chat completion: a body with no SSE
 * event at all is read as that JSON answer. A body that is neither (empty, or not a completion), and a stream whose
 * events carry no text, no tool call and no finish reason, fail instead of reading as an empty answer.
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
  // Whether any SSE event arrived, and whether any of them carried an answer (text, a tool call or a finish reason).
  let sawEvent = false;
  let sawAnswer = false;
  // The whole body while no SSE event has arrived, for a server that answered plain JSON (dropped past the cap).
  let plainBody: string | null = "";
  const observe = (rawEvent: string, payload: string) => {
    sawEvent = true;
    plainBody = null;
    if (input.strict && orderlyEndIn(rawEvent, payload, input.provider)) orderly = true;
  };
  const noteAnswer = (chunk: LLMStreamChunk) => {
    if (chunk.type === "text_delta" || chunk.type === "tool_call_delta" || chunk.type === "finish") sawAnswer = true;
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
      const text = decoder.decode(value, { stream: true });
      buffer += text;
      if (plainBody !== null) plainBody = plainBody.length + text.length > PLAIN_BODY_MAX_CHARS ? null : plainBody + text;
      while (true) {
        const boundary = findSSEBoundary(buffer);
        if (!boundary) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.separatorLength);
        const payload = parseSSEEventPayload(rawEvent);
        if (!payload) continue;
        observe(rawEvent, payload);
        for (const chunk of chunksOfEvent(payload)) {
          noteAnswer(chunk);
          yield chunk;
        }
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
      for (const chunk of chunksOfEvent(trailing)) {
        noteAnswer(chunk);
        yield chunk;
      }
    }
  }
  if (!sawEvent) {
    // No SSE event at all: the server ignored `stream: true`. Read its body as one chat completion.
    yield* chunksOfPlainCompletion(plainBody, input.provider);
    return;
  }
  if (input.strict && !orderly) throw streamFailure(input.provider, "ended the stream without finishing");
  if (!sawAnswer) throw streamFailure(input.provider, "ended the stream without any answer (no text, tool call or finish reason)");
}

/** The most of a body kept while looking for a plain JSON answer instead of a stream. */
const PLAIN_BODY_MAX_CHARS = 8 * 1024 * 1024;

/**
 * The chunks of a plain chat completion sent in place of a stream, as a stream of it would have carried them. Throws
 * for an empty body, an error body and anything that is not a chat completion; the upstream's own text stays out.
 */
function chunksOfPlainCompletion(body: string | null, provider: string): LLMStreamChunk[] {
  const text = body?.trim() ?? "";
  if (body !== null && text.length === 0) throw streamFailure(provider, "returned an empty stream (no events and no answer)");
  let parsed: (OpenAIWireResponse & { error?: unknown; object?: unknown }) | null = null;
  try {
    parsed = text ? (JSON.parse(text) as OpenAIWireResponse & { error?: unknown; object?: unknown }) : null;
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && (parsed.error || parsed.object === "error")) {
    throw streamFailure(provider, "answered the stream request with an error");
  }
  const choice = parsed && typeof parsed === "object" && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (!choice || !choice.message || typeof choice.message !== "object") {
    throw streamFailure(provider, "answered the stream request with neither a stream nor a chat completion");
  }
  const out: LLMStreamChunk[] = [];
  const content = choice.message.content;
  if (typeof content === "string" && content.length > 0) out.push({ type: "text_delta", textDelta: content });
  const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  toolCalls.forEach((toolCall, index) => {
    if (typeof toolCall.function?.name !== "string") return;
    out.push({
      type: "tool_call_delta",
      index: typeof toolCall.index === "number" ? toolCall.index : index,
      toolCallId: toolCall.id,
      name: toolCall.function.name,
      argumentsDelta: typeof toolCall.function.arguments === "string" ? toolCall.function.arguments : ""
    });
  });
  const hasToolCalls = out.some((chunk) => chunk.type === "tool_call_delta");
  out.push({ type: "finish", reason: openAIFinishReason(choice.finish_reason) ?? (hasToolCalls ? "tool_calls" : "stop") });
  const usage = extractOpenAIUsage(parsed?.usage);
  if (usage) out.push({ type: "usage", usage });
  return out;
}
