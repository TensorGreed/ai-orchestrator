/** Tracing set up for tests: settings with tracing on (no export) and the loaded runtime, without a whole API. */
import type { TelemetrySettings } from "../telemetry/settings.js";
import { loadTelemetry, type Telemetry } from "../telemetry/load.js";
import type { SpanProcessor } from "@ai-orchestrator/otel";

export function testTelemetrySettings(overrides: Partial<TelemetrySettings> = {}): TelemetrySettings {
  return {
    enabled: true,
    tracesEndpoint: null,
    metricsEndpoint: null,
    protocol: "http/protobuf",
    headers: {},
    timeoutMs: 10_000,
    serviceName: "ut",
    resourceAttributes: { "service.name": "ut" },
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: { scheduledDelayMs: 5000, exportTimeoutMs: 30_000, maxQueueSize: 2048, maxExportBatchSize: 512 },
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    httpServerSpans: true,
    trustInbound: "authenticated",
    trustedProxies: [],
    warnings: [],
    ...overrides
  };
}

/** Loads the runtime (globals left alone). Call `telemetry.runtime?.shutdown()` when done. */
export async function loadTestTelemetry(
  overrides: Partial<TelemetrySettings> = {},
  spanProcessors: readonly SpanProcessor[] = []
): Promise<Telemetry> {
  return await loadTelemetry(testTelemetrySettings(overrides), { spanProcessors, registerGlobals: false });
}
