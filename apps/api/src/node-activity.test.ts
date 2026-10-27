/**
 * A streamed run sends `node_activity` frames while a node works, and the
 * final result carries the same entries on the node.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { NodeActivityEvent, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { RunWriteChains } from "./services/run-write-chains.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const servers: http.Server[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-node-activity-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

/** An OpenAI-compatible endpoint that answers every request, streamed or not. */
async function startModelServer(): Promise<string> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const streamed = body.includes('"stream":true');
      if (streamed) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi there" } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext): Promise<string> {
  const email = "builder@example.com";
  const password = "builder-Pass-123!";
  await context.authService.register({ email, password, role: "builder" });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

function llmWorkflow(baseUrl: string): Workflow {
  return {
    id: "wf-activity",
    name: "Activity",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
      {
        id: "llm",
        type: "llm_call",
        name: "LLM",
        position: { x: 200, y: 0 },
        config: { provider: { providerId: "openai_compatible", model: "m", baseUrl }, promptKey: "text" }
      },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

function sseFrames(body: string, event: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((frame) => frame.includes(`event: ${event}`))
    .map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:"))!.slice(5)) as Record<string, unknown>);
}

describe("node activity over SSE", () => {
  it("streams node_activity frames and keeps the same entries on the final result", async () => {
    const baseUrl = await startModelServer();
    const context = await createTestContext();
    const cookie = await login(context);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: llmWorkflow(baseUrl) as unknown as Record<string, unknown>
    });
    expect(created.statusCode).toBeLessThan(300);

    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-activity/execute/stream",
      headers: { cookie },
      payload: { input: {} }
    });
    expect(response.statusCode).toBe(200);

    const frames = sseFrames(response.body, "node_activity") as unknown as NodeActivityEvent[];
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.every((frame) => frame.nodeId === "llm")).toBe(true);
    expect(frames.map((frame) => frame.kind)).toEqual(["resolved_input", "llm_call", "llm_call"]);
    expect(frames[0]).toMatchObject({ fields: { providerId: "openai_compatible", model: "m", userPrompt: "hello" } });

    const [result] = sseFrames(response.body, "result") as Array<{ nodeResults: Array<{ nodeId: string; activity?: NodeActivityEvent[] }> }>;
    const llm = result!.nodeResults.find((entry) => entry.nodeId === "llm")!;
    expect(llm.activity?.map((entry) => entry.seq)).toEqual(frames.map((frame) => frame.seq));
  });
});

describe("history writes of one run", () => {
  it("a progress write that commits late never lands after the final write: the run stays finished", async () => {
    const baseUrl = await startModelServer();
    const context = await createTestContext();
    const cookie = await login(context);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: llmWorkflow(baseUrl) as unknown as Record<string, unknown>
    });
    expect(created.statusCode).toBeLessThan(300);

    // A networked store's pool can commit writes out of order: here a progress write made while the model node
    // is working (an activity hook's, which the engine does not await) commits after everything after it.
    const store = context.store;
    const write = store.saveExecutionHistory.bind(store);
    const order: string[] = [];
    let delayed = 0;
    store.saveExecutionHistory = (async (...args: Parameters<typeof write>) => {
      const [record] = args;
      const nodes = (record.nodeResultsJson ?? []) as Array<{ status?: string; activity?: unknown[] }>;
      if (record.status === "running" && nodes.some((node) => node.status === "running" && node.activity?.length)) {
        delayed += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const written = await write(...args);
      order.push(record.status);
      return written;
    }) as typeof write;
    let executionId: string | undefined;
    try {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/workflows/wf-activity/execute",
        headers: { cookie },
        payload: { input: {} }
      });
      expect(response.statusCode, response.body).toBe(200);
      executionId = response.json<{ executionId: string }>().executionId;
      // Let every write still in flight land.
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      store.saveExecutionHistory = write;
    }
    expect(delayed).toBeGreaterThan(0);
    expect(order).toContain("success");
    const history = await store.getExecutionHistory(executionId!);
    expect(history?.status).toBe("success");
    expect(history?.completedAt).toBeTruthy();
  });

  it("a cancel that commits between a run's last check and its final write keeps the run canceled", async () => {
    const baseUrl = await startModelServer();
    const context = await createTestContext();
    const cookie = await login(context);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: llmWorkflow(baseUrl) as unknown as Record<string, unknown>
    });
    expect(created.statusCode).toBeLessThan(300);

    // On a networked store the final write can be queued, past the run's abort check, while a cancel commits first.
    const store = context.store;
    const write = store.saveExecutionHistory.bind(store);
    let cancel: { statusCode: number; body: string } | undefined;
    store.saveExecutionHistory = (async (...args: Parameters<typeof write>) => {
      const [record, options] = args;
      if (!cancel && !options?.unlessFinished && record.status === "success") {
        cancel = await context.app.inject({ method: "POST", url: `/api/executions/${record.id}/cancel`, headers: { cookie }, payload: {} });
      }
      return write(...args);
    }) as typeof write;
    let executionId: string | undefined;
    try {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/workflows/wf-activity/execute",
        headers: { cookie },
        payload: { input: {} }
      });
      executionId = response.json<{ executionId: string }>().executionId;
    } finally {
      store.saveExecutionHistory = write;
    }
    expect(cancel?.statusCode, cancel?.body).toBe(200);
    const history = await store.getExecutionHistory(executionId!);
    expect(history?.status).toBe("canceled");
    // The refused final write is not counted as stored: no success metric and no run context for the manifest.
    const metrics = await context.app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toMatch(/_workflow_executions_success_total 0\b/);
    expect((await store.getExecutionManifest(executionId!))?.runContext ?? null).toBeNull();
  });

  it("a paused run and a run that fails before its final write keep no progress-write chain", async () => {
    const opened: string[] = [];
    const instances = new Set<RunWriteChains>();
    const open = RunWriteChains.prototype.open;
    const spy = vi.spyOn(RunWriteChains.prototype, "open").mockImplementation(function (this: RunWriteChains, executionId: string) {
      opened.push(executionId);
      instances.add(this);
      return open.call(this, executionId);
    });
    try {
      const context = await createTestContext();
      const cookie = await login(context);
      const paused: Workflow = {
        id: "wf-paused",
        name: "Paused",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
          { id: "gate", type: "approval_gate", name: "Gate", position: { x: 200, y: 0 }, config: { message: "ok?", approverRoles: ["builder"], timeoutMinutes: 60 } },
          { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
        ],
        edges: [
          { id: "e1", source: "input", target: "gate" },
          { id: "e2", source: "gate", sourceHandle: "approved", target: "output" }
        ]
      } as Workflow;
      const created = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: paused as unknown as Record<string, unknown> });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const run = await context.app.inject({ method: "POST", url: "/api/workflows/wf-paused/execute", headers: { cookie }, payload: { input: {} } });
      expect(run.json<{ status: string }>().status).toBe("waiting_approval");

      // A run that throws after its hooks were made, before any final write.
      const listVariables = context.store.listVariables.bind(context.store);
      context.store.listVariables = async () => {
        throw new Error("store unavailable");
      };
      try {
        await context.app.inject({ method: "POST", url: "/api/workflows/wf-paused/execute", headers: { cookie }, payload: { input: {} } });
      } finally {
        context.store.listVariables = listVariables;
      }
      expect(opened.length).toBeGreaterThanOrEqual(2);
      expect([...instances].map((chains) => chains.size)).toEqual([0]);
    } finally {
      spy.mockRestore();
    }
  });
});
