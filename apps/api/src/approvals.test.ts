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
import { ApprovalResumeRunner } from "./services/approval-service.js";
import { approvalEditsDigest } from "./services/approval-digest.js";
import { escapeTeams } from "./services/notification-service.js";
import { registerApprovalRoutes } from "./approval-routes.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import Fastify from "fastify";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
  secretService: SecretService;
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
  const context = { app, store, authService, config, tempDir, dbPath, secretService, ...(queue ? { queue } : {}) };
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
      "idx_approval_requests_status_expires",
      "CREATE TABLE IF NOT EXISTS schema_markers",
      "INSERT INTO schema_markers"
    ]) {
      expect(migration.up).toContain(fragment);
    }
    expect(migration.down).toContain("DROP TABLE IF EXISTS approval_requests");
    expect(migration.down).toContain("DROP TABLE IF EXISTS schema_markers");
    const context = await createTestContext();
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const columns = (db.prepare("PRAGMA table_info(approval_requests)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["id", "execution_id", "project_id", "kind", "status", "spec_json", "requested_by_user_id", "expires_at", "decided_by", "reason", "edits_json", "edited_fields_json", "asking_workflow_id", "edits_salt"])
      );
      expect(db.prepare("SELECT name FROM schema_markers").all()).toEqual([{ name: "approval_requests" }]);
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

const rawDb = (context: TestContext) => (context.store as unknown as { db: Database.Database }).db;

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
    context.store.upsertWorkflow(wf);
    const skipped = (await call(context, "POST", `/api/workflows/${wf.id}/execute`, builder.cookie, { startNodeId: "x" })).json<RunResult>();
    expect(skipped.status).toBe("error");
    expect(skipped.error).toContain("Approval Gate 'gate'");
    expect(skipped.nodeResults.find((entry) => entry.nodeId === "send")).toBeUndefined();
    expect(context.store.listApprovalRequestsForExecution(skipped.executionId ?? "none")).toEqual([]);
  });

  it("refuses execute and retry that start after the gate, ignores a pinned gate output, and refuses pinning a gate", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const lead = await login(context, "builder", "lead");
    const wf = rejectFailsWorkflow("wf-skip");
    context.store.upsertWorkflow(wf);
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
    expect(context.store.getWorkflow(wf.id)?.pinnedData).toBeUndefined();

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
    expect(context.store.getWorkflowExecutionState(run.executionId!)?.status).toBe("waiting_approval");
    expect(context.store.getApprovalRequest(item!.requestId)).toMatchObject({ status: "pending", decidedBy: null, expiresAt: item!.expiresAt });

    const again = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId });
    expect(again.statusCode).toBe(202);
    // The queued resume carries the run timeout, so the stuck-job check follows it.
    const queued = rawDb(context).prepare("SELECT payload_json FROM execution_queue WHERE id LIKE ?").get(`${run.executionId}:${item!.requestId}:%`) as { payload_json: string };
    expect(JSON.parse(queued.payload_json).executionTimeoutMs).toBe(context.config.WORKFLOW_EXECUTION_TIMEOUT_MS);
    await waitFor(() => context.store.getExecutionHistory(run.executionId!)?.status === "success");
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
    await waitFor(() => (context.store.getApprovalRequest(item!.requestId)?.status === "pending" ? true : null));
    await waitFor(() => (context.store.getWorkflowExecutionState(run.executionId!)?.status === "waiting_approval" ? true : null));
    const second = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, { requestId: item!.requestId, edits: { reply: "second words" } });
    expect(second.statusCode).toBe(202);
    const history = await waitFor(() => {
      const entry = context.store.getExecutionHistory(run.executionId!);
      return entry && entry.status === "success" ? entry : null;
    });
    const sent = (history.nodeResults as Array<{ nodeId: string; output?: Record<string, any> }>).find((entry) => entry.nodeId === "sent");
    expect(JSON.stringify(sent?.output)).toContain("second words");
    expect(JSON.stringify(sent?.output)).not.toContain("first words");
    // One queue item per decision, neither retried by the queue itself.
    const rows = rawDb(context).prepare("SELECT id, max_attempts FROM execution_queue WHERE id LIKE ?").all(`${run.executionId}:${item!.requestId}:%`) as Array<{ id: string; max_attempts: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.max_attempts === 1)).toBe(true);
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
    expect(context.store.getWorkflowExecutionState(run.executionId!)?.status).toBe("waiting_approval");
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

      // The process stopped between the decision and its resume (no queue item either).
      const db = new Database(path.join(tempDir, "orchestrator.db"));
      db.prepare("UPDATE workflow_executions SET status = 'resuming' WHERE id = ?").run(run.executionId);
      db.prepare("UPDATE approval_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(lead.email, new Date().toISOString(), item!.requestId);
      db.close();

      const second = await createTestContext({ tempDir, queue });
      const history = await waitFor(() => {
        const entry = second.store.getExecutionHistory(run.executionId!);
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
    const db = new Database(path.join(tempDir, "orchestrator.db"));
    // An older decided request for another node, and the current one still pending.
    const old = db.prepare("SELECT * FROM approval_requests WHERE execution_id = ?").get(run.executionId) as Record<string, unknown>;
    db.prepare("UPDATE approval_requests SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), old.id);
    db.prepare(
      "INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, decided_by, created_at, updated_at) VALUES ('apr_old', ?, ?, 'default', 'earlier_gate', 'approval_gate', 'approved', '{}', 'someone', ?, ?)"
    ).run(run.executionId, "wf-stale", new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
    db.prepare("UPDATE workflow_executions SET status = 'resuming' WHERE id = ?").run(run.executionId);
    db.close();
    const second = await createTestContext({ tempDir });
    await waitFor(() => second.store.getWorkflowExecutionState(run.executionId!)?.status === "waiting_approval");
    expect(second.store.getExecutionHistory(run.executionId!)?.status).not.toBe("success");
  });
});

describe("expiry and the upgrade", () => {
  it("refuses a decision past the expiry and applies the timeout outcome", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const lead = await login(context, "builder", "lead");
    const run = await startRun(context, gateWorkflow("wf-expired", GATE), requester.cookie);
    rawDb(context).prepare("UPDATE approval_requests SET expires_at = ? WHERE execution_id = ?").run(new Date(Date.now() - 1_000).toISOString(), run.executionId);
    const late = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {});
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: string }>().error).toMatch(/expired/);
    const history = await waitFor(() => {
      const entry = context.store.getExecutionHistory(run.executionId!);
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
    const db = new Database(path.join(tempDir, "orchestrator.db"));
    // As if both runs were waiting when approval requests came up: no request rows, and the upgrade 30 minutes ago.
    db.prepare("DELETE FROM approval_requests").run();
    db.prepare("UPDATE schema_markers SET created_at = ? WHERE name = 'approval_requests'").run(upgradedAt.toISOString());
    db.prepare("UPDATE workflow_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * 86_400_000).toISOString(), new Date(Date.now() - 2 * 86_400_000).toISOString(), before.executionId);
    const pausedAfter = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare("UPDATE workflow_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(pausedAfter, pausedAfter, after.executionId);
    db.close();

    const second = await createTestContext({ tempDir });
    const reader = await login(second, "builder", "requester");
    const items = await inbox(second, reader.cookie);
    const legacy = items.find((entry) => entry.executionId === before.executionId)!;
    const recent = items.find((entry) => entry.executionId === after.executionId)!;
    // Paused two days ago with a 60-minute timeout: not rejected, it expires 60 minutes after the upgrade.
    expect(legacy.status).toBe("pending");
    expect(Date.parse(legacy.expiresAt!)).toBe(upgradedAt.getTime() + 60 * 60_000);
    expect(Date.parse(recent.expiresAt!)).toBe(Date.parse(pausedAfter) + 60 * 60_000);
    expect(second.store.getWorkflowExecutionState(before.executionId!)?.status).toBe("waiting_approval");
  });
});

describe("who may see and decide", () => {
  it("filters the inbox by project before the limit", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const member = await login(context, "builder", "member");
    context.store.upsertProject({ id: "busy", name: "Busy" });
    context.store.upsertCustomRole({ id: "none-busy", projectId: "busy", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: member.id, projectId: "busy", role: "custom", customRoleId: "none-busy" });
    const run = await startRun(context, gateWorkflow("wf-mine", { ...GATE, approverRoles: [] }), requester.cookie);
    const now = Date.now();
    const db = rawDb(context);
    const insert = db.prepare(
      "INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at) VALUES (?, ?, 'wf-busy', 'busy', 'gate', 'approval_gate', 'pending', '{}', ?, ?)"
    );
    db.transaction(() => {
      for (let index = 0; index < 900; index += 1) {
        const at = new Date(now + 60_000 + index).toISOString();
        insert.run(`apr_busy_${index}`, `exec-busy-${index}`, at, at);
      }
    })();
    const items = await inbox(context, member.cookie, "?limit=200");
    expect(items.map((entry) => entry.executionId)).toEqual([run.executionId]);
  });

  it("answers 404 for another project's run before saying anything about its state", async () => {
    const context = await createTestContext();
    const requester = await login(context, "builder", "requester");
    const outsider = await login(context, "builder", "outsider");
    context.store.upsertProject({ id: "secret-team", name: "Secret" });
    context.store.upsertCustomRole({ id: "none-secret", projectId: "secret-team", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: outsider.id, projectId: "secret-team", role: "custom", customRoleId: "none-secret" });
    const run = await startRun(context, gateWorkflow("wf-hidden", GATE, "secret-team"), requester.cookie);
    rawDb(context).prepare("DELETE FROM approval_requests WHERE execution_id = ?").run(run.executionId);
    rawDb(context).prepare("UPDATE workflow_executions SET status = 'resuming' WHERE id = ?").run(run.executionId);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    rawDb(context).prepare("UPDATE workflow_executions SET status = 'waiting_approval' WHERE id = ?").run(run.executionId);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, outsider.cookie, {})).statusCode).toBe(404);
    // Nothing was written for the outsider's attempt.
    expect(context.store.listApprovalRequestsForExecution(run.executionId!)).toEqual([]);
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
    context.store.updateUserRole(lead.id, "operator");
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(403);
    context.store.updateUserRole(lead.id, "builder");
    // Removed from the project: the run is no longer visible.
    context.store.upsertCustomRole({ id: "none-default", projectId: "default", name: "No access", permissions: [] });
    context.store.upsertProjectRole({ userId: lead.id, projectId: "default", role: "custom", customRoleId: "none-default" });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(404);
    context.store.removeProjectRole(lead.id, "default");
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
    context.store.upsertCustomRole({ id: "editor-only", projectId: "default", name: "Editor", permissions: ["workflow:read", "workflow:write", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: editor.id, projectId: "default", role: "custom", customRoleId: "editor-only" });
    context.store.upsertCustomRole({ id: "read-only", projectId: "default", name: "Reader", permissions: ["workflow:read", "workflow:execute"] });
    context.store.upsertProjectRole({ userId: reader.id, projectId: "default", role: "custom", customRoleId: "read-only" });
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
    context.store.upsertProject({ id: "child-team", name: "Child team" });
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
      projectId: "default",
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
    context.store.upsertWorkflow(child);
    context.store.upsertWorkflow(middle);
    const run = await startRun(context, parent, requester.cookie);
    // Read-only on the child's project: the request shows, but the lead may not decide it.
    context.store.upsertCustomRole({ id: "read-child", projectId: "child-team", name: "Read", permissions: ["workflow:read"] });
    context.store.upsertProjectRole({ userId: lead.id, projectId: "child-team", role: "custom", customRoleId: "read-child" });
    const [item] = await inbox(context, lead.cookie);
    expect(item).toMatchObject({ nodeId: "gate", path: [{ workflowId: parent.id, nodeId: "call" }, { workflowId: middle.id, nodeId: "call" }], canDecide: false });
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).statusCode).toBe(403);
    context.store.removeProjectRole(lead.id, "child-team");
    const approved = (await call(context, "POST", `/api/approvals/${run.executionId}/approve`, lead.cookie, {})).json<RunResult>();
    expect(approved.status).toBe("success");
    expect(approved.nodeResults.find((entry) => entry.nodeId === "out")?.output?.result).toBe("parent got middle got deep done");
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
    context.secretService.createSecret({ name: "token", provider: "openai", value: secretValue });
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
    const stored = context.store.listApprovalRequestsForExecution(run.executionId!)[0]!;
    expect(request.editsDigest).toBe(approvalEditsDigest(stored.editsSalt, stored.edits));
    const decided = context.store.listAuditLogs({ category: "approval", pageSize: 20 }).items.find((entry) => entry.eventType === "approval.decided" && entry.outcome === "success")!;
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

  it("answers 501 when the store has no approval requests", async () => {
    const app = Fastify();
    const user = { id: "u1", email: "u@example.com", role: "admin" as const };
    registerApprovalRoutes({ app, approvals: {} as never, available: false, loadWorkflow: () => null, canReadWorkflow: () => true, canUpdateWorkflow: () => true, canSeeProjectAccounts: () => true, requireRole: async () => user, dispatch: async () => null });
    await app.ready();
    const listed = await app.inject({ method: "GET", url: "/api/approvals" });
    expect(listed.statusCode).toBe(501);
    expect((await app.inject({ method: "POST", url: "/api/approvals/x/approve", payload: {} })).statusCode).toBe(501);
    await app.close();
  });
});
