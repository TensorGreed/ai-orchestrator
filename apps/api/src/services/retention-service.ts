/**
 * 13.3 — the retention service: every purge by age goes through it.
 *
 * One purge (a "tick") runs the classes in a fixed order (RETENTION_PURGE_CLASSES): runs, tool calls, rule events,
 * cassettes and approvals, the queue, agent memory, usage, AI gateway requests, eval runs, captured runs and rule
 * simulations. Each class prunes its tables by age, at most RETENTION_MAX_ROWS_PER_TICK rows per table, in batches
 * (the store yields to the event loop between SQLite batches; Postgres batches skip locked rows). What is left goes
 * on the next purge, and the admin page shows the backlog.
 *
 * Who purges: only the leader (always the instance itself when HA is off), and only while it holds the `retention`
 * lease, so two instances never purge at once, whatever their HA settings. A purge runs at start-up, on
 * EXECUTION_HISTORY_PRUNE_INTERVAL_MS, and after finished runs (nudge(), at most once a minute per instance).
 *
 * Records: every start-up and interval purge, and every other purge that deleted rows or failed, writes a
 * `retention_runs` row (counts only, kept 90 days). A purge that deleted rows adds to the
 * `<prefix>_retention_deleted_total{class}` counter and writes one `retention.purged` audit row with the counts.
 *
 * Seams for later steps: `effectiveRetention(projectId, class)` resolves a class's days (deployment only today;
 * per-project values slot in between), and every class is a step, so another deletion source registers as one.
 */
import crypto from "node:crypto";
import {
  GUARD_SIMULATION_RETENTION_DAYS,
  RETENTION_PURGE_CLASSES,
  RETENTION_PURGE_CLASS_LABELS,
  type RetentionAdminView,
  type RetentionClassView,
  type RetentionPurgeClass,
  type RetentionRunReason,
  type RetentionRunView
} from "@ai-orchestrator/shared";
import type { RetentionSettings } from "../config.js";
import type { Store } from "../db/store.js";
import type { RetentionTable } from "../db/retention-tables.js";
import type { AuditEventInput } from "./audit-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The lease a purge holds; renewed between classes. */
export const RETENTION_LEASE_NAME = "retention";
/** `retention_runs` rows are kept this long. */
export const RETENTION_RUN_LOG_DAYS = 90;
/** The backlog is counted up to this many rows per class. */
export const RETENTION_BACKLOG_CAP = 10_000;
const DEFAULT_NUDGE_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_TTL_MS = 15 * 60_000;
const MAX_ERROR_LENGTH = 1000;

/** One class of a purge. */
export interface RetentionStep {
  class: RetentionPurgeClass;
  /** The setting its days come from, for the admin page. */
  setting: string;
  /** Days kept; 0 = kept forever (the step is skipped). */
  days(): number;
  /** Deletes what is due before `before`, at most `limit` rows per table. */
  run(input: { before: string; limit: number }): Promise<{ deleted: number; capped: boolean }>;
  /** Rows due before `before`, up to `cap`; absent when the class cannot count cheaply. */
  countDue?(input: { before: string; cap: number }): Promise<number>;
}

export interface RetentionMetrics {
  recordRetentionDeleted(retentionClass: RetentionPurgeClass, count: number): void;
}

export interface RetentionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface RetentionServiceOptions {
  store: Store;
  settings: RetentionSettings;
  /** EXECUTION_HISTORY_RETENTION_DAYS: runs and what goes with them (0 = keep). */
  executionHistoryDays: number;
  /** EVAL_RUN_RETENTION_DAYS (0 = keep). */
  evalRunDays: number;
  /** EXECUTION_HISTORY_PRUNE_INTERVAL_MS. */
  intervalMs: number;
  instanceId: string;
  /** Whether this instance leads (always true when HA is off). */
  isLeader: () => boolean;
  metrics?: RetentionMetrics;
  audit?: (event: AuditEventInput) => Promise<unknown>;
  logger?: RetentionLogger;
  /** Applied to error messages before they are logged or recorded. */
  redact?: (text: string) => string;
  now?: () => Date;
  nudgeIntervalMs?: number;
  leaseTtlMs?: number;
}

export type RetentionTickResult =
  | { status: "ran"; run: RetentionRunView; deleted: number }
  | { status: "skipped"; why: "not_leader" | "lease_held" | "stopped" };

/** A class that prunes whole tables by age through the store, the same cutoff for each. */
function tableStep(
  store: Store,
  retentionClass: RetentionPurgeClass,
  setting: string,
  days: () => number,
  tables: readonly RetentionTable[]
): RetentionStep {
  return {
    class: retentionClass,
    setting,
    days,
    async run({ before, limit }) {
      let deleted = 0;
      let capped = false;
      for (const table of tables) {
        const n = await store.pruneRetentionTable(table, { before, limit });
        deleted += n;
        if (n >= limit) capped = true;
      }
      return { deleted, capped };
    },
    async countDue({ before, cap }) {
      let total = 0;
      for (const table of tables) {
        if (total >= cap) break;
        total += await store.countRetentionDue(table, { before, cap: cap - total });
      }
      return Math.min(total, cap);
    }
  };
}

export class RetentionService {
  private readonly steps = new Map<RetentionPurgeClass, RetentionStep>();
  private readonly now: () => Date;
  private readonly nudgeIntervalMs: number;
  private readonly leaseTtlMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<RetentionTickResult> | null = null;
  private lastNudgeAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(private readonly options: RetentionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.nudgeIntervalMs = options.nudgeIntervalMs ?? DEFAULT_NUDGE_INTERVAL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const { store, settings } = options;
    const history = () => options.executionHistoryDays;
    const historySetting = "EXECUTION_HISTORY_RETENTION_DAYS";
    this.register(tableStep(store, "runs", historySetting, history, ["execution_history"]));
    this.register(tableStep(store, "tool_calls", historySetting, history, ["mcp_tool_calls"]));
    this.register(tableStep(store, "rule_events", historySetting, history, ["guard_events"]));
    this.register(
      tableStep(store, "cassettes_approvals", historySetting, history, ["approval_requests", "mcp_cassettes", "mcp_gateway_approvals"])
    );
    this.register(tableStep(store, "queue", historySetting, history, ["execution_queue", "execution_queue_dlq"]));
    this.register(
      tableStep(store, "agent_memory", "AGENT_MEMORY_RETENTION_DAYS", () => settings.agentMemoryDays, [
        "session_memory",
        "session_artifacts",
        "session_tool_cache"
      ])
    );
    this.register(tableStep(store, "usage", "USAGE_EVENTS_RETENTION_DAYS", () => settings.usageEventDays, ["usage_events"]));
    this.register(
      tableStep(store, "gateway_requests", "AI_GATEWAY_REQUEST_RETENTION_DAYS", () => settings.aiGatewayRequestDays, ["ai_gateway_requests"])
    );
    // Eval runs go whole or not at all, and the newest run of every set stays (the store decides); no row cap.
    this.register({
      class: "eval_runs",
      setting: "EVAL_RUN_RETENTION_DAYS",
      days: () => options.evalRunDays,
      async run({ before }) {
        return { deleted: await store.pruneEvalRuns({ before }), capped: false };
      }
    });
  }

  /** Adds or replaces the step of a class (captured runs and rule simulations register theirs once their services exist). */
  register(step: RetentionStep): void {
    this.steps.set(step.class, step);
  }

  /**
   * The days `retentionClass` keeps rows of `projectId` (null: rows of no project). Deployment values only for now;
   * per-project values are resolved here, between the deployment value and the result.
   */
  async effectiveRetention(_projectId: string | null, retentionClass: RetentionPurgeClass): Promise<{ days: number; source: "deployment"; setting: string } | null> {
    const step = this.steps.get(retentionClass);
    if (!step) return null;
    return { days: sanitizeDays(step.days()), source: "deployment", setting: step.setting };
  }

  /** Starts the interval purges and runs the start-up purge. */
  async start(): Promise<void> {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.background("interval"), this.options.intervalMs);
    this.timer.unref?.();
    await this.tick("startup");
  }

  /** Stops the timer and waits for a purge in flight. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.idle();
  }

  /** Resolves once no purge is running on this instance. */
  async idle(): Promise<void> {
    await this.inFlight?.catch(() => undefined);
  }

  /** A run finished: purge, unless this instance already did within the last minute. Never waits for the purge. */
  nudge(): void {
    if (this.stopped) return;
    const now = this.now().getTime();
    if (now - this.lastNudgeAt < this.nudgeIntervalMs) return;
    this.lastNudgeAt = now;
    this.background("write");
  }

  /** A purge nobody waits for; anything it did not catch itself is logged. */
  private background(reason: RetentionRunReason): void {
    this.tick(reason).catch((error: unknown) => {
      this.options.logger?.warn({ reason, error: this.message(error) }, "Retention purge failed");
    });
  }

  /** Runs one purge now (a purge already running on this instance is joined, not repeated). */
  async tick(reason: RetentionRunReason): Promise<RetentionTickResult> {
    if (this.inFlight) return await this.inFlight;
    const run = this.runTick(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return await run;
  }

  private async runTick(reason: RetentionRunReason): Promise<RetentionTickResult> {
    if (this.stopped) return { status: "skipped", why: "stopped" };
    if (!this.options.isLeader()) return { status: "skipped", why: "not_leader" };
    const { store, instanceId } = this.options;
    const lease = { leaseName: RETENTION_LEASE_NAME, holderId: instanceId, ttlMs: this.leaseTtlMs };
    let held: boolean;
    try {
      held = await store.tryAcquireLease(lease);
    } catch (error) {
      this.options.logger?.warn({ reason, error: this.message(error) }, "Retention purge could not take its lease");
      return { status: "skipped", why: "lease_held" };
    }
    if (!held) return { status: "skipped", why: "lease_held" };

    const startedAt = this.now();
    const counts: RetentionRunView["counts"] = {};
    const capped: RetentionPurgeClass[] = [];
    const errors: string[] = [];
    let deleted = 0;
    try {
      for (const retentionClass of RETENTION_PURGE_CLASSES) {
        if (this.stopped) break;
        const step = this.steps.get(retentionClass);
        if (!step) continue;
        const days = sanitizeDays(step.days());
        if (days <= 0) continue;
        const before = new Date(this.now().getTime() - days * DAY_MS).toISOString();
        try {
          const result = await step.run({ before, limit: this.options.settings.maxRowsPerTick });
          if (result.deleted > 0) {
            counts[retentionClass] = result.deleted;
            deleted += result.deleted;
            this.options.metrics?.recordRetentionDeleted(retentionClass, result.deleted);
          }
          if (result.capped) capped.push(retentionClass);
        } catch (error) {
          const message = this.message(error);
          errors.push(`${retentionClass}: ${message}`);
          this.options.logger?.warn({ reason, class: retentionClass, before, error: message }, "Retention purge failed for a class");
        }
        // Renew between classes; a lease taken over (this purge outlived its TTL) stops the purge here.
        if (!(await this.renew(lease))) {
          errors.push("lease: lost to another instance; the purge stopped");
          break;
        }
      }
      try {
        await store.pruneRetentionTable("retention_runs", {
          before: new Date(this.now().getTime() - RETENTION_RUN_LOG_DAYS * DAY_MS).toISOString(),
          limit: this.options.settings.maxRowsPerTick
        });
      } catch (error) {
        this.options.logger?.warn({ error: this.message(error) }, "Failed to prune the retention purge log");
      }
    } finally {
      try {
        await store.releaseLease(RETENTION_LEASE_NAME, instanceId);
      } catch {
        // The lease expires on its own.
      }
    }

    const outcome = errors.length === 0 ? "ok" : deleted > 0 || errors.length < this.activeClassCount() ? "partial" : "error";
    const run: RetentionRunView = {
      id: crypto.randomUUID(),
      startedAt: startedAt.toISOString(),
      finishedAt: this.now().toISOString(),
      instanceId,
      reason,
      outcome,
      counts,
      capped,
      error: errors.length > 0 ? errors.join("; ").slice(0, MAX_ERROR_LENGTH) : null
    };
    // After-run purges are frequent; they are recorded only when they did something worth showing.
    if (reason !== "write" || deleted > 0 || errors.length > 0) {
      try {
        await store.saveRetentionRun(run);
      } catch (error) {
        this.options.logger?.warn({ error: this.message(error) }, "Failed to record a retention purge");
      }
    }
    if (deleted > 0) {
      this.options.logger?.info({ reason, counts, capped }, "Retention purge deleted rows");
      try {
        await this.options.audit?.({
          category: "system",
          eventType: "retention.purged",
          action: "delete",
          outcome: errors.length > 0 ? "failure" : "success",
          actor: { type: "system" },
          resourceType: "retention",
          resourceId: run.id,
          metadata: { reason, counts, capped, deleted },
          message: `Retention purge deleted ${deleted} row${deleted === 1 ? "" : "s"}`
        });
      } catch (error) {
        this.options.logger?.warn({ error: this.message(error) }, "Failed to audit a retention purge");
      }
    }
    return { status: "ran", run, deleted };
  }

  /** The admin view: deployment values, backlog and the latest purges. */
  async view(options: { runs?: number } = {}): Promise<RetentionAdminView> {
    const now = this.now().getTime();
    const classes: RetentionClassView[] = [];
    for (const retentionClass of RETENTION_PURGE_CLASSES) {
      const step = this.steps.get(retentionClass);
      if (!step) continue;
      const days = sanitizeDays(step.days());
      const cutoff = days > 0 ? new Date(now - days * DAY_MS).toISOString() : null;
      let backlog: number | null = null;
      if (cutoff && step.countDue) {
        try {
          backlog = await step.countDue({ before: cutoff, cap: RETENTION_BACKLOG_CAP });
        } catch (error) {
          this.options.logger?.warn({ class: retentionClass, error: this.message(error) }, "Failed to count the retention backlog");
        }
      }
      classes.push({
        class: retentionClass,
        ...RETENTION_PURGE_CLASS_LABELS[retentionClass],
        setting: step.setting,
        days,
        cutoff,
        backlog,
        backlogCapped: backlog !== null && backlog >= RETENTION_BACKLOG_CAP
      });
    }
    const runs = await this.options.store.listRetentionRuns(options.runs ?? 20);
    const lastScheduled = runs.find((run) => run.reason === "interval" || run.reason === "startup");
    return {
      intervalMs: this.options.intervalMs,
      maxRowsPerTick: this.options.settings.maxRowsPerTick,
      bounds: { minDays: this.options.settings.minDays, maxDays: this.options.settings.maxDays },
      backlogCap: RETENTION_BACKLOG_CAP,
      classes,
      lastRun: runs[0] ?? null,
      nextRunAt: lastScheduled ? new Date(Date.parse(lastScheduled.startedAt) + this.options.intervalMs).toISOString() : null,
      runs
    };
  }

  private activeClassCount(): number {
    return [...this.steps.values()].filter((step) => sanitizeDays(step.days()) > 0).length;
  }

  private async renew(lease: { leaseName: string; holderId: string; ttlMs: number }): Promise<boolean> {
    try {
      return await this.options.store.tryAcquireLease(lease);
    } catch {
      return false;
    }
  }

  private message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return this.options.redact ? this.options.redact(text) : text;
  }
}

function sanitizeDays(days: number): number {
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
}

/** Rule simulations: GUARD_SIMULATION_RETENTION_DAYS, a fixed constant. */
export function ruleSimulationStep(prune: (before: string) => Promise<number>): RetentionStep {
  return {
    class: "simulations",
    setting: `fixed (${GUARD_SIMULATION_RETENTION_DAYS} days)`,
    days: () => GUARD_SIMULATION_RETENTION_DAYS,
    async run({ before }) {
      return { deleted: await prune(before), capped: false };
    }
  };
}

/** Captured runs nobody promoted: REPLAY_CAPTURE_RETENTION_DAYS. Golden runs are never pruned. */
export function captureStep(days: () => number, prune: (before: string) => Promise<number>): RetentionStep {
  return {
    class: "captures",
    setting: "REPLAY_CAPTURE_RETENTION_DAYS",
    days,
    async run({ before }) {
      return { deleted: await prune(before), capped: false };
    }
  };
}
