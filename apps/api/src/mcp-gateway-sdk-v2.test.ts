/**
 * The official TypeScript SDK v2 client (`@modelcontextprotocol/client`, which speaks 2026-07-28) as an independent
 * modern oracle for the gateway, next to the legacy SDK client in mcp-gateway.test.ts. Real sockets, a real toolset.
 *
 * With MCP_GATEWAY_MODERN_PROTOCOL=on a client that probes (`auto`) or is pinned to 2026-07-28 talks to the
 * gateway without a session; with it off, `auto` falls back to the initialize handshake and a pinned client fails
 * with a typed error instead of getting a half-working connection.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface Fixture {
  app: FastifyInstance;
  store: Store;
  tempDir: string;
  url: URL;
  token: string;
  requests: Array<{ protocolVersion: string | undefined; session: string | undefined }>;
}

const fixtures: Fixture[] = [];
const clients: Client[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close().catch(() => undefined);
  while (fixtures.length > 0) {
    const fixture = fixtures.pop()!;
    await fixture.app.close().catch(() => undefined);
    await fixture.store.close().catch(() => undefined);
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

async function boot(modern: "on" | "off"): Promise<Fixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-gateway-sdk-v2-"));
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
    MCP_GATEWAY_MODERN_PROTOCOL: modern
  });
  const auth = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), auth);
  const requests: Fixture["requests"] = [];
  app.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/mcp/") && request.method === "POST") {
      requests.push({
        protocolVersion: request.headers["mcp-protocol-version"] as string | undefined,
        session: request.headers["mcp-session-id"] as string | undefined
      });
    }
  });
  await app.listen({ port: 0, host: "127.0.0.1" });

  await auth.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  const admin = async (url: string, payload?: Record<string, unknown>) => {
    const response = await app.inject({ method: "POST", url, headers: { cookie }, ...(payload ? { payload } : {}) });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  };
  const server = await admin("/api/mcp/servers", { name: "Mock", adapterId: "mock-mcp", probeEnabled: false });
  await admin(`/api/mcp/servers/${server.server.id}/probe`);
  const toolset = await admin("/api/mcp/toolsets", { name: "SDK v2", description: "SDK v2 oracle", members: [{ kind: "server", serverId: server.server.id }] });
  const client = await admin("/api/mcp/clients", { name: "SDK v2 agent", toolsetIds: [toolset.toolset.id], role: "builder" });
  const fixture: Fixture = {
    app,
    store,
    tempDir,
    url: new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp/${toolset.toolset.slug}`),
    token: client.token,
    requests
  };
  fixtures.push(fixture);
  return fixture;
}

function connect(fixture: Fixture, mode: "auto" | "legacy" | { pin: string }): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(fixture.url, { requestInit: { headers: { Authorization: `Bearer ${fixture.token}` } } });
  const client = new Client({ name: "sdk-v2-oracle", version: "1.0.0" }, { versionNegotiation: { mode } });
  clients.push(client);
  return { client, transport };
}

function textOf(result: unknown): string {
  return ((result as { content?: Array<{ text?: string }> }).content ?? []).map((entry) => entry.text ?? "").join("\n");
}

describe("SDK v2 client against the gateway", () => {
  it("talks 2026-07-28 with no session when modern mode is on", async () => {
    const fixture = await boot("on");
    const { client, transport } = connect(fixture, { pin: "2026-07-28" });
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("mock__calculator");
    const called = await client.callTool({ name: "mock__calculator", arguments: { expression: "2+3" } });
    expect(called.isError).not.toBe(true);
    expect(textOf(called)).toContain("5");

    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests.every((request) => request.protocolVersion === "2026-07-28")).toBe(true);
    expect(fixture.requests.every((request) => request.session === undefined)).toBe(true);
  });

  it("probes and picks 2026-07-28 in auto mode when modern mode is on", async () => {
    const fixture = await boot("on");
    const { client, transport } = connect(fixture, "auto");
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("falls back to the initialize handshake in auto mode when modern mode is off", async () => {
    const fixture = await boot("off");
    const { client, transport } = connect(fixture, "auto");
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(fixture.requests.some((request) => request.session !== undefined)).toBe(true);
    const called = await client.callTool({ name: "mock__calculator", arguments: { expression: "1+1" } });
    expect(textOf(called)).toMatch(/\b2\b/);
  });

  it("fails a client pinned to 2026-07-28 with a typed error when modern mode is off", async () => {
    const fixture = await boot("off");
    const { client, transport } = connect(fixture, { pin: "2026-07-28" });
    await expect(client.connect(transport)).rejects.toThrow(/version|protocol|400|Unsupported/i);
    expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
  });

  it("keeps serving the initialize handshake to a legacy-mode client when modern mode is on", async () => {
    const fixture = await boot("on");
    const { client, transport } = connect(fixture, "legacy");
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("mock__get_current_time");
  });
});
