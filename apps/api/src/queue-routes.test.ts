/**
 * Phase 13.1 — the queue as the API serves it, on one instance: `/ready` and the shutdown drain, `/enqueue` on a
 * replica without a consumer (WORKER_MODE=api), pools and backpressure on `/enqueue`, queue metrics, and the queue
 * settings that fail fast. Runs on the store TEST_STORE names (SQLite by default).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, resolveQueueSettings } from "./config.js";
import type { Store } from "./db/store.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore, testStoreKind } from "./test-support/test-store.js";

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
const stores: Store[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) {
    try {
      await store.close();
    } catch {
      // Already closed by its app.
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const workflow = (id: string, settings?: Workflow["settings"]): Workflow => ({
  id,
  name: id,
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  nodes: [
    { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hi" } },
    { id: "output", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { responseTemplate: "done" } }
  ],
  edges: [{ id: "e1", source: "input", target: "output" }],
  ...(settings ? { settings } : {})
});

interface Booted {
  app: FastifyInstance;
  store: Store;
  lifecycle: AppLifecycle;
  queue?: QueueService;
  login(role: "admin" | "builder" | "operator"): Promise<string>;
}

async function boot(env: Record<string, string> = {}, options: { queue?: boolean; queueConfig?: ConstructorParameters<typeof QueueService>[1] } = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-queue-routes-"));
  dirs.push(dir);
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  stores.push(store);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync"),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue === false ? undefined : new QueueService(store, { pollIntervalMs: 20, ...options.queueConfig });
  const lifecycle = new AppLifecycle();
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService, undefined, queue, undefined, { lifecycle });
  apps.push(app);
  await app.ready();
  const login = async (role: "admin" | "builder" | "operator") => {
    const email = `${role}@example.com`;
    const password = `${role}-Pass-123!`;
    if (!(await store.getUserByEmail(email))) await authService.register({ email, password, role });
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    const raw = response.headers["set-cookie"];
    return (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  };
  return { app, store, lifecycle, ...(queue ? { queue } : {}), login };
}

async function createWorkflow(booted: Booted, cookie: string, wf: Workflow): Promise<void> {
  const created = await booted.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: wf as unknown as Record<string, unknown> });
  expect(created.statusCode).toBeLessThan(300);
}

describe("readiness and the shutdown drain", () => {
  it("/ready is 200 until the drain starts, then 503; /health stays 200", async () => {
    const booted = await boot();
    const ready = await booted.app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true, reasons: [] });
    booted.lifecycle.addReadinessCheck("probe", () => null);
    expect((await booted.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await booted.lifecycle.drain(1_000);
    const draining = await booted.app.inject({ method: "GET", url: "/ready" });
    expect(draining.statusCode).toBe(503);
    expect(draining.json()).toEqual({ ready: false, reasons: ["draining"] });
    expect((await booted.app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("a failing readiness check makes /ready 503 with its reason", async () => {
    const booted = await boot();
    booted.lifecycle.addReadinessCheck("bus", () => "bus disconnected");
    const response = await booted.app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ready: false, reasons: ["bus disconnected"] });
  });

  it("the drain lets a queued run finish, and stops claiming afterwards", async () => {
    const booted = await boot();
    const cookie = await booted.login("builder");
    await createWorkflow(booted, cookie, workflow("wf-drain"));
    const queued = await booted.app.inject({ method: "POST", url: "/api/workflows/wf-drain/enqueue", headers: { cookie }, payload: {} });
    expect(queued.statusCode).toBe(200);
    const { executionId } = queued.json<{ executionId: string }>();
    await until(async () => (await booted.store.getExecutionHistory(executionId))?.status === "success", "the queued run");
    await booted.lifecycle.drain(5_000);
    expect(booted.queue!.freeSlots()).toBe(0);
    const later = await booted.app.inject({ method: "POST", url: "/api/workflows/wf-drain/enqueue", headers: { cookie }, payload: {} });
    expect(later.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await booted.store.getQueueDepth()).toMatchObject({ pending: 1, running: 0 });
  });
});

describe("enqueue", () => {
  it("an api replica (no consumer) accepts /enqueue on Postgres; on SQLite, where nothing else could run it, the routes stay off", async () => {
    const booted = await boot({ WORKER_MODE: "api" }, { queue: false });
    const cookie = await booted.login("builder");
    await createWorkflow(booted, cookie, workflow("wf-api"));
    const queued = await booted.app.inject({ method: "POST", url: "/api/workflows/wf-api/enqueue", headers: { cookie }, payload: {} });
    if (testStoreKind() === "sqlite") {
      expect(queued.statusCode).toBe(404);
      expect((await booted.app.inject({ method: "GET", url: "/api/queue/depth", headers: { cookie } })).statusCode).toBe(404);
      expect(await booted.store.getQueueDepth()).toEqual({ pending: 0, running: 0, dlq: 0 });
      return;
    }
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ queued: true, queueDepth: { pending: 1, running: 0, dlq: 0 } });
    expect((await booted.app.inject({ method: "GET", url: "/api/queue/depth", headers: { cookie } })).json()).toEqual({ pending: 1, running: 0, dlq: 0 });
    expect((await booted.app.inject({ method: "GET", url: "/api/queue/dlq", headers: { cookie } })).json()).toEqual([]);
  });

  it("a pool comes from the workflow's settings or, for builders, the body", async () => {
    // A consumer that does not poll during the test, so the jobs stay pending.
    const booted = await boot({}, { queueConfig: { pollIntervalMs: 600_000 } });
    const builder = await booted.login("builder");
    const operator = await booted.login("operator");
    await createWorkflow(booted, builder, workflow("wf-gpu", { executionPool: "gpu-local" }));
    await createWorkflow(booted, builder, workflow("wf-plain"));
    // The operator needs project access to run: the admin-made workflows live in the default project.
    const enqueue = (cookie: string, id: string, payload: Record<string, unknown> = {}) =>
      booted.app.inject({ method: "POST", url: `/api/workflows/${id}/enqueue`, headers: { cookie }, payload });
    expect((await enqueue(builder, "wf-gpu")).statusCode).toBe(200);
    expect((await enqueue(builder, "wf-plain", { pool: "sandbox" })).statusCode).toBe(200);
    expect((await enqueue(builder, "wf-plain", { pool: "no spaces" })).statusCode).toBe(400);
    const refused = await enqueue(operator, "wf-plain", { pool: "sandbox" });
    expect([403, 404]).toContain(refused.statusCode);
    expect(await booted.store.getQueueDepthByPool()).toEqual([
      { pool: "gpu-local", pending: 1, running: 0 },
      { pool: "sandbox", pending: 1, running: 0 }
    ]);
    // An invalid pool in the settings is refused when the workflow is saved.
    const invalid = await booted.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builder },
      payload: workflow("wf-bad", { executionPool: "bad pool" }) as unknown as Record<string, unknown>
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("QUEUE_MAX_PENDING turns a full pool's /enqueue into 429 with Retry-After", async () => {
    const booted = await boot({ QUEUE_MAX_PENDING: "2" }, { queueConfig: { pollIntervalMs: 600_000, maxPending: 2 } });
    const cookie = await booted.login("builder");
    await createWorkflow(booted, cookie, workflow("wf-full"));
    const enqueue = () => booted.app.inject({ method: "POST", url: "/api/workflows/wf-full/enqueue", headers: { cookie }, payload: {} });
    expect((await enqueue()).statusCode).toBe(200);
    expect((await enqueue()).statusCode).toBe(200);
    // The count is re-read at most once a second; it is refused once it is read at the limit.
    const refused = await until(async () => {
      const response = await enqueue();
      return response.statusCode === 429 ? response : null;
    }, "a refused enqueue");
    expect(refused.headers["retry-after"]).toBe("5");
    expect(refused.json()).toMatchObject({ pool: "default", error: expect.stringContaining("QUEUE_MAX_PENDING") });
  });

  it("/metrics reports queue depth, waits and free slots once sampled", async () => {
    const booted = await boot({}, { queueConfig: { pollIntervalMs: 20 } });
    const cookie = await booted.login("builder");
    await createWorkflow(booted, cookie, workflow("wf-metrics"));
    const queued = await booted.app.inject({ method: "POST", url: "/api/workflows/wf-metrics/enqueue", headers: { cookie }, payload: {} });
    const { executionId } = queued.json<{ executionId: string }>();
    await until(async () => (await booted.store.getExecutionHistory(executionId))?.status === "success", "the queued run");
    const metrics = (await booted.app.inject({ method: "GET", url: "/metrics" })).body;
    // Sampled at startup (empty queue, no pools yet), so the dead-letter gauge and the counter are present.
    expect(metrics).toContain("ao_queue_dlq 0");
    expect(metrics).toContain("ao_queue_lost_total 0");
    expect(metrics).toMatch(/ao_queue_wait_seconds_count 1/);
    expect(metrics).toMatch(/ao_worker_slots_free \d+/);
  });
});

describe("queue settings", () => {
  it("defaults keep today's behaviour and validate what is set", () => {
    expect(resolveQueueSettings({}, { clusterMode: false })).toEqual({
      concurrency: 5,
      pollIntervalMs: 1_000,
      heartbeatMs: 10_000,
      leaseMs: 45_000,
      reaperIntervalMs: 15_000,
      pools: ["default"],
      maxPending: 0,
      maxRssMb: 0,
      maxEventLoopLagMs: 0,
      shutdownDrainMs: 20_000,
      // No settings, no cluster: SIGTERM/SIGINT exit at once, as before.
      drainOnSignal: false
    });
    expect(resolveQueueSettings({}, { clusterMode: true }).drainOnSignal).toBe(true);
    expect(resolveQueueSettings({ SHUTDOWN_DRAIN_MS: 3_000 }, { clusterMode: false })).toMatchObject({ drainOnSignal: true, shutdownDrainMs: 3_000 });
    expect(resolveQueueSettings({ QUEUE_HEARTBEAT_MS: 20_000 }, { clusterMode: true }).leaseMs).toBe(60_000);
    expect(resolveQueueSettings({ QUEUE_POOLS: " gpu , default,gpu " }, { clusterMode: true }).pools).toEqual(["gpu", "default"]);
    expect(() => resolveQueueSettings({ QUEUE_POOLS: "gpu" }, { clusterMode: false })).toThrow(/QUEUE_POOLS needs cluster mode/);
    expect(() => resolveQueueSettings({ QUEUE_POOLS: "bad pool" }, { clusterMode: true })).toThrow(/QUEUE_POOLS entry/);
    expect(() => resolveQueueSettings({ QUEUE_HEARTBEAT_MS: 1_000, QUEUE_LEASE_MS: 1_500 }, { clusterMode: true })).toThrow(/at least twice/);
  });

  it("parseConfig reads the settings, treats empty values as unset and fails fast naming the setting", () => {
    const base = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };
    const parsed = parseConfig({ ...base, QUEUE_CONCURRENCY: "12", QUEUE_MAX_PENDING: "", SHUTDOWN_DRAIN_MS: "5000" });
    expect(parsed.QUEUE_CONCURRENCY).toBe(12);
    expect(parsed.QUEUE_MAX_PENDING).toBeUndefined();
    expect(parsed.SHUTDOWN_DRAIN_MS).toBe(5_000);
    expect(() => parseConfig({ ...base, QUEUE_CONCURRENCY: "0" })).toThrow(/QUEUE_CONCURRENCY/);
    expect(() => parseConfig({ ...base, QUEUE_POOLS: "gpu" })).toThrow(/QUEUE_POOLS needs cluster mode/);
    expect(() => parseConfig({ ...base, QUEUE_POOLS: "gpu", DB_TYPE: "postgres", DB_POSTGRESDB_HOST: "db", HA_ENABLED: "true" })).not.toThrow();
  });
});
