/**
 * v79 — upgrading a database with runs to `execution_history.session_owner`: the column is added, existing runs read
 * as using the workflow's sessions (null), and a run's owner can be recorded right after. v79 down drops only the
 * column. SQLite always; Postgres when TEST_POSTGRES_URL is set.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v79-"));
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
  expect(await store.getExecutionSessionOwner("run-old")).toBeNull();
  await store.setExecutionSessionOwner("run-old", "usr_ana");
  expect(await store.getExecutionSessionOwner("run-old")).toBe("usr_ana");
  expect(await store.getExecutionSessionOwner("run-missing")).toBeNull();
}

describe("v79 on SQLite", () => {
  it("a database with runs and no session_owner column gains it in place", async () => {
    const file = path.join(tempDir, "v78.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh);
    await fresh.close();

    const db = new Database(file);
    db.exec(`ALTER TABLE execution_history DROP COLUMN session_owner`);
    expect((db.prepare(`PRAGMA table_info(execution_history)`).all() as Array<{ name: string }>).some((column) => column.name === "session_owner")).toBe(false);
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

describe.skipIf(!postgresUrl)("v79 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v78 schema with runs migrates on boot; v79 down drops only the column", async () => {
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
      (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'execution_history' AND column_name = 'session_owner'`, [schema])).rows.length > 0;
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 78);
      expect(await chainVersion(pool)).toBe(78);
      expect(await columnExists()).toBe(false);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await columnExists()).toBe(true);
        await expectUpgraded(store);
      } finally {
        await store.close();
      }

      await rollbackMigrations(run, current, setRolledBack, 78);
      expect(await columnExists()).toBe(false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM execution_history`)).rows[0].n).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
