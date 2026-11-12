import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace";

export const SAMPLER_NAMES = [
  "always_on",
  "always_off",
  "traceidratio",
  "parentbased_always_on",
  "parentbased_always_off",
  "parentbased_traceidratio"
] as const;
export type SamplerName = (typeof SAMPLER_NAMES)[number];

export const PROPAGATOR_NAMES = ["tracecontext", "baggage", "none"] as const;
export type PropagatorName = (typeof PROPAGATOR_NAMES)[number];

export const OTLP_PROTOCOLS = ["http/protobuf", "http/json"] as const;
export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];

export type SpanDetail = "standard" | "verbose";
/** `names`: workflow, node and agent names appear in span names and attributes; `ids`: ids only. */
export type SpanNaming = "names" | "ids";

export interface OtlpTraceExportOptions {
  /** Full URL spans are POSTed to (the `/v1/traces` path included). */
  url: string;
  protocol: OtlpProtocol;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface BatchOptions {
  scheduledDelayMs: number;
  exportTimeoutMs: number;
  maxQueueSize: number;
  maxExportBatchSize: number;
}

export interface OtelRuntimeOptions {
  /** Resource attributes, `service.name` included, already merged from the deployment's settings. */
  resourceAttributes: Record<string, string>;
  /** Null: spans stay in this instance's recent-spans buffer only (no export). */
  export: OtlpTraceExportOptions | null;
  sampler: { name: SamplerName; ratio?: number };
  propagators: readonly PropagatorName[];
  batch: BatchOptions;
  /** Longest string attribute value; longer values are cut. */
  attributeValueLengthLimit: number;
  spanDetail: SpanDetail;
  naming: SpanNaming;
  propagateToProviders: boolean;
  propagateToMcp: boolean;
  /** `OTEL_SEMCONV_STABILITY_OPT_IN` entries (`gen_ai_latest_experimental` switches the GenAI metric names). */
  semconvOptIn: readonly string[];
  /** Size of the recent-spans buffer behind `/api/observability/traces`. */
  recentSpanLimit: number;
  /** Removes secret values from text before it becomes an attribute or event (error messages). */
  scrub?: (text: string) => string;
  /** Extra span processors, run before the exporter (tests add an in-memory exporter here). */
  spanProcessors?: readonly SpanProcessor[];
  /** Metric readers for the meter provider (none: metrics are recorded nowhere). */
  metricReaders?: readonly MetricReader[];
  /**
   * Register the tracer provider, context manager and propagator as the process-wide OpenTelemetry globals, so
   * libraries instrumented separately join L2M's traces. Default true. A second runtime in one process (tests)
   * cannot replace the first one's globals and works through its own references.
   */
  registerGlobals?: boolean;
}

export const DEFAULT_BATCH_OPTIONS: BatchOptions = Object.freeze({
  scheduledDelayMs: 5000,
  exportTimeoutMs: 30000,
  maxQueueSize: 2048,
  maxExportBatchSize: 512
});
