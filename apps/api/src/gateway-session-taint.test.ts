/**
 * 12.2 — gateway session taint: a toolset may track outside content per client session. With it on, each session
 * keeps a high-water mark of what its calls returned, and later calls are checked with it, so label rules (the
 * safety presets) apply to gateway calls. With it off (the default) a gateway call is checked exactly as before.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SENSITIVE_OUTPUT_CONFIG_KEY,
  mcpSafetyPresetRule,
  mcpSafetyPresetRuleId,
  type McpClient,
  type McpGatewayApproval,
  type McpGatewaySessionView,
  type McpPolicySimulationResult,
  type McpSafetyPresetId,
  type McpToolset,
  type Workflow
} from "@ai-orchestrator/shared";
import { MockMCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { JSON_RPC_ERRORS } from "./services/mcp-gateway-protocol.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

// 12.2 (M2) — a run on a queue worker that sends no output labels: the gateway falls back. Tests switch it on.
const engineLabels = vi.hoisted(() => ({ drop: false }));
vi.mock("@ai-orchestrator/workflow-engine", async (importOriginal) => {
  const engine = await importOriginal<typeof import("@ai-orchestrator/workflow-engine")>();
  return { ...engine, outputLabelsOf: (result: Parameters<typeof engine.outputLabelsOf>[0]) => (engineLabels.drop ? undefined : engine.outputLabelsOf(result)) };
});

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-gw-taint-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
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
  engineLabels.drop = false;
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

async function login(context: TestContext, role: Role): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

function caller(context: TestContext) {
  return (cookie: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    context.app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** A workflow tool whose output is the trigger's (outside content), optionally declared sensitive. */
function workflowTool(id: string, toolName: string, sensitive: boolean): Workflow {
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
      {
        id: "out",
        type: "output",
        name: "Out",
        position: { x: 300, y: 0 },
        config: { outputKey: "result", responseTemplate: "answered:{{text}}", ...(sensitive ? { [SENSITIVE_OUTPUT_CONFIG_KEY]: true } : {}) }
      }
    ],
    edges: [{ id: "e1", source: "trigger", target: "out" }]
  };
}

/** A workflow tool whose run calls the mock server's calculator (an open-world write tool) from an MCP Tool node. */
function calculatorWorkflowTool(id: string, serverId: string): Workflow {
  return {
    id,
    name: "Calculator via workflow",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "trigger", type: "mcp_server_trigger", name: "Trigger", position: { x: 0, y: 0 }, config: { path: `${id}-path`, toolName: "calc_workflow", inputSchema: { type: "object" }, authMode: "public" } },
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

/** A workflow tool that calls the sensitive workflow `childId` as a sub-workflow, then fails on a tool that does not exist. */
function failingParentTool(id: string, childId: string, serverId: string): Workflow {
  return {
    id,
    name: "Failing parent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "trigger", type: "mcp_server_trigger", name: "Trigger", position: { x: 0, y: 0 }, config: { path: `${id}-path`, toolName: "failing_parent", inputSchema: { type: "object" }, authMode: "public" } },
      { id: "child", type: "execute_workflow", name: "Child", position: { x: 200, y: 0 }, config: { workflowId: childId, mode: "sync" } },
      { id: "boom", type: "mcp_tool", name: "Boom", position: { x: 400, y: 0 }, config: { registryServerId: serverId, toolName: "no_such_tool", argsTemplate: "{}", retry: { enabled: false } } },
      { id: "out", type: "output", name: "Out", position: { x: 600, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "child" },
      { id: "e2", source: "child", target: "boom" },
      { id: "e3", source: "boom", target: "out" }
    ]
  };
}

interface Fixture {
  context: TestContext;
  admin: string;
  serverId: string;
  toolset: McpToolset;
  token: string;
  client: McpClient;
}

async function setup(options: { track: boolean; presets?: McpSafetyPresetId[] }): Promise<Fixture> {
  const context = await createTestContext();
  const call = caller(context);
  const admin = await login(context, "admin");
  const created = await call(admin, "POST", "/api/mcp/servers", { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false });
  const serverId = created.json<{ server: { id: string } }>().server.id;
  expect((await call(admin, "POST", `/api/mcp/servers/${serverId}/probe`)).statusCode).toBe(200);
  await context.store.upsertWorkflow(workflowTool("wf-plain", "plain_lookup", false));
  await context.store.upsertWorkflow(workflowTool("wf-secret", "secret_lookup", true));
  await context.store.upsertWorkflow(calculatorWorkflowTool("wf-calc", serverId));
  await context.store.upsertWorkflow(failingParentTool("wf-failing", "wf-secret", serverId));
  const toolsetResponse = await call(admin, "POST", "/api/mcp/toolsets", {
    name: "Agent tools",
    projectId: "default",
    ...(options.track ? { trackSessionLabels: true } : {}),
    members: [
      { kind: "server", serverId },
      { kind: "workflow", workflowId: "wf-plain" },
      { kind: "workflow", workflowId: "wf-secret" },
      { kind: "workflow", workflowId: "wf-calc" },
      { kind: "workflow", workflowId: "wf-failing" }
    ]
  });
  expect(toolsetResponse.statusCode, toolsetResponse.body).toBe(201);
  const toolset = toolsetResponse.json<{ toolset: McpToolset }>().toolset;
  const clientResponse = await call(admin, "POST", "/api/mcp/clients", { name: "IDE agent", toolsetIds: [toolset.id], role: "builder" });
  expect(clientResponse.statusCode).toBe(201);
  const { client, token } = clientResponse.json<{ client: McpClient; token: string }>();
  for (const preset of options.presets ?? []) {
    expect((await call(admin, "POST", `/api/mcp/policies/presets/${preset}`)).statusCode).toBe(201);
    expect((await call(admin, "POST", `/api/mcp/policies/${mcpSafetyPresetRuleId(preset)}/enforce`)).statusCode).toBe(200);
  }
  return { context, admin, serverId, toolset, token, client };
}

async function rpc(context: TestContext, slug: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return context.app.inject({
    method: "POST",
    url: `/mcp/${slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    payload: JSON.stringify(body)
  });
}

async function openSession(fixture: Pick<Fixture, "context" | "toolset" | "token">, token = fixture.token): Promise<string> {
  const response = await rpc(fixture.context, fixture.toolset.slug, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "taint-test", version: "1" } }
  });
  expect(response.statusCode).toBe(200);
  return response.headers["mcp-session-id"] as string;
}

let requestId = 10;

/** One tools/call; the tool is named by its upstream name (server tools) or its gateway name (workflow tools). */
async function callTool(
  fixture: Pick<Fixture, "context" | "toolset" | "token">,
  sessionId: string,
  tool: string,
  args: Record<string, unknown> = {},
  extra: { meta?: Record<string, unknown>; headers?: Record<string, string>; token?: string } = {}
): Promise<{ outcome: "ok" | "tool_error" | "approval_pending" | "other"; body: Record<string, unknown> }> {
  const listed = await rpc(fixture.context, fixture.toolset.slug, extra.token ?? fixture.token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/list" }, { "mcp-session-id": sessionId });
  const tools = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((entry) => entry.name);
  const name = tools.find((entry) => entry === tool || entry.endsWith(`__${tool}`) || entry.endsWith(`_${tool}`));
  if (!name) throw new Error(`No tool ${tool} in ${tools.join(", ")}`);
  const response = await rpc(
    fixture.context,
    fixture.toolset.slug,
    extra.token ?? fixture.token,
    { jsonrpc: "2.0", id: (requestId += 1), method: "tools/call", params: { name, arguments: args, ...(extra.meta ? { _meta: extra.meta } : {}) } },
    { "mcp-session-id": sessionId, ...(extra.headers ?? {}) }
  );
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<Record<string, unknown>>();
  const error = body.error as { code?: number } | undefined;
  if (error?.code === JSON_RPC_ERRORS.approvalPending) return { outcome: "approval_pending", body };
  if (error) return { outcome: "other", body };
  const result = body.result as { isError?: boolean };
  return { outcome: result.isError ? "tool_error" : "ok", body };
}

async function gatewayRows(store: Store) {
  const rows = await store.scanMcpToolCalls({
    since: new Date(Date.now() - 60_000).toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
    before: null,
    limit: 100,
    sources: ["gateway"]
  });
  return [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function auditEvents(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 100 })).items;
}

describe("migration v52", () => {
  it("adds the toolset setting, off by default, with a rollback, in both stores", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 52)!;
    expect(migration.up).toContain("ALTER TABLE mcp_toolsets ADD COLUMN IF NOT EXISTS track_session_labels INTEGER NOT NULL DEFAULT 0");
    expect(migration.down).toContain("ALTER TABLE mcp_toolsets DROP COLUMN IF EXISTS track_session_labels");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = (
      sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(mcp_toolsets)`)
        : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, "mcp_toolsets")
    ).map((column) => column.name);
    expect(columns).toContain("track_session_labels");
    const created = await context.store.createMcpToolset({ id: "ts-default", slug: "plain", name: "Plain", description: null, projectId: null, enabled: true, createdBy: null, members: [] });
    expect(created.trackSessionLabels).toBe(false);
    expect((await context.store.updateMcpToolset("ts-default", { trackSessionLabels: true }))?.trackSessionLabels).toBe(true);
    expect((await context.store.updateMcpToolset("ts-default", { name: "Renamed" }))?.trackSessionLabels).toBe(true);
    expect((await context.store.getMcpToolsetBySlug("plain"))?.trackSessionLabels).toBe(true);
  });
});

describe("the toolset setting", () => {
  it("is off by default, shown to builders, changed only by admins, and every change is audited", async () => {
    const { context, admin, toolset } = await setup({ track: false });
    const call = caller(context);
    const builder = await login(context, "builder");
    expect(toolset.trackSessionLabels).toBe(false);
    const shown = await call(builder, "GET", `/api/mcp/toolsets/${toolset.id}`);
    expect(shown.json<{ toolset: McpToolset }>().toolset.trackSessionLabels).toBe(false);
    expect((await call(builder, "PUT", `/api/mcp/toolsets/${toolset.id}`, { trackSessionLabels: true })).statusCode).toBe(403);
    expect((await call(admin, "PUT", `/api/mcp/toolsets/${toolset.id}`, { trackSessionLabels: "yes" })).statusCode).toBe(400);
    const on = await call(admin, "PUT", `/api/mcp/toolsets/${toolset.id}`, { trackSessionLabels: true });
    expect(on.statusCode).toBe(200);
    expect(on.json<{ toolset: McpToolset }>().toolset.trackSessionLabels).toBe(true);
    // Saving the same value again is not a change.
    expect((await call(admin, "PUT", `/api/mcp/toolsets/${toolset.id}`, { trackSessionLabels: true, name: "Agent tools 2" })).statusCode).toBe(200);
    expect((await call(admin, "PUT", `/api/mcp/toolsets/${toolset.id}`, { trackSessionLabels: false })).statusCode).toBe(200);
    const changes = await auditEvents(context.store, "mcp_toolset.session_tracking_changed");
    expect(changes.map((event) => (event.metadata as { trackSessionLabels: boolean }).trackSessionLabels).sort()).toEqual([false, true]);
    expect(changes.every((event) => event.resourceId === toolset.id)).toBe(true);
  });
});

describe("gateway calls with the setting off", () => {
  it("are checked without labels exactly as before: label rules never match and nothing is recorded", async () => {
    const fixture = await setup({ track: false, presets: ["untrusted_write_approval", "sensitive_no_open_world"] });
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "secret_lookup", { text: "x" })).outcome).toBe("ok");
    // After outside content and sensitive data, a write to an open-world tool still goes through.
    expect((await callTool(fixture, sessionId, "calculator", { expression: "2+2" })).outcome).toBe("ok");
    const rows = await gatewayRows(fixture.context.store);
    expect(rows.length).toBe(4);
    expect(rows.every((row) => row.labels === undefined || row.labels === null)).toBe(true);
    expect(rows.every((row) => !row.policyDecision?.labels)).toBe(true);
    expect(await auditEvents(fixture.context.store, "mcp_gateway.session_labels_raised")).toEqual([]);
    const listed = await caller(fixture.context)(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    const [view] = listed.json<{ sessions: McpGatewaySessionView[] }>().sessions;
    expect(view).toMatchObject({ tracked: false, labels: null, raisedAt: null });
  });
});

describe("gateway calls with the setting on", () => {
  it("checks a write after an outside-content call against the untrusted preset; the first call itself is not tainted", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval"] });
    const sessionId = await openSession(fixture);
    // The session starts with only the client's own request: the first write goes through.
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    const held = await callTool(fixture, sessionId, "calculator", { expression: "6*7" });
    expect(held.outcome).toBe("approval_pending");
    // Read-only tools are not held by this preset.
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");

    const rows = await gatewayRows(fixture.context.store);
    expect(rows.map((row) => row.labels)).toEqual([
      { provenance: ["user"], tracked: false },
      { provenance: ["user", "untrusted_external"], tracked: false },
      { provenance: ["user", "untrusted_external"], tracked: false }
    ]);
    const raised = await auditEvents(fixture.context.store, "mcp_gateway.session_labels_raised");
    expect(raised.length).toBe(1);
    expect(raised[0]!.metadata).toMatchObject({ sessionId, clientId: fixture.client.id, reason: "tool_result" });
    expect(String((raised[0]!.metadata as { tool: string }).tool)).toContain("calculator");
    const requested = await auditEvents(fixture.context.store, "mcp_gateway.approval_requested");
    expect(requested.length).toBe(1);

    const listed = await caller(fixture.context)(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    expect(listed.statusCode).toBe(200);
    const [view] = listed.json<{ sessions: McpGatewaySessionView[] }>().sessions;
    expect(view).toMatchObject({ tracked: true, labels: { provenance: ["untrusted_external"], dataClasses: [] }, toolsetName: "Agent tools" });
    expect(view!.idPrefix).toBe(sessionId.slice(0, 8));
    expect(view!.raisedAt).toMatch(/^\d{4}-/);
  });

  it("ignores labels a client declares in _meta, the arguments or headers", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval", "sensitive_no_open_world"] });
    const sessionId = await openSession(fixture);
    const claims = {
      meta: { labels: ["sensitive"], dataLabels: { provenance: ["sensitive", "untrusted_external"], dataClasses: ["email"] }, provenance: ["sensitive"] },
      headers: { "x-l2m-data-labels": "sensitive,untrusted_external", "x-data-labels": "sensitive", "x-provenance": "untrusted_external" }
    };
    // Declaring sensitive or outside content does not raise anything.
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1", labels: ["sensitive"] }, claims)).outcome).toBe("ok");
    // Once raised, declaring only `user` or `trusted` does not lower it.
    expect((await callTool(fixture, sessionId, "calculator", { expression: "2+2" }, { meta: { dataLabels: { provenance: ["trusted"] } }, headers: { "x-l2m-data-labels": "trusted" } })).outcome).toBe(
      "approval_pending"
    );
    const rows = await gatewayRows(fixture.context.store);
    expect(rows[0]!.labels).toEqual({ provenance: ["user"], tracked: false });
  });

  it("raises from a workflow tool's output: outside content, and sensitive when the run declared it; sensitive then denies open-world tools", async () => {
    const fixture = await setup({ track: true, presets: ["sensitive_no_open_world"] });
    const call = caller(fixture.context);
    const plain = await openSession(fixture);
    expect((await callTool(fixture, plain, "plain_lookup", { text: "hello" })).outcome).toBe("ok");
    // Outside content alone: the sensitive preset does not apply.
    expect((await callTool(fixture, plain, "calculator", { expression: "1+1" })).outcome).toBe("ok");

    const secret = await openSession(fixture);
    expect((await callTool(fixture, secret, "secret_lookup", { text: "hello" })).outcome).toBe("ok");
    expect((await callTool(fixture, secret, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
    const sessions = (await call(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`)).json<{ sessions: McpGatewaySessionView[] }>().sessions;
    expect(sessions.find((entry) => entry.idPrefix === secret.slice(0, 8))?.labels?.provenance).toEqual(["untrusted_external", "sensitive"]);
    expect(sessions.find((entry) => entry.idPrefix === plain.slice(0, 8))?.labels?.provenance).toEqual(["untrusted_external"]);
    const denied = await auditEvents(fixture.context.store, "mcp_gateway.tool_denied");
    expect(denied.length).toBe(1);
    expect((denied[0]!.metadata as { policy?: { labels?: unknown } }).policy?.labels).toEqual({ provenance: ["user", "untrusted_external", "sensitive"], tracked: false });

    // The run's input carries what the session collected: a workflow that calls an open-world tool is denied inside
    // the run in the sensitive session, and runs in the other one.
    expect((await callTool(fixture, plain, "calc_workflow")).outcome).toBe("ok");
    const inRun = await callTool(fixture, secret, "calc_workflow");
    expect(inRun.outcome).toBe("tool_error");
    expect(JSON.stringify(inRun.body)).toMatch(/policy|blocked|denied/i);
  });

  it("follows the admin's open-world override both ways", async () => {
    const fixture = await setup({ track: true, presets: ["sensitive_no_open_world"] });
    const call = caller(fixture.context);
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "secret_lookup", { text: "hello" })).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
    const url = `/api/mcp/servers/${fixture.serverId}/tools/calculator/open-world`;
    expect((await call(fixture.admin, "PUT", url, { openWorld: false })).statusCode).toBe(200);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call(fixture.admin, "PUT", url, { openWorld: true })).statusCode).toBe(200);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
  });

  it("keeps the mark per session and per client, and a new session starts clean", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval"] });
    const call = caller(fixture.context);
    const second = await call(fixture.admin, "POST", "/api/mcp/clients", { name: "Other agent", toolsetIds: [fixture.toolset.id], role: "builder" });
    const otherToken = second.json<{ token: string }>().token;

    const tainted = await openSession(fixture);
    const sibling = await openSession(fixture);
    const other = await openSession(fixture, otherToken);
    expect((await callTool(fixture, tainted, "get_current_time")).outcome).toBe("ok");
    expect((await callTool(fixture, tainted, "calculator", { expression: "1+1" })).outcome).toBe("approval_pending");
    expect((await callTool(fixture, sibling, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await callTool(fixture, other, "calculator", { expression: "1+1" }, { token: otherToken })).outcome).toBe("ok");

    const ended = await fixture.context.app.inject({
      method: "DELETE",
      url: `/mcp/${fixture.toolset.slug}`,
      headers: { authorization: `Bearer ${fixture.token}`, "mcp-session-id": tainted }
    });
    expect(ended.statusCode).toBe(204);
    const fresh = await openSession(fixture);
    expect((await callTool(fixture, fresh, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    const open = (await call(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`)).json<{ sessions: McpGatewaySessionView[] }>().sessions;
    expect(open.map((entry) => entry.idPrefix)).not.toContain(tainted.slice(0, 8));
  });

  it("counts results returned while tracking was off as outside content once it is turned on", async () => {
    const fixture = await setup({ track: false, presets: ["untrusted_write_approval"] });
    const call = caller(fixture.context);
    const sessionId = await openSession(fixture);
    const idle = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: true })).statusCode).toBe(200);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("approval_pending");
    // A session that made no call before is not affected.
    expect((await callTool(fixture, idle, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    const raised = await auditEvents(fixture.context.store, "mcp_gateway.session_labels_raised");
    expect(raised.find((event) => (event.metadata as { sessionId: string }).sessionId === sessionId)?.metadata).toMatchObject({ reason: "results_before_tracking", tool: null });
  });

  it("records the labels on the decision rows, and the simulator reads them; untracked rows stay unknown", async () => {
    const fixture = await setup({ track: true });
    const call = caller(fixture.context);
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { trackSessionLabels: false })).statusCode).toBe(200);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "2+2" })).outcome).toBe("ok");
    const rows = await gatewayRows(fixture.context.store);
    expect(rows.map((row) => row.labels ?? null)).toEqual([{ provenance: ["user"], tracked: false }, { provenance: ["user", "untrusted_external"], tracked: false }, null]);

    const simulate = async (addRule: Record<string, unknown>) => {
      const response = await call(fixture.admin, "POST", "/api/mcp/policies/simulate", { windowDays: 7, addRule });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ simulation: McpPolicySimulationResult }>().simulation;
    };
    const { id: _id, mode: _mode, ...untrusted } = mcpSafetyPresetRule("untrusted_write_approval");
    // The tracked write after outside content would need approval; the untracked one is undetermined.
    expect((await simulate(untrusted)).counts).toMatchObject({ newly_needs_approval: 1, undetermined: 1 });
  });
});

/** The gateway name of a tool in the fixture's toolset (server tools by their upstream name). */
async function gatewayToolName(fixture: Pick<Fixture, "context" | "toolset" | "token">, sessionId: string, tool: string): Promise<string> {
  const listed = await rpc(fixture.context, fixture.toolset.slug, fixture.token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/list" }, { "mcp-session-id": sessionId });
  const name = listed
    .json<{ result: { tools: Array<{ name: string }> } }>()
    .result.tools.map((entry) => entry.name)
    .find((entry) => entry === tool || entry.endsWith(`__${tool}`));
  if (!name) throw new Error(`No tool ${tool}`);
  return name;
}

async function createRule(fixture: Fixture, rule: Record<string, unknown>): Promise<string> {
  const response = await caller(fixture.context)(fixture.admin, "POST", "/api/mcp/policies", rule);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ rule: { id: string } }>().rule.id;
}

async function sessionView(fixture: Fixture, sessionId: string): Promise<McpGatewaySessionView | undefined> {
  const listed = await caller(fixture.context)(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
  return listed.json<{ sessions: McpGatewaySessionView[] }>().sessions.find((entry) => entry.idPrefix === sessionId.slice(0, 8));
}

describe("gateway calls never treat sensitive or data classes as checked", () => {
  it("keeps a deny when an allow carves out on the absence of sensitive, and the simulator agrees", async () => {
    const fixture = await setup({ track: true });
    const call = caller(fixture.context);
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");

    const deny = { name: "No calculator", effect: "deny", serverId: fixture.serverId, toolPattern: "calculator" };
    const carveOut = {
      name: "Calculator unless sensitive",
      effect: "allow",
      serverId: fixture.serverId,
      toolPattern: "calculator",
      conditions: { all: [{ op: "label_absent", value: "sensitive" }] }
    };
    await createRule(fixture, deny);
    // The simulator reads the recorded gateway row as the gateway decides: the carve-out changes nothing.
    const simulated = await call(fixture.admin, "POST", "/api/mcp/policies/simulate", { windowDays: 7, addRule: carveOut });
    expect(simulated.statusCode, simulated.body).toBe(200);
    expect(simulated.json<{ simulation: McpPolicySimulationResult }>().simulation.counts).toMatchObject({ no_longer_denied: 0, undetermined: 0, unchanged: 2 });

    // Live: the session read a server whose secret is not flagged; sensitive was never checked, so the deny holds.
    await createRule(fixture, carveOut);
    const name = await gatewayToolName(fixture, sessionId, "calculator");
    const denied = await rpc(fixture.context, fixture.toolset.slug, fixture.token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/call", params: { name, arguments: { expression: "2+2" } } }, { "mcp-session-id": sessionId });
    expect(JSON.stringify(denied.json())).toMatch(/blocked by policy|not allowed|denied/i);
    expect(await auditEvents(fixture.context.store, "mcp_gateway.tool_denied")).toHaveLength(1);
  });
});

describe("what raises a session's mark", () => {
  it("raises after a server call that errored, and the held call's approval request carries the labels", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval"] });
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "abc" })).outcome).toBe("tool_error");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("approval_pending");
    const [requested] = await auditEvents(fixture.context.store, "mcp_gateway.approval_requested");
    expect((requested!.metadata as { labels?: unknown }).labels).toEqual({ provenance: ["user", "untrusted_external"], tracked: false });
    // The request row keeps them too (v56), and the admin list returns them.
    const listed = await caller(fixture.context)(fixture.admin, "GET", "/api/mcp/gateway/approvals");
    expect(listed.statusCode).toBe(200);
    const [approval] = listed.json<{ approvals: McpGatewayApproval[] }>().approvals;
    expect(approval).toMatchObject({ id: (requested!.metadata as { approvalRequestId: string }).approvalRequestId, labels: { provenance: ["user", "untrusted_external"], tracked: false } });
  });

  it("raises after a server call the client cancelled", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval"] });
    const sessionId = await openSession(fixture);
    const name = await gatewayToolName(fixture, sessionId, "calculator");
    const hang = vi.spyOn(MockMCPServerAdapter.prototype, "invokeTool").mockImplementationOnce(() => new Promise(() => undefined));
    const pending = rpc(fixture.context, fixture.toolset.slug, fixture.token, { jsonrpc: "2.0", id: 777, method: "tools/call", params: { name, arguments: { expression: "1+1" } } }, { "mcp-session-id": sessionId });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rpc(fixture.context, fixture.toolset.slug, fixture.token, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 777, reason: "test" } }, { "mcp-session-id": sessionId });
    await pending;
    hang.mockRestore();
    expect((await sessionView(fixture, sessionId))?.labels?.provenance).toEqual(["untrusted_external"]);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("approval_pending");
  });

  it("does not raise after a call that was denied, held for approval or rate limited", async () => {
    const fixture = await setup({ track: true, presets: ["untrusted_write_approval"] });
    const call = caller(fixture.context);
    await createRule(fixture, { effect: "deny", serverId: fixture.serverId, toolPattern: "calculator", conditions: { all: [{ path: "expression", op: "starts_with", value: "9" }] } });
    await createRule(fixture, { effect: "require_approval", serverId: fixture.serverId, toolPattern: "calculator", conditions: { all: [{ path: "expression", op: "starts_with", value: "1000" }] } });
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "9*9" })).outcome).toBe("tool_error");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1000*3" })).outcome).toBe("approval_pending");
    expect((await sessionView(fixture, sessionId))?.labels).toEqual({ provenance: [], dataClasses: [] });

    // Another session spends the server's one call a minute; this session's call is then refused before the server.
    expect((await call(fixture.admin, "PUT", `/api/mcp/servers/${fixture.serverId}`, { limits: { requestsPerMinute: 1, maxQueueWaitMs: 0 } })).statusCode).toBe(200);
    const other = await openSession(fixture);
    expect((await callTool(fixture, other, "get_current_time")).outcome).toBe("ok");
    const limited = await callTool(fixture, sessionId, "get_current_time");
    expect((limited.body.error as { code?: number } | undefined)?.code).toBe(-32029);
    expect((await sessionView(fixture, sessionId))?.labels).toEqual({ provenance: [], dataClasses: [] });
    expect((await sessionView(fixture, other))?.labels?.provenance).toEqual(["untrusted_external"]);
    expect(await auditEvents(fixture.context.store, "mcp_gateway.session_labels_raised")).toHaveLength(1);
  });

  it("adds sensitive after a call to a server whose secret is flagged sensitive output", async () => {
    const fixture = await setup({ track: true, presets: ["sensitive_no_open_world"] });
    const call = caller(fixture.context);
    const secret = await call(fixture.admin, "POST", "/api/secrets", { name: "CRM token", provider: "custom", value: "crm-token-value", sensitiveOutput: true });
    expect(secret.statusCode, secret.body).toBe(200);
    const secretId = secret.json<{ id: string }>().id;
    expect((await call(fixture.admin, "PUT", `/api/mcp/servers/${fixture.serverId}`, { secretRef: { secretId } })).statusCode).toBe(200);
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await sessionView(fixture, sessionId))?.labels?.provenance).toEqual(["untrusted_external", "sensitive"]);
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
  });
});

describe("the toolset setting off", () => {
  it("does not look up flagged secrets after a server call", async () => {
    const fixture = await setup({ track: false });
    const call = caller(fixture.context);
    // A flagged secret clears the app's short cache, so a lookup would read the store.
    expect((await call(fixture.admin, "POST", "/api/secrets", { name: "Flagged", provider: "custom", value: "flagged-value", sensitiveOutput: true })).statusCode).toBe(200);
    const lookup = vi.spyOn(fixture.context.store, "listSensitiveOutputSecretIds");
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "get_current_time")).outcome).toBe("ok");
    expect((await callTool(fixture, sessionId, "calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });
});

describe("the sessions endpoint", () => {
  it("refuses viewers and operators, and answers 404 for an unknown client", async () => {
    const fixture = await setup({ track: true });
    const call = caller(fixture.context);
    const url = `/api/mcp/clients/${fixture.client.id}/sessions`;
    expect((await call(await login(fixture.context, "viewer"), "GET", url)).statusCode).toBe(403);
    expect((await call(await login(fixture.context, "operator"), "GET", url)).statusCode).toBe(403);
    expect((await call(await login(fixture.context, "builder"), "GET", url)).statusCode).toBe(200);
    expect((await call(fixture.admin, "GET", "/api/mcp/clients/mcl_missing/sessions")).statusCode).toBe(404);
  });
});

describe("a gateway workflow tool's run", () => {
  it("records the session's labels on its trigger, so a retry from history keeps sensitive", async () => {
    const fixture = await setup({ track: true });
    const call = caller(fixture.context);
    const denyId = await createRule(fixture, { effect: "deny", serverId: fixture.serverId, toolPattern: "calculator" });
    const sessionId = await openSession(fixture);
    expect((await callTool(fixture, sessionId, "secret_lookup", { text: "hello" })).outcome).toBe("ok");
    // The run fails: its calculator call is denied.
    expect((await callTool(fixture, sessionId, "calc_workflow")).outcome).toBe("tool_error");
    const failed = (await fixture.context.store.listExecutionHistory({ workflowId: "wf-calc", pageSize: 10 })).items;
    expect(failed.map((run) => run.status)).toEqual(["error"]);
    const history = await fixture.context.store.getExecutionHistory(failed[0]!.id);
    const trigger = (history!.nodeResults as Array<{ nodeId: string; labels?: { provenance: string[] } }>).find((result) => result.nodeId === "trigger");
    expect(trigger?.labels?.provenance).toContain("sensitive");

    // Now only the sensitive preset applies: the retry starts from the recorded labels, so it is denied again.
    expect((await call(fixture.admin, "DELETE", `/api/mcp/policies/${denyId}`)).statusCode).toBeLessThan(300);
    expect((await call(fixture.admin, "POST", "/api/mcp/policies/presets/sensitive_no_open_world")).statusCode).toBe(201);
    expect((await call(fixture.admin, "POST", `/api/mcp/policies/${mcpSafetyPresetRuleId("sensitive_no_open_world")}/enforce`)).statusCode).toBe(200);
    const retried = await call(fixture.admin, "POST", `/api/executions/${failed[0]!.id}/retry`, {});
    expect(retried.json<{ status: string }>().status, retried.body).toBe("error");
    expect(retried.body).toMatch(/policy|blocked|denied/i);
  });
});

describe("a workflow tool's run that returned no output labels (a queue worker that did not send them)", () => {
  it("counts as outside content, and sensitive when the workflow declares a sensitive source", async () => {
    const fixture = await setup({ track: true, presets: ["sensitive_no_open_world"] });
    engineLabels.drop = true;
    const plain = await openSession(fixture);
    expect((await callTool(fixture, plain, "plain_lookup", { text: "hello" })).outcome).toBe("ok");
    expect((await sessionView(fixture, plain))?.labels?.provenance).toEqual(["untrusted_external"]);
    expect((await callTool(fixture, plain, "calculator", { expression: "1+1" })).outcome).toBe("ok");

    const secret = await openSession(fixture);
    expect((await callTool(fixture, secret, "secret_lookup", { text: "hello" })).outcome).toBe("ok");
    expect((await sessionView(fixture, secret))?.labels?.provenance).toEqual(["untrusted_external", "sensitive"]);
    expect((await callTool(fixture, secret, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
  });

  it("walks a sub-workflow the workflow calls: a failed run of a tool that called a sensitive child gives sensitive", async () => {
    const fixture = await setup({ track: true, presets: ["sensitive_no_open_world"] });
    engineLabels.drop = true;
    const session = await openSession(fixture);
    expect((await callTool(fixture, session, "failing_parent")).outcome).toBe("tool_error");
    expect((await sessionView(fixture, session))?.labels?.provenance).toEqual(["untrusted_external", "sensitive"]);
    expect((await callTool(fixture, session, "calculator", { expression: "1+1" })).outcome).toBe("tool_error");
  });
});
