/**
 * Phase 13.1 — two API instances on one Postgres database: each a full app with its own store (pool), scheduler and
 * trigger service. One is elected leader with the advisory lock, a cron fires once per tick however many instances
 * run, the standby takes over when the leader's lock connection is killed, and a webhook idempotency key runs the
 * workflow once across instances. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { ADVISORY_LOCK_CLASS_LEADER } from "./db/postgres/leader-lock.js";
import { AuthService } from "./services/auth-service.js";
import { LeaderElectionService } from "./services/leader-election-service.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { TriggerService } from "./services/trigger-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("two API instances on one Postgres database");

const quiet = () => undefined;

interface Instance {
  app: FastifyInstance;
  store: PostgresStore;
  scheduler: SchedulerService;
}

const jobCount = (scheduler: SchedulerService) => (scheduler as unknown as { jobs: Map<string, unknown> }).jobs.size;

/** Polls `read` until it returns a truthy value (an event with no hook of its own); fails after `timeoutMs`. */
async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, entry: WorkflowNode): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [entry, node("out", "output", { responseTemplate: "{{user_prompt}}" })],
    edges: [{ id: "e1", source: entry.id, target: "out" }]
  };
}

run("two API instances on one Postgres database", () => {
  let primary: TestStore | undefined;
  const instances: Instance[] = [];
  const tempDirs: string[] = [];
  let fires: Array<{ instance: number; at: number }> = [];

  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    fires = [];
  }, 60_000);

  async function start(count: number, overrides: Record<string, string> = {}): Promise<Instance[]> {
    primary = await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-two-instance-"));
    tempDirs.push(tempDir);
    for (let i = 0; i < count; i += 1) {
      const store = await openTestStoreTwin(primary, { maxConnections: 6 });
      const config = parseConfig({
        LOG_LEVEL: "warn",
        SEED_SAMPLE_WORKFLOWS: "false",
        SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        COOKIE_SECURE: "false",
        RATE_LIMIT_ENABLED: "false",
        MCP_PROBE_INTERVAL_MS: "0",
        GIT_SYNC_WORKDIR: path.join(tempDir, `sync-${i}`),
        HA_INSTANCE_ID: `instance-${i}`,
        HA_RENEW_INTERVAL_MS: "100",
        ...overrides
      });
      const scheduler = new SchedulerService(store, quiet);
      // Record each tick as it fires (the cron's own time), before the app's handler runs it.
      const setHandler = scheduler.setExecutionHandler.bind(scheduler);
      scheduler.setExecutionHandler = (handler) =>
        setHandler(async (input) => {
          fires.push({ instance: i, at: Date.now() });
          await handler(input);
        });
      const triggers = new TriggerService(store, quiet);
      const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), scheduler, undefined, triggers);
      await app.ready();
      instances.push({ app, store, scheduler });
    }
    return instances;
  }

  const cronSeconds = async (): Promise<number[]> => fires.map((fire) => fire.at);
  /**
   * The shortest gap between two fires, by any instance. The cron ticks every second; a tick fired twice (two
   * leaders, or two jobs for one schedule) shows a gap near zero. Timer jitter and a busy event loop move a fire by tens of milliseconds, not
   * a second.
   */
  const shortestGap = (): number => {
    const times = fires.map((fire) => fire.at).sort((x, y) => x - y);
    return Math.min(...times.slice(1).map((time, index) => time - times[index]!));
  };

  async function lockHolderPid(): Promise<number | null> {
    const pool = testStorePool(primary!);
    try {
      const found = await pool.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [ADVISORY_LOCK_CLASS_LEADER]
      );
      expect(found.rows.length).toBeLessThanOrEqual(1);
      return found.rows[0]?.pid ?? null;
    } finally {
      await pool.end();
    }
  }

  async function terminateLeaderConnection(): Promise<number> {
    const pid = await lockHolderPid();
    expect(pid).not.toBeNull();
    const pool = testStorePool(primary!);
    try {
      await pool.query(`SELECT pg_terminate_backend($1)`, [pid]);
      return pid!;
    } finally {
      await pool.end();
    }
  }

  it("one leader runs the schedules; a cron fires once per tick, and again once per tick after the leader's connection is killed", async () => {
    // Saved before the instances start, as after a deploy: both see it, only the leader registers it.
    const [a, b] = await start(2);
    await a!.store.upsertWorkflow(workflow("wf-cron", node("tick", "schedule_trigger", { cronExpression: "* * * * * *", timezone: "UTC", active: true })));
    await a!.scheduler.syncAllSchedules();
    await b!.scheduler.syncAllSchedules();
    const leader = await until(() => [a!, b!].find((instance) => jobCount(instance.scheduler) > 0), "a leader with the schedule");
    const standby = leader === a ? b! : a!;
    expect(jobCount(standby.scheduler)).toBe(0);

    await until(async () => (await cronSeconds()).length >= 3, "three scheduled runs");
    expect(shortestGap(), JSON.stringify(fires)).toBeGreaterThan(150);

    // Kill the leader's lock session: it steps down at once (its schedules stop), and whichever instance takes the
    // free lock first leads from then on, on a new session.
    const stopped = vi.spyOn(leader.scheduler, "stop");
    const killed = await terminateLeaderConnection();
    await until(() => stopped.mock.calls.length > 0, "the old leader to stop its schedules");
    const holder = await until(async () => {
      const pid = await lockHolderPid();
      return pid !== null && pid !== killed ? pid : null;
    }, "a new session to hold the lock");
    expect(holder).not.toBe(killed);
    await until(() => [a!, b!].filter((instance) => jobCount(instance.scheduler) > 0).length === 1, "one instance with the schedule again");
    expect(standby).toBeDefined();
    const taken = (await cronSeconds()).length;
    await until(async () => (await cronSeconds()).length >= taken + 3, "three runs after the failover");
    expect(shortestGap(), JSON.stringify(fires)).toBeGreaterThan(150);
  }, 90_000);

  it("the health output keeps its shape: enabled, one leader, the holder named by both", async () => {
    const [a, b] = await start(2);
    await until(async () => (await a!.store.getLease("primary"))?.holderId, "the lease row");
    const holder = (await a!.store.getLease("primary"))!.holderId;
    expect(["instance-0", "instance-1"]).toContain(holder);
    const authA = new AuthService(a!.store, 24);
    await authA.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
    const statuses = [];
    for (const instance of [a!, b!]) {
      const login = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
      const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
      const status = (await instance.app.inject({ method: "GET", url: "/api/ha/status", headers: { cookie } })).json<{
        leader: { enabled: boolean; isLeader: boolean; instanceId: string; leaseHolder: string | null };
      }>();
      statuses.push(status.leader);
    }
    expect(statuses.map((s) => s.enabled)).toEqual([true, true]);
    expect(statuses.filter((s) => s.isLeader)).toHaveLength(1);
    expect(statuses.map((s) => s.leaseHolder)).toEqual([holder, holder]);
  }, 60_000);

  it("a webhook idempotency key sent to both instances at once runs the workflow once", async () => {
    const [a, b] = await start(2);
    await a!.store.upsertWorkflow(
      workflow("wf-hook", node("hook", "webhook_input", { path: "hook-once", method: "POST", passThroughFields: ["user_prompt"], authMode: "none", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }))
    );
    for (let round = 0; round < 4; round += 1) {
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? a! : b!).app.inject({ method: "POST", url: "/webhook/hook-once", headers: { "idempotency-key": `key-${round}` }, payload: { user_prompt: `round ${round}` } })
        )
      );
      const fresh = responses.filter((r) => r.statusCode === 200 && r.json<{ idempotency?: { reused?: boolean } }>().idempotency?.reused === false);
      expect(fresh).toHaveLength(1);
      for (const response of responses) expect([200, 409]).toContain(response.statusCode);
    }
    const pool = testStorePool(primary!);
    try {
      const rows = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM execution_history WHERE workflow_id = 'wf-hook'`);
      expect(Number(rows.rows[0]!.n)).toBe(4);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("leader election alone: one holder at a time; stopping the holder hands the lock over", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const twins = [await openTestStoreTwin(primary), await openTestStoreTwin(primary)];
    const events: string[] = [];
    const services = twins.map(
      (store, i) =>
        new LeaderElectionService(store, {
          instanceId: `elect-${i}`,
          renewIntervalMs: 50,
          lock: store.leaderLock({ leaseName: "primary", holderId: `elect-${i}`, ttlMs: 1_000 }),
          onBecomeLeader: () => void events.push(`lead-${i}`),
          onResignLeader: () => void events.push(`resign-${i}`)
        })
    );
    try {
      await Promise.all(services.map((service) => service.start()));
      expect(services.filter((service) => service.isLeader())).toHaveLength(1);
      const first = services.findIndex((service) => service.isLeader());
      const other = 1 - first;
      await services[first]!.stop();
      await until(() => services[other]!.isLeader(), "the other instance to lead");
      expect(events).toEqual([`lead-${first}`, `resign-${first}`, `lead-${other}`]);
    } finally {
      for (const service of services) await service.stop();
      for (const store of twins) await store.close();
    }
  }, 60_000);
});
