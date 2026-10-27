/**
 * Phase 13.1 — Postgres only: two stores (two pools) on one schema race for a leader lease and for a budget alert.
 * Exactly one holder wins a free or expired lease, and one alert is recorded per (budget, window, severity).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postgresStoreConfig } from "../create-store.js";
import { PostgresStore } from "../postgres-store.js";
import type { Store } from "../store.js";
import {
  createTestStore,
  noticePostgresSkipped,
  testPostgresPool,
  testPostgresSettings,
  testPostgresUrl,
  type TestStore
} from "../../test-support/test-store.js";

const enabled = Boolean(testPostgresUrl());
if (!enabled) noticePostgresSkipped("misc concurrency (leases, budget alerts)");

describe.skipIf(!enabled)("Postgres concurrency: leases and budget alerts (two stores, one database)", () => {
  let first: TestStore | undefined;
  let second: PostgresStore | undefined;
  let a: Store;
  let b: Store;

  beforeEach(async () => {
    first = await createTestStore({ kind: "postgres" });
    second = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema: first.schema!, maxConnections: 8 }));
    a = first.store;
    b = second;
  }, 60_000);

  afterEach(async () => {
    await second?.close().catch(() => undefined);
    second = undefined;
    await first?.cleanup();
    first = undefined;
  }, 60_000);

  it("a free lease raced by many holders on two stores has exactly one winner, every round", async () => {
    for (let round = 0; round < 20; round += 1) {
      const leaseName = `lease-${round}`;
      const attempts = Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? a : b).tryAcquireLease({ leaseName, holderId: `holder-${i}`, ttlMs: 60_000 })
      );
      const results = await Promise.all(attempts);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.indexOf(true);
      expect((await a.getLease(leaseName))?.holderId).toBe(`holder-${winner}`);
    }
  });

  it("an expired lease raced by many holders is taken over by exactly one", async () => {
    for (let round = 0; round < 10; round += 1) {
      const leaseName = `expired-${round}`;
      expect(await a.tryAcquireLease({ leaseName, holderId: "dead", ttlMs: 1 })).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).tryAcquireLease({ leaseName, holderId: `n-${i}`, ttlMs: 60_000 }))
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await b.getLease(leaseName))?.holderId).toBe(`n-${results.indexOf(true)}`);
    }
  });

  it("two stores recording the same budget window fire one alert; other windows and severities still fire", async () => {
    await a.createBudget({ id: "b1", name: "Cap", scopeType: "global", period: "month", limitType: "usd", limitValue: 10, action: "block" });
    const periodStart = "2026-10-01T00:00:00.000Z";
    for (let round = 0; round < 10; round += 1) {
      const window = `${periodStart}#${round}`;
      // Both stores pass BudgetService's "no alert yet" check, then both record.
      expect(await a.getLatestBudgetAlert("b1", window, "block")).toBeNull();
      expect(await b.getLatestBudgetAlert("b1", window, "block")).toBeNull();
      const recorded = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 === 0 ? a : b).recordBudgetAlert({ id: `al-${round}-${i}`, budgetId: "b1", periodStart: window, severity: "block", usageValue: 11, limitValue: 10 })
        )
      );
      const alerts = (await a.listBudgetAlerts({ budgetId: "b1", limit: 500 })).filter((alert) => alert.periodStart === window);
      expect(alerts).toHaveLength(1);
      expect(recorded.filter(Boolean)).toHaveLength(1);
    }
    await b.recordBudgetAlert({ id: "warn-1", budgetId: "b1", periodStart, severity: "warn", usageValue: 9, limitValue: 10 });
    await a.recordBudgetAlert({ id: "next-window", budgetId: "b1", periodStart: "2026-11-01T00:00:00.000Z", severity: "block", usageValue: 11, limitValue: 10 });
    expect((await a.getLatestBudgetAlert("b1", periodStart, "warn"))?.id).toBe("warn-1");
    expect((await b.getLatestBudgetAlert("b1", "2026-11-01T00:00:00.000Z", "block"))?.id).toBe("next-window");
  });

  it("alerts raced for a deleted budget record nothing (no orphans, no duplicates)", async () => {
    await a.createBudget({ id: "b-del", name: "Gone", scopeType: "global", period: "month", limitType: "usd", limitValue: 10, action: "warn" });
    await a.deleteBudget("b-del");
    const recorded = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).recordBudgetAlert({ id: `orphan-${i}`, budgetId: "b-del", periodStart: "p", severity: "warn", usageValue: 11, limitValue: 10 })
      )
    );
    expect(recorded.filter(Boolean)).toHaveLength(0);
    expect(await a.listBudgetAlerts({ budgetId: "b-del", limit: 500 })).toEqual([]);
  });

  async function orphanAlerts(): Promise<number> {
    const pool = testPostgresPool(first!.schema!);
    try {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM budget_alerts al WHERE NOT EXISTS (SELECT 1 FROM budgets b WHERE b.id = al.budget_id)`
      );
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end();
    }
  }

  it("an alert that commits while deleteBudget waits is deleted with the budget (no orphan)", async () => {
    await a.createBudget({ id: "det", name: "Det", scopeType: "global", period: "month", limitType: "usd", limitValue: 1, action: "warn" });
    const pool = testPostgresPool(first!.schema!);
    const client = await pool.connect();
    try {
      // recordBudgetAlert's own steps on a raw connection: lock the budget, then insert the alert.
      await client.query("BEGIN");
      await client.query(`SELECT id FROM budgets WHERE id = $1 FOR UPDATE`, ["det"]);
      const deleting = b.deleteBudget("det");
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query(
        `INSERT INTO budget_alerts (id, budget_id, period_start, severity, usage_value, limit_value, fired_at)
         VALUES ('x', 'det', '2026-10-01T00:00:00.000Z', 'warn', 2, 1, now())`
      );
      await client.query("COMMIT");
      expect(await deleting).toBe(true);
    } finally {
      client.release();
      await pool.end();
    }
    expect(await a.getBudget("det")).toBeNull();
    expect(await orphanAlerts()).toBe(0);
  });

  it("alerts raced against deleteBudget on two stores never leave an orphan alert", async () => {
    for (let i = 0; i < 60; i += 1) {
      const id = `race-${i}`;
      await a.createBudget({ id, name: id, scopeType: "global", period: "month", limitType: "usd", limitValue: 1, action: "warn" });
      const [recorder, deleter] = i % 2 === 0 ? [a, b] : [b, a];
      await Promise.all([
        recorder.recordBudgetAlert({ id: `al-${i}`, budgetId: id, periodStart: "2026-10-01T00:00:00.000Z", severity: "warn", usageValue: 2, limitValue: 1 }),
        deleter.deleteBudget(id)
      ]);
      expect(await a.getBudget(id)).toBeNull();
    }
    expect(await orphanAlerts()).toBe(0);
  }, 60_000);
});
