/**
 * Describe-it builder: POST /api/workflow-builder/build drafts a workflow through a model (here a mock
 * OpenAI-compatible server that answers with canned tool calls), checks it, and returns a preview without saving
 * anything. On Echo no model is called and the closest templates come back. Builders only; an admin can turn it off.
 * A build's model calls count toward the model spending limits: recorded as the project's and the person's usage
 * ("Describe it (builds)"), and refused before any call while a block budget is used up.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowBuilderResult } from "@ai-orchestrator/shared";
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
const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Canned model turns, by how many tool results the request already carries. */
type Turn = { content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; fail?: string; delayMs?: number; noUsage?: boolean };
let script: Turn[] = [];
const modelRequests: Array<{ messages: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name?: string } }>; stream?: boolean }> = [];
let mockServer: http.Server;
let mockBaseUrl = "";

const goodDraft = {
  name: "Order alerts",
  description: "Posts each new order to the shop API",
  nodes: [
    { id: "incoming", type: "webhook_input", label: "Incoming order", config: { path: "orders", method: "POST" } },
    {
      id: "post_order",
      type: "http_request",
      label: "Post order",
      config: { method: "POST", urlTemplate: "https://shop.example.com/orders", secretRef: { secretId: "someone-elses-secret" } }
    }
  ],
  edges: [{ source: "incoming", target: "post_order" }]
};

function respond(res: http.ServerResponse, turn: Turn, index: number) {
  if (turn.delayMs) {
    setTimeout(() => respond(res, { ...turn, delayMs: 0 }, index), turn.delayMs);
    return;
  }
  if (turn.fail) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: turn.fail, type: "invalid_request_error" } }));
    return;
  }
  const message = {
    role: "assistant",
    content: turn.content ?? null,
    ...(turn.toolCalls
      ? {
          tool_calls: turn.toolCalls.map((call, i) => ({
            id: `call_${index}_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        }
      : {})
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${index}`,
      object: "chat.completion",
      model: "mock-builder",
      choices: [{ index: 0, message, finish_reason: turn.toolCalls ? "tool_calls" : "stop" }],
      ...(turn.noUsage ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    })
  );
}

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      modelRequests.push(parsed);
      const toolResults = (parsed.messages ?? []).filter((message: { role: string }) => message.role === "tool").length;
      respond(res, script[toolResults] ?? { content: "Done." }, modelRequests.length);
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockBaseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

afterEach(async () => {
  script = [];
  modelRequests.length = 0;
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-workflow-builder-"));
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
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer", email = `${role}@example.com`): Promise<string> {
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const mockModel = () => ({ providerId: "openai_compatible", model: "mock-builder", baseUrl: mockBaseUrl });

async function build(context: TestContext, cookie: string, payload: Record<string, unknown>) {
  return await context.app.inject({ method: "POST", url: "/api/workflow-builder/build", headers: { cookie }, payload });
}

describe("POST /api/workflow-builder/build", () => {
  it("drafts a workflow through the model, repairs a rejected one, and saves nothing", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    script = [
      { toolCalls: [{ name: "list_node_types", arguments: { query: "webhook http" } }] },
      { toolCalls: [{ name: "get_node_types", arguments: { types: ["webhook_input", "http_request"] } }] },
      { toolCalls: [{ name: "submit_workflow", arguments: { ...goodDraft, edges: [{ source: "incoming", target: "missing_node" }] } }] },
      { toolCalls: [{ name: "submit_workflow", arguments: goodDraft }] }
    ];
    const before = await context.store.listWorkflows();

    const response = await build(context, cookie, { prompt: "When an order arrives, post it to the shop API", model: mockModel() });
    expect(response.statusCode).toBe(200);
    const result = response.json<WorkflowBuilderResult>();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.attempts).toBe(2);
    expect(result.model).toEqual({ providerId: "openai_compatible", model: "mock-builder" });
    expect(result.workflow.projectId).toBe("default");
    expect(result.workflow.nodes.map((node) => node.id)).toEqual(["incoming", "post_order"]);
    // Its own trigger path, and no secret the model named.
    const hook = result.workflow.nodes[0]!;
    expect(hook.config.path).toMatch(/^orders/);
    expect(JSON.stringify(result.workflow)).not.toContain("someone-elses-secret");
    expect(result.preview.notes.join(" ")).toMatch(/credential/);
    expect(result.preview.addresses.map((entry) => entry.url)).toContain("https://shop.example.com/orders");

    // Four model turns, no call after the accepted submission; the tools went with each call.
    expect(modelRequests).toHaveLength(4);
    expect(modelRequests[0]!.tools?.map((tool) => tool.function?.name)).toEqual(
      expect.arrayContaining(["list_node_types", "get_node_types", "submit_workflow"])
    );
    const lastToolResult = modelRequests[3]!.messages.filter((message) => message.role === "tool").at(-1);
    expect(String(lastToolResult?.content)).toMatch(/missing_node/);

    // Nothing was saved; the preview saves as a new workflow through the normal save.
    expect(await context.store.listWorkflows()).toHaveLength(before.length);
    expect(await context.store.getWorkflow(result.workflow.id)).toBeNull();
    const saved = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: result.workflow });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<Workflow>().id).toBe(result.workflow.id);

    const audit = await context.store.listAuditLogs({ eventType: "workflow.builder.build" });
    const entries = Array.isArray(audit) ? audit : (audit as { items: unknown[] }).items;
    expect(JSON.stringify(entries)).toMatch(/"status":"ready"/);
    expect(JSON.stringify(entries)).not.toMatch(/post it to the shop/);
  });

  it("on Echo calls no model and offers the three closest templates", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    for (const [name, description, tags] of [
      ["Webhook to Slack", "Post incoming webhooks to a Slack channel", ["slack", "webhook"]],
      ["Nightly report", "A schedule that emails a report", ["schedule", "email"]],
      ["Docs Q&A", "Answer questions about documents", ["rag"]],
      ["Ticket triage", "Classify support tickets", ["classify"]]
    ] as const) {
      const created = await context.app.inject({
        method: "POST",
        url: "/api/templates",
        headers: { cookie },
        payload: { name, description, tags, workflowJson: JSON.stringify({ id: "t", name, nodes: [], edges: [] }) }
      });
      expect(created.statusCode).toBeLessThan(300);
    }
    const response = await build(context, cookie, { prompt: "When a webhook comes in, post to Slack" });
    expect(response.statusCode).toBe(200);
    const result = response.json<WorkflowBuilderResult>();
    expect(result.status).toBe("needs_model");
    if (result.status !== "needs_model") return;
    expect(result.message).toMatch(/real model/);
    expect(result.templates).toHaveLength(3);
    expect(result.templates[0]!.name).toBe("Webhook to Slack");

    // Naming Echo outright answers the same way.
    const echo = await build(context, cookie, { prompt: "anything", model: { providerId: "echo", model: "echo" } });
    expect(echo.json<WorkflowBuilderResult>().status).toBe("needs_model");
    expect(modelRequests).toHaveLength(0);
  });

  it("returns the model's question", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    script = [{ toolCalls: [{ name: "agent_clarify", arguments: { question: "Which Slack channel?" } }] }];
    const response = await build(context, cookie, { prompt: "notify the team", model: mockModel() });
    expect(response.json()).toMatchObject({ status: "question", question: "Which Slack channel?" });
  });

  it("gives up after three rejected submissions and lists the problems", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const bad = { name: "bad", nodes: [{ id: "x", type: "made_up_node", config: {} }], edges: [] };
    script = [0, 1, 2, 3].map(() => ({ toolCalls: [{ name: "submit_workflow", arguments: bad }] }));
    const response = await build(context, cookie, { prompt: "do something", model: mockModel() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "failed", attempts: 3 });
    expect(JSON.stringify(response.json())).toMatch(/made_up_node/);
    expect(modelRequests).toHaveLength(3);
  });

  it("is for builders and admins only", async () => {
    const context = await createTestContext();
    for (const role of ["viewer", "operator"] as const) {
      const cookie = await login(context, role);
      const response = await build(context, cookie, { prompt: "anything", model: mockModel() });
      expect(response.statusCode).toBe(403);
    }
    const admin = await login(context, "admin");
    script = [{ content: "What should start it?" }];
    expect((await build(context, admin, { prompt: "anything", model: mockModel() })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "POST", url: "/api/workflow-builder/build", payload: { prompt: "x" } })).statusCode).toBe(401);
  });

  it("refuses a secret the person may not use and a malformed request", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const missing = await build(context, cookie, { prompt: "x", model: { ...mockModel(), secretRef: { secretId: "not-mine" } } });
    expect(missing.statusCode).toBe(403);
    expect((await build(context, cookie, { prompt: "" })).statusCode).toBe(400);
    expect((await build(context, cookie, { prompt: "x", model: { providerId: "no_such_provider", model: "m" } })).statusCode).toBe(400);
    expect(modelRequests).toHaveLength(0);
  });

  it("an admin can turn it off; the studio learns it from GET /api/workflow-builder", async () => {
    const context = await createTestContext({ WORKFLOW_BUILDER_ENABLED: "false" });
    const cookie = await login(context, "builder");
    const response = await build(context, cookie, { prompt: "anything", model: mockModel() });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "workflow_builder_disabled" });
    expect((await context.app.inject({ method: "GET", url: "/api/workflow-builder", headers: { cookie } })).json()).toEqual({ enabled: false });
    expect(modelRequests).toHaveLength(0);

    const on = await createTestContext();
    const onCookie = await login(on, "builder", "builder2@example.com");
    expect((await on.app.inject({ method: "GET", url: "/api/workflow-builder", headers: { cookie: onCookie } })).json()).toEqual({
      enabled: true,
      defaultModel: { providerId: "echo", model: "echo" }
    });
    const viewer = await login(on, "viewer");
    expect((await on.app.inject({ method: "GET", url: "/api/workflow-builder", headers: { cookie: viewer } })).statusCode).toBe(403);
  });

  it("uses the default model of the project: a saved key there, not one from another project", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const project = await context.app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Other" } });
    const otherId = project.json<{ id: string }>().id;
    const secret = await context.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: { name: "Other key", provider: "openai", value: "other-project-key", projectId: otherId }
    });
    expect(secret.statusCode).toBeLessThan(300);
    const status = async (projectId: string) =>
      (await context.app.inject({ method: "GET", url: `/api/workflow-builder?projectId=${projectId}`, headers: { cookie } })).json();
    expect(await status("default")).toMatchObject({ defaultModel: { providerId: "echo" } });
    expect(await status(otherId)).toMatchObject({ defaultModel: { providerId: "openai", model: "gpt-4o-mini" } });
    // A build in the default project stays on Echo: no model call.
    expect((await build(context, cookie, { prompt: "post orders" })).json()).toMatchObject({ status: "needs_model" });
    expect(modelRequests).toHaveLength(0);
  });

  it("names the saved credential the default model uses, so the dialog shows the key a build will use", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const secret = await context.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: { name: "Team Anthropic key", provider: "anthropic", value: "sk-ant-not-a-real-key" }
    });
    expect(secret.statusCode).toBeLessThan(300);
    const secretId = secret.json<{ id: string }>().id;
    const status = await context.app.inject({ method: "GET", url: "/api/workflow-builder", headers: { cookie } });
    expect(status.json()).toMatchObject({ enabled: true, defaultModel: { providerId: "anthropic", secretRef: { secretId } } });
    // Only the id: never the key.
    expect(status.body).not.toContain("sk-ant-not-a-real-key");
  });

  it("repairs the validation's classify webhook: a {{response}} body goes back to the model and comes back as {{answer}}", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const classify = (body: string) => ({
      name: "Classify customer messages",
      nodes: [
        { id: "incoming", type: "webhook_input", label: "Incoming message", config: { path: "classify", method: "POST" } },
        { id: "build_prompt", type: "prompt_template", label: "Build prompt", config: { template: "Classify as billing, shipping or other: {{webhook.message}}" } },
        { id: "classify", type: "llm_call", label: "Classify", config: {} },
        { id: "reply", type: "webhook_response", label: "Reply", config: { statusCode: 200, bodyTemplate: body } }
      ],
      edges: [
        { source: "incoming", target: "build_prompt" },
        { source: "build_prompt", target: "classify" },
        { source: "classify", target: "reply" }
      ]
    });
    script = [
      { toolCalls: [{ name: "submit_workflow", arguments: classify("{{response}}") }] },
      { toolCalls: [{ name: "submit_workflow", arguments: classify("{{answer}}") }] }
    ];
    const response = await build(context, cookie, {
      prompt:
        "When a webhook receives a JSON body with a customer message in the field 'message', use an LLM to classify it as billing, shipping or other, and reply to the webhook caller with JSON {\"category\": ..., \"summary\": one sentence}.",
      model: mockModel()
    });
    const result = response.json<WorkflowBuilderResult>();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.attempts).toBe(2);
    expect(result.workflow.nodes.find((node) => node.id === "reply")!.config).toMatchObject({ bodyTemplate: "{{answer}}" });
    const feedback = String(modelRequests[1]!.messages.filter((message) => message.role === "tool").at(-1)?.content);
    expect(feedback).toMatch(/\{\{response\}\}/);
    expect(feedback).toMatch(/'classify' \(llm_call\) outputs answer/);
    // The catalog the model reads names each node's outputs.
    expect(JSON.stringify(modelRequests[0]!.messages[0]!.content)).toMatch(/outputFields/);
  });

  it("refuses a secret of another project, even one the person may use there", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const otherId = (await context.app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Other" } })).json<{ id: string }>().id;
    const secret = await context.app.inject({
      method: "POST",
      url: "/api/secrets",
      headers: { cookie },
      payload: { name: "Other key", provider: "openai", value: "other-project-key", projectId: otherId }
    });
    const secretId = secret.json<{ secretId?: string; id?: string }>().secretId ?? secret.json<{ id: string }>().id;
    const model = { ...mockModel(), secretRef: { secretId } };
    const elsewhere = await build(context, cookie, { prompt: "post orders", projectId: "default", model });
    expect(elsewhere.statusCode, elsewhere.body).toBe(403);
    expect(modelRequests).toHaveLength(0);
    const there = await build(context, cookie, { prompt: "post orders", projectId: otherId, model });
    expect(there.statusCode, there.body).toBe(200);
  });

  it("runs one build at a time per person", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    script = [{ content: "Which shop?", delayMs: 600 }];
    const first = build(context, cookie, { prompt: "orders", model: mockModel() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await build(context, cookie, { prompt: "orders", model: mockModel() });
    expect(second.statusCode).toBe(409);
    expect((await first).json()).toMatchObject({ status: "question" });
    expect((await build(context, cookie, { prompt: "orders", model: mockModel() })).statusCode).toBe(200);
  });

  it("redacts a provider's error before it goes out", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const leaked = `Incorrect API key provided: sk-${"a1B2c3D4e5".repeat(3)}`;
    script = [{ fail: leaked }];
    const response = await build(context, cookie, { prompt: "orders", model: mockModel() });
    expect(response.json()).toMatchObject({ status: "failed" });
    const text = response.body;
    expect(text).not.toContain("a1B2c3D4e5a1B2c3D4e5");
    expect(text).toContain("REDACTED");
    expect(modelRequests.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("Describe it and model spending limits", () => {
  const usageOfBuilds = async (context: TestContext) => {
    const events = await context.store.listUsageEvents({ limit: 50, workflowId: "workflow-builder" });
    return events as Array<Record<string, unknown>>;
  };
  const draftScript = (): Turn[] => [
    { toolCalls: [{ name: "list_node_types", arguments: { query: "webhook http" } }] },
    { toolCalls: [{ name: "submit_workflow", arguments: goodDraft }] }
  ];

  it("records a build's model calls as the project's and the person's usage, labelled as a build", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const builder = (await context.store.getUserByEmail("builder@example.com"))!;
    script = draftScript();
    const response = await build(context, cookie, { prompt: "When an order arrives, post it to the shop API", model: mockModel() });
    expect(response.json()).toMatchObject({ status: "ready" });
    expect(modelRequests).toHaveLength(2);
    const events = await usageOfBuilds(context);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workflowId: "workflow-builder",
      workflowName: "Describe it (builds)",
      triggerType: "workflow_builder",
      projectId: "default",
      userId: builder.id,
      userEmail: "builder@example.com",
      status: "success",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      llmCallCount: 2
    });

    // The usage views show it under its own label.
    const admin = await login(context, "admin");
    const rollup = await context.app.inject({ method: "GET", url: "/api/usage/rollup?groupBy=workflow", headers: { cookie: admin } });
    expect(rollup.json<{ rows: Array<{ workflowName?: string; totalTokens: number }> }>().rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ workflowName: "Describe it (builds)", totalTokens: 30 })])
    );

    // Settings > FinOps reads the totals and the provider / model breakdown: the build is in both.
    const totals = await context.app.inject({ method: "GET", url: "/api/usage/totals", headers: { cookie: admin } });
    expect(totals.statusCode).toBe(200);
    expect(totals.json<{ totals: { totalTokens: number; executions: number } }>().totals).toMatchObject({ totalTokens: 30 });
    const byModel = await context.app.inject({ method: "GET", url: "/api/usage/rollup?groupBy=provider", headers: { cookie: admin } });
    expect(JSON.stringify(byModel.json())).toMatch(/mock-builder|openai_compatible/);

    // A build that fails after a call is charged for that call.
    script = [{ toolCalls: [{ name: "list_node_types", arguments: {} }] }, { fail: "upstream broke" }];
    await build(context, cookie, { prompt: "orders again", model: mockModel() });
    const after = await usageOfBuilds(context);
    expect(after).toHaveLength(2);
    expect(after.find((event) => event.status === "error")).toMatchObject({ totalTokens: 15, llmCallCount: 1 });

    // A server that reports no usage is charged an estimate, as a run's call is, never nothing.
    script = [{ toolCalls: [{ name: "submit_workflow", arguments: goodDraft }], noUsage: true }];
    await build(context, cookie, { prompt: "orders once more", model: mockModel() });
    const quiet = (await usageOfBuilds(context)).filter((event) => !after.some((earlier) => earlier.id === event.id));
    expect(quiet).toHaveLength(1);
    expect(Number(quiet[0]!.inputTokens)).toBeGreaterThan(0);
    expect(Number(quiet[0]!.outputTokens)).toBeGreaterThan(0);
  }, 30_000);

  it("refuses a build before any model call once a block budget on the project or the person is used up", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const admin = await login(context, "admin");
    const budget = async (payload: Record<string, unknown>) => {
      const created = await context.app.inject({ method: "POST", url: "/api/budgets", headers: { cookie: admin }, payload });
      expect(created.statusCode, created.body).toBeLessThan(300);
      return created.json<{ id: string }>();
    };
    await budget({ name: "Default project tokens", scopeType: "project", scopeId: "default", period: "month", limitType: "tokens", limitValue: 25, action: "block" });

    // Under the limit: the build runs (and takes it over).
    script = draftScript();
    expect((await build(context, cookie, { prompt: "orders", model: mockModel() })).json()).toMatchObject({ status: "ready" });
    expect(modelRequests).toHaveLength(2);

    script = draftScript();
    const refused = await build(context, cookie, { prompt: "orders", model: mockModel() });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({
      code: "budget_exceeded",
      error: 'The model spending limit "Default project tokens" is used up for this month, and describing a workflow uses the model too. Try again when the limit resets, or ask an admin to raise it.'
    });
    expect(modelRequests).toHaveLength(2);
    const audit = await context.store.listAuditLogs({ eventType: "workflow.builder.build" });
    const entries = Array.isArray(audit) ? audit : (audit as { items: unknown[] }).items;
    expect(JSON.stringify(entries)).toMatch(/"status":"budget_exceeded"/);

    // On Echo nothing is spent, so nothing is refused.
    expect((await build(context, cookie, { prompt: "orders" })).json()).toMatchObject({ status: "needs_model" });

    // A person's own budget applies too, in any project.
    const other = await createTestContext();
    const otherCookie = await login(other, "builder");
    const otherAdmin = await login(other, "admin");
    const created = await other.app.inject({
      method: "POST",
      url: "/api/budgets",
      headers: { cookie: otherAdmin },
      payload: { name: "Builder's tokens", scopeType: "user", scopeId: "builder@example.com", period: "day", limitType: "tokens", limitValue: 10, action: "block" }
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    script = draftScript();
    expect((await build(other, otherCookie, { prompt: "orders", model: mockModel() })).json()).toMatchObject({ status: "ready" });
    const before = modelRequests.length;
    expect((await build(other, otherCookie, { prompt: "orders", model: mockModel() })).statusCode).toBe(402);
    expect(modelRequests).toHaveLength(before);
  }, 30_000);
});
