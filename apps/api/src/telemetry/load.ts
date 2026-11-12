/**
 * The lazy loader. While tracing is off it returns a frozen no-op and imports nothing from OpenTelemetry; when it is
 * on it imports `@ai-orchestrator/otel` (the only package that depends on the SDK) and builds the runtime.
 *
 * Only type imports from the otel package appear in this file: they are erased at compile time, so the module
 * graph of an API with tracing off never reaches `@opentelemetry/*` (telemetry-off.test.ts checks this).
 */
import type { MetricReader, MetricsPipeline, OtelRuntime, SpanProcessor } from "@ai-orchestrator/otel";
import { NOOP_RUN_INSTRUMENTATION, type RunInstrumentation } from "@ai-orchestrator/shared";
import type { TelemetrySettings } from "./settings.js";

/** Spans kept for `/api/observability/traces` (as before). */
export const RECENT_SPAN_LIMIT = 5000;

export interface Telemetry {
  readonly enabled: boolean;
  /** Null while tracing is off. */
  readonly runtime: OtelRuntime | null;
  /** The metrics pipeline: the runtime's while tracing is on, its own with only a metrics endpoint, else null. */
  readonly metrics: MetricsPipeline | null;
  /** What the engine, runtime and SDK packages are given: the no-op while tracing is off. */
  readonly instrumentation: RunInstrumentation;
  readonly settings: TelemetrySettings;
}

export interface LoadTelemetryOptions {
  /** Removes secret values from text recorded on spans (error messages). */
  scrub?: (text: string) => string;
  /** Extra span processors (tests collect spans in memory with these). */
  spanProcessors?: readonly SpanProcessor[];
  /** Register the process-wide OpenTelemetry globals (default true). */
  registerGlobals?: boolean;
  /** Extra metric readers (tests collect metrics in memory with these); used wherever a meter provider is built. */
  metricReaders?: readonly MetricReader[];
}

export async function loadTelemetry(settings: TelemetrySettings, options: LoadTelemetryOptions = {}): Promise<Telemetry> {
  const metricsExport = settings.metricsEndpoint
    ? {
        url: settings.metricsEndpoint,
        protocol: settings.protocol,
        headers: settings.headers,
        timeoutMs: settings.timeoutMs,
        intervalMs: settings.metricsIntervalMs
      }
    : null;
  if (!settings.enabled) {
    if (!metricsExport) {
      return Object.freeze({ enabled: false, runtime: null, metrics: null, instrumentation: NOOP_RUN_INSTRUMENTATION, settings });
    }
    // A metrics endpoint without tracing: only the meter provider and its reader are built (no tracer, no globals).
    const otel = await import("@ai-orchestrator/otel");
    const metrics = otel.createMetricsPipeline({
      resourceAttributes: settings.resourceAttributes,
      export: metricsExport,
      ...(options.metricReaders ? { readers: options.metricReaders } : {})
    });
    return Object.freeze({ enabled: false, runtime: null, metrics, instrumentation: NOOP_RUN_INSTRUMENTATION, settings });
  }
  const otel = await import("@ai-orchestrator/otel");
  const runtime = otel.createOtelRuntime({
    resourceAttributes: settings.resourceAttributes,
    export: settings.tracesEndpoint
      ? { url: settings.tracesEndpoint, protocol: settings.protocol, headers: settings.headers, timeoutMs: settings.timeoutMs }
      : null,
    sampler: settings.sampler,
    propagators: settings.propagators,
    batch: settings.batch,
    attributeValueLengthLimit: settings.attributeValueLengthLimit,
    spanDetail: settings.spanDetail,
    naming: settings.naming,
    propagateToProviders: settings.propagateToProviders,
    propagateToMcp: settings.propagateToMcp,
    semconvOptIn: settings.semconvOptIn,
    metricsExport,
    recentSpanLimit: RECENT_SPAN_LIMIT,
    ...(options.scrub ? { scrub: options.scrub } : {}),
    ...(options.spanProcessors ? { spanProcessors: options.spanProcessors } : {}),
    ...(options.metricReaders ? { metricReaders: options.metricReaders } : {}),
    ...(options.registerGlobals === false ? { registerGlobals: false } : {})
  });
  return Object.freeze({ enabled: true, runtime, metrics: runtime.metrics, instrumentation: runtime.instrumentation, settings });
}
