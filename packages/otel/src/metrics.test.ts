import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AggregationTemporality,
  createMetricsPipeline,
  createOtelRuntime,
  DEFAULT_BATCH_OPTIONS,
  HISTOGRAM_METRIC_NAMES,
  InMemoryMetricExporter,
  LEGACY_METRIC_NAMES,
  PeriodicExportingMetricReader,
  registerL2mMetrics,
  type MetricsPipeline,
  type MetricsSnapshotSource,
  type OtelRuntime,
  type ResourceMetrics
} from "./index.js";

const snapshot: ReturnType<MetricsSnapshotSource["getSnapshot"]> = {
  httpRequestsTotal: 7,
  executionsTotal: 4,
  executionsSuccess: 3,
  executionsFailure: 1,
  activeExecutions: 2,
  executionP50Ms: 120,
  executionP95Ms: 900,
  executionP99Ms: 950,
  httpP50Ms: 5,
  httpP95Ms: 40,
  slo: { currentSuccessRate: 0.75, healthy: false },
  uptimeSeconds: 33
};
const source: MetricsSnapshotSource = { getSnapshot: () => snapshot };

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function memoryReader() {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  return { exporter, reader };
}

function collected(exporter: InMemoryMetricExporter) {
  const metrics = exporter.getMetrics().flatMap((resourceMetrics: ResourceMetrics) => resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics));
  return new Map(metrics.map((metric) => [metric.descriptor.name, metric] as const));
}

describe("L2M metrics through the SDK meter", () => {
  it("exports every legacy ao.* name unchanged, as cumulative sums and gauges with the same values", async () => {
    const { exporter, reader } = memoryReader();
    const pipeline = createMetricsPipeline({ resourceAttributes: { "service.name": "t" }, export: null, readers: [reader] });
    cleanup.push(() => pipeline.shutdown());
    registerL2mMetrics(pipeline.meter, source);
    await pipeline.forceFlush();
    const byName = collected(exporter);

    expect([...LEGACY_METRIC_NAMES].filter((name) => !byName.has(name))).toEqual([]);
    // The golden list: renaming any of these breaks existing dashboards.
    expect([...LEGACY_METRIC_NAMES]).toEqual([
      "ao.http.requests.total",
      "ao.workflow.executions.total",
      "ao.workflow.executions.success.total",
      "ao.workflow.executions.failure.total",
      "ao.workflow.executions.active",
      "ao.workflow.execution.duration.p50.ms",
      "ao.workflow.execution.duration.p95.ms",
      "ao.workflow.execution.duration.p99.ms",
      "ao.http.request.duration.p50.ms",
      "ao.http.request.duration.p95.ms",
      "ao.slo.success.rate",
      "ao.slo.healthy",
      "ao.uptime.seconds"
    ]);
    const value = (name: string) => byName.get(name)!.dataPoints[0]!.value;
    expect(value("ao.http.requests.total")).toBe(7);
    expect(value("ao.workflow.executions.failure.total")).toBe(1);
    expect(value("ao.workflow.executions.active")).toBe(2);
    expect(value("ao.workflow.execution.duration.p95.ms")).toBe(900);
    expect(value("ao.slo.success.rate")).toBe(0.75);
    expect(value("ao.slo.healthy")).toBe(0);
    expect(value("ao.uptime.seconds")).toBe(33);
    expect(byName.get("ao.http.requests.total")!.dataPointType).toBe(3); // SUM
    expect(byName.get("ao.http.requests.total")!.aggregationTemporality).toBe(AggregationTemporality.CUMULATIVE);
    expect(byName.get("ao.workflow.executions.active")!.dataPointType).toBe(2); // GAUGE
  });

  it("records duration histograms in seconds with bounded attributes", async () => {
    const { exporter, reader } = memoryReader();
    const pipeline = createMetricsPipeline({ resourceAttributes: { "service.name": "t" }, export: null, readers: [reader] });
    cleanup.push(() => pipeline.shutdown());
    const recorder = registerL2mMetrics(pipeline.meter, source);
    recorder.recordExecution("success", 1500);
    recorder.recordExecution("error", 40);
    recorder.recordHttpRequest("get", 404, 20);
    await pipeline.forceFlush();
    const byName = collected(exporter);

    expect(HISTOGRAM_METRIC_NAMES.every((name) => byName.has(name))).toBe(true);
    const execution = byName.get("ao.workflow.execution.duration")!;
    expect(execution.descriptor.unit).toBe("s");
    const success = execution.dataPoints.find((point) => point.attributes["l2m.execution.status"] === "success")!;
    expect((success.value as { sum: number }).sum).toBeCloseTo(1.5);
    const httpPoint = byName.get("ao.http.request.duration")!.dataPoints[0]!;
    expect(httpPoint.attributes).toEqual({ "http.request.method": "GET", "http.response.status_class": "4xx" });
  });

  it("survives a source that throws", async () => {
    const { exporter, reader } = memoryReader();
    const pipeline = createMetricsPipeline({ resourceAttributes: { "service.name": "t" }, export: null, readers: [reader] });
    cleanup.push(() => pipeline.shutdown());
    registerL2mMetrics(pipeline.meter, {
      getSnapshot: () => {
        throw new Error("boom");
      }
    });
    await expect(pipeline.forceFlush()).resolves.toBeUndefined();
    expect(collected(exporter).has("ao.http.requests.total")).toBe(false);
  });
});

describe("OTLP delivery", () => {
  async function sink() {
    const bodies: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { bodies, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/metrics` };
  }

  it("a metrics-only pipeline (no tracer) pushes http/json with the resource, headers and every legacy name", async () => {
    const { bodies, url } = await sink();
    const pipeline: MetricsPipeline = createMetricsPipeline({
      resourceAttributes: { "service.name": "metrics-only" },
      export: { url, protocol: "http/json", headers: { "x-test": "yes" }, timeoutMs: 2000, intervalMs: 3_600_000 }
    });
    registerL2mMetrics(pipeline.meter, source);
    await pipeline.shutdown();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.path).toBe("/v1/metrics");
    expect(bodies[0]!.headers["x-test"]).toBe("yes");
    const payload = JSON.parse(bodies[0]!.body.toString("utf8")) as {
      resourceMetrics: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { isMonotonic: boolean; aggregationTemporality: number } }> }> }>;
    };
    const resource = payload.resourceMetrics[0]!.resource.attributes.find((attribute) => attribute.key === "service.name");
    expect(resource?.value.stringValue).toBe("metrics-only");
    const metrics = payload.resourceMetrics[0]!.scopeMetrics.flatMap((scope) => scope.metrics);
    const names = metrics.map((metric) => metric.name);
    for (const name of LEGACY_METRIC_NAMES) expect(names).toContain(name);
    const total = metrics.find((metric) => metric.name === "ao.http.requests.total")!;
    expect(total.sum).toMatchObject({ isMonotonic: true, aggregationTemporality: 2 });
  });

  it("the default protocol is protobuf (binary body)", async () => {
    const { bodies, url } = await sink();
    const pipeline = createMetricsPipeline({
      resourceAttributes: { "service.name": "proto" },
      export: { url, protocol: "http/protobuf", headers: {}, timeoutMs: 2000, intervalMs: 3_600_000 }
    });
    registerL2mMetrics(pipeline.meter, source);
    await pipeline.shutdown();
    expect(bodies[0]!.headers["content-type"]).toContain("protobuf");
  });

  it("the tracing runtime exports its meter, and counts spans lost to a failed export", async () => {
    const { bodies, url } = await sink();
    const dead = "http://127.0.0.1:1/v1/traces";
    const runtime: OtelRuntime = createOtelRuntime({
      resourceAttributes: { "service.name": "both" },
      export: { url: dead, protocol: "http/json", headers: {}, timeoutMs: 500 },
      metricsExport: { url, protocol: "http/json", headers: {}, timeoutMs: 2000, intervalMs: 3_600_000 },
      sampler: { name: "always_on" },
      propagators: ["tracecontext"],
      batch: { ...DEFAULT_BATCH_OPTIONS, scheduledDelayMs: 50, exportTimeoutMs: 1000 },
      attributeValueLengthLimit: 8192,
      spanDetail: "standard",
      naming: "names",
      propagateToProviders: false,
      propagateToMcp: true,
      semconvOptIn: [],
      recentSpanLimit: 10,
      registerGlobals: false
    });
    registerL2mMetrics(runtime.meter, source);
    const span = runtime.instrumentation.startSpan({ kind: "internal", name: "probe" } as never);
    span.end();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await runtime.shutdown();
    const text = bodies.map((entry) => entry.body.toString("utf8")).join("\n");
    expect(text).toContain("ao.http.requests.total");
    expect(text).toContain("l2m_otel_spans_dropped_total");
  });
});
