import { SpanKind, SpanStatusCode, type AttributeValue, type Attributes, type HrTime } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";

/** The span shape `/api/observability/traces` has always returned (Phase 5.7), kept for the Settings page. */
export interface RecentSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  startTimeMs: number;
  endTimeMs: number | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; timestampMs: number; attributes?: Record<string, unknown> }>;
}

const KIND_NAMES: Record<SpanKind, RecentSpan["kind"]> = {
  [SpanKind.INTERNAL]: "internal",
  [SpanKind.SERVER]: "server",
  [SpanKind.CLIENT]: "client",
  [SpanKind.PRODUCER]: "producer",
  [SpanKind.CONSUMER]: "consumer"
};

function hrTimeToMs(time: HrTime): number {
  return Math.round(time[0] * 1000 + time[1] / 1e6);
}

function flatValue(value: AttributeValue | undefined): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value as string | number | boolean;
}

function flatAttributes(attributes: Attributes): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const flat = flatValue(value);
    if (flat !== undefined) out[key] = flat;
  }
  return out;
}

export function toRecentSpan(span: ReadableSpan): RecentSpan {
  const context = span.spanContext();
  const startTimeMs = hrTimeToMs(span.startTime);
  const endTimeMs = span.ended ? hrTimeToMs(span.endTime) : null;
  const serviceName = span.resource.attributes["service.name"];
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    operationName: span.name,
    kind: KIND_NAMES[span.kind] ?? "internal",
    startTimeMs,
    endTimeMs,
    durationMs: endTimeMs === null ? null : endTimeMs - startTimeMs,
    attributes: {
      ...(typeof serviceName === "string" ? { "service.name": serviceName } : {}),
      ...flatAttributes(span.attributes)
    },
    status: span.status.code === SpanStatusCode.ERROR ? "error" : span.status.code === SpanStatusCode.OK ? "ok" : "unset",
    events: span.events.map((event) => ({
      name: event.name,
      timestampMs: hrTimeToMs(event.time),
      ...(event.attributes ? { attributes: flatAttributes(event.attributes) } : {})
    }))
  };
}

/**
 * Keeps the last `limit` ended spans of this instance for `/api/observability/traces`. It sees only sampled spans,
 * like every other processor.
 */
export class RecentSpansProcessor implements SpanProcessor {
  private readonly spans: RecentSpan[] = [];

  constructor(private readonly limit: number) {}

  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    this.spans.push(toRecentSpan(span));
    if (this.spans.length > this.limit) this.spans.splice(0, this.spans.length - this.limit);
  }

  recent(limit = 100): RecentSpan[] {
    return this.spans.slice(-Math.max(0, Math.min(limit, this.limit)));
  }

  byTrace(traceId: string): RecentSpan[] {
    return this.spans.filter((span) => span.traceId === traceId);
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
