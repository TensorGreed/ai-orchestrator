/**
 * 12.6 (D6, D8) — gateway rate limits and budget blocks across in-process replicas on one Postgres database in
 * cluster mode (HA_ENABLED).
 *
 * - A client's per-minute rate is counted in the shared database buckets: its calls through two replicas add up.
 * - Concurrency stays per replica.
 * - A block budget refuses queue-dispatched runs on the replica that takes the request (402, nothing enqueued) and a
 *   schedule the worker's leader fires (a failed run, nothing enqueued); a budget created on one replica applies on
 *   the other within the snapshot's re-read.
 *
 * Polling `until()` helpers, no fixed sleeps. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { QueueService } from "./services/queue-service.js";
import { SchedulerService, type SchedulerExecutionInput } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("gateway limits and budgets across replicas");

interface Replica {
  name: string;
  app: FastifyInstance;
  store: PostgresStore;
  schedule?: (input: SchedulerExecutionInput) => Promise<void>;
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

function chain(id: string, nodes: WorkflowNode[]): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes,
    edges: nodes.slice(1).map((target, index) => ({ id: `e${index}`, source: nodes[index]!.id, target: target.id }))
  } as Workflow;
}

run("gateway limits and budgets across replicas on one Postgres database", () => {
  let primary: TestStore | undefined;
  const replicas: Replica[] = [];
  const tempDirs: string[] = [];
  const masterKey = crypto.randomBytes(32).toString("base64");

  afterEach(async () => {
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function addReplica(name: string, mode: "api" | "worker", env: Record<string, string> = {}): Promise<Replica> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-gw-cluster-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 8 });
    const config = parseConfig({
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: masterKey,
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
    const replica: Replica = { name, app: undefined as unknown as FastifyInstance, store };
    const queue = mode === "worker" ? new QueueService(store, { pollIntervalMs: 25, concurrency: 5 }) : undefined;
    const scheduler = mode === "worker" ? new SchedulerService(store, () => undefined) : undefined;
    if (scheduler) {
      const set = scheduler.setExecutionHandler.bind(scheduler);
      scheduler.setExecutionHandler = (handler) => {
        replica.schedule = handler;
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
      undefined,
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

  async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const pool = testStorePool(primary!);
    try {
      return (await pool.query<T>(text, params)).rows;
    } finally {
      await pool.end();
    }
  }

  async function gatewayClient(replica: Replica, admin: string) {
    const server = await replica.app.inject({ method: "POST", url: "/api/mcp/servers", headers: { cookie: admin }, payload: { name: "Mock", adapterId: "mock-mcp", probeEnabled: false } });
    expect(server.statusCode, server.body).toBe(201);
    const serverId = server.json<{ server: { id: string } }>().server.id;
    expect((await replica.app.inject({ method: "POST", url: `/api/mcp/servers/${serverId}/probe`, headers: { cookie: admin } })).statusCode).toBe(200);
    const toolset = await replica.app.inject({ method: "POST", url: "/api/mcp/toolsets", headers: { cookie: admin }, payload: { name: "Shared", members: [{ kind: "server", serverId }] } });
    expect(toolset.statusCode, toolset.body).toBe(201);
    const slug = toolset.json<{ toolset: McpToolset }>().toolset.slug;
    const client = await replica.app.inject({ method: "POST", url: "/api/mcp/clients", headers: { cookie: admin }, payload: { name: "Fleet agent", toolsetIds: [toolset.json<{ toolset: McpToolset }>().toolset.id], role: "builder" } });
    expect(client.statusCode, client.body).toBe(201);
    return { slug, ...client.json<{ client: McpClient; token: string }>() };
  }

  /** One MCP session on `replica`; returns a caller of the calculator tool. */
  async function session(replica: Replica, slug: string, token: string) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
    const init = await replica.app.inject({
      method: "POST",
      url: `/mcp/${slug}`,
      headers,
      payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cluster", version: "1" } } })
    });
    expect(init.statusCode, init.body).toBe(200);
    const sessionId = init.headers["mcp-session-id"] as string;
    const listed = await replica.app.inject({ method: "POST", url: `/mcp/${slug}`, headers: { ...headers, "mcp-session-id": sessionId }, payload: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    const name = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.find((tool) => tool.name.endsWith("__calculator"))!.name;
    let id = 10;
    return async () => {
      const response = await replica.app.inject({
        method: "POST",
        url: `/mcp/${slug}`,
        headers: { ...headers, "mcp-session-id": sessionId },
        payload: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method: "tools/call", params: { name, arguments: { expression: "1+1" } } })
      });
      return response.json<{ result?: unknown; error?: { code: number; data?: { reason?: string } } }>();
    };
  }

  it("counts a client's per-minute rate across replicas in the shared buckets", async () => {
    const a = await addReplica("api-a", "api");
    const b = await addReplica("api-b", "api");
    const admin = await cookieFor(a, "admin", "admin");
    const { slug, client, token } = await gatewayClient(a, admin);
    const patched = await a.app.inject({ method: "PATCH", url: `/api/mcp/clients/${client.id}`, headers: { cookie: admin }, payload: { rateLimit: { requestsPerMinute: 3 } } });
    expect(patched.statusCode, patched.body).toBe(200);
    const onA = await session(a, slug, token);
    const onB = await session(b, slug, token);
    expect((await onA()).result).toBeDefined();
    expect((await onB()).result).toBeDefined();
    expect((await onA()).result).toBeDefined();
    // The fourth call in the minute, on either replica, is over the shared count.
    expect((await onB()).error).toMatchObject({ code: -32029, data: { reason: "rate_limited" } });
    expect((await onA()).error?.code).toBe(-32029);
    const buckets = await sql<{ key: string; count: number }>(`SELECT key, count FROM rate_limit_buckets WHERE key LIKE 'rl:mcp-gateway:%'`);
    expect(buckets.map((row) => row.key)).toEqual([`rl:mcp-gateway:client:${client.id}:3:3`]);
  });

  it("refuses queue-dispatched runs and a worker's schedule under a block budget created on another replica", async () => {
    const worker = await addReplica("worker-1", "worker", { EXECUTION_DISPATCH: "queue" });
    const api = await addReplica("api-q", "api", { EXECUTION_DISPATCH: "queue" });
    const admin = await cookieFor(api, "admin", "admin");
    await until(async () => (await api.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json<{ executionDispatch: string }>().executionDispatch === "queue", "api-q to dispatch to the queue");
    const save = async (workflow: Workflow) => {
      const response = await api.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: admin }, payload: workflow as unknown as Record<string, unknown> });
      expect(response.statusCode, response.body).toBeLessThan(300);
    };
    await save(chain("wf-hook", [node("hook", "webhook_input", { path: "budget-hook", method: "POST", authMode: "none" }), node("out", "output", { responseTemplate: "hooked" })]));
    await save(chain("wf-cron", [node("cron", "schedule_trigger", { cronExpression: "0 0 1 1 *", timezone: "UTC" }), node("out", "output", { responseTemplate: "tick" })]));
    // Under the budget: the webhook runs on the worker.
    expect((await api.app.inject({ method: "POST", url: "/webhook/budget-hook", payload: {} })).statusCode).toBe(200);
    // The budget is created on the worker; the api replica sees it within its snapshot's re-read.
    const created = await worker.app.inject({
      method: "POST",
      url: "/api/budgets",
      headers: { cookie: await cookieFor(worker, "admin", "admin") },
      payload: { name: "Cluster cap", scopeType: "global", period: "month", limitType: "tokens", limitValue: 1, action: "block" }
    });
    expect(created.statusCode, created.body).toBe(200);
    await sql(
      `INSERT INTO usage_events (id, execution_id, workflow_id, workflow_name, status, input_tokens, output_tokens, cached_input_tokens, total_tokens, cost_usd, llm_call_count, duration_ms, providers_json, created_at)
       VALUES ($1, $2, 'wf-x', 'x', 'success', 5, 0, 0, 5, 0, 1, 1, '[]', now())`,
      [`usage_${crypto.randomUUID()}`, `exec_${crypto.randomUUID()}`]
    );
    const refused = await until(async () => {
      const response = await api.app.inject({ method: "POST", url: "/webhook/budget-hook", payload: {} });
      return response.statusCode === 402 ? response : null;
    }, "the api replica to refuse the webhook");
    expect(refused.json()).toMatchObject({ error: "budget_exceeded", message: 'Budget "Cluster cap" exceeded for the current month.' });
    // From now on nothing is enqueued.
    const queuedBefore = Number((await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM execution_queue`))[0]!.n);
    expect((await api.app.inject({ method: "POST", url: "/webhook/budget-hook", payload: {} })).statusCode).toBe(402);
    // The worker's leader fires a schedule: a failed run, nothing enqueued.
    await worker.schedule!({ workflowId: "wf-cron", workflowName: "wf-cron", scheduleNodeId: "cron", cronExpression: "0 0 1 1 *", timezone: "UTC", firedAt: new Date().toISOString(), scheduledFor: new Date().toISOString() });
    const [cronRun] = await sql<{ status: string; error: string | null; trigger_type: string }>(`SELECT status, error, trigger_type FROM execution_history WHERE workflow_id = 'wf-cron'`);
    expect(cronRun).toMatchObject({ status: "error", trigger_type: "cron", error: 'Budget "Cluster cap" exceeded for the current month. The run did not start.' });
    expect(Number((await sql<{ n: string }>(`SELECT COUNT(*) AS n FROM execution_queue`))[0]!.n)).toBe(queuedBefore);
  });
});
