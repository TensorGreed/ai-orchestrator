import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../db/database.js";
import { STUCK_JOB_MARGIN_MS, queuedRunTimeoutMs } from "../db/queue-timeouts.js";
import type { ApprovalResumeJob } from "./approval-service.js";

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
}

export interface QueueServiceConfig {
  concurrency?: number;
  pollIntervalMs?: number;
  stuckJobTimeoutMs?: number;
  /** The run time limit; a job is never treated as stuck before this plus a margin has passed. */
  executionTimeoutMs?: number;
}

export { STUCK_JOB_MARGIN_MS };

/** A running job can legitimately take the whole run time limit, so the stuck threshold must exceed it. */
export function resolveStuckJobTimeoutMs(stuckJobTimeoutMs: number, executionTimeoutMs: number): number {
  return Math.max(stuckJobTimeoutMs, executionTimeoutMs + STUCK_JOB_MARGIN_MS);
}

export type ExecutionHandler = (payload: QueuedExecutionPayload) => Promise<void>;

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

export class QueueService {
  private readonly store: SqliteStore;
  private readonly config: Required<QueueServiceConfig>;
  private running = 0;
  private readonly inFlight = new Map<string, { startedAtMs: number; stuckAfterMs: number }>();
  private readonly warnedStuck = new Set<string>();
  private handler: ExecutionHandler | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(store: SqliteStore, config: QueueServiceConfig = {}) {
    this.store = store;
    this.config = {
      concurrency: config.concurrency ?? 5,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      stuckJobTimeoutMs: resolveStuckJobTimeoutMs(config.stuckJobTimeoutMs ?? 600_000, config.executionTimeoutMs ?? 0),
      executionTimeoutMs: config.executionTimeoutMs ?? 0
    };
  }

  setHandler(handler: ExecutionHandler): void {
    this.handler = handler;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.pollTimer = setInterval(() => {
      this.poll();
    }, this.config.pollIntervalMs);

    // Check for stuck items every 60 seconds
    this.stuckTimer = setInterval(() => {
      this.sweepStuck();
    }, 60_000);
  }

  private sweepStuck(): void {
    const nowMs = Date.now();
    for (const [id, { startedAtMs, stuckAfterMs }] of this.inFlight) {
      if (nowMs - startedAtMs > stuckAfterMs && !this.warnedStuck.has(id)) {
        this.warnedStuck.add(id);
        console.warn(`[queue] Job ${id} still running after ${nowMs - startedAtMs}ms; it is not re-queued while this process holds it`);
      }
    }
    try {
      // A shared database can hold running jobs of other instances; the store applies each job's own run time limit.
      Promise.resolve(this.store.requeueStuckItems(this.config.stuckJobTimeoutMs, [...this.inFlight.keys()], STUCK_JOB_MARGIN_MS))
        .then((requeued) => {
          if (requeued > 0) {
            console.info(`[queue] Re-queued ${requeued} stuck job(s)`);
          }
        })
        .catch((error: unknown) => {
          console.error("[queue] Failed to requeue stuck items", error);
        });
    } catch (error) {
      console.error("[queue] Failed to requeue stuck items", error);
    }
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.stuckTimer) {
      clearInterval(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  async enqueue(
    payload: Omit<QueuedExecutionPayload, "executionId"> & { executionId?: string; priority?: number; queueItemId?: string }
  ): Promise<string> {
    const executionId = payload.executionId ?? randomUUID();
    const { priority, executionId: _id, queueItemId, ...rest } = payload;

    this.store.enqueueExecution({
      // A resume reuses its run's execution id, so its queue item needs its own id.
      id: queueItemId ?? executionId,
      workflowId: rest.workflowId,
      workflowName: undefined,
      payload: { executionId, ...rest } as Record<string, unknown>,
      priority: priority ?? 0,
      maxAttempts: 3
    });

    return executionId;
  }

  getDepth(): { pending: number; running: number; dlq: number } {
    return this.store.getQueueDepth();
  }

  listDlq(limit?: number, workflowIds?: string[]): Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }> {
    return this.store.listDlqItems(limit, workflowIds);
  }

  private poll(): void {
    if (!this.handler) {
      return;
    }

    const available = this.config.concurrency - this.running;
    if (available <= 0) {
      return;
    }

    let items: ReturnType<SqliteStore["dequeueNext"]>;
    try {
      items = this.store.dequeueNext(available);
    } catch (error) {
      console.error("[queue] Failed to dequeue items", error);
      return;
    }

    for (const item of items) {
      this.running++;
      // Warn only once the job's own run time limit (if it set one) and the margin have passed.
      const ownTimeoutMs = queuedRunTimeoutMs(item.payload);
      this.inFlight.set(item.id, {
        startedAtMs: Date.now(),
        stuckAfterMs:
          ownTimeoutMs === null
            ? this.config.stuckJobTimeoutMs
            : Math.max(this.config.stuckJobTimeoutMs, ownTimeoutMs + STUCK_JOB_MARGIN_MS)
      });
      void this.executeItem(item);
    }
  }

  private async executeItem(
    item: ReturnType<SqliteStore["dequeueNext"]>[number]
  ): Promise<void> {
    const handler = this.handler;
    if (!handler) {
      this.running--;
      this.inFlight.delete(item.id);
      this.warnedStuck.delete(item.id);
      try {
        this.store.markQueueItemFailed(item.id, "No handler registered");
      } catch {
        // ignore
      }
      return;
    }

    try {
      const payload = item.payload as unknown as QueuedExecutionPayload;
      await handler(payload);
      this.store.markQueueItemCompleted(item.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[queue] Job ${item.id} failed: ${errorMessage}`);
      try {
        this.store.markQueueItemFailed(item.id, errorMessage, { retryable: !(error instanceof NonRetryableQueueError) });
      } catch (persistError) {
        console.error("[queue] Failed to mark item as failed", persistError);
      }
    } finally {
      this.running--;
      this.inFlight.delete(item.id);
      this.warnedStuck.delete(item.id);
    }
  }
}
