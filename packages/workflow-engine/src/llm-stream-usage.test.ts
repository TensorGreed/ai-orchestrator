import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAgentRuntime } from "@ai-orchestrator/agent-runtime";
import { createDefaultConnectorRegistry } from "@ai-orchestrator/connector-sdk";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import {
  createDefaultProviderRegistry,
  createModelTapeRecordingRegistry,
  createModelTapeReplayRegistry,
  estimateTextTokens,
  ModelTapeRecorder,
  type ProviderRegistry
} from "@ai-orchestrator/provider-sdk";
import type { LLMProviderConfig, Workflow } from "@ai-orchestrator/shared";
import { executeWorkflow } from "./executor";

const position = { x: 0, y: 0 };
const ANSWER = "Hello there";

function workflowFor(provider: LLMProviderConfig): Workflow {
  return {
    id: "wf-stream-usage",
    name: "Stream usage",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position, config: { text: "Say hello" } },
      { id: "llm", type: "llm_call", name: "LLM", position, config: { provider, retry: { enabled: false, maxAttempts: 1, delayMs: 1 } } },
      { id: "output", type: "output", name: "Output", position, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

function sseResponse(frames: string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** An OpenAI-family stream of `ANSWER` in two deltas, with the usage frame when given. */
function openAIStream(usage?: Record<string, number>): Response {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hello " } }] }),
    JSON.stringify({ choices: [{ delta: { content: "there" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ...(usage ? [JSON.stringify({ choices: [], usage })] : []),
    "[DONE]"
  ]);
}

/** Answers every request with `response()`, or with the queued responses first when `first` is given. */
function stubFetch(response: () => Response, ...first: Response[]) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return first.shift() ?? response();
    })
  );
  return bodies;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

async function runLlm(
  provider: LLMProviderConfig,
  options: { stream: boolean; logger?: (message: string, metadata?: unknown) => void; expectError?: boolean; registry?: ProviderRegistry }
) {
  const deltas: string[] = [];
  const result = await executeWorkflow(
    { workflow: workflowFor(provider) },
    {
      providerRegistry: options.registry ?? createDefaultProviderRegistry(),
      connectorRegistry: createDefaultConnectorRegistry(),
      mcpRegistry: createDefaultMCPRegistry(),
      agentRuntime: createDefaultAgentRuntime(),
      resolveSecret: async () => "test-key",
      ...(options.stream ? { onLLMDelta: (event: { delta: string }) => void deltas.push(event.delta) } : {}),
      ...(options.logger ? { logger: options.logger } : {})
    }
  );
  const node = result.nodeResults.find((entry) => entry.nodeId === "llm")!;
  expect(node.status, node.error).toBe(options.expectError ? "error" : "success");
  const output = (node.output ?? {}) as { answer: string; _telemetry: { providerId: string; model: string; usage: Record<string, number>; usageEstimated?: boolean } };
  return { output, telemetry: output._telemetry, deltas, error: node.error };
}

const secretRef = { secretId: "s" };
// `asksByDefault`: OpenAI and Azure OpenAI ask for the usage frame unless told not to; compatible servers and Ollama
// only when the model sets `extra.streamUsage: true`.
const OPENAI_FAMILY: Array<{ label: string; provider: LLMProviderConfig; asksByDefault: boolean }> = [
  { label: "openai", provider: { providerId: "openai", model: "gpt-4o-mini", secretRef }, asksByDefault: true },
  { label: "openai_compatible", provider: { providerId: "openai_compatible", model: "local-model", baseUrl: "http://compat.test/v1" }, asksByDefault: false },
  { label: "ollama", provider: { providerId: "ollama", model: "llama3.1" }, asksByDefault: false },
  { label: "azure_openai", provider: { providerId: "azure_openai", model: "prod-4o", baseUrl: "https://x.openai.azure.com", secretRef }, asksByDefault: true }
];

/** The model with `extra.streamUsage: true`, so every adapter asks for the usage frame. */
const asking = (provider: LLMProviderConfig): LLMProviderConfig => ({ ...provider, extra: { ...provider.extra, streamUsage: true } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamed llm_call usage", () => {
  for (const { label, provider: base, asksByDefault } of OPENAI_FAMILY) {
    describe(label, () => {
      it(asksByDefault ? "asks for the usage frame by default" : "leaves stream_options out by default and estimates", async () => {
        const bodies = stubFetch(() => openAIStream());
        const { telemetry } = await runLlm(base, { stream: true });
        if (asksByDefault) expect(bodies[0]).toMatchObject({ stream_options: { include_usage: true } });
        else expect(bodies[0]).not.toHaveProperty("stream_options");
        expect(telemetry.usageEstimated).toBe(true);
      });

      const provider = asking(base);
      it("asks for the usage frame and records the provider's numbers", async () => {
        const bodies = stubFetch(() => openAIStream({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }));
        const { output, telemetry, deltas } = await runLlm(provider, { stream: true });
        expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
        expect(JSON.stringify(bodies[0]!.messages)).toContain("Say hello");
        expect(deltas).toEqual(["Hello ", "there"]);
        expect(output.answer).toBe(ANSWER);
        expect(telemetry).toMatchObject({ providerId: provider.providerId, model: provider.model, usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } });
        expect(telemetry.usageEstimated).toBeUndefined();
        expect(typeof (telemetry as { latencyMs?: unknown }).latencyMs).toBe("number");
      });

      it("estimates the usage when the stream ends without a usage frame, and flags it", async () => {
        stubFetch(() => openAIStream());
        const { telemetry } = await runLlm(provider, { stream: true });
        expect(telemetry.usageEstimated).toBe(true);
        expect(telemetry.usage.outputTokens).toBe(estimateTextTokens(ANSWER));
        expect(telemetry.usage.inputTokens).toBeGreaterThanOrEqual(estimateTextTokens("Say hello"));
        expect(telemetry.usage.totalTokens).toBe(telemetry.usage.inputTokens! + telemetry.usage.outputTokens!);
      });
    });
  }

  it("treats an all-zero usage frame as missing", async () => {
    stubFetch(() => openAIStream({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));
    const { telemetry } = await runLlm(asking(OPENAI_FAMILY[1]!.provider), { stream: true });
    expect(telemetry.usageEstimated).toBe(true);
    expect(telemetry.usage.totalTokens).toBeGreaterThan(0);
  });

  it("keeps the provider's input count and estimates only the missing output", async () => {
    stubFetch(() => openAIStream({ prompt_tokens: 40 }));
    const { telemetry } = await runLlm(OPENAI_FAMILY[0]!.provider, { stream: true });
    expect(telemetry.usage).toMatchObject({ inputTokens: 40, outputTokens: estimateTextTokens(ANSWER) });
    expect(telemetry.usageEstimated).toBe(true);
  });

  it("leaves stream_options out when the model sets extra.streamUsage to false, and estimates", async () => {
    const bodies = stubFetch(() => openAIStream());
    const { telemetry } = await runLlm({ providerId: "openai", model: "gpt-4o-mini", secretRef, extra: { streamUsage: false } }, { stream: true });
    expect(bodies[0]).toMatchObject({ stream: true });
    expect(bodies[0]).not.toHaveProperty("stream_options");
    expect(telemetry.usageEstimated).toBe(true);
    expect(telemetry.usage.outputTokens).toBe(estimateTextTokens(ANSWER));
  });

  it("does not send stream_options on a run that does not stream", async () => {
    const bodies = stubFetch(() =>
      jsonResponse({ choices: [{ message: { content: ANSWER }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })
    );
    const { telemetry } = await runLlm(OPENAI_FAMILY[0]!.provider, { stream: false });
    expect(bodies[0]).not.toHaveProperty("stream");
    expect(bodies[0]).not.toHaveProperty("stream_options");
    expect(telemetry.usage).toMatchObject({ inputTokens: 9, outputTokens: 3, totalTokens: 12 });
    expect(telemetry.usageEstimated).toBeUndefined();
  });

  it("estimates a non-streamed answer that came back without usage", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: ANSWER }, finish_reason: "stop" }] }));
    const { telemetry } = await runLlm(OPENAI_FAMILY[1]!.provider, { stream: false });
    expect(telemetry.usageEstimated).toBe(true);
    expect(telemetry.usage.outputTokens).toBe(estimateTextTokens(ANSWER));
  });
});

describe("a provider that refuses stream_options", () => {
  for (const status of [400, 422]) {
    it(`retries once without the field on a ${status}, estimates, warns, and leaves it out of later calls`, async () => {
      const provider: LLMProviderConfig = { providerId: "azure_openai", model: `old-api-${status}`, baseUrl: `https://refuses-${status}.openai.azure.com`, secretRef, extra: { apiVersion: "2024-02-01" } };
      const bodies = stubFetch(() => openAIStream(), errorResponse(status, "Unrecognized request argument supplied: stream_options"));
      const warnings: Array<{ message: string; metadata: unknown }> = [];
      const logger = (message: string, metadata?: unknown) => void warnings.push({ message, metadata });
      const { output, telemetry } = await runLlm(provider, { stream: true, logger });
      expect(output.answer).toBe(ANSWER);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toHaveProperty("stream_options");
      expect(bodies[1]).not.toHaveProperty("stream_options");
      expect(telemetry.usageEstimated).toBe(true);
      expect(telemetry.usage.outputTokens).toBe(estimateTextTokens(ANSWER));
      const warning = warnings.find((entry) => entry.message.includes("stream_options"));
      expect(warning?.metadata).toMatchObject({ nodeId: "llm", providerId: "azure_openai", status });

      // The next call to the same model and endpoint leaves the field out at once.
      await runLlm(provider, { stream: true });
      expect(bodies).toHaveLength(3);
      expect(bodies[2]).not.toHaveProperty("stream_options");
    });
  }

  it("fails as before when the retry is refused too, and remembers nothing", async () => {
    const provider: LLMProviderConfig = { providerId: "openai", model: "bad-request", baseUrl: "https://always-400.test/v1", secretRef };
    const bodies = stubFetch(
      () => openAIStream(),
      errorResponse(400, "Unrecognized request argument supplied: stream_options"),
      errorResponse(400, "Invalid value for temperature")
    );
    const node = await runLlm(provider, { stream: true, expectError: true, logger: () => undefined });
    expect(bodies).toHaveLength(2);
    expect(node.error).toContain("Invalid value for temperature");
    await runLlm(provider, { stream: true });
    expect(bodies[2]).toHaveProperty("stream_options");
  });

  it("does not retry a 400 or 422 that does not name the usage option, and remembers nothing", async () => {
    const provider: LLMProviderConfig = { providerId: "openai", model: "long-prompt", baseUrl: "https://context.test/v1", secretRef };
    const warnings: string[] = [];
    const bodies = stubFetch(
      () => openAIStream(),
      errorResponse(400, "This model's maximum context length is 128000 tokens. (context_length_exceeded)"),
      errorResponse(422, "messages.0.content: field required")
    );
    const first = await runLlm(provider, { stream: true, expectError: true, logger: (message) => void warnings.push(message) });
    expect(first.error).toContain("context_length_exceeded");
    await runLlm(provider, { stream: true, expectError: true, logger: (message) => void warnings.push(message) });
    expect(bodies).toHaveLength(2);
    expect(warnings.filter((message) => message.includes("stream_options"))).toEqual([]);
    await runLlm(provider, { stream: true });
    expect(bodies[2]).toHaveProperty("stream_options");
  });

  it("records only the retry on a model tape, so a run that went through it replays, strict and lenient", async () => {
    const provider: LLMProviderConfig = { providerId: "azure_openai", model: "taped", baseUrl: "https://taped.openai.azure.com", secretRef, extra: { apiVersion: "2024-02-01" } };
    const bodies = stubFetch(() => openAIStream(), errorResponse(400, "Unrecognized request argument supplied: stream_options"));
    const recorder = new ModelTapeRecorder();
    const recorded = await runLlm(provider, { stream: true, logger: () => undefined, registry: createModelTapeRecordingRegistry(createDefaultProviderRegistry(), recorder) });
    expect(recorded.output.answer).toBe(ANSWER);
    expect(bodies).toHaveLength(2);
    const tape = recorder.toTape();
    expect(tape.entries).toHaveLength(1);
    expect(tape.entries[0]).not.toHaveProperty("error");

    for (const mode of ["strict", "lenient"] as const) {
      const { registry, player } = createModelTapeReplayRegistry(tape, { mode });
      const replayed = await runLlm(provider, { stream: true, registry });
      expect(replayed.output.answer).toBe(ANSWER);
      expect(player.report()).toMatchObject({ matched: 1, live: 0, unmatched: [] });
    }
    expect(bodies).toHaveLength(2);
  });

  it("does not retry other failures, or a request that did not ask for usage", async () => {
    const bodies = stubFetch(() => openAIStream(), errorResponse(401, "bad key"), errorResponse(400, "stream_options is not supported"));
    await runLlm({ providerId: "openai", model: "m", baseUrl: "https://unauthorised.test/v1", secretRef }, { stream: true, expectError: true });
    await runLlm({ providerId: "openai_compatible", model: "m", baseUrl: "http://plain.test/v1" }, { stream: true, expectError: true });
    expect(bodies).toHaveLength(2);
  });
});

// Anthropic and Gemini have no streaming adapter: a streaming run calls them once and takes the usage of the answer.
describe("llm_call usage on providers without a streaming adapter", () => {
  const cases: Array<{ label: string; provider: LLMProviderConfig; withUsage: () => Response; withoutUsage: () => Response; usage: Record<string, number> }> = [
    {
      label: "anthropic",
      provider: { providerId: "anthropic", model: "claude-sonnet-4-5", secretRef },
      withUsage: () => jsonResponse({ content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn", usage: { input_tokens: 21, output_tokens: 4 } }),
      withoutUsage: () => jsonResponse({ content: [{ type: "text", text: ANSWER }], stop_reason: "end_turn" }),
      usage: { inputTokens: 21, outputTokens: 4 }
    },
    {
      label: "gemini",
      provider: { providerId: "gemini", model: "gemini-2.5-flash", secretRef },
      withUsage: () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 6, totalTokenCount: 21 }
        }),
      withoutUsage: () => jsonResponse({ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: "STOP" }] }),
      usage: { inputTokens: 15, outputTokens: 6 }
    }
  ];

  for (const entry of cases) {
    describe(entry.label, () => {
      it("records the provider's usage on a streaming run", async () => {
        stubFetch(entry.withUsage);
        const { output, telemetry } = await runLlm(entry.provider, { stream: true });
        expect(output.answer).toBe(ANSWER);
        expect(telemetry.usage).toMatchObject(entry.usage);
        expect(telemetry.usageEstimated).toBeUndefined();
      });

      it("estimates when the answer carries no usage", async () => {
        stubFetch(entry.withoutUsage);
        const { telemetry } = await runLlm(entry.provider, { stream: true });
        expect(telemetry.usageEstimated).toBe(true);
        expect(telemetry.usage.outputTokens).toBe(estimateTextTokens(ANSWER));
        expect(telemetry.usage.inputTokens).toBeGreaterThan(0);
      });
    });
  }
});
