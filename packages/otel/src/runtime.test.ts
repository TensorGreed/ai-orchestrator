import { afterEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { createOtelRuntime, DEFAULT_BATCH_OPTIONS, type OtelRuntime, type OtelRuntimeOptions } from "./index.js";

const INBOUND_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const INBOUND_SPAN = "00f067aa0ba902b7";

let runtimes: OtelRuntime[] = [];

/** Hands each ended span to an in-memory exporter at once (SimpleSpanProcessor exports on a later tick). */
function exportingAtOnce(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

function setup(overrides: Partial<OtelRuntimeOptions> = {}) {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test", "deployment.environment.name": "test" },
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
    recentSpanLimit: 5000,
    spanProcessors: [exportingAtOnce(exporter)],
    registerGlobals: false,
    ...overrides
  });
  runtimes.push(runtime);
  const spans = () => exporter.getFinishedSpans();
  const byName = (name: string): ReadableSpan => {
    const span = spans().find((candidate) => candidate.name === name);
    if (!span) throw new Error(`no span ${name}; have ${spans().map((s) => s.name).join(", ")}`);
    return span;
  };
  return { runtime, exporter, spans, byName, inst: runtime.instrumentation };
}

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  runtimes = [];
});

describe("OtelRunInstrumentation span shapes", () => {
  it("nests run, node, agent, model and tool spans with the pinned attribute names", async () => {
    const { inst, byName } = setup();
    await inst.run({ executionId: "exec_1", workflowId: "wf_1", workflowName: "Support triage", projectId: "proj_1", triggerType: "manual", runMode: "inline", replay: false }, async () => {
      await inst.node({ nodeId: "agent_1", nodeType: "agent_orchestrator", nodeName: "Triage agent", attempt: 1 }, async () => {
        await inst.agent({ agentId: "agent_1", agentName: "Triage", sessionId: "sess_42", supervisor: false }, async () => {
          await inst.modelCall({ providerId: "azure-openai", model: "gpt-4.1", stream: true, temperature: 0.2, maxTokens: 512, serverAddress: "example.openai.azure.com" }, async () => undefined);
          await inst.toolCall({ toolName: "search", toolCallId: "call_1", toolType: "extension" }, async () => {
            await inst.mcpRequest({ method: "tools/call", target: "search", serverId: "mcp_1", requestId: 7, transport: "tcp", sessionId: "mcp-sess" }, async () => undefined);
          });
        });
      });
    });

    const run = byName("invoke_workflow Support triage");
    expect(run.kind).toBe(SpanKind.INTERNAL);
    expect(run.attributes).toEqual({
      "gen_ai.operation.name": "invoke_workflow",
      "l2m.execution.id": "exec_1",
      "l2m.workflow.id": "wf_1",
      "l2m.workflow.name": "Support triage",
      "l2m.project.id": "proj_1",
      "l2m.trigger.type": "manual",
      "l2m.run.mode": "inline",
      "l2m.replay": false
    });
    const node = byName("l2m.node agent_orchestrator");
    expect(node.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(node.attributes).toEqual({ "l2m.node.id": "agent_1", "l2m.node.type": "agent_orchestrator", "l2m.node.name": "Triage agent", "l2m.node.attempts": 1 });
    const agent = byName("invoke_agent Triage");
    expect(agent.parentSpanContext?.spanId).toBe(node.spanContext().spanId);
    expect(agent.attributes).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "agent_1",
      "gen_ai.agent.name": "Triage",
      "gen_ai.conversation.id": "sess_42",
      "l2m.agent.supervisor": false
    });
    const chat = byName("chat gpt-4.1");
    expect(chat.kind).toBe(SpanKind.CLIENT);
    expect(chat.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(chat.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "azure.ai.openai",
      "l2m.provider.id": "azure-openai",
      "gen_ai.request.model": "gpt-4.1",
      "gen_ai.request.stream": true,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 512,
      "server.address": "example.openai.azure.com"
    });
    const tool = byName("execute_tool search");
    expect(tool.attributes).toEqual({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search", "gen_ai.tool.call.id": "call_1", "gen_ai.tool.type": "extension" });
    const mcp = byName("tools/call search");
    expect(mcp.kind).toBe(SpanKind.CLIENT);
    expect(mcp.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(mcp.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "search",
      "mcp.session.id": "mcp-sess",
      "jsonrpc.request.id": "7",
      "network.transport": "tcp",
      "l2m.mcp.server.id": "mcp_1"
    });
    expect(new Set([run, node, agent, chat, tool, mcp].map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(run.instrumentationScope).toMatchObject({ name: "l2m", schemaUrl: "https://opentelemetry.io/schemas/1.41.0" });
  });

  it("maps every shipped provider id to its gen_ai.provider.name", async () => {
    const { inst, spans } = setup();
    for (const providerId of ["openai", "openai-compatible", "azure-openai", "anthropic", "gemini", "ollama", "custom-thing"]) {
      await inst.modelCall({ providerId, model: providerId }, async () => undefined);
    }
    const names = Object.fromEntries(spans().map((span) => [span.attributes["l2m.provider.id"], span.attributes["gen_ai.provider.name"]]));
    expect(names).toEqual({
      openai: "openai",
      "openai-compatible": "openai",
      "azure-openai": "azure.ai.openai",
      anthropic: "anthropic",
      gemini: "gcp.gemini",
      ollama: "ollama",
      "custom-thing": "custom-thing"
    });
  });

  it("keeps names out of span names and attributes with naming=ids", async () => {
    const { inst, spans } = setup({ naming: "ids" });
    await inst.run({ executionId: "exec_1", workflowId: "wf_1", workflowName: "Acme Corp payroll" }, async () => {
      await inst.agent({ agentId: "agent_1", agentName: "Acme helper" }, async () => undefined);
      await inst.node({ nodeId: "n1", nodeType: "llm_call", nodeName: "Acme summary" }, async () => undefined);
    });
    expect(spans().map((span) => span.name).sort()).toEqual(["invoke_agent agent_1", "invoke_workflow wf_1", "l2m.node llm_call"]);
    expect(JSON.stringify(spans().map((span) => span.attributes))).not.toContain("Acme");
  });

  it("hashes a session id that looks like an email address or phone number", async () => {
    const { inst, spans } = setup();
    await inst.agent({ agentId: "a", sessionId: "jane.doe@example.com" }, async () => undefined);
    await inst.agent({ agentId: "b", sessionId: "+1 (555) 010-9999" }, async () => undefined);
    const ids = spans().map((span) => String(span.attributes["gen_ai.conversation.id"]));
    for (const id of ids) expect(id).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(spans().map((span) => span.attributes))).not.toContain("example.com");
  });

  it("records agent iterations only at verbose detail", async () => {
    const standard = setup();
    let ran = 0;
    await standard.inst.iteration({ iteration: 1 }, async (span) => {
      ran += 1;
      expect(span.recording).toBe(false);
    });
    expect(ran).toBe(1);
    expect(standard.spans()).toHaveLength(0);

    const verbose = setup({ spanDetail: "verbose" });
    await verbose.inst.iteration({ iteration: 3 }, async () => undefined);
    expect(verbose.byName("l2m.agent.iteration").attributes).toEqual({ "l2m.agent.iteration": 3 });
  });

  it("records a thrown error with a scrubbed message, an error.type and no stack trace, and rethrows it", async () => {
    const { inst, byName } = setup({ scrub: (text) => text.replaceAll("sk-live-secret-value", "[redacted]") });
    const failure = Object.assign(new Error("upstream said sk-live-secret-value is invalid"), { errorCategory: "provider_auth" });
    await expect(inst.modelCall({ providerId: "openai", model: "gpt-4o" }, async () => { throw failure; })).rejects.toBe(failure);
    const span = byName("chat gpt-4o");
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "upstream said [redacted] is invalid" });
    expect(span.attributes["error.type"]).toBe("provider_auth");
    expect(span.events).toHaveLength(1);
    expect(span.events[0]!.attributes).toEqual({ "exception.type": "provider_auth", "exception.message": "upstream said [redacted] is invalid" });
    expect(JSON.stringify(span)).not.toContain("sk-live-secret-value");
    expect(JSON.stringify(span.events)).not.toContain("stacktrace");
  });

  it("drops null and undefined attributes and keeps a span open for streams until end()", async () => {
    const { inst, spans } = setup();
    let handle: { end(): void } | undefined;
    await inst.span({ name: "stream", kind: "client", attributes: { a: 1, b: undefined, c: null } }, async (span) => {
      span.keepOpen();
      handle = span;
    });
    expect(spans()).toHaveLength(0);
    handle!.end();
    handle!.end();
    expect(spans()).toHaveLength(1);
    expect(spans()[0]!.attributes).toEqual({ a: 1 });
  });

  it("annotates the active span", async () => {
    const { inst, byName } = setup();
    await inst.span({ name: "outer" }, async () => {
      inst.annotate({ "l2m.gateway.route_set.id": "rs_1", skipped: undefined });
    });
    expect(byName("outer").attributes).toEqual({ "l2m.gateway.route_set.id": "rs_1" });
  });
});

describe("propagation", () => {
  it("injects into MCP carriers and not into provider carriers by default", async () => {
    const { inst } = setup();
    await inst.span({ name: "outer" }, async (span) => {
      const mcp: Record<string, string> = {};
      expect(inst.inject(mcp, "mcp")).toBe(true);
      expect(mcp.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
      const provider: Record<string, string> = {};
      expect(inst.inject(provider, "provider")).toBe(false);
      expect(provider).toEqual({});
    });
  });

  it("follows the provider and MCP switches", async () => {
    const { inst } = setup({ propagateToProviders: true, propagateToMcp: false });
    await inst.span({ name: "outer" }, async () => {
      const provider: Record<string, string> = {};
      expect(inst.inject(provider, "provider")).toBe(true);
      expect(inst.inject({}, "mcp")).toBe(false);
    });
  });

  it("injects nothing outside a span", () => {
    const { inst } = setup();
    const carrier: Record<string, string> = {};
    expect(inst.inject(carrier, "queue")).toBe(false);
    expect(carrier).toEqual({});
  });

  it("parents a span on a carrier with withParent and links runs to earlier traces", async () => {
    const { inst, byName } = setup();
    await inst.withParent({ traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01` }, () => inst.span({ name: "consumer", kind: "consumer" }, async () => undefined));
    const consumer = byName("consumer");
    expect(consumer.spanContext().traceId).toBe(INBOUND_TRACE);
    expect(consumer.parentSpanContext?.spanId).toBe(INBOUND_SPAN);

    await inst.run({ executionId: "e", workflowId: "w", links: [{ traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01` }, { traceparent: "garbage" }] }, async () => undefined);
    const run = byName("invoke_workflow w");
    expect(run.spanContext().traceId).not.toBe(INBOUND_TRACE);
    expect(run.links.map((link) => link.context.spanId)).toEqual([INBOUND_SPAN]);
  });

  it("ignores malformed carriers in withParent", async () => {
    const { inst, byName } = setup();
    await inst.withParent({ traceparent: "00-zz-00-01" }, () => inst.span({ name: "root" }, async () => undefined));
    expect(byName("root").parentSpanContext).toBeUndefined();
  });

  it("propagates nothing with OTEL_PROPAGATORS=none", async () => {
    const { inst } = setup({ propagators: ["none"] });
    await inst.span({ name: "outer" }, async () => {
      expect(inst.inject({}, "mcp")).toBe(false);
    });
  });
});

describe("HTTP server spans", () => {
  const request = { method: "POST", route: "/api/workflows/:id/execute", path: "/api/workflows/wf_1/execute", scheme: "http", clientAddress: "10.0.0.5", requestId: "req_1" };
  const inbound = { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01` };

  it("uses the stable HTTP attribute names and makes the span the parent of work in its context", async () => {
    const { runtime, byName } = setup();
    const server = runtime.startHttpServerSpan({ ...request, inboundUse: "parent" });
    await runtime.withContext(server.context, () => runtime.instrumentation.span({ name: "handler work" }, async () => undefined));
    server.end(201);
    const span = byName("POST /api/workflows/:id/execute");
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/api/workflows/:id/execute",
      "url.path": "/api/workflows/wf_1/execute",
      "url.scheme": "http",
      "client.address": "10.0.0.5",
      "l2m.request.id": "req_1",
      "http.response.status_code": 201
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(byName("handler work").parentSpanContext?.spanId).toBe(span.spanContext().spanId);
  });

  it("continues a trusted caller's trace", () => {
    const { runtime, byName } = setup();
    runtime.startHttpServerSpan({ ...request, inbound, inboundUse: "parent" }).end(200);
    const span = byName("POST /api/workflows/:id/execute");
    expect(span.spanContext().traceId).toBe(INBOUND_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(INBOUND_SPAN);
    expect(span.links).toHaveLength(0);
  });

  it("starts a new trace with a link for an untrusted caller", () => {
    const { runtime, byName } = setup();
    runtime.startHttpServerSpan({ ...request, inbound, inboundUse: "link" }).end(200);
    const span = byName("POST /api/workflows/:id/execute");
    expect(span.spanContext().traceId).not.toBe(INBOUND_TRACE);
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.links).toHaveLength(1);
    expect(span.links[0]!.context.traceId).toBe(INBOUND_TRACE);
    expect(span.links[0]!.attributes).toEqual({ "l2m.link.reason": "untrusted_inbound" });
  });

  it("cannot be forced out of sampling by an untrusted caller's unsampled flag", () => {
    const { runtime, spans } = setup();
    runtime.startHttpServerSpan({ ...request, inbound: { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-00` }, inboundUse: "link" }).end(200);
    expect(spans()).toHaveLength(1);
    runtime.startHttpServerSpan({ ...request, inbound: { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-00` }, inboundUse: "parent" }).end(200);
    // A trusted caller's "not sampled" decision is honoured by the parent-based sampler.
    expect(spans()).toHaveLength(1);
  });

  it("ignores the inbound header entirely with inboundUse=ignore", () => {
    const { runtime, byName } = setup();
    runtime.startHttpServerSpan({ ...request, inbound, inboundUse: "ignore" }).end(200);
    const span = byName("POST /api/workflows/:id/execute");
    expect(span.links).toHaveLength(0);
    expect(span.spanContext().traceId).not.toBe(INBOUND_TRACE);
  });

  it("marks 5xx as errors, leaves 4xx unset, and names unmatched and unknown-method requests", () => {
    const { runtime, spans } = setup();
    runtime.startHttpServerSpan({ method: "GET", path: "/nope", inboundUse: "ignore" }).end(404);
    runtime.startHttpServerSpan({ method: "BREW", route: "/pot", path: "/pot", inboundUse: "ignore" }).end(503);
    const [notFound, brew] = spans();
    expect(notFound!.name).toBe("GET");
    expect(notFound!.status.code).toBe(SpanStatusCode.UNSET);
    expect(notFound!.attributes["error.type"]).toBeUndefined();
    expect(brew!.name).toBe("HTTP /pot");
    expect(brew!.attributes["http.request.method"]).toBe("_OTHER");
    expect(brew!.attributes["http.request.method_original"]).toBe("BREW");
    expect(brew!.attributes["error.type"]).toBe("503");
    expect(brew!.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("runtime", () => {
  it("keeps recent spans in the Phase 5.7 shape", async () => {
    const { runtime } = setup({ recentSpanLimit: 2 });
    for (const name of ["a", "b", "c"]) await runtime.instrumentation.span({ name, attributes: { list: ["x", "y"] } }, async () => undefined);
    const recent = runtime.recent(10);
    expect(recent.map((span) => span.operationName)).toEqual(["b", "c"]);
    expect(recent[0]).toMatchObject({ kind: "internal", status: "unset", parentSpanId: null, attributes: { "service.name": "l2m-test", list: '["x","y"]' } });
    expect(recent[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(runtime.spansByTrace(recent[1]!.traceId)).toHaveLength(1);
  });

  it("gives log fields only inside a span", async () => {
    const { runtime } = setup();
    expect(runtime.logFields()).toBeNull();
    await runtime.instrumentation.span({ name: "x" }, async (span) => {
      expect(runtime.logFields()).toEqual({ trace_id: span.traceId, span_id: span.spanId, trace_flags: "01" });
    });
    expect(runtime.logFields()).toBeNull();
  });

  it("builds the resource from the given attributes over the SDK defaults", () => {
    const { runtime } = setup();
    expect(runtime.resourceAttributes()).toMatchObject({
      "service.name": "l2m-test",
      "deployment.environment.name": "test",
      "telemetry.sdk.language": "nodejs",
      "telemetry.sdk.name": "opentelemetry"
    });
  });

  it("samples nothing with always_off and still runs the wrapped work", async () => {
    const { runtime, spans } = setup({ sampler: { name: "always_off" } });
    const result = await runtime.instrumentation.run({ executionId: "e", workflowId: "w" }, async (span) => {
      expect(span.recording).toBe(false);
      return 42;
    });
    expect(result).toBe(42);
    expect(spans()).toHaveLength(0);
  });

  it("registers the process-wide globals once and releases them at shutdown", async () => {
    const first = setup({ registerGlobals: true });
    const second = setup({ registerGlobals: true });
    await first.inst.span({ name: "outer" }, async (span) => {
      expect(trace.getActiveSpan()?.spanContext().spanId).toBe(span.spanId);
    });
    // The second runtime could not take the globals but still traces through its own references.
    await second.inst.span({ name: "inner" }, async (span) => {
      expect(second.runtime.logFields()?.span_id).toBe(span.spanId);
    });
    await first.runtime.shutdown();
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it("exports batched spans over OTLP and flushes them at shutdown", async () => {
    const http = await import("node:http");
    const received: Array<{ path: string; type: string; bytes: number }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ path: req.url ?? "", type: String(req.headers["content-type"]), bytes: Buffer.concat(chunks).length });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      for (const protocol of ["http/protobuf", "http/json"] as const) {
        const runtime = createOtelRuntime({
          resourceAttributes: { "service.name": "l2m-export-test" },
          export: { url: `http://127.0.0.1:${port}/v1/traces`, protocol, headers: { "x-tenant": "t1" }, timeoutMs: 2000 },
          sampler: { name: "always_on" },
          propagators: ["tracecontext"],
          batch: { ...DEFAULT_BATCH_OPTIONS, scheduledDelayMs: 60_000 },
          attributeValueLengthLimit: 8192,
          spanDetail: "standard",
          naming: "names",
          propagateToProviders: false,
          propagateToMcp: true,
          semconvOptIn: [],
          recentSpanLimit: 10,
          registerGlobals: false
        });
        await runtime.instrumentation.span({ name: "exported" }, async () => undefined);
        await runtime.shutdown();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(received.map((entry) => [entry.path, entry.type])).toEqual([
      ["/v1/traces", "application/x-protobuf"],
      ["/v1/traces", "application/json"]
    ]);
    expect(received.every((entry) => entry.bytes > 0)).toBe(true);
  });
});
