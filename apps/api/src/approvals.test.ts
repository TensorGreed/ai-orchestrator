/**
 * Phase 11.2 — approval gates over the API: the inbox and its project
 * scoping, approvers and the self-approval rule, reasons and edits, one
 * decision per request, the timeout sweeper and startup expiry, audit
 * entries, notifications, sub-workflows, resumes on the execution queue,
 * the run manifest and migration 32.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ApprovalRequestView, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
  queue?: QueueService;
}

const contexts: TestContext[] = [];
const tempDirs: string[] = [];

async function createTestContext(options: { overrides?: Record<string, string>; tempDir?: string; queue?: boolean } = {}): Promise<TestContext> {
  const tempDir = options.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-"));
  if (!tempDirs.includes(tempDir)) tempDirs.push(tempDir);
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  store.ensureDefaultProject();
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
  const app = createApp(config, store, secretService, authService, undefined, queue);
  await app.ready();
  const context = { app, store, authService, config, tempDir, dbPath, ...(queue ? { queue } : {}) };
  contexts.push(context);
  return context;
}

async function closeContext(context: TestContext) {
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
  context.queue?.stop();
  await context.app.close();
  try {
    context.store.close();
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
  const existing = context.store.getUserByEmail(email);
  const id = existing ? existing.id : context.authService.register({ email, password, role }).id;
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
  context.store.upsertWorkflow(workflow);
  const run = (await call(context, "POST", `/api/workflows/${workflow.id}/execute`, cookie, { user_prompt: prompt })).json<RunResult>();
  expect(run.status).toBe("waiting_approval");
  return run;
}

const inbox = async (context: TestContext, cookie: string, query = "") =>
  (await call(context, "GET", `/api/approvals${query}`, cookie)).json<{ items: ApprovalRequestView[] }>().items;

const auditTypes = (context: TestContext) => context.store.listAuditLogs({ category: "approval", pageSize: 100 }).items.map((entry) => entry.eventType);

async function waitFor<T>(read: () => T | undefined | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("migration 32", () => {
  it("adds approval_requests in Postgres DDL with a down path, and the same table in SQLite", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 32)!;
    expect(migration.description).toContain("11.2");
    for (const fragment of ["CREATE TABLE IF NOT EXISTS approval_requests", "spec_json TEXT NOT NULL", "expires_at TIMESTAMPTZ", "idx_approval_requests_status_expires"]) {
      expect(migration.up).toContain(fragment);
    }
    expect(migration.down).toContain("DROP TABLE IF EXISTS approval_requests");
    const context = await createTestContext();
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const columns = (db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["id", "execution_id", "project_id", "kind", "status", "spec_json", "requested_by_user_id", "expires_at", "decided_by", "reason", "edits_json", "edited_fields_json"]));
    } finally {
      db.close();
    }
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
    expect(auditTypes(context)).toEqual(expect.arrayContaining(["approval.requested", "approval.decided"]));
    const denied = context.store.listAuditLogs({ category: "approval", outcome: "denied", pageSize: 10 }).items;
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
    const [first, second] = await Promise.all([
      call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, { reason: "Off-brand" }),
      call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.json<RunResult>().nodeResults.find((entry) => entry.nodeId === "stopped")?.status).toBe("success");
    expect([404, 409]).toContain(second.statusCode);
    const [decided] = await inbox(context, lead.cookie, "?status=all");
    expect(decided).toMatchObject({ status: "rejected", reason: "Off-brand" });
  });

  it("scopes the inbox and decisions to the workflow's project", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    context.store.upsertProject({ id: "team-a", name: "Team A" });
    context.store.upsertCustomRole({ id: "none-team-a", projectId: "team-a", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "team-a", role: "custom", customRoleId: "none-team-a" });
    const run = await startRun(context, gateWorkflow("wf-scoped", { ...GATE, approverRoles: [] }, "team-a"), requester.cookie);
    expect(await inbox(context, outsider.cookie)).toEqual([]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);

    // Read access without execute: the item shows, but cannot be decided.
    context.store.upsertCustomRole({ id: "read-team-a", projectId: "team-a", name: "Read", permissions: ["workflow:read"] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "team-a", role: "custom", customRoleId: "read-team-a" });
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
    expect(auditTypes(context)).toContain("approval.canceled");
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
    expect(requested).toContain("Send 'Hello Ana'?");
    expect(requested).toContain("https://l2m.example.test/?mode=approvals&request=apr_");
    await closeContext(first);

    // Past its expiry while the API was down.
    const db = new Database(path.join(tempDir, "orchestrator.db"));
    db.prepare("UPDATE approval_requests SET expires_at = ? WHERE execution_id = ?").run(new Date(Date.now() - 60_000).toISOString(), run.executionId);
    db.close();

    const second = await createTestContext({ tempDir, overrides });
    const history = await waitFor(() => {
      const entry = second.store.getExecutionHistory(run.executionId!);
      return entry && entry.status !== "waiting_approval" && entry.status !== "running" ? entry : null;
    });
    expect(history.status).toBe("success");
    const results = history.nodeResults as Array<{ nodeId: string; status: string; output?: Record<string, any> }>;
    expect(results.find((entry) => entry.nodeId === "gate")?.output?._branchHandle).toBe("timed_out");
    expect(results.find((entry) => entry.nodeId === "late")?.status).toBe("success");
    expect(auditTypes(second)).toContain("approval.timed_out");
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
    context.store.upsertWorkflow(child);
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
    const history = await waitFor(() => {
      const entry = context.store.getExecutionHistory(run.executionId!);
      return entry && entry.status === "success" ? entry : null;
    });
    expect((history.nodeResults as Array<{ nodeId: string; status: string }>).find((entry) => entry.nodeId === "sent")?.status).toBe("success");
    // A second decision after the queued one is refused.
    expect([404, 409]).toContain((await call(context, "POST", `/api/approvals/${run.executionId}/reject`, lead.cookie, { reason: "late" })).statusCode);
  });
});
