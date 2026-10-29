/**
 * Phase 13.1 — a run's events between the worker that executes it and the API instance that streams it.
 *
 * Worker side (RunEventPublisher): every event the run reports goes on the cluster bus's run channel, in the order the
 * run reported it (one publish at a time):
 *   - node_start, node_progress, node_activity and mcp_elicitation as they are while the JSON fits the bus
 *     (RUN_EVENT_INLINE_BYTES); a larger one goes as a reference (`ref: true`) the receiver fills from the run's
 *     persisted progress;
 *   - node_complete always by reference (its input and output are in the progress record, written before the event);
 *   - llm_delta coalesced per node every RUN_EVENT_COALESCE_MS (about 20 messages a second per streaming node), and
 *     flushed before any other event so the order holds;
 *   - a final `done` after the run's history (and its result on the queue row) is stored.
 *
 * API side (openRunRelay): subscribes to the run's channel before the job is enqueued, turns events back into what an
 * inline run reports, and ends with the run's result read from the database: on `done`, on a reconnect of the bus
 * (`resync`), and on a poll of the database every RUN_RELAY_POLL_MS as the backstop for a lost message. The result never
 * comes from the bus.
 */
import { CLUSTER_BUS_MAX_PAYLOAD_BYTES, type ClusterBus, type RunBusEvent } from "./cluster-bus.js";
import type { QueueItemOutcome } from "../db/store.js";

/** Coalescing window for llm_delta events, per node. */
export const RUN_EVENT_COALESCE_MS = 50;
/** Largest event JSON sent as it is; room is kept for the bus's own fields (`v`, `from`). */
export const RUN_EVENT_INLINE_BYTES = CLUSTER_BUS_MAX_PAYLOAD_BYTES - 500;
/** How often a relay reads the run's state from the database while it waits (the backstop for a lost `done`). */
export const RUN_RELAY_POLL_MS = 2_000;

/** The run events an SSE stream carries (named as the SSE events are). */
export type RunEventName = "node_start" | "node_complete" | "llm_delta" | "node_progress" | "node_activity" | "mcp_elicitation";
const RUN_EVENT_NAMES = new Set<string>(["node_start", "node_complete", "llm_delta", "node_progress", "node_activity", "mcp_elicitation"]);

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The bus form of one event (§ encoding above). */
export function encodeRunEvent(name: RunEventName, payload: Record<string, unknown>, maxBytes = RUN_EVENT_INLINE_BYTES): RunBusEvent {
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
  if (name === "node_complete") {
    return {
      t: name,
      ref: true,
      nodeId,
      nodeType: payload.nodeType,
      status: payload.status,
      completedAt: payload.completedAt,
      durationMs: payload.durationMs,
      hasError: payload.error !== undefined
    };
  }
  const event: RunBusEvent = { ...payload, t: name };
  if (byteLength(event) <= maxBytes) return event;
  if (name === "node_start") return { t: name, ref: true, nodeId, nodeType: payload.nodeType, startedAt: payload.startedAt };
  if (name === "node_activity") return { t: name, ref: true, nodeId, seq: payload.seq };
  if (name === "mcp_elicitation") {
    const elicitation = asRecord(payload.elicitation);
    return { t: name, ref: true, phase: payload.phase, elicitationId: typeof elicitation.id === "string" ? elicitation.id : undefined };
  }
  return { t: name, ref: true, nodeId };
}

/** Splits one coalesced delta so each part fits the bus (a long burst of text). */
function deltaParts(nodeId: string, delta: string, index: number, maxBytes: number): RunBusEvent[] {
  const whole: RunBusEvent = { t: "llm_delta", nodeId, delta, index };
  if (byteLength(whole) <= maxBytes) return [whole];
  const parts: RunBusEvent[] = [];
  // JSON can triple a character's size (escapes); a conservative slice keeps every part under the limit.
  const chunk = Math.max(256, Math.floor((maxBytes - 200) / 6));
  for (let offset = 0; offset < delta.length; offset += chunk) {
    parts.push({ t: "llm_delta", nodeId, delta: delta.slice(offset, offset + chunk), index });
  }
  return parts;
}

export interface RunEventPublisherOptions {
  publish: (event: RunBusEvent) => Promise<void>;
  coalesceMs?: number;
  maxBytes?: number;
  onError?: (error: unknown) => void;
}

/**
 * Worker side: publishes one run's events in order. `emit` never throws and never waits on the database: events are
 * chained, one publish at a time (NOTIFYs are delivered in commit order, so the chain keeps the run's order). A failed
 * publish is reported and skipped; the relay's database reads cover what it carried.
 */
export class RunEventPublisher {
  private chain: Promise<void> = Promise.resolve();
  private readonly deltas = new Map<string, { delta: string; index: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: RunEventPublisherOptions) {}

  emit(name: RunEventName, payload: Record<string, unknown>): void {
    if (this.closed) return;
    if (name === "llm_delta") {
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      const index = typeof payload.index === "number" ? payload.index : 0;
      const pending = this.deltas.get(nodeId);
      if (pending) pending.delta += delta;
      else this.deltas.set(nodeId, { delta, index });
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flushDeltas();
        }, this.options.coalesceMs ?? RUN_EVENT_COALESCE_MS);
      }
      return;
    }
    this.flushDeltas();
    this.send(encodeRunEvent(name, payload, this.options.maxBytes ?? RUN_EVENT_INLINE_BYTES));
  }

  /** Resolves once every event emitted so far was published (or failed). */
  async flush(): Promise<void> {
    this.flushDeltas();
    await this.chain;
  }

  /** Publishes the terminal `done` after everything before it, then stops taking events. */
  async done(status: string): Promise<void> {
    if (this.closed) return;
    this.flushDeltas();
    this.send({ t: "done", status });
    this.closed = true;
    await this.chain;
  }

  /** Stops taking events without a `done` (the run was stopped here; another worker or the reaper owns it now). */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deltas.clear();
  }

  private flushDeltas(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.deltas.size === 0) return;
    const maxBytes = this.options.maxBytes ?? RUN_EVENT_INLINE_BYTES;
    for (const [nodeId, pending] of this.deltas) {
      for (const part of deltaParts(nodeId, pending.delta, pending.index, maxBytes)) this.send(part);
    }
    this.deltas.clear();
  }

  private send(event: RunBusEvent): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.options.publish(event);
      } catch (error) {
        this.options.onError?.(error);
      }
    });
  }
}

/** One node's entry in a run's persisted progress (execution_history.node_results_json). */
export interface PersistedNodeEntry {
  nodeId: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  progress?: Record<string, unknown>;
  activity?: Array<Record<string, unknown>>;
}

/** A run as its history row stores it (the parts a relay reads). */
export interface PersistedRun {
  id: string;
  workflowId: string;
  status: string;
  startedAt: string;
  completedAt?: string | null;
  output?: unknown;
  nodeResults?: unknown;
  customData?: Record<string, unknown> | null;
  error?: string | null;
}

export interface RunRelaySource {
  bus: Pick<ClusterBus, "subscribeRun" | "onResync">;
  /** The run's history row (null while it has none). */
  readRun: (executionId: string) => Promise<PersistedRun | null>;
  /** The run's queue item, for a dispatched run (null: none, or not a dispatched run). */
  readOutcome?: (queueItemId: string) => Promise<QueueItemOutcome | null>;
  /** An elicitation's current view, for an `mcp_elicitation` event that came by reference. */
  readElicitation?: (id: string) => Promise<unknown | null>;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

export type RunRelayEnd =
  | { kind: "result"; result: unknown }
  | { kind: "failed"; error: string | null }
  | { kind: "timeout" }
  | { kind: "closed" };

export interface RunRelay {
  /** Resolves when the run ended (its result), its job died, `timeoutMs` passed, or the relay was closed. */
  ended(timeoutMs?: number): Promise<RunRelayEnd>;
  /** Checks the database now (a reattach checks once before it waits). */
  check(): void;
  close(): void;
}

/** A run's state that ends a stream: anything but running (a partial run with no completion time is still running). */
export function isRunSettled(run: Pick<PersistedRun, "status" | "completedAt">): boolean {
  if (run.status === "running") return false;
  if (run.status === "partial" && !run.completedAt) return false;
  return true;
}

/** The result an inline run would have answered with, rebuilt from its history row (when no stored result exists). */
export function resultFromPersistedRun(run: PersistedRun): Record<string, unknown> {
  return {
    workflowId: run.workflowId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt ?? run.startedAt,
    executionId: run.id,
    ...(run.customData ? { customData: run.customData } : {}),
    nodeResults: Array.isArray(run.nodeResults) ? run.nodeResults : [],
    ...(run.output !== undefined && run.output !== null ? { output: run.output } : {}),
    ...(run.error ? { error: run.error } : {})
  };
}

function nodeEntry(run: PersistedRun | null, nodeId: unknown): PersistedNodeEntry | null {
  if (!run || typeof nodeId !== "string" || !Array.isArray(run.nodeResults)) return null;
  const entries = run.nodeResults as PersistedNodeEntry[];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.nodeId === nodeId) return entries[index]!;
  }
  return null;
}

/**
 * API side: the inline form of one bus event, reading a referenced value from the run's progress. Null for an event
 * that is not a run event, or a reference that can no longer be filled (a progress or activity entry already gone).
 */
export async function decodeRunEvent(
  event: RunBusEvent,
  readers: { readRun: () => Promise<PersistedRun | null>; readElicitation?: (id: string) => Promise<unknown | null> }
): Promise<{ name: RunEventName; payload: Record<string, unknown> } | null> {
  const name = event.t;
  if (!RUN_EVENT_NAMES.has(name)) return null;
  const { t: _t, v: _v, from: _from, ref, ...rest } = event as RunBusEvent & { from?: unknown };
  if (!ref) return { name: name as RunEventName, payload: rest };
  if (name === "mcp_elicitation") {
    const id = typeof rest.elicitationId === "string" ? rest.elicitationId : null;
    const elicitation = id && readers.readElicitation ? await readers.readElicitation(id) : null;
    return elicitation ? { name, payload: { phase: rest.phase, elicitation } } : null;
  }
  const entry = nodeEntry(await readers.readRun(), rest.nodeId);
  if (name === "node_complete") {
    return {
      name,
      payload: {
        nodeId: rest.nodeId,
        nodeType: rest.nodeType,
        status: rest.status,
        completedAt: rest.completedAt,
        durationMs: rest.durationMs,
        input: entry?.input,
        output: entry?.output,
        ...(rest.hasError && entry?.error !== undefined ? { error: entry.error } : {})
      }
    };
  }
  if (name === "node_start") {
    return { name, payload: { nodeId: rest.nodeId, nodeType: rest.nodeType, startedAt: rest.startedAt, input: entry?.input } };
  }
  if (name === "node_progress") {
    return entry?.progress ? { name, payload: { nodeId: rest.nodeId, ...entry.progress } } : null;
  }
  if (name === "node_activity") {
    const found = entry?.activity?.find((item) => item.seq === rest.seq);
    return found ? { name, payload: found } : null;
  }
  return null;
}

/**
 * Subscribes to a run's events (resolves once subscribed, so the caller may start or enqueue the run) and relays them
 * to `onEvent` in order. The relay ends with the run's result:
 *   - the result the worker stored on the queue item (`queueItemId`), which is exactly what the run returned;
 *   - else, once the run's history row is settled and no queue item is pending or running, a result rebuilt from it;
 *   - `failed` when the queue item is dead (in the dead-letter queue) without a result.
 * The database is read on `done`, on the bus's `resync`, and every `pollMs`.
 */
export async function openRunRelay(
  source: RunRelaySource,
  options: {
    executionId: string;
    /** The dispatched run's queue item (its execution id); absent when the run is not a dispatched one. */
    queueItemId?: string;
    onEvent: (name: RunEventName, payload: Record<string, unknown>) => void | Promise<void>;
  }
): Promise<RunRelay> {
  const { executionId } = options;
  let finished: RunRelayEnd | null = null;
  let resolveEnd: (end: RunRelayEnd) => void = () => undefined;
  const endPromise = new Promise<RunRelayEnd>((resolve) => {
    resolveEnd = resolve;
  });
  let events: Promise<void> = Promise.resolve();
  let checking = false;
  let checkAgain = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopResync: (() => void) | null = null;

  const finish = (end: RunRelayEnd) => {
    if (finished) return;
    finished = end;
    if (pollTimer) clearInterval(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    pollTimer = null;
    timeoutTimer = null;
    unsubscribe?.();
    stopResync?.();
    resolveEnd(end);
  };
  const report = (error: unknown) => source.onError?.(error);

  const readEnd = async (): Promise<RunRelayEnd | null> => {
    const outcome = options.queueItemId && source.readOutcome ? await source.readOutcome(options.queueItemId) : null;
    if (outcome && outcome.result !== null && outcome.result !== undefined) return { kind: "result", result: outcome.result };
    if (outcome?.status === "dead") return { kind: "failed", error: outcome.lastError };
    if (outcome?.status === "running") return null;
    const run = await source.readRun(executionId);
    // Canceled while it waited for a worker: the cancel is the run's end (the worker that claims it later skips it).
    if (outcome?.status === "pending") return run?.status === "canceled" ? { kind: "result", result: resultFromPersistedRun(run) } : null;
    if (run && isRunSettled(run)) return { kind: "result", result: resultFromPersistedRun(run) };
    return null;
  };

  const check = (): void => {
    if (finished) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    void (async () => {
      try {
        do {
          checkAgain = false;
          const end = await readEnd();
          if (end) {
            // Events already received go out before the result.
            await events;
            finish(end);
          }
        } while (checkAgain && !finished);
      } catch (error) {
        report(error);
      } finally {
        checking = false;
      }
    })();
  };

  const onBusEvent = (event: RunBusEvent): void => {
    if (finished) return;
    if (event.t === "done") {
      events = events.then(() => check());
      return;
    }
    events = events.then(async () => {
      if (finished) return;
      try {
        const decoded = await decodeRunEvent(event, {
          readRun: async () => await source.readRun(executionId),
          ...(source.readElicitation ? { readElicitation: source.readElicitation } : {})
        });
        if (decoded && !finished) await options.onEvent(decoded.name, decoded.payload);
      } catch (error) {
        report(error);
      }
    });
  };

  unsubscribe = await source.bus.subscribeRun(executionId, onBusEvent);
  stopResync = source.bus.onResync(() => check());
  pollTimer = setInterval(() => check(), source.pollMs ?? RUN_RELAY_POLL_MS);
  pollTimer.unref?.();

  return {
    ended: (timeoutMs?: number) => {
      if (timeoutMs !== undefined && timeoutMs > 0 && !finished && !timeoutTimer) {
        timeoutTimer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
        timeoutTimer.unref?.();
      }
      return endPromise;
    },
    check,
    close: () => finish({ kind: "closed" })
  };
}

/**
 * In-process run events of runs executing in this process (inline runs), for a reattach on this instance. Emitting
 * costs a map lookup while nobody listens. It has the bus's run-event shape (subscribeRun, onResync), so a relay reads
 * it like the cluster bus; events are never shortened.
 */
export class LocalRunEvents implements Pick<ClusterBus, "subscribeRun" | "onResync"> {
  private readonly handlers = new Map<string, Set<(event: RunBusEvent) => void | Promise<void>>>();

  /** Whether anybody listens to this run (callers skip building events otherwise). */
  has(executionId: string): boolean {
    return this.handlers.has(executionId);
  }

  emit(executionId: string, name: RunEventName, payload: Record<string, unknown>): void {
    const handlers = this.handlers.get(executionId);
    if (!handlers) return;
    const event: RunBusEvent = { ...payload, t: name };
    for (const handler of [...handlers]) {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).then === "function") (result as Promise<void>).catch(() => undefined);
      } catch {
        // A listener's failure never reaches the run.
      }
    }
  }

  async subscribeRun(executionId: string, handler: (event: RunBusEvent) => void | Promise<void>): Promise<() => void> {
    let handlers = this.handlers.get(executionId);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(executionId, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.handlers.get(executionId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(executionId);
    };
  }

  onResync(): () => void {
    return () => undefined;
  }
}
