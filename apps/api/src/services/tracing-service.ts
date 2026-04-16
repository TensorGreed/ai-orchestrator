import crypto from "node:crypto";

export interface TracingOptions {
  enabled?: boolean;
  endpoint?: string;
  serviceName?: string;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
}

/**
 * Lightweight distributed tracing service. Produces span objects compatible
 * with the OpenTelemetry data model. When `TRACING_ENDPOINT` is set, spans
 * are flushed to an OTLP/HTTP collector; otherwise they are only available
 * via the in-memory query API used by the UI.
 */
export class TracingService {
  private readonly enabled: boolean;
  private readonly endpoint: string | null;
  private readonly serviceName: string;
  private readonly spans: Span[] = [];
  private readonly maxSpans = 5000;

  constructor(options: TracingOptions = {}) {
    this.enabled = options.enabled === true;
    this.endpoint = options.endpoint ?? null;
    this.serviceName = options.serviceName ?? "ai-orchestrator";
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  startSpan(input: {
    operationName: string;
    traceId?: string;
    parentSpanId?: string | null;
    attributes?: Record<string, string | number | boolean>;
  }): Span {
    const span: Span = {
      traceId: input.traceId ?? this.generateId(16),
      spanId: this.generateId(8),
      parentSpanId: input.parentSpanId ?? null,
      operationName: input.operationName,
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

  recentSpans(limit = 100): Span[] {
    return this.spans.slice(-Math.min(limit, this.maxSpans));
  }

  spansByTrace(traceId: string): Span[] {
    return this.spans.filter((s) => s.traceId === traceId);
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
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } }
            ]
          },
          scopeSpans: [
            {
              scope: { name: "ai-orchestrator" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? undefined,
                name: s.operationName,
                kind: 1,
                startTimeUnixNano: String(s.startTimeMs * 1_000_000),
                endTimeUnixNano: String((s.endTimeMs ?? s.startTimeMs) * 1_000_000),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value:
                    typeof value === "string"
                      ? { stringValue: value }
                      : typeof value === "number"
                        ? { intValue: String(value) }
                        : { boolValue: value }
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resourceSpans })
      });
    } catch {
      // fire and forget — tracing must not affect the hot path
    }
  }
}
