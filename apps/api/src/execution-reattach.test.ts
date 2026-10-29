/**
 * Phase 13.1 — with EXECUTION_DISPATCH unset (inline, the default) nothing changes: runs execute on the instance that
 * received them, /api/cluster reports `executionDispatch: "inline"`, and no dispatch warning or metric appears. SQLite.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface Context {
  app: FastifyInstance;
  store: Store;
  auth: AuthService;
  tempDir: string;
}

const contexts: Context[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Closed by the app's shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function start(): Promise<Context> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reattach-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    METRICS_ENABLED: "true",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const auth = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), auth);
  await app.ready();
  const context = { app, store, auth, tempDir };
  contexts.push(context);
  return context;
}

async function login(context: Context, role: "admin" | "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.auth.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  return String([response.headers["set-cookie"]].flat()[0]).split(";")[0]!;
}

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function waitingWorkflow(id: string, delayMs: number): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [node("input", "text_input", { text: "hi" }), node("wait", "wait_node", { delayMs, maxDelayMs: delayMs }), node("out", "output", { responseTemplate: "done" })],
    edges: [
      { id: "e1", source: "input", target: "wait" },
      { id: "e2", source: "wait", target: "out" }
    ]
  };
}

/** The `event:` names of an SSE body, in order, and each event's data. */
function sseEvents(body: string): Array<{ event: string; data: unknown }> {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [first, ...rest] = frame.split("\n");
      return { event: first!.slice("event: ".length), data: JSON.parse(rest.map((line) => line.slice("data: ".length)).join("\n")) as unknown };
    });
}

async function until<T>(read: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("inline dispatch (the default)", () => {
  it("reports inline in /api/cluster, with no dispatch warning or metric", async () => {
    const context = await start();
    const admin = await login(context, "admin");
    const cluster = (await context.app.inject({ method: "GET", url: "/api/cluster", headers: { cookie: admin } })).json<Record<string, unknown>>();
    expect(cluster).toMatchObject({ clusterMode: false, executionDispatch: "inline", executionDispatchConfigured: "inline", executionDispatchFallbackReason: null });
    const health = (await context.app.inject({ method: "GET", url: "/health" })).json<{ warnings?: Array<{ code: string }> }>();
    expect((health.warnings ?? []).map((warning) => warning.code)).not.toContain("dispatch_inline_fallback");
    const metrics = (await context.app.inject({ method: "GET", url: "/metrics" })).body;
    expect(metrics).not.toMatch(/_dispatch_/);
  });
});
