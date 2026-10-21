import { describe, expect, it } from "vitest";
import type { GuardFinding } from "../types";
import { analyzeSql, createSqlGuardDetector, findSqlCandidates, looksLikeSql, SQL_DIALECTS, type SqlDialect } from "./sql-guard";

const codes = (sql: string, options?: Parameters<typeof analyzeSql>[1]) => analyzeSql(sql, options).issues.map((i) => i.code);

describe("sql guard: classification", () => {
  it.each(SQL_DIALECTS)("classifies read, write and ddl statements for %s", (dialect: SqlDialect) => {
    expect(analyzeSql("SELECT id FROM users WHERE id = 1", { dialect }).statements[0]!.kind).toBe("read");
    expect(analyzeSql("INSERT INTO users (id) VALUES (1)", { dialect }).statements[0]!.kind).toBe("write");
    expect(analyzeSql("UPDATE users SET name = 'x' WHERE id = 1", { dialect }).statements[0]!.kind).toBe("write");
    expect(analyzeSql("DELETE FROM users WHERE id = 1", { dialect }).statements[0]!.kind).toBe("write");
    expect(analyzeSql("CREATE TABLE t (id INT)", { dialect, allowDdl: true }).statements[0]!.kind).toBe("ddl");
    expect(analyzeSql("DROP TABLE users", { dialect }).statements[0]!.kind).toBe("ddl");
  });

  it("refuses DDL and other statements unless allowed", () => {
    expect(codes("DROP TABLE users", { dialect: "postgres" })).toContain("ddl_not_allowed");
    expect(codes("DROP TABLE users", { dialect: "postgres", allowDdl: true })).toEqual([]);
    expect(codes("SHOW TABLES", { dialect: "mysql" })).toContain("statement_not_allowed");
    expect(codes("SHOW TABLES", { dialect: "mysql", allowedOtherStatements: ["show"] })).toEqual([]);
    expect(codes("INSERT INTO t (a) VALUES (1)", { dialect: "sqlite", allowWrites: false })).toContain("write_not_allowed");
  });
});

describe("sql guard: injection shapes", () => {
  it.each(SQL_DIALECTS)("blocks stacked queries for %s", (dialect: SqlDialect) => {
    const result = analyzeSql("SELECT id FROM users WHERE id = 1; DROP TABLE users", { dialect });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("stacked_queries");
    expect(result.statements).toHaveLength(2);
  });

  it.each(SQL_DIALECTS)("detects tautologies for %s", (dialect: SqlDialect) => {
    expect(codes("SELECT id FROM users WHERE name = 'x' OR 1=1", { dialect })).toContain("tautology");
    expect(codes("SELECT id FROM users WHERE name = 'x' OR 'a'='a'", { dialect })).toContain("tautology");
    expect(codes("SELECT id FROM users WHERE name = 'x' OR id = id", { dialect })).toContain("tautology");
    expect(codes("SELECT id FROM users WHERE id = 1 AND 1=1", { dialect })).not.toContain("tautology");
    expect(codes("SELECT id FROM users WHERE id = 1 OR id = 2", { dialect })).not.toContain("tautology");
  });

  it("detects comment tricks and lets them be allowed", () => {
    const sql = "SELECT id FROM users WHERE name = 'x' -- AND active = 1";
    const result = analyzeSql(sql, { dialect: "postgres" });
    expect(result.issues.map((i) => i.code)).toContain("comment");
    const span = result.issues.find((i) => i.code === "comment")!.span!;
    expect(sql.slice(span.start, span.end)).toBe("-- AND active = 1");
    expect(codes("SELECT id FROM users /* hint */ WHERE id = 1", { dialect: "mysql" })).toContain("comment");
    expect(codes("SELECT id FROM users # trailing", { dialect: "mysql" })).toContain("comment");
    expect(codes("SELECT id FROM users WHERE name = '-- not a comment'", { dialect: "postgres" })).toEqual([]);
    expect(codes("SELECT id FROM users /* hint */ WHERE id = 1", { dialect: "mysql", allowComments: true })).toEqual([]);
  });

  it("detects union column probes", () => {
    expect(codes("SELECT name FROM users WHERE id = 1 UNION SELECT NULL", { dialect: "postgres" })).toContain("union_probe");
    expect(codes("SELECT name FROM users WHERE id = 1 UNION SELECT name FROM admins", { dialect: "postgres" })).not.toContain("union_probe");
  });

  it("fails closed on unparseable SQL", () => {
    const result = analyzeSql("SELECT * FROM users WHERE name = '' OR '1'='1", { dialect: "sqlite" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.code).toBe("unparseable");
    expect(result.issues[0]!.score).toBeGreaterThanOrEqual(0.5);
    expect(analyzeSql("not sql at all", { dialect: "mssql" }).ok).toBe(false);
  });
});

describe("sql guard: policy", () => {
  it("enforces table allowlists, schema-qualified too", () => {
    const options = { dialect: "postgres" as const, allowedTables: ["public.users", "orders"] };
    expect(codes("SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id WHERE u.id = 1", options)).toEqual([]);
    expect(codes("SELECT id FROM public.users WHERE id = 1", options)).toEqual([]);
    expect(codes("SELECT id FROM admins WHERE id = 1", options)).toContain("table_not_allowed");
    expect(codes("SELECT name FROM users WHERE id = 1 UNION SELECT password FROM secrets", options)).toContain("table_not_allowed");
  });

  it("enforces column allowlists and rejects SELECT *", () => {
    const options = { dialect: "mysql" as const, allowedTables: ["users"], allowedColumns: ["users.id", "users.name", "email"] };
    expect(codes("SELECT id, name, email FROM users WHERE id = 1", options)).toEqual([]);
    expect(codes("SELECT password FROM users WHERE id = 1", options)).toContain("column_not_allowed");
    expect(codes("SELECT * FROM users WHERE id = 1", options)).toContain("wildcard_columns");
    expect(codes("UPDATE users SET name = 'x' WHERE id = 1", options)).toEqual([]);
    expect(codes("UPDATE users SET password = 'x' WHERE id = 1", options)).toContain("column_not_allowed");
  });

  it("requires WHERE on mutations and treats constant WHERE as missing", () => {
    expect(codes("DELETE FROM users", { dialect: "postgres" })).toContain("mutation_without_where");
    expect(codes("UPDATE users SET active = 0", { dialect: "mssql" })).toContain("mutation_without_where");
    expect(codes("UPDATE users SET active = 0 WHERE 1=1", { dialect: "mysql" })).toContain("mutation_without_where");
    expect(codes("DELETE FROM users WHERE id = 1 OR 1=1", { dialect: "sqlite" })).toContain("tautology");
    expect(codes("DELETE FROM users WHERE id = 1", { dialect: "sqlite" })).toEqual([]);
    expect(codes("DELETE FROM users", { dialect: "postgres", requireWhereOnMutations: false })).toEqual([]);
  });

  it("applies a row cap: rewrite for reads, LIMIT or check for mutations", () => {
    const read = analyzeSql("SELECT id FROM users WHERE active = true", { dialect: "postgres", maxRows: 100 });
    expect(read.rewritten).toMatch(/LIMIT 100$/);
    expect(read.ok).toBe(true);
    const lowered = analyzeSql("SELECT id FROM users WHERE active = true LIMIT 5000", { dialect: "postgres", maxRows: 100 });
    expect(lowered.rewritten).toMatch(/LIMIT 100$/);
    expect(lowered.issues.map((i) => i.code)).toContain("row_cap_exceeded");
    expect(lowered.ok).toBe(true);
    const kept = analyzeSql("SELECT id FROM users WHERE active = true LIMIT 10", { dialect: "postgres", maxRows: 100 });
    expect(kept.rewritten).toMatch(/LIMIT 10$/);
    expect(analyzeSql("SELECT id FROM users WHERE active = 1", { dialect: "mssql", maxRows: 50 }).rewritten).toMatch(/SELECT TOP 50/);
    expect(analyzeSql("UPDATE users SET active = 0 WHERE created < '2020-01-01'", { dialect: "mysql", maxRows: 100 }).rewritten).toMatch(/LIMIT 100$/);
    expect(codes("UPDATE users SET active = 0 WHERE created < '2020-01-01'", { dialect: "postgres", maxRows: 100 })).toContain("mutation_unbounded");
    expect(codes("UPDATE users SET active = 0 WHERE id = 7", { dialect: "postgres", maxRows: 100 })).toEqual([]);
  });
});

describe("sql guard: detector", () => {
  const detector = createSqlGuardDetector();
  const run = (content: unknown, options: Record<string, unknown> = {}) => {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return detector.detect({ channel: "tool_arguments", content, tool: { toolName: "query" } }, { text, options, now: () => 0 }) as GuardFinding[];
  };

  it("finds SQL inside JSON arguments and maps spans into the serialised text", () => {
    const content = { query: "SELECT id FROM users WHERE id = 1 OR 1=1", limit: 10 };
    const findings = run(content, { dialect: "postgres" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.category).toBe("sql_injection");
    const text = JSON.stringify(content);
    expect(text.slice(findings[0]!.spans[0]!.start, findings[0]!.spans[0]!.end)).toBe(content.query);
    expect(findings[0]!.metadata).toMatchObject({ code: "tautology", path: "query", dialect: "postgres" });
  });

  it("skips strings that are not SQL and honours argumentPaths", () => {
    expect(run({ note: "select the best option from the list" })).toEqual([]);
    expect(looksLikeSql("select the best option from the list")).toBe(false);
    expect(looksLikeSql("SELECT id FROM users WHERE id = 1")).toBe(true);
    expect(looksLikeSql("hello world")).toBe(false);
    expect(findSqlCandidates({ a: "DELETE FROM t", b: "DELETE FROM t" }, JSON.stringify({ a: "DELETE FROM t", b: "DELETE FROM t" }), ["b"]).map((c) => c.path)).toEqual(["b"]);
  });

  it("reports policy findings with the table name but never the row values", () => {
    const findings = run({ sql: "UPDATE users SET email = 'secret@example.com'" }, { dialect: "postgres", allowedTables: ["orders"] });
    expect(findings.map((f) => f.metadata?.code)).toEqual(expect.arrayContaining(["mutation_without_where", "table_not_allowed"]));
    for (const f of findings) expect(f.message).not.toContain("secret@example.com");
  });
});
