import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import { STUCK_JOB_MARGIN_MS, queuedRunTimeoutMs } from "../db/queue-timeouts.js";
import { DEFAULT_QUEUE_POOL, QUEUE_POOL_PATTERN, type LostJobOutcome } from "../db/queue-leases.js";
import type { ApprovalResumeJob } from "./approval-service.js";
import type { Store } from "../db/store.js";
import type { DispatchedRunSpec } from "./run-dispatch.js";

export interface QueuedExecutionPayload {
  workflowId: string;
  executionId: string;
  input?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  systemPrompt?: string;
  userPrompt?: string;
  sessionId?: string;
  triggerType?: string;
  triggeredBy?: string;
  /** The signed-in user who enqueued the job; their access is checked again when it runs. */
  enqueuedByUserId?: string;
  executionTimeoutMs?: number;
  customData?: Record<string, unknown>;
  /** Phase 11.2 — resume a paused run with a recorded approval decision instead of starting one. */
  resume?: ApprovalResumeJob;
  /**
   * Phase 13.1 — queue dispatch: a run another instance received, as it would have started it inline (run-dispatch.ts).
   * Only consumers that advertise queue-dispatch-v1 are sent such jobs.
   */
  dispatch?: DispatchedRunSpec;
}

export interface QueueServiceConfig {
  concurrency?: number;
  pollIntervalMs?: number;
  stuckJobTimeoutMs?: number;
  /** The run time limit; a job is never treated as stuck before this plus a margin has passed. */
  executionTimeoutMs?: number;
  /** Phase 13.1 — pending jobs per pool at which an enforced enqueue is refused (0 = no limit). */
  maxPending?: number;
  /** Phase 13.1 — skip claiming while resident memory is above this many MB (0 = off). */
  maxRssMb?: number;
  /** Phase 13.1 — skip claiming while the event loop's p99 lag over the last second exceeds this many ms (0 = off). */
  maxEventLoopLagMs?: number;
  /** Where the claim gates read memory and event-loop lag (tests pass fakes); the process's own by default. */
  probes?: QueueClaimProbes;
}

/** An event-loop delay histogram, as monitorEventLoopDelay returns (values in nanoseconds). */
export interface LagHistogram {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
  readonly count: number;
}

export interface QueueClaimProbes {
  rssBytes?: () => number;
  createLagHistogram?: () => LagHistogram;
}

/** A closed claim gate re-opens only once memory is below this share of QUEUE_MAX_RSS_MB. */
export const RSS_RESUME_RATIO = 0.9;
/** A closed claim gate re-opens only once event-loop lag is below this share of QUEUE_MAX_EVENT_LOOP_LAG_MS. */
export const LAG_RESUME_RATIO = 0.8;

export { STUCK_JOB_MARGIN_MS };

/** A running job can legitimately take the whole run time limit, so the stuck threshold must exceed it. */
export function resolveStuckJobTimeoutMs(stuckJobTimeoutMs: number, executionTimeoutMs: number): number {
  return Math.max(stuckJobTimeoutMs, executionTimeoutMs + STUCK_JOB_MARGIN_MS);
}

/** What a handler learns about the job it runs. */
export interface QueueJobContext {
  queueItemId: string;
  /** The fencing token of a leased claim (cluster mode); null for an unleased claim. */
  claimToken: string | null;
  /** Aborted when the job must stop here: its lease was lost, or the worker is draining for shutdown. */
  signal: AbortSignal;
  /** Attempts already counted before this one. */
  attempts: number;
  pool: string;
  /**
   * Cluster mode: whether this worker can still count on its lease (renewed recently enough). When it cannot, the job
   * is stopped here (the signal aborts) and false is returned; call it before a step with side effects starts.
   * Always true for an unleased claim.
   */
  leaseFresh: () => boolean;
  /** A write fenced on this claim was refused (the claim was taken back): the job is stopped here. */
  leaseLost: (detail: string) => void;
}

export type ExecutionHandler = (payload: QueuedExecutionPayload, context: QueueJobContext) => Promise<void>;

/**
 * A job that can never succeed by retrying (for example, the user who queued
 * it may no longer run the workflow). It goes straight to the dead-letter
 * queue instead of spending its remaining attempts.
 */
export class NonRetryableQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableQueueError";
  }
}

/** Phase 13.1 — an enqueue refused because the pool already holds QUEUE_MAX_PENDING pending jobs. */
export class QueueFullError extends Error {
  readonly pool: string;
  readonly retryAfterSeconds: number;
  constructor(pool: string, maxPending: number, retryAfterSeconds: number) {
    super(`The queue for pool "${pool}" holds ${maxPending} pending jobs (QUEUE_MAX_PENDING); try again later.`);
    this.name = "QueueFullError";
    this.pool = pool;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The reason a draining worker stops a job it gives back (the run is not saved as canceled or failed). */
export class QueueDrainAbort extends Error {
  constructor() {
    super("The worker is shutting down; the job is given back to the queue.");
    this.name = "QueueDrainAbort";
  }
}

/** The reason a job is stopped because its claim was taken back (another worker may run it now). */
export class QueueLeaseLostAbort extends Error {
  constructor(detail: string) {
    super(`The job's queue lease was lost (${detail}); it is no longer run here.`);
    this.name = "QueueLeaseLostAbort";
  }
}

export type EnqueueInput = Omit<QueuedExecutionPayload, "executionId"> & {
  executionId?: string;
  priority?: number;
  queueItemId?: string;
  maxAttempts?: number;
  /** Phase 13.1 — the worker pool that runs it (default `default`). */
  pool?: string;
};

/** How long a backpressure count of one pool is reused before it is read again. */
const PENDING_COUNT_TTL_MS = 1_000;
const QUEUE_FULL_RETRY_AFTER_SECONDS = 5;

/**
 * Phase 13.1 — the producer half of the queue: enqueue, depth and the dead-letter list. It exists on every instance,
 * whatever WORKER_MODE says, so an `api` replica accepts `/enqueue` while `worker` replicas run the jobs.
 */
export class QueueProducer {
  private readonly store: Store;
  private readonly maxPending: number;
  private readonly pendingCounts = new Map<string, { count: number; readAtMs: number }>();

  constructor(store: Store, options: { maxPending?: number } = {}) {
    this.store = store;
    this.maxPending = Math.max(0, Math.floor(options.maxPending ?? 0));
  }

  /**
   * Adds a job and returns its execution id. With `enforceBackpressure` (requests from outside: `/enqueue`), a pool
   * that already holds QUEUE_MAX_PENDING pending jobs refuses it with QueueFullError. The count is re-read at most once
   * a second, so a burst can overshoot the limit by what arrives within that second.
   */
  async enqueue(payload: EnqueueInput, options: { enforceBackpressure?: boolean } = {}): Promise<string> {
    return (await this.add(payload, options)).executionId;
  }

  /**
   * As `enqueue`, and says whether the job was added. With `dedupeWindowMs` and a `queueItemId`, an existing item with
   * that id is a duplicate (nothing added) unless it is finished and older than the window, when the new job replaces
   * it. Without it an existing item always wins.
   */
  async add(payload: EnqueueInput, options: { enforceBackpressure?: boolean; dedupeWindowMs?: number } = {}): Promise<{ executionId: string; added: boolean }> {
    const executionId = payload.executionId ?? randomUUID();
    const { priority, executionId: _id, queueItemId, maxAttempts, pool: requestedPool, ...rest } = payload;
    const pool = requestedPool ?? DEFAULT_QUEUE_POOL;
    if (!QUEUE_POOL_PATTERN.test(pool)) {
      throw new Error(`Invalid queue pool "${pool.slice(0, 64)}": letters, digits, _ or - (at most 63).`);
    }
    if (options.enforceBackpressure) await this.checkBackpressure(pool);

    const added = await this.store.enqueueExecution({
      // A resume reuses its run's execution id, so its queue item needs its own id.
      id: queueItemId ?? executionId,
      workflowId: rest.workflowId,
      workflowName: undefined,
      payload: { executionId, ...rest } as Record<string, unknown>,
      priority: priority ?? 0,
      maxAttempts: maxAttempts ?? 3,
      ...(pool !== DEFAULT_QUEUE_POOL ? { pool } : {}),
      ...(queueItemId && options.dedupeWindowMs !== undefined
        ? { replaceFinishedBefore: new Date(Date.now() - options.dedupeWindowMs).toISOString() }
        : {})
    });
    const cached = this.pendingCounts.get(pool);
    if (cached && added) cached.count += 1;

    return { executionId, added };
  }

  /** Throws QueueFullError when `pool` already holds QUEUE_MAX_PENDING pending jobs (never with no limit set). */
  async checkBackpressure(pool: string): Promise<void> {
    if (this.maxPending <= 0) return;
    const pending = await this.pendingCount(pool);
    if (pending >= this.maxPending) throw new QueueFullError(pool, this.maxPending, QUEUE_FULL_RETRY_AFTER_SECONDS);
  }

  private async pendingCount(pool: string): Promise<number> {
    const now = Date.now();
    const cached = this.pendingCounts.get(pool);
    if (cached && now - cached.readAtMs < PENDING_COUNT_TTL_MS) return cached.count;
    const count = await this.store.countPendingQueueItems(pool);
    this.pendingCounts.set(pool, { count, readAtMs: now });
    return count;
  }

  async getDepth(): Promise<{ pending: number; running: number; dlq: number }> {
    return await this.store.getQueueDepth();
  }

  async getDepthByPool(): Promise<Array<{ pool: string; pending: number; running: number }>> {
    return await this.store.getQueueDepthByPool();
  }

  async listDlq(limit?: number, workflowIds?: string[]): Promise<Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }>> {
    return await this.store.listDlqItems(limit, workflowIds);
  }
}

/** Phase 13.1 — heartbeat leases (cluster mode only). */
export interface QueueLeaseOptions {
  /** The instance id claims are recorded under (HA_INSTANCE_ID or the generated one). */
  instanceId: string;
  heartbeatMs: number;
  leaseMs: number;
  reaperIntervalMs: number;
  pools: string[];
}

/** Hooks for metrics and logs; each is optional and must not throw. */
export interface QueueConsumerObserver {
  onClaimed?: (job: { id: string; pool: string; waitMs: number | null }) => void;
  onLost?: (outcomes: LostJobOutcome[]) => void;
  onReleased?: (outcome: LostJobOutcome) => void;
  onSlotsChanged?: (free: number) => void;
  log?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;
}

interface ActiveJob {
  id: string;
  executionId: string;
  claimToken: string | null;
  controller: AbortController;
  /** Why this worker stopped the job, if it did: the lease was lost, or the worker is draining. */
  stoppedBy: "lost" | "drain" | null;
  /** Set once a drain has given the job back itself (the handler had not returned in time). */
  releasedByDrain: boolean;
  startedAtMs: number;
  stuckAfterMs: number;
  /** performance.now() when its lease was last confirmed: the start of the last renew that succeeded (or the claim). */
  renewedAtMs: number;
  settled: Promise<void>;
}

type ClaimedItem = {
  id: string;
  workflowId: string;
  payload: Record<string, unknown>;
  attempts: number;
  scheduledAt?: string;
  pool?: string;
  claimToken?: string;
  waitMs?: number;
};

/**
 * The consumer half of the queue: poll, claim, run, complete, and (cluster mode) heartbeat, reap and fence. It is
 * created only where WORKER_MODE runs background work (`all`, `worker`). Without enableLeases() it runs exactly the
 * single-instance code path: unleased claims and the stuck-job sweep. The producer methods are kept here too, so
 * existing callers that hold a QueueService enqueue through it.
 */
export class QueueConsumer {
  readonly producer: QueueProducer;
  private readonly store: Store;
  private readonly config: Required<Omit<QueueServiceConfig, "maxPending" | "probes">>;
  private readonly active = new Map<string, ActiveJob>();
  private readonly warnedStuck = new Set<string>();
  private handler: ExecutionHandler | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private started = false;
  private claiming = false;
  private polling = false;
  private pollAgain = false;
  private heartbeating = false;
  private reaping = false;
  private leases: QueueLeaseOptions | null = null;
  private observer: QueueConsumerObserver = {};
  private cancelHandler: ((executionId: string) => void) | null = null;
  private lagMonitor: LagHistogram | null = null;
  private lagResetTimer: NodeJS.Timeout | null = null;
  /** The p99 event-loop lag (ms) of the last full window, kept across the reset so a fresh window is never "no lag". */
  private lastWindowLagMs = 0;
  /** Why claiming is paused for self-protection; it re-opens only below the resume thresholds. */
  private gatedBy: "rss" | "event_loop_lag" | null = null;
  /** Cluster mode: set when this worker stopped jobs because it could not confirm its leases; no claims until it can. */
  private leaseUnconfirmed = false;
  private readonly probes: Required<QueueClaimProbes>;
  /** Phase 13.1 — whether this instance re-queues stuck jobs (on a shared database only the leader does). */
  private sweepGate: () => boolean = () => true;

  constructor(store: Store, config: QueueServiceConfig = {}) {
    this.store = store;
    this.producer = new QueueProducer(store, { maxPending: config.maxPending });
    this.config = {
      concurrency: config.concurrency ?? 5,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      stuckJobTimeoutMs: resolveStuckJobTimeoutMs(config.stuckJobTimeoutMs ?? 600_000, config.executionTimeoutMs ?? 0),
      executionTimeoutMs: config.executionTimeoutMs ?? 0,
      maxRssMb: config.maxRssMb ?? 0,
      maxEventLoopLagMs: config.maxEventLoopLagMs ?? 0
    };
    this.probes = {
      rssBytes: config.probes?.rssBytes ?? (() => process.memoryUsage().rss),
      createLagHistogram: config.probes?.createLagHistogram ?? ((): LagHistogram => monitorEventLoopDelay({ resolution: 20 }) as IntervalHistogram)
    };
  }

  setHandler(handler: ExecutionHandler): void {
    this.handler = handler;
  }

  /**
   * Phase 13.1 — on a database instances share, only the leader re-queues stuck jobs and reaps expired leases
   * (createApp passes isLeader). Every instance still warns about its own long-running jobs. Without a gate (one
   * process) it always sweeps.
   */
  setSweepGate(gate: () => boolean): void {
    this.sweepGate = gate;
  }

  /**
   * Phase 13.1 — cluster mode: claims carry this instance as owner and a fencing token, the consumer renews them every
   * heartbeatMs and stops a job whose claim was taken back, and (behind the sweep gate) reaps expired leases every
   * reaperIntervalMs. Call before start().
   */
  enableLeases(options: QueueLeaseOptions): void {
    if (this.started) throw new Error("enableLeases must be called before start()");
    if (options.pools.length === 0) throw new Error("A leased consumer needs at least one pool");
    this.leases = { ...options, pools: [...options.pools] };
  }

  leaseOptions(): QueueLeaseOptions | null {
    return this.leases ? { ...this.leases, pools: [...this.leases.pools] } : null;
  }

  setObserver(observer: QueueConsumerObserver): void {
    this.observer = observer;
  }

  /** Called with a running job's execution id when its history reads canceled (cluster mode, on each heartbeat). */
  setCancelHandler(handler: (executionId: string) => void): void {
    this.cancelHandler = handler;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.claiming = true;
    // promise-ok: poll catches and logs its own dequeue errors
    this.pollTimer = setInterval(async () => {
      await this.poll();
    }, this.config.pollIntervalMs);

    // Check for stuck items every 60 seconds
    // promise-ok: sweepStuck catches and logs its own errors
    this.stuckTimer = setInterval(async () => {
      await this.sweepStuck();
    }, 60_000);

    if (this.leases) {
      // promise-ok: heartbeat catches and logs its own errors
      this.heartbeatTimer = setInterval(async () => {
        await this.heartbeat();
      }, this.leases.heartbeatMs);
      // promise-ok: reap catches and logs its own errors
      this.reaperTimer = setInterval(async () => {
        await this.reap();
      }, this.leases.reaperIntervalMs);
    }
    if (this.config.maxEventLoopLagMs > 0) {
      this.lagMonitor = this.probes.createLagHistogram();
      this.lagMonitor.enable();
      // The gate reads the p99 of one-second windows; the last full window is kept when a new one starts.
      this.lagResetTimer = setInterval(() => this.rollLagWindow(), 1_000);
      this.lagResetTimer.unref?.();
    }
  }

  stop(): void {
    this.started = false;
    this.claiming = false;
    for (const timer of [this.pollTimer, this.stuckTimer, this.heartbeatTimer, this.reaperTimer, this.lagResetTimer]) {
      if (timer) clearInterval(timer);
    }
    this.pollTimer = null;
    this.stuckTimer = null;
    this.heartbeatTimer = null;
    this.reaperTimer = null;
    this.lagResetTimer = null;
    this.lagMonitor?.disable();
    this.lagMonitor = null;
  }

  /** Polls now instead of at the next tick (a wake-up from the bus after an enqueue). */
  wake(): void {
    if (!this.started || !this.claiming) return;
    void this.poll();
  }

  /** Jobs running here now. */
  inFlightCount(): number {
    return this.active.size;
  }

  /** Free slots (concurrency minus running jobs); 0 while not claiming. */
  freeSlots(): number {
    return this.claiming ? Math.max(0, this.config.concurrency - this.active.size) : 0;
  }

  concurrency(): number {
    return this.config.concurrency;
  }

  /** Stops claiming new jobs; running jobs go on (and keep renewing their leases). */
  stopClaiming(): void {
    this.claiming = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.observer.onSlotsChanged?.(0);
  }

  /**
   * Graceful shutdown: stops claiming, lets running jobs finish for up to `timeoutMs`, then stops the rest and gives
   * them back to the queue (QueueDrainAbort; releaseQueueItem: no attempt counted, the worker-loss policy decides
   * between pending and interrupted). Waits up to `settleMs` more for the stopped jobs to wind down; one still running
   * after that is given back by the drain itself.
   */
  async drain(timeoutMs: number, settleMs = 5_000): Promise<{ finished: number; released: number }> {
    this.stopClaiming();
    const startedWith = this.active.size;
    if (startedWith === 0) return { finished: 0, released: 0 };
    await this.waitForIdle(timeoutMs);
    const remaining = [...this.active.values()];
    for (const job of remaining) this.stopJob(job, "drain", new QueueDrainAbort());
    await this.waitForIdle(settleMs);
    for (const job of this.active.values()) {
      if (job.releasedByDrain) continue;
      job.releasedByDrain = true;
      await this.release(job);
    }
    return { finished: startedWith - remaining.length, released: remaining.length };
  }

  private async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (this.active.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.active.values()].map((job) => job.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remainingMs);
        })
      ]);
      clearTimeout(timer);
    }
  }

  async enqueue(payload: EnqueueInput, options: { enforceBackpressure?: boolean } = {}): Promise<string> {
    return await this.producer.enqueue(payload, options);
  }

  async getDepth(): Promise<{ pending: number; running: number; dlq: number }> {
    return await this.producer.getDepth();
  }

  async listDlq(limit?: number, workflowIds?: string[]): ReturnType<QueueProducer["listDlq"]> {
    return await this.producer.listDlq(limit, workflowIds);
  }

  private log(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
    if (this.observer.log) {
      this.observer.log(level, message, fields);
      return;
    }
    const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
    if (level === "error") console.error(`[queue] ${line}`);
    else if (level === "warn") console.warn(`[queue] ${line}`);
    else console.info(`[queue] ${line}`);
  }

  private async sweepStuck(): Promise<void> {
    const nowMs = Date.now();
    for (const [id, { startedAtMs, stuckAfterMs }] of this.active) {
      if (nowMs - startedAtMs > stuckAfterMs && !this.warnedStuck.has(id)) {
        this.warnedStuck.add(id);
        console.warn(`[queue] Job ${id} still running after ${nowMs - startedAtMs}ms; it is not re-queued while this process holds it`);
      }
    }
    if (!this.sweepGate()) return;
    try {
      // A shared database can hold running jobs of other instances; the store applies each job's own run time limit.
      // Leased claims with a recent heartbeat are the lease reaper's; this rule covers claims without one.
      const requeued = await this.store.requeueStuckItems(this.config.stuckJobTimeoutMs, [...this.active.keys()], STUCK_JOB_MARGIN_MS);
      if (requeued > 0) {
        console.info(`[queue] Re-queued ${requeued} stuck job(s)`);
      }
    } catch (error) {
      console.error("[queue] Failed to requeue stuck items", error);
    }
  }

  /**
   * Cluster mode: renews this worker's leases, stops jobs it no longer holds, and notices canceled runs. The self-fence
   * runs on every tick, also while an earlier renew is still waiting on the database: a renew counts only if it answers
   * within one heartbeat, and a job whose lease was not confirmed for lease - heartbeat is stopped before the reaper
   * can hand it on. Until a later renew (or, with nothing running, a probe) answers in time, nothing new is claimed.
   */
  private async heartbeat(): Promise<void> {
    const leases = this.leases;
    if (!leases) return;
    this.selfFence(leases);
    if (this.heartbeating) return;
    this.heartbeating = true;
    try {
      const jobs = [...this.active.values()].filter((job) => job.claimToken !== null && job.stoppedBy === null);
      const startedAtMs = performance.now();
      let answered = false;
      try {
        if (jobs.length === 0) {
          if (this.leaseUnconfirmed) {
            await this.withinHeartbeat(this.store.countPendingQueueItems(leases.pools[0]!), leases);
            answered = true;
          }
          return;
        }
        const held = new Set(await this.withinHeartbeat(this.store.renewQueueLeases({ owner: leases.instanceId, claimTokens: jobs.map((job) => job.claimToken!) }), leases));
        answered = true;
        for (const job of jobs) {
          if (held.has(job.claimToken!)) job.renewedAtMs = Math.max(job.renewedAtMs, startedAtMs);
          else this.stopJob(job, "lost", new QueueLeaseLostAbort("taken back by the queue"));
        }
      } catch (error) {
        this.log("warn", "Failed to renew queue leases", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (answered && this.leaseUnconfirmed) {
          this.leaseUnconfirmed = false;
          this.log("info", "Queue leases confirmed again: claiming resumes");
        }
      }
      this.selfFence(leases);
      // A cancel recorded on another instance (its signal may have been missed) stops the run here too.
      if (this.cancelHandler) {
        const running = jobs.filter((job) => job.stoppedBy === null);
        if (running.length > 0) {
          try {
            for (const executionId of await this.withinHeartbeat(this.store.listCanceledExecutionIds(running.map((job) => job.executionId)), leases)) {
              this.cancelHandler(executionId);
            }
          } catch (error) {
            this.log("warn", "Failed to check running jobs for a cancel", { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } finally {
      this.heartbeating = false;
    }
  }

  /** A database call of the heartbeat that does not answer within one heartbeat counts as failed. */
  private async withinHeartbeat<T>(call: Promise<T>, leases: QueueLeaseOptions): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${leases.heartbeatMs} ms`)), leases.heartbeatMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
      // A late answer (or failure) of a call given up on is dropped.
      call.catch(() => undefined);
    }
  }

  /** Stops every leased job whose lease was not confirmed in time; claiming waits until a lease is confirmed again. */
  private selfFence(leases: QueueLeaseOptions): void {
    const nowMs = performance.now();
    for (const job of this.active.values()) {
      if (job.claimToken === null || job.stoppedBy !== null) continue;
      if (nowMs - job.renewedAtMs > leases.leaseMs - leases.heartbeatMs) {
        if (!this.leaseUnconfirmed) {
          this.leaseUnconfirmed = true;
          this.log("warn", "Queue leases could not be confirmed in time: stopping their jobs and claiming nothing new");
        }
        this.stopJob(job, "lost", new QueueLeaseLostAbort("not renewed in time"));
      }
    }
  }

  /** Whether this job's lease is still confirmed recently enough; stops the job when it is not. */
  private leaseFresh(job: ActiveJob): boolean {
    if (job.stoppedBy !== null) return false;
    const leases = this.leases;
    if (!leases || job.claimToken === null) return true;
    if (performance.now() - job.renewedAtMs <= leases.leaseMs - leases.heartbeatMs) return true;
    this.stopJob(job, "lost", new QueueLeaseLostAbort("not renewed in time"));
    return false;
  }

  /** Cluster mode, leader only: settles jobs whose lease ran out (their worker is gone). */
  private async reap(): Promise<void> {
    const leases = this.leases;
    if (!leases || this.reaping || !this.sweepGate()) return;
    this.reaping = true;
    try {
      const outcomes = await this.store.reapExpiredQueueLeases({ leaseMs: leases.leaseMs });
      if (outcomes.length > 0) {
        this.observer.onLost?.(outcomes);
        this.log("warn", "Took back queue jobs whose worker was lost", {
          count: outcomes.length,
          jobs: outcomes.slice(0, 50).map((outcome) => ({ id: outcome.id, decision: outcome.decision, attempts: outcome.attempts }))
        });
      }
    } catch (error) {
      this.log("error", "Failed to reap expired queue leases", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.reaping = false;
    }
  }

  private stopJob(job: ActiveJob, reason: "lost" | "drain", abortReason: Error): void {
    if (job.stoppedBy !== null) return;
    job.stoppedBy = reason;
    if (reason === "lost") this.log("warn", "Stopped a queue job whose lease was lost", { id: job.id, executionId: job.executionId });
    job.controller.abort(abortReason);
  }

  private rollLagWindow(): void {
    const monitor = this.lagMonitor;
    if (!monitor) return;
    this.lastWindowLagMs = monitor.count > 0 ? monitor.percentile(99) / 1e6 : 0;
    monitor.reset();
  }

  /** The p99 event-loop lag to gate on: the worse of the last full window and the one filling now. */
  private eventLoopLagMs(): number {
    const monitor = this.lagMonitor;
    if (!monitor) return 0;
    const current = monitor.count > 0 ? monitor.percentile(99) / 1e6 : 0;
    return Math.max(this.lastWindowLagMs, current);
  }

  /**
   * How many jobs this poll may claim (0: paused for self-protection). The memory and event-loop gates close above
   * their limits and re-open only once both are below their resume thresholds (RSS_RESUME_RATIO, LAG_RESUME_RATIO),
   * so a value hovering at a limit does not flap; the first poll after re-opening claims one job. In cluster mode a
   * worker that could not confirm its leases claims nothing.
   */
  private claimAllowance(available: number): number {
    if (available <= 0 || (this.leases && this.leaseUnconfirmed)) return 0;
    const maxRss = this.config.maxRssMb * 1024 * 1024;
    const maxLag = this.config.maxEventLoopLagMs;
    if (maxRss === 0 && maxLag === 0) return available;
    const rss = maxRss > 0 ? this.probes.rssBytes() : 0;
    const lag = maxLag > 0 ? this.eventLoopLagMs() : 0;
    if (this.gatedBy !== null) {
      const rssLow = maxRss === 0 || rss <= maxRss * RSS_RESUME_RATIO;
      const lagLow = maxLag === 0 || lag <= maxLag * LAG_RESUME_RATIO;
      if (!rssLow || !lagLow) return 0;
      this.log("info", "Queue claiming resumes", { pausedBy: this.gatedBy });
      this.gatedBy = null;
      return Math.min(1, available);
    }
    if (maxRss > 0 && rss > maxRss) this.gatedBy = "rss";
    else if (maxLag > 0 && lag > maxLag) this.gatedBy = "event_loop_lag";
    if (this.gatedBy !== null) {
      this.log("warn", "Queue claiming paused to protect this worker", { pausedBy: this.gatedBy });
      return 0;
    }
    return available;
  }

  private async poll(): Promise<void> {
    // One poll at a time: a dequeue still waiting on the database must not let the next tick take more jobs. A wake
    // that arrives meanwhile polls again right after.
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.pollAgain = false;
        await this.pollOnce();
      } while (this.pollAgain && this.claiming);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.handler || !this.claiming) {
      return;
    }

    const available = this.claimAllowance(this.config.concurrency - this.active.size);
    if (available <= 0) {
      return;
    }

    let items: ClaimedItem[];
    try {
      items = this.leases
        ? await this.store.claimQueueItems({ limit: available, owner: this.leases.instanceId, pools: this.leases.pools })
        : await this.store.dequeueNext(available);
    } catch (error) {
      console.error("[queue] Failed to dequeue items", error);
      return;
    }

    for (const item of items) {
      this.startJob(item);
    }
    if (items.length > 0) this.observer.onSlotsChanged?.(this.freeSlots());
  }

  private startJob(item: ClaimedItem): void {
    // Warn only once the job's own run time limit (if it set one) and the margin have passed.
    const ownTimeoutMs = queuedRunTimeoutMs(item.payload);
    const executionId = typeof item.payload.executionId === "string" && item.payload.executionId ? item.payload.executionId : item.id;
    const job: ActiveJob = {
      id: item.id,
      executionId,
      claimToken: item.claimToken ?? null,
      controller: new AbortController(),
      stoppedBy: null,
      releasedByDrain: false,
      startedAtMs: Date.now(),
      stuckAfterMs:
        ownTimeoutMs === null
          ? this.config.stuckJobTimeoutMs
          : Math.max(this.config.stuckJobTimeoutMs, ownTimeoutMs + STUCK_JOB_MARGIN_MS),
      renewedAtMs: performance.now(),
      settled: Promise.resolve()
    };
    this.active.set(item.id, job);
    // A leased claim measured its wait in database time; an unleased one (one process) measures it here.
    const dueAtMs = item.scheduledAt ? Date.parse(item.scheduledAt) : Number.NaN;
    const waitMs = item.waitMs ?? (Number.isFinite(dueAtMs) ? Math.max(0, Date.now() - dueAtMs) : null);
    this.observer.onClaimed?.({ id: item.id, pool: item.pool ?? DEFAULT_QUEUE_POOL, waitMs });
    job.settled = this.executeItem(item, job);
  }

  private async executeItem(item: ClaimedItem, job: ActiveJob): Promise<void> {
    const handler = this.handler;
    const fenced = job.claimToken !== null ? { claimToken: job.claimToken } : {};
    try {
      if (!handler) {
        try {
          await this.store.markQueueItemFailed(item.id, "No handler registered", fenced);
        } catch {
          // ignore
        }
        return;
      }
      try {
        const payload = item.payload as unknown as QueuedExecutionPayload;
        await handler(payload, {
          queueItemId: item.id,
          claimToken: job.claimToken,
          signal: job.controller.signal,
          attempts: item.attempts,
          pool: item.pool ?? DEFAULT_QUEUE_POOL,
          leaseFresh: () => this.leaseFresh(job),
          leaseLost: (detail) => this.stopJob(job, "lost", new QueueLeaseLostAbort(detail))
        });
        if (job.stoppedBy !== null) {
          await this.settleStopped(job);
          return;
        }
        const completed = await this.store.markQueueItemCompleted(item.id, ...(job.claimToken !== null ? [fenced] : []));
        if (!completed && job.claimToken !== null) this.log("warn", "A completion was refused: the job's claim was taken back", { id: item.id });
      } catch (error) {
        if (job.stoppedBy !== null) {
          await this.settleStopped(job);
          return;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[queue] Job ${item.id} failed: ${errorMessage}`);
        try {
          const failed = await this.store.markQueueItemFailed(item.id, errorMessage, { retryable: !(error instanceof NonRetryableQueueError), ...fenced });
          if (!failed && job.claimToken !== null) this.log("warn", "A failure was refused: the job's claim was taken back", { id: item.id });
        } catch (persistError) {
          console.error("[queue] Failed to mark item as failed", persistError);
        }
      }
    } finally {
      this.active.delete(item.id);
      this.warnedStuck.delete(item.id);
      this.observer.onSlotsChanged?.(this.freeSlots());
    }
  }

  /** A job this worker stopped: a lost lease belongs to someone else now; a drained one is given back. */
  private async settleStopped(job: ActiveJob): Promise<void> {
    if (job.stoppedBy !== "drain" || job.releasedByDrain) return;
    job.releasedByDrain = true;
    await this.release(job);
  }

  private async release(job: ActiveJob): Promise<void> {
    try {
      const outcome = await this.store.releaseQueueItem({ id: job.id, claimToken: job.claimToken });
      if (outcome) {
        this.observer.onReleased?.(outcome);
        this.log("info", "Gave a queue job back while shutting down", { id: job.id, decision: outcome.decision });
      }
    } catch (error) {
      this.log("error", "Failed to give a queue job back while shutting down", { id: job.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** The consumer under its original name: createApp and existing callers take a QueueService. */
export { QueueConsumer as QueueService };
