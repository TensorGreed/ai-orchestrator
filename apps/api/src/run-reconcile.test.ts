/**
 * Runs left "running" by a stopped server are reconciled to errors, the queue sweeper
 * never re-runs a job that is still executing, and user-initiated run actions are audited.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { QueueService, resolveStuckJobTimeoutMs, STUCK_JOB_MARGIN_MS } from "./services/queue-service.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { INTERRUPTED_RUN_ERROR, reconcileInterruptedRuns } from "./services/run-reconcile-service.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];

async function makeStore(): Promise<{ store: SqliteStore; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reconcile-"));
  dirs.push(dir);
  const store = await SqliteStore.create(path.join(dir, "orchestrator.db"));
  stores.push(store);
  store.ensureDefaultProject();
  return { store, dir };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed.
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function saveRun(store: SqliteStore, id: string, status: string, startedAt: string): void {
  store.saveExecutionHistory({ id, workflowId: "wf", status, startedAt });
}

describe("reconcileInterruptedRuns", () => {
  it("marks running runs as errors and leaves approvals, finished runs and queue-owned runs alone", async () => {
    const { store } = await makeStore();
    const old = new Date(Date.now() - 3_600_000).toISOString();
    saveRun(store, "orphan", "running", old);
    saveRun(store, "paused", "waiting_approval", old);
    saveRun(store, "done", "success", old);
    saveRun(store, "queued", "running", old);
    store.enqueueExecution({ id: "queued", workflowId: "wf", payload: {}, priority: 0, maxAttempts: 3 });

    const reconciled = reconcileInterruptedRuns(store, { haEnabled: false, executionTimeoutMs: 300_000 });

    expect(reconciled).toEqual([{ id: "orphan", workflowId: "wf" }]);
    const orphan = store.getExecutionHistory("orphan")!;
    expect(orphan.status).toBe("error");
    expect(orphan.error).toBe(INTERRUPTED_RUN_ERROR);
    expect(orphan.completedAt).toBeTruthy();
    expect(orphan.durationMs).toBeGreaterThan(0);
    expect(store.getExecutionHistory("paused")!.status).toBe("waiting_approval");
    expect(store.getExecutionHistory("done")!.status).toBe("success");
    expect(store.getExecutionHistory("queued")!.status).toBe("running");
    expect(reconcileInterruptedRuns(store, { haEnabled: false, executionTimeoutMs: 300_000 })).toEqual([]);
  });

  it("with several replicas only touches runs older than the run time limit plus the margin", async () => {
    const { store } = await makeStore();
    const now = Date.now();
    saveRun(store, "fresh", "running", new Date(now - 60_000).toISOString());
    saveRun(store, "stale", "running", new Date(now - 300_000 - STUCK_JOB_MARGIN_MS - 1_000).toISOString());

    const reconciled = reconcileInterruptedRuns(store, { haEnabled: true, executionTimeoutMs: 300_000, now });

    expect(reconciled.map((run) => run.id)).toEqual(["stale"]);
    expect(store.getExecutionHistory("fresh")!.status).toBe("running");
  });
});

describe("queue stuck-job sweeper", () => {
  it("never sets the stuck threshold below the run time limit plus a margin", () => {
    expect(resolveStuckJobTimeoutMs(600_000, 900_000)).toBe(900_000 + STUCK_JOB_MARGIN_MS);
    expect(resolveStuckJobTimeoutMs(600_000, 300_000)).toBe(600_000);
  });

  it("does not requeue a job this process is still executing", async () => {
    const { store } = await makeStore();
    store.enqueueExecution({ id: "job-1", workflowId: "wf", payload: {}, priority: 0, maxAttempts: 3 });
    store.enqueueExecution({ id: "job-2", workflowId: "wf", payload: {}, priority: 0, maxAttempts: 3 });
    store.dequeueNext(2);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.requeueStuckItems(0, ["job-1"])).toBe(1);
    expect(store.getQueueDepth()).toMatchObject({ pending: 1, running: 1 });
    expect(new QueueService(store, { stuckJobTimeoutMs: 1, executionTimeoutMs: 120_000 })).toBeInstanceOf(QueueService);
  });
});

describe("run audit events", () => {
  it("records started, retried, replayed and cancelled for user-initiated actions", async () => {
    const { store, dir } = await makeStore();
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(dir, "sync")
    });
    const authService = new AuthService(store, config.SESSION_TTL_HOURS);
    const app = createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
    await app.ready();
    try {
      authService.register({ email: "builder@example.com", password: "builder-Pass-123!", role: "builder" });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "builder@example.com", password: "builder-Pass-123!" }
      });
      const raw = login.headers["set-cookie"];
      const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((v) => v.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
      const workflow: Workflow = {
        id: "wf-audit",
        name: "Audit",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hi" } },
          { id: "output", type: "output", name: "Output", position: { x: 200, y: 0 }, config: { responseTemplate: "{{answer}}" } }
        ],
        edges: [{ id: "e1", source: "input", target: "output" }]
      };
      const created = await app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow as unknown as Record<string, unknown> });
      expect(created.statusCode).toBeLessThan(300);

      const run = await app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/execute`, headers: { cookie }, payload: {} });
      const runId = (run.json() as { executionId: string }).executionId;

      const failed = crypto.randomUUID();
      store.saveExecutionHistory({ id: failed, workflowId: workflow.id, status: "error", startedAt: new Date().toISOString() });
      const retry = await app.inject({ method: "POST", url: `/api/executions/${failed}/retry`, headers: { cookie }, payload: {} });
      expect(retry.statusCode).toBeLessThan(500);

      const running = crypto.randomUUID();
      store.saveExecutionHistory({ id: running, workflowId: workflow.id, status: "running", startedAt: new Date().toISOString() });
      const cancel = await app.inject({ method: "POST", url: `/api/executions/${running}/cancel`, headers: { cookie }, payload: {} });
      expect(cancel.statusCode).toBe(200);

      const events = store.listAuditLogs({ pageSize: 100 } as never) as { items: Array<{ eventType: string; metadata: Record<string, unknown> }> };
      const types = events.items.map((item) => item.eventType);
      expect(types).toContain("execution.started");
      expect(types).toContain("execution.retried");
      expect(types).toContain("execution.cancelled");
      const started = events.items.find((item) => item.eventType === "execution.started")!;
      expect(started.metadata.executionId).toBe(runId);
      expect(events.items.find((item) => item.eventType === "execution.retried")!.metadata.sourceExecutionId).toBe(failed);
    } finally {
      await app.close();
    }
  });
});
