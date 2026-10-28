/**
 * Phase 13.1 — the instance registry: every API instance on Postgres writes a heartbeat row (`cluster_instances`)
 * every `heartbeatMs`, whether HA is on or off. It costs one row per instance and gives:
 *   - the admin cluster view (`GET /api/cluster`);
 *   - liveness for the dead-executor reconcile (the leader fails the inline runs of an instance that stopped beating,
 *     in cluster mode);
 *   - the warning for several instances leading at once: an instance with HA off runs the schedules and triggers
 *     unconditionally, so two such instances (or one beside an elected leader) fire every cron twice. That is only
 *     reported (log, `/health.warnings`, a metric); nothing changes behaviour on its own.
 *
 * Liveness is judged on the database clock against `instanceTimeoutMs`. The leader deletes rows that stopped beating
 * an hour ago; a clean shutdown deletes its own row at once.
 */
import os from "node:os";
import type { ClusterInstanceRecord, Store } from "../db/store.js";
import { errorText } from "./cluster-bus-local.js";

export const CLUSTER_HEARTBEAT_MS_DEFAULT = 10_000;
export const CLUSTER_INSTANCE_TIMEOUT_MS_DEFAULT = 45_000;
/** Rows whose heartbeat is older than this are deleted by the leader. */
export const CLUSTER_INSTANCE_PRUNE_AFTER_MS = 60 * 60 * 1000;

export const DEAD_EXECUTOR_RUN_ERROR = "interrupted: the instance running this run stopped responding";

export interface ClusterWarning {
  code: "multiple_leaders";
  message: string;
  instances: string[];
}

/** What changes between heartbeats, read at each one. */
export interface InstanceRuntimeInfo {
  isLeader: boolean;
  running: number;
  busConnected: boolean;
}

export interface InstanceRegistryOptions {
  store: Store;
  instanceId: string;
  workerMode: string;
  haEnabled: boolean;
  /** Pools this instance's queue consumer claims from (empty when it consumes none). */
  pools: string[];
  /** Queue consumer slots (null when it consumes none). */
  concurrency: number | null;
  capabilities: string[];
  appVersion: string | null;
  schemaVersion: number | null;
  runtime: () => InstanceRuntimeInfo;
  heartbeatMs?: number;
  instanceTimeoutMs?: number;
  /**
   * Cluster mode: on the leader, each heartbeat also fails the inline runs of instances that stopped beating
   * (cluster_run_owners). Off outside cluster mode, where nothing records run owners.
   */
  reconcileDeadExecutors?: boolean;
  /** The leader's runs it failed for a dead instance, for the log and audit. */
  onDeadExecutorRuns?: (runs: Array<{ id: string; workflowId: string; instanceId: string }>) => void;
  /** Called after every heartbeat with the current warnings (the metric and health output read them). */
  onWarnings?: (warnings: ClusterWarning[], live: number) => void;
  logger: { warn: (message: string, fields?: Record<string, unknown>) => void; error: (message: string, fields?: Record<string, unknown>) => void; info: (message: string, fields?: Record<string, unknown>) => void };
  now?: () => number;
}

/** Instances that run the scheduler and triggers: every one with background workers (`all`, `worker`). */
function leaderEligible(instance: Pick<ClusterInstanceRecord, "workerMode">): boolean {
  return instance.workerMode === "all" || instance.workerMode === "worker";
}

/**
 * The warnings for a set of live instances. Several leaders: more than one leader-eligible instance is live and at
 * least one of them has HA off (it leads without an election, so it runs the schedules beside every other leader).
 */
export function clusterWarnings(live: ReadonlyArray<Pick<ClusterInstanceRecord, "id" | "workerMode" | "haEnabled">>): ClusterWarning[] {
  const eligible = live.filter(leaderEligible);
  const unelected = eligible.filter((instance) => !instance.haEnabled);
  if (eligible.length < 2 || unelected.length === 0) return [];
  const ids = eligible.map((instance) => instance.id).sort();
  return [
    {
      code: "multiple_leaders",
      message:
        `${eligible.length} instances that run schedules and triggers share this database, and ${unelected.length} of them ` +
        `${unelected.length === 1 ? "has" : "have"} HA_ENABLED=false, so each leads on its own: every cron and trigger fires ` +
        `once per such instance. Set HA_ENABLED=true on every instance so one leader is elected.`,
      instances: ids
    }
  ];
}

export class InstanceRegistry {
  private timer: NodeJS.Timeout | null = null;
  private beating: Promise<void> | null = null;
  private stopped = false;
  private current: ClusterWarning[] = [];
  private lastWarningKey = "";
  private liveCount = 0;
  private readonly startedAt: string;
  private readonly heartbeatMs: number;
  readonly instanceTimeoutMs: number;
  private readonly hostname = os.hostname();

  constructor(private readonly options: InstanceRegistryOptions) {
    this.startedAt = new Date((options.now ?? Date.now)()).toISOString();
    this.heartbeatMs = options.heartbeatMs ?? CLUSTER_HEARTBEAT_MS_DEFAULT;
    this.instanceTimeoutMs = options.instanceTimeoutMs ?? CLUSTER_INSTANCE_TIMEOUT_MS_DEFAULT;
  }

  get instanceId(): string {
    return this.options.instanceId;
  }

  /** Writes the first heartbeat (awaited, so the instance is listed before it serves), then one every heartbeatMs. */
  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat();
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  /** Stops beating and removes this instance's row, so the others stop counting it at once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.beating?.catch(() => undefined);
    await this.options.store.deleteClusterInstance(this.options.instanceId).catch((error: unknown) => {
      this.options.logger.warn("Could not remove this instance from the cluster registry", { error: errorText(error) });
    });
  }

  /** The warnings found at the last heartbeat. */
  warnings(): ClusterWarning[] {
    return this.current;
  }

  /** Live instances at the last heartbeat. */
  liveInstances(): number {
    return this.liveCount;
  }

  /** Every registry row, with liveness. */
  async list(): Promise<ClusterInstanceRecord[]> {
    return await this.options.store.listClusterInstances({ liveWithinMs: this.instanceTimeoutMs });
  }

  /** One heartbeat; never overlaps itself and never throws (a failed beat is logged and retried at the next tick). */
  async beat(): Promise<void> {
    if (this.stopped) return;
    // promise-ok: kept so a concurrent caller waits for the same beat; cleared when it settles
    this.beating ??= this.beatOnce().finally(() => {
      this.beating = null;
    });
    await this.beating;
  }

  private async beatOnce(): Promise<void> {
    const runtime = this.options.runtime();
    try {
      await this.options.store.heartbeatClusterInstance({
        id: this.options.instanceId,
        workerMode: this.options.workerMode,
        haEnabled: this.options.haEnabled,
        isLeader: runtime.isLeader,
        pools: this.options.pools,
        concurrency: this.options.concurrency,
        running: runtime.running,
        appVersion: this.options.appVersion,
        schemaVersion: this.options.schemaVersion,
        capabilities: this.options.capabilities,
        hostname: this.hostname,
        busConnected: runtime.busConnected,
        startedAt: this.startedAt
      });
      const live = (await this.list()).filter((instance) => instance.live);
      this.liveCount = live.length;
      this.updateWarnings(clusterWarnings(live));
    } catch (error) {
      this.options.logger.warn("Cluster registry heartbeat failed", { error: errorText(error) });
      return;
    }
    if (!runtime.isLeader) return;
    await this.leaderWork();
  }

  private async leaderWork(): Promise<void> {
    try {
      await this.options.store.pruneClusterInstances({ olderThanMs: CLUSTER_INSTANCE_PRUNE_AFTER_MS });
    } catch (error) {
      this.options.logger.warn("Could not prune the cluster registry", { error: errorText(error) });
    }
    if (!this.options.reconcileDeadExecutors) return;
    try {
      const failed = await this.options.store.reconcileDeadExecutorRuns({
        error: DEAD_EXECUTOR_RUN_ERROR,
        deadAfterMs: this.instanceTimeoutMs,
        selfId: this.options.instanceId
      });
      if (failed.length > 0) this.options.onDeadExecutorRuns?.(failed);
    } catch (error) {
      this.options.logger.warn("Could not reconcile the runs of stopped instances", { error: errorText(error) });
    }
  }

  private updateWarnings(warnings: ClusterWarning[]): void {
    this.current = warnings;
    const key = warnings.map((warning) => `${warning.code}:${warning.instances.join(",")}`).join("|");
    if (key !== this.lastWarningKey) {
      // Logged when a warning appears or its instances change, and once when it clears; not at every heartbeat.
      for (const warning of warnings) this.options.logger.error(warning.message, { code: warning.code, instances: warning.instances });
      if (warnings.length === 0 && this.lastWarningKey) this.options.logger.info("Cluster warning cleared", { previous: this.lastWarningKey });
      this.lastWarningKey = key;
    }
    this.options.onWarnings?.(warnings, this.liveCount);
  }
}

/**
 * Phase 13.1 — records which instance executes each inline run (cluster mode), so the leader can fail a dead
 * instance's runs. Writes are fire-and-forget (a run never waits for them) but ordered per run, so a release never
 * lands before its claim. A lost write only means that run falls back to the long reconcile cutoff.
 */
export class RunOwnerTracker {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly instanceId: string,
    private readonly logger: { warn: (message: string, fields?: Record<string, unknown>) => void }
  ) {}

  claim(executionId: string): void {
    this.enqueue(executionId, async () => await this.store.claimClusterRunOwner({ executionId, instanceId: this.instanceId }));
  }

  release(executionId: string): void {
    this.enqueue(executionId, async () => await this.store.releaseClusterRunOwner({ executionId, instanceId: this.instanceId }));
  }

  /** Waits for every queued write (shutdown, tests). */
  async settle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private enqueue(executionId: string, write: () => Promise<void>): void {
    const previous = this.chains.get(executionId) ?? Promise.resolve();
    const next = previous.then(write).catch((error: unknown) => {
      this.logger.warn("Could not record the instance running a run", { executionId, error: errorText(error) });
    });
    this.chains.set(executionId, next);
    void next.then(() => {
      // promise-ok: identity check of this run's latest chain, not a value comparison
      if (this.chains.get(executionId) === next) this.chains.delete(executionId);
    });
  }
}
