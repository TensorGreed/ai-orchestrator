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
