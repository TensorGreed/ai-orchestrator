/**
 * A run whose model call hangs ends on the execution timeout with the error
 * on the node (WORKFLOW_TIMEOUT + remediation) and a final result frame, and
 * streamed runs send `: ping` heartbeats while nothing else is sent.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ErrorCategory, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { SSE_HEARTBEAT_FRAME, startSseHeartbeat } from "./sse-heartbeat.js";
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

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-run-timeout-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

/** An LLM endpoint that accepts the request and never answers. */
async function startHangingProvider(): Promise<{ baseUrl: string; requests: () => number }> {
  let count = 0;
  const server = http.createServer(() => {
    count += 1;
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests: () => count };
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

function hangingLlmWorkflow(baseUrl: string): Workflow {
  return {
    id: "wf-hanging-llm",
    name: "Hanging LLM",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "input", type: "text_input", name: "Input", position: { x: 0, y: 0 }, config: { text: "hello" } },
      {
        id: "llm",
        type: "llm_call",
        name: "LLM",
        position: { x: 200, y: 0 },
        config: { provider: { providerId: "openai_compatible", model: "m", baseUrl } }
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

describe("run-level execution timeout", () => {
  it("ends a streamed run with a hanging model call as a node error with WORKFLOW_TIMEOUT remediation and a final result", async () => {
    const provider = await startHangingProvider();
    const context = await createTestContext({ SSE_HEARTBEAT_INTERVAL_MS: "100" });
    const cookie = await login(context);
    const created = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: hangingLlmWorkflow(provider.baseUrl) as unknown as Record<string, unknown>
    });
    expect(created.statusCode).toBeLessThan(300);

    const startedAt = Date.now();
    const response = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-hanging-llm/execute/stream",
      headers: { cookie },
      payload: { input: {}, executionTimeoutMs: 1000 }
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(200);
    // The timeout interrupted the call: no 60s header wait, no retries.
    expect(elapsedMs).toBeLessThan(5_000);
    expect(provider.requests()).toBe(1);

    const llmComplete = sseFrames(response.body, "node_complete").find((event) => event.nodeId === "llm");
    expect(llmComplete).toMatchObject({
      status: "error",
      error: "Workflow exceeded the 1000ms execution timeout.",
      errorCategory: ErrorCategory.WORKFLOW_TIMEOUT,
      retryable: false
    });
    expect(String(llmComplete?.errorRemediation)).toContain("1000ms execution timeout");

    const results = sseFrames(response.body, "result");
    expect(results).toHaveLength(1);
    const result = results[0] as {
      status: string;
      executionId: string;
      errorCategory?: string;
      errorRemediation?: string;
      nodeResults: Array<{ nodeId: string; status: string; errorCategory?: string; output?: unknown }>;
    };
    expect(result.status).toBe("error");
    expect(result.errorCategory).toBe(ErrorCategory.WORKFLOW_TIMEOUT);
    expect(result.errorRemediation).toContain("WORKFLOW_EXECUTION_TIMEOUT_MS");
    expect(result.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({
      status: "error",
      errorCategory: ErrorCategory.WORKFLOW_TIMEOUT
    });
    expect(result.nodeResults.find((entry) => entry.nodeId === "output")).toMatchObject({
      status: "skipped",
      output: { reason: "execution_timeout" }
    });

    // The run is saved as an error, not rewritten as canceled.
    const history = await context.store.getExecutionHistory(result.executionId);
    expect(history?.status).toBe("error");

    // Heartbeats were sent while the model call was pending.
    expect(response.body).toContain(SSE_HEARTBEAT_FRAME);
  });
});

describe("startSseHeartbeat", () => {
  it("writes a ping comment on each interval until stopped", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const stop = startSseHeartbeat({ write: (chunk: string) => writes.push(chunk) }, 15_000);
      vi.advanceTimersByTime(14_999);
      expect(writes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(writes).toEqual([": ping\n\n"]);
      vi.advanceTimersByTime(30_000);
      expect(writes).toHaveLength(3);
      stop();
      vi.advanceTimersByTime(60_000);
      expect(writes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops on its own once the response has ended or the client left", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      let closed = false;
      startSseHeartbeat({ write: (chunk: string) => writes.push(chunk) }, 1_000, () => closed);
      vi.advanceTimersByTime(1_000);
      closed = true;
      vi.advanceTimersByTime(5_000);
      expect(writes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
