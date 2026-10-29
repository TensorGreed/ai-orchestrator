/**
 * Phase 13.1 — the queue with real worker processes (`src/index.ts` under tsx, WORKER_MODE=worker, cluster mode) on
 * one Postgres database, killed the hard way:
 *   - SIGKILL a worker while its run waits in its first node: the job is taken back after the lease and completes
 *     once on the survivor (lost_count 1);
 *   - SIGKILL a worker after its run completed a node: the run is marked `interrupted: worker lost`, dead-lettered,
 *     and nothing runs it again;
 *   - SIGTERM a worker running a short and a long job with a short drain: the short one finishes, the long one is
 *     given back with its attempts unchanged, and the process exits 0.
 * Random high ports, short leases, polling helpers. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { WORKER_LOST_INTERRUPTED_ERROR } from "./db/queue-leases.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("queue chaos with real worker processes");

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PORTS = new Set([4000, 4100, 5173, 5199]);

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    if (port > 0 && !FORBIDDEN_PORTS.has(port)) return port;
  }
}

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, nodes: WorkflowNode[]): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: nodes.slice(1).map((target, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: target.id }))
  };
}

interface Worker {
  name: string;
  child: ChildProcess;
  port: number;
  output: string[];
  exited: Promise<number | null>;
}

run("queue chaos with real worker processes", () => {
  let primary: TestStore | undefined;
  const workers: Worker[] = [];

  afterAll(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
      await worker.exited;
    }
    await primary?.cleanup();
  }, 60_000);

  function databaseUrl(): string {
    const url = new URL(testPostgresUrl()!);
    url.pathname = `/${primary!.postgres!.database}`;
    return url.toString();
  }

  /** Starts a worker; a port taken between the probe and the bind (another test's server) is retried on a new port. */
  async function startWorker(name: string, extra: Record<string, string> = {}): Promise<Worker> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await bootWorker(name, extra);
      } catch (error) {
        if (attempt >= 3 || !String(error).includes("EADDRINUSE")) throw error;
      }
    }
  }

  async function bootWorker(name: string, extra: Record<string, string>): Promise<Worker> {
    const port = await freePort();
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      API_HOST: "127.0.0.1",
      API_PORT: String(port),
      DB_TYPE: "postgres",
      DB_POSTGRESDB_URL: databaseUrl(),
      DB_POSTGRESDB_POOL_SIZE: "4",
      SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      SEED_SAMPLE_WORKFLOWS: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      WORKER_MODE: "worker",
      HA_ENABLED: "true",
      HA_INSTANCE_ID: name,
      HA_RENEW_INTERVAL_MS: "200",
      QUEUE_POLL_INTERVAL_MS: "100",
      QUEUE_HEARTBEAT_MS: "200",
      QUEUE_LEASE_MS: "1500",
      QUEUE_REAPER_INTERVAL_MS: "200",
      SHUTDOWN_DRAIN_MS: "1500",
      ...extra
    };
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const worker = { name, child, port, output, exited };
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`${name} exited during boot:\n${output.join("")}`);
      try {
        return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
      } catch {
        return false;
      }
    }, `${name} to be ready`, 60_000).catch(async (error: unknown) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      throw error;
    });
    workers.push(worker);
    return worker;
  }

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  async function enqueue(workflowId: string): Promise<string> {
    const executionId = randomUUID();
    await primary!.store.enqueueExecution({ id: executionId, workflowId, payload: { workflowId, executionId, triggerType: "chaos" } });
    return executionId;
  }

  const queueRow = async (id: string) =>
    (await sql<{ status: string; claimed_by: string | null; attempts: number; lost_count: number }>(
      `SELECT status, claimed_by, attempts, lost_count FROM execution_queue WHERE id = $1`,
      [id]
    ))[0]!;

  const workerNamed = (name: string | null) => workers.find((worker) => worker.name === name)!;

  it("survives SIGKILL before and after a node completed, and drains on SIGTERM", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const store = primary.store;
    await store.upsertWorkflow(workflow("wf-wait-first", [node("wait", "wait_node", { delayMs: 2_500, maxDelayMs: 2_500 }), node("out", "output", { responseTemplate: "done" })]));
    await store.upsertWorkflow(
      workflow("wf-node-then-wait", [
        node("input", "text_input", { text: "hi" }),
        node("wait", "wait_node", { delayMs: 20_000, maxDelayMs: 20_000 }),
        node("out", "output", { responseTemplate: "done" })
      ])
    );
    await store.upsertWorkflow(workflow("wf-short", [node("wait", "wait_node", { delayMs: 500, maxDelayMs: 500 }), node("out", "output", { responseTemplate: "done" })]));
    await store.upsertWorkflow(workflow("wf-long", [node("wait", "wait_node", { delayMs: 60_000, maxDelayMs: 60_000 }), node("out", "output", { responseTemplate: "done" })]));

    try {
      await Promise.all([startWorker("chaos-a"), startWorker("chaos-b")]);

      // 1. SIGKILL while the run waits in its first node: taken back, re-run once on the survivor.
      const first = await enqueue("wf-wait-first");
      const firstOwner = await until(async () => (await queueRow(first)).claimed_by, "a worker to claim the first job");
      workerNamed(firstOwner).child.kill("SIGKILL");
      await workerNamed(firstOwner).exited;
      await until(async () => (await queueRow(first)).status === "completed", "the first job to complete on the survivor", 60_000);
      const firstRow = await queueRow(first);
      expect(firstRow).toMatchObject({ attempts: 1, lost_count: 1 });
      expect(firstRow.claimed_by).not.toBe(firstOwner);
      expect(await store.getExecutionHistory(first)).toMatchObject({ status: "success" });

      // 2. SIGKILL after the run's first node completed: interrupted and dead-lettered, never re-run.
      await startWorker("chaos-c");
      const second = await enqueue("wf-node-then-wait");
      const secondOwner = await until(async () => {
        const history = await store.getExecutionHistory(second);
        const nodes = (history?.nodeResults ?? []) as Array<{ nodeId: string; status: string }>;
        return nodes.some((entry) => entry.nodeId === "input" && entry.status === "success") ? (await queueRow(second)).claimed_by : null;
      }, "the second run to complete its first node");
      workerNamed(secondOwner).child.kill("SIGKILL");
      await workerNamed(secondOwner).exited;
      await until(async () => (await queueRow(second)).status === "dead", "the second job to be dead-lettered", 60_000);
      expect(await store.getExecutionHistory(second)).toMatchObject({ status: "error", error: WORKER_LOST_INTERRUPTED_ERROR });
      expect((await store.listDlqItems()).map((item) => [item.originalId, item.finalError])).toEqual([[second, WORKER_LOST_INTERRUPTED_ERROR]]);
      expect(await queueRow(second)).toMatchObject({ attempts: 1, lost_count: 1 });

      // 3. SIGTERM with a short drain: one worker left, running a short and a long job.
      const alive = workers.filter((worker) => worker.child.exitCode === null && worker.child.signalCode === null);
      for (const extra of alive.slice(1)) {
        extra.child.kill("SIGTERM");
        expect(await extra.exited).toBe(0);
      }
      const last = alive[0]!;
      const short = await enqueue("wf-short");
      const long = await enqueue("wf-long");
      await until(async () => (await queueRow(short)).status === "running" && (await queueRow(long)).status === "running", "both jobs to run");
      // SHUTDOWN_DRAIN_MS is 1.5 s: the short job finishes within it, the long one is given back.
      last.child.kill("SIGTERM");
      const code = await last.exited;
      expect(code, last.output.join("")).toBe(0);
      expect(await store.getExecutionHistory(short)).toMatchObject({ status: "success" });
      expect(await queueRow(long)).toMatchObject({ status: "pending", attempts: 0, lost_count: 0, claimed_by: null });
    } catch (error) {
      for (const worker of workers) {
        // eslint-disable-next-line no-console
        console.error(`--- ${worker.name} (port ${worker.port}) ---\n${worker.output.join("").slice(-6_000)}`);
      }
      throw error;
    }
  }, 240_000);
});
