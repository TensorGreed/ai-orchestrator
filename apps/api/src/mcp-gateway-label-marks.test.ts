/**
 * MCP 2026-07-28 (v71) — the label mark of a stateless gateway caller is stored (`mcp_gateway_label_marks`), keyed by
 * the client credential, the toolset and the user its token acts for. Nothing a caller sends, and nothing that ends
 * the instance's principal state (eviction at the cap, the idle sweep, a restart), resets it; a store error fails
 * closed. Runs on SQLite, and on Postgres with TEST_STORE=postgres (the restart reopens the same database).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { mcpSafetyPresetRuleId, type McpClient, type McpGatewayCallerView, type McpGatewaySessionView, type McpToolset, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

const MODERN = "2026-07-28";
const APPROVAL_PENDING = -31030;

interface Instance {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
}

interface Fixture {
  dbFile: string;
  env: Record<string, string>;
  instance: Instance;
  cookie: string;
  toolset: McpToolset;
  client: McpClient;
  token: string;
}

const tempDirs: string[] = [];
const instances: Instance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) await stop(instance);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function stop(instance: Instance): Promise<void> {
  const index = instances.indexOf(instance);
  if (index >= 0) instances.splice(index, 1);
  await instance.app.close();
  try {
    await instance.store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
}

/** One API instance on `dbFile`; a second call on the same file is a restart (same database, fresh process state). */
async function start(dbFile: string, env: Record<string, string>): Promise<Instance> {
  const store = await openTestStore(dbFile);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(path.dirname(dbFile), "sync"),
    MCP_GATEWAY_MODERN_PROTOCOL: "on",
    ...env
  });
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
  await app.ready();
  const instance = { app, store, config };
  instances.push(instance);
  return instance;
}

async function login(instance: Instance): Promise<string> {
  const email = "admin@example.com";
  const password = "admin-Pass-123!";
  if (!(await instance.store.getUserByEmail(email))) await new AuthService(instance.store, 24).register({ email, password, role: "admin" });
  const response = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return String([response.headers["set-cookie"]].flat().find((value) => String(value).startsWith(`${instance.config.SESSION_COOKIE_NAME}=`))).split(";")[0]!;
}

async function api<T = Record<string, unknown>>(instance: Instance, cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const response = await instance.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: response.statusCode, body: (response.body ? response.json() : {}) as T };
}

function echoWorkflow(): Workflow {
  return {
    id: "wf-echo",
    name: "Echo",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: "wf-echo-path", toolName: "echo_workflow", inputSchema: { type: "object", properties: { text: { type: "string" } } }, authMode: "public" }
      },
      { id: "out", type: "output", name: "Out", position: { x: 300, y: 0 }, config: { outputKey: "result", responseTemplate: "answered:{{text}}" } }
    ],
    edges: [{ id: "e1", source: "trigger", target: "out" }]
  };
}

async function setup(options: { track: boolean; env?: Record<string, string> }): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-gw-label-marks-"));
  tempDirs.push(tempDir);
  const dbFile = path.join(tempDir, "orchestrator.db");
  const env = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"), ...(options.env ?? {}) };
  const instance = await start(dbFile, env);
  const cookie = await login(instance);
  const server = await api<{ server: { id: string } }>(instance, cookie, "POST", "/api/mcp/servers", { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false });
  expect(server.status).toBe(201);
  expect((await api(instance, cookie, "POST", `/api/mcp/servers/${server.body.server.id}/probe`)).status).toBe(200);
  await instance.store.upsertWorkflow(echoWorkflow());
  const toolset = await api<{ toolset: McpToolset }>(instance, cookie, "POST", "/api/mcp/toolsets", {
    name: "Agent tools",
    projectId: "default",
    ...(options.track ? { trackSessionLabels: true } : {}),
    members: [
      { kind: "server", serverId: server.body.server.id },
      { kind: "workflow", workflowId: "wf-echo" }
    ]
  });
  expect(toolset.status, JSON.stringify(toolset.body)).toBe(201);
  const client = await api<{ client: McpClient; token: string }>(instance, cookie, "POST", "/api/mcp/clients", { name: "IDE agent", toolsetIds: [toolset.body.toolset.id], role: "builder" });
  expect(client.status).toBe(201);
  // Writes are held for a person once the caller carries outside content.
  expect((await api(instance, cookie, "POST", "/api/mcp/policies/presets/untrusted_write_approval")).status).toBe(201);
  expect((await api(instance, cookie, "POST", `/api/mcp/policies/${mcpSafetyPresetRuleId("untrusted_write_approval")}/enforce`)).status).toBe(200);
  return { dbFile, env, instance, cookie, toolset: toolset.body.toolset, client: client.body.client, token: client.body.token };
}

let nextId = 1;

/** A stateless tools/call; `meta` and `headers` are what the caller adds itself. */
async function modernCall(
  fixture: Fixture,
  instance: Instance,
  name: string,
  args: Record<string, unknown>,
  extra: { meta?: Record<string, unknown>; headers?: Record<string, string>; clientInfo?: Record<string, unknown> } = {}
) {
  const response = await instance.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${fixture.token}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/call",
      "mcp-name": name,
      ...(extra.headers ?? {})
    },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: (nextId += 1),
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": extra.clientInfo ?? { name: "marks-test", version: "1" },
          ...(extra.meta ?? {})
        }
      }
    })
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { result?: number } }; error?: { code: number } }>();
}

const calc = (fixture: Fixture, instance: Instance, expression: string, extra?: Parameters<typeof modernCall>[4]) =>
  modernCall(fixture, instance, "mock_tools__calculator", { expression }, extra);

async function legacySession(fixture: Fixture, instance: Instance): Promise<string> {
  const response = await instance.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}` },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } })
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers["mcp-session-id"]);
}

async function auditEvents(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 100 })).items;
}

describe("stored label marks of stateless callers", () => {
  it("cannot be reset by the caller: not by its client info, a session id, labels in _meta, sessions that evict its state, or a restart", async () => {
    const fixture = await setup({ track: true, env: { MCP_GATEWAY_MAX_SESSIONS: "1" } });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await calc(fixture, a, "2+2")).error?.code).toBe(APPROVAL_PENDING);

    // What the caller sends itself changes nothing.
    const disguised = await calc(fixture, a, "3+3", {
      clientInfo: { name: "someone-else", version: "9" },
      meta: { dataLabels: { provenance: [] }, "io.l2m/conversation": "fresh" },
      headers: { "mcp-session-id": crypto.randomUUID() }
    });
    expect(disguised.error?.code).toBe(APPROVAL_PENDING);

    // A legacy session takes the only slot, so the cap evicts the caller's idle principal state on this instance.
    const sessionId = await legacySession(fixture, a);
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);
    expect((await calc(fixture, a, "4+4")).error?.code).toBe(APPROVAL_PENDING);

    // A restart (or another instance) starts with no principal state at all.
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    expect((await calc(fixture, b, "5+5")).error?.code).toBe(APPROVAL_PENDING);

    // The raise was audited once, by the call that raised the stored mark.
    const raised = await auditEvents(b.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ reason: "tool_result", clientId: fixture.client.id, labels: { provenance: ["untrusted_external"] } });
  });

  it("ends with the idle expiry after the caller's last call, as a session would", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    await calc(fixture, a, "1+1");
    expect((await calc(fixture, a, "2+2")).error?.code).toBe(APPROVAL_PENDING);
    // The window passed (on every instance: the mark is stored), and this instance's state idled out with it.
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET expires_at = ? WHERE client_id = ?`, new Date(Date.now() - 1_000).toISOString(), fixture.client.id);
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    expect((await calc(fixture, b, "3+3")).result?.structuredContent?.result).toBe(6);
  });

  it("fails closed when the stored mark cannot be read: the call is checked as carrying outside content", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    const read = vi.spyOn(a.store, "readMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    // A clean caller's first write would go through; with the mark unreadable it is held.
    expect((await calc(fixture, a, "1+1")).error?.code).toBe(APPROVAL_PENDING);
    expect(read).toHaveBeenCalled();
    // A legacy session keeps its own mark and is not affected.
    const sessionId = await legacySession(fixture, a);
    const legacy = await a.app.inject({
      method: "POST",
      url: `/mcp/${fixture.toolset.slug}`,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}`, "mcp-session-id": sessionId },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "mock_tools__calculator", arguments: { expression: "2+3" } } })
    });
    expect(legacy.json().result.structuredContent.result).toBe(5);
  });

  it("withholds a result whose labels cannot be stored, and still holds the caller's next write on this instance", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    const raise = vi.spyOn(a.store, "raiseMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    const withheld = await modernCall(fixture, a, "echo_workflow", { text: "secret plan" });
    expect(withheld.result?.isError).toBe(true);
    const text = (withheld.result?.content ?? []).map((entry) => entry.text ?? "").join("\n");
    expect(text).toMatch(/could not be recorded/);
    expect(text).not.toContain("secret plan");
    expect(raise).toHaveBeenCalled();
    raise.mockRestore();
    // Nothing reached the store, but this instance saw the result go out: the next write is held.
    expect(await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString())).toEqual([]);
    expect((await calc(fixture, a, "1+1")).error?.code).toBe(APPROVAL_PENDING);
  });

  it("counts results from before tracking was switched on as outside content, on any instance", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await calc(fixture, a, "2+2")).result?.structuredContent?.result).toBe(4);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    // Another instance (here: after a restart) never saw those results itself.
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    expect((await calc(fixture, b, "3+3")).error?.code).toBe(APPROVAL_PENDING);
    const raised = await auditEvents(b.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ reason: "results_before_tracking" });
  });

  it("is deleted when the client is revoked or the toolset deleted", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    await calc(fixture, a, "1+1");
    const now = () => new Date().toISOString();
    expect(await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, now())).toHaveLength(1);
    expect((await api(a, fixture.cookie, "DELETE", `/api/mcp/toolsets/${fixture.toolset.id}`)).status).toBe(200);
    expect(await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, now())).toEqual([]);

    const other = await setup({ track: true });
    await calc(other, other.instance, "1+1");
    expect(await other.instance.store.listMcpGatewayLabelMarks({ clientId: other.client.id }, now())).toHaveLength(1);
    expect((await api(other.instance, other.cookie, "POST", `/api/mcp/clients/${other.client.id}/revoke`)).status).toBe(200);
    expect(await other.instance.store.listMcpGatewayLabelMarks({ clientId: other.client.id }, now())).toEqual([]);
  });

  it("shows stateless callers next to sessions, from the stored mark when the caller's state is on no instance", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    await calc(fixture, a, "1+1");
    const sessionId = await legacySession(fixture, a);

    type Panel = { sessions: McpGatewaySessionView[]; callers: McpGatewayCallerView[]; callersUnavailable?: boolean };
    const first = await api<Panel>(a, fixture.cookie, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    expect(first.status).toBe(200);
    expect(first.body.sessions).toHaveLength(1);
    expect(first.body.sessions[0]).toMatchObject({ idPrefix: sessionId.slice(0, 8), protocolVersion: "2025-11-25" });
    expect(first.body.callers).toHaveLength(1);
    expect(first.body.callers[0]).toMatchObject({
      clientId: fixture.client.id,
      toolsetId: fixture.toolset.id,
      toolsetName: "Agent tools",
      userId: expect.any(String),
      protocolVersion: MODERN,
      clientInfo: { name: "marks-test", version: "1" },
      tracked: true,
      labels: { provenance: ["untrusted_external"], dataClasses: [] },
      guard: { blocks: 0, lastBlock: null }
    });
    expect(Date.parse(first.body.callers[0]!.expiresAt!)).toBeGreaterThan(Date.now());
    expect(first.body.callers[0]!.raisedAt).not.toBeNull();
    expect(first.body.callersUnavailable).toBeUndefined();

    // After a restart only the stored mark knows the caller.
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    const cookie = await login(b);
    const second = await api<Panel>(b, cookie, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    expect(second.body.sessions).toEqual([]);
    expect(second.body.callers).toHaveLength(1);
    expect(second.body.callers[0]).toMatchObject({ protocolVersion: null, clientInfo: null, guard: null, labels: { provenance: ["untrusted_external"] } });

    // An unreadable store still shows this instance's callers, and says the list is partial.
    vi.spyOn(b.store, "listMcpGatewayLabelMarks").mockRejectedValue(new Error("connection reset"));
    const partial = await api<Panel>(b, cookie, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({ callers: [], callersUnavailable: true });
  });
});
