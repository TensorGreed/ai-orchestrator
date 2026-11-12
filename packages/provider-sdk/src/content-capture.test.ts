import { describe, expect, it } from "vitest";
import {
  NOOP_RUN_INSTRUMENTATION,
  type InstrumentationContentKind,
  type InstrumentationSpan,
  type LLMCallResponse,
  type ModelCallSpanInfo,
  type RunInstrumentation
} from "@ai-orchestrator/shared";
import { STREAMED_ANSWER_MAX_CHARS, StreamedAnswer, genAiInputMessages, genAiOutputMessages, genAiSystemInstructions, genAiToolDefinitions } from "./content-capture";
import { createInstrumentedProviderRegistry } from "./instrumented-registry";
import { ProviderRegistry } from "./registry";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "./types";

/** A RunInstrumentation whose model spans record the content handed to them (when `captures`). */
function recorder(captures: boolean) {
  const content: Array<{ kind: InstrumentationContentKind; value: unknown }> = [];
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    capturesContent: captures,
    async modelCall<T>(_info: ModelCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
      const span: InstrumentationSpan = {
        recording: true,
        traceId: "t".repeat(32),
        spanId: "s".repeat(16),
        setAttributes: () => undefined,
        recordError: () => undefined,
        keepOpen: () => undefined,
        end: () => undefined,
        capturesContent: captures,
        addContent: (kind, value) => {
          if (!captures) throw new Error("content handed over while capture is off");
          content.push({ kind, value: JSON.parse(JSON.stringify(value)) });
        }
      };
      return await fn(span);
    }
  };
  return { instrument, content };
}

const context: ProviderExecutionContext = { resolveSecret: async () => undefined };

const request: ProviderCallRequest = {
  provider: { providerId: "scripted", model: "m-1" },
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Weather in Paris?", images: [{ data: "AAAA", mimeType: "image/png" }] },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "get_weather", arguments: { location: "Paris" } }] },
    { role: "tool", content: "rainy", toolCallId: "call_1", name: "get_weather" }
  ],
  tools: [{ name: "get_weather", description: "Weather", inputSchema: { type: "object" } }]
};

class Scripted implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  constructor(
    private readonly answer: () => LLMCallResponse = () => ({ content: "Rainy, 57F.", toolCalls: [], finishReason: "stop" }),
    private readonly chunks: LLMStreamChunk[] = []
  ) {}
  async generate(): Promise<LLMCallResponse> {
    return this.answer();
  }
  async *generateStream(): AsyncGenerator<LLMStreamChunk> {
    for (const chunk of this.chunks) yield chunk;
  }
}

function registryWith(adapter: LLMProviderAdapter, instrument: RunInstrumentation) {
  const base = new ProviderRegistry();
  base.register(adapter);
  return createInstrumentedProviderRegistry(base, { instrument });
}

describe("model call content in GenAI shapes", () => {
  it("maps messages, system instructions, tool definitions and answers to the v1.41.0 JSON shapes", () => {
    expect(genAiSystemInstructions(request.messages)).toEqual([{ type: "text", content: "Be brief." }]);
    expect(genAiInputMessages(request.messages)).toEqual([
      { role: "user", parts: [{ type: "text", content: "Weather in Paris?" }, { type: "image", mime_type: "image/png" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "get_weather", arguments: { location: "Paris" } }] },
      { role: "tool", parts: [{ type: "tool_call_response", id: "call_1", response: "rainy" }], name: "get_weather" }
    ]);
    expect(genAiToolDefinitions(request.tools!)).toEqual([{ type: "function", name: "get_weather", description: "Weather", parameters: { type: "object" } }]);
    expect(genAiOutputMessages({ content: "", toolCalls: [{ id: "c", name: "n", arguments: {} }] })).toEqual([
      { role: "assistant", parts: [{ type: "tool_call", id: "c", name: "n", arguments: {} }], finish_reason: "tool_call" }
    ]);
  });

  it("never copies image data", () => {
    expect(JSON.stringify(genAiInputMessages(request.messages))).not.toContain("AAAA");
  });
});

describe("instrumented registry content capture", () => {
  it("hands nothing over while capture is off", async () => {
    const { instrument, content } = recorder(false);
    await registryWith(new Scripted(), instrument).get("scripted").generate(request, context);
    expect(content).toEqual([]);
  });

  it("hands the request and the answer to the span while capture is on", async () => {
    const { instrument, content } = recorder(true);
    await registryWith(new Scripted(), instrument).get("scripted").generate(request, context);
    expect(content.map((entry) => entry.kind)).toEqual(["system_instructions", "input_messages", "tool_definitions", "output_messages"]);
    expect(content[3]!.value).toEqual([{ role: "assistant", parts: [{ type: "text", content: "Rainy, 57F." }], finish_reason: "stop" }]);
  });

  it("records no answer for a failed call and still fails it with the provider's error", async () => {
    const { instrument, content } = recorder(true);
    const failing = new Scripted(() => {
      throw new Error("upstream down");
    });
    await expect(registryWith(failing, instrument).get("scripted").generate(request, context)).rejects.toThrow("upstream down");
    expect(content.map((entry) => entry.kind)).not.toContain("output_messages");
  });

  it("assembles a streamed answer's text and tool calls", async () => {
    const { instrument, content } = recorder(true);
    const streaming = new Scripted(undefined, [
      { type: "text_delta", textDelta: "Checking " },
      { type: "text_delta", textDelta: "now." },
      { type: "tool_call_delta", index: 0, toolCallId: "call_9", name: "get_weather", argumentsDelta: '{"loca' },
      { type: "tool_call_delta", index: 0, argumentsDelta: 'tion":"Paris"}' },
      { type: "finish", reason: "tool_calls" }
    ]);
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of registryWith(streaming, instrument).get("scripted").generateStream!(request, context)) chunks.push(chunk);
    expect(chunks).toHaveLength(5);
    expect(content.at(-1)).toEqual({
      kind: "output_messages",
      value: [
        {
          role: "assistant",
          parts: [
            { type: "text", content: "Checking now." },
            { type: "tool_call", id: "call_9", name: "get_weather", arguments: { location: "Paris" } }
          ],
          finish_reason: "tool_call"
        }
      ]
    });
  });

  it("never fails a model call when handing over content throws", async () => {
    const { instrument } = recorder(true);
    const throwing: RunInstrumentation = {
      ...instrument,
      modelCall: (info, fn) =>
        instrument.modelCall(info, (span) =>
          fn({
            ...span,
            addContent: () => {
              throw new Error("capture broke");
            }
          })
        )
    };
    const answer = await registryWith(new Scripted(), throwing).get("scripted").generate(request, context);
    expect(answer.content).toBe("Rainy, 57F.");
  });

  it("keeps at most STREAMED_ANSWER_MAX_CHARS of a streamed answer", () => {
    const answer = new StreamedAnswer();
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 40; i += 1) answer.addText(chunk);
    const text = (answer.output("stop")[0] as { parts: Array<{ content: string }> }).parts[0]!.content;
    expect(text.length).toBe(STREAMED_ANSWER_MAX_CHARS);
  });
});
