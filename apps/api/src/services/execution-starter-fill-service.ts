/**
 * v80 — fills in who started each run recorded before v80 (`execution_history.triggered_by_user_id`), after start-up
 * and in the background, so an upgrade never holds a lock on the run history for long.
 *
 * - Batches: STARTER_FILL_BATCH_SIZE runs per transaction (row locks on those runs only, for tens of milliseconds),
 *   with a short pause between batches so requests keep their share of the database.
 * - Resumable: each batch saves how far it got in the same transaction (db/execution-starter-fill.ts). A stop, a crash
 *   or a lost lease resumes after the last committed batch at the next start (or the next retry).
 * - One instance at a time: only the leader (always the instance itself when HA is off) runs it, and only while it
 *   holds the `execution-starter-fill` lease, renewed every batch. Each batch also takes a lock of its own (on
 *   Postgres an advisory lock; SQLite has one writer), so even two runners would take turns, never visit a run twice.
 * - Until a run is reached it records nobody, which counts as nobody's own run (fail closed): a person who sees only
 *   their own runs sees it once the fill has reached it.
 *
 * Instances that are not the leader, or find the lease held, look again every `retryMs` until the fill is done; then
 * the service stops for good.
 */
import { STARTER_FILL_BATCH_SIZE } from "../db/execution-starter-fill.js";
import type { Store } from "../db/store.js";
import { yieldToEventLoop } from "../db/retention-tables.js";

export const STARTER_FILL_LEASE_NAME = "execution-starter-fill";
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 60_000;
const DEFAULT_PAUSE_MS = 25;
/** Progress is logged at most this often while a fill runs. */
const PROGRESS_LOG_EVERY_MS = 30_000;

export interface ExecutionStarterFillOptions {
  store: Store;
  instanceId: string;
  isLeader: () => boolean;
  logger?: {
    info: (fields: Record<string, unknown>, message: string) => void;
    warn: (fields: Record<string, unknown>, message: string) => void;
  };
  batchSize?: number;
  /** Pause between batches. */
  pauseMs?: number;
  /** How soon an instance that could not run it (not the leader, the lease held, an error) tries again. */
  retryMs?: number;
  leaseTtlMs?: number;
  /** Test seam: called after each batch that committed; return false to stop as a crash would. */
  afterBatch?: (batch: { visited: number; filled: number; transactionMs: number }) => boolean | void;
}

export type ExecutionStarterFillOutcome =
  | { status: "done"; visited: number; filled: number; batches: number; maxTransactionMs: number }
  | { status: "stopped"; visited: number; filled: number; batches: number; maxTransactionMs: number }
  | { status: "skipped"; why: "not_leader" | "lease_held" | "stopped" };

export class ExecutionStarterFillService {
  private stopped = false;
  private finished = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ExecutionStarterFillOutcome> | null = null;
  private readonly batchSize: number;
  private readonly pauseMs: number;
  private readonly retryMs: number;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: ExecutionStarterFillOptions) {
    this.batchSize = options.batchSize ?? STARTER_FILL_BATCH_SIZE;
    this.pauseMs = Math.max(0, options.pauseMs ?? DEFAULT_PAUSE_MS);
    this.retryMs = Math.max(1000, options.retryMs ?? DEFAULT_RETRY_MS);
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Starts the fill in the background (nothing is awaited); retries until it is done. */
  start(): void {
    if (this.stopped || this.finished || this.timer !== null || this.running !== null) return;
    this.schedule(0);
  }

  /** Stops retrying and waits for a batch in flight; the fill resumes from its last batch at the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Runs the fill now, to the end (or until stopped); joins a run already in flight on this instance. */
  async runOnce(): Promise<ExecutionStarterFillOutcome> {
    if (this.running) return await this.running;
    const run = this.fill().finally(() => {
      this.running = null;
    });
    this.running = run;
    return await run;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOnce()
        .then((outcome) => {
          if (outcome.status !== "done") this.schedule(this.retryMs);
        })
        .catch((error: unknown) => {
          this.options.logger?.warn({ error: error instanceof Error ? error.message : String(error) }, "Filling in who started earlier runs failed; it resumes later");
          this.schedule(this.retryMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private async fill(): Promise<ExecutionStarterFillOutcome> {
    const { store, instanceId, logger } = this.options;
    if (this.stopped) return { status: "skipped", why: "stopped" };
    const state = await store.getExecutionStarterFill();
    if (state.done) {
      this.finished = true;
      return { status: "done", visited: 0, filled: 0, batches: 0, maxTransactionMs: 0 };
    }
    if (!this.options.isLeader()) return { status: "skipped", why: "not_leader" };
    const lease = { leaseName: STARTER_FILL_LEASE_NAME, holderId: instanceId, ttlMs: this.leaseTtlMs };
    if (!(await store.tryAcquireLease(lease))) return { status: "skipped", why: "lease_held" };

    let visited = 0;
    let filled = 0;
    let batches = 0;
    let maxTransactionMs = 0;
    const startedAt = Date.now();
    let loggedAt = startedAt;
    logger?.info({ after: state.after, upTo: state.upTo }, "Filling in who started the runs recorded before this upgrade, in the background");
    try {
      for (;;) {
        if (this.stopped) return { status: "stopped", visited, filled, batches, maxTransactionMs };
        const batch = await store.fillExecutionStarters(this.batchSize);
        if (batch.done) {
          this.finished = true;
          logger?.info(
            { visited, filled, batches, maxTransactionMs: Math.round(maxTransactionMs), durationMs: Date.now() - startedAt },
            "Filled in who started the runs recorded before this upgrade"
          );
          return { status: "done", visited, filled, batches, maxTransactionMs };
        }
        visited += batch.visited;
        filled += batch.filled;
        batches += 1;
        maxTransactionMs = Math.max(maxTransactionMs, batch.transactionMs);
        if (this.options.afterBatch?.(batch) === false) return { status: "stopped", visited, filled, batches, maxTransactionMs };
        if (Date.now() - loggedAt >= PROGRESS_LOG_EVERY_MS) {
          loggedAt = Date.now();
          logger?.info({ visited, filled, batches }, "Still filling in who started earlier runs");
        }
        // A lease taken over (this instance stalled past its TTL): another instance carries on from the last batch.
        if (!(await store.tryAcquireLease(lease))) return { status: "stopped", visited, filled, batches, maxTransactionMs };
        if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
        else await yieldToEventLoop();
      }
    } finally {
      try {
        await store.releaseLease(STARTER_FILL_LEASE_NAME, instanceId);
      } catch {
        // The lease expires on its own.
      }
    }
  }
}
