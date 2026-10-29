/**
 * Phase 13.1 — queue dispatch (`EXECUTION_DISPATCH=queue`): one seam every run-starting path goes through.
 *
 * `inline` (the default, every store): the run executes in the process that received the request, exactly as before.
 * `queue` (cluster mode only: Postgres with HA_ENABLED=true): the run is put on the execution queue as a job that carries
 * everything the run is started with (a DispatchedRunSpec), a worker claims and executes it, and the instance that
 * received the request relays the run's events and answers with its result (run-event-relay.ts). The answer is the one
 * an inline run gives: the same result object, status codes and SSE events.
 *
 * Mixed versions: a job is only dispatched while every live queue consumer of its pool advertises
 * QUEUE_DISPATCH_CAPABILITY in the instance registry (an older worker would run the job as a plain queued run). While
 * that does not hold, or no consumer serves the pool, runs go inline and the gate reports why (DispatchGate.status).
 */
import { createHash } from "node:crypto";
import type { McpCassetteSource, McpReplayMode, Workflow, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import type { ClusterInstanceRecord } from "../db/store.js";
import type { RunWorkflowExecutionInput, WorkflowExecutionEventHooks } from "../run-types.js";
import type { SafeUser } from "./auth-service.js";
import { QueueFullError } from "./queue-service.js";
import type { RunRelay, RunRelayEnd } from "./run-event-relay.js";
import type { McpCassetteRunPlan } from "./mcp-cassette-service.js";

export type ExecutionDispatchMode = "inline" | "queue";

/** What a queue consumer advertises when it runs dispatched jobs (the instance registry's capabilities). */
export const QUEUE_DISPATCH_CAPABILITY = "queue-dispatch-v1";
/** The DispatchedRunSpec format this build writes and reads. */
export const DISPATCH_SPEC_VERSION = 1;

/** How long a gate decision is reused before the instance registry is read again. */
export const DISPATCH_GATE_CACHE_MS = 5_000;

/**
 * The parts of the run function's input that cross the queue. In-process objects (event hooks, an MCP plan, replay
 * hooks, model tapes, guard simulations, a paused state) never do: hooks are rebuilt by the worker, an MCP plan from
 * `cassette`, and the paths that need the rest (golden-run replays, evals, simulations, approval resumes) do not
 * dispatch runs this way.
 */
export type DispatchedRunInput = Omit<
  RunWorkflowExecutionInput,
  | "hooks"
  | "mcpPlan"
  | "replay"
  | "providerRegistry"
  | "guardProfileOverride"
  | "guardSimulation"
  | "resumeState"
  | "approvalDecision"
  | "policyActor"
  | "executionId"
  | "triggerType"
  | "triggeredBy"
  | "workflow"
> & {
  /** The workflow as the route resolved it (the draft, or the published version), so the worker runs exactly that. */
  workflow: Workflow;
  executionId: string;
  triggerType: string;
  triggeredBy?: string;
  /** The signed-in user who started the run (id, email, role), when a route authenticated one. */
  policyActor?: SafeUser | null;
};

/** A run, as a queue job carries it: what the route would have passed to the run function and to the history write. */
export interface DispatchedRunSpec {
  v: number;
  run: DispatchedRunInput;
  /**
   * The progress record's input and custom data (app.ts createProgressTrackingHooks), when the route tracks progress;
   * null when it does not (a schedule). A dispatched run always records progress on its worker.
   */
  progress: { requestInput?: unknown; customData?: Record<string, unknown> } | null;
  /** The final history record's input and custom data (app.ts persistExecutionHistory). */
  history: { requestInput?: unknown; customData?: Record<string, unknown> };
  /** "Record MCP calls" (a recording), or a replay of a cassette's calls; absent for an ordinary run. */
  cassette?:
    | { kind: "record"; source: McpCassetteSource; createdBy: string | null }
    | { kind: "replay"; cassetteId: string; mode: McpReplayMode; source: McpCassetteSource; createdBy: string | null };
}

/** Reads a spec from a queue payload; null when it is missing or of a format this build does not know. */
export function readDispatchedRunSpec(value: unknown): DispatchedRunSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const spec = value as Partial<DispatchedRunSpec>;
  if (spec.v !== DISPATCH_SPEC_VERSION) return null;
  const run = spec.run as Partial<DispatchedRunInput> | undefined;
  if (!run || typeof run !== "object" || typeof run.executionId !== "string" || typeof run.triggerType !== "string") return null;
  if (!run.workflow || typeof run.workflow !== "object" || typeof (run.workflow as Workflow).id !== "string") return null;
  if (!spec.history || typeof spec.history !== "object") return null;
  return spec as DispatchedRunSpec;
}

/** Only what identifies the user crosses the queue (the session, a token or a password never does). */
export function dispatchedPolicyActor(user: SafeUser | null | undefined): SafeUser | null | undefined {
  if (!user) return user;
  return { id: user.id, email: user.email, role: user.role };
}

/** The idempotent queue item of a schedule's fire: two leaders (or a retried tick) firing one second enqueue once. */
export function cronQueueItemId(workflowId: string, scheduleNodeId: string, scheduledFor: string | undefined, firedAt: string): string {
  const at = Date.parse(scheduledFor ?? "");
  const second = Number.isFinite(at) ? Math.floor(at / 1000) : Math.floor(Date.parse(firedAt) / 1000);
  return `cron:${workflowId}:${scheduleNodeId}:${second}`;
}

/**
 * The idempotent queue item of an app trigger's fire, when the fire names what it reports: the RSS items' ids, an
 * SSE event's id, or the file events seen (each includes the file's mtime). Two leaders that both saw it enqueue it
 * once. Null when the fire has no such key (an SSE event without an id): the caller uses a fresh id.
 */
export function triggerQueueItemId(workflowId: string, nodeId: string, triggerType: string, input: Record<string, unknown>): string | null {
  let key: unknown = null;
  if (triggerType === "rss" && Array.isArray(input.rss_items)) {
    const ids = (input.rss_items as Array<Record<string, unknown>>).map((item) => (item && typeof item.id === "string" ? item.id : null));
    if (ids.length > 0 && ids.every((id) => id !== null)) key = ids;
  } else if (triggerType === "sse") {
    const event = input.sse_event as Record<string, unknown> | undefined;
    if (event && typeof event.id === "string" && event.id.length > 0) key = [event.event ?? null, event.id];
  } else if (triggerType === "file" && Array.isArray(input.file_events) && input.file_events.length > 0) {
    key = input.file_events;
  }
  if (key === null) return null;
  const hash = createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32);
  return `trig:${workflowId}:${nodeId}:${hash}`;
}

export interface DispatchGateStatus {
  mode: ExecutionDispatchMode;
  /** True while `queue` is set but runs go inline (the reason says why). */
  fallback: boolean;
  reason: string | null;
}

/**
 * The capability gate (mixed versions): dispatch to `pool` only while at least one live queue consumer serves it and
 * every live consumer of it advertises QUEUE_DISPATCH_CAPABILITY. Decisions are cached per pool for
 * DISPATCH_GATE_CACHE_MS; a failed registry read falls back to inline.
 */
export class DispatchGate {
  private readonly cache = new Map<string, { queue: boolean; reason: string | null; atMs: number }>();
  private last: { fallback: boolean; reason: string | null } = { fallback: false, reason: null };

  constructor(
    private readonly options: {
      mode: ExecutionDispatchMode;
      listInstances: () => Promise<ClusterInstanceRecord[]>;
      /** Called when the gate starts or stops falling back to inline (log once, metrics). */
      onChange?: (fallback: boolean, reason: string | null) => void;
      cacheMs?: number;
      now?: () => number;
    }
  ) {}

  get mode(): ExecutionDispatchMode {
    return this.options.mode;
  }

  /** Whether a run for `pool` goes on the queue now. Always false with `inline`. */
  async useQueue(pool: string): Promise<boolean> {
    if (this.options.mode !== "queue") return false;
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(pool);
    if (cached && now - cached.atMs < (this.options.cacheMs ?? DISPATCH_GATE_CACHE_MS)) {
      this.record(!cached.queue, cached.reason);
      return cached.queue;
    }
    let decision: { queue: boolean; reason: string | null };
    try {
      decision = decideDispatch(await this.options.listInstances(), pool);
    } catch (error) {
      decision = { queue: false, reason: `the instance registry could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    this.cache.set(pool, { ...decision, atMs: now });
    this.record(!decision.queue, decision.reason);
    return decision.queue;
  }

  status(): DispatchGateStatus {
    return { mode: this.options.mode, fallback: this.options.mode === "queue" && this.last.fallback, reason: this.last.reason };
  }

  private record(fallback: boolean, reason: string | null): void {
    const changed = fallback !== this.last.fallback || (fallback && reason !== this.last.reason);
    this.last = { fallback, reason: fallback ? reason : null };
    if (changed) this.options.onChange?.(fallback, fallback ? reason : null);
  }
}

/** The gate's rule over the registry's rows (exported for tests). */
export function decideDispatch(instances: ClusterInstanceRecord[], pool: string): { queue: boolean; reason: string | null } {
  const consumers = instances.filter(
    (instance) => instance.live && (instance.workerMode === "all" || instance.workerMode === "worker") && instance.pools.includes(pool)
  );
  if (consumers.length === 0) {
    return { queue: false, reason: `no live queue consumer serves pool "${pool}"` };
  }
  const old = consumers.filter((instance) => !instance.capabilities.includes(QUEUE_DISPATCH_CAPABILITY));
  if (old.length > 0) {
    const names = old.slice(0, 3).map((instance) => `${instance.id}${instance.appVersion ? ` (${instance.appVersion})` : ""}`).join(", ");
    return { queue: false, reason: `queue consumers of pool "${pool}" without ${QUEUE_DISPATCH_CAPABILITY}: ${names}${old.length > 3 ? ", ..." : ""}` };
  }
  return { queue: true, reason: null };
}

/** Too many requests on this instance are already waiting for dispatched runs (DISPATCH_MAX_WAITING): 503. */
export class DispatchBusyError extends Error {
  readonly statusCode = 503;
  constructor(limit: number) {
    super(`This API instance already waits on ${limit} dispatched runs (DISPATCH_MAX_WAITING); try again shortly.`);
    this.name = "DispatchBusyError";
  }
}

/** A dispatched run did not end within the time the instance waits for it: 504; the run may still finish. */
export class DispatchTimeoutError extends Error {
  readonly statusCode = 504;
  readonly executionId: string;
  constructor(executionId: string, waitedMs: number) {
    super(`Execution ${executionId} did not finish on a worker within ${Math.round(waitedMs / 1000)} s; it may still finish (see /api/executions/${executionId}).`);
    this.name = "DispatchTimeoutError";
    this.executionId = executionId;
  }
}

/** A dispatched run's job ended in the dead-letter queue without a result (it could not be run). */
export class DispatchFailedError extends Error {
  readonly executionId: string;
  constructor(executionId: string, reason: string | null) {
    super(`Execution ${executionId} could not be run on a worker: ${reason ?? "the job failed"}`);
    this.name = "DispatchFailedError";
    this.executionId = executionId;
  }
}

/** The client of a streamed run went away (`closed`): the relay stopped; the run goes on on its worker. */
export class DispatchClientGoneError extends Error {
  constructor(executionId: string) {
    super(`The client of execution ${executionId} went away; the run goes on.`);
    this.name = "DispatchClientGoneError";
  }
}

/** In-process parts a route already built for an inline run (never sent: a worker builds its own from the spec). */
export interface LocalRunParts {
  mcpPlan?: McpCassetteRunPlan;
}

export interface RunDispatcherDeps {
  gate: DispatchGate;
  /** Runs the spec in this process: exactly the inline path (app.ts executeRunSpec). */
  executeLocally: (spec: DispatchedRunSpec, passthrough?: WorkflowExecutionEventHooks, local?: LocalRunParts) => Promise<WorkflowExecutionResult>;
  /** Refuses with QueueFullError when the pool is full (QUEUE_MAX_PENDING). */
  checkBackpressure: (pool: string) => Promise<void>;
  /** Writes the run's first `running` record, so it can be read, reattached to and canceled while it waits for a worker. */
  recordQueued: (spec: DispatchedRunSpec) => Promise<void>;
  /** The queued record stays behind when the job could not be queued: it is ended with this error. */
  recordNotQueued: (spec: DispatchedRunSpec, error: string) => Promise<void>;
  enqueue: (spec: DispatchedRunSpec, options: { pool: string; queueItemId?: string; priority?: number }) => Promise<void>;
  /** Subscribes to the run's events (before the enqueue) and resolves with the relay that ends with its result. */
  openRelay: (spec: DispatchedRunSpec, passthrough: WorkflowExecutionEventHooks | undefined) => Promise<RunRelay>;
  /** How long the instance waits for a dispatched run to end: its run time limit plus the queue's margin. */
  waitTimeoutMs: (spec: DispatchedRunSpec) => number;
  /** Requests that may wait on dispatched runs at once on this instance. */
  maxWaiting: number;
  onQueued?: (spec: DispatchedRunSpec, pool: string) => void;
}

/**
 * Starts runs inline or on the queue. `run` answers with the run's result either way; `fire` (schedules and app
 * triggers, which nobody waits on) only starts it.
 */
export class RunDispatcher {
  private waiting = 0;

  constructor(private readonly deps: RunDispatcherDeps) {}

  get mode(): ExecutionDispatchMode {
    return this.deps.gate.mode;
  }

  /** Requests on this instance waiting for a dispatched run now. */
  waitingCount(): number {
    return this.waiting;
  }

  async useQueue(pool: string): Promise<boolean> {
    return await this.deps.gate.useQueue(pool);
  }

  /**
   * Runs the spec and resolves with its result. Inline: in this process (passthrough hooks get the events as they
   * happen). Queue: on a worker; the relayed events reach the passthrough hooks in order, and the result is the one
   * the worker stored. A full pool (QUEUE_MAX_PENDING) is refused with QueueFullError before anything is written, unless
   * `enforceBackpressure` is false.
   * `closed` (streams only: callers that do nothing more once the client is gone) resolves when the client went away:
   * the relay stops and DispatchClientGoneError is thrown; the run goes on (as an inline run does).
   */
  async run(
    spec: DispatchedRunSpec,
    options: { pool: string; passthrough?: WorkflowExecutionEventHooks; enforceBackpressure?: boolean; closed?: Promise<void>; local?: LocalRunParts }
  ): Promise<WorkflowExecutionResult> {
    if (!(await this.deps.gate.useQueue(options.pool))) {
      return await this.deps.executeLocally(spec, options.passthrough, options.local);
    }
    if (this.waiting >= this.deps.maxWaiting) throw new DispatchBusyError(this.deps.maxWaiting);
    if (options.enforceBackpressure !== false) await this.deps.checkBackpressure(options.pool);
    this.waiting += 1;
    let relay: RunRelay | null = null;
    try {
      relay = await this.deps.openRelay(spec, options.passthrough);
      await this.deps.recordQueued(spec);
      try {
        await this.deps.enqueue(spec, { pool: options.pool });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.recordNotQueued(spec, `The run could not be queued: ${message}`);
        throw error;
      }
      this.deps.onQueued?.(spec, options.pool);
      const timeoutMs = this.deps.waitTimeoutMs(spec);
      const ending: Array<Promise<RunRelayEnd>> = [relay.ended(timeoutMs)];
      if (options.closed) ending.push(options.closed.then(() => ({ kind: "closed" }) as const));
      const end = await Promise.race(ending);
      if (end.kind === "result") return end.result as WorkflowExecutionResult;
      if (end.kind === "failed") throw new DispatchFailedError(spec.run.executionId, end.error);
      if (end.kind === "timeout") throw new DispatchTimeoutError(spec.run.executionId, timeoutMs);
      // The client went away: nobody reads the answer. The run goes on on its worker, as an inline run goes on.
      throw new DispatchClientGoneError(spec.run.executionId);
    } finally {
      this.waiting -= 1;
      relay?.close();
    }
  }

  /**
   * Starts a run nobody waits on (a schedule, an app trigger). Queue: enqueued under `queueItemId` when given (an
   * idempotent id: a second fire of the same event enqueues nothing) and resolves at once; inline: resolves when the
   * run ends, as before, with its result.
   */
  async fire(
    spec: DispatchedRunSpec,
    options: { pool: string; queueItemId?: string }
  ): Promise<{ queued: false; result: WorkflowExecutionResult } | { queued: true }> {
    if (!(await this.deps.gate.useQueue(options.pool))) {
      return { queued: false, result: await this.deps.executeLocally(spec) };
    }
    await this.deps.enqueue(spec, { pool: options.pool, ...(options.queueItemId ? { queueItemId: options.queueItemId } : {}) });
    this.deps.onQueued?.(spec, options.pool);
    return { queued: true };
  }
}

export { QueueFullError };
