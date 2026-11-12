/**
 * 13.3 — store contract: erasure tombstones on both stores (written once per row, pruned by age in batches, restore
 * markers taken once and left out of the count), vault tokens deleted with their tombstones, a subject row under a legal
 * hold left in place, and a staff pseudonymisation that leaves held rows (counted) and matches the email in any case.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";

const AT = "2026-11-01T00:00:00.000Z";

describeStoreContract("store contract: erasure tombstones", (ctx) => {
  it("writes each tombstone once, prunes by age in batches, and counts without restore markers", async () => {
    const store = ctx.store();
    await store.writeErasureTombstones([
      { kind: "run", rowId: "r1", requestId: "dsr-1", erasedAt: "2026-01-01T00:00:00.000Z" },
      { kind: "run", rowId: "r2", requestId: "dsr-1", erasedAt: "2026-01-02T00:00:00.000Z" },
      { kind: "run", rowId: "r3", requestId: null, erasedAt: "2026-10-01T00:00:00.000Z" }
    ]);
    // Again: an upsert, not a second row.
    await store.writeErasureTombstones([{ kind: "run", rowId: "r1", requestId: "dsr-2", erasedAt: "2026-01-01T00:00:00.000Z" }]);
    await testSql(store).run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('restore_skipped', 'restore-1', NULL, ?)", AT);
    expect(await store.countErasureTombstones()).toBe(3);
    expect(await store.pruneErasureTombstones("2026-06-01T00:00:00.000Z", 1)).toBe(1);
    expect(await store.pruneErasureTombstones("2026-06-01T00:00:00.000Z", 10)).toBe(1);
    expect(await store.countErasureTombstones()).toBe(1);
    const markers = await store.takeRestoreSkippedMarkers();
    expect(markers.map((marker) => marker.id)).toEqual(["restore-1"]);
    expect(await store.takeRestoreSkippedMarkers()).toEqual([]);
  });

  it("deletes vault tokens with a tombstone each; unknown tokens count nothing", async () => {
    const store = ctx.store();
    const sql = testSql(store);
    for (const token of ["tok_email_AAAAAAAAAAAAAAAA", "tok_email_BBBBBBBBBBBBBBBB"]) {
      await sql.run(
        "INSERT INTO guard_token_vault (token, data_class, value_hash, value_sealed, created_at, project_id, execution_id) VALUES (?, 'email', ?, 'x', ?, 'default', NULL)",
        token, `h-${token}`, AT
      );
    }
    expect(await store.deleteGuardVaultTokens(["tok_email_AAAAAAAAAAAAAAAA", "tok_email_ZZZZZZZZZZZZZZZZ"], { requestId: "dsr-1", erasedAt: AT })).toBe(1);
    expect(await store.deleteGuardVaultTokens([], { requestId: "dsr-1", erasedAt: AT })).toBe(0);
    expect((await sql.all<{ token: string }>("SELECT token FROM guard_token_vault")).map((row) => row.token)).toEqual(["tok_email_BBBBBBBBBBBBBBBB"]);
    expect(await sql.all("SELECT kind, row_id FROM erasure_tombstones")).toEqual([{ kind: "vault_token", row_id: "tok_email_AAAAAAAAAAAAAAAA" }]);
  });

  it("keeps a run under a legal hold (no tombstone); deletes it with its side rows and a tombstone once released", async () => {
    const store = ctx.store();
    const sql = testSql(store);
    await store.upsertWorkflow({ id: "wf", name: "W", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-h', 'wf', 'success', ?)", AT);
    await sql.run(
      `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
       VALUES ('appr-h', 'run-h', 'wf', 'default', 'gate', 'approval_gate', 'approved', '{}', ?, ?)`,
      AT, AT
    );
    await sql.run("INSERT INTO usage_events (id, execution_id, workflow_id, user_id, user_email, status, total_tokens, created_at) VALUES ('ue-h', 'run-h', 'wf', 'u', 'u@example.com', 'success', 7, ?)", AT);
    const hold = await store.placeLegalHold({
      id: "h1", name: "Matter", reason: "r", matterRef: null, scopeType: "workflow", scopeId: "wf", endsAt: null, createdBy: null, createdAt: AT, items: []
    });
    const held = await store.deleteSubjectRow("execution", "run-h", { requestId: "dsr-1", erasedAt: AT });
    expect(held.deleted).toBe(false);
    expect(held.heldBy?.map((ref) => ref.id)).toEqual(["h1"]);
    expect(await store.countErasureTombstones()).toBe(0);
    await store.releaseLegalHold({ id: hold.id, releasedBy: null, reason: "done", releasedAt: AT });
    const outcome = await store.deleteSubjectRow("execution", "run-h", { requestId: "dsr-1", erasedAt: AT });
    expect(outcome).toMatchObject({ deleted: true, usageCleared: 1 });
    expect(await sql.all("SELECT id FROM approval_requests")).toEqual([]);
    expect(await sql.all("SELECT user_id, user_email FROM usage_events")).toEqual([{ user_id: null, user_email: null }]);
    expect(await sql.all("SELECT kind, row_id FROM erasure_tombstones")).toEqual([{ kind: "run", row_id: "run-h" }]);
  });

  it("pseudonymises a staff email in any case, leaving rows a hold keeps (counted)", async () => {
    const store = ctx.store();
    const sql = testSql(store);
    await store.upsertWorkflow({ id: "wf-held", name: "H", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    await store.upsertWorkflow({ id: "wf-free", name: "F", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('r-held', 'wf-held', 'success', ?, 'Ann@Example.com')", AT);
    await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('r-free', 'wf-free', 'success', ?, 'ann@example.com')", AT);
    await sql.run("INSERT INTO variables (id, project_id, key, value, created_by, created_at, updated_at) VALUES ('v1', 'default', 'K', 'v', 'ANN@EXAMPLE.COM', ?, ?)", AT, AT);
    await store.placeLegalHold({
      id: "h2", name: "Matter", reason: "r", matterRef: null, scopeType: "workflow", scopeId: "wf-held", endsAt: null, createdBy: null, createdAt: AT, items: []
    });
    const result = await store.pseudonymiseStaff({ emails: ["ann@example.com"], pseudonym: "erased-user-12345678", batch: 1 });
    expect(result).toEqual({ changed: 2, held: 1, remaining: 0 });
    expect(await sql.all("SELECT id, triggered_by FROM execution_history ORDER BY id")).toEqual([
      { id: "r-free", triggered_by: "erased-user-12345678" },
      { id: "r-held", triggered_by: "Ann@Example.com" }
    ]);
    expect(await sql.all("SELECT created_by FROM variables")).toEqual([{ created_by: "erased-user-12345678" }]);
  });

  it("keeps a run whose cassette a hold names, and one whose tool call a project hold reaches", async () => {
    const store = ctx.store();
    const sql = testSql(store);
    await store.upsertProject({ id: "proj-held", name: "Held" });
    await store.upsertWorkflow({ id: "wf", name: "W", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    for (const id of ["run-c", "run-t"]) await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES (?, 'wf', 'success', ?)", id, AT);
    await sql.run("INSERT INTO mcp_cassettes (id, execution_id, workflow_id, cassette_json, created_at) VALUES ('cas-1', 'run-c', 'wf', '{}', ?)", AT);
    await sql.run(
      `INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, project_id, node_id, adapter_id, tool_name, started_at, ok, created_at)
       VALUES ('call-1', 'run-t', 'wf', 'proj-held', 'n', 'http-mcp', 't', ?, 1, ?)`,
      AT, AT
    );
    await store.placeLegalHold({
      id: "h-cas", name: "Cassette", reason: "r", matterRef: null, scopeType: "runs", scopeId: "", endsAt: null, createdBy: null, createdAt: AT,
      items: [{ kind: "cassette", rowId: "cas-1" }]
    } as never);
    await store.placeLegalHold({
      id: "h-proj", name: "Project", reason: "r", matterRef: null, scopeType: "project", scopeId: "proj-held", endsAt: null, createdBy: null, createdAt: AT, items: []
    });
    for (const [run, hold] of [["run-c", "h-cas"], ["run-t", "h-proj"]] as const) {
      const outcome = await store.deleteSubjectRow("execution", run, { requestId: "dsr-1", erasedAt: AT });
      expect(outcome.deleted).toBe(false);
      expect(outcome.heldBy?.map((ref) => ref.id)).toContain(hold);
    }
    expect(await sql.all("SELECT id FROM mcp_cassettes")).toEqual([{ id: "cas-1" }]);
    expect(await sql.all("SELECT id FROM mcp_tool_calls")).toEqual([{ id: "call-1" }]);
    expect(await sql.all("SELECT id FROM execution_history ORDER BY id")).toEqual([{ id: "run-c" }, { id: "run-t" }]);
    expect(await store.countErasureTombstones()).toBe(0);
  });
});
