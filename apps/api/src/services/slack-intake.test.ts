import { describe, expect, it } from "vitest";
import type { WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { BudgetExceededError } from "./budget-service.js";
import { QueueFullError } from "./queue-service.js";
import { DispatchGate, QUEUE_DISPATCH_CAPABILITY, RunDispatcher, type DispatchedRunSpec, type RunDispatcherDeps } from "./run-dispatch.js";
import { acceptSlackEvent } from "./slack-intake.js";

const result = { workflowId: "wf", status: "success", startedAt: "s", completedAt: "c", nodeResults: [] } as WorkflowExecutionResult;

const spec = (executionId = "exec-slack"): DispatchedRunSpec => ({
  v: 1,
  run: { executionId, triggerType: "slack_webhook", workflow: { id: "wf", name: "Flow", nodes: [], edges: [] } as never },
  progress: { requestInput: {} },
  history: { requestInput: {} }
});

const worker = {
  id: "w1",
  workerMode: "worker" as const,
  haEnabled: true,
  isLeader: false,
  pools: ["default"],
  concurrency: 5,
  running: 0,
  appVersion: "1.0.0",
  schemaVersion: 46,
  capabilities: ["bus-v1", "fenced-claims-v1", QUEUE_DISPATCH_CAPABILITY],
  hostname: "h",
  busConnected: true,
  startedAt: "s",
  heartbeatAt: "h",
  live: true
};

function harness(options: { queue: boolean; full?: boolean; duplicate?: boolean; enqueueError?: Error; budget?: boolean; runEnds?: Promise<WorkflowExecutionResult> }) {
  const enqueued: Array<{ executionId: string; queueItemId?: string }> = [];
  const local: string[] = [];
  const deps: RunDispatcherDeps = {
    gate: new DispatchGate({ mode: options.queue ? "queue" : "inline", listInstances: async () => [worker] }),
    executeLocally: async (s) => {
      local.push(s.run.executionId);
      return await (options.runEnds ?? Promise.resolve(result));
    },
    checkBackpressure: async (pool) => {
      if (options.full) throw new QueueFullError(pool, 5, 5);
    },
    recordQueued: async () => undefined,
    recordNotQueued: async () => undefined,
    enqueue: async (s, enqueueOptions) => {
      if (options.enqueueError) throw options.enqueueError;
      if (options.duplicate) return false;
      enqueued.push({ executionId: s.run.executionId, ...(enqueueOptions.queueItemId ? { queueItemId: enqueueOptions.queueItemId } : {}) });
      return true;
    },
    openRelay: async () => {
      throw new Error("not used");
    },
    waitTimeoutMs: () => 1_000,
    maxWaiting: 10,
    ...(options.budget
      ? {
          admit: async () => {
            throw new BudgetExceededError({ id: "b" } as never, 10, 5, "p");
          },
          recordRefused: async () => ({ ...result, status: "error" }) as WorkflowExecutionResult
        }
      : {})
  };
  const tracked: Array<Promise<void>> = [];
  const notTaken: unknown[] = [];
  const intakeDeps = {
    dispatcher: new RunDispatcher(deps),
    track: (run: Promise<void>) => void tracked.push(run),
    onNotTaken: (error: unknown) => void notTaken.push(error)
  };
  return { enqueued, local, tracked, notTaken, intakeDeps };
}

describe("RunDispatcher.fire after the start/fire split", () => {
  it("still records a budget refusal and resolves with it", async () => {
    const h = harness({ queue: true, budget: true });
    const outcome = await h.intakeDeps.dispatcher.fire(spec(), { pool: "default", queueItemId: "cron:x" });
    expect(outcome.queued).toBe(false);
    if (!outcome.queued) {
      expect(outcome.result.status).toBe("error");
      expect(outcome.refused).toBeInstanceOf(BudgetExceededError);
    }
    expect(h.enqueued).toHaveLength(0);
  });

  it("still waits for an inline run and passes its error on", async () => {
    const h = harness({ queue: false, runEnds: Promise.reject(new Error("boom")) });
    await expect(h.intakeDeps.dispatcher.fire(spec(), { pool: "default" })).rejects.toThrow("boom");
  });
});

describe("acceptSlackEvent", () => {
  it("queue: answers with the execution id only after the queue took the job under it", async () => {
    const h = harness({ queue: true });
    const answer = await acceptSlackEvent(spec("exec-a"), { pool: "default", queueItemId: "slack:wf:Ev1" }, h.intakeDeps);
    expect(answer).toEqual({ status: 200, body: { ok: true, accepted: true, executionId: "exec-a" } });
    expect(h.enqueued).toEqual([{ executionId: "exec-a", queueItemId: "slack:wf:Ev1" }]);
    expect(h.tracked).toHaveLength(0);
    expect(h.notTaken).toHaveLength(0);
  });

  it("queue: a full pool answers 503 so Slack retries, and nothing is queued", async () => {
    const h = harness({ queue: true, full: true });
    const answer = await acceptSlackEvent(spec(), { pool: "default", queueItemId: "slack:wf:Ev1" }, h.intakeDeps);
    expect(answer.status).toBe(503);
    expect(answer.body).not.toHaveProperty("executionId");
    expect(h.enqueued).toHaveLength(0);
    expect(h.notTaken[0]).toBeInstanceOf(QueueFullError);
  });

  it("queue: a failed enqueue answers 500 so Slack retries", async () => {
    const h = harness({ queue: true, enqueueError: new Error("db down") });
    const answer = await acceptSlackEvent(spec(), { pool: "default" }, h.intakeDeps);
    expect(answer.status).toBe(500);
    expect(answer.body).not.toHaveProperty("executionId");
    expect(h.notTaken).toHaveLength(1);
  });

  it("queue: an event the queue already holds answers duplicate without a new execution id", async () => {
    const h = harness({ queue: true, duplicate: true });
    const answer = await acceptSlackEvent(spec("exec-dup"), { pool: "default", queueItemId: "slack:wf:Ev1" }, h.intakeDeps);
    expect(answer).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(JSON.stringify(answer)).not.toContain("exec-dup");
    expect(h.notTaken).toHaveLength(0);
  });

  it("inline: answers at once with the id while the run goes on in this process", async () => {
    let finish!: (value: WorkflowExecutionResult) => void;
    const runEnds = new Promise<WorkflowExecutionResult>((resolve) => (finish = resolve));
    const h = harness({ queue: false, runEnds });
    const answer = await acceptSlackEvent(spec("exec-i"), { pool: "default", queueItemId: "slack:wf:Ev1" }, h.intakeDeps);
    expect(answer).toEqual({ status: 200, body: { ok: true, accepted: true, executionId: "exec-i" } });
    expect(h.local).toEqual(["exec-i"]);
    expect(h.tracked).toHaveLength(1);
    finish(result);
    await h.tracked[0];
    expect(h.notTaken).toHaveLength(0);
  });

  it("inline: a run that throws after the answer is reported as not taken", async () => {
    const h = harness({ queue: false, runEnds: Promise.reject(new Error("boom")) });
    const answer = await acceptSlackEvent(spec(), { pool: "default" }, h.intakeDeps);
    expect(answer.status).toBe(200);
    await h.tracked[0];
    expect(h.notTaken).toHaveLength(1);
  });

  it("a used-up budget answers refused, without an execution id or amounts", async () => {
    const h = harness({ queue: true, budget: true });
    const answer = await acceptSlackEvent(spec("exec-b"), { pool: "default" }, h.intakeDeps);
    expect(answer).toEqual({ status: 200, body: { ok: true, refused: "budget" } });
    await h.tracked[0];
    expect(h.enqueued).toHaveLength(0);
  });
});
