/**
 * Phase 10.5 — OAuth 2.1 for remote MCP servers, end to end against a fake
 * authorization server and a protected MCP resource (node:http): 401 →
 * protected resource metadata → authorization server metadata → dynamic
 * client registration → authorization URL (PKCE S256, state, resource) →
 * callback → token → authenticated tools/list and tools/call; refresh before
 * expiry and on 401; state replay, expiry and session binding; RBAC; and no
 * token in any API response, audit row or log line. Also covers progress
 * streaming to the run's SSE stream and annotation policy rules over the API.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpOAuthConnectionStatus } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

// ---------------------------------------------------------------------------
// Fake authorization server + protected MCP resource
// ---------------------------------------------------------------------------

interface IssuedCode {
  challenge: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string | null;
}

const fake = {
  base: "",
  registrations: [] as Array<Record<string, unknown>>,
  authorizeRequests: [] as URLSearchParams[],
  tokenRequests: [] as URLSearchParams[],
  codes: new Map<string, IssuedCode>(),
  validAccessTokens: new Set<string>(),
  currentRefreshToken: "",
  tokenCounter: 0,
  expiresIn: 3600,
  mcpAuthHeaders: [] as string[],
  reset() {
    this.registrations = [];
    this.authorizeRequests = [];
    this.tokenRequests = [];
    this.codes.clear();
    this.validAccessTokens.clear();
    this.currentRefreshToken = "";
    this.tokenCounter = 0;
    this.expiresIn = 3600;
    this.mcpAuthHeaders = [];
  }
};

/** Every token value the fake server ever issued, to search responses and logs for. */
const issuedSecrets = new Set<string>();

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });
}

/** client_secret_basic: the client id from the Authorization header. */
function basicClientId(request: IncomingMessage): string | null {
  const header = request.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decodeURIComponent(decoded.split(":")[0] ?? "");
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

function issueTokens(): Record<string, unknown> {
  fake.tokenCounter += 1;
  const accessToken = `at-${fake.tokenCounter}-${crypto.randomBytes(12).toString("hex")}`;
  const refreshToken = `rt-${fake.tokenCounter}-${crypto.randomBytes(12).toString("hex")}`;
  issuedSecrets.add(accessToken);
  issuedSecrets.add(refreshToken);
  fake.validAccessTokens.add(accessToken);
  fake.currentRefreshToken = refreshToken;
  const idClaims = Buffer.from(JSON.stringify({ sub: "u-1", email: "ops@example.com" })).toString("base64url");
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: fake.expiresIn,
    refresh_token: refreshToken,
    scope: "tools:read tools:write",
    id_token: `e30.${idClaims}.sig`
  };
}

const MCP_TOOLS = [
  {
    name: "weather",
    description: "Current weather",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    outputSchema: { type: "object", properties: { temperature: { type: "number" } }, required: ["temperature"] },
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Weather" }
  },
  {
    name: "slow_index",
    description: "Reports progress",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true }
  },
  {
    name: "drop_index",
    description: "Destroys an index",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true }
  }
];

async function handleFake(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", fake.base);
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return json(response, 200, { resource: `${fake.base}/mcp`, authorization_servers: [`${fake.base}/auth`], scopes_supported: ["tools:read", "tools:write"] });
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
    fake.registrations.push(body);
    return json(response, 201, { client_id: `dyn-client-${fake.registrations.length}`, token_endpoint_auth_method: "none", ...body });
  }
  if (url.pathname === "/auth/authorize") {
    fake.authorizeRequests.push(url.searchParams);
    const code = `code-${crypto.randomBytes(8).toString("hex")}`;
    fake.codes.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      clientId: url.searchParams.get("client_id") ?? "",
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      resource: url.searchParams.get("resource") ?? "",
      scope: url.searchParams.get("scope")
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
    fake.tokenRequests.push(params);
    if (params.get("grant_type") === "authorization_code") {
      const issued = fake.codes.get(params.get("code") ?? "");
      fake.codes.delete(params.get("code") ?? "");
      const verifier = params.get("code_verifier") ?? "";
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (
        !issued ||
        issued.challenge !== challenge ||
        issued.clientId !== (params.get("client_id") ?? basicClientId(request)) ||
        issued.redirectUri !== params.get("redirect_uri") ||
        issued.resource !== params.get("resource")
      ) {
        return json(response, 400, { error: "invalid_grant", error_description: "bad code exchange" });
      }
      return json(response, 200, issueTokens());
    }
    if (params.get("grant_type") === "refresh_token") {
      if (params.get("refresh_token") !== fake.currentRefreshToken || params.get("resource") !== `${fake.base}/mcp`) {
        return json(response, 400, { error: "invalid_grant", error_description: "refresh token is not valid" });
      }
      return json(response, 200, issueTokens());
    }
    return json(response, 400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/mcp") {
    const body = await readBody(request);
    const auth = request.headers.authorization ?? "";
    fake.mcpAuthHeaders.push(auth);
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!fake.validAccessTokens.has(token)) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${fake.base}/.well-known/oauth-protected-resource/mcp", scope="tools:read"`
      });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: Record<string, unknown> };
    if (rpc.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (rpc.method === "initialize") return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    if (rpc.method === "tools/list") return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: { tools: MCP_TOOLS } });
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      if (name === "slow_index") {
        const token = (rpc.params?._meta as { progressToken?: string } | undefined)?.progressToken;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, total: 5, message: "indexing shards" } })}\n\n`);
        setTimeout(() => {
          response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "indexed" }] } })}\n\n`);
        }, 20);
        return;
      }
      return json(response, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: '{"temperature":12}' }], structuredContent: { temperature: 12 } }
      });
    }
    return json(response, 200, { jsonrpc: "2.0", id: rpc.id, result: {} });
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
// L2M test context
// ---------------------------------------------------------------------------

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const REDIRECT_BASE = "https://l2m.example.test";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-oauth-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "info",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    WEB_ORIGIN: "http://studio.example.test",
    MCP_OAUTH_REDIRECT_BASE_URL: REDIRECT_BASE,
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  vi.restoreAllMocks();
  fake.reset();
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

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Cookie '${cookieName}' was not set`);
  return cookie.split(";")[0];
}

async function login(context: TestContext, role: "admin" | "builder" | "operator", name: string = role): Promise<string> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  return extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

/** Every response body the test saw, checked for tokens at the end. */
const seenBodies: string[] = [];

async function call(
  context: TestContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie: string,
  payload?: unknown
) {
  const response = await context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  seenBodies.push(response.body);
  return response;
}

async function registerOAuthServer(context: TestContext, adminCookie: string, extraConnection: Record<string, unknown> = {}) {
  const response = await call(context, "POST", "/api/mcp/servers", adminCookie, {
    name: "Search (OAuth)",
    adapterId: "http_mcp",
    connection: { endpoint: `${fake.base}/mcp`, transport: "http_streamable", authType: "oauth", ...extraConnection },
    probeEnabled: false
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ server: { id: string } }>().server.id;
}

/** Connect → follow the authorization URL → land on the callback with the admin's cookie. */
async function connect(context: TestContext, adminCookie: string, serverId: string) {
  const started = await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, adminCookie, {});
  expect(started.statusCode).toBe(200);
  const { authorizationUrl } = started.json<{ authorizationUrl: string }>();
  const consent = await fetch(authorizationUrl, { redirect: "manual" });
  expect(consent.status).toBe(302);
  const location = new URL(consent.headers.get("location") ?? "");
  const callbackUrl = `${location.pathname}${location.search}`;
  const callback = await call(context, "GET", callbackUrl, adminCookie);
  return { authorizationUrl, callbackUrl, callback };
}

function oauthStatus(context: TestContext, cookie: string, serverId: string) {
  return call(context, "GET", `/api/mcp/servers/${serverId}/oauth`, cookie).then((response) => response.json<{ status: McpOAuthConnectionStatus }>().status);
}

function workflowWithTool(serverId: string, toolName: string) {
  return {
    id: `wf-oauth-${toolName}`,
    name: `OAuth ${toolName}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "trigger", type: "webhook_input", name: "Trigger", position: { x: 0, y: 0 }, config: {} },
      {
        id: "tool",
        type: "mcp_tool",
        name: "Tool",
        position: { x: 200, y: 0 },
        config: { registryServerId: serverId, serverId: "http_mcp", toolName, argsTemplate: "{}" }
      },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{results.tool.structured.temperature}}" } }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "tool" },
      { id: "e2", source: "tool", target: "output" }
    ]
  };
}

// ---------------------------------------------------------------------------

describe("MCP OAuth connect flow", () => {
  it("discovers, registers, authorizes with PKCE, exchanges the code and calls the server with the token", async () => {
    const logs: string[] = [];
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logs.push(String(chunk));
      return (stdoutWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);

    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerOAuthServer(context, admin);

    const before = await oauthStatus(context, admin, serverId);
    expect(before).toMatchObject({ state: "not_connected", redirectUri: `${REDIRECT_BASE}/api/mcp/oauth/callback` });

    // Not connected yet: a probe fails with an actionable message.
    const failedProbe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(failedProbe.json<{ probe: { ok: boolean; error: string } }>().probe).toMatchObject({
      ok: false,
      error: expect.stringMatching(/uses OAuth but is not connected/)
    });

    const { authorizationUrl, callbackUrl, callback } = await connect(context, admin, serverId);

    // Dynamic client registration as a public client with our redirect URL.
    expect(fake.registrations).toEqual([
      expect.objectContaining({
        redirect_uris: [`${REDIRECT_BASE}/api/mcp/oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none"
      })
    ]);
    const authorize = new URL(authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${fake.base}/auth/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "dyn-client-1",
      redirect_uri: `${REDIRECT_BASE}/api/mcp/oauth/callback`,
      code_challenge_method: "S256",
      resource: `${fake.base}/mcp`,
      scope: "tools:read"
    });
    expect(authorize.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorize.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    expect(callback.statusCode).toBe(200);
    expect(callback.headers["content-type"]).toMatch(/text\/html/);
    expect(callback.headers["content-security-policy"]).toMatch(/script-src 'nonce-/);
    expect(callback.body).toContain('"type":"l2m:mcp-oauth"');
    expect(callback.body).toContain('"ok":true');
    expect(callback.body).toContain('"http://studio.example.test"');

    const connected = await oauthStatus(context, admin, serverId);
    expect(connected).toMatchObject({
      state: "connected",
      subject: "ops@example.com",
      authorizationServer: `${fake.base}/auth`,
      clientRegistration: "dynamic",
      clientId: "dyn-client-1",
      hasRefreshToken: true,
      connectedBy: "admin@example.com",
      lastError: null
    });
    expect(Date.parse(connected.expiresAt ?? "")).toBeGreaterThan(Date.now());

    // The code exchange sent the verifier, the redirect URL and the resource.
    const exchange = fake.tokenRequests[0];
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(exchange.get("resource")).toBe(`${fake.base}/mcp`);

    // Replaying the callback is refused: states are single-use.
    const replay = await call(context, "GET", callbackUrl, admin);
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain("unknown or was already used");

    // Authenticated tools/list through a probe; annotations and outputSchema land in the snapshot.
    const probe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(probe.json<{ probe: { ok: boolean; toolCount: number } }>().probe).toMatchObject({ ok: true, toolCount: 3 });
    expect(fake.mcpAuthHeaders.at(-1)).toMatch(/^Bearer at-1-/);
    const tools = await call(context, "GET", `/api/mcp/servers/${serverId}/tools`, admin);
    const weather = tools.json<{ tools: Array<Record<string, unknown>> }>().tools.find((tool) => tool.name === "weather");
    expect(weather).toMatchObject({
      annotations: { readOnlyHint: true, openWorldHint: true, title: "Weather" },
      outputSchema: { type: "object", properties: { temperature: { type: "number" } }, required: ["temperature"] }
    });

    // An authenticated tools/call from a workflow; structured output reaches templates.
    const createWorkflow = await call(context, "POST", "/api/workflows", admin, workflowWithTool(serverId, "weather"));
    expect(createWorkflow.statusCode).toBe(200);
    const run = await call(context, "POST", `/api/workflows/wf-oauth-weather/execute`, admin, { input: {} });
    expect(run.statusCode).toBe(200);
    const runBody = run.json<{ status: string; output: unknown; nodeResults: Array<{ nodeId: string; output: Record<string, unknown> }> }>();
    expect(runBody.status).toBe("success");
    expect(runBody.nodeResults.find((entry) => entry.nodeId === "tool")?.output.structured).toEqual({ temperature: 12 });

    // No token or refresh token in any response, audit row, secret listing or log line.
    const secretsList = await call(context, "GET", "/api/secrets", admin);
    expect(secretsList.json<Array<{ provider: string }>>().some((secret) => secret.provider === "mcp_oauth")).toBe(false);
    const audit = context.store.listAuditLogs({ resourceType: "mcp_server", pageSize: 200 });
    expect(audit.items.map((item) => item.eventType)).toEqual(
      expect.arrayContaining(["mcp_server.oauth_connect_started", "mcp_server.oauth_connected"])
    );
    const haystacks = [...seenBodies, JSON.stringify(audit.items), ...logs];
    expect(issuedSecrets.size).toBeGreaterThan(0);
    for (const secret of issuedSecrets) {
      for (const haystack of haystacks) {
        expect(haystack.includes(secret)).toBe(false);
      }
    }
    expect(haystacks.some((haystack) => haystack.includes(exchange.get("code_verifier") ?? "unused"))).toBe(false);
  });

  it("refreshes the access token before it expires and rotates the refresh token", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerOAuthServer(context, admin);
    fake.expiresIn = 30; // inside the default 60 s refresh window
    await connect(context, admin, serverId);
    const firstRefresh = fake.currentRefreshToken;

    const probe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(probe.json<{ probe: { ok: boolean } }>().probe.ok).toBe(true);
    const refreshes = fake.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].get("refresh_token")).toBe(firstRefresh);
    expect(refreshes[0].get("resource")).toBe(`${fake.base}/mcp`);
    expect(fake.currentRefreshToken).not.toBe(firstRefresh);
    expect(fake.mcpAuthHeaders.at(-1)).toMatch(/^Bearer at-2-/);
    const status = await oauthStatus(context, admin, serverId);
    expect(status.lastRefreshAt).not.toBeNull();
    expect(status.state).toBe("connected");
  });

  it("refreshes and retries once when the server answers 401", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerOAuthServer(context, admin);
    await connect(context, admin, serverId);
    // The resource server revokes the token behind L2M's back.
    fake.validAccessTokens.clear();

    const probe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(probe.json<{ probe: { ok: boolean } }>().probe.ok).toBe(true);
    expect(fake.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token")).toHaveLength(1);
    expect(fake.mcpAuthHeaders.at(-1)).toMatch(/^Bearer at-2-/);

    // A refresh token the server no longer accepts puts the connection in error.
    fake.validAccessTokens.clear();
    fake.currentRefreshToken = "revoked";
    const failing = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(failing.json<{ probe: { ok: boolean; error: string } }>().probe).toMatchObject({ ok: false, error: expect.stringMatching(/Token refresh failed/) });
    expect(await oauthStatus(context, admin, serverId)).toMatchObject({ state: "error", lastError: expect.stringMatching(/refresh token is not valid/) });
  });

  it("rejects expired states and callbacks from another session", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const otherAdmin = await login(context, "admin", "second-admin");
    const serverId = await registerOAuthServer(context, admin);

    // Another admin's session cannot complete this admin's authorization.
    const started = await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, admin, {});
    const consent = await fetch(started.json<{ authorizationUrl: string }>().authorizationUrl, { redirect: "manual" });
    const location = new URL(consent.headers.get("location") ?? "");
    const hijack = await call(context, "GET", `${location.pathname}${location.search}`, otherAdmin);
    expect(hijack.statusCode).toBe(400);
    expect(hijack.body).toContain("different session");
    // ...and the state is gone after that attempt.
    const late = await call(context, "GET", `${location.pathname}${location.search}`, admin);
    expect(late.body).toContain("unknown or was already used");

    // An expired state is refused.
    const second = await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, admin, {});
    const consent2 = await fetch(second.json<{ authorizationUrl: string }>().authorizationUrl, { redirect: "manual" });
    const location2 = new URL(consent2.headers.get("location") ?? "");
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + context.config.MCP_OAUTH_STATE_TTL_MS + 1000);
    const expired = await call(context, "GET", `${location2.pathname}${location2.search}`, admin);
    vi.restoreAllMocks();
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toContain("expired");

    // Without a signed-in admin the callback does nothing.
    const anonymous = await context.app.inject({ method: "GET", url: `${location2.pathname}${location2.search}` });
    expect(anonymous.statusCode).toBe(400);
    expect(anonymous.body).toContain("Sign in to L2M as an admin");
    expect((await oauthStatus(context, admin, serverId)).state).toBe("not_connected");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("keeps connect, refresh and disconnect admin-only, and disconnect removes the tokens", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerOAuthServer(context, admin);

    expect((await call(context, "GET", `/api/mcp/servers/${serverId}/oauth`, builder)).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, builder, {})).statusCode).toBe(403);
    await connect(context, admin, serverId);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/refresh`, builder)).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/mcp/servers/${serverId}/oauth`, builder)).statusCode).toBe(403);

    const manual = await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/refresh`, admin);
    expect(manual.statusCode).toBe(200);
    expect(manual.json<{ status: McpOAuthConnectionStatus }>().status.lastRefreshAt).not.toBeNull();

    const secretId = context.store.getMcpOAuthConnection(serverId)?.secretId;
    expect(secretId).toBeTruthy();
    // The OAuth secret cannot be deleted or resolved through the generic secret routes.
    expect((await call(context, "DELETE", `/api/secrets/${secretId}`, admin)).statusCode).toBe(404);

    const disconnected = await call(context, "DELETE", `/api/mcp/servers/${serverId}/oauth`, admin);
    expect(disconnected.json<{ status: McpOAuthConnectionStatus }>().status.state).toBe("not_connected");
    expect(context.store.getSecret(secretId!)).toBeNull();
    const probe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);
    expect(probe.json<{ probe: { ok: boolean; error: string } }>().probe.error).toMatch(/not connected/);
  });

  it("uses a pre-registered client id and secret without dynamic registration", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const secret = await call(context, "POST", "/api/secrets", admin, { name: "search client secret", provider: "oauth", value: "pre-registered-secret" });
    expect(secret.statusCode).toBeLessThan(300);
    const secretId = secret.json<{ id: string }>().id;
    const response = await call(context, "POST", "/api/mcp/servers", admin, {
      name: "Search (pre-registered)",
      adapterId: "http_mcp",
      connection: { endpoint: `${fake.base}/mcp`, authType: "oauth", oauth: { clientId: "l2m-static", scope: "tools:read" } },
      secretRef: { secretId },
      probeEnabled: false
    });
    const serverId = response.json<{ server: { id: string } }>().server.id;
    const started = await call(context, "POST", `/api/mcp/servers/${serverId}/oauth/connect`, admin, {});
    const url = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("l2m-static");
    expect(fake.registrations).toHaveLength(0);
    const consent = await fetch(url, { redirect: "manual" });
    const location = new URL(consent.headers.get("location") ?? "");
    const callback = await call(context, "GET", `${location.pathname}${location.search}`, admin);
    expect(callback.statusCode).toBe(200);
    // client_secret_basic by default when a secret is configured.
    expect(fake.tokenRequests[0].get("client_id")).toBeNull();
    expect((await oauthStatus(context, admin, serverId)).clientRegistration).toBe("pre_registered");
  });
});

describe("MCP progress on the run stream", () => {
  it("sends node_progress events on the execution SSE stream", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerOAuthServer(context, admin);
    await connect(context, admin, serverId);
    await call(context, "POST", "/api/workflows", admin, workflowWithTool(serverId, "slow_index"));
    const stream = await call(context, "POST", `/api/workflows/wf-oauth-slow_index/execute/stream`, admin, { input: {} });
    expect(stream.statusCode).toBe(200);
    const frames = stream.body.split("\n\n").filter((frame) => frame.includes("event: node_progress"));
    expect(frames).toHaveLength(1);
    const data = JSON.parse(frames[0].split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as Record<string, unknown>;
    expect(data).toMatchObject({ nodeId: "tool", toolName: "slow_index", progress: 2, total: 5, percent: 40, message: "indexing shards", registryServerId: serverId });
  });
});

describe("annotation policy rules over the API", () => {
  it("stores annotationHint and denies destructive tools for operators", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerOAuthServer(context, admin);
    await connect(context, admin, serverId);
    await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin);

    const created = await call(context, "POST", "/api/mcp/policies", admin, {
      name: "No destructive tools for operators",
      effect: "deny",
      roles: ["operator"],
      annotationHint: "destructive"
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ rule: { annotationHint: string } }>().rule.annotationHint).toBe("destructive");
    expect((await call(context, "POST", "/api/mcp/policies", admin, { effect: "deny", annotationHint: "dangerous" })).statusCode).toBe(400);

    const evaluate = (toolName: string, role: string) =>
      call(context, "POST", "/api/mcp/policies/evaluate", admin, { role, serverId, toolName }).then((response) =>
        response.json<{ allowed: boolean; ruleName: string | null }>()
      );
    expect(await evaluate("drop_index", "operator")).toMatchObject({ allowed: false, ruleName: "No destructive tools for operators" });
    expect(await evaluate("weather", "operator")).toMatchObject({ allowed: true });
    expect(await evaluate("drop_index", "builder")).toMatchObject({ allowed: true });

    const operator = await login(context, "operator");
    const tools = await call(context, "GET", `/api/mcp/servers/${serverId}/tools`, operator);
    if (tools.statusCode === 200) {
      const marked = tools.json<{ tools: Array<{ name: string; access: { allowed: boolean } }> }>().tools;
      expect(marked.find((tool) => tool.name === "drop_index")?.access.allowed).toBe(false);
    }

    const updated = await call(context, "PUT", `/api/mcp/policies/${created.json<{ rule: { id: string } }>().rule.id}`, admin, { annotationHint: null });
    expect(updated.json<{ rule: { annotationHint: string | null } }>().rule.annotationHint).toBeNull();
  });
});

describe("Phase 10.5 schema", () => {
  it("ships Postgres migration v24 with the annotation column, the OAuth table and a reversing down", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 24);
    expect(migration).toBeDefined();
    expect(Math.max(...MIGRATIONS.map((entry) => entry.version))).toBe(24);
    expect(migration!.up).toContain("ALTER TABLE mcp_tool_policies ADD COLUMN IF NOT EXISTS annotation_hint TEXT");
    expect(migration!.up).toContain("CREATE TABLE IF NOT EXISTS mcp_oauth_connections");
    expect(migration!.up).not.toMatch(/\baccess_token\b|\brefresh_token\b|\bclient_secret\b/);
    expect(migration!.down).toContain("DROP TABLE IF EXISTS mcp_oauth_connections");
    expect(migration!.down).toContain("DROP COLUMN IF EXISTS annotation_hint");
  });

  it("adds the annotation column and OAuth table to an existing SQLite database", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-oauth-schema-"));
    try {
      const file = path.join(tempDir, "orchestrator.db");
      const first = await SqliteStore.create(file);
      first.createMcpToolPolicy({
        id: "legacy",
        name: null,
        description: null,
        effect: "deny",
        projectId: null,
        roles: [],
        serverId: null,
        toolPattern: "*",
        enabled: true
      });
      first.close();
      const reopened = await SqliteStore.create(file);
      expect(reopened.getMcpToolPolicy("legacy")?.annotationHint).toBeNull();
      expect(reopened.getMcpOAuthConnection("nope")).toBeNull();
      reopened.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
