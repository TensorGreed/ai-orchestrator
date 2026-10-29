/**
 * Phase 13.1 — queue dispatch (EXECUTION_DISPATCH=queue) across in-process replicas on one Postgres database in
 * cluster mode: `api` replicas take requests and `worker` replicas run them.
 *
 * - Every run-starting path runs on a worker and answers as inline does: /execute, /execute/stream, a webhook, the
 *   streaming webhook API, a schedule fire and an approval resume.
 * - A lost NOTIFY still ends a run, from the database.
 * - A cancel stops a relayed stream's run on its worker.
 * - Another replica can reattach mid-run.
 * - The capability gate falls back to inline with a warning and a metric.
 * - Two leaders firing one schedule second, or one trigger event, enqueue it once.
 * - An enqueue wakes an idle worker well before its next poll.
 *
 * Polling `until()` helpers, no fixed sleeps. Postgres only (skipped without TEST_POSTGRES_URL).
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
import type { ClusterBus } from "./services/cluster-bus.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { TriggerService } from "./services/trigger-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("queue dispatch across replicas");

type SchedulerHandler = Parameters<SchedulerService["setExecutionHandler"]>[0];
type TriggerHandler = Parameters<TriggerService["setExecutionHandler"]>[0];

interface Replica {
  name: string;
  app: FastifyInstance;
  store: PostgresStore;
  queue?: QueueService;
  /** Execution ids this replica's consumer ran, in order. */
  ran: string[];
  /** When each run started on this replica's consumer (ms). */
  startedAt: Map<string, number>;
  schedule?: SchedulerHandler;
  trigger?: TriggerHandler;
}

interface ReplicaOptions {
  env?: Record<string, string>;
  pollIntervalMs?: number;
  /** Drops the run events this replica publishes (a lost NOTIFY). */
  dropRunEvents?: boolean;
  background?: boolean;
}

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function chain(id: string, nodes: WorkflowNode[], edgeExtras: Record<number, Record<string, unknown>> = {}): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: nodes.slice(1).map((target, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: target.id, ...(edgeExtras[index] ?? {}) }))
  } as Workflow;
}

const quick = (id: string) => chain(id, [node("input", "text_input", { text: "hi" }), node("out", "output", { responseTemplate: "done" })]);
const waiting = (id: string, delayMs: number) =>
  chain(id, [node("input", "text_input", { text: "hi" }), node("wait", "wait_node", { delayMs, maxDelayMs: delayMs }), node("out", "output", { responseTemplate: "done" })]);

/** The `event:` names of an SSE body, in order, with each event's data. */
function sseEvents(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [first, ...rest] = frame.split("\n");
      return { event: first!.slice("event: ".length), data: JSON.parse(rest.map((line) => line.slice("data: ".length)).join("\n")) as Record<string, unknown> };
    });
}

/** The parts of a result that differ between two runs of one workflow (ids and times). */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(executionId|execution_id|startedAt|completedAt|durationMs|at|id)$/.test(key) || /At$/.test(key) || /Ms$/.test(key)) continue;
      out[key] = stable(entry);
    }
    return out;
  }
  return value;
}

run("queue dispatch across replicas on one Postgres database", () => {
  let primary: TestStore | undefined;
  const replicas: Replica[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function database(): Promise<void> {
    primary = await createTestStore({ kind: "postgres" });
  }

  async function addReplica(name: string, mode: "api" | "worker", options: ReplicaOptions = {}): Promise<Replica> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-queue-dispatch-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary!, { maxConnections: 8 });
    if (options.dropRunEvents) {
      // The listener never hears this replica's run events: every NOTIFY of a run is lost.
      const makeBus = store.clusterBus.bind(store);
      store.clusterBus = ((busOptions: Parameters<PostgresStore["clusterBus"]>[0]) => {
        const bus: ClusterBus = makeBus(busOptions);
        bus.publishRunEvent = async () => undefined;
        return bus;
      }) as PostgresStore["clusterBus"];
    }
    const config = parseConfig({
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      METRICS_ENABLED: "true",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      DB_TYPE: "postgres",
      DB_POSTGRESDB_HOST: "unused-the-store-is-passed-in",
      HA_ENABLED: "true",
      HA_INSTANCE_ID: name,
      HA_RENEW_INTERVAL_MS: "100",
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "5000",
      QUEUE_HEARTBEAT_MS: "100",
      QUEUE_LEASE_MS: "1000",
      QUEUE_REAPER_INTERVAL_MS: "200",
      WORKER_MODE: mode,
      ...(options.env ?? {})
    });
    const ran: string[] = [];
    const startedAt = new Map<string, number>();
    const queue = mode === "worker" ? new QueueService(store, { pollIntervalMs: options.pollIntervalMs ?? 25, concurrency: 5 }) : undefined;
    if (queue) {
      const setHandler = queue.setHandler.bind(queue);
      queue.setHandler = (handler) =>
        setHandler(async (payload, context) => {
          ran.push(payload.executionId);
          startedAt.set(payload.executionId, Date.now());
          await handler(payload, context);
        });
    }
    const replica: Replica = { name, app: undefined as unknown as FastifyInstance, store, ...(queue ? { queue } : {}), ran, startedAt };
    const scheduler = mode === "worker" && options.background ? new SchedulerService(store, () => undefined) : undefined;
    if (scheduler) {
      const set = scheduler.setExecutionHandler.bind(scheduler);
      scheduler.setExecutionHandler = (handler) => {
        replica.schedule = handler;
        set(handler);
      };
    }
    const triggers = mode === "worker" && options.background ? new TriggerService(store, () => undefined) : undefined;
    if (triggers) {
      const set = triggers.setExecutionHandler.bind(triggers);
      triggers.setExecutionHandler = (handler) => {
        replica.trigger = handler;
        set(handler);
      };
    }
    replica.app = await createApp(
      config,
      store,
      new SecretService(store, config.SECRET_MASTER_KEY_BASE64),
      new AuthService(store, config.SESSION_TTL_HOURS),
      scheduler,
      queue,
      triggers,
      { lifecycle: new AppLifecycle() }
    );
    await replica.app.ready();
    replicas.push(replica);
    return replica;
  }

  async function cookieFor(replica: Replica, name: string, role: "builder" | "admin" = "builder"): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await replica.store.getUserByEmail(email))) await new AuthService(replica.store, 24).register({ email, password, role });
    const login = await replica.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  async function save(replica: Replica, cookie: string, workflow: Workflow): Promise<void> {
    const response = await replica.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow as unknown as Record<string, unknown> });
    expect(response.statusCode, response.body).toBeLessThan(300);
  }

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  /** Waits until `replica` dispatches runs to the queue (the capability gate saw a capable worker). */
  async function dispatching(replica: Replica, admin: string): Promise<void> {
    await until(async () => {
      const view = (await replica.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json<{ executionDispatch: string }>();
      return view.executionDispatch === "queue";
    }, `${replica.name} to dispatch to the queue`);
  }

  /** A queue worker, then an api replica dispatching to it, then an inline api replica to compare answers with. */
  async function cluster(workerOptions: ReplicaOptions = {}) {
    await database();
    const worker = await addReplica("worker-1", "worker", { env: { EXECUTION_DISPATCH: "queue" }, ...workerOptions });
    const api = await addReplica("api-q", "api", { env: { EXECUTION_DISPATCH: "queue" } });
    const inline = await addReplica("api-inline", "api");
    const admin = await cookieFor(api, "admin", "admin");
    const builder = await cookieFor(api, "builder");
    await dispatching(api, admin);
    return { worker, api, inline, admin, builder };
  }

  it("every run-starting path runs on a worker and answers as an inline run does", async () => {
    const { worker, api, inline, admin, builder } = await cluster({ background: true });
    await save(api, builder, quick("wf-quick"));

    // /execute (the editor's canvas run): same body as inline, run by the worker.
    const queued = await api.app.inject({ method: "POST", url: "/api/workflows/wf-quick/execute", headers: { cookie: builder }, payload: {} });
    const direct = await inline.app.inject({ method: "POST", url: "/api/workflows/wf-quick/execute", headers: { cookie: builder }, payload: {} });
    expect(queued.statusCode, queued.body).toBe(200);
    const queuedBody = queued.json<{ executionId: string; status: string }>();
    expect(queuedBody.status).toBe("success");
    expect(worker.ran).toContain(queuedBody.executionId);
    expect(worker.ran).not.toContain(direct.json<{ executionId: string }>().executionId);
    expect(Object.keys(queuedBody).sort()).toEqual(Object.keys(direct.json()).sort());
    expect(stable(queuedBody)).toEqual(stable(direct.json()));
    expect(await api.store.getExecutionHistory(queuedBody.executionId)).toMatchObject({ status: "success", triggeredBy: "builder@example.com" });
    // Delivered: the queue row keeps neither the result nor the run's spec.
    const [deliveredRow] = await sql<{ result_json: string | null; payload_json: string }>(`SELECT result_json, payload_json FROM execution_queue WHERE id = $1`, [queuedBody.executionId]);
    expect(deliveredRow!.result_json).toBeNull();
    expect(JSON.parse(deliveredRow!.payload_json)).toEqual({ executionId: queuedBody.executionId });

    // /execute/stream: the same events in the same order, relayed from the worker.
    const streamed = await api.app.inject({ method: "POST", url: "/api/workflows/wf-quick/execute/stream", headers: { cookie: builder }, payload: {} });
    const inlineStream = await inline.app.inject({ method: "POST", url: "/api/workflows/wf-quick/execute/stream", headers: { cookie: builder }, payload: {} });
    const streamEvents = sseEvents(streamed.body);
    expect(streamEvents.map((entry) => entry.event)).toEqual(sseEvents(inlineStream.body).map((entry) => entry.event));
    const streamedId = String(streamEvents[0]!.data.executionId);
    expect(worker.ran).toContain(streamedId);
    expect(streamEvents.filter((entry) => entry.event === "node_complete").map((entry) => [entry.data.nodeId, entry.data.status])).toEqual([
      ["input", "success"],
      ["out", "success"]
    ]);
    expect(stable(streamEvents.at(-1)!.data)).toEqual(stable(sseEvents(inlineStream.body).at(-1)!.data));

    // A configured webhook (sync): the reply waits for the worker's run.
    await save(api, builder, chain("wf-hook", [node("hook", "webhook_input", { path: "dispatch-hook", method: "POST", authMode: "none" }), node("out", "output", { responseTemplate: "hooked" })]));
    const hooked = await api.app.inject({ method: "POST", url: "/webhook/dispatch-hook", payload: { user_prompt: "hello" } });
    const hookedInline = await inline.app.inject({ method: "POST", url: "/webhook/dispatch-hook", payload: { user_prompt: "hello" } });
    expect(hooked.statusCode, hooked.body).toBe(hookedInline.statusCode);
    expect(stable(hooked.json())).toEqual(stable(hookedInline.json()));
    const hookRuns = await sql<{ id: string }>(`SELECT id FROM execution_history WHERE workflow_id = 'wf-hook' ORDER BY started_at`);
    expect(hookRuns).toHaveLength(2);
    expect(worker.ran.filter((id) => hookRuns.some((row) => row.id === id))).toHaveLength(1);

    // The streaming webhook API.
    const hookStream = await api.app.inject({ method: "POST", url: "/api/webhooks/execute/stream", headers: { cookie: builder }, payload: { workflow_id: "wf-quick", user_prompt: "hi" } });
    const hookEvents = sseEvents(hookStream.body);
    expect(hookEvents.at(-1)).toMatchObject({ event: "result", data: { status: "success" } });
    expect(worker.ran).toContain(String(hookEvents[0]!.data.executionId));

    // A schedule fire (the leader's scheduler): enqueued under the second it matched, run by the worker.
    await save(api, builder, chain("wf-cron", [node("cron", "schedule_trigger", { cronExpression: "0 0 1 1 *", timezone: "UTC" }), node("out", "output", { responseTemplate: "tick" })]));
    const scheduledFor = "2026-10-29T10:00:05.000Z";
    await worker.schedule!({ workflowId: "wf-cron", workflowName: "wf-cron", scheduleNodeId: "cron", cronExpression: "0 0 1 1 *", timezone: "UTC", firedAt: "2026-10-29T10:00:05.420Z", scheduledFor });
    const cronItem = `cron:wf-cron:cron:${Date.parse(scheduledFor) / 1000}`;
    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id = $1`, [cronItem]))[0]?.status === "completed", "the scheduled run to complete");
    const [cronRun] = await sql<{ id: string; status: string; trigger_type: string }>(`SELECT id, status, trigger_type FROM execution_history WHERE workflow_id = 'wf-cron'`);
    expect(cronRun).toMatchObject({ status: "success", trigger_type: "cron" });
    expect(worker.ran).toContain(cronRun!.id);

    // An approval resume decided on an api replica (no consumer) goes to the worker through the producer.
    const lead = await cookieFor(api, "lead");
    await save(
      api,
      builder,
      chain(
        "wf-gate",
        [node("input", "text_input", { text: "hi" }), node("gate", "approval_gate", { message: "Go on?", approverRoles: ["builder", "admin"], timeoutMinutes: 60 }), node("sent", "output", { responseTemplate: "sent" })],
        { 1: { sourceHandle: "approved" } }
      )
    );
    const paused = await api.app.inject({ method: "POST", url: "/api/workflows/wf-gate/execute", headers: { cookie: builder }, payload: {} });
    const pausedBody = paused.json<{ executionId: string; status: string }>();
    expect(pausedBody.status, paused.body).toBe("waiting_approval");
    expect(worker.ran).toContain(pausedBody.executionId);
    const approved = await api.app.inject({ method: "POST", url: `/api/approvals/${pausedBody.executionId}/approve`, headers: { cookie: lead }, payload: {} });
    expect(approved.statusCode, approved.body).toBe(202);
    expect(approved.json()).toMatchObject({ queued: true });
    await until(async () => (await api.store.getExecutionHistory(pausedBody.executionId))?.status === "success", "the resumed run to finish");
    expect(worker.ran.filter((id) => id === pausedBody.executionId)).toHaveLength(2);

    // Every dispatched run is counted.
    expect((await api.app.inject({ method: "GET", url: "/metrics" })).body).toMatch(/_dispatch_runs_total \d+/);
    expect((await api.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json()).toMatchObject({ executionDispatch: "queue" });
  }, 120_000);

  it("a failing node's node_complete has the inline event's shape when relayed: error, category, remediation, retryable", async () => {
    const { worker, api, inline, builder } = await cluster();
    // Nothing listens on port 1: the call fails at once with a classified network error.
    await save(api, builder, chain("wf-fail", [node("input", "text_input", { text: "hi" }), node("call", "http_request", { method: "GET", urlTemplate: "http://127.0.0.1:1/x" }), node("out", "output", { responseTemplate: "never" })]));
    const streamed = await api.app.inject({ method: "POST", url: "/api/workflows/wf-fail/execute/stream", headers: { cookie: builder }, payload: {} });
    const inlineStream = await inline.app.inject({ method: "POST", url: "/api/workflows/wf-fail/execute/stream", headers: { cookie: builder }, payload: {} });
    const failed = (body: string) => sseEvents(body).find((entry) => entry.event === "node_complete" && entry.data.nodeId === "call")!.data;
    const relayed = failed(streamed.body);
    const direct = failed(inlineStream.body);
    expect(worker.ran).toContain(String(sseEvents(streamed.body)[0]!.data.executionId));
    expect(direct).toMatchObject({ status: "error" });
    expect(typeof direct.error).toBe("string");
    expect(direct).toHaveProperty("errorCategory");
    expect(direct).toHaveProperty("errorRemediation");
    expect(Object.keys(relayed).sort()).toEqual(Object.keys(direct).sort());
    expect(stable(relayed)).toEqual(stable(direct));
  }, 60_000);

  it("a run whose NOTIFYs are all lost still ends, from the database", async () => {
    const { worker, api, builder } = await cluster({ dropRunEvents: true });
    await save(api, builder, quick("wf-quiet"));
    const response = await api.app.inject({ method: "POST", url: "/api/workflows/wf-quiet/execute", headers: { cookie: builder }, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ executionId: string; status: string; output: unknown }>();
    expect(body).toMatchObject({ status: "success", output: { result: "done" } });
    expect(worker.ran).toEqual([body.executionId]);
  }, 60_000);

  it("a cancel during a relayed stream stops the run on its worker, and the stream ends with the canceled result", async () => {
    const { worker, api, builder } = await cluster();
    await save(api, builder, waiting("wf-long", 30_000));
    const stream = api.app.inject({ method: "POST", url: "/api/workflows/wf-long/execute/stream", headers: { cookie: builder }, payload: {} });
    const executionId = await until(async () => {
      const [row] = await sql<{ id: string; node_results_json: string | null }>(`SELECT id, node_results_json FROM execution_history WHERE workflow_id = 'wf-long'`);
      return row && String(row.node_results_json ?? "").includes("\"wait\"") ? row.id : null;
    }, "the run to reach its wait node on the worker");
    expect(worker.ran).toEqual([executionId]);
    const canceled = await api.app.inject({ method: "POST", url: `/api/executions/${executionId}/cancel`, headers: { cookie: builder }, payload: { reason: "enough" } });
    expect(canceled.statusCode, canceled.body).toBe(200);
    const events = sseEvents((await stream).body);
    expect(events.filter((entry) => entry.event === "node_start").map((entry) => entry.data.nodeId)).toEqual(["input", "wait"]);
    expect(events.at(-1)).toMatchObject({ event: "result", data: { status: "canceled" } });
    expect(await api.store.getExecutionHistory(executionId)).toMatchObject({ status: "canceled" });
    await until(() => worker.queue!.inFlightCount() === 0, "the worker to stop the run");
  }, 60_000);

  it("another replica reattaches mid-run and follows it to its result", async () => {
    const { worker, api, inline, builder } = await cluster();
    await save(api, builder, waiting("wf-follow", 1_500));
    const execution = api.app.inject({ method: "POST", url: "/api/workflows/wf-follow/execute", headers: { cookie: builder }, payload: {} });
    const executionId = await until(async () => {
      const [row] = await sql<{ id: string; node_results_json: string | null }>(`SELECT id, node_results_json FROM execution_history WHERE workflow_id = 'wf-follow'`);
      return row && String(row.node_results_json ?? "").includes("\"wait\"") ? row.id : null;
    }, "the run to reach its wait node");
    const followed = await inline.app.inject({ method: "GET", url: `/api/executions/${executionId}/events`, headers: { cookie: builder } });
    const events = sseEvents(followed.body);
    expect(events[0]).toMatchObject({ event: "execution", data: { id: executionId, status: "running" } });
    expect(events.filter((entry) => entry.event === "node_complete").map((entry) => entry.data.nodeId)).toEqual(["wait", "out"]);
    expect(events.at(-1)).toMatchObject({ event: "result", data: { status: "success" } });
    expect((await execution).json()).toMatchObject({ executionId, status: "success" });
    expect(worker.ran).toEqual([executionId]);
  }, 60_000);

  it("the capability gate runs inline while a live worker cannot run dispatched jobs, with a warning and a metric", async () => {
    await database();
    const worker = await addReplica("worker-1", "worker", { env: { EXECUTION_DISPATCH: "queue" } });
    // An older worker on the same pool, still live: it would not know the job format.
    await worker.store.heartbeatClusterInstance({
      id: "worker-old",
      workerMode: "worker",
      haEnabled: true,
      isLeader: false,
      pools: ["default"],
      concurrency: 5,
      running: 0,
      appVersion: "0.9.0",
      schemaVersion: 45,
      capabilities: ["bus-v1", "fenced-claims-v1"],
      hostname: "old",
      busConnected: true,
      startedAt: new Date().toISOString()
    });
    const api = await addReplica("api-q", "api", { env: { EXECUTION_DISPATCH: "queue" } });
    const admin = await cookieFor(api, "admin", "admin");
    const builder = await cookieFor(api, "builder");
    await save(api, builder, quick("wf-mixed"));
    const response = await api.app.inject({ method: "POST", url: "/api/workflows/wf-mixed/execute", headers: { cookie: builder }, payload: {} });
    expect(response.json()).toMatchObject({ status: "success" });
    expect(worker.ran).toEqual([]);
    const view = (await api.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json<Record<string, unknown>>();
    expect(view).toMatchObject({ executionDispatch: "inline", executionDispatchConfigured: "queue" });
    expect(String(view.executionDispatchFallbackReason)).toContain("worker-old (0.9.0)");
    const health = (await api.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: Array<{ code: string; message: string }> }>();
    // The public /health names no instance, version or error text; the reason is admin-only.
    const fallbackWarning = health.warnings?.find((warning) => warning.code === "dispatch_inline_fallback")?.message;
    expect(fallbackWarning).toContain("GET /api/cluster");
    expect(fallbackWarning).not.toContain("worker-old");
    expect(fallbackWarning).not.toContain("0.9.0");
    const metrics = (await api.app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).toMatch(/_dispatch_inline_fallback 1/);
    expect(metrics).toMatch(/_dispatch_inline_fallbacks_total 1/);
  }, 60_000);

  it("two leaders firing one schedule second, or one trigger event, enqueue it once and it runs once", async () => {
    await database();
    const a = await addReplica("worker-a", "worker", { env: { EXECUTION_DISPATCH: "queue" }, background: true });
    const b = await addReplica("worker-b", "worker", { env: { EXECUTION_DISPATCH: "queue" }, background: true });
    const admin = await cookieFor(a, "admin", "admin");
    const builder = await cookieFor(a, "builder");
    await dispatching(a, admin);
    await dispatching(b, admin);
    await save(a, builder, chain("wf-tick", [node("cron", "schedule_trigger", { cronExpression: "0 0 1 1 *", timezone: "UTC" }), node("out", "output", { responseTemplate: "tick" })]));
    const scheduledFor = "2026-10-29T11:00:00.000Z";
    const fire = (replica: Replica, firedAt: string) =>
      replica.schedule!({ workflowId: "wf-tick", workflowName: "wf-tick", scheduleNodeId: "cron", cronExpression: "0 0 1 1 *", timezone: "UTC", firedAt, scheduledFor });
    // A leadership handover: both believe they lead for the same matched second.
    await Promise.all([fire(a, "2026-10-29T11:00:00.120Z"), fire(b, "2026-10-29T11:00:00.870Z")]);
    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id LIKE 'cron:wf-tick:%'`))[0]?.status === "completed", "the fire to run");
    expect(await sql(`SELECT id FROM execution_queue WHERE workflow_id = 'wf-tick'`)).toHaveLength(1);
    expect(await sql(`SELECT id FROM execution_history WHERE workflow_id = 'wf-tick'`)).toHaveLength(1);

    await save(a, builder, chain("wf-feed", [node("rss", "rss_trigger", { feedUrl: "http://127.0.0.1:9/feed.xml", pollIntervalSeconds: 3600, active: false }), node("out", "output", { responseTemplate: "item" })]));
    const workflow = (await a.store.getWorkflow("wf-feed"))!;
    const event = { rss_items: [{ id: "item-1", title: "One" }], feed_url: "http://127.0.0.1:9/feed.xml" };
    const triggerInput = { workflow, node: workflow.nodes[0]!, triggerType: "rss", input: event };
    // Turned off triggers are skipped: switch it on in the stored workflow only, as a leader would see it.
    await a.store.upsertWorkflow({ ...workflow, nodes: workflow.nodes.map((entry) => (entry.id === "rss" ? { ...entry, config: { ...entry.config, active: true } } : entry)) });
    await Promise.all([a.trigger!(triggerInput), b.trigger!(triggerInput)]);
    await until(async () => (await sql<{ status: string }>(`SELECT status FROM execution_queue WHERE id LIKE 'trig:wf-feed:%'`))[0]?.status === "completed", "the trigger fire to run");
    expect(await sql(`SELECT id FROM execution_queue WHERE workflow_id = 'wf-feed'`)).toHaveLength(1);
    expect(await sql(`SELECT id FROM execution_history WHERE workflow_id = 'wf-feed'`)).toHaveLength(1);

    // The same event id again, still within the dedupe window: nothing runs.
    await a.trigger!(triggerInput);
    expect(await sql(`SELECT id FROM execution_history WHERE workflow_id = 'wf-feed'`)).toHaveLength(1);
    // Past the window (an upstream that reuses ids after a restart): the event runs again.
    await sql(`UPDATE execution_queue SET created_at = now() - interval '11 minutes' WHERE workflow_id = 'wf-feed'`);
    await a.trigger!(triggerInput);
    await until(async () => (await sql(`SELECT id FROM execution_history WHERE workflow_id = 'wf-feed' AND status = 'success'`)).length === 2, "the repeated event to run again");
    expect(await sql(`SELECT id FROM execution_queue WHERE workflow_id = 'wf-feed'`)).toHaveLength(1);
  }, 60_000);

  it("an enqueue on an api replica wakes an idle worker well before its next poll", async () => {
    await database();
    // The worker polls only every 10 s; its first poll runs at start.
    const worker = await addReplica("worker-1", "worker", { pollIntervalMs: 10_000 });
    const api = await addReplica("api-0", "api");
    const builder = await cookieFor(api, "builder");
    await save(api, builder, quick("wf-wake"));
    const waits: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const sent = Date.now();
      const enqueued = await api.app.inject({ method: "POST", url: "/api/workflows/wf-wake/enqueue", headers: { cookie: builder }, payload: {} });
      expect(enqueued.statusCode, enqueued.body).toBe(200);
      const executionId = enqueued.json<{ executionId: string }>().executionId;
      const started = await until(() => worker.startedAt.get(executionId), "the worker to claim the job", 8_000);
      waits.push(started - sent);
      await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "success", "the job to finish");
    }
    // Well under the 10 s poll: the wake-up, not the poll, started each job.
    for (const wait of waits) expect(wait).toBeLessThan(1_500);
  }, 60_000);
});
