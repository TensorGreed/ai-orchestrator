import type { ChatMessage, InstrumentationSpan, LLMFinishReason, ToolCall, ToolDefinition } from "@ai-orchestrator/shared";

/**
 * A model call's content in the shapes the GenAI semantic conventions (v1.41.0) define for `gen_ai.system_instructions`,
 * `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.tool.definitions`. Built only when the span says it
 * captures content (OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT); the span's implementation masks it before export.
 *
 * Images are never copied: a part names the image's type only.
 */

type Part = Record<string, unknown>;

function messageParts(message: ChatMessage): Part[] {
  const parts: Part[] = [];
  if (message.role === "tool") {
    parts.push({ type: "tool_call_response", ...(message.toolCallId ? { id: message.toolCallId } : {}), response: message.content });
  } else if (message.content) {
    parts.push({ type: "text", content: message.content });
  }
  for (const image of message.images ?? []) parts.push({ type: "image", mime_type: image.mimeType });
  for (const call of message.toolCalls ?? []) parts.push(toolCallPart(call));
  return parts;
}

function toolCallPart(call: Pick<ToolCall, "id" | "name" | "arguments">): Part {
  return { type: "tool_call", ...(call.id ? { id: call.id } : {}), name: call.name, arguments: call.arguments };
}

/** The system messages, as instruction parts. */
export function genAiSystemInstructions(messages: readonly ChatMessage[]): Part[] {
  return messages.filter((message) => message.role === "system" && message.content).map((message) => ({ type: "text", content: message.content }));
}

/** Every other message, in the order sent. */
export function genAiInputMessages(messages: readonly ChatMessage[]): Part[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, parts: messageParts(message), ...(message.name ? { name: message.name } : {}) }));
}

export function genAiToolDefinitions(tools: readonly ToolDefinition[]): Part[] {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.inputSchema }));
}

function finishReason(reason: LLMFinishReason | undefined, hasToolCalls: boolean): string {
  if (reason === "tool_calls") return "tool_call";
  if (reason) return reason;
  return hasToolCalls ? "tool_call" : "stop";
}

/** The answer as one output message. */
export function genAiOutputMessages(answer: { content: string; toolCalls: ReadonlyArray<Pick<ToolCall, "id" | "name" | "arguments">>; finishReason?: LLMFinishReason }): Part[] {
  const parts: Part[] = [];
  if (answer.content) parts.push({ type: "text", content: answer.content });
  for (const call of answer.toolCalls) parts.push(toolCallPart(call));
  return [{ role: "assistant", parts, finish_reason: finishReason(answer.finishReason, answer.toolCalls.length > 0) }];
}

/** Queues the request's content on `span` (system instructions, messages, tool definitions). */
export function captureModelRequest(span: InstrumentationSpan, request: { messages: readonly ChatMessage[]; tools?: readonly ToolDefinition[] }): void {
  if (span.capturesContent !== true || !span.addContent) return;
  try {
    const system = genAiSystemInstructions(request.messages);
    if (system.length > 0) span.addContent("system_instructions", system);
    span.addContent("input_messages", genAiInputMessages(request.messages));
    if (request.tools && request.tools.length > 0) span.addContent("tool_definitions", genAiToolDefinitions(request.tools));
  } catch {
    // Content capture never fails a model call; content that cannot be built is left out.
  }
}

/** Queues the answer's content on `span` as its output message. */
export function captureModelAnswer(span: InstrumentationSpan, build: () => Part[]): void {
  if (span.capturesContent !== true || !span.addContent) return;
  try {
    span.addContent("output_messages", build());
  } catch {
    // As above: never fails the call.
  }
}

/**
 * How much of a streamed answer is kept (text, and each tool call's arguments): no exported attribute is longer, so
 * what is past it would be cut anyway.
 */
export const STREAMED_ANSWER_MAX_CHARS = 1024 * 1024;

function appendBounded(current: string, delta: string): string {
  if (current.length >= STREAMED_ANSWER_MAX_CHARS) return current;
  return current + delta.slice(0, STREAMED_ANSWER_MAX_CHARS - current.length);
}

/** Collects a streamed answer's text and tool calls, for its output message. */
export class StreamedAnswer {
  private text = "";
  private readonly calls = new Map<string, { id?: string; name: string; arguments?: string }>();
  private lastKey: string | undefined;

  addText(delta: string): void {
    this.text = appendBounded(this.text, delta);
  }

  addToolCall(delta: { index?: number; toolCallId?: string; name?: string; argumentsDelta?: string }): void {
    const key = delta.index !== undefined ? `i${delta.index}` : delta.toolCallId ? `c${delta.toolCallId}` : (this.lastKey ?? "i0");
    this.lastKey = key;
    const call: { id?: string; name: string; arguments?: string } = this.calls.get(key) ?? { name: "" };
    if (delta.toolCallId) call.id = delta.toolCallId;
    if (delta.name) call.name = delta.name;
    if (delta.argumentsDelta) call.arguments = appendBounded(call.arguments ?? "", delta.argumentsDelta);
    if (!this.calls.has(key) && this.calls.size >= 128) return;
    this.calls.set(key, call);
  }

  output(reason: LLMFinishReason | undefined): Part[] {
    const toolCalls = [...this.calls.values()].map((call) => {
      let parsed: Record<string, unknown> | string = call.arguments ?? "";
      try {
        const value: unknown = JSON.parse(call.arguments ?? "");
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch {
        // Partial or invalid JSON stays as the text the model sent.
      }
      return { id: call.id ?? "", name: call.name, arguments: parsed as Record<string, unknown> };
    });
    return genAiOutputMessages({ content: this.text, toolCalls, ...(reason ? { finishReason: reason } : {}) });
  }
}
