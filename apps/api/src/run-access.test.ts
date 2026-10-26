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
import http from "node:http";
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
import { strictIsolationStartupWarning } from "./services/rbac-service.js";
import type { SchedulerService } from "./services/scheduler-service.js";

type SchedulerExecutionHandler = Parameters<SchedulerService["setExecutionHandler"]>[0];
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  /** The scheduler's execution handler, when the context was created with `scheduler: true`. */
  fireSchedule?: SchedulerExecutionHandler;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { env?: Record<string, string>; queuePollMs?: number; scheduler?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-run-access-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...options.env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  // By default a queue that never polls: enqueued jobs stay pending for the assertions.
  const queueService = new QueueService(store, { pollIntervalMs: options.queuePollMs ?? 3_600_000 });
  // A scheduler stand-in that hands its execution handler to the test instead of running cron.
  let fireSchedule: SchedulerExecutionHandler | undefined;
  const scheduler = options.scheduler
    ? ({
        setExecutionHandler: (handler: SchedulerExecutionHandler) => {
          fireSchedule = handler;
        },
        initialize: () => undefined,
        stop: () => undefined,
        reloadWorkflow: () => undefined,
        removeWorkflow: () => undefined
      } as unknown as SchedulerService)
    : undefined;
  const app = await createApp(config, store, secretService, authService, scheduler, queueService);
  await app.ready();
  const context: TestContext = { app, store, authService, secretService, config, tempDir, fireSchedule };
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
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
async function lockOut(context: TestContext, userId: string, projectId: string) {
  await context.store.upsertProject({ id: projectId, name: projectId });
  await context.store.upsertCustomRole({ id: `none-${projectId}`, projectId, name: "No access", permissions: [] });
  await context.store.upsertProjectRole({ userId, projectId, role: "custom", customRoleId: `none-${projectId}` });
}

/** Gives a user read-only access to a project. */
async function readOnly(context: TestContext, userId: string, projectId: string) {
  await context.store.upsertProject({ id: projectId, name: projectId });
  await context.store.upsertProjectRole({ userId, projectId, role: "viewer" });
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

/** Polls until a queued run has left the running and waiting states, and returns its history. */
async function waitForFinished(context: TestContext, executionId: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const entry = await context.store.getExecutionHistory(executionId);
    if (entry && entry.status !== "running" && entry.status !== "waiting_approval") return entry;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${executionId} did not finish`);
}

async function saveRun(context: TestContext, id: string, workflowId: string, status = "error") {
  const now = new Date().toISOString();
  await context.store.saveExecutionHistory({
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
async function seed(options: Parameters<typeof createTestContext>[0] = {}) {
  const context = await createTestContext(options);
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  const operator = await login(context, "operator");
  const viewer = await login(context, "viewer");
  for (const user of [builder, operator, viewer]) {
    await lockOut(context, user.id, "hidden");
    await readOnly(context, user.id, "ro");
  }
  await context.store.upsertWorkflow(simpleWorkflow("wf-open", "default"));
  await context.store.upsertWorkflow(simpleWorkflow("wf-hidden", "hidden"));
  await context.store.upsertWorkflow(simpleWorkflow("wf-ro", "ro"));
  await saveRun(context, "run-open", "wf-open");
  await saveRun(context, "run-hidden", "wf-hidden");
  await saveRun(context, "run-ro", "wf-ro");
  return { context, admin, builder, operator, viewer };
}

describe("run-access helper", () => {
  const user = (role: SafeUser["role"]): SafeUser => ({ id: `u-${role}`, email: `${role}@x`, role }) as SafeUser;
  const workflows: Record<string, Workflow> = {
    a: simpleWorkflow("a", "pa"),
    b: simpleWorkflow("b", "pb")
  };
  const access = createRunAccess({
    getWorkflow: async (id) => workflows[id] ?? null,
    listWorkflows: async () => Object.values(workflows),
    listProjectIds: async () => ["pa", "pb"],
    // The user can read pa and pb, and run only in pa.
    canAccessWorkflow: async (_user, workflow, permission) => workflow.projectId === "pa" || permission === "workflow:read",
    canInProject: async (_user, projectId, permission) => projectId === "pa" || permission === "workflow:read",
    listWorkflowIdsSharedToProject: async () => [],
    projectExists: async (projectId) => projectId === "pa" || projectId === "pb"
  });

  it("answers 404 for unknown or unreadable workflows and 403 for readable ones without the permission", async () => {
    expect(await access.workflow(user("builder"), "missing", "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(await access.workflow(user("builder"), "a", "workflow:execute")).toMatchObject({ ok: true });
    expect(await access.workflow(user("builder"), "b", "workflow:read")).toMatchObject({ ok: true });
    expect(await access.workflow(user("builder"), "b", "workflow:execute")).toMatchObject({ ok: false, status: 403 });
    const locked = createRunAccess({ ...accessDeps(), canAccessWorkflow: async () => false, canInProject: async () => false });
    expect(await locked.workflow(user("builder"), "a", "workflow:execute")).toMatchObject({ ok: false, status: 404 });
    expect(await locked.readableWorkflowIds(user("builder"))).toEqual([]);
    expect(await locked.project(user("builder"), null, "workflow:read")).toMatchObject({ ok: false, status: 404 });
  });

  it("lets admins through everywhere, including runs of a deleted workflow", async () => {
    const admin = user("admin");
    expect(await access.run(admin, { id: "r", workflowId: "gone" }, "workflow:execute")).toMatchObject({ ok: true, workflow: null });
    expect(await access.run(user("builder"), { id: "r", workflowId: "gone" }, "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(await access.run(admin, null, "workflow:read")).toMatchObject({ ok: false, status: 404 });
    expect(await access.readableWorkflowIds(admin)).toBeNull();
    expect(await access.readableProjectIds(admin)).toBeNull();
  });

  it("filters rows to readable workflows", async () => {
    const locked = createRunAccess({ ...accessDeps(), canInProject: async (_user, projectId) => projectId === "pa" });
    const rows = [{ workflowId: "a" }, { workflowId: "b" }, { workflowId: "gone" }];
    expect(await locked.filterRuns(user("viewer"), rows)).toEqual([{ workflowId: "a" }]);
    expect(await locked.filterRuns(user("admin"), rows)).toHaveLength(3);
  });

  function accessDeps() {
    return {
      getWorkflow: async (id: string) => workflows[id] ?? null,
      listWorkflows: async () => Object.values(workflows),
      listProjectIds: async () => ["pa", "pb"],
      canAccessWorkflow: async () => true,
      canInProject: async () => true,
      listWorkflowIdsSharedToProject: async (_projectId: string): Promise<string[]> => [],
      projectExists: async () => true
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
    await saveRun(context, "run-orphan", "wf-gone");
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

    await saveRun(context, "live-hidden", "wf-hidden", "running");
    await saveRun(context, "live-ro", "wf-ro", "running");
    await saveRun(context, "live-open", "wf-open", "running");
    expect((await call(context, "POST", "/api/executions/live-hidden/cancel", operator.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/executions/live-ro/cancel", operator.cookie, {})).statusCode).toBe(403);
    expect((await context.store.getExecutionHistory("live-hidden"))!.status).toBe("running");
    expect((await call(context, "POST", "/api/executions/live-open/cancel", operator.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/executions/live-hidden/cancel", admin.cookie, {})).statusCode).toBe(200);
  });

  it("approvals: the inbox lists only readable projects, and deciding needs run access", async () => {
    const { context, admin, operator } = await seed({ queuePollMs: 20 });
    await context.store.upsertWorkflow(simpleWorkflow("wf-gate-hidden", "hidden", true));
    await context.store.upsertWorkflow(simpleWorkflow("wf-gate-ro", "ro", true));
    await context.store.upsertWorkflow(simpleWorkflow("wf-gate-open", "default", true));
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
    expect((await context.store.getWorkflowExecutionState(paused["wf-gate-hidden"]!))!.status).toBe("waiting_approval");
    // With the execution queue in use a decision answers 202 and the resume runs on the queue.
    expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-open"]}/approve`, operator.cookie, {})).statusCode).toBe(202);
    expect((await call(context, "POST", `/api/approvals/${paused["wf-gate-hidden"]}/approve`, admin.cookie, {})).statusCode).toBe(202);
    for (const id of ["wf-gate-open", "wf-gate-hidden"]) {
      const finished = await waitForFinished(context, paused[id]!);
      expect(finished.status, id).toBe("success");
      expect(JSON.stringify(finished.output), id).toContain("done");
    }
  });

  it("dead-letter queue lists only readable workflows", async () => {
    const { context, admin, operator } = await seed();
    for (const workflowId of ["wf-open", "wf-hidden"]) {
      const id = `job-${workflowId}`;
      await context.store.enqueueExecution({ id, workflowId, payload: {}, maxAttempts: 1 });
      await context.store.markQueueItemFailed(id, "boom");
    }
    const dlq = (await call(context, "GET", "/api/queue/dlq", operator.cookie)).json<Array<{ workflowId: string }>>();
    expect(dlq.map((item) => item.workflowId)).toEqual(["wf-open"]);
    expect((await call(context, "GET", "/api/queue/dlq", admin.cookie)).json<unknown[]>()).toHaveLength(2);
  });

  it("golden runs: save, list, read, replay and delete follow the workflow's project", async () => {
    const { context, admin, builder } = await seed();
    const save = (executionId: string, cookie: string) => call(context, "POST", "/api/replay/recordings", cookie, { executionId, name: "golden" });
    await saveRun(context, "ok-hidden", "wf-hidden", "success");
    await saveRun(context, "ok-ro", "wf-ro", "success");
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
    // A shared knowledge base is read by every project's runs, so only an admin may add to it.
    expect((await call(context, "POST", `/api/knowledge-bases/${sharedKb}/search`, builder.cookie, { query: "x" })).statusCode).toBe(200);
    const sharedIngest = await call(context, "POST", `/api/knowledge-bases/${sharedKb}/ingest`, builder.cookie, { documents: [{ content: "x" }] });
    expect(sharedIngest.statusCode).toBe(403);
    expect(sharedIngest.json()).toEqual({ error: "Only an admin can add content to a shared knowledge base" });
    expect((await call(context, "POST", `/api/knowledge-bases/${sharedKb}/ingest`, admin.cookie, { documents: [{ content: "x" }] })).statusCode).toBe(200);
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
    await context.store.upsertWorkflow(ragWorkflow("wf-rag-open", "default"));
    await context.store.upsertWorkflow(ragWorkflow("wf-rag-hidden", "hidden"));
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
    await context.store.upsertWorkflow(chatWorkflow("wf-chat-hidden", "hidden"));
    await context.store.upsertWorkflow(chatWorkflow("wf-chat-open", "default"));
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
    const hidden = (await context.store.getWorkflow("wf-hidden"))!;
    const ro = (await context.store.getWorkflow("wf-ro"))!;
    // Overwriting another project's workflow, by update or by create/import with its id.
    expect((await call(context, "PUT", "/api/workflows/wf-hidden", builder.cookie, { ...hidden, projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, { ...hidden, projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/import", builder.cookie, { workflow: { ...hidden, projectId: "default" } })).statusCode).toBe(404);
    expect((await call(context, "PUT", "/api/workflows/wf-ro", builder.cookie, ro)).statusCode).toBe(403);
    expect((await context.store.getWorkflow("wf-hidden"))!.projectId).toBe("hidden");
    // Creating into a project the user cannot write.
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "ro"))).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "hidden"))).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-new", "default"))).statusCode).toBe(200);
    // Moving your own workflow into a project you cannot write.
    expect((await call(context, "PUT", "/api/workflows/wf-new", builder.cookie, simpleWorkflow("wf-new", "ro"))).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-new/move", builder.cookie, { projectId: "ro" })).statusCode).toBe(403);
    expect((await context.store.getWorkflow("wf-new"))!.projectId).toBe("default");

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
    expect(await context.store.getWorkflow("wf-hidden")).toBeTruthy();
  });

  it("eval runs start only on workflows the user can run", async () => {
    const { context, builder } = await seed();
    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "d" })).json<{ id?: string; dataset?: { id: string } }>();
    const datasetId = dataset.dataset?.id ?? dataset.id;
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId, workflowId: "wf-hidden" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId, workflowId: "wf-ro" })).statusCode).toBe(403);
  });
});

/** A workflow whose only work is an Execute Workflow node calling `childId`. */
function callerWorkflow(id: string, projectId: string, childId: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "sub", type: "execute_workflow", name: "Sub", position: { x: 200, y: 0 }, config: { workflowId: childId, mode: "sync" } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ]
  };
}

function childWorkflow(id: string, projectId: string, marker: string): Workflow {
  const workflow = simpleWorkflow(id, projectId);
  workflow.nodes[1] = { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: marker } };
  return workflow;
}

function webhookWorkflow(id: string, projectId: string, hookPath: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Hook", position: { x: 0, y: 0 }, config: { path: hookPath, method: "POST" } },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: `ran-${id}` } }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  };
}

async function saveCassette(context: TestContext, id: string, workflowId: string | null) {
  return await context.store.saveMcpCassette({
    id,
    executionId: null,
    workflowId,
    workflowName: workflowId,
    projectId: null,
    source: "manual",
    cassette: { format: "l2m.mcp-cassette", version: 1, recordedAt: new Date().toISOString(), servers: [], entries: [], truncated: false, bytes: 0, llm: "not_recorded" } as never,
    createdBy: null
  });
}

describe("project authorization: compat webhook execute (H1)", () => {
  it("an explicit workflow id follows the workflow's project, on both routes", async () => {
    const { context, admin, builder } = await seed();
    for (const route of ["/api/webhooks/execute", "/api/webhooks/execute/stream"]) {
      const hidden = await call(context, "POST", route, builder.cookie, { workflow_id: "wf-hidden" });
      expect(hidden.statusCode, route).toBe(404);
      expect(hidden.json(), route).toEqual({ error: "No workflows available" });
      expect((await call(context, "POST", route, builder.cookie, { workflow_id: "wf-nope" })).json(), route).toEqual(hidden.json());
      expect((await call(context, "POST", route, builder.cookie, { workflow_id: "wf-ro" })).statusCode, route).toBe(403);
    }
    expect((await call(context, "POST", "/api/webhooks/execute", builder.cookie, { workflow_id: "wf-open" })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/webhooks/execute", admin.cookie, { workflow_id: "wf-hidden" })).statusCode).toBe(200);
  });

  it("the path match and the fallback pick never choose a hidden workflow", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await lockOut(context, builder.id, "hidden");
    await context.store.upsertWorkflow(webhookWorkflow("wf-a-hidden-hook", "hidden", "shared-hook"));
    const byPath = await call(context, "POST", "/api/webhooks/execute", builder.cookie, { webhook_path: "shared-hook" });
    expect(byPath.statusCode).toBe(404);
    // With only a hidden webhook workflow and an open plain one, the fallback picks the open one.
    await context.store.upsertWorkflow(simpleWorkflow("wf-z-open", "default"));
    const fallback = await call(context, "POST", "/api/webhooks/execute", builder.cookie, {});
    expect(fallback.json<{ selectedWorkflowId: string }>().selectedWorkflowId).toBe("wf-z-open");
  });

  it("a production webhook still runs a workflow in any project (no user, by design)", async () => {
    const { context } = await seed();
    await context.store.upsertWorkflow(webhookWorkflow("wf-hidden-hook", "hidden", "hidden-hook"));
    const response = await context.app.inject({ method: "POST", url: "/webhook/hidden-hook", payload: {} });
    expect(response.statusCode).toBe(200);
  });
});

describe("project authorization: templates (H2)", () => {
  it("a template cannot be made from a workflow the user cannot read, and never carries project, folder or pins", async () => {
    const { context, builder, viewer } = await seed();
    const hidden = await call(context, "POST", "/api/templates", builder.cookie, { name: "steal", workflowId: "wf-hidden" });
    expect(hidden.statusCode).toBe(404);
    expect((await context.store.listTemplates({})).some((template) => template.name === "steal")).toBe(false);

    await context.store.upsertWorkflow({ ...simpleWorkflow("wf-pinned", "default"), pinnedData: { out: { secret: "run output" } } });
    const created = (await call(context, "POST", "/api/templates", builder.cookie, { name: "ok", workflowId: "wf-pinned" })).json<{ id: string }>();
    const stored = (await call(context, "GET", `/api/templates/${created.id}`, viewer.cookie)).json<{ workflowJson: string }>();
    const json = JSON.parse(stored.workflowJson) as Record<string, unknown>;
    expect(json.projectId).toBeUndefined();
    expect(json.pinnedData).toBeUndefined();
    expect((await call(context, "POST", "/api/templates", builder.cookie, { name: "bad", workflowJson: "not json" })).statusCode).toBe(400);
  });

  it("using a template lands in the project the caller asks for and can write, never the one the JSON names", async () => {
    const { context, builder } = await seed();
    const created = (
      await call(context, "POST", "/api/templates", builder.cookie, { name: "planted", workflowJson: JSON.stringify({ ...simpleWorkflow("x", "hidden"), folderId: "f" }) })
    ).json<{ id: string }>();
    const used = (await call(context, "POST", `/api/templates/${created.id}/use`, builder.cookie)).json<{ workflowId: string }>();
    expect((await context.store.getWorkflow(used.workflowId))!.projectId).toBe("default");
    expect((await call(context, "POST", `/api/templates/${created.id}/use`, builder.cookie, { projectId: "ro" })).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/templates/${created.id}/use`, builder.cookie, { projectId: "hidden" })).statusCode).toBe(404);
    // A template whose JSON still names a project (seeded before this change) is also re-homed.
    await context.store.upsertTemplate({ id: "tpl-old", name: "old", description: "", category: "General", tags: [], author: "x", workflowJson: JSON.stringify(simpleWorkflow("y", "hidden")), nodeCount: 2 });
    const legacy = (await call(context, "POST", "/api/templates/tpl-old/use", builder.cookie)).json<{ workflowId: string }>();
    expect((await context.store.getWorkflow(legacy.workflowId))!.projectId).toBe("default");
  });
});

describe("project authorization: sub-workflows at run time (H3)", () => {
  it("execute_workflow cannot run a workflow of a project the caller is locked out of", async () => {
    const { context, builder } = await seed();
    await context.store.upsertWorkflow(childWorkflow("wf-secret", "hidden", "hidden-project-secret-output"));
    expect((await call(context, "POST", "/api/workflows", builder.cookie, callerWorkflow("wf-caller", "default", "wf-secret"))).statusCode).toBe(200);
    const run = await call(context, "POST", "/api/workflows/wf-caller/execute", builder.cookie, {});
    expect(run.body).not.toContain("hidden-project-secret-output");
    expect(run.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("is in another project") });
  });

  it("same project and execute shares work; another project the run's user may run does not", async () => {
    const { context, admin, builder } = await seed();
    await context.store.upsertWorkflow(childWorkflow("wf-same", "default", "same-project-output"));
    await context.store.upsertWorkflow(callerWorkflow("wf-call-same", "default", "wf-same"));
    expect((await call(context, "POST", "/api/workflows/wf-call-same/execute", builder.cookie, {})).body).toContain("same-project-output");

    // Shared to the caller's project with execute: works for every trigger.
    await context.store.upsertWorkflow(childWorkflow("wf-shared-child", "hidden", "shared-child-output"));
    await context.store.upsertWorkflow(callerWorkflow("wf-call-shared", "default", "wf-shared-child"));
    expect((await call(context, "POST", "/api/workflows/wf-shared-child/shares", admin.cookie, { projectId: "default", accessLevel: "read" })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-call-shared/execute", builder.cookie, {})).json<{ status: string }>().status).toBe("error");
    expect((await call(context, "POST", "/api/workflows/wf-shared-child/shares", admin.cookie, { projectId: "default", accessLevel: "execute" })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-call-shared/execute", builder.cookie, {})).body).toContain("shared-child-output");

    // Another project the run's user may run: only the projects decide, so it is refused (N1).
    await context.store.upsertProject({ id: "p2", name: "p2" });
    await context.store.upsertWorkflow(childWorkflow("wf-p2-child", "p2", "p2-output"));
    await context.store.upsertWorkflow(callerWorkflow("wf-call-p2", "default", "wf-p2-child"));
    const crossProject = await call(context, "POST", "/api/workflows/wf-call-p2/execute", builder.cookie, {});
    expect(crossProject.body).not.toContain("p2-output");
    expect(crossProject.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("is in another project") });
  });

  it("an admin approving a builder's paused run does not let it call another project (N1)", async () => {
    const { context, admin, builder } = await seed({ queuePollMs: 20 });
    await context.store.upsertWorkflow(childWorkflow("wf-secret", "hidden", "hidden-project-secret-output"));
    const gated = callerWorkflow("wf-gated", "default", "wf-secret");
    gated.nodes.splice(1, 0, { id: "gate", type: "human_approval", name: "Gate", position: { x: 100, y: 0 }, config: { approvalMessage: "ok?", timeoutMinutes: 60 } });
    gated.edges = [
      { id: "e0", source: "start", target: "gate" },
      { id: "e1", source: "gate", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ];
    expect((await call(context, "POST", "/api/workflows", builder.cookie, gated)).statusCode).toBe(200);
    const run = (await call(context, "POST", "/api/workflows/wf-gated/execute", builder.cookie, {})).json<{ status: string; executionId: string }>();
    expect(run.status).toBe("waiting_approval");
    const approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, admin.cookie, {});
    // The resume runs on the execution queue.
    expect(approved.statusCode).toBe(202);
    for (let attempt = 0; attempt < 200 && (await context.store.getExecutionHistory(run.executionId))?.status !== "error"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const detail = await call(context, "GET", `/api/executions/${run.executionId}`, builder.cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("is in another project") });
    expect(detail.body).not.toContain("hidden-project-secret-output");
  });

  it("an admin retrying a builder's failed run does not let it call another project (N1)", async () => {
    const { context, admin, builder } = await seed();
    await context.store.upsertWorkflow(childWorkflow("wf-secret", "hidden", "hidden-project-secret-output"));
    expect((await call(context, "POST", "/api/workflows", builder.cookie, callerWorkflow("wf-plain", "default", "wf-secret"))).statusCode).toBe(200);
    const first = (await call(context, "POST", "/api/workflows/wf-plain/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(first.status).toBe("error");
    const retry = await call(context, "POST", `/api/executions/${first.executionId}/retry`, admin.cookie, {});
    expect(retry.statusCode).toBe(400);
    expect(retry.body).not.toContain("hidden-project-secret-output");
    expect(retry.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("is in another project") });
  });

  it("a run with no user (webhook) only reaches its own project's sub-workflows", async () => {
    const { context } = await seed();
    await context.store.upsertProject({ id: "p2", name: "p2" });
    await context.store.upsertWorkflow(childWorkflow("wf-p2-child", "p2", "p2-output"));
    const hook = webhookWorkflow("wf-hook-caller", "default", "call-p2");
    hook.nodes.splice(1, 0, { id: "sub", type: "execute_workflow", name: "Sub", position: { x: 100, y: 0 }, config: { workflowId: "wf-p2-child", mode: "sync" } });
    hook.edges = [
      { id: "e1", source: "hook", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ];
    await context.store.upsertWorkflow(hook);
    const response = await context.app.inject({ method: "POST", url: "/webhook/call-p2", payload: {} });
    expect(response.body).not.toContain("p2-output");
    expect(response.body).toContain("is in another project");
  });
});

describe("project authorization: MCP cassettes (H4) and replay sources (M1)", () => {
  it("cassette list, detail and export follow the workflow's project", async () => {
    const { context, admin, builder } = await seed();
    await saveCassette(context, "cas-hidden", "wf-hidden");
    await saveCassette(context, "cas-open", "wf-open");
    await saveCassette(context, "cas-orphan", null);
    const listed = (await call(context, "GET", "/api/mcp/cassettes", builder.cookie)).json<{ items: Array<{ id: string }>; total: number }>();
    expect(listed.items.map((item) => item.id)).toEqual(["cas-open"]);
    expect(listed.total).toBe(1);
    expect((await call(context, "GET", "/api/mcp/cassettes?workflowId=wf-hidden", builder.cookie)).json()).toMatchObject({ items: [], total: 0 });
    for (const suffix of ["", "/export"]) {
      const hidden = await call(context, "GET", `/api/mcp/cassettes/cas-hidden${suffix}`, builder.cookie);
      expect(hidden.statusCode, suffix).toBe(404);
      expect((await call(context, "GET", `/api/mcp/cassettes/cas-nope${suffix}`, builder.cookie)).json(), suffix).toEqual(hidden.json());
      expect((await call(context, "GET", `/api/mcp/cassettes/cas-orphan${suffix}`, builder.cookie)).statusCode, suffix).toBe(404);
      expect((await call(context, "GET", `/api/mcp/cassettes/cas-open${suffix}`, builder.cookie)).statusCode, suffix).toBe(200);
      expect((await call(context, "GET", `/api/mcp/cassettes/cas-hidden${suffix}`, admin.cookie)).statusCode, suffix).toBe(200);
    }
    expect((await call(context, "GET", "/api/mcp/cassettes", admin.cookie)).json<{ total: number }>().total).toBe(3);
  });

  it("execution and eval replays refuse another project's cassette or eval run", async () => {
    const { context, admin, builder } = await seed();
    await saveCassette(context, "cas-hidden", "wf-hidden");
    await saveCassette(context, "cas-orphan", null);
    await saveCassette(context, "cas-ro", "wf-ro");
    // Execution replay: unreadable reads as missing, a readable one of another workflow (or none) is 409.
    const replay = (cassetteId: string) => call(context, "POST", "/api/executions/run-open/replay", builder.cookie, { cassetteId });
    expect((await replay("cas-hidden")).statusCode).toBe(404);
    expect((await replay("cas-ro")).statusCode).toBe(409);
    // A cassette with no workflow is admin-only, and never belongs to this workflow.
    expect((await replay("cas-orphan")).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/executions/run-open/replay", admin.cookie, { cassetteId: "cas-orphan" })).statusCode).toBe(409);

    const dataset = (await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "d" })).json<{ dataset: { id: string } }>().dataset;
    const evalRun = (replaySource: Record<string, string>) =>
      call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: dataset.id, workflowId: "wf-open", replay: replaySource });
    expect((await evalRun({ cassetteId: "cas-hidden" })).statusCode).toBe(404);
    expect((await evalRun({ cassetteId: "cas-ro" })).statusCode).toBe(409);
    expect((await evalRun({ cassetteId: "cas-orphan" })).statusCode).toBe(404);
    await context.store.createEvalRun({ id: "er-hidden", datasetId: dataset.id, workflowId: "wf-hidden" });
    await context.store.createEvalRun({ id: "er-ro", datasetId: dataset.id, workflowId: "wf-ro" });
    expect((await evalRun({ evalRunId: "er-hidden" })).statusCode).toBe(404);
    expect((await evalRun({ evalRunId: "er-ro" })).statusCode).toBe(409);
  });
});

describe("project authorization: lists, deletes and elicitations (M2, M3, M4)", () => {
  it("webhook endpoints list only readable workflows", async () => {
    const { context, admin, viewer } = await seed();
    await context.store.upsertWorkflow(webhookWorkflow("wf-hidden-hook", "hidden", "hidden-hook"));
    await context.store.upsertWorkflow(webhookWorkflow("wf-open-hook", "default", "open-hook"));
    const listed = (await call(context, "GET", "/api/webhook-endpoints", viewer.cookie)).body;
    expect(listed).toContain("open-hook");
    expect(listed).not.toContain("hidden-hook");
    expect((await call(context, "GET", "/api/webhook-endpoints", admin.cookie)).body).toContain("hidden-hook");
  });

  it("a re-created workflow id inherits nothing from the deleted one", async () => {
    const { context, admin, builder } = await seed();
    await context.store.upsertWorkflow(simpleWorkflow("wf-reuse", "hidden"));
    await context.store.writeWorkflowVersion({ id: "v1", workflowId: "wf-reuse", version: 1, workflowJson: JSON.stringify(simpleWorkflow("wf-reuse", "hidden")), createdBy: null, changeNote: null });
    await context.store.upsertWorkflowShare({ workflowId: "wf-reuse", projectId: "ro", accessLevel: "execute" });
    await context.store.enqueueExecution({ id: "job-reuse", workflowId: "wf-reuse", payload: {}, maxAttempts: 1 });
    await context.store.markQueueItemFailed("job-reuse", "boom");
    await context.store.createEvalRun({ id: "er-reuse", datasetId: "ds", workflowId: "wf-reuse" });
    await context.store.saveSessionMemory("wf-reuse:out", "s1", [{ role: "user", content: "old memory" }]);
    // Another workflow whose id extends the deleted one's: its legacy rows stay (N5).
    await context.store.upsertWorkflow(simpleWorkflow("wf-reuse:x", "hidden"));
    await context.store.saveSessionMemory("wf-reuse:x:out", "s1", [{ role: "user", content: "other workflow" }]);
    expect((await call(context, "DELETE", "/api/workflows/wf-reuse", admin.cookie)).statusCode).toBe(200);

    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-reuse", "default"))).statusCode).toBe(200);
    const versions = (await call(context, "GET", "/api/workflows/wf-reuse/versions", builder.cookie)).json<{ versions: Array<{ version: number; createdBy: string | null }> }>();
    expect(versions.versions.every((entry) => entry.createdBy === builder.id)).toBe(true);
    expect(await context.store.listWorkflowShares("wf-reuse")).toEqual([]);
    expect(await context.store.listDlqItems(50, ["wf-reuse"])).toEqual([]);
    expect(await context.store.listEvalRuns({ workflowId: "wf-reuse" })).toEqual([]);
    expect(await context.store.loadSessionMemory("wf-reuse:out", "s1")).toEqual([]);
    expect(await context.store.loadSessionMemory("wf-reuse:x:out", "s1")).toEqual([{ role: "user", content: "other workflow" }]);
  });

  it("elicitations are listed, read and answered only within readable projects", async () => {
    const { context, admin, operator } = await seed();
    const ask = async (id: string, workflowId: string) =>
      await context.store.createMcpElicitation({
        id,
        executionId: `exec-${id}`,
        workflowId,
        workflowName: workflowId,
        nodeId: "tool",
        serverId: "mock-mcp",
        toolName: "ask",
        message: `question-${id}`,
        requestedSchema: { type: "object", properties: {} } as never,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        createdBy: null,
        triggerType: "manual"
      });
    await ask("el-hidden", "wf-hidden");
    await ask("el-ro", "wf-ro");
    await ask("el-open", "wf-open");
    const listed = (await call(context, "GET", "/api/mcp/elicitations", operator.cookie)).json<{ items: Array<{ id: string }> }>();
    expect(listed.items.map((item) => item.id).sort()).toEqual(["el-open", "el-ro"]);
    expect((await call(context, "GET", "/api/mcp/elicitations", admin.cookie)).json<{ items: unknown[] }>().items).toHaveLength(3);
    expect((await call(context, "GET", "/api/mcp/elicitations/el-hidden", operator.cookie)).statusCode).toBe(404);
    const answer = (id: string) => call(context, "POST", `/api/mcp/elicitations/${id}/answer`, operator.cookie, { action: "decline" });
    expect((await answer("el-hidden")).statusCode).toBe(404);
    expect((await answer("el-ro")).statusCode).toBe(403);
    expect((await context.store.getMcpElicitation("el-hidden"))!.status).toBe("pending");
  });
});

describe("project authorization: eval datasets (M6) and eval runs", () => {
  it("datasets, fixtures and eval runs follow the dataset's and workflow's project", async () => {
    const { context, admin, builder, viewer } = await seed();
    const createDataset = async (name: string, projectId?: string) =>
      (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name, ...(projectId ? { projectId } : {}) })).json<{ dataset: { id: string } }>().dataset.id;
    const hiddenDs = await createDataset("hidden", "hidden");
    const roDs = await createDataset("ro", "ro");
    const sharedDs = await createDataset("shared");
    const fixture = (await call(context, "POST", `/api/eval/datasets/${hiddenDs}/fixtures`, admin.cookie, { name: "f", input: { q: "hidden input" } })).json<{ fixture: { id: string } }>().fixture;

    const listed = (await call(context, "GET", "/api/eval/datasets", builder.cookie)).json<{ datasets: Array<{ id: string }> }>();
    expect(listed.datasets.map((dataset) => dataset.id).sort()).toEqual([roDs, sharedDs].sort());
    const fixtures = await call(context, "GET", `/api/eval/datasets/${hiddenDs}/fixtures`, builder.cookie);
    expect(fixtures.statusCode).toBe(404);
    expect(fixtures.body).not.toContain("hidden input");
    expect((await call(context, "DELETE", `/api/eval/datasets/${hiddenDs}`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "DELETE", `/api/eval/fixtures/${fixture.id}`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/eval/datasets/${roDs}/fixtures`, builder.cookie, { name: "f", input: {} })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/eval/datasets", builder.cookie, { name: "x", projectId: "ro" })).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/eval/datasets/${sharedDs}/fixtures`, builder.cookie)).statusCode).toBe(200);
    // An eval run cannot feed another project's fixtures through your own workflow.
    expect((await call(context, "POST", "/api/eval/runs", builder.cookie, { datasetId: hiddenDs, workflowId: "wf-open" })).statusCode).toBe(404);
    expect(await context.store.getEvalDataset(hiddenDs)).toBeTruthy();

    // Eval runs: list (filtered before the limit) and detail.
    await context.store.createEvalRun({ id: "er-hidden", datasetId: sharedDs, workflowId: "wf-hidden" });
    await context.store.createEvalRun({ id: "er-open", datasetId: sharedDs, workflowId: "wf-open" });
    const runs = (await call(context, "GET", "/api/eval/runs?limit=1", viewer.cookie)).json<{ runs: Array<{ id: string }> }>();
    expect(runs.runs.map((run) => run.id)).toEqual(["er-open"]);
    expect((await call(context, "GET", "/api/eval/runs/er-hidden", viewer.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/eval/runs/er-open", viewer.cookie)).statusCode).toBe(200);
  });
});

describe("project authorization: secrets (M9)", () => {
  it("a run resolves only its project's, the default project's and shared secrets", async () => {
    const { context, admin, builder } = await seed();
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(String(request.headers.authorization ?? ""));
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const hiddenSecret = (await context.secretService.createSecret({ name: "hidden", provider: "custom", value: "hidden-token", projectId: "hidden" })).secretId;
      const defaultSecret = (await context.secretService.createSecret({ name: "default", provider: "custom", value: "default-token" })).secretId;
      const usesSecret = (id: string, secretId: string): Workflow => ({
        id,
        name: id,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "req", type: "http_request", name: "Req", position: { x: 200, y: 0 }, config: { method: "GET", urlTemplate: `http://127.0.0.1:${port}/`, secretRef: { secretId } } },
          { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
        ],
        edges: [
          { id: "e1", source: "start", target: "req" },
          { id: "e2", source: "req", target: "out" }
        ]
      });
      expect((await call(context, "POST", "/api/workflows", builder.cookie, usesSecret("wf-steal", hiddenSecret))).statusCode).toBe(200);
      const stolen = await call(context, "POST", "/api/workflows/wf-steal/execute", builder.cookie, {});
      expect(stolen.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("belongs to another project") });
      expect(seen).toEqual([]);

      await context.store.upsertWorkflow(usesSecret("wf-default-secret", defaultSecret));
      expect((await call(context, "POST", "/api/workflows/wf-default-secret/execute", builder.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer default-token"]);

      // Shared to the workflow's project: usable.
      expect((await call(context, "POST", `/api/secrets/${hiddenSecret}/shares`, admin.cookie, { projectId: "default" })).statusCode).toBe(200);
      expect((await call(context, "POST", "/api/workflows/wf-steal/execute", builder.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer default-token", "Bearer hidden-token"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("secret management and test routes follow the secret's project", async () => {
    const { context, builder } = await seed();
    const hiddenSecret = (await context.secretService.createSecret({ name: "hidden-secret-name", provider: "custom", value: "v", projectId: "hidden" })).secretId;
    const listed = (await call(context, "GET", "/api/secrets", builder.cookie)).body;
    expect(listed).not.toContain("hidden-secret-name");
    expect((await call(context, "GET", `/api/secrets/${hiddenSecret}/shares`, builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/secrets/${hiddenSecret}/shares`, builder.cookie, { projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "DELETE", `/api/secrets/${hiddenSecret}`, builder.cookie)).statusCode).toBe(404);
    expect(await context.store.listSecretsSharedToProject("default")).toEqual([]);
    expect((await call(context, "POST", "/api/secrets", builder.cookie, { name: "x", provider: "custom", value: "v", projectId: "ro" })).statusCode).toBe(403);
    // A test route cannot send someone else's secret to a URL of the caller's choice.
    const seen: string[] = [];
    const server = http.createServer((request, response) => {
      seen.push(String(request.headers.authorization ?? ""));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "m" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
      const openSecret = (await context.secretService.createSecret({ name: "open", provider: "custom", value: "open-token" })).secretId;
      const models = (secretId: string) => call(context, "POST", "/api/providers/models", builder.cookie, { providerId: "openai", secretRef: { secretId }, baseUrl });
      expect((await models(hiddenSecret)).json()).toEqual({ models: [] });
      expect(seen).toEqual([]);
      expect((await models(openSecret)).json()).toEqual({ models: [{ id: "m", label: "m" }] });
      expect(seen).toEqual(["Bearer open-token"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("project authorization: isolation mode (M7)", () => {
  it("PROJECT_ISOLATION is validated and defaults to role", () => {
    const env = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };
    expect(parseConfig(env).PROJECT_ISOLATION).toBe("role");
    expect(parseConfig({ ...env, PROJECT_ISOLATION: "strict" }).PROJECT_ISOLATION).toBe("strict");
    expect(() => parseConfig({ ...env, PROJECT_ISOLATION: "members" })).toThrow(/Invalid environment configuration/);
  });

  it("strict: a non-admin only sees projects they are a member of", async () => {
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "team", name: "team" });
    await context.store.upsertProject({ id: "other", name: "other" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "editor" });
    await context.store.upsertWorkflow(simpleWorkflow("wf-team", "team"));
    await context.store.upsertWorkflow(simpleWorkflow("wf-other", "other"));
    await context.store.upsertWorkflow(simpleWorkflow("wf-default", "default"));
    expect((await call(context, "GET", "/api/workflows", builder.cookie)).json<Array<{ id: string }>>().map((workflow) => workflow.id)).toEqual(["wf-team"]);
    expect((await call(context, "GET", "/api/projects", builder.cookie)).json<{ projects: Array<{ id: string }> }>().projects.map((project) => project.id)).toEqual(["team"]);
    expect((await call(context, "GET", "/api/workflows/wf-other", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", builder.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows", admin.cookie)).json<unknown[]>()).toHaveLength(3);
    // A project the builder creates is theirs to see.
    const created = (await call(context, "POST", "/api/projects", builder.cookie, { name: "mine" })).json<{ id: string }>();
    expect((await call(context, "GET", "/api/projects", builder.cookie)).json<{ projects: Array<{ id: string }> }>().projects.map((project) => project.id)).toContain(created.id);
  });

  it("strict with no memberships at all warns at startup that only admins can see anything (N9)", async () => {
    expect(strictIsolationStartupWarning("strict", 0)).toContain("only admins can see anything");
    expect(strictIsolationStartupWarning("strict", 1)).toBeNull();
    expect(strictIsolationStartupWarning("role", 0)).toBeNull();
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    expect(await context.store.countProjectMemberships()).toBe(0);
    await context.store.upsertProjectRole({ userId: "u1", projectId: "default", role: "viewer" });
    expect(await context.store.countProjectMemberships()).toBe(1);
  });

  it("role (default): a user with no membership keeps their global role", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "other", name: "other" });
    await context.store.upsertWorkflow(simpleWorkflow("wf-other", "other"));
    expect((await call(context, "GET", "/api/workflows/wf-other", builder.cookie)).statusCode).toBe(200);
  });
});

describe("project authorization: projects, folders and placement (L4, L5, L6)", () => {
  it("projects and folders are listed and changed only where the user can", async () => {
    const { context, builder } = await seed();
    await context.store.upsertFolder({ id: "fld-hidden", name: "hidden folder", projectId: "hidden" });
    await context.store.upsertFolder({ id: "fld-ro", name: "ro folder", projectId: "ro" });
    expect((await call(context, "GET", "/api/projects", builder.cookie)).json<{ projects: Array<{ id: string }> }>().projects.map((project) => project.id).sort()).toEqual(["default", "ro"]);
    expect((await call(context, "GET", "/api/folders", builder.cookie)).json<{ folders: Array<{ id: string }> }>().folders.map((folder) => folder.id)).toEqual(["fld-ro"]);
    expect((await call(context, "PUT", "/api/projects/hidden", builder.cookie, { name: "renamed" })).statusCode).toBe(404);
    expect((await call(context, "DELETE", "/api/projects/ro", builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/projects", builder.cookie, { id: "hidden", name: "taken over" })).statusCode).toBe(404);
    expect((await context.store.getProject("hidden"))!.name).toBe("hidden");
    expect((await call(context, "DELETE", "/api/folders/fld-hidden", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "PUT", "/api/folders/fld-ro", builder.cookie, { name: "x", projectId: "ro" })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/folders", builder.cookie, { name: "x", projectId: "ro" })).statusCode).toBe(403);
  });

  it("a workflow's folder must be in its project, and its project must exist", async () => {
    const { context, admin, builder } = await seed();
    await context.store.upsertFolder({ id: "fld-ro", name: "ro folder", projectId: "ro" });
    await context.store.upsertWorkflow(simpleWorkflow("wf-mine", "default"));
    const moved = await call(context, "POST", "/api/workflows/wf-mine/move", builder.cookie, { folderId: "fld-ro" });
    expect(moved.statusCode).toBe(400);
    expect(moved.json()).toEqual({ error: "Target folder belongs to a different project" });
    expect((await call(context, "POST", "/api/workflows", builder.cookie, simpleWorkflow("wf-ghost", "no-such-project"))).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows", admin.cookie, simpleWorkflow("wf-ghost", "no-such-project"))).json()).toEqual({ error: "Target project does not exist" });
  });

  it("a project that still holds a knowledge base is not deleted, so the knowledge base never loses its project", async () => {
    const { context, admin } = await seed();
    await context.store.upsertProject({ id: "gone", name: "gone" });
    const kbId = (await call(context, "POST", "/api/knowledge-bases", admin.cookie, { name: "orphan", embedderId: "token-embedder", projectId: "gone" })).json<{ knowledgeBase: { id: string } }>().knowledgeBase.id;
    await expect(context.store.deleteProject("gone")).rejects.toThrow(/knowledge bases/);
    expect((await call(context, "GET", `/api/knowledge-bases/${kbId}`, admin.cookie)).statusCode).toBe(200);
  });

  it("MCP toolset candidates list only readable workflows", async () => {
    const { context, builder } = await seed();
    const exposed = (id: string, projectId: string): Workflow => ({
      ...simpleWorkflow(id, projectId),
      nodes: [
        { id: "start", type: "mcp_server_trigger", name: "Start", position: { x: 0, y: 0 }, config: { toolName: `tool_${id.replace(/-/g, "_")}` } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
      ]
    });
    await context.store.upsertWorkflow(exposed("wf-tool-hidden", "hidden"));
    await context.store.upsertWorkflow(exposed("wf-tool-open", "default"));
    const candidates = (await call(context, "GET", "/api/mcp/toolsets/candidates", builder.cookie)).json<{ workflows: Array<{ id: string }> }>();
    expect(candidates.workflows.map((workflow) => workflow.id)).toEqual(["wf-tool-open"]);
  });
});

describe("project authorization: shares, imports, restores and other callers", () => {
  it("workflow shares: 404 for unreadable workflows; an execute share lets the target project run and approve", async () => {
    const { context, admin, builder, operator } = await seed({ queuePollMs: 20 });
    expect((await call(context, "GET", "/api/workflows/wf-hidden/shares", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/shares", builder.cookie, { projectId: "default" })).statusCode).toBe(404);
    expect((await call(context, "DELETE", "/api/workflows/wf-hidden/shares/default", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/workflows/wf-hidden/share-link", builder.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/workflows/wf-open/share-link", builder.cookie)).statusCode).toBe(200);

    // Read share: visible, not runnable.
    await call(context, "POST", "/api/workflows/wf-hidden/shares", admin.cookie, { projectId: "default", accessLevel: "read" });
    expect((await call(context, "GET", "/api/workflows/wf-hidden", builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/execute", builder.cookie, {})).statusCode).toBe(403);
    // Execute share: runs and approvals work.
    await context.store.upsertWorkflow(simpleWorkflow("wf-gate-hidden", "hidden", true));
    await call(context, "POST", "/api/workflows/wf-gate-hidden/shares", admin.cookie, { projectId: "default", accessLevel: "execute" });
    const paused = (await call(context, "POST", "/api/workflows/wf-gate-hidden/execute", builder.cookie, {})).json<{ status: string; executionId: string }>();
    expect(paused.status).toBe("waiting_approval");
    expect((await call(context, "POST", `/api/approvals/${paused.executionId}/approve`, operator.cookie, {})).statusCode).toBe(202);
    const finished = await waitForFinished(context, paused.executionId);
    expect(finished.status).toBe("success");
    expect(JSON.stringify(finished.output)).toContain("done");
  });

  it("imports and restores cannot land a workflow in a project the user cannot write", async () => {
    const { context, builder } = await seed();
    expect((await call(context, "POST", "/api/workflows/import", builder.cookie, { workflow: simpleWorkflow("wf-imp", "ro") })).statusCode).toBe(403);
    const encoded = Buffer.from(JSON.stringify(simpleWorkflow("wf-imp2", "ro"))).toString("base64url");
    expect((await call(context, "GET", `/api/workflows/import-shared?data=${encoded}`, builder.cookie)).statusCode).toBe(403);
    await context.store.upsertWorkflow(simpleWorkflow("wf-moved", "default"));
    await context.store.writeWorkflowVersion({ id: "v-ro", workflowId: "wf-moved", version: 1, workflowJson: JSON.stringify(simpleWorkflow("wf-moved", "ro")), createdBy: null, changeNote: null });
    expect((await call(context, "POST", "/api/workflows/wf-moved/versions/1/restore", builder.cookie)).statusCode).toBe(403);
    expect((await context.store.getWorkflow("wf-moved"))!.projectId).toBe("default");
  });

  it("session-mode forms only answer users who can read the workflow's project", async () => {
    const { context, viewer } = await seed();
    const form = (id: string, projectId: string, formPath: string): Workflow => ({
      ...simpleWorkflow(id, projectId),
      nodes: [
        { id: "start", type: "form_trigger", name: "Form", position: { x: 0, y: 0 }, config: { path: formPath, authMode: "session", title: "T", fields: [] } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
      ]
    });
    await context.store.upsertWorkflow(form("wf-form-hidden", "hidden", "hidden-form"));
    await context.store.upsertWorkflow(form("wf-form-open", "default", "open-form"));
    for (const method of ["GET", "POST"] as const) {
      expect((await call(context, method, "/api/forms/hidden-form", viewer.cookie, method === "POST" ? {} : undefined)).statusCode, method).toBe(404);
      expect((await call(context, method, "/api/forms/open-form", viewer.cookie, method === "POST" ? {} : undefined)).statusCode, method).toBe(200);
    }
  });

  it("an API key carries its owner's project access", async () => {
    const { context, builder } = await seed();
    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "ci" })).json<{ key: string }>().key;
    const withKey = (method: "GET" | "POST", url: string) => context.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(method === "POST" ? { payload: {} } : {}) });
    expect((await withKey("GET", "/api/executions/run-hidden")).statusCode).toBe(404);
    expect((await withKey("GET", "/api/executions/run-open")).statusCode).toBe(200);
    expect((await withKey("POST", "/api/workflows/wf-hidden/execute")).statusCode).toBe(404);
    expect((await withKey("POST", "/api/workflows/wf-ro/execute")).statusCode).toBe(403);
  });

  it("a scheduled run of a workflow in a locked-out project still runs (no user, by design)", async () => {
    const { context, admin } = await seed({ scheduler: true });
    const before = (await call(context, "GET", "/api/executions?workflowId=wf-hidden", admin.cookie)).json<{ total: number }>().total;
    await context.fireSchedule!({ workflowId: "wf-hidden", workflowName: "hidden", scheduleNodeId: "start", cronExpression: "* * * * *", timezone: "UTC", firedAt: new Date().toISOString() });
    expect((await call(context, "GET", "/api/executions?workflowId=wf-hidden", admin.cookie)).json<{ total: number }>().total).toBe(before + 1);
  });
});

describe("project authorization: queued runs (L7)", () => {
  it("records the session user as the trigger and re-checks access when the job runs", async () => {
    const { context, builder, operator } = await seed({ queuePollMs: 20 });
    const queued = (await call(context, "POST", "/api/workflows/wf-open/enqueue", operator.cookie, { triggeredBy: "someone-else@example.com" })).json<{ executionId: string }>();
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 200 && !await check(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await waitFor(async () => Boolean(await context.store.getExecutionHistory(queued.executionId)));
    const history = (await context.store.getExecutionHistory(queued.executionId))!;
    expect(history.triggeredBy).toBe("operator@example.com");
    expect(history.customData).toMatchObject({ requestedBy: "someone-else@example.com" });

    // A job queued by a user who has since lost access does not run.
    const executionId = "exec-revoked";
    await context.store.enqueueExecution({ id: "job-revoked", workflowId: "wf-hidden", payload: { workflowId: "wf-hidden", executionId, enqueuedByUserId: builder.id }, maxAttempts: 1 });
    await waitFor(async () => (await context.store.listDlqItems(50)).some((item) => item.workflowId === "wf-hidden"));
    expect((await context.store.listDlqItems(50)).find((item) => item.workflowId === "wf-hidden")!.finalError).toContain("can no longer run");
    expect(await context.store.getExecutionHistory(executionId)).toBeFalsy();
  });
});

/** An HTTP server that records the Authorization header of every request. */
async function withEcho<T>(fn: (port: number, seen: string[]) => Promise<T>): Promise<T> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(String(request.headers.authorization ?? ""));
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn((server.address() as { port: number }).port, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Manual trigger → HTTP Request sending `secretId` as a bearer token to the echo server → output. */
function secretWorkflow(id: string, projectId: string, port: number, secretId: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "req", type: "http_request", name: "Req", position: { x: 200, y: 0 }, config: { method: "GET", urlTemplate: `http://127.0.0.1:${port}/`, secretRef: { secretId } } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "req" },
      { id: "e2", source: "req", target: "out" }
    ]
  };
}

describe("project authorization: default-project secrets and isolation (N2)", () => {
  it("strict: a default-project secret reaches another project's runs only once it is shared there", async () => {
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "x", name: "x" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "x", role: "editor" });
    const adminSecret = (await context.secretService.createSecret({ name: "prod-db", provider: "custom", value: "admin-only-token" })).secretId;
    await withEcho(async (port, seen) => {
      expect((await call(context, "POST", "/api/workflows", builder.cookie, secretWorkflow("wf-x", "x", port, adminSecret))).statusCode).toBe(200);
      const refused = await call(context, "POST", "/api/workflows/wf-x/execute", builder.cookie, {});
      expect(refused.json<{ status: string; error: string }>()).toMatchObject({ status: "error", error: expect.stringContaining("belongs to another project") });
      expect(seen).toEqual([]);
      expect((await call(context, "GET", "/api/secrets", builder.cookie)).body).not.toContain("prod-db");
      // The one-time admin step: share the default secret to the project that uses it.
      expect((await call(context, "POST", `/api/secrets/${adminSecret}/shares`, admin.cookie, { projectId: "x" })).statusCode).toBe(200);
      expect((await call(context, "POST", "/api/workflows/wf-x/execute", builder.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer admin-only-token"]);
    });
  });

  it("role (default): default-project secrets stay usable from every project", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "x", name: "x" });
    const openSecret = (await context.secretService.createSecret({ name: "shared", provider: "custom", value: "shared-token" })).secretId;
    await withEcho(async (port, seen) => {
      await context.store.upsertWorkflow(secretWorkflow("wf-x", "x", port, openSecret));
      expect((await call(context, "POST", "/api/workflows/wf-x/execute", builder.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer shared-token"]);
    });
  });

  it("creating a secret: the given project is used, and a default-project save by default carries a warning", async () => {
    const role = await createTestContext();
    const roleBuilder = await login(role, "builder");
    await role.store.upsertProject({ id: "x", name: "x" });
    const defaulted = await call(role, "POST", "/api/secrets", roleBuilder.cookie, { name: "a", provider: "custom", value: "value-a-1234" });
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.json<{ projectId: string; warnings: string[] }>()).toMatchObject({ projectId: "default", warnings: [expect.stringContaining("every project can use")] });
    const placed = await call(role, "POST", "/api/secrets", roleBuilder.cookie, { name: "b", provider: "custom", value: "value-b-1234", projectId: "x" });
    expect(placed.json<{ projectId: string; warnings: string[] }>()).toMatchObject({ projectId: "x", warnings: [] });

    const strict = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const strictBuilder = await login(strict, "builder");
    await strict.store.upsertProject({ id: "x", name: "x" });
    await strict.store.upsertProjectRole({ userId: strictBuilder.id, projectId: "x", role: "project_admin" });
    // The UI now sends the project: saved there. Without it, the default project needs a membership.
    expect((await call(strict, "POST", "/api/secrets", strictBuilder.cookie, { name: "c", provider: "custom", value: "value-c-1234", projectId: "x" })).json<{ projectId: string }>().projectId).toBe("x");
    expect((await call(strict, "POST", "/api/secrets", strictBuilder.cookie, { name: "d", provider: "custom", value: "value-d-1234" })).statusCode).toBe(403);
  });
});

describe("project authorization: renaming and deleting projects (N3)", () => {
  it("needs project:manage: an editor gets 403, a locked-out user 404", async () => {
    const { context, builder, viewer } = await seed();
    await context.store.upsertProject({ id: "fin", name: "fin" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "fin", role: "editor" });
    await lockOut(context, viewer.id, "fin");
    await context.store.upsertWorkflow(simpleWorkflow("wf-fin", "fin"));
    expect((await call(context, "DELETE", "/api/projects/fin", builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "PUT", "/api/projects/fin", builder.cookie, { name: "renamed" })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/projects", builder.cookie, { id: "fin", name: "renamed" })).statusCode).toBe(403);
    expect((await call(context, "DELETE", "/api/projects/fin", viewer.cookie)).statusCode).toBe(403);
    expect((await context.store.getProject("fin"))!.name).toBe("fin");
    // The project's workflow stayed where it was: the locked-out viewer still cannot read it.
    expect((await call(context, "GET", "/api/workflows/wf-fin", viewer.cookie)).statusCode).toBe(404);
  });

  it("a project with workflows or secrets is not deleted; an empty one takes its memberships, roles and shares with it", async () => {
    const { context, admin, builder, viewer } = await seed();
    await context.store.upsertProject({ id: "fin", name: "fin" });
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "fin", role: "project_admin" });
    await lockOut(context, viewer.id, "fin");
    await context.store.upsertWorkflow(simpleWorkflow("wf-fin", "fin"));
    const finSecret = (await context.secretService.createSecret({ name: "fin-bank-key", provider: "custom", value: "bank", projectId: "fin" })).secretId;
    const refused = await call(context, "DELETE", "/api/projects/fin", builder.cookie);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "Move or delete this project's workflows, secrets, knowledge bases, MCP servers and eval datasets first.", workflows: 1, secrets: 1, knowledgeBases: 0, mcpServers: 0, evalDatasets: 0 });
    expect((await context.store.getWorkflow("wf-fin"))!.projectId).toBe("fin");
    expect((await context.store.getSecret(finSecret))!.projectId).toBe("fin");
    expect((await call(context, "GET", "/api/workflows/wf-fin", viewer.cookie)).statusCode).toBe(404);

    // Shares into the project, from elsewhere, go with it too.
    await context.store.upsertWorkflowShare({ workflowId: "wf-open", projectId: "fin", accessLevel: "execute" });
    const openSecret = (await context.secretService.createSecret({ name: "open", provider: "custom", value: "v" })).secretId;
    await context.store.upsertSecretShare({ secretId: openSecret, projectId: "fin" });
    expect((await call(context, "DELETE", "/api/workflows/wf-fin", builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/secrets/${finSecret}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "DELETE", "/api/projects/fin", builder.cookie)).statusCode).toBe(200);
    expect(await context.store.listProjectMembers("fin")).toEqual([]);
    expect(await context.store.getCustomRole("none-fin")).toBeFalsy();
    expect(await context.store.listWorkflowsSharedToProject("fin")).toEqual([]);
    expect(await context.store.listSecretsSharedToProject("fin")).toEqual([]);

    // Re-creating the id grants nothing from before.
    expect((await call(context, "POST", "/api/projects", admin.cookie, { id: "fin", name: "fin again" })).statusCode).toBe(200);
    expect(await context.store.listProjectMembers("fin")).toEqual([]);
  });

  it("role (default): a builder with no membership in a project can still rename and delete it", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const created = (await call(context, "POST", "/api/projects", builder.cookie, { name: "scratch" })).json<{ id: string }>();
    expect((await call(context, "PUT", `/api/projects/${created.id}`, builder.cookie, { name: "renamed" })).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/projects/${created.id}`, builder.cookie)).statusCode).toBe(200);
  });
});

describe("project authorization: execute shares (N4, N10)", () => {
  it("strict: a consumer-project editor runs an execute-shared workflow that uses its owner's secret, directly and as a sub-workflow", async () => {
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const admin = await login(context, "admin");
    const editor = await login(context, "builder", "consumer-editor");
    const consumerViewer = await login(context, "builder", "consumer-viewer");
    await context.store.upsertProject({ id: "owner", name: "owner" });
    await context.store.upsertProject({ id: "consumer", name: "consumer" });
    await context.store.upsertProjectRole({ userId: editor.id, projectId: "consumer", role: "editor" });
    await context.store.upsertProjectRole({ userId: consumerViewer.id, projectId: "consumer", role: "viewer" });
    const ownerSecret = (await context.secretService.createSecret({ name: "owner-s", provider: "custom", value: "owner-token", projectId: "owner" })).secretId;
    await withEcho(async (port, seen) => {
      await context.store.upsertWorkflow(secretWorkflow("wf-owned", "owner", port, ownerSecret));
      expect((await call(context, "POST", "/api/workflows/wf-owned/shares", admin.cookie, { projectId: "consumer", accessLevel: "execute" })).statusCode).toBe(200);
      expect((await call(context, "POST", "/api/workflows/wf-owned/execute", editor.cookie, {})).json<{ status: string }>().status).toBe("success");
      await context.store.upsertWorkflow(callerWorkflow("wf-cons", "consumer", "wf-owned"));
      expect((await call(context, "POST", "/api/workflows/wf-cons/execute", editor.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer owner-token", "Bearer owner-token"]);
      // A viewer of the consumer project can see the shared workflow but not run it.
      expect((await call(context, "GET", "/api/workflows/wf-owned", consumerViewer.cookie)).statusCode).toBe(200);
      expect((await call(context, "POST", "/api/workflows/wf-owned/execute", consumerViewer.cookie, {})).statusCode).toBe(403);
      expect(seen).toHaveLength(2);
    });
  });

  it("role: a viewer member of the target project cannot run through an execute share; an editor can", async () => {
    const { context, admin, builder, viewer } = await seed();
    // builder and viewer have viewer memberships in "ro"; share wf-hidden there with execute.
    expect((await call(context, "POST", "/api/workflows/wf-hidden/shares", admin.cookie, { projectId: "ro", accessLevel: "execute" })).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-hidden", builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/execute", builder.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-hidden/execute", viewer.cookie, {})).statusCode).toBe(403);
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "ro", role: "editor" });
    expect((await call(context, "POST", "/api/workflows/wf-hidden/execute", builder.cookie, {})).statusCode).toBe(200);
  });
});

describe("project authorization: templates need write on the source (N7)", () => {
  it("a read-only member cannot publish a project workflow as a template; an editor can", async () => {
    const { context, builder } = await seed();
    expect((await call(context, "POST", "/api/templates", builder.cookie, { name: "t", workflowId: "wf-ro" })).statusCode).toBe(403);
    await context.store.upsertProjectRole({ userId: builder.id, projectId: "ro", role: "editor" });
    expect((await call(context, "POST", "/api/templates", builder.cookie, { name: "t", workflowId: "wf-ro" })).statusCode).toBe(200);
  });
});

describe("project authorization: refused queued jobs (N6)", () => {
  it("a job whose user lost access goes straight to the dead-letter queue, with an audit event", async () => {
    const { context, builder } = await seed({ queuePollMs: 20 });
    await context.store.enqueueExecution({ id: "job-refused", workflowId: "wf-hidden", payload: { workflowId: "wf-hidden", executionId: "exec-refused", enqueuedByUserId: builder.id }, maxAttempts: 3 });
    for (let attempt = 0; attempt < 200 && !(await context.store.listDlqItems(50)).some((item) => item.originalId === "job-refused"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const dead = (await context.store.listDlqItems(50)).find((item) => item.originalId === "job-refused")!;
    expect(dead).toMatchObject({ attempts: 1, finalError: expect.stringContaining("can no longer run workflow wf-hidden") });
    const refusal = (await context.store.listAuditLogs({ eventType: "queue.job_refused", pageSize: 10 })).items;
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({ category: "workflow", outcome: "denied", resourceId: "wf-hidden" });
    expect(await context.store.getExecutionHistory("exec-refused")).toBeFalsy();
  });
});

describe("project authorization: editors create secrets (F1)", () => {
  it("role: an editor member creates a secret in their project and a workflow there uses it; a viewer member cannot; an editor cannot delete another's secret", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const editor = await login(context, "builder", "x-editor");
    const viewer = await login(context, "builder", "x-viewer");
    await context.store.upsertProject({ id: "x", name: "x" });
    await context.store.upsertProjectRole({ userId: editor.id, projectId: "x", role: "editor" });
    await context.store.upsertProjectRole({ userId: viewer.id, projectId: "x", role: "viewer" });
    const created = await call(context, "POST", "/api/secrets", editor.cookie, { name: "mine", provider: "custom", value: "editor-token", projectId: "x" });
    expect(created.statusCode).toBe(200);
    const secretId = created.json<{ id: string }>().id;
    await withEcho(async (port, seen) => {
      await context.store.upsertWorkflow(secretWorkflow("wf-x", "x", port, secretId));
      expect((await call(context, "POST", "/api/workflows/wf-x/execute", editor.cookie, {})).json<{ status: string }>().status).toBe("success");
      expect(seen).toEqual(["Bearer editor-token"]);
    });
    expect((await call(context, "POST", "/api/secrets", viewer.cookie, { name: "nope", provider: "custom", value: "viewer-token", projectId: "x" })).statusCode).toBe(403);
    const adminsId = (await call(context, "POST", "/api/secrets", admin.cookie, { name: "admins", provider: "custom", value: "admin-token", projectId: "x" })).json<{ id: string }>().id;
    expect((await call(context, "DELETE", `/api/secrets/${adminsId}`, editor.cookie)).statusCode).toBe(403);
  });

  it("strict: an editor of x creates a secret in x", async () => {
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const editor = await login(context, "builder", "x-editor");
    await context.store.upsertProject({ id: "x", name: "x" });
    await context.store.upsertProjectRole({ userId: editor.id, projectId: "x", role: "editor" });
    const created = await call(context, "POST", "/api/secrets", editor.cookie, { name: "mine", provider: "custom", value: "editor-token", projectId: "x" });
    expect(created.statusCode).toBe(200);
    expect(created.json<{ projectId: string }>().projectId).toBe("x");
  });
});

describe("project authorization: project delete strands nothing (F2)", () => {
  it("refuses while a knowledge base, MCP server or eval dataset remains, then removes variables so a re-created id starts empty", async () => {
    const context = await createTestContext({ env: { PROJECT_ISOLATION: "strict" } });
    const owner = await login(context, "builder", "fin-admin");
    const stranger = await login(context, "builder", "stranger");
    await context.store.upsertProject({ id: "fin", name: "fin" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "fin", role: "project_admin" });
    await context.store.createKnowledgeBase({ id: "kb-fin", name: "kb", projectId: "fin", embedderId: "mock" });
    await context.store.upsertVariable({ id: "var-fin", projectId: "fin", key: "BANK_URL", value: "https://internal.fin" });
    const kbRefused = await call(context, "DELETE", "/api/projects/fin", owner.cookie);
    expect(kbRefused.statusCode).toBe(409);
    expect(kbRefused.json()).toMatchObject({ workflows: 0, secrets: 0, knowledgeBases: 1, mcpServers: 0, evalDatasets: 0 });

    await context.store.deleteKnowledgeBase("kb-fin");
    await context.store.createEvalDataset({ id: "ds-fin", name: "ds", projectId: "fin" });
    expect((await call(context, "DELETE", "/api/projects/fin", owner.cookie)).json()).toMatchObject({ evalDatasets: 1 });
    await context.store.deleteEvalDataset("ds-fin");
    await context.store.createMcpServer({ id: "mcp-fin", name: "mcp", adapterId: "mock-mcp", projectId: "fin" });
    expect((await call(context, "DELETE", "/api/projects/fin", owner.cookie)).json()).toMatchObject({ mcpServers: 1 });
    await context.store.deleteMcpServer("mcp-fin");

    expect((await call(context, "DELETE", "/api/projects/fin", owner.cookie)).statusCode).toBe(200);
    expect(await context.store.listVariables("fin")).toEqual([]);
    expect((await call(context, "POST", "/api/projects", stranger.cookie, { id: "fin", name: "fin" })).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/knowledge-bases/kb-fin", stranger.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/variables?projectId=fin", stranger.cookie)).json<{ variables: unknown[] }>().variables).toEqual([]);
  });
});
