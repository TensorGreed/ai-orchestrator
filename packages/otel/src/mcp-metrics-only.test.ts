import { afterEach, describe, expect, it } from "vitest";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader, type ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { NOOP_INSTRUMENTATION_SPAN, type TraceCarrier } from "@ai-orchestrator/shared";
import { createMcpMetricsInstrumentation } from "./index.js";

const providers: MeterProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

function setup() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  providers.push(provider);
  const instrument = createMcpMetricsInstrumentation(provider.getMeter("test"), (text) => text.replaceAll("s3cr3t", "[redacted]"));
  const points = async (name: string) => {
    await reader.forceFlush();
    return exporter
      .getMetrics()
      .flatMap((resource: ResourceMetrics) => resource.scopeMetrics.flatMap((scope) => scope.metrics))
      .filter((metric) => metric.descriptor.name === name)
      .flatMap((metric) => metric.dataPoints.map((point) => ({ attributes: point.attributes, count: (point.value as { count: number }).count })));
  };
  return { instrument, points };
}

describe("metrics-only MCP instrumentation", () => {
  it("measures a client request with what the adapter reports, and starts no span", async () => {
    const { instrument, points } = setup();
    expect(instrument.enabled).toBe(true);
    const seen = await instrument.mcpRequest(
      { method: "tools/call", side: "client", target: "search_s3cr3t", transport: "tcp", networkProtocol: "http", serverAddress: "mcp.example", serverPort: 443, serverId: "srv-1" },
      async (span) => {
        expect(span.recording).toBe(false);
        expect(span.capturesContent).toBe(false);
        instrument.annotate({ "mcp.protocol.version": "2025-06-18", "mcp.session.id": "sess-1", "jsonrpc.request.id": "7" });
        return span.traceId;
      }
    );
    expect(seen).toBe("");
    const [point] = await points("mcp.client.operation.duration");
    expect(point).toMatchObject({ count: 1 });
    expect(point!.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "search_[redacted]",
      "mcp.protocol.version": "2025-06-18",
      "network.transport": "tcp",
      "network.protocol.name": "http",
      "server.address": "mcp.example",
      "server.port": 443
    });
  });

  it("records the server's JSON-RPC code as the error type, once, and rethrows", async () => {
    const { instrument, points } = setup();
    const failure = new Error("upstream said no");
    await expect(
      instrument.mcpRequest({ method: "tools/list", side: "client" }, async (span) => {
        instrument.annotate({ "rpc.response.status_code": "-32602" });
        span.recordError(failure, { type: "protocol" });
        throw failure;
      })
    ).rejects.toBe(failure);
    const [point] = await points("mcp.client.operation.duration");
    expect(point!.attributes).toMatchObject({ "mcp.method.name": "tools/list", "error.type": "-32602", "rpc.response.status_code": "-32602" });
  });

  it("measures a gateway request on the server metric, and a later round only as part of its request", async () => {
    const { instrument, points } = setup();
    await instrument.mcpRequest({ method: "tools/call", side: "server", target: "anything", toolsetId: "ts-1", gatewayClientId: "c-1" }, async (span) => {
      const round = await instrument.mcpRequest({ method: "tools/call", side: "client", round: 2 }, async (inner) => inner);
      // The round reports to its request (no measurement of its own).
      expect(round).toBe(span);
      span.setAttributes({ "rpc.response.status_code": "-31030" });
      span.recordError(null, { type: "-31030" });
    });
    expect(await points("mcp.client.operation.duration")).toEqual([]);
    const [point] = await points("mcp.server.operation.duration");
    expect(point).toMatchObject({ count: 1 });
    // Ids and caller-chosen names stay off the server metric; an out-of-range code is bounded.
    expect(point!.attributes).toEqual({ "mcp.method.name": "tools/call", "gen_ai.operation.name": "execute_tool", "rpc.response.status_code": "_OTHER", "error.type": "_OTHER" });
  });

  it("measures a span kept open when its owner ends it, and only once", async () => {
    const { instrument, points } = setup();
    let held: { end(): void } | undefined;
    await instrument.mcpRequest({ method: "resources/read", side: "client" }, async (span) => {
      span.keepOpen();
      held = span;
    });
    expect(await points("mcp.client.operation.duration")).toEqual([]);
    held!.end();
    held!.end();
    expect(await points("mcp.client.operation.duration")).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it("measures a kept-open request that fails at once (nobody owns it then)", async () => {
    const { instrument, points } = setup();
    await expect(
      instrument.mcpRequest({ method: "tools/list", side: "client" }, async (span) => {
        span.keepOpen();
        throw new Error("transport closed");
      })
    ).rejects.toThrow("transport closed");
    expect(await points("mcp.client.operation.duration")).toEqual([expect.objectContaining({ count: 1, attributes: expect.objectContaining({ "error.type": "Error" }) })]);
  });

  it("injects no trace context and runs every other wrapper as the no-op does", async () => {
    const { instrument, points } = setup();
    const carrier: TraceCarrier = {};
    expect(instrument.inject(carrier, "mcp")).toBe(false);
    expect(carrier).toEqual({});
    expect(await instrument.run({ workflowId: "wf", executionId: "ex" } as never, async (span) => span)).toBe(NOOP_INSTRUMENTATION_SPAN);
    expect(await instrument.toolCall({ toolName: "t" } as never, async (span) => span)).toBe(NOOP_INSTRUMENTATION_SPAN);
    expect(instrument.activeTraceIds()).toBeNull();
    // Annotating outside an MCP request reaches nothing.
    instrument.annotate({ "mcp.protocol.version": "x" });
    expect(await points("mcp.client.operation.duration")).toEqual([]);
  });
});
