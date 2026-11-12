/**
 * The lazy loader. While tracing is off it returns a frozen no-op and imports nothing from OpenTelemetry; when it is
 * on it imports `@ai-orchestrator/otel` (the only package that depends on the SDK) and builds the runtime.
 *
 * Only type imports from the otel package appear in this file: they are erased at compile time, so the module
 * graph of an API with tracing off never reaches `@opentelemetry/*` (telemetry-off.test.ts checks this).
 */
import type { OtelRuntime, SpanProcessor } from "@ai-orchestrator/otel";
import { NOOP_RUN_INSTRUMENTATION, type RunInstrumentation } from "@ai-orchestrator/shared";
import type { TelemetrySettings } from "./settings.js";

/** Spans kept for `/api/observability/traces` (as before). */
export const RECENT_SPAN_LIMIT = 5000;

export interface Telemetry {
  readonly enabled: boolean;
  /** Null while tracing is off. */
  readonly runtime: OtelRuntime | null;
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
}

export async function loadTelemetry(settings: TelemetrySettings, options: LoadTelemetryOptions = {}): Promise<Telemetry> {
  if (!settings.enabled) {
    return Object.freeze({ enabled: false, runtime: null, instrumentation: NOOP_RUN_INSTRUMENTATION, settings });
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
    recentSpanLimit: RECENT_SPAN_LIMIT,
    ...(options.scrub ? { scrub: options.scrub } : {}),
    ...(options.spanProcessors ? { spanProcessors: options.spanProcessors } : {}),
    ...(options.registerGlobals === false ? { registerGlobals: false } : {})
  });
  return Object.freeze({ enabled: true, runtime, instrumentation: runtime.instrumentation, settings });
}
