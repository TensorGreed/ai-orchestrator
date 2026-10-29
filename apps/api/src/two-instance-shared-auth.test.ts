/**
 * Phase 13.1 — shared auth and per-user flow state with in-process replicas on one Postgres database (each a full app
 * with its own store and pool, cluster mode: HA_ENABLED=true): a password sign-in's TOTP step started on one instance
 * finishes on another (and only once); an MCP OAuth authorization started on one finishes on the other; two instances
 * refreshing one connection at once spend the refresh token once; an elicitation raised on one is answered through the
 * other, and a third instance starting meanwhile leaves it pending; the auth rate limit counts across instances; the
 * replay-capture daily limit holds across instances; community-node installs are refused. Postgres only (skipped
 * without TEST_POSTGRES_URL).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpElicitationView, McpOAuthConnectionStatus, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AuthService } from "./services/auth-service.js";
import { generateTotpCode } from "./services/mfa-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";
import { challengeIdHash } from "./services/challenge-store.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("shared auth and flow state across API instances");

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const REDIRECT_BASE = "https://l2m.example.test";

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// A small OAuth authorization server with a protected MCP resource
// ---------------------------------------------------------------------------

const fake = {
  base: "",
  codes: new Map<string, { challenge: string; redirectUri: string; resource: string }>(),
  tokenCounter: 0,
  currentRefreshToken: "",
  expiresIn: 3600,
  refreshDelayMs: 0,
  refreshRequests: [] as string[],
  reset() {
    this.codes.clear();
    this.tokenCounter = 0;
    this.currentRefreshToken = "";
    this.expiresIn = 3600;
    this.refreshDelayMs = 0;
    this.refreshRequests = [];
  }
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function issueTokens(): Record<string, unknown> {
  fake.tokenCounter += 1;
  const refreshToken = `rt-${fake.tokenCounter}-${crypto.randomBytes(8).toString("hex")}`;
  fake.currentRefreshToken = refreshToken;
  return { access_token: `at-${fake.tokenCounter}-${crypto.randomBytes(8).toString("hex")}`, token_type: "Bearer", expires_in: fake.expiresIn, refresh_token: refreshToken };
}

async function handleFake(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", fake.base);
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(response, 200, { resource: `${fake.base}/mcp`, authorization_servers: [`${fake.base}/auth`] });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
    return json(response, 200, {
      issuer: `${fake.base}/auth`,
      authorization_endpoint: `${fake.base}/auth/authorize`,
      token_endpoint: `${fake.base}/auth/token`,
      registration_endpoint: `${fake.base}/auth/register`,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"]
    });
  }
  if (url.pathname === "/auth/register" && request.method === "POST") {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    return json(response, 201, { client_id: "dyn-client", token_endpoint_auth_method: "none", ...body });
  }
  if (url.pathname === "/auth/authorize") {
    const code = `code-${crypto.randomBytes(8).toString("hex")}`;
    fake.codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      resource: url.searchParams.get("resource") ?? ""
    });
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    response.writeHead(302, { location: redirect.toString() });
    response.end();
    return;
  }
  if (url.pathname === "/auth/token" && request.method === "POST") {
    const params = new URLSearchParams(await readBody(request));
    if (params.get("grant_type") === "authorization_code") {
      const issued = fake.codes.get(params.get("code") ?? "");
      fake.codes.delete(params.get("code") ?? "");
      const challenge = crypto.createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
      if (!issued || issued.challenge !== challenge || issued.redirectUri !== params.get("redirect_uri")) {
        return json(response, 400, { error: "invalid_grant", error_description: "bad code exchange" });
      }
      return json(response, 200, issueTokens());
    }
    if (params.get("grant_type") === "refresh_token") {
      fake.refreshRequests.push(params.get("refresh_token") ?? "");
      // Rotation: the refresh token is valid once. A slow answer widens the window two instances could race in.
      const valid = params.get("refresh_token") === fake.currentRefreshToken;
      if (valid) fake.currentRefreshToken = "";
      if (fake.refreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, fake.refreshDelayMs));
      if (!valid) return json(response, 400, { error: "invalid_grant", error_description: "refresh token already used" });
      return json(response, 200, issueTokens());
    }
    return json(response, 400, { error: "unsupported_grant_type" });
  }
  response.writeHead(404);
  response.end();
}

let fakeServer: Server;

beforeAll(async () => {
  fakeServer = createServer((request, response) => {
    void handleFake(request, response);
  });
  await new Promise<void>((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => fakeServer.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Replicas
// ---------------------------------------------------------------------------

interface Instance {
  id: string;
  app: FastifyInstance;
  store: PostgresStore;
}

run("shared auth and flow state across API instances on one Postgres database", () => {
  let primary: TestStore | undefined;
  const instances: Instance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    fake.reset();
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function addInstance(i: number, overrides: Record<string, string> = {}): Promise<Instance> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-shared-auth-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 6 });
    await store.ensureDefaultProject();
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: MASTER_KEY,
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      WEB_ORIGIN: "http://studio.example.test",
      MCP_OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
      HA_INSTANCE_ID: `instance-${i}`,
      HA_ENABLED: "true",
      HA_RENEW_INTERVAL_MS: "100",
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "1500",
      CLUSTER_CANCEL_CHECK_MS: "0",
      ...overrides
    });
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
    await app.ready();
    const instance = { id: `instance-${i}`, app, store };
    instances.push(instance);
    return instance;
  }

  async function start(count: number, overrides: Record<string, string> = {}): Promise<Instance[]> {
    const started: Instance[] = [];
    for (let i = 0; i < count; i += 1) started.push(await addInstance(i, overrides));
    return started;
  }

  async function loginAs(instance: Instance, role: "admin" | "builder", name: string): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await instance.store.getUserByEmail(email))) await new AuthService(instance.store, 24).register({ email, password, role });
    const login = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  const call = (instance: Instance, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
    instance.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  it("a sign-in's TOTP step started on one instance finishes on another, once", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a, "admin", "mfa-admin");
    const enroll = await call(a, "POST", "/api/auth/mfa/enroll", cookie);
    const { secret } = enroll.json<{ secret: string }>();
    expect((await call(a, "POST", "/api/auth/mfa/activate", cookie, { code: generateTotpCode(secret) })).statusCode).toBe(200);

    const login = await a!.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "mfa-admin@example.com", password: "mfa-admin-Pass-123!" } });
    const challenge = login.json<{ mfaChallenge: string }>().mfaChallenge;
    expect(challenge).toMatch(/^mfa_/);
    // Stored by its hash, sealed: neither the id nor the user id is readable in the row.
    const rows = await sql<{ id_hash: string; kind: string; payload_sealed: string }>(`SELECT id_hash, kind, payload_sealed FROM pending_challenges`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id_hash: challengeIdHash(challenge), kind: "mfa_login" });
    const user = await a!.store.getUserByEmail("mfa-admin@example.com");
    expect(rows[0]!.payload_sealed).not.toContain(user!.id);
    expect(rows[0]!.payload_sealed).not.toContain(challenge);

    const finished = await b!.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge, code: generateTotpCode(secret) } });
    expect(finished.statusCode, finished.body).toBe(200);
    expect(finished.headers["set-cookie"]).toBeDefined();
    // Single use across instances: the same challenge fails everywhere afterwards.
    const replayed = await a!.app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge, code: generateTotpCode(secret) } });
    expect(replayed.statusCode).toBe(401);
    expect(await sql(`SELECT 1 FROM pending_challenges`)).toHaveLength(0);
  });

  async function registerOAuthServer(instance: Instance, cookie: string): Promise<string> {
    const response = await call(instance, "POST", "/api/mcp/servers", cookie, {
      name: "Search (OAuth)",
      adapterId: "http_mcp",
      connection: { endpoint: `${fake.base}/mcp`, transport: "http_streamable", authType: "oauth" },
      probeEnabled: false
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ server: { id: string } }>().server.id;
  }

  /** Connect on `starter`, follow the authorization URL, land on the callback on `finisher`. */
  async function connectAcross(starter: Instance, finisher: Instance, cookie: string, serverId: string) {
    const started = await call(starter, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, cookie, {});
    expect(started.statusCode, started.body).toBe(200);
    const consent = await fetch(started.json<{ authorizationUrl: string }>().authorizationUrl, { redirect: "manual" });
    const location = new URL(consent.headers.get("location") ?? "");
    const callbackUrl = `${location.pathname}${location.search}`;
    return { callbackUrl, callback: await call(finisher, "GET", callbackUrl, cookie) };
  }

  const oauthStatus = async (instance: Instance, cookie: string, serverId: string) =>
    (await call(instance, "GET", `/api/mcp/servers/${serverId}/oauth`, cookie)).json<{ status: McpOAuthConnectionStatus }>().status;

  it("an MCP OAuth authorization started on one instance completes on the other, once", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a!, "admin", "oauth-admin");
    const serverId = await registerOAuthServer(a!, cookie);
    const { callbackUrl, callback } = await connectAcross(a!, b!, cookie, serverId);
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("MCP server connected");
    expect((await oauthStatus(a!, cookie, serverId)).state).toBe("connected");
    // The PKCE verifier and client never sit in the row in clear, and the state is gone after its one use.
    const replay = await call(a!, "GET", callbackUrl, cookie);
    expect(replay.body).toContain("unknown or was already used");
  });

  it("two instances refreshing one connection at once spend the rotating refresh token once", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a!, "admin", "refresh-admin");
    const serverId = await registerOAuthServer(a!, cookie);
    expect((await connectAcross(a!, a!, cookie, serverId)).callback.statusCode).toBe(200);
    fake.refreshDelayMs = 300;
    const [one, two] = await Promise.all([
      call(a!, "POST", `/api/mcp/servers/${serverId}/oauth/refresh`, cookie),
      call(b!, "POST", `/api/mcp/servers/${serverId}/oauth/refresh`, cookie)
    ]);
    expect(one.statusCode, one.body).toBe(200);
    expect(two.statusCode, two.body).toBe(200);
    expect(fake.refreshRequests).toHaveLength(1);
    const status = await oauthStatus(b!, cookie, serverId);
    expect(status.state).toBe("connected");
    expect(status.lastError).toBeNull();
  });

  function askWorkflow(serverId: string): Workflow {
    return {
      id: "wf-ask",
      name: "Ask",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: "hook-wf-ask", method: "POST" } },
        {
          id: "tool",
          type: "mcp_tool",
          name: "Ask",
          position: { x: 200, y: 0 },
          config: { registryServerId: serverId, toolName: "ask_user", argsTemplate: JSON.stringify({ question: "Which region?", choices: ["eu", "us"] }), retry: { enabled: false } }
        },
        { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "hook", target: "tool" },
        { id: "e2", source: "tool", target: "output" }
      ]
    } as Workflow;
  }

  it("an elicitation raised on one instance is answered through another; an instance starting meanwhile leaves it pending", async () => {
    const [a, b] = await start(2);
    const admin = await loginAs(a!, "admin", "elc-admin");
    const builder = await loginAs(a!, "builder", "elc-builder");
    const created = await call(a!, "POST", "/api/mcp/servers", admin, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false });
    const serverId = created.json<{ server: { id: string } }>().server.id;
    expect((await call(a!, "POST", `/api/mcp/servers/${serverId}/probe`, admin)).statusCode).toBe(200);
    expect((await call(a!, "POST", "/api/workflows", builder, askWorkflow(serverId))).statusCode).toBeLessThan(300);

    const stream = call(a!, "POST", "/api/workflows/wf-ask/execute/stream", builder, { input: {} });
    const pending = await until(async () => (await a!.store.listMcpElicitations({ status: "pending" }))[0], "the request to wait on instance 0");
    expect(pending.holderId).toBe("instance-0");

    // A third instance starts: its boot-time cleanup must not expire a live replica's request.
    await addInstance(2);
    expect((await a!.store.getMcpElicitation(pending.id))?.status).toBe("pending");

    const answered = await call(b!, "POST", `/api/mcp/elicitations/${pending.id}/answer`, builder, { action: "accept", content: { answer: "eu" } });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json<{ elicitation: McpElicitationView }>().elicitation).toMatchObject({ status: "accepted", answeredBy: "elc-builder@example.com" });
    const response = await stream;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"answer":"eu"');
    // The bus carried the answer sealed: the holder audited it, and the stored row never holds the content.
    const audits = (await a!.store.listAuditLogs({ resourceType: "mcp_elicitation", pageSize: 20 })).items.map((entry) => entry.eventType);
    expect(audits).toContain("mcp_elicitation.accepted");
  });

  it("an answer for a request whose instance stopped expires it instead of hanging", async () => {
    const [a, b] = await start(2);
    const admin = await loginAs(a!, "admin", "gone-admin");
    // A request held by an instance that no longer beats (its registry row is gone).
    await a!.store.createMcpElicitation({
      id: "elc_gone",
      executionId: "exec_gone",
      workflowId: "wf",
      nodeId: "n",
      serverId: "s",
      toolName: "t",
      message: "m",
      requestedSchema: { type: "object", properties: {} },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: null,
      triggerType: "manual",
      holderId: "instance-stopped"
    });
    await a!.store.upsertWorkflow({ id: "wf", name: "wf", schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes: [], edges: [] } as Workflow);
    const answered = await call(b!, "POST", "/api/mcp/elicitations/elc_gone/answer", admin, { action: "decline" });
    expect(answered.statusCode, answered.body).toBe(409);
    expect((await a!.store.getMcpElicitation("elc_gone"))?.status).toBe("expired");
  });

  it("counts failed sign-ins against one auth bucket across instances", async () => {
    const [a, b] = await start(2, { RATE_LIMIT_ENABLED: "true", RATE_LIMIT_AUTH_MAX: "3", RATE_LIMIT_AUTH_WINDOW_MS: "60000" });
    const attempt = (instance: Instance) =>
      instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.com", password: "wrong-password-123" } });
    const codes = [await attempt(a!), await attempt(b!), await attempt(a!), await attempt(b!)].map((response) => response.statusCode);
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
    // The global limiter stays per instance: an unauthenticated read on either is not refused.
    expect((await a!.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("warns on /health when X-Forwarded-For arrives while TRUST_PROXY is off", async () => {
    const [a] = await start(1);
    expect((await a!.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: unknown }>().warnings).toBeUndefined();
    await a!.app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.9" } });
    const health = (await a!.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: Array<{ code: string }> }>();
    expect(health.warnings?.map((warning) => warning.code)).toContain("forwarded_for_untrusted");
  });

  it("keeps the replay-capture daily limit across instances", async () => {
    const [a, b] = await start(2);
    const builder = await loginAs(a!, "builder", "cap-builder");
    const workflow = {
      id: "wf-cap",
      name: "Capture",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "hook", type: "webhook_input", name: "hook", position: { x: 0, y: 0 }, config: { path: "hook-wf-cap", method: "POST" } },
        { id: "out", type: "output", name: "out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }
      ],
      edges: [{ id: "e1", source: "hook", target: "out" }]
    } as Workflow;
    const saved = await a!.store.upsertWorkflow(workflow);
    await new WorkflowVersionService(a!.store).snapshot({ workflow: saved, changeNote: "test" });
    const enabled = await call(a!, "PUT", "/api/workflows/wf-cap/replay-capture", builder, { enabled: true, rate: 1, maxPerDay: 2 });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const hook = (instance: Instance) => instance.app.inject({ method: "POST", url: "/webhook/hook-wf-cap", payload: {} });
    const runs = await Promise.all([a, b, a, b, a, b].map((instance) => hook(instance!)));
    expect(runs.every((response) => response.statusCode === 200)).toBe(true);
    await until(async () => (await a!.store.countReplayCapturesSince("wf-cap", new Date(Date.now() - 3_600_000).toISOString())) >= 2, "two captures");
    // Every reservation is given back once its capture is stored or dropped, and no third capture slipped in.
    await until(async () => (await a!.store.countReplayCaptureReservations("wf-cap")) === 0, "the reservations to be given back");
    expect(await a!.store.countReplayCapturesSince("wf-cap", new Date(Date.now() - 3_600_000).toISOString())).toBe(2);
  });

  it("refuses community-node installs and removals in cluster mode", async () => {
    const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-community-"));
    tempDirs.push(pluginsDir);
    const [a] = await start(1, { COMMUNITY_NODES_ENABLED: "true", COMMUNITY_NODES_DIR: pluginsDir, COMMUNITY_NODES_ALLOWLIST: "l2m-nodes-other" });
    const admin = await loginAs(a!, "admin", "community-admin");
    const install = await call(a!, "POST", "/api/community-nodes/install", admin, { packageSpec: "l2m-nodes-example" });
    expect(install.statusCode).toBe(409);
    expect(install.json<{ error: string; code: string }>()).toMatchObject({ code: "community_nodes_cluster_mode", error: expect.stringContaining("shared volume") });
    expect((await call(a!, "DELETE", "/api/community-nodes/l2m-nodes-example", admin)).statusCode).toBe(409);
    const listed = await call(a!, "GET", "/api/community-nodes", admin);
    expect(listed.json<{ installAllowed: boolean }>().installAllowed).toBe(false);
  });
});
