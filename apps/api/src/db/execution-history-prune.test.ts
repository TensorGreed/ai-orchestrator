/**
 * Phase 13.1 — pruneExecutionHistory removes the same rows on both stores (Postgres when TEST_POSTGRES_URL is set):
 * execution history and tool calls started before the cut-off, MCP cassettes and guard events created before it, and
 * decided approval requests created before it (a pending one stays with its paused run). It returns the number of
 * history rows removed. Rows are seeded with SQL because cassettes and guard events are not on PostgresStore in this
 * lane yet; the same statements run on both dialects.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "./store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";

const OLD = "2001-01-01T00:00:00.000Z";
const NEW = "2100-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";

const SEED = [OLD, NEW].flatMap((at, i) => {
  const tag = i === 0 ? "old" : "new";
  return [
    `INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-${tag}', 'wf', 'success', '${at}')`,
    `INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok, created_at)
       VALUES ('call-${tag}', 'run-${tag}', 'wf', 'n', 'http-mcp', 't', '${at}', 1, '${at}')`,
    `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, cassette_json, created_at) VALUES ('cas-${tag}', 'run-${tag}', 'wf', '{}', '${at}')`,
    `INSERT INTO guard_events (id, verdict_id, execution_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
       profile_id, profile_version, profile_hash, created_at)
       VALUES ('ge-${tag}', 'v', 'run-${tag}', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${at}')`,
    ...["approved", "pending"].map(
      (status) => `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
       VALUES ('req-${tag}-${status}', 'run-${tag}', 'wf', 'default', 'gate', 'approval_gate', '${status}', '{}', '${at}', '${at}')`
    )
  ];
});

const TABLES = { execution_history: "id", mcp_tool_calls: "id", mcp_cassettes: "id", guard_events: "id", approval_requests: "id" } as const;

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("execution history prune");

for (const kind of kinds) {
  describe(`pruneExecutionHistory [${kind}]`, () => {
    let current: TestStore | undefined;
    afterEach(async () => {
      await current?.cleanup().catch(() => undefined);
      current = undefined;
    });

    /** Runs `statements` on the store's database. */
    async function seed(statements: string[]): Promise<Store> {
      const sql = testSql(current!.store);
      for (const statement of statements) await sql.run(statement);
      return current!.store;
    }

    async function remaining(): Promise<Record<string, string[]>> {
      const sql = testSql(current!.store);
      const out: Record<string, string[]> = {};
      for (const table of Object.keys(TABLES)) {
        out[table] = (await sql.all<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).map((row) => row.id);
      }
      return out;
    }

    it("removes history, tool calls, cassettes, guard events and decided approvals before the cut-off; keeps pending ones", async () => {
      current = await createTestStore({ kind });
      const store = await seed(SEED);
      expect(await store.pruneExecutionHistory({ before: CUT })).toBe(1);
      expect(await remaining()).toEqual({
        execution_history: ["run-new"],
        mcp_tool_calls: ["call-new"],
        mcp_cassettes: ["cas-new"],
        guard_events: ["ge-new"],
        approval_requests: ["req-new-approved", "req-new-pending", "req-old-pending"]
      });
    }, 60_000);
  });
}
