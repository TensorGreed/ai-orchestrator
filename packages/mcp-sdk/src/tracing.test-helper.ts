import { AsyncLocalStorage } from "node:async_hooks";
import {
  NOOP_RUN_INSTRUMENTATION,
  type InstrumentationAttributes,
  type InstrumentationSpan,
  type McpRequestSpanInfo,
  type RunInstrumentation,
  type TraceCarrier,
  type TraceInjectTarget
} from "@ai-orchestrator/shared";

/** A span the recording instrumentation opened. */
export interface RecordedSpan extends InstrumentationSpan {
  info: McpRequestSpanInfo;
  parent?: RecordedSpan;
  attributes: Record<string, unknown>;
  errorType?: string;
  ended: boolean;
}

export const TEST_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

/**
 * A recording `RunInstrumentation` without OpenTelemetry: MCP spans nest through AsyncLocalStorage, `inject` writes
 * the active span's id as a W3C `traceparent`, `annotate` sets attributes on the active span.
 */
export class RecordingInstrumentation implements RunInstrumentation {
  readonly enabled = true;
  readonly spans: RecordedSpan[] = [];
  /** What `inject` adds besides `traceparent` (a `tracestate`, `baggage`). */
  extra: TraceCarrier = {};
  propagate = true;
  private readonly active = new AsyncLocalStorage<RecordedSpan>();
  private counter = 0;

  run = NOOP_RUN_INSTRUMENTATION.run;
  node = NOOP_RUN_INSTRUMENTATION.node;
  agent = NOOP_RUN_INSTRUMENTATION.agent;
  iteration = NOOP_RUN_INSTRUMENTATION.iteration;
  modelCall = NOOP_RUN_INSTRUMENTATION.modelCall;
  toolCall = NOOP_RUN_INSTRUMENTATION.toolCall;
  span = NOOP_RUN_INSTRUMENTATION.span;
  startNode = NOOP_RUN_INSTRUMENTATION.startNode;
  startIteration = NOOP_RUN_INSTRUMENTATION.startIteration;
  startToolCall = NOOP_RUN_INSTRUMENTATION.startToolCall;
  withParent = NOOP_RUN_INSTRUMENTATION.withParent;
  withNewTrace = NOOP_RUN_INSTRUMENTATION.withNewTrace;
  activeTraceIds = NOOP_RUN_INSTRUMENTATION.activeTraceIds;

  async mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
    this.counter += 1;
    const parent = this.active.getStore();
    const attributes: Record<string, unknown> = {};
    const span: RecordedSpan = {
      info,
      ...(parent ? { parent } : {}),
      attributes,
      ended: false,
      recording: true,
      traceId: TEST_TRACE_ID,
      spanId: this.counter.toString(16).padStart(16, "0"),
      setAttributes(values: InstrumentationAttributes) {
        for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) attributes[key] = value;
      },
      recordError(_error: unknown, options?: { type?: string }) {
        // As the OTel implementation does: a JSON-RPC code seen during the request is the error type.
        if (span.errorType !== undefined) return;
        const code = attributes["rpc.response.status_code"];
        span.errorType = typeof code === "string" ? code : (options?.type ?? "_OTHER");
      },
      keepOpen: () => undefined,
      end() {
        span.ended = true;
      }
    };
    this.spans.push(span);
    try {
      return await this.active.run(span, () => fn(span));
    } finally {
      span.end();
    }
  }

  annotate(attributes: InstrumentationAttributes): void {
    this.active.getStore()?.setAttributes(attributes);
  }

  inject(carrier: TraceCarrier, target: TraceInjectTarget): boolean {
    const span = this.active.getStore();
    if (target !== "mcp" || !this.propagate || !span) return false;
    carrier.traceparent = traceparentOf(span);
    Object.assign(carrier, this.extra);
    return true;
  }

  named(name: string): RecordedSpan[] {
    return this.spans.filter((span) => (span.info.target ? `${span.info.method} ${span.info.target}` : span.info.method) === name);
  }
}

export function traceparentOf(span: Pick<RecordedSpan, "spanId">): string {
  return `00-${TEST_TRACE_ID}-${span.spanId}-01`;
}
