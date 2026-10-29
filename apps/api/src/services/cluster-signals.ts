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
 *
 * Trust: Postgres has no privilege on NOTIFY channels, so any role that can connect to the database can send on the
 * bus. The database role is the trust boundary (every cluster member shares it); operators must not grant the app's
 * database to untrusted roles. Within that, each message is validated (known type, field types, lengths; anything
 * else is ignored), and a message never decides anything on its own: a `cancel` or `eval_cancel` aborts only a run
 * the store shows canceled, and `workflow_changed` only makes the leader re-read the stored workflow.
 */
import type { Store } from "../db/store.js";
import type { ClusterBus, ClusterMessage } from "./cluster-bus.js";
import { errorText } from "./cluster-bus-local.js";

export const CLUSTER_CANCEL_CHECK_MS_DEFAULT = 10_000;
export const REMOTE_CANCEL_REASON = "The run was canceled.";
/** Longest cancel reason sent on (or taken from) the bus. */
export const CLUSTER_CANCEL_REASON_MAX_LENGTH = 200;
/** Longest id (execution, eval run, workflow, instance) a control message may carry. */
const CLUSTER_ID_MAX_LENGTH = 512;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A cancel reason fit for the bus: control characters become spaces, whitespace is collapsed and the text is cut to
 * CLUSTER_CANCEL_REASON_MAX_LENGTH characters. Undefined when nothing is left.
 */
export function clusterCancelReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const clean = reason.replace(CONTROL_CHARACTER_RUNS, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > CLUSTER_CANCEL_REASON_MAX_LENGTH ? `${clean.slice(0, CLUSTER_CANCEL_REASON_MAX_LENGTH - 1)}…` : clean;
}

function clusterId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= CLUSTER_ID_MAX_LENGTH && !CONTROL_CHARACTERS.test(value) ? value : null;
}

/** A control message this build acts on, validated. */
export type ClusterControlMessage =
  | { t: "cancel"; id: string; reason: string | undefined; from: string | null }
  | { t: "eval_cancel"; runId: string; from: string | null }
  | { t: "workflow_changed"; id: string; from: string | null };

/** The validated form of a `ctl` message, or null for anything else (unknown type, wrong field types or lengths). */
export function parseControlMessage(message: ClusterMessage): ClusterControlMessage | null {
  const from = message.from === undefined ? null : clusterId(message.from);
  if (message.from !== undefined && from === null) return null;
  if (message.t === "cancel") {
    const id = clusterId(message.id);
    if (!id || (message.reason !== undefined && typeof message.reason !== "string")) return null;
    return { t: "cancel", id, reason: clusterCancelReason(message.reason), from };
  }
  if (message.t === "eval_cancel") {
    const runId = clusterId(message.runId);
    return runId ? { t: "eval_cancel", runId, from } : null;
  }
  if (message.t === "workflow_changed") {
    const id = clusterId(message.id);
    return id ? { t: "workflow_changed", id, from } : null;
  }
  return null;
}

export interface ClusterSignalsOptions {
  bus: ClusterBus;
  store: Pick<Store, "listCanceledExecutionIds">;
  /** Runs executing in this process. */
  activeExecutionIds: () => string[];
  /** Aborts a run executing in this process; a no-op when it is not here (or is already ending). */
  abortExecution: (executionId: string, reason: string) => void;
  evalRuns?: {
    /** Stops the run here if it runs here and the store shows it canceled. */
    stopIfCanceledElsewhere(runId: string): Promise<boolean>;
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

  const onControl = async (raw: ClusterMessage): Promise<void> => {
    const message = parseControlMessage(raw);
    if (!message) return;
    if (message.t === "cancel") {
      // Only a run executing here, and only once the store confirms the cancel (one indexed read).
      if (!options.activeExecutionIds().includes(message.id)) return;
      if (!(await options.store.listCanceledExecutionIds([message.id])).includes(message.id)) return;
      options.abortExecution(message.id, message.reason ?? REMOTE_CANCEL_REASON);
      return;
    }
    if (message.t === "eval_cancel") {
      await options.evalRuns?.stopIfCanceledElsewhere(message.runId);
      return;
    }
    // The publisher already reloaded its own services.
    if (message.from === bus.instanceId || !options.workflows?.isLeader()) return;
    await options.workflows.reload(message.id);
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
