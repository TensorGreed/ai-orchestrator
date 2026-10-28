/**
 * Phase 11.2 — approval gates over the API: the inbox and its project
 * scoping, approvers and the self-approval rule, reasons and edits, one
 * decision per request, the timeout sweeper and startup expiry, audit
 * entries, notifications, sub-workflows, resumes on the execution queue,
 * the run manifest and migration 32.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ApprovalRequestView, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql, type TestSql } from "./test-support/test-sql.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { ApprovalResumeRunner } from "./services/approval-service.js";
import { approvalEditsDigest } from "./services/approval-digest.js";
import { escapeTeams } from "./services/notification-service.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
  secretService: SecretService;
  queue?: QueueService;
}

const contexts: TestContext[] = [];
const tempDirs: string[] = [];

async function createTestContext(options: { overrides?: Record<string, string>; tempDir?: string; queue?: boolean; lifecycle?: AppLifecycle } = {}): Promise<TestContext> {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-"));
  if (!tempDirs.includes(tempDir)) tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await openTestStore(dbPath);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...(options.overrides ?? {})
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue ? new QueueService(store, { pollIntervalMs: 20 }) : undefined;
  const app = await createApp(config, store, secretService, authService, undefined, queue, undefined, options.lifecycle ? { lifecycle: options.lifecycle } : {});
  await app.ready();
  const context = { app, store, authService, config, tempDir, dbPath, secretService, ...(queue ? { queue } : {}) };
  contexts.push(context);
  return context;
}

/** Raw SQL against a stopped API's database (the same file reopened), as if the process had died in a given state. */
async function whileStopped(tempDir: string, work: (sql: TestSql) => Promise<void>): Promise<void> {
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  try {
    await work(testSql(store));
  } finally {
    await store.close();
  }
}

async function closeContext(context: TestContext) {
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
  context.queue?.stop();
  await context.app.close();
  try {
    await context.store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (contexts.length > 0) await closeContext(contexts[contexts.length - 1]!);
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const existing = await context.store.getUserByEmail(email);
  const id = existing ? existing.id : (await context.authService.register({ email, password, role })).id;
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function gateWorkflow(id: string, gate: Record<string, unknown>, projectId = "default"): Workflow {
  return {
    id,
    name: `Gated ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("draft", "set_node", { assignments: [{ key: "reply", valueTemplate: "Hello {{user_prompt}}" }] }),
      node("gate", "approval_gate", gate),
      node("sent", "output", { responseTemplate: "sent: {{reply}}" }),
      node("stopped", "output", { responseTemplate: "rejected" }),
      node("late", "output", { responseTemplate: "timed out" })
    ],
    edges: [
      { id: "e1", source: "hook", target: "draft" },
      { id: "e2", source: "draft", target: "gate" },
      { id: "e3", source: "gate", sourceHandle: "approved", target: "sent" },
      { id: "e4", source: "gate", sourceHandle: "rejected", target: "stopped" },
      { id: "e5", source: "gate", sourceHandle: "timed_out", target: "late" }
    ]
  } as Workflow;
}

const GATE = {
  message: "Send '{{reply}}'?",
  approverRoles: ["builder", "admin"],
  timeoutMinutes: 60,
  timeoutOutcome: "fallback",
  editableFields: [{ key: "reply", label: "Reply", type: "text", valueTemplate: "{{reply}}", required: true, maxLength: 200 }]
};

type RunResult = { status: string; executionId?: string; error?: string; output?: Record<string, any>; nodeResults: Array<{ nodeId: string; status: string; output?: Record<string, any> }> };

async function startRun(context: TestContext, workflow: Workflow, cookie: string, prompt = "Ana"): Promise<RunResult> {
  await context.store.upsertWorkflow(workflow);
  const run = (await call(context, "POST", `/api/workflows/${workflow.id}/execute`, cookie, { user_prompt: prompt })).json<RunResult>();
  expect(run.status).toBe("waiting_approval");
  return run;
}

const inbox = async (context: TestContext, cookie: string, query = "") =>
  (await call(context, "GET", `/api/approvals${query}`, cookie)).json<{ items: ApprovalRequestView[] }>().items;

const auditTypes = async (context: TestContext) => (await context.store.listAuditLogs({ category: "approval", pageSize: 100 })).items.map((entry) => entry.eventType);

async function waitFor<T>(read: () => T | undefined | null | Promise<T | undefined | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("migration 32", () => {
  it("adds approval_requests in Postgres DDL with a down path, and the same table in SQLite", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 32)!;
    expect(migration.description).toContain("11.2");
    for (const fragment of [
      "CREATE TABLE IF NOT EXISTS approval_requests",
      "spec_json TEXT NOT NULL",
      "expires_at TIMESTAMPTZ",
      "asking_workflow_id TEXT",
      "edits_salt TEXT",
      "workflow_deleted_at TIMESTAMPTZ",
      "idx_approval_requests_status_expires",
      "CREATE TABLE IF NOT EXISTS schema_markers",
      "INSERT INTO schema_markers"
    ]) {
      expect(migration.up).toContain(fragment);
    }
    expect(migration.down).toContain("DROP TABLE IF EXISTS approval_requests");
    expect(migration.down).toContain("DROP TABLE IF EXISTS schema_markers");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = sql.kind === "sqlite"
      ? (await sql.all<{ name: string }>("PRAGMA table_info(approval_requests)")).map((row) => row.name)
      : (await sql.all<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'approval_requests'")).map((row) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "execution_id", "project_id", "kind", "status", "spec_json", "requested_by_user_id", "expires_at", "decided_by", "reason", "edits_json", "edited_fields_json", "asking_workflow_id", "edits_salt", "workflow_deleted_at"])
    );
    expect(await sql.all("SELECT name FROM schema_markers WHERE name = 'approval_requests'")).toEqual([{ name: "approval_requests" }]);
  });
});

describe("approvals inbox", () => {
  it("lists a gate with its approvers and proposed values, refuses self-approval and non-approvers, and approves with edits", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const operator = await login(context, "operator");
    const run = await startRun(context, gateWorkflow("wf-edit", GATE), requester.cookie);

    const [item] = await inbox(context, requester.cookie);
    expect(item).toMatchObject({
      id: run.executionId,
      executionId: run.executionId,
      nodeId: "gate",
      kind: "approval_gate",
      status: "pending",
      message: "Send 'Hello Ana'?",
      approvalMessage: "Send 'Hello Ana'?",
      approverRoles: ["builder", "admin"],
      allowSelfApproval: false,
      timeoutOutcome: "fallback",
      requestedBy: requester.email,
      editableFields: [{ key: "reply", type: "text", value: "Hello Ana", required: true }],
      canDecide: false
    });
    expect(item!.cannotDecideReason).toMatch(/own run/);
    expect(item!.expiresAt).toBeTruthy();
    expect((await inbox(context, lead.cookie))[0]!.canDecide).toBe(true);
    expect((await inbox(context, operator.cookie))[0]).toMatchObject({ canDecide: false, cannotDecideReason: "You are not one of this gate's approvers." });

    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, requester.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, operator.cookie, {})).statusCode).toBe(403);
    const badEdit = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { edits: { reply: "", other: 1 } });
    expect(badEdit.statusCode).toBe(400);
    expect(badEdit.json<{ details: Array<{ key: string }> }>().details.map((entry) => entry.key).sort()).toEqual(["other", "reply"]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: "apr_stale" })).statusCode).toBe(409);

    const approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { edits: { reply: "Hello Ana, thanks!" }, reason: "Warmer", requestId: item!.requestId });
    expect(approved.statusCode).toBe(200);
    const result = approved.json<RunResult>();
    expect(result.status).toBe("success");
    expect(result.nodeResults.find((entry) => entry.nodeId === "sent")?.output?.result).toBe("sent: Hello Ana, thanks!");

    expect(await inbox(context, lead.cookie)).toEqual([]);
    const [decided] = await inbox(context, lead.cookie, "?status=decided");
    expect(decided).toMatchObject({ status: "approved", decidedBy: lead.email, reason: "Warmer", editedFields: ["reply"], canDecide: false });
    expect(await auditTypes(context)).toEqual(expect.arrayContaining(["approval.requested", "approval.decided"]));
    const denied = (await context.store.listAuditLogs({ category: "approval", outcome: "denied", pageSize: 10 })).items;
    expect(denied.length).toBe(2);

    // The decision is in the run manifest: the gate's decision and the request with the edit digest.
    const admin = await login(context, "admin");
    const manifest = (await call(context, "GET", `/api/executions/${run.executionId}/manifest`, admin.cookie)).json<{ manifest: Record<string, any> }>().manifest;
    expect(manifest.approvals).toEqual([expect.objectContaining({ nodeId: "gate", decision: "approve", actedBy: lead.email, reason: "Warmer" })]);
    expect(manifest.extensions.approvals.requests).toEqual([
      expect.objectContaining({ nodeId: "gate", kind: "approval_gate", outcome: "approved", decidedBy: lead.email, editedFields: ["reply"], editsDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    ]);
    expect(JSON.stringify(manifest)).not.toContain("Hello Ana, thanks!");
  });

  it("requires a reason to reject a gate, routes the rejection, and takes one decision per request", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-reject", GATE), requester.cookie);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, {})).statusCode).toBe(400);
    // One after the other: which of two concurrent decisions wins is the store's race (Postgres runs both requests at
    // once), and "concurrent decisions" below covers it.
    const first = await call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, { reason: "Off-brand" });
    expect(first.statusCode).toBe(200);
    expect(first.json<RunResult>().nodeResults.find((entry) => entry.nodeId === "stopped")?.status).toBe("success");
    const second = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect([404, 409]).toContain(second.statusCode);
    const [decided] = await inbox(context, lead.cookie, "?status=all");
    expect(decided).toMatchObject({ status: "rejected", reason: "Off-brand" });
  });

  it("scopes the inbox and decisions to the workflow's project", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    await context.store.upsertProject({ id: "team-a", name: "Team A" });
    await context.store.upsertCustomRole({ id: "none-team-a", projectId: "team-a", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "team-a", role: "custom", customRoleId: "none-team-a" });
    const run = await startRun(context, gateWorkflow("wf-scoped", { ...GATE, approverRoles: [] }, "team-a"), requester.cookie);
    expect(await inbox(context, outsider.cookie)).toEqual([]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);

    // Read access without execute: the item shows, but cannot be decided.
    await context.store.upsertCustomRole({ id: "read-team-a", projectId: "team-a", name: "Read", permissions: ["workflow:read"] });
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "team-a", role: "custom", customRoleId: "read-team-a" });
    const [item] = await inbox(context, outsider.cookie);
    expect(item).toMatchObject({ canDecide: false, cannotDecideReason: "You do not have execute access to this workflow's project." });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(403);
  });

  it("keeps Human Approval nodes decidable by the requester, without a reason", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const workflow = {
      id: "wf-human",
      name: "Human",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-human", method: "POST" }), node("approve", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 5 }), node("out", "output")],
      edges: [{ id: "e1", source: "hook", target: "approve" }, { id: "e2", source: "approve", target: "out" }]
    } as Workflow;
    const run = await startRun(context, workflow, builder.cookie);
    expect((await inbox(context, builder.cookie))[0]).toMatchObject({ kind: "human_approval", allowSelfApproval: true, requireRejectReason: false, canDecide: true });
    const rejected = await call(context, "POST", `/api/approvals/${run.executionId}/reject`, builder.cookie, {});
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<RunResult>().error).toBe("Human approval rejected");
  });

  it("cancels the pending request when the run is canceled", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const run = await startRun(context, gateWorkflow("wf-cancel", GATE), requester.cookie);
    expect((await call(context, "POST", `/api/executions/${run.executionId}/cancel`, requester.cookie, {})).statusCode).toBe(200);
    expect(await inbox(context, requester.cookie)).toEqual([]);
    expect((await inbox(context, requester.cookie, "?status=decided"))[0]).toMatchObject({ status: "canceled" });
    expect(await auditTypes(context)).toContain("approval.canceled");
  });
});

describe("one pending request per run (v41)", () => {
  it("a request another instance backfilled first is superseded by the pause's own request", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const insert = context.store.insertApprovalRequest.bind(context.store);
    let raced = 0;
    vi.spyOn(context.store, "insertApprovalRequest").mockImplementation(async (input) => {
      if (raced === 0) {
        raced += 1;
        // Another instance's backfill lands between this pause's cancel and its insert.
        await insert({ ...input, id: "apr_other_instance" });
      }
      return await insert(input);
    });
    const run = await startRun(context, gateWorkflow("wf-race", GATE), requester.cookie);
    const pending = await context.store.getPendingApprovalRequestForExecution(run.executionId!);
    expect(pending?.id).not.toBe("apr_other_instance");
    expect(await context.store.getApprovalRequest("apr_other_instance")).toMatchObject({ status: "canceled", reason: "Superseded by a newer request of the same run" });
    expect((await inbox(context, requester.cookie)).map((item) => item.requestId)).toEqual([pending!.id]);
  });

  it("a backfill that loses to another instance's backfill uses that request", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const run = await startRun(context, gateWorkflow("wf-backfill", GATE), requester.cookie);
    const own = await context.store.getPendingApprovalRequestForExecution(run.executionId!);
    // The row is missing (as for a run paused before approval requests existed); another instance backfills it first.
    await context.store.cancelPendingApprovalRequests({ executionId: run.executionId! }, "test");
    const insert = context.store.insertApprovalRequest.bind(context.store);
    let raced = false;
    vi.spyOn(context.store, "getPendingApprovalRequestForExecution").mockImplementationOnce(async () => null);
    vi.spyOn(context.store, "insertApprovalRequest").mockImplementation(async (input) => {
      if (!raced) {
        raced = true;
        await insert({ ...input, id: "apr_other_backfill" });
      }
      return await insert(input);
    });
    const items = await inbox(context, requester.cookie);
    expect(items.map((item) => item.requestId)).toEqual(["apr_other_backfill"]);
    expect(own?.id).not.toBe("apr_other_backfill");
    expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).filter((r) => r.status === "pending").map((r) => r.id)).toEqual(["apr_other_backfill"]);
  });
});

describe("concurrent decisions", () => {
  it("two approvers deciding the same gate at once: one decision wins, the run resumes once", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const other = await login(context, "admin", "other");
    const run = await startRun(context, gateWorkflow("wf-race", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    const [a, b] = await Promise.all([
      call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId }),
      call(context, "POST", `/api/approvals/${run.executionId}/reject`, other.cookie, { requestId: item!.requestId, reason: "No" })
    ]);
    const codes = [a.statusCode, b.statusCode];
    expect(codes.filter((code) => code === 200)).toHaveLength(1);
    expect([404, 409]).toContain(codes.find((code) => code !== 200));
    const decided = (await context.store.listAuditLogs({ category: "approval", pageSize: 100 })).items.filter((entry) => entry.eventType === "approval.decided");
    expect(decided).toHaveLength(1);
    const winner = a.statusCode === 200 ? "sent" : "stopped";
    const history = await context.store.getExecutionHistory(run.executionId!);
    expect(history?.status).toBe("success");
    expect(JSON.stringify(history)).toContain(winner === "sent" ? "sent: Hello Ana" : "rejected");
  });

  it("an approval that lands after a cancel read the run as waiting wins: the cancel answers 409 and the resumed run keeps its state and result", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-cancel-race", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    // The cancel route's read of the run returns "waiting_approval"; the approval is decided and the run resumes
    // before the cancel takes its next step, as two requests on a networked store can interleave.
    const store = context.store;
    const read = store.getExecutionHistory.bind(store);
    let armed = true;
    let approved: { statusCode: number } | undefined;
    store.getExecutionHistory = async (id: string) => {
      const row = await read(id);
      if (armed && id === run.executionId) {
        armed = false;
        approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId });
      }
      return row;
    };
    let cancel;
    try {
      cancel = await call(context, "POST", `/api/executions/${run.executionId}/cancel`, requester.cookie, {});
    } finally {
      store.getExecutionHistory = read;
    }
    expect(approved?.statusCode).toBe(200);
    expect(cancel.statusCode, cancel.body).toBe(409);
    expect(cancel.json<{ error: string }>().error).toMatch(/already decided|Only running or waiting/);
    const history = await waitFor(async () => {
      const row = await store.getExecutionHistory(run.executionId!);
      return row && row.status !== "waiting_approval" && row.status !== "running" ? row : null;
    });
    expect(history.status).toBe("success");
    expect(JSON.stringify(history)).toContain("sent: Hello Ana");
    const types = (await store.listAuditLogs({ pageSize: 200 })).items.map((entry) => entry.eventType);
    expect(types).not.toContain("execution.cancel_requested");
    expect(types).not.toContain("approval.canceled");
  });

  it("a cancel whose approval was decided between its read and its write refuses and leaves the paused state for the resume", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-cancel-claim", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    // The decision is taken and the run claimed for resume (what the approve route does first), but the resume has
    // not started yet when the cancel arrives.
    const decided = await context.store.claimExecutionAndDecideApproval(run.executionId!, {
      id: item!.requestId,
      status: "approved",
      decidedByUserId: lead.id,
      decidedBy: lead.email,
      decidedAt: new Date().toISOString(),
      reason: null
    });
    expect(decided).toBe(true);
    const cancel = await call(context, "POST", `/api/executions/${run.executionId}/cancel`, requester.cookie, {});
    expect(cancel.statusCode, cancel.body).toBe(409);
    expect(cancel.json<{ error: string }>().error).toMatch(/already decided/);
    expect(await context.store.getWorkflowExecutionState(run.executionId!)).toMatchObject({ status: "resuming" });
    expect((await context.store.getExecutionHistory(run.executionId!))?.status).toBe("waiting_approval");
  });

  it("an approve between the cancel's request cancel and its write leaves no pending request behind", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-cancel-gap", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    // On a networked store the approve can run in the gap after the cancel took the pending request: it finds the
    // run still waiting with no pending request, and opens a new one.
    const store = context.store;
    const cancelExecution = store.cancelExecution.bind(store);
    let approved: { statusCode: number } | undefined;
    store.cancelExecution = async (input) => {
      approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId });
      return await cancelExecution(input);
    };
    let cancel;
    try {
      cancel = await call(context, "POST", `/api/executions/${run.executionId}/cancel`, requester.cookie, {});
    } finally {
      store.cancelExecution = cancelExecution;
    }
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect([404, 409]).toContain(approved?.statusCode);
    expect((await store.getExecutionHistory(run.executionId!))?.status).toBe("canceled");
    expect(await store.getWorkflowExecutionState(run.executionId!)).toBeNull();
    const requests = await store.listApprovalRequestsForExecution(run.executionId!);
    const statuses = requests.map((request) => request.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses).not.toContain("pending");
    // Every request the cancel canceled is audited, including one it canceled inside its own write.
    const canceledIds = requests.filter((request) => request.status === "canceled").map((request) => request.id).sort();
    const audited = (await store.listAuditLogs({ category: "approval", pageSize: 100 })).items
      .filter((entry) => entry.eventType === "approval.canceled")
      .map((entry) => String((entry.metadata as Record<string, unknown> | null)?.requestId))
      .sort();
    expect(audited).toEqual(canceledIds);
  });

  it("a cancel while the approved run is resuming in this process stops it like a running run: 200, canceled, audited", async () => {
    // The node after the gate calls a server that holds its answer, so the resume is still running at the cancel.
    let hits = 0;
    const held: Array<() => void> = [];
    const server = http.createServer((_request, response) => {
      hits += 1;
      held.push(() => {
        response.setHeader("content-type", "application/json");
        response.end("{\"ok\":true}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const releaseAll = () => {
      while (held.length) held.shift()!();
    };
    try {
      const port = (server.address() as { port: number }).port;
      const context = await createTestContext();
      const requester = await login(context, "builder", "requester");
      const lead = await login(context, "builder", "lead");
      const workflow = gateWorkflow("wf-cancel-resuming", { ...GATE, editableFields: [] });
      workflow.nodes.push(node("call", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/` }));
      workflow.edges = workflow.edges.map((edge) => (edge.id === "e3" ? { ...edge, target: "call" } : edge));
      workflow.edges.push({ id: "e6", source: "call", target: "sent" });
      const run = await startRun(context, workflow, requester.cookie);
      const [item] = await inbox(context, lead.cookie);
      const approving = call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId });
      await waitFor(() => hits > 0);
      // The resume writes no progress, so the run still reads as waiting while it runs.
      expect((await context.store.getExecutionHistory(run.executionId!))?.status).toBe("waiting_approval");
      const cancel = await call(context, "POST", `/api/executions/${run.executionId}/cancel`, requester.cookie, {});
      releaseAll();
      await approving;
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json()).toMatchObject({ status: "canceled", abortedActiveRun: true });
      const history = await waitFor(async () => {
        const row = await context.store.getExecutionHistory(run.executionId!);
        return row && row.status !== "waiting_approval" && row.status !== "running" ? row : null;
      });
      expect(history.status).toBe("canceled");
      expect(await context.store.getWorkflowExecutionState(run.executionId!)).toBeNull();
      const cancels = (await context.store.listAuditLogs({ pageSize: 200 })).items.filter((entry) => entry.eventType === "execution.cancel_requested");
      expect(cancels).toHaveLength(1);
    } finally {
      releaseAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("timeouts", () => {
  it("expires overdue requests at startup, routes to timed_out, audits and notifies", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-restart-"));
    const overrides = { NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.example.test/slack", APP_PUBLIC_URL: "https://l2m.example.test" };
    const posts: Array<{ url: string; body: string }> = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://hooks.example.test/")) {
        posts.push({ url, body: String(init?.body ?? "") });
        return new Response("ok");
      }
      return realFetch(input as string, init);
    });
    const first = await createTestContext({ tempDir, overrides });
    const requester = await login(first, "builder", "requester");
    const run = await startRun(first, gateWorkflow("wf-late", GATE), requester.cookie);
    await waitFor(() => posts.find((post) => post.body.includes("Approval needed")));
    const requested = JSON.parse(posts.find((post) => post.body.includes("Approval needed"))!.body).text as string;
    // Channels are not project-scoped: the run's own text stays in the inbox.
    expect(requested).not.toContain("Hello Ana");
    expect(requested).toContain("Open the approvals inbox");
    expect(requested).toContain("https://l2m.example.test/?mode=approvals&request=apr_");
    await closeContext(first);

    // Past its expiry while the API was down.
    await whileStopped(tempDir, async (sql) => {
      await sql.run("UPDATE approval_requests SET expires_at = ? WHERE execution_id = ?", new Date(Date.now() - 60_000).toISOString(), run.executionId);
    });

    const second = await createTestContext({ tempDir, overrides });
    const history = await waitFor(async () => {
      const entry = await second.store.getExecutionHistory(run.executionId!);
      return entry && entry.status !== "waiting_approval" && entry.status !== "running" ? entry : null;
    });
    expect(history.status).toBe("success");
    const results = history.nodeResults as Array<{ nodeId: string; status: string; output?: Record<string, any> }>;
    expect(results.find((entry) => entry.nodeId === "gate")?.output?._branchHandle).toBe("timed_out");
    expect(results.find((entry) => entry.nodeId === "late")?.status).toBe("success");
    expect(await auditTypes(second)).toContain("approval.timed_out");
    await waitFor(() => posts.find((post) => post.body.includes("Approval timed out")));
    const reader = await login(second, "builder", "requester");
    expect((await inbox(second, reader.cookie, "?status=decided"))[0]).toMatchObject({ status: "timed_out", decidedBy: "system" });
  });
});

describe("sub-workflows and the queue", () => {
  it("shows a child's gate for the parent run and resumes both on approve", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const child = {
      id: "wf-child",
      name: "Child",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("start", "manual_trigger"), node("gate", "approval_gate", { message: "Child gate", approverUsers: [lead.email] }), node("out", "output", { responseTemplate: "child done" })],
      edges: [{ id: "c1", source: "start", target: "gate" }, { id: "c2", source: "gate", sourceHandle: "approved", target: "out" }]
    } as Workflow;
    await context.store.upsertWorkflow(child);
    const parent = {
      id: "wf-parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-parent", method: "POST" }), node("call", "execute_workflow", { workflowId: "wf-child" }), node("out", "output", { responseTemplate: "parent got {{result}}" })],
      edges: [{ id: "p1", source: "hook", target: "call" }, { id: "p2", source: "call", target: "out" }]
    } as Workflow;
    const run = await startRun(context, parent, requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    expect(item).toMatchObject({ executionId: run.executionId, workflowId: "wf-parent", nodeId: "gate", approverUsers: [lead.email], path: [{ workflowId: "wf-parent", nodeId: "call" }], canDecide: true });
    expect((await inbox(context, requester.cookie))[0]!.canDecide).toBe(false);
    const approved = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).json<RunResult>();
    expect(approved.status).toBe("success");
    expect(approved.nodeResults.find((entry) => entry.nodeId === "out")?.output?.result).toBe("parent got child done");
  });

  it("resumes on the execution queue when it is in use", async () => {
    const context = await createTestContext({ queue: true });
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-queued", GATE), requester.cookie);
    const response = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ queued: true, executionId: run.executionId, decision: "approve" });
    const history = await waitFor(async () => {
      const entry = await context.store.getExecutionHistory(run.executionId!);
      return entry && entry.status === "success" ? entry : null;
    });
    expect((history.nodeResults as Array<{ nodeId: string; status: string }>).find((entry) => entry.nodeId === "sent")?.status).toBe("success");
    // A second decision after the queued one is refused.
    expect([404, 409]).toContain((await call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, { reason: "late" })).statusCode);
  });
});


function rejectFailsWorkflow(id: string): Workflow {
  const base = gateWorkflow(id, { ...GATE, approverRoles: [] });
  return { ...base, nodes: base.nodes.filter((entry) => ["hook", "draft", "gate", "sent"].includes(entry.id)), edges: base.edges.filter((edge) => ["e1", "e2", "e3"].includes(edge.id)) };
}

describe("nothing skips an Approval Gate over the API", () => {
  it("refuses a start node on a sibling branch that merges below the gate", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const wf = {
      id: "wf-merge-skip",
      name: "Merge skip",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("in", "manual_trigger"), node("x", "noop_node"), node("gate", "approval_gate", GATE), node("send", "output", { responseTemplate: "SENT" })],
      edges: [
        { id: "e1", source: "in", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "send" },
        { id: "e3", source: "in", target: "x" },
        { id: "e4", source: "x", target: "send" }
      ]
    } as Workflow;
    await context.store.upsertWorkflow(wf);
    const skipped = (await call(context, "POST", `/api/workflows/${wf.id}/execute`, builder.cookie, { startNodeId: "x" })).json<RunResult>();
    expect(skipped.status).toBe("error");
    expect(skipped.error).toContain("Approval Gate 'gate'");
    expect(skipped.nodeResults.find((entry) => entry.nodeId === "send")).toBeUndefined();
    expect(await context.store.listApprovalRequestsForExecution(skipped.executionId ?? "none")).toEqual([]);
  });

  it("refuses execute and retry that start after the gate, ignores a pinned gate output, and refuses pinning a gate", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const lead = await login(context, "builder", "lead");
    const wf = rejectFailsWorkflow("wf-skip");
    await context.store.upsertWorkflow(wf);
    const refusal = "This run would start after Approval Gate 'gate'. Start at or before the gate.";

    for (const runMode of ["workflow", "single_node"]) {
      const skipped = (await call(context, "POST", `/api/workflows/${wf.id}/execute`, builder.cookie, { startNodeId: "sent", runMode, nodeOutputs: { gate: { approved: true, _branchHandle: "approved" } } })).json<RunResult>();
      expect(skipped.status).toBe("error");
      expect(skipped.error).toBe(refusal);
    }
    const pinned = (await call(context, "POST", `/api/workflows/${wf.id}/execute`, builder.cookie, { user_prompt: "Ana", pinnedData: { gate: { approved: true, _branchHandle: "approved" } } })).json<RunResult>();
    expect(pinned.status).toBe("waiting_approval");
    expect(pinned.nodeResults.find((entry) => entry.nodeId === "sent")).toBeUndefined();

    const pin = await call(context, "PUT", `/api/workflows/${wf.id}/pins/gate`, builder.cookie, { data: { approved: true } });
    expect(pin.statusCode).toBe(400);
    expect(pin.json<{ error: string }>().error).toMatch(/cannot be pinned/);
    expect((await context.store.getWorkflow(wf.id))?.pinnedData).toBeUndefined();

    // A rejected run retried from the node after the gate is refused too.
    const rejected = await call(context, "POST", `/api/approvals/${pinned.executionId}/reject`, lead.cookie, { reason: "No" });
    expect(rejected.json<RunResult>().status).toBe("error");
    const retried = (await call(context, "POST", `/api/executions/${pinned.executionId}/retry`, builder.cookie, { startNodeId: "sent" })).json<RunResult>();
    expect(retried.status).toBe("error");
    expect(retried.error).toBe(refusal);
  });
});

describe("a recorded decision is never lost", () => {
  it("runs a later decision of the same run after the earlier resume, and the same decision once", async () => {
    const runner = new ApprovalResumeRunner();
    let release!: () => void;
    const order: string[] = [];
    const first = runner.run({ executionId: "exec-1", requestId: "apr_1" }, async () => {
      order.push("first started");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first done");
      return "first";
    });
    expect(runner.isActive("exec-1")).toBe(true);
    const duplicate = await runner.run({ executionId: "exec-1", requestId: "apr_1" }, async () => "again");
    expect(duplicate).toBeNull();
    const second = runner.run({ executionId: "exec-1", requestId: "apr_2" }, async () => {
      order.push("second started");
      return "second";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["first started"]);
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(order).toEqual(["first started", "first done", "second started"]);
    expect(runner.isActive("exec-1")).toBe(false);
  });

  it("a shutdown drain during a queued resume (one instance, default settings) gives it back resumable: never canceled, paused state kept", async () => {
    // The node after the gate calls a server that holds its answer, so the resume is still running when the drain
    // stops it.
    let hits = 0;
    let holding = true;
    const held: Array<() => void> = [];
    const server = http.createServer((_request, response) => {
      hits += 1;
      const answer = () => {
        response.setHeader("content-type", "application/json");
        response.end("{\"ok\":true}");
      };
      if (holding) held.push(answer);
      else answer();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const lifecycle = new AppLifecycle();
      const context = await createTestContext({ queue: true, lifecycle });
      const requester = await login(context, "builder", "requester");
      const lead = await login(context, "builder", "lead");
      const workflow = gateWorkflow("wf-drain-resume", { ...GATE, editableFields: [] });
      workflow.nodes.push(node("call", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/` }));
      workflow.edges = workflow.edges.map((edge) => (edge.id === "e3" ? { ...edge, target: "call" } : edge));
      workflow.edges.push({ id: "e6", source: "call", target: "sent" });
      const run = await startRun(context, workflow, requester.cookie);
      const [item] = await inbox(context, lead.cookie);
      expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId })).statusCode).toBe(202);
      await waitFor(() => hits > 0);

      await lifecycle.drain(50);
      expect(context.queue!.inFlightCount()).toBe(0);
      // Nothing was destroyed: the run still reads as the pause, its decision stands, the job waits for the next worker.
      expect((await context.store.getExecutionHistory(run.executionId!))?.status).toBe("waiting_approval");
      expect((await context.store.getWorkflowExecutionState(run.executionId!))?.status).toBe("resuming");
      expect(await context.store.getApprovalRequest(item!.requestId)).toMatchObject({ status: "approved" });
      const [job] = await testSql(context.store).all<{ status: string; attempts: unknown }>(
        "SELECT status, attempts FROM execution_queue WHERE id LIKE ?",
        `${run.executionId}:${item!.requestId}:%`
      );
      expect([job!.status, Number(job!.attempts)]).toEqual(["pending", 0]);
      expect(await context.store.listDlqItems()).toEqual([]);

      // The next process on the same database resumes it from the recorded decision, once.
      const { tempDir } = context;
      await closeContext(context);
      holding = false;
      while (held.length) held.shift()!();
      const restarted = await createTestContext({ queue: true, tempDir });
      const history = await waitFor(async () => {
        const entry = await restarted.store.getExecutionHistory(run.executionId!);
        return entry && entry.status === "success" ? entry : null;
      });
      expect((history.nodeResults as Array<{ nodeId: string; status: string }>).find((entry) => entry.nodeId === "sent")?.status).toBe("success");
      expect(await restarted.store.getWorkflowExecutionState(run.executionId!)).toBeNull();
      expect(await restarted.store.listApprovalRequestsForExecution(run.executionId!)).toHaveLength(1);
    } finally {
      holding = false;
      while (held.length) held.shift()!();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hands the request back when the queue cannot take the resume, and the decision can be taken again", async () => {
    const context = await createTestContext({ queue: true });
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-enqueue-fails", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    vi.spyOn(context.queue!, "enqueue").mockRejectedValueOnce(new Error("queue down"));
    const failed = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: "Could not resume the run; decide again" });
    expect((await context.store.getWorkflowExecutionState(run.executionId!))?.status).toBe("waiting_approval");
    expect(await context.store.getApprovalRequest(item!.requestId)).toMatchObject({ status: "pending", decidedBy: null, expiresAt: item!.expiresAt });

    const again = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId });
    expect(again.statusCode).toBe(202);
    // The queued resume carries the run timeout, so the stuck-job check follows it.
    const queued = (await testSql(context.store).get<{ payload_json: string | Record<string, any> }>("SELECT payload_json FROM execution_queue WHERE id LIKE ?", `${run.executionId}:${item!.requestId}:%`))!;
    const payload = typeof queued.payload_json === "string" ? JSON.parse(queued.payload_json) : queued.payload_json;
    expect(payload.executionTimeoutMs).toBe(context.config.WORKFLOW_EXECUTION_TIMEOUT_MS);
    await waitFor(async () => (await context.store.getExecutionHistory(run.executionId!))?.status === "success");
  });

  it("applies the new decision, once, when a queued resume fails and the request is decided again", async () => {
    const context = await createTestContext({ queue: true });
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-redecide", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    vi.spyOn(context.store, "listVariables").mockImplementationOnce(() => {
      throw new Error("database hiccup");
    });
    const first = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { edits: { reply: "first words" } });
    expect(first.statusCode).toBe(202);
    await waitFor(async () => ((await context.store.getApprovalRequest(item!.requestId))?.status === "pending" ? true : null));
    await waitFor(async () => ((await context.store.getWorkflowExecutionState(run.executionId!))?.status === "waiting_approval" ? true : null));
    const second = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId, edits: { reply: "second words" } });
    expect(second.statusCode).toBe(202);
    const history = await waitFor(async () => {
      const entry = await context.store.getExecutionHistory(run.executionId!);
      return entry && entry.status === "success" ? entry : null;
    });
    const sent = (history.nodeResults as Array<{ nodeId: string; output?: Record<string, any> }>).find((entry) => entry.nodeId === "sent");
    expect(JSON.stringify(sent?.output)).toContain("second words");
    expect(JSON.stringify(sent?.output)).not.toContain("first words");
    // One queue item per decision; the failed one is not retried by the queue itself (its attempts are for a lost
    // worker): it went to the dead-letter queue after its one try.
    const rows = await testSql(context.store).all<{ id: string; status: string; attempts: unknown }>(
      "SELECT id, status, attempts FROM execution_queue WHERE id LIKE ? ORDER BY created_at",
      `${run.executionId}:${item!.requestId}:%`
    );
    expect(rows.map((row) => [row.status, Number(row.attempts)])).toEqual([["dead", 1], ["completed", 0]]);
  });

  it("hands the request back with its expiry when the resume throws", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-resume-throws", GATE), requester.cookie);
    const [item] = await inbox(context, lead.cookie);
    // Fails inside the resume, after the decision was recorded.
    vi.spyOn(context.store, "listVariables").mockImplementationOnce(() => {
      throw new Error("database hiccup");
    });
    const failed = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(failed.statusCode).toBe(503);
    expect((await context.store.getWorkflowExecutionState(run.executionId!))?.status).toBe("waiting_approval");
    const reopened = (await inbox(context, lead.cookie))[0]!;
    expect(reopened).toMatchObject({ requestId: item!.requestId, status: "pending", expiresAt: item!.expiresAt, canDecide: true });
    const approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(approved.json<RunResult>().status).toBe("success");
  });

  for (const queue of [false, true]) {
    it(`re-drives a run left in resuming ${queue ? "on the queue" : "inline"} at startup, with the decision of its current pause`, async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-recover-"));
      const first = await createTestContext({ tempDir, queue });
      const requester = await login(first, "builder", "requester");
      const lead = await login(first, "builder", "lead");
      const run = await startRun(first, gateWorkflow("wf-recover", GATE), requester.cookie);
      const [item] = await inbox(first, lead.cookie);
      await closeContext(first);

      // The process stopped between the decision and its resume (no queue item either), long enough ago that on a
      // database instances share (Postgres) no live instance can still be running it.
      await whileStopped(tempDir, async (sql) => {
        await sql.run("UPDATE workflow_executions SET status = 'resuming', updated_at = ? WHERE id = ?", new Date(Date.now() - 86_400_000).toISOString(), run.executionId);
        await sql.run("UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", lead.email, new Date().toISOString(), item!.requestId);
      });

      const second = await createTestContext({ tempDir, queue });
      const history = await waitFor(async () => {
        const entry = await second.store.getExecutionHistory(run.executionId!);
        return entry && entry.status === "success" ? entry : null;
      });
      expect((history.nodeResults as Array<{ nodeId: string; status: string }>).find((entry) => entry.nodeId === "sent")?.status).toBe("success");
    });
  }

  it("never applies an earlier pause's decision: a resuming run with no decision for its current pause waits again", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-stale-"));
    const first = await createTestContext({ tempDir });
    const requester = await login(first, "builder", "requester");
    const run = await startRun(first, gateWorkflow("wf-stale", GATE), requester.cookie);
    await closeContext(first);
    await whileStopped(tempDir, async (sql) => {
      // An older decided request for another node, and the current one still pending.
      const old = (await sql.get<{ id: string }>("SELECT id FROM approval_requests WHERE execution_id = ?", run.executionId))!;
      await sql.run("UPDATE approval_requests SET created_at = ? WHERE id = ?", new Date(Date.now() - 1_000).toISOString(), old.id);
      await sql.run(
        "INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, decided_by, created_at, updated_at) VALUES ('apr_old', ?, ?, 'default', 'earlier_gate', 'approval_gate', 'approved', '{}', 'someone', ?, ?)",
        run.executionId, "wf-stale", new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString()
      );
      // Claimed long ago: on a database instances share (Postgres) only a stale claim is recovered at startup.
      await sql.run("UPDATE workflow_executions SET status = 'resuming', updated_at = ? WHERE id = ?", new Date(Date.now() - 86_400_000).toISOString(), run.executionId);
    });
    const second = await createTestContext({ tempDir });
    await waitFor(async () => (await second.store.getWorkflowExecutionState(run.executionId!))?.status === "waiting_approval");
    expect((await second.store.getExecutionHistory(run.executionId!))?.status).not.toBe("success");
  });
});

describe("expiry and the upgrade", () => {
  it("refuses a decision past the expiry and applies the timeout outcome", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-expired", GATE), requester.cookie);
    await testSql(context.store).run("UPDATE approval_requests SET expires_at = ? WHERE execution_id = ?", new Date(Date.now() - 1_000).toISOString(), run.executionId);
    const late = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: string }>().error).toMatch(/expired/);
    const history = await waitFor(async () => {
      const entry = await context.store.getExecutionHistory(run.executionId!);
      return entry && entry.status === "success" ? entry : null;
    });
    expect((history.nodeResults as Array<{ nodeId: string; output?: Record<string, any> }>).find((entry) => entry.nodeId === "gate")?.output?._branchHandle).toBe("timed_out");
  });

  it("gives a run paused before the upgrade one full timeout from the upgrade, and a later one its own", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-upgrade-"));
    const first = await createTestContext({ tempDir });
    const requester = await login(first, "builder", "requester");
    const human = {
      id: "wf-legacy",
      name: "Legacy",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-legacy", method: "POST" }), node("approve", "human_approval", { approvalMessage: "ok?", timeoutMinutes: 60 }), node("out", "output")],
      edges: [{ id: "e1", source: "hook", target: "approve" }, { id: "e2", source: "approve", target: "out" }]
    } as Workflow;
    const before = await startRun(first, human, requester.cookie);
    const after = await startRun(first, { ...human, id: "wf-legacy-2", nodes: human.nodes.map((entry) => (entry.id === "hook" ? node("hook", "webhook_input", { path: "hook-legacy-2", method: "POST" }) : entry)) }, requester.cookie);
    await closeContext(first);

    const upgradedAt = new Date(Date.now() - 30 * 60_000);
    const pausedAfter = new Date(Date.now() - 10 * 60_000).toISOString();
    await whileStopped(tempDir, async (sql) => {
      // As if both runs were waiting when approval requests came up: no request rows, and the upgrade 30 minutes ago.
      await sql.run("DELETE FROM approval_requests");
      await sql.run("UPDATE schema_markers SET created_at = ? WHERE name = 'approval_requests'", upgradedAt.toISOString());
      await sql.run("UPDATE workflow_executions SET created_at = ?, updated_at = ? WHERE id = ?", new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 2 * 86_400_000).toISOString(), before.executionId);
      await sql.run("UPDATE workflow_executions SET created_at = ?, updated_at = ? WHERE id = ?", pausedAfter, pausedAfter, after.executionId);
    });

    const second = await createTestContext({ tempDir });
    const reader = await login(second, "builder", "requester");
    const items = await inbox(second, reader.cookie);
    const legacy = items.find((entry) => entry.executionId === before.executionId)!;
    const recent = items.find((entry) => entry.executionId === after.executionId)!;
    // Paused two days ago with a 60-minute timeout: not rejected, it expires 60 minutes after the upgrade.
    expect(legacy.status).toBe("pending");
    expect(Date.parse(legacy.expiresAt!)).toBe(upgradedAt.getTime() + 60 * 60_000);
    expect(Date.parse(recent.expiresAt!)).toBe(Date.parse(pausedAfter) + 60 * 60_000);
    expect((await second.store.getWorkflowExecutionState(before.executionId!))?.status).toBe("waiting_approval");
  });
});

describe("who may see and decide", () => {
  it("filters the inbox by project before the limit", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const member = await login(context, "builder", "member");
    await context.store.upsertProject({ id: "busy", name: "Busy" });
    await context.store.upsertCustomRole({ id: "none-busy", projectId: "busy", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: member.id, projectId: "busy", role: "custom", customRoleId: "none-busy" });
    const run = await startRun(context, gateWorkflow("wf-mine", { ...GATE, approverRoles: [] }), requester.cookie);
    const now = Date.now();
    const sql = testSql(context.store);
    for (let index = 0; index < 900; index += 1) {
      const at = new Date(now + 60_000 + index).toISOString();
      await sql.run(
        "INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at) VALUES (?, ?, 'wf-busy', 'busy', 'gate', 'approval_gate', 'pending', '{}', ?, ?)",
        `apr_busy_${index}`, `exec-busy-${index}`, at, at
      );
    }
    const items = await inbox(context, member.cookie, "?limit=200");
    expect(items.map((entry) => entry.executionId)).toEqual([run.executionId]);
  });

  it("answers 404 for another project's run before saying anything about its state", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    await context.store.upsertProject({ id: "secret-team", name: "Secret" });
    await context.store.upsertCustomRole({ id: "none-secret", projectId: "secret-team", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "secret-team", role: "custom", customRoleId: "none-secret" });
    const run = await startRun(context, gateWorkflow("wf-hidden", GATE, "secret-team"), requester.cookie);
    await testSql(context.store).run("DELETE FROM approval_requests WHERE execution_id = ?", run.executionId);
    await testSql(context.store).run("UPDATE workflow_executions SET status = 'resuming' WHERE id = ?", run.executionId);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    await testSql(context.store).run("UPDATE workflow_executions SET status = 'waiting_approval' WHERE id = ?", run.executionId);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    // Nothing was written for the outsider's attempt.
    expect(await context.store.listApprovalRequestsForExecution(run.executionId!)).toEqual([]);
  });

  it("applies self-approval to the requester's API key and re-checks role and project at decision time", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-key", GATE), requester.cookie);
    const created = (await call(context, "POST", "/api/auth/api-keys", requester.cookie, { name: "ci" })).json<{ key: string }>();
    const viaKey = await context.app.inject({ method: "POST", url: `/api/approvals/${run.executionId}/approve`, headers: { authorization: `Bearer ${created.key}` }, payload: {} });
    expect(viaKey.statusCode).toBe(403);
    expect(viaKey.json<{ error: string }>().error).toMatch(/own run/);

    // Demoted after the request: no longer one of the gate's roles.
    await context.store.updateUserRole(lead.id, "operator");
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(403);
    await context.store.updateUserRole(lead.id, "builder");
    // Removed from the project: the run is no longer visible.
    await context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
    await context.store.upsertProjectRole({ userId: lead.id, projectId: "default", role: "custom", customRoleId: "none-default" });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(404);
    await context.store.removeProjectRole(lead.id, "default");
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).json<RunResult>().status).toBe("success");
  });

  it("tells the editor when nobody but the requester could approve", async () => {
    const context = await createTestContext();
    const solo = await login(context, "admin", "solo");
    const check = (payload: Record<string, unknown>) => call(context, "POST", "/api/approvals/eligibility", solo.cookie, { workflowId: "wf-unsaved", ...payload });
    // Alone on the instance, with self-approval off: nobody can approve.
    expect((await check({})).json()).toEqual({ othersCanApprove: false, requesterCanApprove: false });
    expect((await check({ allowSelfApproval: true })).json()).toEqual({ othersCanApprove: false, requesterCanApprove: true });
    await login(context, "operator", "colleague");
    expect((await check({})).json()).toEqual({ othersCanApprove: true, requesterCanApprove: false });
    // Only admins listed: the operator does not count.
    expect((await check({ approverRoles: ["admin"] })).json()).toMatchObject({ othersCanApprove: false });
    const viewer = await login(context, "viewer", "watcher");
    expect((await call(context, "POST", "/api/approvals/eligibility", viewer.cookie, { workflowId: "wf-unsaved" })).statusCode).toBe(403);
  });

  it("answers the same for an existing and a missing approver account when the caller cannot see the project's accounts", async () => {
    const context = await createTestContext();
    await login(context, "admin", "root");
    const colleague = await login(context, "operator", "colleague");
    const editor = await login(context, "builder", "editor");
    const reader = await login(context, "builder", "reader");
    await context.store.upsertCustomRole({ id: "editor-only", projectId: "default", name: "Editor", permissions: ["workflow:read", "workflow:write", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: editor.id, projectId: "default", role: "custom", customRoleId: "editor-only" });
    await context.store.upsertCustomRole({ id: "read-only", projectId: "default", name: "Reader", permissions: ["workflow:read", "workflow:execute"] });
    await context.store.upsertProjectRole({ userId: reader.id, projectId: "default", role: "custom", customRoleId: "read-only" });
    const probe = (cookie: string, email: string, extra: Record<string, unknown> = {}) =>
      call(context, "POST", "/api/approvals/eligibility", cookie, { workflowId: "wf-unsaved", approverUsers: [email], approverRoles: [], ...extra });
    const existing = await probe(editor.cookie, colleague.email);
    const missing = await probe(editor.cookie, "nobody@example.com");
    expect(existing.body).toContain("othersCanApprove");
    expect(existing.json()).toEqual(missing.json());
    // Admins are not revealed through roles either.
    expect((await call(context, "POST", "/api/approvals/eligibility", editor.cookie, { workflowId: "wf-unsaved", approverRoles: ["admin"], approverUsers: [] })).json()).toMatchObject({ othersCanApprove: false });
    // Read access is not enough to ask.
    expect((await probe(reader.cookie, colleague.email)).statusCode).toBe(403);
  });

  it("requires execute access on every project along a sub-workflow path, two levels deep", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    await context.store.upsertProject({ id: "child-team", name: "Child team" });
    const child = {
      id: "wf-deep-child",
      name: "Deep child",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "child-team",
      nodes: [node("start", "manual_trigger"), node("gate", "approval_gate", { message: "Deep gate", approverUsers: [lead.email] }), node("out", "output", { responseTemplate: "deep done" })],
      edges: [{ id: "c1", source: "start", target: "gate" }, { id: "c2", source: "gate", sourceHandle: "approved", target: "out" }]
    } as Workflow;
    const middle = {
      id: "wf-deep-middle",
      name: "Middle",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "child-team",
      nodes: [node("start", "manual_trigger"), node("call", "execute_workflow", { workflowId: child.id }), node("out", "output", { responseTemplate: "middle got {{result}}" })],
      edges: [{ id: "m1", source: "start", target: "call" }, { id: "m2", source: "call", target: "out" }]
    } as Workflow;
    const parent = {
      id: "wf-deep-parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("hook", "webhook_input", { path: "hook-deep", method: "POST" }), node("call", "execute_workflow", { workflowId: middle.id }), node("out", "output", { responseTemplate: "parent got {{result}}" })],
      edges: [{ id: "p1", source: "hook", target: "call" }, { id: "p2", source: "call", target: "out" }]
    } as Workflow;
    await context.store.upsertWorkflow(child);
    await context.store.upsertWorkflow(middle);
    // A run may call another project's workflow only through an execute share;
    // the middle reaches the child inside its own project.
    await context.store.upsertWorkflowShare({ workflowId: middle.id, projectId: "default", accessLevel: "execute" });
    const run = await startRun(context, parent, requester.cookie);
    // Read-only on the child's project: the request shows, but the lead may not decide it.
    await context.store.upsertCustomRole({ id: "read-child", projectId: "child-team", name: "Read", permissions: ["workflow:read"] });
    await context.store.upsertProjectRole({ userId: lead.id, projectId: "child-team", role: "custom", customRoleId: "read-child" });
    const [item] = await inbox(context, lead.cookie);
    expect(item).toMatchObject({ nodeId: "gate", path: [{ workflowId: parent.id, nodeId: "call" }, { workflowId: middle.id, nodeId: "call" }], canDecide: false });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(403);
    await context.store.removeProjectRole(lead.id, "child-team");
    const approved = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).json<RunResult>();
    expect(approved.status).toBe("success");
    expect(approved.nodeResults.find((entry) => entry.nodeId === "out")?.output?.result).toBe("parent got middle got deep done");
  });
});

describe("project authorization (run-access)", () => {
  const lockOut = async (context: TestContext, userId: string, projectId: string, permissions: string[]) => {
    const roleId = `${projectId}-${permissions.join("-") || "none"}`;
    await context.store.upsertCustomRole({ id: roleId, projectId, name: roleId, permissions });
    await context.store.upsertProjectRole({ userId, projectId, role: "custom", customRoleId: roleId });
  };

  it("answers 404 for another project's requests and 403 for a read-only one on the inbox, the run lookup, approve, reject and approve with edits", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    await context.store.upsertProject({ id: "hidden", name: "Hidden" });
    await context.store.upsertProject({ id: "ro", name: "Read only" });
    await lockOut(context, outsider.id, "hidden", []);
    await lockOut(context, outsider.id, "ro", ["workflow:read"]);
    const hidden = await startRun(context, gateWorkflow("wf-authz-hidden", GATE, "hidden"), requester.cookie);
    const readOnly = await startRun(context, gateWorkflow("wf-authz-ro", GATE, "ro"), requester.cookie);

    const listed = await inbox(context, outsider.cookie, "?status=all");
    expect(listed.map((item) => item.workflowId)).toEqual(["wf-authz-ro"]);
    expect(listed[0]).toMatchObject({ canDecide: false });
    expect((await call(context, "GET", "/api/approvals?workflowId=wf-authz-hidden", outsider.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/approvals?executionId=${hidden.executionId}`, outsider.cookie)).statusCode).toBe(404);
    // A missing run answers exactly like a hidden one.
    const missing = await call(context, "GET", "/api/approvals?executionId=no-such-run", outsider.cookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual((await call(context, "GET", `/api/approvals?executionId=${hidden.executionId}`, outsider.cookie)).json());
    expect(await inbox(context, outsider.cookie, "?workflowId=wf-authz-ro")).toHaveLength(1);
    expect(await inbox(context, outsider.cookie, `?executionId=${readOnly.executionId}`)).toHaveLength(1);

    const attempts = [
      ["approve", {}],
      ["reject", { reason: "no" }],
      ["approve", { edits: { reply: "Edited by an outsider" }, reason: "edited" }]
    ] as const;
    for (const [decision, body] of attempts) {
      expect((await call(context, "POST", `/api/approvals/${hidden.executionId}/${decision}`, outsider.cookie, body)).statusCode).toBe(404);
      expect((await call(context, "POST", `/api/approvals/${readOnly.executionId}/${decision}`, outsider.cookie, body)).statusCode).toBe(403);
    }
    for (const run of [hidden, readOnly]) {
      expect((await context.store.getWorkflowExecutionState(run.executionId!))!.status).toBe("waiting_approval");
      expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).map((entry) => entry.status)).toEqual(["pending"]);
    }
    const audits = (await context.store.listAuditLogs({ category: "approval", pageSize: 100 })).items.filter((entry) => entry.eventType === "approval.decided");
    expect(audits.every((entry) => entry.outcome === "denied")).toBe(true);
    // Nothing is recorded for the hidden run: it answered as if it did not exist.
    expect(audits.some((entry) => entry.resourceId === "wf-authz-hidden")).toBe(false);
  });

  it("follows the workflow's current project, and a deleted workflow's requests are admin-only", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    await context.store.upsertProject({ id: "moved-to", name: "Moved to" });
    await lockOut(context, lead.id, "moved-to", []);
    const workflow = gateWorkflow("wf-moves", GATE);
    const run = await startRun(context, workflow, requester.cookie);
    expect(await inbox(context, lead.cookie)).toHaveLength(1);
    // Moved after the pause: the stored request still says "default", but access follows the workflow.
    await context.store.upsertWorkflow({ ...workflow, projectId: "moved-to" });
    expect(await inbox(context, lead.cookie)).toEqual([]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(404);

    const gone = await startRun(context, gateWorkflow("wf-gone", GATE), requester.cookie);
    // Only the workflow row goes (deleting through the store also clears its runs).
    await testSql(context.store).run("DELETE FROM workflows WHERE id = ?", "wf-gone");
    expect((await inbox(context, lead.cookie)).map((item) => item.workflowId)).not.toContain("wf-gone");
    expect((await call(context, "POST", `/api/approvals/${gone.executionId}/approve`, lead.cookie, {})).statusCode).toBe(404);
    const admin = await login(context, "admin");
    expect((await inbox(context, admin.cookie)).map((item) => item.workflowId)).toContain("wf-gone");
  });

  it("strict isolation: only members of the workflow's project see and decide its requests", async () => {
    const context = await createTestContext({ overrides: { PROJECT_ISOLATION: "strict" } });
    const requester = await login(context, "builder", "requester");
    const member = await login(context, "builder", "member");
    const outsider = await login(context, "builder", "outsider");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProject({ id: "other", name: "Other" });
    await context.store.upsertProjectRole({ userId: requester.id, projectId: "team", role: "editor" });
    await context.store.upsertProjectRole({ userId: member.id, projectId: "team", role: "editor" });
    // A member elsewhere: in strict isolation a global role alone reaches no project.
    await context.store.upsertProjectRole({ userId: outsider.id, projectId: "other", role: "editor" });
    const run = await startRun(context, gateWorkflow("wf-strict", GATE, "team"), requester.cookie);
    expect(await inbox(context, outsider.cookie)).toEqual([]);
    expect((await call(context, "GET", "/api/approvals?workflowId=wf-strict", outsider.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/approvals/eligibility", outsider.cookie, { workflowId: "wf-strict", approverRoles: ["builder"] })).statusCode).toBe(404);
    expect((await inbox(context, member.cookie)).map((item) => item.workflowId)).toEqual(["wf-strict"]);
    const approved = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, member.cookie, { edits: { reply: "ok" } })).json<RunResult>();
    expect(approved.status).toBe("success");
  });

  it("resumes in the workflow's project scope: an approved run cannot use another project's secret, even when an admin approves", async () => {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(String(request.headers.authorization ?? ""));
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const context = await createTestContext();
      const requester = await login(context, "builder", "requester");
      const admin = await login(context, "admin");
      await context.store.upsertProject({ id: "vault", name: "Vault" });
      const vaultSecret = (await context.secretService.createSecret({ name: "vault", provider: "custom", value: "vault-token", projectId: "vault" })).secretId;
      const withCall = (id: string): Workflow => {
        const workflow = gateWorkflow(id, { ...GATE, editableFields: [] });
        workflow.nodes.push(node("call", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/`, secretRef: { secretId: vaultSecret } }));
        workflow.edges = workflow.edges.map((edge) => (edge.id === "e3" ? { ...edge, target: "call" } : edge));
        workflow.edges.push({ id: "e6", source: "call", target: "sent" });
        return workflow;
      };
      // Stored directly, as an older or imported definition would be: the save check is not what stops it.
      const run = await startRun(context, withCall("wf-vault"), requester.cookie);
      const refused = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, admin.cookie, {})).json<RunResult>();
      expect(refused).toMatchObject({ status: "error", error: expect.stringContaining("belongs to another project") });
      expect(seen).toEqual([]);

      // Shared to the workflow's project: the approved run may use it.
      expect((await call(context, "POST", `/api/secrets/${vaultSecret}/shares`, admin.cookie, { projectId: "default" })).statusCode).toBe(200);
      const next = await startRun(context, withCall("wf-vault-shared"), requester.cookie);
      expect((await call(context, "POST", `/api/approvals/${next.executionId}/approve`, admin.cookie, {})).json<RunResult>().status).toBe("success");
      expect(seen).toEqual(["Bearer vault-token"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a decision by an approver who lost project access after the request, and a queued resume whose approver lost it before it ran", async () => {
    const context = await createTestContext({ queue: true });
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-revoked", GATE), requester.cookie);
    // Read-only now: still visible, no longer decidable.
    await lockOut(context, lead.id, "default", ["workflow:read"]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, { reason: "no" })).statusCode).toBe(403);
    expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).map((entry) => entry.status)).toEqual(["pending"]);
    await context.store.removeProjectRole(lead.id, "default");

    // Decided while allowed, then locked out before the queue ran the resume.
    context.queue!.stop();
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { edits: { reply: "ok" } })).statusCode).toBe(202);
    await lockOut(context, lead.id, "default", []);
    context.queue!.start();
    await waitFor(async () => (await context.store.listAuditLogs({ category: "approval", pageSize: 100 })).items.find((entry) => entry.eventType === "approval.resume_refused"));
    await waitFor(async () => (await context.store.getWorkflowExecutionState(run.executionId!))?.status === "waiting_approval");
    expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).at(-1)!.status).toBe("pending");
    expect((await context.store.getExecutionHistory(run.executionId!))?.status).not.toBe("success");

    // Someone who may still decide it can.
    await context.store.removeProjectRole(lead.id, "default");
    const other = await login(context, "builder", "other");
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, other.cookie, { edits: { reply: "ok" } })).statusCode).toBe(202);
    await waitFor(async () => (await context.store.getExecutionHistory(run.executionId!))?.status === "success");
  });
});

describe("who a resume runs as, and what it re-checks", () => {
  const expireNow = async (context: TestContext, executionId: string) => {
    await testSql(context.store).run("UPDATE approval_requests SET expires_at = ? WHERE execution_id = ?", new Date(Date.now() - 1_000).toISOString(), executionId);
    // A decision past the expiry answers 409 and starts a sweep, which resumes the run with the timeout.
    const lead = await login(context, "admin", "sweeper");
    expect((await call(context, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {})).statusCode).toBe(409);
  };
  const waitForEnd = (context: TestContext, executionId: string) =>
    waitFor(async () => {
      const entry = await context.store.getExecutionHistory(executionId);
      return entry && entry.status !== "waiting_approval" && entry.status !== "running" ? entry : null;
    });
  const nodeStatus = (entry: { nodeResults: unknown }, id: string) => (entry.nodeResults as Array<{ nodeId: string; status: string }>).find((result) => result.nodeId === id)?.status;
  const refusals = async (context: TestContext) => (await context.store.listAuditLogs({ category: "approval", pageSize: 100 })).items.filter((entry) => entry.eventType === "approval.resume_refused");

  /** A gate whose timeout branch calls a project secret, with a server that records what it receives. */
  async function withSecretServer(run: (setup: { port: number; seen: string[] }) => Promise<void>) {
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(String(request.headers.authorization ?? ""));
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run({ port: (server.address() as { port: number }).port, seen });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  const fallbackCalls = (id: string, port: number, secretId: string): Workflow => {
    const workflow = gateWorkflow(id, { ...GATE, editableFields: [] });
    workflow.nodes.push(node("call", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/`, secretRef: { secretId } }));
    workflow.edges = workflow.edges.map((edge) => (edge.id === "e5" ? { ...edge, target: "call" } : edge));
    workflow.edges.push({ id: "e6", source: "call", target: "late" });
    return workflow;
  };

  it("a timeout resumes as the person who started the run: without secret:use the fallback branch cannot use a secret", async () => {
    await withSecretServer(async ({ port, seen }) => {
      const context = await createTestContext();
      const limited = await login(context, "builder", "limited");
      await context.store.upsertCustomRole({ id: "runner", projectId: "default", name: "runner", permissions: ["workflow:read", "workflow:execute"] });
      await context.store.upsertProjectRole({ userId: limited.id, projectId: "default", role: "custom", customRoleId: "runner" });
      const secretId = (await context.secretService.createSecret({ name: "token", provider: "custom", value: "project-token", projectId: "default" })).secretId;
      const run = await startRun(context, fallbackCalls("wf-timeout-actor", port, secretId), limited.cookie);
      expect((await context.store.listApprovalRequestsForExecution(run.executionId!))[0]).toMatchObject({ requestedByUserId: limited.id, requestedBy: limited.email });
      await expireNow(context, run.executionId!);
      const entry = await waitForEnd(context, run.executionId!);
      expect(entry.status).toBe("error");
      expect(nodeStatus(entry, "call")).toBe("error");
      expect(entry.error ?? JSON.stringify(entry.nodeResults)).toContain("secret:use");
      expect(seen).toEqual([]);
    });
  });

  it("a timeout of a run a trigger started still goes to the fallback, with no user", async () => {
    await withSecretServer(async ({ port, seen }) => {
      const context = await createTestContext();
      const secretId = (await context.secretService.createSecret({ name: "token", provider: "custom", value: "project-token", projectId: "default" })).secretId;
      const workflow = fallbackCalls("wf-timeout-trigger", port, secretId);
      await context.store.upsertWorkflow(workflow);
      const started = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-timeout-trigger", payload: { user_prompt: "Ana" } });
      expect(started.json<{ output: { waitingForApproval: boolean } }>().output.waitingForApproval).toBe(true);
      const executionId = (await testSql(context.store).get<{ id: string }>("SELECT id FROM workflow_executions WHERE workflow_id = ?", "wf-timeout-trigger"))!.id;
      expect((await context.store.getWorkflowExecutionState(executionId))?.status).toBe("waiting_approval");
      expect((await context.store.listApprovalRequestsForExecution(executionId))[0]).toMatchObject({ requestedByUserId: null });
      await expireNow(context, executionId);
      const entry = await waitForEnd(context, executionId);
      expect(entry.status).toBe("success");
      expect(nodeStatus(entry, "call")).toBe("success");
      expect(seen).toEqual(["Bearer project-token"]);
      expect(await refusals(context)).toEqual([]);
    });
  });

  it("a timeout fails closed when the person who started the run is gone: no branch runs, and it is audited", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const run = await startRun(context, gateWorkflow("wf-timeout-gone", GATE), requester.cookie);
    await context.store.deleteUser(requester.id);
    await expireNow(context, run.executionId!);
    const entry = await waitForEnd(context, run.executionId!);
    expect(entry.status).toBe("error");
    expect(entry.error).toMatch(/no longer run this workflow/);
    expect(nodeStatus(entry, "late")).not.toBe("success");
    expect(nodeStatus(entry, "stopped")).not.toBe("success");
    // The paused state is removed just after the final history is written (a second round trip on Postgres).
    await waitFor(async () => (await context.store.getWorkflowExecutionState(run.executionId!)) === null);
    expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).map((request) => request.status)).toEqual(["timed_out"]);
    expect(await refusals(context)).toEqual([expect.objectContaining({ outcome: "denied", metadata: expect.objectContaining({ reason: "user_not_found" }) })]);
  });

  it("a timeout fails closed when the person who started the run lost execute access", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const run = await startRun(context, gateWorkflow("wf-timeout-revoked", GATE), requester.cookie);
    await context.store.upsertCustomRole({ id: "reader", projectId: "default", name: "reader", permissions: ["workflow:read"] });
    await context.store.upsertProjectRole({ userId: requester.id, projectId: "default", role: "custom", customRoleId: "reader" });
    await expireNow(context, run.executionId!);
    const entry = await waitForEnd(context, run.executionId!);
    expect(entry.status).toBe("error");
    expect(nodeStatus(entry, "late")).not.toBe("success");
    expect(await refusals(context)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ reason: "no_execute_permission" }) })]);
  });

  describe("a queued resume re-checks the decider like a decision", () => {
    const decideThenChange = async (change: (context: TestContext, approver: { id: string; email: string }) => unknown, spec: Record<string, unknown> = { approverRoles: ["admin"] }) => {
      const context = await createTestContext({ queue: true });
      const requester = await login(context, "builder", "requester");
      const approver = await login(context, "admin", "boss");
      const run = await startRun(context, gateWorkflow("wf-recheck", { ...GATE, ...spec }), requester.cookie);
      context.queue!.stop();
      expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, approver.cookie, { edits: { reply: "ok" } })).statusCode).toBe(202);
      await change(context, approver);
      context.queue!.start();
      await waitFor(async () => (await refusals(context))[0]);
      await waitFor(async () => (await context.store.getWorkflowExecutionState(run.executionId!))?.status === "waiting_approval");
      expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).at(-1)!.status).toBe("pending");
      expect((await context.store.getExecutionHistory(run.executionId!))?.status).not.toBe("success");
      return { context, run, reasons: (await refusals(context)).map((entry) => (entry.metadata as { reason?: string }).reason) };
    };

    it("refuses an approver demoted below the gate's approver roles", async () => {
      const { reasons } = await decideThenChange(async (context, approver) => await context.store.updateUserRole(approver.id, "operator"));
      expect(reasons).toEqual(["not_an_approver"]);
    });

    it("refuses a decider who was deleted", async () => {
      const { reasons } = await decideThenChange(async (context, approver) => await context.store.deleteUser(approver.id));
      expect(reasons).toEqual(["user_not_found"]);
    });

    it("refuses a decider replaced by a new account with the same email", async () => {
      const { reasons } = await decideThenChange(async (context, approver) => {
        await context.store.deleteUser(approver.id);
        await context.authService.register({ email: approver.email, password: "boss-Pass-123!", role: "admin" });
      });
      expect(reasons).toEqual(["user_not_found"]);
    });
  });
});

describe("approvals after a workflow is deleted or moved", () => {
  it("keeps a deleted workflow's requests admin-only, also when another project reuses the id", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const admin = await login(context, "admin");
    const newcomer = await login(context, "builder", "newcomer");
    await context.store.upsertProject({ id: "other", name: "Other" });
    await context.store.upsertProjectRole({ userId: newcomer.id, projectId: "other", role: "editor" });
    const run = await startRun(context, gateWorkflow("wf-reused", GATE), requester.cookie);
    const decided = await startRun(context, gateWorkflow("wf-reused", GATE), requester.cookie);
    expect((await call(context, "POST", `/api/approvals/${decided.executionId}/approve`, admin.cookie, { edits: { reply: "ok" } })).statusCode).toBe(200);
    expect((await call(context, "DELETE", "/api/workflows/wf-reused", admin.cookie)).statusCode).toBe(200);
    expect((await context.store.listApprovalRequestsForExecution(run.executionId!)).map((request) => request.workflowDeletedAt !== null)).toEqual([true]);

    await context.store.upsertWorkflow(gateWorkflow("wf-reused", GATE, "other"));
    expect(await inbox(context, newcomer.cookie, "?status=all")).toEqual([]);
    expect(await inbox(context, newcomer.cookie, "?workflowId=wf-reused&status=all")).toEqual([]);
    expect((await inbox(context, admin.cookie, "?status=all")).map((item) => item.executionId).sort()).toEqual([run.executionId, decided.executionId].sort());
  });

  it("tags inbox items and approval audit events with the workflow's current project", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const admin = await login(context, "admin");
    await context.store.upsertProject({ id: "moved-to", name: "Moved to" });
    const workflow = gateWorkflow("wf-moved-audit", GATE);
    const run = await startRun(context, workflow, requester.cookie);
    expect((await context.store.listAuditLogs({ category: "approval", pageSize: 20 })).items.find((entry) => entry.eventType === "approval.requested")?.projectId).toBe("default");
    await context.store.upsertWorkflow({ ...workflow, projectId: "moved-to" });
    expect((await inbox(context, admin.cookie))[0]).toMatchObject({ projectId: "moved-to" });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, admin.cookie, { edits: { reply: "ok" } })).statusCode).toBe(200);
    expect((await context.store.listAuditLogs({ category: "approval", pageSize: 20 })).items.find((entry) => entry.eventType === "approval.decided")?.projectId).toBe("moved-to");
  });
});

describe("what approvals record and send", () => {
  it("keeps edited values out of notifications, masks secrets, redacts the reason in the manifest and matches the audit digest", async () => {
    const overrides = { NOTIFICATIONS_ENABLED: "true", NOTIFICATION_SLACK_WEBHOOK_URL: "https://hooks.example.test/slack" };
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://hooks.example.test/")) {
        posts.push(String(init?.body ?? ""));
        return new Response("ok");
      }
      return realFetch(input as string, init);
    });
    const context = await createTestContext({ overrides });
    const secretValue = "sk-ApprovalsTestValue0123456789";
    await context.secretService.createSecret({ name: "token", provider: "openai", value: secretValue });
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-sends", { ...GATE, message: `Send '{{reply}}' with ${secretValue}?` }), requester.cookie);
    await waitFor(() => posts.find((body) => body.includes("Approval needed")));
    expect(posts.join("\n")).not.toContain(secretValue);

    const approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { edits: { reply: "Edited words" }, reason: `ok ${secretValue}` });
    expect(approved.json<RunResult>().status).toBe("success");
    expect(posts.join("\n")).not.toContain("Edited words");

    const admin = await login(context, "admin");
    const manifest = (await call(context, "GET", `/api/executions/${run.executionId}/manifest`, admin.cookie)).json<{ manifest: Record<string, any> }>().manifest;
    const [request] = manifest.extensions.approvals.requests;
    expect(request.reason).not.toContain(secretValue);
    const stored = (await context.store.listApprovalRequestsForExecution(run.executionId!))[0]!;
    expect(request.editsDigest).toBe(approvalEditsDigest(stored.editsSalt, stored.edits));
    const decided = (await context.store.listAuditLogs({ category: "approval", pageSize: 20 })).items.find((entry) => entry.eventType === "approval.decided" && entry.outcome === "success")!;
    expect((decided.metadata as Record<string, unknown>).editsDigest).toBe(request.editsDigest);
    // Keyed with the request's own salt: a plain hash of the edits does not match.
    expect(request.editsDigest).not.toBe(crypto.createHash("sha256").update(JSON.stringify(stored.edits)).digest("hex"));
  });

  it("escapes Teams Markdown so run input cannot add links", () => {
    expect(escapeTeams("see [click](https://phish) *now* _x_ `y`")).toBe("see \\[click\\]\\(https://phish\\) \\*now\\* \\_x\\_ \\`y\\`");
    expect(escapeTeams("<b>a</b> & c")).toBe("&lt;b&gt;a&lt;/b&gt; &amp; c");
  });

  it("validates APP_PUBLIC_URL", () => {
    const base = { SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" };
    expect(parseConfig({ ...base, APP_PUBLIC_URL: "https://l2m.example.test" }).APP_PUBLIC_URL).toBe("https://l2m.example.test");
    expect(() => parseConfig({ ...base, APP_PUBLIC_URL: "javascript:alert(1)" })).toThrow();
    expect(() => parseConfig({ ...base, APP_PUBLIC_URL: "l2m.example.test" })).toThrow();
  });
});
