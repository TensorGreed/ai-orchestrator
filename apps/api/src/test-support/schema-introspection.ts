/**
 * Phase 13.1 — reads the shape of a SQLite and a Postgres schema into one normalised form, so the schema-parity test
 * can compare a fresh SQLite (the store's embedded migrate()) with a fresh Postgres (the MIGRATIONS chain).
 *
 * Normalisation: column types fold into classes (text-like, integer-like, real, other) because the two dialects spell
 * the same stored value differently (TEXT vs TIMESTAMPTZ, INTEGER vs BIGINT); primary-key columns count as NOT NULL
 * on both; index columns are compared as written, lower-cased with whitespace removed. Column defaults are compared
 * by presence only (not the expression: `datetime('now')` and `now()` are the same intent), and only for NOT NULL
 * columns, where a missing default makes an insert that leaves the column out fail on one store only. Foreign keys
 * are compared by columns, target table/columns and ON DELETE action.
 */
import type Database from "better-sqlite3";
import type { Pool, PoolClient } from "pg";

export type ColumnClass = "text" | "integer" | "real" | "blob" | "boolean" | "tsvector" | "other";

export interface ColumnShape {
  type: ColumnClass;
  notNull: boolean;
  /** Whether the column has a DEFAULT (an expression or a sequence); generated columns count as having none. */
  hasDefault: boolean;
}

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export interface ForeignKeyShape {
  /** Target table. */
  references: string;
  /** Target columns, comma-joined, in key order. */
  referencedColumns: string;
  onDelete: ForeignKeyAction;
}

export interface IndexShape {
  unique: boolean;
  /** Indexed columns or expressions, normalised. */
  columns: string;
  /** Normalised WHERE predicate of a partial index, or "" for a full index. */
  where: string;
}

export interface TableShape {
  columns: Record<string, ColumnShape>;
  primaryKey: string[];
  /** Named indexes only (the implicit primary-key / UNIQUE-constraint indexes are folded into `uniqueConstraints`). */
  indexes: Record<string, IndexShape>;
  /** Column lists of UNIQUE table constraints (inline UNIQUE / UNIQUE(a, b)), sorted. */
  uniqueConstraints: string[];
  /** Foreign keys keyed by their local column list (comma-joined, in key order). */
  foreignKeys: Record<string, ForeignKeyShape>;
}

export type SchemaShape = Record<string, TableShape>;

function normaliseExpression(value: string): string {
  return value
    .toLowerCase()
    .replace(/::[a-z ]+/g, "")
    .replace(/[\s"()]/g, "");
}

export function classifySqliteType(declared: string): ColumnClass {
  const t = declared.trim().toUpperCase();
  if (t === "" || t.startsWith("TEXT") || t.includes("CHAR") || t.includes("CLOB")) return "text";
  if (t.includes("INT")) return "integer";
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUMERIC")) return "real";
  if (t.includes("BLOB")) return "blob";
  if (t.includes("BOOL")) return "boolean";
  return "other";
}

export function classifyPostgresType(dataType: string): ColumnClass {
  const t = dataType.toLowerCase();
  if (t === "text" || t.startsWith("character") || t.startsWith("timestamp") || t === "date" || t === "jsonb" || t === "json" || t === "uuid") {
    return "text";
  }
  if (t === "integer" || t === "bigint" || t === "smallint") return "integer";
  if (t === "real" || t === "double precision" || t === "numeric") return "real";
  if (t === "bytea") return "blob";
  if (t === "boolean") return "boolean";
  if (t === "tsvector") return "tsvector";
  return "other";
}

/** Tables FTS5 creates behind a virtual table; they have no Postgres counterpart. */
function isSqliteInternalTable(name: string, virtualTables: Set<string>): boolean {
  if (name.startsWith("sqlite_")) return true;
  for (const virtual of virtualTables) {
    if (name === virtual || name.startsWith(`${virtual}_`)) return true;
  }
  return false;
}

export function introspectSqlite(db: Database.Database): SchemaShape {
  const masterRows = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string; sql: string | null }>;
  const virtualTables = new Set(
    masterRows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name)
  );
  const shape: SchemaShape = {};
  for (const { name } of masterRows) {
    if (isSqliteInternalTable(name, virtualTables)) continue;
    const columns: Record<string, ColumnShape> = {};
    const pk: Array<{ name: string; pk: number }> = [];
    for (const col of db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>) {
      columns[col.name] = {
        type: classifySqliteType(col.type),
        notNull: col.notnull === 1 || col.pk > 0,
        hasDefault: col.dflt_value !== null
      };
      if (col.pk > 0) pk.push({ name: col.name, pk: col.pk });
    }
    const indexes: Record<string, IndexShape> = {};
    const uniqueConstraints: string[] = [];
    for (const idx of db.prepare(`PRAGMA index_list(${JSON.stringify(name)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>) {
      if (idx.origin === "pk") continue;
      const cols = (db.prepare(`PRAGMA index_xinfo(${JSON.stringify(idx.name)})`).all() as Array<{
        name: string | null;
        key: number;
        cid: number;
      }>).filter((c) => c.key === 1);
      if (idx.origin === "u") {
        uniqueConstraints.push(cols.map((c) => c.name ?? "").join(","));
        continue;
      }
      const sqlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(idx.name) as
        | { sql: string | null }
        | undefined;
      const sql = sqlRow?.sql ?? "";
      indexes[idx.name] = {
        unique: idx.unique === 1,
        columns: indexColumnsFromSql(sql),
        where: wherePredicateFromSql(sql)
      };
    }
    const fkRows = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }>;
    const foreignKeys: Record<string, ForeignKeyShape> = {};
    for (const id of [...new Set(fkRows.map((row) => row.id))]) {
      const parts = fkRows.filter((row) => row.id === id).sort((a, b) => a.seq - b.seq);
      foreignKeys[parts.map((row) => row.from).join(",")] = {
        references: parts[0].table,
        referencedColumns: parts.map((row) => row.to ?? "").join(","),
        onDelete: parts[0].on_delete.toLowerCase() as ForeignKeyAction
      };
    }
    shape[name] = {
      columns,
      primaryKey: pk.sort((a, b) => a.pk - b.pk).map((c) => c.name),
      indexes,
      uniqueConstraints: uniqueConstraints.sort(),
      foreignKeys
    };
  }
  return shape;
}

/** The parenthesised column/expression list of a CREATE INDEX statement (after `ON table [USING m]`). */
export function indexColumnsFromSql(sql: string): string {
  const match = /\bON\s+[^\s(]+\s*(?:USING\s+\w+\s*)?\(/i.exec(sql);
  if (!match) return "";
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
  }
  return normaliseExpression(sql.slice(start, i - 1)).replace(/\basc\b/g, "");
}

export function wherePredicateFromSql(sql: string): string {
  const match = /\bWHERE\b([\s\S]*)$/i.exec(sql);
  return match ? normaliseExpression(match[1]) : "";
}

type Queryable = Pool | PoolClient;

export async function introspectPostgres(db: Queryable, schema: string): Promise<SchemaShape> {
  const shape: SchemaShape = {};
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [schema]
  );
  for (const { table_name } of tables.rows) {
    shape[table_name] = { columns: {}, primaryKey: [], indexes: {}, uniqueConstraints: [], foreignKeys: {} };
  }
  const columns = await db.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
    is_identity: string;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, is_identity
       FROM information_schema.columns WHERE table_schema = $1`,
    [schema]
  );
  for (const col of columns.rows) {
    const table = shape[col.table_name];
    if (!table) continue;
    table.columns[col.column_name] = {
      type: classifyPostgresType(col.data_type),
      notNull: col.is_nullable === "NO",
      hasDefault: col.column_default !== null || col.is_identity === "YES"
    };
  }
  const foreignKeys = await db.query<{
    table_name: string;
    columns: string[];
    references: string;
    referenced_columns: string[];
    confdeltype: string;
  }>(
    `SELECT t.relname AS table_name, rt.relname AS references,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
            ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS referenced_columns,
            c.confdeltype::text AS confdeltype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_class rt ON rt.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND c.contype = 'f'`,
    [schema]
  );
  const deleteActions: Record<string, ForeignKeyAction> = {
    a: "no action",
    r: "restrict",
    c: "cascade",
    n: "set null",
    d: "set default"
  };
  for (const row of foreignKeys.rows) {
    const table = shape[row.table_name];
    if (!table) continue;
    table.foreignKeys[row.columns.join(",")] = {
      references: row.references,
      referencedColumns: row.referenced_columns.join(","),
      onDelete: deleteActions[row.confdeltype] ?? "no action"
    };
  }
  const constraints = await db.query<{ table_name: string; contype: string; index_name: string; columns: string[] }>(
    `SELECT t.relname AS table_name, c.contype, i.relname AS index_name,
            ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_class i ON i.oid = c.conindid
      WHERE n.nspname = $1 AND c.contype IN ('p', 'u')`,
    [schema]
  );
  const constraintIndexes = new Set<string>();
  for (const row of constraints.rows) {
    const table = shape[row.table_name];
    if (!table) continue;
    if (row.index_name) constraintIndexes.add(row.index_name);
    if (row.contype === "p") table.primaryKey = row.columns;
    else table.uniqueConstraints.push(row.columns.join(","));
  }
  const indexes = await db.query<{ tablename: string; indexname: string; indexdef: string; indisunique: boolean }>(
    `SELECT pi.tablename, pi.indexname, pi.indexdef, ix.indisunique
       FROM pg_indexes pi
       JOIN pg_class ic ON ic.relname = pi.indexname
       JOIN pg_namespace n ON n.oid = ic.relnamespace AND n.nspname = pi.schemaname
       JOIN pg_index ix ON ix.indexrelid = ic.oid
      WHERE pi.schemaname = $1`,
    [schema]
  );
  for (const idx of indexes.rows) {
    const table = shape[idx.tablename];
    if (!table || constraintIndexes.has(idx.indexname)) continue;
    table.indexes[idx.indexname] = {
      unique: idx.indisunique,
      columns: indexColumnsFromSql(idx.indexdef),
      where: wherePredicateFromSql(idx.indexdef)
    };
  }
  for (const table of Object.values(shape)) {
    table.uniqueConstraints.sort();
    for (const col of table.primaryKey) {
      if (table.columns[col]) table.columns[col].notNull = true;
    }
  }
  return shape;
}

export interface SchemaDifference {
  kind:
    | "table-missing"
    | "column-missing"
    | "column-type"
    | "column-nullability"
    | "primary-key"
    | "unique-constraint"
    | "index-missing"
    | "index-shape"
    | "column-default"
    | "foreign-key-missing"
    | "foreign-key-shape";
  table: string;
  /** Column, index or constraint the difference is about; "" for a whole table. */
  object: string;
  /** Which side has it / what each side says. */
  detail: string;
}

/** Every difference between two normalised schemas, both directions, in a stable order. */
export function diffSchemas(sqlite: SchemaShape, postgres: SchemaShape): SchemaDifference[] {
  const out: SchemaDifference[] = [];
  const tables = [...new Set([...Object.keys(sqlite), ...Object.keys(postgres)])].sort();
  for (const table of tables) {
    const a = sqlite[table];
    const b = postgres[table];
    if (!a || !b) {
      out.push({ kind: "table-missing", table, object: "", detail: a ? "only in sqlite" : "only in postgres" });
      continue;
    }
    for (const column of [...new Set([...Object.keys(a.columns), ...Object.keys(b.columns)])].sort()) {
      const ca = a.columns[column];
      const cb = b.columns[column];
      if (!ca || !cb) {
        out.push({ kind: "column-missing", table, object: column, detail: ca ? "only in sqlite" : "only in postgres" });
        continue;
      }
      if (ca.type !== cb.type) {
        out.push({ kind: "column-type", table, object: column, detail: `sqlite ${ca.type}, postgres ${cb.type}` });
      }
      if ((ca.notNull || cb.notNull) && ca.hasDefault !== cb.hasDefault) {
        out.push({
          kind: "column-default",
          table,
          object: column,
          detail: `NOT NULL; default only in ${ca.hasDefault ? "sqlite" : "postgres"}`
        });
      }
      if (ca.notNull !== cb.notNull) {
        out.push({
          kind: "column-nullability",
          table,
          object: column,
          detail: `sqlite ${ca.notNull ? "NOT NULL" : "nullable"}, postgres ${cb.notNull ? "NOT NULL" : "nullable"}`
        });
      }
    }
    if (a.primaryKey.join(",") !== b.primaryKey.join(",")) {
      out.push({ kind: "primary-key", table, object: "", detail: `sqlite (${a.primaryKey.join(",")}), postgres (${b.primaryKey.join(",")})` });
    }
    if (a.uniqueConstraints.join("|") !== b.uniqueConstraints.join("|")) {
      out.push({
        kind: "unique-constraint",
        table,
        object: "",
        detail: `sqlite [${a.uniqueConstraints.join("|")}], postgres [${b.uniqueConstraints.join("|")}]`
      });
    }
    for (const key of [...new Set([...Object.keys(a.foreignKeys), ...Object.keys(b.foreignKeys)])].sort()) {
      const fa = a.foreignKeys[key];
      const fb = b.foreignKeys[key];
      const describe = (fk: ForeignKeyShape) => `-> ${fk.references}(${fk.referencedColumns}) on delete ${fk.onDelete}`;
      if (!fa || !fb) {
        out.push({ kind: "foreign-key-missing", table, object: key, detail: `${describe((fa ?? fb)!)} only in ${fa ? "sqlite" : "postgres"}` });
        continue;
      }
      if (fa.references !== fb.references || fa.referencedColumns !== fb.referencedColumns || fa.onDelete !== fb.onDelete) {
        out.push({ kind: "foreign-key-shape", table, object: key, detail: `sqlite ${describe(fa)}, postgres ${describe(fb)}` });
      }
    }
    for (const index of [...new Set([...Object.keys(a.indexes), ...Object.keys(b.indexes)])].sort()) {
      const ia = a.indexes[index];
      const ib = b.indexes[index];
      if (!ia || !ib) {
        out.push({ kind: "index-missing", table, object: index, detail: ia ? "only in sqlite" : "only in postgres" });
        continue;
      }
      if (ia.unique !== ib.unique || ia.columns !== ib.columns || ia.where !== ib.where) {
        out.push({
          kind: "index-shape",
          table,
          object: index,
          detail: `sqlite ${ia.unique ? "unique " : ""}(${ia.columns})${ia.where ? ` where ${ia.where}` : ""}, postgres ${
            ib.unique ? "unique " : ""
          }(${ib.columns})${ib.where ? ` where ${ib.where}` : ""}`
        });
      }
    }
  }
  return out;
}

export function formatDifference(d: SchemaDifference): string {
  return `${d.kind} ${d.table}${d.object ? `.${d.object}` : ""}: ${d.detail}`;
}
