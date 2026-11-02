/**
 * Phase 8.3 — BudgetService.
 *
 * Spend / token caps with two enforcement modes:
 *   - `warn`  — never blocks. Fires a budget_alert (and Notification) when
 *               usage crosses the warn threshold or the cap. Useful as a
 *               soft signal to operators.
 *   - `block` — pre-execution check rejects the request with HTTP 402 when
 *               current-period usage already meets the cap. Also fires
 *               post-execution alerts on warn-threshold/cap crossings.
 *
 * Scopes
 * ------
 *   - `global`   — applies to every execution (scope_id ignored).
 *   - `project`  — applies when execution's workflow.project_id == scope_id.
 *   - `workflow` — applies when execution's workflow.id == scope_id.
 *   - `user`     — applies when execution's triggeredBy matches scope_id
 *                  (best-effort: we match on email or user-id, both can be
 *                  the actor depending on trigger type).
 *   - `mcp_client` (12.6) — an MCP gateway client: the runs its tool calls
 *                  start and the sampling its server tool calls use. A
 *                  toolset's project budget counts that toolset's gateway
 *                  usage as well (see Store.queryBudgetUsage).
 *
 * Where `block` applies (12.6, D8)
 * --------------------------------
 *   - every run a trigger starts (RunDispatcher's admission: webhooks,
 *     schedules, chat, forms, app triggers, queue dispatch, retries, gateway
 *     workflow tools), through `checkBlock`, and `/api/workflows/:id/execute`
 *     through `checkExecution` (which also reports approaching limits);
 *   - every gateway `tools/call`, before the tool policy (`checkBlock` with
 *     the client and the toolset's project).
 *   A run or call that starts while usage is under the cap may take it over;
 *   calls of one gateway batch are checked together, so a batch may overshoot
 *   by one batch. The next one is refused.
 *
 * `checkBlock` reads the budgets from an in-process snapshot (re-read every
 * `refreshMs` and at once after a local edit), so with no matching `block`
 * budget it reads nothing from the store.
 *
 * Period boundaries
 * -----------------
 *   - day:   UTC midnight to next UTC midnight.
 *   - week:  Monday 00:00 UTC to next Monday 00:00 UTC.
 *   - month: 1st of month 00:00 UTC to 1st of next month 00:00 UTC.
 *
 * Alerts are debounced per (budget, period, severity) tuple so a user
 * doesn't get spammed with one alert per execution after a threshold flips.
 */

import { randomUUID } from "node:crypto";
import type { McpClientBudgetUsage } from "@ai-orchestrator/shared";
import type { BudgetRecord } from "../db/database.js";
import type { Store } from "../db/store.js";

export interface BudgetCheckContext {
  /** Null for a gateway server-tool call (no workflow). */
  workflowId: string | null;
  projectId: string | null;
  userEmail: string | null;
  userId: string | null;
  /** 12.6 — the gateway client behind the call or run. */
  client?: { id: string; name: string } | null;
  /** 12.6 — the project of the gateway toolset the call came through. */
  toolsetProjectId?: string | null;
}

/** 12.6 — a `block` budget that is used up: the run or gateway call is refused (HTTP 402 on HTTP triggers). */
export class BudgetExceededError extends Error {
  readonly statusCode = 402;
  constructor(
    readonly budget: BudgetRecord,
    readonly current: number,
    readonly limit: number,
    readonly periodStart: string
  ) {
    super(`Budget "${budget.name}" exceeded for the current ${budget.period}.`);
    this.name = "BudgetExceededError";
  }
}

/** The budgets could not be read (and no earlier copy exists), or a block budget's usage could not be read. */
export class BudgetUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Budgets could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "BudgetUnavailableError";
  }
}

export const BUDGET_SNAPSHOT_REFRESH_MS = 2_000;

export interface BudgetCheckResult {
  allowed: boolean;
  blocked?: { budget: BudgetRecord; current: number; limit: number; periodStart: string };
  approachingLimit: Array<{ budget: BudgetRecord; current: number; limit: number; pct: number }>;
}

export interface BudgetRecordContext extends BudgetCheckContext {
  executionId: string;
  spentUsd: number;
  spentTokens: number;
}

export class BudgetService {
  private readonly store: Store;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };
  private readonly refreshMs: number;
  private snapshot: BudgetRecord[] | null = null;
  private loadedAt = 0;
  private loading: Promise<BudgetRecord[]> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, options: { refreshMs?: number } = {}) {
    this.store = store;
    this.refreshMs = options.refreshMs ?? BUDGET_SNAPSHOT_REFRESH_MS;
  }

  // ---------------------------------------------------------------------------
  // 12.6 — the enabled budgets, kept in memory for the hot paths
  // ---------------------------------------------------------------------------

  /** Loads the snapshot and re-reads it every `refreshMs` in the background (other instances' edits apply within it). */
  async start(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // Logged by load; a check loads the snapshot itself until one read succeeds.
    }
    if (!this.timer && this.refreshMs > 0) {
      this.timer = setInterval(() => {
        this.refresh().catch(() => undefined);
      }, this.refreshMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-reads the enabled budgets (after a local edit, at once). A failure keeps the last copy and is rethrown. */
  async refresh(): Promise<void> {
    await this.load();
  }

  private load(): Promise<BudgetRecord[]> {
    if (this.loading) return this.loading;
    const loading = (async () => {
      try {
        const next = await this.store.listBudgets({ enabledOnly: true });
        this.snapshot = next;
        this.loadedAt = Date.now();
        return next;
      } catch (error) {
        this.logger?.warn(this.snapshot ? "Could not re-read the budgets; keeping the last copy" : "Could not read the budgets", {
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      } finally {
        this.loading = null;
      }
    })();
    this.loading = loading;
    return loading;
  }

  /** The enabled budgets; read from the store only when no copy was ever loaded (then a failure throws). */
  private async enabledBudgets(): Promise<BudgetRecord[]> {
    if (this.snapshot) {
      // Not started (no background re-read): re-read here at most every `refreshMs`, keeping the copy on failure.
      if (!this.timer && this.refreshMs > 0 && Date.now() - this.loadedAt > this.refreshMs) {
        this.loadedAt = Date.now();
        return await this.load().catch(() => this.snapshot!);
      }
      return this.snapshot;
    }
    try {
      return await this.load();
    } catch (error) {
      throw new BudgetUnavailableError(error);
    }
  }

  /**
   * 12.6 — the first matching `block` budget whose cap the current period's usage meets, or null. With no matching
   * block budget in the snapshot nothing is read from the store. Throws BudgetUnavailableError when the budgets or
   * a block budget's usage cannot be read.
   */
  async checkBlock(ctx: BudgetCheckContext): Promise<BudgetExceededError | null> {
    const blocking = matchBudgets(await this.enabledBudgets(), ctx).filter((budget) => budget.action === "block");
    for (const budget of blocking) {
      const periodStart = currentPeriodStart(budget.period);
      let current: number;
      try {
        current = await this.currentUsage(budget, ctx, periodStart);
      } catch (error) {
        throw new BudgetUnavailableError(error);
      }
      if (current >= budget.limitValue) return new BudgetExceededError(budget, current, budget.limitValue, periodStart);
    }
    return null;
  }

  /** Throws the BudgetExceededError of `checkBlock`, if any. */
  async assertNotBlocked(ctx: BudgetCheckContext): Promise<void> {
    const blocked = await this.checkBlock(ctx);
    if (blocked) throw blocked;
  }

  /**
   * 12.6 — after a gateway server-tool call that used sampling: fires the alerts of the client's, the toolset
   * project's and the global budgets it crossed (as `recordExecution` does for runs). Nothing is read when no budget
   * matches.
   */
  async recordGatewayUsage(ctx: BudgetCheckContext & { executionId: string }): Promise<void> {
    await this.alertCrossed(ctx);
  }

  /** 12.6 — the budgets scoped to one gateway client, with what each counted this period (the client's Governance). */
  async clientUsage(client: { id: string; name: string }): Promise<McpClientBudgetUsage[]> {
    const budgets = await this.store.listBudgets({ scopeType: "mcp_client", scopeId: client.id });
    const ctx: BudgetCheckContext = { workflowId: null, projectId: null, userEmail: null, userId: null, client };
    const views: McpClientBudgetUsage[] = [];
    for (const budget of budgets) {
      if (budget.scopeId !== client.id) continue;
      const periodStart = currentPeriodStart(budget.period);
      views.push({
        budgetId: budget.id,
        name: budget.name,
        scopeType: budget.scopeType,
        scopeId: budget.scopeId,
        period: budget.period,
        limitType: budget.limitType,
        limitValue: budget.limitValue,
        action: budget.action,
        enabled: budget.enabled,
        current: await this.currentUsage(budget, ctx, periodStart),
        periodStart
      });
    }
    return views;
  }

  setLogger(logger: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void }): void {
    this.logger = logger;
  }

  // ---------------------------------------------------------------------------
  // Pre-execution: hard block
  // ---------------------------------------------------------------------------

  /**
   * Iterate enabled `block`-action budgets that match the request scope. If
   * any of them already meets/exceeds its cap for the current period, deny.
   * Also surface budgets that are within `warnThresholdPct` so the caller
   * can attach a "warning" header to the response.
   */
  async checkExecution(ctx: BudgetCheckContext): Promise<BudgetCheckResult> {
    const matching = await this.matchingBudgets(ctx);
    const approaching: BudgetCheckResult["approachingLimit"] = [];
    for (const budget of matching) {
      const periodStart = currentPeriodStart(budget.period);
      const current = await this.currentUsage(budget, ctx, periodStart);
      const pct = budget.limitValue > 0 ? current / budget.limitValue : 0;
      if (budget.action === "block" && current >= budget.limitValue) {
        return {
          allowed: false,
          blocked: { budget, current, limit: budget.limitValue, periodStart },
          approachingLimit: approaching
        };
      }
      if (pct >= budget.warnThresholdPct) {
        approaching.push({ budget, current, limit: budget.limitValue, pct });
      }
    }
    return { allowed: true, approachingLimit: approaching };
  }

  // ---------------------------------------------------------------------------
  // Post-execution: alert firing
  // ---------------------------------------------------------------------------

  /**
   * Called after usage_events is written. Re-checks every matching budget
   * and fires an alert if a threshold was newly crossed. Debounced via
   * getLatestBudgetAlert so we only fire once per (budget, period, severity).
   */
  async recordExecution(ctx: BudgetRecordContext): Promise<void> {
    await this.alertCrossed(ctx);
  }

  /** Fires the alerts of the matching budgets whose warn threshold or cap was crossed; from the snapshot (12.6). */
  private async alertCrossed(ctx: BudgetCheckContext & { executionId: string }): Promise<void> {
    const matching = matchBudgets(await this.enabledBudgets(), ctx);
    for (const budget of matching) {
      const periodStart = currentPeriodStart(budget.period);
      const current = await this.currentUsage(budget, ctx, periodStart);
      if (current >= budget.limitValue) {
        await this.maybeFireAlert(budget, periodStart, "block", current, ctx);
      } else if (current >= budget.limitValue * budget.warnThresholdPct) {
        await this.maybeFireAlert(budget, periodStart, "warn", current, ctx);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async matchingBudgets(ctx: BudgetCheckContext): Promise<BudgetRecord[]> {
    return matchBudgets(await this.store.listBudgets({ enabledOnly: true }), ctx);
  }

  private async currentUsage(budget: BudgetRecord, ctx: BudgetCheckContext, periodStart: string): Promise<number> {
    const periodEnd = currentPeriodEnd(budget.period);
    const filter: Parameters<Store["queryBudgetUsage"]>[0] = { from: periodStart, to: periodEnd };
    if (budget.scopeType === "project" && budget.scopeId) filter.projectId = budget.scopeId;
    else if (budget.scopeType === "workflow" && budget.scopeId) filter.workflowId = budget.scopeId;
    else if (budget.scopeType === "user") {
      // Match the configured scope_id against either user_id or user_email
      // — both identify "the user" depending on how the execution was triggered.
      const userKey = budget.scopeId ?? ctx.userId ?? ctx.userEmail;
      if (userKey) filter.userKey = userKey;
    } else if (budget.scopeType === "mcp_client" && budget.scopeId) {
      // The name finds the client's runs recorded before v54 (`user_id = mcp-client:<name>`).
      filter.client = { id: budget.scopeId, name: ctx.client?.id === budget.scopeId ? ctx.client.name : "" };
    }
    const totals = await this.store.queryBudgetUsage(filter);
    return budget.limitType === "usd" ? totals.costUsd : totals.totalTokens;
  }

  private async maybeFireAlert(
    budget: BudgetRecord,
    periodStart: string,
    severity: "warn" | "block",
    usageValue: number,
    ctx: BudgetCheckContext & { executionId: string }
  ): Promise<void> {
    const existing = await this.store.getLatestBudgetAlert(budget.id, periodStart, severity);
    if (existing) return; // already fired this period
    const message = severity === "block"
      ? `Budget "${budget.name}" exceeded: ${formatUsage(usageValue, budget.limitType)} of ${formatUsage(budget.limitValue, budget.limitType)}`
      : `Budget "${budget.name}" at ${Math.round((usageValue / budget.limitValue) * 100)}%: ${formatUsage(usageValue, budget.limitType)} of ${formatUsage(budget.limitValue, budget.limitType)}`;
    const recorded = await this.store.recordBudgetAlert({
      id: `bal_${randomUUID()}`,
      budgetId: budget.id,
      periodStart,
      severity,
      usageValue,
      limitValue: budget.limitValue,
      workflowId: ctx.workflowId || null,
      executionId: ctx.executionId,
      message
    });
    // Another instance (or a concurrent run) recorded this window's alert between the check and the write.
    if (!recorded) return;
    this.logger?.warn("Budget threshold crossed", {
      budgetId: budget.id,
      severity,
      usageValue,
      limit: budget.limitValue,
      executionId: ctx.executionId
    });
    if (budget.notifyChannel) {
      void this.postWebhookAlert(budget, severity, usageValue, periodStart, ctx, message);
    }
  }

  /**
   * Fire-and-forget POST to a Slack/Discord/Teams-compatible webhook URL.
   * Per-budget; isolated from the global NotificationService's channel
   * configs so different budgets can route to different channels (e.g.
   * platform team vs product team) without sharing a global config.
   */
  private async postWebhookAlert(
    budget: BudgetRecord,
    severity: "warn" | "block",
    usageValue: number,
    periodStart: string,
    ctx: BudgetCheckContext & { executionId: string },
    message: string
  ): Promise<void> {
    if (!budget.notifyChannel) return;
    const icon = severity === "block" ? "\u{1F6A8}" : "⚠️";
    const text = `${icon} *Budget ${severity === "block" ? "exceeded" : "warning"}*\n` +
      `*Budget:* ${budget.name} (${budget.scopeType}${budget.scopeId ? `:${budget.scopeId}` : ""})\n` +
      `*Usage:* ${formatUsage(usageValue, budget.limitType)} / ${formatUsage(budget.limitValue, budget.limitType)}\n` +
      `*Period:* ${budget.period} starting ${periodStart}\n` +
      (ctx.workflowId ? `*Workflow:* ${ctx.workflowId}\n` : "") +
      (ctx.client ? `*MCP client:* ${ctx.client.name}\n` : "") +
      `*Execution:* ${ctx.executionId}`;
    try {
      await fetch(budget.notifyChannel, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, message })
      });
    } catch (err) {
      this.logger?.warn("Budget alert webhook failed", {
        error: err instanceof Error ? err.message : String(err),
        budgetId: budget.id
      });
    }
  }
}

/** The enabled budgets that apply to a run or gateway call. */
function matchBudgets(budgets: BudgetRecord[], ctx: BudgetCheckContext): BudgetRecord[] {
  return budgets.filter((b) => {
    if (!b.enabled) return false;
    if (b.scopeType === "global") return true;
    if (b.scopeType === "project") {
      if (!b.scopeId) return false;
      return b.scopeId === ctx.projectId || b.scopeId === (ctx.toolsetProjectId ?? null);
    }
    if (b.scopeType === "workflow") return ctx.workflowId !== null && b.scopeId === ctx.workflowId;
    if (b.scopeType === "user") {
      if (!b.scopeId) return false;
      return b.scopeId === ctx.userEmail || b.scopeId === ctx.userId;
    }
    if (b.scopeType === "mcp_client") return Boolean(ctx.client) && b.scopeId === ctx.client!.id;
    return false;
  });
}

function currentPeriodStart(period: "day" | "week" | "month"): string {
  const now = new Date();
  if (period === "day") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString();
  }
  if (period === "week") {
    // ISO week: Monday is day 1. JS getUTCDay returns 0=Sunday..6=Saturday.
    const day = now.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday));
    return d.toISOString();
  }
  // month
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function currentPeriodEnd(period: "day" | "week" | "month"): string {
  const now = new Date();
  if (period === "day") {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return d.toISOString();
  }
  if (period === "week") {
    const day = now.getUTCDay();
    const daysFromMonday = (day + 6) % 7;
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday + 7));
    return d.toISOString();
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function formatUsage(value: number, limitType: "usd" | "tokens"): string {
  if (limitType === "usd") return `$${value.toFixed(2)}`;
  if (value < 1000) return `${value} tokens`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k tokens`;
  return `${(value / 1_000_000).toFixed(2)}M tokens`;
}

// Exported for tests.
export const __test__ = { currentPeriodStart, currentPeriodEnd, formatUsage };
