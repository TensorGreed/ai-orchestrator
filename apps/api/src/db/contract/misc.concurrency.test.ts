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
  testPostgresSettings,
  testPostgresUrl,
  type TestStore
} from "../../test-support/test-store.js";
import { applyPendingSeqColumns } from "../../test-support/pending-seq.js";

const enabled = Boolean(testPostgresUrl());
if (!enabled) noticePostgresSkipped("misc concurrency (leases, budget alerts)");

describe.skipIf(!enabled)("Postgres concurrency: leases and budget alerts (two stores, one database)", () => {
  let first: TestStore | undefined;
  let second: PostgresStore | undefined;
  let a: Store;
  let b: Store;

  beforeEach(async () => {
    first = await createTestStore({ kind: "postgres" });
    await applyPendingSeqColumns(first);
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
});
