/**
 * 13.3 — the retention service inside the app: the start-up purge (old history goes, usage stays unless
 * USAGE_EVENTS_RETENTION_DAYS is set), its record and audit row, the admin view, and who may read it. Runs against the
 * store TEST_STORE names (SQLite by default; the Postgres suite runs it again).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RetentionAdminView } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { retentionRowSql } from "./test-support/retention-rows.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const OLD = "2001-01-01T00:00:00.000Z";
const NEW = "2100-01-01T00:00:00.000Z";

async function createTestContext(env: Record<string, string> = {}, seed: string[] = []): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-retention-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const sql = testSql(store);
  for (const statement of seed) await sql.run(statement);
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: "admin" | "builder" | "viewer"): Promise<string> {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

async function count(store: Store, table: string): Promise<number> {
  return Number((await testSql(store).get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
}

const SEED = [
  retentionRowSql("execution_history", "old-run", OLD),
  retentionRowSql("execution_history", "new-run", NEW),
  retentionRowSql("usage_events", "old-usage", OLD),
  retentionRowSql("usage_events", "new-usage", NEW),
  retentionRowSql("session_memory", "old-memory", OLD)
];

describe("retention in the app", () => {
  it("with nothing set: the start-up purge removes old history only, records itself and audits the counts", async () => {
    const context = await createTestContext({}, SEED);
    expect(await count(context.store, "execution_history")).toBe(1);
    // Usage rows and agent memory are kept: USAGE_EVENTS_RETENTION_DAYS and AGENT_MEMORY_RETENTION_DAYS default to keep.
    expect(await count(context.store, "usage_events")).toBe(2);
    expect(await count(context.store, "session_memory")).toBe(1);
    const runs = await context.store.listRetentionRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ reason: "startup", outcome: "ok", counts: { runs: 1 } });
    const audit = (await context.store.listAuditLogs({ eventType: "retention.purged", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ category: "system", resourceType: "retention", resourceId: runs[0]!.id });
    // The lease is given back after the purge.
    expect((await context.store.listLeases()).map((lease) => lease.leaseName)).not.toContain("retention");
  }, 60_000);

  it("USAGE_EVENTS_RETENTION_DAYS and AGENT_MEMORY_RETENTION_DAYS, once set, purge their rows", async () => {
    const context = await createTestContext({ USAGE_EVENTS_RETENTION_DAYS: "30", AGENT_MEMORY_RETENTION_DAYS: "30" }, SEED);
    expect(await count(context.store, "usage_events")).toBe(1);
    expect(await count(context.store, "session_memory")).toBe(0);
    expect((await context.store.listRetentionRuns(1))[0]?.counts).toEqual({ runs: 1, usage: 1, agent_memory: 1 });
  }, 60_000);

  it("GET /api/admin/retention: admins read the view; others are refused", async () => {
    const context = await createTestContext({ USAGE_EVENTS_RETENTION_DAYS: "365", RETENTION_MAX_DAYS: "3650" }, SEED);
    const admin = await login(context, "admin");
    const response = await context.app.inject({ method: "GET", url: "/api/admin/retention", headers: { cookie: admin } });
    expect(response.statusCode).toBe(200);
    const view = response.json<RetentionAdminView>();
    expect(view).toMatchObject({ maxRowsPerTick: 50_000, bounds: { minDays: 1, maxDays: 3650 }, intervalMs: 3_600_000 });
    expect(view.classes.find((entry) => entry.class === "runs")).toMatchObject({ setting: "EXECUTION_HISTORY_RETENTION_DAYS", days: 30, backlog: 0 });
    expect(view.classes.find((entry) => entry.class === "usage")).toMatchObject({ days: 365 });
    expect(view.classes.find((entry) => entry.class === "agent_memory")).toMatchObject({ days: 0, cutoff: null, backlog: null });
    expect(view.classes.map((entry) => entry.class)).toContain("captures");
    expect(view.classes.map((entry) => entry.class)).toContain("simulations");
    expect(view.lastRun).toMatchObject({ reason: "startup" });
    expect(view.nextRunAt).toBe(new Date(Date.parse(view.lastRun!.startedAt) + 3_600_000).toISOString());
    for (const role of ["builder", "viewer"] as const) {
      const cookie = await login(context, role);
      expect((await context.app.inject({ method: "GET", url: "/api/admin/retention", headers: { cookie } })).statusCode, role).toBe(403);
    }
    expect((await context.app.inject({ method: "GET", url: "/api/admin/retention" })).statusCode).toBe(401);
  }, 60_000);

  it("refuses to start with RETENTION_MAX_DAYS below RETENTION_MIN_DAYS", () => {
    expect(() => parseConfig({ RETENTION_MIN_DAYS: "30", RETENTION_MAX_DAYS: "7" })).toThrow(/RETENTION_MAX_DAYS/);
    expect(() => parseConfig({ RETENTION_MAX_ROWS_PER_TICK: "10" })).toThrow(/RETENTION_MAX_ROWS_PER_TICK/);
    expect(parseConfig({}).USAGE_EVENTS_RETENTION_DAYS).toBe(0);
  });
});
