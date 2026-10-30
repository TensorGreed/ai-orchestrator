/**
 * Phase 13.1 — schema parity and the migration walk.
 *
 * Postgres (TEST_POSTGRES_URL set; skipped otherwise): a fresh schema migrated through the MIGRATIONS chain must have
 * the same tables, columns (type class, nullability), primary keys, unique constraints and named indexes as a fresh
 * SQLite created by the store's embedded migrate(), except for the deliberate differences in ALLOWED_DIFFERENCES.
 * The rollback walk v40 -> v10 -> v40 (and -> v0 -> v40) must succeed and land on the same schema again.
 *
 * SQLite (always): the v39 objects exist, the partial unique index refuses a second running guard simulation, and an
 * older database holding several running simulations upgrades cleanly.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool as PgPool, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_INSERTION_SEQ_TABLES, INSERTION_SEQ_TABLES, MIGRATIONS, rollbackMigrations, runMigrations } from "./migrations.js";
import { SqliteStore } from "./database.js";
import { createStore, postgresStoreConfig } from "./create-store.js";
import { PostgresStore, postgresPoolConfig, withMigrationLock } from "./postgres-store.js";
import {
  diffSchemas,
  formatDifference,
  introspectPostgres,
  introspectSqlite,
  type SchemaDifference,
  type SchemaShape
} from "../test-support/schema-introspection.js";
import {
  createTestStore,
  dropTestSchema,
  testStorePool,
  noticePostgresSkipped,
  randomTestSchema,
  testPostgresPool,
  testPostgresSettings,
  testPostgresUrl
} from "../test-support/test-store.js";

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

/**
 * Deliberate differences between the two schemas. Everything else must match. Not compared at all: SQLite's FTS5
 * virtual table `knowledge_base_chunks_fts` and its shadow tables (introspection skips them), triggers (the FTS5 sync
 * triggers exist only on SQLite; the guard profile revision triggers exist on both, in each dialect), CHECK
 * constraints, and default expressions (only whether a NOT NULL column has a default is compared).
 */
const FOREIGN_KEY_ONLY_IN_POSTGRES =
  "Postgres keeps this foreign key (NO ACTION); SQLite never declared it. Deleting the parent while a child row exists fails on Postgres (23503) and leaves an orphan on SQLite. Hand-off, q3a: deleteUser / project delete remove child rows (api_keys, mfa_secrets, sso_identities, user_project_roles) explicitly in both stores.";

const ROWID_STAND_IN =
  "Postgres stand-in for SQLite rowid (v40): BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY, the insertion order the Postgres queries use where SQLite orders by rowid. Its shape is pinned by the v40 test below.";

/** The v40 indexes over `seq`, exactly as Postgres reports them (pinned by the v40 test). */
const SEQ_INDEXES: ReadonlyArray<{ table: string; index: string; definition: string }> = [
  { table: "audit_logs", index: "idx_audit_logs_seq", definition: "CREATE UNIQUE INDEX idx_audit_logs_seq ON audit_logs USING btree (seq)" },
  {
    table: "knowledge_base_chunks",
    index: "idx_kb_chunks_kb_seq",
    definition: "CREATE INDEX idx_kb_chunks_kb_seq ON knowledge_base_chunks USING btree (knowledge_base_id, seq)"
  },
  // The data-subject lookup pages these five tables by `seq` (postgres/data-labels.ts).
  ...["replay_recordings", "eval_fixtures", "eval_results", "execution_history", "mcp_cassettes"].map((table) => ({
    table,
    index: `idx_${table}_seq`,
    definition: `CREATE UNIQUE INDEX idx_${table}_seq ON ${table} USING btree (seq)`
  }))
];

/** The tables q3b's Postgres modules order by `seq` (where SQLite uses rowid); all must be in v40. */
const Q3B_SEQ_TABLES = ["eval_fixtures", "eval_runs", "eval_results", "mcp_cassettes", "replay_recordings", "guard_simulations", "execution_history"];

export const ALLOWED_DIFFERENCES: ReadonlyArray<SchemaDifference & { reason: string }> = [
  ...ALL_INSERTION_SEQ_TABLES.map(({ table }) => ({
    kind: "column-missing" as const,
    table,
    object: "seq",
    detail: "only in postgres",
    reason: ROWID_STAND_IN
  })),
  ...SEQ_INDEXES.map(({ table, index }) => ({
    kind: "index-missing" as const,
    table,
    object: index,
    detail: "only in postgres",
    reason: ROWID_STAND_IN
  })),
  {
    kind: "column-missing",
    table: "knowledge_base_chunks",
    object: "content_tsv",
    detail: "only in postgres",
    reason: "Postgres full-text search: a generated tsvector column (v19). SQLite uses the FTS5 virtual table."
  },
  {
    kind: "index-missing",
    table: "knowledge_base_chunks",
    object: "idx_kb_chunks_content_tsv",
    detail: "only in postgres",
    reason: "Postgres full-text search: the GIN index over content_tsv (v19)."
  },
  {
    kind: "index-shape",
    table: "mcp_tool_calls",
    object: "idx_mcp_tool_calls_started",
    detail: "sqlite (started_at,id), postgres (started_at,idcollatec)",
    reason:
      "The keyset scan breaks started_at ties by id in code point order. SQLite compares text that way already; Postgres needs id COLLATE \"C\" in the index to serve the same ORDER BY (v49)."
  },
  {
    kind: "table-missing",
    table: "schema_migrations",
    object: "",
    detail: "only in postgres",
    reason: "Postgres records applied chain versions; SQLite's embedded migrate() always brings the whole schema."
  },
  {
    kind: "foreign-key-missing",
    table: "api_keys",
    object: "user_id",
    detail: "-> users(id) on delete no action only in postgres",
    reason: FOREIGN_KEY_ONLY_IN_POSTGRES
  },
  {
    kind: "foreign-key-missing",
    table: "mfa_secrets",
    object: "user_id",
    detail: "-> users(id) on delete no action only in postgres",
    reason: FOREIGN_KEY_ONLY_IN_POSTGRES
  },
  {
    kind: "foreign-key-missing",
    table: "sso_identities",
    object: "user_id",
    detail: "-> users(id) on delete no action only in postgres",
    reason: FOREIGN_KEY_ONLY_IN_POSTGRES
  },
  {
    kind: "foreign-key-missing",
    table: "user_project_roles",
    object: "project_id",
    detail: "-> projects(id) on delete no action only in postgres",
    reason: FOREIGN_KEY_ONLY_IN_POSTGRES
  },
  {
    kind: "foreign-key-missing",
    table: "user_project_roles",
    object: "user_id",
    detail: "-> users(id) on delete no action only in postgres",
    reason: FOREIGN_KEY_ONLY_IN_POSTGRES
  }
];

function unexpected(differences: SchemaDifference[]): string[] {
  return differences
    .filter((d) => !ALLOWED_DIFFERENCES.some((a) => a.kind === d.kind && a.table === d.table && a.object === d.object && a.detail === d.detail))
    .map(formatDifference);
}

function staleAllowances(differences: SchemaDifference[]): string[] {
  return ALLOWED_DIFFERENCES.filter((a) => !differences.some((d) => a.kind === d.kind && a.table === d.table && a.object === d.object && a.detail === d.detail)).map(
    (a) => `${a.kind} ${a.table}${a.object ? `.${a.object}` : ""}`
  );
}

let tempDir: string;

async function freshSqliteShape(): Promise<{ shape: SchemaShape; file: string }> {
  const file = path.join(tempDir, `parity-${Math.random().toString(36).slice(2)}.db`);
  const store = await SqliteStore.create(file);
  await store.close();
  const db = new Database(file, { readonly: true });
  try {
    return { shape: introspectSqlite(db), file };
  } finally {
    db.close();
  }
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-schema-parity-"));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("the allow-list pins the shape of each allowed difference", () => {
  const fk = (table: string, object: string, detail: string): SchemaDifference => ({ kind: "foreign-key-missing", table, object, detail });

  it("accepts the documented shapes", () => {
    const documented = ALLOWED_DIFFERENCES.map(({ kind, table, object, detail }) => ({ kind, table, object, detail }));
    expect(unexpected(documented)).toEqual([]);
    expect(staleAllowances(documented)).toEqual([]);
  });

  it("reports an allowed foreign key whose ON DELETE action, target table or target columns changed", () => {
    expect(unexpected([fk("api_keys", "user_id", "-> users(id) on delete no action only in postgres")])).toEqual([]);
    expect(unexpected([fk("api_keys", "user_id", "-> users(id) on delete cascade only in postgres")])).toHaveLength(1);
    expect(unexpected([fk("api_keys", "user_id", "-> projects(id) on delete no action only in postgres")])).toHaveLength(1);
    expect(unexpected([fk("api_keys", "user_id", "-> users(email) on delete no action only in postgres")])).toHaveLength(1);
    expect(unexpected([fk("api_keys", "user_id", "-> users(id) on delete no action only in sqlite")])).toHaveLength(1);
  });

  it("reports a changed content_tsv column or index as unexpected", () => {
    expect(unexpected([{ kind: "column-missing", table: "knowledge_base_chunks", object: "content_tsv", detail: "only in postgres" }])).toEqual([]);
    expect(unexpected([{ kind: "column-missing", table: "knowledge_base_chunks", object: "content_tsv", detail: "only in sqlite" }])).toHaveLength(1);
  });
});

describe("SQLite schema: migration 39 objects", () => {
  it("has the partial unique index for one running guard simulation and the external-provider secrets index", async () => {
    const { shape } = await freshSqliteShape();
    expect(shape.guard_simulations.indexes.idx_guard_simulations_one_running).toEqual({ unique: true, columns: "status", where: "status='running'" });
    expect(shape.secrets.indexes.idx_secrets_external_provider_id).toEqual({ unique: false, columns: "external_provider_id", where: "" });
    expect(shape.sessions.indexes.idx_sessions_revoked_expires).toBeDefined();
  });

  it("a fresh database has no upgrade notes", async () => {
    const file = path.join(tempDir, `fresh-${Math.random().toString(36).slice(2)}.db`);
    const logged: string[] = [];
    const store = await createStore({ env: { DB_SQLITE_PATH: file }, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) } });
    try {
      expect((store as SqliteStore).upgradeNotes).toEqual([]);
      expect(logged).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("refuses a second running simulation and allows any number of finished ones", async () => {
    const { file } = await freshSqliteShape();
    const db = new Database(file);
    try {
      const insert = db.prepare(
        `INSERT INTO guard_simulations (id, profile_id, source_kind, simulated_hash, job_ids_json, status, created_at) VALUES (?, 'p', 'draft', 'h', '[]', ?, ?)`
      );
      insert.run("sim-1", "running", "2026-10-26T00:00:00.000Z");
      expect(() => insert.run("sim-2", "running", "2026-10-26T00:00:01.000Z")).toThrow(/UNIQUE/);
      insert.run("sim-3", "completed", "2026-10-26T00:00:02.000Z");
      insert.run("sim-4", "completed", "2026-10-26T00:00:03.000Z");
      db.prepare(`UPDATE guard_simulations SET status = 'completed' WHERE id = 'sim-1'`).run();
      insert.run("sim-5", "running", "2026-10-26T00:00:04.000Z");
    } finally {
      db.close();
    }
  });

  it("upgrades a database holding several running simulations: the newest keeps running, the others are interrupted", async () => {
    const { file } = await freshSqliteShape();
    const db = new Database(file);
    db.exec(`DROP INDEX idx_guard_simulations_one_running`);
    const insert = db.prepare(
      `INSERT INTO guard_simulations (id, profile_id, source_kind, simulated_hash, job_ids_json, status, error, created_at) VALUES (?, 'p', 'draft', 'h', '[]', ?, ?, ?)`
    );
    insert.run("old", "running", null, "2026-10-01T00:00:00.000Z");
    insert.run("older", "running", "kept", "2026-09-01T00:00:00.000Z");
    insert.run("newest", "running", null, "2026-10-20T00:00:00.000Z");
    insert.run("done", "completed", null, "2026-10-21T00:00:00.000Z");
    db.close();

    const firstLog: string[] = [];
    const store = await createStore({ env: { DB_SQLITE_PATH: file }, log: { info: (m) => firstLog.push(m), warn: (m) => firstLog.push(m) } });
    expect((store as SqliteStore).upgradeNotes).toEqual(["v39 upgrade: 2 running guard simulations were interrupted (only one can run at a time)."]);
    expect(firstLog).toEqual(["Database: v39 upgrade: 2 running guard simulations were interrupted (only one can run at a time)."]);
    await store.close();
    // The note is printed once, at the upgrade; the next start has nothing to say.
    const logged: string[] = [];
    const again = await createStore({ env: { DB_SQLITE_PATH: file }, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) } });
    await again.close();
    expect(logged).toEqual([]);
    const after = new Database(file, { readonly: true });
    try {
      const rows = after.prepare(`SELECT id, status, error, finished_at FROM guard_simulations ORDER BY id`).all() as Array<{
        id: string;
        status: string;
        error: string | null;
        finished_at: string | null;
      }>;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId.newest.status).toBe("running");
      expect(byId.newest.finished_at).toBeNull();
      expect(byId.old).toMatchObject({ status: "interrupted", error: "Stopped by an upgrade: only one simulation can run at a time." });
      expect(byId.old.finished_at).toBeTruthy();
      expect(byId.older).toMatchObject({ status: "interrupted", error: "kept" });
      expect(byId.done.status).toBe("completed");
      const index = after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_guard_simulations_one_running'`).get();
      expect(index).toBeTruthy();
    } finally {
      after.close();
    }
  });
});

const APPROVAL_INSERT_COLUMNS = `id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at`;
const SUPERSEDED = "Superseded by a newer request of the same run";
const V41_NOTE = "v41 upgrade: 3 duplicate pending approval requests were canceled (a run has one open request).";
/** Seed rows for the v41 upgrade tests: run-1 has three pending requests, run-2 two, run-3 one plus a decided one. */
const DUPLICATE_APPROVALS: ReadonlyArray<[id: string, executionId: string, status: string, createdAt: string]> = [
  ["a-old", "run-1", "pending", "2026-10-01T00:00:00.000Z"],
  ["a-new", "run-1", "pending", "2026-10-03T00:00:00.000Z"],
  ["a-mid", "run-1", "pending", "2026-10-02T00:00:00.000Z"],
  ["b-1", "run-2", "pending", "2026-10-05T00:00:00.000Z"],
  ["b-2", "run-2", "pending", "2026-10-05T00:00:00.000Z"],
  ["c-pending", "run-3", "pending", "2026-10-01T00:00:00.000Z"],
  ["c-decided", "run-3", "approved", "2026-10-09T00:00:00.000Z"]
];
const V41_EXPECTED_STATUS: Record<string, string> = {
  "a-old": "canceled", "a-mid": "canceled", "a-new": "pending",
  // Equal created_at: the greater id is kept.
  "b-1": "canceled", "b-2": "pending",
  "c-pending": "pending", "c-decided": "approved"
};

describe("SQLite schema: migration 41 (one pending approval request per run)", () => {
  it("a copy of a v40 database holding duplicate pending requests boots: the newest stays pending, the others are canceled and counted", async () => {
    const { file } = await freshSqliteShape();
    const db = new Database(file);
    db.exec(`DROP INDEX idx_approval_requests_one_pending`);
    const insert = db.prepare(`INSERT INTO approval_requests (${APPROVAL_INSERT_COLUMNS}) VALUES (?, ?, 'wf', 'default', 'n', 'approval_gate', ?, '{}', ?, ?)`);
    for (const [id, executionId, status, createdAt] of DUPLICATE_APPROVALS) insert.run(id, executionId, status, createdAt, createdAt);
    db.close();
    const copy = `${file}.copy.db`;
    fs.copyFileSync(file, copy);

    const firstLog: string[] = [];
    const store = await createStore({ env: { DB_SQLITE_PATH: copy }, log: { info: (m) => firstLog.push(m), warn: (m) => firstLog.push(m) } });
    expect((store as SqliteStore).upgradeNotes).toEqual([V41_NOTE]);
    expect(firstLog).toEqual([`Database: ${V41_NOTE}`]);
    expect((await store.getApprovalRequest("a-old"))).toMatchObject({ status: "canceled", reason: SUPERSEDED });
    expect((await store.getPendingApprovalRequestForExecution("run-1"))?.id).toBe("a-new");
    await store.close();
    const logged: string[] = [];
    const again = await createStore({ env: { DB_SQLITE_PATH: copy }, log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) } });
    await again.close();
    expect(logged).toEqual([]);

    const after = new Database(copy, { readonly: true });
    const original = new Database(file, { readonly: true });
    try {
      const rows = after.prepare(`SELECT id, status, decided_at FROM approval_requests`).all() as Array<{ id: string; status: string; decided_at: string | null }>;
      expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual(V41_EXPECTED_STATUS);
      expect(rows.find((row) => row.id === "a-old")?.decided_at).toBeTruthy();
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_approval_requests_one_pending'`).get()).toBeTruthy();
      // The upgrade ran on the copy only.
      expect((original.prepare(`SELECT COUNT(*) AS n FROM approval_requests WHERE status = 'pending'`).get() as { n: number }).n).toBe(6);
    } finally {
      after.close();
      original.close();
    }
  });
});

describe("schema introspection: foreign keys and NOT NULL defaults", () => {
  it("reports a foreign key or a NOT NULL default present on one side only, and a differing ON DELETE action", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          note TEXT DEFAULT 'x'
        );
      `);
      const sqlite = introspectSqlite(db);
      expect(sqlite.children.foreignKeys).toEqual({ parent_id: { references: "parents", referencedColumns: "id", onDelete: "cascade" } });
      expect(sqlite.children.columns.created_at).toMatchObject({ notNull: true, hasDefault: true });

      const other: SchemaShape = structuredClone(sqlite);
      other.children.columns.created_at.hasDefault = false;
      other.children.columns.note.hasDefault = false; // nullable: a missing default is not reported
      other.children.foreignKeys.parent_id.onDelete = "no action";
      other.parents.foreignKeys.id = { references: "children", referencedColumns: "id", onDelete: "no action" };
      expect(diffSchemas(sqlite, other).map(formatDifference)).toEqual([
        "column-default children.created_at: NOT NULL; default only in sqlite",
        "foreign-key-shape children.parent_id: sqlite -> parents(id) on delete cascade, postgres -> parents(id) on delete no action",
        "foreign-key-missing parents.id: -> children(id) on delete no action only in postgres"
      ]);
    } finally {
      db.close();
    }
  });
});

const postgresUrl = testPostgresUrl();
if (!postgresUrl) noticePostgresSkipped("schema parity and migration walk");

async function chainVersion(pool: Pool): Promise<number> {
  const result = await pool.query<{ version: number }>(`SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations`);
  return result.rows[0].version;
}

/** The callbacks the db:rollback CLI and PostgresStore use, on a pool whose search_path is the test schema. */
function chainCallbacks(pool: Pool) {
  return {
    run: async (sql: string) => {
      await pool.query(sql);
    },
    current: () => chainVersion(pool),
    setApplied: async (version: number) => {
      await pool.query(`INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [version]);
    },
    setRolledBack: async (version: number) => {
      await pool.query(`DELETE FROM schema_migrations WHERE version > $1`, [version]);
    }
  };
}

describe.skipIf(!postgresUrl)("Postgres schema parity and migration walk", () => {
  let sqliteShape: SchemaShape;

  beforeAll(async () => {
    sqliteShape = (await freshSqliteShape()).shape;
  });

  it("a fresh Postgres through the whole chain matches a fresh SQLite, apart from the documented differences", async () => {
    const test = await createTestStore({ kind: "postgres" });
    const pool = testStorePool(test);
    try {
      const pgShape = await introspectPostgres(pool, "public");
      expect(Object.keys(pgShape).length).toBeGreaterThan(70);
      // The whole table is allowed to be missing from SQLite, so pin its shape here.
      expect(Object.keys(pgShape.schema_migrations.columns).sort()).toEqual(["applied_at", "version"]);
      expect(pgShape.schema_migrations.primaryKey).toEqual(["version"]);
      const differences = diffSchemas(sqliteShape, pgShape);
      expect(unexpected(differences)).toEqual([]);
      expect(staleAllowances(differences)).toEqual([]);
      const scoped = testStorePool(test);
      try {
        expect(await chainVersion(scoped)).toBe(LATEST);
      } finally {
        await scoped.end();
      }
    } finally {
      await pool.end();
      await test.cleanup();
    }
  }, 120_000);

  it("v40: no float4 (real) column remains; SQLite REAL is an 8-byte double, so Postgres uses double precision", async () => {
    const test = await createTestStore({ kind: "postgres" });
    const pool = testStorePool(test);
    try {
      const real = await pool.query<{ column: string }>(
        `SELECT table_name || '.' || column_name AS column FROM information_schema.columns
          WHERE table_schema = $1 AND data_type = 'real' ORDER BY 1`,
        ["public"]
      );
      expect(real.rows).toEqual([]);
      const widened = await pool.query<{ column: string; data_type: string }>(
        `SELECT table_name || '.' || column_name AS column, data_type FROM information_schema.columns
          WHERE table_schema = $1 AND (table_name, column_name) IN (('usage_events', 'cost_usd'), ('budgets', 'limit_value'),
            ('budgets', 'warn_threshold_pct'), ('budget_alerts', 'usage_value'), ('budget_alerts', 'limit_value')) ORDER BY 1`,
        ["public"]
      );
      expect(widened.rows).toEqual(
        ["budget_alerts.limit_value", "budget_alerts.usage_value", "budgets.limit_value", "budgets.warn_threshold_pct", "usage_events.cost_usd"].map((column) => ({
          column,
          data_type: "double precision"
        }))
      );
    } finally {
      await pool.end();
      await test.cleanup();
    }
  }, 120_000);

  it("v40 down narrows the widened columns back to real, keeping the shortest decimal on the way up again", async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const cb = chainCallbacks(pool);
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 39);
      const type = await pool.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'usage_events' AND column_name = 'cost_usd'`,
        [schema]
      );
      expect(type.rows[0]?.data_type).toBe("real");
      await pool.query(
        `INSERT INTO usage_events (id, execution_id, workflow_id, status, cost_usd, created_at) VALUES ('u1', 'e1', 'w1', 'success', 0.1, now())`
      );
      await runMigrations(cb.run, cb.current, cb.setApplied);
      const cost = await pool.query<{ cost: number }>(`SELECT cost_usd AS cost FROM usage_events WHERE id = 'u1'`);
      expect(cost.rows[0]?.cost).toBe(0.1);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 120_000);

  it("v40 covers every table the governance modules order by seq", () => {
    const tables = INSERTION_SEQ_TABLES.map(({ table }) => table);
    expect(Q3B_SEQ_TABLES.filter((table) => !tables.includes(table))).toEqual([]);
  });

  it("v40: every insertion-ordered table has seq BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY, and the seq indexes are exactly as documented", async () => {
    const test = await createTestStore({ kind: "postgres" });
    const pool = testStorePool(test);
    try {
      const columns = await pool.query<{ table_name: string; data_type: string; is_nullable: string; is_identity: string; identity_generation: string | null }>(
        `SELECT table_name, data_type, is_nullable, is_identity, identity_generation
           FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'seq' ORDER BY table_name`,
        ["public"]
      );
      expect(columns.rows).toEqual(
        ALL_INSERTION_SEQ_TABLES.map(({ table }) => ({ table_name: table, data_type: "bigint", is_nullable: "NO", is_identity: "YES", identity_generation: "ALWAYS" })).sort((a, b) =>
          a.table_name < b.table_name ? -1 : 1
        )
      );
      const indexes = await pool.query<{ tablename: string; indexname: string; indexdef: string }>(
        // Only this schema's indexes over a `seq` column (the fence keeps pg_get_indexdef off other tests' schemas).
        `SELECT tablename, indexname, replace(pg_get_indexdef(indexrelid), $1 || '.', '') AS indexdef FROM (
           SELECT DISTINCT t.relname AS tablename, c.relname AS indexname, i.indexrelid
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_class t ON t.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
            WHERE n.nspname = $1 AND a.attname = 'seq'
           OFFSET 0
         ) s ORDER BY indexname`,
        ["public"]
      );
      expect(indexes.rows.map((row) => ({ table: row.tablename, index: row.indexname, definition: row.indexdef }))).toEqual(
        [...SEQ_INDEXES].sort((a, b) => (a.index < b.index ? -1 : 1))
      );
    } finally {
      await pool.end();
      await test.cleanup();
    }
  }, 120_000);

  it("v40 on a populated v39 database numbers existing rows in the old read order; new rows follow; down removes seq", async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const cb = chainCallbacks(pool);
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 39);
      expect(await chainVersion(pool)).toBe(39);
      // Inserted out of time order; ties on created_at are numbered by id.
      const insert = `INSERT INTO audit_logs (id, event_type, category, action, outcome, created_at) VALUES ($1, 'e', 'auth', 'a', 'success', $2)`;
      await pool.query(insert, ["b", "2026-01-02T00:00:00.000Z"]);
      await pool.query(insert, ["a", "2026-01-03T00:00:00.000Z"]);
      await pool.query(insert, ["d", "2026-01-01T00:00:00.000Z"]);
      await pool.query(insert, ["c", "2026-01-01T00:00:00.000Z"]);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      expect(await chainVersion(pool)).toBe(LATEST);
      await pool.query(insert, ["z", "2020-01-01T00:00:00.000Z"]);
      const rows = await pool.query<{ id: string; seq: string }>(`SELECT id, seq FROM audit_logs ORDER BY seq`);
      expect(rows.rows.map((row) => [row.id, Number(row.seq)])).toEqual([["c", 1], ["d", 2], ["b", 3], ["a", 4], ["z", 5]]);
      // GENERATED ALWAYS: a caller cannot pick seq.
      await expect(pool.query(`INSERT INTO audit_logs (id, event_type, category, action, outcome, created_at, seq) VALUES ('x', 'e', 'auth', 'a', 'success', now(), 1)`)).rejects.toMatchObject({ code: "428C9" });

      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 39);
      const left = await pool.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'seq'`, [schema]);
      expect(left.rows).toEqual([]);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs`)).rows[0].n).toBe(5);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 120_000);

  it("knowledge base chunks are searchable through the generated tsvector (ts_rank_cd / websearch_to_tsquery)", async () => {
    const test = await createTestStore({ kind: "postgres" });
    const pool = testStorePool(test);
    try {
      const insert = `INSERT INTO knowledge_base_chunks (id, knowledge_base_id, chunk_index, content, vector_json, created_at) VALUES ($1, 'kb', $2, $3, '[]', now())`;
      await pool.query(insert, ["c1", 0, "Refund policy: customers may return items within thirty days."]);
      await pool.query(insert, ["c2", 1, "Shipping takes five business days. Refunds for shipping are not offered; refund requests go to billing."]);
      await pool.query(insert, ["c3", 2, "Our office dog is named Biscuit."]);
      const result = await pool.query<{ id: string; rank: number }>(
        `SELECT id, ts_rank_cd(content_tsv, q) AS rank
           FROM knowledge_base_chunks, websearch_to_tsquery('english', $1) q
          WHERE knowledge_base_id = 'kb' AND content_tsv @@ q
          ORDER BY rank DESC, id`,
        ["refunds"]
      );
      expect(result.rows.map((row) => row.id)).toEqual(["c2", "c1"]);
      await pool.query(`UPDATE knowledge_base_chunks SET content = 'Biscuit now handles refunds.' WHERE id = 'c3'`);
      const updated = await pool.query(`SELECT id FROM knowledge_base_chunks WHERE content_tsv @@ websearch_to_tsquery('english', 'biscuit refund')`);
      expect(updated.rows.map((row) => row.id)).toEqual(["c3"]);
    } finally {
      await pool.end();
      await test.cleanup();
    }
  }, 120_000);

  it(`rolls back v${LATEST} -> v10 -> v${LATEST}, and v${LATEST} -> v0 -> v${LATEST}, ending on the same schema`, async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const cb = chainCallbacks(pool);
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      expect(await chainVersion(pool)).toBe(LATEST);

      const toTen = await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 10);
      expect(toTen.rolledBack).toEqual(MIGRATIONS.filter((m) => m.version > 10).map((m) => m.version).sort((a, b) => b - a));
      expect(await chainVersion(pool)).toBe(10);
      const atTen = await introspectPostgres(admin, schema);
      expect(atTen.leader_leases).toBeDefined();
      expect(atTen.workflow_templates).toBeUndefined();
      expect(atTen.guard_simulations).toBeUndefined();
      expect(atTen.data_destinations).toBeUndefined();

      await runMigrations(cb.run, cb.current, cb.setApplied);
      expect(await chainVersion(pool)).toBe(LATEST);
      let differences = diffSchemas(sqliteShape, await introspectPostgres(admin, schema));
      expect(unexpected(differences)).toEqual([]);

      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 0);
      expect(await chainVersion(pool)).toBe(0);
      expect(Object.keys(await introspectPostgres(admin, schema))).toEqual(["schema_migrations"]);

      await runMigrations(cb.run, cb.current, cb.setApplied);
      differences = diffSchemas(sqliteShape, await introspectPostgres(admin, schema));
      expect(unexpected(differences)).toEqual([]);
      expect(staleAllowances(differences)).toEqual([]);
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);

  it("v39 on a database holding several running simulations keeps the newest running and builds the index", async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const cb = chainCallbacks(pool);
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 38);
      // v39's down drops the timestamp defaults it added; its up puts them back.
      const hasDefault = async () =>
        (await introspectPostgres(admin, schema)).budgets.columns.created_at.hasDefault;
      expect(await hasDefault()).toBe(false);
      const insert = `INSERT INTO guard_simulations (id, profile_id, source_kind, simulated_hash, job_ids_json, status, error, created_at) VALUES ($1, 'p', 'draft', 'h', '[]', $2, $3, $4)`;
      await pool.query(insert, ["old", "running", null, "2026-10-01T00:00:00Z"]);
      await pool.query(insert, ["older", "running", null, "2026-09-01T00:00:00Z"]);
      await pool.query(insert, ["newest", "running", null, "2026-10-20T00:00:00Z"]);
      await pool.query(insert, ["done", "completed", null, "2026-10-21T00:00:00Z"]);

      // The store's own boot applies v39 and reports what it interrupted (a NOTICE raised by the migration).
      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      expect(store.upgradeNotes).toEqual(["v39 upgrade: 2 running guard simulations were interrupted (only one can run at a time)."]);
      await store.close();
      expect(await chainVersion(pool)).toBe(LATEST);
      expect(await hasDefault()).toBe(true);
      const rows = await pool.query<{ id: string; status: string; error: string | null; finished_at: string | null }>(
        `SELECT id, status, error, finished_at FROM guard_simulations ORDER BY id`
      );
      const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
      expect(byId.newest).toMatchObject({ status: "running", finished_at: null });
      expect(byId.old).toMatchObject({ status: "interrupted", error: "Stopped by an upgrade: only one simulation can run at a time." });
      expect(byId.old.finished_at).toBeTruthy();
      expect(byId.done.status).toBe("completed");
      await expect(pool.query(insert, ["another", "running", null, "2026-10-22T00:00:00Z"])).rejects.toMatchObject({ code: "23505" });
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);

  it("v41 on a database holding duplicate pending approval requests keeps the newest per run, cancels the rest, and builds the index", async () => {
    const schema = randomTestSchema();
    const admin = testPostgresPool();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = testPostgresPool(schema);
    const cb = chainCallbacks(pool);
    try {
      await pool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
      await runMigrations(cb.run, cb.current, cb.setApplied);
      await rollbackMigrations(cb.run, cb.current, cb.setRolledBack, 40);
      expect(await chainVersion(pool)).toBe(40);
      for (const [id, executionId, status, createdAt] of DUPLICATE_APPROVALS) {
        await pool.query(
          `INSERT INTO approval_requests (${APPROVAL_INSERT_COLUMNS}) VALUES ($1, $2, 'wf', 'default', 'n', 'approval_gate', $3, '{}', $4, $4)`,
          [id, executionId, status, createdAt]
        );
      }

      const store = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 }));
      expect(store.upgradeNotes).toEqual([V41_NOTE]);
      expect(await store.getApprovalRequest("a-mid")).toMatchObject({ status: "canceled", reason: SUPERSEDED });
      await store.close();
      expect(await chainVersion(pool)).toBe(LATEST);
      const rows = await pool.query<{ id: string; status: string }>(`SELECT id, status FROM approval_requests`);
      expect(Object.fromEntries(rows.rows.map((row) => [row.id, row.status]))).toEqual(V41_EXPECTED_STATUS);
      await expect(
        pool.query(`INSERT INTO approval_requests (${APPROVAL_INSERT_COLUMNS}) VALUES ('x', 'run-1', 'wf', 'default', 'n', 'approval_gate', 'pending', '{}', 'now', 'now')`)
      ).rejects.toMatchObject({ code: "23505", constraint: "idx_approval_requests_one_pending" });
    } finally {
      await pool.end();
      await admin.end();
      await dropTestSchema(schema);
    }
  }, 180_000);

  it("withMigrationLock serialises holders of the same schema, not of different schemas, and releases on a throw", async () => {
    // One connection per holder (three at once).
    const pool = new PgPool(postgresPoolConfig(postgresStoreConfig(testPostgresSettings()), { max: 4 }));
    try {
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const order: string[] = [];
      const first = withMigrationLock(pool, "t_lock_a", async () => {
        order.push("first:start");
        await firstHeld;
        order.push("first:end");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = withMigrationLock(pool, "t_lock_a", async () => {
        order.push("second");
      });
      const other = withMigrationLock(pool, "t_lock_b", async () => {
        order.push("other-schema");
      });
      await other;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(order).toEqual(["first:start", "other-schema"]);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first:start", "other-schema", "first:end", "second"]);

      await expect(withMigrationLock(pool, "t_lock_a", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      await withMigrationLock(pool, "t_lock_a", async () => undefined);
      // Only this test's keys: other test files boot stores (and take migration locks) on the same server meanwhile.
      const held = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objsubid = 2
            AND objid::bigint IN ((hashtext('t_lock_a')::bigint + 4294967296) % 4294967296, (hashtext('t_lock_b')::bigint + 4294967296) % 4294967296)`,
        [0x4c324d]
      );
      expect(held.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("two stores migrating the same schema at once both succeed (the migration lock serialises them)", async () => {
    const schema = randomTestSchema();
    const config = postgresStoreConfig(testPostgresSettings(), { schema, maxConnections: 2 });
    try {
      const [a, b] = await Promise.all([PostgresStore.create(config), PostgresStore.create(config)]);
      await a.close();
      await b.close();
      const pool = testPostgresPool(schema);
      try {
        expect(await chainVersion(pool)).toBe(LATEST);
        const count = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM schema_migrations`);
        expect(count.rows[0].n).toBe(MIGRATIONS.length);
      } finally {
        await pool.end();
      }
    } finally {
      await dropTestSchema(schema);
    }
  }, 120_000);
});
