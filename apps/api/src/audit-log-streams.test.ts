/**
 * Every audit event reaches the log streams exactly once, whichever way it is recorded: through the request helper
 * (sign-ins), straight through AuditService.record (export destinations, MCP servers, budgets, ...), or by the
 * retention prune (its checkpoint). Before, events recorded with AuditService.record directly never reached them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuditService, type AuditEventInput } from "./services/audit-service.js";
import { AuthService } from "./services/auth-service.js";
import { LogStreamingService } from "./services/log-streaming-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-audit-streams-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync"),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, masterKey), authService);
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
  return { app, store, authService };
}

describe("audit events and log streams", () => {
  it("events recorded through the request helper and straight through AuditService.record each reach the streams once", async () => {
    const dispatched = vi.spyOn(LogStreamingService.prototype, "dispatchAudit");
    const { app, store, authService } = await boot();
    await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    const created = await app.inject({
      method: "POST",
      url: "/api/audit-export/destinations",
      headers: { cookie },
      payload: { name: "SIEM", kind: "http", config: { url: "https://siem.example.com/ingest" } }
    });
    expect(created.statusCode).toBe(200);

    const types = dispatched.mock.calls.map(([event]) => event.eventType);
    expect(types.filter((type) => type === "user.login")).toHaveLength(1);
    expect(types.filter((type) => type === "audit_export.destination.created")).toHaveLength(1);
    // Every stored entry was streamed once, and nothing was streamed that was not stored.
    const stored = (await store.listAuditLogs({ pageSize: 500 })).items.map((item) => item.eventType).sort();
    expect([...types].sort()).toEqual(stored);
  });

  it("streams events with the audit log off, as before", async () => {
    const dispatched = vi.spyOn(LogStreamingService.prototype, "dispatchAudit");
    const { app, store, authService } = await boot({ AUDIT_LOG_ENABLED: "false" });
    await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
    expect(dispatched.mock.calls.map(([event]) => event.eventType)).toContain("user.login");
    expect((await store.listAuditLogs()).total).toBe(0);
  });
});

describe("AuditService.setStream", () => {
  async function service(enabled = true): Promise<{ audit: AuditService; store: Store; sent: AuditEventInput[] }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-audit-stream-unit-"));
    const store = await openTestStore(path.join(dir, "orchestrator.db"));
    cleanups.push(async () => {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const audit = new AuditService(store, { enabled });
    const sent: AuditEventInput[] = [];
    audit.setStream(async (event) => {
      sent.push(event);
    });
    return { audit, store, sent };
  }

  it("sends each recorded event once, and a failing stream never fails the record", async () => {
    const { audit, store, sent } = await service();
    await audit.record({ category: "system", eventType: "budget.created", action: "create" });
    expect(sent.map((event) => event.eventType)).toEqual(["budget.created"]);
    audit.setStream(async () => {
      throw new Error("stream down");
    });
    await expect(audit.record({ category: "system", eventType: "budget.deleted", action: "delete" })).resolves.toMatchObject({ eventType: "budget.deleted" });
    expect((await store.listAuditLogs()).total).toBe(2);
  });

  it("streams the retention checkpoint a purge appends", async () => {
    const { audit, store, sent } = await service();
    await store.writeAuditLog({ id: "old", eventType: "x", category: "system", action: "x", outcome: "success", createdAt: "2001-01-01T00:00:00.000Z" });
    await store.writeAuditLog({ id: "new", eventType: "x", category: "system", action: "x", outcome: "success" });
    expect(await audit.purge({ before: "2020-01-01T00:00:00.000Z" })).toBe(1);
    expect(sent).toEqual([
      expect.objectContaining({ eventType: "audit.retention_checkpoint", category: "system", actor: { type: "system" }, metadata: expect.objectContaining({ firstRetainedId: "new", deleted: 1 }) })
    ]);
  });
});
