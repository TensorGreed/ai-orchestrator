/**
 * Trace propagation for queue jobs. The producer writes the enqueuer's trace context into the payload JSON
 * (`QueueProducer.setTracing`); the worker, on this instance or any other that shares the queue table, opens a
 * consumer span under it here. A job without a context (tracing was off where it was enqueued, or a schedule or
 * trigger enqueued it outside any span) starts a new trace.
 */
import { readTraceCarrier, type RunInstrumentation, type TraceCarrier } from "@ai-orchestrator/shared";
import type { QueueJobContext, QueuedExecutionPayload } from "../services/queue-service.js";

/**
 * Runs one attempt of a queued job under a `process l2m.queue` consumer span. A retried or reaped job gets one such
 * span per attempt, all under the same parent. Without tracing it only calls `fn`.
 */
export async function traceQueueJob<T>(
  instrumentation: RunInstrumentation,
  payload: Pick<QueuedExecutionPayload, "executionId" | "traceContext">,
  context: Pick<QueueJobContext, "queueItemId" | "pool" | "attempts" | "waitMs">,
  fn: () => Promise<T>
): Promise<T> {
  if (!instrumentation.enabled) return await fn();
  // A queue poll woken from a request would otherwise run the job inside that request's trace.
  return await instrumentation.withNewTrace(() =>
    instrumentation.withParent(readTraceCarrier(payload.traceContext), () =>
      instrumentation.span(
        {
          name: "process l2m.queue",
          kind: "consumer",
          attributes: {
            "messaging.system": "l2m",
            "messaging.destination.name": context.pool,
            "messaging.operation.type": "process",
            "messaging.message.id": context.queueItemId,
            "l2m.execution.id": payload.executionId,
            "l2m.queue.attempt": context.attempts + 1,
            "l2m.queue.wait_ms": context.waitMs ?? undefined
          }
        },
        async () => await fn()
      )
    )
  );
}

/**
 * The active span's trace context for a paused run's stored state (the node that is waiting), or undefined while
 * tracing is off or no span is active. The resumed run links to it.
 */
export function pausedTraceContext(instrumentation: RunInstrumentation): TraceCarrier | undefined {
  if (!instrumentation.enabled) return undefined;
  const carrier: TraceCarrier = {};
  return instrumentation.inject(carrier, "state") ? carrier : undefined;
}
