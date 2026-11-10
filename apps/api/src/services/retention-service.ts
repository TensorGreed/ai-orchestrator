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
 * Records: every start-up, interval and manual purge writes a `retention_runs` row (counts only, kept 90 days) and,
 * when rows went, one `retention.purged` audit row. After-run purges write neither: their counts are added to the next
 * recorded purge. Every purge adds what it deleted to the `<prefix>_retention_deleted_total{class}` counter.
 *
 * Per project: runs, tool calls, rule events and agent memory can be set per project (`retention_policies`, within
 * RETENTION_MIN_DAYS and RETENTION_MAX_DAYS). A purge of such a class runs one pass per project with a value of its
 * own, then one at the deployment's cutoff for every other row; `effectiveRetention(projectId, class)` resolves the
 * same way. Every class is a step, so another deletion source registers as one.
 */
import crypto from "node:crypto";
import {
  GUARD_SIMULATION_RETENTION_DAYS,
  RETENTION_DATA_CLASSES,
  RETENTION_DATA_CLASS_LABELS,
  RETENTION_DATA_CLASS_PURGES,
  RETENTION_EXEMPTIONS_TEXT,
  RETENTION_PURGE_CLASSES,
  RETENTION_PURGE_CLASS_LABELS,
  clampRetentionDays,
  retentionDataClassOf,
  type ProjectRetentionOverride,
  type ProjectRetentionView,
  type RetentionBounds,
  type RetentionDataClass,
  type RetentionAdminView,
  type RetentionClassView,
  type RetentionPurgeClass,
  type RetentionRunReason,
  type RetentionRunView
} from "@ai-orchestrator/shared";
import type { RetentionSettings } from "../config.js";
import type { Store } from "../db/store.js";
import { yieldToEventLoop, type RetentionTable } from "../db/retention-tables.js";
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

/** Per class a project can set: each project with a value of its own, and its days within the bounds. */
type ProjectOverrides = Map<RetentionDataClass, Map<string, number>>;

/**
 * One cutoff of a per-project purge (13.3 R1): one project's rows before its own cutoff, or everyone else's
 * (`excludeProjects`: the projects with a value of their own, which their own passes cover) before the deployment's.
 */
export interface RetentionPass {
  before: string;
  projectId?: string;
  excludeProjects?: readonly string[];
}

/** One class of a purge. */
export interface RetentionStep {
  class: RetentionPurgeClass;
  /** The setting its days come from, for the admin page. */
  setting: string;
  /** Days kept; 0 = kept forever (the step is skipped). */
  days(): number;
  /**
   * Whether the step honours `passes` (per-project cutoffs). A class that projects can set but whose step does not is
   * skipped while any project has a value for it, so a project that keeps longer never loses rows to the deployment's
   * cutoff.
   */
  scoped?: boolean;
  /**
   * Deletes what is due before `before`, at most `limit` rows per table. A scoped step gets `passes` instead (each
   * table's `limit` shared across them); `before` is then the deployment's cutoff, or the earliest pass's.
   */
  run(input: { before: string; limit: number; passes?: readonly RetentionPass[] }): Promise<{ deleted: number; capped: boolean }>;
  /** Rows due before `before` (or in `passes`), up to `cap`; absent when the class cannot count cheaply. */
  countDue?(input: { before: string; cap: number; passes?: readonly RetentionPass[] }): Promise<number>;
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
    scoped: true,
    async run({ before, limit, passes }) {
      let deleted = 0;
      let capped = false;
      for (const table of tables) {
        // One cap per table for the whole purge, shared by its passes in order.
        let remaining = limit;
        for (const pass of passes ?? [{ before }]) {
          if (remaining <= 0) break;
          const n = await store.pruneRetentionTable(table, { ...pass, limit: remaining });
          deleted += n;
          remaining -= n;
        }
        if (remaining <= 0) capped = true;
      }
      return { deleted, capped };
    },
    async countDue({ before, cap, passes }) {
      let total = 0;
      for (const table of tables) {
        for (const pass of passes ?? [{ before }]) {
          if (total >= cap) break;
          total += await store.countRetentionDue(table, { ...pass, cap: cap - total });
        }
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
  private inFlightReason: RetentionRunReason | null = null;
  /** What after-run purges deleted since the last recorded purge; the next scheduled purge records and audits it. */
  private pending: { counts: RetentionRunView["counts"]; capped: Set<RetentionPurgeClass>; errors: string[]; purges: number } = {
    counts: {},
    capped: new Set(),
    errors: [],
    purges: 0
  };
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
   * The days `retentionClass` keeps rows of `projectId` (null: rows of no project): the project's own value for the
   * class it follows (within the deployment's bounds), else the deployment's. One function walks the scopes, so a
   * scope between project and deployment slots in here.
   */
  async effectiveRetention(
    projectId: string | null,
    retentionClass: RetentionPurgeClass
  ): Promise<{ days: number; source: "deployment" | "project"; setting: string } | null> {
    const step = this.steps.get(retentionClass);
    if (!step) return null;
    const dataClass = retentionDataClassOf(retentionClass);
    if (projectId !== null && dataClass) {
      const own = (await this.options.store.listRetentionPolicies({ scopeId: projectId })).find((policy) => policy.dataClass === dataClass);
      if (own) return { days: clampRetentionDays(own.days, this.bounds()), source: "project", setting: "project" };
    }
    return { days: sanitizeDays(step.days()), source: "deployment", setting: step.setting };
  }

  /** The range a project's value must fall in (RETENTION_MIN_DAYS, RETENTION_MAX_DAYS). */
  bounds(): RetentionBounds {
    return { minDays: this.options.settings.minDays, maxDays: this.options.settings.maxDays };
  }

  /** The deployment's value for a per-project class (from the purge class it is named after) and its setting. */
  deploymentRetention(dataClass: RetentionDataClass): { days: number; setting: string } {
    const step = this.steps.get(RETENTION_DATA_CLASS_PURGES[dataClass][0]);
    return step ? { days: sanitizeDays(step.days()), setting: step.setting } : { days: 0, setting: "" };
  }

  /** A project's values, with what each class inherits and what purges apply (`GET /api/projects/:id/retention`). */
  async projectView(projectId: string, canEdit: boolean): Promise<ProjectRetentionView> {
    const bounds = this.bounds();
    const own = new Map((await this.options.store.listRetentionPolicies({ scopeId: projectId })).map((policy) => [policy.dataClass, policy]));
    return {
      projectId,
      bounds,
      exemptions: RETENTION_EXEMPTIONS_TEXT,
      canEdit,
      classes: RETENTION_DATA_CLASSES.map((dataClass) => {
        const deployment = this.deploymentRetention(dataClass);
        const policy = own.get(dataClass);
        const effectiveDays = policy ? clampRetentionDays(policy.days, bounds) : deployment.days;
        return {
          class: dataClass,
          ...RETENTION_DATA_CLASS_LABELS[dataClass],
          deploymentDays: deployment.days,
          deploymentSetting: deployment.setting,
          days: policy ? policy.days : null,
          effectiveDays,
          clamped: policy ? effectiveDays !== policy.days : false,
          updatedBy: policy?.updatedBy ?? null,
          updatedAt: policy?.updatedAt ?? null
        };
      })
    };
  }

  /**
   * The cutoffs one purge of `retentionClass` runs with: one pass per project with its own value (kept forever: no
   * pass), then one for everyone else at the deployment's cutoff. Classes projects cannot set get the deployment's
   * cutoff alone. Empty when nothing of the class is due.
   */
  private passesFor(retentionClass: RetentionPurgeClass, deploymentDays: number, overrides: ProjectOverrides, now: number): RetentionPass[] {
    const cutoff = (days: number) => new Date(now - days * DAY_MS).toISOString();
    const dataClass = retentionDataClassOf(retentionClass);
    const own = dataClass ? overrides.get(dataClass) : undefined;
    if (!own || own.size === 0) return deploymentDays > 0 ? [{ before: cutoff(deploymentDays) }] : [];
    const passes: RetentionPass[] = [];
    for (const [projectId, days] of own) {
      if (days > 0) passes.push({ before: cutoff(days), projectId });
    }
    if (deploymentDays > 0) passes.push({ before: cutoff(deploymentDays), excludeProjects: [...own.keys()] });
    return passes;
  }

  /** Every project's values, per class, clamped to the bounds (one read per purge). */
  private async loadOverrides(): Promise<ProjectOverrides> {
    const bounds = this.bounds();
    const overrides: ProjectOverrides = new Map();
    for (const policy of await this.options.store.listRetentionPolicies()) {
      let own = overrides.get(policy.dataClass);
      if (!own) overrides.set(policy.dataClass, (own = new Map()));
      own.set(policy.scopeId, clampRetentionDays(policy.days, bounds));
    }
    return overrides;
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

  /**
   * Runs one purge now. A purge already running on this instance is joined, not repeated; a scheduled purge that
   * finds an after-run purge running waits for it and then runs itself, so every scheduled purge is recorded.
   */
  async tick(reason: RetentionRunReason): Promise<RetentionTickResult> {
    while (this.inFlight) {
      const current = this.inFlight;
      if (reason === "write" || this.inFlightReason !== "write") return await current;
      await current.catch(() => undefined);
    }
    const run = this.runTick(reason).finally(() => {
      this.inFlight = null;
      this.inFlightReason = null;
    });
    this.inFlight = run;
    this.inFlightReason = reason;
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
    // Projects' own values, read once. Unreadable: the classes projects can set are skipped this time, since the
    // deployment's cutoff alone would delete rows a project keeps longer.
    let overrides: ProjectOverrides | null;
    try {
      overrides = await this.loadOverrides();
    } catch (error) {
      overrides = null;
      errors.push(`project values: ${this.message(error)}`);
      this.options.logger?.warn({ reason, error: this.message(error) }, "Retention purge could not read project values");
    }
    try {
      for (const retentionClass of RETENTION_PURGE_CLASSES) {
        if (this.stopped) break;
        const step = this.steps.get(retentionClass);
        if (!step) continue;
        const projectSettable = retentionDataClassOf(retentionClass) !== null;
        if (projectSettable && overrides === null) continue;
        const passes = this.passesFor(retentionClass, sanitizeDays(step.days()), overrides ?? new Map(), this.now().getTime());
        if (passes.length === 0) continue;
        const scopedPasses = passes.some((pass) => pass.projectId !== undefined || pass.excludeProjects !== undefined);
        if (scopedPasses && !step.scoped) {
          errors.push(`${retentionClass}: skipped, its purge cannot apply project values`);
          continue;
        }
        const before = passes.reduce((earliest, pass) => (pass.before < earliest ? pass.before : earliest), passes[0].before);
        try {
          const result = await step.run({ before, limit: this.options.settings.maxRowsPerTick, ...(scopedPasses ? { passes } : {}) });
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
        // Let timers and requests run between classes (SQLite purges are synchronous inside each batch).
        await yieldToEventLoop();
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
    if (reason === "write") {
      // After-run purges run up to once a minute: they leave no purge-log row or audit entry of their own. What they
      // deleted is added to the next scheduled purge's record.
      for (const [key, n] of Object.entries(counts)) {
        const retentionClass = key as RetentionPurgeClass;
        this.pending.counts[retentionClass] = (this.pending.counts[retentionClass] ?? 0) + (n ?? 0);
      }
      for (const retentionClass of capped) this.pending.capped.add(retentionClass);
      this.pending.errors.push(...errors);
      this.pending.purges += 1;
      if (deleted > 0) this.options.logger?.info({ reason, counts, capped }, "Retention purge deleted rows");
      return { status: "ran", run, deleted };
    }

    // A scheduled purge records itself with what the after-run purges since the last record deleted.
    const carried = this.pending;
    this.pending = { counts: {}, capped: new Set(), errors: [], purges: 0 };
    const recordedCounts: RetentionRunView["counts"] = { ...counts };
    for (const [key, n] of Object.entries(carried.counts)) {
      const retentionClass = key as RetentionPurgeClass;
      recordedCounts[retentionClass] = (recordedCounts[retentionClass] ?? 0) + (n ?? 0);
    }
    const recordedCapped = [...new Set([...capped, ...carried.capped])];
    const recordedErrors = [...errors, ...carried.errors.map((error) => `after a run: ${error}`)];
    const recordedDeleted = Object.values(recordedCounts).reduce((sum: number, n) => sum + (n ?? 0), 0);
    const recorded: RetentionRunView = {
      ...run,
      counts: recordedCounts,
      capped: recordedCapped,
      outcome: errors.length > 0 ? outcome : carried.errors.length > 0 ? "partial" : "ok",
      error: recordedErrors.length > 0 ? recordedErrors.join("; ").slice(0, MAX_ERROR_LENGTH) : null
    };
    try {
      await store.saveRetentionRun(recorded);
    } catch (error) {
      this.options.logger?.warn({ error: this.message(error) }, "Failed to record a retention purge");
    }
    if (recordedDeleted > 0) {
      this.options.logger?.info({ reason, counts: recordedCounts, capped: recordedCapped }, "Retention purge deleted rows");
      try {
        await this.options.audit?.({
          category: "system",
          eventType: "retention.purged",
          action: "delete",
          outcome: recordedErrors.length > 0 ? "failure" : "success",
          actor: { type: "system" },
          resourceType: "retention",
          resourceId: recorded.id,
          metadata: { reason, counts: recordedCounts, capped: recordedCapped, deleted: recordedDeleted, afterRunPurges: carried.purges },
          message: `Retention purge deleted ${recordedDeleted} row${recordedDeleted === 1 ? "" : "s"}`
        });
      } catch (error) {
        this.options.logger?.warn({ error: this.message(error) }, "Failed to audit a retention purge");
      }
    }
    return { status: "ran", run: recorded, deleted };
  }

  /** The admin view: deployment values, backlog and the latest purges. */
  async view(options: { runs?: number } = {}): Promise<RetentionAdminView> {
    const now = this.now().getTime();
    const classes: RetentionClassView[] = [];
    const overrides = await this.loadOverrides();
    for (const retentionClass of RETENTION_PURGE_CLASSES) {
      const step = this.steps.get(retentionClass);
      if (!step) continue;
      const days = sanitizeDays(step.days());
      const cutoff = days > 0 ? new Date(now - days * DAY_MS).toISOString() : null;
      // The backlog counts what the next purge would take: projects' own cutoffs included.
      const passes = this.passesFor(retentionClass, days, overrides, now);
      const scopedPasses = passes.some((pass) => pass.projectId !== undefined || pass.excludeProjects !== undefined);
      let backlog: number | null = null;
      if (passes.length > 0 && step.countDue && (!scopedPasses || step.scoped)) {
        try {
          backlog = await step.countDue({ before: passes[0].before, cap: RETENTION_BACKLOG_CAP, ...(scopedPasses ? { passes } : {}) });
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
      runs,
      projectOverrides: await this.projectOverrides()
    };
  }

  /** The projects with values of their own, with their names, for the admin page. */
  private async projectOverrides(): Promise<ProjectRetentionOverride[]> {
    const byProject = new Map<string, ProjectRetentionOverride["classes"]>();
    for (const policy of await this.options.store.listRetentionPolicies()) {
      const classes = byProject.get(policy.scopeId) ?? {};
      classes[policy.dataClass] = policy.days;
      byProject.set(policy.scopeId, classes);
    }
    if (byProject.size === 0) return [];
    const names = new Map((await this.options.store.listProjects()).map((project) => [project.id, project.name]));
    return [...byProject.entries()].map(([projectId, classes]) => ({ projectId, projectName: names.get(projectId) ?? null, classes }));
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

/**
 * The start-up warning for an explicit USAGE_EVENTS_RETENTION_DAYS (null when usage is kept). Usage retention is applied
 * since 13.3, and an .env copied from an older .env.example still sets 365, so the log names the date before which
 * usage rows now go.
 */
export function usageRetentionWarning(days: number, now: Date = new Date()): { fields: Record<string, unknown>; message: string } | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const deletesBefore = new Date(now.getTime() - days * DAY_MS).toISOString();
  return {
    fields: { setting: "USAGE_EVENTS_RETENTION_DAYS", days, deletesBefore },
    message:
      `USAGE_EVENTS_RETENTION_DAYS=${days} is set: usage events older than ${deletesBefore.slice(0, 10)} are deleted by the ` +
      "retention purge, and FinOps totals, chargeback reports and budget history for those days go with them. " +
      "Remove the setting or set it to 0 to keep usage history."
  };
}
