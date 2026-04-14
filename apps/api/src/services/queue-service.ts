import { randomUUID } from "node:crypto";
import type { SqliteStore } from "../db/database.js";

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
  executionTimeoutMs?: number;
}

export interface QueueServiceConfig {
  concurrency?: number;
  pollIntervalMs?: number;
  stuckJobTimeoutMs?: number;
}

export type ExecutionHandler = (payload: QueuedExecutionPayload) => Promise<void>;

export class QueueService {
  private readonly store: SqliteStore;
  private readonly config: Required<QueueServiceConfig>;
  private running = 0;
  private handler: ExecutionHandler | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stuckTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(store: SqliteStore, config: QueueServiceConfig = {}) {
    this.store = store;
    this.config = {
      concurrency: config.concurrency ?? 5,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      stuckJobTimeoutMs: config.stuckJobTimeoutMs ?? 600_000
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
      try {
        const requeued = this.store.requeueStuckItems(this.config.stuckJobTimeoutMs);
        if (requeued > 0) {
          console.info(`[queue] Re-queued ${requeued} stuck job(s)`);
        }
      } catch (error) {
        console.error("[queue] Failed to requeue stuck items", error);
      }
    }, 60_000);
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
    payload: Omit<QueuedExecutionPayload, "executionId"> & { executionId?: string; priority?: number }
  ): Promise<string> {
    const executionId = payload.executionId ?? randomUUID();
    const { priority, executionId: _id, ...rest } = payload;

    this.store.enqueueExecution({
      id: executionId,
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

  listDlq(limit?: number): Array<{
    id: string;
    originalId: string;
    workflowId: string;
    workflowName: string | null;
    attempts: number;
    finalError: string;
    failedAt: string;
  }> {
    return this.store.listDlqItems(limit);
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
      void this.executeItem(item);
    }
  }

  private async executeItem(
    item: ReturnType<SqliteStore["dequeueNext"]>[number]
  ): Promise<void> {
    const handler = this.handler;
    if (!handler) {
      this.running--;
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
        this.store.markQueueItemFailed(item.id, errorMessage);
      } catch (persistError) {
        console.error("[queue] Failed to mark item as failed", persistError);
      }
    } finally {
      this.running--;
    }
  }
}
