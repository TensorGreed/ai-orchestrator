/**
 * Phase 13.1 — cluster signalling with in-process replicas on one Postgres database (each a full app with its own
 * store and pool): a cancel on one instance stops the run executing on another (over the bus, and by the cancel check
 * when the message is lost or the listener was down), the registry lists every instance, several instances leading
 * with HA off raise the warning, only one instance at a time exports an audit destination, a save on a standby reaches
 * the leader's scheduler at once, and the leader fails the runs of an instance that stopped beating. With the queue
 * lane: a queued run under a live lease is never failed by the dead-executor reconcile, and a queued run canceled
 * both over the bus and by the queue heartbeat's check is stopped once. Postgres only (skipped without
 * TEST_POSTGRES_URL).
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
import { AuthService } from "./services/auth-service.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { TriggerService } from "./services/trigger-service.js";
import { QueueService } from "./services/queue-service.js";
import { DEAD_EXECUTOR_RUN_ERROR } from "./services/instance-registry.js";
import { REMOTE_CANCEL_REASON } from "./services/cluster-signals.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("cluster signalling across API instances");

interface Instance {
  id: string;
  app: FastifyInstance;
  store: PostgresStore;
  /** Absent on an `api`/`webhook` replica (no background workers), as in index.ts. */
  scheduler: SchedulerService | undefined;
  queue: QueueService | undefined;
}

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

/** A run that waits `ms` before answering. */
function waitingWorkflow(id: string, ms: number): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("wait", "wait_node", { delayMs: ms, maxDelayMs: ms }), node("out", "output", { responseTemplate: "done" })],
    edges: [{ id: "e1", source: "wait", target: "out" }]
  };
}

const jobCount = (scheduler: SchedulerService | undefined) => (scheduler as unknown as { jobs: Map<string, unknown> } | undefined)?.jobs.size ?? 0;

run("cluster signalling across API instances on one Postgres database", () => {
  let primary: TestStore | undefined;
  const instances: Instance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function addInstance(
    i: number,
    overrides: Record<string, string> = {},
    options: { queue?: boolean; beforeApp?: (queue: QueueService) => void } = {}
  ): Promise<Instance> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-cluster-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 6 });
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      HA_INSTANCE_ID: `instance-${i}`,
      HA_ENABLED: "true",
      HA_RENEW_INTERVAL_MS: "100",
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "1500",
      // The bus is what stops runs in these tests unless a test turns the backstop on.
      CLUSTER_CANCEL_CHECK_MS: "0",
      ...overrides
    });
    const background = config.WORKER_MODE === "all" || config.WORKER_MODE === "worker";
    const scheduler = background ? new SchedulerService(store, () => undefined) : undefined;
    const triggers = background ? new TriggerService(store, () => undefined) : undefined;
    const queue = background && options.queue ? new QueueService(store, { pollIntervalMs: 50 }) : undefined;
    if (queue) options.beforeApp?.(queue);
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), scheduler, queue, triggers);
    await app.ready();
    const instance = { id: `instance-${i}`, app, store, scheduler, queue };
    instances.push(instance);
    return instance;
  }

  async function start(count: number, overrides: Record<string, string> = {}): Promise<Instance[]> {
    const started: Instance[] = [];
    for (let i = 0; i < count; i += 1) started.push(await addInstance(i, overrides));
    return started;
  }

  async function loginAs(instance: Instance, role: "admin" | "builder", name: string): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await instance.store.getUserByEmail(email))) await new AuthService(instance.store, 24).register({ email, password, role });
    const login = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  /** Starts a long run on `on` and returns its execution id once it is running, with the pending response. */
  async function startLongRun(on: Instance, workflowId: string): Promise<{ executionId: string; response: Promise<{ statusCode: number; body: string }> }> {
    await on.store.upsertWorkflow(waitingWorkflow(workflowId, 60_000));
    const cookie = await loginAs(on, "builder", "builder");
    const response = on.app.inject({ method: "POST", url: `/api/workflows/${workflowId}/execute`, headers: { cookie }, payload: {} });
    const executionId = await until(async () => {
      const rows = await sql<{ id: string }>(`SELECT id FROM execution_history WHERE workflow_id = $1 AND status = 'running'`, [workflowId]);
      return rows[0]?.id;
    }, "the run to start");
    return { executionId, response };
  }

  it("a cancel on one instance stops the run executing on another, over the bus", async () => {
    const [a, b] = await start(2);
    const { executionId, response } = await startLongRun(b!, "wf-cancel-bus");
    const cookie = await loginAs(a!, "builder", "builder");
    const canceledAt = Date.now();
    const cancel = await a!.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie }, payload: { reason: "stop it" } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({ status: "canceled", abortedActiveRun: false, abortSignalled: true });
    // The run on B ends (it was waiting a minute) and keeps the canceled record.
    const ended = await response;
    expect(Date.now() - canceledAt).toBeLessThan(5_000);
    expect(ended.statusCode).toBe(200);
    expect(JSON.parse(ended.body)).toMatchObject({ status: "canceled" });
    expect((await a!.store.getExecutionHistory(executionId))!.status).toBe("canceled");
  }, 60_000);

  it("a cancel NOTIFY sent straight to the database for a run that is not canceled stops nothing", async () => {
    const [a] = await start(1);
    const { executionId, response } = await startLongRun(a!, "wf-forged");
    const seen: string[] = [];
    vi.spyOn(a!.store, "listCanceledExecutionIds").mockImplementation(async (ids) => {
      seen.push(...ids);
      return [];
    });
    await sql(`SELECT pg_notify('l2m_ctl', $1)`, [JSON.stringify({ v: 1, t: "cancel", id: executionId, from: "intruder" })]);
    // The message arrived and was checked against the store, which does not show the run canceled.
    await until(() => seen.includes(executionId), "the store check");
    expect((await a!.store.getExecutionHistory(executionId))!.status).toBe("running");
    vi.restoreAllMocks();
    const cookie = await loginAs(a!, "builder", "builder");
    await a!.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie }, payload: {} });
    expect(JSON.parse((await response).body)).toMatchObject({ status: "canceled" });
  }, 60_000);

  it("with the bus message lost, the cancel check stops the run within one period", async () => {
    const [, b] = await start(2, { CLUSTER_CANCEL_CHECK_MS: "200" });
    const { executionId, response } = await startLongRun(b!, "wf-cancel-check");
    // A cancel written without a message (as when the publisher's NOTIFY never reached B).
    const result = await b!.store.cancelExecution({ id: executionId, onlyFrom: ["running"], completedAt: new Date().toISOString(), error: "lost message" });
    expect(result.outcome).toBe("canceled");
    const ended = await response;
    expect(JSON.parse(ended.body)).toMatchObject({ status: "canceled" });
  }, 60_000);

  it("while its bus listener is down, /health warns and /ready stays ready; the warning clears on reconnect", async () => {
    const [a] = await start(1);
    const killListeners = () => sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'l2m-bus' AND datname = current_database()`);
    const warned = await until(async () => {
      await killListeners();
      const body = (await a!.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: Array<{ code: string; message: string }> }>();
      return body.warnings?.find((warning) => warning.code === "bus_disconnected") ?? null;
    }, "the bus warning");
    expect(warned.message).toContain("GET /api/cluster");
    expect((await a!.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await until(async () => !(await a!.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: unknown[] }>().warnings, "the warning to clear");
  }, 60_000);

  it("after its bus listener is killed, an instance reconnects and still receives cancels", async () => {
    const [a, b] = await start(2);
    const adminB = await loginAs(b!, "admin", "admin");
    const cluster = async () => (await b!.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: adminB } })).json<{ bus: { connected: boolean; reconnects: number } }>();
    expect((await cluster()).bus).toMatchObject({ connected: true, reconnects: 0 });
    // Kill every bus session of B's... both instances' listeners are named l2m-bus; kill them all.
    await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'l2m-bus' AND datname = current_database()`);
    await until(async () => (await cluster()).bus.reconnects >= 1 && (await cluster()).bus.connected, "B's bus to reconnect");
    const { executionId, response } = await startLongRun(b!, "wf-cancel-reconnect");
    const cookie = await loginAs(a!, "builder", "builder");
    // A's listener may still be reconnecting; its publish goes through the pool regardless.
    const cancel = await a!.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie }, payload: {} });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(JSON.parse((await response).body)).toMatchObject({ status: "canceled" });
  }, 60_000);

  it("the registry lists both instances, the cluster view shows them, and a stopped instance is removed", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a!, "admin", "admin");
    const view = async () =>
      (await a!.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie } })).json<{
        clusterMode: boolean;
        instanceId: string;
        bus: { kind: string; connected: boolean };
        instances: Array<{ id: string; live: boolean; self: boolean; haEnabled: boolean; isLeader: boolean; capabilities: string[]; busConnected: boolean }>;
        warnings: unknown[];
      }>();
    const both = await until(async () => {
      const current = await view();
      return current.instances.filter((instance) => instance.live).length === 2 && current.instances.some((instance) => instance.isLeader) ? current : null;
    }, "both instances, one of them leading");
    expect(both).toMatchObject({ clusterMode: true, instanceId: "instance-0", bus: { kind: "postgres", connected: true }, warnings: [] });
    expect(both.instances.map((instance) => instance.id).sort()).toEqual(["instance-0", "instance-1"]);
    expect(both.instances.find((instance) => instance.self)!.id).toBe("instance-0");
    expect(both.instances.every((instance) => instance.haEnabled && instance.capabilities.includes("bus-v1"))).toBe(true);
    expect(both.instances.filter((instance) => instance.isLeader)).toHaveLength(1);
    // A non-admin may not read it.
    const builder = await loginAs(a!, "builder", "builder");
    expect((await a!.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: builder } })).statusCode).toBe(403);
    // /health carries no warnings with HA on.
    expect((await a!.app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("warnings");

    instances.splice(instances.indexOf(b!), 1);
    await b!.app.close();
    await b!.store.close();
    expect((await view()).instances.map((instance) => instance.id)).toEqual(["instance-0"]);
  }, 60_000);

  it("HA off with two instances: both keep running schedules, and both report the several-leaders warning (health, metric)", async () => {
    const [a, b] = await start(2, { HA_ENABLED: "false" });
    for (const instance of [a!, b!]) {
      const health = await until(async () => {
        const body = (await instance.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: Array<{ code: string; message: string }> }>();
        return body.warnings?.length ? body : null;
      }, `the warning on ${instance.id}`);
      expect(health.warnings![0]!.code).toBe("multiple_leaders");
      expect(health.warnings![0]!.message).toContain("HA_ENABLED=true");
      const metrics = (await instance.app.inject({ method: "GET", url: "/metrics" })).body;
      expect(metrics).toMatch(/_cluster_multiple_leaders 1/);
      expect(metrics).toMatch(/_cluster_live_instances 2/);
      // Not cluster mode: no bus gauge.
      expect(metrics).not.toMatch(/_cluster_bus_connected/);
    }
    // No behaviour change: both still run the scheduler (each leads, as before).
    expect([a!.scheduler!.isRunning(), b!.scheduler!.isRunning()]).toEqual([true, true]);
    const cookie = await loginAs(a!, "admin", "admin");
    const view = (await a!.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie } })).json<{ clusterMode: boolean; bus: { kind: string } }>();
    expect(view).toMatchObject({ clusterMode: false, bus: { kind: "local" } });

    // One instance left: the warning clears.
    instances.splice(instances.indexOf(b!), 1);
    await b!.app.close();
    await b!.store.close();
    await until(async () => !(await a!.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: unknown[] }>().warnings, "the warning to clear");
  }, 60_000);

  it("only one instance at a time exports an audit destination: every row reaches the file exactly once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-cluster-audit-"));
    tempDirs.push(root);
    const settings = { AUDIT_EXPORT_ENABLED: "true", AUDIT_EXPORT_CHECK_INTERVAL_MS: "100", AUDIT_EXPORT_BATCH_SIZE: "3", AUDIT_EXPORT_FILE_ROOT: root };
    const [a, b] = await start(2, settings);
    const file = path.join(root, "audit.ndjson");
    await a!.store.createAuditExportDestination({ id: "dest-1", name: "file", kind: "file", config: { path: file }, intervalSeconds: 0, enabled: true });
    for (let i = 0; i < 30; i += 1) {
      await (i % 2 ? a! : b!).store.writeAuditLog({ id: `audit-${i}`, eventType: "test.event", category: "system", action: "test", outcome: "success" });
    }
    // "Export now" on both instances at once, beside the leader's timer.
    const adminA = await loginAs(a!, "admin", "admin");
    const adminB = await loginAs(b!, "admin", "admin");
    const exportNow = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? a! : b!).app.inject({ method: "POST", url: "/api/audit-export/destinations/dest-1/run", headers: { cookie: i % 2 ? adminA : adminB } })
      )
    );
    for (const response of exportNow) expect([200, 409], response.body).toContain(response.statusCode);
    const total = async () => Number((await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM audit_logs`))[0]!.n);
    const exported = () =>
      fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => (JSON.parse(line) as { id: string }).id)
        : [];
    await until(async () => exported().length >= (await total()), "every audit row in the file");
    const ids = exported();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(await total());
  }, 60_000);

  it("a schedule saved through the standby is registered by the leader at once (workflow_changed), not at the next sync", async () => {
    const [a, b] = await start(2);
    const leader = await until(() => [a!, b!].find((instance) => instance.scheduler?.isRunning()), "a leader");
    const standby = leader === a ? b! : a!;
    const cookie = await loginAs(standby, "builder", "builder");
    const workflow: Workflow = {
      id: "wf-sched",
      name: "wf-sched",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [node("tick", "schedule_trigger", { cronExpression: "0 0 1 1 *", timezone: "UTC", active: true }), node("out", "output", { responseTemplate: "x" })],
      edges: [{ id: "e1", source: "tick", target: "out" }]
    };
    const savedAt = Date.now();
    const saved = await standby.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow });
    expect(saved.statusCode, saved.body).toBe(200);
    // The periodic sync runs every 15 s; the bus brings it well under that.
    await until(() => jobCount(leader.scheduler) > 0, "the leader to register the schedule", 10_000);
    expect(Date.now() - savedAt).toBeLessThan(10_000);
    expect(jobCount(standby.scheduler)).toBe(0);
  }, 60_000);

  it("the leader fails the running runs of an instance that stopped beating, and leaves live instances' and queued resumes' runs alone", async () => {
    const [a] = await start(1);
    // A run owned by an instance whose heartbeat stopped, and one owned by a live instance.
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await a!.store.saveExecutionHistory({ id: "ghost-run", workflowId: "wf", status: "running", startedAt });
    await a!.store.saveExecutionHistory({ id: "self-run", workflowId: "wf", status: "running", startedAt });
    await sql(
      `INSERT INTO cluster_instances (id, worker_mode, started_at, heartbeat_at) VALUES ('ghost', 'all', now() - interval '1 minute', now() - interval '1 minute')`
    );
    // A run whose approval resume waits on the queue: the job's id is not the run's id, its payload names the run.
    await a!.store.saveExecutionHistory({ id: "resumed-run", workflowId: "wf", status: "running", startedAt });
    await a!.store.enqueueExecution({
      id: "resumed-run:req-1:1730000000000",
      workflowId: "wf",
      payload: { executionId: "resumed-run", workflowId: "wf", triggerType: "approval_resume", resume: { executionId: "resumed-run" } },
      scheduledAt: new Date().toISOString()
    });
    await a!.store.claimClusterRunOwner({ executionId: "resumed-run", instanceId: "ghost" });
    await a!.store.claimClusterRunOwner({ executionId: "ghost-run", instanceId: "ghost" });
    await a!.store.claimClusterRunOwner({ executionId: "self-run", instanceId: "instance-0" });
    await until(async () => (await a!.store.getExecutionHistory("ghost-run"))?.status === "error", "the ghost's run to fail");
    expect((await a!.store.getExecutionHistory("ghost-run"))!.error).toBe(DEAD_EXECUTOR_RUN_ERROR);
    expect((await a!.store.getExecutionHistory("self-run"))!.status).toBe("running");
    expect((await a!.store.getExecutionHistory("resumed-run"))!.status).toBe("running");
  }, 60_000);

  it("an instance with a fixed id fails, at start, the runs its previous process left under that id", async () => {
    primary = await createTestStore({ kind: "postgres" });
    // The previous process of instance-0 died mid-run, and instance-0 comes back before its heartbeat aged out.
    await primary.store.saveExecutionHistory({ id: "left-behind", workflowId: "wf", status: "running", startedAt: new Date().toISOString() });
    await primary.store.claimClusterRunOwner({ executionId: "left-behind", instanceId: "instance-0" });
    await primary.store.heartbeatClusterInstance({
      id: "instance-0", workerMode: "all", haEnabled: true, isLeader: true, pools: [], concurrency: null, running: 1, appVersion: null,
      schemaVersion: 7, capabilities: ["bus-v1"], hostname: "old", busConnected: true, startedAt: new Date().toISOString()
    });
    const [a] = await start(1);
    expect(await a!.store.getExecutionHistory("left-behind")).toMatchObject({ status: "error", error: DEAD_EXECUTOR_RUN_ERROR });
    expect(await sql(`SELECT 1 FROM cluster_run_owners`)).toEqual([]);
  }, 60_000);

  it("an inline run records its owner while it runs and forgets it when it ends", async () => {
    const [a] = await start(1);
    const { executionId, response } = await startLongRun(a!, "wf-owner");
    await until(async () => (await sql<{ instance_id: string }>(`SELECT instance_id FROM cluster_run_owners WHERE execution_id = $1`, [executionId]))[0]?.instance_id === "instance-0", "the owner row");
    const cookie = await loginAs(a!, "builder", "builder");
    await a!.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie }, payload: {} });
    await response;
    await until(async () => (await sql(`SELECT 1 FROM cluster_run_owners WHERE execution_id = $1`, [executionId])).length === 0, "the owner row to go");
  }, 60_000);

  it("an instance whose heartbeat stops: the leader fails its run, the instance stops it itself, and its late final write is refused", async () => {
    const [a, b] = await start(2);
    const leader = await until(() => [a!, b!].find((instance) => instance.scheduler?.isRunning()), "a leader");
    const silent = leader === a ? b! : a!;
    const { executionId, response } = await startLongRun(silent, "wf-silent");
    await until(
      async () => (await sql<{ instance_id: string }>(`SELECT instance_id FROM cluster_run_owners WHERE execution_id = $1`, [executionId]))[0]?.instance_id === silent.id,
      "the owner row"
    );
    // The silent instance's final write waits until the leader has failed the run, so it is the late write. (With
    // the database reachable for everything but the heartbeat, the instance would stop the run, release its owner
    // and store the same error itself before the leader looked.)
    const save = silent.store.saveExecutionHistory.bind(silent.store);
    const lateWrites: Array<{ status: string; written: boolean }> = [];
    vi.spyOn(silent.store, "saveExecutionHistory").mockImplementation(async (record, options) => {
      if (record.id !== executionId || record.status === "running") return await save(record, options);
      await until(async () => (await sql(`SELECT 1 FROM execution_history WHERE id = $1 AND status = 'error'`, [executionId])).length > 0, "the leader's reconcile");
      const written = await save(record, options);
      lateWrites.push({ status: record.status, written });
      return written;
    });
    // Its owner release is held the same way (a partition delays every write; the reconcile has removed the row).
    const release = silent.store.releaseClusterRunOwner.bind(silent.store);
    vi.spyOn(silent.store, "releaseClusterRunOwner").mockImplementation(async (input) => {
      await until(async () => (await sql(`SELECT 1 FROM execution_history WHERE id = $1 AND status = 'error'`, [executionId])).length > 0, "the leader's reconcile");
      await release(input);
    });
    // Alive, but its heartbeats no longer reach the database.
    vi.spyOn(silent.store, "heartbeatClusterInstance").mockRejectedValue(new Error("heartbeat blocked"));
    const blockedAt = Date.now();

    // The run (it waited a minute) stops on the silent instance, which fenced itself.
    const ended = await response;
    expect(Date.now() - blockedAt).toBeLessThan(15_000);
    expect(JSON.parse(ended.body)).toMatchObject({ status: "error" });
    expect(lateWrites).toEqual([{ status: "error", written: false }]);
    expect(await leader.store.getExecutionHistory(executionId)).toMatchObject({ status: "error", error: DEAD_EXECUTOR_RUN_ERROR });
    expect(await sql(`SELECT 1 FROM cluster_run_owners WHERE execution_id = $1`, [executionId])).toEqual([]);
  }, 60_000);

  it("a run the queue consumer executes records no owner: the queue's lease owns it", async () => {
    const a = await addInstance(0, {}, { queue: true });
    await a.store.upsertWorkflow(waitingWorkflow("wf-queued", 3_000));
    await a.queue!.enqueue({ workflowId: "wf-queued", executionId: "queued-run" });
    const running = async () => Number((await sql<{ running: number }>(`SELECT running FROM cluster_instances WHERE id = 'instance-0'`))[0]?.running ?? 0);
    await until(async () => (await running()) >= 1, "the queued run to execute");
    // An inline run started after it records its owner; by then the queued run's would have been written too.
    const inline = await startLongRun(a, "wf-inline");
    await until(async () => (await sql(`SELECT 1 FROM cluster_run_owners WHERE execution_id = $1`, [inline.executionId])).length === 1, "the inline run's owner");
    await until(async () => (await running()) === 2, "both runs in the heartbeat");
    expect(await sql(`SELECT execution_id FROM cluster_run_owners`)).toEqual([{ execution_id: inline.executionId }]);
    await until(async () => (await sql(`SELECT 1 FROM execution_queue WHERE status IN ('pending', 'running')`)).length === 0, "the queued job to end");
    const cookie = await loginAs(a, "builder", "builder");
    expect((await a.app.inject({ method: "POST", url: `/api/executions/${inline.executionId}/cancel`, headers: { cookie }, payload: {} })).statusCode).toBe(200);
    await inline.response;
  }, 60_000);

  it("HA off, one instance restarted without a clean stop: the previous process's row raises no several-leaders warning", async () => {
    primary = await createTestStore({ kind: "postgres" });
    // The process before this one (another generated id) died a moment ago; its row is still within the timeout.
    await sql(
      `INSERT INTO cluster_instances (id, worker_mode, ha_enabled, is_leader, started_at, heartbeat_at) VALUES ('host-1a2b3c4d', 'all', 0, 1, now() - interval '1 hour', now())`
    );
    const [a] = await start(1, { HA_ENABLED: "false", CLUSTER_INSTANCE_TIMEOUT_MS: "30000" });
    const cookie = await loginAs(a!, "admin", "admin");
    const view = async () => (await a!.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie } })).json<{ instances: Array<{ live: boolean }>; warnings: unknown[] }>();
    // Several heartbeats with both rows live.
    const beats = async () => (await sql<{ n: string }>(`SELECT EXTRACT(EPOCH FROM (heartbeat_at - started_at::timestamptz)) * 1000 AS n FROM cluster_instances WHERE id = 'instance-0'`))[0]?.n;
    await until(async () => Number(await beats()) >= 1_000, "a few heartbeats");
    const current = await view();
    expect(current.instances.filter((instance) => instance.live)).toHaveLength(2);
    expect(current.warnings).toEqual([]);
    expect((await a!.app.inject({ method: "GET", url: "/health" })).json()).not.toHaveProperty("warnings");
    expect((await a!.app.inject({ method: "GET", url: "/metrics" })).body).toMatch(/_cluster_multiple_leaders 0/);
  }, 60_000);

  it("a schedule saved or deleted through an api-role replica reaches the leader at once (workflow_changed)", async () => {
    const leader = await addInstance(0);
    await until(() => leader.scheduler?.isRunning(), "the leader");
    const api = await addInstance(1, { WORKER_MODE: "api" });
    expect(api.scheduler).toBeUndefined();
    const cookie = await loginAs(api, "builder", "builder");
    const workflow: Workflow = {
      id: "wf-sched-api",
      name: "wf-sched-api",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [node("tick", "schedule_trigger", { cronExpression: "0 0 1 1 *", timezone: "UTC", active: true }), node("out", "output", { responseTemplate: "x" })],
      edges: [{ id: "e1", source: "tick", target: "out" }]
    };
    const savedAt = Date.now();
    const saved = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow });
    expect(saved.statusCode, saved.body).toBe(200);
    await until(() => jobCount(leader.scheduler) > 0, "the leader to register the schedule", 10_000);
    expect(Date.now() - savedAt).toBeLessThan(10_000);
    const deleted = await api.app.inject({ method: "DELETE", url: "/api/workflows/wf-sched-api", headers: { cookie } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    await until(() => jobCount(leader.scheduler) === 0, "the leader to drop the schedule", 10_000);
  }, 60_000);

  /** Short queue leases, as in queue-cluster.test.ts. */
  const QUEUE_LEASES = { QUEUE_HEARTBEAT_MS: "100", QUEUE_LEASE_MS: "600", QUEUE_REAPER_INTERVAL_MS: "100" };

  it("a queued run whose worker stopped beating in the registry is not failed by the reconcile while its lease is live", async () => {
    const leader = await addInstance(0, QUEUE_LEASES);
    await until(() => leader.scheduler?.isRunning(), "the leader");
    const worker = await addInstance(1, QUEUE_LEASES, { queue: true });
    await worker.store.upsertWorkflow(waitingWorkflow("wf-leased", 5_000));
    await worker.queue!.enqueue({ workflowId: "wf-leased", executionId: "leased-run" });
    await until(async () => (await worker.store.getExecutionHistory("leased-run"))?.status === "running", "the queued run to start");
    const [claim] = await sql<{ claim_token: string; claimed_by: string }>(`SELECT claim_token, claimed_by FROM execution_queue WHERE id = 'leased-run'`);
    expect(claim).toMatchObject({ claimed_by: "instance-1" });
    // The consumer recorded no owner for it; an owner row left under the worker's id (as an inline run would have)
    // makes the reconcile look at it, so the queue's lookup is what keeps it.
    expect(await sql(`SELECT 1 FROM cluster_run_owners WHERE execution_id = 'leased-run'`)).toEqual([]);
    await worker.store.claimClusterRunOwner({ executionId: "leased-run", instanceId: "instance-1" });
    // The worker's registry heartbeats stop reaching the database; its queue lease keeps renewing.
    vi.spyOn(worker.store, "heartbeatClusterInstance").mockRejectedValue(new Error("heartbeat blocked"));

    // The leader judged instance-1 dead and took its owner rows (the reconcile forgets every owner it looked at).
    await until(async () => (await sql(`SELECT 1 FROM cluster_run_owners WHERE execution_id = 'leased-run'`)).length === 0, "the leader's reconcile", 15_000);
    expect((await worker.store.getExecutionHistory("leased-run"))!.status).toBe("running");
    const [during] = await sql<{ status: string; claim_token: string; lost_count: number }>(`SELECT status, claim_token, lost_count FROM execution_queue WHERE id = 'leased-run'`);
    expect(during).toEqual({ status: "running", claim_token: claim!.claim_token, lost_count: 0 });

    // The worker fenced itself for its inline runs, but the queued run is the lease's: it finishes, once.
    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = 'leased-run'`))[0]?.status === "completed", "the queued run to finish", 20_000);
    expect(await worker.store.getExecutionHistory("leased-run")).toMatchObject({ status: "success" });
    const [after] = await sql<{ attempts: number; lost_count: number }>(`SELECT attempts, lost_count FROM execution_queue WHERE id = 'leased-run'`);
    expect(after).toEqual({ attempts: 0, lost_count: 0 });
  }, 60_000);

  it("a queued run canceled over the bus and again by the queue heartbeat's check is stopped and recorded once", async () => {
    // A slow queue heartbeat (4 s) so the bus stops the run first; the heartbeat's check then finds it still running.
    const leases = { QUEUE_HEARTBEAT_MS: "4000", QUEUE_LEASE_MS: "12000", QUEUE_REAPER_INTERVAL_MS: "1000" };
    const api = await addInstance(0, leases);
    const cancelChecks: string[] = [];
    // Every abort with its reason: the bus abort carries the route's reason, the heartbeat's check the remote one.
    const abortReasons: unknown[] = [];
    const abort = AbortController.prototype.abort;
    vi.spyOn(AbortController.prototype, "abort").mockImplementation(function (this: AbortController, reason?: unknown) {
      abortReasons.push(reason);
      return abort.call(this, reason);
    });
    const worker = await addInstance(1, leases, {
      queue: true,
      beforeApp: (queue) => {
        const setCancelHandler = queue.setCancelHandler.bind(queue);
        queue.setCancelHandler = (handler) =>
          setCancelHandler((executionId) => {
            cancelChecks.push(executionId);
            handler(executionId);
          });
      }
    });
    await worker.store.upsertWorkflow(waitingWorkflow("wf-cancel-queued", 60_000));
    // The run's final write waits until the heartbeat's check has seen the cancel too, so both paths reach a live run.
    const save = worker.store.saveExecutionHistory.bind(worker.store);
    let finalWriteAt = 0;
    const finalWrites: Array<{ status: string; written: boolean }> = [];
    vi.spyOn(worker.store, "saveExecutionHistory").mockImplementation(async (record, options) => {
      if (record.id !== "queued-cancel" || record.status === "running") return await save(record, options);
      finalWriteAt ||= Date.now();
      await until(() => cancelChecks.includes("queued-cancel"), "the queue heartbeat's cancel check", 15_000);
      const written = await save(record, options);
      finalWrites.push({ status: record.status, written });
      return written;
    });
    await worker.queue!.enqueue({ workflowId: "wf-cancel-queued", executionId: "queued-cancel" });
    await until(async () => (await worker.store.getExecutionHistory("queued-cancel"))?.status === "running", "the queued run to start");

    const cookie = await loginAs(api, "builder", "builder");
    const canceledAt = Date.now();
    const cancel = await api.app.inject({ method: "POST", url: "/api/executions/queued-cancel/cancel", headers: { cookie }, payload: { reason: "stop it" } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({ status: "canceled", abortedActiveRun: false, abortSignalled: true });

    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = 'queued-cancel'`))[0]?.status === "completed", "the job to end", 20_000);
    // The bus stopped it, and the heartbeat's later check found it already aborted and changed nothing.
    expect(finalWriteAt).toBeGreaterThanOrEqual(canceledAt);
    expect(cancelChecks).toContain("queued-cancel");
    expect(abortReasons).toContain("stop it");
    expect(abortReasons).not.toContain(REMOTE_CANCEL_REASON);
    expect(finalWrites).toEqual([{ status: "canceled", written: true }]);
    expect(await worker.store.getExecutionHistory("queued-cancel")).toMatchObject({ status: "canceled" });
    const [job] = await sql<{ attempts: number; lost_count: number }>(`SELECT attempts, lost_count FROM execution_queue WHERE id = 'queued-cancel'`);
    expect(job).toEqual({ attempts: 0, lost_count: 0 });
    expect(await sql(`SELECT 1 FROM execution_queue WHERE status <> 'completed'`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM cluster_run_owners`)).toEqual([]);
  }, 60_000);

  it("a queued run canceled without a bus message is stopped by the queue heartbeat's check", async () => {
    const api = await addInstance(0, QUEUE_LEASES);
    const worker = await addInstance(1, QUEUE_LEASES, { queue: true });
    await worker.store.upsertWorkflow(waitingWorkflow("wf-cancel-hb", 60_000));
    await worker.queue!.enqueue({ workflowId: "wf-cancel-hb", executionId: "hb-cancel" });
    await until(async () => (await worker.store.getExecutionHistory("hb-cancel"))?.status === "running", "the queued run to start");
    // A cancel written without a message (the bus is off for it); the cluster cancel check is off in these tests.
    const result = await api.store.cancelExecution({ id: "hb-cancel", onlyFrom: ["running"], completedAt: new Date().toISOString(), error: "lost message" });
    expect(result.outcome).toBe("canceled");
    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = 'hb-cancel'`))[0]?.status === "completed", "the heartbeat to stop the run", 10_000);
    expect(await worker.store.getExecutionHistory("hb-cancel")).toMatchObject({ status: "canceled" });
    const [job] = await sql<{ attempts: number; lost_count: number }>(`SELECT attempts, lost_count FROM execution_queue WHERE id = 'hb-cancel'`);
    expect(job).toEqual({ attempts: 0, lost_count: 0 });
  }, 60_000);
});
