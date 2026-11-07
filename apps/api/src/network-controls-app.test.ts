/**
 * 13.2 — network controls end to end: scope allowlists in enforce and report mode, break-glass with its audit and
 * alert, TRUST_PROXY, per-client and per-webhook lists, forwarded client certificates (trusted and untrusted
 * proxies, fingerprint rotation, subject pins), the audit actor address, the Network settings view and migration
 * v58. Runs against the store TEST_STORE names (SQLite by default; the Postgres suite runs it again).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { NETWORK_DENIED_MESSAGE, WORKFLOW_SCHEMA_VERSION, type McpClient, type NetworkSettingsView, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { NotificationService } from "./services/notification-service.js";
import { CLIENT_CERT_A_PEM, CLIENT_CERT_B_PEM } from "./test-support/client-certs.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

const INSIDE = "10.0.0.2";
const OUTSIDE = "203.0.113.9";
const PROXY = "10.0.0.5";

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-network-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
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
  vi.restoreAllMocks();
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

function send(context: TestContext, options: InjectOptions & { from?: string }) {
  const { from, ...rest } = options;
  return context.app.inject({ ...rest, remoteAddress: from ?? INSIDE } as InjectOptions);
}

async function login(context: TestContext, role: "admin" | "viewer" = "admin", from = INSIDE): Promise<string> {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await send(context, { method: "POST", url: "/api/auth/login", payload: { email, password }, from });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

async function auditEvents(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 200 })).items;
}

async function gatewayClient(context: TestContext, cookie: string): Promise<{ client: McpClient; token: string; slug: string }> {
  const toolset = await send(context, {
    method: "POST",
    url: "/api/mcp/toolsets",
    headers: { cookie },
    payload: { name: `Net tools ${crypto.randomUUID().slice(0, 6)}`, projectId: "default" }
  });
  expect(toolset.statusCode, toolset.body).toBe(201);
  const { id, slug } = toolset.json<{ toolset: { id: string; slug: string } }>().toolset;
  const created = await send(context, { method: "POST", url: "/api/mcp/clients", headers: { cookie }, payload: { name: "IDE", toolsetIds: [id], role: "builder" } });
  expect(created.statusCode, created.body).toBe(201);
  return { ...created.json<{ client: McpClient; token: string }>(), slug };
}

function initialize(context: TestContext, slug: string, token: string, from: string, headers: Record<string, string> = {}) {
  return send(context, {
    method: "POST",
    url: `/mcp/${slug}`,
    from,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
  });
}

function setNetwork(context: TestContext, cookie: string, clientId: string, payload: Record<string, unknown>) {
  return send(context, { method: "PUT", url: `/api/mcp/clients/${clientId}/network`, headers: { cookie }, payload });
}

function webhookWorkflow(id: string, config: Record<string, unknown>): Workflow {
  return {
    id,
    name: `Webhook ${id}`,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [
      {
        id: "hook",
        type: "webhook_input",
        name: "Webhook",
        position: { x: 0, y: 0 },
        config: { path: `net-${id}`, method: "POST", passThroughFields: ["user_prompt"], ...config }
      },
      { id: "out", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { outputKey: "result", responseTemplate: "{{user_prompt}}" } }
    ],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  };
}

const fingerprintOf = (pem: string) => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
const FP_A = fingerprintOf(CLIENT_CERT_A_PEM);
const FP_B = fingerprintOf(CLIENT_CERT_B_PEM);
const certHeader = (pem: string) => ({ "x-ssl-client-cert": encodeURIComponent(pem) });

const STRICT = {
  NETWORK_ALLOW_UI: "10.0.0.0/8",
  NETWORK_ALLOW_API: "10.0.0.0/8",
  NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8",
  NETWORK_ALLOW_METRICS: "10.0.0.0/8"
};

describe("nothing set", () => {
  it("installs no hook and changes nothing: every address reaches every route, /metrics has no network series", async () => {
    const context = await createTestContext();
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: OUTSIDE })).statusCode).toBe(401);
    const metrics = await send(context, { method: "GET", url: "/metrics", from: OUTSIDE });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).not.toContain("network_requests_total");
    const cookie = await login(context, "admin", OUTSIDE);
    const view = await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie }, from: OUTSIDE });
    expect(view.statusCode).toBe(200);
    expect(view.json<NetworkSettingsView>()).toMatchObject({ mode: "enforce", active: false, yourIp: OUTSIDE, matchedScopes: [], breakGlass: { ranges: ["127.0.0.0/8", "::1/128"] } });
    expect(await auditEvents(context.store, "network.request_denied")).toEqual([]);
  });
});

describe("scope allowlists, enforce mode", () => {
  it("refuses outside addresses with a fixed 403 before rate limiting, audits once per window and counts each", async () => {
    const context = await createTestContext({ ...STRICT, RATE_LIMIT_ENABLED: "true", RATE_LIMIT_GLOBAL_MAX: "3" });
    for (let i = 0; i < 6; i += 1) {
      const response = await send(context, { method: "GET", url: "/api/workflows?secret=x", from: OUTSIDE, headers: { "x-forwarded-for": "10.0.0.9" } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: NETWORK_DENIED_MESSAGE });
      expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
      expect(response.body).not.toContain("10.0.0.0");
    }
    // An inside address still has its whole bucket: the refusals consumed none of it.
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: "10.9.9.9" })).headers["x-ratelimit-remaining"]).toBe("2");

    const denied = await auditEvents(context.store, "network.request_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", ipAddress: OUTSIDE, actorType: "system" });
    expect(denied[0]!.metadata).toMatchObject({ scope: "ui", mode: "enforce", method: "GET", path: "/api/workflows", list: "deployment" });

    // The gateway answers in JSON-RPC; probes are exempt; an open scope (webhook) is not checked.
    const gateway = await send(context, { method: "POST", url: "/mcp/anything", from: OUTSIDE, headers: { authorization: "Bearer x" }, payload: {} });
    expect(gateway.statusCode).toBe(403);
    expect(gateway.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: NETWORK_DENIED_MESSAGE } });
    expect((await send(context, { method: "GET", url: "/health", from: OUTSIDE })).statusCode).toBe(200);
    expect((await send(context, { method: "GET", url: "/ready", from: OUTSIDE })).statusCode).not.toBe(403);
    expect((await send(context, { method: "POST", url: "/webhook/none", from: OUTSIDE, payload: {} })).statusCode).toBe(404);
    expect((await send(context, { method: "GET", url: "/metrics", from: OUTSIDE })).statusCode).toBe(403);
    // A bearer that is not an API key is not API traffic (ui, the 7th ui refusal); an IPv4-mapped inside address matches.
    expect((await send(context, { method: "GET", url: "/api/workflows", from: OUTSIDE, headers: { authorization: "Bearer k" } })).statusCode).toBe(403);
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: "::ffff:10.1.2.3" })).statusCode).toBe(401);

    const metrics = await send(context, { method: "GET", url: "/metrics", from: INSIDE });
    expect(metrics.body).toContain('ao_network_requests_total{scope="ui",outcome="denied"} 7');
    expect(metrics.body).toContain('ao_network_requests_total{scope="mcp_gateway",outcome="denied"} 1');
  });

  it("shows the lists read-only to admins with the caller's address and matches; viewers are refused", async () => {
    const context = await createTestContext({ ...STRICT, NETWORK_ALLOW_API: "10.0.0.0/8, 2001:db8::/32" });
    const cookie = await login(context);
    const view = (await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie } })).json<NetworkSettingsView>();
    expect(view.active).toBe(true);
    expect(view.yourIp).toBe(INSIDE);
    expect(view.matchedScopes).toEqual(["ui", "api", "mcp_gateway", "metrics"]);
    expect(view.scopes.find((entry) => entry.scope === "api")).toEqual({ scope: "api", env: "NETWORK_ALLOW_API", ranges: ["10.0.0.0/8", "2001:db8::/32"], matched: true });
    expect(view.scopes.find((entry) => entry.scope === "webhook")).toEqual({ scope: "webhook", env: "NETWORK_ALLOW_WEBHOOK", ranges: [], matched: null });
    const viewer = await login(context, "viewer");
    expect((await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie: viewer } })).statusCode).toBe(403);
  });
});

describe("the scope classifier on real requests", () => {
  it("applies the ui list to a session cookie however it is spaced and whatever Authorization header comes with it", async () => {
    // Only the UI is restricted: a request that could pass as API traffic would be open.
    const context = await createTestContext({ NETWORK_ALLOW_UI: "10.0.0.0/8" });
    const cookie = await login(context);
    const [name, value] = cookie.split("=") as [string, string];
    const spaced = [`${name} =${value}`, `${name}\t=${value}`, ` ${name}=${value}`];
    for (const form of spaced) {
      for (const authorization of ["Bearer x", "Bearer junk", "Basic eDp5"]) {
        const response = await send(context, { method: "GET", url: "/api/auth/me", from: OUTSIDE, headers: { cookie: form, authorization } });
        expect(response.statusCode, `${form} / ${authorization}`).toBe(403);
      }
    }
    // The same cookie from inside works (the auth layer reads the spaced form too).
    expect((await send(context, { method: "GET", url: "/api/auth/me", headers: { cookie: spaced[0]!, authorization: "Bearer junk" } })).statusCode).toBe(200);

    // A real API key from outside is API traffic (open here); with the session cookie as well, the ui list applies.
    const created = await send(context, { method: "POST", url: "/api/auth/api-keys", headers: { cookie }, payload: { name: "ci" } });
    expect(created.statusCode, created.body).toBe(200);
    const key = created.json<{ key: string }>().key;
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: OUTSIDE, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(200);
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: OUTSIDE, headers: { authorization: `Bearer ${key}`, cookie } })).statusCode).toBe(403);
  });

  it("keeps sign-in and registration on the ui list when an Authorization header is sent", async () => {
    const context = await createTestContext({ NETWORK_ALLOW_UI: "10.0.0.0/8", AUTH_ALLOW_PUBLIC_REGISTER: "true" });
    const email = "guess@example.com";
    await context.authService.register({ email, password: "Guess-Pass-123!", role: "admin" });
    for (const url of ["/api/auth/login", "/api/auth/register", "/api/auth/ldap/login"]) {
      const response = await send(context, { method: "POST", url, from: OUTSIDE, headers: { authorization: "Bearer x" }, payload: { email, password: "Guess-Pass-123!" } });
      expect(response.statusCode, url).toBe(403);
    }
    expect((await send(context, { method: "GET", url: "/api/auth/oidc/login", from: OUTSIDE, headers: { authorization: "Bearer x" } })).statusCode).toBe(403);
  });

  it("classifies an absolute-form request target by its path (a raw socket, as a direct client would send it)", async () => {
    const context = await createTestContext({ NETWORK_ALLOW_METRICS: "10.0.0.0/8", NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8" });
    await context.app.listen({ host: "127.0.0.1", port: 0 });
    const address = context.app.server.address() as net.AddressInfo;
    const raw = (target: string, method = "GET") =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(address.port, "127.0.0.1", () => {
          socket.write(`${method} ${target} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString()));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
    // Loopback is not in the metrics or gateway lists (break-glass covers ui and api only).
    expect((await raw("http://x/metrics")).split("\r\n")[0]).toContain("403");
    expect((await raw("/metrics")).split("\r\n")[0]).toContain("403");
    expect((await raw("http://x/mcp/anything", "POST")).split("\r\n")[0]).toContain("403");
    expect((await raw("http://x/health")).split("\r\n")[0]).toContain("200");
  });
});

describe("report mode", () => {
  it("admits what enforce would refuse and records it as a would-be denial", async () => {
    const context = await createTestContext({ ...STRICT, NETWORK_ALLOWLIST_MODE: "report" });
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: OUTSIDE })).statusCode).toBe(401);
    expect((await send(context, { method: "GET", url: "/metrics", from: OUTSIDE })).statusCode).toBe(200);
    expect(await auditEvents(context.store, "network.request_denied")).toEqual([]);
    const would = await auditEvents(context.store, "network.request_would_be_denied");
    expect(would.map((event) => (event.metadata as { scope: string }).scope).sort()).toEqual(["metrics", "ui"]);
    expect(would[0]).toMatchObject({ outcome: "success", ipAddress: OUTSIDE });
    const cookie = await login(context);
    const view = (await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie } })).json<NetworkSettingsView>();
    expect(view.mode).toBe("report");
    expect(view.warnings.join(" ")).toContain("Report mode");
  });
});

describe("break-glass", () => {
  it("admits loopback on ui and api outside the list, audits it once per window and alerts once", async () => {
    const notify = vi.spyOn(NotificationService.prototype, "notify");
    const context = await createTestContext(STRICT);
    const cookie = await login(context, "admin", "127.0.0.1");
    for (let i = 0; i < 3; i += 1) {
      expect((await send(context, { method: "GET", url: "/api/auth/me", headers: { cookie }, from: "127.0.0.1" })).statusCode).toBe(200);
    }
    const used = await auditEvents(context.store, "network.break_glass_used");
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ outcome: "success", ipAddress: "127.0.0.1" });
    expect(used[0]!.metadata).toMatchObject({ scope: "ui" });
    await vi.waitFor(() => expect(notify.mock.calls.filter(([event]) => event.type === "network.break_glass_used")).toHaveLength(1));
    expect(notify.mock.calls.find(([event]) => event.type === "network.break_glass_used")![0]).toMatchObject({ network: { ip: "127.0.0.1", scope: "ui" } });
    // Break-glass never opens the gateway or metrics.
    expect((await send(context, { method: "GET", url: "/metrics", from: "127.0.0.1" })).statusCode).toBe(403);
    const view = (await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie }, from: "::1" })).json<NetworkSettingsView>();
    expect(view.breakGlass).toEqual({ ranges: ["127.0.0.0/8", "::1/128"], matched: true });
  });

  it("never trusts a loopback address read from X-Forwarded-For, even from a trusted proxy range", async () => {
    const notify = vi.spyOn(NotificationService.prototype, "notify");
    const context = await createTestContext({ NETWORK_ALLOW_UI: "192.168.0.0/16", NETWORK_ALLOW_API: "192.168.0.0/16", TRUST_PROXY: "10.0.0.0/8" });
    for (const forwarded of ["127.0.0.1", "::1"]) {
      expect((await send(context, { method: "GET", url: "/api/auth/me", from: "10.4.5.6", headers: { "x-forwarded-for": forwarded } })).statusCode).toBe(403);
    }
    expect(await auditEvents(context.store, "network.break_glass_used")).toEqual([]);
    expect(notify.mock.calls.filter(([event]) => event.type === "network.break_glass_used")).toHaveLength(0);
    // An operator on the host itself still gets in.
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: "127.0.0.1" })).statusCode).toBe(401);
    // A proxy on the same host connecting over loopback for an outside client is not break-glass.
    const sameHost = await createTestContext({ NETWORK_ALLOW_UI: "192.168.0.0/16", TRUST_PROXY: "loopback" });
    expect((await send(sameHost, { method: "GET", url: "/api/auth/me", from: "127.0.0.1", headers: { "x-forwarded-for": OUTSIDE } })).statusCode).toBe(403);
    expect((await send(sameHost, { method: "GET", url: "/api/auth/me", from: "127.0.0.1", headers: { "x-forwarded-for": "127.0.0.1" } })).statusCode).toBe(401);
  });

  it("is off with NETWORK_BREAK_GLASS_CIDRS=none", async () => {
    const context = await createTestContext({ ...STRICT, NETWORK_BREAK_GLASS_CIDRS: "none" });
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: "127.0.0.1" })).statusCode).toBe(403);
    expect(await auditEvents(context.store, "network.break_glass_used")).toEqual([]);
  });
});

describe("TRUST_PROXY", () => {
  it("checks the client address the trusted hop reports, never a forged one", async () => {
    const context = await createTestContext({ ...STRICT, TRUST_PROXY: "1" });
    // From the proxy: the address it appended counts.
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: PROXY, headers: { "x-forwarded-for": OUTSIDE } })).statusCode).toBe(403);
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: PROXY, headers: { "x-forwarded-for": "10.0.0.9" } })).statusCode).toBe(401);
    // A client that prepends an inside address is still checked by the hop the proxy appended.
    expect((await send(context, { method: "GET", url: "/api/auth/me", from: PROXY, headers: { "x-forwarded-for": `10.0.0.9, ${OUTSIDE}` } })).statusCode).toBe(403);
  });

  it("refuses per-client lists while every hop is trusted", async () => {
    const context = await createTestContext({ TRUST_PROXY: "true" });
    const cookie = await login(context);
    const { client } = await gatewayClient(context, cookie);
    const refused = await setNetwork(context, cookie, client.id, { allowedIps: ["10.0.0.0/8"] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("TRUST_PROXY=true");
    const view = (await send(context, { method: "GET", url: "/api/settings/network", headers: { cookie } })).json<NetworkSettingsView>();
    expect(view.warnings.join(" ")).toContain("TRUST_PROXY=true");
  });
});

describe("the audit actor address", () => {
  it("is request.ip: a forged X-Forwarded-For is ignored without TRUST_PROXY and read from the trusted hop with it", async () => {
    const plain = await createTestContext();
    const email = "ip@example.com";
    await plain.authService.register({ email, password: "Ip-Pass-123!", role: "admin" });
    await send(plain, { method: "POST", url: "/api/auth/login", payload: { email, password: "Ip-Pass-123!" }, from: "10.0.0.3", headers: { "x-forwarded-for": "6.6.6.6" } });
    expect((await auditEvents(plain.store, "user.login"))[0]).toMatchObject({ ipAddress: "10.0.0.3" });

    const proxied = await createTestContext({ TRUST_PROXY: "1" });
    await proxied.authService.register({ email, password: "Ip-Pass-123!", role: "admin" });
    await send(proxied, { method: "POST", url: "/api/auth/login", payload: { email, password: "Ip-Pass-123!" }, from: PROXY, headers: { "x-forwarded-for": "1.2.3.4, 6.6.6.6" } });
    expect((await auditEvents(proxied.store, "user.login"))[0]).toMatchObject({ ipAddress: "6.6.6.6" });
  });
});

describe("per-client address lists", () => {
  it("admit the client only from its ranges, validate entries and audit the change", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const { client, token, slug } = await gatewayClient(context, cookie);
    expect(client).toMatchObject({ allowedIps: [], certFingerprints: [], certSubject: null });
    expect((await initialize(context, slug, token, OUTSIDE)).statusCode).toBe(200);

    const invalid = await setNetwork(context, cookie, client.id, { allowedIps: ["198.51.100.0/24", "not-an-ip"] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: string }>().error).toBe("'not-an-ip' is not an IP address or CIDR range");
    const viewer = await login(context, "viewer");
    expect((await setNetwork(context, viewer, client.id, { allowedIps: [] })).statusCode).toBe(403);
    expect((await setNetwork(context, cookie, "mcc_missing", { allowedIps: [] })).statusCode).toBe(404);

    const updated = await setNetwork(context, cookie, client.id, { allowedIps: ["198.51.100.7/24", "2001:db8::/48"] });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ client: McpClient }>().client.allowedIps).toEqual(["198.51.100.0/24", "2001:db8::/48"]);
    expect((await initialize(context, slug, token, "198.51.100.42")).statusCode).toBe(200);
    expect((await initialize(context, slug, token, "2001:db8::9")).statusCode).toBe(200);
    const refused = await initialize(context, slug, token, OUTSIDE);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: NETWORK_DENIED_MESSAGE } });

    const denied = await auditEvents(context.store, "network.request_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.metadata).toMatchObject({ list: "mcp_client", clientId: client.id, scope: "mcp_gateway" });
    const changed = await auditEvents(context.store, "mcp_client.network_updated");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.metadata).toMatchObject({ before: { allowedIps: [] }, after: { allowedIps: ["198.51.100.0/24", "2001:db8::/48"] } });

    // Listed with the client; clearing the list admits any address again.
    const listed = (await send(context, { method: "GET", url: "/api/mcp/clients", headers: { cookie } })).json<{ clients: McpClient[] }>();
    expect(listed.clients[0]!.allowedIps).toEqual(["198.51.100.0/24", "2001:db8::/48"]);
    expect((await setNetwork(context, cookie, client.id, { allowedIps: [] })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, OUTSIDE)).statusCode).toBe(200);
  });

  it("only record in report mode", async () => {
    const context = await createTestContext({ NETWORK_ALLOWLIST_MODE: "report" });
    const cookie = await login(context);
    const { client, token, slug } = await gatewayClient(context, cookie);
    expect((await setNetwork(context, cookie, client.id, { allowedIps: ["198.51.100.0/24"] })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, OUTSIDE)).statusCode).toBe(200);
    expect((await auditEvents(context.store, "network.request_would_be_denied"))[0]!.metadata).toMatchObject({ list: "mcp_client" });
  });
});

describe("per-webhook address lists", () => {
  it("admit the trigger's callers only from its ranges; a list of bad entries admits nobody", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const saved = await send(context, { method: "POST", url: "/api/workflows", headers: { cookie }, payload: webhookWorkflow("wf-net", { allowedIps: ["198.51.100.0/24"] }) });
    expect(saved.statusCode, saved.body).toBe(200);
    const inside = await send(context, { method: "POST", url: "/webhook/net-wf-net", from: "198.51.100.3", payload: { user_prompt: "hi" } });
    expect(inside.statusCode, inside.body).toBe(200);
    const outside = await send(context, { method: "POST", url: "/webhook/net-wf-net", from: OUTSIDE, payload: { user_prompt: "hi" } });
    expect(outside.statusCode).toBe(403);
    expect(outside.json()).toEqual({ error: NETWORK_DENIED_MESSAGE });
    expect((await auditEvents(context.store, "network.request_denied"))[0]!.metadata).toMatchObject({ list: "webhook", workflowId: "wf-net", nodeId: "hook" });

    await context.store.upsertWorkflow(webhookWorkflow("wf-bad", { allowedIps: ["nonsense"] }), {});
    expect((await send(context, { method: "POST", url: "/webhook/net-wf-bad", from: "198.51.100.3", payload: { user_prompt: "hi" } })).statusCode).toBe(403);
    // Without a list the trigger answers everyone, as before.
    await context.store.upsertWorkflow(webhookWorkflow("wf-open", {}), {});
    expect((await send(context, { method: "POST", url: "/webhook/net-wf-open", from: OUTSIDE, payload: { user_prompt: "hi" } })).statusCode).toBe(200);
  });
});

describe("forwarded client certificates", () => {
  const CERT_ENV = { MCP_GATEWAY_CLIENT_CERT_HEADER: "x-ssl-client-cert", MCP_GATEWAY_CLIENT_CERT_PROXIES: PROXY };

  it("need the token and a pinned certificate from the trusted proxy; rotation keeps old and new until the old is removed", async () => {
    const context = await createTestContext(CERT_ENV);
    const cookie = await login(context);
    const { client, token, slug } = await gatewayClient(context, cookie);
    const pinned = await setNetwork(context, cookie, client.id, { certFingerprints: [FP_A.match(/../g)!.join(":").toUpperCase()] });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json<{ client: McpClient }>().client.certFingerprints).toEqual([FP_A]);

    const tokenOnly = await initialize(context, slug, token, PROXY);
    expect(tokenOnly.statusCode).toBe(401);
    expect(tokenOnly.headers["www-authenticate"]).toContain("Bearer");
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(200);
    // The same header from an address that is not the proxy is ignored.
    expect((await initialize(context, slug, token, "10.0.0.6", certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(401);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_B_PEM))).statusCode).toBe(401);
    expect((await initialize(context, slug, "l2m_mcp_wrong.token", PROXY, certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(401);

    // Rotation: add B, both work; remove A, only B works.
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: [FP_A, FP_B] })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(200);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_B_PEM))).statusCode).toBe(200);
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: [FP_B] })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(401);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_B_PEM))).statusCode).toBe(200);

    // A subject pin narrows it further.
    expect((await setNetwork(context, cookie, client.id, { certSubject: "spiffe://l2m.test/agent-a" })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_B_PEM))).statusCode).toBe(401);
    expect((await setNetwork(context, cookie, client.id, { certSubject: "agent-b.example.com" })).statusCode).toBe(200);
    expect((await initialize(context, slug, token, PROXY, certHeader(CLIENT_CERT_B_PEM))).statusCode).toBe(200);

    // Sampled per client, address and reason: the later mismatches from the proxy fall in the first one's window.
    const refused = await auditEvents(context.store, "mcp_gateway.client_certificate_refused");
    expect(refused.map((event) => (event.metadata as { reason: string }).reason).sort()).toEqual(["mismatch", "none", "untrusted"]);
    expect(refused.every((event) => event.resourceId === client.id)).toBe(true);
    // Validation: a subject pin needs a fingerprint; bad fingerprints are refused.
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: [], certSubject: "x" })).statusCode).toBe(400);
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: ["abc"] })).json<{ error: string }>().error).toContain("SHA-256");
  });

  it("refuse a header with more than one certificate (401, audited)", async () => {
    const context = await createTestContext(CERT_ENV);
    const cookie = await login(context);
    const { client, token, slug } = await gatewayClient(context, cookie);
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: [FP_A] })).statusCode).toBe(200);
    const both = { "x-ssl-client-cert": `${encodeURIComponent(CLIENT_CERT_B_PEM)}, ${encodeURIComponent(CLIENT_CERT_A_PEM)}` };
    expect((await initialize(context, slug, token, PROXY, both)).statusCode).toBe(401);
    const refused = await auditEvents(context.store, "mcp_gateway.client_certificate_refused");
    expect(refused.map((event) => (event.metadata as { reason: string }).reason)).toEqual(["invalid"]);
  });

  it("cannot be pinned while forwarded certificates are off, and clients without a pin never need one", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const { client, token, slug } = await gatewayClient(context, cookie);
    const refused = await setNetwork(context, cookie, client.id, { certFingerprints: [FP_A] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>().error).toContain("MCP_GATEWAY_CLIENT_CERT_HEADER");
    expect((await initialize(context, slug, token, OUTSIDE, certHeader(CLIENT_CERT_A_PEM))).statusCode).toBe(200);
  });
});

describe("the /v1 AI gateway", () => {
  const CHAT = { model: "net-chat", messages: [{ role: "user", content: "hi" }] };
  const JSON_HEADERS = { "content-type": "application/json" };
  const OPENAI_DENIED = { error: { message: NETWORK_DENIED_MESSAGE, type: "invalid_request_error", code: "access_denied", param: null } };
  const upstreams: http.Server[] = [];

  afterEach(async () => {
    for (const server of upstreams.splice(0)) await new Promise((resolve) => server.close(resolve));
  });

  /** An OpenAI-compatible upstream, and a client granted a chat and an embedding route on it. */
  async function aiClient(context: TestContext, cookie: string): Promise<{ client: McpClient; token: string; calls: () => number }> {
    let calls = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        const body = (req.url ?? "").endsWith("/embeddings")
          ? { object: "list", data: [{ object: "embedding", index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 1, total_tokens: 1 } }
          : { id: "1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }] };
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    upstreams.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
    const post = async (url: string, payload: object) => {
      const response = await send(context, { method: "POST", url, headers: { cookie }, payload });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json<{ id: string; client: McpClient; token: string }>();
    };
    const set = await post("/api/ai-gateway/route-sets", { name: `Net ${crypto.randomUUID().slice(0, 6)}`, projectId: "default" });
    await post(`/api/ai-gateway/route-sets/${set.id}/routes`, { alias: "net-chat", providerId: "openai_compatible", model: "m", baseUrl });
    await post(`/api/ai-gateway/route-sets/${set.id}/routes`, { alias: "net-embed", kind: "embedding", providerId: "openai_compatible", model: "e", baseUrl });
    const { client, token } = await post("/api/mcp/clients", { name: "App", toolsetIds: [], role: "builder" });
    const granted = await send(context, { method: "PUT", url: `/api/ai-gateway/clients/${client.id}/grants`, headers: { cookie }, payload: { routeSetIds: [set.id] } });
    expect(granted.statusCode, granted.body).toBe(200);
    return { client, token, calls: () => calls };
  }

  /** Every /v1 route, with the status each answers when admitted. */
  function everyRoute(context: TestContext, token: string, from: string, headers: Record<string, string> = {}) {
    const auth = { authorization: `Bearer ${token}`, ...headers };
    return Promise.all([
      send(context, { method: "GET", url: "/v1/models", from, headers: auth }),
      send(context, { method: "GET", url: "/v1/models/net-chat", from, headers: auth }),
      send(context, { method: "POST", url: "/v1/chat/completions", from, headers: { ...auth, ...JSON_HEADERS }, payload: JSON.stringify(CHAT) }),
      send(context, { method: "POST", url: "/v1/embeddings", from, headers: { ...auth, ...JSON_HEADERS }, payload: JSON.stringify({ model: "net-embed", input: "x" }) })
    ]);
  }

  const statuses = (responses: Array<{ statusCode: number }>) => responses.map((response) => response.statusCode);

  it("is unchanged with no network settings: every address reaches every route", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const { token, calls } = await aiClient(context, cookie);
    expect(statuses(await everyRoute(context, token, OUTSIDE))).toEqual([200, 200, 200, 200]);
    expect(calls()).toBe(2);
    expect(await auditEvents(context.store, "network.request_denied")).toHaveLength(0);
    expect((await send(context, { method: "GET", url: "/metrics" })).body).not.toContain("ao_network_requests_total{");
  });

  it("is the MCP gateway scope: refused in the OpenAI format with a fixed body, audited and counted, on known and unknown paths", async () => {
    const context = await createTestContext({ NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8" });
    const cookie = await login(context);
    const { token, calls } = await aiClient(context, cookie);
    const refused = await everyRoute(context, token, OUTSIDE);
    expect(statuses(refused)).toEqual([403, 403, 403, 403]);
    for (const response of refused) {
      expect(response.json()).toEqual(OPENAI_DENIED);
      expect(response.body).not.toContain("10.0.0.0");
      expect(response.body).not.toContain(OUTSIDE);
    }
    const unknown = await send(context, { method: "GET", url: "/v1/nope", from: OUTSIDE });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json()).toEqual(OPENAI_DENIED);
    expect(calls()).toBe(0);

    const denied = await auditEvents(context.store, "network.request_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", ipAddress: OUTSIDE });
    expect(denied[0]!.metadata).toMatchObject({ scope: "mcp_gateway", list: "deployment" });
    expect((await send(context, { method: "GET", url: "/metrics" })).body).toContain('ao_network_requests_total{scope="mcp_gateway",outcome="denied"} 5');

    expect(statuses(await everyRoute(context, token, INSIDE))).toEqual([200, 200, 200, 200]);
  });

  it("does not take the ui or api lists, or break-glass", async () => {
    const context = await createTestContext({ NETWORK_ALLOW_UI: "10.0.0.0/8", NETWORK_ALLOW_API: "10.0.0.0/8" });
    const cookie = await login(context);
    const { token } = await aiClient(context, cookie);
    expect(statuses(await everyRoute(context, token, OUTSIDE))).toEqual([200, 200, 200, 200]);

    const strict = await createTestContext({ NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8" });
    expect((await send(strict, { method: "GET", url: "/v1/models", from: "127.0.0.1" })).statusCode).toBe(403);
  });

  it("only records in report mode", async () => {
    const context = await createTestContext({ NETWORK_ALLOW_MCP_GATEWAY: "10.0.0.0/8", NETWORK_ALLOWLIST_MODE: "report" });
    const cookie = await login(context);
    const { client, token } = await aiClient(context, cookie);
    expect((await setNetwork(context, cookie, client.id, { allowedIps: ["198.51.100.0/24"] })).statusCode).toBe(200);
    expect(statuses(await everyRoute(context, token, OUTSIDE))).toEqual([200, 200, 200, 200]);
    const lists = (await auditEvents(context.store, "network.request_would_be_denied")).map((event) => (event.metadata as Record<string, unknown>).list);
    expect(lists.map(String).sort()).toEqual(["deployment", "mcp_client"]);
  });

  it("holds a token to its client's address list on every route, with the body the deployment list sends", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const { client, token, calls } = await aiClient(context, cookie);
    expect((await setNetwork(context, cookie, client.id, { allowedIps: ["198.51.100.0/24"] })).statusCode).toBe(200);

    const refused = await everyRoute(context, token, OUTSIDE);
    expect(statuses(refused)).toEqual([403, 403, 403, 403]);
    for (const response of refused) expect(response.json()).toEqual(OPENAI_DENIED);
    const stream = await send(context, {
      method: "POST",
      url: "/v1/chat/completions",
      from: OUTSIDE,
      headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS },
      payload: JSON.stringify({ ...CHAT, stream: true })
    });
    expect(stream.statusCode).toBe(403);
    expect(stream.json()).toEqual(OPENAI_DENIED);
    expect(calls()).toBe(0);
    expect(await context.store.listAiGatewayRequests({ from: "1970-01-01T00:00:00.000Z", limit: 10 })).toHaveLength(0);

    const denied = await auditEvents(context.store, "network.request_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.metadata).toMatchObject({ scope: "mcp_gateway", list: "mcp_client", clientId: client.id, clientName: "App" });
    expect((await send(context, { method: "GET", url: "/metrics" })).body).toContain('ao_network_requests_total{scope="mcp_gateway",outcome="denied"} 5');

    expect(statuses(await everyRoute(context, token, "198.51.100.7"))).toEqual([200, 200, 200, 200]);
    // A bad token is refused as one, whatever the address: the list is only read for a valid client.
    expect((await send(context, { method: "GET", url: "/v1/models", from: OUTSIDE, headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  });

  it("holds a token to its client's certificate pin on every route; an endpoint's refusal is audited as such", async () => {
    const context = await createTestContext({ MCP_GATEWAY_CLIENT_CERT_HEADER: "x-ssl-client-cert", MCP_GATEWAY_CLIENT_CERT_PROXIES: PROXY });
    const cookie = await login(context);
    const { client, token, calls } = await aiClient(context, cookie);
    expect((await setNetwork(context, cookie, client.id, { certFingerprints: [FP_A] })).statusCode).toBe(200);

    const bare = await everyRoute(context, token, PROXY);
    expect(statuses(bare)).toEqual([401, 401, 401, 401]);
    for (const response of bare) {
      expect(response.headers["www-authenticate"]).toContain("Bearer");
      expect(response.json<{ error: { code: string; type: string } }>().error).toMatchObject({ code: "invalid_api_key", type: "invalid_request_error" });
    }
    // The wrong certificate, and the right one from an address that is not the proxy.
    expect(statuses(await everyRoute(context, token, PROXY, certHeader(CLIENT_CERT_B_PEM)))).toEqual([401, 401, 401, 401]);
    expect(statuses(await everyRoute(context, token, "10.0.0.6", certHeader(CLIENT_CERT_A_PEM)))).toEqual([401, 401, 401, 401]);
    expect(calls()).toBe(0);

    expect(statuses(await everyRoute(context, token, PROXY, certHeader(CLIENT_CERT_A_PEM)))).toEqual([200, 200, 200, 200]);

    const reasons = (await auditEvents(context.store, "mcp_gateway.client_certificate_refused")).map((event) => event.metadata as Record<string, unknown>);
    expect(reasons.map((metadata) => metadata.reason).sort()).toEqual(["mismatch", "none", "untrusted"]);
    for (const metadata of reasons) expect(metadata).toMatchObject({ endpoint: "ai_gateway" });
  });
});

describe("migration v58", () => {
  it("adds the network columns to mcp_clients in both stores, with a rollback, and the store round-trips them", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 58)!;
    expect(migration.description).toContain("13.2");
    expect(migration.up).toContain("ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS allowed_ips_json TEXT NOT NULL DEFAULT '[]'");
    expect(migration.up).toContain("ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS cert_fingerprints_json TEXT NOT NULL DEFAULT '[]'");
    expect(migration.up).toContain("ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS cert_subject TEXT");
    expect(migration.down).toContain("ALTER TABLE mcp_clients DROP COLUMN IF EXISTS allowed_ips_json");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = (
      sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(mcp_clients)`)
        : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, "mcp_clients")
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["allowed_ips_json", "cert_fingerprints_json", "cert_subject"]));

    const created = await context.store.createMcpClient({
      id: "mcc_net",
      name: "Net",
      tokenPrefix: "l2m_mcp_net",
      tokenHash: "00",
      toolsetIds: [],
      role: "viewer",
      createdBy: null,
      createdByEmail: null,
      expiresAt: null
    });
    expect(created).toMatchObject({ allowedIps: [], certFingerprints: [], certSubject: null });
    const updated = await context.store.updateMcpClientNetwork("mcc_net", { allowedIps: ["10.0.0.0/8"], certFingerprints: [FP_A], certSubject: "agent" });
    expect(updated).toMatchObject({ allowedIps: ["10.0.0.0/8"], certFingerprints: [FP_A], certSubject: "agent" });
    expect(await context.store.findMcpClientByTokenPrefix("l2m_mcp_net")).toMatchObject({ allowedIps: ["10.0.0.0/8"], certFingerprints: [FP_A] });
    expect(await context.store.updateMcpClientNetwork("mcc_missing", { allowedIps: [], certFingerprints: [], certSubject: null })).toBeNull();
  });
});
