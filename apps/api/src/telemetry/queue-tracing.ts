/**
 * Trace propagation for queue jobs. The producer writes the enqueuer's trace context into the payload JSON
 * (`QueueProducer.setTracing`); the worker, on this instance or any other that shares the queue table, opens a
 * consumer span under it here. A job without a context (tracing was off where it was enqueued, or a schedule or
 * trigger enqueued it outside any span) starts a new trace.
 */
import { SPAN_OUTCOME_ATTRIBUTES, readTraceCarrier, type RunInstrumentation, type TraceCarrier } from "@ai-orchestrator/shared";
import { QueueDrainAbort, QueueLeaseLostAbort, type QueueJobContext, type QueuedExecutionPayload } from "../services/queue-service.js";

/** True when this worker stopped the attempt itself: it is draining, or the job's lease was lost. */
function stoppedByQueue(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) && (signal!.reason instanceof QueueDrainAbort || signal!.reason instanceof QueueLeaseLostAbort);
}

/**
 * Runs one attempt of a queued job under a `process l2m.queue` consumer span. A retried or reaped job gets one such
 * span per attempt, all under the same parent. An attempt this worker stopped (a drain gives the job back, a lost
 * lease leaves it to another worker) is not a failure of the job: its span gets `l2m.queue.outcome=requeued` and no
 * error status, whether the stopped run threw or returned. Without tracing it only calls `fn`.
 */
export async function traceQueueJob<T>(
  instrumentation: RunInstrumentation,
  payload: Pick<QueuedExecutionPayload, "executionId" | "traceContext">,
  context: Pick<QueueJobContext, "queueItemId" | "pool" | "attempts" | "waitMs"> & { signal?: AbortSignal },
  fn: () => Promise<T>
): Promise<T> {
  if (!instrumentation.enabled) return await fn();
  // What a stopped attempt threw: rethrown once its span has ended, so the span does not record it as an error.
  let stopped: { error: unknown } | undefined;
  // A queue poll woken from a request would otherwise run the job inside that request's trace.
  const result = await instrumentation.withNewTrace(() =>
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
        async (span) => {
          try {
            const value = await fn();
            if (stoppedByQueue(context.signal)) span.setAttributes({ [SPAN_OUTCOME_ATTRIBUTES.QUEUE_OUTCOME]: "requeued" });
            return value;
          } catch (error) {
            if (!stoppedByQueue(context.signal)) throw error;
            span.setAttributes({ [SPAN_OUTCOME_ATTRIBUTES.QUEUE_OUTCOME]: "requeued" });
            stopped = { error };
            return undefined as T;
          }
        }
      )
    )
  );
  if (stopped) throw stopped.error;
  return result;
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
