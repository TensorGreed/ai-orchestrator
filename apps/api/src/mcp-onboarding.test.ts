/**
 * Phase 10.6 — MCP onboarding: config import, the deployment catalog and the
 * playground, end to end through the Fastify app.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpConfigImportResponse, McpPlaygroundCallResponse } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openApiSpec } from "./openapi.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const echoServer = path.join(repoRoot, "samples/mcp-echo-server/server.mjs");
const exampleCatalog = path.join(repoRoot, "samples/mcp-catalog.example.json");

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-onboarding-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir };
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

async function login(context: TestContext, role: Role, name: string = role): Promise<string> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const STDIO_KEY = "echo-key-value-7f2a9";
const STDIO_SECRET = "echo-secret-value-3c8d1";
const BEARER = "remote-bearer-value-55aa1";

function sampleConfig() {
  return JSON.stringify({
    mcpServers: {
      echo: {
        command: process.execPath,
        args: [echoServer],
        env: { ECHO_API_KEY: STDIO_KEY, ECHO_API_SECRET: STDIO_SECRET, ECHO_MODE: "demo" }
      },
      remote: {
        type: "http",
        url: "https://mcp.remote.example.test/mcp",
        headers: { Authorization: `Bearer ${BEARER}` },
        autoApprove: ["x"]
      }
    }
  });
}

async function importConfig(
  context: TestContext,
  cookie: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: McpConfigImportResponse & { error?: string; servers?: Array<{ id: string }> }; raw: string }> {
  const response = await context.app.inject({ method: "POST", url: "/api/mcp/servers/import", headers: { cookie }, payload });
  return { status: response.statusCode, body: response.json(), raw: response.body };
}

describe("POST /api/mcp/servers/import", () => {
  it("previews without saving, then imports with secrets stored through SecretService", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");

    const preview = await importConfig(context, admin, { content: sampleConfig(), fileName: "mcp.json", dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.format).toBe("mcp_servers");
    expect(preview.body.entries.map((entry) => [entry.key, entry.adapterId, entry.secretMode, entry.decision])).toEqual([
      ["echo", "stdio_mcp", "bundle", "create"],
      ["remote", "http_mcp", "single", "create"]
    ]);
    for (const secret of [STDIO_KEY, STDIO_SECRET, BEARER]) expect(preview.raw).not.toContain(secret);
    expect(await context.store.listMcpServers()).toHaveLength(0);

    const result = await importConfig(context, admin, { content: sampleConfig(), fileName: "mcp.json", probe: false });
    expect(result.status).toBe(200);
    for (const secret of [STDIO_KEY, STDIO_SECRET, BEARER]) expect(result.raw).not.toContain(secret);
    expect(result.body.entries.map((entry) => entry.result?.action)).toEqual(["created", "created"]);

    const servers = await context.store.listMcpServers();
    expect(servers.map((server) => server.name).sort()).toEqual(["echo", "remote"]);
    const echo = servers.find((server) => server.name === "echo")!;
    expect(echo.connection).toEqual({
      command: process.execPath,
      args: [echoServer],
      env: { ECHO_MODE: "demo" },
      secretEnvVars: ["ECHO_API_KEY", "ECHO_API_SECRET"]
    });
    expect(JSON.parse((await context.secretService.resolveSecret({ secretId: echo.secretId! }))!)).toEqual({
      ECHO_API_KEY: STDIO_KEY,
      ECHO_API_SECRET: STDIO_SECRET
    });
    const remote = servers.find((server) => server.name === "remote")!;
    expect(remote.connection).toEqual({ endpoint: "https://mcp.remote.example.test/mcp", transport: "http_streamable", authType: "bearer" });
    expect(await context.secretService.resolveSecret({ secretId: remote.secretId! })).toBe(BEARER);
    for (const secret of [STDIO_KEY, STDIO_SECRET, BEARER]) {
      expect(JSON.stringify(servers)).not.toContain(secret);
    }

    const audits = (await context.store.listAuditLogs({ pageSize: 200 })).items;
    const imported = audits.find((entry) => entry.eventType === "mcp_server.imported");
    expect(imported).toBeTruthy();
    expect(audits.filter((entry) => entry.eventType === "secret.create")).toHaveLength(2);
    for (const secret of [STDIO_KEY, STDIO_SECRET, BEARER]) expect(JSON.stringify(audits)).not.toContain(secret);

    // The list endpoint never echoes a value either.
    const list = await context.app.inject({ method: "GET", url: "/api/mcp/servers", headers: { cookie: admin } });
    for (const secret of [STDIO_KEY, STDIO_SECRET, BEARER]) expect(list.body).not.toContain(secret);
  });

  it("lets builders dry-run but not import, and refuses viewers", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    expect((await importConfig(context, builder, { content: sampleConfig(), dryRun: true })).status).toBe(200);
    const denied = await importConfig(context, builder, { content: sampleConfig() });
    expect(denied.status).toBe(403);
    expect((await importConfig(context, viewer, { content: sampleConfig(), dryRun: true })).status).toBe(403);
    expect(await context.store.listMcpServers()).toHaveLength(0);
  });

  it("rejects unreadable files with a clear message", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const bad = await importConfig(context, admin, { content: "{ not json", dryRun: true });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not valid JSON/);
    const empty = await importConfig(context, admin, { content: { theme: "dark" }, dryRun: true });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/No MCP servers found/);
  });

  it("skips duplicates by default and updates or copies on request", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await importConfig(context, admin, { content: sampleConfig(), probe: false });
    const [before] = (await context.store.listMcpServers()).filter((server) => server.name === "echo");

    const again = await importConfig(context, admin, { content: sampleConfig(), dryRun: true });
    expect(again.body.entries.map((entry) => [entry.decision, entry.duplicate?.serverId])).toEqual([
      ["skip", before!.id],
      ["skip", expect.any(String)]
    ]);

    const chosen = await importConfig(context, admin, {
      content: sampleConfig(),
      probe: false,
      entries: { echo: { decision: "update" }, remote: { decision: "copy" } }
    });
    expect(chosen.body.entries.map((entry) => entry.result?.action)).toEqual(["updated", "created"]);
    const servers = await context.store.listMcpServers();
    expect(servers.map((server) => server.name).sort()).toEqual(["echo", "remote", "remote (imported)"]);
    const after = (await context.store.getMcpServer(before!.id))!;
    expect(after.secretId).not.toBe(before!.secretId);
  });

  it("asks for prompted values and blocks the entry until they are supplied", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const content = JSON.stringify({
      inputs: [{ type: "promptString", id: "key", password: true }],
      servers: { tracker: { type: "stdio", command: "node", args: ["tracker.js"], env: { TRACKER_TOKEN: "${input:key}" } } }
    });
    const missing = await importConfig(context, admin, { content, probe: false });
    expect(missing.body.entries[0]!.result).toMatchObject({ action: "skipped" });
    expect(missing.body.entries[0]!.result?.reason).toMatch(/TRACKER_TOKEN/);
    expect(await context.store.listMcpServers()).toHaveLength(0);

    const supplied = await importConfig(context, admin, {
      content,
      probe: false,
      entries: { tracker: { values: { "env:TRACKER_TOKEN": "typed-token-value-1" } } }
    });
    expect(supplied.body.entries[0]!.result?.action).toBe("created");
    expect(supplied.raw).not.toContain("typed-token-value-1");
    const [server] = await context.store.listMcpServers();
    expect(server!.connection).toMatchObject({ secretEnvVar: "TRACKER_TOKEN" });
    expect(await context.secretService.resolveSecret({ secretId: server!.secretId! })).toBe("typed-token-value-1");
  });

  it("probes imported stdio servers through the secret bundle", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await importConfig(context, admin, { content: sampleConfig(), probe: false, entries: { remote: { decision: "skip" } } });
    const [echo] = await context.store.listMcpServers();
    const probe = await context.app.inject({ method: "POST", url: `/api/mcp/servers/${echo!.id}/probe`, headers: { cookie: admin } });
    expect(probe.json().probe.ok).toBe(true);
    const call = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${echo!.id}/playground/call`,
      headers: { cookie: admin },
      payload: { toolName: "credentials", args: {} }
    });
    expect(call.statusCode).toBe(200);
    expect((call.json() as McpPlaygroundCallResponse).result.content[0]).toEqual({
      type: "text",
      text: "Received: ECHO_API_KEY, ECHO_API_SECRET"
    });
  });
});

async function catalogContext(overrides: Record<string, string>, content: unknown = fs.readFileSync(exampleCatalog, "utf8")) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-catalog-"));
  const file = path.join(tempDir, "catalog.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  const context = await createTestContext({ MCP_CATALOG_FILE: file, ...overrides });
  fs.rmSync(context.tempDir, { recursive: true, force: true });
  context.tempDir = tempDir;
  return { context, file };
}

describe("MCP catalog", () => {
  it("merges catalog entries with the built-in presets by default and reports its status", async () => {
    const { context } = await catalogContext({});
    const viewer = await login(context, "viewer");
    const response = await context.app.inject({ method: "GET", url: "/api/mcp/presets", headers: { cookie: viewer } });
    const body = response.json() as { presets: Array<{ id: string; origin: string }>; catalog: { state: string; mode: string } };
    expect(body.catalog).toMatchObject({ state: "ok", mode: "merge" });
    expect(body.presets.filter((preset) => preset.origin === "catalog")).toHaveLength(5);
    expect(body.presets.some((preset) => preset.origin === "builtin")).toBe(true);
  });

  it("lists only catalog entries in exclusive mode", async () => {
    const { context } = await catalogContext({ MCP_CATALOG_MODE: "exclusive" });
    const viewer = await login(context, "viewer");
    const response = await context.app.inject({ method: "GET", url: "/api/mcp/presets", headers: { cookie: viewer } });
    const body = response.json() as { presets: Array<{ origin: string }> };
    expect(body.presets.length).toBe(5);
    expect(body.presets.every((preset) => preset.origin === "catalog")).toBe(true);
  });

  it("surfaces validation errors, keeps serving, and reloads on request (admin only)", async () => {
    const { context, file } = await catalogContext({}, { servers: [{ id: "x", name: "X", adapter: "stdio_mcp", connection: { command: "npx", args: ["-y", "pkg"] } }] });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const status = await context.app.inject({ method: "GET", url: "/api/mcp/catalog", headers: { cookie: builder } });
    expect(status.json().status).toMatchObject({ state: "partial", entryCount: 0 });
    expect(status.json().status.errors[0].message).toMatch(/not pinned/);

    fs.writeFileSync(file, "{ broken");
    expect((await context.app.inject({ method: "POST", url: "/api/mcp/catalog/reload", headers: { cookie: builder } })).statusCode).toBe(403);
    const broken = await context.app.inject({ method: "POST", url: "/api/mcp/catalog/reload", headers: { cookie: admin } });
    expect(broken.statusCode).toBe(200);
    expect(broken.json().status.state).toBe("error");
    // Still serving.
    expect((await context.app.inject({ method: "GET", url: "/api/mcp/presets", headers: { cookie: builder } })).statusCode).toBe(200);

    fs.writeFileSync(file, fs.readFileSync(exampleCatalog, "utf8"));
    const fixed = await context.app.inject({ method: "POST", url: "/api/mcp/catalog/reload", headers: { cookie: admin } });
    expect(fixed.json().status).toMatchObject({ state: "ok", entryCount: 6 });
    expect((await context.store.listAuditLogs({ pageSize: 50 })).items.some((entry) => entry.eventType === "mcp_catalog.reloaded")).toBe(true);
  });

  it("starts with a broken catalog file without crashing", async () => {
    const { context } = await catalogContext({}, "{{{");
    const admin = await login(context, "admin");
    const status = await context.app.inject({ method: "GET", url: "/api/mcp/catalog", headers: { cookie: admin } });
    expect(status.json().status.state).toBe("error");
  });

  it("enforcement rejects unpinned or uncatalogued stdio commands on register, update and import", async () => {
    const { context } = await catalogContext({ MCP_CATALOG_ENFORCE: "true" });
    const admin = await login(context, "admin");
    const register = (connection: Record<string, unknown>) =>
      context.app.inject({
        method: "POST",
        url: "/api/mcp/servers",
        headers: { cookie: admin },
        payload: { name: "s", adapterId: "stdio_mcp", connection, probeEnabled: false }
      });
    const unpinned = await register({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] });
    expect(unpinned.statusCode).toBe(403);
    expect(unpinned.json().error).toMatch(/does not pin/);
    const unknown = await register({ command: "bash", args: ["-c", "echo hi"] });
    expect(unknown.statusCode).toBe(403);
    const approved = await register({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2025.8.21", "/data"] });
    expect(approved.statusCode).toBe(201);
    // http servers are not subject to enforcement.
    const http = await context.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: { cookie: admin },
      payload: { name: "h", adapterId: "http_mcp", connection: { endpoint: "https://x.example.test/mcp" }, probeEnabled: false }
    });
    expect(http.statusCode).toBe(201);

    const update = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${approved.json().server.id}`,
      headers: { cookie: admin },
      payload: { connection: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@latest"] } }
    });
    expect(update.statusCode).toBe(403);

    const imported = await importConfig(context, admin, {
      content: { mcpServers: { rogue: { command: "npx", args: ["-y", "rogue-mcp"] }, time: { command: "uvx", args: ["mcp-server-time==0.6.2"] } } },
      probe: false
    });
    expect(imported.body.entries.map((entry) => entry.result?.action)).toEqual(["skipped", "created"]);
    expect(imported.body.entries[0]!.result?.reason).toMatch(/does not pin/);
  });
});

describe("MCP playground", () => {
  async function mockServer(context: TestContext, admin: string) {
    const created = await context.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: { cookie: admin },
      payload: { name: "Mock", adapterId: "mock-mcp", connection: {}, probeEnabled: false }
    });
    const id = created.json().server.id as string;
    await context.app.inject({ method: "POST", url: `/api/mcp/servers/${id}/probe`, headers: { cookie: admin } });
    return id;
  }

  it("calls a read-only tool, returns the exchange and records telemetry with the playground source", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const id = await mockServer(context, admin);
    const response = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: builder },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" } }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as McpPlaygroundCallResponse;
    expect(body.ok).toBe(true);
    expect(body.classification.readOnly).toBe(true);
    expect(body.exchange.request).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "lookup_kb", arguments: { topic: "mcp" } } });
    expect(body.exchange.response).toMatchObject({ jsonrpc: "2.0", id: body.exchange.request.id });
    expect(body.policy).toEqual({ role: "builder", projectId: "default" });
    const rows = await context.store.listMcpToolCalls({ registryServerId: id, since: "2020-01-01T00:00:00.000Z" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "playground", toolName: "lookup_kb", ok: true, clientId: null });
    expect((await context.store.listAuditLogs({ pageSize: 50 })).items.some((entry) => entry.eventType === "mcp_tool.playground_call")).toBe(true);
  });

  it("evaluates a project-scoped server only in its own project", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "team-a", name: "Team A" });
    await context.store.upsertProject({ id: "team-b", name: "Team B" });
    const created = await context.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: { cookie: admin },
      payload: { name: "Scoped", adapterId: "mock-mcp", connection: {}, probeEnabled: false, projectId: "team-a" }
    });
    const id = created.json().server.id as string;
    await context.app.inject({ method: "POST", url: `/api/mcp/servers/${id}/probe`, headers: { cookie: admin } });

    const elsewhere = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: builder },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" }, projectId: "team-b" }
    });
    expect(elsewhere.statusCode).toBe(400);

    const own = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: builder },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" } }
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as McpPlaygroundCallResponse).policy).toEqual({ role: "builder", projectId: "team-a" });
  });

  it("refuses callers without permission to run workflows in the project", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const id = await mockServer(context, admin);
    const builderUser = await context.store.getUserByEmail("builder@example.com");
    if (!builderUser) throw new Error("builder missing");
    await context.store.upsertProjectRole({ userId: builderUser.id, projectId: "default", role: "viewer" });

    const response = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: builder },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" } }
    });
    expect(response.statusCode).toBe(403);
    expect(await context.store.listMcpToolCalls({ registryServerId: id, since: "2020-01-01T00:00:00.000Z" })).toHaveLength(0);
  });

  it("asks before calling a write tool", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const id = await mockServer(context, admin);
    const unconfirmed = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: admin },
      payload: { toolName: "calculator", args: { expression: "2+3" } }
    });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json().requiresConfirmation).toBe(true);
    const confirmed = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: admin },
      payload: { toolName: "calculator", args: { expression: "2+3" }, confirmWrite: true }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().result.structuredContent).toEqual({ expression: "2+3", result: 5 });
  });

  it("enforces tool policy for the caller's role and project and records no call", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const id = await mockServer(context, admin);
    const rule = await context.app.inject({
      method: "POST",
      url: "/api/mcp/policies",
      headers: { cookie: admin },
      payload: { name: "No KB for builders", effect: "deny", roles: ["builder"], serverId: id, toolPattern: "lookup_kb" }
    });
    expect(rule.statusCode).toBe(201);
    const denied = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: builder },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" } }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().policy.ruleName).toBe("No KB for builders");
    const allowedForAdmin = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${id}/playground/call`,
      headers: { cookie: admin },
      payload: { toolName: "lookup_kb", args: { topic: "mcp" } }
    });
    expect(allowedForAdmin.statusCode).toBe(200);
    const rows = await context.store.listMcpToolCalls({ registryServerId: id, since: "2020-01-01T00:00:00.000Z" });
    expect(rows).toHaveLength(1);

    // A project-scoped deny applies only when that project is active.
    await context.store.upsertProject({ id: "proj_ops", name: "Ops" });
    await context.app.inject({
      method: "POST",
      url: "/api/mcp/policies",
      headers: { cookie: admin },
      payload: { effect: "deny", projectId: "proj_ops", serverId: id, toolPattern: "get_current_time" }
    });
    const call = (projectId?: string) =>
      context.app.inject({
        method: "POST",
        url: `/api/mcp/servers/${id}/playground/call`,
        headers: { cookie: admin },
        payload: { toolName: "get_current_time", args: {}, ...(projectId ? { projectId } : {}) }
      });
    expect((await call("proj_ops")).statusCode).toBe(403);
    expect((await call()).statusCode).toBe(200);
  });

  it("refuses viewers, unknown tools and servers without a snapshot", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    const id = await mockServer(context, admin);
    const call = (cookie: string, toolName: string, serverId = id) =>
      context.app.inject({ method: "POST", url: `/api/mcp/servers/${serverId}/playground/call`, headers: { cookie }, payload: { toolName } });
    expect((await call(viewer, "lookup_kb")).statusCode).toBe(403);
    expect((await call(admin, "nope")).statusCode).toBe(404);
    const unprobed = await context.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: { cookie: admin },
      payload: { name: "Fresh", adapterId: "mock-mcp", probeEnabled: false }
    });
    expect((await call(admin, "lookup_kb", unprobed.json().server.id)).statusCode).toBe(409);
  });

  it("masks credentials in the exchange transport", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await importConfig(context, admin, { content: sampleConfig(), probe: false, entries: { remote: { decision: "skip" } } });
    const [echo] = await context.store.listMcpServers();
    await context.app.inject({ method: "POST", url: `/api/mcp/servers/${echo!.id}/probe`, headers: { cookie: admin } });
    const response = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${echo!.id}/playground/call`,
      headers: { cookie: admin },
      payload: { toolName: "create_ticket", args: { title: "Hi", reporter: { name: "Ana" } }, confirmWrite: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as McpPlaygroundCallResponse;
    expect(body.exchange.transport).toMatchObject({
      kind: "stdio",
      env: { ECHO_MODE: "demo", ECHO_API_KEY: "••••••", ECHO_API_SECRET: "••••••" }
    });
    expect(body.result.structuredContent).toMatchObject({ title: "Hi", reporter: { name: "Ana" } });
    for (const secret of [STDIO_KEY, STDIO_SECRET]) expect(response.body).not.toContain(secret);
  });
});

describe("OpenAPI", () => {
  it("documents the onboarding endpoints", () => {
    const paths = Object.keys(openApiSpec.paths);
    for (const route of ["/api/mcp/servers/import", "/api/mcp/catalog", "/api/mcp/catalog/reload", "/api/mcp/servers/{id}/playground/call"]) {
      expect(paths).toContain(route);
    }
  });
});
