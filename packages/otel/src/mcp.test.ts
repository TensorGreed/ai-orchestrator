import { afterEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { createOtelRuntime, DEFAULT_BATCH_OPTIONS, sanitizeResourceUri, type OtelRuntime, type OtelRuntimeOptions } from "./index.js";

const CALLER_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN = "00f067aa0ba902b7";
const CALLER_TRACEPARENT = `00-${CALLER_TRACE}-${CALLER_SPAN}-01`;

let runtimes: OtelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.shutdown()));
  runtimes = [];
});

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
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
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
    metricReaders: [reader],
    registerGlobals: false,
    scrub: (text) => text.replaceAll("s3cr3t", "[redacted]"),
    ...overrides
  });
  runtimes.push(runtime);
  const spans = () => exporter.getFinishedSpans();
  const byName = (name: string): ReadableSpan => {
    const span = spans().find((candidate) => candidate.name === name);
    if (!span) throw new Error(`no span ${name}; have ${spans().map((s) => s.name).join(", ")}`);
    return span;
  };
  const metrics = async () => {
    await runtime.metrics.forceFlush();
    const all = metricExporter.getMetrics().flatMap((resource: ResourceMetrics) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
    return new Map(all.map((metric) => [metric.descriptor.name, metric] as const));
  };
  return { runtime, inst: runtime.instrumentation, spans, byName, metrics };
}

describe("MCP CLIENT spans", () => {
  it("names the span after the method and tool, sets the MCP attributes and records the duration metric", async () => {
    const { inst, byName, metrics } = setup();
    await inst.mcpRequest(
      { method: "tools/call", target: "search", side: "client", serverId: "srv_1", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example.com", serverPort: 443 },
      async () => {
        // What an adapter records once it knows the request on the wire.
        inst.annotate({ "mcp.session.id": "sess-9", "mcp.protocol.version": "2025-06-18", "jsonrpc.request.id": "tool-call-1" });
      }
    );
    const span = byName("tools/call search");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "server.address": "mcp.example.com",
      "server.port": 443,
      "l2m.mcp.server.id": "srv_1",
      "mcp.session.id": "sess-9",
      "mcp.protocol.version": "2025-06-18",
      "jsonrpc.request.id": "tool-call-1"
    });
    const duration = (await metrics()).get("mcp.client.operation.duration");
    expect(duration?.descriptor.unit).toBe("s");
    const point = duration!.dataPoints[0]!;
    expect(point.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search",
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "server.address": "mcp.example.com",
      "server.port": 443,
      "mcp.protocol.version": "2025-06-18"
    });
  });

  it("records a JSON-RPC error code as error.type and rpc.response.status_code on span and metric, without its text", async () => {
    const { inst, byName, metrics } = setup();
    await inst.mcpRequest({ method: "tools/list", side: "client", serverId: "srv_1" }, async (span) => {
      span.setAttributes({ "rpc.response.status_code": "-32601" });
      span.recordError(null, { type: "-32601" });
    });
    const span = byName("tools/list");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes["error.type"]).toBe("-32601");
    expect(span.attributes["rpc.response.status_code"]).toBe("-32601");
    expect(span.events.flatMap((event) => Object.keys(event.attributes ?? {}))).not.toContain("exception.message");
    const point = (await metrics()).get("mcp.client.operation.duration")!.dataPoints[0]!;
    expect(point.attributes).toMatchObject({ "error.type": "-32601", "rpc.response.status_code": "-32601" });
  });

  it("measures spans the sampler dropped, with the outcome set on them", async () => {
    const { inst, spans, metrics } = setup({ sampler: { name: "always_off" } });
    await inst.mcpRequest({ method: "tools/call", target: "search", side: "client" }, async (span) => {
      inst.annotate({ "mcp.protocol.version": "2026-07-28" });
      span.recordError(null, { type: "tool_error" });
    });
    expect(spans()).toEqual([]);
    const point = (await metrics()).get("mcp.client.operation.duration")!.dataPoints[0]!;
    expect(point.attributes).toMatchObject({ "error.type": "tool_error", "mcp.protocol.version": "2026-07-28" });
  });

  it("makes a later round of a multi round-trip request a child span that is not measured on its own", async () => {
    const { inst, byName, spans, metrics } = setup();
    await inst.mcpRequest({ method: "tools/call", target: "book", side: "client" }, async () => {
      await inst.mcpRequest({ method: "tools/call", target: "book", side: "client", round: 2 }, async () => undefined);
      await inst.mcpRequest({ method: "tools/call", target: "book", side: "client", round: 3 }, async () => undefined);
      inst.annotate({ "l2m.mcp.rounds": 3 });
    });
    const all = spans().filter((span) => span.name === "tools/call book");
    expect(all).toHaveLength(3);
    const outer = all.find((span) => span.attributes["l2m.mcp.round"] === undefined)!;
    expect(outer.attributes["l2m.mcp.rounds"]).toBe(3);
    for (const round of all.filter((span) => span !== outer)) {
      expect(round.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
      expect(round.kind).toBe(SpanKind.CLIENT);
    }
    expect(byName("tools/call book")).toBeDefined();
    const points = (await metrics()).get("mcp.client.operation.duration")!.dataPoints;
    expect(points.reduce((sum, point) => sum + (point.value as { count: number }).count, 0)).toBe(1);
  });

  it("keeps prompt names, drops a resource URI's credentials, query and fragment, and scrubs targets", async () => {
    const { inst, byName } = setup();
    await inst.mcpRequest({ method: "prompts/get", target: "summarise", side: "client" }, async () => undefined);
    await inst.mcpRequest({ method: "resources/read", resourceUri: "https://user:pw@files.example.com/a/b.txt?token=s3cr3t#x", side: "client" }, async () => undefined);
    await inst.mcpRequest({ method: "tools/call", target: "s3cr3t-tool", side: "client" }, async () => undefined);
    expect(byName("prompts/get summarise").attributes["gen_ai.prompt.name"]).toBe("summarise");
    const read = byName("resources/read");
    expect(read.attributes["mcp.resource.uri"]).toBe("https://files.example.com/a/b.txt");
    expect(byName("tools/call [redacted]-tool").attributes["gen_ai.tool.name"]).toBe("[redacted]-tool");
    expect(sanitizeResourceUri("not a uri?with=query", (text) => text)).toBe("not a uri");
  });
});

describe("MCP SERVER spans (gateway)", () => {
  it("takes trusted _meta context as parent and links the transport span", async () => {
    const { inst, byName, metrics } = setup();
    let transportSpanId = "";
    await inst.span({ name: "POST /mcp/:toolset", kind: "server" }, async (http) => {
      transportSpanId = http.spanId;
      await inst.mcpRequest(
        {
          method: "tools/call",
          target: "lookup",
          side: "server",
          toolsetId: "ts_1",
          gatewayClientId: "cl_1",
          clientAddress: "10.0.0.5",
          serverAddress: "ignored-on-server",
          remoteParent: { carrier: { traceparent: CALLER_TRACEPARENT }, use: "parent" }
        },
        async () => undefined
      );
    });
    const span = byName("tools/call lookup");
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.spanContext().traceId).toBe(CALLER_TRACE);
    expect(span.parentSpanContext?.spanId).toBe(CALLER_SPAN);
    expect(span.links.map((link) => [link.context.spanId, link.attributes?.["l2m.link.reason"]])).toEqual([[transportSpanId, "transport"]]);
    expect(span.attributes).toMatchObject({ "l2m.toolset.id": "ts_1", "l2m.gateway.client.id": "cl_1", "client.address": "10.0.0.5" });
    expect(span.attributes["server.address"]).toBeUndefined();
    const point = (await metrics()).get("mcp.server.operation.duration")!.dataPoints[0]!;
    // Tool names on the server metric would let any caller add series.
    expect(point.attributes["gen_ai.tool.name"]).toBeUndefined();
    expect(point.attributes["mcp.method.name"]).toBe("tools/call");
  });

  it("only links untrusted _meta context and stays in the transport's trace", async () => {
    const { inst, byName } = setup();
    let transportTrace = "";
    await inst.span({ name: "POST /mcp/:toolset", kind: "server" }, async (http) => {
      transportTrace = http.traceId;
      await inst.mcpRequest(
        { method: "tools/list", side: "server", remoteParent: { carrier: { traceparent: CALLER_TRACEPARENT }, use: "link" } },
        async () => undefined
      );
    });
    const span = byName("tools/list");
    expect(span.spanContext().traceId).toBe(transportTrace);
    expect(span.links.map((link) => [link.context.traceId, link.attributes?.["l2m.link.reason"]])).toEqual([[CALLER_TRACE, "untrusted_inbound"]]);
  });

  it("ignores malformed _meta context", async () => {
    const { inst, byName } = setup();
    let transportSpan = "";
    await inst.span({ name: "POST /mcp/:toolset", kind: "server" }, async (http) => {
      transportSpan = http.spanId;
      await inst.mcpRequest({ method: "tools/list", side: "server", remoteParent: { carrier: { traceparent: "nonsense" }, use: "parent" } }, async () => undefined);
    });
    const span = byName("tools/list");
    expect(span.parentSpanContext?.spanId).toBe(transportSpan);
    expect(span.links).toEqual([]);
  });
});

describe("MCP propagation switch", () => {
  it("injects into MCP carriers by default and not with L2M_OTEL_PROPAGATE_TO_MCP=false", async () => {
    const on = setup();
    const off = setup({ propagateToMcp: false });
    const carriers: Record<string, string>[] = [{}, {}];
    await on.inst.mcpRequest({ method: "tools/list", side: "client" }, async (span) => {
      expect(on.inst.inject(carriers[0]!, "mcp")).toBe(true);
      expect(carriers[0]!.traceparent).toBe(`00-${span.traceId}-${span.spanId}-01`);
    });
    await off.inst.mcpRequest({ method: "tools/list", side: "client" }, async () => {
      expect(off.inst.inject(carriers[1]!, "mcp")).toBe(false);
    });
    expect(carriers[1]).toEqual({});
  });
});

describe("MCP span errors", () => {
  it("keeps the type the MCP wrapper recorded when the error is then rethrown, and records no message", async () => {
    const { inst, byName } = setup();
    await expect(
      inst.mcpRequest({ method: "tools/list", side: "client" }, async (span) => {
        span.recordError(null, { type: "transport" });
        throw new Error("upstream said: s3cr3t customer data");
      })
    ).rejects.toThrow();
    const span = byName("tools/list");
    expect(span.attributes["error.type"]).toBe("transport");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.events)).not.toContain("customer data");
    expect(span.status.message ?? "").toBe("");
  });
});
