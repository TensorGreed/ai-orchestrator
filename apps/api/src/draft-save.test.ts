/**
 * Draft saves and the editor's webhook test payload: a workflow saves without an Output node and with unfinished node
 * settings (only a broken graph or a live-trigger setting blocks it), and "Webhook run" sends a payload the workflow
 * keeps in its settings.
 */
import crypto from "node:crypto";
import fs from "node:fs";
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

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-draft-save-"));
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

afterEach(async () => {
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

const position = { x: 0, y: 0 };

function hookFlow(extra: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-hook-draft",
    name: "Hook draft",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "draft-orders", method: "POST" } },
      { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "line", valueTemplate: "order for {{webhook.customer}}" }] } }
    ],
    edges: [{ id: "e1", source: "hook", target: "set" }],
    ...extra
  };
}

describe("saving a draft", () => {
  it("saves a workflow without an Output node, and validate reports it as a warning", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const saved = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: hookFlow() });
    expect(saved.statusCode).toBe(200);
    const validation = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/validate", headers: { cookie }, payload: {} });
    const body = validation.json() as { valid: boolean; issues: Array<{ code: string; severity?: string }> };
    expect(body.valid).toBe(true);
    expect(body.issues.find((issue) => issue.code === "missing_output_node")?.severity).toBe("warning");
  });

  it("saves unfinished node settings, which validate still lists and a run still refuses", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const draft = hookFlow({
      nodes: [...hookFlow().nodes, { id: "http", type: "http_request", name: "HTTP", position, config: { method: "POST" } }],
      edges: [...hookFlow().edges, { id: "e2", source: "set", target: "http" }]
    });
    const saved = await context.app.inject({ method: "PUT", url: "/api/workflows/wf-hook-draft", headers: { cookie }, payload: draft });
    expect(saved.statusCode).toBe(200);
    const validation = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/validate", headers: { cookie }, payload: {} });
    const body = validation.json() as { valid: boolean; issues: Array<{ code: string }> };
    expect(body.valid).toBe(false);
    expect(body.issues.map((issue) => issue.code)).toContain("missing_http_request_url_template");
    const run = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/execute", headers: { cookie }, payload: {} });
    expect(JSON.stringify(run.json())).toContain("requires a non-empty urlTemplate");
  });

  it("refuses a broken graph and says why once", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const cyclic = hookFlow({ edges: [...hookFlow().edges, { id: "e2", source: "set", target: "hook" }] });
    const response = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: cyclic });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; validation: { issues: Array<{ code: string; message: string }> } };
    expect(body.validation.issues.map((issue) => issue.code)).toEqual(["cycle_detected"]);
    expect(body.error).toBe(`Workflow validation failed: ${body.validation.issues[0]!.message}`);
    expect(body.error).not.toContain("Output node");
  });

  it("refuses a webhook whose authentication is half set up, since a saved trigger is live", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const unsafe = hookFlow({
      nodes: [{ id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "draft-orders", method: "POST", authMode: "bearer_token" } }],
      edges: []
    });
    const response = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: unsafe });
    expect(response.statusCode).toBe(400);
  });
});

describe("the webhook test payload", () => {
  it("is kept in the workflow's settings, and credential fields are refused", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const saved = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie },
      payload: hookFlow({ settings: { testWebhookPayload: { customer: "Ana" } } })
    });
    expect(saved.statusCode).toBe(200);
    const read = await context.app.inject({ method: "GET", url: "/api/workflows/wf-hook-draft", headers: { cookie } });
    expect((read.json() as Workflow).settings?.testWebhookPayload).toEqual({ customer: "Ana" });

    const refused = await context.app.inject({
      method: "PUT",
      url: "/api/workflows/wf-hook-draft",
      headers: { cookie },
      payload: hookFlow({ settings: { testWebhookPayload: { customer: "Ana", api_token: "sk-123" } } })
    });
    expect(refused.statusCode).toBe(400);
    expect(JSON.stringify(refused.json())).toContain("api_token");
  });

  it("is what {{webhook.<field>}} reads in a webhook run, streamed or not, and the run stores it as its input", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: hookFlow() });

    const run = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/execute",
      headers: { cookie },
      payload: { workflow_id: "wf-hook-draft", session_id: "s-1", payload: { customer: "Ana" } }
    });
    expect(run.statusCode).toBe(200);
    const result = run.json() as { status: string; output: unknown; executionId: string };
    expect(result.status).toBe("success");
    expect(JSON.stringify(result.output)).toContain("order for Ana");

    const detail = await context.app.inject({ method: "GET", url: `/api/executions/${result.executionId}`, headers: { cookie } });
    expect(JSON.stringify((detail.json() as { input?: unknown }).input)).toContain('"customer":"Ana"');

    const stream = await context.app.inject({
      method: "POST",
      url: "/api/webhooks/execute/stream",
      headers: { cookie },
      payload: { workflow_id: "wf-hook-draft", payload: { customer: "Bo" } }
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain("order for Bo");
  });

  it("leaves a run without one as before", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: hookFlow() });
    const run = await context.app.inject({ method: "POST", url: "/api/webhooks/execute", headers: { cookie }, payload: { workflow_id: "wf-hook-draft" } });
    expect(run.statusCode).toBe(200);
    expect(JSON.stringify((run.json() as { output: unknown }).output)).toContain("order for ");
  });
});
