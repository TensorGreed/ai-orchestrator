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
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { NodeActivityEvent, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const servers: http.Server[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-node-activity-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
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
  const app = createApp(config, store, secretService, authService);
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
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext): Promise<string> {
  const email = "builder@example.com";
  const password = "builder-Pass-123!";
  context.authService.register({ email, password, role: "builder" });
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
