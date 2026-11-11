/**
 * 13.3 — store contract: per-table retention purges (pruneRetentionTable), the backlog count and the purge log, on both
 * stores. Rows are seeded with SQL that runs on both dialects.
 */
import { expect, it } from "vitest";
import type { RetentionRunView } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { RETENTION_TABLES, type RetentionTable } from "../retention-tables.js";
import { retentionRowSql as insert } from "../../test-support/retention-rows.js";

const OLD = "2001-01-01T00:00:00.000Z";
const NEW = "2100-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";

/** The column that names a row of `table` in these tests. */
const NAME_COLUMN: Partial<Record<RetentionTable, string>> = { session_memory: "session_id", session_artifacts: "artifact_key" };

describeStoreContract("store contract: retention purges", (ctx) => {
  async function seed(statements: string[]): Promise<void> {
    const sql = testSql(ctx.store());
    for (const statement of statements) await sql.run(statement);
  }

  async function names(table: RetentionTable): Promise<string[]> {
    const column = NAME_COLUMN[table] ?? "id";
    const rows = await testSql(ctx.store()).all<{ name: string }>(`SELECT ${column} AS name FROM ${table} ORDER BY ${column}`);
    return rows.map((row) => row.name);
  }

  it("every retention table: deletes rows aged before the cut-off, keeps newer ones", async () => {
    const store = ctx.store();
    const tables = Object.keys(RETENTION_TABLES) as RetentionTable[];
    await seed(tables.flatMap((table) => [insert(table, "old-1", OLD), insert(table, "old-2", OLD), insert(table, "new-1", NEW)]));
    for (const table of tables) {
      expect(await store.countRetentionDue(table, { before: CUT, cap: 100 }), table).toBe(2);
      expect(await store.pruneRetentionTable(table, { before: CUT, limit: 100 }), table).toBe(2);
      expect(await names(table), table).toEqual(["new-1"]);
      expect(await store.countRetentionDue(table, { before: CUT, cap: 100 }), table).toBe(0);
    }
  });

  it("respects the limit across batches and the backlog cap", async () => {
    const store = ctx.store();
    const statements = Array.from({ length: 2_500 }, (_, i) => insert("mcp_tool_calls", `old-${String(i).padStart(5, "0")}`, OLD));
    await seed([...statements, insert("mcp_tool_calls", "new-1", NEW)]);
    expect(await store.countRetentionDue("mcp_tool_calls", { before: CUT, cap: 2_000 })).toBe(2_000);
    expect(await store.pruneRetentionTable("mcp_tool_calls", { before: CUT, limit: 1_200 })).toBe(1_200);
    expect(await store.countRetentionDue("mcp_tool_calls", { before: CUT, cap: 10_000 })).toBe(1_300);
    expect(await store.pruneRetentionTable("mcp_tool_calls", { before: CUT, limit: 50_000 })).toBe(1_300);
    expect(await names("mcp_tool_calls")).toEqual(["new-1"]);
    expect(await store.pruneRetentionTable("mcp_tool_calls", { before: CUT, limit: 0 })).toBe(0);
  }, 60_000);

  it("keeps pending approvals and unfinished queue jobs whatever their age", async () => {
    const store = ctx.store();
    await seed([
      insert("approval_requests", "old-approved", OLD),
      insert("approval_requests", "old-rejected", OLD, { status: "rejected" }),
      insert("approval_requests", "old-pending", OLD, { status: "pending" }),
      insert("execution_queue", "old-completed", OLD),
      insert("execution_queue", "old-dead", OLD, { status: "dead" }),
      insert("execution_queue", "old-pending", OLD, { status: "pending" }),
      insert("execution_queue", "old-running", OLD, { status: "running" })
    ]);
    expect(await store.countRetentionDue("approval_requests", { before: CUT, cap: 10 })).toBe(2);
    expect(await store.pruneRetentionTable("approval_requests", { before: CUT, limit: 10 })).toBe(2);
    expect(await names("approval_requests")).toEqual(["old-pending"]);
    expect(await store.pruneRetentionTable("execution_queue", { before: CUT, limit: 10 })).toBe(2);
    expect(await names("execution_queue")).toEqual(["old-pending", "old-running"]);
  });

  it("refuses a table outside the retention list", async () => {
    const store = ctx.store();
    await expect(store.pruneRetentionTable("users" as RetentionTable, { before: CUT, limit: 10 })).rejects.toThrow(/Not a retention table/);
    await expect(store.countRetentionDue("users" as RetentionTable, { before: CUT, cap: 10 })).rejects.toThrow(/Not a retention table/);
  });

  it("records purges and lists them newest first", async () => {
    const store = ctx.store();
    const run = (id: string, startedAt: string, extra: Partial<RetentionRunView> = {}): RetentionRunView => ({
      id,
      startedAt,
      finishedAt: startedAt,
      instanceId: "instance-a",
      reason: "interval",
      outcome: "ok",
      counts: {},
      capped: [],
      error: null,
      ...extra
    });
    await store.saveRetentionRun(run("r1", "2026-11-10T10:00:00.000Z"));
    await store.saveRetentionRun(
      run("r2", "2026-11-10T11:00:00.000Z", {
        reason: "write",
        outcome: "partial",
        counts: { runs: 12, tool_calls: 3 },
        capped: ["runs"],
        error: "usage: failed"
      })
    );
    expect(await store.listRetentionRuns(10)).toEqual([
      run("r2", "2026-11-10T11:00:00.000Z", {
        reason: "write",
        outcome: "partial",
        counts: { runs: 12, tool_calls: 3 },
        capped: ["runs"],
        error: "usage: failed"
      }),
      run("r1", "2026-11-10T10:00:00.000Z")
    ]);
    expect((await store.listRetentionRuns(1)).map((entry) => entry.id)).toEqual(["r2"]);
  });
});
