/**
 * v82 — upgrading a database with workflows, users and secrets to connected accounts: the oauth_apps and
 * oauth_accounts tables and their indexes are added, existing rows are untouched, apps and accounts save and list
 * right after, an account's details go with its secret, and a project goes with its own apps and their client
 * secrets. v82 down drops only the new tables. SQLite always; Postgres when TEST_POSTGRES_URL is set.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v82-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const cipher = { iv: "aXY=", authTag: "dGFn", ciphertext: "Y3Q=" };

async function seed(store: Store): Promise<void> {
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "p2", name: "Two" });
  await store.upsertWorkflow({ id: "wf-keep", name: "Keep", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);
  await store.saveUser({ id: "u1", email: "ana@example.com", passwordHash: "x", role: "builder" });
  await store.saveSecret({ id: "sec_keep", name: "Keep", provider: "custom", projectId: "p2", source: "local", ...cipher });
}

async function expectUpgraded(store: Store): Promise<void> {
  expect((await store.getWorkflow("wf-keep"))?.name).toBe("Keep");
  expect((await store.getSecret("sec_keep"))?.name).toBe("Keep");
  expect(await store.listOAuthApps()).toEqual([]);
  const instance = await store.saveOAuthApp({ id: "slack:*", providerId: "slack", projectId: null, clientId: "c1", clientSecretId: "sec_c1", tenant: null, updatedBy: "ana@example.com" });
  expect(instance).toMatchObject({ id: "slack:*", projectId: null, clientId: "c1", clientSecretId: "sec_c1" });
  // A second save replaces the client id and keeps the creation time.
  const replaced = await store.saveOAuthApp({ ...instance, clientId: "c2" });
  expect(replaced).toMatchObject({ clientId: "c2", createdAt: instance.createdAt });
  await store.saveSecret({ id: "sec_acct", name: "Slack · Acme", provider: "oauth_account", projectId: "p2", source: "local", ...cipher });
  const account = await store.saveOAuthAccount({
    secretId: "sec_acct",
    providerId: "slack",
    projectId: "p2",
    appId: "slack:*",
    accountLabel: "Acme",
    scopes: ["chat:write", "chat:write.public"],
    status: "connected",
    lastError: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
    hasRefreshToken: true,
    connectedBy: "ana@example.com",
    connectedAt: "2026-11-20T10:00:00.000Z",
    lastRefreshAt: null
  });
  expect(account).toMatchObject({ accountLabel: "Acme", scopes: ["chat:write", "chat:write.public"], hasRefreshToken: true, expiresAt: "2030-01-01T00:00:00.000Z" });
  await store.saveOAuthAccount({ ...account, status: "needs_reconnect", lastError: "refused" });
  expect(await store.listOAuthAccounts(["sec_acct", "sec_other"])).toMatchObject([{ secretId: "sec_acct", status: "needs_reconnect", lastError: "refused" }]);
  expect(await store.listOAuthAccounts([])).toEqual([]);
  // The account's details go with its secret.
  expect(await store.deleteSecret("sec_acct")).toBe(true);
  expect(await store.getOAuthAccount("sec_acct")).toBeNull();
  // A project goes with its own apps and their client secrets, once it holds no secrets of its own.
  await store.upsertProject({ id: "p3", name: "Three" });
  await store.saveSecret({ id: "sec_c3", name: "client", provider: "oauth_client", source: "local", ...cipher });
  await store.saveOAuthApp({ id: "github:p3", providerId: "github", projectId: "p3", clientId: "g", clientSecretId: "sec_c3", tenant: null, updatedBy: null });
  expect(await store.deleteProject("p3")).toBe(true);
  expect(await store.getOAuthApp("github:p3")).toBeNull();
  expect(await store.getSecret("sec_c3")).toBeNull();
  expect(await store.deleteOAuthApp("slack:*")).toBe(true);
  expect(await store.deleteOAuthApp("slack:*")).toBe(false);
}

describe("v82 on SQLite", () => {
  it("a v81 database with data gains the connected-account tables in place", async () => {
    const file = path.join(tempDir, "v81.db");
    const fresh = await SqliteStore.create(file);
    await seed(fresh);
    await fresh.close();

    const db = new Database(file);
    db.exec(`DROP TABLE oauth_accounts; DROP TABLE oauth_apps;`);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      await expectUpgraded(store);
    } finally {
      await store.close();
    }
    const after = new Database(file, { readonly: true });
    try {
      for (const index of ["idx_oauth_apps_project", "idx_oauth_accounts_project"]) {
        expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index)).toBeTruthy();
      }
    } finally {
      after.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v82 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v81 schema with data migrates on boot; v82 down drops only the new tables", async () => {
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
    const tablesExist = async () =>
      (await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('oauth_apps', 'oauth_accounts')`, [schema])).rows.length;
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      const seeded = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await seed(seeded);
      await seeded.close();
      await rollbackMigrations(run, current, setRolledBack, 81);
      expect(await chainVersion(pool)).toBe(81);
      expect(await tablesExist()).toBe(0);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        expect(await tablesExist()).toBe(2);
        await expectUpgraded(store);
      } finally {
        await store.close();
      }
      await rollbackMigrations(run, current, setRolledBack, 81);
      expect(await tablesExist()).toBe(0);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM secrets WHERE id = 'sec_keep'`)).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM workflows`)).rows[0].n).toBe(1);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
