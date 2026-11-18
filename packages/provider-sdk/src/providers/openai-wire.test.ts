import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@ai-orchestrator/shared";
import type { LLMStreamChunk } from "../types";
import { LLMProviderError } from "../resilient-fetch";
import { OpenAICompatibleProviderAdapter } from "./openai-compatible";
import { OllamaProviderAdapter } from "./ollama";
import { readOpenAIStream } from "./openai-wire";

const ctx = { resolveSecret: async () => undefined };
const provider = { providerId: "openai_compatible", model: "local", baseUrl: "http://compat.test/v1" };
const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

function bodyResponse(text: string, contentType: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": contentType } });
}

function sse(events: string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join("");
}

function stubFetch(...responses: Response[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next;
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collect(stream: AsyncGenerator<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

async function failureOf(stream: AsyncGenerator<LLMStreamChunk>): Promise<Error | null> {
  return collect(stream).then(
    () => null,
    (error: unknown) => error as Error
  );
}

describe("a server that ignores stream:true", () => {
  it("reads a plain JSON chat completion as the answer", async () => {
    stubFetch(
      bodyResponse(
        JSON.stringify({ choices: [{ message: { content: "billing" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
        "application/json"
      )
    );
    const chunks = await collect(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(chunks).toEqual([
      { type: "text_delta", textDelta: "billing" },
      { type: "finish", reason: "stop" },
      { type: "usage", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } }
    ]);
  });

  it("reads pretty-printed JSON with blank lines and tool calls", async () => {
    const json = JSON.stringify(
      {
        choices: [
          {
            message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] }
          }
        ]
      },
      null,
      2
    ).replace("\n", "\n\n");
    stubFetch(bodyResponse(json, "application/json"));
    const chunks = await collect(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(chunks).toEqual([
      { type: "tool_call_delta", index: 0, toolCallId: "c1", name: "lookup", argumentsDelta: "{\"q\":\"x\"}" },
      { type: "finish", reason: "tool_calls" }
    ]);
  });

  it("counts as an orderly end under strictStream", async () => {
    stubFetch(bodyResponse(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), "application/json"));
    const chunks = await collect(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages, options: { strictStream: true } }, ctx));
    expect(chunks[0]).toEqual({ type: "text_delta", textDelta: "ok" });
  });

  it("applies to the Ollama adapter too", async () => {
    stubFetch(bodyResponse(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), "application/json"));
    const chunks = await collect(
      new OllamaProviderAdapter().generateStream!({ provider: { providerId: "ollama", model: "m", baseUrl: "http://ollama.test/v1" }, messages }, ctx)
    );
    expect(chunks[0]).toEqual({ type: "text_delta", textDelta: "hello" });
  });

  it("fails on a JSON error body, without the upstream's text", async () => {
    stubFetch(bodyResponse(JSON.stringify({ error: { message: "secret host down" } }), "application/json"));
    const failure = await failureOf(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(failure).toBeInstanceOf(LLMProviderError);
    expect(failure!.message).toContain("with an error");
    expect(failure!.message).not.toContain("secret host");
  });

  it("fails on a body that is neither a stream nor a completion", async () => {
    stubFetch(bodyResponse("<html>gateway</html>", "text/html"));
    const failure = await failureOf(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(failure).toBeInstanceOf(LLMProviderError);
    expect(failure!.message).toContain("neither a stream nor a chat completion");
  });
});

describe("an empty stream", () => {
  it("fails on an empty body instead of answering with empty text", async () => {
    stubFetch(bodyResponse("", "text/event-stream"));
    const failure = await failureOf(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(failure).toBeInstanceOf(LLMProviderError);
    expect(failure!.message).toContain("empty stream");
  });

  it("fails on events that carry no text, tool call or finish reason", async () => {
    stubFetch(bodyResponse(sse([JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }), "[DONE]"]), "text/event-stream"));
    const failure = await failureOf(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(failure).toBeInstanceOf(LLMProviderError);
    expect(failure!.message).toContain("without any answer");
  });

  it("accepts a finish reason with no text (the model chose to say nothing)", async () => {
    stubFetch(bodyResponse(sse([JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }), "[DONE]"]), "text/event-stream"));
    const chunks = await collect(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(chunks).toEqual([{ type: "finish", reason: "length" }]);
  });

  it("still reads a normal stream unchanged", async () => {
    stubFetch(
      bodyResponse(
        sse([JSON.stringify({ choices: [{ delta: { content: "a" } }] }), JSON.stringify({ choices: [{ delta: { content: "b" }, finish_reason: "stop" }] }), "[DONE]"]),
        "text/event-stream"
      )
    );
    const chunks = await collect(new OpenAICompatibleProviderAdapter().generateStream!({ provider, messages }, ctx));
    expect(chunks).toEqual([
      { type: "text_delta", textDelta: "a" },
      { type: "text_delta", textDelta: "b" },
      { type: "finish", reason: "stop" }
    ]);
  });

  it("reads a plain body split across many reads", async () => {
    const json = JSON.stringify({ choices: [{ message: { content: "split answer" } }] });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < json.length; at += 7) controller.enqueue(encoder.encode(json.slice(at, at + 7)));
        controller.close();
      }
    });
    const chunks = await collect(
      readOpenAIStream(body, { idleTimeoutMs: 5_000, provider: "openai_compatible", timeoutMessage: "stalled" })
    );
    expect(chunks[0]).toEqual({ type: "text_delta", textDelta: "split answer" });
  });
});
