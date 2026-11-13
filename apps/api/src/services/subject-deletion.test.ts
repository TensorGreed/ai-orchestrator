/**
 * 13.3 — data-subject deletion on both stores (Postgres when TEST_POSTGRES_URL is set): preview then confirm, a run
 * with what it took (approvals, tool calls, queue jobs), usage rows kept with the person cleared (totals unchanged),
 * agent memory, the person's vault tokens (a later reveal finds nothing), rows under a legal hold deferred and deleted
 * once it is released, staff erasure (every authorship column pseudonymised, the user deleted, the audit log kept and
 * its chain intact), tombstones re-applied after a restore, and the tombstone prune.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { STAFF_AUTHORSHIP_COLUMNS, memorySessionTombstoneId, reapplyErasures, staffPseudonym, staffTombstoneId } from "../db/erasure.js";
import type { Store } from "../db/store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";
import type { AuditEventInput } from "./audit-service.js";
import { ReplayCaptureService } from "./replay-capture-service.js";
import { SecretService } from "./secret-service.js";
import { SubjectRequestError, SubjectRequestService, type SubjectRequestServiceOptions } from "./subject-request-service.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const T0 = new Date("2026-11-10T12:00:00.000Z");
const AT = "2026-11-01T00:00:00.000Z";
const ADMIN = { id: "u-admin", email: "admin@example.com" };
const STAFF_EMAIL = "Erin.Staff@Example.com";
const TOKEN = "tok_email_AAAAAAAAAAAAAAAA";
const OTHER_TOKEN = "tok_email_BBBBBBBBBBBBBBBB";

const WORKFLOW: Workflow = {
  id: "wf-del",
  name: "Support bot",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  projectId: "default",
  nodes: [{ id: "mem", type: "local_memory", name: "Memory", position: { x: 0, y: 0 }, config: {} }],
  edges: [],
  settings: { dataProtection: { subjectRefs: ["{{input.customerId}}", "{{session_id}}"] } }
} as unknown as Workflow;

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("data-subject deletion");

for (const kind of kinds) {
  describe(`data-subject deletion [${kind}]`, () => {
    const opened: TestStore[] = [];
    afterEach(async () => {
      for (const test of opened.splice(0)) await test.cleanup().catch(() => undefined);
    }, 60_000);

    async function setup(overrides: Partial<SubjectRequestServiceOptions> = {}) {
      const test = await createTestStore({ kind });
      opened.push(test);
      const store = test.store;
      const sql = testSql(store);
      const secrets = new SecretService(store, KEY);
      const capture = new ReplayCaptureService({
        store,
        recordings: {} as never,
        datasets: {} as never,
        surrogateKey: new Uint8Array(32).fill(7),
        dictionariesFor: async () => [],
        dictionaryClasses: async () => [],
        publishedVersion: async () => null,
        deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
        log: { warn: () => undefined, info: () => undefined }
      });
      const audits: AuditEventInput[] = [];
      const clock = { now: T0 };
      // The vault as the app reads it: a token's value while its row is there (the value kept beside, as sealed in prod).
      const vaultValues = new Map<string, string>([
        [TOKEN, "cust-777"],
        [OTHER_TOKEN, "someone-else"]
      ]);
      const revealToken = async (token: string): Promise<string | null> => {
        const rows = await sql.all<{ token: string }>("SELECT token FROM guard_token_vault WHERE token = ?", token);
        return rows.length > 0 ? (vaultValues.get(token) ?? null) : null;
      };
      const service = new SubjectRequestService({
        store,
        secrets,
        matcher: async (query) => await capture.subjectMatcher(query),
        revealToken,
        instanceId: "instance-a",
        isLeader: () => true,
        dueDays: 30,
        exportTtlHours: 72,
        audit: async (event) => {
          audits.push(event);
        },
        now: () => clock.now,
        ...overrides
      });
      return { store, sql, service, audits, clock, revealToken };
    }

    /** Background passes until nothing is searching or running. */
    async function settle(service: SubjectRequestService, max = 50): Promise<void> {
      for (let pass = 0; pass < max; pass += 1) {
        await service.idle();
        service.kick();
        await service.idle();
        if (!(await service.list()).some((request) => request.status === "searching" || request.status === "running")) return;
      }
    }

    async function saveRun(store: Store, id: string, input: unknown): Promise<void> {
      await store.saveExecutionHistory({
        id,
        workflowId: WORKFLOW.id,
        workflowName: WORKFLOW.name,
        status: "success",
        startedAt: AT,
        completedAt: AT,
        triggerType: "webhook",
        inputJson: input,
        outputJson: { ok: true }
      });
    }

    async function seedRun(store: Store, service: SubjectRequestService, id: string, customerId: string): Promise<void> {
      const sql = testSql(store);
      await saveRun(store, id, { customerId, session_id: `sess-${id}`, note: `reach me via ${TOKEN}` });
      await service.recordRunRefs({ executionId: id, workflow: WORKFLOW, run: { input: { customerId }, sessionId: `sess-${id}` } });
      await sql.run(
        `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, message, created_at, updated_at)
         VALUES (?, ?, ?, 'default', 'gate', 'approval_gate', 'approved', '{}', 'ok?', ?, ?)`,
        `appr-${id}`, id, WORKFLOW.id, AT, AT
      );
      await sql.run(
        `INSERT INTO usage_events (id, execution_id, workflow_id, workflow_name, user_id, user_email, project_id, trigger_type, status, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, 'Support bot', 'u-op', 'op@example.com', 'default', 'webhook', 'success', 40, 0.5, ?)`,
        `ue-${id}`, id, WORKFLOW.id, AT
      );
      await sql.run(
        `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('wf-del:mem', ?, '[{"role":"user","content":"hi"}]', ?, ?)`,
        `sess-${id}`, AT, AT
      );
    }

    async function seedVault(store: Store): Promise<void> {
      const sql = testSql(store);
      for (const token of [TOKEN, OTHER_TOKEN]) {
        await sql.run(
          `INSERT INTO guard_token_vault (token, data_class, value_hash, value_sealed, created_at, project_id, execution_id) VALUES (?, 'email', ?, 'sealed', ?, 'default', NULL)`,
          token, `hash-${token}`, AT
        );
      }
    }

    async function usageTotals(store: Store): Promise<{ tokens: number; cost: number; rows: number }> {
      const row = (await testSql(store).all<{ t: number | string; c: number | string; n: number | string }>(
        "SELECT COALESCE(SUM(total_tokens), 0) AS t, COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM usage_events"
      ))[0]!;
      return { tokens: Number(row.t), cost: Number(row.c), rows: Number(row.n) };
    }

    async function count(store: Store, table: string, where = "1 = 1", ...params: unknown[]): Promise<number> {
      const row = (await testSql(store).all<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params))[0]!;
      return Number(row.n);
    }

    it("previews, then deletes on confirm: the runs and what they took, memory and the person's tokens; usage totals unchanged", async () => {
      const { store, service, audits, revealToken } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      await seedRun(store, service, "run-other", "CUST-888");
      await seedVault(store);
      const before = await usageTotals(store);

      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      expect(created.export).toBeNull();
      await settle(service);
      const preview = (await service.get(created.id))!;
      expect(preview.status).toBe("ready");
      expect(preview.counts).toMatchObject({ run: 1 });
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(1);
      await expect(service.download(created.id, ADMIN)).rejects.toBeInstanceOf(SubjectRequestError);

      const confirmed = await service.confirm(created.id, ADMIN);
      expect(confirmed.status).toBe("running");
      await expect(service.confirm(created.id, ADMIN)).rejects.toThrow(/only a request ready/);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.status).toBe("done");
      expect(done.deletion).toMatchObject({ confirmedBy: ADMIN.email, usageRowsCleared: 1, vaultTokensDeleted: 1, deferred: 0 });
      expect(done.deletion!.deleted.run).toBe(1);
      expect(done.deletion!.notCovered).toEqual(expect.arrayContaining([expect.stringContaining("Signed run manifests")]));

      // The run and what it took are gone; the other person's are not.
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);
      expect(await count(store, "approval_requests", "execution_id = 'run-1'")).toBe(0);
      expect(await count(store, "subject_refs", "row_id = 'run-1'")).toBe(0);
      expect(await count(store, "execution_history", "id = 'run-other'")).toBe(1);
      expect(await count(store, "approval_requests", "execution_id = 'run-other'")).toBe(1);
      expect(await count(store, "session_memory", "session_id = 'sess-run-other'")).toBe(1);
      // Usage rows stay (budgets and totals do not move) with the person cleared.
      expect(await usageTotals(store)).toEqual(before);
      const usage = await testSql(store).all<{ user_id: string | null; user_email: string | null }>("SELECT user_id, user_email FROM usage_events WHERE execution_id = 'run-1'");
      expect(usage).toEqual([{ user_id: null, user_email: null }]);
      // The person's own token is gone; a later reveal finds nothing. Another person's token stays.
      expect(await revealToken(TOKEN)).toBeNull();
      expect(await revealToken(OTHER_TOKEN)).toBe("someone-else");
      // Tombstones: the run and the token.
      expect(await count(store, "erasure_tombstones", "kind = 'run' AND row_id = 'run-1' AND request_id = ?", created.id)).toBe(1);
      expect(await count(store, "erasure_tombstones", "kind = 'vault_token'")).toBe(1);
      // The value is dropped once done.
      expect((await store.getSubjectRequest(created.id))!.valueSealed).toBeNull();
      expect(audits.map((event) => event.eventType)).toEqual(expect.arrayContaining(["data_subject.deletion_ready", "data_subject.deleted"]));
      expect(JSON.stringify(audits).toLowerCase()).not.toContain("cust-777");
    });

    it("deletes the memory session found by a session reference", async () => {
      const { store, service } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "sess-run-1", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.status).toBe("done");
      expect(done.deletion!.deleted).toMatchObject({ run: 1, memory_session: 1 });
      expect(await count(store, "session_memory", "session_id = 'sess-run-1'")).toBe(0);
      expect(await count(store, "erasure_tombstones", "kind = 'memory_session'")).toBe(1);
      // The tombstone names the session by a keyed hash, never the session id.
      expect(JSON.stringify(await testSql(store).all("SELECT * FROM erasure_tombstones"))).not.toContain("sess-run-1");
    });

    it("asks the release gate before deleting a golden run, and runs its follow-up (stale jobs) only once it is deleted", async () => {
      const calls: string[] = [];
      const { store, sql, service } = await setup({
        subjectRowRemoval: async (actor, row) => {
          calls.push(`check:${row.kind}:${row.id}:${actor.email}`);
          return async () => {
            calls.push(`after:${row.kind}:${row.id}`);
          };
        }
      });
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      await sql.run(
        `INSERT INTO replay_recordings (id, workflow_id, project_id, name, source_status, workflow_hash, captured_workflow_json, input_json, node_outputs_json,
           facts_json, capabilities_json, bytes, created_at, status)
         VALUES ('rec-1', ?, 'default', 'Golden', 'success', 'h', '{}', ?, '{}', '{}', '{}', 10, ?, 'golden')`,
        WORKFLOW.id, JSON.stringify({ email: "golden.subject@example.com" }), AT
      );
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "golden.subject@example.com", scan: true, revealTokens: false }, ADMIN);
      await settle(service);
      expect((await service.get(created.id))!.counts).toMatchObject({ golden_run: 1 });
      expect(calls).toEqual([]);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      expect((await service.get(created.id))!.status).toBe("done");
      expect(calls).toEqual([`check:recording:rec-1:${ADMIN.email}`, "after:recording:rec-1"]);
      expect(await count(store, "replay_recordings", "id = 'rec-1'")).toBe(0);
      expect(await count(store, "erasure_tombstones", "kind = 'golden_run' AND row_id = 'rec-1'")).toBe(1);
    });

    it("keeps the person's vault entries while any legal hold is active, and deletes them once it is released", async () => {
      const { store, service, revealToken } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await store.upsertWorkflow({ ...WORKFLOW, id: "wf-elsewhere" } as Workflow);
      await seedRun(store, service, "run-1", "CUST-777");
      await seedVault(store);
      // A hold elsewhere: it may keep a row (not found by this request) that holds the same token.
      const hold = await store.placeLegalHold({
        id: "h-else", name: "Else", reason: "r", matterRef: null, scopeType: "workflow", scopeId: "wf-elsewhere", endsAt: null, createdBy: null, createdAt: AT, items: []
      });
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const deferred = (await service.get(created.id))!;
      expect(deferred.status).toBe("deferred_by_hold");
      expect(deferred.deletion).toMatchObject({ vaultTokensDeleted: 0, deferred: 1 });
      expect(deferred.deletion!.deleted.run).toBe(1);
      expect(await revealToken(TOKEN)).toBe("cust-777");

      await store.releaseLegalHold({ id: hold.id, releasedBy: null, reason: "done", releasedAt: T0.toISOString() });
      expect(await service.requeueDeferred()).toBe(1);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.status).toBe("done");
      expect(done.deletion).toMatchObject({ vaultTokensDeleted: 1, deferred: 0 });
      expect(await revealToken(TOKEN)).toBeNull();
      expect(await revealToken(OTHER_TOKEN)).toBe("someone-else");
    });

    it("refuses revealTokens on a deletion, and confirming an export", async () => {
      const { service } = await setup();
      const exported = await service.create({ type: "export", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await expect(service.confirm(exported.id, ADMIN)).rejects.toThrow(/Only a deletion/);
      await expect(service.confirm("missing", ADMIN)).rejects.toMatchObject({ code: "not_found" });
    });

    it("defers rows under a legal hold, and deletes them once the hold is released", async () => {
      const { store, service, audits } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      const hold = await store.placeLegalHold({
        id: "hold-1",
        name: "Matter 1",
        reason: "litigation",
        matterRef: null,
        scopeType: "workflow",
        scopeId: WORKFLOW.id,
        endsAt: null,
        createdBy: ADMIN.email,
        createdAt: AT,
        items: []
      });
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const deferred = (await service.get(created.id))!;
      expect(deferred.status).toBe("deferred_by_hold");
      expect(deferred.deletion!.deferred).toBeGreaterThanOrEqual(1);
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(1);
      expect(audits.map((event) => event.eventType)).toContain("data_subject.deletion_deferred");
      // The held run's token is not deleted while the run is kept.
      expect(await count(store, "erasure_tombstones", "kind = 'run'")).toBe(0);

      // Nothing to re-queue while the hold is active (the sweep checks the deferred rows).
      await service.sweep();
      expect((await service.get(created.id))!.status).toBe("deferred_by_hold");

      await store.releaseLegalHold({ id: hold.id, releasedBy: ADMIN.email, reason: "settled", releasedAt: T0.toISOString() });
      expect(await service.requeueDeferred()).toBe(1);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.status).toBe("done");
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);
      expect(audits.map((event) => event.eventType)).toEqual(expect.arrayContaining(["data_subject.deletion_requeued", "data_subject.deleted"]));
    });

    it("waits for a run still in flight: its executor finishes it, then the sweep deletes it and no late write brings it back", async () => {
      const { store, service, clock } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      const finalWrite = {
        id: "run-1",
        workflowId: WORKFLOW.id,
        workflowName: WORKFLOW.name,
        startedAt: AT,
        triggerType: "webhook",
        inputJson: { customerId: "CUST-777", session_id: "sess-run-1" },
        outputJson: { ok: true }
      };
      await store.saveExecutionHistory({ ...finalWrite, status: "running" });
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const waiting = (await service.get(created.id))!;
      expect(waiting.status).toBe("deferred_by_hold");
      expect(waiting.deletion).toMatchObject({ deferred: 0, waitingForRuns: 1 });
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(1);
      expect(await count(store, "erasure_tombstones", "kind = 'run'")).toBe(0);
      // Still running: the sweep leaves it.
      await service.sweep();
      await settle(service);
      expect((await service.get(created.id))!.status).toBe("deferred_by_hold");

      // The executor's final write lands on the kept row; the next sweep deletes the finished run.
      expect(await store.saveExecutionHistory({ ...finalWrite, status: "success", completedAt: AT }, { unlessCanceled: true })).toBe(true);
      await service.sweep();
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.status).toBe("done");
      expect(done.deletion).toMatchObject({ deferred: 0, waitingForRuns: 0 });
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);

      // A late write for an erased run (a progress or final write racing the delete) writes nothing; no reference either.
      expect(await store.saveExecutionHistory({ ...finalWrite, status: "running" }, { unlessFinished: true })).toBe(false);
      expect(await store.saveExecutionHistory({ ...finalWrite, status: "success", completedAt: AT }, { unlessCanceled: true })).toBe(false);
      expect(await store.saveExecutionHistory({ ...finalWrite, status: "success", completedAt: AT })).toBe(false);
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);
      expect(await service.recordRunRefs({ executionId: "run-1", workflow: WORKFLOW, run: { input: { customerId: "CUST-777" }, sessionId: "sess-run-1" } })).toBe(0);
      expect(await count(store, "subject_refs", "row_id = 'run-1'")).toBe(0);

      // Rows the executor wrote after the erasure (a history row that raced the write check, a tool call, the usage user,
      // a recording captured from it): the sweep deletes them again, and keeps none of the person.
      const sql = testSql(store);
      const late = new Date(T0.getTime() + 60_000).toISOString();
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, input_json) VALUES ('run-1', ?, 'canceled', ?, '{\"customerId\":\"CUST-777\"}')", WORKFLOW.id, AT);
      await sql.run(
        "INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok) VALUES ('tc-late', 'run-1', ?, 'n', 'mock-mcp', 'lookup', ?, 1)",
        WORKFLOW.id, AT
      );
      await sql.run(
        `INSERT INTO usage_events (id, execution_id, workflow_id, user_id, user_email, status, total_tokens, cost_usd, created_at)
         VALUES ('ue-late', 'run-1', ?, 'u-op', 'op@example.com', 'success', 7, 0.2, ?)`,
        WORKFLOW.id, AT
      );
      await sql.run(
        `INSERT INTO replay_recordings (id, workflow_id, name, source_status, workflow_hash, captured_workflow_json, node_outputs_json, facts_json, capabilities_json, bytes, created_at, status, captured_at, source_execution_id)
         VALUES ('rec-late', ?, 'Capture', 'success', 'h', '{}', '{}', '{}', '{}', 2, ?, 'candidate', ?, 'run-1')`,
        WORKFLOW.id, late, late
      );
      clock.now = new Date(T0.getTime() + 5 * 60_000);
      await service.sweep();
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);
      expect(await count(store, "mcp_tool_calls", "execution_id = 'run-1'")).toBe(0);
      expect(await count(store, "replay_recordings", "id = 'rec-late'")).toBe(0);
      expect(await count(store, "erasure_tombstones", "row_id = 'rec-late'")).toBe(1);
      expect(await sql.all("SELECT user_id, user_email, total_tokens FROM usage_events WHERE id = 'ue-late'")).toEqual([{ user_id: null, user_email: null, total_tokens: 7 }]);
    });

    it("a pass that made progress resets the error count, so one more error after two failed passes does not fail it", async () => {
      const { store, service } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      for (let n = 0; n < 12; n += 1) await seedRun(store, service, `run-${n}`, "CUST-777");
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      // Calls 1 and 2 fail (two passes with no progress); the third pass saves after ten deletes, then fails once more.
      const real = store.deleteSubjectRow.bind(store);
      let calls = 0;
      store.deleteSubjectRow = async (...args: Parameters<Store["deleteSubjectRow"]>) => {
        calls += 1;
        if (calls === 1 || calls === 2 || calls === 14) throw new Error("transient");
        return await real(...args);
      };
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(calls).toBeGreaterThan(14);
      expect(done.error).toBeNull();
      expect(done.status).toBe("done");
      expect(await count(store, "execution_history")).toBe(0);
    });

    it("a waiting run that a legal hold keeps once it has finished is reported as held, not waiting", async () => {
      const { store, service } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      await testSql(store).run("UPDATE execution_history SET status = 'running' WHERE id = 'run-1'");
      const created = await service.create({ type: "delete", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      expect((await service.get(created.id))!.deletion).toMatchObject({ deferred: 0, waitingForRuns: 1 });
      await store.placeLegalHold({
        id: "h-w", name: "M", reason: "r", matterRef: null, scopeType: "workflow", scopeId: WORKFLOW.id, endsAt: null, createdBy: null, createdAt: AT, items: []
      });
      await testSql(store).run("UPDATE execution_history SET status = 'success' WHERE id = 'run-1'");
      expect(await service.requeueDeferred()).toBe(1);
      await settle(service);
      const held = (await service.get(created.id))!;
      expect(held.status).toBe("deferred_by_hold");
      expect(held.deletion).toMatchObject({ deferred: 1, waitingForRuns: 0 });
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(1);
    });

    it("the scrub of erased runs leaves a run in flight, a held run and a held late recording", async () => {
      const { store, sql } = await setup();
      for (const id of [WORKFLOW.id, "wf-held", "wf-rec-held"]) await store.upsertWorkflow({ ...WORKFLOW, id } as Workflow);
      const erasedAt = T0.toISOString();
      const later = new Date(T0.getTime() + 60_000).toISOString();
      for (const id of ["run-a", "run-b", "run-c"]) {
        await sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('run', ?, 'dsr-s', ?)", id, erasedAt);
      }
      // run-a still running (in flight), run-b in a held workflow; run-c free, with a recording in a held workflow.
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-a', ?, 'running', ?)", WORKFLOW.id, AT);
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-b', 'wf-held', 'success', ?)", AT);
      for (const id of ["run-a", "run-b", "run-c"]) {
        await sql.run(
          "INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok) VALUES (?, ?, ?, 'n', 'mock-mcp', 'lookup', ?, 1)",
          `tc-${id}`, id, id === "run-b" ? "wf-held" : WORKFLOW.id, AT
        );
      }
      await sql.run(
        `INSERT INTO replay_recordings (id, workflow_id, name, source_status, workflow_hash, captured_workflow_json, node_outputs_json, facts_json, capabilities_json, bytes, created_at, status, captured_at, source_execution_id)
         VALUES ('rec-c', 'wf-rec-held', 'Capture', 'success', 'h', '{}', '{}', '{}', '{}', 2, ?, 'candidate', ?, 'run-c')`,
        later, later
      );
      for (const [id, scope] of [["h-run", "wf-held"], ["h-rec", "wf-rec-held"]] as const) {
        await store.placeLegalHold({ id, name: "M", reason: "r", matterRef: null, scopeType: "workflow", scopeId: scope, endsAt: null, createdBy: null, createdAt: AT, items: [] });
      }
      expect(await store.scrubErasedRuns(new Date(T0.getTime() - 3_600_000).toISOString(), 100)).toBeGreaterThan(0);
      expect((await sql.all<{ id: string }>("SELECT id FROM execution_history ORDER BY id")).map((row) => row.id)).toEqual(["run-a", "run-b"]);
      expect((await sql.all<{ id: string }>("SELECT id FROM mcp_tool_calls ORDER BY id")).map((row) => row.id)).toEqual(["tc-run-a", "tc-run-b"]);
      expect(await count(store, "replay_recordings", "id = 'rec-c'")).toBe(1);
      // Outside the window nothing is touched.
      await sql.run("INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok) VALUES ('tc-c2', 'run-c', ?, 'n', 'mock-mcp', 'lookup', ?, 1)", WORKFLOW.id, AT);
      expect(await store.scrubErasedRuns(new Date(T0.getTime() + 60_000).toISOString(), 100)).toBe(0);
      expect(await count(store, "mcp_tool_calls", "id = 'tc-c2'")).toBe(1);
    });

    it("treats a resuming run and a run with an open queue job as in flight", async () => {
      const { store, sql } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await saveRun(store, "run-r", { a: 1 });
      await saveRun(store, "run-q", { a: 1 });
      await sql.run(
        `INSERT INTO workflow_executions (id, workflow_id, status, waiting_node_id, started_at, state_json, created_at, updated_at) VALUES ('run-r', ?, 'resuming', 'gate', ?, '{}', ?, ?)`,
        WORKFLOW.id, AT, AT, AT
      );
      expect(await store.deleteSubjectRow("production_execution", "run-r")).toMatchObject({ deleted: false, busy: true });
      expect(await store.subjectRunActive("run-r")).toBe(true);
      await sql.run(
        `INSERT INTO execution_queue (id, workflow_id, execution_id, status, payload_json, created_at, updated_at, scheduled_at) VALUES ('q-1', ?, 'run-q', 'pending', '{}', ?, ?, ?)`,
        WORKFLOW.id, AT, AT, AT
      );
      expect(await store.deleteSubjectRow("production_execution", "run-q")).toMatchObject({ deleted: false, busy: true });
      await sql.run("UPDATE execution_queue SET status = 'completed' WHERE id = 'q-1'");
      expect(await store.deleteSubjectRow("production_execution", "run-q")).toMatchObject({ deleted: true });
      expect(await store.subjectRunActive("run-q")).toBe(false);
    });

    it("keeps a run whose usage row a project hold covers (the run itself not held), the usage row unchanged", async () => {
      const { store, sql } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await saveRun(store, "run-u", { a: 1 });
      await sql.run(
        `INSERT INTO usage_events (id, execution_id, workflow_id, user_id, user_email, project_id, status, total_tokens, cost_usd, created_at)
         VALUES ('ue-u', 'run-u', ?, 'u-op', 'op@example.com', 'proj-held', 'success', 5, 0.1, ?)`,
        WORKFLOW.id, AT
      );
      await store.placeLegalHold({
        id: "h-u", name: "M", reason: "r", matterRef: null, scopeType: "project", scopeId: "proj-held", endsAt: null, createdBy: null, createdAt: AT, items: []
      });
      const outcome = await store.deleteSubjectRow("production_execution", "run-u", { requestId: "dsr-u", erasedAt: AT });
      expect(outcome.deleted).toBe(false);
      expect(outcome.heldBy?.map((hold) => hold.id)).toEqual(["h-u"]);
      expect(await count(store, "execution_history", "id = 'run-u'")).toBe(1);
      expect(await sql.all("SELECT user_id, user_email FROM usage_events WHERE id = 'ue-u'")).toEqual([{ user_id: "u-op", user_email: "op@example.com" }]);
      expect(await count(store, "erasure_tombstones")).toBe(0);
    });

    it("fails a staff erasure the account delete refuses (the only admin), with no tombstone and authorship unchanged", async () => {
      const { store, sql, service } = await setup({
        staffUser: { check: async () => null, remove: async () => "last_admin" }
      });
      await store.saveUser({ id: "u-erin", email: STAFF_EMAIL, passwordHash: "x", role: "admin" });
      await store.upsertWorkflow(WORKFLOW);
      await sql.run("UPDATE workflows SET created_by = ? WHERE id = ?", STAFF_EMAIL.toLowerCase(), WORKFLOW.id);
      const created = await service.create({ type: "delete", subjectKind: "staff", value: STAFF_EMAIL, scan: false, revealTokens: false }, ADMIN);
      await settle(service);
      await service.confirm(created.id, ADMIN);
      await settle(service);
      const failed = (await service.get(created.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/only admin/);
      expect(await count(store, "erasure_tombstones")).toBe(0);
      expect((await sql.all<{ created_by: string }>("SELECT created_by FROM workflows WHERE id = ?", WORKFLOW.id))[0]!.created_by).toBe(STAFF_EMAIL.toLowerCase());
      expect(await store.getUserByEmail(STAFF_EMAIL)).not.toBeNull();
    });

    it("erases a staff member: every authorship column pseudonymised, the user deleted, the audit log kept and verifiable", async () => {
      const removed: string[] = [];
      const { store, sql, service } = await setup({
        staffUser: {
          check: async (email, actor) => (email.toLowerCase() === actor.email.toLowerCase() ? "own account" : null),
          remove: async (email) => {
            const user = await store.getUserByEmail(email);
            if (!user) return "not_found";
            removed.push(user.id);
            return await store.deleteUserKeepingAdmin(user.id);
          }
        }
      });
      await store.saveUser({ id: "u-admin", email: ADMIN.email, passwordHash: "x", role: "admin" });
      const staff = await store.saveUser({ id: "u-erin", email: STAFF_EMAIL, passwordHash: "x", role: "builder" });
      await store.upsertWorkflow(WORKFLOW);
      await sql.run("UPDATE workflows SET created_by = ? WHERE id = ?", STAFF_EMAIL.toLowerCase(), WORKFLOW.id);
      await saveRun(store, "run-s", { hello: "world" });
      await sql.run("UPDATE execution_history SET triggered_by = ? WHERE id = 'run-s'", STAFF_EMAIL.toLowerCase());
      await sql.run(
        `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, message, requested_by, decided_by, created_at, updated_at)
         VALUES ('appr-s', 'run-s', ?, 'default', 'gate', 'approval_gate', 'approved', '{}', 'ok?', ?, ?, ?, ?)`,
        WORKFLOW.id, STAFF_EMAIL.toLowerCase(), STAFF_EMAIL.toUpperCase(), AT, AT
      );
      await sql.run(
        `INSERT INTO usage_events (id, execution_id, workflow_id, user_id, user_email, status, total_tokens, cost_usd, created_at)
         VALUES ('ue-s', 'run-s', ?, ?, ?, 'success', 10, 0.1, ?)`,
        WORKFLOW.id, staff.id, STAFF_EMAIL, AT
      );
      await sql.run("INSERT INTO variables (id, project_id, key, value, created_by, created_at, updated_at) VALUES ('var-1', 'default', 'K', 'v', ?, ?, ?)", STAFF_EMAIL, AT, AT);
      await store.writeAuditLog({ id: "audit-s", eventType: "auth.login", category: "auth", action: "login", outcome: "success", actorUserId: staff.id, actorEmail: STAFF_EMAIL });
      const before = await usageTotals(store);

      const created = await service.create({ type: "delete", subjectKind: "staff", value: STAFF_EMAIL, scan: true, revealTokens: false }, ADMIN);
      await settle(service);
      const preview = (await service.get(created.id))!;
      expect(preview.status).toBe("ready");
      expect(preview.staffPreview).toMatchObject({ userFound: true, runsTriggered: 1, workflowsCreated: 1, approvals: 1, auditEntries: 1 });
      // Erasing your own account is refused.
      await expect(service.confirm(created.id, { id: staff.id, email: STAFF_EMAIL })).rejects.toThrow(/own account/);

      await service.confirm(created.id, ADMIN);
      await settle(service);
      const done = (await service.get(created.id))!;
      expect(done.error).toBeNull();
      expect(done.status).toBe("done");
      const key = await service.subjectKey();
      const pseudonym = staffPseudonym(staffTombstoneId(key, STAFF_EMAIL));
      expect(done.deletion!.staff).toMatchObject({ pseudonym, userDeleted: true });
      expect(done.deletion!.staff!.rowsPseudonymised).toBeGreaterThanOrEqual(6);
      expect(removed).toEqual([staff.id]);
      expect(await store.getUserByEmail(STAFF_EMAIL)).toBeNull();
      expect((await sql.all<{ created_by: string }>("SELECT created_by FROM workflows WHERE id = ?", WORKFLOW.id))[0]!.created_by).toBe(pseudonym);
      expect(await usageTotals(store)).toEqual(before);

      // No text column of any table but the audit log holds the email any more (any case).
      const needle = STAFF_EMAIL.toLowerCase();
      const leaks: string[] = [];
      for (const table of await tablesOf(store)) {
        if (table === "audit_logs") continue;
        const text = JSON.stringify(await sql.all(`SELECT * FROM ${table}`)).toLowerCase();
        if (text.includes(needle)) leaks.push(table);
      }
      expect(leaks).toEqual([]);
      // The audit log keeps the person's rows, and its chain still verifies.
      expect(await count(store, "audit_logs", "lower(actor_email) = ?", needle)).toBe(1);
      expect((await store.verifyAuditChain()).ok).toBe(true);

      // A restore of a backup taken before the erasure: the tombstone pseudonymises the email again.
      await sql.run("UPDATE variables SET created_by = ? WHERE id = 'var-1'", STAFF_EMAIL);
      const report = await reapplyErasures(sqlExecutor(store), key);
      expect(report.needKey).toBe(0);
      expect((await sql.all<{ created_by: string }>("SELECT created_by FROM variables WHERE id = 'var-1'"))[0]!.created_by).toBe(pseudonym);
    });

    it("re-applies run, memory and token erasures after a restore brings the rows back; refuses without the key", async () => {
      const { store, sql, service } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await seedRun(store, service, "run-1", "CUST-777");
      await seedVault(store);
      const snapshot = {
        run: await sql.all<Record<string, unknown>>("SELECT * FROM execution_history WHERE id = 'run-1'"),
        approval: await sql.all<Record<string, unknown>>("SELECT * FROM approval_requests WHERE execution_id = 'run-1'"),
        memory: await sql.all<Record<string, unknown>>("SELECT * FROM session_memory WHERE session_id = 'sess-run-1'"),
        vault: await sql.all<Record<string, unknown>>("SELECT * FROM guard_token_vault WHERE token = ?", TOKEN)
      };
      for (const value of ["cust-777", "sess-run-1"]) {
        const created = await service.create({ type: "delete", subjectKind: "end_user", value, scan: false, revealTokens: false }, ADMIN);
        await settle(service);
        await service.confirm(created.id, ADMIN);
        await settle(service);
        expect((await service.get(created.id))!.status).toBe("done");
      }
      // "Restore": the erased rows come back.
      for (const [table, rows] of [
        ["execution_history", snapshot.run],
        ["approval_requests", snapshot.approval],
        ["session_memory", snapshot.memory],
        ["guard_token_vault", snapshot.vault]
      ] as const) {
        for (const row of rows) {
          // An identity column (seq) is assigned again, as a restore does.
          const cols = Object.keys(row).filter((col) => col !== "seq");
          await sql.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((col) => row[col]));
        }
      }
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(1);
      // Without the subject key the memory tombstone cannot be matched.
      expect((await reapplyErasures(sqlExecutor(store), null)).needKey).toBeGreaterThan(0);
      const report = await reapplyErasures(sqlExecutor(store), await service.subjectKey());
      expect(report.needKey).toBe(0);
      expect(report.erasures).toBeGreaterThanOrEqual(3);
      expect(await count(store, "execution_history", "id = 'run-1'")).toBe(0);
      expect(await count(store, "approval_requests", "execution_id = 'run-1'")).toBe(0);
      expect(await count(store, "session_memory", "session_id = 'sess-run-1'")).toBe(0);
      expect(await count(store, "guard_token_vault", "token = ?", TOKEN)).toBe(0);
      // Re-applying again changes nothing.
      expect((await reapplyErasures(sqlExecutor(store), await service.subjectKey())).rowsChanged).toBe(0);
    });

    it("a restore leaves sessions and accounts created after their erasure, held authorship rows, and the only admin", async () => {
      const { store, sql, service } = await setup();
      const key = await service.subjectKey();
      const erasedAt = "2026-06-01T00:00:00.000Z";
      const tomb = async (kind: string, rowId: string) =>
        await sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES (?, ?, 'dsr-x', ?)", kind, rowId, erasedAt);
      // A session erased in June: the restored row from May goes, a new conversation from July under the same id stays.
      await tomb("memory_session", memorySessionTombstoneId(key, "ns-old", "s-1"));
      await tomb("memory_session", memorySessionTombstoneId(key, "ns-new", "s-1"));
      await sql.run("INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('ns-old', 's-1', '[]', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')");
      await sql.run("INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('ns-new', 's-1', '[]', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')");
      // Staff: one erased person re-hired in July (kept), one erased admin who is the only admin (kept), one erased
      // builder (deleted, their unheld rows renamed, their held rows left).
      for (const email of ["rehired@example.com", "only.admin@example.com", "gone@example.com"]) await tomb("staff", staffTombstoneId(key, email));
      await store.saveUser({ id: "u-rehired", email: "rehired@example.com", passwordHash: "x", role: "builder" });
      await sql.run("UPDATE users SET created_at = '2026-07-01T00:00:00.000Z' WHERE id = 'u-rehired'");
      await store.saveUser({ id: "u-only", email: "only.admin@example.com", passwordHash: "x", role: "admin" });
      // Another admin whose invite is still open cannot sign in yet, so u-only still counts as the only admin.
      await store.saveUser({ id: "u-invited", email: "invited.admin@example.com", passwordHash: "x", role: "admin" });
      await sql.run(
        "INSERT INTO user_invites (id, user_id, email, role, token_hash, created_by, created_at, expires_at) VALUES ('inv-1', 'u-invited', 'invited.admin@example.com', 'admin', 'h', 'admin@example.com', ?, '2027-01-01T00:00:00.000Z')",
        AT
      );
      await store.saveUser({ id: "u-gone", email: "gone@example.com", passwordHash: "x", role: "builder" });
      await sql.run("UPDATE users SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN ('u-only', 'u-gone')");
      await store.upsertWorkflow({ ...WORKFLOW, id: "wf-held" } as Workflow);
      await store.upsertWorkflow({ ...WORKFLOW, id: "wf-free" } as Workflow);
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('r-held', 'wf-held', 'success', ?, 'gone@example.com')", AT);
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('r-free', 'wf-free', 'success', ?, 'gone@example.com')", AT);
      await sql.run("INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('r-rehired', 'wf-free', 'success', ?, 'rehired@example.com')", AT);
      await store.placeLegalHold({
        id: "h-1", name: "M", reason: "r", matterRef: null, scopeType: "workflow", scopeId: "wf-held", endsAt: null, createdBy: null, createdAt: AT, items: []
      });

      const report = await reapplyErasures(sqlExecutor(store), key);
      expect(report.needKey).toBe(0);
      expect((await sql.all<{ namespace: string }>("SELECT namespace FROM session_memory")).map((row) => row.namespace)).toEqual(["ns-new"]);
      expect((await sql.all<{ id: string }>("SELECT id FROM users ORDER BY id")).map((row) => row.id)).toEqual(["u-invited", "u-only", "u-rehired"]);
      expect(await sql.all("SELECT id, triggered_by FROM execution_history ORDER BY id")).toEqual([
        { id: "r-free", triggered_by: staffPseudonym(staffTombstoneId(key, "gone@example.com")) },
        { id: "r-held", triggered_by: "gone@example.com" },
        { id: "r-rehired", triggered_by: "rehired@example.com" }
      ]);
      // The re-hired person, the newer session, the held row and the only admin.
      expect(report.rowsKept).toBe(4);
    });

    it("prunes tombstones older than ERASURE_TOMBSTONE_RETENTION_DAYS on the sweep (0 keeps them)", async () => {
      const { store, sql, service, clock } = await setup({ tombstoneRetentionDays: 10 });
      await sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('run', 'old', NULL, ?)", "2026-10-01T00:00:00.000Z");
      await sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('run', 'new', NULL, ?)", "2026-11-09T00:00:00.000Z");
      clock.now = T0;
      await service.sweep();
      expect((await sql.all<{ row_id: string }>("SELECT row_id FROM erasure_tombstones ORDER BY row_id")).map((row) => row.row_id)).toEqual(["new"]);

      const keeping = (await setup({ tombstoneRetentionDays: 0 }));
      await keeping.sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('run', 'old', NULL, ?)", "2020-01-01T00:00:00.000Z");
      await keeping.service.sweep();
      expect(await count(keeping.store, "erasure_tombstones")).toBe(1);
    });

    it("audits a restore that skipped erasures once, at the next start", async () => {
      const { sql, service, audits } = await setup();
      await sql.run("INSERT INTO erasure_tombstones (kind, row_id, request_id, erased_at) VALUES ('restore_skipped', 'restore-1', NULL, ?)", AT);
      expect(await service.auditSkippedRestores()).toBe(1);
      expect(await service.auditSkippedRestores()).toBe(0);
      expect(audits.filter((event) => event.eventType === "data_subject.erasures_skipped_on_restore")).toHaveLength(1);
    });

    it("lists every staff authorship column as an existing text column", async () => {
      const { store } = await setup();
      const tables = new Set(await tablesOf(store));
      const missing: string[] = [];
      for (const column of STAFF_AUTHORSHIP_COLUMNS) {
        if (!tables.has(column.table)) {
          missing.push(column.table);
          continue;
        }
        try {
          await testSql(store).all(`SELECT ${column.column} FROM ${column.table} WHERE 1 = 0`);
        } catch {
          missing.push(`${column.table}.${column.column}`);
        }
      }
      expect(missing).toEqual([]);
    });

    async function tablesOf(store: Store): Promise<string[]> {
      const sql = testSql(store);
      const rows =
        kind === "sqlite"
          ? // Virtual (full-text) tables and their shadow tables hold copies of indexed rows, read through their own table.
            await sql.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE '%_fts%'"
            )
          : await sql.all<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'");
      return rows.map((row) => row.name);
    }

    function sqlExecutor(store: Store) {
      const sql = testSql(store);
      return {
        all: async (text: string, params: unknown[]) => await sql.all<Record<string, unknown>>(text, ...params),
        run: async (text: string, params: unknown[]) => await sql.run(text, ...params)
      };
    }
  });
}
