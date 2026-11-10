/**
 * 13.3 — a large first purge on SQLite keeps the event loop responsive: the store deletes in batches and yields between
 * them, so a timer due during a purge of 200 000 runs fires within 100 ms. (better-sqlite3 is synchronous: one
 * unbatched DELETE held the loop for the whole purge.)
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

  it("deletes 200 000 runs while a 10 ms timer keeps firing within 100 ms", async () => {
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
    const timer = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 10);
    try {
      last = performance.now();
      const result = await service.tick("manual");
      expect(result.status === "ran" && result.run.counts.runs).toBe(ROWS);
    } finally {
      clearInterval(timer);
    }
    const left = db.prepare(`SELECT COUNT(*) AS n FROM execution_history`).get() as { n: number };
    expect(left.n).toBe(0);
    expect(worstGap).toBeLessThan(100);
  }, 120_000);
});
