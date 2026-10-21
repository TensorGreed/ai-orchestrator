/**
 * Phase 10.7 — MCP runtime safety over the API: sandbox settings (admin-only,
 * MCP_SANDBOX_REQUIRED, mount roots, catalog and import), the sandbox check a
 * probe records, rate limits and the circuit breaker (audit, Changes feed,
 * Overview, telemetry, gateway retry hint, admin reset) and migration 27.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpRuntimeStateView, McpSandboxPolicyView, McpSandboxStatus } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
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
const PINNED = `node:22.11.0-alpine3.20@sha256:${"b".repeat(64)}`;

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-safety-"));
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
    // Never start a real container from these tests: podman is not expected on the test host.
    MCP_SANDBOX_RUNTIME: "podman",
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
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

const stdioServer = (extra: Record<string, unknown> = {}) => ({
  name: "Files",
  adapterId: "stdio_mcp",
  connection: { command: "node", args: ["server.js"] },
  probeEnabled: false,
  ...extra
});

async function registerMock(context: TestContext, cookie: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(context, "POST", "/api/mcp/servers", cookie, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false, ...extra });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ server: { id: string } }>().server.id;
  expect((await call(context, "POST", `/api/mcp/servers/${id}/probe`, cookie)).statusCode).toBe(200);
  return id;
}

const playground = (context: TestContext, cookie: string, serverId: string, expression: string) =>
  call(context, "POST", `/api/mcp/servers/${serverId}/playground/call`, cookie, {
    toolName: "calculator",
    args: { expression },
    confirmWrite: true
  });

/** The error text a playground call shows (it comes back as tool content). */
function playgroundError(response: { json: <T>() => T }): string {
  const body = response.json<{ result?: { content?: Array<{ text?: string }> } }>();
  return (body.result?.content ?? []).map((entry) => entry.text ?? "").join(" ");
}

describe("migration 27", () => {
  it("adds sandbox, limits and credential columns, the rejection column and per-user connections, with a rollback", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 27);
    expect(migration?.description).toContain("10.7");
    for (const fragment of [
      "ADD COLUMN IF NOT EXISTS sandbox_json",
      "ADD COLUMN IF NOT EXISTS sandbox_status_json",
      "ADD COLUMN IF NOT EXISTS limits_json",
      "credential_mode TEXT NOT NULL DEFAULT 'service'",
      "delegated_fallback TEXT NOT NULL DEFAULT 'none'",
      "mcp_tool_calls ADD COLUMN IF NOT EXISTS rejection",
      "CREATE TABLE IF NOT EXISTS mcp_user_oauth_connections",
      "PRIMARY KEY (server_id, user_id)",
      "idx_mcp_user_oauth_user"
    ]) {
      expect(migration!.up).toContain(fragment);
    }
    expect(migration!.down).toContain("DROP TABLE IF EXISTS mcp_user_oauth_connections");
    expect(migration!.down).toContain("DROP COLUMN IF EXISTS sandbox_json");
    expect(Math.max(...MIGRATIONS.map((entry) => entry.version))).toBe(27);
  });

  it("creates the SQLite columns and table", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const id = await registerMock(context, admin.cookie);
    const server = context.store.getMcpServer(id)!;
    expect(server).toMatchObject({ sandbox: null, credentialMode: "service", delegatedFallback: "none" });
    expect(server.limits.breaker).toMatchObject({ enabled: true, failureThreshold: 5 });
    expect(context.store.listMcpUserOAuthConnections()).toEqual([]);
  });
});

describe("sandbox settings", () => {
  it("are admin-only, stdio-only, need a pinned image and stay within the allowed mount roots", async () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-mounts-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-outside-"));
    fs.mkdirSync(path.join(allowed, "data"));
    fs.symlinkSync(outside, path.join(allowed, "escape"));
    try {
      const context = await createTestContext({ MCP_SANDBOX_ALLOWED_MOUNT_ROOTS: allowed });
      const admin = await login(context, "admin");
      const builder = await login(context, "builder");
      const sandbox = { mode: "container", image: PINNED };

      expect((await call(context, "POST", "/api/mcp/servers", builder.cookie, stdioServer({ sandbox }))).statusCode).toBe(403);

      const httpWithSandbox = await call(context, "POST", "/api/mcp/servers", admin.cookie, {
        name: "Remote",
        adapterId: "http_mcp",
        connection: { endpoint: "http://127.0.0.1:9/mcp" },
        sandbox,
        probeEnabled: false
      });
      expect(httpWithSandbox.statusCode).toBe(400);
      expect(httpWithSandbox.json<{ error: string }>().error).toMatch(/stdio MCP servers only/);

      const latest = await call(context, "POST", "/api/mcp/servers", admin.cookie, stdioServer({ sandbox: { mode: "container", image: "node:latest" } }));
      expect(latest.statusCode).toBe(400);

      const escape = await call(
        context,
        "POST",
        "/api/mcp/servers",
        admin.cookie,
        stdioServer({ sandbox: { ...sandbox, mounts: [{ source: path.join(allowed, "escape"), target: "/data" }] } })
      );
      expect(escape.statusCode).toBe(400);
      expect(escape.json<{ error: string }>().error).toMatch(/outside|allowed/i);

      const created = await call(
        context,
        "POST",
        "/api/mcp/servers",
        admin.cookie,
        stdioServer({ sandbox: { ...sandbox, mounts: [{ source: path.join(allowed, "data"), target: "/data" }] } })
      );
      expect(created.statusCode).toBe(201);
      const serverId = created.json<{ server: { id: string } }>().server.id;
      expect(context.store.getMcpServer(serverId)?.sandbox).toMatchObject({ mode: "container", image: PINNED });

      // Builders cannot change it; admins can.
      expect((await call(context, "PUT", `/api/mcp/servers/${serverId}`, builder.cookie, { sandbox: null })).statusCode).toBe(403);
      expect((await call(context, "PUT", `/api/mcp/servers/${serverId}`, admin.cookie, { sandbox: { ...sandbox, network: "bridge" } })).statusCode).toBe(200);

      const list = await call(context, "GET", "/api/mcp/servers", builder.cookie);
      expect(list.json<{ sandboxPolicy: McpSandboxPolicyView }>().sandboxPolicy).toMatchObject({
        defaultMode: "none",
        required: false,
        runtime: "podman",
        allowedMountRoots: [allowed]
      });
    } finally {
      fs.rmSync(allowed, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("with MCP_SANDBOX_REQUIRED refuses unsandboxed stdio servers, on save and on import", async () => {
    const context = await createTestContext({ MCP_SANDBOX_REQUIRED: "true" });
    const admin = await login(context, "admin");
    const plain = await call(context, "POST", "/api/mcp/servers", admin.cookie, stdioServer());
    expect(plain.statusCode).toBe(400);
    expect(plain.json<{ error: string }>().error).toMatch(/MCP_SANDBOX_REQUIRED/);
    const none = await call(context, "POST", "/api/mcp/servers", admin.cookie, stdioServer({ sandbox: { mode: "none" } }));
    expect(none.statusCode).toBe(400);
    expect((await call(context, "POST", "/api/mcp/servers", admin.cookie, stdioServer({ sandbox: { mode: "container", image: PINNED } }))).statusCode).toBe(201);
    // Remote servers are not affected.
    expect((await registerMock(context, admin.cookie)).length).toBeGreaterThan(0);

    const content = { mcpServers: { files: { command: "node", args: ["files.js"] } } };
    const preview = await call(context, "POST", "/api/mcp/servers/import", admin.cookie, { content, dryRun: true });
    expect(preview.json<{ entries: Array<{ blockedReason: string | null }> }>().entries[0]?.blockedReason).toMatch(/MCP_SANDBOX_REQUIRED/);
    const skipped = await call(context, "POST", "/api/mcp/servers/import", admin.cookie, { content, probe: false });
    expect(skipped.json<{ entries: Array<{ result?: { action: string } }> }>().entries[0]?.result?.action).toBe("skipped");
    const sandboxed = await call(context, "POST", "/api/mcp/servers/import", admin.cookie, {
      content,
      probe: false,
      entries: { files: { sandbox: { mode: "container", image: PINNED } } }
    });
    const result = sandboxed.json<{ entries: Array<{ result?: { action: string; serverId?: string } }> }>().entries[0]?.result;
    expect(result?.action).toBe("created");
    expect(context.store.getMcpServer(result!.serverId!)?.sandbox).toMatchObject({ mode: "container", image: PINNED });
  });

  it("takes the sandbox of a matching catalog entry on import", async () => {
    const tempCatalog = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-catalog-"));
    const file = path.join(tempCatalog, "catalog.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        servers: [
          {
            id: "files",
            name: "Files",
            adapter: "stdio_mcp",
            connection: { command: "node", args: ["files.js"] },
            approved: true,
            sandbox: { mode: "container", image: PINNED, memoryMb: 256 }
          }
        ]
      })
    );
    try {
      const context = await createTestContext({ MCP_CATALOG_FILE: file, MCP_CATALOG_ENFORCE: "true", MCP_SANDBOX_REQUIRED: "true" });
      const admin = await login(context, "admin");
      const imported = await call(context, "POST", "/api/mcp/servers/import", admin.cookie, {
        content: { mcpServers: { files: { command: "node", args: ["files.js"] } } },
        probe: false
      });
      const result = imported.json<{ entries: Array<{ result?: { action: string; serverId?: string } }> }>().entries[0]?.result;
      expect(result?.action).toBe("created");
      expect(context.store.getMcpServer(result!.serverId!)?.sandbox).toMatchObject({ mode: "container", memoryMb: 256 });
      const presets = await call(context, "GET", "/api/mcp/presets", admin.cookie);
      if (presets.statusCode === 200) {
        expect(JSON.stringify(presets.json())).toContain(PINNED);
      }
    } finally {
      fs.rmSync(tempCatalog, { recursive: true, force: true });
    }
  });

  it("probe records why a sandbox cannot start without starting anything", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const created = await call(context, "POST", "/api/mcp/servers", admin.cookie, stdioServer({ sandbox: { mode: "container", image: "node:22-alpine" } }));
    expect(created.statusCode).toBe(201);
    const serverId = created.json<{ server: { id: string } }>().server.id;
    // CI runners ship podman, so hide every runtime CLI: the probe must report "not installed" on any host.
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-no-runtime-"));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyBin;
    let probe: Awaited<ReturnType<typeof call>>;
    try {
      probe = await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin.cookie);
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
    expect(probe.statusCode).toBe(200);
    expect(probe.json<{ probe: { ok: boolean; error: string } }>().probe.ok).toBe(false);
    const status = probe.json<{ server: { sandboxStatus: McpSandboxStatus } }>().server.sandboxStatus;
    expect(status).toMatchObject({ mode: "container", source: "server", ok: false, pinnedByDigest: false });
    expect(status.problems.join(" ")).toMatch(/podman/);
    expect(status.warnings.join(" ")).toMatch(/digest/);

    const overview = await call(context, "GET", "/api/mcp/overview", admin.cookie);
    expect(overview.json<{ sandboxAttention: Array<{ serverId: string }> }>().sandboxAttention).toEqual([
      expect.objectContaining({ serverId })
    ]);
  });
});

describe("rate limits and the circuit breaker", () => {
  it("opens the breaker after repeated failures, audits it, shows it everywhere and lets an admin reset it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMock(context, admin.cookie, {
      limits: { breaker: { failureThreshold: 2, cooldownMs: 60_000 } }
    });

    expect((await playground(context, builder.cookie, serverId, "1+1")).json<{ ok: boolean }>().ok).toBe(true);
    for (let i = 0; i < 2; i += 1) {
      const failed = await playground(context, builder.cookie, serverId, "abc");
      expect(failed.json<{ ok: boolean }>().ok).toBe(false);
    }
    const refused = await playground(context, builder.cookie, serverId, "2+2");
    expect(refused.json<{ ok: boolean }>().ok).toBe(false);
    expect(playgroundError(refused)).toMatch(/^Circuit open:/);

    const audit = context.store.listAuditLogs({ resourceType: "mcp_server", pageSize: 200 }).items;
    expect(audit.map((entry) => entry.eventType)).toContain("mcp_server.breaker_opened");
    const opened = audit.find((entry) => entry.eventType === "mcp_server.breaker_opened")!;
    expect(JSON.stringify(opened.metadata)).not.toContain("unsupported characters");

    const asBuilder = await call(context, "GET", `/api/mcp/servers/${serverId}`, builder.cookie);
    const builderRuntime = asBuilder.json<{ server: { runtime: McpRuntimeStateView } }>().server.runtime;
    expect(builderRuntime.breaker.state).toBe("open");
    expect(builderRuntime.breaker.lastError).toBeNull();
    expect(builderRuntime.rejected.circuit_open).toBe(1);
    const asAdmin = await call(context, "GET", `/api/mcp/servers/${serverId}/runtime`, admin.cookie);
    expect(asAdmin.json<{ runtime: McpRuntimeStateView }>().runtime.breaker.lastError).toMatch(/unsupported characters/);

    const overview = await call(context, "GET", "/api/mcp/overview", builder.cookie);
    expect(overview.json<{ breakers: Array<{ serverId: string; state: string }> }>().breakers).toEqual([
      expect.objectContaining({ serverId, state: "open" })
    ]);
    const changes = await call(context, "GET", "/api/mcp/changes?kind=breaker", builder.cookie);
    expect(changes.statusCode).toBe(200);
    expect(changes.json<{ items: Array<{ title: string; severity: string }> }>().items[0]).toMatchObject({
      title: expect.stringMatching(/Circuit opened on Mock/),
      severity: "breaking"
    });

    // Refused calls are counted apart from errors.
    const telemetry = await call(context, "GET", `/api/mcp/servers/${serverId}/telemetry`, builder.cookie);
    expect(telemetry.json<{ totals: Record<string, number> }>().totals).toMatchObject({ calls: 4, errors: 2, breakerRejected: 1, rateLimited: 0 });

    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/breaker/reset`, builder.cookie)).statusCode).toBe(403);
    const reset = await call(context, "POST", `/api/mcp/servers/${serverId}/breaker/reset`, admin.cookie);
    expect(reset.json<{ runtime: McpRuntimeStateView }>().runtime.breaker.state).toBe("closed");
    expect((await playground(context, builder.cookie, serverId, "3+3")).json<{ ok: boolean }>().ok).toBe(true);
    const events = context.store.listAuditLogs({ resourceType: "mcp_server", pageSize: 200 }).items.map((entry) => entry.eventType);
    expect(events).toEqual(expect.arrayContaining(["mcp_server.breaker_closed", "mcp_server.breaker_reset"]));
  });

  it("keeps breaker and limit state per server", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const flaky = await registerMock(context, admin.cookie, { name: "Flaky", limits: { breaker: { failureThreshold: 1 } } });
    const other = await registerMock(context, admin.cookie, { name: "Other", limits: { breaker: { failureThreshold: 1 } } });
    await playground(context, admin.cookie, flaky, "abc");
    expect(playgroundError(await playground(context, admin.cookie, flaky, "1+1"))).toMatch(/^Circuit open:/);
    expect((await playground(context, admin.cookie, other, "1+1")).json<{ ok: boolean }>().ok).toBe(true);
  });

  it("rate limits calls and tells gateway clients when to retry", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerMock(context, admin.cookie, { limits: { requestsPerMinute: 1, maxQueueWaitMs: 0 } });

    const toolset = await call(context, "POST", "/api/mcp/toolsets", admin.cookie, {
      name: "Limited",
      projectId: "default",
      members: [{ kind: "server", serverId, toolGlob: "calculator" }]
    });
    expect(toolset.statusCode).toBe(201);
    const { slug, id: toolsetId } = toolset.json<{ toolset: { slug: string; id: string } }>().toolset;
    const client = await call(context, "POST", "/api/mcp/clients", admin.cookie, { name: "IDE", toolsetIds: [toolsetId], role: "builder" });
    const token = client.json<{ token: string }>().token;
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } } });
    const session = init.headers["mcp-session-id"] as string;
    const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": session });
    const name = tools.json<{ result: { tools: Array<{ name: string }> } }>().result.tools[0]!.name;

    const first = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { expression: "1+1" } } }, { "mcp-session-id": session });
    expect(first.json<{ result: { isError?: boolean } }>().result.isError).not.toBe(true);
    const second = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: { expression: "1+1" } } }, { "mcp-session-id": session });
    const error = second.json<{ error: { code: number; message: string; data: { reason: string; retryAfterMs: number; retryAfterSeconds: number } } }>().error;
    expect(error.code).toBe(-32029);
    expect(error.message).toMatch(/^Rate limited:/);
    expect(error.data.reason).toBe("rate_limited");
    expect(error.data.retryAfterMs).toBeGreaterThan(0);
    expect(error.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    // The playground shares the same budget in this process.
    expect(playgroundError(await playground(context, admin.cookie, serverId, "1+1"))).toMatch(/^Rate limited:/);

    const telemetry = await call(context, "GET", `/api/mcp/servers/${serverId}/telemetry`, admin.cookie);
    expect(telemetry.json<{ totals: Record<string, number> }>().totals).toMatchObject({ calls: 3, errors: 0, rateLimited: 2, errorRate: 0 });
    const rows = context.store.listMcpToolCalls({ registryServerId: serverId, since: "1970-01-01T00:00:00.000Z" });
    expect(rows.map((row) => row.rejection ?? null)).toEqual([null, "rate_limited", "rate_limited"]);
  });
});
