/**
 * Boots the real API (temp SQLite database) with one mock MCP server behind one toolset and prints the gateway URL
 * as a single JSON line on stdout once it is listening:
 *
 *   tsx conformance/boot-gateway.ts --modern on|off [--port 4170]
 *
 * The conformance CLI cannot send an Authorization header, so a small forwarding proxy in front of the app adds the
 * client token. The process runs until it is killed (SIGTERM / SIGINT close the app and delete the temp directory).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { parseConfig } from "../src/config.js";
import { openTestStore } from "../src/test-support/test-store.js";
import { AuthService } from "../src/services/auth-service.js";
import { SecretService } from "../src/services/secret-service.js";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : fallback;
}

// The suite always runs on SQLite, whatever the developer's shell sets for the Postgres test stores.
delete process.env.TEST_POSTGRES_URL;
delete process.env.TEST_STORE;

const modern = flag("--modern", "on") === "on" ? "on" : "off";
const proxyPort = Number(flag("--port", "0"));

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-conformance-"));
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
await app.listen({ port: 0, host: "127.0.0.1" });
const appPort = (app.server.address() as AddressInfo).port;

await auth.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
async function admin(method: "POST", url: string, payload: Record<string, unknown>): Promise<any> {
  const res = await app.inject({ method, url, headers: { cookie }, payload });
  if (res.statusCode >= 300) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.json();
}
const server = await admin("POST", "/api/mcp/servers", { name: "Mock", adapterId: "mock-mcp", probeEnabled: false });
await app.inject({ method: "POST", url: `/api/mcp/servers/${server.server.id}/probe`, headers: { cookie } });
const toolset = await admin("POST", "/api/mcp/toolsets", { name: "Conformance", description: "Conformance toolset", members: [{ kind: "server", serverId: server.server.id }] });
const client = await admin("POST", "/api/mcp/clients", { name: "Conformance agent", toolsetIds: [toolset.toolset.id], role: "builder" });
const token: string = client.token;

const proxy = http.createServer((req, res) => {
  const upstream = http.request(
    { host: "127.0.0.1", port: appPort, method: req.method, path: req.url, headers: { ...req.headers, authorization: `Bearer ${token}` } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
const port = (proxy.address() as AddressInfo).port;

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  proxy.closeAllConnections();
  proxy.close();
  await app.close().catch(() => undefined);
  await store.close().catch(() => undefined);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}/mcp/${toolset.toolset.slug}`, modern })}\n`);
