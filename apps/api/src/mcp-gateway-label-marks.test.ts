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
import { GatewaySessionLimitError, GatewaySessionManager } from "./services/mcp-gateway-sessions.js";

const MODERN = "2026-07-28";
const APPROVAL_PENDING = -31030;
/** The same refusal for a legacy session (the pre-2026-07-28 code range). */
const LEGACY_APPROVAL_PENDING = -32030;

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

async function initialize(fixture: Fixture, instance: Instance) {
  return await instance.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}` },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } })
  });
}

async function legacySession(fixture: Fixture, instance: Instance): Promise<string> {
  const response = await initialize(fixture, instance);
  expect(response.statusCode).toBe(200);
  return String(response.headers["mcp-session-id"]);
}

/** A calculator call in a legacy session. */
async function legacyCall(fixture: Fixture, instance: Instance, sessionId: string, expression: string) {
  const response = await instance.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${fixture.token}`, "mcp-session-id": sessionId },
    payload: JSON.stringify({ jsonrpc: "2.0", id: (nextId += 1), method: "tools/call", params: { name: "mock_tools__calculator", arguments: { expression } } })
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: { result?: number } }; error?: { code: number } }>();
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
    // The principal state really was evicted: the call above started a new one (a second caller_seen).
    expect(await auditEvents(a.store, "mcp_gateway.caller_seen")).toHaveLength(2);

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

  it("fails closed when the stored mark cannot be read: the call is refused before it reaches the tool", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    const read = vi.spyOn(a.store, "readMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    // A clean caller's first call would go through; with the mark unreadable it is refused (no label set could stand
    // in for data classes the caller may hold), and nothing ran.
    const refused = await calc(fixture, a, "1+1");
    expect(refused.result?.isError).toBe(true);
    expect((refused.result?.content ?? []).map((entry) => entry.text).join("")).toMatch(/labels could not be checked/);
    expect(refused.result?.structuredContent).toBeUndefined();
    const workflow = await modernCall(fixture, a, "echo_workflow", { text: "x" });
    expect((workflow.result?.content ?? []).map((entry) => entry.text).join("")).toMatch(/labels could not be checked/);
    expect(read).toHaveBeenCalled();
    read.mockRestore();
    expect((await calc(fixture, a, "1+2")).result?.structuredContent?.result).toBe(3);
  });

  it("starts a new legacy session from the client's stored mark, so opening a session does not clear it", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    // A clean client's legacy session runs the write.
    const clean = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, clean, "1+1")).result?.structuredContent?.result).toBe(2);

    // Its result raised the client's stored mark too (modern mode is on): the client's stateless writes are held...
    expect((await calc(fixture, a, "2+2")).error?.code).toBe(APPROVAL_PENDING);
    expect((await calc(fixture, a, "3+3")).error?.code).toBe(APPROVAL_PENDING);
    // ...and a session opened after that, on any instance, starts from it: its first write is held too.
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    const sessionId = await legacySession(fixture, b);
    expect((await legacyCall(fixture, b, sessionId, "4+4")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    // One raise per mark: the clean session's result raised the client's stored mark (modern mode is on), so the
    // stateless calls and the seeded session record none of their own.
    const raised = await auditEvents(b.store, "mcp_gateway.session_labels_raised");
    expect(raised.map((entry) => (entry.metadata as { sessionId?: string } | undefined)?.sessionId ?? null)).toEqual([clean]);
    // It records once that it took them up when it opened, with the labels and where they came from.
    const inherited = await auditEvents(b.store, "mcp_gateway.session_labels_inherited");
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.metadata).toMatchObject({ sessionId, clientId: fixture.client.id, source: "stored_mark", at: "session_open", labels: { provenance: ["untrusted_external"], dataClasses: [] } });
  });

  it("counts a stored note of untracked results in a new legacy session's first call", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    const sessionId = await legacySession(fixture, b);
    expect((await legacyCall(fixture, b, sessionId, "2+2")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    const raised = await auditEvents(b.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ reason: "results_before_tracking", sessionId });
    // The note was converted in the store when the session opened: the client's next stateless call, and a second
    // session, are held too, and the same results are not audited again.
    expect((await calc(fixture, b, "3+3")).error?.code).toBe(APPROVAL_PENDING);
    const second = await legacySession(fixture, b);
    expect((await legacyCall(fixture, b, second, "4+4")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    expect(await auditEvents(b.store, "mcp_gateway.session_labels_raised")).toHaveLength(1);
    // The session whose read converted the note is named by the raise event; only the second session inherited.
    const inherited = await auditEvents(b.store, "mcp_gateway.session_labels_inherited");
    expect(inherited.map((entry) => (entry.metadata as { sessionId?: string }).sessionId)).toEqual([second]);
    const [stored] = await b.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ unobserved: false, provenance: ["untrusted_external"] });
  });

  it("does not open a legacy session on a tracking toolset when the stored mark cannot be read", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    // The client's mark holds a note of untracked results: it is read and converted in one step, which fails here.
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: false })).status).toBe(200);
    await calc(fixture, a, "1+1");
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    const read = vi.spyOn(a.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    const refused = await initialize(fixture, a);
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["mcp-session-id"]).toBeUndefined();
    expect(refused.json().error.message).toMatch(/labels could not be checked/);
    expect(await auditEvents(a.store, "mcp_gateway.session_started")).toHaveLength(0);
    read.mockRestore();
    expect((await initialize(fixture, a)).statusCode).toBe(200);
    // Nothing was converted while the read failed; the session that opened converted the note once.
    expect(await auditEvents(a.store, "mcp_gateway.session_labels_raised")).toHaveLength(1);

    // A toolset that does not track reads nothing: sessions open as before.
    const untracked = await setup({ track: false });
    const spy = vi.spyOn(untracked.instance.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    expect((await initialize(untracked, untracked.instance)).statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    // Neither does a tracking toolset while modern mode is off (no marks are stored then).
    const off = await setup({ track: true, env: { MCP_GATEWAY_MODERN_PROTOCOL: "off" } });
    const offSpy = vi.spyOn(off.instance.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    expect((await initialize(off, off.instance)).statusCode).toBe(200);
    expect(offSpy).not.toHaveBeenCalled();
  });

  it("reads the client's stored mark again on every call of an open legacy session, and fails closed", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    // A session opened while the client is clean, and not used yet: its own labels stay empty.
    const sessionId = await legacySession(fixture, a);
    // The client's stateless calls raise the stored mark after the session opened (the stateless write after them is held).
    expect((await calc(fixture, a, "2+2")).result?.structuredContent?.result).toBe(4);
    expect((await calc(fixture, a, "3+3")).error?.code).toBe(APPROVAL_PENDING);
    // The open session's next call reads the mark again: its write is held too.
    expect((await legacyCall(fixture, a, sessionId, "4+4")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    // The stored raise is audited once, by the stateless call that raised it; the session does not audit it again.
    const raised = await auditEvents(a.store, "mcp_gateway.session_labels_raised");
    expect(raised.map((entry) => (entry.metadata as { sessionId?: string } | undefined)?.sessionId ?? null)).toEqual([null]);

    // A second session, used once while the mark cannot be read: the call is refused before it reaches the tool.
    const other = await setup({ track: true });
    const session = await legacySession(other, other.instance);
    const read = vi.spyOn(other.instance.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    const refused = await legacyCall(other, other.instance, session, "1+1");
    expect(refused.result?.isError).toBe(true);
    expect((refused.result?.content ?? []).map((entry) => entry.text).join("")).toMatch(/labels could not be checked/);
    expect(refused.result?.structuredContent).toBeUndefined();
    expect(read).toHaveBeenCalled();
    read.mockRestore();
    expect((await legacyCall(other, other.instance, session, "1+2")).result?.structuredContent?.result).toBe(3);

    // With modern mode off nothing is read: a legacy session's calls run as before.
    const off = await setup({ track: true, env: { MCP_GATEWAY_MODERN_PROTOCOL: "off" } });
    const offSession = await legacySession(off, off.instance);
    const offRead = vi.spyOn(off.instance.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    expect((await legacyCall(off, off.instance, offSession, "2+3")).result?.structuredContent?.result).toBe(5);
    expect(offRead).not.toHaveBeenCalled();
    // Nor on a toolset that does not track.
    const untracked = await setup({ track: false });
    const untrackedSession = await legacySession(untracked, untracked.instance);
    const untrackedRead = vi.spyOn(untracked.instance.store, "peekMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    expect((await legacyCall(untracked, untracked.instance, untrackedSession, "3+3")).result?.structuredContent?.result).toBe(6);
    expect(untrackedRead).not.toHaveBeenCalled();
  });

  it("does not renew the client's stored mark, or show its stateless caller as recently seen, when a legacy session reads it", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    await calc(fixture, a, "1+1");
    expect((await calc(fixture, a, "2+2")).error?.code).toBe(APPROVAL_PENDING);
    // Pin the stored mark: its stateless caller was last seen ten minutes ago, and it ends in a minute.
    const lastSeen = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET last_seen_at = ?, expires_at = ? WHERE client_id = ?`, lastSeen, expiresAt, fixture.client.id);
    const stored = async () => (await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString()))[0];

    // A session opens and calls three times: it takes the labels up every time (its writes are held)...
    const sessionId = await legacySession(fixture, a);
    for (const expression of ["3+3", "4+4", "5+5"]) {
      expect((await legacyCall(fixture, a, sessionId, expression)).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    }
    // ...but none of that is the stateless caller's activity: the mark's last call and expiry did not move.
    const after = await stored();
    expect(Date.parse(after!.lastSeenAt)).toBe(Date.parse(lastSeen));
    expect(Date.parse(after!.expiresAt)).toBe(Date.parse(expiresAt));

    // A real stateless call does renew it.
    expect((await calc(fixture, a, "6+6")).error?.code).toBe(APPROVAL_PENDING);
    const renewed = await stored();
    expect(Date.parse(renewed!.lastSeenAt)).toBeGreaterThan(Date.parse(lastSeen));
    expect(Date.parse(renewed!.expiresAt)).toBeGreaterThan(Date.parse(expiresAt));

    // Once the stored mark ends, the session keeps what it took up: its labels are its own and never go down.
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET expires_at = ? WHERE client_id = ?`, new Date(Date.now() - 1_000).toISOString(), fixture.client.id);
    expect((await legacyCall(fixture, a, sessionId, "7+7")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    expect(await stored()).toBeUndefined();
  });

  it("converts a stored note of untracked results for a legacy session without renewing the client's mark", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    const lastSeen = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET last_seen_at = ?, expires_at = ? WHERE client_id = ?`, lastSeen, expiresAt, fixture.client.id);
    const sessionId = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, sessionId, "2+2")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    const [stored] = await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ unobserved: false, provenance: ["untrusted_external"], raiseAudited: true });
    expect(Date.parse(stored!.lastSeenAt)).toBe(Date.parse(lastSeen));
    expect(Date.parse(stored!.expiresAt)).toBe(Date.parse(expiresAt));
  });

  it("records once per legacy session that it took up labels its client raised elsewhere", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    // Both sessions open clean; `own` then raises its labels, which also raises the client's stored mark.
    const own = await legacySession(fixture, a);
    const later = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, own, "1+1")).result?.structuredContent?.result).toBe(2);
    // The client's stateless calls start from it.
    expect((await calc(fixture, a, "3+3")).error?.code).toBe(APPROVAL_PENDING);

    // `later` takes the labels up on its next call, and records it once however often it reads them again.
    expect((await legacyCall(fixture, a, later, "4+4")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    expect((await legacyCall(fixture, a, later, "5+5")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    // `own` already held them: it takes up nothing new and records nothing.
    expect((await legacyCall(fixture, a, own, "6+6")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    // A session opened now takes them up when it opens.
    const opened = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, opened, "7+7")).error?.code).toBe(LEGACY_APPROVAL_PENDING);

    const inherited = await auditEvents(a.store, "mcp_gateway.session_labels_inherited");
    const bySession = new Map(inherited.map((entry) => [(entry.metadata as { sessionId?: string }).sessionId, entry]));
    expect([...bySession.keys()].sort()).toEqual([later, opened].sort());
    expect(inherited).toHaveLength(2);
    const labels = { provenance: ["untrusted_external"], dataClasses: [] };
    expect(bySession.get(later)).toMatchObject({ action: "update", resourceId: fixture.toolset.id });
    expect(bySession.get(later)!.metadata).toMatchObject({ clientId: fixture.client.id, source: "stored_mark", at: "tool_call", labels, added: labels });
    expect(bySession.get(opened)!.metadata).toMatchObject({ source: "stored_mark", at: "session_open", labels, added: labels });
    expect(typeof (bySession.get(later)!.metadata as { storedRaisedAt?: unknown }).storedRaisedAt).toBe("string");

    // Audited once per mark: the stored mark's first raise, by `own`'s result.
    const raised = await auditEvents(a.store, "mcp_gateway.session_labels_raised");
    expect(raised.map((entry) => (entry.metadata as { sessionId?: string } | undefined)?.sessionId ?? null)).toEqual([own]);
  });

  it("still records labels a session inherits later when its own read converted the stored note", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    // The session's open converts the note: the raise event names it, and it inherits nothing.
    const sessionId = await legacySession(fixture, a);
    expect(await auditEvents(a.store, "mcp_gateway.session_labels_inherited")).toHaveLength(0);
    // The client's stateless call on another instance stores a data class later; the session takes it up and records it.
    const now = new Date();
    await a.store.raiseMcpGatewayLabelMark({
      clientId: fixture.client.id,
      toolsetId: fixture.toolset.id,
      scopeKey: fixture.client.createdBy ?? "",
      provenance: [],
      dataClasses: ["pii.email"],
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + a.config.MCP_GATEWAY_SESSION_IDLE_MS).toISOString()
    });
    expect((await legacyCall(fixture, a, sessionId, "2+2")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    const inherited = await auditEvents(a.store, "mcp_gateway.session_labels_inherited");
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.metadata).toMatchObject({ sessionId, at: "tool_call", added: { provenance: [], dataClasses: ["pii.email"] } });
    const raised = await auditEvents(a.store, "mcp_gateway.session_labels_raised");
    expect(raised.map((entry) => (entry.metadata as { sessionId?: string }).sessionId)).toEqual([sessionId]);
  });

  it("audits the stored note's first raise when initialize converted it but the session could not be created", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    const full = vi.spyOn(GatewaySessionManager.prototype, "create").mockRejectedValueOnce(new GatewaySessionLimitError(1));
    expect((await initialize(fixture, a)).statusCode).toBe(503);
    expect(full).toHaveBeenCalled();
    const raised = await auditEvents(a.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ sessionId: null, clientId: fixture.client.id, reason: "results_before_tracking", labels: { provenance: ["untrusted_external"], dataClasses: [] } });
    // Converted once: the next session opens from it without a second raise event.
    await legacySession(fixture, a);
    expect(await auditEvents(a.store, "mcp_gateway.session_labels_raised")).toHaveLength(1);
  });

  it("stores a legacy session's raise in its client's mark, so a later stateless call starts from it after the old mark expired", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    // A stateless call long ago: its mark ended (the client has made no call without a session for a whole idle window).
    expect((await calc(fixture, a, "1+1")).result?.structuredContent?.result).toBe(2);
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET expires_at = ? WHERE client_id = ?`, new Date(Date.now() - 1_000).toISOString(), fixture.client.id);
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    // A session works through the gateway: its result's labels are stored (a real raise, which renews the mark).
    const before = Date.now();
    const sessionId = await legacySession(fixture, b);
    expect((await legacyCall(fixture, b, sessionId, "2+2")).result?.structuredContent?.result).toBe(4);
    const [stored] = await b.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ provenance: ["untrusted_external"], raiseAudited: true });
    expect(Date.parse(stored!.expiresAt)).toBeGreaterThanOrEqual(before + b.config.MCP_GATEWAY_SESSION_IDLE_MS);
    // A stateless call on another instance (here: after a restart, no principal state) starts from those labels.
    await stop(b);
    const c = await start(fixture.dbFile, fixture.env);
    expect((await calc(fixture, c, "3+3")).error?.code).toBe(APPROVAL_PENDING);
    // The new mark's first raise is audited once, naming the session.
    const raised = await auditEvents(c.store, "mcp_gateway.session_labels_raised");
    expect(raised.map((entry) => (entry.metadata as { sessionId?: string } | undefined)?.sessionId ?? null).filter(Boolean)).toEqual([sessionId]);
    expect(raised.find((entry) => (entry.metadata as { sessionId?: string }).sessionId === sessionId)!.metadata).toMatchObject({ reason: "tool_result", tool: "mock_tools__calculator" });
  });

  it("withholds a legacy session's result whose labels cannot be stored in the client's mark", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    const sessionId = await legacySession(fixture, a);
    const raise = vi.spyOn(a.store, "raiseMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    const withheld = await legacyCall(fixture, a, sessionId, "2+2");
    expect(withheld.result?.isError).toBe(true);
    expect((withheld.result?.content ?? []).map((entry) => entry.text).join("")).toMatch(/could not be recorded/);
    expect(withheld.result?.structuredContent).toBeUndefined();
    expect(raise).toHaveBeenCalled();
    raise.mockRestore();
    // The session still holds the labels itself: its next write is held.
    expect((await legacyCall(fixture, a, sessionId, "3+3")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    // With modern mode off nothing is stored: the session's results go back as before.
    const off = await setup({ track: true, env: { MCP_GATEWAY_MODERN_PROTOCOL: "off" } });
    const offSession = await legacySession(off, off.instance);
    const offRaise = vi.spyOn(off.instance.store, "raiseMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    expect((await legacyCall(off, off.instance, offSession, "2+3")).result?.structuredContent?.result).toBe(5);
    expect(offRaise).not.toHaveBeenCalled();
  });

  it("stores a legacy session's results from before tracking was switched on once it tracks, and refuses the call when it cannot", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    const sessionId = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, sessionId, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    const raise = vi.spyOn(a.store, "raiseMcpGatewayLabelMark").mockRejectedValue(new Error("connection reset"));
    const refused = await legacyCall(fixture, a, sessionId, "2+2");
    expect((refused.result?.content ?? []).map((entry) => entry.text).join("")).toMatch(/labels could not be checked/);
    raise.mockRestore();
    // Retried on the next call: stored, and the session's write is held.
    expect((await legacyCall(fixture, a, sessionId, "3+3")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    const [stored] = await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ provenance: ["untrusted_external"], unobserved: false });
    const raised = await auditEvents(a.store, "mcp_gateway.session_labels_raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.metadata).toMatchObject({ sessionId, reason: "results_before_tracking" });
    expect((await calc(fixture, a, "4+4")).error?.code).toBe(APPROVAL_PENDING);
  });

  it("notes a legacy session's untracked results in its client's mark, so turning tracking on counts them after the session is gone", async () => {
    const fixture = await setup({ track: false });
    const a = fixture.instance;
    const sessionId = await legacySession(fixture, a);
    expect((await legacyCall(fixture, a, sessionId, "1+1")).result?.structuredContent?.result).toBe(2);
    expect((await legacyCall(fixture, a, sessionId, "1+2")).result?.structuredContent?.result).toBe(3);
    const [note] = await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(note).toMatchObject({ unobserved: true, provenance: [] });
    expect(Date.parse(note!.expiresAt)).toBeGreaterThan(Date.now() + a.config.MCP_GATEWAY_SESSION_IDLE_MS * 1.4);
    expect((await api(a, fixture.cookie, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).status).toBe(200);
    // The session ends with the instance; the client's next call without a session counts its results anyway.
    await stop(a);
    const b = await start(fixture.dbFile, fixture.env);
    expect((await calc(fixture, b, "2+2")).error?.code).toBe(APPROVAL_PENDING);
  });

  it("records labels another writer merged into the client's mark during a session's own raise as inherited", async () => {
    const fixture = await setup({ track: true });
    const a = fixture.instance;
    const sessionId = await legacySession(fixture, a);
    // Between this call's read and its raise, another session (or a call without one) stores a data class.
    const real = a.store.raiseMcpGatewayLabelMark.bind(a.store);
    vi.spyOn(a.store, "raiseMcpGatewayLabelMark").mockImplementationOnce(async (input) => {
      await real({ ...input, provenance: [], dataClasses: ["pii.email"] });
      return await real(input);
    });
    expect((await legacyCall(fixture, a, sessionId, "1+1")).result?.structuredContent?.result).toBe(2);
    const [stored] = await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ provenance: ["untrusted_external"], dataClasses: ["pii.email"] });
    const inherited = await auditEvents(a.store, "mcp_gateway.session_labels_inherited");
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.metadata).toMatchObject({ sessionId, at: "tool_call", added: { provenance: [], dataClasses: ["pii.email"] } });
    // Its own result's label is not an inheritance; it records nothing more on later calls.
    expect((await legacyCall(fixture, a, sessionId, "2+2")).error?.code).toBe(LEGACY_APPROVAL_PENDING);
    expect(await auditEvents(a.store, "mcp_gateway.session_labels_inherited")).toHaveLength(1);
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
    // The note is written once per half idle window, so it lasts one and a half windows.
    const [note] = await a.store.listMcpGatewayLabelMarks({ clientId: fixture.client.id }, new Date().toISOString());
    expect(note).toMatchObject({ unobserved: true, provenance: [] });
    expect(Date.parse(note!.expiresAt)).toBeGreaterThan(Date.now() + a.config.MCP_GATEWAY_SESSION_IDLE_MS * 1.4);
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
