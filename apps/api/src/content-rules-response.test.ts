/**
 * Phase 12 coverage — the response boundary over the API: what webhook (and chat widget), `/api/chat` and MCP
 * trigger callers receive is checked on the `response` channel when a rule set configures it; a blocked response is
 * 422 content_filter (MCP: a tool error result); history and the idempotency store keep the checked version; the
 * opt-in `trigger_input` check refuses or rewrites a webhook payload before anything runs. With no such rule set,
 * nothing changes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { RESPONSE_FAILED_MESSAGE, RESPONSE_WITHHELD_MESSAGE, TRIGGER_INPUT_REFUSED_MESSAGE, type GuardEventView, type Workflow, type WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { testSql } from "./test-support/test-sql.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { HIDDEN_BY_RESPONSE_RULES } from "./response-run-view.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz123456";
const EMAIL = "maria.gonzalez@example.org";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-response-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "error",
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
  const context = { app, store, authService, secretService, config, tempDir };
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

async function login(context: TestContext, role: "admin" | "builder" | "viewer"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  return values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function channel(actions: Record<string, { action: string }>) {
  return { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { ...actions, sensitive_data: { action: "allow" } }, defaultAction: { action: "allow" } };
}

/** A rule set on the project: credentials blocked and emails redacted in responses (and, optionally, at the door). */
async function bindRules(context: TestContext, admin: string, channels: Record<string, unknown>): Promise<void> {
  const created = await call(context, "POST", "/api/guard/profiles", admin, { id: "callers", document: { id: "callers", name: "Callers", version: "1", channels } });
  expect(created.statusCode, created.body).toBe(201);
  const bound = await call(context, "PUT", "/api/guard/bindings/projects/default", admin, { mode: "override", profileId: "callers" });
  expect(bound.statusCode, bound.body).toBe(200);
}
const RESPONSE_RULES = { response: channel({ credential: { action: "block" }, email: { action: "redact" } }) };

function node(id: string, type: string, config: Record<string, unknown>): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function workflow(id: string, trigger: WorkflowNode, template: string): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [trigger, node("out", "output", { outputKey: "result", responseTemplate: template })],
    edges: [{ id: "e1", source: trigger.id, target: "out" }]
  };
}

const webhookWorkflow = (id: string, config: Record<string, unknown> = {}) =>
  workflow(id, node("hook", "webhook_input", { path: id, method: "POST", ...config }), "{{user_prompt}}");
const chatWorkflow = (id: string) => workflow(id, node("chat", "chat_trigger", { authMode: "public" }), "{{message}}");
const mcpWorkflow = (id: string) =>
  workflow(id, node("mcp", "mcp_server_trigger", { path: id, toolName: "echo", toolDescription: "Echo", authMode: "public", inputSchema: { type: "object" } }), "{{q}}");

async function history(context: TestContext, executionId: string) {
  const run = await context.store.getExecutionHistory(executionId);
  expect(run).not.toBeNull();
  return run!;
}

async function responseEvents(context: TestContext, executionId: string) {
  return (await context.store.listGuardEventsForExecution(executionId)).filter((row) => row.placement === "response");
}

describe("response boundary: zero config", () => {
  it("answers webhook, chat and MCP invoke callers exactly as before without a response channel", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(webhookWorkflow("plain-hook"));
    await context.store.upsertWorkflow(chatWorkflow("plain-chat"));
    await context.store.upsertWorkflow(mcpWorkflow("plain-mcp"));

    const hook = await context.app.inject({ method: "POST", url: "/webhook/plain-hook", payload: { user_prompt: `key ${SECRET}` } });
    expect(hook.statusCode).toBe(200);
    expect(hook.json<{ output: { result: string } }>().output.result).toContain(SECRET);

    const chat = await context.app.inject({ method: "POST", url: "/api/chat/plain-chat", payload: { message: `key ${SECRET}` } });
    expect(chat.statusCode).toBe(200);
    expect(JSON.stringify(chat.json())).toContain(SECRET);

    const mcp = await context.app.inject({ method: "POST", url: "/api/mcp-server/plain-mcp/invoke", payload: { arguments: { q: `key ${SECRET}` } } });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json<{ ok: boolean }>().ok).toBe(true);
    expect(JSON.stringify(mcp.json())).toContain(SECRET);

    expect(await testSql(context.store).all("SELECT id FROM guard_events WHERE placement = 'response'")).toEqual([]);
  });
});

describe("response boundary: webhook", () => {
  it("redacts what the caller gets; history and the idempotency replay hold the checked version, node results what ran", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(webhookWorkflow("redact-hook", { authMode: "none", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));

    const send = () => context.app.inject({ method: "POST", url: "/webhook/redact-hook", headers: { "idempotency-key": "k-1" }, payload: { user_prompt: `write to ${EMAIL}` } });
    const first = await send();
    expect(first.statusCode).toBe(200);
    const body = first.json<{ output: { result: string }; idempotency: { reused: boolean } }>();
    expect(body.output.result).not.toContain(EMAIL);
    expect(body.idempotency.reused).toBe(false);

    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.body).not.toContain(EMAIL);
    expect(replay.json<{ idempotency: { reused: boolean } }>().idempotency.reused).toBe(true);

    const stored = JSON.stringify(await testSql(context.store).all("SELECT result_json FROM webhook_idempotency"));
    expect(stored).not.toContain(EMAIL);

    const executionId = (await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'redact-hook'"))[0]!.id;
    const run = await history(context, executionId);
    expect(run.status).toBe("success");
    expect(JSON.stringify(run.output)).not.toContain(EMAIL);
    // The builder's record of each step is kept as it ran.
    expect(JSON.stringify(run.nodeResults)).toContain(EMAIL);
    const events = await responseEvents(context, executionId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(events)).not.toContain(EMAIL);

    // The Security page's "Responses to callers" filter lists them.
    const listed = await call(context, "GET", "/api/guard/events?placement=response&workflowId=redact-hook", admin);
    expect(listed.statusCode).toBe(200);
    const listedEvents = listed.json<{ events: GuardEventView[] }>().events;
    expect(listedEvents.length).toBeGreaterThan(0);
    expect(listedEvents.every((event) => event.placement === "response" && event.channel === "response")).toBe(true);
  });

  it("answers 422 content_filter for a blocked response, stores the same envelope for replays, and the run ends success", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(webhookWorkflow("block-hook", { authMode: "none", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));

    const send = () => context.app.inject({ method: "POST", url: "/webhook/block-hook", headers: { "idempotency-key": "k-2" }, payload: { user_prompt: `key ${SECRET}` } });
    const first = await send();
    expect(first.statusCode).toBe(422);
    const envelope = first.json<{ error: string; code: string; executionId: string }>();
    expect(envelope).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter", executionId: expect.any(String) });
    expect(first.body).not.toContain(SECRET);

    const replay = await send();
    expect(replay.statusCode).toBe(422);
    expect(replay.json()).toEqual(envelope);
    expect(JSON.stringify(await testSql(context.store).all("SELECT result_json FROM webhook_idempotency"))).not.toContain(SECRET);

    const run = await history(context, envelope.executionId);
    expect(run.status).toBe("success");
    expect(run.output).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter" });
    const events = await responseEvents(context, envelope.executionId);
    expect(events.map((event) => [event.channel, event.verdictAction])).toContainEqual(["response", "block"]);
  });

  it("checks bearer and HMAC webhooks and the chat widget's text/plain posts the same way", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    const token = "bearer-token-123";
    const bearerRef = await context.secretService.createSecret({ name: "bearer", provider: "webhook", value: token });
    const hmacSecret = "hmac-secret-456";
    const hmacRef = await context.secretService.createSecret({ name: "hmac", provider: "webhook", value: hmacSecret });
    await context.store.upsertWorkflow(webhookWorkflow("bearer-hook", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: bearerRef }));
    await context.store.upsertWorkflow(
      webhookWorkflow("hmac-hook", { authMode: "hmac_sha256", signatureHeaderName: "x-webhook-signature", timestampHeaderName: "x-webhook-timestamp", replayToleranceSeconds: 300, secretRef: hmacRef })
    );
    await context.store.upsertWorkflow(webhookWorkflow("widget-hook"));

    const bearer = await context.app.inject({ method: "POST", url: "/webhook/bearer-hook", headers: { authorization: `Bearer ${token}` }, payload: { user_prompt: `key ${SECRET}` } });
    expect(bearer.statusCode).toBe(422);
    expect(bearer.json<{ code: string }>().code).toBe("content_filter");

    const rawBody = JSON.stringify({ user_prompt: `write to ${EMAIL}` });
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const signature = crypto.createHmac("sha256", hmacSecret).update(`${timestamp}.${rawBody}`).digest("hex");
    const hmac = await context.app.inject({
      method: "POST",
      url: "/webhook/hmac-hook",
      headers: { "content-type": "application/json", "x-webhook-timestamp": timestamp, "x-webhook-signature": signature },
      payload: rawBody
    });
    expect(hmac.statusCode).toBe(200);
    expect(hmac.body).not.toContain(EMAIL);

    // The chat widget posts its JSON as text/plain to /webhook/<id>.
    const widget = await context.app.inject({
      method: "POST",
      url: "/webhook/widget-hook",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      payload: JSON.stringify({ user_prompt: `key ${SECRET}`, session_id: "s-1" })
    });
    expect(widget.statusCode).toBe(422);
    expect(widget.json<{ error: string }>().error).toBe(RESPONSE_WITHHELD_MESSAGE);
  });

  it("never checks editor runs: builders already read the run history", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(webhookWorkflow("editor-hook"));
    const run = await call(context, "POST", "/api/workflows/editor-hook/execute", admin, { user_prompt: `key ${SECRET}` });
    expect(run.statusCode).toBe(200);
    expect(run.body).toContain(SECRET);
  });
});

describe("response boundary: chat and MCP invoke", () => {
  it("answers chat with the envelope in place of the output, and redacts a rewritten one", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(chatWorkflow("rules-chat"));

    const blocked = await context.app.inject({ method: "POST", url: "/api/chat/rules-chat", payload: { message: `key ${SECRET}`, session_id: "s-9" } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toEqual({ error: RESPONSE_WITHHELD_MESSAGE, code: "content_filter", executionId: expect.any(String), session_id: "s-9" });

    const redacted = await context.app.inject({ method: "POST", url: "/api/chat/rules-chat", payload: { message: `write to ${EMAIL}` } });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json<{ ok: boolean }>().ok).toBe(true);
    expect(redacted.body).not.toContain(EMAIL);
  });

  it("answers MCP invoke with a tool error result, never the output", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(mcpWorkflow("rules-mcp"));

    const blocked = await context.app.inject({ method: "POST", url: "/api/mcp-server/rules-mcp/invoke", payload: { arguments: { q: `key ${SECRET}` } } });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toEqual({
      ok: false,
      executionId: expect.any(String),
      code: "content_filter",
      error: RESPONSE_WITHHELD_MESSAGE,
      result: { isError: true, content: [{ type: "text", text: RESPONSE_WITHHELD_MESSAGE }] }
    });
    expect(blocked.body).not.toContain(SECRET);

    const redacted = await context.app.inject({ method: "POST", url: "/api/mcp-server/rules-mcp/invoke", payload: { arguments: { q: `write to ${EMAIL}` } } });
    expect(redacted.json<{ ok: boolean }>().ok).toBe(true);
    expect(redacted.body).not.toContain(EMAIL);
  });
});

describe("response boundary: replays", () => {
  it("a replay of a webhook run checks its output as production did, so the outputs compare", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(webhookWorkflow("replayed-hook"));
    const hook = await context.app.inject({ method: "POST", url: "/webhook/replayed-hook", payload: { user_prompt: `write to ${EMAIL}` } });
    expect(hook.statusCode).toBe(200);
    const source = (await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'replayed-hook'"))[0]!.id;
    const saved = await call(context, "POST", "/api/replay/recordings", admin, { executionId: source, name: "From a webhook" });
    expect(saved.statusCode, saved.body).toBe(201);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;

    const replayed = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, admin, { draft: true });
    expect(replayed.statusCode, replayed.body).toBe(200);
    const executionId = replayed.json<{ executionId: string }>().executionId;
    const run = await history(context, executionId);
    expect(JSON.stringify(run.output)).not.toContain(EMAIL);
    expect(JSON.stringify(run.output)).toEqual(JSON.stringify((await history(context, source)).output));
    expect((await responseEvents(context, executionId)).length).toBeGreaterThan(0);
  });
});

describe("incoming payload check (trigger_input)", () => {
  it("refuses a blocked payload with 400 content_filter before anything runs, and runs a rewritten one", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await bindRules(context, admin, { trigger_input: channel({ credential: { action: "block" }, email: { action: "redact" } }) });
    await context.store.upsertWorkflow(webhookWorkflow("door-hook", { authMode: "none", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }));

    const refused = await context.app.inject({ method: "POST", url: "/webhook/door-hook", headers: { "idempotency-key": "d-1" }, payload: { user_prompt: `key ${SECRET}` } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: TRIGGER_INPUT_REFUSED_MESSAGE, code: "content_filter" });
    expect(await testSql(context.store).all("SELECT id FROM execution_history WHERE workflow_id = 'door-hook'")).toEqual([]);
    // Nothing was reserved under the key: the same key with a clean payload runs.
    expect(await testSql(context.store).all("SELECT idempotency_key FROM webhook_idempotency")).toEqual([]);
    const events = await testSql(context.store).all<{ channel: string; placement: string }>("SELECT channel, placement FROM guard_events WHERE workflow_id = 'door-hook'");
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.channel === "trigger_input" && event.placement === "request")).toBe(true);
    // Listed under their own source, never as responses to callers.
    const listed = (await call(context, "GET", "/api/guard/events?placement=request&workflowId=door-hook", admin)).json<{ events: GuardEventView[] }>().events;
    expect(listed.length).toBe(events.length);
    expect((await call(context, "GET", "/api/guard/events?placement=response&workflowId=door-hook", admin)).json<{ events: GuardEventView[] }>().events).toEqual([]);

    const rewritten = await context.app.inject({ method: "POST", url: "/webhook/door-hook", headers: { "idempotency-key": "d-2" }, payload: { user_prompt: `write to ${EMAIL}` } });
    expect(rewritten.statusCode).toBe(200);
    expect(rewritten.body).not.toContain(EMAIL);
    const executionId = (await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'door-hook'"))[0]!.id;
    const run = await history(context, executionId);
    // The run started from the checked payload: its input and every node saw the rewritten text.
    expect(JSON.stringify(run.input)).not.toContain(EMAIL);
    expect(JSON.stringify(run.nodeResults)).not.toContain(EMAIL);
  });
});

/** trigger → middle → Output, for the paths that end before the run-end check. */
function chained(id: string, trigger: WorkflowNode, middle: WorkflowNode): Workflow {
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [trigger, middle, node("out", "output", { outputKey: "result", responseTemplate: "done" })],
    edges: [
      { id: "e1", source: trigger.id, target: middle.id },
      { id: "e2", source: middle.id, target: "out" }
    ]
  };
}
const approvalStep = (template: string) => node("gate", "human_approval", { approvalMessage: `Approve: ${template}`, timeoutMinutes: 5 });
const failingStep = (template: string) => node("stop", "stop_and_error", { message: `leak ${template}` });

describe("replies of runs that end before the run-end check", () => {
  it("answers a paused run with only that it waits, on every surface and for idempotent retries", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(chained("open-pause", node("hook", "webhook_input", { path: "open-pause", method: "POST" }), approvalStep("{{user_prompt}}")));
    // Without response rules the reply is as before: the approval message included.
    const open = await context.app.inject({ method: "POST", url: "/webhook/open-pause", payload: { user_prompt: "hello" } });
    expect(open.json<{ output: { approvalMessage: string } }>().output.approvalMessage).toBe("Approve: hello");

    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(chained("pause-hook", node("hook", "webhook_input", { path: "pause-hook", method: "POST", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }), approvalStep("{{user_prompt}}")));
    await context.store.upsertWorkflow(chained("pause-chat", node("chat", "chat_trigger", { authMode: "public" }), approvalStep("{{message}}")));
    await context.store.upsertWorkflow(chained("pause-mcp", node("mcp", "mcp_server_trigger", { path: "pause-mcp", toolName: "pause", authMode: "public", inputSchema: { type: "object" } }), approvalStep("{{q}}")));

    const send = () => context.app.inject({ method: "POST", url: "/webhook/pause-hook", headers: { "idempotency-key": "p-1" }, payload: { user_prompt: `key ${SECRET}` } });
    const paused = await send();
    expect(paused.statusCode).toBe(200);
    const executionId = (await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'pause-hook'"))[0]!.id;
    expect(paused.json<{ output: unknown }>().output).toEqual({ waitingForApproval: true, executionId });
    expect((await send()).body).not.toContain(SECRET);
    expect(JSON.stringify(await testSql(context.store).all("SELECT result_json FROM webhook_idempotency"))).not.toContain(SECRET);

    const chat = await context.app.inject({ method: "POST", url: "/api/chat/pause-chat", payload: { message: `key ${SECRET}` } });
    expect(chat.statusCode).toBe(200);
    expect(chat.body).not.toContain(SECRET);
    expect(chat.json<{ output: { waitingForApproval: boolean } }>().output.waitingForApproval).toBe(true);

    const mcp = await context.app.inject({ method: "POST", url: "/api/mcp-server/pause-mcp/invoke", payload: { arguments: { q: `key ${SECRET}` } } });
    expect(mcp.body).not.toContain(SECRET);
    expect(mcp.json<{ result: { waitingForApproval: boolean } }>().result.waitingForApproval).toBe(true);
  });

  it("answers a failed run with a generic error and its execution id; the history keeps the error", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(chained("open-fail", node("hook", "webhook_input", { path: "open-fail", method: "POST" }), failingStep("{{user_prompt}}")));
    const open = await context.app.inject({ method: "POST", url: "/webhook/open-fail", payload: { user_prompt: "hello" } });
    expect(open.statusCode).toBe(400);
    expect(open.json<{ error: string }>().error).toContain("leak hello");

    await bindRules(context, admin, RESPONSE_RULES);
    await context.store.upsertWorkflow(chained("fail-hook", node("hook", "webhook_input", { path: "fail-hook", method: "POST", idempotencyEnabled: true, idempotencyHeaderName: "idempotency-key" }), failingStep("{{user_prompt}}")));
    await context.store.upsertWorkflow(chained("fail-mcp", node("mcp", "mcp_server_trigger", { path: "fail-mcp", toolName: "fail", authMode: "public", inputSchema: { type: "object" } }), failingStep("{{q}}")));

    const send = () => context.app.inject({ method: "POST", url: "/webhook/fail-hook", headers: { "idempotency-key": "f-1" }, payload: { user_prompt: `key ${SECRET}` } });
    const failed = await send();
    expect(failed.statusCode).toBe(400);
    const executionId = (await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'fail-hook'"))[0]!.id;
    expect(failed.json()).toMatchObject({ output: null, error: RESPONSE_FAILED_MESSAGE, executionId });
    expect(failed.body).not.toContain(SECRET);
    expect((await send()).body).not.toContain(SECRET);
    expect(JSON.stringify(await testSql(context.store).all("SELECT result_json FROM webhook_idempotency"))).not.toContain(SECRET);
    expect((await history(context, executionId)).error).toContain(SECRET);

    const mcp = await context.app.inject({ method: "POST", url: "/api/mcp-server/fail-mcp/invoke", payload: { arguments: { q: `key ${SECRET}` } } });
    expect(mcp.statusCode).toBe(500);
    expect(mcp.json()).toEqual({ error: RESPONSE_FAILED_MESSAGE, executionId: expect.any(String) });
  });
});

describe("run views below builder", () => {
  it("hide node data of externally answered runs while response rules exist; builders see what ran", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    await context.store.upsertWorkflow(webhookWorkflow("view-hook"));
    const before = await context.app.inject({ method: "POST", url: "/webhook/view-hook", payload: { user_prompt: `write to ${EMAIL}` } });
    expect(before.statusCode).toBe(200);
    const [earlier] = await testSql(context.store).all<{ id: string }>("SELECT id FROM execution_history WHERE workflow_id = 'view-hook'");
    // No response rules yet: a viewer reads the run as before.
    expect((await call(context, "GET", `/api/executions/${earlier!.id}`, viewer)).body).toContain(EMAIL);

    await bindRules(context, admin, RESPONSE_RULES);
    const blocked = await context.app.inject({ method: "POST", url: "/webhook/view-hook", payload: { user_prompt: `key ${SECRET}` } });
    expect(blocked.statusCode).toBe(422);
    const executionId = blocked.json<{ executionId: string }>().executionId;

    const asViewer = await call(context, "GET", `/api/executions/${executionId}`, viewer);
    expect(asViewer.statusCode).toBe(200);
    const view = asViewer.json<{ input: unknown; output: { code: string }; nodeResults: Array<{ nodeId: string; status: string; output: unknown }> }>();
    // The request as sent stays (it is not what the run answered); nothing the run produced is readable.
    expect(JSON.stringify({ ...view, input: null })).not.toContain(SECRET);
    expect(view.output.code).toBe("content_filter");
    expect(view.nodeResults.map((entry) => [entry.nodeId, entry.status, entry.output])).toEqual([
      ["hook", "success", HIDDEN_BY_RESPONSE_RULES],
      ["out", "success", HIDDEN_BY_RESPONSE_RULES]
    ]);
    const events = await call(context, "GET", `/api/executions/${executionId}/events`, viewer);
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("event: execution");
    expect(events.body).not.toContain(`"result":"key ${SECRET}`);
    expect(events.body).toContain(HIDDEN_BY_RESPONSE_RULES);

    // Builders debug from what ran.
    expect((await call(context, "GET", `/api/executions/${executionId}`, admin)).body).toContain(SECRET);
    expect((await call(context, "GET", `/api/executions/${executionId}/events`, admin)).body).toContain(`"result":"key ${SECRET}`);
    // Editor runs answered no external caller: unchanged for viewers.
    const editor = await call(context, "POST", "/api/workflows/view-hook/execute", admin, { user_prompt: `key ${SECRET}` });
    expect((await call(context, "GET", `/api/executions/${editor.json<{ executionId: string }>().executionId}`, viewer)).body).toContain(SECRET);
  });
});

