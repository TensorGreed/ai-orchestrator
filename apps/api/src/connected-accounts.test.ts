/**
 * Connected accounts end to end against the local mock provider (never a real one): an admin sets up the OAuth app,
 * a builder connects in a "popup" (the redirects followed by hand), a workflow uses the account, its token is renewed
 * before expiry and after a 401, a refused refresh asks for a reconnect, reconnect keeps the secret id, and disconnect
 * revokes. No API response, audit entry or run record carries a token or the client secret.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { startMockOAuthProvider, type MockOAuthProvider } from "./fixtures/mock-oauth-provider.js";
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
let mock: MockOAuthProvider;

beforeAll(async () => {
  mock = await startMockOAuthProvider();
});
afterAll(async () => {
  await mock.close();
});

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-connect-"));
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
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    APP_PUBLIC_URL: "https://l2m.example.test",
    CONNECTED_ACCOUNTS_TEST_PROVIDER_URL: mock.url,
    ...env
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
  mock.control({ accessTtl: 3600, refuseRefresh: false, client: { id: "l2m-test-client", secret: "l2m-test-secret" } });
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
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie for ${name}`);
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function setUpApp(context: TestContext, admin: { cookie: string }, providerId = "slack", projectId: string | null = null) {
  const response = await call(context, "PUT", `/api/connect/providers/${providerId}/app`, admin.cookie, {
    projectId,
    clientId: "l2m-test-client",
    clientSecret: "l2m-test-secret"
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Start, follow the provider's redirect, and land on the callback with `cookie`. */
async function connect(context: TestContext, cookie: string, providerId = "slack", body: Record<string, unknown> = {}, callbackCookie = cookie) {
  const started = await call(context, "POST", `/api/connect/${providerId}/start`, cookie, body);
  expect(started.statusCode, started.body).toBe(200);
  const { authorizationUrl } = started.json() as { authorizationUrl: string };
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  const location = new URL(consent.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("https://l2m.example.test/api/connect/callback");
  const callback = await context.app.inject({ method: "GET", url: `${location.pathname}${location.search}`, headers: { cookie: callbackCookie } });
  return { started, location, callback };
}

function runWorkflow(secretId: string): Workflow {
  return {
    id: "wf-connected",
    name: "Use a connected account",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
      {
        id: "http",
        type: "http_request",
        name: "Who am I",
        position: { x: 200, y: 0 },
        config: { method: "GET", urlTemplate: `${mock.url}/resource/whoami`, secretRef: { secretId }, secretAuth: { type: "connected" }, failOnHttpError: true }
      },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "in", target: "http" },
      { id: "e2", source: "http", target: "out" }
    ]
  };
}

async function executeAs(context: TestContext, cookie: string, workflow: Workflow) {
  const saved = await call(context, "POST", "/api/workflows", cookie, workflow);
  expect(saved.statusCode, saved.body).toBeLessThan(300);
  return await call(context, "POST", `/api/workflows/${workflow.id}/execute`, cookie, {});
}

describe("connected accounts", () => {
  it("shows each provider's exact redirect URL and setup steps, and who may set up an app", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const listed = await call(context, "GET", "/api/connect/providers", builder.cookie);
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { redirectUrl: string; providers: Array<{ id: string; configured: boolean; setupSteps: string[]; canConfigureInstance: boolean }> };
    expect(body.redirectUrl).toBe("https://l2m.example.test/api/connect/callback");
    expect(body.providers.map((provider) => provider.id).sort()).toEqual(["github", "google", "microsoft", "notion", "slack"]);
    expect(body.providers.every((provider) => !provider.configured && !provider.canConfigureInstance)).toBe(true);
    expect(body.providers.find((provider) => provider.id === "slack")!.setupSteps.join(" ")).toContain("https://l2m.example.test/api/connect/callback");

    // A builder may not set up the instance's app; an admin may, and the secret is never echoed.
    const refused = await call(context, "PUT", "/api/connect/providers/slack/app", builder.cookie, { projectId: null, clientId: "x", clientSecret: "y" });
    expect(refused.statusCode).toBe(403);
    const saved = await call(context, "PUT", "/api/connect/providers/slack/app", admin.cookie, { projectId: null, clientId: "l2m-test-client", clientSecret: "l2m-test-secret" });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain("l2m-test-secret");
    const after = (await call(context, "GET", "/api/connect/providers", builder.cookie)).json() as typeof body;
    expect(after.providers.find((provider) => provider.id === "slack")).toMatchObject({ configured: true, appScope: "instance", clientId: "l2m-test-client" });
    // The client secret is an internal secret: not in the secrets list, not resolvable.
    const secrets = (await call(context, "GET", "/api/secrets", admin.cookie)).json() as Array<{ provider: string }>;
    expect(secrets.some((secret) => secret.provider === "oauth_client")).toBe(false);
    // A project's own app wins over the instance's (secret:write in the project; a builder has it in default).
    const project = await call(context, "PUT", "/api/connect/providers/slack/app", builder.cookie, { projectId: "default", clientId: "project-client", clientSecret: "s" });
    expect(project.statusCode).toBe(200);
    const projectView = (await call(context, "GET", "/api/connect/providers?projectId=default", builder.cookie)).json() as typeof body;
    expect(projectView.providers.find((provider) => provider.id === "slack")).toMatchObject({ appScope: "project", clientId: "project-client" });
  });

  it("connects with PKCE and state, saves a secret that shows the account but never a token, and refuses a second use of the state", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await setUpApp(context, admin);
    const { callback, location } = await connect(context, builder.cookie);
    expect(callback.statusCode, callback.body).toBe(200);
    expect(callback.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    expect(callback.body).toContain("l2m:oauth-account");
    expect(callback.body).toContain("Mock Workspace");
    expect(callback.body).not.toMatch(/at-slack-|rt-slack-/);
    // The authorization request carried PKCE (S256), state and the default scopes.
    const authorization = mock.authorizations.at(-1)!;
    expect(authorization).toMatchObject({ code_challenge_method: "S256", scope: "chat:write,chat:write.public", client_id: "l2m-test-client" });
    expect(authorization.state).toBe(location.searchParams.get("state"));

    const secrets = (await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ id: string; name: string; provider: string; connection?: Record<string, unknown> }>;
    const account = secrets.find((secret) => secret.provider === "oauth_account")!;
    expect(account.name).toBe("Slack · Mock Workspace");
    expect(account.connection).toMatchObject({ providerId: "slack", accountLabel: "Mock Workspace", status: "connected", refreshable: true, scopes: ["chat:write", "chat:write.public"] });
    expect(JSON.stringify(secrets)).not.toMatch(/at-slack-|rt-slack-/);
    const detail = await call(context, "GET", `/api/connect/accounts/${account.id}`, builder.cookie);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toMatch(/at-slack-|rt-slack-/);

    // The same callback again: the state is used up.
    const replay = await context.app.inject({ method: "GET", url: `${location.pathname}${location.search}`, headers: { cookie: builder.cookie } });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toMatch(/unknown or was already used/);

    // Nothing in the audit log carries a token, and the connect is recorded.
    const audit = await call(context, "GET", "/api/audit?limit=200", admin.cookie);
    expect(audit.body).toContain("oauth_account.connected");
    expect(audit.body).not.toMatch(/at-slack-|rt-slack-|l2m-test-secret/);
  });

  it("finishes only in the session and for the user that started it, and never with a secrets-API-made account", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const other = await login(context, "builder", "other");
    await setUpApp(context, admin);
    const { callback } = await connect(context, builder.cookie, "slack", {}, other.cookie);
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toMatch(/started by another session/);
    const anonymous = await connect(context, builder.cookie, "slack", {}, "");
    expect(anonymous.callback.statusCode).toBe(400);
    expect(anonymous.callback.body).toMatch(/Sign in to L2M/);
    const secrets = (await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ provider: string }>;
    expect(secrets.some((secret) => secret.provider === "oauth_account")).toBe(false);
    // Nobody makes an account through the secrets API.
    const forged = await call(context, "POST", "/api/secrets", admin.cookie, { name: "fake", provider: "oauth_account", value: '{"version":1}' });
    expect(forged.statusCode).toBe(400);
    // A viewer cannot start a connection; nothing is set up for GitHub yet.
    const viewer = await login(context, "viewer");
    expect((await call(context, "POST", "/api/connect/slack/start", viewer.cookie, {})).statusCode).toBe(403);
    const unset = await call(context, "POST", "/api/connect/github/start", builder.cookie, {});
    expect(unset.statusCode).toBe(409);
    expect(unset.json().error).toMatch(/not set up yet/);
  });

  it("hands runs the access token, renews it before expiry and after a 401, and asks for a reconnect when the provider refuses", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await setUpApp(context, admin, "google");
    await connect(context, builder.cookie, "google", { scopeSets: ["sheets", "gmail"] });
    const scope = mock.authorizations.at(-1)!.scope!.split(" ");
    expect(scope).toEqual(expect.arrayContaining(["openid", "email", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/gmail.send"]));
    expect(mock.authorizations.at(-1)).toMatchObject({ access_type: "offline", prompt: "consent" });
    const secrets = (await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ id: string; provider: string; connection?: { accountLabel: string } }>;
    const account = secrets.find((secret) => secret.provider === "oauth_account")!;
    expect(account.connection!.accountLabel).toBe("person@mock.example");

    const first = await executeAs(context, builder.cookie, runWorkflow(account.id));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe("success");
    expect(first.body).not.toMatch(/at-google-|rt-google-/);

    // The provider stops accepting the token: the run gets a 401, renews once and succeeds.
    const refreshesBefore = mock.stats.refreshes;
    mock.control({ expireAccess: true });
    const second = await executeAs(context, builder.cookie, runWorkflow(account.id));
    expect(second.json().status, second.body).toBe("success");
    expect(mock.stats.refreshes).toBe(refreshesBefore + 1);

    // A token that is due is renewed before it is used (Refresh now shows the new expiry).
    mock.control({ accessTtl: 30 });
    const refreshed = await call(context, "POST", `/api/connect/accounts/${account.id}/refresh`, builder.cookie);
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.body).not.toMatch(/at-google-|rt-google-/);
    const beforeDue = mock.stats.refreshes;
    const third = await executeAs(context, builder.cookie, runWorkflow(account.id));
    expect(third.json().status).toBe("success");
    expect(mock.stats.refreshes).toBe(beforeDue + 1); // 30 s left is inside the 60 s refresh margin

    // The provider refuses the refresh token: the account needs reconnecting and the run says so plainly.
    mock.control({ refuseRefresh: true });
    const failed = await executeAs(context, builder.cookie, runWorkflow(account.id));
    expect(failed.json().status).toBe("error");
    expect(failed.body).toMatch(/needs to be reconnected/);
    const view = (await call(context, "GET", `/api/connect/accounts/${account.id}`, builder.cookie)).json() as { connection: { status: string; lastError: string } };
    expect(view.connection.status).toBe("needs_reconnect");
    const audit = await call(context, "GET", "/api/audit?limit=200", admin.cookie);
    expect(audit.body).toContain("oauth_account.refresh_failed");

    // Reconnect: the same secret id, connected again, and the workflow works unchanged.
    mock.control({ refuseRefresh: false, accessTtl: 3600 });
    const again = await connect(context, builder.cookie, "google", { reconnectSecretId: account.id });
    expect(again.callback.statusCode, again.callback.body).toBe(200);
    const after = (await call(context, "GET", `/api/connect/accounts/${account.id}`, builder.cookie)).json() as { connection: { status: string } };
    expect(after.connection.status).toBe("connected");
    expect((await executeAs(context, builder.cookie, runWorkflow(account.id))).json().status).toBe("success");
    const list = (await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ provider: string }>;
    expect(list.filter((secret) => secret.provider === "oauth_account")).toHaveLength(1);
  });

  it("renews a connected-account token only for the run's own secrets, not for a token typed into a header", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await setUpApp(context, admin);
    await connect(context, builder.cookie);
    const workflow = runWorkflow("sec_none");
    const node = workflow.nodes[1]!;
    // No secret: the request carries a stale token by hand. A 401 stands; nothing is renewed.
    node.config = { method: "GET", urlTemplate: `${mock.url}/resource/whoami`, headersTemplate: '{"Authorization":"Bearer expired-at-slack-1"}', failOnHttpError: true };
    const before = mock.stats.refreshes;
    mock.control({ expireAccess: true });
    const run = await executeAs(context, builder.cookie, workflow);
    expect(run.json().status).toBe("error");
    expect(mock.stats.refreshes).toBe(before);
  });

  it("disconnects: revokes at the provider, deletes the secret, and refuses people without secret:write", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await setUpApp(context, admin);
    await connect(context, builder.cookie);
    const account = ((await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ id: string; provider: string }>).find((secret) => secret.provider === "oauth_account")!;
    const viewer = await login(context, "viewer");
    expect((await call(context, "DELETE", `/api/connect/accounts/${account.id}`, viewer.cookie)).statusCode).toBe(403);
    const revocations = mock.stats.revocations;
    const removed = await call(context, "DELETE", `/api/connect/accounts/${account.id}`, builder.cookie);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ ok: true, revoked: true });
    expect(mock.stats.revocations).toBe(revocations + 1);
    expect(await context.store.getOAuthAccount(account.id)).toBeNull();
    expect(await context.store.getSecret(account.id)).toBeNull();
    const audit = await call(context, "GET", "/api/audit?limit=200", admin.cookie);
    expect(audit.body).toContain("oauth_account.disconnected");
    // Deleting through the secrets page does the same.
    await connect(context, builder.cookie);
    const second = ((await call(context, "GET", "/api/secrets", builder.cookie)).json() as Array<{ id: string; provider: string }>).find((secret) => secret.provider === "oauth_account")!;
    expect((await call(context, "DELETE", `/api/secrets/${second.id}`, builder.cookie)).statusCode).toBe(200);
    expect(await context.store.getOAuthAccount(second.id)).toBeNull();
    expect(mock.stats.revocations).toBe(revocations + 2);
  });

  it("refuses a test provider URL that is not loopback, and an APP_PUBLIC_URL with a query", () => {
    const base = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };
    expect(() => parseConfig({ ...base, CONNECTED_ACCOUNTS_TEST_PROVIDER_URL: "https://mock.example.com" })).toThrow(/loopback/);
    expect(parseConfig({ ...base, CONNECTED_ACCOUNTS_TEST_PROVIDER_URL: "http://127.0.0.1:4532" }).CONNECTED_ACCOUNTS_TEST_PROVIDER_URL).toBe("http://127.0.0.1:4532");
    expect(() => parseConfig({ ...base, APP_PUBLIC_URL: "https://l2m.example.com/?next=x" })).toThrow(/plain base URL/);
    expect(parseConfig({ ...base, APP_PUBLIC_URL: "https://l2m.example.com/l2m" }).APP_PUBLIC_URL).toBe("https://l2m.example.com/l2m");
  });
});
