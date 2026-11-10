/**
 * 13.3 — store contract: data-subject tables and lookups on both stores (subject key, references, requests, sealed
 * exports, the request scan's pages, memory sessions and a staff member's rows). Rows are seeded with SQL that runs on
 * both dialects.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { SUBJECT_SCAN_KINDS, memoryArtifactRowId, memorySessionRowId, type SubjectRequestRecord, type SubjectScanKind } from "../subject-store.js";

const AT = "2026-11-01T00:00:00.000Z";

function request(id: string, overrides: Partial<SubjectRequestRecord> = {}): SubjectRequestRecord {
  return {
    id,
    type: "export",
    subjectKind: "end_user",
    queryHash: `hash-${id}`,
    valueSealed: "v1.sealed",
    scan: true,
    revealTokens: false,
    status: "searching",
    dueAt: "2026-12-01T00:00:00.000Z",
    dueNotifiedAt: null,
    counts: {},
    progress: { phase: "references" },
    deferred: [],
    createdBy: "admin@example.com",
    createdByUserId: "u-admin",
    createdAt: AT,
    updatedAt: AT,
    error: null,
    ...overrides
  };
}

describeStoreContract("store contract: data-subject requests", (ctx) => {
  async function seed(statements: string[]): Promise<void> {
    const sql = testSql(ctx.store());
    for (const statement of statements) await sql.run(statement);
  }

  it("keeps the first subject key stored", async () => {
    const store = ctx.store();
    expect(await store.getSubjectRefKey()).toBeNull();
    expect(await store.initSubjectRefKey("sealed-a", AT)).toBe("sealed-a");
    expect(await store.initSubjectRefKey("sealed-b", AT)).toBe("sealed-a");
    expect(await store.getSubjectRefKey()).toBe("sealed-a");
  });

  it("stores references once and lists them by hash", async () => {
    const store = ctx.store();
    const ref = { hash: "h1", kind: "run" as const, rowId: "run-1", projectId: "default", workflowId: "wf", createdAt: AT };
    await store.addSubjectRefs([ref, ref, { ...ref, rowId: "run-2", createdAt: "2026-11-02T00:00:00.000Z" }, { ...ref, hash: "h2", rowId: "run-3" }]);
    await store.addSubjectRefs([ref]);
    await store.addSubjectRefs([]);
    const listed = await store.listSubjectRefs("h1", 10);
    expect(listed.map((row) => row.rowId)).toEqual(["run-1", "run-2"]);
    expect(listed[0]).toMatchObject({ kind: "run", projectId: "default", workflowId: "wf", createdAt: AT });
    expect(await store.listSubjectRefs("h1", 1)).toHaveLength(1);
    expect(await store.listSubjectRefs("nope", 10)).toEqual([]);
  });

  it("prunes references whose run or memory session is gone", async () => {
    const store = ctx.store();
    await seed([
      `INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-live', 'wf', 'success', '${AT}')`,
      `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('ns', 'live', '[]', '${AT}', '${AT}')`,
      `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at) VALUES ('ns', 'artifact-only', 'k', '{}', '${AT}', '${AT}')`
    ]);
    const base = { hash: "h", projectId: null, workflowId: null, createdAt: AT };
    await store.addSubjectRefs([
      { ...base, kind: "run", rowId: "run-live" },
      { ...base, kind: "run", rowId: "run-gone" },
      { ...base, kind: "memory_session", rowId: memorySessionRowId("ns", "live") },
      { ...base, kind: "memory_session", rowId: memorySessionRowId("ns", "artifact-only") },
      { ...base, kind: "memory_session", rowId: memorySessionRowId("ns", "gone") }
    ]);
    expect(await store.pruneOrphanSubjectRefs(1)).toBe(1);
    expect(await store.pruneOrphanSubjectRefs(100)).toBe(1);
    expect(await store.pruneOrphanSubjectRefs(100)).toBe(0);
    expect((await store.listSubjectRefs("h", 10)).map((row) => row.rowId).sort()).toEqual(
      [memorySessionRowId("ns", "artifact-only"), memorySessionRowId("ns", "live"), "run-live"].sort()
    );
  });

  it("creates, lists, gets and updates requests, guarded by status", async () => {
    const store = ctx.store();
    await store.createSubjectRequest(request("r1"));
    await store.createSubjectRequest(request("r2", { createdAt: "2026-11-02T00:00:00.000Z", status: "ready", valueSealed: null, scan: false, revealTokens: true, subjectKind: "staff" }));
    const got = await store.getSubjectRequest("r2");
    expect(got).toMatchObject({ id: "r2", status: "ready", valueSealed: null, scan: false, revealTokens: true, subjectKind: "staff", createdAt: "2026-11-02T00:00:00.000Z" });
    expect((await store.listSubjectRequests({ limit: 10 })).map((row) => row.id)).toEqual(["r2", "r1"]);
    expect((await store.listSubjectRequests({ limit: 10, statuses: ["searching"] })).map((row) => row.id)).toEqual(["r1"]);
    expect(await store.listSubjectRequests({ limit: 10, statuses: [] })).toEqual([]);

    expect(await store.updateSubjectRequest("r1", { status: "ready", updatedAt: AT }, "failed")).toBe(false);
    expect(
      await store.updateSubjectRequest("r1", { status: "ready", counts: { run: 2 }, progress: { phase: "finished" }, valueSealed: null, error: null, updatedAt: "2026-11-03T00:00:00.000Z" }, "searching")
    ).toBe(true);
    expect(await store.getSubjectRequest("r1")).toMatchObject({ status: "ready", counts: { run: 2 }, progress: { phase: "finished" }, valueSealed: null, updatedAt: "2026-11-03T00:00:00.000Z" });
    expect(await store.updateSubjectRequest("r1", { dueNotifiedAt: AT, updatedAt: AT })).toBe(true);
    expect((await store.getSubjectRequest("r1"))?.dueNotifiedAt).toBe(AT);
    expect(await store.updateSubjectRequest("missing", { status: "failed", updatedAt: AT })).toBe(false);
    expect(await store.getSubjectRequest("missing")).toBeNull();
  });

  it("hands an export out once, and clears expired ones", async () => {
    const store = ctx.store();
    const base = { bytes: 10, sha256: "abc", createdAt: AT };
    await store.saveSubjectExport({ ...base, id: "x1", requestId: "r1", sealedBlob: "blob-1", expiresAt: "2026-11-05T00:00:00.000Z" });
    await store.saveSubjectExport({ ...base, id: "x2", requestId: "r2", sealedBlob: "blob-2", expiresAt: "2026-11-02T00:00:00.000Z" });
    expect(await store.getSubjectExport("r1")).toMatchObject({ id: "x1", requestId: "r1", bytes: 10, stored: true, downloadedAt: null });

    // Expired at the time of the download: refused.
    expect(await store.claimSubjectExport({ requestId: "r2", by: "a@example.com", at: "2026-11-03T00:00:00.000Z" })).toBeNull();
    expect(await store.claimSubjectExport({ requestId: "r1", by: "a@example.com", at: "2026-11-03T00:00:00.000Z" })).toBe("blob-1");
    expect(await store.claimSubjectExport({ requestId: "r1", by: "b@example.com", at: "2026-11-03T00:00:01.000Z" })).toBeNull();
    expect(await store.getSubjectExport("r1")).toMatchObject({ stored: false, downloadedAt: "2026-11-03T00:00:00.000Z", downloadedBy: "a@example.com" });

    expect(await store.expireSubjectExports("2026-11-03T00:00:00.000Z")).toEqual(["r2"]);
    expect(await store.expireSubjectExports("2026-11-03T00:00:00.000Z")).toEqual([]);
    expect(await store.getSubjectExport("r2")).toMatchObject({ stored: false, downloadedAt: null });
    expect(await store.getSubjectExport("none")).toBeNull();
  });

  it("pages every scan kind once, in a stable order, and reads a row by id", async () => {
    const store = ctx.store();
    await seed([
      `INSERT INTO workflows (id, name, schema_version, workflow_version, workflow_json, created_at, updated_at, project_id) VALUES ('wf', 'WF', '1.0.0', 1, '{}', '${AT}', '${AT}', 'p1')`,
      ...["a", "b", "c"].map(
        (tag) => `INSERT INTO execution_history (id, workflow_id, status, started_at, trigger_type, input_json) VALUES ('run-${tag}', 'wf', 'success', '${AT}', 'manual', '{"v":"${tag}"}')`
      ),
      // A replay run belongs to the data-subject lookup's own kind, not this one.
      `INSERT INTO execution_history (id, workflow_id, status, started_at, trigger_type, input_json) VALUES ('run-replay', 'wf', 'success', '${AT}', 'replay', '{}')`,
      ...["a", "b", "c"].map(
        (tag) =>
          `INSERT INTO workflow_executions (id, workflow_id, status, waiting_node_id, started_at, state_json, created_at, updated_at) VALUES ('paused-${tag}', 'wf', 'waiting_approval', 'n', '${AT}', '{"s":"${tag}"}', '${AT}', '${AT}')`
      ),
      ...["a", "b", "c"].map(
        (tag) =>
          `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, message, created_at, updated_at) VALUES ('appr-${tag}', 'run-${tag}', 'wf', 'p1', 'gate', 'approval_gate', 'pending', '{}', 'm-${tag}', '${AT}', '${AT}')`
      ),
      ...["a", "b", "c"].map(
        (tag) => `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('ns', 's-${tag}', '["${tag}"]', '${AT}', '${AT}')`
      ),
      ...["a", "b", "c"].map(
        (tag) =>
          `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at) VALUES ('ns', 's-a', 'k-${tag}', '"${tag}"', '${AT}', '${AT}')`
      ),
      ...["a", "b", "c"].map(
        (tag) => `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, source, cassette_json, created_at) VALUES ('cas-${tag}', 'run', 'wf', 'manual', '{"c":"${tag}"}', '${AT}')`
      ),
      `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, source, cassette_json, created_at) VALUES ('cas-replay', 'run', 'wf', 'replay', '{}', '${AT}')`
    ]);
    const expected: Record<SubjectScanKind, string[]> = {
      production_execution: ["run-a", "run-b", "run-c"],
      paused_run: ["paused-a", "paused-b", "paused-c"],
      approval: ["appr-a", "appr-b", "appr-c"],
      memory_session: ["s-a", "s-b", "s-c"].map((sid) => memorySessionRowId("ns", sid)),
      memory_artifact: ["k-a", "k-b", "k-c"].map((key) => memoryArtifactRowId("ns", "s-a", key)),
      cassette_any: ["cas-a", "cas-b", "cas-c"]
    };
    for (const kind of SUBJECT_SCAN_KINDS) {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page: { rows: Array<{ id: string }>; next: string | null } = await store.subjectScanPage(kind, cursor, 2);
        ids.push(...page.rows.map((row) => row.id));
        if (page.next === null || page.rows.length < 2) break;
        cursor = page.next;
      }
      expect(ids.sort(), kind).toEqual([...expected[kind]].sort());
      const one = await store.subjectScanRow(kind, expected[kind][1]!);
      expect(one?.id, kind).toBe(expected[kind][1]);
      expect(Object.values(one?.texts ?? {}).some((text) => typeof text === "string"), kind).toBe(true);
    }
    const run = await store.subjectScanRow("production_execution", "run-b");
    expect(run).toMatchObject({ workflowId: "wf", projectId: "p1", texts: { input: '{"v":"b"}' } });
    // By id, a run is read whatever its trigger (a reference may point at any run).
    expect((await store.subjectScanRow("production_execution", "run-replay"))?.id).toBe("run-replay");
    expect(await store.subjectScanRow("production_execution", "nope")).toBeNull();
    expect(await store.subjectScanRow("memory_session", "not json")).toBeNull();

    const memory = await store.memorySessionSubjectRows("ns", "s-a");
    expect(memory.map((row) => `${String(row.kind)}:${row.id}`)).toEqual([
      `memory_session:${memorySessionRowId("ns", "s-a")}`,
      ...["k-a", "k-b", "k-c"].map((key) => `memory_artifact:${memoryArtifactRowId("ns", "s-a", key)}`)
    ]);
    expect(await store.memorySessionSubjectRows("ns", "none")).toEqual([]);
  });

  it("reads a staff member's identity and authored rows, never a credential", async () => {
    const store = ctx.store();
    await seed([
      `INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u1', 'Ana@Example.com', 'secret-hash', 'builder', '${AT}', '${AT}')`,
      `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at) VALUES ('k1', 'u1', 'ci', 'ao_ab', 'key-hash', '${AT}')`,
      `INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('run-1', 'wf', 'success', '${AT}', 'ana@example.com')`,
      `INSERT INTO audit_logs (id, event_type, category, action, outcome, actor_user_id, actor_email, created_at) VALUES ('a1', 'auth.login', 'auth', 'login', 'success', 'u1', 'ana@example.com', '${AT}')`
    ]);
    const rows = await store.staffSubjectRows("ana@example.com");
    expect(rows.user).toMatchObject({ id: "u1", email: "Ana@Example.com", role: "builder" });
    expect(JSON.stringify(rows)).not.toContain("secret-hash");
    expect(JSON.stringify(rows)).not.toContain("key-hash");
    expect(rows.apiKeys.map((row) => row.id)).toEqual(["k1"]);
    expect(rows.runsTriggered.map((row) => row.id)).toEqual(["run-1"]);
    expect(rows.auditEntries.map((row) => row.id)).toEqual(["a1"]);
    const nobody = await store.staffSubjectRows("nobody@example.com");
    expect(nobody.user).toBeNull();
    expect(nobody.apiKeys).toEqual([]);
  });
});
