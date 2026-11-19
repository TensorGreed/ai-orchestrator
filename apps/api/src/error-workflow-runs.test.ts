/**
 * An error workflow's run is recorded like any other run (the validation found none in Runs, so a working handler
 * looked broken): trigger type `error`, linked to the failed run both ways, owned by whoever owns the failed run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { errorWorkflowRunId } from "./error-workflow-run.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(isolation: "role" | "strict"): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-error-runs-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    PROJECT_ISOLATION: isolation,
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
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

interface Person {
  cookie: string;
  id: string;
  email: string;
}

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer", name: string): Promise<Person> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie for ${name}`);
  return { cookie: cookie.split(";")[0]!, id: user.id, email };
}

const call = (context: TestContext, method: "GET" | "POST", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const position = { x: 0, y: 0 };

/** Fails at its second node (a sub-workflow that does not exist); its error workflow is `handlerId`. */
function failingWorkflow(id: string, handlerId: string, projectId = "default"): Workflow {
  return {
    id,
    name: `Fails ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    settings: { errorWorkflowId: handlerId },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position, config: {} },
      { id: "sub", type: "execute_workflow", name: "Missing", position, config: { workflowId: "does-not-exist" } },
      { id: "out", type: "output", name: "Out", position, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ]
  } as Workflow;
}

/** Error Trigger → Output naming the failed workflow; `alsoFails` makes it fail too (with itself as its error workflow). */
function handlerWorkflow(id: string, options: { alsoFails?: boolean; projectId?: string } = {}): Workflow {
  return {
    id,
    name: `Handler ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: options.projectId ?? "default",
    ...(options.alsoFails ? { settings: { errorWorkflowId: id } } : {}),
    nodes: [
      { id: "trigger", type: "error_trigger", name: "On error", position, config: {} },
      ...(options.alsoFails
        ? [{ id: "sub", type: "execute_workflow", name: "Missing", position, config: { workflowId: "does-not-exist" } }]
        : []),
      { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "{{source_workflow_name}} failed", outputKey: "result" } }
    ],
    edges: options.alsoFails
      ? [
          { id: "e1", source: "trigger", target: "sub" },
          { id: "e2", source: "sub", target: "out" }
        ]
      : [{ id: "e1", source: "trigger", target: "out" }]
  } as Workflow;
}

type RunRow = { id: string; workflowId: string; status: string; triggerType: string | null };

const runsOf = async (context: TestContext, person: Person, workflowId: string): Promise<RunRow[]> => {
  const response = await call(context, "GET", `/api/executions?workflowId=${workflowId}`, person.cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ items: RunRow[] }>().items;
};

async function runAndWaitForHandler(context: TestContext, person: Person, workflowId: string, handlerId: string) {
  const failed = await call(context, "POST", `/api/workflows/${workflowId}/execute`, person.cookie, {});
  // A failed run answers 400 with the run.
  expect(failed.statusCode, failed.body).toBe(400);
  const failedRun = failed.json<{ executionId: string; status: string }>();
  expect(failedRun.status).toBe("error");
  const errorRunId = errorWorkflowRunId(failedRun.executionId);
  await vi.waitFor(async () => expect((await context.store.getExecutionHistory(errorRunId))?.completedAt).toBeTruthy(), { timeout: 10_000 });
  return { failedRunId: failedRun.executionId, errorRunId, handlerId };
}

describe("an error workflow's run", () => {
  it("is recorded in Runs with trigger type error, linked to the failed run both ways", async () => {
    const context = await createTestContext("role");
    const admin = await login(context, "admin", "ada");
    await context.store.upsertWorkflow(handlerWorkflow("wf-handler"));
    await context.store.upsertWorkflow(failingWorkflow("wf-fails", "wf-handler"));
    const { failedRunId, errorRunId } = await runAndWaitForHandler(context, admin, "wf-fails", "wf-handler");

    const handlerRuns = await runsOf(context, admin, "wf-handler");
    expect(handlerRuns).toEqual([expect.objectContaining({ id: errorRunId, status: "success", triggerType: "error" })]);
    const errorRun = (await call(context, "GET", `/api/executions/${errorRunId}`, admin.cookie)).json<Record<string, any>>();
    expect(errorRun.output).toEqual({ result: "Fails wf-fails failed" });
    expect(errorRun.input).toMatchObject({ executionId: failedRunId, sourceWorkflowId: "wf-fails", sourceWorkflowName: "Fails wf-fails" });
    expect(errorRun.errorWorkflowSource).toEqual({ executionId: failedRunId, workflowId: "wf-fails", workflowName: "Fails wf-fails", status: "error" });

    const failedRun = (await call(context, "GET", `/api/executions/${failedRunId}`, admin.cookie)).json<Record<string, any>>();
    expect(failedRun.errorWorkflowRun).toEqual({ executionId: errorRunId, workflowId: "wf-handler", workflowName: "Handler wf-handler", status: "success" });
    // The trigger type filter finds error workflow runs.
    const filtered = (await call(context, "GET", "/api/executions?triggerType=error", admin.cookie)).json<{ items: RunRow[] }>().items;
    expect(filtered.map((row) => row.id)).toEqual([errorRunId]);
  });

  it("belongs to whoever owns the failed run: someone with the workflows only through a share sees their own", async () => {
    const context = await createTestContext("strict");
    const owner = await login(context, "builder", "owen");
    const olivia = await login(context, "operator", "olivia");
    const gus = await login(context, "builder", "gus");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertWorkflow(handlerWorkflow("wf-handler", { projectId: "team" }));
    await context.store.upsertWorkflow(failingWorkflow("wf-fails", "wf-handler", "team"));
    for (const workflowId of ["wf-fails", "wf-handler"]) {
      for (const person of [olivia, gus]) {
        const shared = await call(context, "POST", `/api/workflows/${workflowId}/user-shares`, owner.cookie, { email: person.email, accessLevel: "execute" });
        expect(shared.statusCode, shared.body).toBeLessThan(300);
      }
    }
    const ownerRuns = await runAndWaitForHandler(context, owner, "wf-fails", "wf-handler");
    const oliviaRuns = await runAndWaitForHandler(context, olivia, "wf-fails", "wf-handler");

    expect(await context.store.getExecutionStarter(oliviaRuns.errorRunId)).toBe(olivia.id);
    expect((await runsOf(context, olivia, "wf-handler")).map((row) => row.id)).toEqual([oliviaRuns.errorRunId]);
    expect(await runsOf(context, gus, "wf-handler")).toEqual([]);
    expect((await runsOf(context, owner, "wf-handler")).map((row) => row.id).sort()).toEqual([ownerRuns.errorRunId, oliviaRuns.errorRunId].sort());
    // Someone else's error run answers 404, and her failed run does not name the owner's.
    expect((await call(context, "GET", `/api/executions/${ownerRuns.errorRunId}`, olivia.cookie)).statusCode).toBe(404);
    const hers = (await call(context, "GET", `/api/executions/${oliviaRuns.failedRunId}`, olivia.cookie)).json<Record<string, any>>();
    expect(hers.errorWorkflowRun).toMatchObject({ executionId: oliviaRuns.errorRunId });
  });

  it("an error workflow that fails starts no further error run", async () => {
    const context = await createTestContext("role");
    const admin = await login(context, "admin", "ada");
    await context.store.upsertWorkflow(handlerWorkflow("wf-handler", { alsoFails: true }));
    await context.store.upsertWorkflow(failingWorkflow("wf-fails", "wf-handler"));
    const { errorRunId } = await runAndWaitForHandler(context, admin, "wf-fails", "wf-handler");
    expect((await context.store.getExecutionHistory(errorRunId))?.status).toBe("error");
    // Give a second error run time to appear, were one started.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await runsOf(context, admin, "wf-handler")).map((row) => row.id)).toEqual([errorRunId]);
    expect(await context.store.getExecutionHistory(errorWorkflowRunId(errorRunId))).toBeNull();
  });

  it("stays an error workflow run after it pauses for an approval and resumes, and its failure then starts no other error run", async () => {
    const context = await createTestContext("role");
    const admin = await login(context, "admin", "ada");
    const handler = handlerWorkflow("wf-handler", { alsoFails: true });
    handler.nodes.splice(1, 0, { id: "ask", type: "human_approval", name: "Approve", position, config: { approvalMessage: "Handle it?", timeoutMinutes: 30 } } as Workflow["nodes"][number]);
    handler.edges = [
      { id: "e0", source: "trigger", target: "ask" },
      { id: "e1", source: "ask", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ];
    await context.store.upsertWorkflow(handler);
    await context.store.upsertWorkflow(failingWorkflow("wf-fails", "wf-handler"));
    const failed = await call(context, "POST", "/api/workflows/wf-fails/execute", admin.cookie, {});
    const failedRunId = failed.json<{ executionId: string }>().executionId;
    const errorRunId = errorWorkflowRunId(failedRunId);
    await vi.waitFor(async () => expect((await context.store.getExecutionHistory(errorRunId))?.status).toBe("waiting_approval"), { timeout: 10_000 });
    const approved = await call(context, "POST", `/api/approvals/${errorRunId}/approve`, admin.cookie, {});
    // The resumed run fails, so the approval answers 400 with it, as a failed execute does.
    expect(approved.statusCode, approved.body).toBe(400);
    await vi.waitFor(async () => expect((await context.store.getExecutionHistory(errorRunId))?.status).toBe("error"), { timeout: 10_000 });

    const errorRun = (await call(context, "GET", `/api/executions/${errorRunId}`, admin.cookie)).json<Record<string, any>>();
    expect(errorRun.triggerType).toBe("error");
    expect(errorRun.errorWorkflowSource).toMatchObject({ executionId: failedRunId });
    const failedRun = (await call(context, "GET", `/api/executions/${failedRunId}`, admin.cookie)).json<Record<string, any>>();
    expect(failedRun.errorWorkflowRun).toMatchObject({ executionId: errorRunId, status: "error" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await context.store.getExecutionHistory(errorWorkflowRunId(errorRunId))).toBeNull();
  });
});
