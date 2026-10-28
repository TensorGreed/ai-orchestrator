/**
 * Phase 13.1 — what each instance does with the control messages on the cluster bus, plus the reconciliation that
 * makes each effect happen even when a message is lost (the bus is best effort, see cluster-bus.ts):
 *
 *   - `cancel` {id, reason}: the run is already `canceled` in the store; the instance executing it aborts it.
 *     Backstop: every `cancelCheckMs`, and at once after a bus resync, the instance reads which of its running runs
 *     are `canceled` in the store and aborts those.
 *   - `eval_cancel` {runId}: the eval run or replay job is already `canceled`; the instance executing it stops it.
 *     Backstop: the eval heartbeat re-reads its runs (EvalService watchRemoteCancel), and a resync re-reads them all.
 *   - `workflow_changed` {id}: the leader reloads that workflow's schedules and triggers at once. Backstop: the
 *     leader's periodic schedule sync (and a full sync after a resync).
 *
 * Every handler is idempotent: aborting an aborted run, stopping a stopped eval run or reloading a workflow twice does
 * nothing more.
 */
import type { Store } from "../db/store.js";
import type { ClusterBus, ClusterMessage } from "./cluster-bus.js";
import { errorText } from "./cluster-bus-local.js";

export const CLUSTER_CANCEL_CHECK_MS_DEFAULT = 10_000;
export const REMOTE_CANCEL_REASON = "The run was canceled.";

export interface ClusterSignalsOptions {
  bus: ClusterBus;
  store: Pick<Store, "listCanceledExecutionIds">;
  /** Runs executing in this process. */
  activeExecutionIds: () => string[];
  /** Aborts a run executing in this process; a no-op when it is not here (or is already ending). */
  abortExecution: (executionId: string, reason: string) => void;
  evalRuns?: {
    stopCanceledElsewhere(runId: string): boolean;
    stopRunsCanceledElsewhere(): Promise<number>;
  };
  workflows?: {
    isLeader: () => boolean;
    reload: (workflowId: string) => Promise<void>;
    /** Full re-read of every schedule and trigger (after a resync). */
    syncAll: () => Promise<void>;
  };
  /** The cancel backstop's period; 0 turns it off. Default 10 s. */
  cancelCheckMs?: number;
  logger: { warn: (message: string, fields?: Record<string, unknown>) => void; info?: (message: string, fields?: Record<string, unknown>) => void };
}

export interface ClusterSignals {
  /** Reads which local runs were canceled elsewhere and aborts them. Returns the ids it aborted. */
  checkCanceled(): Promise<string[]>;
  stop(): void;
}

export function startClusterSignals(options: ClusterSignalsOptions): ClusterSignals {
  const { bus, logger } = options;
  let checking: Promise<string[]> | null = null;

  const checkCanceled = async (): Promise<string[]> => {
    // promise-ok: kept so overlapping callers (timer, resync) share one read; cleared when it settles
    checking ??= (async () => {
      const ids = options.activeExecutionIds();
      if (ids.length === 0) return [];
      const canceled = await options.store.listCanceledExecutionIds(ids);
      for (const id of canceled) options.abortExecution(id, REMOTE_CANCEL_REASON);
      return canceled;
    })().finally(() => {
      checking = null;
    });
    return await checking;
  };

  const onControl = async (message: ClusterMessage): Promise<void> => {
    if (message.t === "cancel" && typeof message.id === "string") {
      options.abortExecution(message.id, typeof message.reason === "string" && message.reason ? message.reason : REMOTE_CANCEL_REASON);
      return;
    }
    if (message.t === "eval_cancel" && typeof message.runId === "string") {
      options.evalRuns?.stopCanceledElsewhere(message.runId);
      return;
    }
    if (message.t === "workflow_changed" && typeof message.id === "string") {
      // The publisher already reloaded its own services.
      if (message.from === bus.instanceId || !options.workflows?.isLeader()) return;
      await options.workflows.reload(message.id);
    }
  };

  const onResync = async (): Promise<void> => {
    const results = await Promise.allSettled([
      checkCanceled(),
      options.evalRuns?.stopRunsCanceledElsewhere(),
      options.workflows?.isLeader() ? options.workflows.syncAll() : undefined
    ]);
    for (const result of results) {
      if (result.status === "rejected") logger.warn("Cluster resync step failed", { error: errorText(result.reason) });
    }
  };

  const unsubscribe = bus.subscribe("ctl", onControl);
  const unsubscribeResync = bus.onResync(onResync);
  const period = options.cancelCheckMs ?? CLUSTER_CANCEL_CHECK_MS_DEFAULT;
  const timer =
    period > 0
      ? setInterval(() => {
          checkCanceled().catch((error: unknown) => logger.warn("Cancel check failed", { error: errorText(error) }));
        }, period)
      : null;
  timer?.unref?.();

  return {
    checkCanceled,
    stop() {
      unsubscribe();
      unsubscribeResync();
      if (timer) clearInterval(timer);
    }
  };
}
