/**
 * Trace propagation across instances (the cluster contract): an `api` replica takes the request and a `worker`
 * replica, another instance with its own tracer, runs the job from the shared Postgres queue. Each replica records its
 * spans in its own in-memory exporter, so the only thing that can join them is the context in the queue payload and in
 * the paused state.
 *
 * - A dispatched run's worker spans continue the request trace of the api replica.
 * - An approval decided on the api replica resumes on the worker, linked to the node that paused (on the worker).
 * - With tracing off on both, the queue payload holds no trace context.
 *
 * Postgres only (skipped without TEST_POSTGRES_URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpanExporter, type ReadableSpan, type SpanProcessor } from "@ai-orchestrator/otel";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import type { PostgresStore } from "../db/postgres-store.js";
import { AppLifecycle } from "../services/app-lifecycle.js";
import { AuthService } from "../services/auth-service.js";
import { QueueService } from "../services/queue-service.js";
import { SecretService } from "../services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("queue trace propagation across replicas");

const TRACING = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" };
const REQUEST_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const REQUEST_PARENT = `00-${REQUEST_TRACE}-00f067aa0ba902b7-01`;

interface Replica {
  name: string;
  app: FastifyInstance;
  store: PostgresStore;
  exporter: InMemorySpanExporter;
}

function collectInto(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
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

const named = (replica: Replica, prefix: string): ReadableSpan[] => replica.exporter.getFinishedSpans().filter((span) => span.name.startsWith(prefix));

run("trace context across replicas on one Postgres database", () => {
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

  async function addReplica(name: string, mode: "api" | "worker", env: Record<string, string>): Promise<Replica> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-queue-otel-pg-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 8 });
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
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "5000",
      QUEUE_HEARTBEAT_MS: "100",
      QUEUE_LEASE_MS: "1000",
      QUEUE_REAPER_INTERVAL_MS: "200",
      WORKER_MODE: mode,
      ...env
    });
    const exporter = new InMemorySpanExporter();
    const queue = mode === "worker" ? new QueueService(store, { pollIntervalMs: 25, concurrency: 5 }) : undefined;
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS), undefined, queue, undefined, {
      lifecycle: new AppLifecycle(),
      telemetrySpanProcessors: [collectInto(exporter)],
      telemetryRegisterGlobals: false
    });
    await app.ready();
    const replica = { name, app, store, exporter };
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

  async function dispatching(replica: Replica, admin: string): Promise<void> {
    await until(async () => {
      const view = (await replica.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json<{ executionDispatch: string }>();
      return view.executionDispatch === "queue";
    }, `${replica.name} to dispatch to the queue`);
  }

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  it("a worker on another instance continues the trace of the api replica's request, and a resume links to the pause", async () => {
    const env = { ...TRACING, EXECUTION_DISPATCH: "queue" };
    primary = await createTestStore({ kind: "postgres" });
    const worker = await addReplica("worker-1", "worker", env);
    const api = await addReplica("api-1", "api", env);
    const admin = await cookieFor(api, "admin", "admin");
    const builder = await cookieFor(api, "builder");
    const lead = await cookieFor(api, "lead");
    await dispatching(api, admin);
    const wf = chain("wf-gate", [node("input", "text_input", { text: "hi" }), node("gate", "approval_gate", { message: "Go on?", approverRoles: ["builder", "admin"], timeoutMinutes: 60 }), node("sent", "output", { responseTemplate: "sent" })], { 1: { sourceHandle: "approved" } });
    expect((await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: builder }, payload: wf as unknown as Record<string, unknown> })).statusCode).toBeLessThan(300);

    const paused = await api.app.inject({ method: "POST", url: "/api/workflows/wf-gate/execute", headers: { cookie: builder, traceparent: REQUEST_PARENT }, payload: {} });
    const { executionId, status } = paused.json<{ executionId: string; status: string }>();
    expect(status, paused.body).toBe("waiting_approval");

    // The api replica's request span, in the caller's trace; the worker's spans are in the same trace and none of them
    // is in the api replica's exporter: the context travelled through the queue row.
    const request = named(api, "POST").find((span) => span.attributes["http.route"] === "/api/workflows/:id/execute")!;
    expect(request.spanContext().traceId).toBe(REQUEST_TRACE);
    await until(() => named(worker, "invoke_workflow").length >= 1 && named(worker, "process l2m.queue").length >= 1, "the worker's run and consumer spans");
    const consumer = named(worker, "process l2m.queue")[0]!;
    expect(consumer.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(consumer.spanContext().traceId).toBe(REQUEST_TRACE);
    const firstRun = named(worker, "invoke_workflow")[0]!;
    expect(firstRun.parentSpanContext?.spanId).toBe(consumer.spanContext().spanId);
    expect(named(api, "process l2m.queue")).toHaveLength(0);
    expect(named(api, "invoke_workflow")).toHaveLength(0);
    const gateNode = named(worker, "l2m.node").find((span) => span.attributes["l2m.node.id"] === "gate")!;
    // v72 — the worker wrote the trace id under its queue claim; the api replica reads it from the shared database.
    await until(async () => (await api.store.getExecutionHistory(executionId))?.traceId === REQUEST_TRACE, "the paused run's trace id");

    // The paused state, in the shared database, names the worker's gate node.
    const stored = await api.store.getWorkflowExecutionState(executionId);
    expect((stored!.state as { traceContext?: unknown }).traceContext).toEqual({ traceparent: `00-${REQUEST_TRACE}-${gateNode.spanContext().spanId}-01` });

    // The decision is taken on the api replica (a new trace) and resumes on the worker.
    const decision = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    const approved = await api.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie: lead, traceparent: decision }, payload: {} });
    expect(approved.statusCode, approved.body).toBe(202);
    await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "success", "the resumed run");
    await until(() => named(worker, "invoke_workflow").length === 2 && named(worker, "process l2m.queue").length === 2, "the resume's run and consumer spans");
    const approve = named(api, "POST").find((span) => span.attributes["http.route"] === "/api/approvals/:id/approve")!;
    const resumeConsumer = named(worker, "process l2m.queue").find((span) => span.attributes["messaging.message.id"] !== executionId)!;
    expect(resumeConsumer.parentSpanContext?.spanId).toBe(approve.spanContext().spanId);
    const resumed = named(worker, "invoke_workflow").find((span) => span.attributes["l2m.trigger.type"] === "approval_resume")!;
    expect(resumed.spanContext().traceId).toBe("cccccccccccccccccccccccccccccccc");
    expect(resumed.parentSpanContext?.spanId).toBe(resumeConsumer.spanContext().spanId);
    expect(resumed.links.map((link) => [link.context.traceId, link.context.spanId])).toEqual([[REQUEST_TRACE, gateNode.spanContext().spanId]]);
    await until(async () => (await api.store.getExecutionHistory(executionId))?.traceId === "cccccccccccccccccccccccccccccccc", "the resume's trace id");
  }, 120_000);

  it("holds no trace context in the queue row while tracing is off on both replicas", async () => {
    const env = { EXECUTION_DISPATCH: "queue" };
    primary = await createTestStore({ kind: "postgres" });
    const worker = await addReplica("worker-1", "worker", env);
    const api = await addReplica("api-1", "api", env);
    const admin = await cookieFor(api, "admin", "admin");
    const builder = await cookieFor(api, "builder");
    await dispatching(api, admin);
    const wf = chain("wf-off", [node("input", "text_input", { text: "hi" }), node("out", "output", { responseTemplate: "done" })]);
    await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: builder }, payload: wf as unknown as Record<string, unknown> });
    const enqueued = await api.app.inject({ method: "POST", url: "/api/workflows/wf-off/enqueue", headers: { cookie: builder, traceparent: REQUEST_PARENT }, payload: {} });
    expect(enqueued.statusCode, enqueued.body).toBe(200);
    const { executionId } = enqueued.json<{ executionId: string }>();
    await until(async () => (await api.store.getExecutionHistory(executionId))?.status === "success", "the queued run");
    const rows = await sql<{ payload_json: string }>(`SELECT payload_json FROM execution_queue`);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload_json).not.toContain("traceContext");
      expect(row.payload_json).not.toContain(REQUEST_TRACE);
    }
    expect(worker.exporter.getFinishedSpans()).toHaveLength(0);
    expect(api.exporter.getFinishedSpans()).toHaveLength(0);
  }, 120_000);
});
