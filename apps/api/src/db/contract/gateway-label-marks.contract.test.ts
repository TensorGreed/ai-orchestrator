/**
 * MCP 2026-07-28 (v71) — store contract: label marks of stateless gateway callers, on both stores. A raise only adds
 * labels, an expired mark starts clean, reading a live mark keeps it alive, concurrent raises lose nothing, and a
 * revoked client's or deleted toolset's marks are gone.
 */
import { expect, it } from "vitest";
import { MIGRATIONS } from "../migrations.js";
import type { McpGatewayLabelMarkKey, McpGatewayLabelMarkRaise } from "../gateway-label-marks.js";
import type { Store } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";

const KEY: McpGatewayLabelMarkKey = { clientId: "mcc_1", toolsetId: "mts_1", scopeKey: "" };
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const IDLE = 30 * 60_000;

function at(offsetMs: number): { now: string; expiresAt: string } {
  return { now: new Date(T0 + offsetMs).toISOString(), expiresAt: new Date(T0 + offsetMs + IDLE).toISOString() };
}

function raise(input: Partial<McpGatewayLabelMarkRaise> & { offsetMs?: number } = {}): McpGatewayLabelMarkRaise {
  const { offsetMs = 0, ...rest } = input;
  return { ...KEY, provenance: [], dataClasses: [], ...at(offsetMs), ...rest };
}

async function toolsetAndClient(store: Store, toolsetId: string, clientId: string): Promise<void> {
  await store.createMcpToolset({ id: toolsetId, slug: toolsetId, name: toolsetId, description: null, projectId: null, enabled: true, createdBy: null, members: [] });
  await store.createMcpClient({
    id: clientId,
    name: clientId,
    tokenPrefix: `p_${clientId}`,
    tokenHash: "h",
    toolsetIds: [toolsetId],
    role: "builder",
    createdBy: null,
    createdByEmail: null,
    expiresAt: null
  });
}

describeStoreContract("store contract: gateway label marks", (ctx) => {
  it("v71 creates the table and its expiry index", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 71)!;
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS mcp_gateway_label_marks");
    expect(migration.up).toContain("PRIMARY KEY (client_id, toolset_id, scope_key)");
    expect(migration.down).toContain("DROP TABLE IF EXISTS mcp_gateway_label_marks");
    const sql = testSql(ctx.store());
    const columns =
      sql.kind === "sqlite"
        ? (await sql.all<{ name: string }>(`PRAGMA table_info(mcp_gateway_label_marks)`)).map((column) => column.name)
        : (
            await sql.all<{ name: string }>(
              `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`,
              "mcp_gateway_label_marks"
            )
          ).map((column) => column.name);
    expect(columns.sort()).toEqual(
      ["client_id", "data_classes_json", "expires_at", "last_seen_at", "provenance_json", "raise_audited", "raised_at", "scope_key", "toolset_id", "unobserved"].sort()
    );
    const index =
      sql.kind === "sqlite"
        ? await sql.get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`, "idx_mcp_gateway_label_marks_expires")
        : await sql.get(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?`, "idx_mcp_gateway_label_marks_expires");
    expect(index).toBeDefined();
  });

  it("creates a mark on the first raise, only ever adds labels, and reports the first raise once", async () => {
    const store = ctx.store();
    expect(await store.readMcpGatewayLabelMark(KEY, at(0))).toBeNull();

    // The client's own request carries nothing: no raise yet.
    const quiet = await store.raiseMcpGatewayLabelMark(raise({ provenance: ["user"] }));
    expect(quiet.firstRaise).toBe(false);
    expect(quiet.mark).toMatchObject({ provenance: ["user"], dataClasses: [], raisedAt: null, raiseAudited: false });

    const first = await store.raiseMcpGatewayLabelMark(raise({ provenance: ["untrusted_external", "trusted", "made_up"], dataClasses: ["pii.email", "Not A Class!"], offsetMs: 1_000 }));
    expect(first.firstRaise).toBe(true);
    // `trusted` is never collected; unknown labels and invalid class names are dropped.
    expect(first.mark).toMatchObject({ provenance: ["user", "untrusted_external"], dataClasses: ["pii.email"], raiseAudited: true, raisedAt: at(1_000).now });

    // A raise with less never removes anything, and the first raise is not reported again.
    const second = await store.raiseMcpGatewayLabelMark(raise({ provenance: ["sensitive"], offsetMs: 2_000 }));
    expect(second.firstRaise).toBe(false);
    expect(second.mark).toMatchObject({ provenance: ["user", "untrusted_external", "sensitive"], dataClasses: ["pii.email"], raisedAt: at(1_000).now });

    const read = await store.readMcpGatewayLabelMark(KEY, at(3_000));
    expect(read).toMatchObject({ ...KEY, provenance: ["user", "untrusted_external", "sensitive"], dataClasses: ["pii.email"], unobserved: false, raiseAudited: true });
    expect(Date.parse(read!.raisedAt!)).toBe(T0 + 1_000);
    // Reading keeps the mark alive.
    expect(Date.parse(read!.expiresAt)).toBe(T0 + 3_000 + IDLE);
    expect(Date.parse(read!.lastSeenAt)).toBe(T0 + 3_000);
  });

  it("keeps marks of other clients, toolsets and users apart", async () => {
    const store = ctx.store();
    await store.raiseMcpGatewayLabelMark(raise({ provenance: ["untrusted_external"] }));
    for (const other of [
      { ...KEY, clientId: "mcc_2" },
      { ...KEY, toolsetId: "mts_2" },
      { ...KEY, scopeKey: "user-1" }
    ]) {
      expect(await store.readMcpGatewayLabelMark(other, at(1_000))).toBeNull();
    }
    const user = await store.raiseMcpGatewayLabelMark(raise({ scopeKey: "user-1", provenance: ["sensitive"] }));
    expect(user.firstRaise).toBe(true);
    expect((await store.readMcpGatewayLabelMark(KEY, at(1_000)))?.provenance).toEqual(["untrusted_external"]);
  });

  it("ends a mark at its expiry: reads miss it, the next raise starts clean, and the sweep deletes it", async () => {
    const store = ctx.store();
    await store.raiseMcpGatewayLabelMark(raise({ provenance: ["untrusted_external"], dataClasses: ["pii.email"] }));
    // Just before the expiry it is live; at the expiry it is gone.
    expect(await store.readMcpGatewayLabelMark(KEY, { now: new Date(T0 + IDLE - 1).toISOString(), expiresAt: new Date(T0 + IDLE - 1).toISOString() })).not.toBeNull();
    expect(await store.readMcpGatewayLabelMark(KEY, at(IDLE + 1))).toBeNull();
    expect(await store.listMcpGatewayLabelMarks({ clientId: KEY.clientId }, at(IDLE + 1).now)).toEqual([]);

    const fresh = await store.raiseMcpGatewayLabelMark(raise({ provenance: ["sensitive"], offsetMs: IDLE + 2 }));
    expect(fresh.firstRaise).toBe(true);
    expect(fresh.mark).toMatchObject({ provenance: ["sensitive"], dataClasses: [], raisedAt: at(IDLE + 2).now });

    // The sweep deletes expired rows only, in batches.
    await store.raiseMcpGatewayLabelMark(raise({ clientId: "mcc_old1", provenance: ["sensitive"] }));
    await store.raiseMcpGatewayLabelMark(raise({ clientId: "mcc_old2", provenance: ["sensitive"] }));
    const later = new Date(T0 + IDLE + 10).toISOString();
    expect(await store.sweepMcpGatewayLabelMarks(later, 1)).toBe(1);
    expect(await store.sweepMcpGatewayLabelMarks(later, 10)).toBe(1);
    expect(await store.sweepMcpGatewayLabelMarks(later, 10)).toBe(0);
    expect(await store.readMcpGatewayLabelMark(KEY, at(IDLE + 3))).toMatchObject({ provenance: ["sensitive"] });
  });

  it("notes untracked results and turns them into outside content once, atomically", async () => {
    const store = ctx.store();
    const noted = await store.raiseMcpGatewayLabelMark(raise({ unobserved: true }));
    expect(noted).toMatchObject({ firstRaise: false, mark: { unobserved: true, provenance: [], raisedAt: null } });
    // A plain raise keeps the note.
    expect((await store.raiseMcpGatewayLabelMark(raise({ provenance: ["user"] }))).mark.unobserved).toBe(true);
    const converted = await store.raiseMcpGatewayLabelMark(raise({ convertUnobserved: true, offsetMs: 500 }));
    expect(converted.firstRaise).toBe(true);
    expect(converted.mark).toMatchObject({ unobserved: false, provenance: ["user", "untrusted_external"] });
    // Converting again with nothing noted changes nothing.
    expect((await store.raiseMcpGatewayLabelMark(raise({ convertUnobserved: true }))).firstRaise).toBe(false);
  });

  it("loses no label when many raises run at once", async () => {
    const store = ctx.store();
    const classes = Array.from({ length: 12 }, (_, index) => `pii.c${index}`);
    const results = await Promise.all(
      classes.map((name, index) => store.raiseMcpGatewayLabelMark(raise({ provenance: index % 2 === 0 ? ["untrusted_external"] : ["sensitive"], dataClasses: [name], offsetMs: index })))
    );
    // Exactly one raise was the first.
    expect(results.filter((result) => result.firstRaise)).toHaveLength(1);
    const read = await store.readMcpGatewayLabelMark(KEY, at(100));
    expect(read?.provenance).toEqual(["untrusted_external", "sensitive"]);
    expect(read?.dataClasses).toEqual([...classes].sort());
  });

  it("lists a client's live marks, latest call first", async () => {
    const store = ctx.store();
    await store.raiseMcpGatewayLabelMark(raise({ toolsetId: "mts_a", provenance: ["sensitive"] }));
    await store.raiseMcpGatewayLabelMark(raise({ toolsetId: "mts_b", scopeKey: "user-7", offsetMs: 5_000 }));
    await store.raiseMcpGatewayLabelMark(raise({ clientId: "mcc_other", offsetMs: 6_000 }));
    const listed = await store.listMcpGatewayLabelMarks({ clientId: KEY.clientId }, at(5_500).now);
    expect(listed.map((mark) => [mark.toolsetId, mark.scopeKey])).toEqual([
      ["mts_b", "user-7"],
      ["mts_a", ""]
    ]);
    expect(listed[1]).toMatchObject({ provenance: ["sensitive"], raiseAudited: true });
  });

  it("deletes a client's marks when it is revoked and a toolset's marks when it is deleted", async () => {
    const store = ctx.store();
    await toolsetAndClient(store, "mts_x", "mcc_x");
    await toolsetAndClient(store, "mts_y", "mcc_y");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + IDLE).toISOString();
    const mark = (clientId: string, toolsetId: string) =>
      store.raiseMcpGatewayLabelMark({ clientId, toolsetId, scopeKey: "", provenance: ["untrusted_external"], dataClasses: [], now, expiresAt });
    await mark("mcc_x", "mts_x");
    await mark("mcc_x", "mts_y");
    await mark("mcc_y", "mts_x");
    await mark("mcc_y", "mts_y");

    await store.revokeMcpClient("mcc_x");
    expect(await store.listMcpGatewayLabelMarks({ clientId: "mcc_x" }, now)).toEqual([]);
    expect((await store.listMcpGatewayLabelMarks({ clientId: "mcc_y" }, now)).map((entry) => entry.toolsetId).sort()).toEqual(["mts_x", "mts_y"]);

    expect(await store.deleteMcpToolset("mts_x")).toBe(true);
    expect((await store.listMcpGatewayLabelMarks({ clientId: "mcc_y" }, now)).map((entry) => entry.toolsetId)).toEqual(["mts_y"]);
  });
});
