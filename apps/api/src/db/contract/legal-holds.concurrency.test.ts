/**
 * 13.3 — a legal hold placed while a purge is under way, on Postgres (two connections). Placing a hold takes the
 * legal-hold advisory lock exclusively; every purge batch takes it shared before it reads. So the placement waits for
 * the batch under way, and every batch after it sees the hold: no held row is deleted. Skipped without
 * TEST_POSTGRES_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { retentionRowSql as insert } from "../../test-support/retention-rows.js";
import { LEGAL_HOLD_LOCK_SHARED_SQL } from "../legal-hold-sql.js";

const enabled = Boolean(testPostgresUrl());
if (!enabled) noticePostgresSkipped("legal hold concurrency");

const OLD = "2001-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";

/** Resolves once a session waits for the legal-hold advisory lock (pg_locks shows a lock not granted). */
async function untilAdvisoryWaiter(pool: Pool, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0];
    if (Number(row?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No ${count} session(s) waited for the legal-hold lock`);
}

describe.skipIf(!enabled)("legal holds against a purge under way (Postgres)", () => {
  let test: TestStore;
  let pool: Pool;
  let batch: PoolClient | null = null;

  beforeEach(async () => {
    test = await createTestStore({ kind: "postgres" });
    pool = testStorePool(test, { max: 4 });
  }, 60_000);

  afterEach(async () => {
    if (batch) {
      await batch.query("ROLLBACK").catch(() => undefined);
      batch.release();
      batch = null;
    }
    await pool?.end().catch(() => undefined);
    await test?.cleanup();
  }, 60_000);

  it("a hold placed during a purge batch waits for it; the purge's next batch keeps every held row", async () => {
    const store = test.store;
    const sql = testSql(store);
    await store.upsertProject({ id: "proj", name: "Held" });
    await store.upsertWorkflow({ id: "wf", name: "W", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "proj" } as never);
    for (let index = 0; index < 30; index += 1) {
      await sql.run(insert("execution_history", `held-${index}`, OLD));
      await sql.run(insert("execution_history", `free-${index}`, OLD));
      await sql.run(`UPDATE execution_history SET workflow_id = 'wf-free' WHERE id = ?`, `free-${index}`);
    }

    // A purge batch under way: it holds the lock shared, as each batch does.
    batch = await pool.connect();
    await batch.query("BEGIN");
    await batch.query(LEGAL_HOLD_LOCK_SHARED_SQL);

    let placed = false;
    const placing = store
      .placeLegalHold({
        id: "h1", name: "Matter", reason: "Litigation", matterRef: null, scopeType: "project", scopeId: "proj", endsAt: null,
        createdBy: "admin", createdAt: new Date().toISOString(), items: []
      })
      .then((hold) => {
        placed = true;
        return hold;
      });
    await untilAdvisoryWaiter(pool, 1);
    expect(placed).toBe(false);

    // The purge's next batch queues behind the waiting placement (it cannot jump the exclusive request).
    const purging = store.pruneRetentionTable("execution_history", { before: CUT, limit: 1000 });
    await untilAdvisoryWaiter(pool, 2);

    await batch.query("COMMIT");
    batch.release();
    batch = null;
    expect((await placing).status).toBe("active");
    expect(await purging).toBe(30);
    const left = (await sql.all<{ id: string }>(`SELECT id FROM execution_history ORDER BY id`)).map((row) => row.id);
    expect(left).toHaveLength(30);
    expect(left.every((id) => id.startsWith("held-"))).toBe(true);
  }, 60_000);

  it("a workflow delete under way finishes before a hold on it is placed; one started after the hold is refused", async () => {
    const store = test.store;
    await store.upsertWorkflow({ id: "wf-a", name: "A", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    await store.upsertWorkflow({ id: "wf-b", name: "B", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    batch = await pool.connect();
    await batch.query("BEGIN");
    await batch.query(LEGAL_HOLD_LOCK_SHARED_SQL);
    const placing = store.placeLegalHold({
      id: "h2", name: "B hold", reason: "r", matterRef: null, scopeType: "workflow", scopeId: "wf-b", endsAt: null, createdBy: null,
      createdAt: new Date().toISOString(), items: []
    });
    await untilAdvisoryWaiter(pool, 1);
    const deleting = store.deleteWorkflow("wf-b").then(
      () => "deleted",
      (error: unknown) => (error as { code?: string }).code ?? String(error)
    );
    await untilAdvisoryWaiter(pool, 2);
    await batch.query("COMMIT");
    batch.release();
    batch = null;
    await placing;
    expect(await deleting).toBe("legal_hold");
    expect(await store.getWorkflow("wf-b")).not.toBeNull();
    expect(await store.deleteWorkflow("wf-a")).toBe(true);
  }, 60_000);
});
