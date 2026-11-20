/**
 * Webhook Response Mode "On Received": the caller gets 202 with the run's id at once, and the run goes on in the
 * background (production and test routes). The reply still goes through the response rules; an idempotency retry gets
 * the same answer; a used-up block budget still answers 402 before anything runs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { getNodeDefinition, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { webhookTestCookie } from "./test-support/webhook-test-caller.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-on-received-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
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

async function adminCookie(context: TestContext): Promise<string> {
  const email = "ada@example.com";
  const password = "ada-Pass-123!";
  await context.authService.register({ email, password, role: "admin" });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const position = { x: 0, y: 0 };

/** Webhook (On Received) → Wait → Webhook Response → Output: the reply would name the customer if the caller waited. */
function onReceivedWorkflow(extra: Record<string, unknown> = {}): Workflow {
  return {
    id: "wf-received",
    name: "Received",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "orders-in", method: "POST", authMode: "none", responseMode: "onReceived", ...extra } },
      { id: "wait", type: "wait_node", name: "Wait", position, config: { delayMs: 300, maxDelayMs: 300 } },
      { id: "reply", type: "webhook_response", name: "Reply", position, config: { statusCode: 200, bodyTemplate: "{\"customer\":\"{{webhook.customer}}\"}" } },
      { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "done {{webhook.customer}}" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "wait" },
      { id: "e2", source: "wait", target: "reply" },
      { id: "e3", source: "reply", target: "out" }
    ]
  } as Workflow;
}

describe("Webhook Response Mode On Received", () => {
  it("answers 202 with the run's id at once on /webhook and /webhook-test, and the run goes on in the background", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(onReceivedWorkflow());
    for (const route of ["/webhook/orders-in", "/webhook-test/orders-in"]) {
      const headers = route.startsWith("/webhook-test") ? { cookie: await webhookTestCookie(context) } : {};
      const response = await context.app.inject({ method: "POST", url: route, headers, payload: { customer: "Grace Hopper" } });
      expect(response.statusCode, response.body).toBe(202);
      const body = response.json<{ executionId: string; status: string }>();
      expect(body).toEqual({ executionId: expect.any(String), status: "accepted" });
      // Nothing of the run is in the reply.
      expect(response.body).not.toContain("Grace");
      // Answered before the run's Wait ended; the run finishes afterwards and is recorded under that id.
      expect((await context.store.getExecutionHistory(body.executionId))?.status ?? "running").not.toBe("success");
      await vi.waitFor(async () => expect((await context.store.getExecutionHistory(body.executionId))?.status).toBe("success"), { timeout: 10_000 });
      const run = await context.store.getExecutionHistory(body.executionId);
      expect(run?.triggerType).toBe(route.startsWith("/webhook-test") ? "webhook_test" : "webhook");
    }
  });

  it("answers an idempotency retry with the same 202 and starts no second run", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(onReceivedWorkflow({ idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));
    const send = () => context.app.inject({ method: "POST", url: "/webhook/orders-in", headers: { "idempotency-key": "k-1" }, payload: { customer: "Grace" } });
    const first = await send();
    expect(first.statusCode, first.body).toBe(202);
    const again = await send();
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual(first.json());
    const executionId = first.json<{ executionId: string }>().executionId;
    await vi.waitFor(async () => expect((await context.store.getExecutionHistory(executionId))?.status).toBe("success"), { timeout: 10_000 });
    const runs = await context.store.listExecutionHistory({ workflowId: "wf-received", limit: 10 } as never);
    const items = Array.isArray(runs) ? runs : (runs as { items: unknown[] }).items;
    expect(items).toHaveLength(1);
  });

  it("puts the 202 body through the response rules: a rule that blocks what it says withholds it", async () => {
    const context = await createTestContext();
    const admin = await adminCookie(context);
    await context.store.upsertWorkflow(onReceivedWorkflow());
    const rules = {
      id: "block-all-replies",
      name: "Block replies",
      version: "1",
      // A custom term the acknowledgement carries ("accepted"), blocked on the response channel.
      dictionaries: [{ dataClass: "ack_word", terms: ["accepted"] }],
      channels: {
        response: {
          detectors: [{ id: "dlp.patterns", threshold: 0.5 }],
          actions: { ack_word: { action: "block" } },
          defaultAction: { action: "allow" }
        }
      }
    };
    const created = await context.app.inject({ method: "POST", url: "/api/guard/profiles", headers: { cookie: admin }, payload: { document: rules } });
    expect(created.statusCode, created.body).toBe(201);
    const bound = await context.app.inject({ method: "PUT", url: "/api/guard/bindings/projects/default", headers: { cookie: admin }, payload: { mode: "override", profileId: "block-all-replies" } });
    expect(bound.statusCode, bound.body).toBe(200);
    const response = await context.app.inject({ method: "POST", url: "/webhook/orders-in", payload: { customer: "Grace" } });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ code: "content_filter" });
    // A withheld acknowledgement starts no run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const runs = await context.store.listExecutionHistory({ workflowId: "wf-received", limit: 10 } as never);
    expect(Array.isArray(runs) ? runs : (runs as { items: unknown[] }).items).toHaveLength(0);
  });

  it("caps runs answered on receipt per instance (DISPATCH_MAX_WAITING): the next one is refused and its key is free again", async () => {
    const context = await createTestContext({ DISPATCH_MAX_WAITING: "1" });
    await context.store.upsertWorkflow(onReceivedWorkflow({ idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));
    const send = (key: string) => context.app.inject({ method: "POST", url: "/webhook/orders-in", headers: { "idempotency-key": key }, payload: { customer: "Grace" } });
    const first = await send("k-a");
    expect(first.statusCode, first.body).toBe(202);
    const busy = await send("k-b");
    expect(busy.statusCode, busy.body).toBe(503);
    const firstId = first.json<{ executionId: string }>().executionId;
    await vi.waitFor(async () => expect((await context.store.getExecutionHistory(firstId))?.status).toBe("success"), { timeout: 10_000 });
    // The refused request's key was given back, so its retry runs instead of being "already in progress".
    await vi.waitFor(async () => expect((await send("k-b")).statusCode).toBe(202), { timeout: 5_000 });
  });

  it("a used-up block budget answers 402 and starts nothing", async () => {
    const context = await createTestContext();
    const admin = await adminCookie(context);
    await context.store.upsertWorkflow(onReceivedWorkflow());
    const budget = await context.app.inject({
      method: "POST",
      url: "/api/budgets",
      headers: { cookie: admin },
      payload: { name: "Cap", scopeType: "workflow", scopeId: "wf-received", period: "month", limitType: "tokens", limitValue: 1, action: "block", warnThresholdPct: 0.8 }
    });
    expect(budget.statusCode, budget.body).toBe(200);
    await context.store.writeUsageEvent({
      id: `usage_${crypto.randomUUID()}`,
      executionId: `exec_${crypto.randomUUID()}`,
      workflowId: "wf-received",
      workflowName: "Received",
      userId: null,
      userEmail: null,
      projectId: "default",
      triggerType: "webhook",
      status: "success",
      inputTokens: 5,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 5,
      costUsd: 0,
      llmCallCount: 1,
      durationMs: 1,
      providers: []
    });
    const response = await context.app.inject({ method: "POST", url: "/webhook/orders-in", payload: { customer: "Grace" } });
    expect(response.statusCode, response.body).toBe(402);
  });
});

describe("the Webhook Input's Response Status Code", () => {
  /** Webhook → Output, or Webhook → Webhook Response (418) → Output; the status code set on the Webhook Input. */
  function replyWorkflow(hook: Record<string, unknown>, withResponseNode = false, failing = false): Workflow {
    return {
      id: "wf-code",
      name: "Code",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "coded", method: "POST", authMode: "none", ...hook } },
        ...(withResponseNode ? [{ id: "reply", type: "webhook_response", name: "Reply", position, config: { statusCode: 418, bodyTemplate: "{\"tea\":true}" } }] : []),
        failing
          ? { id: "out", type: "code_node", name: "Boom", position, config: { language: "javascript", code: "throw new Error('boom')" } }
          : { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "done" } }
      ],
      edges: withResponseNode
        ? [
            { id: "e1", source: "hook", target: "reply" },
            { id: "e2", source: "reply", target: "out" }
          ]
        : [{ id: "e1", source: "hook", target: "out" }]
    } as Workflow;
  }
  const send = (context: TestContext) => context.app.inject({ method: "POST", url: "/webhook/coded", payload: { a: 1 } });

  it("is the status of a reply the webhook builds itself, in every Response Mode; unset keeps 200 (202 for On Received)", async () => {
    const context = await createTestContext();
    for (const mode of [undefined, "auto", "lastNode", "responseNode"]) {
      await context.store.upsertWorkflow(replyWorkflow({ ...(mode ? { responseMode: mode } : {}), responseCode: 201 }));
      const response = await send(context);
      expect(response.statusCode, `${mode} ${response.body}`).toBe(201);
      await context.store.upsertWorkflow(replyWorkflow(mode ? { responseMode: mode } : {}));
      expect((await send(context)).statusCode, String(mode)).toBe(200);
    }
    await context.store.upsertWorkflow(replyWorkflow({ responseMode: "onReceived", responseCode: 200 }));
    const received = await send(context);
    expect(received.statusCode).toBe(200);
    expect(received.json()).toMatchObject({ status: "accepted" });
    await context.store.upsertWorkflow(replyWorkflow({ responseMode: "onReceived" }));
    expect((await send(context)).statusCode).toBe(202);
  });

  it("gives way to a Webhook Response node's own status, and a failed run still answers 400", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(replyWorkflow({ responseCode: 201 }, true));
    expect((await send(context)).statusCode).toBe(418);
    await context.store.upsertWorkflow(replyWorkflow({ responseCode: 201 }, false, true));
    expect((await send(context)).statusCode).toBe(400);
  });

  it("is kept for a retry under the same idempotency key", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(replyWorkflow({ responseCode: 201, idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));
    const sendKeyed = () => context.app.inject({ method: "POST", url: "/webhook/coded", headers: { "idempotency-key": "k-9" }, payload: { a: 1 } });
    expect((await sendKeyed()).statusCode).toBe(201);
    expect((await sendKeyed()).statusCode).toBe(201);
  });

  it("new Webhook Input nodes leave it unset", () => {
    expect(getNodeDefinition("webhook_input")?.sampleConfig).not.toHaveProperty("responseCode");
  });
});
