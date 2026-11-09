/**
 * 13.2 (v62) — upgrading a database that holds users and API keys: `users` gains kind (default human), description and
 * created_by; existing users are people, and existing keys verify with their stored scopes unchanged (a free-form
 * scope stays legacy, so the key keeps its owner's role). approval_requests gains the API key columns. Any kind other
 * than 'human' reads as a service account (fails closed); Postgres also refuses one with a CHECK. Rolling v62 back
 * revokes service-account keys and scoped keys and disables service accounts instead of widening them. SQLite always;
 * Postgres when TEST_POSTGRES_URL is set.
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
import { ApiKeyService } from "../services/api-key-service.js";
import { AuthService } from "../services/auth-service.js";
import { effectiveKeyRole, parseKeyScopes } from "../services/key-scopes.js";
import { dropTestSchema, randomTestSchema, testPostgresPool, testPostgresSettings, testPostgresUrl } from "../test-support/test-store.js";

const V62_COLUMNS = ["kind", "description", "created_by"];
const V62_APPROVAL_COLUMNS = ["requested_by_api_key_id", "decided_by_api_key_id"];

let tempDir = "";

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v62-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Seeds a person with a legacy-scoped key on the current schema; returns the key's plaintext. */
async function seed(store: Store): Promise<string> {
  await new AuthService(store, 24).register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "admin" });
  const userId = (await store.getUserByEmail("ana@example.com"))!.id;
  return (await new ApiKeyService(store).create({ userId, name: "ci", scopes: ["workflow:read", "deploy"] })).plaintext;
}

async function expectPreUpgradeRowsWork(store: Store, key: string): Promise<void> {
  const user = await store.getUserByEmail("ana@example.com");
  expect(user).toMatchObject({ role: "admin", kind: "human", description: null, createdBy: null });
  expect((await store.listUsers({ kind: "human" })).map((row) => row.email)).toEqual(["ana@example.com"]);
  expect(await store.listUsers({ kind: "service" })).toEqual([]);
  const verified = await new ApiKeyService(store).verify(key);
  expect(verified?.scopes).toEqual(["workflow:read", "deploy"]);
  expect(effectiveKeyRole("admin", parseKeyScopes(verified?.scopes))).toBe("admin");
  expect(await new AuthService(store, 24).verifyCredentials("ana@example.com", "Ana-Pass-123!")).toMatchObject({ role: "admin" });
  // A service account can be created next to the old rows.
  expect(await store.createServiceAccount({ id: "svc1", email: "bot@service.invalid", role: "viewer", description: null, createdBy: user!.id })).toMatchObject({ kind: "service" });
}

describe("v62 on SQLite", () => {
  it("a v61 database with users and keys upgrades in place", async () => {
    const file = path.join(tempDir, "v61.db");
    const fresh = await SqliteStore.create(file);
    const key = await seed(fresh);
    await fresh.close();

    // Turn the file back into the v61 users table.
    const db = new Database(file);
    db.exec(`DROP INDEX idx_users_kind`);
    for (const column of V62_COLUMNS) db.exec(`ALTER TABLE users DROP COLUMN ${column}`);
    for (const column of V62_APPROVAL_COLUMNS) db.exec(`ALTER TABLE approval_requests DROP COLUMN ${column}`);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      await expectPreUpgradeRowsWork(store, key);
      // An unknown kind (a typo or a manual fix) reads as a service account, which cannot sign in.
      const raw = new Database(file);
      raw.prepare(`UPDATE users SET kind = 'Human' WHERE email = ?`).run("ana@example.com");
      raw.close();
      expect(await store.getUserByEmail("ana@example.com")).toMatchObject({ kind: "service" });
      await expect(new AuthService(store, 24).verifyCredentials("ana@example.com", "Ana-Pass-123!")).rejects.toThrow();
      expect((await store.listUsers({ kind: "human" })).map((row) => row.email)).toEqual([]);
    } finally {
      await store.close();
    }

    const after = new Database(file, { readonly: true });
    try {
      const columns = after.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const byName = Object.fromEntries(columns.map((column) => [column.name, column]));
      expect(byName.kind).toMatchObject({ notnull: 1, dflt_value: "'human'" });
      expect(byName.description).toBeDefined();
      expect(byName.created_by).toBeDefined();
      const approvalColumns = (after.prepare(`PRAGMA table_info(approval_requests)`).all() as Array<{ name: string }>).map((column) => column.name);
      expect(approvalColumns).toEqual(expect.arrayContaining(V62_APPROVAL_COLUMNS));
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_kind'`).get()).toBeTruthy();
    } finally {
      after.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v62 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v61 schema with users and keys migrates on boot; v62 down disables service accounts, revokes scoped keys, then removes the columns", async () => {
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
    const userColumns = async () =>
      (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`, [schema])).rows.map(
        (row) => row.column_name
      );
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      // Seed on the current schema, then go back to v61 with the rows in place.
      const seedStore = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      const key = await seed(seedStore);
      await seedStore.close();
      await rollbackMigrations(run, current, setRolledBack, 61);
      expect(await chainVersion(pool)).toBe(61);
      expect(await userColumns()).not.toContain("kind");

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
        expect(await userColumns()).toEqual(expect.arrayContaining(V62_COLUMNS));
        await expectPreUpgradeRowsWork(store, key);
        // A kind other than human or service is refused.
        await expect(pool.query(`UPDATE users SET kind = 'svc' WHERE id = 'svc1'`)).rejects.toThrow();
        const ana = (await store.getUserByEmail("ana@example.com"))!.id;
        const keys = new ApiKeyService(store);
        await keys.create({ userId: "svc1", name: "bot", scopes: [] });
        await keys.create({ userId: ana, name: "dash", scopes: ["role:viewer"] });
        await keys.create({ userId: ana, name: "proj", scopes: ["project:default"] });
        await store.ensureDefaultProject();
        await store.upsertProjectRole({ userId: "svc1", projectId: "default", role: "editor" });
      } finally {
        await store.close();
      }
      const approvalColumns = async () =>
        (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'approval_requests'`, [schema])).rows.map(
          (row) => row.column_name
        );
      expect(await approvalColumns()).toEqual(expect.arrayContaining(V62_APPROVAL_COLUMNS));

      await rollbackMigrations(run, current, setRolledBack, 61);
      expect((await userColumns()).filter((column) => V62_COLUMNS.includes(column))).toEqual([]);
      expect((await approvalColumns()).filter((column) => V62_APPROVAL_COLUMNS.includes(column))).toEqual([]);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n).toBe(2);
      // Nothing is widened on the older build: the service account is disabled, and every key it or a scope limited is revoked.
      expect((await pool.query(`SELECT email, password_hash, role FROM users WHERE id = 'svc1'`)).rows[0]).toEqual({ email: "svc1@disabled.invalid", password_hash: "!", role: "viewer" });
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM user_project_roles WHERE user_id = 'svc1'`)).rows[0].n).toBe(0);
      const keyRows = (await pool.query<{ name: string; revoked: boolean }>(`SELECT name, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY name`)).rows;
      expect(keyRows).toEqual([
        { name: "bot", revoked: true },
        { name: "ci", revoked: false },
        { name: "dash", revoked: true },
        { name: "proj", revoked: true }
      ]);
      expect((await pool.query(`SELECT role FROM users WHERE email = 'ana@example.com'`)).rows[0].role).toBe("admin");
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
