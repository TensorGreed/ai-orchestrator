/**
 * MCP operation metrics without tracing: what the MCP clients and the MCP gateway are given when only a metrics
 * endpoint is set. Each MCP request is measured as it is while tracing is on (`mcp.client.operation.duration` and
 * `mcp.server.operation.duration`, same attributes and outcome), but no span is started, no trace context is injected
 * into requests and every other wrapper runs its work as the no-op does.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Meter } from "@opentelemetry/api";
import {
  NOOP_INSTRUMENTATION_SPAN,
  NOOP_RUN_INSTRUMENTATION,
  type InstrumentationAttributes,
  type InstrumentationSpan,
  type McpRequestSpanInfo,
  type RunInstrumentation
} from "@ai-orchestrator/shared";
import { McpOperationMeasurement } from "./instrumentation.js";
import { McpMetrics, mcpSpanSpec } from "./mcp.js";

/** Stands in for an MCP span: what the wrappers report on it reaches the measurement only. */
class MeasuredMcpSpan implements InstrumentationSpan {
  readonly recording = false;
  readonly traceId = "";
  readonly spanId = "";
  readonly capturesContent = false;
  private kept = false;

  constructor(readonly measurement: McpOperationMeasurement) {}

  setAttributes(attributes: InstrumentationAttributes): void {
    this.measurement.capture(attributes);
  }

  recordError(error: unknown, options: { type?: string } = {}): void {
    this.measurement.error(error, options.type);
  }

  keepOpen(): void {
    this.kept = true;
  }

  /** Called by the wrapper when its work settles; a span kept open is measured when its owner ends it. */
  settle(): void {
    if (!this.kept) this.measurement.finish();
  }

  end(): void {
    this.measurement.finish();
  }

  addContent(): void {
    // No content is ever recorded without tracing.
  }
}

/** Without a scrubber, tool names reach the metric as they are. */
const keep = (text: string): string => text;

/**
 * A `RunInstrumentation` that measures MCP requests only. `enabled` is true so the MCP registry and the gateway call
 * `mcpRequest`; give it to them only, never to the engine or the agent runtime (their wrappers would do nothing).
 */
export function createMcpMetricsInstrumentation(meter: Meter, scrub: (text: string) => string = keep): RunInstrumentation {
  const metrics = new McpMetrics(meter);
  const current = new AsyncLocalStorage<MeasuredMcpSpan>();
  return Object.freeze({
    ...NOOP_RUN_INSTRUMENTATION,
    enabled: true,
    mcpRequest<T>(info: McpRequestSpanInfo, fn: (span: InstrumentationSpan) => Promise<T>): Promise<T> {
      // A later round of a multi round-trip request is part of the request's own measurement, as it is with spans.
      if (info.round && info.round > 1) return fn(current.getStore() ?? NOOP_INSTRUMENTATION_SPAN);
      const side = info.side === "server" ? "server" : "client";
      const span = new MeasuredMcpSpan(new McpOperationMeasurement(side, metrics, mcpSpanSpec(info, scrub).attributes));
      return current.run(span, async () => {
        try {
          return await fn(span);
        } catch (error) {
          span.recordError(error);
          throw error;
        } finally {
          span.settle();
        }
      });
    },
    /** What an MCP client reports about its request reaches the request's measurement (outside one: nothing). */
    annotate(attributes: InstrumentationAttributes): void {
      current.getStore()?.measurement.capture(attributes);
    },
    // No trace context exists to send.
    inject: () => false
  });
}
