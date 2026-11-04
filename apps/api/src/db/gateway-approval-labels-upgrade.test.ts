/**
 * 12.2 (v56) — a gateway approval request stored before the labels column existed reads back with `labels: null`,
 * on both stores (Postgres when TEST_POSTGRES_URL is set). On SQLite the column is dropped and the store reopened, so
 * the upgrade path (`ensureColumn` on a table without it) runs against a stored row.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind, testStorePool } from "../test-support/test-store.js";
import { SqliteStore } from "./database.js";
import type { Store } from "./store.js";

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("gateway approval rows stored before v56");

const T0 = "2026-10-30T10:00:00.000Z";
const EXPIRES = "2026-10-30T11:00:00.000Z";
const INSERT_OLD_ROW = `INSERT INTO mcp_gateway_approvals (
  id, client_id, client_name, toolset_id, project_id, server_id, server_name, tool_name, gateway_tool_name,
  args_hash, args_preview, rule_id, rule_name, message, status, requested_at, expires_at
) VALUES ('mga_old', 'mcpc_1', 'CI bot', 'mts_1', 'default', 'mcp_github', 'GitHub', 'push', 'github__push',
  'hash-old', '{}', 'mtp_1', 'Prod pushes', 'needs approval', 'pending', '${T0}', '${EXPIRES}')`;

for (const kind of kinds) {
  describe(`gateway approvals stored before v56 (${kind})`, () => {
    let current: TestStore | undefined;
    let reopened: SqliteStore | undefined;

    afterEach(async () => {
      await reopened?.close().catch(() => undefined);
      reopened = undefined;
      await current?.cleanup().catch(() => undefined);
      current = undefined;
    });

    async function storeWithOldRow(): Promise<Store> {
      const test = current!;
      if (test.kind === "postgres") {
        const pool = testStorePool(test);
        try {
          await pool.query(INSERT_OLD_ROW);
        } finally {
          await pool.end();
        }
        return test.store;
      }
      await test.store.close();
      const db = new Database(test.file!);
      db.exec(`ALTER TABLE mcp_gateway_approvals DROP COLUMN labels_json`);
      db.exec(INSERT_OLD_ROW);
      db.close();
      reopened = await SqliteStore.create(test.file!);
      return reopened;
    }

    it("reads back with labels null, in a list and by id, and a repeat of that call adds its labels", async () => {
      current = await createTestStore({ kind });
      const store = await storeWithOldRow();
      const listed = await store.listMcpGatewayApprovals({}, T0);
      expect(listed.find((entry) => entry.id === "mga_old")?.labels).toBeNull();
      expect((await store.getMcpGatewayApproval("mga_old"))?.labels).toBeNull();

      const labels = { provenance: ["untrusted_external" as const], tracked: true };
      const again = await store.createMcpGatewayApproval(
        {
          id: "mga_new", clientId: "mcpc_1", clientName: "CI bot", toolsetId: "mts_1", projectId: "default", serverId: "mcp_github",
          serverName: "GitHub", toolName: "push", gatewayToolName: "github__push", argsHash: "hash-old", argsPreview: "{}",
          ruleId: "mtp_1", ruleName: "Prod pushes", message: "needs approval", requestedAt: T0, expiresAt: EXPIRES, labels
        },
        T0
      );
      expect(again).toMatchObject({ created: false, approval: { id: "mga_old", labels } });
    });
  });
}
