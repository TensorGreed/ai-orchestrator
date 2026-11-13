import { afterEach, describe, expect, it } from "vitest";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { CONTENT_DROPPED_ATTRIBUTE } from "@ai-orchestrator/shared";
import {
  ContentDroppedError,
  INFERENCE_DETAILS_EVENT,
  createOtelRuntime,
  DEFAULT_BATCH_OPTIONS,
  snapshotContent,
  truncateContent,
  type ContentCaptureOptions,
  type ContentMasker,
  type OtelRuntime,
  type OtelRuntimeOptions
} from "./index.js";

const SECRET = "sk-live-0123456789abcdefSECRET";
const EMAIL = "alice@example.com";

let runtimes: OtelRuntime[] = [];

function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

/** A masker that replaces the planted email with a surrogate and the planted secret with [REDACTED]. */
const plantedMasker: ContentMasker = async (parts) => ({
  parts: parts.map((part) => ({
    id: part.id,
    value: JSON.parse(JSON.stringify(part.value).split(EMAIL).join("user_1a2b@surrogate.invalid").split(SECRET).join("[REDACTED]"))
  })),
  containsSecret: (text) => text.includes(SECRET)
});

function setup(content?: Partial<ContentCaptureOptions> | null, overrides: Partial<OtelRuntimeOptions> = {}) {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test" },
    export: null,
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: DEFAULT_BATCH_OPTIONS,
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    recentSpanLimit: 100,
    spanProcessors: [exportingAtOnce(exporter)],
    registerGlobals: false,
    ...(content === null ? {} : { content: { mode: "SPAN_ONLY", maxChars: 8192, masker: plantedMasker, ...content } }),
    ...overrides
  });
  runtimes.push(runtime);
  const spans = async () => {
    await runtime.forceFlush();
    return exporter.getFinishedSpans();
  };
  const one = async (name: string): Promise<ReadableSpan> => {
    const span = (await spans()).find((candidate) => candidate.name === name);
    if (!span) throw new Error(`no span ${name}`);
    return span;
  };
  // Content is captured only inside a scope that declared its sensitivity check; these tests work in one that says
  // "not sensitive" unless they open their own.
  const raw = runtime.instrumentation;
  const inScope = new Proxy(raw, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== "function" || key === "withContentExclusion") return typeof value === "function" ? value.bind(target) : value;
      return (...args: unknown[]) => target.withContentExclusion(() => false, () => (value as (...a: unknown[]) => unknown).apply(target, args));
    }
  });
  return { runtime, inst: inScope, raw, spans, one, exporter };
}

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  runtimes = [];
});

const MESSAGES = [{ role: "user", parts: [{ type: "text", content: `Mail ${EMAIL}, key ${SECRET}` }] }];

function contentKeys(span: ReadableSpan): string[] {
  return Object.keys(span.attributes).filter((key) => key.startsWith("gen_ai.input") || key.startsWith("gen_ai.output") || key.startsWith("gen_ai.tool.call") || key === "gen_ai.system_instructions" || key === "gen_ai.tool.definitions");
}

describe("content capture off", () => {
  it("accepts no content: spans keep exactly their usual attributes", async () => {
    const { inst, one } = setup(null);
    expect(inst.capturesContent).toBe(false);
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => {
      expect(span.capturesContent).toBe(false);
      span.addContent?.("input_messages", MESSAGES);
    });
    const span = await one("chat gpt-x");
    expect(contentKeys(span)).toEqual([]);
    expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain(EMAIL);
    // The exclusion wrapper only runs the function.
    expect(inst.withContentExclusion(() => true, () => 7)).toBe(7);
  });
});

describe("content capture on", () => {
  it("exports content only after masking, as GenAI JSON attributes", async () => {
    const { inst, one } = setup();
    expect(inst.capturesContent).toBe(true);
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => {
      expect(span.capturesContent).toBe(true);
      span.addContent?.("input_messages", MESSAGES);
      span.addContent?.("output_messages", [{ role: "assistant", parts: [{ type: "text", content: "ok" }], finish_reason: "stop" }]);
    });
    const span = await one("chat gpt-x");
    const input = JSON.parse(String(span.attributes["gen_ai.input.messages"]));
    expect(input[0].parts[0].content).toBe("Mail user_1a2b@surrogate.invalid, key [REDACTED]");
    expect(JSON.parse(String(span.attributes["gen_ai.output.messages"]))[0].finish_reason).toBe("stop");
    expect(JSON.stringify(span)).not.toContain(EMAIL);
    expect(JSON.stringify(span)).not.toContain(SECRET);
    expect(span.events.find((event) => event.name === INFERENCE_DETAILS_EVENT)).toBeUndefined();
  });

  it("copies content when it is handed over: later changes by the caller are not exported", async () => {
    const { inst, one } = setup();
    const args: Record<string, unknown> = { query: "first" };
    await inst.toolCall({ toolName: "search" }, async (span) => {
      span.addContent?.("tool_call_arguments", args);
      args.query = EMAIL;
    });
    expect(JSON.parse(String((await one("execute_tool search")).attributes["gen_ai.tool.call.arguments"]))).toEqual({ query: "first" });
  });

  it("keeps every other processor waiting until masking finished (recent spans included)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: ContentMasker = async (parts, options) => {
      await gate;
      return await plantedMasker(parts, options);
    };
    const { inst, exporter, runtime } = setup({ masker: slow });
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(runtime.recent()).toHaveLength(0);
    release();
    await runtime.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(JSON.stringify(runtime.recent())).not.toContain(EMAIL);
  });

  it("drops all content when masking fails, naming the reason", async () => {
    const cases: Array<[ContentMasker, string]> = [
      [async () => Promise.reject(new Error("boom")), "masking_failed"],
      [async () => Promise.reject(Object.assign(new Error("deep"), { name: "MaskUnscannableError" })), "unscannable"],
      [async () => Promise.reject(Object.assign(new Error("left"), { name: "MaskIncompleteError" })), "masking_incomplete"],
      [async () => Promise.reject(new ContentDroppedError("timeout")), "timeout"],
      [async () => Promise.reject(Object.assign(new Error("x"), { name: "ContentDroppedError", reason: "timeout" })), "timeout"],
      // A masker that loses a part, or leaves a secret the final check finds.
      [async () => ({ parts: [], containsSecret: () => false }), "masking_failed"],
      [async (parts) => ({ parts: [...parts], containsSecret: (text) => text.includes(SECRET) }), "secret_detected"]
    ];
    for (const [masker, reason] of cases) {
      const { inst, one } = setup({ masker });
      await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      const span = await one("chat gpt-x");
      expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe(reason);
      expect(contentKeys(span)).toEqual([]);
      expect(JSON.stringify(span)).not.toContain(EMAIL);
      expect(JSON.stringify(span)).not.toContain(SECRET);
    }
  });

  it("drops content the deployment scrubber still finds after masking", async () => {
    const { inst, one } = setup({ masker: async (parts) => ({ parts: [...parts], containsSecret: () => false }) }, { scrub: (text) => text.split(SECRET).join("[REDACTED]") });
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    const span = await one("chat gpt-x");
    expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("secret_detected");
    expect(JSON.stringify(span)).not.toContain(SECRET);
  });

  it("drops content when masking takes too long", async () => {
    const { inst, one } = setup({ masker: () => new Promise(() => undefined), timeoutMs: 20 });
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    expect((await one("chat gpt-x")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("timeout");
  });

  it("drops content past the pending limit (backpressure) and still exports the span", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { inst, spans } = setup({
      maxPending: 1,
      masker: async (parts, options) => {
        await gate;
        return await plantedMasker(parts, options);
      }
    });
    await inst.modelCall({ providerId: "openai", model: "first" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    await inst.modelCall({ providerId: "openai", model: "second" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    release();
    const all = await spans();
    expect(all.find((span) => span.name === "chat second")!.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("backpressure");
    expect(all.find((span) => span.name === "chat first")!.attributes["gen_ai.input.messages"]).toBeDefined();
  });

  it("drops content of spans started under a sensitive check, and of their children", async () => {
    const { inst, spans } = setup();
    await inst.withContentExclusion(() => true, async () => {
      await inst.toolCall({ toolName: "lookup" }, async (tool) => {
        tool.addContent?.("tool_call_arguments", { email: EMAIL });
        await inst.modelCall({ providerId: "openai", model: "inner" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      });
    });
    for (const span of await spans()) {
      expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
      expect(contentKeys(span)).toEqual([]);
    }
    expect(JSON.stringify(await spans())).not.toContain(EMAIL);
  });

  it("checks sensitivity when content is handed over, nests checks, and fails closed when a check throws", async () => {
    const { inst, one } = setup();
    let sensitive = false;
    await inst.withContentExclusion(() => sensitive, async () => {
      await inst.withContentExclusion(() => false, async () => {
        await inst.modelCall({ providerId: "openai", model: "before" }, async (span) => span.addContent?.("input_messages", MESSAGES));
        sensitive = true;
        await inst.modelCall({ providerId: "openai", model: "after" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      });
    });
    expect((await one("chat before")).attributes["gen_ai.input.messages"]).toBeDefined();
    expect((await one("chat after")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    await inst.withContentExclusion(
      () => {
        throw new Error("labels unreadable");
      },
      async () => {
        await inst.modelCall({ providerId: "openai", model: "throws" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      }
    );
    expect((await one("chat throws")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
  });

  it("records the drop reason a check gives, inner check first, and re-checks it at span end", async () => {
    const { inst, one } = setup();
    let memory: string | false = false;
    await inst.withContentExclusion(() => memory, async () => {
      await inst.modelCall({ providerId: "openai", model: "reasoned" }, async (span) => {
        span.addContent?.("input_messages", MESSAGES);
        // Turned sensitive after the content was handed over: dropped when the span ends, with the check's reason.
        memory = "sensitive_memory";
      });
      await inst.withContentExclusion(() => "Not A Reason!", async () => {
        await inst.modelCall({ providerId: "openai", model: "malformed" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      });
    });
    await inst.withContentExclusion(() => "sensitive_memory", async () => {
      await inst.withContentExclusion(() => true, async () => {
        await inst.modelCall({ providerId: "openai", model: "inner" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      });
      await inst.withContentExclusion(() => "", async () => {
        await inst.modelCall({ providerId: "openai", model: "outer" }, async (span) => span.addContent?.("input_messages", MESSAGES));
      });
    });
    expect((await one("chat reasoned")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive_memory");
    // A reason that is not lower-case letters and underscores is recorded as plain `sensitive`.
    expect((await one("chat malformed")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    expect((await one("chat inner")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
    // An empty answer means not sensitive, so the outer check's reason applies.
    expect((await one("chat outer")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive_memory");
    for (const name of ["chat reasoned", "chat malformed", "chat inner", "chat outer"]) {
      expect(contentKeys(await one(name))).toEqual([]);
      expect(JSON.stringify((await one(name)).attributes)).not.toContain(SECRET);
    }
  });

  it("drops content that cannot be copied: too deep, cyclic or too large", async () => {
    let deep: Record<string, unknown> = { leaf: EMAIL };
    for (let index = 0; index < 80; index += 1) deep = { next: deep };
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { inst, one } = setup({ maxInputChars: 1000 });
    await inst.toolCall({ toolName: "deep" }, async (span) => span.addContent?.("tool_call_arguments", deep));
    await inst.toolCall({ toolName: "cyclic" }, async (span) => span.addContent?.("tool_call_arguments", cyclic));
    await inst.toolCall({ toolName: "large" }, async (span) => span.addContent?.("tool_call_arguments", { text: "x".repeat(2000) }));
    expect((await one("execute_tool deep")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("unscannable");
    expect((await one("execute_tool cyclic")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("unscannable");
    expect((await one("execute_tool large")).attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("too_large");
  });

  it("cuts each attribute to the configured length after masking, keeping valid JSON", async () => {
    const { inst, one } = setup({ maxChars: 300 });
    const long = [{ role: "user", parts: [{ type: "text", content: `${EMAIL} ${"word ".repeat(500)}` }] }];
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", long));
    const text = String((await one("chat gpt-x")).attributes["gen_ai.input.messages"]);
    expect(text.length).toBeLessThanOrEqual(300);
    const parsed = JSON.parse(text);
    expect(parsed[0].role).toBe("user");
    expect(parsed[0].parts[0].content.startsWith("user_1a2b@surrogate.invalid")).toBe(true);
    expect(parsed[0].parts[0].content.endsWith("…[truncated]")).toBe(true);
  });

  it("EVENT_ONLY puts a model call's content in the inference details event and records no tool content", async () => {
    const { inst, one } = setup({ mode: "EVENT_ONLY" });
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    await inst.toolCall({ toolName: "search" }, async (span) => {
      expect(span.capturesContent).toBe(false);
      span.addContent?.("tool_call_arguments", { email: EMAIL });
    });
    const model = await one("chat gpt-x");
    expect(contentKeys(model)).toEqual([]);
    const event = model.events.find((entry) => entry.name === INFERENCE_DETAILS_EVENT);
    expect(JSON.parse(String(event!.attributes!["gen_ai.input.messages"]))[0].parts[0].content).toContain("user_1a2b@surrogate.invalid");
    const tool = await one("execute_tool search");
    expect(JSON.stringify(tool)).not.toContain(EMAIL);
  });

  it("SPAN_AND_EVENT records both; tool content only as attributes", async () => {
    const { inst, one } = setup({ mode: "SPAN_AND_EVENT" });
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    await inst.toolCall({ toolName: "search" }, async (span) => span.addContent?.("tool_call_result", { hits: 2 }));
    const model = await one("chat gpt-x");
    expect(model.attributes["gen_ai.input.messages"]).toBeDefined();
    expect(model.events.some((entry) => entry.name === INFERENCE_DETAILS_EVENT)).toBe(true);
    const tool = await one("execute_tool search");
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe('{"hits":2}');
    expect(tool.events.some((entry) => entry.name === INFERENCE_DETAILS_EVENT)).toBe(false);
  });

  it("captures nothing on embeddings, run, node or MCP server spans", async () => {
    const { inst, spans } = setup();
    await inst.modelCall({ providerId: "openai", model: "embed", operation: "embeddings" }, async (span) => {
      expect(span.capturesContent).toBe(false);
      span.addContent?.("input_messages", MESSAGES);
    });
    await inst.run({ workflowId: "wf" }, async (span) => span.addContent?.("input_messages", MESSAGES));
    await inst.mcpRequest({ method: "tools/call", target: "t", side: "server" }, async (span) => span.addContent?.("tool_call_arguments", { email: EMAIL }));
    const all = await spans();
    expect(all).toHaveLength(3);
    for (const span of all) expect(contentKeys(span)).toEqual([]);
    expect(JSON.stringify(all)).not.toContain(EMAIL);
  });

  it("captures tool arguments and results on MCP client spans", async () => {
    const { inst, one } = setup();
    await inst.mcpRequest({ method: "tools/call", target: "lookup", side: "client" }, async (span) => {
      span.addContent?.("tool_call_arguments", { email: EMAIL });
      span.addContent?.("tool_call_result", "found");
    });
    const span = await one("tools/call lookup");
    expect(JSON.parse(String(span.attributes["gen_ai.tool.call.arguments"]))).toEqual({ email: "user_1a2b@surrogate.invalid" });
    expect(span.attributes["gen_ai.tool.call.result"]).toBe('"found"');
  });

  it("records nothing for a span the sampler dropped", async () => {
    let calls = 0;
    const { inst, spans } = setup(
      {
        masker: async (parts, options) => {
          calls += 1;
          return await plantedMasker(parts, options);
        }
      },
      { sampler: { name: "always_off" } }
    );
    await inst.modelCall({ providerId: "openai", model: "gpt-x" }, async (span) => {
      expect(span.capturesContent).toBe(false);
      span.addContent?.("input_messages", MESSAGES);
    });
    expect(await spans()).toHaveLength(0);
    expect(calls).toBe(0);
  });
});

describe("truncateContent", () => {
  it("returns small values as they are and always fits the limit with valid JSON", () => {
    expect(truncateContent({ a: "b" }, 100)).toBe('{"a":"b"}');
    const big = { messages: Array.from({ length: 200 }, (_, index) => ({ role: "user", text: `message ${index} ${"z".repeat(50)}` })) };
    for (const limit of [20, 64, 128, 500, 4000]) {
      const text = truncateContent(big, limit);
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("never splits a surrogate pair", () => {
    const text = truncateContent(["😀".repeat(100)], 40);
    expect(JSON.parse(text)[0]).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("snapshotContent", () => {
  it("copies JSON data and drops functions, symbols and binary buffers", () => {
    const value = { a: [1, "x", null, Number.NaN], f: () => 1, b: new Uint8Array([1]), d: new Date(0), n: 10n };
    expect(snapshotContent(value, 1000)).toEqual({ a: [1, "x", null, null], b: null, d: "1970-01-01T00:00:00.000Z", n: "10" });
  });
});

describe("content scopes", () => {
  it("captures nothing for work outside a content scope", async () => {
    const { raw, one } = setup();
    await raw.modelCall({ providerId: "openai", model: "unscoped" }, async (span) => {
      expect(span.capturesContent).toBe(false);
      span.addContent?.("input_messages", MESSAGES);
    });
    await raw.mcpRequest({ method: "tools/call", target: "lookup", side: "client" }, async (span) => span.addContent?.("tool_call_arguments", { email: EMAIL }));
    expect(contentKeys(await one("chat unscoped"))).toEqual([]);
    expect(contentKeys(await one("tools/call lookup"))).toEqual([]);
  });

  it("checks sensitivity again when the span ends", async () => {
    const { raw, one } = setup();
    let sensitive = false;
    await raw.withContentExclusion(() => sensitive, async () => {
      await raw.modelCall({ providerId: "openai", model: "turns" }, async (span) => {
        span.addContent?.("input_messages", MESSAGES);
        sensitive = true;
      });
    });
    const span = await one("chat turns");
    expect(contentKeys(span)).toEqual([]);
    expect(span.attributes[CONTENT_DROPPED_ATTRIBUTE]).toBe("sensitive");
  });

  it("records an agent tool call's MCP request content once, on the execute_tool span", async () => {
    const { raw, one } = setup();
    await raw.withContentExclusion(() => false, async () => {
      const tool = raw.startToolCall({ toolName: "lookup", toolCallId: "c1" });
      await tool.enter(() =>
        raw.mcpRequest({ method: "tools/call", target: "lookup", side: "client" }, async (span) => {
          expect(span.capturesContent).toBe(false);
          span.addContent?.("tool_call_arguments", { q: "x" });
        })
      );
      tool.addContent?.("tool_call_arguments", { q: "x" });
      tool.end();
    });
    expect(contentKeys(await one("tools/call lookup"))).toEqual([]);
    expect(contentKeys(await one("execute_tool lookup"))).toContain("gen_ai.tool.call.arguments");
  });
});
