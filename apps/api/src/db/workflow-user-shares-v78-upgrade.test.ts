/**
 * v78 — upgrading a database with workflows, users and project shares to per-workflow user shares: the table and its
 * index are added, the existing rows are untouched, and shares work right after. v78 down drops only the new table.
 * SQLite always; Postgres when TEST_POSTGRES_URL is set.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v78-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function workflow(id: string) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never;
}

async function seed(store: Store): Promise<void> {
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "p2", name: "Two" });
  await store.upsertWorkflow(workflow("wf-keep"));
  await store.saveUser({ id: "u1", email: "ana@example.com", passwordHash: "x", role: "operator" });
  await store.upsertWorkflowShare({ workflowId: "wf-keep", projectId: "p2", accessLevel: "execute" });
}

async function expectUpgraded(store: Store): Promise<void> {
  expect((await store.getWorkflow("wf-keep"))?.name).toBe("Workflow wf-keep");
  expect((await store.getUserById("u1"))?.email).toBe("ana@example.com");
  expect((await store.listWorkflowShares("wf-keep")).map((share) => [share.projectId, share.accessLevel])).toEqual([["p2", "execute"]]);
  expect(await store.listWorkflowUserShares("wf-keep")).toEqual([]);
  expect(await store.upsertWorkflowUserShare({ workflowId: "wf-keep", userId: "u1", accessLevel: "execute" })).toBe(true);
  expect(await store.listWorkflowsSharedToUser("u1")).toMatchObject([{ workflowId: "wf-keep", accessLevel: "execute" }]);
}

describe("v78 on SQLite", () => {
  it("a v77 database with data gains the user share table in place", async () => {
    const file = path.join(tempDir, "v77.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh);
    await fresh.close();

    const db = new Database(file);
    db.exec(`DROP TABLE workflow_user_shares`);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      await expectUpgraded(store);
    } finally {
      await store.close();
    }
    const after = new Database(file, { readonly: true });
    try {
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_workflow_user_shares_user_id'`).get()).toBeTruthy();
    } finally {
      after.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v78 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v77 schema with data migrates on boot; v78 down drops only the new table", async () => {
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
    const tableExists = async () =>
      (await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'workflow_user_shares'`, [schema])).rows.length > 0;
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 77);
      expect(await chainVersion(pool)).toBe(77);
      expect(await tableExists()).toBe(false);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await tableExists()).toBe(true);
        await expectUpgraded(store);
      } finally {
        await store.close();
      }
      const index = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_workflow_user_shares_user_id'`, [schema]);
      expect(index.rows).toHaveLength(1);

      await rollbackMigrations(run, current, setRolledBack, 77);
      expect(await tableExists()).toBe(false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM workflow_shares`)).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM workflows`)).rows[0].n).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
