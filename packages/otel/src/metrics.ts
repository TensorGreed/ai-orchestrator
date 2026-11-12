import { ValueType, type Meter } from "@opentelemetry/api";
import { OTLPMetricExporter as OTLPJsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import type { OtlpMetricExportOptions } from "./options.js";
import { INSTRUMENTATION_SCOPE, SEMCONV_SCHEMA_URL } from "./semconv.js";

/** How long a metrics flush or shutdown waits for the collector. */
const METRICS_TIMEOUT_MS = 5000;

/**
 * The numbers behind L2M's metrics, read at every collection. `MetricsService.getSnapshot()` has this shape; the
 * interface is structural so this package does not depend on the API.
 */
export interface MetricsSnapshotSource {
  getSnapshot(): {
    httpRequestsTotal: number;
    executionsTotal: number;
    executionsSuccess: number;
    executionsFailure: number;
    activeExecutions: number;
    executionP50Ms: number;
    executionP95Ms: number;
    executionP99Ms: number;
    httpP50Ms: number;
    httpP95Ms: number;
    slo: { currentSuccessRate: number; healthy: boolean };
    uptimeSeconds: number;
  };
}

/** What the API calls as events happen, so duration histograms get real observations. */
export interface MetricsRecorder {
  recordExecution(status: "success" | "error" | "canceled", durationMs: number): void;
  recordHttpRequest(method: string, statusCode: number, durationMs: number): void;
}

/** The metric names L2M has always pushed, kept as they are (dashboards depend on them). */
export const LEGACY_METRIC_NAMES = Object.freeze([
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
] as const);

/** Duration histograms in seconds (new in this release; the percentile gauges above stay, deprecated). */
export const HISTOGRAM_METRIC_NAMES = Object.freeze(["ao.workflow.execution.duration", "ao.http.request.duration"] as const);

const DURATION_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

const DEPRECATED = " (deprecated: use the matching histogram)";

type SnapshotOf = ReturnType<MetricsSnapshotSource["getSnapshot"]>;

/**
 * Registers the `ao.*` instruments on `meter`. Counters and gauges are observable: each collection reads the
 * current snapshot, so existing counts are exported without touching the code that records them (cumulative Sum for
 * counters, Gauge for the rest, exactly as the previous hand-built push). Returns a recorder for the histograms.
 */
export function registerL2mMetrics(meter: Meter, source: MetricsSnapshotSource): MetricsRecorder {
  const int = { valueType: ValueType.INT };
  const counters: Array<[string, string, (s: SnapshotOf) => number]> = [
    ["ao.http.requests.total", "Total HTTP requests processed", (s) => s.httpRequestsTotal],
    ["ao.workflow.executions.total", "Total workflow executions", (s) => s.executionsTotal],
    ["ao.workflow.executions.success.total", "Successful executions", (s) => s.executionsSuccess],
    ["ao.workflow.executions.failure.total", "Failed/canceled executions", (s) => s.executionsFailure]
  ];
  const gauges: Array<[string, string, string, (s: SnapshotOf) => number, ValueType]> = [
    ["ao.workflow.executions.active", "Currently active workflow executions", "1", (s) => s.activeExecutions, ValueType.INT],
    ["ao.workflow.execution.duration.p50.ms", "Execution latency p50" + DEPRECATED, "ms", (s) => s.executionP50Ms, ValueType.INT],
    ["ao.workflow.execution.duration.p95.ms", "Execution latency p95" + DEPRECATED, "ms", (s) => s.executionP95Ms, ValueType.INT],
    ["ao.workflow.execution.duration.p99.ms", "Execution latency p99" + DEPRECATED, "ms", (s) => s.executionP99Ms, ValueType.INT],
    ["ao.http.request.duration.p50.ms", "HTTP latency p50" + DEPRECATED, "ms", (s) => s.httpP50Ms, ValueType.INT],
    ["ao.http.request.duration.p95.ms", "HTTP latency p95" + DEPRECATED, "ms", (s) => s.httpP95Ms, ValueType.INT],
    ["ao.slo.success.rate", "Current execution success rate", "1", (s) => s.slo.currentSuccessRate, ValueType.DOUBLE],
    ["ao.slo.healthy", "1 if SLOs are met, 0 otherwise", "1", (s) => (s.slo.healthy ? 1 : 0), ValueType.INT],
    ["ao.uptime.seconds", "Process uptime in seconds", "s", (s) => s.uptimeSeconds, ValueType.INT]
  ];

  const counterInstruments = counters.map(([name, description]) => meter.createObservableCounter(name, { description, ...int }));
  const gaugeInstruments = gauges.map(([name, description, unit, , valueType]) =>
    meter.createObservableGauge(name, { description, unit, valueType })
  );

  meter.addBatchObservableCallback(
    (result) => {
      let snapshot: SnapshotOf;
      try {
        snapshot = source.getSnapshot();
      } catch {
        return;
      }
      counters.forEach(([, , read], index) => result.observe(counterInstruments[index]!, Math.trunc(read(snapshot))));
      gauges.forEach(([, , , read, valueType], index) => {
        const value = read(snapshot);
        result.observe(gaugeInstruments[index]!, valueType === ValueType.INT ? Math.trunc(value) : value);
      });
    },
    [...counterInstruments, ...gaugeInstruments]
  );

  const executionDuration = meter.createHistogram("ao.workflow.execution.duration", {
    description: "Workflow execution duration",
    unit: "s",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS }
  });
  const httpDuration = meter.createHistogram("ao.http.request.duration", {
    description: "HTTP request duration",
    unit: "s",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS }
  });

  return {
    recordExecution(status, durationMs) {
      executionDuration.record(Math.max(0, durationMs) / 1000, { "l2m.execution.status": status });
    },
    recordHttpRequest(method, statusCode, durationMs) {
      httpDuration.record(Math.max(0, durationMs) / 1000, {
        "http.request.method": method.toUpperCase(),
        "http.response.status_class": `${Math.floor(statusCode / 100)}xx`
      });
    }
  };
}

function buildMetricExporter(options: OtlpMetricExportOptions) {
  const config = { url: options.url, headers: { ...options.headers }, timeoutMillis: options.timeoutMs };
  return options.protocol === "http/json" ? new OTLPJsonMetricExporter(config) : new OTLPProtoMetricExporter(config);
}

/**
 * A meter provider with its OTLP reader. The tracing runtime owns one (so `OtelRuntime.meter` records somewhere when
 * a metrics endpoint is set), and a metrics-only deployment (an endpoint for metrics, tracing off) builds one on its
 * own with `createMetricsPipeline`.
 */
export class MetricsPipeline {
  readonly meter: Meter;
  private readonly provider: MeterProvider;
  private stopped: Promise<void> | null = null;

  constructor(resource: Resource, options: { export?: OtlpMetricExportOptions | null; readers?: readonly MetricReader[] }) {
    const readers: MetricReader[] = [...(options.readers ?? [])];
    if (options.export) {
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: buildMetricExporter(options.export),
          exportIntervalMillis: options.export.intervalMs,
          exportTimeoutMillis: Math.min(options.export.timeoutMs, options.export.intervalMs)
        })
      );
    }
    this.provider = new MeterProvider({ resource, readers });
    this.meter = this.provider.getMeter(INSTRUMENTATION_SCOPE, undefined, { schemaUrl: SEMCONV_SCHEMA_URL });
  }

  forceFlush(timeoutMs = METRICS_TIMEOUT_MS): Promise<void> {
    return withTimeout(this.provider.forceFlush({ timeoutMillis: timeoutMs }), timeoutMs);
  }

  /** Exports once more and stops (capped at five seconds); idempotent. */
  shutdown(timeoutMs = METRICS_TIMEOUT_MS): Promise<void> {
    this.stopped ??= withTimeout(this.provider.shutdown({ timeoutMillis: timeoutMs }), timeoutMs);
    return this.stopped;
  }
}

export interface MetricsPipelineOptions {
  resourceAttributes: Record<string, string>;
  export: OtlpMetricExportOptions | null;
  readers?: readonly MetricReader[];
}

/** For deployments that export metrics without tracing: no tracer provider, context manager or globals. */
export function createMetricsPipeline(options: MetricsPipelineOptions): MetricsPipeline {
  const resource = defaultResource().merge(resourceFromAttributes(options.resourceAttributes));
  return new MetricsPipeline(resource, { export: options.export, ...(options.readers ? { readers: options.readers } : {}) });
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
