/**
 * A streamed run's model usage reaches spend and budgets: the provider's usage frame when it sends one, an estimate
 * of the request and the answer when it does not. Before, a streamed `llm_call` recorded no usage at all, so a block
 * budget never stopped streamed runs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-llm-stream-usage-"));
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

/** An OpenAI-compatible server that streams "hi there", with a usage frame only when `usage` is given. */
async function startModelServer(usage?: Record<string, number>): Promise<{ baseUrl: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi there" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      if (usage) response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies };
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

async function loginAdmin(context: TestContext): Promise<string> {
  const email = "admin@example.com";
  const password = "admin-Pass-123!";
  await context.authService.register({ email, password, role: "admin" });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

function llmWorkflow(baseUrl: string, extra?: Record<string, unknown>): Workflow {
  return {
    id: "wf-stream-usage",
    name: "Stream usage",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
      {
        id: "llm",
        type: "llm_call",
        name: "LLM",
        position: { x: 200, y: 0 },
        config: { provider: { providerId: "openai_compatible", model: "m", baseUrl, ...(extra ? { extra } : {}) }, promptKey: "text" }
      },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}" } }
    ],
    edges: [
      { id: "e1", source: "input", target: "llm" },
      { id: "e2", source: "llm", target: "output" }
    ]
  };
}

async function setup(usage?: Record<string, number>, extra?: Record<string, unknown>) {
  const server = await startModelServer(usage);
  const context = await createTestContext();
  const cookie = await loginAdmin(context);
  const created = await context.app.inject({
    method: "POST",
    url: "/api/workflows",
    headers: { cookie },
    payload: llmWorkflow(server.baseUrl, extra) as unknown as Record<string, unknown>
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  const streamRun = () => context.app.inject({ method: "POST", url: "/api/workflows/wf-stream-usage/execute/stream", headers: { cookie }, payload: { input: {} } });
  return { context, cookie, server, streamRun };
}

async function usageEvents(store: Store) {
  return await store.listUsageEvents({ workflowId: "wf-stream-usage" });
}

describe("usage of a streamed llm_call", () => {
  it("records the provider's usage frame, which the run asks for when the model sets extra.streamUsage", async () => {
    const { context, server, streamRun } = await setup({ prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 }, { streamUsage: true });
    expect((await streamRun()).statusCode).toBe(200);
    expect(server.bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    const [event] = await usageEvents(context.store);
    expect(event).toMatchObject({ inputTokens: 30, outputTokens: 2, totalTokens: 32, llmCallCount: 1 });
  });

  it("records an estimate when the stream has no usage frame, and a block budget then refuses the next run", async () => {
    const { context, cookie, server, streamRun } = await setup();
    const budget = await context.app.inject({
      method: "POST",
      url: "/api/budgets",
      headers: { cookie },
      payload: { name: "Tiny", scopeType: "global", period: "month", limitType: "tokens", limitValue: 1, action: "block", warnThresholdPct: 0.8 }
    });
    expect(budget.statusCode, budget.body).toBeLessThan(300);

    expect((await streamRun()).statusCode).toBe(200);
    // A compatible server is not asked for usage unless the model says so.
    expect(server.bodies[0]).not.toHaveProperty("stream_options");
    const [event] = await usageEvents(context.store);
    expect(event!.outputTokens).toBeGreaterThan(0);
    expect(event!.inputTokens).toBeGreaterThan(0);
    expect(event!.llmCallCount).toBe(1);

    const refused = await streamRun();
    expect(refused.statusCode, refused.body).toBe(402);
    expect(refused.json()).toMatchObject({ error: "budget_exceeded" });
  });
});
