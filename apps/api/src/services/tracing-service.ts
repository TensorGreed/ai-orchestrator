import crypto from "node:crypto";
import os from "node:os";

export interface TracingOptions {
  enabled?: boolean;
  endpoint?: string;
  serviceName?: string;
  /**
   * Resource attributes attached to every span batch. service.name/version,
   * deployment.environment, host.name etc. live here. Phase 8.1 enriches the
   * default set in `app.ts` from the standard OTEL_* env vars.
   */
  resourceAttributes?: Record<string, string>;
  /** Extra HTTP headers on every OTLP POST (auth, tenancy). */
  otlpHeaders?: Record<string, string>;
}

export type SpanKind = "internal" | "server" | "client" | "producer" | "consumer";

const SPAN_KIND_CODES: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5
};

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  kind: SpanKind;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
}

/**
 * W3C trace-context value:
 *   `00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>`
 * Returns null on any parse failure so the caller can fall back to a fresh
 * trace ID without surfacing client errors.
 */
export function parseTraceparent(headerValue: string | undefined): {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
} | null {
  if (!headerValue) return null;
  const value = headerValue.trim();
  const parts = value.split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentSpanId, flags] = parts;
  if (version !== "00") return null;
  if (!/^[0-9a-f]{32}$/.test(traceId ?? "")) return null;
  if (!/^[0-9a-f]{16}$/.test(parentSpanId ?? "")) return null;
  if (!/^[0-9a-f]{2}$/.test(flags ?? "")) return null;
  return {
    traceId: traceId!,
    parentSpanId: parentSpanId!,
    sampled: (parseInt(flags!, 16) & 0x01) === 1
  };
}

/**
 * Lightweight distributed tracing service. Produces OTLP/HTTP-JSON-compatible
 * span batches. Phase 8.1 adds W3C trace-context parsing, resource enrichment
 * (host.name + service.version + deployment.environment), span kinds, and
 * configurable OTLP headers (Honeycomb / Grafana Cloud / Tempo auth).
 *
 * In-memory ring buffer is kept for the existing /api/observability/traces UI
 * regardless of whether OTLP export is enabled.
 */
export class TracingService {
  private readonly enabled: boolean;
  private readonly endpoint: string | null;
  private readonly serviceName: string;
  private readonly resourceAttributes: Record<string, string>;
  private readonly otlpHeaders: Record<string, string>;
  private readonly spans: Span[] = [];
  private readonly maxSpans = 5000;

  constructor(options: TracingOptions = {}) {
    this.enabled = options.enabled === true;
    this.endpoint = options.endpoint ?? null;
    this.serviceName = options.serviceName ?? "ai-orchestrator";
    this.resourceAttributes = {
      "service.name": this.serviceName,
      "host.name": os.hostname(),
      "process.pid": String(process.pid),
      "telemetry.sdk.name": "ai-orchestrator",
      "telemetry.sdk.language": "nodejs",
      ...(options.resourceAttributes ?? {})
    };
    this.otlpHeaders = options.otlpHeaders ?? {};
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  startSpan(input: {
    operationName: string;
    traceId?: string;
    parentSpanId?: string | null;
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }): Span {
    const span: Span = {
      traceId: input.traceId ?? this.generateId(16),
      spanId: this.generateId(8),
      parentSpanId: input.parentSpanId ?? null,
      operationName: input.operationName,
      kind: input.kind ?? "internal",
      startTimeMs: Date.now(),
      endTimeMs: null,
      durationMs: null,
      attributes: {
        "service.name": this.serviceName,
        ...(input.attributes ?? {})
      },
      status: "unset",
      events: []
    };
    return span;
  }

  endSpan(span: Span, status: "ok" | "error" = "ok"): void {
    span.endTimeMs = Date.now();
    span.durationMs = span.endTimeMs - span.startTimeMs;
    span.status = status;
    if (this.enabled) {
      this.spans.push(span);
      if (this.spans.length > this.maxSpans) {
        this.spans.splice(0, this.spans.length - this.maxSpans);
      }
      if (this.endpoint) {
        void this.flush([span]);
      }
    }
  }

  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({ name, timestampMs: Date.now(), attributes });
  }

  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  recentSpans(limit = 100): Span[] {
    return this.spans.slice(-Math.min(limit, this.maxSpans));
  }

  spansByTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  /** Render a `traceparent` value for outgoing requests / log correlation. */
  toTraceparent(span: Span): string {
    return `00-${span.traceId}-${span.spanId}-01`;
  }

  getResourceAttributes(): Record<string, string> {
    return { ...this.resourceAttributes };
  }

  private generateId(bytes: number): string {
    return crypto.randomBytes(bytes).toString("hex");
  }

  private async flush(spans: Span[]): Promise<void> {
    if (!this.endpoint) return;
    try {
      const resourceSpans = [
        {
          resource: {
            attributes: this.resourceAttributesForOtlp()
          },
          scopeSpans: [
            {
              scope: { name: "ai-orchestrator" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? undefined,
                name: s.operationName,
                kind: SPAN_KIND_CODES[s.kind],
                startTimeUnixNano: String(s.startTimeMs * 1_000_000),
                endTimeUnixNano: String((s.endTimeMs ?? s.startTimeMs) * 1_000_000),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: encodeAttributeValue(value)
                })),
                events: s.events.map((e) => ({
                  timeUnixNano: String(e.timestampMs * 1_000_000),
                  name: e.name,
                  attributes: e.attributes
                    ? Object.entries(e.attributes).map(([key, value]) => ({
                        key,
                        value: encodeAttributeValue(value as string | number | boolean)
                      }))
                    : []
                })),
                status: {
                  code: s.status === "ok" ? 1 : s.status === "error" ? 2 : 0
                }
              }))
            }
          ]
        }
      ];
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.otlpHeaders },
        body: JSON.stringify({ resourceSpans })
      });
    } catch {
      // fire and forget — tracing must not affect the hot path
    }
  }

  private resourceAttributesForOtlp(): Array<{ key: string; value: unknown }> {
    return Object.entries(this.resourceAttributes).map(([key, value]) => ({
      key,
      value: { stringValue: value }
    }));
  }
}

function encodeAttributeValue(value: string | number | boolean): unknown {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES`/`OTEL_EXPORTER_OTLP_HEADERS`-style
 * `key1=value1,key2=value2` strings into a Record. Whitespace around tokens
 * is trimmed; empty values are dropped. Invalid pairs are silently skipped
 * rather than blocking startup — observability config is best-effort.
 */
export function parseKeyValueList(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}
