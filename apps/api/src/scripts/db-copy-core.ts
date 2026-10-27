/**
 * Phase 13.1 — db:copy: moves a SQLite database into an empty Postgres database (the CLI is db-copy.ts).
 *
 * What it does, in order:
 *  1. Source: opens the SQLite file read-only, inside one read transaction (a consistent snapshot), and compares its
 *     schema with the one this build's SqliteStore creates: tables and columns, indexes (name, unique, key columns,
 *     partial), triggers (names) and the schema_markers rows the store writes. Older (something missing): refused,
 *     start this build once against the file to upgrade it. Newer (something this build does not know): refused, run
 *     db:copy from the build that wrote it. A same-named index defined differently is refused with both hints.
 *  2. Target: everything runs on one connection holding the migrations advisory lock (withMigrationLock), so an API
 *     instance starting against the target waits until the copy has committed or rolled back. An empty database with
 *     no applied migrations is migrated first through the normal chain (applyMigrationChain, as PostgresStore does at
 *     boot). A database whose applied version is not this build's (MIGRATIONS' highest) is refused; so is one with any
 *     user or workflow row, or with rows a table's migration did not put there (rows whose primary key the source does
 *     not hold).
 *  3. Mapping: derived from the two live schemas, never from a hand list. Every source table and column must exist on
 *     the target. The only target-only objects allowed are the ones the schema-parity allow-list documents for
 *     copying: `schema_migrations`, `GENERATED ALWAYS AS (…) STORED` columns (knowledge_base_chunks.content_tsv, which
 *     Postgres computes), and the `seq` identity of INSERTION_SEQ_TABLES (the stand-in for SQLite's rowid, assigned by
 *     the identity as rows are copied in rowid order). Anything else fails loudly.
 *  4. Copy: tables in foreign-key order (parents first), each read in rowid order in batches and written with
 *     multi-row INSERTs, all in **one transaction**. Values are converted to the target column's type the way the
 *     Postgres store writes them: text through the store's parameter mapping (U+0000 → U+FFFD, pgParams), timestamps
 *     as SQLite holds them (ISO strings, read in UTC; an empty string is NULL, as the SQLite store already reads it),
 *     integers (a fractional value is rounded, as Postgres casts numeric to integer, and reported), booleans, JSON
 *     text verbatim. Audit text is read exactly as verify reads it (exactSqliteTextRows: a lone surrogate that
 *     better-sqlite3 on Node 20 kept as generalized UTF-8 is that surrogate, not three U+FFFD) and is not
 *     re-normalised. Secrets are copied as ciphertext / iv / auth tag, never decrypted.
 *  5. Audit chain, before anything is written: the source verdict is computed on SQLite from the exact stored bytes.
 *     - Source broken: refused (name the row; investigate, or db:export first). With `allowBrokenAudit` the copy goes
 *       on, and the summary says (also as its last line) that the target's verdict cannot be trusted to show the break;
 *       the target is never reported as intact then. The rule below still holds for the rows before the break.
 *     - Otherwise (ok, or rows that cannot be verified), predicted from the source rows as Postgres stores them (lone
 *       surrogates and U+0000 become U+FFFD): every row SQLite verified must verify on Postgres, or may be unverifiable
 *       there only if the source row itself holds a character Postgres cannot store and, once those become U+FFFD,
 *       two or more U+FFFD (too many candidates to try; computed from the source row, never inferred from the target).
 *       Rows unverifiable on SQLite must stay unverifiable. Anything else is refused.
 *  6. Verify, inside the same transaction, before COMMIT: per-table row counts, a per-table checksum over primary keys
 *     (order-independent), for seq tables the order (source rowid order = target seq order), and the audit chain on
 *     Postgres: it must give exactly the predicted verdict and meet the rule above. Then sequences are moved past the
 *     copied values and the transaction commits; anything that does not verify rolls back.
 *
 * Why one transaction (not one per table): a failed copy leaves the target exactly as it was (migrated and empty),
 * so it can simply be re-run, and a copy that does not verify is never committed. Postgres has no transaction size
 * limit beyond disk for WAL; the target is not in use during the copy (the advisory lock holds back API starts).
 */
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  AuditChainWalker,
  exactSqliteTextRows,
  iterateSqliteAuditChainRows,
  LEGACY_TEXT_FIELDS,
  SQLITE_AUDIT_TEXT_COLUMNS,
  verifyAuditRows,
  wellFormedAuditText,
  type AuditCanonicalInput,
  type AuditChainResult,
  type AuditChainRow
} from "../db/audit-chain.js";
import { SqliteStore } from "../db/database.js";
import { INSERTION_SEQ_TABLES, MIGRATIONS } from "../db/migrations.js";
import { pgParams } from "../db/postgres/context.js";
import { describePostgresSettings, isPostgresDbType, parsePostgresSettings } from "../config.js";
import { postgresStoreConfig } from "../db/create-store.js";
import { loadApiEnvFiles, resolveSettingOrigins, type SettingOrigin } from "./api-env.js";
import { auditCarryOver, brokenPosition, unverifiableOnPostgresBySource, verdictText, verifyPostgresAuditChainByCursor } from "./audit-carry-over.js";
import { applyMigrationChain, currentChainVersion, postgresPoolConfig, withMigrationLock, type PostgresStoreConfig } from "../db/postgres-store.js";

/** The chain version this build migrates to (whatever MIGRATIONS' highest is; never a fixed number). */
export const CODE_SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

const SEQ_TABLES: ReadonlySet<string> = new Set(INSERTION_SEQ_TABLES.map(({ table }) => table));
const DEFAULT_BATCH_ROWS = 500;
/** Postgres binds at most 65535 parameters per statement. */
const MAX_PARAMS = 60_000;

/** A reason not to copy (exit code 2): nothing was written. */
export class DbCopyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbCopyRefusal";
  }
}

export interface DbCopyOptions {
  /** The SQLite file to copy from. */
  sqlitePath: string;
  /** The target (validated settings; `schema` only in tests). */
  postgres: PostgresStoreConfig;
  /** Report counts and refusals; write nothing. */
  dryRun?: boolean;
  /**
   * Copy even though the SQLite audit chain is broken (refused by default). The summary then says the target's
   * verdict cannot be trusted to show the break.
   */
  allowBrokenAudit?: boolean;
  /** Where DB_SQLITE_PATH / DB_TYPE come from, so the "start this build once" hint works with apps/api/.env. */
  settingOrigins?: SettingOrigins;
  /** Rows per INSERT (default 500, fewer for wide tables). */
  batchRows?: number;
  log?: (line: string) => void;
}

export interface DbCopyTableReport {
  table: string;
  rows: number;
  /** Rows a migration had put in the target table, replaced by the source's (e.g. schema_markers). */
  replacedSeedRows: number;
  /** Fractional values written to integer columns, rounded (column → count). */
  rounded: Record<string, number>;
}

export interface DbCopyReport {
  dryRun: boolean;
  schemaVersion: number;
  /** The target had no applied migrations, so this run migrated it (a dry run rehearses it and rolls back). */
  migratedTarget: boolean;
  tables: DbCopyTableReport[];
  totalRows: number;
  audit: {
    source: AuditChainResult;
    /** The verdict the copied chain must have (the source rows as Postgres stores them). */
    expectedTarget: AuditChainResult;
    /** The copied chain's verdict (not on a dry run). */
    target?: AuditChainResult;
    /**
     * Rows verified on SQLite that cannot be verified on Postgres: each holds a character Postgres cannot store, and two
     * or more U+FFFD once U+0000 and lone surrogates become U+FFFD.
     */
    becameUnverifiable: string[];
    /** Where the SQLite chain was broken (only with allowBrokenAudit): the Postgres verdict cannot be trusted then. */
    sourceBrokenAt?: { id: string; position: number };
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas

interface SqliteTable {
  columns: string[];
}

interface SqliteSchema {
  /** User tables (FTS5 virtual tables, their shadow tables and sqlite_* excluded). */
  tables: Map<string, SqliteTable>;
  /** Named indexes on user tables (sqlite_autoindex_* excluded): a definition string to compare. */
  indexes: Map<string, string>;
  /** Trigger names. */
  triggers: Set<string>;
  /** schema_markers names (rows the store's migrate() writes; a data-only migration records itself there). */
  markers: Set<string>;
}

/** The parts of a SQLite schema db:copy compares with this build's. */
function sqliteSchema(db: BetterSqlite3Database): SqliteSchema {
  const master = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master`).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const virtual = master.filter((row) => row.type === "table" && /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name);
  const internal = (name: string) => name.startsWith("sqlite_") || virtual.some((v) => name === v || name.startsWith(`${v}_`));
  const tables = new Map<string, SqliteTable>();
  const indexes = new Map<string, string>();
  const triggers = new Set<string>();
  for (const row of master) {
    if (row.type === "table" && !internal(row.name)) {
      const columns = (db.prepare(`PRAGMA table_info(${sqliteIdent(row.name)})`).all() as Array<{ name: string }>).map((c) => c.name);
      tables.set(row.name, { columns });
    }
  }
  for (const row of master) {
    if (row.type === "trigger") triggers.add(row.name);
    if (row.type !== "index" || row.name.startsWith("sqlite_autoindex_") || internal(row.tbl_name)) continue;
    const list = db.prepare(`PRAGMA index_list(${sqliteIdent(row.tbl_name)})`).all() as Array<{ name: string; unique: number; partial: number }>;
    const entry = list.find((item) => item.name === row.name);
    const keys = (db.prepare(`PRAGMA index_xinfo(${sqliteIdent(row.name)})`).all() as Array<{ name: string | null; key: number; desc: number }>)
      .filter((column) => column.key === 1)
      .map((column) => `${column.name ?? "<expression>"}${column.desc ? " DESC" : ""}`);
    indexes.set(row.name, `${entry?.unique ? "UNIQUE " : ""}ON ${row.tbl_name} (${keys.join(", ")})${entry?.partial ? " WHERE …" : ""}`);
  }
  const markers = new Set<string>();
  if (tables.has("schema_markers")) {
    for (const { name } of db.prepare(`SELECT name FROM schema_markers`).all() as Array<{ name: string }>) markers.add(name);
  }
  return { tables, indexes, triggers, markers };
}

/** The schema this build's SqliteStore creates (a fresh file in a temp directory, removed afterwards). */
async function codeSqliteSchema(): Promise<SqliteSchema> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-db-copy-schema-"));
  try {
    const file = path.join(dir, "schema.db");
    const store = await SqliteStore.create(file);
    await store.close();
    const db = new Database(file, { readonly: true });
    try {
      return sqliteSchema(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Where DB_SQLITE_PATH and DB_TYPE come from (the CLI resolves them with the API's .env rule). */
export type SettingOrigins = Record<"DB_SQLITE_PATH" | "DB_TYPE", SettingOrigin>;

/**
 * How to start this build once against `sqlitePath`, given where the API reads its settings. apps/api/.env beats the
 * shell, so a shell prefix is ignored when that file sets the variable: the hint then names the file. A DB_TYPE that
 * resolves to postgres would boot the API against the copy target (and bootstrap an admin into it), so it is flagged.
 */
export function upgradeHint(sqlitePath: string, origins?: SettingOrigins): string {
  const resolved = path.resolve(sqlitePath);
  const settings: string[] = [];
  const shell: string[] = [];
  const pathOrigin = origins?.DB_SQLITE_PATH;
  if (pathOrigin?.source === "apps/api/.env") {
    if (pathOrigin.value === undefined || path.resolve(pathOrigin.value) !== resolved) {
      settings.push(`DB_SQLITE_PATH=${sqlitePath} in apps/api/.env (it sets DB_SQLITE_PATH and beats the shell; put it back afterwards)`);
    }
  } else {
    shell.push(`DB_SQLITE_PATH=${sqlitePath}`);
  }
  const typeOrigin = origins?.DB_TYPE;
  let warning = "";
  if (isPostgresDbType(typeOrigin?.value)) {
    warning =
      ` (WARNING: DB_TYPE resolves to postgres, from ${typeOrigin!.source}, so a start without changing it would boot against the ` +
      `Postgres target db:copy writes to and bootstrap an admin there, and the copy would then refuse the target as non-empty)`;
    if (typeOrigin!.source === "apps/api/.env") settings.push(`DB_TYPE=sqlite in apps/api/.env (it sets DB_TYPE=postgres and beats the shell; put it back afterwards)`);
    else shell.push("DB_TYPE=sqlite");
  }
  const command = `${shell.length > 0 ? `${shell.join(" ")} ` : ""}pnpm --filter @ai-orchestrator/api start`;
  const edit = settings.length > 0 ? `set ${settings.join(" and ")}, then ` : "";
  return `${edit}start this build once against it (${command}, wait for "listening", stop it), then run db:copy again${warning}`;
}

/**
 * Refuses a source whose schema is not this build's: older (boot once to upgrade) or newer (copy from that build).
 * Tables, columns, indexes, triggers and schema markers all count: a migration that only adds a unique index (and
 * dedupes the rows it would refuse) or only transforms data (recording a marker) leaves tables and columns as they were.
 */
function checkSourceSchema(source: SqliteSchema, code: SqliteSchema, sqlitePath: string, origins?: SettingOrigins): void {
  const missing: string[] = [];
  const unknown: string[] = [];
  const differing: string[] = [];
  for (const [table, { columns }] of code.tables) {
    const have = source.tables.get(table);
    if (!have) missing.push(table);
    else for (const column of columns) if (!have.columns.includes(column)) missing.push(`${table}.${column}`);
  }
  for (const [table, { columns }] of source.tables) {
    const known = code.tables.get(table);
    if (!known) unknown.push(table);
    else for (const column of columns) if (!known.columns.includes(column)) unknown.push(`${table}.${column}`);
  }
  for (const [name, definition] of code.indexes) {
    const have = source.indexes.get(name);
    if (have === undefined) missing.push(`index ${name}`);
    else if (have !== definition) differing.push(`index ${name} is ${have} in the file, ${definition} in this build`);
  }
  for (const name of source.indexes.keys()) if (!code.indexes.has(name)) unknown.push(`index ${name}`);
  for (const name of code.triggers) if (!source.triggers.has(name)) missing.push(`trigger ${name}`);
  for (const name of source.triggers) if (!code.triggers.has(name)) unknown.push(`trigger ${name}`);
  for (const name of code.markers) if (!source.markers.has(name)) missing.push(`schema marker ${name}`);
  for (const name of source.markers) if (!code.markers.has(name)) unknown.push(`schema marker ${name}`);
  const upgrade = upgradeHint(sqlitePath, origins);
  if (unknown.length > 0) {
    throw new DbCopyRefusal(
      `The SQLite database has ${unknown.length} schema object(s) this build does not know (${preview(unknown)}): it was written by a newer ` +
        `build. Run db:copy from that build (or a newer one), so nothing is dropped.`
    );
  }
  if (missing.length > 0) {
    throw new DbCopyRefusal(`The SQLite database is older than this build (missing ${preview(missing)}). Upgrade it first: ${upgrade}.`);
  }
  if (differing.length > 0) {
    throw new DbCopyRefusal(
      `The SQLite database's schema differs from this build's (${preview(differing, 4)}). If the file is older, upgrade it first: ${upgrade}. ` +
        `If a newer build wrote it, run db:copy from that build.`
    );
  }
}

interface PgColumn {
  name: string;
  dataType: string;
  notNull: boolean;
  identity: "ALWAYS" | "BY DEFAULT" | null;
  generated: boolean;
}

interface PgTable {
  columns: Map<string, PgColumn>;
  primaryKey: string[];
  /** Tables this one references (foreign keys). */
  references: Set<string>;
  /** Columns backed by a sequence (identity or serial), whose sequence must move past the copied values. */
  sequenceColumns: string[];
}

async function postgresTables(client: PoolClient): Promise<Map<string, PgTable>> {
  const tables = new Map<string, PgTable>();
  const tableRows = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
  );
  for (const { table_name } of tableRows.rows) tables.set(table_name, { columns: new Map(), primaryKey: [], references: new Set(), sequenceColumns: [] });
  const columnRows = await client.query<{
    table_name: string; column_name: string; data_type: string; is_nullable: string; is_identity: string;
    identity_generation: string | null; is_generated: string; column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, is_identity, identity_generation, is_generated, column_default
       FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`
  );
  for (const row of columnRows.rows) {
    const table = tables.get(row.table_name);
    if (!table) continue;
    const identity = row.is_identity === "YES" ? (row.identity_generation === "ALWAYS" ? "ALWAYS" : "BY DEFAULT") : null;
    table.columns.set(row.column_name, {
      name: row.column_name,
      dataType: row.data_type.toLowerCase(),
      notNull: row.is_nullable === "NO",
      identity,
      generated: row.is_generated === "ALWAYS"
    });
    if (identity || /^nextval\(/i.test(row.column_default ?? "")) table.sequenceColumns.push(row.column_name);
  }
  const keyRows = await client.query<{ table_name: string; column_name: string; ord: number }>(
    `SELECT c.relname AS table_name, a.attname AS column_name, k.ord::int AS ord
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND c.relnamespace = current_schema()::regnamespace
      ORDER BY c.relname, k.ord`
  );
  for (const row of keyRows.rows) tables.get(row.table_name)?.primaryKey.push(row.column_name);
  const fkRows = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
      WHERE k.contype = 'f' AND k.connamespace = current_schema()::regnamespace`
  );
  for (const row of fkRows.rows) if (row.child !== row.parent) tables.get(row.child)?.references.add(row.parent);
  return tables;
}

interface TablePlan {
  table: string;
  /** Source columns, all mapped to target columns of the same name. */
  columns: string[];
  target: PgTable;
  seq: boolean;
}

/** The table/column mapping from the two live schemas; throws on anything it cannot map. */
function planTables(source: Map<string, SqliteTable>, target: Map<string, PgTable>): TablePlan[] {
  const problems: string[] = [];
  const plans: TablePlan[] = [];
  for (const [table, { columns }] of source) {
    const pg = target.get(table);
    if (!pg) {
      problems.push(`table ${table} has no Postgres counterpart`);
      continue;
    }
    for (const column of columns) {
      const pgColumn = pg.columns.get(column);
      if (!pgColumn) problems.push(`column ${table}.${column} has no Postgres counterpart`);
      else if (pgColumn.generated || pgColumn.identity === "ALWAYS") problems.push(`column ${table}.${column} is generated on Postgres and cannot be copied`);
    }
    for (const [name, column] of pg.columns) {
      if (columns.includes(name)) continue;
      const seqStandIn = name === "seq" && SEQ_TABLES.has(table) && column.identity === "ALWAYS";
      if (!column.generated && !seqStandIn) problems.push(`Postgres column ${table}.${name} has no SQLite counterpart`);
    }
    if (pg.primaryKey.length === 0) problems.push(`Postgres table ${table} has no primary key (the copy checksums primary keys)`);
    plans.push({ table, columns, target: pg, seq: SEQ_TABLES.has(table) });
  }
  for (const table of target.keys()) {
    if (table !== "schema_migrations" && !source.has(table)) problems.push(`Postgres table ${table} has no SQLite counterpart`);
  }
  if (problems.length > 0) {
    throw new Error(
      `db:copy cannot map the schemas (${problems.length} problem(s)): ${problems.join("; ")}. Both stores should have the same ` +
        `schema at this build (see db/schema-parity.test.ts); this is a bug, please report it.`
    );
  }
  return plans;
}

/** Parents before children (foreign keys), ties by name, so every insert finds its referenced rows. */
function dependencyOrder(plans: TablePlan[]): TablePlan[] {
  const byName = new Map(plans.map((plan) => [plan.table, plan]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: TablePlan[] = [];
  const visit = (plan: TablePlan) => {
    if (done.has(plan.table)) return;
    if (visiting.has(plan.table)) throw new Error(`db:copy: foreign keys form a cycle through ${plan.table}.`);
    visiting.add(plan.table);
    for (const parent of [...plan.target.references].sort()) {
      const parentPlan = byName.get(parent);
      if (parentPlan) visit(parentPlan);
    }
    visiting.delete(plan.table);
    done.add(plan.table);
    out.push(plan);
  };
  for (const plan of [...plans].sort((a, b) => a.table.localeCompare(b.table))) visit(plan);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Values

type SourceRow = Record<string, unknown> & { __rowid: number | bigint };

/** A source value as the target column's type takes it (before pgParams' U+0000 mapping). */
function convertValue(value: unknown, column: PgColumn, where: () => string, rounded: Record<string, number>): unknown {
  if (value === null || value === undefined) return null;
  const type = column.dataType;
  if (type.startsWith("timestamp") || type === "date") {
    if (typeof value === "string") {
      if (value.trim() !== "") return value;
      if (column.notNull) throw new Error(`${where()}: empty timestamp in NOT NULL column ${column.name}`);
      return null;
    }
    throw new Error(`${where()}: column ${column.name} holds ${typeof value} ${String(value)}, not a timestamp string`);
  }
  if (type === "integer" || type === "bigint" || type === "smallint") {
    if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    if (typeof value === "number") {
      if (Number.isInteger(value)) return value;
      if (!Number.isFinite(value)) throw new Error(`${where()}: column ${column.name} holds ${value}`);
      rounded[column.name] = (rounded[column.name] ?? 0) + 1;
      return Math.sign(value) * Math.round(Math.abs(value));
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }
  if (type === "boolean") {
    if (typeof value === "number" || typeof value === "bigint") return Number(value) !== 0;
    if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
    return Boolean(value);
  }
  if (type === "double precision" || type === "real" || type === "numeric") {
    return typeof value === "bigint" ? Number(value) : value;
  }
  if (type === "bytea") {
    return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  }
  // text, json, jsonb, character varying, …: SQLite text as is (JSON text verbatim).
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

/** A primary-key value as Postgres stores it, for the checksums: text with lone surrogates and U+0000 as U+FFFD. */
function keyPart(value: unknown): string {
  if (value === null || value === undefined) return "\u0000null";
  if (typeof value === "string") return wellFormedAuditText(value);
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

function keyHash(values: unknown[]): Buffer {
  return createHash("sha256").update(JSON.stringify(values.map(keyPart)), "utf8").digest();
}

/** Order-independent: the sum of the keys' hashes (mod 2^256) and the count. */
class KeySet {
  private sum = 0n;
  count = 0;
  add(values: unknown[]): void {
    this.sum = (this.sum + BigInt(`0x${keyHash(values).toString("hex")}`)) & ((1n << 256n) - 1n);
    this.count += 1;
  }
  digest(): string {
    return `${this.count}:${this.sum.toString(16).padStart(64, "0")}`;
  }
}

/** Order-dependent: a running hash over the keys in order. */
class KeySequence {
  private hash = Buffer.alloc(32);
  add(values: unknown[]): void {
    this.hash = createHash("sha256").update(this.hash).update(keyHash(values)).digest();
  }
  digest(): string {
    return this.hash.toString("hex");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The run

function sqliteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Refusing to quote suspicious identifier: ${name}`);
  return `"${name}"`;
}
const pgIdent = sqliteIdent;

function preview(items: string[], max = 8): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

/** A source row as Postgres will store it: lone surrogates and U+0000 become U+FFFD (pg / pgParams). */
function asPostgresStores(row: AuditChainRow): AuditChainRow {
  const fields = { ...row.fields } as Record<keyof AuditCanonicalInput, string | null>;
  for (const key of Object.keys(fields) as Array<keyof AuditCanonicalInput>) fields[key] = wellFormedAuditText(fields[key]);
  return { ...row, fields: fields as unknown as AuditCanonicalInput };
}

const verdictLine = verdictText;
const SQLITE_TO_POSTGRES = { source: "SQLite", target: "Postgres" };

function sameVerdict(a: AuditChainResult, b: AuditChainResult): boolean {
  return (
    a.ok === b.ok &&
    a.rowsChecked === b.rowsChecked &&
    (a.firstBrokenAt?.id ?? null) === (b.firstBrokenAt?.id ?? null) &&
    JSON.stringify((a.unverifiable ?? []).map((row) => row.id)) === JSON.stringify((b.unverifiable ?? []).map((row) => row.id))
  );
}

async function countRows(client: PoolClient, table: string): Promise<number> {
  const r = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${pgIdent(table)}`);
  return Number(r.rows[0]?.n ?? 0);
}

/** Primary keys (and their order by seq) of a target table, read through a cursor in the copy transaction. */
async function targetKeys(client: PoolClient, plan: TablePlan): Promise<{ set: string; order?: string }> {
  const keys = plan.target.primaryKey;
  const set = new KeySet();
  const order = plan.seq ? new KeySequence() : undefined;
  const cursor = `db_copy_keys_${plan.table}`;
  await client.query(
    `DECLARE ${pgIdent(cursor)} NO SCROLL CURSOR FOR SELECT ${keys.map(pgIdent).join(", ")} FROM ${pgIdent(plan.table)}${plan.seq ? " ORDER BY seq" : ""}`
  );
  try {
    for (;;) {
      const batch = await client.query({ text: `FETCH 5000 FROM ${pgIdent(cursor)}`, rowMode: "array" });
      for (const row of batch.rows as unknown[][]) {
        set.add(row);
        order?.add(row);
      }
      if (batch.rows.length < 5000) break;
    }
  } finally {
    await client.query(`CLOSE ${pgIdent(cursor)}`);
  }
  return { set: set.digest(), order: order?.digest() };
}

function sourceKeys(db: BetterSqlite3Database, plan: TablePlan): { set: string; order?: string } {
  const keys = plan.target.primaryKey;
  const set = new KeySet();
  const order = plan.seq ? new KeySequence() : undefined;
  const select = keys.map(sqliteIdent).join(", ");
  if (plan.table === "audit_logs") {
    // Keys as the copy wrote them: audit text exact.
    for (const row of auditRowsInBatches(db, `SELECT rowid AS __rowid, ${select} FROM audit_logs`, keys)) {
      const values = keys.map((key) => row[key]);
      set.add(values);
      order?.add(values);
    }
  } else {
    const stmt = db.prepare(`SELECT ${select} FROM ${sqliteIdent(plan.table)} ORDER BY rowid`).raw(true).safeIntegers(true);
    for (const row of stmt.iterate() as Iterable<unknown[]>) {
      set.add(row);
      order?.add(row);
    }
  }
  return { set: set.digest(), order: order?.digest() };
}

/** `selectSql` (which must select `rowid AS __rowid`) over audit_logs in rowid batches, the text columns exact. */
function* auditRowsInBatches(db: BetterSqlite3Database, selectSql: string, textColumns: readonly string[]): Generator<SourceRow> {
  const exact = textColumns.filter((column) => (SQLITE_AUDIT_TEXT_COLUMNS as readonly string[]).includes(column));
  let after: number | bigint = -1;
  const stmt = db.prepare(`${selectSql} WHERE rowid > ? ORDER BY rowid LIMIT 2000`).safeIntegers(true);
  for (;;) {
    const rows = stmt.all(after) as SourceRow[];
    if (rows.length === 0) return;
    exactSqliteTextRows(db, "audit_logs", rows, exact, "__rowid");
    yield* rows;
    after = rows[rows.length - 1]!.__rowid;
  }
}

/** Source rows of a table in rowid order, in batches (audit text exact). */
function* sourceRows(db: BetterSqlite3Database, plan: TablePlan, batch: number): Generator<SourceRow[]> {
  const select = `SELECT rowid AS __rowid, ${plan.columns.map(sqliteIdent).join(", ")} FROM ${sqliteIdent(plan.table)}`;
  if (plan.table === "audit_logs") {
    let pending: SourceRow[] = [];
    for (const row of auditRowsInBatches(db, select, plan.columns)) {
      pending.push(row);
      if (pending.length >= batch) {
        yield pending;
        pending = [];
      }
    }
    if (pending.length > 0) yield pending;
    return;
  }
  const stmt = db.prepare(`${select} WHERE rowid > ? ORDER BY rowid LIMIT ?`).safeIntegers(true);
  let after: number | bigint = -1;
  for (;;) {
    const rows = stmt.all(after, batch) as SourceRow[];
    if (rows.length === 0) return;
    yield rows;
    after = rows[rows.length - 1]!.__rowid;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const pg = error as Error & { code?: string; column?: string; detail?: string };
    return `${error.message}${pg.code ? ` (${pg.code})` : ""}${pg.detail ? `: ${pg.detail}` : ""}`;
  }
  return String(error);
}

export async function runDbCopy(options: DbCopyOptions): Promise<DbCopyReport> {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const batchRows = Math.max(1, Math.floor(options.batchRows ?? DEFAULT_BATCH_ROWS));
  const sqlitePath = path.resolve(options.sqlitePath);

  if (!fs.existsSync(sqlitePath) || !fs.statSync(sqlitePath).isFile()) {
    throw new DbCopyRefusal(`--from: no SQLite file at ${sqlitePath}.`);
  }
  let db: BetterSqlite3Database;
  try {
    db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    db.prepare(`SELECT COUNT(*) FROM sqlite_master`).get();
  } catch (error) {
    throw new DbCopyRefusal(`--from: ${sqlitePath} is not a readable SQLite database (${describeError(error)}).`);
  }

  try {
    // One read transaction: every read below sees the same snapshot, even if something writes the file meanwhile.
    db.exec("BEGIN");
    const sourceSchema = sqliteSchema(db);
    const source = sourceSchema.tables;
    if (source.size === 0) throw new DbCopyRefusal(`--from: ${sqlitePath} holds no tables; it is not an L2M database.`);
    checkSourceSchema(sourceSchema, await codeSqliteSchema(), options.sqlitePath, options.settingOrigins);
    log(`Source: SQLite ${sqlitePath} (read-only), schema matches this build.`);

    // Two streaming walks over the chain (rowid batches inside the read transaction): the verdict as SQLite stores it,
    // then as Postgres will store it. Neither holds the chain in memory.
    const sourceAudit = verifyAuditRows(iterateSqliteAuditChainRows(db));
    const sourceBrokenAt = sourceAudit.firstBrokenAt ? { id: sourceAudit.firstBrokenAt.id, position: brokenPosition(sourceAudit)! } : undefined;
    if (sourceBrokenAt && !options.allowBrokenAudit) {
      throw new DbCopyRefusal(
        `The audit chain on SQLite is broken at row ${sourceBrokenAt.id} (position ${sourceBrokenAt.position}, created_at ` +
          `${sourceAudit.firstBrokenAt!.createdAt} as stored; ${sourceAudit.rowsChecked} rows verified before it). Copying it would ` +
          `leave a Postgres chain whose verdict cannot be trusted to show that. Investigate the row first (compare it with a backup), ` +
          `or keep the evidence with db:export and keep this SQLite file. To copy anyway, run db:copy again with --allow-broken-audit. ` +
          `Nothing was copied.`
      );
    }
    const explainedBySource = new Set<string>();
    const expectedTarget = verifyAuditRows(
      (function* () {
        for (const row of iterateSqliteAuditChainRows(db)) {
          if (unverifiableOnPostgresBySource(row.fields)) explainedBySource.add(row.fields.id);
          yield asPostgresStores(row);
        }
      })()
    );
    const predicted = auditCarryOver(sourceAudit, expectedTarget, explainedBySource, SQLITE_TO_POSTGRES);
    if (predicted.problems.length > 0) {
      throw new DbCopyRefusal(
        `The audit chain would not carry over to Postgres: ${predicted.problems.join("; ")}. SQLite says the chain is ` +
          `${verdictLine(sourceAudit)}. Nothing was copied.`
      );
    }
    const becameUnverifiable = predicted.becameUnverifiable;

    const pool = new Pool(postgresPoolConfig(options.postgres, { max: 1 }));
    try {
      return await withMigrationLock(pool, options.postgres.schema, async (client) => {
        await client.query("SET TimeZone = 'UTC'");
        // A dry run works inside a transaction it rolls back, its migration rehearsal included.
        if (dryRun) await client.query("BEGIN");
        // `schema` is set only by tests (each its own); a deployment uses the role's default schema, as PostgresStore does.
        if (options.postgres.schema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${pgIdent(options.postgres.schema)}`);
        try {
          const report = await copyInto(client, {
            db, source, dryRun, batchRows, log, sourceAudit, expectedTarget, becameUnverifiable, sourceBrokenAt, explainedBySource
          });
          if (dryRun) await client.query("ROLLBACK");
          return report;
        } catch (error) {
          if (dryRun) await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      });
    } finally {
      await pool.end().catch(() => undefined);
    }
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no read transaction open
    }
    db.close();
  }
}

interface CopyContext {
  db: BetterSqlite3Database;
  source: Map<string, SqliteTable>;
  dryRun: boolean;
  batchRows: number;
  log: (line: string) => void;
  sourceAudit: AuditChainResult;
  expectedTarget: AuditChainResult;
  becameUnverifiable: string[];
  sourceBrokenAt?: { id: string; position: number };
  explainedBySource: ReadonlySet<string>;
}

async function copyInto(client: PoolClient, ctx: CopyContext): Promise<DbCopyReport> {
  const { db, dryRun, log } = ctx;
  const hasChain = (await client.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`)).rows[0]?.t !== null;
  const version = hasChain ? await currentChainVersion(client) : 0;
  let migratedTarget = false;
  if (version === 0) {
    const existing = (await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name <> 'schema_migrations'`
    )).rows.map((row) => row.table_name);
    if (existing.length > 0) {
      throw new DbCopyRefusal(
        `The Postgres database holds ${existing.length} table(s) (${preview(existing)}) but no applied L2M migrations. Point db:copy at an empty database.`
      );
    }
    log(`Target: empty, no migrations applied: ${dryRun ? "would migrate" : "migrating"} it to v${CODE_SCHEMA_VERSION} first (the normal migration chain).`);
    await applyMigrationChain(client);
    migratedTarget = true;
  } else if (version !== CODE_SCHEMA_VERSION) {
    throw new DbCopyRefusal(
      version > CODE_SCHEMA_VERSION
        ? `The Postgres database is at schema v${version}, newer than this build (v${CODE_SCHEMA_VERSION}). Run db:copy from a build at v${version}.`
        : `The Postgres database is at schema v${version}, this build is at v${CODE_SCHEMA_VERSION}. db:copy needs the same version: use an empty database ` +
            `(db:copy migrates it), or start this build once against this one so it migrates, then run db:copy again.`
    );
  } else {
    log(`Target: schema v${version} (this build's).`);
  }

  const target = await postgresTables(client);
  const plans = planTables(ctx.source, target);

  // Emptiness: no user or workflow, and no row in any table that is not a migration's own seed (a row whose primary key
  // the source also holds, e.g. schema_markers, guard_profile_revision): those are replaced by the source's rows.
  const seedRows = new Map<string, number>();
  const refusals: string[] = [];
  for (const plan of plans) {
    const n = await countRows(client, plan.table);
    if (n === 0) continue;
    if (plan.table === "users" || plan.table === "workflows") {
      refusals.push(`${plan.table}: ${n} row(s)`);
      continue;
    }
    const keys = plan.target.primaryKey;
    const targetKeyRows = (await client.query({ text: `SELECT ${keys.map(pgIdent).join(", ")} FROM ${pgIdent(plan.table)}`, rowMode: "array" })).rows as unknown[][];
    const lookup = db.prepare(`SELECT 1 FROM ${sqliteIdent(plan.table)} WHERE ${keys.map((key) => `${sqliteIdent(key)} = ?`).join(" AND ")}`);
    const foreign = targetKeyRows.filter((values) => !lookup.get(...values.map((value) => (typeof value === "boolean" ? Number(value) : value))));
    if (foreign.length > 0) refusals.push(`${plan.table}: ${foreign.length} row(s) not in the source`);
    else seedRows.set(plan.table, n);
  }
  if (refusals.length > 0) {
    throw new DbCopyRefusal(`The Postgres database is not empty (${refusals.join("; ")}). db:copy only copies into an empty database; nothing was written.`);
  }

  // Seeded tables last, so a trigger bumping them while their dependents are copied (guard_profile_revision) does not
  // change the value the source holds.
  const ordered = dependencyOrder(plans);
  const order = [...ordered.filter((plan) => !seedRows.has(plan.table)), ...ordered.filter((plan) => seedRows.has(plan.table))];
  const sourceCount = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${sqliteIdent(table)}`).get() as { n: number }).n);

  const tables: DbCopyTableReport[] = [];
  if (dryRun) {
    for (const plan of order) {
      tables.push({ table: plan.table, rows: sourceCount(plan.table), replacedSeedRows: seedRows.get(plan.table) ?? 0, rounded: {} });
    }
    const report = summary(tables, {
      dryRun,
      migratedTarget,
      audit: { source: ctx.sourceAudit, expectedTarget: ctx.expectedTarget, becameUnverifiable: ctx.becameUnverifiable, sourceBrokenAt: ctx.sourceBrokenAt }
    });
    printSummary(report, log);
    return report;
  }

  await client.query("BEGIN");
  try {
    for (const plan of order) {
      const rounded: Record<string, number> = {};
      const replaced = seedRows.get(plan.table) ?? 0;
      if (replaced > 0) await client.query(`DELETE FROM ${pgIdent(plan.table)}`);
      const columns = plan.columns.map((name) => plan.target.columns.get(name)!);
      const perStatement = Math.max(1, Math.min(ctx.batchRows, Math.floor(MAX_PARAMS / Math.max(1, columns.length))));
      const insertHead = `INSERT INTO ${pgIdent(plan.table)} (${columns.map((column) => pgIdent(column.name)).join(", ")}) VALUES `;
      let copied = 0;
      for (const rows of sourceRows(db, plan, perStatement)) {
        const params: unknown[] = [];
        const tuples: string[] = [];
        for (const row of rows) {
          const where = () => `${plan.table} (SQLite rowid ${String(row.__rowid)})`;
          tuples.push(`(${columns.map((column) => {
            params.push(convertValue(row[column.name], column, where, rounded));
            return `$${params.length}`;
          }).join(", ")})`);
        }
        try {
          await client.query(insertHead + tuples.join(", "), pgParams(params));
        } catch (error) {
          const range = `the batch from SQLite rowid ${String(rows[0]!.__rowid)} to ${String(rows[rows.length - 1]!.__rowid)}`;
          const pgError = error as { code?: string; constraint?: string; detail?: string };
          if (pgError.code === "23505") {
            throw new Error(
              `Copying ${plan.table} failed in ${range}: the rows break the unique constraint "${pgError.constraint ?? "?"}" of ${plan.table} on ` +
                `Postgres${pgError.detail ? ` (${pgError.detail})` : ""}. Nothing was committed (the copy rolled back). If the SQLite file ` +
                `predates that constraint, start this build once against it so its migration applies, then run db:copy again. Otherwise ` +
                `two SQLite values become the same on Postgres (U+0000 and lone surrogates are stored as U+FFFD): fix one of the rows.`
            );
          }
          throw new Error(`Copying ${plan.table} failed in ${range}: ${describeError(error)}`);
        }
        copied += rows.length;
      }
      tables.push({ table: plan.table, rows: copied, replacedSeedRows: replaced, rounded });
      log(`  ${plan.table}: ${copied} row(s)${replaced ? ` (replaced ${replaced} migration seed row(s))` : ""}${Object.keys(rounded).length ? `, rounded to integers: ${JSON.stringify(rounded)}` : ""}`);
    }

    // Sequences: past the copied values (identities assigned while copying are already there; this also covers a
    // column a future migration backs by a sequence and whose values were copied).
    for (const plan of order) {
      for (const column of plan.target.sequenceColumns) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${pgIdent(column)}) FROM ${pgIdent(plan.table)}), 0) + 1, false)`,
          [plan.table, column]
        );
      }
    }

    // Verify before committing.
    log("Verifying...");
    const mismatches: string[] = [];
    for (const plan of order) {
      const expected = sourceCount(plan.table);
      const actual = await countRows(client, plan.table);
      if (expected !== actual) {
        mismatches.push(`${plan.table}: ${expected} row(s) in SQLite, ${actual} on Postgres`);
        continue;
      }
      const sourceDigest = sourceKeys(db, plan);
      const targetDigest = await targetKeys(client, plan);
      if (sourceDigest.set !== targetDigest.set) mismatches.push(`${plan.table}: primary-key checksum differs`);
      if (sourceDigest.order !== targetDigest.order) mismatches.push(`${plan.table}: seq order differs from SQLite rowid order`);
    }
    const targetAudit = await verifyPostgresAuditChainByCursor(client);
    if (!sameVerdict(targetAudit, ctx.expectedTarget)) {
      mismatches.push(`audit chain on Postgres is ${verdictLine(targetAudit)}, expected ${verdictLine(ctx.expectedTarget)}`);
    }
    const carried = auditCarryOver(ctx.sourceAudit, targetAudit, ctx.explainedBySource, SQLITE_TO_POSTGRES);
    mismatches.push(...carried.problems.map((problem) => `audit chain: ${problem}`));
    if (mismatches.length > 0) {
      throw new Error(`Verification failed, nothing was committed: ${mismatches.join("; ")}.`);
    }
    await client.query("COMMIT");
    const report = summary(tables, {
      dryRun,
      migratedTarget,
      audit: {
        source: ctx.sourceAudit,
        expectedTarget: ctx.expectedTarget,
        target: targetAudit,
        becameUnverifiable: carried.becameUnverifiable,
        sourceBrokenAt: ctx.sourceBrokenAt
      }
    });
    printSummary(report, log);
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function summary(tables: DbCopyTableReport[], rest: Omit<DbCopyReport, "tables" | "totalRows" | "schemaVersion">): DbCopyReport {
  return { ...rest, schemaVersion: CODE_SCHEMA_VERSION, tables, totalRows: tables.reduce((sum, table) => sum + table.rows, 0) };
}

function printSummary(report: DbCopyReport, log: (line: string) => void): void {
  log("");
  if (report.dryRun) {
    log(`Dry run: nothing was written. ${report.totalRows} row(s) in ${report.tables.length} table(s) would be copied:`);
    for (const table of report.tables) if (table.rows > 0) log(`  ${table.table}: ${table.rows}`);
  } else {
    log(`Copied ${report.totalRows} row(s) in ${report.tables.length} table(s) at schema v${report.schemaVersion}; verified row counts, primary-key checksums and seq order.`);
  }
  const broken = report.audit.sourceBrokenAt;
  log(`Audit chain on SQLite (verified from the stored bytes): ${verdictLine(report.audit.source)}.`);
  if (broken) {
    // Never "intact": rows from the break on were not verified on SQLite, so a clean verdict on Postgres proves nothing.
    log(
      `Audit chain on Postgres: not trusted. The SQLite chain was broken at row ${broken.id} (position ${broken.position}), and the ` +
        `Postgres verdict cannot be trusted to show it.`
    );
  } else {
    log(`Audit chain on Postgres: ${verdictLine(report.audit.target ?? report.audit.expectedTarget)}${report.audit.target ? "" : " (expected)"}.`);
  }
  if (report.audit.becameUnverifiable.length > 0) {
    log(
      `Note: ${report.audit.becameUnverifiable.length} audit row(s) verified on SQLite cannot be verified on Postgres (${preview(report.audit.becameUnverifiable)}): ` +
        `each holds two or more U+FFFD once U+0000 and lone surrogates (which Postgres cannot store) become U+FFFD, too many ` +
        `combinations to check. Keep the SQLite file as the record for them.`
    );
  }
  log(
    `Secrets ${report.dryRun ? "would be" : "were"} copied encrypted (ciphertext, iv and auth tag only, never decrypted). Start the API on Postgres ` +
      `with the same SECRET_MASTER_KEY_BASE64.`
  );
  if (broken) {
    log(
      `WARNING: the SQLite audit chain was broken at row ${broken.id} (position ${broken.position}) before the copy (--allow-broken-audit). ` +
        `The Postgres audit verdict cannot be trusted to show it: keep the SQLite file as the evidence.`
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI arguments (db-copy.ts)

export interface DbCopyArgs {
  /** The SQLite file (`sqlite:<path>`; `sqlite` alone: DB_SQLITE_PATH, else apps/api/data/orchestrator.db). */
  from: string;
  yes: boolean;
  dryRun: boolean;
  /** Copy even though the SQLite audit chain is broken (refused by default). */
  allowBrokenAudit: boolean;
  help: boolean;
}

/** apps/api (the default SQLite file is apps/api/data/orchestrator.db, as the API opens it). */
export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const USAGE = [
  "Usage: pnpm --filter @ai-orchestrator/api db:copy -- --from sqlite:<path> --to postgres [--dry-run | --yes]",
  "",
  "Copies a SQLite database into an empty Postgres database, then verifies it (row counts, primary-key checksums,",
  "insertion order, the audit chain) before committing. One transaction: a failed copy writes nothing.",
  "",
  "Options:",
  "  --from sqlite:<path>  The SQLite file (read-only). `--from sqlite` alone uses the API's file: DB_SQLITE_PATH,",
  "                        else apps/api/data/orchestrator.db. A relative path is relative to the current directory",
  "                        (apps/api when run through pnpm --filter).",
  "  --to postgres         The target: DB_POSTGRESDB_URL or DB_POSTGRESDB_HOST/PORT/DATABASE/USER/PASSWORD/SSL*.",
  "                        Settings are read as the API reads them: the environment, the repo's .env (which does not",
  "                        override it), then apps/api/.env (which does).",
  "  --dry-run             Check everything and report row counts; write nothing.",
  "  --yes, -y             Copy (required unless --dry-run).",
  "  --allow-broken-audit  Copy even though the SQLite audit chain is broken (refused by default). The summary then",
  "                        says the Postgres audit verdict cannot be trusted to show the break.",
  "  --help, -h            Show this message.",
  "",
  "Stop the API first. An empty, unmigrated Postgres database is migrated first; a non-empty one, or one at",
  "another schema version, is refused. Secrets are copied encrypted: start the API on Postgres with the same",
  "SECRET_MASTER_KEY_BASE64."
].join("\n");

/**
 * Parses the CLI arguments; throws DbCopyRefusal with a usage hint on anything wrong. A run with neither --yes nor
 * --dry-run parses (so the CLI can print what it resolved first) and is refused by requireConfirmation.
 */
export function parseDbCopyArgs(argv: string[], env: Record<string, string | undefined> = process.env): DbCopyArgs {
  let from: string | undefined;
  let to: string | undefined;
  let yes = false;
  let dryRun = false;
  let help = false;
  let allowBrokenAudit = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = () => {
      const next = inline ?? argv[++i];
      if (next === undefined || next === "") throw new DbCopyRefusal(`${flag} needs a value.\n\n${USAGE}`);
      return next;
    };
    if (flag === "--from") from = value();
    else if (flag === "--to") to = value();
    else if (flag === "--yes" || flag === "-y") yes = true;
    else if (flag === "--dry-run") dryRun = true;
    else if (flag === "--allow-broken-audit") allowBrokenAudit = true;
    else if (flag === "--help" || flag === "-h") help = true;
    else throw new DbCopyRefusal(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  if (help) return { from: "", yes, dryRun, allowBrokenAudit, help };
  if (from === undefined) throw new DbCopyRefusal(`--from sqlite:<path> is required.\n\n${USAGE}`);
  let file: string;
  if (from === "sqlite") {
    file = env.DB_SQLITE_PATH?.trim() ? path.resolve(env.DB_SQLITE_PATH.trim()) : path.join(API_ROOT, "data", "orchestrator.db");
  } else if (from.startsWith("sqlite:") && from.length > "sqlite:".length) {
    file = path.resolve(from.slice("sqlite:".length).replace(/^\/\/(?=\/)/, ""));
  } else {
    throw new DbCopyRefusal(`--from must be sqlite:<path> (or sqlite for the API's default file), got '${from}'.\n\n${USAGE}`);
  }
  if (to === undefined) throw new DbCopyRefusal(`--to postgres is required.\n\n${USAGE}`);
  if (to !== "postgres" && to !== "postgresql") throw new DbCopyRefusal(`--to must be postgres, got '${to}'.\n\n${USAGE}`);
  if (yes && dryRun) throw new DbCopyRefusal(`--dry-run and --yes together: choose one.\n\n${USAGE}`);
  return { from: file, yes, dryRun, allowBrokenAudit, help };
}

/** Refuses a run with neither --yes nor --dry-run (after the CLI printed the source and target it resolved). */
export function requireConfirmation(args: DbCopyArgs): void {
  if (!args.yes && !args.dryRun) throw new DbCopyRefusal(`Refusing to copy without --yes (or check first with --dry-run).\n\n${USAGE}`);
}

export interface DbCopyCliOptions {
  /** apps/api: where the .env files are found (the repo root's is two levels up), as index.ts finds them. */
  apiRoot: string;
  /** The environment to resolve settings from; the .env files are loaded into it (process.env by default). */
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * The CLI: loads settings exactly as the API does (loadApiEnvFiles) **before** resolving `--from sqlite` and the
 * Postgres target, prints both (never the password), then requires --yes or --dry-run. Returns the exit code.
 */
export async function runDbCopyCli(argv: string[], options: DbCopyCliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  const settingOrigins = resolveSettingOrigins(options.apiRoot, env, ["DB_SQLITE_PATH", "DB_TYPE"]) as SettingOrigins;
  loadApiEnvFiles(options.apiRoot, env);
  let args: DbCopyArgs;
  try {
    args = parseDbCopyArgs(argv, env);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }
  try {
    out(`Source: SQLite ${args.from}`);
    const settings = parsePostgresSettings(env);
    for (const warning of settings.warnings) err(`Warning: ${warning}`);
    out(`Target: ${describePostgresSettings(settings)}`);
    requireConfirmation(args);
    await runDbCopy({
      sqlitePath: args.from,
      postgres: postgresStoreConfig(settings, { maxConnections: 1 }),
      dryRun: args.dryRun,
      allowBrokenAudit: args.allowBrokenAudit,
      settingOrigins,
      log: out
    });
    return 0;
  } catch (error) {
    if (error instanceof DbCopyRefusal) {
      err(`Refused: ${error.message}`);
      return 2;
    }
    // Config errors name the variable, never its value; pg errors never carry the password.
    err(`db:copy failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
