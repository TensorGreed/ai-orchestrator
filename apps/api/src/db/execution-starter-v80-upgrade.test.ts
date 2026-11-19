/**
 * v80 — upgrading a database with runs to `execution_history.triggered_by_user_id`: the column is added, existing runs
 * record no starter (null, so they are judged by email for accounts older than the run), and a run written right after
 * records its starter, kept by later writes. v80 down drops only the column. SQLite always; Postgres when
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
import { dropTestSchema, randomTestSchema, testPostgresPool, testPostgresSettings, testPostgresUrl } from "../test-support/test-store.js";

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

let tempDir = "";

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v80-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function seed(store: Store): Promise<void> {
  await store.ensureDefaultProject();
  await store.upsertWorkflow({ id: "wf-keep", name: "Workflow wf-keep", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
  await store.saveExecutionHistory({ id: "run-old", workflowId: "wf-keep", status: "success", startedAt: "2026-11-01T00:00:00.000Z", completedAt: "2026-11-01T00:00:01.000Z", triggeredBy: "ana@example.com" });
}

async function expectUpgraded(store: Store): Promise<void> {
  expect((await store.getExecutionHistory("run-old"))?.status).toBe("success");
  expect((await store.getExecutionHistory("run-old"))?.triggeredBy).toBe("ana@example.com");
  expect(await store.getExecutionStarter("run-old")).toBeNull();
  // An older run stays the email's for an account created before it, not for a later one.
  const page = async (userCreatedAt: string) =>
    (await store.listExecutionHistory({ workflowIds: [], ownRunsOnly: { workflowIds: ["wf-keep"], userId: "usr_ana", email: "ana@example.com", userCreatedAt } })).total;
  expect(await page("2026-10-01T00:00:00.000Z")).toBe(1);
  expect(await page("2026-11-02T00:00:00.000Z")).toBe(0);
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf-keep", status: "running", startedAt: "2026-11-20T00:00:00.000Z", triggeredBy: "ana@example.com", triggeredByUserId: "usr_ana" });
  await store.saveExecutionHistory({ id: "run-new", workflowId: "wf-keep", status: "success", startedAt: "2026-11-20T00:00:00.000Z", triggeredBy: "bo@example.com" });
  expect(await store.getExecutionStarter("run-new")).toBe("usr_ana");
}

describe("v80 on SQLite", () => {
  it("a database with runs and no triggered_by_user_id column gains it in place", async () => {
    const file = path.join(tempDir, "v79.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh);
    await fresh.close();

    const db = new Database(file);
    db.exec(`ALTER TABLE execution_history DROP COLUMN triggered_by_user_id`);
    expect((db.prepare(`PRAGMA table_info(execution_history)`).all() as Array<{ name: string }>).some((column) => column.name === "triggered_by_user_id")).toBe(false);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      await expectUpgraded(store);
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

  it("a v79 schema with runs migrates on boot; v80 down drops only the column", async () => {
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
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await chainVersion(pool)).toBe(79);
      expect(await columnExists()).toBe(false);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await columnExists()).toBe(true);
        await expectUpgraded(store);
      } finally {
        await store.close();
      }

      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await columnExists()).toBe(false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM execution_history`)).rows[0].n).toBe(2);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
