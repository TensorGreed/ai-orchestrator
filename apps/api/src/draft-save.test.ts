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
import { SchedulerService } from "./services/scheduler-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  scheduler?: SchedulerService;
  secretService: SecretService;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { scheduler?: boolean } = {}): Promise<TestContext> {
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
  const scheduler = options.scheduler ? new SchedulerService(store, () => undefined) : undefined;
  const app = await createApp(config, store, secretService, authService, scheduler);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir, secretService, ...(scheduler ? { scheduler } : {}) };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    context.scheduler?.stop();
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

  it("does not publish an unfinished draft, and publishes it once finished", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const nodes = (url?: string) => [
      ...hookFlow().nodes,
      { id: "http", type: "http_request" as const, name: "HTTP", position, config: { method: "POST", ...(url ? { urlTemplate: url } : {}) } }
    ];
    const edges = [...hookFlow().edges, { id: "e2", source: "set", target: "http" }];
    const draft = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: hookFlow({ nodes: nodes(), edges }) });
    expect(draft.statusCode).toBe(200);
    // Each save is a new version: 1 is the draft, 2 the finished workflow.
    const draftVersion = 1;
    const refused = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/publish", headers: { cookie }, payload: { version: draftVersion } });
    expect(refused.statusCode).toBe(409);
    expect(JSON.stringify(refused.json())).toContain("cannot be published");

    const finished = await context.app.inject({
      method: "PUT",
      url: "/api/workflows/wf-hook-draft",
      headers: { cookie },
      payload: hookFlow({ nodes: nodes("http://127.0.0.1:9/orders"), edges })
    });
    const published = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-hook-draft/publish",
      headers: { cookie },
      payload: { version: 2 }
    });
    expect(finished.statusCode).toBe(200);
    expect(published.statusCode, JSON.stringify(published.json())).toBe(200);
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

describe("live triggers of an unfinished draft", () => {
  const unfinished = (extra: Partial<Workflow> = {}): Workflow =>
    hookFlow({
      nodes: [...hookFlow().nodes, { id: "http", type: "http_request", name: "HTTP", position, config: { method: "POST" } }],
      edges: [...hookFlow().edges, { id: "e2", source: "set", target: "http" }],
      ...extra
    });
  const pausedNotes = async (context: TestContext, workflowId: string) =>
    (await context.store.listAuditLogs({ eventType: "workflow.triggers_paused", resourceId: workflowId, page: 1, pageSize: 50 })).items;
  const runs = async (context: TestContext, workflowId: string) =>
    (await context.store.listExecutionHistory({ workflowId, page: 1, pageSize: 50 })).items;

  it("a production webhook answers 409 without a run, notes the pause once per version, and serves once finished", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    expect((await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: unfinished() })).statusCode).toBe(200);

    for (let fire = 0; fire < 3; fire += 1) {
      const response = await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: { customer: "Ana" } });
      expect(response.statusCode).toBe(409);
      const body = response.json() as { error: string; code: string };
      expect(body.code).toBe("workflow_unfinished");
      expect(body.error).toContain("Live triggers of this workflow are paused");
      // An anonymous caller is not told which settings; the audit entry and the editor say.
      expect(body.error).not.toContain("urlTemplate");
    }
    expect(await runs(context, "wf-hook-draft")).toHaveLength(0);
    const notes = await pausedNotes(context, "wf-hook-draft");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toBe("Live triggers paused: unfinished settings");
    expect(notes[0]!.metadata).toMatchObject({ version: 1, issues: ["missing_http_request_url_template"] });

    // The editor says so.
    const validation = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/validate", headers: { cookie }, payload: {} });
    expect((validation.json() as { liveTriggersPaused?: boolean }).liveTriggersPaused).toBe(true);

    // A new unfinished version is noted once more.
    expect((await context.app.inject({ method: "PUT", url: "/api/workflows/wf-hook-draft", headers: { cookie }, payload: unfinished({ name: "Hook draft 2" }) })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: {} })).statusCode).toBe(409);
    expect((await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: {} })).statusCode).toBe(409);
    expect(await pausedNotes(context, "wf-hook-draft")).toHaveLength(2);

    // The editor's test route still runs the draft (and reports what is missing).
    const tested = await context.app.inject({ method: "POST", url: "/webhook-test/draft-orders", payload: { customer: "Ana" } });
    expect(tested.statusCode).not.toBe(409);

    // Finished: production serves it again.
    expect((await context.app.inject({ method: "PUT", url: "/api/workflows/wf-hook-draft", headers: { cookie }, payload: hookFlow() })).statusCode).toBe(200);
    const served = await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: { customer: "Ana" } });
    expect(served.statusCode, served.body).toBe(200);
    const finishedValidation = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/validate", headers: { cookie }, payload: {} });
    expect((finishedValidation.json() as { liveTriggersPaused?: boolean }).liveTriggersPaused).toBe(false);
  });

  it("a schedule stays registered but skips its ticks without a run, noting the pause once", async () => {
    const context = await createTestContext({ scheduler: true });
    const cookie = await login(context);
    const scheduled = unfinished({
      id: "wf-cron-draft",
      nodes: [
        { id: "tick", type: "schedule_trigger", name: "Tick", position, config: { cronExpression: "0 3 * * *", timezone: "UTC", active: true } },
        { id: "http", type: "http_request", name: "HTTP", position, config: { method: "POST" } }
      ],
      edges: [{ id: "e1", source: "tick", target: "http" }]
    });
    expect((await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: scheduled })).statusCode).toBe(200);
    await context.scheduler!.reloadWorkflow("wf-cron-draft");
    const jobs = (context.scheduler as unknown as { jobs: Map<string, unknown> }).jobs;
    expect([...jobs.keys()]).toHaveLength(1);

    const handler = (context.scheduler as unknown as { executeHandler: (input: Record<string, string>) => Promise<void> }).executeHandler;
    for (let tick = 0; tick < 3; tick += 1) {
      await handler({ workflowId: "wf-cron-draft", workflowName: "Hook draft", scheduleNodeId: "tick", cronExpression: "0 3 * * *", timezone: "UTC", firedAt: new Date().toISOString() });
    }
    expect(await runs(context, "wf-cron-draft")).toHaveLength(0);
    expect(await pausedNotes(context, "wf-cron-draft")).toHaveLength(1);
  });

  it("checks the webhook's own authentication before saying it is paused, and keeps 405 for a method nobody serves", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const secretRef = await context.secretService.createSecret({ name: "hook-token", provider: "webhook", value: "s3cret-token" });
    const guarded = unfinished({
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "draft-orders", method: "POST", authMode: "bearer_token", authHeaderName: "authorization", secretRef } },
        { id: "http", type: "http_request", name: "HTTP", position, config: { method: "POST" } }
      ],
      edges: [{ id: "e1", source: "hook", target: "http" }]
    });
    const saved = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: guarded });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: {} })).statusCode).toBe(401);
    expect(await pausedNotes(context, "wf-hook-draft")).toHaveLength(0);
    const authorized = await context.app.inject({ method: "POST", url: "/webhook/draft-orders", headers: { authorization: "Bearer s3cret-token" }, payload: {} });
    expect(authorized.statusCode, authorized.body).toBe(409);
    expect((await context.app.inject({ method: "PUT", url: "/webhook/draft-orders", payload: {} })).statusCode).toBe(405);
    expect(await runs(context, "wf-hook-draft")).toHaveLength(0);
  });

  it("a form submission and an MCP trigger call answer 409 without a run; the form and the tool still show", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const http = { id: "http", type: "http_request" as const, name: "HTTP", position, config: { method: "POST" } };
    const form = unfinished({
      id: "wf-form-draft",
      nodes: [{ id: "form", type: "form_trigger", name: "Form", position, config: { path: "draft-form", title: "Contact", authMode: "public", fields: [{ name: "name", label: "Name", type: "text" }] } }, http],
      edges: [{ id: "e1", source: "form", target: "http" }]
    });
    const mcp = unfinished({
      id: "wf-mcp-draft",
      nodes: [{ id: "mcp", type: "mcp_server_trigger", name: "Tool", position, config: { path: "draft-tool", toolName: "echo", toolDescription: "Echo", authMode: "public", inputSchema: { type: "object" } } }, http],
      edges: [{ id: "e1", source: "mcp", target: "http" }]
    });
    for (const workflow of [form, mcp]) {
      const saved = await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow });
      expect(saved.statusCode, saved.body).toBe(200);
    }
    expect((await context.app.inject({ method: "GET", url: "/api/forms/draft-form" })).statusCode).toBe(200);
    const submitted = await context.app.inject({ method: "POST", url: "/api/forms/draft-form", payload: { name: "Ana" } });
    expect(submitted.statusCode).toBe(409);
    expect((submitted.json() as { code: string }).code).toBe("workflow_unfinished");
    expect((await context.app.inject({ method: "GET", url: "/api/mcp-server/draft-tool/manifest" })).statusCode).toBe(200);
    const called = await context.app.inject({ method: "POST", url: "/api/mcp-server/draft-tool/invoke", payload: { arguments: {} } });
    expect(called.statusCode).toBe(409);
    expect((called.json() as { code: string }).code).toBe("workflow_unfinished");
    expect(await runs(context, "wf-form-draft")).toHaveLength(0);
    expect(await runs(context, "wf-mcp-draft")).toHaveLength(0);
  });

  it("a finished published version keeps serving while the draft after it is unfinished", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    expect((await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: hookFlow() })).statusCode).toBe(200);
    const published = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/publish", headers: { cookie }, payload: { version: 1 } });
    expect(published.statusCode, published.body).toBe(200);
    expect((await context.app.inject({ method: "PUT", url: "/api/workflows/wf-hook-draft", headers: { cookie }, payload: unfinished() })).statusCode).toBe(200);
    const served = await context.app.inject({ method: "POST", url: "/webhook/draft-orders", payload: { customer: "Ana" } });
    expect(served.statusCode, served.body).toBe(200);
    const validation = await context.app.inject({ method: "POST", url: "/api/workflows/wf-hook-draft/validate", headers: { cookie }, payload: {} });
    expect((validation.json() as { liveTriggersPaused?: boolean }).liveTriggersPaused).toBe(false);
    expect(await pausedNotes(context, "wf-hook-draft")).toHaveLength(0);
  });
});
