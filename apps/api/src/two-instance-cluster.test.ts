/**
 * Phase 13.1 — cluster signalling with in-process replicas on one Postgres database (each a full app with its own
 * store and pool): a cancel on one instance stops the run executing on another (over the bus, and by the cancel check
 * when the message is lost or the listener was down), the registry lists every instance, several instances leading
 * with HA off raise the warning, only one instance at a time exports an audit destination, a save on a standby reaches
 * the leader's scheduler at once, and the leader fails the runs of an instance that stopped beating. Postgres only
 * (skipped without TEST_POSTGRES_URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AuthService } from "./services/auth-service.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { TriggerService } from "./services/trigger-service.js";
import { DEAD_EXECUTOR_RUN_ERROR } from "./services/instance-registry.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("cluster signalling across API instances");

interface Instance {
  id: string;
  app: FastifyInstance;
  store: PostgresStore;
  scheduler: SchedulerService;
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

const jobCount = (scheduler: SchedulerService) => (scheduler as unknown as { jobs: Map<string, unknown> }).jobs.size;

run("cluster signalling across API instances on one Postgres database", () => {
  let primary: TestStore | undefined;
  const instances: Instance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function addInstance(i: number, overrides: Record<string, string> = {}): Promise<Instance> {
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
    const scheduler = new SchedulerService(store, () => undefined);
    const triggers = new TriggerService(store, () => undefined);
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), scheduler, undefined, triggers);
    await app.ready();
    const instance = { id: `instance-${i}`, app, store, scheduler };
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

  it("with the bus message lost, the cancel check stops the run within one period", async () => {
    const [, b] = await start(2, { CLUSTER_CANCEL_CHECK_MS: "200" });
    const { executionId, response } = await startLongRun(b!, "wf-cancel-check");
    // A cancel written without a message (as when the publisher's NOTIFY never reached B).
    const result = await b!.store.cancelExecution({ id: executionId, onlyFrom: ["running"], completedAt: new Date().toISOString(), error: "lost message" });
    expect(result.outcome).toBe("canceled");
    const ended = await response;
    expect(JSON.parse(ended.body)).toMatchObject({ status: "canceled" });
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
    expect([a!.scheduler.isRunning(), b!.scheduler.isRunning()]).toEqual([true, true]);
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
    const leader = await until(() => [a!, b!].find((instance) => instance.scheduler.isRunning()), "a leader");
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

  it("the leader fails the running runs of an instance that stopped beating, and leaves live instances' runs alone", async () => {
    const [a] = await start(1);
    // A run owned by an instance whose heartbeat stopped, and one owned by a live instance.
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    await a!.store.saveExecutionHistory({ id: "ghost-run", workflowId: "wf", status: "running", startedAt });
    await a!.store.saveExecutionHistory({ id: "self-run", workflowId: "wf", status: "running", startedAt });
    await sql(
      `INSERT INTO cluster_instances (id, worker_mode, started_at, heartbeat_at) VALUES ('ghost', 'all', now() - interval '1 minute', now() - interval '1 minute')`
    );
    await a!.store.claimClusterRunOwner({ executionId: "ghost-run", instanceId: "ghost" });
    await a!.store.claimClusterRunOwner({ executionId: "self-run", instanceId: "instance-0" });
    await until(async () => (await a!.store.getExecutionHistory("ghost-run"))?.status === "error", "the ghost's run to fail");
    expect((await a!.store.getExecutionHistory("ghost-run"))!.error).toBe(DEAD_EXECUTOR_RUN_ERROR);
    expect((await a!.store.getExecutionHistory("self-run"))!.status).toBe("running");
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
});
