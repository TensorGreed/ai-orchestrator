/**
 * 13.3 — data-subject requests on both stores (Postgres when TEST_POSTGRES_URL is set): subject references written
 * with runs, a request by reference and by search, possible matches left out, a lookup resumed after a restart, the
 * export zip (manifest, files, not-covered list), one download, expiry, the overdue notice, token reveal, staff
 * exports, and that the person's value is never stored, logged or audited.
 */
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readZip, type Workflow } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";
import { memorySessionRowId } from "../db/subject-store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind } from "../test-support/test-store.js";
import { testSql } from "../test-support/test-sql.js";
import type { AuditEventInput } from "./audit-service.js";
import type { NotificationEvent } from "./notification-service.js";
import { ReplayCaptureService } from "./replay-capture-service.js";
import { SecretService } from "./secret-service.js";
import {
  REQUEST_VALUE_PURPOSE,
  SUBJECT_EXPORT_MAX_ATTEMPTS,
  SUBJECT_REQUEST_LEASE,
  SUBJECT_REQUEST_MAX_ERRORS,
  SUBJECT_SCAN_PAGE,
  SubjectRequestError,
  SubjectRequestService,
  maskSubjectSample,
  memoryNamespacesOf,
  normalizeSubjectValue,
  resolveSubjectRef,
  runSessionId,
  subjectContextOf,
  type SubjectRequestServiceOptions
} from "./subject-request-service.js";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const T0 = new Date("2026-11-10T12:00:00.000Z");
const AT = "2026-11-01T00:00:00.000Z";
const EMAIL = "alice.subject@example.com";

const WORKFLOW: Workflow = {
  id: "wf-refs",
  name: "Support bot",
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  projectId: "default",
  nodes: [
    { id: "mem", type: "local_memory", name: "Memory", position: { x: 0, y: 0 }, config: {} },
    { id: "mem2", type: "local_memory", name: "Memory 2", position: { x: 0, y: 0 }, config: { namespace: "support:{{input.team}}" } },
    { id: "art", type: "session_artifact_save", name: "Save", position: { x: 0, y: 0 }, config: { namespace: "support-artifacts" } }
  ],
  edges: [],
  settings: { dataProtection: { subjectRefs: ["{{input.customerId}}", "{{session_id}}"] } }
} as unknown as Workflow;

describe("subject references: pure helpers", () => {
  it("normalises values: case, spacing, Unicode width, phone digits", () => {
    expect(normalizeSubjectValue("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeSubjectValue("ＣＵＳＴ-1")).toBe("cust-1");
    expect(normalizeSubjectValue("a   b")).toBe("a b");
    expect(normalizeSubjectValue("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizeSubjectValue("0044 20 7946 0000")).toBe("+442079460000");
    expect(normalizeSubjectValue("415.555.0123")).toBe("4155550123");
    // Too short for a phone: plain text.
    expect(normalizeSubjectValue("12-34")).toBe("12-34");
  });

  it("resolves plain paths to scalars only", () => {
    const context = subjectContextOf({ input: { customer: { id: 42 }, list: ["x"], blank: " " }, sessionId: "s-1", triggeredBy: "a@b.c" });
    expect(resolveSubjectRef(context, "{{input.customer.id}}")).toBe("42");
    expect(resolveSubjectRef(context, "{{ session_id }}")).toBe("s-1");
    expect(resolveSubjectRef(context, "{{triggeredBy}}")).toBe("a@b.c");
    expect(resolveSubjectRef(context, "{{input.customer}}")).toBeNull();
    expect(resolveSubjectRef(context, "{{input.list}}")).toBeNull();
    expect(resolveSubjectRef(context, "{{input.blank}}")).toBeNull();
    expect(resolveSubjectRef(context, "{{input.missing.deep}}")).toBeNull();
    expect(resolveSubjectRef(context, "{{input.constructor}}")).toBeNull();
    expect(resolveSubjectRef(context, "{{ 1 + 1 }}")).toBeNull();
  });

  it("finds the memory namespaces kept per session id, and the run's session id", () => {
    expect(memoryNamespacesOf(WORKFLOW)).toEqual(["support-artifacts", "wf-refs:mem"]);
    expect(runSessionId({ session_id: " s-1 " })).toBe("s-1");
    expect(runSessionId({ sessionId: "s-2" })).toBe("s-2");
    expect(runSessionId({}, { session_id: "s-3" })).toBe("s-3");
    expect(runSessionId(null)).toBeNull();
    expect(maskSubjectSample("CUST-777")).toBe("C••••••7");
    expect(maskSubjectSample("ab")).toBe("••");
  });
});

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("data-subject requests");

for (const kind of kinds) {
  describe(`data-subject requests [${kind}]`, () => {
    const opened: TestStore[] = [];
    afterEach(async () => {
      for (const test of opened.splice(0)) await test.cleanup().catch(() => undefined);
    }, 60_000);

    interface Harness {
      store: Store;
      service: SubjectRequestService;
      make: (overrides?: Partial<SubjectRequestServiceOptions>) => SubjectRequestService;
      audits: AuditEventInput[];
      logs: string[];
      notified: NotificationEvent[];
      clock: { now: Date };
    }

    async function setup(overrides: Partial<SubjectRequestServiceOptions> = {}): Promise<Harness> {
      const test = await createTestStore({ kind });
      opened.push(test);
      const store = test.store;
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
      const logs: string[] = [];
      const notified: NotificationEvent[] = [];
      const clock = { now: T0 };
      const make = (more: Partial<SubjectRequestServiceOptions> = {}) =>
        new SubjectRequestService({
          store,
          secrets,
          matcher: async (query) => await capture.subjectMatcher(query),
          instanceId: "instance-a",
          isLeader: () => true,
          dueDays: 30,
          exportTtlHours: 72,
          audit: async (event) => {
            audits.push(event);
          },
          notify: async (event) => {
            notified.push(event);
          },
          logger: {
            info: (fields, message) => logs.push(`${message} ${JSON.stringify(fields)}`),
            warn: (fields, message) => logs.push(`${message} ${JSON.stringify(fields)}`)
          },
          now: () => clock.now,
          ...overrides,
          ...more
        });
      return { store, service: make(), make, audits, logs, notified, clock };
    }

    async function seed(store: Store, statements: string[]): Promise<void> {
      const sql = testSql(store);
      for (const statement of statements) await sql.run(statement);
    }

    async function saveRun(store: Store, id: string, input: unknown, extra: { triggerType?: string; workflowId?: string } = {}): Promise<void> {
      await store.saveExecutionHistory({
        id,
        workflowId: extra.workflowId ?? WORKFLOW.id,
        workflowName: "Support bot",
        status: "success",
        startedAt: AT,
        completedAt: AT,
        triggerType: extra.triggerType ?? "webhook",
        inputJson: input,
        outputJson: { ok: true }
      });
    }

    /** Runs background passes (as the timer does) until no request is `searching` (or `max` passes). */
    async function finish(service: SubjectRequestService, max = 50): Promise<void> {
      for (let pass = 0; pass < max; pass += 1) {
        await service.idle();
        service.kick();
        await service.idle();
        const open = await service.list();
        if (!open.some((request) => request.status === "searching")) return;
      }
    }

    function unzip(bytes: Buffer): Record<string, string> {
      const entries = readZip(new Uint8Array(bytes), { inflateRaw: (data) => new Uint8Array(inflateRawSync(data)) });
      return Object.fromEntries(entries.map((entry) => [entry.path, new TextDecoder().decode(entry.data)]));
    }

    function jsonl(text: string | undefined): Array<Record<string, unknown>> {
      return (text ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    }

    /** Every text column of the data-subject tables, for "the value is never stored". */
    async function subjectTablesText(store: Store): Promise<string> {
      const sql = testSql(store);
      const parts: unknown[] = [];
      for (const table of ["subject_refs", "subject_requests", "subject_exports", "subject_ref_keys"]) parts.push(await sql.all(`SELECT * FROM ${table}`));
      return JSON.stringify(parts);
    }

    it("stores keyed hashes of a run's references, with its memory sessions, and skips missing values", async () => {
      const { store, service } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await saveRun(store, "run-1", { customerId: "CUST-777", session_id: "sess-9" });
      expect(await service.recordRunRefs({ executionId: "run-1", workflow: WORKFLOW, run: { input: { customerId: "CUST-777" }, sessionId: "sess-9" } })).toBe(4);
      // No customer id: only the session reference (and its memory sessions).
      expect(await service.recordRunRefs({ executionId: "run-2", workflow: WORKFLOW, run: { input: {}, sessionId: null } })).toBe(0);
      // A workflow without references stores nothing.
      expect(await service.recordRunRefs({ executionId: "run-3", workflow: { ...WORKFLOW, settings: {} }, run: { input: { customerId: "x" } } })).toBe(0);

      const hash = await service.hashValue("cust-777");
      expect(await service.hashValue("  CUST-777 ")).toBe(hash);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await store.listSubjectRefs(hash, 10)).map((ref) => `${ref.kind}:${ref.rowId}`)).toEqual(["run:run-1"]);
      const sessionRefs = await store.listSubjectRefs(await service.hashValue("sess-9"), 10);
      expect(sessionRefs.map((ref) => `${ref.kind}:${ref.rowId}`).sort()).toEqual(
        ["run:run-1", `memory_session:${memorySessionRowId("support-artifacts", "sess-9")}`, `memory_session:${memorySessionRowId("wf-refs:mem", "sess-9")}`].sort()
      );
      const text = await subjectTablesText(store);
      expect(text).not.toContain("CUST-777");
      expect(text.toLowerCase()).not.toContain("cust-777");
    });

    it("never fails a run: a store error is logged without the value", async () => {
      const { store, make, logs } = await setup();
      const broken = make({
        store: new Proxy(store, {
          get: (target, property) => (property === "addSubjectRefs" ? async () => Promise.reject(new Error("disk full")) : Reflect.get(target, property, target))
        })
      });
      // The key is made through the real store first.
      await broken.hashValue("warm-up").catch(() => undefined);
      expect(await broken.recordRunRefs({ executionId: "run-1", workflow: WORKFLOW, run: { input: { customerId: "CUST-777" } } })).toBe(0);
      expect(logs.join("\n")).toContain("disk full");
      expect(logs.join("\n")).not.toContain("CUST-777");
    });

    it("exports by reference only: the subject's runs and memory, nothing of another person", async () => {
      const { store, service, audits, logs } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await saveRun(store, "run-1", { customerId: "CUST-777", session_id: "sess-9", note: "first" });
      await saveRun(store, "run-2", { customerId: "CUST-888", session_id: "sess-other" });
      await seed(store, [
        `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('wf-refs:mem', 'sess-9', '[{"role":"user","content":"hi"}]', '${AT}', '${AT}')`,
        `INSERT INTO session_artifacts (namespace, session_id, artifact_key, value_json, created_at, updated_at) VALUES ('wf-refs:mem', 'sess-9', 'latest', '{"a":1}', '${AT}', '${AT}')`
      ]);
      await service.recordRunRefs({ executionId: "run-1", workflow: WORKFLOW, run: { input: { customerId: "CUST-777" }, sessionId: "sess-9" } });
      await service.recordRunRefs({ executionId: "run-2", workflow: WORKFLOW, run: { input: { customerId: "CUST-888" }, sessionId: "sess-other" } });

      const created = await service.create({ type: "export", subjectKind: "end_user", value: "cust-777", scan: false, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      expect(created).toMatchObject({ status: "searching", scan: false, dueAt: "2026-12-10T12:00:00.000Z", overdue: false, export: null });
      await finish(service);
      const ready = (await service.get(created.id))!;
      expect(ready).toMatchObject({ status: "ready", counts: { run: 1 }, foundByReference: 1 });
      expect(ready.export).toMatchObject({ available: true, downloadedAt: null, expiresAt: "2026-11-13T12:00:00.000Z" });

      const sessionRequest = await service.create({ type: "export", subjectKind: "end_user", value: "sess-9", scan: false, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await finish(service);
      expect((await service.get(sessionRequest.id))!.counts).toEqual({ run: 1, memory_session: 1, memory_artifact: 1 });

      const { bytes } = await service.download(created.id, { email: "admin@example.com" });
      const files = unzip(bytes);
      expect(Object.keys(files).sort()).toEqual(["manifest.json", "run.jsonl"]);
      const manifest = JSON.parse(files["manifest.json"]!) as Record<string, unknown>;
      expect(manifest).toMatchObject({ format: "l2m-subject-export", requestId: created.id, counts: { run: 1 }, truncated: false, foundByReference: 1 });
      expect((manifest.notCovered as string[])[0]).toContain("search of stored data was turned off");
      expect((manifest.searched as { storedData: boolean }).storedData).toBe(false);
      const runs = jsonl(files["run.jsonl"]);
      expect(runs.map((row) => row.id)).toEqual(["run-1"]);
      expect(runs[0]).toMatchObject({ kind: "run", foundBy: "reference", fields: { input: { customerId: "CUST-777", note: "first" } } });

      expect(audits.map((event) => event.eventType)).toContain("data_subject.export_ready");
      const trail = JSON.stringify(audits) + logs.join("\n");
      expect(trail.toLowerCase()).not.toContain("cust-777");
      expect((await store.getSubjectRequest(created.id))!.valueSealed).toBeNull();
      expect((await subjectTablesText(store)).toLowerCase()).not.toContain("cust-777");
    });

    it("searches stored data: production runs, approvals and paused runs; possible matches are left out", async () => {
      const { store, service } = await setup();
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      await saveRun(store, "run-email", { message: `please write to ${EMAIL}` });
      await saveRun(store, "run-other", { message: "please write to bob@example.com" });
      await saveRun(store, "run-phone-full", { phone: "+1 415 555 0123" });
      await saveRun(store, "run-phone-national", { phone: "415 555 0123" });
      await seed(store, [
        `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, message, created_at, updated_at) VALUES ('appr-1', 'run-email', 'wf-refs', 'default', 'gate', 'approval_gate', 'pending', '{}', 'Refund for ${EMAIL}?', '${AT}', '${AT}')`,
        `INSERT INTO workflow_executions (id, workflow_id, status, waiting_node_id, started_at, state_json, created_at, updated_at) VALUES ('paused-1', 'wf-refs', 'waiting_approval', 'gate', '${AT}', '{"input":{"email":"${EMAIL}"}}', '${AT}', '${AT}')`
      ]);

      const byEmail = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL.toUpperCase(), scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await finish(service);
      const done = (await service.get(byEmail.id))!;
      expect(done.status).toBe("ready");
      expect(done.counts).toEqual({ run: 1, approval: 1, paused_run: 1 });
      expect(done.progress).toMatchObject({ phase: "finished", kindsDone: 11, kindsTotal: 11 });

      const byPhone = await service.create({ type: "export", subjectKind: "end_user", value: "+1 415 555 0123", scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await finish(service);
      const phone = (await service.get(byPhone.id))!;
      expect(phone.counts).toEqual({ run: 1 });
      const files = unzip((await service.download(byPhone.id, { email: "admin@example.com" })).bytes);
      expect(jsonl(files["run.jsonl"]).map((row) => row.id)).toEqual(["run-phone-full"]);
      expect(JSON.parse(files["manifest.json"]!)).toMatchObject({ possibleMatchesLeftOut: 1 });
    });

    it("refuses a value too short to search, and a staff request without an email", async () => {
      const { service } = await setup();
      await expect(service.create({ type: "export", subjectKind: "end_user", value: "ab", scan: true, revealTokens: false }, { id: "u1", email: "a@b.c" })).rejects.toBeInstanceOf(
        SubjectRequestError
      );
      await expect(service.create({ type: "export", subjectKind: "staff", value: "not-an-email", scan: true, revealTokens: false }, { id: "u1", email: "a@b.c" })).rejects.toThrow(
        /email/
      );
      expect(await service.list()).toEqual([]);
    });

    it("resumes a search after a restart from where it stopped, finding every row once", async () => {
      const { store, make } = await setup();
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      const total = SUBJECT_SCAN_PAGE * 2 + 7;
      await seed(
        store,
        Array.from(
          { length: total },
          (_, i) =>
            `INSERT INTO execution_history (id, workflow_id, status, started_at, trigger_type, input_json) VALUES ('bulk-${String(i).padStart(4, "0")}', 'wf-refs', 'success', '${AT}', 'webhook', '{"to":"${EMAIL}"}')`
        )
      );
      // The first instance loses leadership right after its first page of production runs.
      let leader = true;
      const first = make({
        isLeader: () => leader,
        store: new Proxy(store, {
          get: (target, property) =>
            property === "subjectScanPage"
              ? async (...args: Parameters<Store["subjectScanPage"]>) => {
                  const page = await target.subjectScanPage(...args);
                  if (args[0] === "production_execution") leader = false;
                  return page;
                }
              : Reflect.get(target, property, target)
        })
      });
      const created = await first.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await first.idle();
      const stopped = (await store.getSubjectRequest(created.id))!;
      expect(stopped.status).toBe("searching");
      expect(stopped.valueSealed).not.toBeNull();
      const progress = stopped.progress as { kindIndex: number; cursor: string | null; found: unknown[] };
      expect(progress.kindIndex).toBe(5);
      expect(progress.cursor).not.toBeNull();
      expect(progress.found).toHaveLength(SUBJECT_SCAN_PAGE);

      const second = make();
      await finish(second);
      const done = (await second.get(created.id))!;
      expect(done.status).toBe("ready");
      expect(done.counts).toEqual({ run: total });
      expect(done.progress.rowsSearched).toBe(total);
      const ids = jsonl(unzip((await second.download(created.id, { email: "admin@example.com" })).bytes)["run.jsonl"]).map((row) => row.id);
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    });

    it("hands the export out once, then refuses; an export never downloaded expires", async () => {
      const { store, service, clock } = await setup();
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      await saveRun(store, "run-email", { to: EMAIL });
      const one = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      const two = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await finish(service);

      const first = await service.download(one.id, { email: "admin@example.com" });
      expect(first.request).toMatchObject({ status: "done", export: { available: false, downloadedBy: "admin@example.com" } });
      await expect(service.download(one.id, { email: "admin@example.com" })).rejects.toThrow(/already downloaded/);
      await expect(service.download("missing", { email: "admin@example.com" })).rejects.toMatchObject({ code: "not_found" });

      clock.now = new Date(T0.getTime() + 73 * 3_600_000);
      expect((await service.get(two.id))!.export?.available).toBe(false);
      await service.sweep();
      expect((await service.get(two.id))!.status).toBe("expired");
      await expect(service.download(two.id, { email: "admin@example.com" })).rejects.toThrow(/expired/);
      expect((await store.getSubjectExport(two.id))!.stored).toBe(false);
    });

    it("notifies once when a request is overdue", async () => {
      // A follower takes the request, so it stays open (searching) for the sweep.
      const { service, notified, audits, clock } = await setup({ isLeader: () => false });
      const created = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await service.sweep();
      expect(notified).toEqual([]);
      clock.now = new Date(T0.getTime() + 31 * 86_400_000);
      expect((await service.get(created.id))!.overdue).toBe(true);
      await service.sweep();
      await service.sweep();
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({ type: "data.subject_request_due", subjectRequest: { requestId: created.id, status: "searching" } });
      expect(JSON.stringify(notified)).not.toContain(EMAIL);
      expect(audits.filter((event) => event.eventType === "data_subject.request_overdue")).toHaveLength(1);
    });

    it("reveals the subject's own reversible tokens only when asked, never another person's", async () => {
      const token = "tok_email_ABCDEFGHIJKLMNOP";
      const othersToken = "tok_email_OTHERPERSON00000";
      const { store, make } = await setup();
      const service = make({
        revealToken: async (candidate) => (candidate === token ? EMAIL.toUpperCase() : candidate === othersToken ? "bob.other@example.com" : null)
      });
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      await saveRun(store, "run-email", { to: EMAIL, cc: token, other: "tok_email_ZZZZZZZZZZZZZZZZ", bcc: othersToken });
      const plain = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      const revealed = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: true }, { id: "u1", email: "admin@example.com" });
      await finish(service);
      const plainFiles = unzip((await service.download(plain.id, { email: "a" })).bytes);
      expect(plainFiles["run.jsonl"]).toContain(token);
      expect(JSON.parse(plainFiles["manifest.json"]!).tokensRevealed).toBe(false);
      const revealedFiles = unzip((await service.download(revealed.id, { email: "a" })).bytes);
      expect(revealedFiles["run.jsonl"]).not.toContain(token);
      expect(revealedFiles["run.jsonl"]).not.toContain("bob.other@example.com");
      expect(jsonl(revealedFiles["run.jsonl"])[0]).toMatchObject({
        fields: { input: { cc: EMAIL.toUpperCase(), other: "tok_email_ZZZZZZZZZZZZZZZZ", bcc: othersToken } }
      });
      expect(JSON.parse(revealedFiles["manifest.json"]!)).toMatchObject({ tokensRevealed: 1, tokensKeptForOthers: 2 });
    });

    it("exports a staff member's identity and authored rows, never a credential", async () => {
      const { store, service } = await setup();
      await seed(store, [
        `INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u-staff', '${EMAIL}', 'pw-hash-secret', 'builder', '${AT}', '${AT}')`,
        `INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES ('run-by-staff', 'wf', 'success', '${AT}', '${EMAIL}')`
      ]);
      // Typed with capitals: the authored rows are still found.
      const created = await service.create({ type: "export", subjectKind: "staff", value: EMAIL.toUpperCase(), scan: false, revealTokens: false }, { id: "u1", email: "admin@example.com" });
      await finish(service);
      const files = unzip((await service.download(created.id, { email: "admin@example.com" })).bytes);
      const staff = JSON.parse(files["staff.json"]!) as { user: { id: string }; runsTriggered: Array<{ id: string }> };
      expect(staff.user.id).toBe("u-staff");
      expect(staff.runsTriggered.map((row) => row.id)).toEqual(["run-by-staff"]);
      expect(files["staff.json"]).not.toContain("pw-hash-secret");
    });

    it("works only on the leader", async () => {
      const { make } = await setup();
      const follower = make({ isLeader: () => false });
      const created = await follower.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      await follower.idle();
      await follower.work();
      expect((await follower.get(created.id))!.status).toBe("searching");
      await finish(make());
      expect((await follower.get(created.id))!.status).toBe("ready");
    });

    it("fails a request whose value cannot be opened, and drops the sealed value", async () => {
      const { store, service: follower, make, audits } = await setup({ isLeader: () => false });
      const service = make({ isLeader: () => true });
      const created = await follower.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      const foreign = new SecretService(store, OTHER_KEY).sealValue(REQUEST_VALUE_PURPOSE, EMAIL);
      await store.updateSubjectRequest(created.id, { valueSealed: foreign, updatedAt: AT });
      await finish(service);
      const failed = (await store.getSubjectRequest(created.id))!;
      expect(failed.status).toBe("failed");
      expect(failed.valueSealed).toBeNull();
      expect(failed.error).toBeTruthy();
      expect(audits.map((event) => event.eventType)).toContain("data_subject.request_failed");
    });

    it("a worker that lost the lease never stores a second export or re-opens a downloaded one", async () => {
      const { store, make } = await setup();
      await store.upsertWorkflow(WORKFLOW);
      await saveRun(store, "run-1", { customerId: "CUST-777" });
      let bLeads = false;
      const b = make({ instanceId: "instance-b", isLeader: () => bLeads });
      await b.recordRunRefs({ executionId: "run-1", workflow: WORKFLOW, run: { input: { customerId: "CUST-777" } } });
      let downloaded = false;
      // Instance A stalls while it reads its export; meanwhile its lease lapses, B finishes the request and the admin
      // downloads it. Then A carries on.
      const a = make({
        store: new Proxy(store, {
          get: (target, property) =>
            property === "subjectScanRow"
              ? async (...args: Parameters<Store["subjectScanRow"]>) => {
                  if (!downloaded) {
                    downloaded = true;
                    await target.releaseLease(SUBJECT_REQUEST_LEASE, "instance-a");
                    bLeads = true;
                    await b.work();
                    await b.download(created.id, { email: "admin@example.com" });
                  }
                  return await target.subjectScanRow(...args);
                }
              : Reflect.get(target, property, target)
        })
      });
      const created = await b.create({ type: "export", subjectKind: "end_user", value: "CUST-777", scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      await b.idle();
      await a.work();
      expect(downloaded).toBe(true);
      expect((await store.getSubjectRequest(created.id))!.status).toBe("done");
      expect(await store.getSubjectExport(created.id)).toMatchObject({ stored: false, downloadedBy: "admin@example.com" });
      await expect(a.download(created.id, { email: "admin@example.com" })).rejects.toThrow(/already downloaded/);
    });

    it("cuts an export at its byte budget and says so", async () => {
      const { store, make } = await setup();
      const service = make({ exportMaxBytes: 600 });
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      for (let i = 0; i < 5; i += 1) await saveRun(store, `run-${i}`, { to: EMAIL, padding: "x".repeat(200) });
      const created = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "a@b.c" });
      await finish(service);
      const view = (await service.get(created.id))!;
      expect(view).toMatchObject({ status: "ready", truncated: true });
      const files = unzip((await service.download(created.id, { email: "a" })).bytes);
      const manifest = JSON.parse(files["manifest.json"]!) as Record<string, unknown>;
      expect(manifest).toMatchObject({ truncated: true, truncatedBy: "bytes", maxBytes: 600 });
      const rows = jsonl(files["run.jsonl"]);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(5);
      expect(manifest.counts).toEqual({ run: rows.length });
    });

    it("fails a request whose export was started too often (a crash cannot loop)", async () => {
      const { store, service, make, audits } = await setup({ isLeader: () => false });
      const created = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      // As if the export had crashed the process each time it started.
      await store.updateSubjectRequest(created.id, { progress: { phase: "export", exportAttempts: SUBJECT_EXPORT_MAX_ATTEMPTS }, updatedAt: AT }, "searching");
      await make({ isLeader: () => true }).work();
      const failed = (await store.getSubjectRequest(created.id))!;
      expect(failed).toMatchObject({ status: "failed", valueSealed: null });
      expect(failed.error).toContain(`${SUBJECT_EXPORT_MAX_ATTEMPTS} attempts`);
      expect(audits.map((event) => event.eventType)).toContain("data_subject.request_failed");
    });

    it("keeps a request searching through passing errors, and fails it after several in a row", async () => {
      const { store, make } = await setup({ isLeader: () => false });
      await store.upsertWorkflow({ ...WORKFLOW, settings: {} });
      await saveRun(store, "run-email", { to: EMAIL });
      let failures = 1;
      const flaky = new Proxy(store, {
        get: (target, property) =>
          property === "subjectScanPage"
            ? async (...args: Parameters<Store["subjectScanPage"]>) => {
                if (failures > 0) {
                  failures -= 1;
                  throw new Error("connection reset");
                }
                return await target.subjectScanPage(...args);
              }
            : Reflect.get(target, property, target)
      });
      const follower = make();
      const one = await follower.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "a@b.c" });
      const worker = make({ store: flaky, isLeader: () => true });
      await worker.work();
      const retried = (await store.getSubjectRequest(one.id))!;
      expect(retried.status).toBe("searching");
      expect(retried.valueSealed).not.toBeNull();
      expect((retried.progress as { errors: number }).errors).toBe(1);
      await finish(worker);
      expect((await store.getSubjectRequest(one.id))!.status).toBe("ready");

      failures = SUBJECT_REQUEST_MAX_ERRORS;
      const two = await follower.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: true, revealTokens: false }, { id: "u1", email: "a@b.c" });
      for (let pass = 0; pass < SUBJECT_REQUEST_MAX_ERRORS; pass += 1) await worker.work();
      const failed = (await store.getSubjectRequest(two.id))!;
      expect(failed).toMatchObject({ status: "failed", valueSealed: null, error: "connection reset" });
    });

    it("expires a ready request whose export is gone (a restore), and notifies the oldest overdue requests first", async () => {
      const { store, service, notified, clock } = await setup({ isLeader: () => false });
      const ready = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      await store.updateSubjectRequest(ready.id, { status: "ready", valueSealed: null, updatedAt: AT }, "searching");
      // More open requests than one overdue check reads, the oldest made first.
      const oldest = await service.create({ type: "export", subjectKind: "end_user", value: EMAIL, scan: false, revealTokens: false }, { id: "u1", email: "a@b.c" });
      clock.now = new Date(T0.getTime() + 60_000);
      for (let i = 0; i < 500; i += 1) {
        await store.createSubjectRequest({
          ...(await store.getSubjectRequest(oldest.id))!,
          id: `dsr_bulk_${i}`,
          createdAt: new Date(T0.getTime() + 120_000 + i).toISOString(),
          dueAt: new Date(T0.getTime() + 2 * 86_400_000 * 30).toISOString()
        });
      }
      clock.now = new Date(T0.getTime() + 31 * 86_400_000);
      await service.sweep();
      expect((await store.getSubjectRequest(ready.id))!.status).toBe("expired");
      expect(notified.map((event) => event.subjectRequest?.requestId)).toEqual([oldest.id]);
    });
  });
}
