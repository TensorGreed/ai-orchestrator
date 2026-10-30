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
import type { Pool, PoolClient } from "pg";
import { parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { applyMigrationChain, postgresPoolConfig, withMigrationLock } from "../db/postgres-store.js";
import { createPostgresPool } from "../db/postgres/pool.js";
import { ALL_INSERTION_SEQ_TABLES, MIGRATIONS } from "../db/migrations.js";
import {
  exactSqliteTextRows,
  iterateSqliteAuditChainRows,
  SQLITE_AUDIT_TEXT_COLUMNS,
  verifyAuditRows,
  type AuditCanonicalInput,
  type AuditChainResult
} from "../db/audit-chain.js";
import {
  auditVerdictFromRecord,
  auditVerdictRecord,
  restoredAuditProblems,
  unverifiableOnPostgresBySource,
  verdictText,
  verifyPostgresAuditChainByCursor,
  type AuditVerdictRecord
} from "./audit-carry-over.js";

/** The rowid alias SqliteAdapter.selectAll reads beside `*` (no table has a column of that name). */
const ROWID_KEY = "__backup_rowid";

/**
 * Tables that carry v40's `seq` identity on Postgres (insertion order). A Postgres backup keeps `seq`: export reads
 * them in `seq` order, import writes `seq` back (OVERRIDING SYSTEM VALUE, since the identity is GENERATED ALWAYS) and
 * then moves the identity past the restored max, so the chain and cursors walk the restored rows in the same order.
 */
const SEQ_TABLES: ReadonlySet<string> = new Set(ALL_INSERTION_SEQ_TABLES.map(({ table }) => table));

export interface BackupAdapter {
  readonly kind: "sqlite" | "postgres";
  schemaVersion(): Promise<number>;
  selectAll(table: string): Promise<Record<string, unknown>[]>;
  insertRows(table: string, rows: Record<string, unknown>[]): Promise<void>;
  truncate(table: string): Promise<void>;
  /** Rows currently in `table` (inside the transaction, when one is open). */
  countRows(table: string): Promise<number>;
  /** audit_logs rows the chain walks (entry_hash set); unchained pre-Phase-8.4 rows do not count. */
  countChainedAuditRows(): Promise<number>;
  /**
   * Runs `fn` in one transaction: every read sees one snapshot (`readOnly`, for db:export), or every write commits
   * together and a throw rolls all of them back (db:import).
   */
  transaction<T>(fn: () => Promise<T>, options?: { readOnly?: boolean }): Promise<T>;
  /** The audit chain's verdict as this store's verifyAuditChain gives it (inside the transaction, when one is open). */
  verifyAuditChain(): Promise<AuditChainResult>;
  close(): Promise<void>;
}

/**
 * Tables exported by db:export: every table that holds data a restored instance needs. Anything truly transient
 * (NOT_EXPORTED_TABLES: caches, replay windows, leader leases, cluster liveness, log stream delivery history) is
 * intentionally skipped — restoring those would either be wrong (resume an expired lease) or pointless (caches
 * refill on demand).
 *
 * `schema_migrations` is also skipped: the importer ensures the destination
 * is at the right version via runMigrations, then writes data on top.
 *
 * Order matters on Postgres, where foreign keys are checked as rows go in: parents (users, projects) come before the
 * tables that reference them. db-backup-coverage.test.ts (SQLite) and db-backup-postgres.test.ts check that every
 * table of the live schema is listed here or in NOT_EXPORTED_TABLES, so a new table cannot be left out of backups
 * unnoticed.
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
  "audit_logs",
  // Phase 13.1 — everything else a restored instance needs (db:export wrote only the tables above before).
  // Approvals and releases
  "approval_requests",
  "workflow_releases",
  "release_gates",
  "release_approval_requests",
  "gate_case_requests",
  // MCP registry, gateway, policy and history
  "mcp_servers",
  "mcp_server_catalogs",
  "mcp_server_probes",
  "mcp_tool_snapshots",
  "mcp_tool_classifications",
  "mcp_tool_policies",
  "mcp_toolsets",
  "mcp_toolset_members",
  "mcp_clients",
  "mcp_oauth_connections",
  "mcp_user_oauth_connections",
  "mcp_elicitations",
  "mcp_tool_calls",
  "mcp_gateway_approvals",
  "mcp_policy_suggestions",
  "mcp_cassettes",
  // Guard
  "guard_profiles",
  "guard_profile_versions",
  "guard_bindings",
  "guard_events",
  "guard_simulations",
  "guard_token_vault",
  "data_destinations",
  // Knowledge bases (SQLite's full-text index is rebuilt from the chunks by its triggers; Postgres computes its own)
  "knowledge_bases",
  "knowledge_base_chunks",
  // Evals, replay and capture
  "eval_datasets",
  "eval_fixtures",
  "eval_runs",
  "eval_results",
  "replay_capture_settings",
  "replay_recordings",
  // Audit export and signed run manifests
  "audit_signing_keys",
  "execution_manifests",
  "audit_export_destinations",
  "audit_export_runs",
  // Usage and budgets
  "usage_events",
  "budgets",
  "budget_alerts"
] as const;

/** Tables db:export leaves out on purpose, and why (the runbook lists them as safe to lose). */
export const NOT_EXPORTED_TABLES: Record<string, string> = {
  schema_migrations: "the importer migrates the destination itself",
  schema_markers: "written by the SQLite store as it creates the schema",
  sessions: "live sign-in sessions: a backup would carry working session ids, and users simply sign in again",
  pending_challenges: "short-lived sign-in and MCP OAuth state, sealed with the master key, expires in minutes",
  rate_limit_buckets: "rate-limit counters",
  capture_reservations: "short-lived production-capture reservations",
  session_tool_cache: "cache, refilled on demand",
  external_secret_cache: "cache of external secret values, refilled on demand",
  webhook_idempotency: "short replay window for webhook idempotency keys",
  webhook_replay_keys: "short replay window for signed webhooks",
  leader_leases: "leader election lease, taken again at start",
  cluster_instances: "liveness of running instances",
  cluster_run_owners: "which live instance runs a run",
  log_stream_events: "log stream delivery history",
  guard_profile_revision: "a change counter the guard tables' triggers bump; caches only compare it",
  knowledge_base_chunks_fts: "SQLite full-text index, rebuilt from knowledge_base_chunks",
  knowledge_base_chunks_fts_config: "SQLite full-text index storage",
  knowledge_base_chunks_fts_data: "SQLite full-text index storage",
  knowledge_base_chunks_fts_docsize: "SQLite full-text index storage",
  knowledge_base_chunks_fts_idx: "SQLite full-text index storage"
};

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

/**
 * Columns holding a value sealed with the master key (SecretService.sealValue: `v1.<iv>.<tag>.<ciphertext>`, the
 * purpose bound as authenticated data), which db:import re-seals with --source-master-key. The purpose must match the
 * one the service seals with (guard-service.ts VAULT_PURPOSE; db-backup-coverage.test.ts checks it).
 */
export const SEALED_COLUMNS: Record<string, { column: string; purpose: string }> = {
  guard_token_vault: { column: "value_sealed", purpose: "guard-token-vault" }
};

/**
 * Sealed values inside JSON columns, found by key at any depth (sub-workflow states nest). A paused run's state keeps
 * the approved write-tool results sealed (app.ts sealToolResults, purpose TOOL_RESULTS_PURPOSE): a result that cannot be
 * opened is dropped and the agent asks again, so a key change without re-sealing could run an approved tool twice.
 */
export const JSON_SEALED_FIELDS: ReadonlyArray<{ table: string; column: string; key: string; purpose: string }> = [
  { table: "workflow_executions", column: "state_json", key: "approvedToolResultsSealed", purpose: "approval_tool_results" }
];

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

  async countRows(table: string): Promise<number> {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number | bigint }).n);
  }

  async countChainedAuditRows(): Promise<number> {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE entry_hash IS NOT NULL`).get() as { n: number | bigint }).n);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // One connection, so the writes inside (insertRows' own transactions become savepoints) commit or roll back together.
    this.db.exec("BEGIN");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async verifyAuditChain(): Promise<AuditChainResult> {
    // As SqliteStore.verifyAuditChain reads it (text exact), in rowid batches.
    return verifyAuditRows(iterateSqliteAuditChainRows(this.db));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class PostgresAdapter implements BackupAdapter {
  readonly kind = "postgres" as const;

  private readonly generatedColumns = new Map<string, ReadonlySet<string>>();
  /** The transaction's connection while transaction() runs; every query goes through it then. */
  private client: PoolClient | undefined;

  private constructor(private readonly pool: Pool) {}

  private q<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return (this.client ?? this.pool).query<R>(sql, params);
  }

  /**
   * `fn` under a savepoint while a transaction is open: the callers skip a table that is missing on an old schema,
   * and on Postgres a failed statement would otherwise abort the whole transaction.
   */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.client) return fn();
    await this.client.query("SAVEPOINT backup_table");
    try {
      const result = await fn();
      await this.client.query("RELEASE SAVEPOINT backup_table");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK TO SAVEPOINT backup_table");
      throw error;
    }
  }

  /**
   * Generated columns of `table` (`GENERATED ALWAYS AS (...) STORED`, e.g. knowledge_base_chunks.content_tsv), read
   * from the catalog. Postgres refuses a value for them, and recomputes them from the row, so a backup leaves them out
   * and an import drops them from a backup that carries them. Identity columns (`seq`) are not generated columns here
   * (is_generated = 'NEVER'); they are restored as above.
   */
  private async generatedColumnsOf(table: string): Promise<ReadonlySet<string>> {
    const cached = this.generatedColumns.get(table);
    if (cached) return cached;
    const r = await this.q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND is_generated = 'ALWAYS'`,
      [table]
    );
    const columns = new Set(r.rows.map((row) => row.column_name));
    this.generatedColumns.set(table, columns);
    return columns;
  }

  static async create(): Promise<PostgresAdapter> {
    const pool = createPostgresPool(postgresPoolConfig(postgresStoreConfig(parsePostgresSettings(process.env)), { max: 4 }), { label: "db:import/export" });
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
    const r = await this.q<{ version: string | number | null }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`
    );
    const v = r.rows[0]?.version;
    return typeof v === "number" ? v : Number(v ?? 0);
  }

  async selectAll(table: string): Promise<Record<string, unknown>[]> {
    const order = SEQ_TABLES.has(table) ? " ORDER BY seq" : "";
    const generated = await this.generatedColumnsOf(table);
    const r = await this.guarded(() => this.q(`SELECT * FROM ${quoteIdent(table)}${order}`));
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
      await this.q(`INSERT INTO ${quoteIdent(table)} (${colSql})${overriding} VALUES ${valuesSql}`, params);
    }
    if (keepsSeq) {
      // The restored rows carry their own seq; the next insert must get max + 1, not a value the identity already
      // handed out before the import (or one a restored row now holds).
      await this.q(
        `SELECT setval(pg_get_serial_sequence($1, 'seq'), COALESCE((SELECT MAX(seq) FROM ${quoteIdent(table)}), 0) + 1, false)`,
        [table]
      );
    }
  }

  async truncate(table: string): Promise<void> {
    // CASCADE because the importer truncates every table; FK chains would
    // otherwise force a topological order we don't want to maintain.
    await this.guarded(() => this.q(`TRUNCATE TABLE ${quoteIdent(table)} CASCADE`));
  }

  async transaction<T>(fn: () => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
    if (this.client) throw new Error("db backup: transactions do not nest.");
    const client = await this.pool.connect();
    try {
      await client.query(options.readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      this.client = client;
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      this.client = undefined;
      client.release();
    }
  }

  async countRows(table: string): Promise<number> {
    // Guarded: a caller may skip a table missing on an old schema without aborting the open transaction.
    const r = await this.guarded(() => this.q<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`));
    return Number(r.rows[0]?.n ?? 0);
  }

  async countChainedAuditRows(): Promise<number> {
    const r = await this.q<{ n: string | number }>(`SELECT COUNT(*) AS n FROM audit_logs WHERE entry_hash IS NOT NULL`);
    return Number(r.rows[0]?.n ?? 0);
  }

  async verifyAuditChain(): Promise<AuditChainResult> {
    // A cursor needs a transaction: inside the caller's when one is open, else a read-only one of its own.
    if (this.client) return verifyPostgresAuditChainByCursor(this.client);
    return this.transaction(() => verifyPostgresAuditChainByCursor(this.client!), { readOnly: true });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The backup file, and the audit verdict it records

export interface BackupDump {
  format: "ai-orchestrator-backup";
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  dbType: "sqlite" | "postgres";
  /**
   * The source's audit-chain verdict when audit_logs was exported (absent in backups written before it was recorded,
   * and with --exclude-history). db:import compares the restored chain with it.
   */
  auditVerdict?: AuditVerdictRecord;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * Reads a backup from `adapter` in one read transaction (one snapshot: the recorded verdict is the verdict of the rows
 * exported). Tables missing on an old schema are recorded empty, with a warning.
 */
export async function exportDump(
  adapter: BackupAdapter,
  options: { excludeHistory?: boolean; log?: (line: string) => void; warn?: (line: string) => void } = {}
): Promise<BackupDump> {
  const log = options.log ?? (() => undefined);
  const warn = options.warn ?? log;
  const targetTables = options.excludeHistory
    ? EXPORTED_TABLES.filter((t) => !(HISTORY_TABLES as readonly string[]).includes(t))
    : (EXPORTED_TABLES as readonly string[]);
  return adapter.transaction(
    async () => {
      const schemaVersion = await adapter.schemaVersion();
      const tables: Record<string, Record<string, unknown>[]> = {};
      for (const table of targetTables) {
        try {
          const rows = await adapter.selectAll(table);
          tables[table] = rows;
          log(`  ${table}: ${rows.length} rows`);
        } catch (err) {
          // A table may be missing on an old schema where this build never wrote it. Don't fail the whole export:
          // record an empty list and warn so the operator can investigate if it matters.
          warn(`  ${table}: skipped (${err instanceof Error ? err.message : String(err)})`);
          tables[table] = [];
        }
      }
      let auditVerdict: AuditVerdictRecord | undefined;
      if (targetTables.includes("audit_logs")) {
        const verdict = await adapter.verifyAuditChain();
        auditVerdict = auditVerdictRecord(verdict);
        log(`  audit chain: ${verdictText(verdict)} (recorded in the backup)`);
      }
      return {
        format: "ai-orchestrator-backup" as const,
        formatVersion: 1 as const,
        schemaVersion,
        exportedAt: new Date().toISOString(),
        dbType: adapter.kind,
        ...(auditVerdict ? { auditVerdict } : {}),
        tables
      };
    },
    { readOnly: true }
  );
}

/** audit_logs columns → the canonical fields the rule reads (free text only matters). */
const AUDIT_FIELD_COLUMNS: Record<keyof AuditCanonicalInput, string> = {
  id: "id", createdAt: "created_at", eventType: "event_type", category: "category", action: "action", outcome: "outcome",
  actorUserId: "actor_user_id", actorEmail: "actor_email", actorType: "actor_type", resourceType: "resource_type",
  resourceId: "resource_id", projectId: "project_id", ipAddress: "ip_address", userAgent: "user_agent",
  metadataJson: "metadata_json", message: "message"
};

/** Ids of backup audit rows whose own text explains becoming unverifiable when restored (see audit-carry-over.ts). */
function explainedAuditRows(rows: Record<string, unknown>[]): Set<string> {
  const explained = new Set<string>();
  for (const row of rows) {
    const fields = Object.fromEntries(
      Object.entries(AUDIT_FIELD_COLUMNS).map(([field, column]) => [field, typeof row[column] === "string" ? row[column] : row[column] == null ? null : String(row[column])])
    ) as unknown as AuditCanonicalInput;
    if (unverifiableOnPostgresBySource(fields)) explained.add(String(row.id));
  }
  return explained;
}

/** A restore the backup's recorded audit verdict refuses (rolled back). */
export class AuditVerdictMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditVerdictMismatch";
  }
}

/** A restore db:import refuses before writing anything (exit code 2): the destination already holds data. */
export class ImportRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusal";
  }
}

export interface ImportOptions {
  /** Add the backup's rows to what the destination holds (best-effort; a conflicting row aborts the import). */
  merge?: boolean;
  /**
   * Replace everything the destination holds with the backup: every exported table is emptied, including ones the
   * backup does not hold (an older db:export wrote fewer tables), so the result is exactly the backup. Without it (or
   * `merge`), a destination that holds any exported row is refused.
   */
  replace?: boolean;
  /**
   * Restore even though the restored audit chain's verdict differs from the one the backup recorded (refused by
   * default, rolled back). Both verdicts are logged and the report carries `audit.changedWarning`.
   */
  allowAuditChange?: boolean;
  /** Rows of a table as they go in (db:import re-encrypts secrets here); returns the rows and how many were changed. */
  prepare?: (table: string, rows: Record<string, unknown>[]) => { rows: Record<string, unknown>[]; touched: number };
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** What an import did to one exported table. */
export interface ImportTableReport {
  table: string;
  /** restored: written from the backup; emptied: not in the backup, emptied; untouched: not in the backup (merge). */
  action: "restored" | "emptied" | "untouched";
  rows: number;
}

export interface ImportReport {
  totalInserted: number;
  totalTouched: number;
  tables: ImportTableReport[];
  /** The restored chain's verdict (when audit_logs was restored), and the rows that became unverifiable as allowed. */
  audit?: {
    restored: AuditChainResult;
    recorded?: AuditVerdictRecord;
    becameUnverifiable: string[];
    /** Set when `allowAuditChange` let a changed verdict through: the line to print last. */
    changedWarning?: string;
  };
}

/**
 * Tables an exact restore (anything but `merge`) also empties although no backup holds them: live sign-in sessions
 * of the destination must not outlive a restore, so everyone signs in again (Postgres's TRUNCATE ... CASCADE from
 * `users` would empty them anyway; SQLite's DELETE does not cascade).
 */
export const EMPTIED_ON_RESTORE_TABLES = ["sessions"] as const;

/** Whether `error` says the table does not exist (SQLite "no such table", Postgres 42P01), and nothing else. */
export function isMissingTableError(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === "42P01") return true;
  return error instanceof Error && /no such table/i.test(error.message);
}

/**
 * Exported tables that hold rows in the destination. A table missing on an old schema counts as empty; any other
 * error fails the check, so a destination is never taken for empty because it could not be read.
 */
async function tablesWithRows(adapter: BackupAdapter): Promise<Array<{ table: string; rows: number }>> {
  const held: Array<{ table: string; rows: number }> = [];
  for (const table of EXPORTED_TABLES) {
    let rows = 0;
    try {
      rows = await adapter.countRows(table);
    } catch (error) {
      if (!isMissingTableError(error)) {
        throw new Error(`Cannot tell whether the destination is empty: counting ${table} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rows > 0) held.push({ table, rows });
  }
  return held;
}

/**
 * Restores `dump` into `adapter` in one transaction. By default the destination must hold no exported row (a database
 * the importer just created, or one an API never started on); `replace` empties every exported table first, so the
 * result is exactly the backup (tables an older backup does not hold end up empty, and the log says so); `merge`
 * adds the rows. When the backup recorded its audit verdict, the restored chain is
 * verified before committing and must give the same verdict, except rows the rule allows to become unverifiable
 * (two or more U+FFFD once characters this store cannot keep become U+FFFD); otherwise everything rolls back.
 * A backup without a recorded verdict (older db:export) restores as before, with a note.
 */
export async function importDump(adapter: BackupAdapter, dump: BackupDump, options: ImportOptions = {}): Promise<ImportReport> {
  const log = options.log ?? (() => undefined);
  const warn = options.warn ?? log;
  const restoresAudit = (dump.tables.audit_logs?.length ?? 0) > 0 || dump.auditVerdict !== undefined;
  if (options.merge && options.replace) throw new ImportRefusal("--merge and --replace together: choose one.");
  return adapter.transaction(async () => {
    if (!options.merge && !options.replace) {
      const held = await tablesWithRows(adapter);
      if (held.length > 0) {
        const listed = held.slice(0, 6).map(({ table, rows }) => `${table}: ${rows}`).join(", ");
        throw new ImportRefusal(
          `The destination already holds data (${listed}${held.length > 6 ? `, and ${held.length - 6} more tables` : ""}). ` +
            `db:import restores into an empty database: restore before the first start of the API, or pass --replace to ` +
            `replace everything in it with the backup (every exported table is emptied first, including ones the backup ` +
            `does not hold). Nothing was changed.`
        );
      }
    }
    // A merge into an audit log with no chained rows (the chain walks only those) restores the whole chain, so it is compared like a plain restore.
    const auditWasEmpty = !options.merge || !restoresAudit || (await adapter.countChainedAuditRows()) === 0;
    if (!options.merge) {
      // Every exported table, so nothing of what the destination held survives next to the backup (and rows a
      // migration seeded are replaced by the backup's), and the destination's sessions. Reverse order, so a later
      // non-cascading SQLite delete doesn't hit a parent before its children (CASCADE on Postgres makes this moot).
      // A table that cannot be emptied fails the restore (rolled back): the log must never call a table emptied, or
      // the result the backup, while old rows are left in it.
      for (const table of [...EMPTIED_ON_RESTORE_TABLES, ...[...EXPORTED_TABLES].reverse()]) {
        try {
          await adapter.truncate(table);
        } catch (err) {
          throw new Error(`Failed to empty ${table} before the restore: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const table of EMPTIED_ON_RESTORE_TABLES) log(`  ${table}: emptied (never in a backup: everyone signs in again)`);
    }
    let totalInserted = 0;
    let totalTouched = 0;
    const tables: ImportTableReport[] = [];
    const notInBackup: string[] = [];
    for (const table of EXPORTED_TABLES) {
      const rows = dump.tables[table];
      if (!rows) {
        const action = options.merge ? "untouched" : "emptied";
        tables.push({ table, action, rows: 0 });
        notInBackup.push(table);
        log(`  ${table}: ${action} (not in the backup)`);
        continue;
      }
      if (rows.length === 0) {
        tables.push({ table, action: "restored", rows: 0 });
        log(`  ${table}: restored, 0 rows`);
        continue;
      }
      const { rows: prepared, touched } = options.prepare ? options.prepare(table, rows) : { rows, touched: 0 };
      try {
        await adapter.insertRows(table, prepared);
      } catch (err) {
        throw new Error(`Failed to insert into ${table}: ${err instanceof Error ? err.message : String(err)}`);
      }
      totalInserted += prepared.length;
      totalTouched += touched;
      tables.push({ table, action: "restored", rows: prepared.length });
      log(`  ${table}: restored, ${prepared.length} rows${touched > 0 ? ` (${touched} re-encrypted)` : ""}`);
    }
    if (notInBackup.length > 0) {
      warn(
        `Note: the backup does not hold ${notInBackup.length} table(s) this build exports (${notInBackup.slice(0, 8).join(", ")}` +
          `${notInBackup.length > 8 ? ", …" : ""}): it was written by an older db:export or with --exclude-history. ` +
          (options.merge ? "They were left as they were." : "They are empty now.")
      );
    }
    if (!restoresAudit) return { totalInserted, totalTouched, tables };

    const restored = await adapter.verifyAuditChain();
    if (!dump.auditVerdict) {
      log(
        `Note: this backup does not record its audit-chain verdict (written by an older db:export), so the restored chain ` +
          `is not compared with it. Restored audit chain: ${verdictText(restored)}.`
      );
      return { totalInserted, totalTouched, tables, audit: { restored, becameUnverifiable: [] } };
    }
    if (!auditWasEmpty) {
      log(
        `Note: --merge keeps the audit rows already in the database, so the audit verdict was not compared with the ` +
          `backup's (${verdictText(auditVerdictFromRecord(dump.auditVerdict))}). Restored audit chain: ${verdictText(restored)}.`
      );
      return { totalInserted, totalTouched, tables, audit: { restored, recorded: dump.auditVerdict, becameUnverifiable: [] } };
    }
    const recorded = auditVerdictFromRecord(dump.auditVerdict);
    const { problems, becameUnverifiable } = restoredAuditProblems(recorded, restored, explainedAuditRows(dump.tables.audit_logs ?? []));
    if (problems.length > 0 && options.allowAuditChange) {
      const changedWarning =
        `WARNING: the restored audit chain differs from the backup's recorded verdict (--allow-audit-change): ` +
        `before (backup) ${verdictText(recorded)}, after (restored) ${verdictText(restored)}; ${problems.join("; ")}. ` +
        `Treat the chain as unproven and keep the backup file as the record.`;
      log(`Audit chain before (backup): ${verdictText(recorded)}. After (restored): ${verdictText(restored)}.`);
      return { totalInserted, totalTouched, tables, audit: { restored, recorded: dump.auditVerdict, becameUnverifiable, changedWarning } };
    }
    if (problems.length > 0) {
      throw new AuditVerdictMismatch(
        `The restored audit chain does not match the backup's recorded verdict (${verdictText(recorded)}): ${problems.join("; ")}. ` +
          `Nothing was restored (rolled back). Restore on the same kind of store and Node version that wrote the backup, ` +
          `investigate the backup file, or pass --allow-audit-change to restore anyway.`
      );
    }
    log(`Audit chain: ${verdictText(restored)}, as the backup recorded (${verdictText(recorded)}).`);
    if (becameUnverifiable.length > 0) {
      log(
        `Note: ${becameUnverifiable.length} audit row(s) verified in the backup cannot be verified after the restore ` +
          `(${becameUnverifiable.slice(0, 8).join(", ")}${becameUnverifiable.length > 8 ? ", …" : ""}): each holds two or more U+FFFD once ` +
          `U+0000 and lone surrogates (which this store cannot keep) become U+FFFD. Keep the backup file as the record for them.`
      );
    }
    return { totalInserted, totalTouched, tables, audit: { restored, recorded: dump.auditVerdict, becameUnverifiable } };
  });
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
