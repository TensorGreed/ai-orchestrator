/**
 * Audit export destination headers (ingestion tokens) and log-stream webhook headers are secrets: sealed with the
 * master key at rest, masked in every answer, kept when an update sends the mask back, never written into the audit
 * log, and still sent to the endpoint. Header values stored in plain text by older releases are sealed at start-up.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { LogStreamingService } from "./services/log-streaming-service.js";
import { AUDIT_EXPORT_HEADERS_PURPOSE, AuditExportService } from "./services/audit-export-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

const TOKEN = "hec-token-1234567890";
const NEW_TOKEN = "hec-token-rotated-0987654321";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A local HTTP endpoint that records the headers of each request. */
async function receiver(): Promise<{ url: string; requests: Array<http.IncomingHttpHeaders> }> {
  const requests: Array<http.IncomingHttpHeaders> = [];
  const server = http.createServer((request, response) => {
    requests.push(request.headers);
    request.resume();
    request.on("end", () => response.end("ok"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/ingest`, requests };
}

async function boot(options: { before?: (store: Store) => Promise<void> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-audit-export-secrets-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  await options.before?.(store);
  const masterKey = crypto.randomBytes(32).toString("base64");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync"),
    AUDIT_EXPORT_FILE_ROOT: path.join(dir, "exports")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const secretService = new SecretService(store, masterKey);
  const app: FastifyInstance = await createApp(config, store, secretService, authService);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { app, store, cookie, secretService, masterKey, config };
}

describe("audit export destination headers", () => {
  it("are sealed at rest, masked on read, kept by the mask on update, scrubbed from the audit log and still delivered", async () => {
    const { app, store, cookie, secretService } = await boot();
    const sink = await receiver();
    const created = await app.inject({
      method: "POST",
      url: "/api/audit-export/destinations",
      headers: { cookie },
      payload: { name: "SIEM", kind: "http", config: { url: `${sink.url}?token=${TOKEN}`, headers: { Authorization: `Splunk ${TOKEN}`, "X-Tenant": "acme" } }, intervalSeconds: 300 }
    });
    expect(created.statusCode).toBe(200);
    const destination = created.json<{ destination: { id: string; config: Record<string, unknown> } }>().destination;
    expect(destination.config).toEqual({ url: `${sink.url}?token=${TOKEN}`, headers: { Authorization: "__secret__", "X-Tenant": "__secret__" } });

    // At rest: sealed, with the purpose bound.
    const row = await testSql(store).get<{ config_json: string }>(`SELECT config_json FROM audit_export_destinations WHERE id = ?`, destination.id);
    expect(row!.config_json).not.toContain(`Splunk ${TOKEN}`);
    const stored = JSON.parse(row!.config_json) as { headersSealed: string; headers?: unknown };
    expect(stored.headers).toBeUndefined();
    expect(JSON.parse(secretService.openValue(AUDIT_EXPORT_HEADERS_PURPOSE, stored.headersSealed))).toEqual({ Authorization: `Splunk ${TOKEN}`, "X-Tenant": "acme" });

    const listed = await app.inject({ method: "GET", url: "/api/audit-export/destinations", headers: { cookie } });
    expect(listed.body).not.toContain(`Splunk ${TOKEN}`);
    expect(listed.body).not.toContain("headersSealed");

    // Rotate the token, keep the tenant header by sending its mask back.
    const updated = await app.inject({
      method: "PUT",
      url: `/api/audit-export/destinations/${destination.id}`,
      headers: { cookie },
      payload: { config: { url: sink.url, headers: { Authorization: `Splunk ${NEW_TOKEN}`, "X-Tenant": "__secret__" } }, intervalSeconds: 60 }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain(NEW_TOKEN);

    // The audit log names what changed, never a value.
    const entries = await store.listAuditLogs({ resourceType: "audit_export_destination" });
    const serialized = JSON.stringify(entries.items);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(NEW_TOKEN);
    const update = entries.items.find((item) => item.eventType === "audit_export.destination.updated")!;
    expect(update.metadata).toEqual({
      fields: ["config", "intervalSeconds"],
      intervalSeconds: 60,
      configKeys: ["headers", "url"],
      urlHost: new URL(sink.url).host,
      headerNames: ["Authorization", "X-Tenant"]
    });

    await store.writeAuditLog({ id: "aud_payload", eventType: "x.y", category: "system", action: "x", outcome: "success" });
    const run = await app.inject({ method: "POST", url: `/api/audit-export/destinations/${destination.id}/run`, headers: { cookie } });
    expect(run.json<{ outcome: { status: string } }>().outcome.status).toBe("success");
    expect(sink.requests.at(-1)).toMatchObject({ authorization: `Splunk ${NEW_TOKEN}`, "x-tenant": "acme" });
  });

  it("refuses a mask for a header with no stored value, and a header value with a line break", async () => {
    const { app, cookie } = await boot();
    const create = (headers: Record<string, string>) =>
      app.inject({ method: "POST", url: "/api/audit-export/destinations", headers: { cookie }, payload: { name: "x", kind: "http", config: { url: "https://siem.example.com", headers } } });
    expect((await create({ Authorization: "__secret__" })).statusCode).toBe(400);
    expect((await create({ Authorization: "a\r\nX-Injected: 1" })).statusCode).toBe(400);
    expect((await create({ "Bad Name": "v" })).statusCode).toBe(400);
  });

  it("header values stored in plain text by an older release are sealed at start-up", async () => {
    const { app, store, cookie, secretService } = await boot({
      before: async (store) => {
        await store.createAuditExportDestination({
          id: "axd-legacy",
          name: "legacy",
          kind: "http",
          config: { url: "https://siem.example.com/ingest", headers: { Authorization: `Bearer ${TOKEN}` } },
          intervalSeconds: 300
        });
      }
    });
    const row = await testSql(store).get<{ config_json: string }>(`SELECT config_json FROM audit_export_destinations WHERE id = 'axd-legacy'`);
    expect(row!.config_json).not.toContain(TOKEN);
    const stored = JSON.parse(row!.config_json) as { headersSealed: string };
    expect(JSON.parse(secretService.openValue(AUDIT_EXPORT_HEADERS_PURPOSE, stored.headersSealed))).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const listed = await app.inject({ method: "GET", url: "/api/audit-export/destinations", headers: { cookie } });
    expect(listed.json<{ destinations: Array<{ config: unknown }> }>().destinations[0]!.config).toEqual({
      url: "https://siem.example.com/ingest",
      headers: { Authorization: "__secret__" }
    });
    // Running it again changes nothing.
    expect(await new AuditExportService(store, { sealer: secretService }).sealStoredHeaders()).toBe(0);
  });
});

describe("log stream webhook headers", () => {
  it("are masked on read and kept by the mask on update, and still sent", async () => {
    const { store, masterKey } = await boot();
    const sink = await receiver();
    const service = new LogStreamingService(store, masterKey, { enabled: true });
    const created = await service.createDestination({
      name: "hook",
      type: "webhook",
      config: { url: sink.url, headers: { Authorization: `Bearer ${TOKEN}` } }
    });
    expect(created.config).toEqual({ url: sink.url, headers: { Authorization: "__secret__" } });
    expect(JSON.stringify(await service.listDestinations())).not.toContain(TOKEN);
    await expect(
      service.createDestination({ name: "bad", type: "webhook", config: { url: sink.url, headers: { Authorization: "__secret__" } } })
    ).rejects.toThrow(/cannot be '__secret__'/);

    const updated = await service.updateDestination(created.id, { config: { url: sink.url, headers: { Authorization: "__secret__", "X-Extra": "1" } } });
    expect(updated!.config).toEqual({ url: sink.url, headers: { Authorization: "__secret__", "X-Extra": "__secret__" } });
    await expect(service.updateDestination(created.id, { config: { url: sink.url, headers: { Other: "__secret__" } } })).rejects.toThrow(/no stored value/);

    expect(await service.test(created.id)).toEqual({ ok: true });
    expect(sink.requests.at(-1)).toMatchObject({ authorization: `Bearer ${TOKEN}`, "x-extra": "1" });
  });
});
