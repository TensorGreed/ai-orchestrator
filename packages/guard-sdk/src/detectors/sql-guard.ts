import * as sqlParserModule from "node-sql-parser";
import type { AST } from "node-sql-parser";
import { excerptEvidence } from "../masking";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore } from "../types";

type SqlParserModule = typeof sqlParserModule;
// node-sql-parser is CommonJS whose exports Node's ESM loader cannot detect: under
// Node the classes sit on the default export, under bundlers and vitest on the namespace.
const { Parser } = ((sqlParserModule as SqlParserModule & { default?: SqlParserModule }).default ?? sqlParserModule) as SqlParserModule;

export const SQL_GUARD_DETECTOR_ID = "tool.sql";

/**
 * Phase 12.3 — SQL guard. Statements are parsed to an AST per dialect and
 * classified as read, write or DDL. Stacked queries, tautologies and
 * comment tricks are reported as injection; allowlists, missing WHERE
 * clauses and row caps as policy. Unparseable SQL fails closed.
 */

export type SqlDialect = "postgres" | "mysql" | "mariadb" | "sqlite" | "mssql";

export const SQL_DIALECTS: readonly SqlDialect[] = ["postgres", "mysql", "mariadb", "sqlite", "mssql"];

const DIALECT_DATABASE: Record<SqlDialect, string> = {
  postgres: "Postgresql",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  mssql: "TransactSQL"
};

export type SqlStatementKind = "read" | "write" | "ddl" | "other";

export interface SqlGuardOptions {
  dialect?: SqlDialect;
  /** Table names (optionally `schema.table`), case-insensitive. Empty means any table. */
  allowedTables?: string[];
  /** Column names, optionally `table.column`. Empty means any column. `SELECT *` is rejected when set. */
  allowedColumns?: string[];
  allowStacked?: boolean;
  allowComments?: boolean;
  allowWrites?: boolean;
  allowDdl?: boolean;
  /** Other statement kinds (`show`, `set`, `exec`, `call`, ...) are refused unless listed here, lower-case. */
  allowedOtherStatements?: string[];
  requireWhereOnMutations?: boolean;
  /** Row cap for reads and, where the dialect supports LIMIT on mutations, writes. */
  maxRows?: number;
}

export interface SqlStatementInfo {
  type: string;
  kind: SqlStatementKind;
  tables: string[];
}

export interface SqlIssue {
  category: "sql_injection" | "sql_policy";
  score: number;
  code:
    | "unparseable"
    | "stacked_queries"
    | "comment"
    | "tautology"
    | "union_probe"
    | "table_not_allowed"
    | "column_not_allowed"
    | "wildcard_columns"
    | "write_not_allowed"
    | "ddl_not_allowed"
    | "statement_not_allowed"
    | "mutation_without_where"
    | "mutation_unbounded"
    | "row_cap_exceeded";
  message: string;
  /** Span inside the SQL text when known. */
  span?: GuardSpan;
}

export interface SqlGuardResult {
  ok: boolean;
  dialect: SqlDialect;
  statements: SqlStatementInfo[];
  issues: SqlIssue[];
  /** The SQL with a row cap applied, when a cap was requested and could be applied. */
  rewritten?: string;
}

const READ_TYPES = new Set(["select"]);
const WRITE_TYPES = new Set(["insert", "update", "delete", "replace", "merge", "upsert", "load_data", "copy"]);
const DDL_TYPES = new Set(["create", "drop", "alter", "truncate", "rename", "comment", "lock", "unlock"]);

export function classifySqlStatement(ast: AST): SqlStatementKind {
  const type = String((ast as { type?: string }).type ?? "").toLowerCase();
  if (type === "select") {
    // SELECT ... INTO OUTFILE and SELECT INTO a new table write.
    const into = (ast as { into?: { position?: unknown; expr?: unknown } }).into;
    if (into && (into.position || into.expr)) return "write";
    return "read";
  }
  if (READ_TYPES.has(type)) return "read";
  if (WRITE_TYPES.has(type)) return "write";
  if (DDL_TYPES.has(type)) return "ddl";
  return "other";
}

// Lexical scan: comments and string literals, needed because the parser drops comments.

interface LexicalScan {
  comments: GuardSpan[];
  /** Statement separators outside strings and comments. */
  separators: number[];
}

export function scanSqlLexically(sql: string, dialect: SqlDialect): LexicalScan {
  const comments: GuardSpan[] = [];
  const separators: number[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "'" || c === '"' || (c === "`" && dialect !== "mssql") || (c === "[" && dialect === "mssql")) {
      const close = c === "[" ? "]" : c;
      i += 1;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close && close !== "]") {
            i += 2;
            continue;
          }
          break;
        }
        if (sql[i] === "\\" && (dialect === "mysql" || dialect === "mariadb")) i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "$" && dialect === "postgres") {
      // Dollar-quoted string: $tag$ ... $tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
        continue;
      }
    }
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      comments.push({ start: i, end: end < 0 ? n : end });
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "#" && (dialect === "mysql" || dialect === "mariadb")) {
      const end = sql.indexOf("\n", i);
      comments.push({ start: i, end: end < 0 ? n : end });
      i = end < 0 ? n : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      comments.push({ start: i, end: end < 0 ? n : end + 2 });
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ";") separators.push(i);
    i += 1;
  }
  return { comments, separators };
}

// Expression walk

type Node = Record<string, unknown>;

const LITERAL_TYPES = new Set(["number", "string", "single_quote_string", "double_quote_string", "bool", "null", "boolean", "hex_string", "bit_string"]);

function isLiteral(node: unknown): boolean {
  return Boolean(node && typeof node === "object" && LITERAL_TYPES.has(String((node as Node).type)));
}

function columnName(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const n = node as Node;
  if (n.type !== "column_ref") return null;
  const column = n.column;
  if (typeof column === "string") return `${n.table ?? ""}.${column}`.toLowerCase();
  if (column && typeof column === "object") {
    const expr = (column as Node).expr as Node | undefined;
    if (expr && typeof expr.value === "string") return `${n.table ?? ""}.${expr.value}`.toLowerCase();
  }
  return null;
}

const COMPARISONS = new Set(["=", "!=", "<>", "<", ">", "<=", ">=", "LIKE", "ILIKE", "IS", "IS NOT", "<=>"]);

/** True when the comparison can be decided without a row: literal op literal, or a column compared with itself. */
export function isConstantComparison(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Node;
  if (n.type === "bool" || n.type === "boolean") return true;
  if (n.type === "number" && Number(n.value) !== 0) return true;
  if (n.type !== "binary_expr") return false;
  const operator = String(n.operator).toUpperCase();
  if (!COMPARISONS.has(operator)) return false;
  if (isLiteral(n.left) && isLiteral(n.right)) return true;
  const left = columnName(n.left);
  const right = columnName(n.right);
  return left !== null && left === right;
}

interface WhereAnalysis {
  tautology: boolean;
  /** The whole predicate is constant (true or false). */
  constant: boolean;
  /** Has at least one equality or IN against a column. */
  pointCondition: boolean;
}

export function analyzeWhere(where: unknown): WhereAnalysis {
  let tautology = false;
  let pointCondition = false;
  const visit = (node: unknown, underOr: boolean): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "binary_expr") {
      const operator = String(n.operator).toUpperCase();
      if (operator === "OR") {
        visit(n.left, true);
        visit(n.right, true);
        return;
      }
      if (operator === "AND") {
        visit(n.left, underOr);
        visit(n.right, underOr);
        return;
      }
      if (isConstantComparison(n)) {
        if (underOr) tautology = true;
        return;
      }
      if ((operator === "=" || operator === "IN" || operator === "<=>") && (columnName(n.left) || columnName(n.right))) {
        pointCondition = true;
      }
      return;
    }
    if (n.type === "bool" || n.type === "boolean") {
      if (underOr && n.value === true) tautology = true;
      return;
    }
    if (n.type === "expr_list" && Array.isArray(n.value)) {
      for (const item of n.value) visit(item, underOr);
    }
    if (n.type === "unary_expr") visit(n.expr, underOr);
    if (n.ast) visit(n.ast, underOr);
  };
  visit(where, false);
  const constant = isConstantComparison(where);
  return { tautology, constant, pointCondition };
}

function* walkSelects(ast: unknown): Generator<Node> {
  if (!ast || typeof ast !== "object") return;
  const n = ast as Node;
  if (n.type === "select") {
    yield n;
    const next = n._next;
    if (next) yield* walkSelects(next);
  }
  for (const key of ["with", "from", "columns", "where", "having", "set", "values", "ast", "expr", "table", "select"]) {
    const value = n[key];
    if (Array.isArray(value)) {
      for (const item of value) yield* walkSelectsIn(item);
    } else if (value && typeof value === "object" && key !== "where" && key !== "having") {
      yield* walkSelectsIn(value);
    } else if (value && typeof value === "object") {
      yield* walkSelectsIn(value);
    }
  }
}

function* walkSelectsIn(node: unknown): Generator<Node> {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  if (n.type === "select") {
    yield* walkSelects(n);
    return;
  }
  for (const value of Object.values(n)) {
    if (value && typeof value === "object") yield* walkSelectsIn(value);
  }
}

function unionProbe(select: Node): boolean {
  // A UNION member whose columns are all literals (SELECT NULL, NULL, 1) is a column-count probe.
  const columns = select.columns;
  if (!Array.isArray(columns) || columns.length === 0) return false;
  return columns.every((column) => isLiteral((column as Node).expr));
}

function normaliseName(name: string): string {
  return name.replace(/^[`"[]|[`"\]]$/g, "").toLowerCase();
}

function tableAllowed(table: string, db: string | null, allowed: string[]): boolean {
  const plain = normaliseName(table);
  const qualified = db ? `${normaliseName(db)}.${plain}` : plain;
  return allowed.some((entry) => {
    const e = entry.toLowerCase();
    return e === plain || e === qualified || (e.includes(".") && e.split(".").pop() === plain && !db);
  });
}

function limitValue(ast: Node): number | null {
  const limit = ast.limit as { value?: Array<{ value?: unknown }> } | null | undefined;
  if (limit && Array.isArray(limit.value) && limit.value.length > 0) {
    const values = limit.value.map((v) => Number(v.value)).filter((v) => Number.isFinite(v));
    // `LIMIT a, b` (mysql) puts the row count second; `LIMIT a OFFSET b` puts it first.
    const sep = (ast.limit as { seperator?: string }).seperator;
    if (values.length === 2) return sep === "," ? values[1]! : values[0]!;
    return values[0] ?? null;
  }
  const top = ast.top as { value?: unknown } | null | undefined;
  if (top && Number.isFinite(Number(top.value))) return Number(top.value);
  return null;
}

function applyRowCap(ast: Node, dialect: SqlDialect, maxRows: number): boolean {
  if (dialect === "mssql") {
    if (ast.type !== "select") return false;
    ast.top = { value: maxRows, percent: null };
    return true;
  }
  if (ast.type === "select" || ((ast.type === "update" || ast.type === "delete") && (dialect === "mysql" || dialect === "mariadb" || dialect === "sqlite"))) {
    ast.limit = { seperator: "", value: [{ type: "number", value: maxRows }] };
    return true;
  }
  return false;
}

export function analyzeSql(sql: string, options: SqlGuardOptions = {}): SqlGuardResult {
  const dialect = options.dialect ?? "postgres";
  const parser = new Parser();
  const issues: SqlIssue[] = [];
  const statements: SqlStatementInfo[] = [];
  const result: SqlGuardResult = { ok: true, dialect, statements, issues };
  const push = (issue: SqlIssue) => issues.push(issue);

  const lexical = scanSqlLexically(sql, dialect);
  if (!options.allowComments) {
    for (const span of lexical.comments) {
      push({ category: "sql_injection", score: 0.7, code: "comment", message: "SQL comment; comments are a common way to cut off the rest of a statement", span });
    }
  }

  let parsed: AST | AST[];
  try {
    parsed = parser.astify(sql, { database: DIALECT_DATABASE[dialect] });
  } catch (error) {
    push({
      category: "sql_injection",
      score: 0.8,
      code: "unparseable",
      message: `SQL could not be parsed as ${dialect}; unparseable statements are refused (${String((error as Error).message).split("\n")[0]?.slice(0, 120)})`
    });
    result.ok = false;
    return result;
  }
  const asts = Array.isArray(parsed) ? parsed : [parsed];
  if (asts.length > 1 && !options.allowStacked) {
    push({ category: "sql_injection", score: 0.95, code: "stacked_queries", message: `${asts.length} statements in one query; stacked queries are refused`, span: lexical.separators[0] !== undefined ? { start: lexical.separators[0], end: sql.length } : undefined });
  }

  const allowedTables = (options.allowedTables ?? []).filter(Boolean);
  const allowedColumns = (options.allowedColumns ?? []).map((c) => c.toLowerCase()).filter(Boolean);
  let tableList: string[] = [];
  let columnList: string[] = [];
  try {
    tableList = parser.tableList(sql, { database: DIALECT_DATABASE[dialect] });
    columnList = parser.columnList(sql, { database: DIALECT_DATABASE[dialect] });
  } catch {
    // Lists are best-effort; the AST walk below still applies.
  }

  for (const ast of asts) {
    const node = ast as unknown as Node;
    const type = String(node.type ?? "").toLowerCase();
    const kind = classifySqlStatement(ast);
    const tables = new Set<string>();
    for (const entry of tableList) {
      const [, db, table] = entry.split("::");
      if (table) tables.add(db && db !== "null" ? `${db}.${table}` : table);
    }
    statements.push({ type, kind, tables: [...tables] });

    if (kind === "write" && options.allowWrites === false) {
      push({ category: "sql_policy", score: 1, code: "write_not_allowed", message: `${type.toUpperCase()} is a write statement and writes are not allowed here` });
    }
    if (kind === "ddl" && !options.allowDdl) {
      push({ category: "sql_policy", score: 1, code: "ddl_not_allowed", message: `${type.toUpperCase()} is a DDL statement and DDL is not allowed here` });
    }
    if (kind === "other" && !(options.allowedOtherStatements ?? []).map((s) => s.toLowerCase()).includes(type)) {
      push({ category: "sql_policy", score: 0.9, code: "statement_not_allowed", message: `Statement type '${type || "unknown"}' is not allowed here` });
    }

    for (const select of walkSelects(node)) {
      const where = analyzeWhere(select.where);
      if (where.tautology) {
        push({ category: "sql_injection", score: 0.95, code: "tautology", message: "WHERE contains a condition that is always true under OR (such as OR 1=1)" });
      }
      const having = analyzeWhere(select.having);
      if (having.tautology) {
        push({ category: "sql_injection", score: 0.9, code: "tautology", message: "HAVING contains a condition that is always true under OR" });
      }
      if (select._next && unionProbe(select._next as Node)) {
        push({ category: "sql_injection", score: 0.85, code: "union_probe", message: "UNION with a literal-only SELECT, the shape of a column-count probe" });
      }
      if (Array.isArray(select.from)) {
        for (const from of select.from as Node[]) {
          if (from.on) {
            const on = analyzeWhere(from.on);
            if (on.tautology) push({ category: "sql_injection", score: 0.9, code: "tautology", message: "JOIN condition is always true under OR" });
          }
        }
      }
    }

    if (type === "update" || type === "delete") {
      const where = analyzeWhere(node.where);
      if (options.requireWhereOnMutations !== false) {
        if (!node.where) {
          push({ category: "sql_policy", score: 1, code: "mutation_without_where", message: `${type.toUpperCase()} without a WHERE clause touches every row` });
        } else if (where.constant || where.tautology) {
          push({ category: "sql_injection", score: 0.95, code: where.tautology ? "tautology" : "mutation_without_where", message: `${type.toUpperCase()} with a WHERE clause that is always true touches every row` });
        }
      }
      if (options.maxRows && node.where && !where.constant && !where.tautology) {
        const capped = applyRowCap(node, dialect, options.maxRows);
        if (!capped && !where.pointCondition) {
          push({ category: "sql_policy", score: 0.6, code: "mutation_unbounded", message: `${type.toUpperCase()} has no row cap and no equality condition; ${dialect} cannot LIMIT a mutation` });
        }
      }
    }

    if (type === "select" && options.maxRows) {
      const current = limitValue(node);
      if (current === null || current > options.maxRows) {
        if (current !== null) {
          push({ category: "sql_policy", score: 0.4, code: "row_cap_exceeded", message: `LIMIT ${current} exceeds the row cap of ${options.maxRows}; it was lowered` });
        }
        applyRowCap(node, dialect, options.maxRows);
      }
    }
  }

  if (allowedTables.length > 0) {
    for (const entry of tableList) {
      const [, db, table] = entry.split("::");
      if (!table) continue;
      if (!tableAllowed(table, db && db !== "null" ? db : null, allowedTables)) {
        push({ category: "sql_policy", score: 1, code: "table_not_allowed", message: `Table '${table}' is not in the allowlist` });
      }
    }
  }
  if (allowedColumns.length > 0) {
    const tablesInQuery = tableList.map((entry) => normaliseName(entry.split("::")[2] ?? ""));
    for (const entry of columnList) {
      const [, table, column] = entry.split("::");
      if (!column) continue;
      if (column === "(.*)" || column === "*") {
        push({ category: "sql_policy", score: 0.9, code: "wildcard_columns", message: "SELECT * is not allowed when a column allowlist is set" });
        continue;
      }
      const plain = normaliseName(column);
      const owner = table && table !== "null" ? normaliseName(table) : null;
      const allowed = allowedColumns.some((allowedEntry) => {
        if (!allowedEntry.includes(".")) return allowedEntry === plain;
        const [allowedTable, allowedColumn] = allowedEntry.split(".");
        if (allowedColumn !== plain) return false;
        if (owner) return allowedTable === owner || !tablesInQuery.includes(owner);
        return tablesInQuery.includes(allowedTable!) || tablesInQuery.length === 0;
      });
      if (!allowed) {
        push({ category: "sql_policy", score: 1, code: "column_not_allowed", message: `Column '${column}' is not in the allowlist` });
      }
    }
  }

  if (options.maxRows) {
    try {
      const rewritten = asts.length === 1 ? parser.sqlify(asts[0]!, { database: DIALECT_DATABASE[dialect] }) : asts.map((ast) => parser.sqlify(ast, { database: DIALECT_DATABASE[dialect] })).join("; ");
      if (rewritten) result.rewritten = rewritten;
    } catch {
      // A statement the parser cannot print back keeps its original text; the findings still apply.
    }
  }

  result.ok = issues.every((issue) => issue.score < 0.5);
  return result;
}

// Detector

const SQL_START = /^\s*(?:with\b|select\b|insert\b|update\b|delete\b|replace\b|merge\b|create\b|drop\b|alter\b|truncate\b|grant\b|revoke\b|exec(?:ute)?\b|call\b|show\b|describe\b|explain\b|pragma\b|set\b|use\b|begin\b|commit\b|rollback\b|\()/i;

/** True when a string looks like a SQL statement rather than prose or a name. */
export function looksLikeSql(value: string): boolean {
  if (value.length < 8 || value.length > 100_000) return false;
  // A fragment that closes a string and starts another statement is an injection payload, whatever it starts with.
  if (/['")]\s*;\s*(?:drop|delete|update|insert|select|alter|truncate|exec|shutdown)\b/i.test(value)) return true;
  if (!SQL_START.test(value)) return false;
  // Prose that starts with a keyword ("select the best option from the list") carries function words SQL never has outside strings.
  const withoutStrings = value.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (/\b(?:the|please|me|you|your|our|this|these|those|which|how|should|could|would|can|will|does|did|was|were|been|being|very|really|just|also|about|because|while|until|unless|whether)\b/i.test(withoutStrings)) return false;
  return /\b(?:from|into|table|set|values|where|database|index|view|procedure|select)\b/i.test(value) || /^\s*(?:show|pragma|use|begin|commit|rollback)\b/i.test(value);
}

interface SqlCandidate {
  sql: string;
  span: GuardSpan;
  path: string;
}

/** SQL statements in an input: the whole text, or each SQL-looking string inside a JSON argument object. */
export function findSqlCandidates(content: unknown, text: string, argumentPaths?: string[]): SqlCandidate[] {
  if (typeof content === "string") {
    return looksLikeSql(content) ? [{ sql: content, span: { start: 0, end: content.length }, path: "" }] : [];
  }
  const candidates: SqlCandidate[] = [];
  const wanted = argumentPaths && argumentPaths.length > 0 ? new Set(argumentPaths) : null;
  const visit = (value: unknown, path: string) => {
    if (typeof value === "string") {
      if (wanted ? wanted.has(path) : looksLikeSql(value)) {
        const encoded = JSON.stringify(value);
        const at = text.indexOf(encoded);
        candidates.push({ sql: value, span: at >= 0 ? { start: at + 1, end: at + encoded.length - 1 } : { start: 0, end: text.length }, path });
      }
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, path ? `${path}[${index}]` : `[${index}]`));
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) visit(inner, path ? `${path}.${key}` : key);
    }
  };
  visit(content, "");
  return candidates;
}

export function createSqlGuardDetector(): GuardDetector {
  return {
    id: SQL_GUARD_DETECTOR_ID,
    tier: "parser",
    description: "Parses SQL arguments per dialect; blocks stacked queries, tautologies and comment tricks; enforces table and column allowlists, WHERE on mutations and a row cap.",
    channels: ["tool_arguments"],
    categories: ["sql_injection", "sql_policy"],
    detect(input: GuardInput, context: DetectorContext) {
      const o = context.options;
      const options: SqlGuardOptions = {
        dialect: SQL_DIALECTS.includes(o.dialect as SqlDialect) ? (o.dialect as SqlDialect) : "postgres",
        allowedTables: Array.isArray(o.allowedTables) ? (o.allowedTables as string[]) : undefined,
        allowedColumns: Array.isArray(o.allowedColumns) ? (o.allowedColumns as string[]) : undefined,
        allowStacked: o.allowStacked === true,
        allowComments: o.allowComments === true,
        allowWrites: o.allowWrites !== false,
        allowDdl: o.allowDdl === true,
        allowedOtherStatements: Array.isArray(o.allowedOtherStatements) ? (o.allowedOtherStatements as string[]) : undefined,
        requireWhereOnMutations: o.requireWhereOnMutations !== false,
        maxRows: typeof o.maxRows === "number" && o.maxRows > 0 ? Math.floor(o.maxRows) : undefined
      };
      const argumentPaths = Array.isArray(o.argumentPaths) ? (o.argumentPaths as string[]) : undefined;
      const findings: GuardFinding[] = [];
      for (const candidate of findSqlCandidates(input.content, context.text, argumentPaths)) {
        const result = analyzeSql(candidate.sql, options);
        for (const issue of result.issues) {
          const span = issue.span ? { start: candidate.span.start + issue.span.start, end: candidate.span.start + issue.span.end } : candidate.span;
          findings.push({
            detectorId: SQL_GUARD_DETECTOR_ID,
            category: issue.category,
            score: clampScore(issue.score),
            spans: [span],
            evidence: excerptEvidence(context.text, span),
            message: issue.message,
            metadata: { code: issue.code, path: candidate.path, dialect: result.dialect, statements: result.statements.map((s) => `${s.type}:${s.kind}`) }
          });
        }
      }
      return findings;
    }
  };
}
