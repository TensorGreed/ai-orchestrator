/**
 * Trace propagation across the queue and across an approval pause, collected with the real OpenTelemetry SDK in memory:
 * a queued run continues the trace of the request that enqueued it, a resume after an approval links back to the node
 * that paused (a link, not a parent), schedule fires and trigger events start new traces, and with tracing off a job's
 * payload holds nothing extra. Runs on the store TEST_STORE names; the two-instance case is queue-spans-cluster.test.ts.
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
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { QueueService } from "../services/queue-service.js";
import { SchedulerService } from "../services/scheduler-service.js";
import { SecretService } from "../services/secret-service.js";
import { TriggerService } from "../services/trigger-service.js";
import { openTestStore } from "../test-support/test-store.js";

const TRACING = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" };
const REQUEST_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const REQUEST_SPAN = "00f067aa0ba902b7";
const REQUEST_PARENT = `00-${REQUEST_TRACE}-${REQUEST_SPAN}-01`;

interface Context {
  app: FastifyInstance;
  store: Store;
  tempDir: string;
  exporter: InMemorySpanExporter;
  /** Payloads handed to the store's enqueue, in order. */
  payloads: Array<Record<string, unknown>>;
  queue?: QueueService;
  scheduler: SchedulerService;
  trigger: TriggerService;
  /** The handler the app gave the scheduler (what a cron tick calls). */
  fireSchedule: () => ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
  login(role: "admin" | "builder", name?: string): Promise<string>;
}

const contexts: Context[] = [];

function collectInto(exporter: InMemorySpanExporter): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnd: (span) => exporter.export([span], () => undefined),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve()
  };
}

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(env: Record<string, string> = {}, setup?: (context: Pick<Context, "fireSchedule">, app: FastifyInstance) => void, options: { queue?: boolean } = {}): Promise<Context> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-queue-otel-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const payloads: Array<Record<string, unknown>> = [];
  const enqueue = store.enqueueExecution.bind(store);
  store.enqueueExecution = (async (input: Parameters<Store["enqueueExecution"]>[0]) => {
    payloads.push(JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>);
    return await enqueue(input);
  }) as Store["enqueueExecution"];
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const exporter = new InMemorySpanExporter();
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue === false ? undefined : new QueueService(store, { pollIntervalMs: 20 });
  const scheduler = new SchedulerService(store, () => undefined);
  const trigger = new TriggerService(store, () => undefined);
  const handlers: { schedule?: (input: never) => unknown } = {};
  const setScheduleHandler = scheduler.setExecutionHandler.bind(scheduler);
  scheduler.setExecutionHandler = (handler) => {
    handlers.schedule = handler as (input: never) => unknown;
    setScheduleHandler(handler);
  };
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService, scheduler, queue, trigger, {
    telemetrySpanProcessors: [collectInto(exporter)],
    telemetryRegisterGlobals: false
  });
  const fireSchedule = () => handlers.schedule as ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
  setup?.({ fireSchedule }, app);
  await app.ready();
  const login = async (role: "admin" | "builder", name: string = role) => {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await store.getUserByEmail(email))) await authService.register({ email, password, role });
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    const raw = response.headers["set-cookie"];
    return (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  };
  const context = { app, store, tempDir, exporter, payloads, queue, scheduler, trigger, login, fireSchedule } as unknown as Context;
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    context.queue?.stop();
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app's shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function simple(id: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("input", "text_input", { text: "hi" }), node("output", "output", { responseTemplate: "done" })],
    edges: [{ id: "e1", source: "input", target: "output" }]
  } as Workflow;
}

const GATE = {
  message: "Send it?",
  approverRoles: ["builder", "admin"],
  timeoutMinutes: 60,
  timeoutOutcome: "fallback"
};

function gated(id: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }), node("gate", "approval_gate", GATE), node("sent", "output", { responseTemplate: "sent" }), node("stopped", "output", { responseTemplate: "no" }), node("late", "output", { responseTemplate: "late" })],
    edges: [
      { id: "e1", source: "hook", target: "gate" },
      { id: "e2", source: "gate", sourceHandle: "approved", target: "sent" },
      { id: "e3", source: "gate", sourceHandle: "rejected", target: "stopped" },
      { id: "e4", source: "gate", sourceHandle: "timed_out", target: "late" }
    ]
  } as Workflow;
}

const spansNamed = (context: Context, prefix: string): ReadableSpan[] => context.exporter.getFinishedSpans().filter((span) => span.name.startsWith(prefix));
const serverSpan = (context: Context, route: string): ReadableSpan => {
  const found = context.exporter.getFinishedSpans().filter((span) => span.attributes["http.route"] === route);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const runSpanOf = (context: Context, executionId: string): ReadableSpan[] =>
  context.exporter.getFinishedSpans().filter((span) => span.name.startsWith("invoke_workflow") && span.attributes["l2m.execution.id"] === executionId);

async function publish(context: Context, cookie: string, workflow: Workflow): Promise<void> {
  const created = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow as unknown as Record<string, unknown> });
  expect(created.statusCode, created.body).toBeLessThan(300);
}

describe("queued runs continue the trace of the request that enqueued them", () => {
  it("parents the job's consumer span, and through it the run, under the enqueuing request's span", async () => {
    const context = await start(TRACING);
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-q"));
    const queued = await context.app.inject({ method: "POST", url: "/api/workflows/wf-q/enqueue", headers: { cookie, traceparent: REQUEST_PARENT }, payload: {} });
    expect(queued.statusCode, queued.body).toBe(200);
    const { executionId } = queued.json<{ executionId: string }>();
    await until(async () => (await context.store.getExecutionHistory(executionId))?.status === "success", "the queued run");
    await until(() => runSpanOf(context, executionId).length === 1 && spansNamed(context, "process l2m.queue").length === 1, "the run and consumer spans");

    // A session caller's traceparent is continued, so the request's span is in the caller's trace.
    const request = serverSpan(context, "/api/workflows/:id/enqueue");
    expect(request.spanContext().traceId).toBe(REQUEST_TRACE);
    const [consumer] = spansNamed(context, "process l2m.queue");
    expect(consumer!.kind).toBe(4);
    expect(consumer!.spanContext().traceId).toBe(REQUEST_TRACE);
    expect(consumer!.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(consumer!.attributes).toMatchObject({
      "messaging.system": "l2m",
      "messaging.destination.name": "default",
      "messaging.operation.type": "process",
      "messaging.message.id": executionId,
      "l2m.execution.id": executionId,
      "l2m.queue.attempt": 1
    });
    expect(typeof consumer!.attributes["l2m.queue.wait_ms"]).toBe("number");
    const [run] = runSpanOf(context, executionId);
    expect(run!.spanContext().traceId).toBe(REQUEST_TRACE);
    expect(run!.parentSpanContext?.spanId).toBe(consumer!.spanContext().spanId);
    // At the standard span detail there is no producer span.
    expect(spansNamed(context, "send l2m.queue")).toHaveLength(0);
    // The payload carries the context and nothing else new.
    expect(context.payloads).toHaveLength(1);
    expect(context.payloads[0]!.traceContext).toEqual({ traceparent: `00-${REQUEST_TRACE}-${request.spanContext().spanId}-01` });
    // v70 — the run's history row records the trace the queue carried it into.
    await until(async () => (await context.store.getExecutionHistory(executionId))?.traceId === REQUEST_TRACE, "the queued run's trace id");
  });

  it("puts a producer span between them at the verbose detail", async () => {
    const context = await start({ ...TRACING, L2M_OTEL_SPAN_DETAIL: "verbose" });
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-v"));
    const queued = await context.app.inject({ method: "POST", url: "/api/workflows/wf-v/enqueue", headers: { cookie }, payload: {} });
    const { executionId } = queued.json<{ executionId: string }>();
    await until(() => runSpanOf(context, executionId).length === 1 && spansNamed(context, "process l2m.queue").length === 1, "the run and consumer spans");
    const request = serverSpan(context, "/api/workflows/:id/enqueue");
    const [send] = spansNamed(context, "send l2m.queue");
    const [consumer] = spansNamed(context, "process l2m.queue");
    expect(send!.kind).toBe(3);
    expect(send!.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(consumer!.parentSpanContext?.spanId).toBe(send!.spanContext().spanId);
    expect(context.payloads[0]!.traceContext).toEqual({ traceparent: `00-${consumer!.spanContext().traceId}-${send!.spanContext().spanId}-01` });
  });

  it("starts a new trace for a job that carries no context (a payload from before tracing was on)", async () => {
    const context = await start(TRACING);
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-old"));
    await context.store.enqueueExecution({ id: "old-job", workflowId: "wf-old", payload: { executionId: "old-job", workflowId: "wf-old", triggerType: "api_queue" } });
    context.queue!.wake();
    await until(async () => (await context.store.getExecutionHistory("old-job"))?.status === "success", "the old job");
    await until(() => runSpanOf(context, "old-job").length === 1 && spansNamed(context, "process l2m.queue").length === 1, "the run and consumer spans");
    const [consumer] = spansNamed(context, "process l2m.queue");
    expect(consumer!.parentSpanContext).toBeUndefined();
    expect(runSpanOf(context, "old-job")[0]!.parentSpanContext?.spanId).toBe(consumer!.spanContext().spanId);
  });

  it("starts a job with no context as a new root even when its poll was woken inside a request", async () => {
    const context = await start(TRACING, (_c, app) => {
      app.get("/api/otel-wake", async () => {
        await context.store.enqueueExecution({ id: "woken-job", workflowId: "wf-woken", payload: { executionId: "woken-job", workflowId: "wf-woken" } });
        context.queue!.wake();
        await until(async () => (await context.store.getExecutionHistory("woken-job"))?.status === "success", "the woken job");
        return { ok: true };
      });
    });
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-woken"));
    await context.app.inject({ method: "GET", url: "/api/otel-wake", headers: { cookie, traceparent: REQUEST_PARENT } });
    await until(() => spansNamed(context, "process l2m.queue").length === 1, "the consumer span");
    const [consumer] = spansNamed(context, "process l2m.queue");
    expect(consumer!.parentSpanContext).toBeUndefined();
    expect(consumer!.spanContext().traceId).not.toBe(REQUEST_TRACE);
  });

  it("ignores a malformed context in a payload", async () => {
    const context = await start(TRACING);
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-bad"));
    await context.store.enqueueExecution({ id: "bad-job", workflowId: "wf-bad", payload: { executionId: "bad-job", workflowId: "wf-bad", traceContext: { traceparent: "not-a-traceparent", extra: "x" } } });
    context.queue!.wake();
    await until(async () => (await context.store.getExecutionHistory("bad-job"))?.status === "success", "the job");
    await until(() => spansNamed(context, "process l2m.queue").length === 1, "the consumer span");
    expect(spansNamed(context, "process l2m.queue")[0]!.parentSpanContext).toBeUndefined();
  });

  it("records each attempt of a failing job as its own consumer span under the same parent", async () => {
    const context = await start(TRACING);
    // The workflow does not exist: the job fails on every attempt.
    const parent = `00-${REQUEST_TRACE}-${REQUEST_SPAN}-01`;
    await context.store.enqueueExecution({ id: "missing-job", workflowId: "wf-missing", maxAttempts: 2, payload: { executionId: "missing-job", workflowId: "wf-missing", traceContext: { traceparent: parent } } });
    context.queue!.wake();
    await until(() => spansNamed(context, "process l2m.queue").length >= 2, "two attempts", 20_000);
    const attempts = spansNamed(context, "process l2m.queue");
    expect(attempts.map((span) => span.attributes["l2m.queue.attempt"]).sort()).toEqual([1, 2]);
    for (const span of attempts) {
      expect(span.parentSpanContext?.spanId).toBe(REQUEST_SPAN);
      expect(span.status.code).toBe(2);
    }
  }, 30_000);

  it("adds nothing to a job's payload and records nothing while tracing is off", async () => {
    const context = await start();
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-off"));
    const queued = await context.app.inject({ method: "POST", url: "/api/workflows/wf-off/enqueue", headers: { cookie, traceparent: REQUEST_PARENT }, payload: {} });
    const { executionId } = queued.json<{ executionId: string }>();
    await until(async () => (await context.store.getExecutionHistory(executionId))?.status === "success", "the run");
    expect(context.payloads).toHaveLength(1);
    expect(Object.keys(context.payloads[0]!)).not.toContain("traceContext");
    expect(JSON.stringify(context.payloads)).not.toContain(REQUEST_TRACE);
    expect(context.exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("an approval resume links back to the node that paused", () => {
  async function paused(context: Context, workflow: Workflow) {
    const requester = await context.login("builder", "requester");
    const lead = await context.login("builder", "lead");
    await context.store.upsertWorkflow(workflow);
    const started = await context.app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/execute`, headers: { cookie: requester, traceparent: REQUEST_PARENT }, payload: { user_prompt: "Ana" } });
    const run = started.json<{ status: string; executionId: string }>();
    expect(run.status).toBe("waiting_approval");
    await until(() => spansNamed(context, "invoke_workflow").length === 1, "the first run span");
    return { lead, executionId: run.executionId };
  }

  const NEW_TRACE_PARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

  it("links the queued resume's run span to the pausing node, while its consumer span follows the approving request", async () => {
    const context = await start(TRACING);
    const { lead, executionId } = await paused(context, gated("wf-resume-q"));
    const gateNode = context.exporter.getFinishedSpans().find((span) => span.attributes["l2m.node.id"] === "gate")!;
    expect(gateNode.spanContext().traceId).toBe(REQUEST_TRACE);

    const decided = await context.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie: lead, traceparent: NEW_TRACE_PARENT }, payload: {} });
    expect(decided.statusCode, decided.body).toBe(202);
    await until(async () => (await context.store.getExecutionHistory(executionId))?.status === "success", "the resumed run");
    await until(() => runSpanOf(context, executionId).length === 2 && spansNamed(context, "process l2m.queue").length === 1, "the resume's run and consumer spans");

    const [, resumed] = runSpanOf(context, executionId).sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
    const [consumer] = spansNamed(context, "process l2m.queue");
    const approve = serverSpan(context, "/api/approvals/:id/approve");
    // A new trace: the approving request's, through the queue.
    expect(approve.spanContext().traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(consumer!.parentSpanContext?.spanId).toBe(approve.spanContext().spanId);
    expect(resumed!.spanContext().traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(resumed!.parentSpanContext?.spanId).toBe(consumer!.spanContext().spanId);
    // And a link, not a parent, to the node that paused in the original trace.
    expect(resumed!.links).toHaveLength(1);
    expect(resumed!.links[0]!.context).toMatchObject({ traceId: REQUEST_TRACE, spanId: gateNode.spanContext().spanId });
    expect(resumed!.attributes["l2m.trigger.type"]).toBe("approval_resume");
    // v70 — the paused run recorded the first trace; the queued resume, a new trace, replaces it with its own.
    await until(async () => (await context.store.getExecutionHistory(executionId))?.traceId === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the resume's trace id");
  });

  it("links an inline resume (no queue) the same way", async () => {
    // An instance without a queue consumer resumes inside the approving request.
    const context = await start(TRACING, undefined, { queue: false });
    const { lead, executionId } = await paused(context, gated("wf-resume-inline"));
    const gateNode = context.exporter.getFinishedSpans().find((span) => span.attributes["l2m.node.id"] === "gate")!;
    const decided = await context.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie: lead }, payload: {} });
    expect(decided.statusCode, decided.body).toBeLessThan(300);
    await until(() => runSpanOf(context, executionId).length === 2, "the resume's run span");
    const resumed = runSpanOf(context, executionId).find((span) => span.attributes["l2m.trigger.type"] === "approval_resume")!;
    expect(resumed.links.map((link) => link.context.spanId)).toEqual([gateNode.spanContext().spanId]);
  });

  it("stores the pausing node's context in the paused state, and nothing while tracing is off", async () => {
    const on = await start(TRACING);
    const first = await paused(on, gated("wf-state-on"));
    const gateNode = on.exporter.getFinishedSpans().find((span) => span.attributes["l2m.node.id"] === "gate")!;
    const stored = await on.store.getWorkflowExecutionState(first.executionId);
    expect((stored!.state as { traceContext?: unknown }).traceContext).toEqual({ traceparent: `00-${REQUEST_TRACE}-${gateNode.spanContext().spanId}-01` });

    const off = await start();
    const requester = await off.login("builder", "requester");
    await off.store.upsertWorkflow(gated("wf-state-off"));
    const started = await off.app.inject({ method: "POST", url: "/api/workflows/wf-state-off/execute", headers: { cookie: requester, traceparent: REQUEST_PARENT }, payload: {} });
    const pausedRun = started.json<{ executionId: string }>();
    const offState = await off.store.getWorkflowExecutionState(pausedRun.executionId);
    expect(JSON.stringify(offState!.state)).not.toContain("traceContext");
    expect(JSON.stringify(offState!.state)).not.toContain(REQUEST_TRACE);
  });

  it("a resume with no stored context (a pause from before tracing) runs without a link", async () => {
    const context = await start(TRACING);
    const { lead, executionId } = await paused(context, gated("wf-nolink"));
    const stored = await context.store.getWorkflowExecutionState(executionId);
    const { traceContext: _dropped, ...rest } = stored!.state as Record<string, unknown>;
    await context.store.saveWorkflowExecutionState({ ...stored!, state: rest } as never);
    const decided = await context.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie: lead }, payload: {} });
    expect(decided.statusCode, decided.body).toBeLessThan(300);
    await until(() => runSpanOf(context, executionId).length === 2, "the resume's run span");
    const resumed = runSpanOf(context, executionId).find((span) => span.attributes["l2m.trigger.type"] === "approval_resume")!;
    expect(resumed.links).toHaveLength(0);
  });
});

describe("schedules start new traces", () => {
  it("runs a schedule fire as a new root even when it is called from inside a request's span", async () => {
    // A cron timer created while a request is handled inherits that request's context; the route stands in for it.
    const context = await start(TRACING, ({ fireSchedule }, app) => {
      app.get("/api/otel-fire", async () => {
        await fireSchedule()!({ workflowId: "wf-sched", workflowName: "wf-sched", scheduleNodeId: "tick", cronExpression: "* * * * *", timezone: "UTC", firedAt: new Date().toISOString() });
        return { ok: true };
      });
    });
    const cookie = await context.login("builder");
    await publish(context, cookie, simple("wf-sched"));
    const response = await context.app.inject({ method: "GET", url: "/api/otel-fire", headers: { cookie } });
    expect(response.statusCode).toBeLessThan(500);
    await until(() => spansNamed(context, "invoke_workflow").length === 1, "the scheduled run span");
    const [run] = spansNamed(context, "invoke_workflow");
    const request = context.exporter.getFinishedSpans().find((span) => span.attributes["http.route"] === "/api/otel-fire")!;
    expect(run!.parentSpanContext).toBeUndefined();
    expect(run!.spanContext().traceId).not.toBe(request.spanContext().traceId);
    expect(run!.attributes["l2m.trigger.type"]).toBe("cron");
  });
});
