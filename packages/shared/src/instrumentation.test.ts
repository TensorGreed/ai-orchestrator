import { describe, expect, it } from "vitest";
import {
  NOOP_RUN_INSTRUMENTATION,
  NOOP_SCOPED_INSTRUMENTATION_SPAN,
  SPAN_OUTCOME_ATTRIBUTES,
  parseTraceparentHeader,
  readTraceCarrier,
  type InstrumentationSpan
} from "./instrumentation";

describe("NOOP_RUN_INSTRUMENTATION", () => {
  it("opens one frozen no-op scoped span whose enter only calls fn", async () => {
    const noop = NOOP_RUN_INSTRUMENTATION;
    const spans = [
      noop.startNode({ nodeId: "n", nodeType: "t" }),
      noop.startIteration({ iteration: 1 }),
      noop.startToolCall({ toolName: "t" }, NOOP_SCOPED_INSTRUMENTATION_SPAN)
    ];
    expect(new Set(spans).size).toBe(1);
    expect(spans[0]).toBe(NOOP_SCOPED_INSTRUMENTATION_SPAN);
    expect(Object.isFrozen(spans[0])).toBe(true);
    expect(spans[0]).toMatchObject({ recording: false, traceId: "", spanId: "" });
    expect(await spans[0]!.enter(async () => 42)).toBe(42);
    const failure = new Error("boom");
    await expect(spans[0]!.enter(async () => { throw failure; })).rejects.toBe(failure);
    spans[0]!.end();
    expect(Object.isFrozen(SPAN_OUTCOME_ATTRIBUTES)).toBe(true);
  });


  it("runs every wrapped function with one frozen no-op span and returns its result", async () => {
    const seen: InstrumentationSpan[] = [];
    const record = async (span: InstrumentationSpan) => {
      seen.push(span);
      span.setAttributes({ a: 1 });
      span.recordError(new Error("x"));
      span.keepOpen();
      span.end();
      return seen.length;
    };
    const noop = NOOP_RUN_INSTRUMENTATION;
    expect(await noop.run({ executionId: "e", workflowId: "w" }, record)).toBe(1);
    await noop.node({ nodeId: "n", nodeType: "t" }, record);
    await noop.agent({ agentId: "a" }, record);
    await noop.iteration({ iteration: 1 }, record);
    await noop.modelCall({ providerId: "openai", model: "m" }, record);
    await noop.toolCall({ toolName: "t" }, record);
    await noop.mcpRequest({ method: "tools/call" }, record);
    await noop.span({ name: "x" }, record);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatchObject({ recording: false, traceId: "", spanId: "" });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(noop)).toBe(true);
    expect(noop.enabled).toBe(false);
  });

  it("propagates errors untouched and injects nothing", async () => {
    const failure = new Error("boom");
    await expect(NOOP_RUN_INSTRUMENTATION.run({ executionId: "e", workflowId: "w" }, async () => { throw failure; })).rejects.toBe(failure);
    const carrier: Record<string, string> = {};
    expect(NOOP_RUN_INSTRUMENTATION.inject(carrier, "mcp")).toBe(false);
    expect(carrier).toEqual({});
    expect(NOOP_RUN_INSTRUMENTATION.withParent({ traceparent: "x" }, () => 7)).toBe(7);
    expect(NOOP_RUN_INSTRUMENTATION.activeTraceIds()).toBeNull();
    NOOP_RUN_INSTRUMENTATION.annotate({ a: 1 });
  });
});

describe("parseTraceparentHeader", () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  const span = "00f067aa0ba902b7";

  it("reads version 00 values", () => {
    expect(parseTraceparentHeader(`00-${id}-${span}-01`)).toEqual({ traceId: id, spanId: span, sampled: true, traceFlags: "01" });
    expect(parseTraceparentHeader(` 00-${id}-${span}-00 `)?.sampled).toBe(false);
  });

  it("reads the first four fields of a future version", () => {
    expect(parseTraceparentHeader(`cc-${id}-${span}-01-extra`)?.traceId).toBe(id);
  });

  it("rejects malformed, upper-case, all-zero, version ff and over-long version 00 values", () => {
    for (const value of [
      undefined,
      null,
      "",
      "garbage",
      `00-${id.toUpperCase()}-${span}-01`,
      `00-${"0".repeat(32)}-${span}-01`,
      `00-${id}-${"0".repeat(16)}-01`,
      `ff-${id}-${span}-01`,
      `00-${id}-${span}-01-extra`,
      `00-${id.slice(1)}-${span}-01`
    ]) {
      expect(parseTraceparentHeader(value)).toBeNull();
    }
  });
});

describe("readTraceCarrier", () => {
  const id = "4bf92f3577b34da6a3ce929d0e0e4736";
  const span = "00f067aa0ba902b7";

  it("keeps a valid traceparent and a bounded tracestate, and nothing else", () => {
    expect(readTraceCarrier({ traceparent: `00-${id}-${span}-01`, tracestate: "a=1", extra: "x" })).toEqual({ traceparent: `00-${id}-${span}-01`, tracestate: "a=1" });
    expect(readTraceCarrier({ traceparent: `00-${id}-${span}-01` })).toEqual({ traceparent: `00-${id}-${span}-01` });
    expect(readTraceCarrier({ traceparent: `00-${id}-${span}-01`, tracestate: "x".repeat(513) })).toEqual({ traceparent: `00-${id}-${span}-01` });
    expect(readTraceCarrier({ traceparent: `00-${id}-${span}-01`, tracestate: 5 })).toEqual({ traceparent: `00-${id}-${span}-01` });
  });

  it("returns undefined for anything that is not a carrier with a valid traceparent", () => {
    for (const value of [undefined, null, "x", 5, [], {}, { traceparent: 5 }, { traceparent: "garbage" }, { tracestate: "a=1" }]) {
      expect(readTraceCarrier(value)).toBeUndefined();
    }
  });
});

describe("the no-op trace scope", () => {
  it("withNewTrace and withParent only call fn", () => {
    expect(NOOP_RUN_INSTRUMENTATION.withNewTrace(() => 7)).toBe(7);
    expect(NOOP_RUN_INSTRUMENTATION.withParent({ traceparent: "x" }, () => 8)).toBe(8);
  });
});
