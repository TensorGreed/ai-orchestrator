/**
 * Project authorization on run endpoints: starting runs, reading and acting
 * on executions, approvals, the queue, golden runs and knowledge bases.
 *
 * Every route class gets a cross-project denial: a user locked out of the
 * workflow's project sees 404 (as if the run did not exist), a user who can
 * read the project but not run in it sees 403, and admins keep global access.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { createRunAccess } from "./run-access.js";
import { AuthService, type SafeUser } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-run-access-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  // A queue that never polls: enqueued jobs stay pending for the assertions.
  const queueService = new QueueService(store, { pollIntervalMs: 3_600_000 });
  const app = createApp(config, store, secretService, authService, undefined, queueService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** Locks a user out of a project: a membership whose custom role grants nothing. */
function lockOut(context: TestContext, userId: string, projectId: string) {
  context.store.upsertProject({ id: projectId, name: projectId });
  context.store.upsertCustomRole({ id: `none-${projectId}`, projectId, name: "No access", permissions: [] });
  context.store.upsertProjectRole({ userId, projectId, role: "custom", customRoleId: `none-${projectId}` });
}

/** Gives a user read-only access to a project. */
function readOnly(context: TestContext, userId: string, projectId: string) {
  context.store.upsertProject({ id: projectId, name: projectId });
  context.store.upsertProjectRole({ userId, projectId, role: "viewer" });
}

function simpleWorkflow(id: string, projectId: string, approval = false): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      ...(approval
        ? [{ id: "gate", type: "human_approval" as const, name: "Gate", position: { x: 200, y: 0 }, config: { approvalMessage: "ok?", timeoutMinutes: 60 } }]
        : []),
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: approval
      ? [
          { id: "e1", source: "start", target: "gate" },
          { id: "e2", source: "gate", target: "out" }
        ]
      : [{ id: "e1", source: "start", target: "out" }]
  };
}

function saveRun(context: TestContext, id: string, workflowId: string, status = "error") {
  const now = new Date().toISOString();
  context.store.saveExecutionHistory({
    id,
    workflowId,
    status,
    startedAt: now,
    completedAt: status === "running" ? undefined : now,
    inputJson: { secretInput: `input-of-${id}` },
    nodeResultsJson: []
  });
}

/**
 * Three workflows: one in the default project (everyone can use it), one in
 * "hidden" (the non-admins are locked out), one in "ro" (the non-admins can
 * read but not run). Each has a finished run.
 */
async function seed() {
  const context = await createTestContext();
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  const operator = await login(context, "operator");
  const viewer = await login(context, "viewer");
  for (const user of [builder, operator, viewer]) {
    lockOut(context, user.id, "hidden");
    readOnly(context, user.id, "ro");
  }
  context.store.upsertWorkflow(simpleWorkflow("wf-open", "default"));
  context.store.upsertWorkflow(simpleWorkflow("wf-hidden", "hidden"));
  context.store.upsertWorkflow(simpleWorkflow("wf-ro", "ro"));
  saveRun(context, "run-open", "wf-open");
  saveRun(context, "run-hidden", "wf-hidden");
  saveRun(context, "run-ro", "wf-ro");
  return { context, admin, builder, operator, viewer };
}

describe("run-access helper", () => {
  const user = (role: SafeUser["role"]): SafeUser => ({ id: `u-${role}`, email: `${role}@x`, role }) as SafeUser;
  const workflows: Record<string, Workflow> = {
    a: simpleWorkflow("a", "pa"),
    b: simpleWorkflow("b", "pb")
  };
  const access = createRunAccess({
    getWorkflow: (id) => workflows[id] ?? null,
    listWorkflows: () => Object.values(workflows),
    listProjectIds: () => ["pa", "pb"],
    // The user can read pa and pb, and run only in pa.
    canAccessWorkflow: (_user, workflow, permission) => workflow.projectId === "pa" || permission === "workflow:read",
    canInProject: (_user, projectId, permission) => projectId === "pa" || permission === "workflow:read"
  });

  it("answers 404 for unknown or unreadable workflows and 403 for readable ones without the permission", () => {
    expect(access.workflow(user("builder"), "missing", "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(access.workflow(user("builder"), "a", "workflow:execute")).toMatchObject({ ok: true });
    expect(access.workflow(user("builder"), "b", "workflow:read")).toMatchObject({ ok: true });
    expect(access.workflow(user("builder"), "b", "workflow:execute")).toMatchObject({ ok: false, status: 403 });
    const locked = createRunAccess({ ...accessDeps(), canAccessWorkflow: () => false, canInProject: () => false });
    expect(locked.workflow(user("builder"), "a", "workflow:execute")).toMatchObject({ ok: false, status: 404 });
    expect(locked.readableWorkflowIds(user("builder"))).toEqual([]);
    expect(locked.project(user("builder"), null, "workflow:read")).toMatchObject({ ok: false, status: 404 });
  });

  it("lets admins through everywhere, including runs of a deleted workflow", () => {
    const admin = user("admin");
    expect(access.run(admin, { id: "r", workflowId: "gone" }, "workflow:execute")).toMatchObject({ ok: true, workflow: null });
    expect(access.run(user("builder"), { id: "r", workflowId: "gone" }, "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(access.run(admin, null, "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(access.readableWorkflowIds(admin)).toBeNull();
    expect(access.readableProjectIds(admin)).toBeNull();
  });

  it("filters rows to readable workflows", () => {
    const locked = createRunAccess({ ...accessDeps(), canAccessWorkflow: (_user, workflow) => workflow.id === "a" });
    const rows = [{ workflowId: "a" }, { workflowId: "b" }, { workflowId: "gone" }];
    expect(locked.filterRuns(user("viewer"), rows)).toEqual([{ workflowId: "a" }]);
    expect(locked.filterRuns(user("admin"), rows)).toHaveLength(3);
  });

  function accessDeps() {
    return {
      getWorkflow: (id: string) => workflows[id] ?? null,
      listWorkflows: () => Object.values(workflows),
      listProjectIds: () => ["pa", "pb"],
      canAccessWorkflow: () => true,
      canInProject: () => true
    };
  }
});

describe("project authorization on run endpoints", () => {
  it("starting a run: execute, execute/stream, manual trigger and enqueue", async () => {
    const { context, admin, builder, operator } = await seed();
    for (const route of ["execute", "execute/stream"]) {
      expect((await call(context, "POST", `/api/workflows/wf-hidden/${route}`, builder.cookie, {})).statusCode).toBe(404);
      expect((await call(context, "POST", `/api/workflows/wf-ro/${route}`, builder.cookie, {})).statusCode).toBe(403);
    }
    expect((await call(context, "POST", "/api/workflows/wf-open/execute", builder.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/execute", admin.cookie, {})).statusCode).toBe(200);

    expect((await call(context, "POST", "/api/triggers/manual/wf-hidden", builder.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/triggers/manual/wf-ro", builder.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/triggers/manual/wf-open", builder.cookie, {})).statusCode).toBe(200);

    expect((await call(context, "POST", "/api/workflows/wf-hidden/enqueue", operator.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/wf-ro/enqueue", operator.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-open/enqueue", operator.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/enqueue", admin.cookie, {})).statusCode).toBe(200);
  });

  it("a run cannot reuse the inputs and outputs of a run the user cannot read", async () => {
    const { context, builder } = await seed();
    const response = await call(context, "POST", "/api/workflows/wf-open/execute", builder.cookie, { sourceExecutionId: "run-hidden" });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("input-of-run-hidden");
    expect((await call(context, "POST", "/api/workflows/wf-open/execute", builder.cookie, { sourceExecutionId: "run-ro" })).statusCode).toBe(200);
  });

  it("executions list: filtered before paging, so totals only count readable runs", async () => {
    const { context, admin, viewer } = await seed();
    const listed = (await call(context, "GET", "/api/executions", viewer.cookie)).json<{ total: number; items: Array<{ id: string }> }>();
    expect(listed.items.map((item) => item.id).sort()).toEqual(["run-open", "run-ro"]);
    expect(listed.total).toBe(2);
    const filtered = (await call(context, "GET", "/api/executions?workflowId=wf-hidden", viewer.cookie)).json<{ total: number; items: unknown[] }>();
    expect(filtered).toMatchObject({ total: 0, items: [] });
    // One run per page: still only two pages for the viewer.
    const paged = (await call(context, "GET", "/api/executions?pageSize=1&page=3", viewer.cookie)).json<{ total: number; items: unknown[] }>();
    expect(paged).toMatchObject({ total: 2, items: [] });
    expect((await call(context, "GET", "/api/executions", admin.cookie)).json<{ total: number }>().total).toBe(3);
  });

  it("execution detail, manifest, bundle and guard events: 404 for another project's run", async () => {
    const { context, admin, viewer } = await seed();
    for (const suffix of ["", "/manifest", "/bundle", "/guard-events"]) {
      const hidden = await call(context, "GET", `/api/executions/run-hidden${suffix}`, viewer.cookie);
      expect(hidden.statusCode, suffix).toBe(404);
      expect(hidden.body).not.toContain("input-of-run-hidden");
      // A run that does not exist gets the same answer.
      expect((await call(context, "GET", `/api/executions/run-nope${suffix}`, viewer.cookie)).json(), suffix).toEqual(hidden.json());
    }
    expect((await call(context, "GET", "/api/executions/run-ro", viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/executions/run-hidden", admin.cookie)).statusCode).toBe(200);
    // Runs of a deleted workflow are admin-only.
    saveRun(context, "run-orphan", "wf-gone");
    expect((await call(context, "GET", "/api/executions/run-orphan", viewer.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/executions/run-orphan", admin.cookie)).statusCode).toBe(200);
  });

  it("retry, MCP replay and cancel: 404 across projects, 403 where the user can only read", async () => {
    const { context, admin, builder, operator } = await seed();
    for (const action of ["retry", "replay"]) {
      expect((await call(context, "POST", `/api/executions/run-hidden/${action}`, builder.cookie, {})).statusCode, action).toBe(404);
      expect((await call(context, "POST", `/api/executions/run-ro/${action}`, builder.cookie, {})).statusCode, action).toBe(403);
    }
    expect((await call(context, "POST", "/api/executions/run-open/retry", builder.cookie, {})).statusCode).toBe(200);

    saveRun(context, "live-hidden", "wf-hidden", "running");
    saveRun(context, "live-ro", "wf-ro", "running");
    saveRun(context, "live-open", "wf-open", "running");
    expect((await call(context, "POST", "/api/executions/live-hidden/cancel", operator.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/executions/live-ro/cancel", operator.cookie, {})).statusCode).toBe(403);
    expect(context.store.getExecutionHistory("live-hidden")!.status).toBe("running");
    expect((await call(context, "POST", "/api/executions/live-open/cancel", operator.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/executions/live-hidden/cancel", admin.cookie, {})).statusCode).toBe(200);
  });

  it("approvals: the inbox lists only readable projects, and deciding needs run access", async () => {
    const { context, admin, operator } = await seed();
    context.store.upsertWorkflow(simpleWorkflow("wf-gate-hidden", "hidden", true));
    context.store.upsertWorkflow(simpleWorkflow("wf-gate-ro", "ro", true));
    context.store.upsertWorkflow(simpleWorkflow("wf-gate-open", "default", true));
    const paused: Record<string, string> = {};
    for (const id of ["wf-gate-hidden", "wf-gate-ro", "wf-gate-open"]) {
      const run = (await call(context, "POST", `/api/workflows/${id}/execute`, admin.cookie, {})).json<{ status: string; executionId: string }>();
      expect(run.status).toBe("waiting_approval");
      paused[id] = run.executionId;
    }
    const inbox = (await call(context, "GET", "/api/approvals", operator.cookie)).json<{ items: Array<{ workflowId: string }> }>();
    expect(inbox.items.map((item) => item.workflowId).sort()).toEqual(["wf-gate-open", "wf-gate-ro"]);
    expect((await call(context, "GET", "/api/approvals", admin.cookie)).json<{ items: unknown[] }>().items).toHaveLength(3);

    for (const decision of ["approve", "reject"]) {
      expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-hidden"]}/${decision}`, operator.cookie, {})).statusCode).toBe(404);
      expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-ro"]}/${decision}`, operator.cookie, {})).statusCode).toBe(403);
    }
    expect(context.store.getWorkflowExecutionState(paused["wf-gate-hidden"]!)!.status).toBe("waiting_approval");
    expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-open"]}/approve`, operator.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-hidden"]}/approve`, admin.cookie, {})).statusCode).toBe(200);
  });

  it("dead-letter queue lists only readable workflows", async () => {
    const { context, admin, operator } = await seed();
    for (const workflowId of ["wf-open", "wf-hidden"]) {
      const id = `job-${workflowId}`;
      context.store.enqueueExecution({ id, workflowId, payload: {}, maxAttempts: 1 });
      context.store.markQueueItemFailed(id, "boom");
    }
    const dlq = (await call(context, "GET", "/api/queue/dlq", operator.cookie)).json<Array<{ workflowId: string }>>();
    expect(dlq.map((item) => item.workflowId)).toEqual(["wf-open"]);
    expect((await call(context, "GET", "/api/queue/dlq", admin.cookie)).json<unknown[]>()).toHaveLength(2);
  });

  it("golden runs: save, list, read, replay and delete follow the workflow's project", async () => {
    const { context, admin, builder } = await seed();
    const save = (executionId: string, cookie: string) => call(context, "POST", "/api/replay/recordings", cookie, { executionId, name: "golden" });
    saveRun(context, "ok-hidden", "wf-hidden", "success");
    saveRun(context, "ok-ro", "wf-ro", "success");
    expect((await save("ok-hidden", builder.cookie)).statusCode).toBe(404);
    expect((await save("ok-ro", builder.cookie)).statusCode).toBe(403);
    const hidden = (await save("ok-hidden", admin.cookie)).json<{ recording: { id: string } }>().recording;
    const ro = (await save("ok-ro", admin.cookie)).json<{ recording: { id: string } }>().recording;

    const listed = (await call(context, "GET", "/api/replay/recordings", builder.cookie)).json<{ items: Array<{ id: string }>; total: number }>();
    expect(listed.items.map((item) => item.id)).toEqual([ro.id]);
    expect(listed.total).toBe(1);
    expect((await call(context, "GET", "/api/replay/recordings?workflowId=wf-hidden", builder.cookie)).json()).toEqual({ items: [], total: 0 });

    expect((await call(context, "GET", `/api/replay/recordings/${hidden.id}`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/replay/recordings/${hidden.id}/replay`, builder.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "DELETE", `/api/replay/recordings/${hidden.id}`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/replay/recordings/${ro.id}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/replay/recordings/${ro.id}/replay`, builder.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/replay/recordings/${ro.id}`, builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/replay/recordings/${hidden.id}`, admin.cookie)).statusCode).toBe(200);
  });

  it("knowledge bases: list, detail, chunks, search and ingest are scoped to the KB's project", async () => {
    const { context, admin, builder } = await seed();
    const create = async (name: string, projectId?: string) =>
      (await call(context, "POST", "/api/knowledge-bases", admin.cookie, { name, embedderId: "token-embedder", ...(projectId ? { projectId } : {}) })).json<{ knowledgeBase: { id: string } }>().knowledgeBase.id;
    const hiddenKb = await create("hidden kb", "hidden");
    const roKb = await create("ro kb", "ro");
    const sharedKb = await create("shared kb");
    await call(context, "POST", `/api/knowledge-bases/${hiddenKb}/ingest`, admin.cookie, { sourceId: "s", documents: [{ content: "hidden payroll numbers" }] });

    const listed = (await call(context, "GET", "/api/knowledge-bases", builder.cookie)).json<{ knowledgeBases: Array<{ id: string }> }>();
    expect(listed.knowledgeBases.map((kb) => kb.id).sort()).toEqual([roKb, sharedKb].sort());
    expect((await call(context, "GET", "/api/knowledge-bases?projectId=hidden", builder.cookie)).json()).toEqual({ knowledgeBases: [] });
    expect((await call(context, "GET", "/api/knowledge-bases", admin.cookie)).json<{ knowledgeBases: unknown[] }>().knowledgeBases).toHaveLength(3);

    expect((await call(context, "GET", `/api/knowledge-bases/${hiddenKb}`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/knowledge-bases/${hiddenKb}/chunks`, builder.cookie)).statusCode).toBe(404);
    const search = await call(context, "POST", `/api/knowledge-bases/${hiddenKb}/search`, builder.cookie, { query: "payroll" });
    expect(search.statusCode).toBe(404);
    expect(search.body).not.toContain("payroll numbers");
    expect((await call(context, "POST", `/api/knowledge-bases/${hiddenKb}/ingest`, builder.cookie, { documents: [{ content: "x" }] })).statusCode).toBe(404);

    expect((await call(context, "GET", `/api/knowledge-bases/${roKb}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/knowledge-bases/${roKb}/search`, builder.cookie, { query: "x" })).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/knowledge-bases/${roKb}/ingest`, builder.cookie, { documents: [{ content: "x" }] })).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/knowledge-bases/${sharedKb}/ingest`, builder.cookie, { documents: [{ content: "x" }] })).statusCode).toBe(200);
  });

  it("a run cannot read a knowledge base of another project", async () => {
    const { context, admin } = await seed();
    const kbId = (await call(context, "POST", "/api/knowledge-bases", admin.cookie, { name: "hidden kb", embedderId: "token-embedder", projectId: "hidden" })).json<{ knowledgeBase: { id: string } }>().knowledgeBase.id;
    await call(context, "POST", `/api/knowledge-bases/${kbId}/ingest`, admin.cookie, { sourceId: "s", documents: [{ content: "hidden payroll numbers" }] });
    const ragWorkflow = (id: string, projectId: string): Workflow => ({
      id,
      name: id,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId,
      nodes: [
        { id: "q", type: "text_input", name: "Q", position: { x: 0, y: 0 }, config: { text: "payroll numbers" } },
        { id: "retrieve", type: "rag_retrieve", name: "Retrieve", position: { x: 200, y: 0 }, config: { queryTemplate: "{{text}}", topK: 2, embedderId: "token-embedder", vectorStoreId: "knowledge-base", knowledgeBaseId: kbId, searchMode: "hybrid" } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "q", target: "retrieve" },
        { id: "e2", source: "retrieve", target: "out" }
      ]
    });
    context.store.upsertWorkflow(ragWorkflow("wf-rag-open", "default"));
    context.store.upsertWorkflow(ragWorkflow("wf-rag-hidden", "hidden"));
    const outside = await call(context, "POST", "/api/workflows/wf-rag-open/execute", admin.cookie, {});
    expect(outside.body).not.toContain("hidden payroll numbers");
    const inside = await call(context, "POST", "/api/workflows/wf-rag-hidden/execute", admin.cookie, {});
    expect(inside.statusCode).toBe(200);
    expect(inside.body).toContain("hidden payroll numbers");
  });

  it("session-mode chat only answers users who can read the workflow's project", async () => {
    const { context, viewer } = await seed();
    const chatWorkflow = (id: string, projectId: string): Workflow => ({
      id,
      name: id,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId,
      nodes: [
        { id: "chat", type: "chat_trigger", name: "Chat", position: { x: 0, y: 0 }, config: { authMode: "session" } },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "hi" } }
      ],
      edges: [{ id: "e1", source: "chat", target: "out" }]
    });
    context.store.upsertWorkflow(chatWorkflow("wf-chat-hidden", "hidden"));
    context.store.upsertWorkflow(chatWorkflow("wf-chat-open", "default"));
    expect((await call(context, "POST", "/api/chat/wf-chat-hidden", viewer.cookie, { message: "hi" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/chat/wf-chat-open", viewer.cookie, { message: "hi" })).statusCode).toBe(200);
  });
});

describe("project authorization on workflow routes", () => {
  it("lists and reads only workflows in readable projects", async () => {
    const { context, admin, viewer } = await seed();
    const listed = (await call(context, "GET", "/api/workflows", viewer.cookie)).json<Array<{ id: string }>>();
    expect(listed.map((workflow) => workflow.id).sort()).toEqual(["wf-open", "wf-ro"]);
    expect((await call(context, "GET", "/api/workflows?projectId=hidden", viewer.cookie)).json()).toEqual([]);
    expect((await call(context, "GET", "/api/workflows", admin.cookie)).json<unknown[]>()).toHaveLength(3);
    for (const suffix of ["", "/variables", "/export", "/pins", "/versions", "/versions/1"]) {
      expect((await call(context, "GET", `/api/workflows/wf-hidden${suffix}`, viewer.cookie)).statusCode, suffix).toBe(404);
    }
    expect((await call(context, "POST", "/api/workflows/wf-hidden/validate", viewer.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/workflows/wf-ro", viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-hidden", admin.cookie)).statusCode).toBe(200);
  });

  it("writes need workflow:write on the workflow and on the project it lands in", async () => {
    const { context, builder } = await seed();
    const hidden = context.store.getWorkflow("wf-hidden")!;
    const ro = context.store.getWorkflow("wf-ro")!;
    // Overwriting another project's workflow, by update or by create/import with its id.
    expect((await call(context, "PUT", "/api/workflows/wf-hidden", builder.cookie, { ...hidden, projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, { ...hidden, projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/import", builder.cookie, { workflow: { ...hidden, projectId: "default" } })).statusCode).toBe(404);
    expect((await call(context, "PUT", "/api/workflows/wf-ro", builder.cookie, ro)).statusCode).toBe(403);
    expect(context.store.getWorkflow("wf-hidden")!.projectId).toBe("hidden");
    // Creating into a project the user cannot write.
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "ro"))).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "hidden"))).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "default"))).statusCode).toBe(200);
    // Moving your own workflow into a project you cannot write.
    expect((await call(context, "PUT", "/api/workflows/wf-new", builder.cookie, simpleWorkflow("wf-new", "ro"))).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-new/move", builder.cookie, { projectId: "ro" })).statusCode).toBe(403);
    expect(context.store.getWorkflow("wf-new")!.projectId).toBe("default");

    for (const [method, suffix] of [
      ["DELETE", ""],
      ["POST", "/duplicate"],
      ["POST", "/activate"],
      ["POST", "/deactivate"],
      ["PUT", "/variables"],
      ["PUT", "/pins/out"],
      ["DELETE", "/pins/out"],
      ["POST", "/versions/1/restore"]
    ] as const) {
      const body = suffix === "/duplicate" ? { name: "copy" } : suffix === "/variables" ? { variables: {} } : suffix === "/pins/out" && method === "PUT" ? { data: {} } : undefined;
      expect((await call(context, method, `/api/workflows/wf-hidden${suffix}`, builder.cookie, body)).statusCode, `${method} ${suffix}`).toBe(404);
      expect((await call(context, method, `/api/workflows/wf-ro${suffix}`, builder.cookie, body)).statusCode, `${method} ${suffix}`).toBe(403);
    }
    expect(context.store.getWorkflow("wf-hidden")).toBeTruthy();
  });

  it("eval runs start only on workflows the user can run", async () => {
    const { context, builder } = await seed();
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "d" })).json<{ id?: string; dataset?: { id: string } }>();
    const datasetId = dataset.dataset?.id ?? dataset.id;
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId, workflowId: "wf-hidden" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId, workflowId: "wf-ro" })).statusCode).toBe(403);
  });
});
