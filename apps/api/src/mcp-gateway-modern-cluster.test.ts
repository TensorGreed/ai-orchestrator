/**
 * MCP 2026-07-28 at the gateway in cluster mode (HA_ENABLED on one Postgres database): modern callers need no sticky
 * sessions, so any replica serves them. A toolset that tracks outside content per session is the exception until its
 * label mark is shared across replicas: there a modern request gets the legacy "session required" answer, which a
 * client that speaks both versions reads as "use initialize". Postgres only (skipped without TEST_POSTGRES_URL).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("MCP 2026-07-28 gateway callers across replicas");

const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "fleet", version: "1" }
};

interface Replica {
  app: FastifyInstance;
  store: PostgresStore;
}

run("MCP 2026-07-28 gateway callers across replicas", () => {
  let primary: TestStore | undefined;
  const replicas: Replica[] = [];
  const tempDirs: string[] = [];
  const masterKey = crypto.randomBytes(32).toString("base64");

  afterEach(async () => {
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function addReplica(name: string): Promise<Replica> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-gw-modern-cluster-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 8 });
    const config = parseConfig({
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: masterKey,
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      DB_TYPE: "postgres",
      DB_POSTGRESDB_HOST: "unused-the-store-is-passed-in",
      HA_ENABLED: "true",
      HA_INSTANCE_ID: name,
      HA_RENEW_INTERVAL_MS: "100",
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "5000",
      WORKER_MODE: "api",
      MCP_GATEWAY_MODERN_PROTOCOL: "on"
    });
    const app = await createApp(
      config,
      store,
      new SecretService(store, config.SECRET_MASTER_KEY_BASE64),
      new AuthService(store, config.SESSION_TTL_HOURS),
      undefined,
      undefined,
      undefined,
      { lifecycle: new AppLifecycle() }
    );
    await app.ready();
    const replica = { app, store };
    replicas.push(replica);
    return replica;
  }

  async function adminCookie(replica: Replica): Promise<string> {
    const email = "admin@example.com";
    const password = "admin-Pass-123!";
    if (!(await replica.store.getUserByEmail(email))) await new AuthService(replica.store, 24).register({ email, password, role: "admin" });
    const login = await replica.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  async function toolsetWithClient(replica: Replica, cookie: string, name: string, track: boolean) {
    const server = await replica.app.inject({ method: "POST", url: "/api/mcp/servers", headers: { cookie }, payload: { name: "Mock", adapterId: "mock-mcp", probeEnabled: false } });
    expect(server.statusCode, server.body).toBe(201);
    const serverId = server.json<{ server: { id: string } }>().server.id;
    expect((await replica.app.inject({ method: "POST", url: `/api/mcp/servers/${serverId}/probe`, headers: { cookie } })).statusCode).toBe(200);
    const toolset = await replica.app.inject({
      method: "POST",
      url: "/api/mcp/toolsets",
      headers: { cookie },
      payload: { name, ...(track ? { trackSessionLabels: true } : {}), members: [{ kind: "server", serverId }] }
    });
    expect(toolset.statusCode, toolset.body).toBe(201);
    const created = toolset.json<{ toolset: McpToolset }>().toolset;
    const client = await replica.app.inject({ method: "POST", url: "/api/mcp/clients", headers: { cookie }, payload: { name: `${name} agent`, toolsetIds: [created.id], role: "builder" } });
    expect(client.statusCode, client.body).toBe(201);
    return { slug: created.slug, ...client.json<{ client: McpClient; token: string }>() };
  }

  async function modernCall(replica: Replica, slug: string, token: string, expression: string) {
    return replica.app.inject({
      method: "POST",
      url: `/mcp/${slug}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": "mock__calculator"
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mock__calculator", arguments: { expression }, _meta: META } })
    });
  }

  it("serves a modern caller on any replica without a session", async () => {
    const a = await addReplica("modern-a");
    const b = await addReplica("modern-b");
    const { slug, token } = await toolsetWithClient(a, await adminCookie(a), "Plain", false);
    const onA = await modernCall(a, slug, token, "2+3");
    expect(onA.statusCode, onA.body).toBe(200);
    expect(onA.json().result).toMatchObject({ resultType: "complete", structuredContent: { result: 5 } });
    const onB = await modernCall(b, slug, token, "4+4");
    expect(onB.statusCode, onB.body).toBe(200);
    expect(onB.json().result.structuredContent.result).toBe(8);
  });

  it("refuses modern callers on a toolset that tracks outside content, with an answer that sends dual-era clients to initialize", async () => {
    const a = await addReplica("track-a");
    const { slug, token } = await toolsetWithClient(a, await adminCookie(a), "Tracked", true);
    const refused = await modernCall(a, slug, token, "1+1");
    expect(refused.statusCode).toBe(400);
    const error = refused.json().error as { code: number; message: string };
    // Not one of the modern error codes: a dual-era client falls back to a session.
    expect(error.code).toBe(-32000);
    expect(error.message).toMatch(/^Mcp-Session-Id header is required; send initialize first\. Toolset '.*' tracks outside content per session/);
    // The session path still serves the same client.
    const headers = { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` };
    const init = await a.app.inject({
      method: "POST",
      url: `/mcp/${slug}`,
      headers,
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } })
    });
    expect(init.statusCode).toBe(200);
    const call = await a.app.inject({
      method: "POST",
      url: `/mcp/${slug}`,
      headers: { ...headers, "mcp-session-id": String(init.headers["mcp-session-id"]) },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mock__calculator", arguments: { expression: "1+1" } } })
    });
    expect(call.json().result.structuredContent.result).toBe(2);
  });
});
