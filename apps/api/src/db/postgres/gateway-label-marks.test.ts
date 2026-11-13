/**
 * MCP 2026-07-28 (v71) — the Postgres raise without a database: when the caller's row is gone by the time the locked
 * read runs (another instance's sweep deleted it as expired after the insert), the merged mark is still written.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import type { PgContext } from "./context.js";
import { raiseMcpGatewayLabelMark } from "./gateway-label-marks.js";

describe("raiseMcpGatewayLabelMark on Postgres", () => {
  it("writes the merged mark as an upsert, so a row swept between the insert and the locked read is re-created", async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        // The sweep won the race: the locked read finds no row.
        return { rows: [], rowCount: sql.trimStart().startsWith("SELECT") ? 0 : 1 };
      }
    } as unknown as PoolClient;
    const ctx = { withTransaction: async <T>(fn: (c: PoolClient) => Promise<T>) => await fn(client) } as unknown as PgContext;

    const { mark, firstRaise } = await raiseMcpGatewayLabelMark(ctx, {
      clientId: "mcc_1",
      toolsetId: "mts_1",
      scopeKey: "",
      provenance: ["untrusted_external"],
      dataClasses: [],
      now: "2026-11-12T10:00:00.000Z",
      expiresAt: "2026-11-12T10:30:00.000Z"
    });
    expect(firstRaise).toBe(true);
    expect(mark.provenance).toEqual(["untrusted_external"]);
    const write = statements.at(-1)!;
    expect(write.sql).toMatch(/^INSERT INTO mcp_gateway_label_marks/);
    expect(write.sql).toMatch(/ON CONFLICT \(client_id, toolset_id, scope_key\) DO UPDATE SET/);
    expect(write.params.slice(0, 4)).toEqual(["mcc_1", "mts_1", "", JSON.stringify(["untrusted_external"])]);
  });
});
