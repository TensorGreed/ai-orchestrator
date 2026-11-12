/**
 * 13.3 — a large first purge on SQLite keeps the event loop responsive: the store deletes in batches and yields between
 * them, so the timer keeps firing while the purge runs and no gap between timer turns comes close to the length of the
 * whole purge. (better-sqlite3 is synchronous: one unbatched DELETE held the loop for the whole purge, so the timer never
 * fired during it.) Both bounds are relative to the purge itself, so a single garbage-collection pause on a busy CI
 * runner can't fail the test, while removing the batching or the yield still does.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { createTestStore, type TestStore } from "../test-support/test-store.js";
import { resolveRetentionSettings } from "../config.js";
import { RetentionService } from "./retention-service.js";

const ROWS = 200_000;
const OLD = "2001-01-01T00:00:00.000Z";

describe("retention purge on SQLite under load", () => {
  let current: TestStore | undefined;
  afterEach(async () => {
    await current?.cleanup();
    current = undefined;
  });

  it("deletes 200 000 runs while a 10 ms timer keeps firing between batches", async () => {
    current = await createTestStore({ kind: "sqlite" });
    const store = current.store;
    const db = (store as unknown as { db: BetterSqlite3Database }).db;
    const insert = db.prepare(
      `INSERT INTO execution_history (id, workflow_id, status, started_at, input_json, output_json) VALUES (?, 'wf', 'success', ?, '{"q":"a question"}', '{"a":"an answer"}')`
    );
    db.transaction(() => {
      for (let i = 0; i < ROWS; i += 1) insert.run(`run-${i}`, OLD);
    })();

    const service = new RetentionService({
      store,
      settings: resolveRetentionSettings({ USAGE_EVENTS_RETENTION_DAYS: 0, RETENTION_MAX_ROWS_PER_TICK: ROWS }),
      executionHistoryDays: 30,
      evalRunDays: 0,
      intervalMs: 3_600_000,
      instanceId: "load",
      isLeader: () => true
    });

    let last = performance.now();
    let worstGap = 0;
    let fired = 0;
    let purgeMs = 0;
    let firedDuringPurge = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
      fired += 1;
    }, 10);
    try {
      last = performance.now();
      const startedAt = last;
      const result = await service.tick("manual");
      purgeMs = performance.now() - startedAt;
      firedDuringPurge = fired;
      expect(result.status === "ran" && result.run.counts.runs).toBe(ROWS);
      // One more timer turn, so a purge that blocked the loop up to its end is measured too (a synchronous DELETE
      // never lets the timer fire while it runs), and count the gap still open.
      await new Promise((resolve) => setTimeout(resolve, 30));
      worstGap = Math.max(worstGap, performance.now() - last);
    } finally {
      clearInterval(timer);
    }
    const left = db.prepare(`SELECT COUNT(*) AS n FROM execution_history`).get() as { n: number };
    expect(left.n).toBe(0);
    // 200 batches: batched with a yield, the timer fires many times during the purge and the worst gap is a small part
    // of it; unbatched or never yielding, the timer can't fire until the purge ends and that one gap is the whole purge.
    expect(firedDuringPurge).toBeGreaterThanOrEqual(20);
    expect(worstGap).toBeLessThan(Math.max(100, purgeMs / 2));
  }, 120_000);
});
