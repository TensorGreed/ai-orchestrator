import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "./db/database.js";
import { UsageService } from "./services/usage-service.js";
import { BudgetService, __test__ } from "./services/budget-service.js";

describe("Phase 8.3 — budget caps + alerts", () => {
  let tempDir: string;
  let store: SqliteStore;
  let usage: UsageService;
  let budgets: BudgetService;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-phase8-3-"));
    store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
    store.ensureDefaultProject();
    usage = new UsageService(store);
    budgets = new BudgetService(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seedExecution(workflowId: string, tokens: number, userId?: string): void {
    usage.recordExecution({
      executionId: `exec_${Math.random()}`,
      workflowId,
      workflowName: workflowId,
      userId: userId ?? "user_alice",
      projectId: "proj_default",
      triggerType: "manual",
      status: "success",
      durationMs: 1000,
      nodeResults: {
        x: { _telemetry: { providerId: "openai", model: "gpt-4o", usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens } } }
      }
    });
  }

  describe("period boundaries", () => {
    it("day period starts at UTC midnight today", () => {
      const start = __test__.currentPeriodStart("day");
      expect(start.endsWith("T00:00:00.000Z")).toBe(true);
    });

    it("week period starts on Monday 00:00 UTC", () => {
      const start = __test__.currentPeriodStart("week");
      expect(new Date(start).getUTCDay()).toBe(1); // Monday
    });

    it("month period starts on the 1st 00:00 UTC", () => {
      const start = __test__.currentPeriodStart("month");
      expect(new Date(start).getUTCDate()).toBe(1);
    });

    it("end is strictly after start", () => {
      for (const p of ["day", "week", "month"] as const) {
        const start = __test__.currentPeriodStart(p);
        const end = __test__.currentPeriodEnd(p);
        expect(new Date(end).getTime()).toBeGreaterThan(new Date(start).getTime());
      }
    });
  });

  describe("checkExecution — block action", () => {
    it("rejects when current usage already meets the cap", () => {
      // Cap: $0.001 (1/10 of a cent)
      store.createBudget({
        id: "bgt_1",
        name: "Tight workflow cap",
        scopeType: "workflow",
        scopeId: "wf_a",
        period: "month",
        limitType: "usd",
        limitValue: 0.001,
        action: "block"
      });
      // gpt-4o: $2.5/1M input → 1000 tokens = $0.0025, well over the cap
      seedExecution("wf_a", 1000);

      const result = budgets.checkExecution({ workflowId: "wf_a", projectId: "proj_default", userEmail: null, userId: "user_alice" });
      expect(result.allowed).toBe(false);
      expect(result.blocked?.budget.id).toBe("bgt_1");
      expect(result.blocked!.current).toBeGreaterThanOrEqual(0.001);
    });

    it("allows when usage is below the cap", () => {
      store.createBudget({
        id: "bgt_2",
        name: "Generous cap",
        scopeType: "workflow",
        scopeId: "wf_b",
        period: "month",
        limitType: "tokens",
        limitValue: 1_000_000,
        action: "block"
      });
      seedExecution("wf_b", 1000);
      const result = budgets.checkExecution({ workflowId: "wf_b", projectId: "proj_default", userEmail: null, userId: "user_alice" });
      expect(result.allowed).toBe(true);
    });

    it("ignores budgets that don't match scope", () => {
      store.createBudget({
        id: "bgt_3",
        name: "Other workflow cap",
        scopeType: "workflow",
        scopeId: "wf_other",
        period: "month",
        limitType: "tokens",
        limitValue: 100,
        action: "block"
      });
      seedExecution("wf_other", 200);
      const result = budgets.checkExecution({ workflowId: "wf_unrelated", projectId: "proj_default", userEmail: null, userId: "user_alice" });
      expect(result.allowed).toBe(true);
    });

    it("warn-action budgets never block, only show approachingLimit", () => {
      store.createBudget({
        id: "bgt_4",
        name: "Warn-only",
        scopeType: "global",
        period: "month",
        limitType: "tokens",
        limitValue: 1000,
        warnThresholdPct: 0.5,
        action: "warn"
      });
      seedExecution("wf_x", 600); // 60% — past warn threshold
      const result = budgets.checkExecution({ workflowId: "wf_x", projectId: "proj_default", userEmail: null, userId: "user_alice" });
      expect(result.allowed).toBe(true);
      expect(result.approachingLimit).toHaveLength(1);
      expect(result.approachingLimit[0]!.pct).toBeCloseTo(0.6, 2);
    });

    it("matches user-scope budgets by email or userId", () => {
      store.createBudget({
        id: "bgt_5",
        name: "Per-user cap (email)",
        scopeType: "user",
        scopeId: "alice@example.com",
        period: "day",
        limitType: "tokens",
        limitValue: 100,
        action: "block"
      });
      // emit a usage event for user_alice (the recordExecution sets user_id = "user_alice")
      usage.recordExecution({
        executionId: "exec_e",
        workflowId: "wf_y",
        userEmail: "alice@example.com",
        projectId: null,
        triggerType: "manual",
        status: "success",
        durationMs: 500,
        nodeResults: {
          x: { _telemetry: { providerId: "openai", model: "gpt-4o", usage: { inputTokens: 200, outputTokens: 0, totalTokens: 200 } } }
        }
      });
      const result = budgets.checkExecution({ workflowId: "wf_y", projectId: null, userEmail: "alice@example.com", userId: null });
      expect(result.allowed).toBe(false);
    });
  });

  describe("recordExecution — alert firing & debouncing", () => {
    it("fires a single warn alert per period (debounced)", () => {
      store.createBudget({
        id: "bgt_d",
        name: "debounce test",
        scopeType: "workflow",
        scopeId: "wf_d",
        period: "month",
        limitType: "tokens",
        limitValue: 1000,
        warnThresholdPct: 0.5,
        action: "warn"
      });

      // Fire 3 executions, each adding 250 tokens. After the 2nd we cross 50%.
      for (let i = 0; i < 3; i++) {
        seedExecution("wf_d", 250);
        budgets.recordExecution({
          executionId: `e${i}`,
          workflowId: "wf_d",
          projectId: "proj_default",
          userEmail: null,
          userId: "user_alice",
          spentUsd: 0,
          spentTokens: 250
        });
      }

      const alerts = store.listBudgetAlerts({ budgetId: "bgt_d" });
      // Only one warn alert per period — debounced
      expect(alerts.filter((a) => a.severity === "warn")).toHaveLength(1);
    });

    it("escalates from warn to block as usage crosses the cap", () => {
      store.createBudget({
        id: "bgt_e",
        name: "escalate",
        scopeType: "workflow",
        scopeId: "wf_e",
        period: "month",
        limitType: "tokens",
        limitValue: 1000,
        warnThresholdPct: 0.5,
        action: "block"
      });

      // 600 tokens (warn threshold)
      seedExecution("wf_e", 600);
      budgets.recordExecution({ executionId: "e1", workflowId: "wf_e", projectId: "proj_default", userEmail: null, userId: "user_alice", spentUsd: 0, spentTokens: 600 });

      // 500 more (1100 → over cap)
      seedExecution("wf_e", 500);
      budgets.recordExecution({ executionId: "e2", workflowId: "wf_e", projectId: "proj_default", userEmail: null, userId: "user_alice", spentUsd: 0, spentTokens: 500 });

      const alerts = store.listBudgetAlerts({ budgetId: "bgt_e" });
      const severities = alerts.map((a) => a.severity).sort();
      expect(severities).toContain("warn");
      expect(severities).toContain("block");
    });

    it("does not fire when usage stays below warn threshold", () => {
      store.createBudget({
        id: "bgt_q",
        name: "quiet",
        scopeType: "global",
        period: "month",
        limitType: "tokens",
        limitValue: 1000,
        warnThresholdPct: 0.8,
        action: "warn"
      });
      seedExecution("wf_q", 100);
      budgets.recordExecution({ executionId: "eq", workflowId: "wf_q", projectId: "proj_default", userEmail: null, userId: "user_alice", spentUsd: 0, spentTokens: 100 });
      expect(store.listBudgetAlerts({ budgetId: "bgt_q" })).toHaveLength(0);
    });
  });

  describe("CRUD", () => {
    it("createBudget + listBudgets + updateBudget + deleteBudget round-trip", () => {
      store.createBudget({
        id: "b1",
        name: "Test",
        scopeType: "global",
        period: "day",
        limitType: "usd",
        limitValue: 50,
        action: "warn"
      });
      let list = store.listBudgets();
      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe("Test");

      store.updateBudget("b1", { name: "Renamed", limitValue: 75, enabled: false });
      const updated = store.getBudget("b1")!;
      expect(updated.name).toBe("Renamed");
      expect(updated.limitValue).toBe(75);
      expect(updated.enabled).toBe(false);

      store.deleteBudget("b1");
      list = store.listBudgets();
      expect(list).toHaveLength(0);
    });

    it("listBudgets({ enabledOnly: true }) hides disabled budgets", () => {
      store.createBudget({ id: "on", name: "on", scopeType: "global", period: "day", limitType: "usd", limitValue: 1, action: "warn", enabled: true });
      store.createBudget({ id: "off", name: "off", scopeType: "global", period: "day", limitType: "usd", limitValue: 1, action: "warn", enabled: false });
      const enabled = store.listBudgets({ enabledOnly: true });
      expect(enabled.map((b) => b.id)).toEqual(["on"]);
    });
  });
});
