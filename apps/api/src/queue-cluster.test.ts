/**
 * Phase 13.1 — the queue across in-process replicas on one Postgres database in cluster mode (HA on): an `api`
 * replica that only enqueues and `worker` replicas that claim with leases. Two workers never run one job; a worker
 * that dies (its heartbeat stops) has its job taken back by the leader's reaper by the worker-loss policy; a stale
 * owner's writes are fenced; a cancel recorded on the api replica stops the run on its worker within a heartbeat;
 * pools route jobs; the shutdown drain finishes or gives back running jobs. Short leases, polling `until()` helpers.
 * Postgres only (skipped without TEST_POSTGRES_URL).
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
import { WORKER_LOST_ERROR, WORKER_LOST_INTERRUPTED_ERROR } from "./db/queue-leases.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService, type QueueJobContext, type QueuedExecutionPayload } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("the queue across replicas on one Postgres database");

/** Short leases so a lost worker is noticed within about a second. */
const LEASE_ENV = {
  QUEUE_HEARTBEAT_MS: "100",
  QUEUE_LEASE_MS: "600",
  QUEUE_REAPER_INTERVAL_MS: "100"
};

interface Replica {
  name: string;
  app: FastifyInstance;
  store: PostgresStore;
  lifecycle: AppLifecycle;
  queue?: QueueService;
  /** Execution ids this replica's consumer ran, in order. */
  ran: string[];
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

function quickWorkflow(id: string, settings?: Workflow["settings"]): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("input", "text_input", { text: "hi" }), node("out", "output", { responseTemplate: "done" })],
    edges: [{ id: "e1", source: "input", target: "out" }],
    ...(settings ? { settings } : {})
  };
}

/** A run whose first node waits `delayMs` (abortable), so no node has completed while it waits. */
function waitingWorkflow(id: string, delayMs: number): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("wait", "wait_node", { delayMs, maxDelayMs: delayMs }), node("out", "output", { responseTemplate: "done" })],
    edges: [{ id: "e1", source: "wait", target: "out" }]
  };
}

run("the queue across replicas on one Postgres database", () => {
  let primary: TestStore | undefined;
  const replicas: Replica[] = [];
  const extraStores: PostgresStore[] = [];
  const zombies: QueueService[] = [];
  const releaseZombies: Array<() => void> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const release of releaseZombies.splice(0)) release();
    for (const zombie of zombies.splice(0)) zombie.stop();
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    for (const store of extraStores.splice(0)) await store.close();
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function database(): Promise<void> {
    primary = await createTestStore({ kind: "postgres" });
  }

  async function addReplica(name: string, mode: "api" | "worker", overrides: Record<string, string> = {}): Promise<Replica> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-queue-cluster-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary!, { maxConnections: 8 });
    const config = parseConfig({
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      DB_TYPE: "postgres",
      DB_POSTGRESDB_HOST: "unused-the-store-is-passed-in",
      HA_ENABLED: "true",
      HA_INSTANCE_ID: name,
      HA_RENEW_INTERVAL_MS: "100",
      WORKER_MODE: mode,
      ...LEASE_ENV,
      ...overrides
    });
    const ran: string[] = [];
    const queue = mode === "worker" ? new QueueService(store, { pollIntervalMs: 25, concurrency: 5 }) : undefined;
    if (queue) {
      // Record each job this replica's consumer runs, before the app's handler.
      const setHandler = queue.setHandler.bind(queue);
      queue.setHandler = (handler) =>
        setHandler(async (payload, context) => {
          ran.push(payload.executionId);
          await handler(payload, context);
        });
    }
    const lifecycle = new AppLifecycle();
    const app = await createApp(
      config,
      store,
      new SecretService(store, config.SECRET_MASTER_KEY_BASE64),
      new AuthService(store, config.SESSION_TTL_HOURS),
      undefined,
      queue,
      undefined,
      { lifecycle }
    );
    await app.ready();
    const replica: Replica = { name, app, store, lifecycle, ...(queue ? { queue } : {}), ran };
    replicas.push(replica);
    return replica;
  }

  async function builderCookie(replica: Replica): Promise<string> {
    const email = "builder@example.com";
    const password = "builder-Pass-123!";
    if (!(await replica.store.getUserByEmail(email))) await new AuthService(replica.store, 24).register({ email, password, role: "builder" });
    const login = await replica.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  async function enqueue(replica: Replica, cookie: string, workflowId: string): Promise<string> {
    const response = await replica.app.inject({ method: "POST", url: `/api/workflows/${workflowId}/enqueue`, headers: { cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ executionId: string }>().executionId;
  }

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  /**
   * A worker that claims one job and then dies: its handler never returns and its heartbeat stops. Returns the claim
   * it took (its token stays the zombie's). `onClaim` runs first, as the dead worker's last act (e.g. a node finished).
   */
  async function dyingWorker(name: string, onClaim?: (payload: QueuedExecutionPayload, context: QueueJobContext, store: PostgresStore) => Promise<void>) {
    const store = await openTestStoreTwin(primary!, { maxConnections: 2 });
    extraStores.push(store);
    const zombie = new QueueService(store, { pollIntervalMs: 25, concurrency: 1 });
    zombies.push(zombie);
    zombie.enableLeases({ instanceId: name, heartbeatMs: 100, leaseMs: 600, reaperIntervalMs: 60_000, pools: ["default"] });
    zombie.setSweepGate(() => false);
    zombie.setObserver({ log: () => undefined });
    let claimed: { payload: QueuedExecutionPayload; context: QueueJobContext } | null = null;
    zombie.setHandler(async (payload, context) => {
      if (onClaim) await onClaim(payload, context, store);
      claimed = { payload, context };
      // Dead: never returns on its own; the test releases it at the end.
      await new Promise<void>((resolve) => releaseZombies.push(resolve));
    });
    zombie.start();
    const claim = await until(() => claimed, `${name} to claim a job`);
    // The process is gone: no more heartbeats or claims.
    zombie.stop();
    return { store, claim };
  }

  it("two workers never run one job: 120 enqueued runs complete exactly once, and a pool routes to its workers", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const w1 = await addReplica("worker-1", "worker");
    const w2 = await addReplica("worker-2", "worker", { QUEUE_POOLS: "default,gpu" });
    const cookie = await builderCookie(api);
    for (const wf of [quickWorkflow("wf-a"), quickWorkflow("wf-b"), quickWorkflow("wf-c"), quickWorkflow("wf-gpu", { executionPool: "gpu" })]) {
      const created = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: wf as unknown as Record<string, unknown> });
      expect(created.statusCode).toBeLessThan(300);
    }
    const ids: string[] = [];
    for (let i = 0; i < 120; i += 1) ids.push(await enqueue(api, cookie, ["wf-a", "wf-b", "wf-c"][i % 3]!));
    const gpuIds: string[] = [];
    for (let i = 0; i < 4; i += 1) gpuIds.push(await enqueue(api, cookie, "wf-gpu"));

    await until(async () => {
      const [row] = await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM execution_queue WHERE status = 'completed'`);
      return Number(row!.n) === 124;
    }, "every job to complete", 60_000);

    const ran = [...w1.ran, ...w2.ran];
    expect(ran).toHaveLength(124);
    expect(new Set(ran).size).toBe(124);
    expect([...ran].sort()).toEqual([...ids, ...gpuIds].sort());
    // Only the gpu worker ran gpu jobs.
    for (const id of gpuIds) expect(w2.ran).toContain(id);
    const history = await sql<{ status: string; n: string }>(`SELECT status, COUNT(*) AS n FROM execution_history GROUP BY status`);
    expect(history).toEqual([{ status: "success", n: "124" }]);
    const queueRows = await sql<{ claimed_by: string; lost_count: number; attempts: number }>(
      `SELECT DISTINCT claimed_by, lost_count, attempts FROM execution_queue ORDER BY claimed_by`
    );
    expect(queueRows.map((row) => row.claimed_by).every((owner) => owner === "worker-1" || owner === "worker-2")).toBe(true);
    expect(queueRows.every((row) => row.lost_count === 0 && row.attempts === 0)).toBe(true);
    // Every history row was written under its claim.
    const unfenced = await sql<{ n: string }>(
      `SELECT COUNT(*) AS n FROM execution_history h JOIN execution_queue q ON q.id = h.id WHERE h.executor_id IS DISTINCT FROM q.claim_token`
    );
    expect(Number(unfenced[0]!.n)).toBe(0);
    expect(await sql(`SELECT id FROM execution_queue_dlq`)).toEqual([]);
  }, 120_000);

  it("a worker that dies before any node completed: its job is taken back, re-run once on a survivor, and the zombie is fenced", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const cookie = await builderCookie(api);
    const created = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: quickWorkflow("wf-lost") as unknown as Record<string, unknown> });
    expect(created.statusCode).toBeLessThan(300);
    const executionId = await enqueue(api, cookie, "wf-lost");
    const { store: zombieStore, claim } = await dyingWorker("doomed", async (payload, context, store) => {
      // A progress write under its claim: one node started, none completed.
      await store.saveExecutionHistory(
        { id: payload.executionId, workflowId: payload.workflowId, status: "running", startedAt: new Date().toISOString(), nodeResultsJson: [{ nodeId: "input", status: "running" }] },
        { unlessFinished: true, fence: { queueItemId: context.queueItemId, claimToken: context.claimToken! } }
      );
    });
    expect(claim.payload.executionId).toBe(executionId);

    // The survivors boot; their leader reaps the expired lease and one of them runs the job.
    const w1 = await addReplica("worker-1", "worker");
    const w2 = await addReplica("worker-2", "worker");
    await until(async () => {
      const [row] = await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = $1`, [executionId]);
      return row!.status === "completed";
    }, "the job to complete on a survivor", 30_000);
    expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "success" });
    expect([...w1.ran, ...w2.ran]).toEqual([executionId]);
    const [row] = await sql<{ status: string; attempts: number; lost_count: number; claim_token: string }>(
      `SELECT status, attempts, lost_count, claim_token FROM execution_queue WHERE id = $1`,
      [executionId]
    );
    expect(row).toMatchObject({ status: "completed", attempts: 1, lost_count: 1 });
    expect(row!.claim_token).not.toBe(claim.context.claimToken);

    // The zombie wakes up: every write under its old claim is refused, and the survivor's record stands.
    const stale = { queueItemId: claim.context.queueItemId, claimToken: claim.context.claimToken! };
    expect(
      await zombieStore.saveExecutionHistory(
        { id: executionId, workflowId: "wf-lost", status: "error", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: "zombie" },
        { unlessCanceled: true, fence: stale }
      )
    ).toBe(false);
    expect(await zombieStore.markQueueItemCompleted(executionId, { claimToken: stale.claimToken })).toBe(false);
    expect(await zombieStore.markQueueItemFailed(executionId, "zombie", { claimToken: stale.claimToken })).toBe(false);
    expect(await zombieStore.renewQueueLeases({ owner: "doomed", claimTokens: [stale.claimToken] })).toEqual([]);
    expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "success" });
  }, 90_000);

  it("a worker that dies after a node completed: the run is interrupted and dead-lettered, never re-run", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const cookie = await builderCookie(api);
    await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: quickWorkflow("wf-sent") as unknown as Record<string, unknown> });
    const executionId = await enqueue(api, cookie, "wf-sent");
    await dyingWorker("doomed", async (payload, context, store) => {
      await store.saveExecutionHistory(
        {
          id: payload.executionId,
          workflowId: payload.workflowId,
          status: "running",
          startedAt: new Date().toISOString(),
          nodeResultsJson: [{ nodeId: "input", status: "success" }, { nodeId: "out", status: "running" }]
        },
        { unlessFinished: true, fence: { queueItemId: context.queueItemId, claimToken: context.claimToken! } }
      );
    });
    const w1 = await addReplica("worker-1", "worker");
    await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "error", "the run to be interrupted", 30_000);
    expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ error: WORKER_LOST_INTERRUPTED_ERROR });
    const dlq = await api.store.listDlqItems();
    expect(dlq.map((item) => [item.originalId, item.finalError, item.attempts])).toEqual([[executionId, WORKER_LOST_INTERRUPTED_ERROR, 1]]);
    // Give the survivor a few polls: nothing runs it again.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(w1.ran).toEqual([]);
    expect(await api.store.hasActiveQueueItem(executionId)).toBe(false);
  }, 90_000);

  it("a job that kills every worker ends in the dead-letter queue after its attempts", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const leader = await addReplica("leader-only", "worker", { QUEUE_POOLS: "unused" });
    const cookie = await builderCookie(api);
    await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: quickWorkflow("wf-poison") as unknown as Record<string, unknown> });
    const executionId = await enqueue(api, cookie, "wf-poison");
    // Three attempts (the default), three dead workers; the replica above only reaps (it serves another pool).
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await dyingWorker(`doomed-${attempt}`);
      await until(async () => {
        const [row] = await sql<{ attempts: number; status: string }>(`SELECT attempts, status FROM execution_queue WHERE id = $1`, [executionId]);
        return row!.attempts === attempt && row!.status !== "running";
      }, `reap ${attempt}`, 30_000);
    }
    const [row] = await sql<{ status: string; lost_count: number }>(`SELECT status, lost_count FROM execution_queue WHERE id = $1`, [executionId]);
    expect(row).toEqual({ status: "dead", lost_count: 3 });
    expect((await api.store.listDlqItems()).map((item) => [item.originalId, item.finalError, item.attempts])).toEqual([[executionId, WORKER_LOST_ERROR, 3]]);
    expect(leader.ran).toEqual([]);
  }, 120_000);

  it("a cancel on the api replica stops the run on its worker within a heartbeat", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const worker = await addReplica("worker-1", "worker");
    const cookie = await builderCookie(api);
    await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: waitingWorkflow("wf-wait", 60_000) as unknown as Record<string, unknown> });
    const executionId = await enqueue(api, cookie, "wf-wait");
    await until(() => worker.ran.includes(executionId), "the worker to start the run");
    await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "running", "the run's progress");
    const canceledAt = Date.now();
    const cancel = await api.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie }, payload: {} });
    expect(cancel.statusCode, cancel.body).toBe(200);
    await until(async () => {
      const [row] = await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = $1`, [executionId]);
      return row!.status === "completed";
    }, "the worker to stop the run", 10_000);
    expect(Date.now() - canceledAt).toBeLessThan(5_000);
    expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "canceled" });
  }, 60_000);

  it("the shutdown drain lets a short job finish and gives back a long one without counting an attempt", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const worker = await addReplica("worker-1", "worker");
    const cookie = await builderCookie(api);
    for (const wf of [waitingWorkflow("wf-short", 400), waitingWorkflow("wf-long", 60_000)]) {
      await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: wf as unknown as Record<string, unknown> });
    }
    const short = await enqueue(api, cookie, "wf-short");
    const long = await enqueue(api, cookie, "wf-long");
    await until(() => worker.ran.includes(short) && worker.ran.includes(long), "both runs to start");
    expect((await worker.app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    const draining = worker.lifecycle.drain(1_500);
    await until(async () => (await worker.app.inject({ method: "GET", url: "/ready" })).statusCode === 503, "/ready to turn 503");
    await draining;
    expect(await api.store.getExecutionHistory(short)).toMatchObject({ status: "success" });
    const rows = await sql<{ id: string; status: string; attempts: number; claim_token: string | null }>(
      `SELECT id, status, attempts, claim_token FROM execution_queue ORDER BY id`
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(short)).toMatchObject({ status: "completed" });
    expect(byId.get(long)).toMatchObject({ status: "pending", attempts: 0, claim_token: null });
    // The given-back run was not recorded as canceled: the next worker runs it.
    expect((await api.store.getExecutionHistory(long))?.status).not.toBe("canceled");
    const next = await addReplica("worker-2", "worker");
    await until(() => next.ran.includes(long), "another worker to take the given-back job");
  }, 60_000);
});
