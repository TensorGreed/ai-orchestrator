/**
 * Phase 10.4 — L2M as an MCP server and gateway.
 *
 * Conformance runs the official MCP SDK client (Streamable HTTP transport)
 * against a listening app; the rest covers L2M → L2M through the http_mcp
 * adapter, credentials, origin checks, the policy subject, telemetry, audit,
 * the admin API and the schema changes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { openApiSpec } from "./openapi.js";
import { hashSecret } from "./services/api-key-service.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  baseUrl: string;
}

const contexts: TestContext[] = [];
const sdkClients: Client[] = [];

const ECHO_SERVER_SCRIPT = `
process.stdin.setEncoding('utf-8');
let buf = '';
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\\n');
  while (nl >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    nl = buf.indexOf('\\n');
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.method === 'initialize') {
      reply(req.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo-test', version: '1.0' } });
    } else if (req.method === 'tools/list') {
      reply(req.id, { tools: [
        { name: 'echo', description: 'Echoes msg', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'pid', description: 'Returns the server pid', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'envcheck', description: 'Returns the injected token', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'hang', description: 'Never answers', inputSchema: { type: 'object' } }
      ] });
    } else if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      if (name === 'echo') reply(req.id, { content: [{ type: 'text', text: 'echo: ' + (args.msg || '') }] });
      else if (name === 'pid') reply(req.id, { content: [{ type: 'text', text: String(process.pid) }] });
      else if (name === 'envcheck') reply(req.id, { content: [{ type: 'text', text: 'TOKEN=' + (process.env.ECHO_TOKEN || '') }] });
      else if (name === 'hang') { /* never answers */ }
      else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown tool' } }) + '\\n');
    } else if (req.id !== undefined) {
      reply(req.id, {});
    }
  }
});
`;

const INJECTED_SECRET = "echo-secret-value-9f3k2";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-gateway-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    WEB_ORIGIN: "http://studio.example.test",
    MCP_GATEWAY_ALLOWED_ORIGINS: "https://ide.example.test",
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  const context: TestContext = { app, store, authService, secretService, config, tempDir, baseUrl: `http://127.0.0.1:${port}` };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (sdkClients.length > 0) {
    await sdkClients.pop()?.close().catch(() => undefined);
  }
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  return { cookie: extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME), id: user.id, email };
}

async function api<T = Record<string, unknown>>(
  context: TestContext,
  cookie: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown
): Promise<{ status: number; body: T }> {
  const response = await context.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  });
  return { status: response.statusCode, body: (response.body ? response.json() : {}) as T };
}

async function registerServer(context: TestContext, cookie: string, payload: Record<string, unknown>): Promise<string> {
  const created = await api<{ server: { id: string } }>(context, cookie, "POST", "/api/mcp/servers", { probeEnabled: false, ...payload });
  expect(created.status).toBe(201);
  const id = created.body.server.id;
  const probe = await api<{ probe: { ok: boolean; error: string | null } }>(context, cookie, "POST", `/api/mcp/servers/${id}/probe`);
  expect(probe.status).toBe(200);
  expect(probe.body.probe.ok, probe.body.probe.error ?? "").toBe(true);
  return id;
}

function triggerWorkflow(id: string, toolName: string, extraNodes: Workflow["nodes"] = [], extraEdges: Workflow["edges"] = []): Workflow {
  const nodes: Workflow["nodes"] = [
    {
      id: "trigger",
      type: "mcp_server_trigger",
      name: "Trigger",
      position: { x: 0, y: 0 },
      config: {
        path: `${id}-path`,
        toolName,
        toolDescription: `The ${toolName} tool`,
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
        authMode: "public"
      }
    },
    ...extraNodes
  ];
  const lastId = extraNodes.length > 0 ? extraNodes[extraNodes.length - 1]!.id : "trigger";
  return {
    id,
    name: `Workflow ${toolName}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      ...nodes,
      {
        id: "out",
        type: "output",
        name: "Out",
        position: { x: 400, y: 0 },
        config: { outputKey: "result", responseTemplate: "answered:{{text}}" }
      }
    ],
    edges: [
      ...(extraEdges.length > 0 ? extraEdges : extraNodes.length > 0 ? [{ id: "e0", source: "trigger", target: extraNodes[0]!.id }] : []),
      { id: "e-out", source: lastId, target: "out" }
    ]
  };
}

function slowWorkflow(id: string): Workflow {
  return triggerWorkflow(id, "slow_workflow", [
    { id: "wait", type: "wait_node", name: "Wait", position: { x: 200, y: 0 }, config: { delayMs: 20000, maxDelayMs: 30000 } }
  ]);
}

function calculatorWorkflow(id: string, serverId: string): Workflow {
  return {
    id,
    name: "Calculator via workflow",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: `${id}-path`, toolName: "calc_workflow", inputSchema: { type: "object" }, authMode: "public" }
      },
      {
        id: "calc",
        type: "mcp_tool",
        name: "Calculator",
        position: { x: 200, y: 0 },
        config: { registryServerId: serverId, toolName: "calculator", argsTemplate: "{\"expression\":\"6*7\"}", retry: { enabled: false } }
      },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "calc" },
      { id: "e2", source: "calc", target: "out" }
    ]
  };
}

interface Fixture {
  context: TestContext;
  admin: { cookie: string; id: string; email: string };
  mockServerId: string;
  echoServerId: string;
  toolset: McpToolset;
  token: string;
  client: McpClient;
}

async function createClientToken(
  context: TestContext,
  cookie: string,
  payload: { name: string; toolsetIds: string[]; role: Role; expiresAt?: string | null }
): Promise<{ client: McpClient; token: string }> {
  const created = await api<{ client: McpClient; token: string }>(context, cookie, "POST", "/api/mcp/clients", payload);
  expect(created.status).toBe(201);
  return created.body;
}

async function setupFixture(overrides: Record<string, string> = {}): Promise<Fixture> {
  const context = await createTestContext(overrides);
  const admin = await login(context, "admin");
  const mockServerId = await registerServer(context, admin.cookie, { name: "Mock tools", adapterId: "mock-mcp" });
  const secret = await api<{ id: string }>(context, admin.cookie, "POST", "/api/secrets", {
    name: "echo token",
    provider: "custom",
    value: INJECTED_SECRET
  });
  expect(secret.status).toBe(200);
  const echoServerId = await registerServer(context, admin.cookie, {
    name: "Echo server",
    adapterId: "stdio_mcp",
    connection: { command: process.execPath, args: ["-e", ECHO_SERVER_SCRIPT], timeoutMs: 20000, secretEnvVar: "ECHO_TOKEN" },
    secretRef: { secretId: secret.body.id }
  });
  context.store.upsertWorkflow(triggerWorkflow("wf-echo", "echo_workflow"), { createdBy: admin.id });
  context.store.upsertWorkflow(slowWorkflow("wf-slow"), { createdBy: admin.id });
  const toolsetResponse = await api<{ toolset: McpToolset }>(context, admin.cookie, "POST", "/api/mcp/toolsets", {
    name: "Main tools",
    description: "Everything the tests need",
    projectId: "default",
    members: [
      { kind: "workflow", workflowId: "wf-echo" },
      { kind: "workflow", workflowId: "wf-slow" },
      { kind: "server", serverId: mockServerId },
      { kind: "server", serverId: echoServerId, toolGlob: "*" }
    ]
  });
  expect(toolsetResponse.status).toBe(201);
  const toolset = toolsetResponse.body.toolset;
  const { client, token } = await createClientToken(context, admin.cookie, { name: "IDE agent", toolsetIds: [toolset.id], role: "builder" });
  return { context, admin, mockServerId, echoServerId, toolset, token, client };
}

async function connectSdk(context: TestContext, slug: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${context.baseUrl}/mcp/${slug}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  const client = new Client({ name: "conformance-test", version: "1.0.0" });
  sdkClients.push(client);
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((entry) => entry.text ?? "").join("\n");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Condition not met in time");
}

/** Raw JSON-RPC over app.inject, for protocol edge cases the SDK never sends. */
async function rpc(
  context: TestContext,
  slug: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return context.app.inject({
    method: "POST",
    url: `/mcp/${slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function openSession(context: TestContext, slug: string, token: string, protocolVersion = "2025-11-25"): Promise<string> {
  const response = await rpc(
    context,
    slug,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw", version: "1" } } },
    { authorization: `Bearer ${token}` }
  );
  expect(response.statusCode).toBe(200);
  const sessionId = response.headers["mcp-session-id"];
  expect(typeof sessionId).toBe("string");
  return sessionId as string;
}

describe("MCP gateway conformance (official SDK client)", () => {
  it("initializes, lists workflow and gateway tools, calls them with progress, cancels and ends the session", async () => {
    const { context, toolset, token } = await setupFixture();
    const { client, transport } = await connectSdk(context, toolset.slug, token);

    expect(client.getServerVersion()?.name).toBe(`l2m-${toolset.slug}`);
    expect(transport.sessionId).toBeTruthy();
    expect(transport.protocolVersion).toBe("2025-11-25");

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "echo_workflow",
        "slow_workflow",
        "mock_tools__calculator",
        "mock_tools__get_current_time",
        "mock_tools__lookup_kb",
        "echo_server__echo",
        "echo_server__pid",
        "echo_server__hang"
      ])
    );
    const calculator = listed.tools.find((tool) => tool.name === "mock_tools__calculator");
    expect(calculator?.inputSchema).toMatchObject({ type: "object", required: ["expression"] });
    expect(listed.tools.find((tool) => tool.name === "echo_server__echo")?.annotations).toEqual({ readOnlyHint: true });
    expect(listed.tools.find((tool) => tool.name === "echo_workflow")?.description).toBe("The echo_workflow tool");

    // Workflow tool, with progress over SSE.
    const progress: Array<{ progress: number; total?: number }> = [];
    const workflowResult = await client.callTool({ name: "echo_workflow", arguments: { text: "hi" } }, undefined, {
      onprogress: (event) => progress.push(event)
    });
    expect(workflowResult.isError).toBeFalsy();
    expect(textOf(workflowResult)).toContain("answered:hi");
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]!.progress).toBe(0);
    const executionId = (workflowResult._meta as { executionId?: string } | undefined)?.executionId;
    expect(executionId).toBeTruthy();
    const execution = context.store.getExecutionHistory(executionId!);
    expect(execution?.status).toBe("success");
    expect(execution?.triggerType).toBe("mcp_gateway");

    // Gateway tool on the mock adapter.
    const calc = await client.callTool({ name: "mock_tools__calculator", arguments: { expression: "20+22" } });
    expect(calc.isError).toBeFalsy();
    expect(calc.structuredContent).toEqual({ expression: "20+22", result: 42 });

    // Gateway tool on a real stdio server, with the secret injected but never returned.
    const echo = await client.callTool({ name: "echo_server__echo", arguments: { msg: "hello" } });
    expect(textOf(echo)).toBe("echo: hello");
    const envcheck = await client.callTool({ name: "echo_server__envcheck", arguments: {} });
    expect(textOf(envcheck)).toBe("TOKEN=[REDACTED]");
    expect(JSON.stringify(envcheck)).not.toContain(INJECTED_SECRET);

    // Cancel a long workflow run: the run ends canceled.
    const before = new Set(context.store.listExecutionHistory({ triggerType: "mcp_gateway", pageSize: 100 }).items.map((item) => item.id));
    const workflowAbort = new AbortController();
    const slowCall = client.callTool({ name: "slow_workflow", arguments: { text: "x" } }, undefined, {
      signal: workflowAbort.signal,
      onprogress: () => workflowAbort.abort("test cancel")
    });
    await expect(slowCall).rejects.toThrow();
    let canceledId = "";
    await waitFor(() => {
      const item = context.store
        .listExecutionHistory({ triggerType: "mcp_gateway", pageSize: 100 })
        .items.find((entry) => !before.has(entry.id) && entry.status === "canceled");
      canceledId = item?.id ?? "";
      return Boolean(item);
    });
    expect(context.store.getExecutionHistory(canceledId)?.workflowId).toBe("wf-slow");

    // Cancel a hanging stdio call: the child process is stopped.
    const pid = Number(textOf(await client.callTool({ name: "echo_server__pid", arguments: {} })));
    expect(processAlive(pid)).toBe(true);
    const hangAbort = new AbortController();
    const hangCall = client.callTool({ name: "echo_server__hang", arguments: {} }, undefined, {
      signal: hangAbort.signal,
      onprogress: () => hangAbort.abort("test cancel")
    });
    await expect(hangCall).rejects.toThrow();
    await waitFor(() => !processAlive(pid));

    // The next call starts the server again; ending the session stops it.
    const pid2 = Number(textOf(await client.callTool({ name: "echo_server__pid", arguments: {} })));
    expect(pid2).not.toBe(pid);
    expect(processAlive(pid2)).toBe(true);
    const sessionId = transport.sessionId!;
    await transport.terminateSession();
    await waitFor(() => !processAlive(pid2));
    const afterEnd = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 9, method: "ping" }, {
      authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId
    });
    expect(afterEnd.statusCode).toBe(404);
  }, 60_000);

  it("pages tools/list with a cursor and answers ping", async () => {
    const { context, toolset, token } = await setupFixture();
    const sessionId = await openSession(context, toolset.slug, token);
    const headers = { authorization: `Bearer ${token}`, "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" };
    const ping = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: "p", method: "ping" }, headers);
    expect(ping.json()).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    const list = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
    expect(list.json().result.nextCursor).toBeUndefined();
    const bad = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "nope" } }, headers);
    expect(bad.json().error.code).toBe(-32602);
  });
});

describe("L2M to L2M", () => {
  it("registers another instance's toolset endpoint as an http_mcp server, discovers and calls its tools", async () => {
    const upstream = await setupFixture();
    const downstream = await createTestContext();
    const admin = await login(downstream, "admin");
    const secret = await api<{ id: string }>(downstream, admin.cookie, "POST", "/api/secrets", {
      name: "upstream client token",
      provider: "custom",
      value: upstream.token
    });
    const connection = { endpoint: `${upstream.context.baseUrl}/mcp/${upstream.toolset.slug}`, authType: "bearer", timeoutMs: 20000 };
    const serverId = await registerServer(downstream, admin.cookie, {
      name: "Upstream L2M",
      adapterId: "http_mcp",
      connection,
      secretRef: { secretId: secret.body.id }
    });
    const tools = await api<{ tools: Array<{ name: string }> }>(downstream, admin.cookie, "GET", `/api/mcp/servers/${serverId}/tools`);
    expect(tools.body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["echo_workflow", "mock_tools__calculator"]));

    const called = await api<{ ok: boolean; output: unknown; error?: string }>(downstream, admin.cookie, "POST", "/api/mcp/test-tool", {
      serverId: "http_mcp",
      connection,
      secretRef: { secretId: secret.body.id },
      toolName: "mock_tools__calculator",
      args: { expression: "2*21" }
    });
    expect(called.body.ok).toBe(true);
    expect(called.body.output).toEqual({ expression: "2*21", result: 42 });

    const workflowCall = await api<{ ok: boolean; output: unknown }>(downstream, admin.cookie, "POST", "/api/mcp/test-tool", {
      serverId: "http_mcp",
      connection,
      secretRef: { secretId: secret.body.id },
      toolName: "echo_workflow",
      args: { text: "from downstream" }
    });
    expect(workflowCall.body.ok).toBe(true);
    expect(JSON.stringify(workflowCall.body.output)).toContain("answered:from downstream");
  }, 60_000);
});

describe("MCP gateway auth and security", () => {
  it("rejects missing, invalid, revoked and expired tokens with 401", async () => {
    const { context, admin, toolset, token, client } = await setupFixture();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } };

    const missing = await rpc(context, toolset.slug, init);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");

    expect((await rpc(context, toolset.slug, init, { authorization: "Bearer l2m_mcp_nope.nope" })).statusCode).toBe(401);
    expect((await rpc(context, toolset.slug, init, { authorization: `Bearer ${token}x` })).statusCode).toBe(401);
    expect((await rpc(context, toolset.slug, init, { authorization: "Basic abc" })).statusCode).toBe(401);

    context.store.createMcpClient({
      id: "mcc_expired",
      name: "Expired",
      tokenPrefix: "l2m_mcp_expiredtest1",
      tokenHash: hashSecret("expired-secret"),
      toolsetIds: [toolset.id],
      role: "viewer",
      createdBy: admin.id,
      createdByEmail: admin.email,
      expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    const expired = await rpc(context, toolset.slug, init, { authorization: "Bearer l2m_mcp_expiredtest1.expired-secret" });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.message).toMatch(/expired/);

    const sessionId = await openSession(context, toolset.slug, token);
    const revoked = await api(context, admin.cookie, "POST", `/api/mcp/clients/${client.id}/revoke`);
    expect(revoked.status).toBe(200);
    const afterRevoke = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 2, method: "ping" }, {
      authorization: `Bearer ${token}`,
      "mcp-session-id": sessionId
    });
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().error.message).toMatch(/revoked/);
  });

  it("returns 403 for a token scoped to another toolset and for a foreign Origin", async () => {
    const { context, admin, toolset, token } = await setupFixture();
    const other = await api<{ toolset: McpToolset }>(context, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Other", members: [] });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } };
    const wrongScope = await rpc(context, other.body.toolset.slug, init, { authorization: `Bearer ${token}` });
    expect(wrongScope.statusCode).toBe(403);

    const auth = { authorization: `Bearer ${token}` };
    expect((await rpc(context, toolset.slug, init, { ...auth, origin: "http://evil.example.test" })).statusCode).toBe(403);
    expect((await rpc(context, toolset.slug, init, { ...auth, origin: "null" })).statusCode).toBe(403);
    expect((await rpc(context, toolset.slug, init, { ...auth, origin: "https://ide.example.test" })).statusCode).toBe(200);
    expect((await rpc(context, toolset.slug, init, { ...auth, origin: "http://studio.example.test" })).statusCode).toBe(200);
    expect((await rpc(context, "does-not-exist", init, auth)).statusCode).toBe(404);

    const get = await context.app.inject({ method: "GET", url: `/mcp/${toolset.slug}`, headers: auth });
    expect(get.statusCode).toBe(405);

    // CORS for the endpoint follows the gateway's origin list, without credentials.
    const preflight = (origin: string) =>
      context.app.inject({
        method: "OPTIONS",
        url: `/mcp/${toolset.slug}`,
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,mcp-session-id" }
      });
    const allowed = await preflight("https://ide.example.test");
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://ide.example.test");
    expect(String(allowed.headers["access-control-allow-headers"])).toContain("Mcp-Session-Id");
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    const foreign = await preflight("http://evil.example.test");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    const initialized = await rpc(context, toolset.slug, init, { ...auth, origin: "https://ide.example.test" });
    expect(String(initialized.headers["access-control-expose-headers"])).toContain("Mcp-Session-Id");
    // The studio API keeps its own CORS rules: the MCP origin gets nothing there.
    const studio = await context.app.inject({ method: "OPTIONS", url: "/api/mcp/toolsets", headers: { origin: "https://ide.example.test", "access-control-request-method": "GET" } });
    expect(studio.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers protocol errors as JSON-RPC errors and enforces sessions, versions and batches", async () => {
    const { context, toolset, token } = await setupFixture();
    const auth = { authorization: `Bearer ${token}` };
    const parse = await rpc(context, toolset.slug, "{not json", auth);
    expect(parse.statusCode).toBe(400);
    expect(parse.json().error.code).toBe(-32700);

    expect((await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "ping" }, auth)).statusCode).toBe(400);
    expect((await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "ping" }, { ...auth, "mcp-session-id": "nope" })).statusCode).toBe(404);

    const sessionId = await openSession(context, toolset.slug, token);
    const headers = { ...auth, "mcp-session-id": sessionId };
    expect((await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "ping" }, { ...headers, "mcp-protocol-version": "1999-01-01" })).statusCode).toBe(400);
    expect((await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "resources/list" }, headers)).json().error.code).toBe(-32601);
    const unknownTool = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: {} } }, headers);
    expect(unknownTool.json().error.code).toBe(-32602);
    const badArgs = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo_workflow", arguments: [1] } }, headers);
    expect(badArgs.json().error.code).toBe(-32602);
    const notification = await rpc(context, toolset.slug, { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
    expect(notification.statusCode).toBe(202);
    expect(notification.body).toBe("");
    const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }];
    expect((await rpc(context, toolset.slug, batch, headers)).statusCode).toBe(400);

    // The 2025-03-26 revision still has batches.
    const legacySession = await openSession(context, toolset.slug, token, "2025-03-26");
    const batched = await rpc(context, toolset.slug, batch, { ...auth, "mcp-session-id": legacySession });
    expect(batched.statusCode).toBe(200);
    expect(batched.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} }
    ]);

    // An unknown version is answered with the latest one.
    const unknownVersion = await rpc(
      context,
      toolset.slug,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      auth
    );
    expect(unknownVersion.json().result.protocolVersion).toBe("2025-11-25");
  });

  it("evaluates policy with the client's role capped at its creator's role, hiding and rejecting denied tools", async () => {
    const { context, admin, toolset, mockServerId } = await setupFixture();
    const creator = await login(context, "admin", "second-admin");
    const { token } = await createClientToken(context, creator.cookie, { name: "Admin client", toolsetIds: [toolset.id], role: "admin" });
    const rule = await api<{ rule: { id: string } }>(context, admin.cookie, "POST", "/api/mcp/policies", {
      name: "Builders: no calculator",
      effect: "deny",
      roles: ["builder"],
      serverId: mockServerId,
      toolPattern: "calculator"
    });
    expect(rule.status).toBe(201);
    context.store.upsertWorkflow(calculatorWorkflow("wf-calc", mockServerId), { createdBy: admin.id });
    await api(context, admin.cookie, "POST", `/api/mcp/toolsets/${toolset.id}/members`, { kind: "workflow", workflowId: "wf-calc" });

    const listNames = async () => {
      const sessionId = await openSession(context, toolset.slug, token);
      const list = await rpc(context, toolset.slug, { jsonrpc: "2.0", id: 2, method: "tools/list" }, {
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId
      });
      return { sessionId, names: (list.json().result.tools as Array<{ name: string }>).map((tool) => tool.name) };
    };

    // As admin the calculator is visible.
    expect((await listNames()).names).toContain("mock_tools__calculator");

    // Demote the creator: the client is capped at builder.
    const stored = context.store.getUserById(creator.id)!;
    context.store.saveUser({ id: stored.id, email: stored.email, passwordHash: stored.passwordHash, role: "builder" });
    const { sessionId, names } = await listNames();
    expect(names).not.toContain("mock_tools__calculator");
    expect(names).toContain("mock_tools__lookup_kb");

    const headers = { authorization: `Bearer ${token}`, "mcp-session-id": sessionId };
    const denied = await rpc(context, toolset.slug, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "mock_tools__calculator", arguments: { expression: "1+1" } }
    }, headers);
    const deniedResult = denied.json().result;
    expect(deniedResult.isError).toBe(true);
    expect(deniedResult.content[0].text).toMatch(/blocked by policy 'Builders: no calculator'/);

    // Inside a workflow tool the same subject applies.
    const viaWorkflow = await rpc(context, toolset.slug, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "calc_workflow", arguments: {} }
    }, headers);
    expect(viaWorkflow.json().result.isError).toBe(true);
    expect(viaWorkflow.json().result.content[0].text).toMatch(/blocked by policy/);

    const deniedAudit = context.store.listAuditLogs({ eventType: "mcp_gateway.tool_denied" }).items;
    expect(deniedAudit.length).toBeGreaterThanOrEqual(1);
    expect(deniedAudit[0]!.outcome).toBe("denied");
  });

  it("fails calls to a server that is blocked on a breaking change", async () => {
    const { context, toolset, token, mockServerId } = await setupFixture();
    const server = context.store.getMcpServer(mockServerId)!;
    const current = context.store.getMcpToolSnapshot(server.currentSnapshotId!)!;
    context.store.updateMcpServer(mockServerId, { blockOnBreakingChange: true });
    context.store.recordMcpServerProbe({
      probe: { id: "probe_break", serverId: mockServerId, startedAt: new Date().toISOString(), ok: true, latencyMs: 1, toolCount: current.toolCount, error: null, snapshotId: "snap_break" },
      status: "healthy",
      snapshot: { ...current, id: "snap_break", previousSnapshotId: current.id, breaking: true, changes: [{ tool: "calculator", kind: "removed", breaking: true, detail: "test" }], createdAt: new Date().toISOString() },
      keepProbes: 10
    });
    const sessionId = await openSession(context, toolset.slug, token);
    const call = await rpc(context, toolset.slug, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "mock_tools__calculator", arguments: { expression: "1+1" } }
    }, { authorization: `Bearer ${token}`, "mcp-session-id": sessionId });
    expect(call.json().result.isError).toBe(true);
    expect(call.json().result.content[0].text).toMatch(/breaking way/);
  });

  it("never returns token hashes or tokens after creation, nor puts them in audit metadata", async () => {
    const { context, admin, token, client } = await setupFixture();
    const list = await context.app.inject({ method: "GET", url: "/api/mcp/clients", headers: { cookie: admin.cookie } });
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain(token.split(".")[1]!);
    expect(list.body).not.toContain("tokenHash");
    expect(list.json().clients[0].tokenPrefix).toBe(client.tokenPrefix);
    const audits = JSON.stringify(context.store.listAuditLogs({ pageSize: 500 }).items);
    expect(audits).not.toContain(token.split(".")[1]!);
    expect(audits).not.toContain(INJECTED_SECRET);
  });
});

describe("MCP gateway telemetry and audit", () => {
  it("records gateway rows with source and client id, rolls up per-client usage and audits write tools", async () => {
    const { context, admin, toolset, token, client, mockServerId } = await setupFixture();
    const sessionId = await openSession(context, toolset.slug, token);
    const headers = { authorization: `Bearer ${token}`, "mcp-session-id": sessionId };
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      rpc(context, toolset.slug, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, headers);

    expect((await call(1, "mock_tools__calculator", { expression: "1+2" })).json().result.isError).toBeUndefined();
    expect((await call(2, "mock_tools__calculator", { expression: "oops" })).json().result.isError).toBe(true);
    await call(3, "mock_tools__lookup_kb", { topic: "mcp" });
    await call(4, "mock_tools__lookup_kb", { topic: "rag" });
    await call(5, "echo_workflow", { text: "t" });

    const rows = context.store.listMcpToolCallsForClient(client.id, new Date(Date.now() - 60_000).toISOString());
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.source === "gateway" && row.clientId === client.id)).toBe(true);
    const workflowRow = rows.find((row) => row.toolName === "echo_workflow")!;
    expect(workflowRow.adapterId).toBe("workflow");
    expect(workflowRow.workflowId).toBe("wf-echo");
    expect(context.store.getExecutionHistory(workflowRow.executionId)?.status).toBe("success");

    // Registry rows count toward the server's telemetry; gateway workflow rows stay out of the inline rollup.
    const serverTelemetry = await api<{ totals: { calls: number } }>(context, admin.cookie, "GET", `/api/mcp/servers/${mockServerId}/telemetry`);
    expect(serverTelemetry.body.totals.calls).toBe(4);
    const inline = await api<{ totals: { calls: number } }>(context, admin.cookie, "GET", "/api/mcp/telemetry");
    expect(inline.body.totals.calls).toBe(0);

    const usage = await api<{ totals: { calls: number; errors: number }; lastUsedAt: string | null; tools: Array<{ toolName: string }> }>(
      context,
      admin.cookie,
      "GET",
      `/api/mcp/clients/${client.id}/usage?window=24h`
    );
    expect(usage.body.totals).toMatchObject({ calls: 5, errors: 1 });
    expect(usage.body.lastUsedAt).toBeTruthy();
    const listed = await api<{ clients: Array<{ id: string; usage: { calls: number; errors: number } }> }>(context, admin.cookie, "GET", "/api/mcp/clients");
    expect(listed.body.clients.find((entry) => entry.id === client.id)?.usage).toMatchObject({ calls: 5, errors: 1 });

    const called = context.store.listAuditLogs({ eventType: "mcp_gateway.tool_called", pageSize: 100 }).items;
    const byTool = (tool: string) => called.filter((entry) => (entry.metadata as { tool?: string }).tool === tool);
    // calculator has no read-only hint (a write tool): every call. lookup_kb is read-only: first call only.
    expect(byTool("mock_tools__calculator")).toHaveLength(2);
    expect(byTool("mock_tools__lookup_kb")).toHaveLength(1);
    expect(byTool("echo_workflow")).toHaveLength(1);
    expect(called.find((entry) => entry.outcome === "failure")).toBeTruthy();
    expect(context.store.listAuditLogs({ eventType: "mcp_gateway.session_started" }).items.length).toBeGreaterThanOrEqual(1);
  });
});

describe("MCP toolset and client admin API", () => {
  it("enforces RBAC, validates members and slugs, previews per role and audits changes", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const mockServerId = await registerServer(context, admin.cookie, { name: "Mock tools", adapterId: "mock-mcp" });
    context.store.upsertWorkflow(triggerWorkflow("wf-echo", "echo_workflow"), { createdBy: admin.id });
    context.store.upsertWorkflow({ id: "wf-plain", name: "Plain", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });

    expect((await api(context, builder.cookie, "POST", "/api/mcp/toolsets", { name: "X" })).status).toBe(403);
    expect((await api(context, viewer.cookie, "GET", "/api/mcp/toolsets")).status).toBe(403);
    expect((await api(context, builder.cookie, "GET", "/api/mcp/toolsets")).status).toBe(200);
    expect((await api(context, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Bad", members: [{ kind: "workflow", workflowId: "wf-plain" }] })).status).toBe(400);
    expect((await api(context, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Bad", slug: "Not A Slug" })).status).toBe(400);

    const created = await api<{ toolset: McpToolset & { endpointPath: string } }>(context, admin.cookie, "POST", "/api/mcp/toolsets", {
      name: "Support Desk",
      members: [
        { kind: "workflow", workflowId: "wf-echo" },
        { kind: "server", serverId: mockServerId, toolGlob: "lookup_*" }
      ]
    });
    expect(created.status).toBe(201);
    expect(created.body.toolset.slug).toBe("support-desk");
    expect(created.body.toolset.endpointPath).toBe("/mcp/support-desk");
    const second = await api<{ toolset: McpToolset }>(context, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Support desk" });
    expect(second.body.toolset.slug).toBe("support-desk-2");
    expect((await api(context, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Dup", slug: "support-desk" })).status).toBe(409);

    const candidates = await api<{ workflows: Array<{ id: string; tools: string[] }> }>(context, builder.cookie, "GET", "/api/mcp/toolsets/candidates");
    expect(candidates.body.workflows).toEqual([expect.objectContaining({ id: "wf-echo", tools: ["echo_workflow"] })]);

    await api(context, admin.cookie, "POST", "/api/mcp/policies", { effect: "deny", roles: ["viewer"], serverId: mockServerId, toolPattern: "lookup_kb" });
    const asBuilder = await api<{ tools: Array<{ name: string }>; hidden: Array<{ name: string; message: string }> }>(
      context,
      builder.cookie,
      "GET",
      `/api/mcp/toolsets/${created.body.toolset.id}/preview?role=builder`
    );
    expect(asBuilder.body.tools.map((tool) => tool.name)).toEqual(["echo_workflow", "mock_tools__lookup_kb"]);
    const asViewer = await api<{ tools: Array<{ name: string }>; hidden: Array<{ name: string }> }>(
      context,
      builder.cookie,
      "GET",
      `/api/mcp/toolsets/${created.body.toolset.id}/preview?role=viewer`
    );
    expect(asViewer.body.tools.map((tool) => tool.name)).toEqual(["echo_workflow"]);
    expect(asViewer.body.hidden.map((tool) => tool.name)).toEqual(["mock_tools__lookup_kb"]);
    expect((await api(context, builder.cookie, "GET", `/api/mcp/toolsets/${created.body.toolset.id}/preview?role=root`)).status).toBe(400);

    const updated = await api<{ toolset: McpToolset }>(context, admin.cookie, "PUT", `/api/mcp/toolsets/${created.body.toolset.id}`, {
      description: "Answers support questions",
      members: [{ kind: "server", serverId: mockServerId }]
    });
    expect(updated.status).toBe(200);
    expect(updated.body.toolset.members).toHaveLength(1);
    const memberId = updated.body.toolset.members[0]!.id;
    expect((await api(context, admin.cookie, "DELETE", `/api/mcp/toolsets/${created.body.toolset.id}/members/${memberId}`)).status).toBe(200);
    expect((await api(context, builder.cookie, "DELETE", `/api/mcp/toolsets/${created.body.toolset.id}`)).status).toBe(403);

    // Clients: admin-only writes, role checks, token once.
    expect((await api(context, builder.cookie, "POST", "/api/mcp/clients", { name: "c", toolsetIds: [created.body.toolset.id], role: "viewer" })).status).toBe(403);
    expect((await api(context, admin.cookie, "POST", "/api/mcp/clients", { name: "c", toolsetIds: ["mts_missing"], role: "viewer" })).status).toBe(400);
    expect(
      (await api(context, admin.cookie, "POST", "/api/mcp/clients", { name: "c", toolsetIds: [created.body.toolset.id], role: "viewer", expiresAt: "2001-01-01T00:00:00.000Z" })).status
    ).toBe(400);
    const minted = await createClientToken(context, admin.cookie, { name: "CLI agent", toolsetIds: [created.body.toolset.id], role: "operator" });
    expect(minted.token).toMatch(/^l2m_mcp_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(minted.token.startsWith(minted.client.tokenPrefix)).toBe(true);
    expect((await api(context, builder.cookie, "POST", `/api/mcp/clients/${minted.client.id}/revoke`)).status).toBe(403);
    const revoked = await api<{ client: { status: string } }>(context, admin.cookie, "POST", `/api/mcp/clients/${minted.client.id}/revoke`);
    expect(revoked.body.client.status).toBe("revoked");

    expect((await api(context, admin.cookie, "DELETE", `/api/mcp/toolsets/${created.body.toolset.id}`)).status).toBe(200);
    expect(context.store.getMcpClient(minted.client.id)?.toolsetIds).toEqual([]);

    const events = context.store.listAuditLogs({ pageSize: 200 }).items.map((entry) => entry.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        "mcp_toolset.created",
        "mcp_toolset.updated",
        "mcp_toolset.member_removed",
        "mcp_toolset.deleted",
        "mcp_client.created",
        "mcp_client.revoked"
      ])
    );
  });

  it("documents the endpoint and the admin routes in OpenAPI", () => {
    const paths = Object.keys(openApiSpec.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/mcp/{toolset}",
        "/api/mcp/toolsets",
        "/api/mcp/toolsets/{id}",
        "/api/mcp/toolsets/{id}/preview",
        "/api/mcp/toolsets/{id}/members",
        "/api/mcp/toolsets/{id}/members/{memberId}",
        "/api/mcp/clients",
        "/api/mcp/clients/{id}/revoke",
        "/api/mcp/clients/{id}/usage"
      ])
    );
  });
});

describe("MCP gateway schema", () => {
  it("adds source and client_id to an existing mcp_tool_calls table and the new tables on SQLite", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-gateway-legacy-"));
    try {
      const file = path.join(tempDir, "legacy.db");
      const legacy = new Database(file);
      legacy.exec(`
        CREATE TABLE mcp_tool_calls (
          id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL,
          registry_server_id TEXT, adapter_id TEXT NOT NULL, tool_name TEXT NOT NULL, started_at TEXT NOT NULL,
          duration_ms INTEGER, ok INTEGER NOT NULL, error TEXT, turn_input_tokens INTEGER, turn_output_tokens INTEGER,
          estimated_cost_usd REAL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok)
        VALUES ('old', 'exec', 'wf', 'n', 'mock-mcp', 'calculator', '2026-10-01T00:00:00.000Z', 1);
      `);
      legacy.close();

      const store = await SqliteStore.create(file);
      const rows = store.listMcpToolCalls({ registryServerId: null, since: "2026-01-01T00:00:00.000Z" });
      expect(rows).toEqual([expect.objectContaining({ id: "old", source: "workflow", clientId: null })]);
      expect(store.listMcpToolsets()).toEqual([]);
      expect(store.listMcpClients()).toEqual([]);
      store.close();

      const check = new Database(file);
      const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(["mcp_toolsets", "mcp_toolset_members", "mcp_clients"]));
      check.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("ships Postgres migration v23 with the gateway tables, telemetry columns and a reversing down", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 23);
    expect(migration).toBeDefined();
    expect(Math.max(...MIGRATIONS.map((entry) => entry.version))).toBeGreaterThanOrEqual(23);
    for (const table of ["mcp_toolsets", "mcp_toolset_members", "mcp_clients"]) {
      expect(migration!.up).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migration!.down).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(migration!.up).toContain("ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'workflow'");
    expect(migration!.up).toContain("ADD COLUMN IF NOT EXISTS client_id TEXT");
    expect(migration!.up).toContain("token_hash TEXT NOT NULL");
    expect(migration!.down).toContain("DROP COLUMN IF EXISTS client_id");
    expect(migration!.down).toContain("DROP COLUMN IF EXISTS source");
  });
});
