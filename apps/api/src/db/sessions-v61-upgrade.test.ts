/**
 * 13.2 (v61) — upgrading a database that holds live sign-in sessions: the new session columns are added, and the
 * sessions issued before the upgrade still sign their users in, with empty v61 fields. SQLite always; Postgres when
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
import { AuthService } from "../services/auth-service.js";
import { dropTestSchema, randomTestSchema, testPostgresPool, testPostgresSettings, testPostgresUrl } from "../test-support/test-store.js";

const V61_COLUMNS = ["auth_method", "ip_address", "user_agent", "mfa_verified_at", "break_glass", "ended_reason"];
const LIVE = "sess_livePreUpgradeSession0001";
const ENDED = "sess_endedPreUpgradeSession001";
const FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = "2026-11-01T00:00:00.000Z";

let tempDir = "";

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-v61-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** The old sessions both stores must keep working after the upgrade. */
async function expectPreUpgradeSessionsWork(store: Store): Promise<void> {
  const auth = new AuthService(store, 24);
  const resolved = await auth.getSessionAuth(LIVE);
  expect(resolved?.user).toEqual({ id: "u1", email: "ana@example.com", role: "admin" });
  expect(resolved?.session).toEqual({
    id: LIVE,
    userId: "u1",
    expiresAt: FUTURE,
    createdAt: NOW,
    lastSeenAt: NOW,
    revokedAt: null,
    authMethod: null,
    ipAddress: null,
    userAgent: null,
    mfaVerifiedAt: null,
    breakGlass: false,
    endedReason: null
  });
  expect(await auth.getSessionAuth(ENDED)).toBeNull();
  expect((await store.getSession(ENDED))?.endedReason).toBeNull();
  expect((await store.listUserSessions("u1", { liveOnly: true })).map((session) => session.id)).toEqual([LIVE]);
  // A session issued after the upgrade carries the new fields next to the old one.
  const issued = await auth.login("ana@example.com", "Ana-Pass-123!");
  expect((await store.getSession(issued.sessionId))?.authMethod).toBe("password");
  expect(await store.revokeOldestUserSessions("u1", 1, "evicted")).toEqual([LIVE]);
  expect(await auth.getSessionAuth(LIVE)).toBeNull();
}

describe("v61 on SQLite", () => {
  it("a v60 database with live sessions upgrades in place and its sessions still authenticate", async () => {
    const file = path.join(tempDir, "v60.db");
    const fresh = await SqliteStore.create(file);
    // The password hash is the real one, so the post-upgrade login works.
    await new AuthService(fresh, 24).register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "admin" });
    const userId = (await fresh.getUserByEmail("ana@example.com"))!.id;
    await fresh.close();

    // Turn the file back into the v60 sessions table, then add sessions as v60 wrote them.
    const db = new Database(file);
    db.exec(`DROP INDEX idx_sessions_user_live`);
    for (const column of V61_COLUMNS) db.exec(`ALTER TABLE sessions DROP COLUMN ${column}`);
    db.prepare(`UPDATE users SET id = 'u1' WHERE id = ?`).run(userId);
    const insert = db.prepare(`INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at) VALUES (?, 'u1', ?, ?, ?, ?)`);
    insert.run(LIVE, FUTURE, NOW, NOW, null);
    insert.run(ENDED, FUTURE, NOW, NOW, NOW);
    db.close();

    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      // Read the row before anything touches it.
      expect(await store.getSession(LIVE)).toMatchObject({ lastSeenAt: NOW, authMethod: null, breakGlass: false });
      await expectPreUpgradeSessionsWork(store);
    } finally {
      await store.close();
    }

    const after = new Database(file, { readonly: true });
    try {
      const columns = (after.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);
      const byName = Object.fromEntries(columns.map((column) => [column.name, column]));
      for (const column of V61_COLUMNS) expect(byName[column]).toBeDefined();
      expect(byName.break_glass).toMatchObject({ notnull: 1, dflt_value: "0" });
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_user_live'`).get()).toBeTruthy();
    } finally {
      after.close();
    }
  });
});

const postgresUrl = testPostgresUrl();

describe.skipIf(!postgresUrl)("v61 on Postgres", () => {
  async function chainVersion(pool: Pool): Promise<number> {
    const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
    return result.rows[0].version;
  }

  it("a v60 schema with live sessions migrates on boot and its sessions still authenticate; v61 down removes the columns", async () => {
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
    const sessionColumns = async () =>
      (await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sessions'`, [schema])).rows.map(
        (row) => row.column_name
      );
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(run, current, setApplied);
      await rollbackMigrations(run, current, setRolledBack, 60);
      expect(await chainVersion(pool)).toBe(60);
      expect(await sessionColumns()).not.toContain("auth_method");

      // Users and sessions as v60 wrote them.
      const seed = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      await new AuthService(seed, 24).register({ email: "ana@example.com", password: "Ana-Pass-123!", role: "admin" });
      await seed.close();
      // PostgresStore.create migrated to the latest version; go back to v60 with the user in place.
      await rollbackMigrations(run, current, setRolledBack, 60);
      await pool.query(`UPDATE users SET id = 'u1' WHERE email = 'ana@example.com'`);
      const insert = `INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at, revoked_at) VALUES ($1, 'u1', $2, $3, $3, $4)`;
      await pool.query(insert, [LIVE, FUTURE, NOW, null]);
      await pool.query(insert, [ENDED, FUTURE, NOW, NOW]);

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      try {
        expect(await chainVersion(pool)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
        expect(await sessionColumns()).toEqual(expect.arrayContaining(V61_COLUMNS));
        await expectPreUpgradeSessionsWork(store);
      } finally {
        await store.close();
      }
      const index = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'idx_sessions_user_live'`, [schema]);
      expect(index.rows).toHaveLength(1);

      await rollbackMigrations(run, current, setRolledBack, 60);
      expect((await sessionColumns()).filter((column) => V61_COLUMNS.includes(column))).toEqual([]);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM sessions`)).rows[0].n).toBe(3);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);
});
