import { context as contextApi, propagation, trace, type Context, type Meter, type TextMapPropagator } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, ExportResultCode, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter as OTLPJsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
  type SpanProcessor
} from "@opentelemetry/sdk-trace";
import type { TraceIds } from "@ai-orchestrator/shared";
import { MetricsPipeline } from "./metrics.js";
import { startHttpServerSpan, type HttpServerSpan, type HttpServerSpanInput } from "./http-server.js";
import { OtelRunInstrumentation } from "./instrumentation.js";
import type { OtelRuntimeOptions, OtlpTraceExportOptions, PropagatorName, SamplerName } from "./options.js";
import { RecentSpansProcessor, type RecentSpan } from "./recent-spans.js";
import { INSTRUMENTATION_SCOPE, SEMCONV_SCHEMA_URL } from "./semconv.js";

/** How long shutdown waits for the last spans to export. */
const SHUTDOWN_TIMEOUT_MS = 5000;

export function buildSampler(name: SamplerName, ratio = 1): Sampler {
  const bounded = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1;
  switch (name) {
    case "always_on":
      return new AlwaysOnSampler();
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return new TraceIdRatioBasedSampler(bounded);
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(bounded) });
    case "parentbased_always_on":
    default:
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
}

export function buildPropagator(names: readonly PropagatorName[]): TextMapPropagator {
  const propagators: TextMapPropagator[] = [];
  if (names.includes("tracecontext")) propagators.push(new W3CTraceContextPropagator());
  if (names.includes("baggage")) propagators.push(new W3CBaggagePropagator());
  return new CompositePropagator({ propagators });
}

function buildExporter(options: OtlpTraceExportOptions, onDropped: (count: number) => void): SpanExporter {
  const config = { url: options.url, headers: { ...options.headers }, timeoutMillis: options.timeoutMs };
  const exporter = options.protocol === "http/json" ? new OTLPJsonTraceExporter(config) : new OTLPProtoTraceExporter(config);
  // The batch processor discards a batch whose export fails; count those spans for l2m_otel_spans_dropped_total.
  return {
    export(spans, resultCallback) {
      exporter.export(spans, (result) => {
        if (result.code !== ExportResultCode.SUCCESS) onDropped(spans.length);
        resultCallback(result);
      });
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush()
  };
}

/** The ids written into log lines (`trace_id`, `span_id`, `trace_flags`). */
export interface LogTraceFields {
  trace_id: string;
  span_id: string;
  trace_flags: string;
}

/**
 * Everything the API needs from OpenTelemetry, built once at start-up when tracing is configured. Nothing here is
 * reachable while tracing is off: the API imports this package only after it has decided tracing is on.
 */
export class OtelRuntime {
  readonly instrumentation: OtelRunInstrumentation;
  readonly resource: Resource;
  readonly meter: Meter;
  readonly semconvLatestGenAi: boolean;
  private readonly tracerProvider: TracerProvider;
  readonly metrics: MetricsPipeline;
  private readonly contextManager: AsyncLocalStorageContextManager;
  private readonly recentSpans: RecentSpansProcessor;
  private readonly ownsGlobals: boolean;
  private stopped: Promise<void> | null = null;

  constructor(readonly options: OtelRuntimeOptions) {
    const scrub = options.scrub ?? ((text: string) => text);
    this.resource = defaultResource().merge(resourceFromAttributes(options.resourceAttributes));
    this.recentSpans = new RecentSpansProcessor(options.recentSpanLimit);
    this.metrics = new MetricsPipeline(this.resource, { export: options.metricsExport ?? null, readers: options.metricReaders ?? [] });
    this.meter = this.metrics.meter;
    const droppedSpans = this.meter.createCounter("l2m_otel_spans_dropped_total", {
      description: "Spans discarded because their export to the collector failed",
      unit: "{span}"
    });
    const processors: SpanProcessor[] = [this.recentSpans, ...(options.spanProcessors ?? [])];
    if (options.export) {
      processors.push(
        new BatchSpanProcessor({
          exporter: buildExporter(options.export, (count) => droppedSpans.add(count, { reason: "export_failed" })),
          scheduledDelayMillis: options.batch.scheduledDelayMs,
          exportTimeoutMillis: options.batch.exportTimeoutMs,
          maxQueueSize: options.batch.maxQueueSize,
          maxExportBatchSize: Math.min(options.batch.maxExportBatchSize, options.batch.maxQueueSize)
        })
      );
    }
    this.tracerProvider = new TracerProvider({
      resource: this.resource,
      sampler: buildSampler(options.sampler.name, options.sampler.ratio),
      spanLimits: { attributeValueLengthLimit: options.attributeValueLengthLimit },
      spanProcessors: processors
    });
    this.contextManager = new AsyncLocalStorageContextManager();
    this.contextManager.enable();
    const propagator = buildPropagator(options.propagators);
    const tracer = this.tracerProvider.getTracer(INSTRUMENTATION_SCOPE, undefined, { schemaUrl: SEMCONV_SCHEMA_URL });
    this.instrumentation = new OtelRunInstrumentation({
      tracer,
      contextManager: this.contextManager,
      propagator,
      internalPropagator: new W3CTraceContextPropagator(),
      options,
      scrub
    });
    this.semconvLatestGenAi = options.semconvOptIn.includes("gen_ai_latest_experimental");

    let registered = false;
    if (options.registerGlobals !== false) {
      // Each set* returns false when another provider already holds the global; then this runtime keeps to its own
      // references and leaves the globals alone at shutdown.
      registered = contextApi.setGlobalContextManager(this.contextManager);
      if (registered) {
        trace.setGlobalTracerProvider(this.tracerProvider);
        propagation.setGlobalPropagator(propagator);
      }
    }
    this.ownsGlobals = registered;
  }

  /** Starts the SERVER span of an HTTP request (stable HTTP conventions); run the handler in `context`. */
  startHttpServerSpan(input: HttpServerSpanInput): HttpServerSpan {
    return startHttpServerSpan(this.instrumentation, input);
  }

  /** Runs `fn` in `context` (with the span it holds active). */
  withContext<T>(context: Context, fn: () => T): T {
    return this.contextManager.with(context, fn);
  }

  activeTraceIds(): TraceIds | null {
    return this.instrumentation.activeTraceIds();
  }

  /** The active span's ids for a log line, or null outside any span. */
  logFields(): LogTraceFields | null {
    const ids = this.instrumentation.activeTraceIds();
    return ids ? { trace_id: ids.traceId, span_id: ids.spanId, trace_flags: ids.traceFlags } : null;
  }

  recent(limit?: number): RecentSpan[] {
    return this.recentSpans.recent(limit);
  }

  spansByTrace(traceId: string): RecentSpan[] {
    return this.recentSpans.byTrace(traceId);
  }

  resourceAttributes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.resource.attributes)) {
      if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  }

  forceFlush(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    return withTimeout(Promise.all([this.tracerProvider.forceFlush({ timeoutMillis: timeoutMs }), this.metrics.forceFlush(timeoutMs)]).then(() => undefined), timeoutMs);
  }

  /** Flushes and stops exporting (capped at five seconds); idempotent. */
  shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (!this.stopped) {
      this.stopped = (async () => {
        try {
          await withTimeout(
            Promise.all([this.tracerProvider.shutdown(), this.metrics.shutdown(timeoutMs)]).then(() => undefined),
            timeoutMs
          );
        } finally {
          this.contextManager.disable();
          if (this.ownsGlobals) {
            trace.disable();
            propagation.disable();
            contextApi.disable();
          }
        }
      })();
    }
    return this.stopped;
  }
}

function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

export function createOtelRuntime(options: OtelRuntimeOptions): OtelRuntime {
  return new OtelRuntime(options);
}
