/**
 * Phase 13.1 — the queue across in-process replicas on one Postgres database in cluster mode (HA on): an `api`
 * replica that only enqueues and `worker` replicas that claim with leases. Two workers never run one job; a worker
 * that dies (its heartbeat stops) has its job taken back by the leader's reaper by the worker-loss policy; a stale
 * owner's writes are fenced; a cancel recorded on the api replica stops the run on its worker within a heartbeat;
 * pools route jobs; the shutdown drain finishes or gives back running jobs. Short leases, polling `until()` helpers.
 * Postgres only (skipped without TEST_POSTGRES_URL).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { WORKER_LOST_ERROR, WORKER_LOST_INTERRUPTED_ERROR, WORKER_SHUTDOWN_INTERRUPTED_ERROR } from "./db/queue-leases.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { QueueLeaseLostAbort, QueueService, type QueueJobContext, type QueuedExecutionPayload } from "./services/queue-service.js";
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
  /** The job context of each run, by execution id (the last attempt here). */
  contexts: Map<string, QueueJobContext>;
}

/** A server the workflows' HTTP nodes call; while `holding`, it keeps each answer until released. */
async function callServer() {
  let holding = false;
  /** Hold only this many more requests (then answer at once), when set. */
  let holdBudget: number | null = null;
  /** Answer this many more requests at once before holding, when set. */
  let answerFirst = 0;
  let hits = 0;
  const held: Array<() => void> = [];
  const server = http.createServer((_request, response) => {
    hits += 1;
    const answer = () => {
      response.setHeader("content-type", "application/json");
      response.end("{\"ok\":true}");
    };
    if (holding && answerFirst > 0) {
      answerFirst -= 1;
      answer();
    } else if (holding && (holdBudget === null || holdBudget > 0)) {
      if (holdBudget !== null) holdBudget -= 1;
      held.push(answer);
    } else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    /** Holds the next request only; later ones are answered at once. */
    holdNext: () => {
      holding = true;
      holdBudget = 1;
    },
    /** Answers the next `count` requests at once, then holds every later one. */
    holdAfter: (count: number) => {
      holding = true;
      answerFirst = count;
    },
    port: (server.address() as { port: number }).port,
    hits: () => hits,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      holdBudget = null;
      answerFirst = 0;
      while (held.length) held.shift()!();
    },
    close: async () => {
      holding = false;
      while (held.length) held.shift()!();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
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

/**
 * A gated run: an HTTP call (`before`) or none, the approval gate, then an HTTP call (`after`) or none and the output.
 * Builders and admins approve.
 */
function gatedWorkflow(id: string, port: number, calls: { before?: boolean; after?: boolean; afterTwice?: boolean }): Workflow {
  // With a call before the gate, the call is the first node, so nothing has completed while it is in flight.
  const nodes: WorkflowNode[] = calls.before
    ? [node("before", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/before` })]
    : [node("input", "text_input", { text: "hi" })];
  const chain = [calls.before ? "before" : "input"];
  nodes.push(node("gate", "approval_gate", { message: "Go on?", approverRoles: ["builder", "admin"], timeoutMinutes: 60 }));
  chain.push("gate");
  if (calls.after) {
    nodes.push(node("after", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/after` }));
    chain.push("after");
  }
  if (calls.afterTwice) {
    nodes.push(node("after2", "http_request", { method: "GET", urlTemplate: `http://127.0.0.1:${port}/after2` }));
    chain.push("after2");
  }
  nodes.push(node("sent", "output", { responseTemplate: "sent" }));
  chain.push("sent");
  const edges = chain.slice(1).map((target, index) => ({
    id: `e${index}`,
    source: chain[index]!,
    target,
    ...(chain[index] === "gate" ? { sourceHandle: "approved" } : {})
  }));
  return { id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges } as Workflow;
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
    const contexts = new Map<string, QueueJobContext>();
    const queue = mode === "worker" ? new QueueService(store, { pollIntervalMs: 25, concurrency: 5 }) : undefined;
    if (queue) {
      // Record each job this replica's consumer runs, before the app's handler.
      const setHandler = queue.setHandler.bind(queue);
      queue.setHandler = (handler) =>
        setHandler(async (payload, context) => {
          ran.push(payload.executionId);
          contexts.set(payload.executionId, context);
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
    const replica: Replica = { name, app, store, lifecycle, ...(queue ? { queue } : {}), ran, contexts };
    replicas.push(replica);
    return replica;
  }

  async function builderCookie(replica: Replica, name = "builder"): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
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
    // Both workers took part, so "never run twice" was tested under contention.
    expect(w1.ran.length).toBeGreaterThan(0);
    expect(w2.ran.length).toBeGreaterThan(0);
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
      // As a real worker: the claim is marked before the first node after the trigger starts.
      await store.markQueueEffectsStarted({ queueItemId: context.queueItemId, claimToken: context.claimToken! });
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

  it("the shutdown drain lets a short job finish and interrupts a long one whose node had started, without counting an attempt", async () => {
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
    // Its wait node had started (a node other than an entry node): never re-run silently.
    expect(byId.get(long)).toMatchObject({ status: "dead", attempts: 0 });
    expect(await api.store.getExecutionHistory(long)).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
    expect((await api.store.listDlqItems()).map((item) => [item.originalId, item.finalError, item.attempts])).toEqual([[long, WORKER_SHUTDOWN_INTERRUPTED_ERROR, 0]]);
  }, 60_000);

  /** Saves a gated workflow, runs it inline on `api` until it pauses, and returns the paused run's id. */
  async function pausedRun(api: Replica, cookie: string, workflow: Workflow): Promise<string> {
    const created = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow as unknown as Record<string, unknown> });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const run = await api.app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/execute`, headers: { cookie }, payload: {} });
    const body = run.json<{ status: string; executionId: string }>();
    expect(body.status, run.body).toBe("waiting_approval");
    return body.executionId;
  }

  /** Approves on `replica` (one with a consumer, so the resume goes on the queue). */
  async function approve(replica: Replica, cookie: string, executionId: string): Promise<void> {
    const response = await replica.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie }, payload: {} });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ queued: true });
  }

  const resumeJob = async (executionId: string) =>
    (await sql<{ id: string; status: string; attempts: number; lost_count: number; claim_token: string | null; nodes_completed: number }>(
      `SELECT id, status, attempts, lost_count, claim_token, nodes_completed FROM execution_queue WHERE execution_id = $1 AND id <> $1`,
      [executionId]
    ))[0];

  it("a drain while a resume's call after the gate is in flight: interrupted and dead-lettered, never re-run (the call may have acted)", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      const w1 = await addReplica("worker-1", "worker");
      const requester = await builderCookie(api, "requester");
      const lead = await builderCookie(api, "lead");
      const executionId = await pausedRun(api, requester, gatedWorkflow("wf-drain-resume", server.port, { after: true }));
      server.hold();
      await approve(w1, lead, executionId);
      await until(() => server.hits() === 1, "the resume to reach the call after the gate");
      await w1.lifecycle.drain(100);

      // Nothing completed after the gate, but the call had started: the production marker is on the resume's claim.
      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
      expect(await resumeJob(executionId)).toMatchObject({ status: "dead", attempts: 0, nodes_completed: 0 });
      expect(await api.store.getWorkflowExecutionState(executionId)).toBeNull();
      expect((await api.store.listDlqItems()).map((item) => item.finalError)).toEqual([WORKER_SHUTDOWN_INTERRUPTED_ERROR]);

      server.release();
      const w2 = await addReplica("worker-2", "worker");
      await until(() => w2.queue!.inFlightCount() === 0 && w1.queue!.inFlightCount() === 0, "the workers to be idle");
      expect(await sql(`SELECT id FROM execution_queue WHERE status IN ('pending', 'running')`)).toEqual([]);
      expect(w2.ran).toEqual([]);
      expect(server.hits()).toBe(1);
    } finally {
      await server.close();
    }
  }, 90_000);

  it("a resume that re-enters only its decided gate never marks side effects on its claim", async () => {
    await database();
    const api = await addReplica("api-0", "api");
    const w1 = await addReplica("worker-1", "worker");
    const requester = await builderCookie(api, "requester");
    const lead = await builderCookie(api, "lead");
    // Nothing follows the approved branch (the output is on the rejected one): the resume runs the gate and ends.
    const workflow = {
      id: "wf-gate-only",
      name: "wf-gate-only",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        node("input", "text_input", { text: "hi" }),
        node("gate", "approval_gate", { message: "Go on?", approverRoles: ["builder", "admin"], timeoutMinutes: 60 }),
        node("sent", "output", { responseTemplate: "rejected" })
      ],
      edges: [
        { id: "e0", source: "input", target: "gate" },
        { id: "e1", source: "gate", target: "sent", sourceHandle: "rejected" }
      ]
    } as Workflow;
    const executionId = await pausedRun(api, requester, workflow);
    await approve(w1, lead, executionId);
    await until(async () => (await resumeJob(executionId))?.status === "completed", "the resume to settle", 30_000);
    const [row] = await sql<{ effects_token: string | null; effects_started: number }>(
      `SELECT effects_token, effects_started FROM execution_queue WHERE execution_id = $1 AND id <> $1`,
      [executionId]
    );
    expect(row!.effects_token).not.toBeNull();
    expect(Number(row!.effects_started)).toBe(0);
    expect(w1.ran).toEqual([executionId]);
  }, 60_000);

  it("a drain after a resume's node completed: interrupted and dead-lettered and its paused state removed, and no worker runs it again", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      const w1 = await addReplica("worker-1", "worker");
      const requester = await builderCookie(api, "requester");
      const lead = await builderCookie(api, "lead");
      const executionId = await pausedRun(api, requester, gatedWorkflow("wf-drain-sent", server.port, { after: true, afterTwice: true }));
      // The first call after the gate answers (a side effect happened); the second is still in flight at the drain.
      server.holdAfter(1);
      await approve(w1, lead, executionId);
      await until(() => server.hits() === 2, "the resume to reach the second call after the gate");
      await until(async () => (await resumeJob(executionId))?.nodes_completed === 1, "the first call to be counted");
      await w1.lifecycle.drain(100);

      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "error", error: WORKER_SHUTDOWN_INTERRUPTED_ERROR });
      expect(await resumeJob(executionId)).toMatchObject({ status: "dead", attempts: 0, nodes_completed: 1 });
      const dlq = await api.store.listDlqItems();
      expect(dlq.map((item) => [item.finalError, item.attempts])).toEqual([[WORKER_SHUTDOWN_INTERRUPTED_ERROR, 0]]);
      expect(dlq[0]!.originalId.startsWith(`${executionId}:`)).toBe(true);
      // The paused state goes with the resume; the decision stays, and a retry rebuilds from history.
      expect(await api.store.getWorkflowExecutionState(executionId)).toBeNull();
      expect(await api.store.listResumingWorkflowExecutions()).toEqual([]);
      expect((await api.store.listApprovalRequestsForExecution(executionId)).map((request) => request.status)).toEqual(["approved"]);

      server.release();
      const w2 = await addReplica("worker-2", "worker");
      await until(() => w2.queue!.inFlightCount() === 0 && w1.queue!.inFlightCount() === 0, "the workers to be idle");
      expect(await sql(`SELECT id FROM execution_queue WHERE status IN ('pending', 'running')`)).toEqual([]);
      expect(w2.ran).toEqual([]);
      expect(server.hits()).toBe(2);
    } finally {
      await server.close();
    }
  }, 90_000);

  it("a worker lost during a resume before any node completed: the resume is re-queued and runs once on a survivor", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      // Leads (reaps) and enqueues the resume on approve, but serves another pool, so it never runs it.
      const leader = await addReplica("leader-only", "worker", { QUEUE_POOLS: "unused" });
      const requester = await builderCookie(api, "requester");
      const lead = await builderCookie(api, "lead");
      const executionId = await pausedRun(api, requester, gatedWorkflow("wf-lost-resume", server.port, { after: true }));
      await approve(leader, lead, executionId);
      await dyingWorker("doomed");
      await until(async () => (await resumeJob(executionId))?.status === "pending", "the reaper to re-queue the resume", 30_000);
      expect(await resumeJob(executionId)).toMatchObject({ attempts: 1, lost_count: 1, nodes_completed: 0 });
      expect((await api.store.getWorkflowExecutionState(executionId))?.status).toBe("resuming");

      const survivor = await addReplica("worker-1", "worker");
      await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "success", "the survivor to resume it", 30_000);
      expect(survivor.ran).toEqual([executionId]);
      expect(server.hits()).toBe(1);
      expect(await api.store.listDlqItems()).toEqual([]);
      expect(leader.ran).toEqual([]);
    } finally {
      await server.close();
    }
  }, 90_000);

  it("a worker lost during a resume after a node completed: interrupted and dead-lettered, and approval recovery never drives it again", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      const leader = await addReplica("leader-only", "worker", { QUEUE_POOLS: "unused" });
      const requester = await builderCookie(api, "requester");
      const lead = await builderCookie(api, "lead");
      const executionId = await pausedRun(api, requester, gatedWorkflow("wf-sent-resume", server.port, { after: true }));
      await approve(leader, lead, executionId);
      await dyingWorker("doomed", async (_payload, context, store) => {
        // As a real worker: the call after the gate started (the marker) and completed under the dead worker's claim.
        expect(await store.markQueueEffectsStarted({ queueItemId: context.queueItemId, claimToken: context.claimToken! })).toBe(true);
        expect(await store.recordQueueJobProgress({ queueItemId: context.queueItemId, claimToken: context.claimToken! })).toBe(true);
      });
      await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "error", "the run to be interrupted", 30_000);
      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ error: WORKER_LOST_INTERRUPTED_ERROR });
      expect(await resumeJob(executionId)).toMatchObject({ status: "dead", attempts: 1, nodes_completed: 1 });
      const dlq = await api.store.listDlqItems();
      expect(dlq.map((item) => item.finalError)).toEqual([WORKER_LOST_INTERRUPTED_ERROR]);
      expect(dlq[0]!.originalId.startsWith(`${executionId}:`)).toBe(true);
      // The paused state is gone with the resume: nothing is left in `resuming` for recovery to pick up.
      expect(await api.store.getWorkflowExecutionState(executionId)).toBeNull();
      expect(await api.store.listResumingWorkflowExecutions()).toEqual([]);
      const survivor = await addReplica("worker-1", "worker");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(survivor.ran).toEqual([]);
      expect(server.hits()).toBe(0);
      expect(leader.ran).toEqual([]);
    } finally {
      await server.close();
    }
  }, 90_000);

  it("a worker stalled before its first effect: the job is re-run alongside the live zombie, whose late marker is refused", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      const leader = await addReplica("leader-only", "worker", { QUEUE_POOLS: "unused" });
      const stalled = await addReplica("worker-1", "worker");
      // The stalled worker's marker write hangs: it is about to start the call (the first effect) but has not.
      let releaseMark: () => void = () => undefined;
      const markHeld = new Promise<void>((resolve) => (releaseMark = resolve));
      let markReached = false;
      const mark = stalled.store.markQueueEffectsStarted.bind(stalled.store);
      stalled.store.markQueueEffectsStarted = async (fence) => {
        markReached = true;
        await markHeld;
        return await mark(fence);
      };
      const requester = await builderCookie(api, "requester");
      const lead = await builderCookie(api, "lead");
      const workflow = gatedWorkflow("wf-zombie-early", server.port, { before: true });
      const created = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: requester }, payload: workflow as unknown as Record<string, unknown> });
      expect(created.statusCode).toBeLessThan(300);
      const executionId = await enqueue(api, requester, "wf-zombie-early");
      await until(() => markReached, "the first worker to reach its marker");
      // The worker stalls (no heartbeat, no self-fence) with its run alive: nothing outside the run has happened.
      stalled.queue!.stop();
      await until(async () => (await sql<{ attempts: number; status: string }>(`SELECT attempts, status FROM execution_queue WHERE id = $1`, [executionId]))[0]?.status === "pending", "the reaper to re-queue the job", 30_000);
      expect(await sql(`SELECT id FROM execution_queue_dlq`)).toEqual([]);

      // A healthy worker runs it to the gate while the zombie is still alive; it is approved, resumed and finished.
      const healthy = await addReplica("worker-2", "worker");
      await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "waiting_approval", "the healthy worker's pause", 30_000);
      await approve(leader, lead, executionId);
      await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "success", "the resumed run to finish", 30_000);
      await until(async () => (await api.store.getWorkflowExecutionState(executionId)) === null, "the paused state to be cleared");
      expect(healthy.ran).toEqual([executionId, executionId]);
      expect(stalled.contexts.get(executionId)!.signal.aborted).toBe(false);

      // The zombie wakes: its marker write is refused (another claim holds the job), so its run stops before the call.
      releaseMark();
      const zombie = stalled.contexts.get(executionId)!;
      await until(() => zombie.signal.aborted, "the stalled worker to stop its run", 30_000);
      expect(zombie.signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
      await until(() => stalled.queue!.inFlightCount() === 0, "the stalled worker's run to end");
      expect((await api.store.listApprovalRequestsForExecution(executionId)).map((request) => request.status)).toEqual(["approved"]);
      expect(await api.store.getWorkflowExecutionState(executionId)).toBeNull();
      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "success" });
      // The call ran once, on the healthy worker.
      expect(server.hits()).toBe(1);
      expect(leader.ran).toEqual([]);
    } finally {
      await server.close();
    }
  }, 120_000);

  it("a stalled worker whose job was taken back mid-call: interrupted, never re-run, and its late write and pause land nowhere", async () => {
    const server = await callServer();
    try {
      await database();
      const api = await addReplica("api-0", "api");
      const leader = await addReplica("leader-only", "worker", { QUEUE_POOLS: "unused" });
      const stalled = await addReplica("worker-1", "worker");
      const requester = await builderCookie(api, "requester");
      const workflow = gatedWorkflow("wf-zombie", server.port, { before: true });
      const created = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: requester }, payload: workflow as unknown as Record<string, unknown> });
      expect(created.statusCode).toBeLessThan(300);
      server.holdNext();
      const executionId = await enqueue(api, requester, "wf-zombie");
      await until(() => server.hits() === 1, "the first worker to reach the call");
      // The worker stalls (no timers fire: no heartbeat, no self-fence) while its call is in flight.
      stalled.queue!.stop();
      // Its call had started (a side effect may have happened): interrupted and dead-lettered, not re-run.
      await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = $1`, [executionId]))[0]!.status === "dead", "the reaper to interrupt the job", 30_000);
      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "error", error: WORKER_LOST_INTERRUPTED_ERROR });
      const healthy = await addReplica("worker-2", "worker");

      // The stalled worker's call answers only now: its progress write is refused, the run stops before the gate.
      server.release();
      const zombie = stalled.contexts.get(executionId)!;
      await until(() => zombie.signal.aborted, "the stalled worker to stop its run", 30_000);
      expect(zombie.signal.reason).toBeInstanceOf(QueueLeaseLostAbort);
      await until(() => stalled.queue!.inFlightCount() === 0, "the stalled worker's run to end");
      expect(await api.store.listApprovalRequestsForExecution(executionId)).toEqual([]);
      expect(await api.store.getWorkflowExecutionState(executionId)).toBeNull();
      expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "error", error: WORKER_LOST_INTERRUPTED_ERROR });
      expect(healthy.ran).toEqual([]);
      expect(leader.ran).toEqual([]);
      expect(server.hits()).toBe(1);
    } finally {
      await server.close();
    }
  }, 120_000);
});
