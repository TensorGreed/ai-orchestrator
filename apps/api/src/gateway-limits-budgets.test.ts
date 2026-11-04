/**
 * 12.6 (D5, D6, D8) — budgets and rate limits on the MCP gateway, and budget blocks on every trigger.
 *
 * - Gateway usage is attributed to the client (usage_events.client_id, v54) and counts toward the toolset's project;
 *   gateway server calls record their sampling cost. Budgets get the `mcp_client` scope.
 * - A used-up `block` budget of the client, the toolset's project or the deployment refuses a gateway call (JSON-RPC
 *   -32032) before the tool policy; warn budgets only alert.
 * - A block budget refuses runs from every trigger (webhooks 402, a schedule as a failed run, chat, forms, retries);
 *   replays of a run's MCP calls are not refused.
 * - Optional per-client rate limits (client overrides toolset): requests per minute with a burst, and concurrency.
 * - With no budgets and no limits nothing changes and a gateway call reads neither.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpClientBudgetUsage, McpToolset, Workflow } from "@ai-orchestrator/shared";
import { MockMCPServerAdapter } from "@ai-orchestrator/mcp-sdk";
import { DEFAULT_OUTBOUND_GUARD } from "@ai-orchestrator/workflow-engine";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { SchedulerService, type SchedulerExecutionInput } from "./services/scheduler-service.js";
import { QueueService } from "./services/queue-service.js";
import { TriggerService } from "./services/trigger-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  /** The scheduler's execution handler (a schedule firing). */
  schedule?: (input: SchedulerExecutionInput) => Promise<void>;
}

const contexts: TestContext[] = [];

/** Echo answers sampling and LLM nodes; this price makes one token cost one dollar. */
const PRICING = JSON.stringify({ echo: { "echo-1": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 } } });

interface ContextOptions {
  /** A queue service (the `/enqueue` route needs one on SQLite). */
  queue?: boolean;
  /** Makes the app/polling trigger service the app wires its handler into. */
  triggerService?: (store: Store) => TriggerService;
  /** Runs before the app is built (spies the app must see from its start). */
  beforeApp?: (store: Store) => void;
}

async function createTestContext(env: Record<string, string> = {}, options: ContextOptions = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-gw-limits-"));
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
    LLM_PRICING_OVERRIDES_JSON: PRICING,
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const context: TestContext = { app: undefined as unknown as FastifyInstance, store, authService, config, tempDir };
  const scheduler = new SchedulerService(store, () => undefined);
  const set = scheduler.setExecutionHandler.bind(scheduler);
  scheduler.setExecutionHandler = (handler) => {
    context.schedule = handler;
    set(handler);
  };
  options.beforeApp?.(store);
  const queue = options.queue ? new QueueService(store, { pollIntervalMs: 3_600_000 }) : undefined;
  context.app = await createApp(config, store, secretService, authService, scheduler, queue, options.triggerService?.(store));
  await context.app.ready();
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
  return (cookie: string | null, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    context.app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

/** A workflow tool: answers "looked up" (no model). */
function lookupTool(id: string, projectId = "default"): Workflow {
  return {
    id,
    name: "Lookup",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: `${id}-path`, toolName: "lookup", inputSchema: { type: "object", properties: { text: { type: "string" } } }, authMode: "public" }
      },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { outputKey: "result", responseTemplate: "looked up" } }
    ],
    edges: [{ id: "e1", source: "trigger", target: "out" }]
  } as Workflow;
}

/** A workflow tool that asks the echo model (its run records tokens and cost). */
function modelTool(id: string, projectId = "default"): Workflow {
  return {
    id,
    name: "Ask",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: `${id}-path`, toolName: "ask", inputSchema: { type: "object", properties: { text: { type: "string" } } }, authMode: "public" }
      },
      { id: "model", type: "llm_call", name: "Model", position: { x: 200, y: 0 }, config: { provider: { providerId: "echo", model: "echo-1" }, userPromptTemplate: "Say {{text}}" } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "model" },
      { id: "e2", source: "model", target: "out" }
    ]
  } as Workflow;
}

/** A webhook, a chat, a form and a schedule, each answering "ran". */
function triggerWorkflow(id: string, type: "webhook_input" | "chat_trigger" | "form_trigger" | "schedule_trigger"): Workflow {
  const config: Record<string, unknown> =
    type === "webhook_input"
      ? { path: `hook-${id}`, method: "POST" }
      : type === "form_trigger"
        ? { path: `form-${id}`, title: "Form", authMode: "public", fields: [{ name: "name", label: "Name", type: "text", required: false }] }
        : type === "schedule_trigger"
          ? { cronExpression: "0 0 1 1 *", timezone: "UTC" }
          : {};
  return {
    id,
    name: `Trigger ${type}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type, name: "Start", position: { x: 0, y: 0 }, config },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { outputKey: "result", responseTemplate: "ran" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  } as Workflow;
}

interface Fixture {
  context: TestContext;
  admin: string;
  serverId: string;
  toolset: McpToolset;
  client: McpClient;
  token: string;
  /** A second client of the same toolset. */
  peer: McpClient;
  peerToken: string;
}

async function setup(env: Record<string, string> = {}, toolsetProjectId = "default", options: ContextOptions = {}): Promise<Fixture> {
  const context = await createTestContext(env, options);
  const call = caller(context);
  const admin = await login(context, "admin");
  const created = await call(admin, "POST", "/api/mcp/servers", {
    name: "Mock tools",
    adapterId: "mock-mcp",
    probeEnabled: false,
    sampling: { allow: true, maxTokens: 200, allowedModels: [], defaultModel: { providerId: "echo", model: "echo-1" } }
  });
  expect(created.statusCode, created.body).toBe(201);
  const serverId = created.json<{ server: { id: string } }>().server.id;
  expect((await call(admin, "POST", `/api/mcp/servers/${serverId}/probe`)).statusCode).toBe(200);
  await context.store.upsertWorkflow(lookupTool("wf-lookup"));
  await context.store.upsertWorkflow(modelTool("wf-ask"));
  const toolsetResponse = await call(admin, "POST", "/api/mcp/toolsets", {
    name: "Agent tools",
    projectId: toolsetProjectId,
    members: [
      { kind: "server", serverId },
      { kind: "workflow", workflowId: "wf-lookup" },
      { kind: "workflow", workflowId: "wf-ask" }
    ]
  });
  expect(toolsetResponse.statusCode, toolsetResponse.body).toBe(201);
  const toolset = toolsetResponse.json<{ toolset: McpToolset }>().toolset;
  const makeClient = async (name: string) => {
    const response = await call(admin, "POST", "/api/mcp/clients", { name, toolsetIds: [toolset.id], role: "builder" });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ client: McpClient; token: string }>();
  };
  const first = await makeClient("IDE agent");
  const peer = await makeClient("Peer agent");
  return { context, admin, serverId, toolset, client: first.client, token: first.token, peer: peer.client, peerToken: peer.token };
}

async function rpc(context: TestContext, slug: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return context.app.inject({
    method: "POST",
    url: `/mcp/${slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    payload: JSON.stringify(body)
  });
}

async function openSession(context: TestContext, slug: string, token: string): Promise<string> {
  const response = await rpc(context, slug, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "limits-test", version: "1" } }
  });
  expect(response.statusCode).toBe(200);
  return response.headers["mcp-session-id"] as string;
}

let requestId = 10;

interface CallOutcome {
  outcome: "ok" | "tool_error" | "rpc_error";
  text: string;
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

/** The gateway name of a server tool (`<server-slug>__<tool>`) or a workflow tool. */
async function toolName(context: TestContext, slug: string, token: string, sessionId: string, tool: string): Promise<string> {
  const listed = await rpc(context, slug, token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/list" }, { "mcp-session-id": sessionId });
  const tools = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((entry) => entry.name);
  const name = tools.find((entry) => entry === tool || entry.endsWith(`__${tool}`));
  if (!name) throw new Error(`No tool ${tool} in ${tools.join(", ")}`);
  return name;
}

async function callNamed(context: TestContext, slug: string, token: string, sessionId: string, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const response = await rpc(context, slug, token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sessionId });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: CallOutcome["error"] }>();
  if (body.error) return { outcome: "rpc_error", text: body.error.message, error: body.error };
  const text = (body.result?.content ?? []).map((entry) => entry.text ?? "").join("\n");
  return { outcome: body.result?.isError ? "tool_error" : "ok", text };
}

/** Calls tools by short name for one client, in one session. */
function toolCaller(fixture: Fixture, which: "client" | "peer" = "client") {
  const token = which === "client" ? fixture.token : fixture.peerToken;
  let session: string | undefined;
  const names = new Map<string, string>();
  return async (tool: string, args: Record<string, unknown> = {}) => {
    session ??= await openSession(fixture.context, fixture.toolset.slug, token);
    if (!names.has(tool)) names.set(tool, await toolName(fixture.context, fixture.toolset.slug, token, session, tool));
    return await callNamed(fixture.context, fixture.toolset.slug, token, session, names.get(tool)!, args);
  };
}

async function createBudget(fixture: Fixture, body: Record<string, unknown>): Promise<string> {
  const response = await caller(fixture.context)(fixture.admin, "POST", "/api/budgets", { period: "month", warnThresholdPct: 0.8, ...body });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ budget: { id: string } }>().budget.id;
}

/** Deletes every budget through the route (the instance's budget copy is refreshed at once). */
async function deleteBudgets(fixture: Fixture): Promise<void> {
  const call = caller(fixture.context);
  const listed = await call(fixture.admin, "GET", "/api/budgets");
  for (const budget of listed.json<{ budgets: Array<{ id: string }> }>().budgets) {
    expect((await call(fixture.admin, "DELETE", `/api/budgets/${budget.id}`)).statusCode).toBe(200);
  }
}

/** A run's usage as usage_events records it. */
async function seedRunUsage(store: Store, input: { tokens: number; costUsd?: number; clientId?: string | null; userId?: string | null; toolsetId?: string | null; projectId?: string; workflowId?: string }) {
  await store.writeUsageEvent({
    id: `usage_${crypto.randomUUID()}`,
    executionId: `exec_${crypto.randomUUID()}`,
    workflowId: input.workflowId ?? "wf-elsewhere",
    workflowName: "Elsewhere",
    userId: input.userId ?? null,
    userEmail: null,
    projectId: input.projectId ?? "default",
    triggerType: "mcp_gateway",
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.toolsetId ? { toolsetId: input.toolsetId } : {}),
    status: "success",
    inputTokens: input.tokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: input.tokens,
    costUsd: input.costUsd ?? 0,
    llmCallCount: 1,
    durationMs: 1,
    providers: []
  });
}

/** A gateway server call's sampling, as its telemetry row records it. */
async function seedSampling(store: Store, input: { clientId: string; toolsetId: string; tokens: number; costUsd: number }) {
  await store.insertMcpToolCall({
    id: `mtc_${crypto.randomUUID()}`,
    executionId: `mcpgw_${crypto.randomUUID()}`,
    workflowId: "",
    nodeId: "",
    registryServerId: null,
    adapterId: "mock-mcp",
    toolName: "summarize_with_model",
    startedAt: new Date().toISOString(),
    durationMs: 1,
    ok: true,
    error: null,
    turnInputTokens: null,
    turnOutputTokens: null,
    estimatedCostUsd: input.costUsd,
    samplingRequests: 1,
    samplingInputTokens: input.tokens,
    samplingOutputTokens: 0,
    source: "gateway",
    clientId: input.clientId,
    toolsetId: input.toolsetId
  });
}

async function runs(store: Store) {
  return (await store.listExecutionHistory({ pageSize: 200 })).items;
}

async function gatewayRows(store: Store) {
  return await store.scanMcpToolCalls({
    since: new Date(Date.now() - 60_000).toISOString(),
    until: new Date(Date.now() + 60_000).toISOString(),
    before: null,
    limit: 200,
    sources: ["gateway"]
  });
}

async function auditEvents(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 100 })).items;
}

async function clientBudgets(fixture: Fixture, cookie: string, clientId: string): Promise<McpClientBudgetUsage[]> {
  const response = await caller(fixture.context)(cookie, "GET", `/api/mcp/clients/${clientId}/budgets`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ budgets: McpClientBudgetUsage[] }>().budgets;
}

describe("migration v54", () => {
  it("adds the client and toolset to usage events and rate limits to clients and toolsets, with a rollback, in both stores", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 54)!;
    expect(migration.description).toContain("12.6");
    for (const statement of [
      "ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS client_id TEXT",
      "ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS toolset_id TEXT",
      "CREATE INDEX IF NOT EXISTS idx_usage_events_client_created ON usage_events(client_id, created_at DESC)",
      "ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS rate_limit_json TEXT",
      "ALTER TABLE mcp_toolsets ADD COLUMN IF NOT EXISTS rate_limit_json TEXT"
    ]) {
      expect(migration.up).toContain(statement);
    }
    for (const statement of [
      "ALTER TABLE usage_events DROP COLUMN IF EXISTS client_id",
      "ALTER TABLE usage_events DROP COLUMN IF EXISTS toolset_id",
      "DROP INDEX IF EXISTS idx_usage_events_client_created",
      "ALTER TABLE mcp_clients DROP COLUMN IF EXISTS rate_limit_json",
      "ALTER TABLE mcp_toolsets DROP COLUMN IF EXISTS rate_limit_json"
    ]) {
      expect(migration.down).toContain(statement);
    }
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columnsOf = async (table: string) =>
      (
        sql.kind === "sqlite"
          ? await sql.all<{ name: string }>(`PRAGMA table_info(${table})`)
          : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, table)
      ).map((column) => column.name);
    expect(await columnsOf("usage_events")).toEqual(expect.arrayContaining(["client_id", "toolset_id"]));
    expect(await columnsOf("mcp_clients")).toContain("rate_limit_json");
    expect(await columnsOf("mcp_toolsets")).toContain("rate_limit_json");
  });

  it("round-trips rate limits and counts budget usage per scope in both stores", async () => {
    const context = await createTestContext();
    const { store } = context;
    const toolset = await store.createMcpToolset({ id: "ts-a", slug: "a", name: "A", description: null, projectId: "proj-gw", enabled: true, rateLimit: { requestsPerMinute: 10, burst: 2, maxConcurrent: null }, createdBy: null, members: [] });
    expect(toolset.rateLimit).toEqual({ requestsPerMinute: 10, burst: 2, maxConcurrent: null });
    expect((await store.updateMcpToolset("ts-a", { rateLimit: null }))!.rateLimit).toBeNull();
    const client = await store.createMcpClient({ id: "cl-a", name: "Agent A", tokenPrefix: "pfx", tokenHash: "h", toolsetIds: ["ts-a"], role: "builder", createdBy: null, createdByEmail: null, expiresAt: null });
    expect(client.rateLimit).toBeNull();
    const updated = await store.updateMcpClient("cl-a", { name: "Agent A2", rateLimit: { requestsPerMinute: null, burst: null, maxConcurrent: 3 } });
    expect(updated).toMatchObject({ name: "Agent A2", rateLimit: { requestsPerMinute: null, burst: null, maxConcurrent: 3 }, toolsetIds: ["ts-a"], role: "builder" });
    expect(await store.updateMcpClient("missing", { name: "x" })).toBeNull();

    await seedRunUsage(store, { tokens: 10, costUsd: 1, clientId: "cl-a", toolsetId: "ts-a", projectId: "default" });
    // Written before v54: the client is only named in user_id.
    await seedRunUsage(store, { tokens: 20, costUsd: 2, userId: "mcp-client:Agent A2" });
    await seedRunUsage(store, { tokens: 40, costUsd: 4, userId: "u-1", workflowId: "wf-x", projectId: "proj-gw" });
    await seedSampling(store, { clientId: "cl-a", toolsetId: "ts-a", tokens: 5, costUsd: 0.5 });
    const sql = testSql(store);
    const rows = await sql.all<{ client_id: string | null; toolset_id: string | null }>(`SELECT client_id, toolset_id FROM usage_events WHERE client_id IS NOT NULL`);
    expect(rows).toEqual([{ client_id: "cl-a", toolset_id: "ts-a" }]);
    const window = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    expect(await store.queryBudgetUsage(window)).toEqual({ costUsd: 7.5, totalTokens: 75 });
    expect(await store.queryBudgetUsage({ ...window, clientId: "cl-a" })).toEqual({ costUsd: 3.5, totalTokens: 35 });
    // The project's own run plus the run and sampling through its toolset.
    expect(await store.queryBudgetUsage({ ...window, projectId: "proj-gw" })).toEqual({ costUsd: 5.5, totalTokens: 55 });
    // Workflow and user scopes count runs only.
    expect(await store.queryBudgetUsage({ ...window, workflowId: "wf-x" })).toEqual({ costUsd: 4, totalTokens: 40 });
    expect(await store.queryBudgetUsage({ ...window, userKey: "u-1" })).toEqual({ costUsd: 4, totalTokens: 40 });
  });
});

describe("with no budgets and no rate limits", () => {
  it("answers gateway calls and runs as before, and a gateway call reads no budget or limit state", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    const call = toolCaller(fixture);
    const listBudgets = vi.spyOn(store, "listBudgets");
    const usage = vi.spyOn(store, "queryBudgetUsage");
    const buckets = vi.spyOn(store, "hitRateLimitBucket");
    const calls = 8;
    for (let index = 0; index < calls / 2; index += 1) {
      expect((await call("calculator", { expression: "6*7" })).outcome).toBe("ok");
      expect(await call("lookup")).toMatchObject({ outcome: "ok", text: expect.stringContaining("looked up") });
    }
    // At most the background re-read of the budget snapshot (every 2 s), never one read per call.
    expect(listBudgets.mock.calls.length).toBeLessThan(calls / 2);
    expect(usage).not.toHaveBeenCalled();
    expect(buckets).not.toHaveBeenCalled();
    const rows = await gatewayRows(store);
    expect(rows).toHaveLength(calls);
    expect((await store.listMcpToolCallsForClient(fixture.client.id, new Date(Date.now() - 60_000).toISOString())).every((row) => row.estimatedCostUsd === null)).toBe(true);
    // A webhook run reads no budget either.
    await store.upsertWorkflow(triggerWorkflow("wf-hook", "webhook_input"));
    const hook = await fixture.context.app.inject({ method: "POST", url: "/webhook/hook-wf-hook", payload: { a: 1 } });
    expect(hook.statusCode, hook.body).toBe(200);
    expect(usage).not.toHaveBeenCalled();
    // The client and toolset carry no limit.
    expect(fixture.client.rateLimit).toBeNull();
    expect(fixture.toolset.rateLimit).toBeNull();
  });
});

describe("client and project budgets on the gateway", () => {
  it("a used-up client block budget refuses server and workflow tools before the policy; other clients go on", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    const budgetId = await createBudget(fixture, { name: "IDE cap", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 100, action: "block" });
    const call = toolCaller(fixture);
    // Under the cap: allowed.
    await seedRunUsage(store, { tokens: 60, clientId: fixture.client.id, toolsetId: fixture.toolset.id });
    expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    await seedRunUsage(store, { tokens: 60, clientId: fixture.client.id, toolsetId: fixture.toolset.id });
    const before = (await gatewayRows(store)).length;
    const runsBefore = (await runs(store)).length;
    const refused = await call("calculator", { expression: "2+2" });
    expect(refused).toMatchObject({ outcome: "rpc_error", error: { code: -32032, message: 'Budget "IDE cap" exceeded for the current month.', data: { budgetId, period: "month" } } });
    expect(refused.error!.data!.retryAfterSeconds).toBeGreaterThan(0);
    const workflowRefused = await call("lookup");
    expect(workflowRefused.error?.code).toBe(-32032);
    // Neither call reached the server or started a run.
    expect((await gatewayRows(store)).length).toBe(before);
    expect((await runs(store)).length).toBe(runsBefore);
    // Audited once in the minute, however many calls were refused.
    const audits = await auditEvents(store, "mcp_gateway.budget_blocked");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ clientId: fixture.client.id, budgetId, scopeType: "mcp_client" });
    // The peer client has no budget.
    expect((await toolCaller(fixture, "peer")("calculator", { expression: "3+3" })).outcome).toBe("ok");
    // The client's Governance shows the budget and its usage, to builders too.
    const builder = await login(fixture.context, "builder");
    expect(await clientBudgets(fixture, builder, fixture.client.id)).toEqual([
      expect.objectContaining({ budgetId, name: "IDE cap", scopeType: "mcp_client", limitType: "tokens", limitValue: 100, action: "block", current: 120 })
    ]);
    expect((await caller(fixture.context)(null, "GET", `/api/mcp/clients/${fixture.client.id}/budgets`)).statusCode).toBe(401);
  });

  it("counts the client's runs recorded before v54 by its name", async () => {
    const fixture = await setup();
    await createBudget(fixture, { name: "IDE cap", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 50, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 80, userId: `mcp-client:${fixture.client.name}` });
    expect((await toolCaller(fixture)("calculator", { expression: "1+1" })).error?.code).toBe(-32032);
    expect((await clientBudgets(fixture, fixture.admin, fixture.client.id))[0]!.current).toBe(80);
  });

  it("a block budget of the toolset's project counts the toolset's gateway usage and refuses its calls", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    expect((await caller(context)(admin, "POST", "/api/projects", { id: "proj-gw", name: "Gateway" })).statusCode).toBeLessThan(300);
    contexts.pop();
    await context.app.close();
    await context.store.close();
    fs.rmSync(context.tempDir, { recursive: true, force: true });
    const fixture = await setup({}, "default");
    const call = caller(fixture.context);
    expect((await call(fixture.admin, "POST", "/api/projects", { id: "proj-gw", name: "Gateway" })).statusCode).toBeLessThan(300);
    const moved = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { projectId: "proj-gw" });
    expect(moved.statusCode, moved.body).toBe(200);
    await createBudget(fixture, { name: "Gateway project", scopeType: "project", scopeId: "proj-gw", limitType: "usd", limitValue: 1, action: "block" });
    // Sampling through the toolset (no workflow in the project at all).
    await seedSampling(fixture.context.store, { clientId: fixture.peer.id, toolsetId: fixture.toolset.id, tokens: 3, costUsd: 2 });
    expect((await toolCaller(fixture)("calculator", { expression: "1+1" })).error).toMatchObject({ code: -32032, message: 'Budget "Gateway project" exceeded for the current month.' });
    // A run of the project's own workflows (not a gateway call) is refused by the same budget.
    await fixture.context.store.upsertWorkflow({ ...triggerWorkflow("wf-proj-hook", "webhook_input"), projectId: "proj-gw" });
    expect((await fixture.context.app.inject({ method: "POST", url: "/webhook/hook-wf-proj-hook", payload: {} })).statusCode).toBe(402);
  });

  it("a warn budget never refuses a call; it alerts once the client's usage crosses its threshold", async () => {
    const fixture = await setup();
    const budgetId = await createBudget(fixture, { name: "IDE watch", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 100, action: "warn", warnThresholdPct: 0.5 });
    await seedRunUsage(fixture.context.store, { tokens: 120, clientId: fixture.client.id });
    const call = toolCaller(fixture);
    expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call("lookup")).outcome).toBe("ok");
    const alerts = await fixture.context.store.listBudgetAlerts({ budgetId });
    expect(alerts.map((alert) => alert.severity)).toEqual(["block"]);
  });
});

describe("gateway usage attribution", () => {
  it("records the client and toolset on a workflow tool's run usage, and counts it toward the client and the toolset's project", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    const answer = await toolCaller(fixture)("ask", { text: "hello there" });
    expect(answer.outcome, answer.text).toBe("ok");
    const sql = testSql(store);
    const rows = await sql.all<{ client_id: string | null; toolset_id: string | null; user_id: string | null; total_tokens: number; cost_usd: number }>(
      `SELECT client_id, toolset_id, user_id, total_tokens, cost_usd FROM usage_events WHERE workflow_id = ?`,
      "wf-ask"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: fixture.client.id, toolset_id: fixture.toolset.id, user_id: `mcp-client:${fixture.client.name}` });
    expect(Number(rows[0]!.total_tokens)).toBeGreaterThan(0);
    await createBudget(fixture, { name: "IDE spend", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 1_000_000, action: "warn" });
    expect((await clientBudgets(fixture, fixture.admin, fixture.client.id))[0]!.current).toBe(Number(rows[0]!.total_tokens));
    // The peer's own budget does not count it.
    await createBudget(fixture, { name: "Peer spend", scopeType: "mcp_client", scopeId: fixture.peer.id, limitType: "tokens", limitValue: 1_000_000, action: "warn" });
    expect((await clientBudgets(fixture, fixture.admin, fixture.peer.id))[0]!.current).toBe(0);
    // Another trigger's run of the same workflow is not the client's.
    const executed = await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-ask/execute", { input: { text: "hi" } });
    expect(executed.statusCode, executed.body).toBe(200);
    expect(await sql.all(`SELECT client_id FROM usage_events WHERE workflow_id = ? AND client_id IS NULL`, "wf-ask")).toHaveLength(1);
  });

  it("prices a gateway server call's sampling on its telemetry row and counts it toward the client's budgets and alerts", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    const budgetId = await createBudget(fixture, { name: "IDE dollars", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "usd", limitValue: 1, action: "warn", warnThresholdPct: 0.5 });
    const answer = await toolCaller(fixture)("summarize_with_model", { text: "A long text to summarize for the test." });
    expect(answer.outcome, answer.text).toBe("ok");
    const row = (await store.listMcpToolCallsForClient(fixture.client.id, new Date(Date.now() - 60_000).toISOString())).find((entry) => entry.toolName === "summarize_with_model")!;
    expect(row.samplingRequests).toBe(1);
    const tokens = (row.samplingInputTokens ?? 0) + (row.samplingOutputTokens ?? 0);
    expect(tokens).toBeGreaterThan(0);
    // One token costs one dollar with the test's price.
    expect(row.estimatedCostUsd).toBeCloseTo(tokens, 6);
    expect((await clientBudgets(fixture, fixture.admin, fixture.client.id))[0]!.current).toBeCloseTo(tokens, 6);
    expect((await store.listBudgetAlerts({ budgetId })).map((alert) => alert.severity)).toEqual(["block"]);
  });
});

describe("a block budget refuses runs from every trigger", () => {
  async function overGlobalBudget() {
    const fixture = await setup();
    await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50 });
    return fixture;
  }

  it("answers 402 to a webhook, the webhook API, a chat, a form, a stream and a retry, and starts nothing", async () => {
    const fixture = await setup();
    const { store, app } = fixture.context;
    for (const [id, type] of [["wf-hook", "webhook_input"], ["wf-chat", "chat_trigger"], ["wf-form", "form_trigger"]] as const) {
      await store.upsertWorkflow(triggerWorkflow(id, type));
    }
    // A run made before the budget was used up, to retry later.
    const first = await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-hook/execute", { input: {} });
    expect(first.statusCode, first.body).toBe(200);
    const sourceId = first.json<{ executionId: string }>().executionId;
    // Only a failed run can be retried.
    await testSql(store).run("UPDATE execution_history SET status = ? WHERE id = ?", "error", sourceId);
    const budgetId = await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(store, { tokens: 50 });
    const runsBefore = (await runs(store)).length;
    const refusedResponses = [
      await app.inject({ method: "POST", url: "/webhook/hook-wf-hook", payload: { a: 1 } }),
      await app.inject({ method: "POST", url: "/webhook-test/hook-wf-hook", payload: { a: 1 } }),
      await caller(fixture.context)(fixture.admin, "POST", "/api/webhooks/execute", { workflow_id: "wf-hook", user_prompt: "hi" }),
      await caller(fixture.context)(fixture.admin, "POST", "/api/webhooks/execute/stream", { workflow_id: "wf-hook", user_prompt: "hi" }),
      await app.inject({ method: "POST", url: "/api/chat/wf-chat", payload: { message: "hi" } }),
      await app.inject({ method: "POST", url: "/api/forms/form-wf-form", headers: { accept: "application/json" }, payload: { name: "Ann" } }),
      await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-hook/execute/stream", { input: {} }),
      await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-hook/execute", { input: {} }),
      await caller(fixture.context)(fixture.admin, "POST", `/api/executions/${sourceId}/retry`, {})
    ];
    for (const response of refusedResponses) {
      expect(response.statusCode, `${response.statusCode} ${response.body}`).toBe(402);
      expect(response.json()).toMatchObject({ error: "budget_exceeded", budgetId, message: 'Budget "Deployment cap" exceeded for the current month.' });
      expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    }
    // N2-M1: the webhook, chat and form callers are anonymous and see no amounts; the admin API callers do.
    const anonymous = new Set([0, 1, 4, 5]);
    refusedResponses.forEach((response, index) => {
      const body = response.json<Record<string, unknown>>();
      if (anonymous.has(index)) {
        expect(body, `anonymous ${index}`).not.toHaveProperty("limit");
        expect(body, `anonymous ${index}`).not.toHaveProperty("currentUsage");
      } else {
        expect(body, `admin ${index}`).toMatchObject({ limit: 10, currentUsage: 50 });
      }
    });
    expect((await runs(store)).length).toBe(runsBefore);
  });

  it("N-L3: a refused trigger writes its counter at most once a minute per instance", async () => {
    const fixture = await overGlobalBudget();
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-fast", "schedule_trigger"));
    const writes = vi.spyOn(store, "recordBudgetRefusedRun");
    const fire = async () => {
      const at = new Date().toISOString();
      await fixture.context.schedule!({ workflowId: "wf-fast", workflowName: "fast", scheduleNodeId: "start", cronExpression: "* * * * *", timezone: "UTC", firedAt: at, scheduledFor: at });
    };
    for (let i = 0; i < 6; i += 1) await fire();
    expect(writes).toHaveBeenCalledTimes(1);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
    await fire();
    expect(writes).toHaveBeenCalledTimes(2);
    const [row] = (await runs(store)).filter((run) => run.workflowId === "wf-fast");
    expect((await store.getExecutionHistory(row!.id))?.output).toMatchObject({ refusedFires: 2 });
  });

  it("N2-L2: a failed refused-run write does not start the one-minute wait", async () => {
    const fixture = await overGlobalBudget();
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-flaky", "schedule_trigger"));
    const real = store.recordBudgetRefusedRun.bind(store);
    const writes = vi.spyOn(store, "recordBudgetRefusedRun").mockRejectedValueOnce(new Error("disk full"));
    const fire = async () => {
      const at = new Date().toISOString();
      await fixture.context.schedule!({ workflowId: "wf-flaky", workflowName: "flaky", scheduleNodeId: "start", cronExpression: "* * * * *", timezone: "UTC", firedAt: at, scheduledFor: at });
    };
    await fire();
    expect((await runs(store)).filter((run) => run.workflowId === "wf-flaky")).toHaveLength(0);
    writes.mockImplementation(real);
    await fire();
    expect(writes).toHaveBeenCalledTimes(2);
    expect((await runs(store)).filter((run) => run.workflowId === "wf-flaky")).toHaveLength(1);
  });

  it("records one failed run per schedule and budget period; later refused fires only count on it (D13)", async () => {
    const fixture = await overGlobalBudget();
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-cron", "schedule_trigger"));
    // A minutely schedule under a used-up budget: five fires, one run.
    // The refused-run counter is written at most once a minute per instance: the clock moves a minute per fire.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    for (let minute = 0; minute < 5; minute += 1) {
      skew = minute * 61_000;
      const at = new Date(realNow() + minute * 60_000).toISOString();
      await fixture.context.schedule!({ workflowId: "wf-cron", workflowName: "cron", scheduleNodeId: "start", cronExpression: "* * * * *", timezone: "UTC", firedAt: at, scheduledFor: at });
    }
    const cron = (await runs(store)).filter((run) => run.workflowId === "wf-cron");
    expect(cron).toHaveLength(1);
    expect(cron[0]).toMatchObject({ status: "error", triggerType: "cron" });
    const detail = await store.getExecutionHistory(cron[0]!.id);
    expect(detail?.error).toBe('Budget "Deployment cap" exceeded for the current month. The run did not start.');
    expect(detail?.output).toMatchObject({ refusedFires: 5, periodStart: expect.any(String), budgetId: expect.any(String) });
    expect(detail?.output).toMatchObject({ firstRefusedAt: expect.any(String), lastRefusedAt: expect.any(String) });
    // Each counted fire moved the run's start time to the latest refusal, so history ordering and retention see it recent.
    expect(Date.parse(detail!.startedAt)).toBeGreaterThan(Date.parse((detail!.output as { firstRefusedAt: string }).firstRefusedAt) - 1);
    vi.restoreAllMocks();
    skew = 0;
    // Another budget refusing it is another record (its own period and reason).
    await deleteBudgets(fixture);
    await createBudget(fixture, { name: "Cron cap", scopeType: "workflow", scopeId: "wf-cron", limitType: "tokens", limitValue: 1, action: "block" });
    await seedRunUsage(store, { tokens: 5, workflowId: "wf-cron" });
    const at = new Date().toISOString();
    await fixture.context.schedule!({ workflowId: "wf-cron", workflowName: "cron", scheduleNodeId: "start", cronExpression: "* * * * *", timezone: "UTC", firedAt: at, scheduledFor: at });
    expect((await runs(store)).filter((run) => run.workflowId === "wf-cron")).toHaveLength(2);
  });

  it("refuses a gateway workflow tool whose own workflow budget is used up, as a JSON-RPC error", async () => {
    const fixture = await setup();
    await createBudget(fixture, { name: "Lookup cap", scopeType: "workflow", scopeId: "wf-lookup", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50, workflowId: "wf-lookup" });
    const call = toolCaller(fixture);
    expect((await call("lookup")).error).toMatchObject({ code: -32032, message: 'Budget "Lookup cap" exceeded for the current month.' });
    // Server tools and other workflows are not in that budget.
    expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call("ask", { text: "x" })).outcome).toBe("ok");
  });

  it("does not refuse runs a warn or another workflow's budget covers; refuses an MCP replay, whose model calls are live (D12)", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-hook", "webhook_input"));
    const recorded = await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-hook/execute", { input: {}, record: true });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const sourceId = recorded.json<{ executionId: string }>().executionId;
    await createBudget(fixture, { name: "Warn only", scopeType: "global", limitType: "tokens", limitValue: 1, action: "warn" });
    await createBudget(fixture, { name: "Other workflow", scopeType: "workflow", scopeId: "wf-other", limitType: "tokens", limitValue: 1, action: "block" });
    await seedRunUsage(store, { tokens: 50, workflowId: "wf-other" });
    expect((await fixture.context.app.inject({ method: "POST", url: "/webhook/hook-wf-hook", payload: {} })).statusCode).toBe(200);
    await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    expect((await fixture.context.app.inject({ method: "POST", url: "/webhook/hook-wf-hook", payload: {} })).statusCode).toBe(402);
    const replay = await caller(fixture.context)(fixture.admin, "POST", `/api/executions/${sourceId}/replay`, {});
    expect(replay.statusCode, replay.body).toBe(402);
    expect(replay.json()).toMatchObject({ error: "budget_exceeded" });
  });

  it("refuses a gateway call under a used-up global block budget", async () => {
    const fixture = await overGlobalBudget();
    expect((await toolCaller(fixture)("calculator", { expression: "1+1" })).error?.code).toBe(-32032);
  });
});

describe("per-client rate limits", () => {
  async function setLimit(fixture: Fixture, clientId: string, rateLimit: Record<string, unknown> | null) {
    const response = await caller(fixture.context)(fixture.admin, "PATCH", `/api/mcp/clients/${clientId}`, { rateLimit });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ client: McpClient }>().client;
  }

  it("refuses calls over the client's per-minute rate with retryLater, audited once a minute per session", async () => {
    const fixture = await setup();
    const updated = await setLimit(fixture, fixture.client.id, { requestsPerMinute: 2 });
    expect(updated.rateLimit).toEqual({ requestsPerMinute: 2, burst: null, maxConcurrent: null });
    const call = toolCaller(fixture);
    expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call("lookup")).outcome).toBe("ok");
    const refused = await call("calculator", { expression: "1+1" });
    expect(refused.error).toMatchObject({ code: -32029, data: { reason: "rate_limited" } });
    expect(refused.error!.message).toContain("2 calls per minute");
    expect(Number(refused.error!.data!.retryAfterMs)).toBeGreaterThan(0);
    expect((await call("lookup")).error?.code).toBe(-32029);
    const audits = await auditEvents(fixture.context.store, "mcp_gateway.rate_limited");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ clientId: fixture.client.id, reason: "rate_limited", limitSource: "client" });
    // The peer has no limit; removing the client's limit lifts it.
    expect((await toolCaller(fixture, "peer")("calculator", { expression: "1+1" })).outcome).toBe("ok");
    await setLimit(fixture, fixture.client.id, null);
    expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
  });

  it("allows a burst before the per-minute rate applies", async () => {
    const fixture = await setup();
    await setLimit(fixture, fixture.client.id, { requestsPerMinute: 1, burst: 3 });
    const call = toolCaller(fixture);
    for (let index = 0; index < 3; index += 1) expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await call("calculator", { expression: "1+1" })).error?.data?.reason).toBe("rate_limited");
  });

  it("caps calls in flight at once", async () => {
    const fixture = await setup();
    await setLimit(fixture, fixture.client.id, { maxConcurrent: 1 });
    let releaseSlow: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = MockMCPServerAdapter.prototype.invokeTool;
    vi.spyOn(MockMCPServerAdapter.prototype, "invokeTool").mockImplementation(async function (this: MockMCPServerAdapter, ...args: Parameters<MockMCPServerAdapter["invokeTool"]>) {
      if (args[0] === "calculator") {
        entered();
        await slow;
      }
      return await original.apply(this, args);
    });
    const session = await openSession(fixture.context, fixture.toolset.slug, fixture.token);
    const name = await toolName(fixture.context, fixture.toolset.slug, fixture.token, session, "calculator");
    const inFlight = callNamed(fixture.context, fixture.toolset.slug, fixture.token, session, name, { expression: "1+1" });
    await started;
    const second = await callNamed(fixture.context, fixture.toolset.slug, fixture.token, session, name, { expression: "2+2" });
    expect(second.error).toMatchObject({ code: -32029, data: { reason: "concurrency_limited" } });
    releaseSlow();
    expect((await inFlight).outcome).toBe("ok");
    // The slot is free again.
    expect((await callNamed(fixture.context, fixture.toolset.slug, fixture.token, session, name, { expression: "3+3" })).outcome).toBe("ok");
  });

  it("applies the toolset's default to each client that has no limit of its own; a client's own limit replaces it", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    const updated = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { rateLimit: { requestsPerMinute: 1 } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ toolset: McpToolset }>().toolset.rateLimit).toEqual({ requestsPerMinute: 1, burst: null, maxConcurrent: null });
    const audit = (await auditEvents(fixture.context.store, "mcp_toolset.updated")).at(0);
    expect(audit?.metadata).toMatchObject({ rateLimit: { requestsPerMinute: 1, burst: null, maxConcurrent: null }, previousRateLimit: null });
    await setLimit(fixture, fixture.peer.id, { requestsPerMinute: 5 });
    const client = toolCaller(fixture);
    const peer = toolCaller(fixture, "peer");
    expect((await client("calculator", { expression: "1+1" })).outcome).toBe("ok");
    expect((await client("calculator", { expression: "1+1" })).error).toMatchObject({ code: -32029 });
    for (let index = 0; index < 3; index += 1) expect((await peer("calculator", { expression: "1+1" })).outcome).toBe("ok");
    const audits = await auditEvents(fixture.context.store, "mcp_gateway.rate_limited");
    expect(audits[0]!.metadata).toMatchObject({ limitSource: "toolset" });
    // Only admins set it.
    const builder = await login(fixture.context, "builder");
    expect((await call(builder, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { rateLimit: null })).statusCode).toBe(403);
    expect((await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { rateLimit: { burst: 2 } })).statusCode).toBe(400);
  });
});

describe("the client update route", () => {
  it("lets only admins rename a client or set its rate limit, changes nothing else, and audits each change", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    const builder = await login(fixture.context, "builder");
    const url = `/api/mcp/clients/${fixture.client.id}`;
    expect((await call(builder, "PATCH", url, { name: "Hijacked" })).statusCode).toBe(403);
    expect((await call(null, "PATCH", url, { name: "Hijacked" })).statusCode).toBe(401);
    expect((await call(fixture.admin, "PATCH", url, { role: "admin" })).statusCode).toBe(400);
    expect((await call(fixture.admin, "PATCH", url, {})).statusCode).toBe(400);
    expect((await call(fixture.admin, "PATCH", url, { rateLimit: { requestsPerMinute: 0 } })).statusCode).toBe(400);
    expect((await call(fixture.admin, "PATCH", "/api/mcp/clients/missing", { name: "x" })).statusCode).toBe(404);
    const renamed = await call(fixture.admin, "PATCH", url, { name: "IDE agent (laptop)", rateLimit: { requestsPerMinute: 30, burst: 5, maxConcurrent: 2 } });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const client = renamed.json<{ client: McpClient & { status: string } }>().client;
    expect(client).toMatchObject({
      name: "IDE agent (laptop)",
      rateLimit: { requestsPerMinute: 30, burst: 5, maxConcurrent: 2 },
      role: fixture.client.role,
      toolsetIds: fixture.client.toolsetIds,
      tokenPrefix: fixture.client.tokenPrefix,
      expiresAt: fixture.client.expiresAt,
      status: "active"
    });
    // The token still works.
    expect((await toolCaller(fixture)("calculator", { expression: "1+1" })).outcome).toBe("ok");
    // An all-empty limit removes it.
    expect((await call(fixture.admin, "PATCH", url, { rateLimit: {} })).json<{ client: McpClient }>().client.rateLimit).toBeNull();
    const audits = await auditEvents(fixture.context.store, "mcp_client.updated");
    expect(audits).toHaveLength(2);
    expect(audits.map((entry) => entry.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fields: ["name", "rateLimit"], name: "IDE agent (laptop)", previousName: "IDE agent", rateLimit: { requestsPerMinute: 30, burst: 5, maxConcurrent: 2 }, previousRateLimit: null }),
        expect.objectContaining({ fields: ["rateLimit"], rateLimit: null, previousRateLimit: { requestsPerMinute: 30, burst: 5, maxConcurrent: 2 } })
      ])
    );
    // The listing shows the limit to builders.
    const listed = (await call(builder, "GET", "/api/mcp/clients")).json<{ clients: McpClient[] }>().clients.find((entry) => entry.id === fixture.client.id);
    expect(listed?.rateLimit).toBeNull();
  });

  it("refuses a client budget for a client that does not exist", async () => {
    const fixture = await setup();
    const response = await caller(fixture.context)(fixture.admin, "POST", "/api/budgets", { name: "x", scopeType: "mcp_client", scopeId: "nope", period: "day", limitType: "usd", limitValue: 1, action: "block" });
    expect(response.statusCode).toBe(400);
    expect((await caller(fixture.context)(fixture.admin, "POST", "/api/budgets", { name: "x", scopeType: "toolset", scopeId: "t", period: "day", limitType: "usd", limitValue: 1, action: "block" })).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Review fixes (M1-M5, L1-L9)
// ---------------------------------------------------------------------------

/** Polls until `check` returns a value (no fixed sleeps). */
async function until<T>(check: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A toolset of its own with one workflow tool and one client; calls the tool in one session. */
async function ownToolset(fixture: Fixture, workflow: Workflow, clientName = "Approval agent") {
  const call = caller(fixture.context);
  await fixture.context.store.upsertWorkflow(workflow);
  const made = await call(fixture.admin, "POST", "/api/mcp/toolsets", { name: `Tools ${workflow.id}`, projectId: "default", members: [{ kind: "workflow", workflowId: workflow.id }] });
  expect(made.statusCode, made.body).toBe(201);
  const toolset = made.json<{ toolset: McpToolset }>().toolset;
  const created = await call(fixture.admin, "POST", "/api/mcp/clients", { name: clientName, toolsetIds: [toolset.id], role: "builder" });
  expect(created.statusCode, created.body).toBe(201);
  const { client, token } = created.json<{ client: McpClient; token: string }>();
  const session = await openSession(fixture.context, toolset.slug, token);
  return {
    toolset,
    client,
    token,
    session,
    callTool: async (tool: string, args: Record<string, unknown> = {}) =>
      await callNamed(fixture.context, toolset.slug, token, session, await toolName(fixture.context, toolset.slug, token, session, tool), args)
  };
}

/** A workflow tool that waits for an admin's approval, then asks the echo model (the resumed part spends tokens). */
function approvalTool(id: string): Workflow {
  return {
    id,
    name: "Approve then ask",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      {
        id: "trigger",
        type: "mcp_server_trigger",
        name: "Trigger",
        position: { x: 0, y: 0 },
        config: { path: `${id}-path`, toolName: "approved_ask", inputSchema: { type: "object", properties: { text: { type: "string" } } }, authMode: "public" }
      },
      { id: "gate", type: "approval_gate", name: "Gate", position: { x: 200, y: 0 }, config: { message: "Go on?", approverRoles: ["admin"], timeoutMinutes: 60 } },
      { id: "model", type: "llm_call", name: "Model", position: { x: 400, y: 0 }, config: { provider: { providerId: "echo", model: "echo-1" }, userPromptTemplate: "Say {{text}} after the approval" } },
      { id: "out", type: "output", name: "Out", position: { x: 600, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "gate" },
      { id: "e2", source: "gate", sourceHandle: "approved", target: "model" },
      { id: "e3", source: "model", target: "out" }
    ]
  } as Workflow;
}

describe("review M1: a gateway run that waits on an approval stays the client's", () => {
  it("charges the resumed part to the client and the toolset's project, not to the approver, and keeps it across the pause", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    const own = await ownToolset(fixture, approvalTool("wf-approve-ask"));
    const budgetId = await createBudget(fixture, { name: "Approval agent cap", scopeType: "mcp_client", scopeId: own.client.id, limitType: "tokens", limitValue: 1_000_000, action: "warn" });
    const paused = await own.callTool("approved_ask", { text: "hello" });
    expect(paused.text).toContain("waiting for an approval");
    const [run] = (await store.listExecutionHistory({ workflowId: "wf-approve-ask", pageSize: 5 })).items;
    // The paused state and the run's custom data carry the client and toolset.
    const state = await store.getWorkflowExecutionState(run!.id);
    expect((state!.state as { gatewayUsage?: unknown }).gatewayUsage).toEqual({ clientId: own.client.id, clientName: own.client.name, toolsetId: own.toolset.id, toolsetProjectId: "default" });
    const before = (await clientBudgets(fixture, fixture.admin, own.client.id)).find((entry) => entry.budgetId === budgetId)!.current;
    const approved = await caller(fixture.context)(fixture.admin, "POST", `/api/approvals/${run!.id}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    const finished = await store.getExecutionHistory(run!.id);
    expect(finished?.status).toBe("success");
    expect(finished?.triggeredBy).toBe("admin@example.com");
    const rows = await testSql(store).all<{ client_id: string | null; toolset_id: string | null; user_id: string | null; user_email: string | null; total_tokens: number | string }>(
      "SELECT client_id, toolset_id, user_id, user_email, total_tokens FROM usage_events WHERE execution_id = ? AND trigger_type = ?",
      run!.id,
      "approval_resume"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client_id: own.client.id, toolset_id: own.toolset.id, user_id: `mcp-client:${own.client.name}`, user_email: null });
    const spent = Number(rows[0]!.total_tokens);
    expect(spent).toBeGreaterThan(0);
    const after = (await clientBudgets(fixture, fixture.admin, own.client.id)).find((entry) => entry.budgetId === budgetId)!.current;
    expect((after ?? 0) - (before ?? 0)).toBe(spent);
    // The approver's own usage is untouched.
    expect(await store.queryBudgetUsage({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), userKey: "admin@example.com" })).toEqual({ costUsd: 0, totalTokens: 0 });
    expect((finished!.customData as Record<string, unknown>).gatewayUsage).toMatchObject({ clientId: own.client.id });
  });

  it("a caller cannot charge its run to a gateway client through custom data", async () => {
    const fixture = await setup();
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-plain", "webhook_input"));
    const planted = { clientId: fixture.client.id, clientName: fixture.client.name, toolsetId: fixture.toolset.id, toolsetProjectId: "default" };
    const response = await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-plain/execute", { input: {}, customData: { gatewayUsage: planted, note: "kept" } });
    expect(response.statusCode, response.body).toBe(200);
    const executionId = response.json<{ executionId: string }>().executionId;
    const history = await store.getExecutionHistory(executionId);
    expect(history?.customData).toEqual({ note: "kept" });
    const row = await testSql(store).get<{ client_id: string | null }>("SELECT client_id FROM usage_events WHERE execution_id = ?", executionId);
    expect(row?.client_id ?? null).toBeNull();
  });
});

describe("review M2 / D13: refused app triggers", () => {
  function rssWorkflow(id: string): Workflow {
    return {
      id,
      name: "Feed",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "feed", type: "rss_trigger", name: "Feed", position: { x: 0, y: 0 }, config: { feedUrl: "https://feeds.example.com/rss", pollIntervalSeconds: 3600 } },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { outputKey: "result", responseTemplate: "ran" } }
      ],
      edges: [{ id: "e1", source: "feed", target: "out" }]
    } as Workflow;
  }

  it("N-L2: a refusal on a long feed with a large maxItemsPerTick keeps the earlier seen list, so nothing is lost", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `item-${index}`);
    const feed = `<rss><channel>${ids.map((id) => `<item><guid>${id}</guid><title>${id}</title></item>`).join("")}</channel></rss>`;
    const fetchImpl = vi.fn(async () => new Response(feed, { status: 200, headers: { "content-type": "application/rss+xml" } })) as unknown as typeof fetch;
    let triggers: TriggerService | undefined;
    const fixture = await setup({}, "default", {
      triggerService: (store) => (triggers = new TriggerService(store, () => undefined, fetchImpl))
    });
    const { store } = fixture.context;
    triggers!.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => ["93.184.216.34"]);
    const workflow = rssWorkflow("wf-long-feed");
    const node = { ...workflow.nodes[0]!, config: { ...(workflow.nodes[0]!.config as object), maxItemsPerTick: 100 } };
    await store.upsertWorkflow(workflow);
    await store.saveTriggerState({ workflowId: workflow.id, nodeId: "feed", triggerType: "rss_trigger", state: { seen: ["item-0"] } });
    await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(store, { tokens: 50 });
    const stop = (triggers as unknown as { startRssTrigger: (wf: Workflow, n: typeof node) => () => void }).startRssTrigger(workflow, node);
    await until(async () => (await runs(store)).find((entry) => entry.workflowId === workflow.id && entry.status === "error"), "the refused run");
    stop();
    const seen = ((await store.getTriggerState(workflow.id, "feed")) as { seen?: string[] }).seen;
    expect(seen).toEqual(["item-0"]);
  });

  it("keeps an RSS item a budget refused unseen, records one failed run, and delivers it once the budget allows", async () => {
    const feed = `<rss><channel><item><guid>item-1</guid><title>One</title><link>https://feeds.example.com/1</link></item><item><guid>item-0</guid><title>Zero</title></item></channel></rss>`;
    const fetchImpl = vi.fn(async () => new Response(feed, { status: 200, headers: { "content-type": "application/rss+xml" } })) as unknown as typeof fetch;
    let triggers: TriggerService | undefined;
    const fixture = await setup({}, "default", {
      triggerService: (store) => (triggers = new TriggerService(store, () => undefined, fetchImpl))
    });
    const { store } = fixture.context;
    triggers!.setOutboundGuard(DEFAULT_OUTBOUND_GUARD, async () => ["93.184.216.34"]);
    const workflow = rssWorkflow("wf-feed");
    await store.upsertWorkflow(workflow);
    // The feed was polled before: item-0 is known, item-1 is new.
    await store.saveTriggerState({ workflowId: workflow.id, nodeId: "feed", triggerType: "rss_trigger", state: { seen: ["item-0"] } });
    await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(store, { tokens: 50 });
    const start = () => (triggers as unknown as { startRssTrigger: (wf: Workflow, node: Workflow["nodes"][number]) => () => void }).startRssTrigger(workflow, workflow.nodes[0]!);
    const feedRuns = async () => (await runs(store)).filter((entry) => entry.workflowId === workflow.id);

    const firstPoll = start();
    const refused = await until(async () => (await feedRuns()).find((entry) => entry.status === "error"), "the refused run");
    expect(refused.triggerType).toBe("rss");
    expect((await store.getExecutionHistory(refused.id))?.error).toBe('Budget "Deployment cap" exceeded for the current month. The run did not start.');
    await until(async () => {
      const seen = ((await store.getTriggerState(workflow.id, "feed")) as { seen?: string[] } | null)?.seen ?? [];
      return seen.includes("item-0") && !seen.includes("item-1");
    }, "the refused item to stay unseen");
    firstPoll();
    // A second poll under the same budget: still one failed run, its counter bumped.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
    const secondPoll = start();
    await until(async () => ((await store.getExecutionHistory(refused.id))?.output as { refusedFires?: number } | undefined)?.refusedFires === 2, "the second refusal to be counted");
    secondPoll();
    expect(await feedRuns()).toHaveLength(1);
    vi.mocked(Date.now).mockRestore();

    await deleteBudgets(fixture);
    const thirdPoll = start();
    const delivered = await until(async () => (await feedRuns()).find((entry) => entry.status === "success"), "the item to be delivered");
    thirdPoll();
    expect(JSON.stringify((await store.getExecutionHistory(delivered.id))?.input)).toContain("item-1");
    const seen = ((await store.getTriggerState(workflow.id, "feed")) as { seen?: string[] }).seen;
    expect(seen).toEqual(expect.arrayContaining(["item-0", "item-1"]));
  });
});

describe("review M3: the client's Governance lists every budget that applies", () => {
  it("returns the client's own, its toolsets' project and the deployment's budgets, labelled, and marks the refusing one", async () => {
    const fixture = await setup();
    const builder = await login(fixture.context, "builder");
    const own = await createBudget(fixture, { name: "IDE cap", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 1_000, action: "block" });
    const project = await createBudget(fixture, { name: "Team cap", scopeType: "project", scopeId: "default", limitType: "tokens", limitValue: 1_000, action: "warn" });
    const global = await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    // Not this client's: another client's budget and another project's.
    await createBudget(fixture, { name: "Peer cap", scopeType: "mcp_client", scopeId: fixture.peer.id, limitType: "tokens", limitValue: 1, action: "block" });
    await createBudget(fixture, { name: "Elsewhere", scopeType: "project", scopeId: "proj-none", limitType: "tokens", limitValue: 1, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50, projectId: "elsewhere-project" });
    const projectName = (await fixture.context.store.getProject("default"))!.name;
    const listed = await clientBudgets(fixture, builder, fixture.client.id);
    expect(listed.map((entry) => [entry.budgetId, entry.scopeLabel, entry.refusing])).toEqual([
      [own, "This client", false],
      [project, `Project ${projectName}`, false],
      [global, "Deployment", true]
    ]);
    // The refusing one is what the client's calls get.
    expect((await toolCaller(fixture)("calculator", { expression: "1+1" })).error).toMatchObject({ code: -32032, data: { budgetId: global } });
  });

  it("N-M1: a builder sees no amounts of the deployment's budget and no project they cannot read; an admin sees all", async () => {
    const fixture = await setup({ PROJECT_ISOLATION: "strict" });
    const builder = await login(fixture.context, "builder");
    const own = await createBudget(fixture, { name: "IDE cap", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 1_000, action: "block" });
    const project = await createBudget(fixture, { name: "Team cap", scopeType: "project", scopeId: "default", limitType: "tokens", limitValue: 1_000, action: "warn" });
    const global = await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50, projectId: "elsewhere-project" });

    const asAdmin = await clientBudgets(fixture, fixture.admin, fixture.client.id);
    expect(asAdmin.map((entry) => entry.budgetId)).toEqual([own, project, global]);
    expect(asAdmin.find((entry) => entry.budgetId === global)).toMatchObject({ limitValue: 10, current: 50, refusing: true });

    // A builder outside the project (strict isolation): their own client's budget and the deployment's, without amounts.
    const outside = await clientBudgets(fixture, builder, fixture.client.id);
    expect(outside.map((entry) => entry.budgetId)).toEqual([own, global]);
    const hidden = outside.find((entry) => entry.budgetId === global)!;
    expect(hidden).toMatchObject({ name: "Deployment cap", scopeLabel: "Deployment", action: "block", refusing: true });
    expect(hidden).not.toHaveProperty("limitValue");
    expect(hidden).not.toHaveProperty("current");
    expect(JSON.stringify(outside)).not.toContain("Team cap");

    // A member of the project sees that project's budget with its amounts, the deployment's still without.
    const builderUser = (await fixture.context.store.getUserByEmail("builder@example.com"))!;
    await fixture.context.store.upsertProjectRole({ userId: builderUser.id, projectId: "default", role: "viewer", customRoleId: null });
    const member = await clientBudgets(fixture, builder, fixture.client.id);
    expect(member.map((entry) => entry.budgetId)).toEqual([own, project, global]);
    expect(member.find((entry) => entry.budgetId === project)).toMatchObject({ limitValue: 1_000 });
    expect(member.find((entry) => entry.budgetId === global)).not.toHaveProperty("limitValue");
  });
});

describe("review M4 / D12: replays with live calls are budget-checked", () => {
  function askHook(id: string): Workflow {
    return {
      id,
      name: "Ask hook",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
        { id: "model", type: "llm_call", name: "Model", position: { x: 200, y: 0 }, config: { provider: { providerId: "echo", model: "echo-1" }, userPromptTemplate: "Say hi" } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "hook", target: "model" },
        { id: "e2", source: "model", target: "out" }
      ]
    } as Workflow;
  }

  async function job(fixture: Fixture, body: Record<string, unknown>) {
    const call = caller(fixture.context);
    const started = await call(fixture.admin, "POST", "/api/replay/runs", body);
    expect(started.statusCode, started.body).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    return await until(async () => {
      const view = (await call(fixture.admin, "GET", `/api/replay/runs/${runId}`)).json<{ run: { status: string; summary: { total: number; pass: number }; results: Array<{ id: string; status: string }> } }>().run;
      return ["queued", "running"].includes(view.status) ? null : view;
    }, "the replay job", 30_000);
  }

  it("refuses a golden-run replay with live models (402) and a live job case, and lets a tape-only job run", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    await fixture.context.store.upsertWorkflow(askHook("wf-golden-ask"));
    const recorded = await call(fixture.admin, "POST", "/api/workflows/wf-golden-ask/execute", { input: {}, record: true });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const saved = await call(fixture.admin, "POST", "/api/replay/recordings", { executionId: recorded.json<{ executionId: string }>().executionId, name: "Golden" });
    expect(saved.statusCode, saved.body).toBe(201);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    const set = (await call(fixture.admin, "POST", "/api/eval/datasets", { name: "Suite", workflowId: "wf-golden-ask" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(fixture.admin, "POST", `/api/eval/datasets/${set}/recordings`, { recordingId })).statusCode).toBe(201);
    // Under the cap everything runs.
    expect((await call(fixture.admin, "POST", `/api/replay/recordings/${recordingId}/replay`, {})).statusCode).toBe(200);
    const budgetId = await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50 });

    const live = await call(fixture.admin, "POST", `/api/replay/recordings/${recordingId}/replay`, {});
    expect(live.statusCode, live.body).toBe(402);
    expect(live.json()).toMatchObject({ error: "budget_exceeded", budgetId });
    const liveJob = await job(fixture, { datasetIds: [set], models: "live" });
    expect(liveJob.summary.pass).toBe(0);
    // Model calls from the golden run's tape, MCP strict: no live call, so not refused.
    const tapeJob = await job(fixture, { datasetIds: [set], models: "replay" });
    expect(tapeJob.summary).toMatchObject({ total: 1, pass: 1 });
  }, 60_000);
});

describe("review M5: paths the first round left untested", () => {
  async function overGlobal(fixture: Fixture) {
    const budgetId = await createBudget(fixture, { name: "Deployment cap", scopeType: "global", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(fixture.context.store, { tokens: 50 });
    return budgetId;
  }

  it("refuses POST /enqueue under a used-up budget, also when the body names an exempt trigger type", async () => {
    const fixture = await setup({}, "default", { queue: true });
    const { store } = fixture.context;
    await store.upsertWorkflow(triggerWorkflow("wf-queued", "webhook_input"));
    await overGlobal(fixture);
    for (const body of [{}, { triggerType: "replay" }, { triggerType: "eval" }]) {
      const response = await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-queued/enqueue", body);
      expect(response.statusCode, response.body).toBe(402);
      expect(response.json()).toMatchObject({ error: "budget_exceeded" });
    }
    expect((await runs(store)).filter((entry) => entry.workflowId === "wf-queued")).toHaveLength(0);
    await deleteBudgets(fixture);
    expect((await caller(fixture.context)(fixture.admin, "POST", "/api/workflows/wf-queued/enqueue", { triggerType: "replay" })).statusCode).toBeLessThan(300);
  });

  it("does not use up a webhook's idempotency key on a refusal, and audits the refusal once per period (L7)", async () => {
    const fixture = await setup();
    const { store, app } = fixture.context;
    const workflow = triggerWorkflow("wf-idem", "webhook_input");
    workflow.nodes[0]!.config = { path: "hook-idem", method: "POST", authMode: "none", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" };
    await store.upsertWorkflow(workflow);
    const budgetId = await overGlobal(fixture);
    const send = () => app.inject({ method: "POST", url: "/webhook/hook-idem", headers: { "idempotency-key": "key-1" }, payload: { a: 1 } });
    expect((await send()).statusCode).toBe(402);
    expect((await send()).statusCode).toBe(402);
    const audits = await until(async () => {
      const found = await auditEvents(store, "budget.run_refused");
      return found.length > 0 ? found : null;
    }, "the refusal audit");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ resourceType: "workflow", resourceId: "wf-idem", outcome: "denied" });
    expect(audits[0]!.metadata).toMatchObject({ triggerType: "webhook", budgetId });
    await deleteBudgets(fixture);
    const accepted = await send();
    expect(accepted.statusCode, accepted.body).toBe(200);
    // And the key now holds that result.
    expect((await send()).statusCode).toBe(200);
    expect((await runs(store)).filter((entry) => entry.workflowId === "wf-idem")).toHaveLength(1);
  });

  it("answers 503 to a trigger and a tool error to a gateway call when the budgets were never readable, without the store's text", async () => {
    const fixture = await setup({}, "default", {
      beforeApp: (store) => {
        vi.spyOn(store, "listBudgets").mockRejectedValue(new Error("connection refused at 10.0.0.9"));
      }
    });
    await fixture.context.store.upsertWorkflow(triggerWorkflow("wf-down", "webhook_input"));
    const refused = await fixture.context.app.inject({ method: "POST", url: "/webhook/hook-wf-down", payload: {} });
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["retry-after"]).toBe("5");
    expect(refused.json()).toEqual({ error: "Budgets could not be checked; try again shortly." });
    for (const tool of ["calculator", "lookup"]) {
      const answer = await toolCaller(fixture)(tool, tool === "calculator" ? { expression: "1+1" } : {});
      expect(answer).toMatchObject({ outcome: "tool_error", text: "Budgets could not be checked for this call, so it was not sent. Try again." });
    }
    expect((await runs(fixture.context.store)).filter((entry) => entry.workflowId === "wf-down")).toHaveLength(0);
  });

  describe("a call's concurrency slot is given back", () => {
    async function oneAtOnce(fixture: Fixture) {
      const response = await caller(fixture.context)(fixture.admin, "PATCH", `/api/mcp/clients/${fixture.client.id}`, { rateLimit: { maxConcurrent: 1 } });
      expect(response.statusCode, response.body).toBe(200);
    }

    /** Holds every calculator call until released; `entered` resolves when one is inside the server. */
    function holdCalculator() {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => undefined;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = MockMCPServerAdapter.prototype.invokeTool;
      vi.spyOn(MockMCPServerAdapter.prototype, "invokeTool").mockImplementation(async function (this: MockMCPServerAdapter, ...args: Parameters<MockMCPServerAdapter["invokeTool"]>) {
        if (args[0] === "calculator") {
          entered();
          await held;
        }
        return await original.apply(this, args);
      });
      return { release, inside };
    }

    it("when the call fails", async () => {
      const fixture = await setup();
      await oneAtOnce(fixture);
      const spy = vi.spyOn(MockMCPServerAdapter.prototype, "invokeTool").mockRejectedValueOnce(new Error("server crashed"));
      const call = toolCaller(fixture);
      expect((await call("calculator", { expression: "1+1" })).outcome).toBe("tool_error");
      spy.mockRestore();
      expect((await call("calculator", { expression: "1+1" })).outcome).toBe("ok");
    });

    it("when the client cancels the call", async () => {
      const fixture = await setup();
      await oneAtOnce(fixture);
      const { release, inside } = holdCalculator();
      const { context, toolset, token } = fixture;
      const session = await openSession(context, toolset.slug, token);
      const name = await toolName(context, toolset.slug, token, session, "calculator");
      const pending = rpc(context, toolset.slug, token, { jsonrpc: "2.0", id: "slow-1", method: "tools/call", params: { name, arguments: { expression: "1+1" } } }, { "mcp-session-id": session });
      await inside;
      expect((await callNamed(context, toolset.slug, token, session, name, { expression: "2+2" })).error?.data?.reason).toBe("concurrency_limited");
      await rpc(context, toolset.slug, token, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "slow-1", reason: "user stopped" } }, { "mcp-session-id": session });
      await pending;
      // The cancelled call no longer holds the slot, though the server has not answered it.
      const lookup = await callNamed(context, toolset.slug, token, session, await toolName(context, toolset.slug, token, session, "lookup"));
      expect(lookup.outcome).toBe("ok");
      release();
    });

    it("when the session ends mid-call", async () => {
      const fixture = await setup();
      await oneAtOnce(fixture);
      const { release, inside } = holdCalculator();
      const { context, toolset, token } = fixture;
      const session = await openSession(context, toolset.slug, token);
      const name = await toolName(context, toolset.slug, token, session, "calculator");
      const pending = rpc(context, toolset.slug, token, { jsonrpc: "2.0", id: "slow-2", method: "tools/call", params: { name, arguments: { expression: "1+1" } } }, { "mcp-session-id": session });
      await inside;
      const ended = await context.app.inject({ method: "DELETE", url: `/mcp/${toolset.slug}`, headers: { authorization: `Bearer ${token}`, "mcp-session-id": session } });
      expect(ended.statusCode).toBeLessThan(300);
      await pending;
      const next = await openSession(context, toolset.slug, token);
      const lookup = await callNamed(context, toolset.slug, token, next, await toolName(context, toolset.slug, token, next, "lookup"));
      expect(lookup.outcome).toBe("ok");
      release();
    });
  });

  it("counts a client's pre-v54 runs by its current name from its creation on: a rename drops them, a later client of that name does not inherit them (L3)", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    const { store } = fixture.context;
    const own = await createBudget(fixture, { name: "IDE cap", scopeType: "mcp_client", scopeId: fixture.client.id, limitType: "tokens", limitValue: 1_000, action: "warn" });
    await seedRunUsage(store, { tokens: 80, userId: `mcp-client:${fixture.client.name}` });
    await testSql(store).run("UPDATE usage_events SET created_at = ? WHERE user_id = ?", fixture.client.createdAt, `mcp-client:${fixture.client.name}`);
    const current = async (clientId: string, budgetId: string) => (await clientBudgets(fixture, fixture.admin, clientId)).find((entry) => entry.budgetId === budgetId)!.current;
    expect(await current(fixture.client.id, own)).toBe(80);
    const oldName = fixture.client.name;
    expect((await call(fixture.admin, "PATCH", `/api/mcp/clients/${fixture.client.id}`, { name: "IDE agent (renamed)" })).statusCode).toBe(200);
    expect(await current(fixture.client.id, own)).toBe(0);
    // A client made later under the old name: the older rows are not its.
    const later = await call(fixture.admin, "POST", "/api/mcp/clients", { name: oldName, toolsetIds: [fixture.toolset.id], role: "builder" });
    expect(later.statusCode, later.body).toBe(201);
    const laterClient = later.json<{ client: McpClient }>().client;
    const laterBudget = await createBudget(fixture, { name: "Later cap", scopeType: "mcp_client", scopeId: laterClient.id, limitType: "tokens", limitValue: 1_000, action: "warn" });
    expect(await current(laterClient.id, laterBudget)).toBe(0);
  });
});

describe("review L4: a gateway workflow tool's budgets are checked once, at the gateway", () => {
  it("refuses a workflow tool under its workflow project's used-up budget before the call, and reads a matching budget once per call", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    const { store } = fixture.context;
    expect((await call(fixture.admin, "POST", "/api/projects", { id: "proj-wf", name: "Workflows" })).statusCode).toBeLessThan(300);
    await store.upsertWorkflow(lookupTool("wf-lookup", "proj-wf"));
    // A matching block budget with room left: one usage read at the gateway, one for the run's alerts.
    await createBudget(fixture, { name: "Roomy", scopeType: "global", limitType: "tokens", limitValue: 1_000_000, action: "block" });
    const usage = vi.spyOn(store, "queryBudgetUsage");
    const tools = toolCaller(fixture);
    expect((await tools("lookup")).outcome).toBe("ok");
    expect(usage).toHaveBeenCalledTimes(2);
    usage.mockClear();
    await createBudget(fixture, { name: "Workflow project", scopeType: "project", scopeId: "proj-wf", limitType: "tokens", limitValue: 10, action: "block" });
    await seedRunUsage(store, { tokens: 50, projectId: "proj-wf" });
    const runsBefore = (await runs(store)).length;
    expect((await tools("lookup")).error).toMatchObject({ code: -32032, message: 'Budget "Workflow project" exceeded for the current month.' });
    expect((await runs(store)).length).toBe(runsBefore);
    // The toolset's server tools are not in that project.
    expect((await tools("calculator", { expression: "1+1" })).outcome).toBe("ok");
  });
});
