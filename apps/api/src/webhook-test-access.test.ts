/**
 * The test webhook URL (`/webhook-test/:path`) runs the draft, so it is for people who may edit the workflow: a
 * signed-in session or an API key (in `Authorization: Bearer`, or in `X-API-Key` when the webhook's own bearer token
 * takes the Authorization header). Anyone else, and a path that does not exist, gets the same plain 404 that lists
 * nothing. A webhook that is switched off answers as production does; the webhook's own auth still applies.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { LIVE_ENTRY_OFF_CODE, type Workflow } from "@ai-orchestrator/shared";
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
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
let isolation: "strict" | "role" = "role";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-webhook-test-access-"));
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
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, secretService, config, tempDir };
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

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer", name: string) {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  return { cookie, id: user.id, email };
}

function hookWorkflow(id: string, hookConfig: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Hook ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "team",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Hook", position: { x: 0, y: 0 }, config: { path: `orders-${id}`, method: "POST", ...hookConfig } },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "got {{webhook.customer}}" } }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  };
}

const PLAIN_404 = { error: "No webhook endpoint matches this path and method" };

async function seed() {
  const context = await createTestContext();
  const admin = await login(context, "admin", "ada");
  const owner = await login(context, "builder", "owen");
  const operator = await login(context, "operator", "olivia");
  const outsider = await login(context, "builder", "ollie");
  const viewer = await login(context, "viewer", "vera");
  await context.store.upsertProject({ id: "team", name: "Team" });
  await context.store.upsertProject({ id: "elsewhere", name: "Elsewhere" });
  await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "editor" });
  await context.store.upsertProjectRole({ userId: operator.id, projectId: "team", role: "editor" });
  await context.store.upsertProjectRole({ userId: viewer.id, projectId: "team", role: "viewer" });
  // Ollie edits in another project only: under strict isolation he cannot read the team's workflows.
  await context.store.upsertProjectRole({ userId: outsider.id, projectId: "elsewhere", role: "project_admin" });
  await context.store.upsertWorkflow(hookWorkflow("wf-a"));
  return { context, admin, owner, operator, outsider, viewer };
}

describe.each(["role", "strict"] as const)("the test webhook URL needs someone who may edit the workflow (PROJECT_ISOLATION=%s)", (mode) => {
  beforeAll(() => {
    isolation = mode;
  });
  afterAll(() => {
    isolation = "role";
  });

  it("anonymous callers, and a path that does not exist, get the same plain 404 that lists nothing", async () => {
    const { context } = await seed();
    for (const url of ["/webhook-test/orders-wf-a", "/webhook-test/no-such-hook"]) {
      const response = await context.app.inject({ method: "POST", url, payload: { customer: "Ana" } });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toEqual(PLAIN_404);
    }
    // A wrong method lists no methods either.
    const wrongMethod = await context.app.inject({ method: "GET", url: "/webhook-test/orders-wf-a" });
    expect(wrongMethod.statusCode).toBe(404);
    expect(wrongMethod.json()).toEqual(PLAIN_404);
    // No run was started.
    expect((await context.store.listExecutionHistory({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it("a signed-in editor and an API key run the draft; the same path is still listed nowhere for anyone else", async () => {
    const { context, owner, admin } = await seed();
    const bySession = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: owner.cookie }, payload: { customer: "Ana" } });
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(bySession.json<{ output: unknown }>().output).toEqual({ result: "got Ana" });

    const key = (await context.app.inject({ method: "POST", url: "/api/auth/api-keys", headers: { cookie: owner.cookie }, payload: { name: "CI" } })).json<{ key: string }>().key;
    const byKey = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { authorization: `Bearer ${key}` }, payload: { customer: "Bo" } });
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(byKey.json<{ output: unknown }>().output).toEqual({ result: "got Bo" });
    const byHeader = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { "x-api-key": key }, payload: { customer: "Cy" } });
    expect(byHeader.statusCode, byHeader.body).toBe(200);

    const byAdmin = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: admin.cookie }, payload: { customer: "Di" } });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);

    // A wrong method, for someone who may run it, names the method it takes.
    const wrongMethod = await context.app.inject({ method: "GET", url: "/webhook-test/orders-wf-a", headers: { cookie: owner.cookie } });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.json()).toMatchObject({ allowedMethods: ["POST"] });

    const bad = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { authorization: "Bearer not-a-key" }, payload: {} });
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toEqual(PLAIN_404);
  });

  it("someone who may not run it gets the plain 404; someone who may only run it is told the test URL runs the draft", async () => {
    const { context, outsider, viewer, operator } = await seed();
    const viewerCall = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: viewer.cookie }, payload: {} });
    expect(viewerCall.statusCode).toBe(404);
    expect(viewerCall.json()).toEqual(PLAIN_404);
    const outsiderCall = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: outsider.cookie }, payload: {} });
    if (mode === "strict") {
      expect(outsiderCall.statusCode).toBe(404);
      expect(outsiderCall.json()).toEqual(PLAIN_404);
    } else {
      // Role isolation lends a builder their role in every project they are not a member of.
      expect(outsiderCall.statusCode, outsiderCall.body).toBe(200);
    }
    const operatorCall = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: operator.cookie }, payload: {} });
    expect(operatorCall.statusCode).toBe(403);
    expect(operatorCall.json<{ error: string }>().error).toMatch(/runs the draft/);
  });

  it("a session call another site started is refused as missing", async () => {
    const { context, owner } = await seed();
    const response = await context.app.inject({
      method: "POST",
      url: "/webhook-test/orders-wf-a",
      headers: { cookie: owner.cookie, "sec-fetch-site": "cross-site" },
      payload: {}
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(PLAIN_404);
    // Another site's page named by Origin or Referer, or a same-site page without a studio origin: refused too.
    for (const headers of [
      { origin: "https://evil.example" },
      { referer: "https://evil.example/page" },
      { "sec-fetch-site": "same-site" },
      { origin: "null" }
    ]) {
      const refused = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: owner.cookie, ...headers }, payload: {} });
      expect(refused.statusCode, JSON.stringify(headers)).toBe(404);
    }
    expect((await context.store.listExecutionHistory({ page: 1, pageSize: 10 })).total).toBe(0);
    // The studio's own page (a WEB_ORIGIN, or this server) and a typed-in address are let through.
    for (const headers of [
      { origin: context.config.WEB_ORIGIN.split(",")[0]!.trim(), "sec-fetch-site": "same-site" },
      { referer: "http://localhost:80/editor", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" }
    ]) {
      const allowed = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: owner.cookie, ...headers }, payload: {} });
      expect(allowed.statusCode, `${JSON.stringify(headers)} ${allowed.body}`).toBe(200);
    }
  });

  it("a test URL run is recorded as started by its caller", async () => {
    const { context, owner } = await seed();
    const response = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-a", headers: { cookie: owner.cookie }, payload: { customer: "Ana" } });
    expect(response.statusCode, response.body).toBe(200);
    const runs = await context.store.listExecutionHistory({ page: 1, pageSize: 10 });
    expect(runs.items).toHaveLength(1);
    expect(await context.store.getExecutionStarter(runs.items[0]!.id)).toBe(owner.id);
  });

  it("a webhook switched off answers as production does; its own auth still applies", async () => {
    const { context, owner } = await seed();
    await context.store.upsertWorkflow(hookWorkflow("wf-off", { active: false }));
    const off = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-off", headers: { cookie: owner.cookie }, payload: {} });
    expect(off.statusCode).toBe(404);
    expect(off.json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE, error: expect.stringMatching(/turned off/) });
    // Anonymous: still the plain 404.
    expect((await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-off", payload: {} })).json()).toEqual(PLAIN_404);

    const secret = await context.secretService.createSecret({ name: "hook token", provider: "webhook", value: "tok-123", projectId: "team" });
    await context.store.upsertWorkflow(hookWorkflow("wf-bearer", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: secret }));
    const noToken = await context.app.inject({ method: "POST", url: "/webhook-test/orders-wf-bearer", headers: { cookie: owner.cookie }, payload: {} });
    expect(noToken.statusCode).toBe(401);
    const key = (await context.app.inject({ method: "POST", url: "/api/auth/api-keys", headers: { cookie: owner.cookie }, payload: { name: "CI" } })).json<{ key: string }>().key;
    const withBoth = await context.app.inject({
      method: "POST",
      url: "/webhook-test/orders-wf-bearer",
      headers: { "x-api-key": key, authorization: "Bearer tok-123" },
      payload: { customer: "Ed" }
    });
    expect(withBoth.statusCode, withBoth.body).toBe(200);
  });
});

describe.each(["role", "strict"] as const)("the production webhook URL lists nothing to anonymous callers (PROJECT_ISOLATION=%s)", (mode) => {
  beforeAll(() => {
    isolation = mode;
  });
  afterAll(() => {
    isolation = "role";
  });

  it("a missing path and a wrong method get the plain 404; a signed-in person who may run it gets the detail, for their workflows only", async () => {
    const { context, owner, outsider, viewer } = await seed();
    for (const [method, url] of [["POST", "/webhook/no-such-hook"], ["GET", "/webhook/orders-wf-a"], ["DELETE", "/webhook/orders-wf-a"]] as const) {
      const response = await context.app.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json(), `${method} ${url}`).toEqual(PLAIN_404);
    }
    // A viewer (may not run) learns nothing either.
    expect((await context.app.inject({ method: "GET", url: "/webhook/orders-wf-a", headers: { cookie: viewer.cookie } })).json()).toEqual(PLAIN_404);
    // The owner is told the methods it takes, and the endpoints she may run.
    const wrongMethod = await context.app.inject({ method: "GET", url: "/webhook/orders-wf-a", headers: { cookie: owner.cookie } });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.json()).toMatchObject({ allowedMethods: ["POST"] });
    const missing = await context.app.inject({ method: "POST", url: "/webhook/no-such-hook", headers: { cookie: owner.cookie }, payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ availableEndpoints: Array<{ workflowId: string }> }>().availableEndpoints.map((entry) => entry.workflowId)).toEqual(["wf-a"]);
    const outsiderMissing = await context.app.inject({ method: "POST", url: "/webhook/no-such-hook", headers: { cookie: outsider.cookie }, payload: {} });
    const listed = outsiderMissing.json<{ availableEndpoints?: Array<{ workflowId: string }> }>().availableEndpoints ?? [];
    expect(listed.map((entry) => entry.workflowId)).toEqual(mode === "role" ? ["wf-a"] : []);
    // The call itself still works anonymously.
    expect((await context.app.inject({ method: "POST", url: "/webhook/orders-wf-a", payload: { customer: "Ana" } })).statusCode).toBe(200);
  });

  it("a webhook switched off says so only to a caller that passes its token check; anyone else gets the plain 404", async () => {
    const { context, owner, viewer } = await seed();
    const secret = await context.secretService.createSecret({ name: "hook token", provider: "webhook", value: "tok-off", projectId: "team" });
    await context.store.upsertWorkflow(hookWorkflow("wf-off-bearer", { active: false, authMode: "bearer_token", authHeaderName: "authorization", secretRef: secret }));
    await context.store.upsertWorkflow(hookWorkflow("wf-off-open", { active: false }));
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const refused = await context.app.inject({ method: "POST", url: "/webhook/orders-wf-off-bearer", headers, payload: {} });
      expect(refused.statusCode).toBe(404);
      expect(refused.json()).toEqual(PLAIN_404);
    }
    const told = await context.app.inject({ method: "POST", url: "/webhook/orders-wf-off-bearer", headers: { authorization: "Bearer tok-off" }, payload: {} });
    expect(told.statusCode).toBe(404);
    expect(told.json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE });
    // No token to check: only a signed-in editor is told it is off; anyone else (a person who may only run it too) gets the plain 404.
    expect((await context.app.inject({ method: "POST", url: "/webhook/orders-wf-off-open", payload: {} })).json()).toEqual(PLAIN_404);
    expect((await context.app.inject({ method: "POST", url: "/webhook/orders-wf-off-open", headers: { cookie: viewer.cookie }, payload: {} })).json()).toEqual(PLAIN_404);
    expect((await context.app.inject({ method: "POST", url: "/webhook/orders-wf-off-open", headers: { cookie: owner.cookie }, payload: {} })).json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE });
    expect((await context.store.listExecutionHistory({ page: 1, pageSize: 10 })).total).toBe(0);
  });

  it("the chat endpoint: missing, no Chat trigger and switched off answer one plain 404 to all but a signed-in editor", async () => {
    const { context, owner, operator, viewer } = await seed();
    const chatWorkflow = (id: string, chatConfig: Record<string, unknown> | null): Workflow => ({
      ...hookWorkflow(id),
      nodes: [
        chatConfig === null
          ? { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} }
          : { id: "start", type: "chat_trigger", name: "Chat", position: { x: 0, y: 0 }, config: chatConfig },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }
      ],
      edges: [{ id: "e1", source: "start", target: "out" }]
    });
    await context.store.upsertWorkflow(chatWorkflow("wf-nochat", null));
    await context.store.upsertWorkflow(chatWorkflow("wf-chatoff", { active: false, authMode: "public" }));
    await context.store.upsertWorkflow(chatWorkflow("wf-chaton", { authMode: "public" }));
    const chat = (id: string, cookie?: string) =>
      context.app.inject({ method: "POST", url: `/api/chat/${id}`, headers: cookie ? { cookie } : {}, payload: { message: "hi" } });
    for (const id of ["wf-missing", "wf-nochat", "wf-chatoff"]) {
      for (const person of [null, operator, viewer]) {
        const response = await chat(id, person?.cookie);
        expect(response.statusCode, `${id} ${person?.email ?? "anonymous"}`).toBe(404);
        expect(response.json(), id).toEqual({ error: "Not found" });
      }
    }
    expect((await chat("wf-nochat", owner.cookie)).statusCode).toBe(400);
    const off = await chat("wf-chatoff", owner.cookie);
    expect(off.statusCode).toBe(404);
    expect(off.json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE });
    expect((await chat("wf-chaton")).statusCode).toBe(200);
  });

  it("an off form or MCP trigger, and an open webhook's, form's or tool's unfinished version, answer the plain 404 to all but a signed-in editor", async () => {
    const { context, owner, operator } = await seed();
    const withTrigger = (id: string, trigger: Workflow["nodes"][number]): Workflow => ({
      ...hookWorkflow(id),
      nodes: [trigger, { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }],
      edges: [{ id: "e1", source: trigger.id, target: "out" }]
    });
    await context.store.upsertWorkflow(withTrigger("wf-form-off", { id: "form", type: "form_trigger", name: "Form", position: { x: 0, y: 0 }, config: { path: "form-off", active: false, fields: [] } }));
    await context.store.upsertWorkflow(withTrigger("wf-tool-off", { id: "tool", type: "mcp_server_trigger", name: "Tool", position: { x: 0, y: 0 }, config: { path: "tool-off", toolName: "t", authMode: "public", active: false } }));
    const unfinished = hookWorkflow("wf-unfinished");
    const unfinishedNode: Workflow["nodes"][number] = { id: "http", type: "http_request", name: "HTTP", position: { x: 400, y: 0 }, config: { method: "POST" } };
    await context.store.upsertWorkflow({
      ...withTrigger("wf-form-unfinished", { id: "form", type: "form_trigger", name: "Form", position: { x: 0, y: 0 }, config: { path: "form-unfinished", fields: [] } }),
      nodes: [{ id: "form", type: "form_trigger", name: "Form", position: { x: 0, y: 0 }, config: { path: "form-unfinished", fields: [] } }, unfinishedNode],
      edges: [{ id: "e1", source: "form", target: "http" }]
    });
    await context.store.upsertWorkflow({
      ...withTrigger("wf-tool-unfinished", { id: "tool", type: "mcp_server_trigger", name: "Tool", position: { x: 0, y: 0 }, config: { path: "tool-unfinished", toolName: "u", authMode: "public" } }),
      nodes: [{ id: "tool", type: "mcp_server_trigger", name: "Tool", position: { x: 0, y: 0 }, config: { path: "tool-unfinished", toolName: "u", authMode: "public" } }, unfinishedNode],
      edges: [{ id: "e1", source: "tool", target: "http" }]
    });
    await context.store.upsertWorkflow({
      ...unfinished,
      nodes: [...unfinished.nodes, { id: "http", type: "http_request", name: "HTTP", position: { x: 400, y: 0 }, config: { method: "POST" } }],
      edges: [...unfinished.edges, { id: "e2", source: "out", target: "http" }]
    });
    const ask = (method: "GET" | "POST", url: string, cookie?: string) =>
      context.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(method === "POST" ? { payload: {} } : {}) });
    for (const cookie of [undefined, operator.cookie]) {
      expect((await ask("POST", "/api/forms/form-off", cookie)).json()).toEqual({ error: "Form not found" });
      expect((await ask("GET", "/api/forms/form-off", cookie)).body).toContain("Form not found");
      expect((await ask("GET", "/api/mcp-server/tool-off/manifest", cookie)).json()).toEqual({ error: "MCP server not found" });
      expect((await ask("POST", "/api/mcp-server/tool-off/invoke", cookie)).json()).toEqual({ error: "MCP server not found" });
      const paused = await ask("POST", "/webhook/orders-wf-unfinished", cookie);
      expect(paused.statusCode).toBe(404);
      expect(paused.json()).toEqual(PLAIN_404);
      expect((await ask("POST", "/api/forms/form-unfinished", cookie)).json()).toEqual({ error: "Form not found" });
      expect((await ask("POST", "/api/mcp-server/tool-unfinished/invoke", cookie)).json()).toEqual({ error: "MCP server not found" });
    }
    expect((await ask("POST", "/api/forms/form-unfinished", owner.cookie)).json()).toMatchObject({ code: "workflow_unfinished" });
    expect((await ask("POST", "/api/mcp-server/tool-unfinished/invoke", owner.cookie)).json()).toMatchObject({ code: "workflow_unfinished" });
    expect((await ask("POST", "/api/forms/form-off", owner.cookie)).json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE });
    expect((await ask("POST", "/api/mcp-server/tool-off/invoke", owner.cookie)).json()).toMatchObject({ code: LIVE_ENTRY_OFF_CODE });
    const told = await ask("POST", "/webhook/orders-wf-unfinished", owner.cookie);
    expect(told.statusCode).toBe(409);
    expect(told.json()).toMatchObject({ code: "workflow_unfinished" });
  });
});

