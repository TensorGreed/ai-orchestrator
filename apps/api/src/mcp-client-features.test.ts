/**
 * Phase 10.5 — MCP resources, prompts, elicitation and sampling over the API:
 * the probe's catalog capture and re-probe on list_changed, the resource and
 * prompt endpoints with policy kinds and RBAC, elicitation pause and answer
 * on the run stream with audit events, unattended auto-decline, the
 * elicitation service's timeouts, sampling settings on servers, telemetry
 * attribution of sampling tokens, and migration 25.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDefaultMCPRegistry } from "@ai-orchestrator/mcp-sdk";
import type { McpElicitationView, McpToolPolicyRule, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { McpElicitationService } from "./services/mcp-elicitation-service.js";
import { McpProbeService } from "./services/mcp-probe-service.js";
import { extractMcpToolCalls, rollupMcpToolCalls } from "./services/mcp-tool-telemetry.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-features-"));
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
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
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
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function registerMockServer(context: TestContext, adminCookie: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(context, "POST", "/api/mcp/servers", adminCookie, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false, ...extra });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ server: { id: string } }>().server.id;
  const probe = await call(context, "POST", `/api/mcp/servers/${id}/probe`, adminCookie);
  expect(probe.statusCode).toBe(200);
  return id;
}

async function createRule(context: TestContext, adminCookie: string, payload: Record<string, unknown>) {
  const response = await call(context, "POST", "/api/mcp/policies", adminCookie, payload);
  expect(response.statusCode).toBe(201);
  return response.json<{ rule: McpToolPolicyRule }>().rule;
}

/** Webhook → MCP Tool node calling `toolName` on the registry server → output. */
function directWorkflow(id: string, registryServerId: string, config: Record<string, unknown>): Workflow {
  return {
    id,
    name: `Direct ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "tool", type: "mcp_tool", name: "Tool", position: { x: 200, y: 0 }, config: { registryServerId, retry: { enabled: false }, ...config } },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "tool" },
      { id: "e2", source: "tool", target: "output" }
    ]
  };
}

function sseFrames(body: string, event: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes(`event: ${event}`))
    .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as Record<string, unknown>);
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------

describe("migration 25", () => {
  it("adds the catalog and elicitation tables and the sampling columns, with a rollback", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 25);
    expect(migration).toBeDefined();
    expect(Math.max(...MIGRATIONS.map((entry) => entry.version))).toBeGreaterThanOrEqual(25);
    for (const fragment of [
      "mcp_server_catalogs",
      "mcp_elicitations",
      "ALTER TABLE mcp_tool_policies ADD COLUMN IF NOT EXISTS kind",
      "ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS sampling_json",
      "sampling_input_tokens",
      "sampling_output_tokens",
      "sampling_requests"
    ]) {
      expect(migration!.up).toContain(fragment);
    }
    expect(migration!.down).toContain("DROP TABLE IF EXISTS mcp_elicitations");
    expect(migration!.down).toContain("DROP COLUMN IF EXISTS kind");
  });

  it("round-trips catalogs, elicitations, sampling settings and policy kinds through the SQLite store", async () => {
    const context = await createTestContext();
    const { store } = context;
    store.createMcpServer({ id: "mcp_a", name: "A", adapterId: "mock-mcp", sampling: { allow: true, maxTokens: 50, allowedModels: ["x"], maxRequestsPerCall: 2, defaultModel: { providerId: "openai", model: "gpt-4o-mini" } } });
    expect(store.getMcpServer("mcp_a")!.sampling).toEqual({ allow: true, maxTokens: 50, allowedModels: ["x"], maxRequestsPerCall: 2, defaultModel: { providerId: "openai", model: "gpt-4o-mini" } });
    store.updateMcpServer("mcp_a", { sampling: null });
    expect(store.getMcpServer("mcp_a")!.sampling).toMatchObject({ allow: false, allowedModels: [], defaultModel: null });

    expect(store.getMcpServerCatalog("mcp_a")).toBeNull();
    const catalog = store.upsertMcpServerCatalog("mcp_a", {
      capabilities: { resources: { listChanged: true }, prompts: {} },
      resources: [{ uri: "a://1", name: "one" }],
      resourceTemplates: [{ uriTemplate: "a://{id}", name: "by id" }],
      prompts: [{ name: "p", arguments: [{ name: "x", required: true }] }]
    });
    expect(catalog).toMatchObject({ serverId: "mcp_a", resources: [{ uri: "a://1" }], prompts: [{ name: "p" }] });
    store.upsertMcpServerCatalog("mcp_a", { capabilities: {}, resources: [], resourceTemplates: [], prompts: [] });
    expect(store.getMcpServerCatalog("mcp_a")!.resources).toEqual([]);

    const rule = store.createMcpToolPolicy({ id: "r1", name: "r", description: null, effect: "deny", projectId: null, roles: [], serverId: null, toolPattern: "mock://*", kind: "resource", enabled: true, createdBy: null });
    expect(rule.kind).toBe("resource");
    expect(store.updateMcpToolPolicy("r1", { kind: "prompt" })!.kind).toBe("prompt");
    expect(store.createMcpToolPolicy({ id: "r2", name: null, description: null, effect: "deny", projectId: null, roles: [], serverId: null, toolPattern: "*", enabled: true, createdBy: null }).kind).toBe("tool");

    const record = store.createMcpElicitation({
      id: "elc_1", executionId: "exec_1", workflowId: "wf", workflowName: "WF", nodeId: "agent", serverId: "mock-mcp", registryServerId: "mcp_a", serverName: "A",
      toolName: "ask_user", message: "Which?", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(), createdBy: "u1", triggerType: "manual_stream"
    });
    expect(record).toMatchObject({ status: "pending", createdBy: "u1", serverName: "A", requestedSchema: { required: ["answer"] } });
    expect(store.listMcpElicitations({ status: "pending" })).toHaveLength(1);
    expect(store.settleMcpElicitation("elc_1", { status: "accepted", answeredBy: "u1@example.com" })).toBe(true);
    expect(store.settleMcpElicitation("elc_1", { status: "declined" })).toBe(false);
    expect(store.getMcpElicitation("elc_1")).toMatchObject({ status: "accepted", answeredBy: "u1@example.com" });
    expect(store.listMcpElicitations({ status: "pending" })).toHaveLength(0);
    expect(store.listMcpElicitations({ executionId: "exec_1" })).toHaveLength(1);

    store.insertMcpToolCall({ id: "mtc_1", executionId: "x", workflowId: "wf", nodeId: "n", registryServerId: "mcp_a", adapterId: "mock-mcp", toolName: "t", startedAt: new Date().toISOString(), durationMs: 1, ok: true, error: null, turnInputTokens: null, turnOutputTokens: null, estimatedCostUsd: null, samplingRequests: 2, samplingInputTokens: 30, samplingOutputTokens: 7 });
    expect(store.listMcpToolCalls({ registryServerId: "mcp_a", since: "1970-01-01T00:00:00.000Z" })).toContainEqual(expect.objectContaining({ samplingRequests: 2, samplingInputTokens: 30, samplingOutputTokens: 7 }));
    store.deleteMcpServer("mcp_a");
    expect(store.getMcpServerCatalog("mcp_a")).toBeNull();
  });
});

describe("probe catalog capture and list_changed", () => {
  it("stores resources, templates and prompts the server advertises, and serves them with policy marks", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const serverId = await registerMockServer(context, admin.cookie);
    const stored = context.store.getMcpServerCatalog(serverId);
    expect(stored).toMatchObject({ capabilities: { resources: { listChanged: false }, prompts: { listChanged: false }, tools: { listChanged: false } } });
    expect(stored!.resources.map((entry) => entry.uri)).toEqual(["mock://docs/readme", "mock://kb/index.json", "mock://images/dot.png"]);
    expect(stored!.resourceTemplates.map((entry) => entry.uriTemplate)).toEqual(["mock://kb/{topic}"]);
    expect(stored!.prompts.map((entry) => entry.name)).toEqual(["explain_topic"]);
    // The tool snapshot is unchanged by the catalog.
    expect(context.store.getMcpToolSnapshot(context.store.getMcpServer(serverId)!.currentSnapshotId!)!.tools.map((tool) => tool.name)).not.toContain("readme");

    await createRule(context, admin.cookie, { name: "No KB for builders", effect: "deny", roles: ["builder"], kind: "resource", toolPattern: "mock://kb/*" });
    await createRule(context, admin.cookie, { name: "No explain", effect: "deny", roles: ["builder"], kind: "prompt", toolPattern: "explain_*" });

    const resources = await call(context, "GET", `/api/mcp/servers/${serverId}/resources`, builder.cookie);
    expect(resources.statusCode).toBe(200);
    const resourceBody = resources.json<{ resources: Array<{ uri: string; access: { allowed: boolean; ruleName?: string } }>; resourceTemplates: Array<{ uriTemplate: string; access: { allowed: boolean } }>; updatedAt: string }>();
    expect(resourceBody.resources.find((entry) => entry.uri === "mock://kb/index.json")!.access).toMatchObject({ allowed: false, ruleName: "No KB for builders" });
    expect(resourceBody.resources.find((entry) => entry.uri === "mock://docs/readme")!.access).toEqual({ allowed: true });
    expect(resourceBody.resourceTemplates[0].access.allowed).toBe(false);
    expect(resourceBody.updatedAt).toBeTruthy();

    const prompts = await call(context, "GET", `/api/mcp/servers/${serverId}/prompts`, builder.cookie);
    expect(prompts.json<{ prompts: Array<{ name: string; access: { allowed: boolean } }> }>().prompts[0]).toMatchObject({ name: "explain_topic", access: { allowed: false } });
    expect((await call(context, "GET", `/api/mcp/servers/${serverId}/prompts`, admin.cookie)).json<{ prompts: Array<{ access: { allowed: boolean } }> }>().prompts[0].access.allowed).toBe(true);

    // Live refresh re-lists and rewrites the catalog.
    context.store.upsertMcpServerCatalog(serverId, { capabilities: {}, resources: [], resourceTemplates: [], prompts: [] });
    expect((await call(context, "GET", `/api/mcp/servers/${serverId}/resources?refresh=true`, admin.cookie)).json<{ resources: unknown[] }>().resources).toHaveLength(3);
    expect(context.store.getMcpServerCatalog(serverId)!.prompts).toHaveLength(1);

    // RBAC: builders and above read catalogs.
    for (const url of [`/api/mcp/servers/${serverId}/resources`, `/api/mcp/servers/${serverId}/prompts`]) {
      expect((await call(context, "GET", url, viewer.cookie)).statusCode).toBe(403);
    }
    expect((await call(context, "GET", `/api/mcp/servers/nope/resources`, admin.cookie)).statusCode).toBe(404);
  });

  it("re-probes once after a burst of list_changed notifications", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin.cookie);
    const before = context.store.listMcpServerProbes(serverId, 10).length;
    const service = new McpProbeService(
      context.store,
      createDefaultMCPRegistry(),
      { resolveSecret: async () => undefined, isLeader: () => true },
      { defaultIntervalMs: 0, listChangedDelayMs: 30 }
    );
    for (const kind of ["tools", "resources", "prompts"] as const) {
      service.onListChanged({ kind, serverId: "mock-mcp", registryServerId: serverId, at: new Date().toISOString() });
    }
    expect(service.pendingReprobes()).toEqual([serverId]);
    // Unknown servers and events without a registry id are ignored.
    service.onListChanged({ kind: "tools", serverId: "mock-mcp", at: new Date().toISOString() });
    service.onListChanged({ kind: "tools", serverId: "mock-mcp", registryServerId: "mcp_missing", at: new Date().toISOString() });
    await waitFor(() => (context.store.listMcpServerProbes(serverId, 10).length === before + 1 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(context.store.listMcpServerProbes(serverId, 10)).toHaveLength(before + 1);
    expect(service.pendingReprobes()).toEqual([]);
    service.stop();
  });
});

describe("resource read and prompt get endpoints", () => {
  it("reads text and blob resources, renders prompts, and enforces policy kinds and RBAC", async () => {
    const context = await createTestContext({ MCP_RESOURCE_MAX_BYTES: "4096" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const serverId = await registerMockServer(context, admin.cookie);

    const text = await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, { uri: "mock://docs/readme" });
    expect(text.statusCode).toBe(200);
    expect(text.json<{ contents: Array<{ mimeType: string; text: string }>; bytes: number }>()).toMatchObject({ uri: "mock://docs/readme", contents: [{ mimeType: "text/markdown", text: expect.stringContaining("# Mock MCP server") }] });
    const blob = await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, { uri: "mock://images/dot.png" });
    expect(blob.json<{ contents: Array<{ blob: string; mimeType: string }> }>().contents[0]).toMatchObject({ mimeType: "image/png", blob: expect.stringMatching(/^iVBOR/) });
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, { uri: "mock://missing" })).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, {})).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, viewer.cookie, { uri: "mock://docs/readme" })).statusCode).toBe(403);

    await createRule(context, admin.cookie, { name: "No KB", effect: "deny", roles: ["builder"], kind: "resource", toolPattern: "mock://kb/*" });
    const denied = await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, { uri: "mock://kb/index.json" });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: string; policy: { ruleName: string } }>()).toMatchObject({ error: expect.stringContaining("MCP resource 'mock://kb/index.json'"), policy: { ruleName: "No KB" } });
    // Tool rules do not govern resources, and admins are not in the rule's roles.
    await createRule(context, admin.cookie, { name: "All tools", effect: "deny", roles: ["builder"], toolPattern: "*" });
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, builder.cookie, { uri: "mock://docs/readme" })).statusCode).toBe(200);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/resources/read`, admin.cookie, { uri: "mock://kb/index.json" })).statusCode).toBe(200);

    const prompt = await call(context, "POST", `/api/mcp/servers/${serverId}/prompts/get`, builder.cookie, { name: "explain_topic", arguments: { topic: "rag", audience: "ops" } });
    expect(prompt.statusCode).toBe(200);
    expect(prompt.json<{ prompt: { messages: Array<{ role: string; content: { text: string } }> } }>().prompt.messages[0]).toMatchObject({ role: "user", content: { text: expect.stringContaining("Explain rag to ops") } });
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/prompts/get`, builder.cookie, { name: "explain_topic" })).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/prompts/get`, builder.cookie, { name: "nope" })).statusCode).toBe(404);
    await createRule(context, admin.cookie, { name: "No explain", effect: "deny", roles: ["builder"], kind: "prompt", toolPattern: "explain_topic" });
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/prompts/get`, builder.cookie, { name: "explain_topic", arguments: { topic: "rag" } })).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/prompts/get`, viewer.cookie, { name: "explain_topic", arguments: { topic: "rag" } })).statusCode).toBe(403);

    const events = context.store.listAuditLogs({ pageSize: 200 }).items.map((entry) => entry.eventType);
    expect(events).toEqual(expect.arrayContaining(["mcp_resource.read", "mcp_resource.read_denied", "mcp_prompt.get", "mcp_prompt.get_denied"]));

    // Policy evaluate dry runs take a kind too.
    const evaluate = await call(context, "POST", "/api/mcp/policies/evaluate", admin.cookie, { role: "builder", serverId, toolName: "mock://kb/index.json", kind: "resource" });
    expect(evaluate.json<{ allowed: boolean; ruleName: string | null }>()).toMatchObject({ allowed: false, ruleName: "No KB" });
    expect((await call(context, "POST", "/api/mcp/policies/evaluate", admin.cookie, { role: "builder", serverId, toolName: "mock://kb/index.json" })).json<{ ruleName: string | null }>().ruleName).toBe("All tools");
  });

  it("MCP Tool nodes read resources in a run", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin.cookie);
    const saved = await call(context, "POST", "/api/workflows", admin.cookie, directWorkflow("wf-read", serverId, { operation: "read_resource", resourceUri: "mock://kb/{{topic}}" }));
    expect(saved.statusCode).toBe(200);
    const run = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-read", payload: { topic: "rag" } });
    expect(run.statusCode).toBe(200);
    expect(JSON.stringify(run.json())).toContain("RAG combines retrieval and generation");
  });
});

describe("elicitation", () => {
  const askWorkflow = (id: string, serverId: string): Workflow => ({
    id,
    name: `Ask ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
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
  });

  it("pauses a streamed run, shows the request, and resumes with the person's answer", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const other = await login(context, "builder", "other");
    const operator = await login(context, "operator");
    const serverId = await registerMockServer(context, admin.cookie);
    await call(context, "POST", "/api/workflows", builder.cookie, askWorkflow("wf-ask", serverId));

    const stream = call(context, "POST", "/api/workflows/wf-ask/execute/stream", builder.cookie, { input: {} });
    const pending = await waitFor(() => {
      const items = context.store.listMcpElicitations({ status: "pending" });
      return items.length > 0 ? items[0] : undefined;
    });
    expect(pending).toMatchObject({ workflowId: "wf-ask", nodeId: "tool", toolName: "ask_user", message: "Which region?", serverName: "Mock", registryServerId: serverId, createdBy: builder.id, triggerType: "manual_stream" });
    expect(pending.requestedSchema.properties.answer).toMatchObject({ type: "string", enum: ["eu", "us"] });

    // Another builder cannot see or answer it; a viewer-level list shows only your own.
    expect((await call(context, "GET", "/api/mcp/elicitations", other.cookie)).json<{ items: unknown[] }>().items).toHaveLength(0);
    expect((await call(context, "POST", `/api/mcp/elicitations/${pending.id}/answer`, other.cookie, { action: "accept", content: { answer: "eu" } })).statusCode).toBe(403);
    // Operators see it, and the owner sees it.
    expect((await call(context, "GET", "/api/mcp/elicitations", operator.cookie)).json<{ items: McpElicitationView[] }>().items[0].id).toBe(pending.id);
    expect((await call(context, "GET", `/api/mcp/elicitations?executionId=${pending.executionId}`, builder.cookie)).json<{ items: McpElicitationView[] }>().items).toHaveLength(1);
    // Validation: unknown choice, bad payload.
    const invalid = await call(context, "POST", `/api/mcp/elicitations/${pending.id}/answer`, builder.cookie, { action: "accept", content: { answer: "mars" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ details: string[] }>().details[0]).toContain("answer");
    expect((await call(context, "POST", `/api/mcp/elicitations/${pending.id}/answer`, builder.cookie, { action: "maybe" })).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/mcp/elicitations/nope/answer`, builder.cookie, { action: "decline" })).statusCode).toBe(404);

    const answered = await call(context, "POST", `/api/mcp/elicitations/${pending.id}/answer`, builder.cookie, { action: "accept", content: { answer: "eu" } });
    expect(answered.statusCode).toBe(200);
    expect(answered.json<{ elicitation: McpElicitationView }>().elicitation).toMatchObject({ status: "accepted", answeredBy: builder.email });
    expect((await call(context, "POST", `/api/mcp/elicitations/${pending.id}/answer`, builder.cookie, { action: "decline" })).statusCode).toBe(409);

    const response = await stream;
    expect(response.statusCode).toBe(200);
    const events = sseFrames(response.body, "mcp_elicitation");
    expect(events.map((event) => event.phase)).toEqual(["created", "settled"]);
    expect(events[1].elicitation).toMatchObject({ id: pending.id, status: "accepted" });
    const result = sseFrames(response.body, "result")[0] as { status: string; nodeResults: Array<{ nodeId: string; output: Record<string, unknown> }> };
    expect(result.status).toBe("success");
    const toolOutput = result.nodeResults.find((entry) => entry.nodeId === "tool")!.output;
    expect(toolOutput.tool_output).toEqual({ question: "Which region?", action: "accept", answer: "eu" });
    expect((toolOutput._mcpElicitations as Array<Record<string, unknown>>)[0]).toMatchObject({ id: pending.id, action: "accept", source: "user" });

    const audits = context.store.listAuditLogs({ resourceType: "mcp_elicitation", pageSize: 50 }).items;
    expect(audits.map((entry) => entry.eventType).sort()).toEqual(["mcp_elicitation.accepted", "mcp_elicitation.requested"]);
    const accepted = audits.find((entry) => entry.eventType === "mcp_elicitation.accepted")!;
    expect(JSON.stringify(accepted.metadata)).not.toContain("\"eu\"");
    expect(JSON.stringify(accepted.metadata)).toContain("\"fields\":[\"answer\"]");
  });

  it("declines automatically for unattended runs, with a trace entry, and refuses credential-looking schemas", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin.cookie);
    await call(context, "POST", "/api/workflows", admin.cookie, askWorkflow("wf-auto", serverId));
    const run = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-auto", payload: {} });
    expect(run.statusCode).toBe(200);
    const history = await waitFor(() => {
      const item = context.store.listExecutionHistory({ workflowId: "wf-auto", pageSize: 5 }).items.find((entry) => entry.status === "success");
      return item ? context.store.getExecutionHistory(item.id) ?? undefined : undefined;
    });
    const toolResult = (history.nodeResults as Array<{ nodeId: string; output: Record<string, unknown> }>).find((entry) => entry.nodeId === "tool")!;
    expect(toolResult.output.tool_output).toEqual({ question: "Which region?", action: "decline" });
    expect((toolResult.output._mcpElicitations as Array<Record<string, unknown>>)[0]).toMatchObject({ action: "decline", source: "unattended", note: expect.stringContaining("Unattended run (webhook)") });
    const stored = context.store.listMcpElicitations({ status: "auto_declined" });
    expect(stored).toHaveLength(1);
    expect(stored[0].reason).toContain("Unattended run (webhook)");
    expect(context.store.listAuditLogs({ resourceType: "mcp_elicitation", pageSize: 10 }).items.map((entry) => entry.eventType)).toEqual(["mcp_elicitation.auto_declined"]);

    const service = new McpElicitationService(context.store, { timeoutMs: 60_000, audit: () => undefined });
    const refused = await service.ask({
      request: { message: "Log in", requestedSchema: { type: "object", properties: { api_token: { type: "string" } } } },
      executionId: "exec_r", workflowId: "wf", nodeId: "n", serverId: "mock-mcp", toolName: "login", triggerType: "manual"
    });
    expect(refused).toMatchObject({ action: "decline", source: "refused", note: expect.stringContaining("look like credentials (api_token)") });
    expect(context.store.listMcpElicitations({ executionId: "exec_r" })[0]).toMatchObject({ status: "auto_declined", reason: expect.stringContaining("credentials") });
  });

  it("times out, follows run cancellation, and expires stale rows on restart", async () => {
    const context = await createTestContext();
    const audits: string[] = [];
    const service = new McpElicitationService(context.store, { timeoutMs: 60_000, audit: (event) => audits.push(event.eventType) });
    const base = { request: { message: "Q?", requestedSchema: { type: "object" as const, properties: { a: { type: "string" as const } } } }, workflowId: "wf", nodeId: "n", serverId: "mock-mcp", toolName: "ask", triggerType: "manual" };

    const events: string[] = [];
    const unsubscribe = service.subscribe("exec_t", (event) => events.push(`${event.phase}:${event.elicitation.status}`));
    const timedOut = await service.ask({ ...base, executionId: "exec_t", timeoutMs: 1 });
    expect(timedOut).toMatchObject({ action: "decline", source: "timeout" });
    expect(events).toEqual(["created:pending", "settled:expired"]);
    unsubscribe();

    const controller = new AbortController();
    const waiting = service.ask({ ...base, executionId: "exec_c", signal: controller.signal });
    await waitFor(() => (service.listPending({ executionId: "exec_c" }).length === 1 ? true : undefined));
    controller.abort();
    expect(await waiting).toMatchObject({ action: "cancel", source: "timeout" });
    expect(context.store.listMcpElicitations({ executionId: "exec_c" })[0].status).toBe("expired");

    const released = service.ask({ ...base, executionId: "exec_e" });
    await waitFor(() => (service.listPending({ executionId: "exec_e" }).length === 1 ? true : undefined));
    expect(service.releaseExecution("exec_e", "The run ended.")).toBe(1);
    expect(await released).toMatchObject({ action: "cancel" });

    // A row left pending by a previous process is expired by the next start.
    context.store.createMcpElicitation({ id: "elc_old", executionId: "exec_old", workflowId: "wf", nodeId: "n", serverId: "s", toolName: "t", message: "m", requestedSchema: { type: "object", properties: {} }, expiresAt: new Date().toISOString(), createdBy: null, triggerType: null });
    expect(service.expireStale()).toBe(1);
    expect(context.store.getMcpElicitation("elc_old")!.status).toBe("expired");
    expect(audits).toEqual(expect.arrayContaining(["mcp_elicitation.requested", "mcp_elicitation.expired"]));
  });
});

describe("sampling settings and telemetry", () => {
  it("stores sampling settings on registry servers and never on inline ones", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const created = await call(context, "POST", "/api/mcp/servers", admin.cookie, { name: "S", adapterId: "mock-mcp", probeEnabled: false, sampling: { allow: true, maxTokens: 256, allowedModels: ["gpt-4o-mini"] } });
    expect(created.statusCode).toBe(201);
    const serverId = created.json<{ server: { id: string; sampling: unknown } }>().server.id;
    expect(created.json<{ server: { sampling: unknown } }>().server.sampling).toEqual({ allow: true, maxTokens: 256, allowedModels: ["gpt-4o-mini"], maxRequestsPerCall: 3, defaultModel: null });
    const updated = await call(context, "PUT", `/api/mcp/servers/${serverId}`, admin.cookie, { sampling: { defaultModel: { providerId: "ollama", model: "llama3" } } });
    expect(updated.json<{ server: { sampling: Record<string, unknown> } }>().server.sampling).toMatchObject({ allow: true, maxTokens: 256, defaultModel: { providerId: "ollama", model: "llama3" } });
    expect((await call(context, "PUT", `/api/mcp/servers/${serverId}`, admin.cookie, { sampling: { maxTokens: 0 } })).statusCode).toBe(400);
    expect((await call(context, "PUT", `/api/mcp/servers/${serverId}`, builder.cookie, { sampling: { allow: false } })).statusCode).toBe(403);

    // Direct MCP Tool nodes without a default model refuse to sample; the server reports it.
    await call(context, "PUT", `/api/mcp/servers/${serverId}`, admin.cookie, { sampling: { defaultModel: null } });
    await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin.cookie);
    await call(context, "POST", "/api/workflows", admin.cookie, directWorkflow("wf-sample", serverId, { toolName: "summarize_with_model", argsTemplate: JSON.stringify({ text: "hello world" }) }));
    const run = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-sample", payload: {} });
    expect(run.body).toContain("no chat model is attached");
  });

  it("attributes sampling tokens to the tool call that triggered them", () => {
    const workflow = {
      id: "wf",
      nodes: [
        { id: "agent", type: "agent_orchestrator" },
        { id: "direct", type: "mcp_tool", config: { registryServerId: "mcp_a", toolName: "summarize_with_model" } }
      ]
    };
    const rows = extractMcpToolCalls({
      executionId: "exec",
      workflow,
      priceTurn: () => null,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: "2026-01-01T00:00:00.000Z",
          output: {
            _mcpTools: { "mock-mcp__summarize_with_model": { adapterId: "mock-mcp", toolName: "summarize_with_model", registryServerId: "mcp_a" } },
            _mcpSampling: [
              { toolName: "summarize_with_model", call: 1, serverId: "mock-mcp", requestedModels: [], model: "m", ok: true, prompt: "", maxTokens: 5, inputTokens: 10, outputTokens: 2, durationMs: 1, at: "" },
              { toolName: "summarize_with_model", call: 2, serverId: "mock-mcp", requestedModels: [], model: "m", ok: true, prompt: "", maxTokens: 5, inputTokens: 7, outputTokens: 3, durationMs: 1, at: "" },
              { toolName: "summarize_with_model", call: 2, serverId: "mock-mcp", requestedModels: [], model: null, ok: false, error: "budget", prompt: "", maxTokens: 5, durationMs: 1, at: "" }
            ],
            steps: [
              { toolResults: [{ toolName: "mock-mcp__summarize_with_model", output: {} }], usage: { inputTokens: 4, outputTokens: 2 } },
              { toolResults: [{ toolName: "mock-mcp__summarize_with_model", output: {} }], usage: { inputTokens: 4, outputTokens: 2 } }
            ]
          }
        },
        {
          nodeId: "direct",
          status: "success",
          startedAt: "2026-01-01T00:00:00.000Z",
          output: {
            invocation_request: { server_id: "mock-mcp", registry_server_id: "mcp_a", tool_name: "summarize_with_model" },
            _mcpSampling: [{ toolName: "summarize_with_model", call: 1, serverId: "mock-mcp", requestedModels: [], model: "m", ok: true, prompt: "", maxTokens: 5, inputTokens: 20, outputTokens: 5, durationMs: 1, at: "" }]
          }
        }
      ]
    });
    expect(rows.map((row) => [row.samplingRequests, row.samplingInputTokens, row.samplingOutputTokens])).toEqual([
      [1, 10, 2],
      [2, 7, 3],
      [1, 20, 5]
    ]);
    const rollup = rollupMcpToolCalls(rows.map((row) => ({ ...row, source: "workflow" as const, clientId: null, createdAt: "", samplingRequests: row.samplingRequests ?? null, samplingInputTokens: row.samplingInputTokens ?? null, samplingOutputTokens: row.samplingOutputTokens ?? null })));
    expect(rollup.totals).toMatchObject({ calls: 3, samplingRequests: 4, samplingInputTokens: 37, samplingOutputTokens: 10 });
  });
});
