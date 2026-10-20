/**
 * Phase 10.1 — MCP server registry routes and run-time resolution.
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
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
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

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-registry-"));
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
  const context: TestContext = { app, store, authService, secretService, config, tempDir };
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

interface ServerBody {
  id: string;
  name: string;
  adapterId: string;
  status: string;
  toolCount: number;
  owner: string | null;
  secretId: string | null;
  currentSnapshotId: string | null;
  pendingBreakingSnapshotId: string | null;
  blockOnBreakingChange: boolean;
  latency: { samples: number; p50Ms: number | null; errorRate: number | null };
}

async function createServer(context: TestContext, cookie: string, payload: Record<string, unknown> = {}) {
  const response = await context.app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { cookie },
    payload: { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false, ...payload }
  });
  return response;
}

function calculatorWorkflow(registryServerId: string): Workflow {
  return {
    id: "wf-registry-calc",
    name: "Registry calculator",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "calc",
        type: "mcp_tool",
        name: "Calculator",
        position: { x: 200, y: 0 },
        config: { registryServerId, toolName: "calculator", argsTemplate: "{\"expression\":\"20+22\"}" }
      },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "calc" },
      { id: "e2", source: "calc", target: "output" }
    ]
  };
}

describe("MCP server registry API", () => {
  it("lets admins create servers and builders read and probe them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");

    expect((await createServer(context, builder)).statusCode).toBe(403);
    const created = await createServer(context, admin, { description: "Built-in demo tools" });
    expect(created.statusCode).toBe(201);
    const server = created.json<{ server: ServerBody }>().server;
    expect(server).toMatchObject({ name: "Mock tools", adapterId: "mock-mcp", status: "unknown", owner: "admin@example.com" });

    const list = await context.app.inject({ method: "GET", url: "/api/mcp/servers", headers: { cookie: builder } });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ servers: ServerBody[]; adapters: Array<{ id: string }>; defaultProbeIntervalMs: number }>();
    expect(listBody.servers.map((entry) => entry.id)).toEqual([server.id]);
    expect(listBody.adapters.map((adapter) => adapter.id)).toContain("stdio_mcp");
    expect(listBody.defaultProbeIntervalMs).toBe(0);

    const probe = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${server.id}/probe`,
      headers: { cookie: builder }
    });
    expect(probe.statusCode).toBe(200);
    const probeBody = probe.json<{ server: ServerBody; probe: { ok: boolean }; snapshot: { toolCount: number } | null }>();
    expect(probeBody.probe.ok).toBe(true);
    expect(probeBody.server.status).toBe("healthy");
    expect(probeBody.server.latency.samples).toBe(1);
    expect(probeBody.snapshot?.toolCount).toBeGreaterThan(0);

    const tools = await context.app.inject({
      method: "GET",
      url: `/api/mcp/servers/${server.id}/tools`,
      headers: { cookie: builder }
    });
    expect(tools.json<{ tools: Array<{ name: string }> }>().tools.map((tool) => tool.name)).toContain("calculator");

    const detail = await context.app.inject({ method: "GET", url: `/api/mcp/servers/${server.id}`, headers: { cookie: builder } });
    const detailBody = detail.json<{ probes: unknown[]; snapshots: Array<Record<string, unknown>>; usages: unknown[] }>();
    expect(detailBody.probes).toHaveLength(1);
    expect(detailBody.snapshots).toHaveLength(1);
    expect(detailBody.snapshots[0]).not.toHaveProperty("tools");
    expect(detailBody.usages).toEqual([]);

    const audit = context.store.listAuditLogs({ resourceType: "mcp_server" });
    expect(audit.items.map((entry) => entry.eventType)).toContain("mcp_server.created");
  });

  it("validates adapters, secrets and probe intervals", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");

    expect((await createServer(context, admin, { adapterId: "nope" })).json<{ error: string }>().error).toContain("Unknown MCP adapter");
    expect((await createServer(context, admin, { secretRef: { secretId: "sec_missing" } })).statusCode).toBe(400);
    expect((await createServer(context, admin, { probeIntervalMs: 500 })).statusCode).toBe(400);
    expect((await createServer(context, admin, { name: " " })).statusCode).toBe(400);

    const secret = context.secretService.createSecret({ name: "Token", provider: "mcp", value: "t0ken" });
    const created = await createServer(context, admin, { secretRef: { secretId: secret.secretId } });
    expect(created.statusCode).toBe(201);
    const server = created.json<{ server: ServerBody }>().server;
    expect(server.secretId).toBe(secret.secretId);
    expect(created.body).not.toContain("t0ken");

    const cleared = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${server.id}`,
      headers: { cookie: admin },
      payload: { secretRef: null, blockOnBreakingChange: true }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ server: ServerBody }>().server).toMatchObject({ secretId: null, blockOnBreakingChange: true });

    const empty = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${server.id}`,
      headers: { cookie: admin },
      payload: {}
    });
    expect(empty.statusCode).toBe(400);
  });

  it("runs nodes through the registry and blocks on an unaccepted breaking change", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const server = (await createServer(context, admin, { blockOnBreakingChange: true })).json<{ server: ServerBody }>().server;
    context.store.upsertWorkflow(calculatorWorkflow(server.id));

    const run = () =>
      context.app.inject({ method: "POST", url: "/api/workflows/wf-registry-calc/execute", headers: { cookie: admin }, payload: {} });

    const ok = await run();
    expect(ok.statusCode).toBe(200);
    const okBody = ok.json<{ nodeResults: Array<{ nodeId: string; output: Record<string, unknown> }> }>();
    const calc = okBody.nodeResults.find((entry) => entry.nodeId === "calc");
    expect(calc?.output.invocation_request).toMatchObject({ server_id: "mock-mcp", registry_server_id: server.id });

    // Simulate a probe that saw a breaking schema change.
    const now = new Date().toISOString();
    context.store.recordMcpServerProbe({
      probe: { id: "probe_x", serverId: server.id, startedAt: now, ok: true, latencyMs: 5, toolCount: 0, error: null, snapshotId: "snap_x" },
      status: "healthy",
      snapshot: {
        id: "snap_x",
        serverId: server.id,
        hash: "h",
        tools: [],
        toolCount: 0,
        previousSnapshotId: null,
        changes: [{ tool: "calculator", kind: "tool_removed", breaking: true, detail: "tool calculator removed" }],
        breaking: true,
        createdAt: now
      },
      keepProbes: 10
    });

    const blocked = await run();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).toContain("breaking way");

    const builder = await login(context, "builder");
    const forbidden = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${server.id}/accept-change`,
      headers: { cookie: builder }
    });
    expect(forbidden.statusCode).toBe(403);

    const accepted = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${server.id}/accept-change`,
      headers: { cookie: admin }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ server: ServerBody }>().server.pendingBreakingSnapshotId).toBeNull();
    expect(context.store.getMcpToolSnapshot("snap_x")?.acknowledgedBy).toBe("admin@example.com");

    const again = await context.app.inject({
      method: "POST",
      url: `/api/mcp/servers/${server.id}/accept-change`,
      headers: { cookie: admin }
    });
    expect(again.statusCode).toBe(409);
    expect((await run()).statusCode).toBe(200);
  });

  it("guards deletion of servers that workflows still use", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const server = (await createServer(context, admin)).json<{ server: ServerBody }>().server;
    context.store.upsertWorkflow(calculatorWorkflow(server.id));

    const refused = await context.app.inject({ method: "DELETE", url: `/api/mcp/servers/${server.id}`, headers: { cookie: admin } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ usages: Array<{ workflowId: string; nodeId: string }> }>().usages).toEqual([
      expect.objectContaining({ workflowId: "wf-registry-calc", nodeId: "calc" })
    ]);

    const forced = await context.app.inject({
      method: "DELETE",
      url: `/api/mcp/servers/${server.id}?force=true`,
      headers: { cookie: admin }
    });
    expect(forced.statusCode).toBe(200);

    const run = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-registry-calc/execute",
      headers: { cookie: admin },
      payload: {}
    });
    expect(run.statusCode).toBe(400);
    expect(run.body).toContain("is not in the server registry");
  });
});
