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
import { LEADER_APPLICATION_NAME, type PostgresStore } from "./db/postgres-store.js";
import { ADVISORY_LOCK_CLASS_LEADER } from "./db/postgres/leader-lock.js";
import { AuthService } from "./services/auth-service.js";
import { LeaderElectionService } from "./services/leader-election-service.js";
import { QueueService } from "./services/queue-service.js";
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
  triggers: TriggerService;
  queue?: QueueService;
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

/** A webhook-started run that pauses at an approval gate, then answers "sent" once approved. */
function gateWorkflow(id: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("gate", "approval_gate", { message: "Send?", approverRoles: ["builder", "admin"], timeoutMinutes: 60, timeoutOutcome: "reject" }),
      node("sent", "output", { responseTemplate: "sent" }),
      node("stopped", "output", { responseTemplate: "rejected" })
    ],
    edges: [
      { id: "e1", source: "hook", target: "gate" },
      { id: "e2", source: "gate", sourceHandle: "approved", target: "sent" },
      { id: "e3", source: "gate", sourceHandle: "rejected", target: "stopped" }
    ]
  } as Workflow;
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
  /** Every tick fired (no `event`), and, for a failure message, when each scheduler registered and stopped. */
  let fires: Array<{ instance: number; at: number; event?: string }> = [];

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

  async function start(count: number, overrides: Record<string, string> = {}, options: { queue?: boolean } = {}): Promise<Instance[]> {
    primary = await createTestStore({ kind: "postgres" });
    for (let i = 0; i < count; i += 1) await addInstance(i, overrides, options);
    return instances;
  }

  /** Boots one more full app on the primary's database (a deploy that brings an instance up later). */
  async function addInstance(i: number, overrides: Record<string, string> = {}, options: { queue?: boolean } = {}): Promise<Instance> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-two-instance-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary!, { maxConnections: 6 });
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
    const scheduler = new SchedulerService(store, (_level, message) => {
      if (message === "Registered schedule") fires.push({ instance: i, at: Date.now(), event: "registered" });
    });
    const stopScheduler = scheduler.stop.bind(scheduler);
    scheduler.stop = () => {
      fires.push({ instance: i, at: Date.now(), event: "stopped" });
      stopScheduler();
    };
    // Record each tick as it fires (the cron's own time), before the app's handler runs it.
    const setHandler = scheduler.setExecutionHandler.bind(scheduler);
    scheduler.setExecutionHandler = (handler) =>
      setHandler(async (input) => {
        fires.push({ instance: i, at: Date.now() });
        await handler(input);
      });
    const triggers = new TriggerService(store, quiet);
    const queue = options.queue ? new QueueService(store, { pollIntervalMs: 50 }) : undefined;
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), scheduler, queue, triggers);
    await app.ready();
    const instance = { app, store, scheduler, triggers, ...(queue ? { queue } : {}) };
    instances.push(instance);
    return instance;
  }

  async function stopInstance(instance: Instance): Promise<void> {
    instances.splice(instances.indexOf(instance), 1);
    await instance.app.close();
    await instance.store.close();
  }

  async function loginAs(instance: Instance, role: "admin" | "builder", name: string): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await instance.store.getUserByEmail(email))) await new AuthService(instance.store, 24).register({ email, password, role });
    const login = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  const ticks = () => fires.filter((fire) => !fire.event);
  const cronSeconds = async (): Promise<number[]> => ticks().map((fire) => fire.at);
  /**
   * The shortest gap between two fires, by any instance. The cron ticks every second; a tick fired twice (two
   * leaders, or two jobs for one schedule) shows a gap near zero. Timer jitter and a busy event loop move a fire by tens of milliseconds, not
   * a second.
   */
  const shortestGap = (): number => {
    const times = ticks().map((fire) => fire.at).sort((x, y) => x - y);
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

  it("an instance booting as leader leaves alone an approval resume another instance is running", async () => {
    // B paused a run at an approval gate; a user approved it on B, and B claimed it (resuming) and is running it.
    const [b] = await start(1);
    const cookie = await loginAs(b!, "builder", "builder");
    await b!.store.upsertWorkflow(gateWorkflow("wf-gate"));
    const run = (await b!.app.inject({ method: "POST", url: "/api/workflows/wf-gate/execute", headers: { cookie }, payload: { user_prompt: "Ana" } })).json<{
      status: string;
      executionId: string;
    }>();
    expect(run.status).toBe("waiting_approval");
    const pool = testStorePool(primary!);
    try {
      await pool.query(`UPDATE workflow_executions SET status = 'resuming', updated_at = $2 WHERE id = $1`, [run.executionId, new Date().toISOString()]);
      await pool.query(`UPDATE approval_requests SET status = 'approved', decided_by = 'builder@example.com', decided_at = $2 WHERE execution_id = $1`, [
        run.executionId,
        new Date().toISOString()
      ]);
    } finally {
      await pool.end();
    }
    // A rolling deploy: B's lock frees for a moment and A, booting, takes it. A's startup recovery must not re-drive
    // B's resume (its nodes after the gate would run twice): on a shared database only a stale claim is recovered.
    await stopInstance(b!);
    const a = await addInstance(1);
    await until(async () => (await a.store.getLease("primary"))?.holderId === "instance-1", "A to lead");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect((await a.store.getWorkflowExecutionState(run.executionId))?.status).toBe("resuming");
    expect((await a.store.getExecutionHistory(run.executionId))?.status).not.toBe("success");
  }, 60_000);

  it("a trigger on the leader runs the workflow as saved through the other instance, not the one it registered", async () => {
    const [a, b] = await start(2);
    const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-two-instance-watch-"));
    tempDirs.push(watchDir);
    // An empty folder is no baseline (the trigger fires only once it has seen a file).
    fs.writeFileSync(path.join(watchDir, "existing.txt"), "before");
    const fileWorkflow = (answer: string): Workflow => ({
      ...workflow("wf-file", node("watch", "file_trigger", { watchPath: watchDir, pollIntervalSeconds: 1, events: ["created"], active: true })),
      nodes: [
        node("watch", "file_trigger", { watchPath: watchDir, pollIntervalSeconds: 1, events: ["created"], active: true }),
        node("out", "output", { responseTemplate: answer })
      ]
    });
    await a!.store.upsertWorkflow(fileWorkflow("answer from v1"));
    await a!.triggers.syncAllWorkflows();
    await b!.triggers.syncAllWorkflows();
    const activeTriggers = (instance: Instance) => (instance.triggers as unknown as { active: Map<string, unknown> }).active.size;
    const leader = await until(() => [a!, b!].find((instance) => activeTriggers(instance) > 0), "a leader with the trigger");
    const other = leader === a ? b! : a!;
    expect(activeTriggers(other)).toBe(0);
    // The trigger's first poll records the folder's baseline; files after it fire.
    await until(async () => await leader.store.getTriggerState("wf-file", "watch"), "the trigger's baseline");

    // Saved through the instance that is not the leader: the trigger node is unchanged, so the leader keeps its trigger.
    const cookie = await loginAs(other, "admin", "admin");
    const saved = await other.app.inject({ method: "PUT", url: "/api/workflows/wf-file", headers: { cookie }, payload: fileWorkflow("answer from v2") });
    expect(saved.statusCode).toBe(200);
    fs.writeFileSync(path.join(watchDir, "new.txt"), "hello");

    const pool = testStorePool(primary!);
    try {
      const row = await until(async () => {
        const rows = await pool.query<{ output_json: string | null; status: string; error: string | null }>(`SELECT output_json, status, error FROM execution_history WHERE workflow_id = 'wf-file'`);
        // The progress hooks write the row as the run starts; wait for its end.
        return rows.rows.find((entry) => entry.status !== "running");
      }, "the triggered run");
      expect(row.output_json, JSON.stringify(row)).toContain("answer from v2");
      expect(row.output_json).not.toContain("answer from v1");
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("a trigger the other instance disconnected does not run on the leader before the next sync", async () => {
    const [a, b] = await start(2);
    const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-two-instance-watch-"));
    tempDirs.push(watchDir);
    fs.writeFileSync(path.join(watchDir, "existing.txt"), "before");
    const watch = node("watch", "file_trigger", { watchPath: watchDir, pollIntervalSeconds: 1, events: ["created"], active: true });
    const connected: Workflow = { ...workflow("wf-file", watch), nodes: [watch, node("out", "output", { responseTemplate: "ran" })] };
    await a!.store.upsertWorkflow(connected);
    await a!.triggers.syncAllWorkflows();
    await b!.triggers.syncAllWorkflows();
    const activeTriggers = (instance: Instance) => (instance.triggers as unknown as { active: Map<string, unknown> }).active.size;
    const leader = await until(() => [a!, b!].find((instance) => activeTriggers(instance) > 0), "a leader with the trigger");
    const other = leader === a ? b! : a!;
    await until(async () => await leader.store.getTriggerState("wf-file", "watch"), "the trigger's baseline");
    const skipped = vi.spyOn(leader.app.log, "debug");

    // Saved through the other instance with the trigger node left active but no longer wired to anything.
    const cookie = await loginAs(other, "admin", "admin");
    const saved = await other.app.inject({ method: "PUT", url: "/api/workflows/wf-file", headers: { cookie }, payload: { ...connected, edges: [] } });
    expect(saved.statusCode).toBe(200);
    expect(activeTriggers(leader)).toBe(1); // the leader still has it until its next sync
    fs.writeFileSync(path.join(watchDir, "new.txt"), "hello");

    await until(
      () => skipped.mock.calls.some((call) => String(call[1] ?? "").includes("Skipped triggered execution")),
      "the fire to be skipped",
      10_000
    );
    const pool = testStorePool(primary!);
    try {
      const rows = await pool.query(`SELECT id FROM execution_history WHERE workflow_id = 'wf-file'`);
      expect(rows.rows).toEqual([]);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("only the leader re-queues stuck jobs", async () => {
    const [a, b] = await start(2, {}, { queue: true });
    await until(async () => (await a!.store.getLease("primary"))?.holderId, "the lease row");
    const holder = (await a!.store.getLease("primary"))!.holderId;
    const leader = holder === "instance-0" ? a! : b!;
    const standby = leader === a ? b! : a!;
    const sweeps = [leader, standby].map((instance) => vi.spyOn(instance.store, "requeueStuckItems"));
    for (const instance of [leader, standby]) await (instance.queue as unknown as { sweepStuck(): Promise<void> }).sweepStuck();
    expect(sweeps.map((spy) => spy.mock.calls.length)).toEqual([1, 0]);
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

      // Checks asked for at once share one check: one dedicated connection, never a second one asking for the lock.
      const extra = twins[first]!.leaderLock({ leaseName: "other-lease", holderId: "extra", ttlMs: 1_000 });
      expect(await Promise.all(Array.from({ length: 5 }, () => extra.check()))).toEqual([true, true, true, true, true]);
      const pool = testStorePool(primary!);
      try {
        const sessions = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1`,
          [LEADER_APPLICATION_NAME]
        );
        // The other instance's lock and this one.
        expect(Number(sessions.rows[0]!.n)).toBe(2);
      } finally {
        await pool.end();
      }
      await extra.release();
    } finally {
      for (const service of services) await service.stop();
      for (const store of twins) await store.close();
    }
  }, 60_000);
});
