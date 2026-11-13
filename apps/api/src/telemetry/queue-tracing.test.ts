/**
 * The consumer span of a queue job attempt this worker stopped (a drain, or a lost lease): an outcome, not an error.
 * Collected with the real OpenTelemetry SDK in memory.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createOtelRuntime, DEFAULT_BATCH_OPTIONS, InMemorySpanExporter, type OtelRuntime, type ReadableSpan } from "@ai-orchestrator/otel";
import { QueueDrainAbort, QueueLeaseLostAbort } from "../services/queue-service.js";
import { traceQueueJob } from "./queue-tracing.js";

const SPAN_STATUS_UNSET = 0;
const SPAN_STATUS_ERROR = 2;

const runtimes: OtelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

function setup() {
  const exporter = new InMemorySpanExporter();
  const runtime = createOtelRuntime({
    resourceAttributes: { "service.name": "l2m-test" },
    export: null,
    sampler: { name: "parentbased_always_on" },
    propagators: ["tracecontext"],
    batch: DEFAULT_BATCH_OPTIONS,
    attributeValueLengthLimit: 8192,
    spanDetail: "standard",
    naming: "names",
    propagateToProviders: false,
    propagateToMcp: true,
    semconvOptIn: [],
    recentSpanLimit: 100,
    spanProcessors: [
      { onStart: () => undefined, onEnd: (span) => exporter.export([span], () => undefined), forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve() }
    ],
    registerGlobals: false
  });
  runtimes.push(runtime);
  const consumer = (): ReadableSpan => {
    const spans = exporter.getFinishedSpans().filter((span) => span.name === "process l2m.queue");
    expect(spans).toHaveLength(1);
    return spans[0]!;
  };
  return { instrumentation: runtime.instrumentation, consumer };
}

const job = (signal: AbortSignal) => ({ queueItemId: "q-1", pool: "default", attempts: 0, waitMs: 5, signal });
const payload = { executionId: "exec-1" };

describe("consumer spans of stopped queue jobs", () => {
  it.each([
    ["a drain", () => new QueueDrainAbort()],
    ["a lost lease", () => new QueueLeaseLostAbort("not renewed in time")]
  ])("records %s as requeued with no error status when the stopped run throws, and rethrows it", async (_label, reason) => {
    const { instrumentation, consumer } = setup();
    const controller = new AbortController();
    const thrown = new Error("The run was stopped");
    await expect(
      traceQueueJob(instrumentation, payload, job(controller.signal), async () => {
        controller.abort(reason());
        throw thrown;
      })
    ).rejects.toBe(thrown);
    const span = consumer();
    expect(span.attributes["l2m.queue.outcome"]).toBe("requeued");
    expect(span.status.code).toBe(SPAN_STATUS_UNSET);
    expect(span.attributes["error.type"]).toBeUndefined();
    expect(span.events.filter((event) => event.name === "exception")).toEqual([]);
  });

  it("records a stopped run that returned as requeued too", async () => {
    const { instrumentation, consumer } = setup();
    const controller = new AbortController();
    const value = await traceQueueJob(instrumentation, payload, job(controller.signal), async () => {
      controller.abort(new QueueDrainAbort());
      return "given back";
    });
    expect(value).toBe("given back");
    expect(consumer().attributes["l2m.queue.outcome"]).toBe("requeued");
    expect(consumer().status.code).toBe(SPAN_STATUS_UNSET);
  });

  it("still records a job that failed on its own as an error, with no outcome", async () => {
    const { instrumentation, consumer } = setup();
    const controller = new AbortController();
    await expect(
      traceQueueJob(instrumentation, payload, job(controller.signal), async () => {
        throw new Error("the workflow does not exist");
      })
    ).rejects.toThrow("does not exist");
    expect(consumer().status.code).toBe(SPAN_STATUS_ERROR);
    expect(consumer().attributes["l2m.queue.outcome"]).toBeUndefined();
  });

  it("treats a signal aborted for another reason as an ordinary failure", async () => {
    const { instrumentation, consumer } = setup();
    const controller = new AbortController();
    await expect(
      traceQueueJob(instrumentation, payload, job(controller.signal), async () => {
        controller.abort(new Error("something else"));
        throw new Error("stopped");
      })
    ).rejects.toThrow("stopped");
    expect(consumer().status.code).toBe(SPAN_STATUS_ERROR);
    expect(consumer().attributes["l2m.queue.outcome"]).toBeUndefined();
  });

  it("leaves a successful attempt without an outcome", async () => {
    const { instrumentation, consumer } = setup();
    expect(await traceQueueJob(instrumentation, payload, job(new AbortController().signal), async () => 1)).toBe(1);
    expect(consumer().attributes["l2m.queue.outcome"]).toBeUndefined();
    expect(consumer().status.code).toBe(SPAN_STATUS_UNSET);
  });
});
