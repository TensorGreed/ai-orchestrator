import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@ai-orchestrator/shared";
import type { LLMStreamChunk } from "./types";
import { OpenAICloudProviderAdapter } from "./providers/openai";
import { OpenAICompatibleProviderAdapter } from "./providers/openai-compatible";
import { AzureOpenAIProviderAdapter } from "./providers/azure-openai";
import { AnthropicProviderAdapter } from "./providers/anthropic";
import { GeminiProviderAdapter } from "./providers/gemini";
import { providerCallOptionSupport, unsupportedCallOptions } from "./call-options";
import { ModelTapeRecorder, recordingProviderAdapter } from "./model-tape";
import { LLMProviderError } from "./resilient-fetch";

const ctx = { resolveSecret: async () => "test-key" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return next;
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } };

async function collect(stream: AsyncGenerator<LLMStreamChunk>): Promise<LLMStreamChunk[]> {
  const out: LLMStreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("OpenAI-family request parameters", () => {
  it("sends exactly the old body without options", async () => {
    const calls = stubFetch(jsonResponse(200, { choices: [{ message: { content: "hi" } }] }));
    const answer = await new OpenAICloudProviderAdapter().generate(
      { provider: { providerId: "openai", model: "gpt-4o" }, messages: [{ role: "user", content: "hello" }], tools: [tool] },
      ctx
    );
    expect(calls[0]!.body).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "lookup", description: "Look up", parameters: tool.inputSchema } }],
      tool_choice: "auto"
    });
    expect(answer.finishReason).toBe("stop");
  });

  it("forwards every option and leaves the adapter defaults out with providerDefaults", async () => {
    const calls = stubFetch(
      jsonResponse(200, {
        choices: [{ finish_reason: "length", message: { content: "{\"a\":" } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
      })
    );
    const answer = await new OpenAICompatibleProviderAdapter().generate(
      {
        provider: { providerId: "openai_compatible", model: "m", baseUrl: "http://upstream.test/v1/" },
        messages: [{ role: "user", content: "hello" }],
        tools: [tool],
        options: {
          providerDefaults: true,
          topP: 0.5,
          stop: ["END"],
          seed: 7,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          user: "end-user-1",
          toolChoice: { name: "lookup" },
          parallelToolCalls: false,
          responseFormat: { type: "json_schema", jsonSchema: { name: "out", schema: { type: "object" }, strict: true } }
        }
      },
      ctx
    );
    const body = calls[0]!.body;
    expect(calls[0]!.url).toBe("http://upstream.test/v1/chat/completions");
    expect(body.temperature).toBeUndefined();
    expect(body).toMatchObject({
      top_p: 0.5,
      stop: ["END"],
      seed: 7,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      user: "end-user-1",
      tool_choice: { type: "function", function: { name: "lookup" } },
      parallel_tool_calls: false,
      response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } }
    });
    expect(answer.finishReason).toBe("length");
    expect(answer.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  });

  it("reports tool_calls when the model asked for a tool", async () => {
    stubFetch(
      jsonResponse(200, {
        choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] } }]
      })
    );
    const answer = await new OpenAICloudProviderAdapter().generate(
      { provider: { providerId: "openai", model: "gpt-4o" }, messages: [{ role: "user", content: "hello" }], tools: [tool] },
      ctx
    );
    expect(answer.finishReason).toBe("tool_calls");
    expect(answer.toolCalls).toEqual([{ id: "c1", name: "lookup", arguments: { q: "x" } }]);
  });

  it("streams finish, usage and tool-call indexes, and asks for usage only when told to", async () => {
    const calls = stubFetch(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "lookup", arguments: "{\"q\"" } }] } }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }),
        "[DONE]"
      ]),
      sseResponse(["[DONE]"])
    );
    const chunks = await collect(
      new OpenAICloudProviderAdapter().generateStream(
        { provider: { providerId: "openai", model: "gpt-4o" }, messages: [{ role: "user", content: "hi" }], options: { streamUsage: true } },
        ctx
      )
    );
    expect(calls[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(chunks).toEqual([
      { type: "text_delta", textDelta: "Hel" },
      { type: "text_delta", textDelta: "lo" },
      { type: "tool_call_delta", index: 0, toolCallId: "c1", name: "lookup", argumentsDelta: "{\"q\"" },
      { type: "tool_call_delta", index: 0, toolCallId: undefined, name: undefined, argumentsDelta: ":1}" },
      { type: "finish", reason: "tool_calls" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
    ]);
    await collect(new OpenAICloudProviderAdapter().generateStream({ provider: { providerId: "openai", model: "gpt-4o" }, messages: [{ role: "user", content: "hi" }] }, ctx));
    expect(calls[1]!.body.stream_options).toBeUndefined();
  });

  it("Azure keeps a workflow run's body: no options, so an image in the message is not sent", async () => {
    const provider = { providerId: "azure_openai", model: "dep1", baseUrl: "https://x.openai.azure.com" };
    const messages: ChatMessage[] = [{ role: "user", content: "look", images: [{ data: "AAAA", mimeType: "image/png" }] }];
    const calls = stubFetch(jsonResponse(200, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), sseResponse(["[DONE]"]));
    await new AzureOpenAIProviderAdapter().generate({ provider, messages }, ctx);
    await collect(new AzureOpenAIProviderAdapter().generateStream({ provider, messages }, ctx));
    expect(calls[0]!.body).toEqual({ messages: [{ role: "user", content: "look" }], temperature: 0.2 });
    expect(calls[1]!.body).toEqual({ messages: [{ role: "user", content: "look" }], temperature: 0.2, stream: true });
  });

  it("Azure sends images only for a caller that opts in, and keeps them out with other options set", async () => {
    const reply = () => jsonResponse(200, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    const calls = stubFetch(reply(), reply());
    const answer = await new AzureOpenAIProviderAdapter().generate(
      {
        provider: { providerId: "azure_openai", model: "dep1", baseUrl: "https://x.openai.azure.com" },
        messages: [{ role: "user", content: "look", images: [{ data: "AAAA", mimeType: "image/png" }] }],
        options: { seed: 3, responseFormat: { type: "json_object" }, images: true }
      },
      ctx
    );
    expect(calls[0]!.url).toContain("/openai/deployments/dep1/chat/completions");
    expect(calls[0]!.body).toMatchObject({ seed: 3, response_format: { type: "json_object" }, temperature: 0.2 });
    expect((calls[0]!.body.messages as Array<{ content: unknown }>)[0]!.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    ]);
    expect(answer.finishReason).toBe("stop");
    await new AzureOpenAIProviderAdapter().generate(
      {
        provider: { providerId: "azure_openai", model: "dep1", baseUrl: "https://x.openai.azure.com" },
        messages: [{ role: "user", content: "look", images: [{ data: "AAAA", mimeType: "image/png" }] }],
        options: { seed: 3 }
      },
      ctx
    );
    expect((calls[1]!.body.messages as Array<{ content: unknown }>)[0]!.content).toBe("look");
  });
});

describe("failures inside a stream", () => {
  const frame = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });
  const provider = { providerId: "openai", model: "gpt-4o" };
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("stays silent for a workflow run: no option, so an error frame or a bare end reads as it always did", async () => {
    stubFetch(sseResponse([frame("partial "), JSON.stringify({ error: { message: "overloaded" } })]), sseResponse([frame("partial ")]));
    const expected = [{ type: "text_delta", textDelta: "partial " }];
    expect(await collect(new OpenAICloudProviderAdapter().generateStream({ provider, messages }, ctx))).toEqual(expected);
    expect(await collect(new OpenAICloudProviderAdapter().generateStream({ provider, messages }, ctx))).toEqual(expected);
  });

  it.each([
    ["an error frame", [frame("a"), JSON.stringify({ error: { message: "secret host" } })]],
    ["an error object frame", [frame("a"), JSON.stringify({ object: "error", message: "secret host" })]],
    ["a bare end", [frame("a")]]
  ])("with strictStream throws on %s, with no upstream text", async (_name, events) => {
    stubFetch(sseResponse(events));
    const chunks: LLMStreamChunk[] = [];
    const run = async () => {
      for await (const chunk of new OpenAICloudProviderAdapter().generateStream({ provider, messages, options: { strictStream: true } }, ctx)) chunks.push(chunk);
    };
    const failure = await run().then(() => null, (error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(LLMProviderError);
    expect(failure!.message).not.toContain("secret host");
    expect(chunks).toEqual([{ type: "text_delta", textDelta: "a" }]);
  });

  it("with strictStream accepts each normal ending", async () => {
    const options = { strictStream: true };
    const usage = JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const finished = (reason: string) => JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] });
    stubFetch(sseResponse([frame("a"), "[DONE]"]), sseResponse([frame("a"), finished("stop")]), sseResponse([frame("a"), finished("eos")]), sseResponse([frame("a"), usage]));
    for (let call = 0; call < 4; call += 1) {
      const chunks = await collect(new OpenAICloudProviderAdapter().generateStream({ provider, messages, options }, ctx));
      expect(chunks[0]).toEqual({ type: "text_delta", textDelta: "a" });
    }
  });

  it("Azure honours strictStream too", async () => {
    stubFetch(sseResponse([frame("a")]));
    await expect(
      collect(new AzureOpenAIProviderAdapter().generateStream({ provider: { providerId: "azure_openai", model: "dep1", baseUrl: "https://x.openai.azure.com" }, messages, options: { strictStream: true } }, ctx))
    ).rejects.toBeInstanceOf(LLMProviderError);
  });
});

describe("Anthropic and Gemini request parameters", () => {
  it("Anthropic maps stop, top_p, tool_choice and finish reasons", async () => {
    const calls = stubFetch(
      jsonResponse(200, { content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 2 } })
    );
    const answer = await new AnthropicProviderAdapter().generate(
      {
        provider: { providerId: "anthropic", model: "claude-sonnet-4-6" },
        messages: [{ role: "user", content: "hi" }],
        tools: [tool],
        options: { stop: ["X"], topP: 0.9, toolChoice: "required", parallelToolCalls: false, user: "u1" }
      },
      ctx
    );
    expect(calls[0]!.body).toMatchObject({ stop_sequences: ["X"], top_p: 0.9, tool_choice: { type: "any", disable_parallel_tool_use: true }, metadata: { user_id: "u1" } });
    expect(answer.finishReason).toBe("length");
  });

  it("Gemini maps JSON mode, tool choice and omits its 1024-token default with providerDefaults", async () => {
    const calls = stubFetch(jsonResponse(200, { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "" }] } }] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answer = await new GeminiProviderAdapter().generate(
      {
        provider: { providerId: "gemini", model: "gemini-2.0-flash" },
        messages: [{ role: "user", content: "hi" }],
        tools: [tool],
        options: { providerDefaults: true, responseFormat: { type: "json_object" }, toolChoice: "none", seed: 1, stop: ["Z"] }
      },
      ctx
    );
    warn.mockRestore();
    expect(calls[0]!.body.generationConfig).toEqual({ responseMimeType: "application/json", seed: 1, stopSequences: ["Z"] });
    expect(calls[0]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(answer.finishReason).toBe("content_filter");
  });
});

describe("providerCallOptionSupport", () => {
  it("lists what each provider would drop", () => {
    expect(unsupportedCallOptions("openai", { seed: 1, toolChoice: "required", responseFormat: { type: "json_object" } }, { hasImages: true })).toEqual([]);
    expect(unsupportedCallOptions("anthropic", { seed: 1, responseFormat: { type: "json_object" }, toolChoice: "required" }, { hasImages: true })).toEqual([
      "seed",
      "response_format",
      "image_url"
    ]);
    expect(unsupportedCallOptions("anthropic", { responseFormat: { type: "text" }, toolChoice: "auto" })).toEqual([]);
    expect(unsupportedCallOptions("community_x", { topP: 1 }, { hasTools: true })).toEqual(["top_p", "tools"]);
    expect(unsupportedCallOptions("echo", {}, { hasTools: true })).toEqual([]);
    expect(providerCallOptionSupport("ollama").streaming).toBe(true);
    expect(providerCallOptionSupport("gemini").streaming).toBe(false);
  });
});

describe("model tape and the new stream chunks", () => {
  it("records finish and usage chunks into the answer, not as tool calls", async () => {
    const recorder = new ModelTapeRecorder();
    const base = {
      definition: { id: "fake", label: "Fake", supportsTools: true, configSchema: {} },
      generate: async () => ({ content: "", toolCalls: [] }),
      async *generateStream(): AsyncGenerator<LLMStreamChunk> {
        yield { type: "text_delta", textDelta: "a" };
        yield { type: "finish", reason: "stop" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    };
    const wrapped = recordingProviderAdapter(base, recorder);
    await collect(wrapped.generateStream!({ provider: { providerId: "fake", model: "m" }, messages: [{ role: "user", content: "x" }] }, ctx));
    const entry = recorder.toTape().entries[0]!;
    expect(entry.response).toMatchObject({ content: "a", toolCalls: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } });
  });
});
