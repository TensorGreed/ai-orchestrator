/**
 * Takes a signed Slack event for a run and decides Slack's answer.
 *
 * Slack retries an event it got no 2xx for within 3 seconds, so the answer may only say "taken" once the run is safe:
 * - queue dispatch: after the queue took the job (enqueuing is quick). A full pool or a failed enqueue answers 503 or
 *   500, so Slack sends the event again later. An event the queue already holds (the same event id, from another
 *   instance) answers `duplicate` with no execution id, since no run starts under a new one;
 * - inline: at once, with the run going on in this process (`track`), as a run can take longer than Slack waits.
 */
import { QueueFullError } from "./queue-service.js";
import type { DispatchedRunSpec, RunDispatcher } from "./run-dispatch.js";

export type SlackIntakeAnswer =
  | { status: 200; body: { ok: true; accepted: true; executionId: string } }
  | { status: 200; body: { ok: true; duplicate: true } }
  | { status: 200; body: { ok: true; refused: "budget" } }
  | { status: 500 | 503; body: { error: string } };

export interface SlackIntakeDeps {
  dispatcher: Pick<RunDispatcher, "start">;
  /** Keeps an inline run this process goes on with after the answer (bounded and awaited on close by the caller). */
  track: (run: Promise<void>) => void;
  /** The event was not taken, or its inline run failed: a redelivery may try again (the caller forgets the event id). */
  onNotTaken: (error: unknown) => void;
}

export async function acceptSlackEvent(
  spec: DispatchedRunSpec,
  options: { pool: string; queueItemId?: string },
  deps: SlackIntakeDeps
): Promise<SlackIntakeAnswer> {
  let started: Awaited<ReturnType<RunDispatcher["start"]>>;
  try {
    started = await deps.dispatcher.start(spec, { pool: options.pool, enforceBackpressure: true, ...(options.queueItemId ? { queueItemId: options.queueItemId } : {}) });
  } catch (error) {
    deps.onNotTaken(error);
    if (error instanceof QueueFullError) return { status: 503, body: { error: "The run queue is full; Slack will retry this event." } };
    return { status: 500, body: { error: "The event's run could not be started; Slack will retry this event." } };
  }
  if (started.queued) {
    if (started.deduplicated) return { status: 200, body: { ok: true, duplicate: true } };
    return { status: 200, body: { ok: true, accepted: true, executionId: spec.run.executionId } };
  }
  // A used-up budget refuses the run (recorded as a failed run; amounts stay admin-only): a retry would be refused too.
  const refused = started.refused;
  deps.track(started.done.then(() => undefined, (error: unknown) => deps.onNotTaken(error)));
  if (refused) return { status: 200, body: { ok: true, refused: "budget" } };
  return { status: 200, body: { ok: true, accepted: true, executionId: spec.run.executionId } };
}
