/**
 * 13.3 — data-subject requests inside the app: a workflow's subject reference is stored as a keyed hash when a run
 * finishes, the preview shows how references resolve, an admin's request finds the run and its export downloads once,
 * builders cannot make requests, step-up guards the download when it is on, and the person's value appears in no
 * response error, audit row or data-subject table. Runs against the store TEST_STORE names (SQLite by default).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readZip, type SubjectRequestView, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const CUSTOMER = "CUST-4242-XYZ";

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-subject-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: "admin" | "builder" | "viewer"): Promise<string> {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function workflow(id: string, subjectRefs?: string[]): Workflow {
  return {
    id,
    name: `Subject ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }],
    ...(subjectRefs ? { settings: { dataProtection: { subjectRefs } } } : {})
  } as Workflow;
}

async function waitFor(context: TestContext, cookie: string, id: string, status: SubjectRequestView["status"]): Promise<SubjectRequestView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = (await call(context, "GET", `/api/data-protection/requests/${id}`, cookie)).json<SubjectRequestView>();
    if (view.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Request ${id} never reached ${status}`);
}

async function dataSubjectText(context: TestContext): Promise<string> {
  const sql = testSql(context.store);
  const parts: unknown[] = [];
  for (const table of ["subject_refs", "subject_requests", "subject_exports"]) parts.push(await sql.all(`SELECT * FROM ${table}`));
  parts.push(await sql.all(`SELECT event_type, metadata_json, message FROM audit_logs WHERE event_type LIKE 'data_subject.%'`));
  return JSON.stringify(parts).toLowerCase();
}

describe("data-subject requests in the app", () => {
  it("stores a run's reference, finds the run by it, and hands the export out once", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow(workflow("wf-ref", ["{{input.input.customerId}}"]));
    await context.store.upsertWorkflow(workflow("wf-plain"));

    const run = await call(context, "POST", "/api/workflows/wf-ref/execute", builder, { input: { customerId: CUSTOMER } });
    expect(run.statusCode, run.body).toBe(200);
    const executionId = run.json<{ executionId: string }>().executionId;
    const plain = await call(context, "POST", "/api/workflows/wf-plain/execute", builder, { input: { customerId: CUSTOMER } });
    expect(plain.statusCode).toBe(200);
    const refs = await testSql(context.store).all<{ kind: string; row_id: string; hash: string }>("SELECT kind, row_id, hash FROM subject_refs");
    // Only the workflow that declares a reference stores one.
    expect(refs.map((ref) => `${ref.kind}:${ref.row_id}`)).toEqual([`run:${executionId}`]);
    expect(refs[0]!.hash).toMatch(/^[0-9a-f]{64}$/);

    const preview = await call(context, "POST", "/api/data-protection/subject-refs/preview", builder, {
      workflowId: "wf-ref",
      subjectRefs: ["{{input.input.customerId}}", "{{input.missing}}"]
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({
      runs: 1,
      refs: [
        { expression: "{{input.input.customerId}}", resolved: 1, sample: "C••••••••Z" },
        { expression: "{{input.missing}}", resolved: 0, sample: null }
      ]
    });

    // Builders cannot make requests; invalid bodies never echo the value.
    expect((await call(context, "POST", "/api/data-protection/requests", builder, { type: "export", value: CUSTOMER })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/data-protection/requests", builder)).statusCode).toBe(403);
    const invalid = await call(context, "POST", "/api/data-protection/requests", admin, { type: "export", value: CUSTOMER, extra: CUSTOMER });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(CUSTOMER);
    const short = await call(context, "POST", "/api/data-protection/requests", admin, { type: "export", value: "ab" });
    expect(short.statusCode).toBe(400);

    const created = await call(context, "POST", "/api/data-protection/requests", admin, { type: "export", value: CUSTOMER.toLowerCase(), scan: false });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(CUSTOMER);
    const id = created.json<SubjectRequestView>().id;
    const ready = await waitFor(context, admin, id, "ready");
    expect(ready).toMatchObject({ counts: { run: 1 }, foundByReference: 1, export: { available: true } });
    const listed = (await call(context, "GET", "/api/data-protection/requests", admin)).json<{ requests: SubjectRequestView[] }>();
    expect(listed.requests.map((request) => request.id)).toEqual([id]);

    const download = await call(context, "GET", `/api/data-protection/requests/${id}/export`, admin);
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers["content-type"]).toBe("application/zip");
    expect(download.headers["content-disposition"]).toContain(`subject-export-${id}.zip`);
    const entries = readZip(new Uint8Array(download.rawPayload), { inflateRaw: (data) => new Uint8Array(inflateRawSync(data)) });
    expect(entries.map((entry) => entry.path)).toEqual(["manifest.json", "run.jsonl"]);
    expect(new TextDecoder().decode(entries[1]!.data)).toContain(executionId);

    const again = await call(context, "GET", `/api/data-protection/requests/${id}/export`, admin);
    expect(again.statusCode).toBe(409);
    expect((await call(context, "GET", `/api/data-protection/requests/${id}`, admin)).json<SubjectRequestView>().status).toBe("done");
    expect((await call(context, "GET", "/api/data-protection/requests/missing", admin)).statusCode).toBe(404);

    const audit = await testSql(context.store).all<{ event_type: string; outcome: string; category: string }>(
      "SELECT event_type, outcome, category FROM audit_logs WHERE event_type LIKE 'data_subject.%' ORDER BY created_at"
    );
    expect(new Set(audit.map((row) => row.category))).toEqual(new Set(["data_protection"]));
    expect(audit.map((row) => `${row.event_type}:${row.outcome}`)).toEqual([
      "data_subject.request_created:success",
      "data_subject.export_ready:success",
      "data_subject.export_downloaded:success",
      "data_subject.export_downloaded:failure"
    ]);
    expect(await dataSubjectText(context)).not.toContain(CUSTOMER.toLowerCase());
  });

  it("asks for a recent MFA check before a download, and before an export that reveals tokens, when step-up is on", async () => {
    const context = await createTestContext({ STEP_UP_MAX_AGE_MINUTES: "15" });
    const admin = await login(context, "admin");
    const reveal = await call(context, "POST", "/api/data-protection/requests", admin, { type: "export", value: CUSTOMER, scan: false, revealTokens: true });
    expect(reveal.statusCode).toBe(403);
    expect(reveal.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "subject_request.reveal" } });
    const created = await call(context, "POST", "/api/data-protection/requests", admin, { type: "export", value: CUSTOMER, scan: false });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<SubjectRequestView>().id;
    await waitFor(context, admin, id, "ready");
    const download = await call(context, "GET", `/api/data-protection/requests/${id}/export`, admin);
    expect(download.statusCode).toBe(403);
    expect(download.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "subject_export.download" } });
    // Refused before the claim: the export is still there.
    expect((await call(context, "GET", `/api/data-protection/requests/${id}`, admin)).json<SubjectRequestView>().export?.available).toBe(true);
  });

  it("deletes after a confirmed preview; a hold defers the run until its release re-queues the deletion; usage totals unchanged", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow(workflow("wf-del", ["{{input.input.customerId}}"]));
    const run = await call(context, "POST", "/api/workflows/wf-del/execute", builder, { input: { customerId: CUSTOMER } });
    expect(run.statusCode, run.body).toBe(200);
    const executionId = run.json<{ executionId: string }>().executionId;
    const usage = async () => (await testSql(context.store).all<{ n: number | string }>("SELECT COUNT(*) AS n FROM usage_events"))[0]!.n;
    const usageBefore = Number(await usage());

    // A hold on the workflow keeps its runs.
    const hold = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin },
      payload: { name: "Matter", reason: "Litigation", scopeType: "workflow", scopeId: "wf-del" }
    });
    expect(hold.statusCode, hold.body).toBe(201);
    const holdId = hold.json<{ hold?: { id: string }; id?: string }>().hold?.id ?? hold.json<{ id: string }>().id;

    // revealTokens is for exports only.
    expect((await call(context, "POST", "/api/data-protection/requests", admin, { type: "delete", value: CUSTOMER, scan: false, revealTokens: true })).statusCode).toBe(400);
    const created = await call(context, "POST", "/api/data-protection/requests", admin, { type: "delete", value: CUSTOMER, scan: false });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<SubjectRequestView>().id;
    const ready = await waitFor(context, admin, id, "ready");
    expect(ready).toMatchObject({ type: "delete", counts: { run: 1 }, export: null });
    // Nothing is deleted before the confirmation; builders cannot confirm; an export cannot be downloaded.
    expect(await context.store.getExecutionHistory(executionId)).not.toBeNull();
    expect((await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, builder, {})).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/data-protection/requests/${id}/export`, admin)).statusCode).toBe(409);

    const confirmed = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin, {})).statusCode).toBe(409);
    const deferred = await waitFor(context, admin, id, "deferred_by_hold");
    expect(deferred.deletion).toMatchObject({ deferred: 1 });
    expect(await context.store.getExecutionHistory(executionId)).not.toBeNull();

    const released = await context.app.inject({ method: "POST", url: `/api/legal-holds/${holdId}/release`, headers: { cookie: admin }, payload: { reason: "Settled" } });
    expect(released.statusCode, released.body).toBe(200);
    const done = await waitFor(context, admin, id, "done");
    expect(done.deletion!.deleted).toMatchObject({ run: 1 });
    expect(await context.store.getExecutionHistory(executionId)).toBeNull();
    expect(Number(await usage())).toBe(usageBefore);

    const audit = await testSql(context.store).all<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE event_type LIKE 'data_subject.%' ORDER BY created_at");
    expect(audit.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "data_subject.deletion_ready",
        "data_subject.deletion_confirmed",
        "data_subject.deletion_deferred",
        "data_subject.deletion_requeued",
        "data_subject.deleted"
      ])
    );
    expect(await dataSubjectText(context)).not.toContain(CUSTOMER.toLowerCase());
  });

  it("asks for a recent MFA check before confirming a deletion when step-up is on; refuses erasing your own account", async () => {
    const context = await createTestContext({ STEP_UP_MAX_AGE_MINUTES: "15" });
    const admin = await login(context, "admin");
    const created = await call(context, "POST", "/api/data-protection/requests", admin, { type: "delete", value: CUSTOMER, scan: false });
    const id = created.json<SubjectRequestView>().id;
    await waitFor(context, admin, id, "ready");
    const confirm = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin, {});
    expect(confirm.statusCode).toBe(403);
    expect(confirm.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "subject_request.delete" } });
    expect((await call(context, "GET", `/api/data-protection/requests/${id}`, admin)).json<SubjectRequestView>().status).toBe("ready");
  });

  it("a staff erasure of your own account is refused at confirmation", async () => {
    const context = await createTestContext();
    const email = `self-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await context.authService.register({ email, password: "Self-Pass-123!", role: "admin" });
    await login(context, "admin");
    const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Self-Pass-123!" } });
    const self = String((Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [response.headers["set-cookie"]]).find((value) => value?.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
    const created = await call(context, "POST", "/api/data-protection/requests", self, { type: "delete", subjectKind: "staff", value: email });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<SubjectRequestView>().id;
    const ready = await waitFor(context, self, id, "ready");
    expect(ready.staffPreview).toMatchObject({ userFound: true });
    const refused = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, self, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain("own account");
    expect(await context.store.getUserByEmail(email)).not.toBeNull();
  });

  it("only an admin may confirm a staff erasure of an existing account; it is audited as user.delete without the email", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const privacyCookie = await login(context, "builder");
    const privacy = (await context.store.listUsers()).find((user) => user.role === "builder")!;
    await context.store.upsertCustomRole({ id: "privacy", projectId: null, name: "Privacy", description: null, permissions: ["data_subject:manage"], createdBy: null });
    await context.store.upsertProjectRole({ userId: privacy.id, projectId: "default", role: "custom", customRoleId: "privacy" });
    const target = `target-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await context.authService.register({ email: target, password: "Target-Pass-123!", role: "admin" });
    const targetId = (await context.store.getUserByEmail(target))!.id;

    const made = await call(context, "POST", "/api/data-protection/requests", privacyCookie, { type: "delete", subjectKind: "staff", value: target });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<SubjectRequestView>().id;
    await waitFor(context, privacyCookie, id, "ready");
    // The privacy role may make and see the request, but not delete an account with it.
    const refused = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, privacyCookie, {});
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("Only an admin");
    expect(await context.store.getUserByEmail(target)).not.toBeNull();

    const confirmed = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await waitFor(context, admin, id, "done");
    expect(await context.store.getUserByEmail(target)).toBeNull();
    const rows = await testSql(context.store).all<{ resource_id: string; metadata_json: string }>(
      "SELECT resource_id, metadata_json FROM audit_logs WHERE event_type = 'user.delete'"
    );
    expect(rows.map((row) => row.resource_id)).toEqual([targetId]);
    expect(rows[0]!.metadata_json).toContain("data_subject_erasure");
    expect(rows[0]!.metadata_json).not.toContain(target);
  });

  it("asks for a recent MFA check before a staff erasure of an existing account", async () => {
    const context = await createTestContext({ STEP_UP_MAX_AGE_MINUTES: "15" });
    const admin = await login(context, "admin");
    const target = `target-${crypto.randomUUID().slice(0, 6)}@example.com`;
    await context.authService.register({ email: target, password: "Target-Pass-123!", role: "builder" });
    const id = (await call(context, "POST", "/api/data-protection/requests", admin, { type: "delete", subjectKind: "staff", value: target })).json<SubjectRequestView>().id;
    await waitFor(context, admin, id, "ready");
    const confirm = await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin, {});
    expect(confirm.statusCode).toBe(403);
    expect(confirm.json()).toMatchObject({ code: "step_up_required" });
  });

  it("a deployment-wide custom role with data_subject:manage may make requests; a project role may not, and only an admin hands it out", async () => {
    const context = await createTestContext();
    const builderCookie = await login(context, "builder");
    const viewerCookie = await login(context, "viewer");
    const users = (await context.store.listUsers()).filter((user) => user.role !== "admin");
    const builder = users.find((user) => user.role === "builder")!;
    const viewer = users.find((user) => user.role === "viewer")!;
    await context.store.upsertProject({ id: "p1", name: "P1" });
    const make = (cookie: string) => call(context, "POST", "/api/data-protection/requests", cookie, { type: "export", value: CUSTOMER, scan: false });

    expect((await make(builderCookie)).statusCode).toBe(403);
    await context.store.upsertCustomRole({ id: "privacy", projectId: null, name: "Privacy", description: null, permissions: ["data_subject:manage"], createdBy: null });
    await context.store.upsertCustomRole({ id: "p1-privacy", projectId: "p1", name: "P1 privacy", description: null, permissions: ["data_subject:manage"], createdBy: null });
    await context.store.upsertProjectRole({ userId: viewer.id, projectId: "p1", role: "custom", customRoleId: "p1-privacy" });
    expect((await make(viewerCookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/data-protection/requests", viewerCookie)).statusCode).toBe(403);
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "default", role: "custom", customRoleId: "privacy" });
    const made = await make(builderCookie);
    expect(made.statusCode, made.body).toBe(201);
    expect((await call(context, "GET", "/api/data-protection/requests", builderCookie)).statusCode).toBe(200);

    // A project admin who is not an admin cannot hand out a role granting a deployment-wide permission.
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "p1", role: "project_admin" });
    const handOut = await call(context, "POST", "/api/projects/p1/members", builderCookie, { userId: viewer.id, role: "custom", customRoleId: "privacy" });
    expect(handOut.statusCode).toBe(403);
  });

  it("refuses an invalid subject reference when a workflow is saved", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const bad = await call(context, "POST", "/api/workflows", builder, workflow("wf-bad", ["{{ results.x }}"]));
    expect(bad.statusCode).toBe(400);
    const good = await call(context, "POST", "/api/workflows", builder, workflow("wf-good", ["{{input.customerId}}", "{{session_id}}"]));
    expect(good.statusCode, good.body).toBeLessThan(300);
  });
});
