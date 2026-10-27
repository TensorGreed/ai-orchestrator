/**
 * Shared helpers for the db:export / db:import CLIs.
 *
 * Opens a raw connection to whichever store DB_TYPE points at, ensures the
 * schema is at the latest version, and exposes a tiny adapter for raw
 * SELECT/INSERT/TRUNCATE so the export and import scripts can stay store-
 * agnostic.
 */

import path from "node:path";
import fs from "node:fs";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import { Pool } from "pg";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { applyMigrationChain, postgresPoolConfig, withMigrationLock } from "../db/postgres-store.js";
import { INSERTION_SEQ_TABLES, MIGRATIONS } from "../db/migrations.js";
import { exactSqliteTextRows, SQLITE_AUDIT_TEXT_COLUMNS } from "../db/audit-chain.js";

/** The rowid alias SqliteAdapter.selectAll reads beside `*` (no table has a column of that name). */
const ROWID_KEY = "__backup_rowid";

/**
 * Tables that carry v40's `seq` identity on Postgres (insertion order). A Postgres backup keeps `seq`: export reads
 * them in `seq` order, import writes `seq` back (OVERRIDING SYSTEM VALUE, since the identity is GENERATED ALWAYS) and
 * then moves the identity past the restored max, so the chain and cursors walk the restored rows in the same order.
 */
const SEQ_TABLES: ReadonlySet<string> = new Set(INSERTION_SEQ_TABLES.map(({ table }) => table));

export interface BackupAdapter {
  readonly kind: "sqlite" | "postgres";
  schemaVersion(): Promise<number>;
  selectAll(table: string): Promise<Record<string, unknown>[]>;
  insertRows(table: string, rows: Record<string, unknown>[]): Promise<void>;
  truncate(table: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Tables exported by db:export. Anything truly transient (caches, replay
 * windows, leader leases, log stream delivery history) is intentionally
 * skipped — restoring those would either be wrong (resume an expired lease)
 * or pointless (caches refill on demand).
 *
 * `schema_migrations` is also skipped: the importer ensures the destination
 * is at the right version via runMigrations, then writes data on top.
 */
export const EXPORTED_TABLES = [
  // Workflow data
  "workflows",
  "workflow_versions",
  "workflow_shares",
  "workflow_templates",
  // Secrets + sharing
  "secrets",
  "secret_shares",
  "external_secret_providers",
  // Auth
  "users",
  "sessions",
  "api_keys",
  "mfa_secrets",
  "sso_identities",
  "sso_group_mappings",
  // Org
  "projects",
  "folders",
  "user_project_roles",
  "custom_roles",
  // Config / vars
  "variables",
  "git_configs",
  "notification_configs",
  "log_stream_destinations",
  // Triggers + multi-turn agent state
  "trigger_state",
  "session_memory",
  "session_artifacts",
  // Execution state worth keeping
  "workflow_executions",
  "execution_queue",
  "execution_queue_dlq",
  // Optional history (skippable via --exclude-history)
  "execution_history",
  "audit_logs"
] as const;

export const HISTORY_TABLES = [
  "execution_history",
  "audit_logs"
] as const;

/**
 * Encrypted-blob columns the importer can re-encrypt with a new master key
 * via --source-master-key. (The cache table `external_secret_cache` is
 * intentionally NOT exported; rotating the master key invalidates that
 * cache anyway.)
 */
export const ENCRYPTED_COLUMNS: Record<string, { iv: string; authTag: string; ciphertext: string; required: boolean }> = {
  secrets: { iv: "iv", authTag: "auth_tag", ciphertext: "ciphertext", required: true },
  mfa_secrets: { iv: "secret_iv", authTag: "secret_auth_tag", ciphertext: "secret_ciphertext", required: true },
  log_stream_destinations: { iv: "config_iv", authTag: "config_auth_tag", ciphertext: "config_ciphertext", required: false }
};

class SqliteAdapter implements BackupAdapter {
  readonly kind = "sqlite" as const;

  private constructor(private readonly db: BetterSqlite3Database) {}

  static async create(dbFilePath: string): Promise<SqliteAdapter> {
    const absolutePath = path.resolve(dbFilePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    // Going through SqliteStore guarantees the embedded schema is created
    // and all ensureColumn() shims have run before we touch the file.
    const { SqliteStore } = await import("../db/database.js");
    const store = await SqliteStore.create(absolutePath);
    await store.close();

    const db = new Database(absolutePath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    // Off during raw export/import — we restore data table by table and
    // would otherwise hit FK-order issues. Schema is recreated through the
    // store anyway, so structural integrity is intact.
    db.pragma("foreign_keys = OFF");
    return new SqliteAdapter(db);
  }

  async schemaVersion(): Promise<number> {
    // SqliteStore doesn't track versions — its embedded migrate() always
    // runs the full schema. Report the highest known version.
    return MIGRATIONS.reduce((acc, m) => Math.max(acc, m.version), 0);
  }

  async selectAll(table: string): Promise<Record<string, unknown>[]> {
    // rowid order, so an import (which inserts in file order) keeps insertion order: the audit chain walks rowid.
    const rows = this.db.prepare(`SELECT rowid AS ${ROWID_KEY}, * FROM ${quoteIdent(table)} ORDER BY rowid`).all() as Record<string, unknown>[];
    if (table === "audit_logs") {
      // Audit text exactly as stored, as verify reads it: a lone surrogate that better-sqlite3 on Node 20 kept as
      // generalized UTF-8 reads through the driver as three U+FFFD, which would make the restored row unverifiable.
      // Read exactly, it is the surrogate, which the JSON backup keeps as its `\ud800` escape.
      exactSqliteTextRows(this.db, table, rows, SQLITE_AUDIT_TEXT_COLUMNS, ROWID_KEY);
    }
    for (const row of rows) delete row[ROWID_KEY];
    return rows;
  }

  async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const insertMany = this.db.transaction((batch: Record<string, unknown>[]) => {
      for (const row of batch) {
        stmt.run(...cols.map((c) => normalizeForSqlite(row[c])));
      }
    });
    insertMany(rows);
  }

  async truncate(table: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresAdapter implements BackupAdapter {
  readonly kind = "postgres" as const;

  private readonly generatedColumns = new Map<string, ReadonlySet<string>>();

  private constructor(private readonly pool: Pool) {}

  /**
   * Generated columns of `table` (`GENERATED ALWAYS AS (...) STORED`, e.g. knowledge_base_chunks.content_tsv), read
   * from the catalog. Postgres refuses a value for them, and recomputes them from the row, so a backup leaves them out
   * and an import drops them from a backup that carries them. Identity columns (`seq`) are not generated columns here
   * (is_generated = 'NEVER'); they are restored as above.
   */
  private async generatedColumnsOf(table: string): Promise<ReadonlySet<string>> {
    const cached = this.generatedColumns.get(table);
    if (cached) return cached;
    const r = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'ALWAYS'`,
      [table]
    );
    const columns = new Set(r.rows.map((row) => row.column_name));
    this.generatedColumns.set(table, columns);
    return columns;
  }

  static async create(): Promise<PostgresAdapter> {
    const pool = new Pool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings(process.env)), { max: 4 }));
    try {
      // Under the migrations lock, like a booting instance, so a restore and a boot never run the chain together.
      await withMigrationLock(pool, undefined, (client) => applyMigrationChain(client));
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    return new PostgresAdapter(pool);
  }

  async schemaVersion(): Promise<number> {
    const r = await this.pool.query<{ version: string | number | null }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`
    );
    const v = r.rows[0]?.version;
    return typeof v === "number" ? v : Number(v ?? 0);
  }

  async selectAll(table: string): Promise<Record<string, unknown>[]> {
    const order = SEQ_TABLES.has(table) ? " ORDER BY seq" : "";
    const generated = await this.generatedColumnsOf(table);
    const r = await this.pool.query(`SELECT * FROM ${quoteIdent(table)}${order}`);
    const rows = r.rows as Record<string, unknown>[];
    if (generated.size === 0) return rows;
    return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => !generated.has(column))));
  }

  async insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const generated = await this.generatedColumnsOf(table);
    const cols = Object.keys(rows[0]).filter((column) => !generated.has(column));
    const colSql = cols.map(quoteIdent).join(", ");
    const keepsSeq = SEQ_TABLES.has(table) && cols.includes("seq");
    const overriding = keepsSeq ? " OVERRIDING SYSTEM VALUE" : "";
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const valuesSql = batch
        .map((_, rowIdx) => {
          const start = rowIdx * cols.length;
          return `(${cols.map((_, j) => `$${start + j + 1}`).join(", ")})`;
        })
        .join(", ");
      const params = batch.flatMap((row) => cols.map((c) => row[c] ?? null));
      await this.pool.query(`INSERT INTO ${quoteIdent(table)} (${colSql})${overriding} VALUES ${valuesSql}`, params);
    }
    if (keepsSeq) {
      // The restored rows carry their own seq; the next insert must get max + 1, not a value the identity already
      // handed out before the import (or one a restored row now holds).
      await this.pool.query(
        `SELECT setval(pg_get_serial_sequence($1, 'seq'), COALESCE((SELECT MAX(seq) FROM ${quoteIdent(table)}), 0) + 1, false)`,
        [table]
      );
    }
  }

  async truncate(table: string): Promise<void> {
    // CASCADE because the importer truncates every table; FK chains would
    // otherwise force a topological order we don't want to maintain.
    await this.pool.query(`TRUNCATE TABLE ${quoteIdent(table)} CASCADE`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function openBackupAdapter(): Promise<BackupAdapter> {
  const dbType = process.env.DB_TYPE?.toLowerCase();
  if (dbType === "postgres" || dbType === "postgresql") {
    return PostgresAdapter.create();
  }
  const dbFilePath = process.env.DB_SQLITE_PATH ?? "./data/orchestrator.db";
  return SqliteAdapter.create(dbFilePath);
}

function quoteIdent(name: string): string {
  // Identifiers come from a hardcoded allowlist (EXPORTED_TABLES + their
  // column names from the dump). Still quote defensively to make the SQL
  // explicit and to handle any reserved-word collisions.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote suspicious identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * better-sqlite3 only binds null/number/string/bigint/Buffer. JSON column
 * values arrive from the JSON dump as nested objects/arrays; serialize them
 * back to TEXT here. Booleans become 0/1.
 */
function normalizeForSqlite(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && !(value instanceof Buffer) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}
