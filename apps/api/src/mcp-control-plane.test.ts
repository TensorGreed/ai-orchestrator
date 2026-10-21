/**
 * Phase 10.3 — read-only routes behind the MCP control plane pages:
 * tools catalogue, changes feed and overview.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore, type McpServerProbeRecord } from "./db/database.js";
import { statusTransitions } from "./mcp-control-plane-routes.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-control-plane-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // The store may already be closed by the app shutdown hooks.
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

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  return extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

async function call<T = Record<string, unknown>>(
  context: TestContext,
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie: string,
  payload?: unknown
): Promise<{ status: number; body: T }> {
  const response = await context.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {})
  });
  return { status: response.statusCode, body: response.json() as T };
}

function workflowUsing(serverId: string): Workflow {
  return {
    id: "wf-control-plane",
    name: "Control plane flow",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "calc",
        type: "mcp_tool",
        name: "Calculator",
        position: { x: 200, y: 0 },
        config: { registryServerId: serverId, toolName: "calculator", argsTemplate: "{\"expression\":\"1+1\"}" }
      },
      {
        id: "all",
        type: "mcp_tool",
        name: "Every tool",
        position: { x: 200, y: 200 },
        config: { registryServerId: serverId, toolName: "__all__" }
      }
    ],
    edges: [{ id: "e1", source: "start", target: "calc" }]
  };
}

/** Registers a healthy mock server, a server that cannot connect, telemetry, a policy and gateway records. */
async function seed(context: TestContext, admin: string) {
  const mock = await call<{ server: { id: string } }>(context, "POST", "/api/mcp/servers", admin, {
    name: "Mock tools",
    adapterId: "mock-mcp",
    probeEnabled: false,
    sampling: { allow: true, maxTokens: 512 }
  });
  expect(mock.status).toBe(201);
  const mockId = mock.body.server.id;
  expect((await call(context, "POST", `/api/mcp/servers/${mockId}/probe`, admin)).status).toBe(200);

  const broken = await call<{ server: { id: string } }>(context, "POST", "/api/mcp/servers", admin, {
    name: "Offline",
    adapterId: "http_mcp",
    connection: { endpoint: "http://127.0.0.1:9/mcp", transport: "http_streamable" },
    probeEnabled: false
  });
  const brokenId = broken.body.server.id;
  await call(context, "POST", `/api/mcp/servers/${brokenId}/probe`, admin);

  const now = Date.now();
  for (let index = 0; index < 4; index += 1) {
    context.store.insertMcpToolCall({
      id: `mtc_${index}`,
      executionId: `exec_${index}`,
      workflowId: "wf-control-plane",
      nodeId: "calc",
      registryServerId: mockId,
      adapterId: "mock-mcp",
      toolName: index < 3 ? "calculator" : "get_current_time",
      startedAt: new Date(now - index * 1000).toISOString(),
      durationMs: 10 + index,
      ok: index !== 1,
      error: index === 1 ? "boom" : null,
      turnInputTokens: null,
      turnOutputTokens: null,
      estimatedCostUsd: null
    });
  }

  const policy = await call<{ rule: { id: string } }>(context, "POST", "/api/mcp/policies", admin, {
    name: "No calculator for builders",
    effect: "deny",
    roles: ["builder"],
    serverId: mockId,
    toolPattern: "calculator"
  });
  expect(policy.status).toBe(201);

  context.store.createMcpClient({
    id: "mcl_1",
    name: "IDE",
    tokenPrefix: "l2m_abc",
    tokenHash: "hash",
    toolsetIds: [],
    role: "builder",
    createdBy: null,
    createdByEmail: null,
    expiresAt: null
  });
  context.store.createMcpClient({
    id: "mcl_2",
    name: "Old laptop",
    tokenPrefix: "l2m_def",
    tokenHash: "hash2",
    toolsetIds: [],
    role: "viewer",
    createdBy: null,
    createdByEmail: null,
    expiresAt: new Date(now - 60_000).toISOString()
  });

  context.store.createMcpElicitation({
    id: "elc_1",
    executionId: "exec_1",
    workflowId: "wf-control-plane",
    workflowName: "Control plane flow",
    nodeId: "calc",
    serverId: "mock-mcp",
    registryServerId: mockId,
    serverName: "Mock tools",
    toolName: "ask_user",
    message: "Which?",
    requestedSchema: { type: "object", properties: { answer: { type: "string" } } },
    expiresAt: new Date(now + 60_000).toISOString(),
    createdBy: null,
    triggerType: "manual"
  });

  return { mockId, brokenId, policyId: policy.body.rule.id };
}

describe("MCP control plane routes", () => {
  it("are builder-readable and closed to operators, viewers and anonymous callers", async () => {
    const context = await createTestContext();
    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");
    const builder = await login(context, "builder");
    for (const url of ["/api/mcp/tools", "/api/mcp/changes", "/api/mcp/overview"]) {
      expect((await context.app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await call(context, "GET", url, operator)).status).toBe(403);
      expect((await call(context, "GET", url, viewer)).status).toBe(403);
      expect((await call(context, "GET", url, builder)).status).toBe(200);
    }
  });

  it("lists every registered tool with access, telemetry and usages", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const { mockId } = await seed(context, admin);
    context.store.upsertWorkflow(workflowUsing(mockId));

    type ToolsBody = {
      policy: { role: string };
      servers: Array<{ id: string; status: string }>;
      tools: Array<{
        serverId: string;
        name: string;
        classification: { readOnly: boolean };
        access: { allowed: boolean; ruleName?: string };
        telemetry?: { calls: number; errors: number } | null;
        recentCalls?: Array<{ ok: boolean; error: string | null; source: string }>;
        usages?: Array<{ nodeId: string; allTools: boolean }>;
        annotations?: { readOnlyHint?: boolean };
      }>;
    };
    const asBuilder = await call<ToolsBody>(context, "GET", "/api/mcp/tools?window=7d", builder);
    expect(asBuilder.status).toBe(200);
    expect(asBuilder.body.policy.role).toBe("builder");
    expect(asBuilder.body.servers.map((server) => server.status).sort()).toEqual(["down", "healthy"]);
    const calculator = asBuilder.body.tools.find((tool) => tool.name === "calculator")!;
    expect(calculator.serverId).toBe(mockId);
    expect(calculator.access).toMatchObject({ allowed: false, ruleName: "No calculator for builders" });
    expect(calculator.classification.readOnly).toBe(false);
    expect(calculator.telemetry).toMatchObject({ calls: 3, errors: 1 });
    expect(calculator.recentCalls?.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(calculator.recentCalls?.[1]).toMatchObject({ error: "boom", source: "workflow" });
    expect(calculator.usages?.map((usage) => [usage.nodeId, usage.allTools]).sort()).toEqual([
      ["all", true],
      ["calc", false]
    ]);
    const clock = asBuilder.body.tools.find((tool) => tool.name === "get_current_time")!;
    expect(clock.access.allowed).toBe(true);
    expect(clock.annotations?.readOnlyHint).toBe(true);
    expect(clock.usages?.map((usage) => usage.nodeId)).toEqual(["all"]);

    // The admin is not covered by the builder-only deny.
    const asAdmin = await call<ToolsBody>(context, "GET", "/api/mcp/tools", admin);
    expect(asAdmin.body.tools.find((tool) => tool.name === "calculator")!.access.allowed).toBe(true);

    // The canvas variant skips telemetry and usages and can narrow to servers.
    const light = await call<ToolsBody>(context, "GET", `/api/mcp/tools?detail=false&serverIds=${mockId}`, builder);
    expect(light.body.servers).toHaveLength(1);
    expect(light.body.tools[0]).not.toHaveProperty("telemetry");
    expect(light.body.tools[0]).not.toHaveProperty("usages");
    expect(light.body.tools[0]).not.toHaveProperty("recentCalls");

    expect((await call(context, "GET", "/api/mcp/tools?window=1y", builder)).status).toBe(400);
  });

  it("builds a changes feed with filters and keeps actors admin-only", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const { mockId, brokenId } = await seed(context, admin);
    await call(context, "PUT", `/api/mcp/servers/${mockId}`, admin, { sampling: { allow: false } });
    await call(context, "PUT", `/api/mcp/servers/${mockId}/tools/calculator/classification`, admin, { readOnly: true });

    type Feed = {
      total: number;
      items: Array<{
        kind: string;
        severity: string;
        serverId: string | null;
        title: string;
        link: { page: string; serverId?: string; policyId?: string } | null;
        actor?: string | null;
        transition?: { from: string; to: string };
      }>;
    };
    const asBuilder = await call<Feed>(context, "GET", "/api/mcp/changes", builder);
    expect(asBuilder.status).toBe(200);
    const kinds = new Set(asBuilder.body.items.map((item) => item.kind));
    for (const kind of ["schema", "status", "policy", "classification", "sampling", "server", "catalog"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    expect(asBuilder.body.items.every((item) => !("actor" in item) && !("metadata" in item))).toBe(true);
    const down = asBuilder.body.items.find((item) => item.kind === "status" && item.serverId === brokenId)!;
    expect(down.transition).toEqual({ from: "unknown", to: "down" });
    expect(down.title).toContain("Not probed → Down");
    const policy = asBuilder.body.items.find((item) => item.kind === "policy")!;
    expect(policy.link?.page).toBe("policies");
    expect(policy.link?.policyId).toBeTruthy();

    expect(asBuilder.body.items).toHaveLength(asBuilder.body.total);

    const asAdmin = await call<Feed>(context, "GET", "/api/mcp/changes?kind=sampling", admin);
    expect(asAdmin.body.items).toHaveLength(1);
    expect(asAdmin.body.items[0]).toMatchObject({ kind: "sampling", actor: "admin@example.com" });

    const byServer = await call<Feed>(context, "GET", `/api/mcp/changes?serverId=${brokenId}`, builder);
    expect(byServer.body.items.length).toBeGreaterThan(0);
    expect(byServer.body.items.every((item) => item.serverId === brokenId)).toBe(true);

    const limited = await call<Feed>(context, "GET", "/api/mcp/changes?limit=2", builder);
    expect(limited.body.items).toHaveLength(2);
    expect(limited.body.total).toBeGreaterThan(2);

    expect((await call(context, "GET", "/api/mcp/changes?kind=nope", builder)).status).toBe(400);
  });

  it("summarises the fleet for the overview", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");

    const empty = await call<{ servers: { total: number }; changes: unknown[] }>(context, "GET", "/api/mcp/overview", builder);
    expect(empty.status).toBe(200);
    expect(empty.body.servers.total).toBe(0);
    expect(empty.body.changes).toEqual([]);

    const { mockId } = await seed(context, admin);
    type Overview = {
      servers: { total: number; byStatus: Record<string, number> };
      sampling: Array<{ serverId: string }>;
      elicitations: { pending: number };
      tools: { calls: number; errors: number; busiest: Array<{ toolName: string; calls: number }>; errorProne: Array<{ toolName: string }> };
      clients: { total: number; active: number };
      changes: unknown[];
    };
    const busy = await call<Overview>(context, "GET", "/api/mcp/overview?window=24h", builder);
    expect(busy.body.servers).toMatchObject({ total: 2, byStatus: { healthy: 1, down: 1, degraded: 0, unknown: 0 } });
    expect(busy.body.sampling.map((entry) => entry.serverId)).toEqual([mockId]);
    expect(busy.body.elicitations.pending).toBe(1);
    expect(busy.body.tools.calls).toBe(4);
    expect(busy.body.tools.errors).toBe(1);
    expect(busy.body.tools.busiest[0]).toMatchObject({ toolName: "calculator", calls: 3 });
    expect(busy.body.tools.errorProne.map((tool) => tool.toolName)).toEqual(["calculator"]);
    expect(busy.body.clients).toMatchObject({ total: 2, active: 1 });
    expect(busy.body.changes.length).toBeGreaterThan(0);
    expect(busy.body.changes.length).toBeLessThanOrEqual(8);
  });
});

describe("statusTransitions", () => {
  const probe = (id: string, ok: boolean, at: number): McpServerProbeRecord => ({
    id,
    serverId: "s",
    startedAt: new Date(at).toISOString(),
    ok,
    latencyMs: 5,
    toolCount: 1,
    error: ok ? null : "refused",
    snapshotId: null
  });

  it("replays derived status changes oldest first", () => {
    // Newest first, as the store returns them.
    const probes = [probe("p4", true, 4), probe("p3", false, 3), probe("p2", true, 2), probe("p1", true, 1)];
    expect(statusTransitions(probes).map((entry) => `${entry.from}>${entry.to}`)).toEqual([
      "unknown>healthy",
      "healthy>down",
      "down>degraded"
    ]);
    expect(statusTransitions([])).toEqual([]);
  });
});
