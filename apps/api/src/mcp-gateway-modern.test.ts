/**
 * MCP 2026-07-28 at the gateway: one endpoint serves modern callers (per-request `_meta`, no sessions) next to
 * session-based ones when MCP_GATEWAY_MODERN_PROTOCOL=on, and answers modern requests exactly as before when it is off.
 *
 * Raw JSON-RPC over app.inject for most cases; a real socket where a test needs the client to close the connection.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mcpSafetyPresetRuleId, type McpClient, type McpGatewaySessionView, type McpToolset, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  baseUrl: string;
}

const contexts: TestContext[] = [];

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

/** A stdio server with a tool whose schema carries an `x-mcp-header` annotation, a pid tool and a tool that hangs. */
const HEADER_SERVER_SCRIPT = `
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
      reply(req.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'header-test', version: '1.0' } });
    } else if (req.method === 'tools/list') {
      reply(req.id, { tools: [
        { name: 'regional', description: 'Region in a header', inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'pid', description: 'Returns the server pid', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'hang', description: 'Never answers', inputSchema: { type: 'object' } },
        { name: 'slow_pid', description: 'Returns the pid after a while', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
      ] });
    } else if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      if (name === 'regional') reply(req.id, { content: [{ type: 'text', text: 'region: ' + (args.region || '') }] });
      else if (name === 'pid') reply(req.id, { content: [{ type: 'text', text: String(process.pid) }] });
      else if (name === 'hang') { /* never answers */ }
      else if (name === 'slow_pid') setTimeout(() => reply(req.id, { content: [{ type: 'text', text: String(process.pid) }] }), 1500);
      else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Unknown tool' } }) + '\\n');
    } else if (req.id !== undefined) {
      reply(req.id, {});
    }
  }
});
`;

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-gateway-modern-"));
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
    WEB_ORIGIN: "http://studio.example.test",
    MCP_GATEWAY_ALLOWED_ORIGINS: "https://ide.example.test",
    ...overrides
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const context: TestContext = { app, store, authService, config, tempDir, baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
  contexts.push(context);
  return context;
}

async function login(context: TestContext): Promise<string> {
  const email = "admin@example.com";
  const password = "admin-Pass-123!";
  await context.authService.register({ email, password, role: "admin" });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return String([response.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${context.config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
}

async function api<T = Record<string, unknown>>(context: TestContext, cookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const response = await context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: response.statusCode, body: (response.body ? response.json() : {}) as T };
}

function workflowTool(id: string, toolName: string, extraNodes: Workflow["nodes"] = []): Workflow {
  const lastId = extraNodes.length > 0 ? extraNodes[extraNodes.length - 1]!.id : "trigger";
  return {
    id,
    name: `Workflow ${toolName}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: `${id}-path`, toolName, toolDescription: `The ${toolName} tool`, inputSchema: { type: "object", properties: { text: { type: "string" } } }, authMode: "public" }
      },
      ...extraNodes,
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { outputKey: "result", responseTemplate: "answered:{{text}}" } }
    ],
    edges: [...(extraNodes.length > 0 ? [{ id: "e0", source: "trigger", target: extraNodes[0]!.id }] : []), { id: "e-out", source: lastId, target: "out" }]
  };
}

interface Fixture {
  context: TestContext;
  cookie: string;
  toolset: McpToolset;
  client: McpClient;
  token: string;
  mockServerId: string;
}

async function setup(options: { env?: Record<string, string>; track?: boolean; presets?: string[]; description?: string | null } = {}): Promise<Fixture> {
  const context = await createTestContext(options.env);
  const cookie = await login(context);
  const register = async (payload: Record<string, unknown>) => {
    const created = await api<{ server: { id: string } }>(context, cookie, "POST", "/api/mcp/servers", { probeEnabled: false, ...payload });
    expect(created.status).toBe(201);
    const probe = await api<{ probe: { ok: boolean; error: string | null } }>(context, cookie, "POST", `/api/mcp/servers/${created.body.server.id}/probe`);
    expect(probe.body.probe.ok, probe.body.probe.error ?? "").toBe(true);
    return created.body.server.id;
  };
  const mockServerId = await register({ name: "Mock tools", adapterId: "mock-mcp" });
  const headerServerId = await register({
    name: "Header server",
    adapterId: "stdio_mcp",
    connection: { command: process.execPath, args: ["-e", HEADER_SERVER_SCRIPT], timeoutMs: 20000 }
  });
  await context.store.upsertWorkflow(workflowTool("wf-echo", "echo_workflow"));
  await context.store.upsertWorkflow(
    workflowTool("wf-slow", "slow_workflow", [{ id: "wait", type: "wait_node", name: "Wait", position: { x: 200, y: 0 }, config: { delayMs: 20000, maxDelayMs: 30000 } }])
  );
  const toolset = await api<{ toolset: McpToolset }>(context, cookie, "POST", "/api/mcp/toolsets", {
    name: "Main tools",
    ...(options.description === null ? {} : { description: options.description ?? "Everything the tests need" }),
    projectId: "default",
    ...(options.track ? { trackSessionLabels: true } : {}),
    members: [
      { kind: "workflow", workflowId: "wf-echo" },
      { kind: "workflow", workflowId: "wf-slow" },
      { kind: "server", serverId: mockServerId },
      { kind: "server", serverId: headerServerId, toolGlob: "*" }
    ]
  });
  expect(toolset.status).toBe(201);
  const client = await api<{ client: McpClient; token: string }>(context, cookie, "POST", "/api/mcp/clients", {
    name: "IDE agent",
    toolsetIds: [toolset.body.toolset.id],
    role: "builder"
  });
  expect(client.status).toBe(201);
  for (const preset of options.presets ?? []) {
    expect((await api(context, cookie, "POST", `/api/mcp/policies/presets/${preset}`)).status).toBe(201);
    expect((await api(context, cookie, "POST", `/api/mcp/policies/${mcpSafetyPresetRuleId(preset as never)}/enforce`)).status).toBe(200);
  }
  return { context, cookie, toolset: toolset.body.toolset, client: client.body.client, token: client.body.token, mockServerId };
}

const MODERN = "2026-07-28";

function modernMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "2.0" },
    ...extra
  };
}

/** The standard request metadata headers a modern client sends for `method` (and `name` for tools/call). */
function modernHeaders(method: string, name?: string): Record<string, string> {
  return { "mcp-protocol-version": MODERN, "mcp-method": method, ...(name !== undefined ? { "mcp-name": name } : {}) };
}

let nextId = 100;

async function rpc(fixture: Pick<Fixture, "context" | "toolset" | "token">, body: unknown, headers: Record<string, string> = {}) {
  return fixture.context.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${fixture.token}`, ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body)
  });
}

/** A well-formed modern request. */
async function modern(fixture: Fixture, method: string, params: Record<string, unknown> = {}, extra: { headers?: Record<string, string>; meta?: Record<string, unknown> } = {}) {
  const name = method === "tools/call" ? String(params.name) : undefined;
  return rpc(
    fixture,
    { jsonrpc: "2.0", id: (nextId += 1), method, params: { ...params, _meta: modernMeta(extra.meta) } },
    { ...modernHeaders(method, name), ...(extra.headers ?? {}) }
  );
}

async function openSession(fixture: Fixture): Promise<string> {
  const response = await rpc(fixture, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }
  });
  expect(response.statusCode).toBe(200);
  return response.headers["mcp-session-id"] as string;
}

function textOf(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> }).content ?? []).map((entry) => entry.text ?? "").join("\n");
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition not met in time");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function auditEvents(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 100 })).items;
}

describe("modern mode off (the default)", () => {
  it("answers modern requests exactly as a request without a session, so dual-era clients fall back", async () => {
    const fixture = await setup();
    expect(fixture.context.config.MCP_GATEWAY_MODERN_PROTOCOL).toBeUndefined();
    const sessionless = await rpc(fixture, { jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(sessionless.statusCode).toBe(400);
    for (const method of ["server/discover", "tools/list", "tools/call"]) {
      const response = await rpc(
        fixture,
        { jsonrpc: "2.0", id: 7, method, params: { ...(method === "tools/call" ? { name: "echo_workflow", arguments: {} } : {}), _meta: modernMeta() } },
        { ...modernHeaders(method, method === "tools/call" ? "echo_workflow" : undefined), "mcp-protocol-version": "2025-11-25" }
      );
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual(sessionless.json());
      expect(response.json().error.code).toBe(-32000);
    }
    // The modern version in the header: today's non-modern "unsupported" answer.
    const header = await modern(fixture, "tools/list");
    expect(header.statusCode).toBe(400);
    expect(header.json().error).toMatchObject({ code: -32000 });
    expect(header.json().error.message).toContain("Unsupported MCP-Protocol-Version '2026-07-28'");
    // The toolset list shows only the legacy versions.
    const listed = await api<{ protocolVersions: string[] }>(fixture.context, fixture.cookie, "GET", "/api/mcp/toolsets");
    expect(listed.body.protocolVersions).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
    // CORS preflight: the legacy header list, nothing reflected.
    const preflight = await fixture.context.app.inject({
      method: "OPTIONS",
      url: `/mcp/${fixture.toolset.slug}`,
      headers: { origin: "https://ide.example.test", "access-control-request-method": "POST", "access-control-request-headers": "mcp-method, mcp-param-region" }
    });
    expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).not.toContain("mcp-method");
  });
});

describe("modern mode on", () => {
  const on = { MCP_GATEWAY_MODERN_PROTOCOL: "on", MCP_GATEWAY_LIST_TTL_MS: "45000" };

  it("answers server/discover with both eras, capabilities, instructions, server info and cache hints", async () => {
    const fixture = await setup({ env: on });
    const response = await modern(fixture, "server/discover");
    expect(response.statusCode).toBe(200);
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    expect(response.json().result).toEqual({
      resultType: "complete",
      supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
      capabilities: { tools: { listChanged: true } },
      instructions: "Everything the tests need",
      ttlMs: 45000,
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: `l2m-${fixture.toolset.slug}`, title: "Main tools", version: "0.1.0" } }
    });
    const listed = await api<{ protocolVersions: string[] }>(fixture.context, fixture.cookie, "GET", "/api/mcp/toolsets");
    expect(listed.body.protocolVersions).toEqual(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  });

  it("lists tools sorted by name, with cache hints and server info, and without x-mcp-header annotations", async () => {
    const fixture = await setup({ env: on });
    const response = await modern(fixture, "tools/list");
    expect(response.statusCode).toBe(200);
    const result = response.json().result as { tools: Array<{ name: string; inputSchema: unknown }>; resultType: string; ttlMs: number; cacheScope: string; _meta: Record<string, unknown> };
    expect(result).toMatchObject({ resultType: "complete", ttlMs: 45000, cacheScope: "private" });
    expect(result._meta["io.modelcontextprotocol/serverInfo"]).toMatchObject({ name: `l2m-${fixture.toolset.slug}` });
    const names = result.tools.map((tool) => tool.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual(expect.arrayContaining(["echo_workflow", "mock_tools__calculator", "header_server__regional"]));
    const regional = result.tools.find((tool) => tool.name === "header_server__regional")!;
    expect(regional.inputSchema).toEqual({ type: "object", properties: { region: { type: "string" }, query: { type: "string" } } });
    expect(JSON.stringify(result)).not.toContain("x-mcp-header");

    // A legacy session still sees the upstream schema as before.
    const sessionId = await openSession(fixture);
    const legacy = await rpc(fixture, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
    const legacyResult = legacy.json().result;
    expect(legacyResult.resultType).toBeUndefined();
    expect(legacyResult.ttlMs).toBeUndefined();
    expect(JSON.stringify(legacyResult)).toContain("x-mcp-header");
  });

  it("calls server and workflow tools statelessly; Mcp-Session-Id is ignored and never echoed", async () => {
    const fixture = await setup({ env: on });
    const calc = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "20+22" } }, { headers: { "mcp-session-id": "not-a-session" } });
    expect(calc.statusCode).toBe(200);
    expect(calc.headers["mcp-session-id"]).toBeUndefined();
    expect(calc.json().result).toMatchObject({ resultType: "complete", structuredContent: { expression: "20+22", result: 42 } });
    expect(calc.json().result._meta["io.modelcontextprotocol/serverInfo"]).toBeTruthy();

    const regional = await modern(fixture, "tools/call", { name: "header_server__regional", arguments: { region: "us-west1" } });
    expect(textOf(regional.json().result)).toBe("region: us-west1");

    const workflow = await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "hi" } });
    expect(textOf(workflow.json().result)).toContain("answered:hi");
    expect(workflow.json().result._meta.executionId).toBeTruthy();
    expect(workflow.json().result._meta["io.modelcontextprotocol/serverInfo"]).toBeTruthy();
    expect((await fixture.context.store.getExecutionHistory(workflow.json().result._meta.executionId))?.status).toBe("success");
  });

  it("streams progress over SSE with X-Accel-Buffering and ends with a modern result", async () => {
    const fixture = await setup({ env: on });
    const response = await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "sse" } }, { meta: { progressToken: "p1" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["mcp-session-id"]).toBeUndefined();
    const messages = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(messages.some((message) => message.method === "notifications/progress")).toBe(true);
    const final = messages.find((message) => "result" in message) as { result: Record<string, unknown> };
    expect(final.result.resultType).toBe("complete");
    expect(textOf(final.result)).toContain("answered:sse");
  });

  it("validates each request: missing version, unsupported version, headers, capabilities, unknown methods", async () => {
    const fixture = await setup({ env: on });
    const send = (params: Record<string, unknown>, headers: Record<string, string>, method = "tools/list") =>
      rpc(fixture, { jsonrpc: "2.0", id: 9, method, params }, headers);

    // A protocol version key without a usable value: -32602.
    const blank = await send({ _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "" } }, modernHeaders("tools/list"));
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatchObject({ code: -32602 });

    // A version the gateway does not serve statelessly: -32022 with every version it speaks.
    const future = await send({ _meta: modernMeta({ "io.modelcontextprotocol/protocolVersion": "2027-01-01" }) }, { ...modernHeaders("tools/list"), "mcp-protocol-version": "2027-01-01" });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"], requested: "2027-01-01" } }
    });
    // The modern version in the header over an unknown version in _meta: the header does not match the body, -32020.
    const mismatch = await send({ _meta: modernMeta({ "io.modelcontextprotocol/protocolVersion": "v999.0.0" }) }, modernHeaders("tools/list"));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ id: 9, error: { code: -32020 } });
    // A legacy version named in modern _meta is not served without initialize either.
    const legacyInMeta = await send({ _meta: modernMeta({ "io.modelcontextprotocol/protocolVersion": "2025-11-25" }) }, { ...modernHeaders("tools/list"), "mcp-protocol-version": "2025-11-25" });
    expect(legacyInMeta.json().error.code).toBe(-32022);

    // Header checks: -32020.
    const noVersionHeader = await send({ _meta: modernMeta() }, { "mcp-method": "tools/list" });
    expect(noVersionHeader.statusCode).toBe(400);
    expect(noVersionHeader.json().error.code).toBe(-32020);
    const otherVersion = await send({ _meta: modernMeta() }, { ...modernHeaders("tools/list"), "mcp-protocol-version": "2025-11-25" });
    expect(otherVersion.json().error.code).toBe(-32020);
    const noMethod = await send({ _meta: modernMeta() }, { "mcp-protocol-version": MODERN });
    expect(noMethod.json().error.code).toBe(-32020);
    const wrongMethod = await send({ _meta: modernMeta() }, modernHeaders("tools/call", "x"));
    expect(wrongMethod.json().error.code).toBe(-32020);
    const callParams = { name: "mock_tools__calculator", arguments: { expression: "1+1" }, _meta: modernMeta() };
    const noName = await send(callParams, modernHeaders("tools/call"), "tools/call");
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe(-32020);
    const wrongName = await send(callParams, modernHeaders("tools/call", "echo_workflow"), "tools/call");
    expect(wrongName.json().error).toMatchObject({ code: -32020 });
    const encodedName = await send(callParams, modernHeaders("tools/call", `=?base64?${Buffer.from("mock_tools__calculator").toString("base64")}?=`), "tools/call");
    expect(encodedName.statusCode).toBe(200);
    expect(encodedName.json().result.structuredContent).toMatchObject({ result: 2 });

    // A modern version in the header but no _meta (or no version in it): -32602 with the request's id, not the
    // legacy "unsupported version" answer with id null.
    for (const params of [undefined, {}, { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } }]) {
      const bare = await rpc(fixture, { jsonrpc: "2.0", id: 101, method: "server/discover", ...(params ? { params } : {}) }, modernHeaders("server/discover"));
      expect(bare.statusCode).toBe(400);
      expect(bare.json()).toMatchObject({ jsonrpc: "2.0", id: 101, error: { code: -32602 } });
      expect(bare.json().error.data.missing).toContain("io.modelcontextprotocol/protocolVersion");
    }

    // Capabilities missing: -32602 naming the key.
    const noCapabilities = await send({ _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } }, modernHeaders("tools/list"));
    expect(noCapabilities.statusCode).toBe(400);
    expect(noCapabilities.json().error).toMatchObject({ code: -32602, data: { missing: ["io.modelcontextprotocol/clientCapabilities"] } });

    // Methods the gateway does not serve to modern callers (ping is gone in 2026-07-28): 404 with -32601.
    for (const method of ["ping", "resources/list", "prompts/list"]) {
      const response = await send({ _meta: modernMeta() }, modernHeaders(method), method);
      expect(response.statusCode, method).toBe(404);
      expect(response.json().error.code).toBe(-32601);
    }

    // initialize sent as a modern request (modern header and _meta): a method 2026-07-28 removed, so 404 with -32601
    // and the request's id, and no session.
    const modernInit = await send({ protocolVersion: MODERN, capabilities: {}, clientInfo: { name: "x", version: "1" }, _meta: modernMeta() }, modernHeaders("initialize"), "initialize");
    expect(modernInit.statusCode).toBe(404);
    expect(modernInit.json()).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32601 } });
    expect(modernInit.headers["mcp-session-id"]).toBeUndefined();
    // ...also with legacy-shaped params and no _meta: the removed method comes first, not the missing keys.
    const bareInit = await send({ protocolVersion: MODERN, capabilities: {}, clientInfo: { name: "x", version: "1" } }, modernHeaders("initialize"), "initialize");
    expect(bareInit.statusCode).toBe(404);
    expect(bareInit.json()).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32601 } });

    // Only the one valid call created the caller's state; refused requests never do.
    expect(await auditEvents(fixture.context.store, "mcp_gateway.caller_seen")).toHaveLength(1);
  });

  it("keeps initialize, batches and requests without the version key on the session path", async () => {
    const fixture = await setup({ env: on });
    // initialize with modern _meta: still a legacy handshake.
    const init = await rpc(fixture, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" }, _meta: modernMeta() }
    });
    expect(init.statusCode).toBe(200);
    expect(init.headers["mcp-session-id"]).toBeTruthy();
    // A batch of modern messages is not served statelessly.
    const batch = await rpc(fixture, [{ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: modernMeta() } }], modernHeaders("tools/list"));
    expect(batch.statusCode).toBe(400);
    expect(batch.json().error.code).toBe(-32000);
    // Trace context alone does not make a request modern.
    const traced = await rpc(fixture, { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01" } } });
    expect(traced.statusCode).toBe(400);
    expect(traced.json().error.message).toContain("Mcp-Session-Id header is required");
    // Trace context next to the modern keys is left alone.
    const tracedModern = await modern(fixture, "tools/list", {}, { meta: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01", tracestate: "l2m=1" } });
    expect(tracedModern.statusCode).toBe(200);
    // A modern notification is accepted and ignored.
    const notification = await rpc(fixture, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, _meta: modernMeta() } }, modernHeaders("notifications/cancelled"));
    expect(notification.statusCode).toBe(202);
  });

  it("serves a legacy session and modern calls interleaved on one endpoint; only sessions show as sessions", async () => {
    const fixture = await setup({ env: on });
    const sessionId = await openSession(fixture);
    const legacyCall = (id: number) =>
      rpc(fixture, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "mock_tools__calculator", arguments: { expression: "2*3" } } }, { "mcp-session-id": sessionId });
    const [a, b, c, d] = await Promise.all([
      legacyCall(1),
      modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "3*3" } }),
      legacyCall(1),
      modern(fixture, "tools/list")
    ]);
    expect(a.json().result).toMatchObject({ structuredContent: { result: 6 } });
    expect(a.json().result.resultType).toBeUndefined();
    expect(a.headers["mcp-session-id"]).toBe(sessionId);
    expect(c.json().result.structuredContent.result).toBe(6);
    expect(b.json().result).toMatchObject({ resultType: "complete", structuredContent: { result: 9 } });
    expect(d.statusCode).toBe(200);

    const sessions = await api<{ sessions: McpGatewaySessionView[] }>(fixture.context, fixture.cookie, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    expect(sessions.body.sessions.map((entry) => entry.idPrefix)).toEqual([sessionId.slice(0, 8)]);
    // A modern caller's state is never reachable as a session.
    const seen = await auditEvents(fixture.context.store, "mcp_gateway.caller_seen");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.metadata).toMatchObject({
      principalScope: expect.stringContaining(`client:${fixture.client.id}/toolset:${fixture.toolset.id}`),
      clientId: fixture.client.id,
      protocolVersion: MODERN,
      clientInfo: { name: "modern-test", version: "2.0" }
    });
    const started = await auditEvents(fixture.context.store, "mcp_gateway.session_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toMatchObject({ sessionId });
  });

  it("audits modern calls with the principal scope and version instead of a session id", async () => {
    const fixture = await setup({ env: on });
    await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "a" } });
    await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "b" } });
    const calls = await auditEvents(fixture.context.store, "mcp_gateway.tool_called");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.metadata).toMatchObject({ principalScope: expect.stringContaining(`client:${fixture.client.id}`), protocolVersion: MODERN });
      expect((call.metadata as Record<string, unknown>).sessionId).toBeUndefined();
    }
    // One caller_seen per idle window, not one per call.
    expect(await auditEvents(fixture.context.store, "mcp_gateway.caller_seen")).toHaveLength(1);
  });

  it("uses codes outside the reserved range for the gateway's own errors on modern calls (legacy keeps the old ones)", async () => {
    const fixture = await setup({ env: on });
    const rule = await api<{ rule: { id: string } }>(fixture.context, fixture.cookie, "POST", "/api/mcp/policies", {
      name: "Sums need a person",
      effect: "require_approval",
      serverId: fixture.mockServerId,
      toolPattern: "calculator"
    });
    expect(rule.status).toBe(201);
    const held = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "1+1" } });
    expect(held.statusCode).toBe(200);
    expect(held.json().error).toMatchObject({ code: -31030, data: { status: "pending", ruleId: rule.body.rule.id } });
    expect(held.json().error.message).toMatch(/^Approval pending: /);

    const sessionId = await openSession(fixture);
    const legacy = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mock_tools__calculator", arguments: { expression: "1+1" } } },
      { "mcp-session-id": sessionId }
    );
    expect(legacy.json().error).toMatchObject({ code: -32030, data: { approvalRequestId: held.json().error.data.approvalRequestId } });

    // A rate limit: -31029 for modern callers.
    const limited = await api(fixture.context, fixture.cookie, "PATCH", `/api/mcp/clients/${fixture.client.id}`, { rateLimit: { requestsPerMinute: 1, burst: 1, maxConcurrent: null } });
    expect(limited.status).toBe(200);
    await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "1" } });
    const refused = await modern(fixture, "tools/call", { name: "echo_workflow", arguments: { text: "2" } });
    expect(refused.json().error).toMatchObject({ code: -31029, data: { reason: "rate_limited" } });
  });

  it("tracks outside content per principal: a second stateless call is checked with what the first returned", async () => {
    const fixture = await setup({ env: on, track: true, presets: ["untrusted_write_approval"] });
    // The first write is the client's own request only.
    const first = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "1+1" } });
    expect(first.json().result.isError).toBeUndefined();
    // Its result was outside content, so the next write from the same caller (no session, new id) is held.
    const second = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "6*7" } });
    expect(second.json().error).toMatchObject({ code: -31030 });
    const raised = await auditEvents(fixture.context.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ principalScope: expect.stringContaining(fixture.client.id), reason: "tool_result" });
    // Labels a caller declares itself in _meta are never read.
    const declared = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "6*8" } }, { meta: { dataLabels: { provenance: [] } } });
    expect(declared.json().error.code).toBe(-31030);
    // A legacy session of the same client starts from the stored mark: opening one does not clear it.
    const sessionId = await openSession(fixture);
    const legacy = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mock_tools__calculator", arguments: { expression: "2+2" } } },
      { "mcp-session-id": sessionId }
    );
    expect(legacy.json().error).toMatchObject({ code: -32030 });
  });

  it("pools upstream stdio servers per principal and stops them when the client is revoked", async () => {
    const fixture = await setup({ env: on });
    const pid = Number(textOf((await modern(fixture, "tools/call", { name: "header_server__pid", arguments: {} })).json().result));
    expect(pid).toBeGreaterThan(0);
    // Same caller, next request: the same process.
    expect(Number(textOf((await modern(fixture, "tools/call", { name: "header_server__pid", arguments: {} })).json().result))).toBe(pid);
    expect(processAlive(pid)).toBe(true);
    expect((await api(fixture.context, fixture.cookie, "POST", `/api/mcp/clients/${fixture.client.id}/revoke`)).status).toBe(200);
    await waitFor(() => !processAlive(pid));
  });

  it("cancels a workflow tool when the caller closes the connection", async () => {
    const fixture = await setup({ env: on });
    const controller = new AbortController();
    const pending = fetch(`${fixture.context.baseUrl}/mcp/${fixture.toolset.slug}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${fixture.token}`, ...modernHeaders("tools/call", "slow_workflow") },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow_workflow", arguments: { text: "x" }, _meta: modernMeta() } })
    }).catch((error: unknown) => error);
    let executionId: string | undefined;
    await waitFor(async () => {
      const page = await fixture.context.store.listExecutionHistory({ triggerType: "mcp_gateway", pageSize: 10 });
      executionId = page.items.find((item) => item.workflowId === "wf-slow")?.id;
      return executionId !== undefined;
    });
    controller.abort();
    await pending;
    await waitFor(async () => (await fixture.context.store.getExecutionHistory(executionId!))?.status === "canceled", 10_000);
  });

  it("stops the caller's upstream servers when it disconnects during a server tool call", async () => {
    const fixture = await setup({ env: on });
    const pid = Number(textOf((await modern(fixture, "tools/call", { name: "header_server__pid", arguments: {} })).json().result));
    const controller = new AbortController();
    const pending = fetch(`${fixture.context.baseUrl}/mcp/${fixture.toolset.slug}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}`, ...modernHeaders("tools/call", "header_server__hang") },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "header_server__hang", arguments: {}, _meta: modernMeta() } })
    }).catch((error: unknown) => error);
    // The call reached the server (its telemetry row appears only at the end, so wait for the request to settle in).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(processAlive(pid)).toBe(true);
    controller.abort();
    await pending;
    await waitFor(() => !processAlive(pid));
    // A finished response is not a cancellation: the next call works and starts the server again.
    const after = await modern(fixture, "tools/call", { name: "header_server__pid", arguments: {} });
    expect(Number(textOf(after.json().result))).not.toBe(pid);
  });

  it("lets a caller's other calls finish when one of its calls is cancelled, then stops the servers", async () => {
    const fixture = await setup({ env: on });
    const pid = Number(textOf((await modern(fixture, "tools/call", { name: "header_server__pid", arguments: {} })).json().result));
    const controller = new AbortController();
    const hanging = fetch(`${fixture.context.baseUrl}/mcp/${fixture.toolset.slug}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}`, ...modernHeaders("tools/call", "header_server__hang") },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "header_server__hang", arguments: {}, _meta: modernMeta() } })
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Another conversation of the same caller, with the same JSON-RPC id.
    const slow = modern(fixture, "tools/call", { name: "header_server__slow_pid", arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await hanging;
    const answered = await slow;
    expect(answered.json().result.isError).toBeUndefined();
    expect(Number(textOf(answered.json().result))).toBe(pid);
    // Once nothing is in flight, the servers the cancelled call used are stopped.
    await waitFor(() => !processAlive(pid));
  });

  it("ends an SSE call with a cancellation error when the caller's state ends, and stops its workflow run", async () => {
    const fixture = await setup({ env: on });
    const response = await fetch(`${fixture.context.baseUrl}/mcp/${fixture.toolset.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${fixture.token}`, ...modernHeaders("tools/call", "slow_workflow") },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slow_workflow", arguments: { text: "x" }, _meta: modernMeta({ progressToken: "p" }) } })
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    let executionId: string | undefined;
    await waitFor(async () => {
      executionId = (await fixture.context.store.listExecutionHistory({ triggerType: "mcp_gateway", pageSize: 10 })).items.find((item) => item.workflowId === "wf-slow")?.id;
      return executionId !== undefined;
    });
    expect((await api(fixture.context, fixture.cookie, "POST", `/api/mcp/clients/${fixture.client.id}/revoke`)).status).toBe(200);
    const body = await response.text();
    const final = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { id?: number; error?: { code: number } })
      .find((message) => message.id === 4);
    expect(final?.error?.code).toBe(-32800);
    await waitFor(async () => (await fixture.context.store.getExecutionHistory(executionId!))?.status === "canceled", 10_000);
  });

  it("answers 503 with a modern retry-later error when the session cap is full of busy callers", async () => {
    const fixture = await setup({ env: { ...on, MCP_GATEWAY_MAX_SESSIONS: "1" } });
    const sessionId = await openSession(fixture);
    // Keep the session busy so it cannot be evicted.
    const hanging = rpc(fixture, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "header_server__hang", arguments: {} } }, { "mcp-session-id": sessionId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await modern(fixture, "tools/list");
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("30");
    expect(refused.json().error).toMatchObject({ code: -31029, data: { reason: "gateway_capacity" } });
    await rpc(fixture, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } }, { "mcp-session-id": sessionId });
    await hanging;
  });

  it("allows the modern request headers and well-formed Mcp-Param-* headers in CORS preflights", async () => {
    const fixture = await setup({ env: on });
    const preflight = await fixture.context.app.inject({
      method: "OPTIONS",
      url: `/mcp/${fixture.toolset.slug}`,
      headers: {
        origin: "https://ide.example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, mcp-method, mcp-name, mcp-param-region, x-evil, mcp-param-bad name"
      }
    });
    const allowed = String(preflight.headers["access-control-allow-headers"]).toLowerCase().split(",").map((entry) => entry.trim());
    expect(allowed).toEqual(expect.arrayContaining(["authorization", "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name", "mcp-param-region"]));
    expect(allowed).not.toContain("x-evil");
    expect(allowed.some((entry) => entry.includes("bad"))).toBe(false);
  });
});

describe("MCP gateway subscriptions/listen", () => {
  const on = { MCP_GATEWAY_MODERN_PROTOCOL: "on", SSE_HEARTBEAT_INTERVAL_MS: "50" };

  /** Opens a listen stream over a real socket; `read` returns text received so far. */
  async function listen(fixture: Fixture, options: { id?: number | string; params?: Record<string, unknown>; accept?: string; headers?: Record<string, string> } = {}) {
    const controller = new AbortController();
    const id = options.id ?? 7;
    const response = await fetch(`${fixture.context.baseUrl}/mcp/${fixture.toolset.slug}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: options.accept ?? "text/event-stream",
        authorization: `Bearer ${fixture.token}`,
        ...modernHeaders("subscriptions/listen"),
        ...(options.headers ?? {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true, resourceSubscriptions: ["file:///a"] }, ...(options.params ?? {}), _meta: modernMeta() } })
    });
    let text = "";
    const reader = response.body?.getReader();
    const pump = (async () => {
      if (!reader) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // Aborted by the test.
      }
    })();
    const messages = () =>
      text
        .split("\n\n")
        .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, any>));
    return { response, controller, pump, read: () => text, messages };
  }

  it("acknowledges the honoured subset (toolsListChanged only), keeps the stream alive and ends when the client closes it", async () => {
    const fixture = await setup({ env: on });
    const stream = await listen(fixture, { id: 7 });
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
    await waitFor(() => stream.messages().length === 1 && stream.read().includes(": ping"));
    expect(stream.messages()[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": 7 }, notifications: { toolsListChanged: true } }
    });
    // No state is created for a stream and no session header is returned.
    expect(stream.response.headers.get("mcp-session-id")).toBeNull();
    expect(await auditEvents(fixture.context.store, "mcp_gateway.caller_seen")).toHaveLength(0);
    stream.controller.abort();
    await stream.pump;
  });

  it("ends with a complete result after MCP_GATEWAY_LISTEN_MAX_MS", async () => {
    const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_MAX_MS: "1000" } });
    const stream = await listen(fixture, { id: "sub-1" });
    await stream.pump;
    const messages = stream.messages();
    expect(messages).toHaveLength(2);
    expect(messages[0]!.params._meta["io.modelcontextprotocol/subscriptionId"]).toBe("sub-1");
    expect(messages[1]).toMatchObject({
      jsonrpc: "2.0",
      id: "sub-1",
      result: { resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": "sub-1", "io.modelcontextprotocol/serverInfo": { name: expect.stringMatching(/^l2m-/) } } }
    });
  });

  it("ends open streams with a complete result when the server shuts down", async () => {
    const fixture = await setup({ env: on });
    const stream = await listen(fixture);
    await waitFor(() => stream.messages().length === 1);
    await fixture.context.app.close();
    await stream.pump;
    expect(stream.messages()[1]).toMatchObject({ id: 7, result: { resultType: "complete" } });
  });

  it("refuses without Accept: text/event-stream and on a malformed filter", async () => {
    const fixture = await setup({ env: on });
    const noSse = await rpc(
      fixture,
      { jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { _meta: modernMeta() } },
      { ...modernHeaders("subscriptions/listen"), accept: "application/json" }
    );
    expect(noSse.statusCode).toBe(406);
    expect(noSse.json().error.code).toBe(-32600);
    const bad = await modern(fixture, "subscriptions/listen", { notifications: { toolsListChanged: "yes" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({ code: -32602 });
    const badUris = await modern(fixture, "subscriptions/listen", { notifications: { resourceSubscriptions: [1] } });
    expect(badUris.statusCode).toBe(400);
    const notObject = await modern(fixture, "subscriptions/listen", { notifications: [] });
    expect(notObject.statusCode).toBe(400);
    // A mismatched Mcp-Method header is still -32020.
    const mismatch = await modern(fixture, "subscriptions/listen", {}, { headers: { "mcp-method": "tools/list" } });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error.code).toBe(-32020);
  });

  it("caps the streams one client holds open and frees a slot when one closes", async () => {
    const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_MAX_PER_CLIENT: "2" } });
    const first = await listen(fixture, { id: 1 });
    const second = await listen(fixture, { id: 2 });
    await waitFor(() => first.messages().length === 1 && second.messages().length === 1);
    const third = await modern(fixture, "subscriptions/listen", {}, { headers: { accept: "text/event-stream" } });
    expect(third.statusCode).toBe(429);
    expect(third.json().error).toMatchObject({ code: -31029, data: { reason: "listen_streams_limit" } });
    first.controller.abort();
    await first.pump;
    // The server sees the close a moment after the client aborts.
    let retried!: Awaited<ReturnType<typeof listen>>;
    await waitFor(async () => {
      retried = await listen(fixture, { id: 3 });
      if (retried.response.status === 200) return true;
      await retried.pump;
      return false;
    });
    await waitFor(() => retried.messages().length === 1);
    for (const stream of [second, retried]) {
      stream.controller.abort();
      await stream.pump;
    }
  });

  it("does not take the client's concurrency slot or a rate token", async () => {
    const fixture = await setup({ env: on });
    expect(
      (await api(fixture.context, fixture.cookie, "PATCH", `/api/mcp/clients/${fixture.client.id}`, { rateLimit: { requestsPerMinute: 1, burst: 1, maxConcurrent: 1 } })).status
    ).toBe(200);
    const first = await listen(fixture, { id: 1 });
    const second = await listen(fixture, { id: 2 });
    await waitFor(() => first.messages().length === 1 && second.messages().length === 1);
    // Two streams are open, yet the client's one concurrent call and its one call per minute are still available.
    const call = await modern(fixture, "tools/call", { name: "mock_tools__calculator", arguments: { expression: "1+1" } });
    expect(call.json().error).toBeUndefined();
    expect(call.json().result.structuredContent).toMatchObject({ result: 2 });
    for (const stream of [first, second]) {
      stream.controller.abort();
      await stream.pump;
    }
  });

  it("frees the stream count when the client closes a stream (cap of one)", async () => {
    const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_MAX_PER_CLIENT: "1" } });
    const stream = await listen(fixture, { id: 1 });
    await waitFor(() => stream.messages().length === 1);
    stream.controller.abort();
    await stream.pump;
    let again!: Awaited<ReturnType<typeof listen>>;
    await waitFor(async () => {
      again = await listen(fixture, { id: 2 });
      if (again.response.status === 200) return true;
      await again.pump;
      return false;
    });
    again.controller.abort();
    await again.pump;
  });

  it("is not served with modern mode off, and legacy sessions do not get it", async () => {
    const off = await setup({ env: { MCP_GATEWAY_MODERN_PROTOCOL: "off" } });
    const refused = await modern(off, "subscriptions/listen", {}, { headers: { accept: "text/event-stream" } });
    expect(refused.statusCode).toBe(400);
    // The answer a modern request gets with modern mode off, unchanged by this feature.
    expect(refused.json().error.message).toContain("Unsupported MCP-Protocol-Version");
    const onFixture = await setup({ env: on });
    const sessionId = await openSession(onFixture);
    const legacy = await rpc(onFixture, { jsonrpc: "2.0", id: 2, method: "subscriptions/listen", params: {} }, { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" });
    expect(legacy.json().error.code).toBe(-32601);
  });

  describe("tools list changes (G3b)", () => {
    const LIST_CHANGED = "notifications/tools/list_changed";
    const changesOn = (stream: Awaited<ReturnType<typeof listen>>) => stream.messages().filter((message) => message.method === LIST_CHANGED);
    const modernToolNames = async (fixture: Fixture) =>
      ((await modern(fixture, "tools/list")).json().result.tools as Array<{ name: string }>).map((tool) => tool.name);
    /** Long enough for a hint's debounced check (250 ms) to have run. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 700));
    async function close(...streams: Array<Awaited<ReturnType<typeof listen>>>) {
      for (const stream of streams) {
        stream.controller.abort();
        await stream.pump;
      }
    }

    it("tells a stream when a toolset edit changes its tool list, and not for an edit that leaves the list alone", async () => {
      // No periodic check: only the change hints can cause a notification here.
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "0" } });
      const watching = await listen(fixture, { id: "s1" });
      const silent = await listen(fixture, { id: "s2", params: { notifications: { promptsListChanged: true } } });
      await waitFor(() => watching.messages().length === 1 && silent.messages().length === 1);
      expect(silent.messages()[0]!.params.notifications).toEqual({});
      expect(await modernToolNames(fixture)).toContain("slow_workflow");

      // A description edit changes no tool.
      expect((await api(fixture.context, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { description: "New words" })).status).toBe(200);
      await settle();
      expect(changesOn(watching)).toHaveLength(0);

      const slowMember = fixture.toolset.members.find((member) => member.kind === "workflow" && member.workflowId === "wf-slow")!;
      expect((await api(fixture.context, fixture.cookie, "DELETE", `/api/mcp/toolsets/${fixture.toolset.id}/members/${slowMember.id}`)).status).toBe(200);
      await waitFor(() => changesOn(watching).length === 1);
      expect(changesOn(watching)[0]).toEqual({ jsonrpc: "2.0", method: LIST_CHANGED, params: { _meta: { "io.modelcontextprotocol/subscriptionId": "s1" } } });
      expect(await modernToolNames(fixture)).not.toContain("slow_workflow");
      await settle();
      expect(changesOn(watching)).toHaveLength(1);
      // A stream that did not ask for toolsListChanged is never told.
      expect(changesOn(silent)).toHaveLength(0);
      await close(watching, silent);
    });

    it("tells a stream when a tool rule hides a tool for the client's role, not when it applies to another role", async () => {
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "0" } });
      const stream = await listen(fixture, { id: 3 });
      await waitFor(() => stream.messages().length === 1);
      const deny = (roles: string[]) =>
        api(fixture.context, fixture.cookie, "POST", "/api/mcp/policies", { name: `No calculator for ${roles.join(",")}`, effect: "deny", roles, serverId: fixture.mockServerId, toolPattern: "calculator" });
      expect((await deny(["viewer"])).status).toBe(201);
      await settle();
      expect(changesOn(stream)).toHaveLength(0);
      expect((await deny(["builder"])).status).toBe(201);
      await waitFor(() => changesOn(stream).length === 1);
      expect(await modernToolNames(fixture)).not.toContain("mock_tools__calculator");
      await close(stream);
    });

    it("tells a stream when a workflow tool is saved through the API", async () => {
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "0" } });
      const stream = await listen(fixture, { id: 4 });
      await waitFor(() => stream.messages().length === 1);
      const workflow = (await fixture.context.store.getWorkflow("wf-echo"))!;
      const trigger = workflow.nodes.find((node) => node.id === "trigger")!;
      const edited = { ...workflow, nodes: workflow.nodes.map((node) => (node === trigger ? { ...node, config: { ...node.config, toolName: "echo_renamed" } } : node)) };
      const saved = await api(fixture.context, fixture.cookie, "PUT", "/api/workflows/wf-echo", edited);
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      await waitFor(() => changesOn(stream).length === 1);
      expect(await modernToolNames(fixture)).toContain("echo_renamed");
      await close(stream);
    });

    it("tells a stream when a background probe stores a new tool snapshot of a member server", async () => {
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "0", MCP_PROBE_INTERVAL_MS: "300" } });
      const toolsFile = path.join(fixture.context.tempDir, "tools.json");
      const script = `
const fs = require('fs');
const file = process.argv[1];
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue;
    const result = req.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'file-tools', version: '1' } }
      : req.method === 'tools/list'
        ? { tools: JSON.parse(fs.readFileSync(file, 'utf-8')).map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
  }
});`;
      fs.writeFileSync(toolsFile, JSON.stringify(["first"]));
      const server = await api<{ server: { id: string } }>(fixture.context, fixture.cookie, "POST", "/api/mcp/servers", {
        name: "File tools",
        adapterId: "stdio_mcp",
        probeEnabled: true,
        connection: { command: process.execPath, args: ["-e", script, toolsFile], timeoutMs: 20000 }
      });
      expect(server.status).toBe(201);
      expect((await api(fixture.context, fixture.cookie, "POST", `/api/mcp/servers/${server.body.server.id}/probe`)).status).toBe(200);
      expect((await api(fixture.context, fixture.cookie, "POST", `/api/mcp/toolsets/${fixture.toolset.id}/members`, { kind: "server", serverId: server.body.server.id })).status).toBe(201);
      await waitFor(async () => (await modernToolNames(fixture)).includes("file_tools__first"));

      const stream = await listen(fixture, { id: 5 });
      await waitFor(() => stream.messages().length === 1);
      // Only the upstream server changes; the background probe sees it and announces the new snapshot.
      fs.writeFileSync(toolsFile, JSON.stringify(["first", "second"]));
      await waitFor(() => changesOn(stream).length >= 1, 15_000);
      expect(await modernToolNames(fixture)).toContain("file_tools__second");
      await close(stream);
    });

    it("falls back to the periodic check for a change nothing announced", async () => {
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "300" } });
      const stream = await listen(fixture, { id: 6 });
      await waitFor(() => stream.messages().length === 1);
      // Written straight to the store: no API hook and no bus message.
      await fixture.context.store.upsertWorkflow(workflowTool("wf-echo", "echo_direct"));
      await waitFor(() => changesOn(stream).length === 1);
      await settle();
      expect(changesOn(stream)).toHaveLength(1);
      await close(stream);
    });

    it("ends a watched stream gracefully when its client is revoked", async () => {
      const fixture = await setup({ env: { ...on, MCP_GATEWAY_LISTEN_CHECK_MS: "0" } });
      const stream = await listen(fixture, { id: "gone" });
      await waitFor(() => stream.messages().length === 1);
      expect((await api(fixture.context, fixture.cookie, "POST", `/api/mcp/clients/${fixture.client.id}/revoke`)).status).toBe(200);
      await stream.pump;
      expect(stream.messages().at(-1)).toMatchObject({ id: "gone", result: { resultType: "complete" } });
      expect(changesOn(stream)).toHaveLength(0);
    });

    it("leaves legacy sessions as they were: initialize still declares no listChanged", async () => {
      const fixture = await setup({ env: on });
      const response = await rpc(fixture, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }
      });
      expect(response.json().result.capabilities).toEqual({ tools: { listChanged: false } });
    });
  });
});
