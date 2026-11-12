import type { OtelRuntime, OtelSpanHandle, RecentSpan } from "@ai-orchestrator/otel";
import { parseTraceparentHeader } from "@ai-orchestrator/shared";
import { parseOtelKeyValueList } from "../telemetry/settings.js";

export type SpanKind = RecentSpan["kind"];

/** The span shape `/api/observability/traces` returns (unchanged since Phase 5.7). */
export type Span = RecentSpan;

export interface TracingOptions {
  /**
   * The OpenTelemetry runtime, present only while tracing is on (see telemetry/load.ts). Without it the service is
   * off: spans are plain objects that are never recorded or exported.
   */
  runtime?: OtelRuntime | null;
  /** Where spans are exported, for `/api/observability`. */
  tracesEndpoint?: string | null;
  /** Resource attributes reported while tracing is off (the runtime reports its own while on). */
  resourceAttributes?: Record<string, string>;
}

/**
 * W3C trace-context value: `00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>`. Returns null on any parse failure
 * so the caller can fall back to a fresh trace without surfacing client errors.
 */
export function parseTraceparent(headerValue: string | undefined): { traceId: string; parentSpanId: string; sampled: boolean } | null {
  const parsed = parseTraceparentHeader(headerValue);
  if (!parsed || !headerValue?.trim().startsWith("00-")) return null;
  return { traceId: parsed.traceId, parentSpanId: parsed.spanId, sampled: parsed.sampled };
}

/** Parses `key1=value1,key2=value2` (OTEL_RESOURCE_ATTRIBUTES / OTEL_EXPORTER_OTLP_HEADERS), percent-decoded. */
export const parseKeyValueList = parseOtelKeyValueList;

/**
 * The Phase 5.7 / 8.1 tracing API, now over the OpenTelemetry SDK: spans started here are SDK spans, exported in
 * batches by the runtime's OTLP exporter, and the recent-spans buffer behind `/api/observability/traces` is a span
 * processor. New code should use the `RunInstrumentation` seam (`telemetry.instrumentation`) instead.
 */
export class TracingService {
  private readonly runtime: OtelRuntime | null;
  private readonly tracesEndpoint: string | null;
  private readonly offResourceAttributes: Record<string, string>;
  private readonly handles = new WeakMap<Span, OtelSpanHandle>();

  constructor(options: TracingOptions = {}) {
    this.runtime = options.runtime ?? null;
    this.tracesEndpoint = options.tracesEndpoint ?? null;
    this.offResourceAttributes = { ...(options.resourceAttributes ?? {}) };
  }

  isEnabled(): boolean {
    return this.runtime !== null;
  }

  getTracesEndpoint(): string | null {
    return this.runtime ? this.tracesEndpoint : null;
  }

  /**
   * Starts a span: a child of the active span, or of the remote parent given by `traceId` + `parentSpanId`. While
   * tracing is off the returned object is inert.
   */
  startSpan(input: {
    operationName: string;
    traceId?: string;
    parentSpanId?: string | null;
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }): Span {
    const now = Date.now();
    if (!this.runtime) {
      return {
        traceId: input.traceId ?? "",
        spanId: "",
        parentSpanId: input.parentSpanId ?? null,
        operationName: input.operationName,
        kind: input.kind ?? "internal",
        startTimeMs: now,
        endTimeMs: null,
        durationMs: null,
        attributes: { ...(input.attributes ?? {}) },
        status: "unset",
        events: []
      };
    }
    const instrumentation = this.runtime.instrumentation;
    const remoteParent =
      input.traceId && input.parentSpanId ? instrumentation.extract({ traceparent: `00-${input.traceId}-${input.parentSpanId}-01` }) : null;
    const handle = instrumentation.startSpan({
      name: input.operationName,
      kind: input.kind ?? "internal",
      ...(input.attributes ? { attributes: input.attributes } : {}),
      ...(remoteParent ? { parent: remoteParent } : {})
    });
    const parentSpanId = remoteParent ? input.parentSpanId! : (this.runtime.activeTraceIds()?.spanId ?? null);
    const span: Span = {
      traceId: handle.traceId,
      spanId: handle.spanId,
      parentSpanId,
      operationName: input.operationName,
      kind: input.kind ?? "internal",
      startTimeMs: now,
      endTimeMs: null,
      durationMs: null,
      attributes: { ...(input.attributes ?? {}) },
      status: "unset",
      events: []
    };
    this.handles.set(span, handle);
    return span;
  }

  endSpan(span: Span, status: "ok" | "error" = "ok"): void {
    span.endTimeMs = Date.now();
    span.durationMs = span.endTimeMs - span.startTimeMs;
    span.status = status;
    const handle = this.handles.get(span);
    if (!handle) return;
    this.handles.delete(span);
    if (status === "error") handle.recordError(undefined, { type: "_OTHER" });
    else handle.markOk();
    handle.end();
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({ name, timestampMs: Date.now(), attributes });
    const handle = this.handles.get(span);
    if (!handle) return;
    const primitive: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") primitive[key] = value;
    }
    handle.span.addEvent(name, primitive);
  }

  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
    this.handles.get(span)?.setAttributes({ [key]: value });
  }

  /** The most recent ended spans of this instance (empty while tracing is off). */
  recentSpans(limit = 100): Span[] {
    return this.runtime ? this.runtime.recent(limit) : [];
  }

  spansByTrace(traceId: string): Span[] {
    return this.runtime ? this.runtime.spansByTrace(traceId) : [];
  }

  /** Render a `traceparent` value for outgoing requests / log correlation. */
  toTraceparent(span: Span): string {
    return `00-${span.traceId}-${span.spanId}-01`;
  }

  getResourceAttributes(): Record<string, string> {
    return this.runtime ? this.runtime.resourceAttributes() : { ...this.offResourceAttributes };
  }
}
