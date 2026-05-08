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
import type { BudgetRecord, SqliteStore } from "../db/database.js";

export interface BudgetCheckContext {
  workflowId: string;
  projectId: string | null;
  userEmail: string | null;
  userId: string | null;
}

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
  private readonly store: SqliteStore;
  private logger?: { info: (msg: string, fields?: Record<string, unknown>) => void; warn: (msg: string, fields?: Record<string, unknown>) => void };

  constructor(store: SqliteStore) {
    this.store = store;
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
  checkExecution(ctx: BudgetCheckContext): BudgetCheckResult {
    const matching = this.matchingBudgets(ctx);
    const approaching: BudgetCheckResult["approachingLimit"] = [];
    for (const budget of matching) {
      const periodStart = currentPeriodStart(budget.period);
      const current = this.currentUsage(budget, ctx, periodStart);
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
  recordExecution(ctx: BudgetRecordContext): void {
    const matching = this.matchingBudgets(ctx);
    for (const budget of matching) {
      const periodStart = currentPeriodStart(budget.period);
      const current = this.currentUsage(budget, ctx, periodStart);
      if (current >= budget.limitValue) {
        this.maybeFireAlert(budget, periodStart, "block", current, ctx);
      } else if (current >= budget.limitValue * budget.warnThresholdPct) {
        this.maybeFireAlert(budget, periodStart, "warn", current, ctx);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private matchingBudgets(ctx: BudgetCheckContext): BudgetRecord[] {
    const all = this.store.listBudgets({ enabledOnly: true });
    return all.filter((b) => {
      if (b.scopeType === "global") return true;
      if (b.scopeType === "project") return ctx.projectId !== null && b.scopeId === ctx.projectId;
      if (b.scopeType === "workflow") return b.scopeId === ctx.workflowId;
      if (b.scopeType === "user") {
        if (!b.scopeId) return false;
        return b.scopeId === ctx.userEmail || b.scopeId === ctx.userId;
      }
      return false;
    });
  }

  private currentUsage(budget: BudgetRecord, ctx: BudgetCheckContext, periodStart: string): number {
    const periodEnd = currentPeriodEnd(budget.period);
    const filter: { from: string; to: string; workflowId?: string; userId?: string; userKey?: string; projectId?: string } = {
      from: periodStart,
      to: periodEnd
    };
    if (budget.scopeType === "project" && ctx.projectId) filter.projectId = ctx.projectId;
    else if (budget.scopeType === "workflow") filter.workflowId = ctx.workflowId;
    else if (budget.scopeType === "user") {
      // Match the configured scope_id against either user_id or user_email
      // — both identify "the user" depending on how the execution was triggered.
      filter.userKey = budget.scopeId ?? ctx.userId ?? ctx.userEmail ?? undefined;
    }
    const totals = this.store.queryUsageTotals(filter);
    return budget.limitType === "usd" ? totals.costUsd : totals.totalTokens;
  }

  private maybeFireAlert(
    budget: BudgetRecord,
    periodStart: string,
    severity: "warn" | "block",
    usageValue: number,
    ctx: BudgetRecordContext
  ): void {
    const existing = this.store.getLatestBudgetAlert(budget.id, periodStart, severity);
    if (existing) return; // already fired this period
    const message = severity === "block"
      ? `Budget "${budget.name}" exceeded: ${formatUsage(usageValue, budget.limitType)} of ${formatUsage(budget.limitValue, budget.limitType)}`
      : `Budget "${budget.name}" at ${Math.round((usageValue / budget.limitValue) * 100)}%: ${formatUsage(usageValue, budget.limitType)} of ${formatUsage(budget.limitValue, budget.limitType)}`;
    this.store.recordBudgetAlert({
      id: `bal_${randomUUID()}`,
      budgetId: budget.id,
      periodStart,
      severity,
      usageValue,
      limitValue: budget.limitValue,
      workflowId: ctx.workflowId,
      executionId: ctx.executionId,
      message
    });
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
    ctx: BudgetRecordContext,
    message: string
  ): Promise<void> {
    if (!budget.notifyChannel) return;
    const icon = severity === "block" ? "\u{1F6A8}" : "⚠️";
    const text = `${icon} *Budget ${severity === "block" ? "exceeded" : "warning"}*\n` +
      `*Budget:* ${budget.name} (${budget.scopeType}${budget.scopeId ? `:${budget.scopeId}` : ""})\n` +
      `*Usage:* ${formatUsage(usageValue, budget.limitType)} / ${formatUsage(budget.limitValue, budget.limitType)}\n` +
      `*Period:* ${budget.period} starting ${periodStart}\n` +
      `*Workflow:* ${ctx.workflowId}\n*Execution:* ${ctx.executionId}`;
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
