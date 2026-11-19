/**
 * v81 — upgrading a database with workflows, users, variables and shares to stored OpenAPI specs: the table and its
 * index are added, the existing rows are untouched, specs save and list right after, and deleting a project removes
 * its specs. v81 down drops only the new table. SQLite always; Postgres when TEST_POSTGRES_URL is set.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v81-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function workflow(id: string) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never;
}

const catalog = {
  title: "Tickets",
  version: "1",
  baseUrl: "https://tickets.example.com",
  operations: [{ id: "listTickets", method: "GET" as const, path: "/tickets", summary: "List", tags: [], deprecated: false, parameters: [], auth: null }],
  warnings: []
};

async function seed(store: Store): Promise<void> {
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "p2", name: "Two" });
  await store.upsertWorkflow(workflow("wf-keep"));
  await store.saveUser({ id: "u1", email: "ana@example.com", passwordHash: "x", role: "operator" });
  await store.upsertWorkflowShare({ workflowId: "wf-keep", projectId: "p2", accessLevel: "execute" });
  await store.upsertVariable({ id: "var1", projectId: "p2", key: "region", value: "eu", createdBy: "u1" });
}

async function expectUpgraded(store: Store): Promise<void> {
  expect((await store.getWorkflow("wf-keep"))?.name).toBe("Workflow wf-keep");
  expect((await store.getUserById("u1"))?.email).toBe("ana@example.com");
  expect((await store.listWorkflowShares("wf-keep")).map((share) => [share.projectId, share.accessLevel])).toEqual([["p2", "execute"]]);
  expect((await store.getVariable("var1"))?.value).toBe("eu");
  expect(await store.listOpenApiSpecs()).toEqual([]);
  const saved = await store.saveOpenApiSpec({
    id: "oas_1",
    projectId: "p2",
    name: "Tickets",
    sourceUrl: null,
    baseUrl: catalog.baseUrl,
    specText: '{"openapi":"3.0.0"}',
    catalog,
    createdBy: "ana@example.com"
  });
  expect(saved).toMatchObject({ id: "oas_1", projectId: "p2", name: "Tickets", operationCount: 1, sourceUrl: null });
  expect(saved.catalog.operations[0]?.id).toBe("listTickets");
  // A second save replaces the spec, keeping its project and creator.
  await store.saveOpenApiSpec({ ...saved, projectId: "other", name: "Tickets v2", specText: "{}", sourceUrl: "https://x.example.com/s.json", createdBy: "bob@example.com", catalog: { ...catalog, operations: [] } });
  expect(await store.listOpenApiSpecs("p2")).toMatchObject([{ id: "oas_1", name: "Tickets v2", operationCount: 0, projectId: "p2", createdBy: "ana@example.com" }]);
  expect(await store.getOpenApiSpecText("oas_1")).toBe("{}");
  expect(await store.listOpenApiSpecs("default")).toEqual([]);
  // A project goes with its specs (and its variables), once it holds no workflows.
  await store.upsertProject({ id: "p3", name: "Three" });
  await store.saveOpenApiSpec({ ...saved, id: "oas_3", projectId: "p3", specText: "{}" });
  expect(await store.deleteProject("p3")).toBe(true);
  expect(await store.getOpenApiSpec("oas_3")).toBeNull();
  expect(await store.deleteOpenApiSpec("oas_1")).toBe(true);
  expect(await store.deleteOpenApiSpec("oas_1")).toBe(false);
}

describe("v81 on SQLite", () => {
  it("a v79 database with data gains the OpenAPI spec table in place", async () => {
    const file = path.join(tempDir, "v79.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh);
    await fresh.close();

    const db = new Database(file);
    db.exec(`DROP TABLE openapi_specs`);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      await expectUpgraded(store);
    } finally {
      await store.close();
    }
    const after = new Database(file, { readonly: true });
    try {
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_openapi_specs_project'`).get()).toBeTruthy();
    } finally {
      after.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v81 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v79 schema with data migrates on boot; v81 down drops only the new table", async () => {
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
      (await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'openapi_specs'`, [schema])).rows.length > 0;
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await chainVersion(pool)).toBe(79);
      expect(await tableExists()).toBe(false);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await tableExists()).toBe(true);
        await expectUpgraded(store);
      } finally {
        await store.close();
      }
      const index = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_openapi_specs_project'`, [schema]);
      expect(index.rows).toHaveLength(1);

      await rollbackMigrations(run, current, setRolledBack, 79);
      expect(await tableExists()).toBe(false);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM workflow_shares`)).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM variables`)).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM workflows`)).rows[0].n).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
