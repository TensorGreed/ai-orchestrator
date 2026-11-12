/**
 * L2M's OpenTelemetry support. This is the only package that imports `@opentelemetry/*`; the API loads it with a
 * dynamic import, and only when tracing is configured.
 */
export { createOtelRuntime, OtelRuntime, buildPropagator, buildSampler, type LogTraceFields } from "./runtime.js";
export { OtelRunInstrumentation, OtelSpanHandle, cleanAttributes, conversationIdFor, errorTypeOf, type StartSpanSpec } from "./instrumentation.js";
export { startHttpServerSpan, type HttpServerSpan, type HttpServerSpanInput, type InboundTraceUse } from "./http-server.js";
export { RecentSpansProcessor, toRecentSpan, type RecentSpan } from "./recent-spans.js";
export {
  DEFAULT_BATCH_OPTIONS,
  OTLP_PROTOCOLS,
  PROPAGATOR_NAMES,
  SAMPLER_NAMES,
  type BatchOptions,
  type OtelRuntimeOptions,
  type OtlpProtocol,
  type OtlpTraceExportOptions,
  type PropagatorName,
  type SamplerName,
  type SpanDetail,
  type SpanNaming
} from "./options.js";
export * from "./semconv.js";
// SDK types and the in-memory exporter, re-exported so the API's tests can collect spans without depending on the SDK.
export { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
