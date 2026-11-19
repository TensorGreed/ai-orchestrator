/**
 * Run routes and RBAC: a caller with workflow:execute (operators, execute shares) runs the saved workflow by id with
 * their input on /execute, /execute/stream and /api/webhooks/execute(/stream). The editor's options (start from a node,
 * one node, pinned or copied outputs, variable overrides, recording) and a graph sent with the request stay builder+.
 * Viewers are refused.
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
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-operator-runs-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
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

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function flow(id: string, projectId: string): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  };
}

/** Strict isolation: nobody but the owner (project admin), an editor and admins reaches project "team" without a share. */
async function seed() {
  const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
  const owner = await login(context, "builder", "owner");
  const operator = await login(context, "operator", "olivia");
  const viewer = await login(context, "viewer", "victor");
  const outsider = await login(context, "builder", "oscar");
  const editor = await login(context, "builder", "edith");
  await context.store.upsertProject({ id: "team", name: "Team" });
  await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
  await context.store.upsertProjectRole({ userId: editor.id, projectId: "team", role: "editor" });
  await context.store.upsertWorkflow(flow("wf-team", "team"));
  return { context, owner, operator, viewer, outsider, editor };
}


describe("runs by role", () => {
  it("an operator runs the saved workflow with their input on every run route, audited as before", async () => {
    const context = await createTestContext();
    const operator = await login(context, "operator");
    await context.store.upsertWorkflow(flow("wf-ops", "default"));

    const run = await call(context, "POST", "/api/workflows/wf-ops/execute", operator.cookie, { input: { order: 7 }, sessionId: "s1" });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json<{ status: string }>().status).toBe("success");
    const stream = await call(context, "POST", "/api/workflows/wf-ops/execute/stream", operator.cookie, { input: { order: 8 } });
    expect(stream.statusCode, stream.body).toBe(200);
    expect(stream.body).toContain("execution_started");
    const webhook = await call(context, "POST", "/api/webhooks/execute", operator.cookie, { workflow_id: "wf-ops", payload: { order: 9 } });
    expect(webhook.statusCode, webhook.body).toBe(200);
    expect(webhook.json()).toMatchObject({ selectedWorkflowId: "wf-ops" });
    const webhookStream = await call(context, "POST", "/api/webhooks/execute/stream", operator.cookie, { workflow_id: "wf-ops" });
    expect(webhookStream.statusCode, webhookStream.body).toBe(200);

    const audit = await context.store.listAuditLogs({ pageSize: 100 });
    expect(audit.items.filter((entry) => entry.eventType === "execution.started" && entry.resourceId !== null).length).toBeGreaterThanOrEqual(2);
    const access = await call(context, "GET", "/api/workflows/wf-ops/access", operator.cookie);
    expect(access.json()).toMatchObject({ canEdit: false, canRun: true });
  });

  it("refuses an operator the editor's options and a graph sent with the request", async () => {
    const context = await createTestContext();
    const operator = await login(context, "operator");
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow(flow("wf-ops", "default"));
    const graph = { ...flow("wf-ops", "default"), nodes: [] };

    for (const body of [{ startNodeId: "out" }, { runMode: "single_node" }, { usePinnedData: true }, { pinnedData: { out: [] } }, { record: true }, { workflow: graph }, { nodes: [], edges: [] }]) {
      const refused = await call(context, "POST", "/api/workflows/wf-ops/execute", operator.cookie, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(403);
      expect(refused.json<{ refusedOptions: string[] }>().refusedOptions.length).toBeGreaterThan(0);
      expect((await call(context, "POST", "/api/workflows/wf-ops/execute/stream", operator.cookie, body)).statusCode).toBe(403);
    }
    expect((await call(context, "POST", "/api/webhooks/execute", operator.cookie, { workflow_id: "wf-ops", nodes: [] })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/webhooks/execute/stream", operator.cookie, { workflow_id: "wf-ops", nodes: [] })).statusCode).toBe(403);
    // Harmless values pass (variables are input, as `input` is), and a builder keeps every option.
    expect((await call(context, "POST", "/api/workflows/wf-ops/execute", operator.cookie, { runMode: "workflow", usePinnedData: false, variables: { a: "b" } })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/webhooks/execute", operator.cookie, { workflow_id: "wf-ops", variables: { a: "b" } })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-ops/execute", builder.cookie, { usePinnedData: true, variables: { a: "b" } })).statusCode).toBe(200);
  });

  it("runs an operator's request without the workflow's pinned data, which a builder's run uses", async () => {
    const context = await createTestContext();
    const operator = await login(context, "operator");
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow({ ...flow("wf-pins", "default"), pinnedData: { out: { result: "PINNED_VALUE" } } });
    const byOperator = await call(context, "POST", "/api/workflows/wf-pins/execute", operator.cookie, { input: { a: 1 } });
    expect(byOperator.statusCode, byOperator.body).toBe(200);
    expect(byOperator.body).not.toContain("PINNED_VALUE");
    const byOperatorWebhook = await call(context, "POST", "/api/webhooks/execute", operator.cookie, { workflow_id: "wf-pins" });
    expect(byOperatorWebhook.statusCode, byOperatorWebhook.body).toBe(200);
    expect(byOperatorWebhook.body).not.toContain("PINNED_VALUE");
    const byBuilder = await call(context, "POST", "/api/workflows/wf-pins/execute", builder.cookie, { usePinnedData: true });
    expect(byBuilder.body).toContain("PINNED_VALUE");
  });

  it("still refuses viewers on every run route", async () => {
    const context = await createTestContext();
    const viewer = await login(context, "viewer");
    await context.store.upsertWorkflow(flow("wf-ops", "default"));
    expect((await call(context, "POST", "/api/workflows/wf-ops/execute", viewer.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-ops/execute/stream", viewer.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/webhooks/execute", viewer.cookie, { workflow_id: "wf-ops" })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/webhooks/execute/stream", viewer.cookie, { workflow_id: "wf-ops" })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/workflows/wf-ops/access", viewer.cookie)).json()).toMatchObject({ canRun: false });
  });

  it("strict isolation: an operator runs only with an execute share; a viewer's execute share still reads", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const operator = await login(context, "operator", "olivia");
    const viewer = await login(context, "viewer", "victor");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertWorkflow(flow("wf-team", "team"));

    expect((await call(context, "POST", "/api/workflows/wf-team/execute", operator.cookie, {})).statusCode).toBe(404);
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "read" });
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", operator.cookie, {})).statusCode).toBe(403);
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "execute" });
    const run = await call(context, "POST", "/api/workflows/wf-team/execute", operator.cookie, { input: { a: 1 } });
    expect(run.statusCode, run.body).toBe(200);
    expect((await call(context, "POST", "/api/webhooks/execute", operator.cookie, { workflow_id: "wf-team" })).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-team/access", operator.cookie)).json()).toMatchObject({ canRun: true, canEdit: false });

    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: viewer.email, accessLevel: "execute" });
    expect((await call(context, "GET", "/api/workflows/wf-team", viewer.cookie)).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", viewer.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/webhooks/execute", viewer.cookie, { workflow_id: "wf-team" })).statusCode).toBe(403);
  });
});
