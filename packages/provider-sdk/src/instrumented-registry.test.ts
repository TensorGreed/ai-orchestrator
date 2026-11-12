import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NOOP_RUN_INSTRUMENTATION,
  type InstrumentationAttributes,
  type InstrumentationSpan,
  type LLMCallResponse,
  type ModelCallObservation,
  type ModelCallSpanInfo,
  type RunInstrumentation,
  type TraceCarrier
} from "@ai-orchestrator/shared";
import { EmbeddingProviderRegistry, type EmbeddingProviderAdapter } from "./embeddings";
import { createGatedProviderRegistry, ModelNotAllowedError } from "./gated-registry";
import { createInstrumentedEmbeddingRegistry, createInstrumentedProviderRegistry, modelCallErrorType } from "./instrumented-registry";
import { ProviderRegistry } from "./registry";
import { resilientFetch } from "./resilient-fetch";
import type { LLMProviderAdapter, LLMStreamChunk, ProviderCallRequest, ProviderExecutionContext } from "./types";

/** A recording RunInstrumentation: model-call spans only, the way packages/otel runs them (end unless kept open). */
interface RecordedSpan {
  info: ModelCallSpanInfo;
  attributes: Record<string, unknown>;
  errors: Array<{ error: unknown; type?: string }>;
  kept: boolean;
  ended: boolean;
}

function recorder(options: { inject?: boolean } = {}) {
  const spans: RecordedSpan[] = [];
  const instrument: RunInstrumentation = {
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    async modelCall<T>(info: ModelCallSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
      const record: RecordedSpan = { info, attributes: {}, errors: [], kept: false, ended: false };
      spans.push(record);
      const span: InstrumentationSpan = {
        recording: true,
        traceId: "t".repeat(32),
        spanId: "s".repeat(16),
        setAttributes(attributes: InstrumentationAttributes) {
          for (const [key, value] of Object.entries(attributes)) if (value !== undefined && value !== null) record.attributes[key] = value;
        },
        recordError(error: unknown, opts?: { type?: string }) {
          record.errors.push({ error, ...(opts?.type ? { type: opts.type } : {}) });
        },
        keepOpen() {
          record.kept = true;
        },
        end() {
          record.ended = true;
        }
      };
      try {
        return await fn(span);
      } catch (error) {
        span.recordError(error);
        record.ended = true;
        throw error;
      } finally {
        if (!record.kept) record.ended = true;
      }
    },
    inject(carrier: TraceCarrier, target) {
      if (target !== "provider" || !options.inject) return false;
      carrier.traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      return true;
    }
  };
  return { instrument, spans };
}

const context: ProviderExecutionContext = { resolveSecret: async () => undefined };

const request = (overrides: Partial<ProviderCallRequest["provider"]> = {}): ProviderCallRequest => ({
  provider: { providerId: "scripted", model: "m-1", temperature: 0.3, maxTokens: 100, ...overrides },
  messages: [{ role: "user", content: "SECRET PROMPT TEXT" }]
});

class Scripted implements LLMProviderAdapter {
  readonly definition = { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} };
  contexts: ProviderExecutionContext[] = [];
  closed = false;
  constructor(
    private readonly answer: () => LLMCallResponse = () => ({
      content: "SECRET ANSWER TEXT",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 },
      raw: { id: "resp-9", model: "m-1-2026", choices: [{ message: { content: "SECRET ANSWER TEXT" } }] }
    }),
    private readonly chunks: LLMStreamChunk[] = [
      { type: "text_delta", textDelta: "SECRET " },
      { type: "text_delta", textDelta: "ANSWER" },
      { type: "finish", reason: "length" },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 2 } }
    ],
    private readonly failStreamAt?: number
  ) {}

  async generate(_request: ProviderCallRequest, ctx: ProviderExecutionContext): Promise<LLMCallResponse> {
    this.contexts.push(ctx);
    return this.answer();
  }

  async *generateStream(_request: ProviderCallRequest, ctx: ProviderExecutionContext): AsyncGenerator<LLMStreamChunk> {
    this.contexts.push(ctx);
    try {
      for (const [index, chunk] of this.chunks.entries()) {
        if (index === this.failStreamAt) throw Object.assign(new Error("upstream said SECRET DETAIL"), { category: "llm_provider_error" });
        yield chunk;
      }
    } finally {
      this.closed = true;
    }
  }
}

function registryWith(adapter: LLMProviderAdapter) {
  const base = new ProviderRegistry();
  base.register(adapter);
  return base;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("instrumented provider registry", () => {
  it("records a chat call: request facts, response ids, usage and finish reason, and reports it to the metrics", async () => {
    const { instrument, spans } = recorder();
    const observed: ModelCallObservation[] = [];
    let clock = 1000;
    const registry = createInstrumentedProviderRegistry(registryWith(new Scripted()), { instrument, observe: (o) => observed.push(o), now: () => (clock += 250) });
    const answer = await registry.get("scripted").generate(request({ baseUrl: "https://models.example.com:8443/v1?key=abc" }), context);
    expect(answer.content).toBe("SECRET ANSWER TEXT");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.info).toEqual({
      providerId: "scripted",
      model: "m-1",
      operation: "chat",
      stream: false,
      temperature: 0.3,
      maxTokens: 100,
      serverAddress: "models.example.com",
      serverPort: 8443
    });
    expect(spans[0]!.attributes).toEqual({
      "gen_ai.response.model": "m-1-2026",
      "gen_ai.response.id": "resp-9",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_read.input_tokens": 2,
      "gen_ai.response.finish_reasons": ["stop"]
    });
    expect(spans[0]!.ended).toBe(true);
    expect(observed).toEqual([
      {
        operation: "chat",
        stream: false,
        durationMs: 250,
        providerId: "scripted",
        requestModel: "m-1",
        responseModel: "m-1-2026",
        serverAddress: "models.example.com",
        serverPort: 8443,
        usage: { inputTokens: 12, outputTokens: 5, cachedInputTokens: 2 }
      }
    ]);
    // No content anywhere: not the prompt, not the answer.
    expect(JSON.stringify([spans, observed])).not.toContain("SECRET");
  });

  it("records a failure by its type only and rethrows it unchanged", async () => {
    const { instrument, spans } = recorder();
    const observed: ModelCallObservation[] = [];
    const failure = Object.assign(new Error("401 from upstream: key sk-live-123"), { category: "llm_provider_error" });
    const registry = createInstrumentedProviderRegistry(registryWith(new Scripted(() => { throw failure; })), { instrument, observe: (o) => observed.push(o) });
    await expect(registry.get("scripted").generate(request(), context)).rejects.toBe(failure);
    expect(spans[0]!.errors).toEqual([{ error: "", type: "llm_provider_error" }]);
    expect(observed[0]).toMatchObject({ errorType: "llm_provider_error" });
    expect(observed[0]!.usage).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain("sk-live-123");
  });

  it("records each call once through layered registries, and a refusal of the outer gate with its type", async () => {
    const { instrument, spans } = recorder();
    const scripted = new Scripted();
    const base = createInstrumentedProviderRegistry(registryWith(scripted), { instrument });
    let allowed = true;
    const gated = createGatedProviderRegistry(base, (call) => {
      if (!allowed) throw new ModelNotAllowedError("not on the list", { providerId: call.providerId, model: call.model, refusedBy: "project" });
    });
    const outer = createInstrumentedProviderRegistry(gated, { instrument });
    await outer.get("scripted").generate(request(), context);
    expect(spans).toHaveLength(1);
    // Calls straight to the base are recorded too (a view without the outer layer).
    await base.get("scripted").generate(request(), context);
    expect(spans).toHaveLength(2);

    allowed = false;
    await expect(outer.get("scripted").generate(request(), context)).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(spans).toHaveLength(3);
    expect(spans[2]!.errors).toEqual([{ error: "", type: "model_not_allowed" }]);
    // Streams too: the refusal is raised on the first read, inside the span.
    const chunks: LLMStreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of outer.get("scripted").generateStream!(request(), context)) chunks.push(chunk);
      })()
    ).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(spans).toHaveLength(4);
    expect(spans[3]).toMatchObject({ ended: true, errors: [{ error: "", type: "model_not_allowed" }] });
    expect(scripted.contexts).toHaveLength(2);
  });

  it("keeps a stream's span open until the stream ends, with the usage and finish reason of its last chunks", async () => {
    const { instrument, spans } = recorder();
    const observed: ModelCallObservation[] = [];
    const registry = createInstrumentedProviderRegistry(registryWith(new Scripted()), { instrument, observe: (o) => observed.push(o) });
    const stream = registry.get("scripted").generateStream!(request(), context);
    const first = await stream.next();
    expect(first.value).toEqual({ type: "text_delta", textDelta: "SECRET " });
    expect(spans[0]).toMatchObject({ kept: true, ended: false });
    const rest: LLMStreamChunk[] = [];
    for await (const chunk of stream) rest.push(chunk);
    expect(rest).toHaveLength(3);
    expect(spans[0]!.ended).toBe(true);
    expect(spans[0]!.info.stream).toBe(true);
    expect(spans[0]!.attributes).toEqual({
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 2,
      "gen_ai.response.finish_reasons": ["length"]
    });
    expect(spans[0]!.errors).toEqual([]);
    expect(observed[0]).toMatchObject({ operation: "chat", stream: true, usage: { inputTokens: 7, outputTokens: 2 } });
  });

  it("closes the provider stream and ends the span when the reader stops early", async () => {
    const { instrument, spans } = recorder();
    const scripted = new Scripted();
    const registry = createInstrumentedProviderRegistry(registryWith(scripted), { instrument });
    for await (const chunk of registry.get("scripted").generateStream!(request(), context)) {
      expect(chunk.type).toBe("text_delta");
      break;
    }
    expect(scripted.closed).toBe(true);
    expect(spans[0]).toMatchObject({ ended: true, errors: [] });
    expect(spans[0]!.attributes["l2m.stream.closed_early"]).toBe(true);
  });

  it("records a stream that fails mid-way by its type and passes the error on", async () => {
    const { instrument, spans } = recorder();
    const observed: ModelCallObservation[] = [];
    const registry = createInstrumentedProviderRegistry(registryWith(new Scripted(undefined, undefined, 1)), { instrument, observe: (o) => observed.push(o) });
    const seen: LLMStreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of registry.get("scripted").generateStream!(request(), context)) seen.push(chunk);
      })()
    ).rejects.toThrow("SECRET DETAIL");
    expect(seen).toHaveLength(1);
    expect(spans[0]).toMatchObject({ ended: true, errors: [{ error: "", type: "llm_provider_error" }] });
    expect(spans[0]!.attributes["l2m.stream.closed_early"]).toBeUndefined();
    expect(observed[0]).toMatchObject({ errorType: "llm_provider_error", stream: true });
  });

  it("passes a reader's throw() on to the provider stream and records it as a failure", async () => {
    const { instrument, spans } = recorder();
    const scripted = new Scripted();
    const registry = createInstrumentedProviderRegistry(registryWith(scripted), { instrument });
    const stream = registry.get("scripted").generateStream!(request(), context);
    await stream.next();
    const stop = Object.assign(new Error("reader gave up"), { category: "canceled" });
    await expect(stream.throw(stop)).rejects.toBe(stop);
    expect(scripted.closed).toBe(true);
    expect(spans[0]).toMatchObject({ ended: true, errors: [{ error: "", type: "canceled" }] });
    expect(spans[0]!.attributes["l2m.stream.closed_early"]).toBeUndefined();
  });

  it("keeps an allowlist refusal out of the metrics (nothing was sent)", async () => {
    const { instrument } = recorder();
    const observed: ModelCallObservation[] = [];
    const gated = createGatedProviderRegistry(registryWith(new Scripted()), (call) => {
      throw new ModelNotAllowedError("no", { providerId: call.providerId, model: call.model, refusedBy: "deployment" });
    });
    const registry = createInstrumentedProviderRegistry(gated, { instrument, observe: (o) => observed.push(o) });
    await expect(registry.get("scripted").generate(request(), context)).rejects.toBeInstanceOf(ModelNotAllowedError);
    expect(observed).toEqual([]);
  });

  it("adds trace headers only when propagation to providers is on, and counts retries", async () => {
    const off = recorder();
    const scripted = new Scripted();
    await createInstrumentedProviderRegistry(registryWith(scripted), { instrument: off.instrument }).get("scripted").generate(request(), context);
    expect(scripted.contexts[0]!.traceHeaders).toBeUndefined();

    const on = recorder({ inject: true });
    const retrying: LLMProviderAdapter = {
      definition: scripted.definition,
      async generate(_request, ctx) {
        ctx.onRetry?.({ attempt: 1, maxRetries: 3, delayMs: 1, reason: "status", status: 503 } as never);
        ctx.onRetry?.({ attempt: 2, maxRetries: 3, delayMs: 1, reason: "status", status: 503 } as never);
        scripted.contexts.push(ctx);
        return { content: "", toolCalls: [] };
      }
    };
    const callerRetries: unknown[] = [];
    await createInstrumentedProviderRegistry(registryWith(retrying), { instrument: on.instrument })
      .get("scripted")
      .generate(request(), { ...context, onRetry: (info) => callerRetries.push(info) });
    expect(scripted.contexts[1]!.traceHeaders).toEqual({ traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    expect(on.spans[0]!.attributes["l2m.retry.count"]).toBe(2);
    expect(callerRetries).toHaveLength(2);
  });

  it("runs the call untouched under the no-op instrumentation (metrics only)", async () => {
    const observed: ModelCallObservation[] = [];
    const scripted = new Scripted();
    const registry = createInstrumentedProviderRegistry(registryWith(scripted), { instrument: NOOP_RUN_INSTRUMENTATION, observe: (o) => observed.push(o) });
    await registry.get("scripted").generate(request(), context);
    expect(observed).toHaveLength(1);
    expect(scripted.contexts[0]!.traceHeaders).toBeUndefined();
  });

  it("passes provider tests and definitions through, and keeps unknown providers unknown", async () => {
    const { instrument, spans } = recorder();
    const adapter: LLMProviderAdapter = { ...new Scripted(), definition: new Scripted().definition, generate: async () => ({ content: "", toolCalls: [] }), testConnection: async () => ({ ok: true, message: "fine" }) };
    const registry = createInstrumentedProviderRegistry(registryWith(adapter), { instrument });
    expect(await registry.get("scripted").testConnection!({ providerId: "scripted", model: "m" }, context)).toEqual({ ok: true, message: "fine" });
    expect(spans).toHaveLength(0);
    expect(registry.listDefinitions().map((definition) => definition.id)).toEqual(["scripted"]);
    expect(registry.tryGet("nope")).toBeUndefined();
    expect(registry.get("scripted")).toBe(registry.get("scripted"));
  });

  it("names error types by category, then class, never by message", () => {
    expect(modelCallErrorType(Object.assign(new Error("x"), { category: "timeout" }))).toBe("timeout");
    expect(modelCallErrorType(new TypeError("fetch failed"))).toBe("TypeError");
    expect(modelCallErrorType(new Error("boom"))).toBe("_OTHER");
    expect(modelCallErrorType("text")).toBe("_OTHER");
  });
});

describe("instrumented embedding registry", () => {
  const embedder = (fail = false): EmbeddingProviderAdapter => ({
    id: "openai_compatible",
    async embed(input) {
      if (fail) throw Object.assign(new Error("bad SECRET"), { category: "llm_provider_error" });
      return { embeddings: input.input.map(() => [0.1, 0.2, 0.3]), usage: { inputTokens: 9, totalTokens: 9 }, model: "embed-2", latencyMs: 3 };
    }
  });

  it("records an embeddings span with dimensions and input tokens", async () => {
    const { instrument, spans } = recorder();
    const observed: ModelCallObservation[] = [];
    const base = new EmbeddingProviderRegistry();
    base.register(embedder());
    const registry = createInstrumentedEmbeddingRegistry(base, { instrument, observe: (o) => observed.push(o) });
    expect(registry.ids()).toEqual(["openai_compatible"]);
    const answer = await registry.get("openai_compatible").embed({ provider: { providerId: "openai_compatible", model: "embed-1", baseUrl: "http://10.0.0.5:4000/v1" }, input: ["SECRET a", "b"] }, context);
    expect(answer.embeddings).toHaveLength(2);
    expect(spans[0]!.info).toEqual({ providerId: "openai_compatible", model: "embed-1", operation: "embeddings", serverAddress: "10.0.0.5", serverPort: 4000 });
    expect(spans[0]!.attributes).toEqual({ "gen_ai.response.model": "embed-2", "gen_ai.usage.input_tokens": 9, "gen_ai.embeddings.dimension.count": 3 });
    expect(observed[0]).toMatchObject({ operation: "embeddings", usage: { inputTokens: 9 }, responseModel: "embed-2" });
    expect(JSON.stringify([spans, observed])).not.toContain("SECRET");
  });

  it("records a failed embeddings call by type", async () => {
    const { instrument, spans } = recorder();
    const base = new EmbeddingProviderRegistry();
    base.register(embedder(true));
    const registry = createInstrumentedEmbeddingRegistry(base, { instrument });
    await expect(registry.get("openai_compatible").embed({ provider: { providerId: "openai_compatible", model: "e" }, input: ["x"] }, context)).rejects.toThrow("bad SECRET");
    expect(spans[0]!.errors).toEqual([{ error: "", type: "llm_provider_error" }]);
    expect(registry.tryGet("missing")).toBeUndefined();
  });
});

describe("resilientFetch trace headers", () => {
  it("adds the trace headers the request does not set, and nothing without them", async () => {
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    });
    await resilientFetch("http://127.0.0.1:9/x", { headers: { authorization: "Bearer k" } }, { maxRetries: 0, traceHeaders: { traceparent: "00-a-b-01" } });
    await resilientFetch("http://127.0.0.1:9/x", { headers: { traceparent: "mine" } }, { maxRetries: 0, traceHeaders: { traceparent: "00-a-b-01" } });
    await resilientFetch("http://127.0.0.1:9/x", { headers: { authorization: "Bearer k" } }, { maxRetries: 0 });
    expect(seen[0]!.get("traceparent")).toBe("00-a-b-01");
    expect(seen[0]!.get("authorization")).toBe("Bearer k");
    expect(seen[1]!.get("traceparent")).toBe("mine");
    expect(seen[2]!.has("traceparent")).toBe(false);
  });
});
