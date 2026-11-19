/**
 * v80 — upgrading a database with runs to `execution_history.triggered_by_user_id`: the column is added at once and the
 * runs already there are filled in afterwards by the background fill (services/execution-starter-fill-service.ts), in
 * batches that each save how far they got: the account with that user id, or with that email in any case when the
 * account was created before the run; else nobody. A deleted account's email, an email given to a new account and a
 * later rename bring no runs to anybody. Until the fill reaches a run it is nobody's own; a run recorded after the
 * upgrade is never touched by it. The fill resumes after an interruption without visiting a run twice, and only one
 * instance runs it at a time. v80 down drops only the column (and the fill's markers). SQLite always; Postgres when
 * TEST_POSTGRES_URL is set.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteStore } from "./database.js";
import { MIGRATIONS, rollbackMigrations, runMigrations } from "./migrations.js";
import { createStore, postgresStoreConfig } from "./create-store.js";
import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";
import { ExecutionStarterFillService } from "../services/execution-starter-fill-service.js";
import { STARTER_FILL_AFTER_PREFIX, STARTER_FILL_DONE_MARKER, STARTER_FILL_UPTO_PREFIX } from "./execution-starter-fill.js";
import { testSql } from "../test-support/test-sql.js";
import { dropTestSchema, randomTestSchema, testPostgresPool, testPostgresSettings, testPostgresUrl } from "../test-support/test-store.js";

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

let tempDir = "";

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v80-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** More runs than two fill batches (5000 each here), all Ana's. */
const BULK = 12_001;

/** Runs a statement with `?` placeholders on the store's database. */
type RawSql = (sql: string, params?: unknown[]) => Promise<void>;

const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}T00:00:00.000Z`;

async function seed(store: Store, raw: RawSql): Promise<void> {
  await store.ensureDefaultProject();
  await store.upsertWorkflow({ id: "wf-keep", name: "Workflow wf-keep", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
  for (const [id, email] of [["usr_ana", "ana@example.com"], ["usr_rae", "rae.old@example.com"], ["usr_gone", "gone@example.com"], ["usr_reused_old", "reused@example.com"]]) {
    await store.saveUser({ id: id!, email: email!, passwordHash: "x", role: "operator" });
    await raw(`UPDATE users SET created_at = ? WHERE id = ?`, [day(1), id]);
  }
  const run = async (id: string, triggeredBy: string | undefined, startedAt = day(5), triggerType = "manual") =>
    await store.saveExecutionHistory({ id, workflowId: "wf-keep", status: "success", startedAt, completedAt: startedAt, triggerType, ...(triggeredBy ? { triggeredBy } : {}) });
  const request = async (id: string, executionId: string, at: string, requestedBy: string | null, requestedByUserId: string | null) =>
    await raw(
      `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, message, requested_by, requested_by_user_id, decided_by, created_at, updated_at)
       VALUES (?, ?, 'wf-keep', 'default', 'gate', 'approval_gate', 'approved', '{}', 'Go on', CAST(? AS TEXT), CAST(? AS TEXT), 'rae.old@example.com', ?, ?)`,
      [id, executionId, requestedBy, requestedByUserId, at, at]
    );
  // Resumed by an older build after Rae approved: triggered_by became the approver's email. The first request names
  // the starter: Ana by user id, Ana by email only, or nobody (a webhook started it).
  await run("run-resumed", "rae.old@example.com", day(5), "approval_resume");
  await request("apr-1b", "run-resumed", day(7), "rae.old@example.com", "usr_rae");
  await request("apr-1a", "run-resumed", day(6), "ana@example.com", "usr_ana");
  await run("run-resumed-email", "rae.old@example.com", day(5), "approval_resume");
  await request("apr-2", "run-resumed-email", day(6), "ANA@example.com", null);
  await run("run-resumed-webhook", "rae.old@example.com", day(5), "approval_resume");
  await request("apr-3", "run-resumed-webhook", day(6), null, null);
  // Resumed with no request on record: nobody can be told.
  await run("run-resumed-norequest", "rae.old@example.com", day(5), "approval_resume");
  await run("run-ana", "ANA@example.com");
  await run("run-ana-id", "usr_ana");
  await run("run-rae", "rae.old@example.com");
  await run("run-gone", "gone@example.com");
  await run("run-reused", "reused@example.com");
  await run("run-before-account", "ana@example.com", "2026-10-01T00:00:00.000Z");
  await run("run-webhook", "webhook");
  await run("run-anon", undefined);
  // The account behind gone@ is deleted; reused@'s first account is deleted and the email given to a new one later.
  await store.deleteUser("usr_gone");
  await store.deleteUser("usr_reused_old");
  await store.saveUser({ id: "usr_reused_new", email: "reused@example.com", passwordHash: "x", role: "operator" });
  await raw(`UPDATE users SET created_at = ? WHERE id = ?`, [day(10), "usr_reused_new"]);
}

const own = async (store: Store, userId: string, email: string) =>
  (await store.listExecutionHistory({ workflowIds: [], ownRunsOnly: { workflowIds: ["wf-keep"], userId, email }, pageSize: 50 })).items.map((item) => item.id).sort();

const fillService = (store: Store, instanceId: string, extra: Partial<ConstructorParameters<typeof ExecutionStarterFillService>[0]> = {}) =>
  new ExecutionStarterFillService({ store, instanceId, isLeader: () => true, batchSize: 5000, pauseMs: 0, ...extra });

/**
 * Before the fill: nobody's runs, the fill to do. A first batch, then an interruption: progress is saved; a run the
 * batch visited and then lost its starter (reset by hand) is not visited again; a run written after the upgrade that
 * names Ana by email only is never filled; a second instance (another id) finishes it.
 */
async function fillInterrupted(store: Store, raw: RawSql): Promise<void> {
  expect(await store.getExecutionStarter("run-ana")).toBeNull();
  expect(await own(store, "usr_ana", "ana@example.com")).toEqual([]);
  const before = await store.getExecutionStarterFill();
  expect(before.done).toBe(false);
  expect(before.after).toBe(0);
  expect(before.upTo).toBeGreaterThanOrEqual(BULK + 12);
  await store.saveExecutionHistory({ id: "run-after-upgrade", workflowId: "wf-keep", status: "success", startedAt: day(6), triggerType: "form", triggeredBy: "ana@example.com" });

  // Not the leader: nothing happens.
  expect(await fillService(store, "standby", { isLeader: () => false }).runOnce()).toEqual({ status: "skipped", why: "not_leader" });
  const batches: number[] = [];
  const first = await fillService(store, "instance-a", { afterBatch: (batch) => { batches.push(batch.transactionMs); return false; } }).runOnce();
  expect(first).toMatchObject({ status: "stopped", visited: 5000, batches: 1 });
  const midway = await store.getExecutionStarterFill();
  expect(midway.done).toBe(false);
  expect(midway.after).toBeGreaterThan(0);
  expect(await store.getExecutionStarter("run-ana")).toBe("usr_ana");
  expect(await store.getExecutionStarter("bulk-1")).toBe("usr_ana");
  await raw(`UPDATE execution_history SET triggered_by_user_id = NULL WHERE id = ?`, ["bulk-1"]);

  const rest = await fillService(store, "instance-b").runOnce();
  expect(rest).toMatchObject({ status: "done", visited: BULK + 12 - 5000, batches: 2 });
  expect(await store.getExecutionStarterFill()).toEqual({ done: true, upTo: null, after: 0 });
  expect(await store.getSchemaMarker(STARTER_FILL_DONE_MARKER)).not.toBeNull();
  // Visited before the interruption: not judged again.
  expect(await store.getExecutionStarter("bulk-1")).toBeNull();
  await raw(`UPDATE execution_history SET triggered_by_user_id = ? WHERE id = ?`, ["usr_ana", "bulk-1"]);
  // Recorded after the upgrade: the run's own record stands.
  expect(await store.getExecutionStarter("run-after-upgrade")).toBeNull();
  // Done: another start does nothing.
  expect(await fillService(store, "instance-c").runOnce()).toMatchObject({ status: "done", visited: 0, batches: 0 });
}

/** Two instances at once: one takes the lease and fills every run; the other finds the lease held (or the fill done). */
async function fillRace(stores: [Store, Store], runs: number): Promise<void> {
  const outcomes = await Promise.all([fillService(stores[0], "node-1", { batchSize: 1000 }).runOnce(), fillService(stores[1], "node-2", { batchSize: 1000 }).runOnce()]);
  const visited = outcomes.map((outcome) => ("visited" in outcome ? outcome.visited : 0));
  expect(visited.filter((count) => count > 0)).toEqual([runs]);
  expect(outcomes.some((outcome) => outcome.status === "skipped" && outcome.why === "lease_held")).toBe(true);
  expect((await stores[0].getExecutionStarterFill()).done).toBe(true);
}

async function expectUpgraded(store: Store, raw: RawSql): Promise<void> {
  expect((await store.getExecutionHistory("run-ana"))?.status).toBe("success");
  expect((await store.getExecutionHistory("run-ana"))?.triggeredBy).toBe("ANA@example.com");
  // By email in any case, or by user id, for an account created before the run.
  expect(await store.getExecutionStarter("run-ana")).toBe("usr_ana");
  expect(await store.getExecutionStarter("run-ana-id")).toBe("usr_ana");
  expect(await store.getExecutionStarter("run-rae")).toBe("usr_rae");
  // A run resumed by an older build is its first request's requester's, never the approver's.
  expect(await store.getExecutionStarter("run-resumed")).toBe("usr_ana");
  expect(await store.getExecutionStarter("run-resumed-email")).toBe("usr_ana");
  expect(await store.getExecutionStarter("bulk-0")).toBe("usr_ana");
  expect(await store.getExecutionStarter(`bulk-${BULK - 1}`)).toBe("usr_ana");
  // Nobody: a deleted account's email, an email whose account came after the run, a run before the account, no person.
  for (const id of ["run-gone", "run-reused", "run-before-account", "run-webhook", "run-anon", "run-resumed-webhook", "run-resumed-norequest"]) {
    expect(await store.getExecutionStarter(id), id).toBeNull();
  }
  expect(await own(store, "usr_reused_new", "reused@example.com")).toEqual([]);
  expect(await own(store, "usr_rae", "rae.old@example.com")).toEqual(["run-rae"]);
  // Rae is renamed and the old email goes to a new account: the run stays Rae's.
  await raw(`UPDATE users SET email = ? WHERE id = ?`, ["rae@example.com", "usr_rae"]);
  await store.saveUser({ id: "usr_rae_new", email: "rae.old@example.com", passwordHash: "x", role: "operator" });
  await raw(`UPDATE users SET created_at = ? WHERE id = ?`, [day(1), "usr_rae_new"]);
  expect(await own(store, "usr_rae", "rae@example.com")).toEqual(["run-rae"]);
  expect(await own(store, "usr_rae_new", "rae.old@example.com")).toEqual([]);
  // A run written after records its starter, kept by later writes.
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf-keep", status: "running", startedAt: "2026-11-20T00:00:00.000Z", triggeredBy: "ana@example.com", triggeredByUserId: "usr_ana" });
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf-keep", status: "success", startedAt: "2026-11-20T00:00:00.000Z", triggeredBy: "bo@example.com" });
  expect(await store.getExecutionStarter("run-new")).toBe("usr_ana");
}

describe("v80 on SQLite", () => {
  it("a database with runs and no triggered_by_user_id column gains it in place", async () => {
    const file = path.join(tempDir, "v79.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh, async (sql, params = []) => {
      await testSql(fresh).run(sql, ...params);
    });
    await fresh.close();

    // As a v79 database: no column, no backfill marker, and many runs.
    const db = new Database(file);
    db.exec(`ALTER TABLE execution_history DROP COLUMN triggered_by_user_id`);
    db.exec(`DELETE FROM schema_markers WHERE name = 'execution_starter_backfill'`);
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) SELECT 'bulk-' || i, 'wf-keep', 'success', ?, 'ana@example.com' FROM n`
    ).run(BULK - 1, day(6));
    expect((db.prepare(`PRAGMA table_info(execution_history)`).all() as Array<{ name: string }>).some((column) => column.name === "triggered_by_user_id")).toBe(false);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      const raw: RawSql = async (sql, params = []) => {
        await testSql(store).run(sql, ...params);
      };
      await fillInterrupted(store, raw);
      await expectUpgraded(store, raw);
      expect(await store.getSchemaMarker("execution_starter_backfill")).not.toBeNull();
    } finally {
      await store.close();
    }
  });

  it("a fresh database has nothing to fill; an upgraded one is filled by one of two instances at once", async () => {
    const fresh = await createStore({ env: { DB_SQLITE_PATH: path.join(tempDir, "fresh.db") } });
    try {
      expect(await fresh.getExecutionStarterFill()).toEqual({ done: true, upTo: null, after: 0 });
    } finally {
      await fresh.close();
    }

    const file = path.join(tempDir, "race.db");
    const seeded = await SqliteStore.create(file);
    await seeded.close();
    const db = new Database(file);
    db.exec(`DELETE FROM schema_markers WHERE name = 'execution_starter_backfill'`);
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
       INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) SELECT 'race-' || i, 'wf-keep', 'success', ?, 'nobody@example.com' FROM n`
    ).run(day(6));
    db.close();
    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      expect((await store.getExecutionStarterFill()).upTo).toBe(5000);
      await fillRace([store, store], 5000);
    } finally {
      await store.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v80 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v79 schema with runs migrates on boot and is filled in the background; v80 down drops only the column", async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const run = async (sql: string) => {
      await pool.query(sql);
    };
    const current = () => chainVersion(pool);
    const setApplied = async (version: number) => {
      await pool.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]);
    };
    const setRolledBack = async (version: number) => {
      await pool.query(`DELETE FROM schema_migrations WHERE version > $1`, [version]);
    };
    const columnExists = async () =>
      (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'execution_history' AND column_name = 'triggered_by_user_id'`, [schema])).rows.length > 0;
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      const raw: RawSql = async (sql, params = []) => {
        let n = 0;
        await pool.query(sql.replace(/\?/g, () => `$${(n += 1)}`), params);
      };
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded, raw);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await chainVersion(pool)).toBe(79);
      expect(await columnExists()).toBe(false);
      await pool.query(
        `INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by)
         SELECT 'bulk-' || i, 'wf-keep', 'success', $1::timestamptz, 'ana@example.com' FROM generate_series(0, $2::int) AS i`,
        [day(6), BULK - 1]
      );

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await columnExists()).toBe(true);
        await fillInterrupted(store, raw);
        await expectUpgraded(store, raw);
      } finally {
        await store.close();
      }

      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await columnExists()).toBe(false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM execution_history`)).rows[0].n).toBe(BULK + 14);
      expect((await pool.query(`SELECT name FROM schema_markers WHERE name LIKE 'execution_starter%'`)).rows).toEqual([]);

      // Upgraded again by two instances at once: one fills every run, the other finds the lease held.
      const first = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      const second = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        const marker = (await pool.query<{ name: string }>(`SELECT name FROM schema_markers WHERE name LIKE $1`, [`${STARTER_FILL_UPTO_PREFIX}%`])).rows;
        expect(marker).toHaveLength(1);
        await fillRace([first, second], BULK + 14);
        expect(await first.getExecutionStarter("run-ana")).toBe("usr_ana");
        expect((await pool.query(`SELECT name FROM schema_markers WHERE left(name, length($1)) = $1`, [STARTER_FILL_AFTER_PREFIX])).rows).toEqual([]);
      } finally {
        await first.close();
        await second.close();
      }

      // Once more, with two runners' batches interleaved and no lease at all: they take turns, so each run is visited once.
      await rollbackMigrations(run, current, setRolledBack, 79);
      const third = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      const fourth = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        const loop = async (store: Store) => {
          let visited = 0;
          for (;;) {
            const batch = await store.fillExecutionStarters(700);
            if (batch.done) return visited;
            visited += batch.visited;
          }
        };
        const counts = await Promise.all([loop(third), loop(fourth)]);
        expect(counts[0]! + counts[1]!).toBe(BULK + 14);
        expect((await third.getExecutionStarterFill()).done).toBe(true);
        expect(await third.getExecutionStarter("run-ana")).toBe("usr_ana");
      } finally {
        await third.close();
        await fourth.close();
      }
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
