/**
 * MCP 2026-07-28 at the gateway in cluster mode (HA_ENABLED on one Postgres database): modern callers need no sticky
 * sessions, so any replica serves them. On a toolset that tracks outside content per session, a caller's label mark
 * is stored (v71) and shared: what a call on one replica returned decides how the next call is checked on another,
 * and no replica can lose it. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mcpSafetyPresetRuleId, type McpClient, type McpToolset } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

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

  async function addReplica(name: string, env: Record<string, string> = {}): Promise<Replica> {
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
      MCP_GATEWAY_MODERN_PROTOCOL: "on",
      ...env
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
    return { slug: created.slug, toolsetId: created.id, serverId, ...client.json<{ client: McpClient; token: string }>() };
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

  async function holdWrites(replica: Replica, cookie: string) {
    expect((await replica.app.inject({ method: "POST", url: "/api/mcp/policies/presets/untrusted_write_approval", headers: { cookie } })).statusCode).toBe(201);
    const enforce = await replica.app.inject({ method: "POST", url: `/api/mcp/policies/${mcpSafetyPresetRuleId("untrusted_write_approval")}/enforce`, headers: { cookie } });
    expect(enforce.statusCode).toBe(200);
  }

  it("shares a tracking caller's label mark: a result on one replica holds the next write on another", async () => {
    const a = await addReplica("track-a");
    const b = await addReplica("track-b");
    const cookie = await adminCookie(a);
    const { slug, token, client } = await toolsetWithClient(a, cookie, "Tracked", true);
    await holdWrites(a, cookie);

    // The tainting call on A, the next write on B: held, though B never saw the caller.
    const onA = await modernCall(a, slug, token, "1+1");
    expect(onA.statusCode, onA.body).toBe(200);
    expect(onA.json().result.structuredContent.result).toBe(2);
    const onB = await modernCall(b, slug, token, "6*7");
    expect(onB.json().error, onB.body).toMatchObject({ code: -31030 });
    // And back on A (its own state also holds the mark, but so does the store).
    expect((await modernCall(a, slug, token, "2*2")).json().error.code).toBe(-31030);

    // B's admin view shows the caller from the stored mark.
    const panel = await b.app.inject({ method: "GET", url: `/api/mcp/clients/${client.id}/sessions`, headers: { cookie } });
    expect(panel.json().callers).toEqual([expect.objectContaining({ tracked: true, labels: { provenance: ["untrusted_external"], dataClasses: [] }, protocolVersion: MODERN })]);
    // The raise was audited once in the cluster.
    const raised = await a.store.listAuditLogs({ eventType: "mcp_gateway.session_labels_raised", pageSize: 50 });
    expect(raised.items).toHaveLength(1);
  });

  it("lets a legacy session on one replica take up the labels raised on another without renewing them, and records it once", async () => {
    const a = await addReplica("legacy-a");
    const b = await addReplica("legacy-b");
    const cookie = await adminCookie(a);
    const { slug, token, client, toolsetId } = await toolsetWithClient(a, cookie, "Legacy", true);
    await holdWrites(a, cookie);
    const legacy = (session: string | null, body: Record<string, unknown>) =>
      b.app.inject({
        method: "POST",
        url: `/mcp/${slug}`,
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) },
        payload: JSON.stringify({ jsonrpc: "2.0", ...body })
      });
    // A session on B opens while the client is clean.
    const opened = await legacy(null, { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } });
    expect(opened.statusCode, opened.body).toBe(200);
    const sessionId = String(opened.headers["mcp-session-id"]);
    // The client's stateless call on A raises the stored mark; pin its last call ten minutes back.
    expect((await modernCall(a, slug, token, "1+1")).json().result.structuredContent.result).toBe(2);
    const lastSeen = new Date(Date.now() - 10 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await testSql(a.store).run(`UPDATE mcp_gateway_label_marks SET last_seen_at = ?, expires_at = ? WHERE client_id = ?`, lastSeen, expiresAt, client.id);

    // B's session calls twice: both writes are held, read from A's raise.
    for (const id of [2, 3]) {
      const call = await legacy(sessionId, { id, method: "tools/call", params: { name: "mock__calculator", arguments: { expression: "2+2" } } });
      expect(call.json().error, call.body).toMatchObject({ code: -32030 });
    }
    // The reads did not renew the client's mark: B's panel still shows the stateless caller as seen ten minutes ago.
    const [stored] = await b.store.listMcpGatewayLabelMarks({ clientId: client.id }, new Date().toISOString());
    expect(stored).toMatchObject({ toolsetId, provenance: ["untrusted_external"] });
    expect(Date.parse(stored!.lastSeenAt)).toBe(Date.parse(lastSeen));
    expect(Date.parse(stored!.expiresAt)).toBe(Date.parse(expiresAt));
    const panel = await b.app.inject({ method: "GET", url: `/api/mcp/clients/${client.id}/sessions`, headers: { cookie } });
    expect(panel.json().callers).toEqual([expect.objectContaining({ lastSeenAt: stored!.lastSeenAt })]);

    // One inherited event for the session, one raise for the stored mark (by A's stateless call).
    const inherited = await a.store.listAuditLogs({ eventType: "mcp_gateway.session_labels_inherited", pageSize: 50 });
    expect(inherited.items).toHaveLength(1);
    expect(inherited.items[0]!.metadata).toMatchObject({ sessionId, source: "stored_mark", at: "tool_call", labels: { provenance: ["untrusted_external"], dataClasses: [] } });
    const raised = await a.store.listAuditLogs({ eventType: "mcp_gateway.session_labels_raised", pageSize: 50 });
    expect(raised.items.map((entry) => (entry.metadata as { sessionId?: string } | undefined)?.sessionId ?? null)).toEqual([null]);
  });

  it("keeps every label when replicas raise one caller's mark at once, and a revoke on one replica clears it for all", async () => {
    const a = await addReplica("race-a");
    const b = await addReplica("race-b");
    const cookie = await adminCookie(a);
    const { slug, token, client, toolsetId } = await toolsetWithClient(a, cookie, "Raced", true);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const key = { clientId: client.id, toolsetId, scopeKey: String(client.createdBy ?? "") };
    // Twenty raises from the two replicas' stores at once, each with its own class.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? a : b).store.raiseMcpGatewayLabelMark({ ...key, provenance: ["untrusted_external"], dataClasses: [`pii.c${index}`], now, expiresAt })
      )
    );
    const mark = await b.store.readMcpGatewayLabelMark(key, { now, expiresAt });
    expect(mark?.dataClasses).toHaveLength(20);
    expect(mark?.raiseAudited).toBe(true);

    // The caller's mark is the one the gateway uses: a write on either replica is checked with it.
    await holdWrites(a, cookie);
    expect((await modernCall(b, slug, token, "1+1")).json().error.code).toBe(-31030);

    // Revoked on B: the stored mark is gone for A too.
    expect((await b.app.inject({ method: "POST", url: `/api/mcp/clients/${client.id}/revoke`, headers: { cookie } })).statusCode).toBe(200);
    expect(await a.store.listMcpGatewayLabelMarks({ clientId: client.id }, new Date().toISOString())).toEqual([]);
  });

  it("counts results from before tracking was switched on, whichever replica returned them", async () => {
    const a = await addReplica("late-a");
    const b = await addReplica("late-b");
    const cookie = await adminCookie(a);
    const { slug, token, toolsetId } = await toolsetWithClient(a, cookie, "Late", false);
    await holdWrites(a, cookie);
    expect((await modernCall(a, slug, token, "1+1")).json().result.structuredContent.result).toBe(2);
    const update = await a.app.inject({ method: "PUT", url: `/api/mcp/toolsets/${toolsetId}`, headers: { cookie }, payload: { trackSessionLabels: true } });
    expect(update.statusCode).toBe(200);
    // B never served the caller: the stored note makes the earlier result count as outside content.
    expect((await modernCall(b, slug, token, "2+2")).json().error.code).toBe(-31030);
  });

  it("tells a listen stream on one replica about a tool rule saved on another, over the cluster bus", async () => {
    // No periodic check on either replica: only the bus can carry the change.
    const a = await addReplica("listen-a", { MCP_GATEWAY_LISTEN_CHECK_MS: "0" });
    const b = await addReplica("listen-b", { MCP_GATEWAY_LISTEN_CHECK_MS: "0" });
    await b.app.listen({ port: 0, host: "127.0.0.1" });
    const cookie = await adminCookie(a);
    const { slug, token, serverId } = await toolsetWithClient(a, cookie, "Watched", false);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${(b.app.server.address() as AddressInfo).port}/mcp/${slug}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "subscriptions/listen"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "fleet-1", method: "subscriptions/listen", params: { notifications: { toolsListChanged: true }, _meta: META } })
    });
    expect(response.status).toBe(200);
    let text = "";
    const reader = response.body!.getReader();
    const pump = (async () => {
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
    const messages = () => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out; stream so far: ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    await until(() => messages().length === 1);
    expect(messages()[0]!.params.notifications).toEqual({ toolsListChanged: true });

    const rule = await a.app.inject({
      method: "POST",
      url: "/api/mcp/policies",
      headers: { cookie },
      payload: { name: "No calculator for builders", effect: "deny", roles: ["builder"], serverId, toolPattern: "calculator" }
    });
    expect(rule.statusCode, rule.body).toBe(201);
    await until(() => messages().some((message) => message.method === "notifications/tools/list_changed"));
    expect(messages()[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": "fleet-1" } } });
    controller.abort();
    await pump;
  });
});
