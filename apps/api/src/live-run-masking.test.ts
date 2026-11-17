/**
 * Values a run reveals never reach a browser in clear, live or stored, beyond what the run's history keeps:
 *
 * - a run with a Reveal node: its live events (the editor's stream, the chat stream, a reattach) and its progress
 *   writes (what polling reads) carry status and timing only until the Reveal has run, then each node's data as
 *   history keeps it (`node_redacted`); a value typed in clear before a content rules node made it a token is held
 *   back the same way;
 * - an MCP Tool node calling the gateway's `restore_sensitive_data`: the result's signed marker makes the run keep the
 *   tokens, as a Reveal node does;
 * - the run's own downstream nodes still get the values.
 * SQLite.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset, Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-live-mask-"));
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

async function login(context: TestContext, role: "admin" | "builder" | "viewer", email = `${role}@example.com`): Promise<string> {
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const EMAIL = "ana.lopez@example.org";
const PROMPT_LENGTH = `Mail ${EMAIL} today`.length;

const SUPPORT_RULES = {
  id: "support",
  name: "Support",
  version: "1",
  channels: {
    prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "protect" } }, defaultAction: { action: "allow" } }
  },
  reveal: { rules: [{ name: "Admins", dataClasses: ["email"], subjects: { roles: ["admin"] } }] }
};

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

/** What downstream nodes get: the prompt's length (the revealed text is longer than the token text). */
const MEASURE = node("measure", "code_node", { code: "return { promptLength: String(input.user_prompt).length };" });

function chain(id: string, nodes: WorkflowNode[], extraEdges: Array<{ source: string; target: string; sourceHandle?: string }> = []): Workflow {
  const dag = nodes.filter((entry) => entry.type !== "guard_protection");
  const edges = dag.slice(1).map((entry, index) => ({ id: `e${index}`, source: dag[index]!.id, target: entry.id, ...(dag[index]!.type === "guard" ? { sourceHandle: "pass" } : {}) }));
  return {
    id,
    name: id,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes,
    edges: [...edges, ...extraEdges.map((edge, index) => ({ id: `x${index}`, ...edge }))]
  } as Workflow;
}

/** hook → protect (token vault) → out: issues a token for EMAIL. */
const protectWorkflow = () =>
  chain(
    "wf-protect",
    [
      node("hook", "webhook_input", { path: "hook-protect", method: "POST" }),
      node("protect", "guard", { profileId: "support", channel: "prompt", inputField: "user_prompt" }),
      node("vault", "guard_protection", { providerId: "token_vault", dataClasses: ["email"] }),
      node("out", "output")
    ],
    [{ source: "protect", sourceHandle: "protection", target: "vault" }]
  );

/** hook → [wait] → reveal → measure → out */
const revealWorkflow = (id: string, waitMs?: number) =>
  chain(id, [
    node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
    ...(waitMs ? [node("wait", "wait_node", { delayMs: waitMs, maxDelayMs: waitMs })] : []),
    node("reveal", "guard_reveal", { inputField: "user_prompt" }),
    MEASURE,
    node("out", "output")
  ]);

/** hook → protect (token vault) → [wait] → reveal → measure → out: the value is typed in clear. */
const typedWorkflow = (id: string, waitMs?: number) =>
  chain(
    id,
    [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("protect", "guard", { profileId: "support", channel: "prompt", inputField: "user_prompt" }),
      node("vault", "guard_protection", { providerId: "token_vault", dataClasses: ["email"] }),
      ...(waitMs ? [node("wait", "wait_node", { delayMs: waitMs, maxDelayMs: waitMs })] : []),
      node("reveal", "guard_reveal", { inputField: "user_prompt" }),
      MEASURE,
      node("out", "output")
    ],
    [{ source: "protect", sourceHandle: "protection", target: "vault" }]
  );

type RunResult = { status: string; executionId?: string; error?: string; output?: unknown; nodeResults: Array<{ nodeId: string; status: string; input?: unknown; output?: Record<string, any> }> };

/** The rule set saved, a token issued for EMAIL, and `workflows` stored, published and bound to the rule set. */
async function setUp(context: TestContext, admin: string, workflows: Workflow[]): Promise<string> {
  expect((await call(context, "POST", "/api/guard/profiles", admin, { id: "support", document: SUPPORT_RULES })).statusCode).toBe(201);
  await context.store.upsertWorkflow(protectWorkflow());
  const protect = (await call(context, "POST", "/api/workflows/wf-protect/execute", admin, { user_prompt: `Mail ${EMAIL} today` })).json<RunResult>();
  expect(protect.status, protect.error).toBe("success");
  const token = String(protect.nodeResults.find((entry) => entry.nodeId === "protect")?.output?.user_prompt).split(" ")[1]!;
  expect(token).toMatch(/^tok_email_/);
  for (const workflow of workflows) {
    const saved = await context.store.upsertWorkflow(workflow);
    await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" });
    const bound = await call(context, "PUT", `/api/guard/bindings/workflows/${workflow.id}`, admin, { mode: "override", profileId: "support" });
    expect(bound.statusCode, bound.body).toBe(200);
  }
  return token;
}

/** The SSE events of a body, in order. */
function sseEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const [first, ...rest] = frame.split("\n");
      return { event: first!.slice("event: ".length), data: JSON.parse(rest.map((line) => line.slice("data: ".length)).join("\n")) };
    });
}

/** Each node's data as a client that applies the events in order shows it at the end of the stream (before `result`). */
function streamedView(events: Array<{ event: string; data: any }>): Map<string, { input?: unknown; output?: unknown }> {
  const view = new Map<string, { input?: unknown; output?: unknown }>();
  for (const { event, data } of events) {
    if (!data || typeof data.nodeId !== "string") continue;
    const current = view.get(data.nodeId) ?? {};
    if (event === "node_start") view.set(data.nodeId, { ...current, input: data.input ?? current.input });
    if (event === "node_complete") view.set(data.nodeId, { input: data.input ?? current.input, output: data.output ?? current.output });
    if (event === "node_redacted") view.set(data.nodeId, { input: data.input, output: data.output });
  }
  return view;
}

const outputOf = (run: RunResult, nodeId: string) => run.nodeResults.find((entry) => entry.nodeId === nodeId)?.output ?? {};

async function until<T>(read: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("live runs with a Reveal node", () => {
  it("editor stream: no event carries the revealed value, downstream nodes get it, and the stream ends as history keeps it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const token = await setUp(context, admin, [revealWorkflow("wf-reveal")]);
    const stream = await call(context, "POST", "/api/workflows/wf-reveal/execute/stream", admin, { user_prompt: `Mail ${token} today` });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).not.toContain(EMAIL);
    const events = sseEvents(stream.body);
    const result = events.find((entry) => entry.event === "result")!.data as RunResult;
    expect(result.status, result.error).toBe("success");
    // The node after the Reveal got the value.
    expect(outputOf(result, "measure").promptLength).toBe(PROMPT_LENGTH);
    expect(outputOf(result, "reveal").reveal.revealed).toEqual([expect.objectContaining({ dataClass: "email", count: 1 })]);
    // Before the Reveal ran, node events carried no node data; then each node's data came as history keeps it.
    const hookComplete = events.find((entry) => entry.event === "node_complete" && entry.data.nodeId === "hook")!.data;
    expect(hookComplete).not.toHaveProperty("output");
    expect(hookComplete).not.toHaveProperty("input");
    expect(events.filter((entry) => entry.event === "node_redacted").map((entry) => entry.data.nodeId)).toEqual(expect.arrayContaining(["hook", "reveal"]));
    const history = (await call(context, "GET", `/api/executions/${result.executionId}`, admin)).json<RunResult>();
    expect(JSON.stringify(history)).not.toContain(EMAIL);
    const view = streamedView(events);
    for (const entry of history.nodeResults) {
      expect(view.get(entry.nodeId)?.output, entry.nodeId).toEqual(entry.output);
      expect(view.get(entry.nodeId)?.input, entry.nodeId).toEqual(entry.input);
    }
  });

  it("a value typed in clear is never streamed or written as progress, while history masks it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await setUp(context, admin, [typedWorkflow("wf-typed")]);
    const writes: Array<{ status: string; inputJson?: unknown; nodeResultsJson?: unknown }> = [];
    const save = context.store.saveExecutionHistory.bind(context.store);
    vi.spyOn(context.store, "saveExecutionHistory").mockImplementation(async (record, options) => {
      if (record.workflowId === "wf-typed") writes.push(structuredClone({ status: record.status, inputJson: record.inputJson, nodeResultsJson: record.nodeResultsJson }));
      return await save(record, options);
    });
    const stream = await call(context, "POST", "/api/workflows/wf-typed/execute/stream", admin, { user_prompt: `Mail ${EMAIL} today` });
    const events = sseEvents(stream.body);
    const result = events.find((entry) => entry.event === "result")!.data as RunResult;
    expect(result.status, result.error).toBe("success");
    expect(outputOf(result, "measure").promptLength).toBe(PROMPT_LENGTH);
    expect(stream.body).not.toContain(EMAIL);
    expect(writes.length).toBeGreaterThan(1);
    for (const write of writes) expect(JSON.stringify(write)).not.toContain(EMAIL);
    // The first progress writes carry no node data; the last one holds each node's data as history keeps it.
    expect(JSON.stringify(writes[0]!.nodeResultsJson)).not.toContain("user_prompt");
    const history = (await call(context, "GET", `/api/executions/${result.executionId}`, admin)).json<RunResult>();
    expect(JSON.stringify(history)).not.toContain(EMAIL);
    expect(JSON.stringify(history.nodeResults)).toContain("tok_email_");
  });

  it("a value typed in clear stays out of polling and reattach during the run, and out of the run's stored input", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    await setUp(context, admin, [typedWorkflow("wf-typed-slow", 400)]);
    const running = call(context, "POST", "/api/workflows/wf-typed-slow/execute", admin, { user_prompt: `Mail ${EMAIL} today` });
    const live = await until(async () => (await context.store.listExecutionHistory({ page: 1, pageSize: 5, workflowId: "wf-typed-slow" })).items.find((item) => item.status === "running"), "the run to start");
    for (const who of [viewer, admin]) {
      const polled = await call(context, "GET", `/api/executions/${live.id}`, who);
      expect(polled.statusCode).toBe(200);
      expect(polled.body).not.toContain(EMAIL);
    }
    const reattached = await call(context, "GET", `/api/executions/${live.id}/events`, admin);
    const finished = (await running).json<RunResult>();
    expect(finished.status, finished.error).toBe("success");
    expect(outputOf(finished, "measure").promptLength).toBe(PROMPT_LENGTH);
    expect(reattached.body).not.toContain(EMAIL);
    const history = await call(context, "GET", `/api/executions/${live.id}`, admin);
    expect(history.body).not.toContain(EMAIL);
    expect(history.body).toContain("tok_email_");
  });

  it("chat stream: the same holds for the streaming webhook API", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await setUp(context, admin, [typedWorkflow("wf-chat")]);
    const stream = await call(context, "POST", "/api/webhooks/execute/stream", admin, { workflow_id: "wf-chat", user_prompt: `Mail ${EMAIL} today`, session_id: "s-1" });
    expect(stream.statusCode, stream.body).toBe(200);
    const events = sseEvents(stream.body);
    const result = events.find((entry) => entry.event === "result")!.data as RunResult;
    expect(result.status, result.error).toBe("success");
    expect(outputOf(result, "measure").promptLength).toBe(PROMPT_LENGTH);
    expect(stream.body).not.toContain(EMAIL);
    expect(events.some((entry) => entry.event === "node_redacted")).toBe(true);
  });

  it("reattach and polling during the run: the stored run and the relayed events hold no revealed value", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    const token = await setUp(context, admin, [revealWorkflow("wf-slow", 400)]);
    const running = call(context, "POST", "/api/workflows/wf-slow/execute", admin, { user_prompt: `Mail ${token} today` });
    const live = await until(async () => (await context.store.listExecutionHistory({ page: 1, pageSize: 5, workflowId: "wf-slow" })).items.find((item) => item.status === "running"), "the run to start");
    const polled = await call(context, "GET", `/api/executions/${live.id}`, viewer);
    expect(polled.statusCode).toBe(200);
    expect(polled.body).not.toContain(EMAIL);
    const reattached = await call(context, "GET", `/api/executions/${live.id}/events`, viewer);
    const finished = (await running).json<RunResult>();
    expect(finished.status, finished.error).toBe("success");
    expect(outputOf(finished, "measure").promptLength).toBe(PROMPT_LENGTH);
    expect(reattached.body).not.toContain(EMAIL);
    const events = sseEvents(reattached.body);
    expect(events[0]!.event).toBe("execution");
    expect(events.some((entry) => entry.event === "node_redacted" && entry.data.nodeId === "hook")).toBe(true);
    expect(events.at(-1)!.event).toBe("result");
  });

  it("a workflow without a Reveal node streams node data as it runs", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(chain("wf-plain", [node("hook", "webhook_input", { path: "hook-plain", method: "POST" }), MEASURE, node("out", "output")]));
    const stream = await call(context, "POST", "/api/workflows/wf-plain/execute/stream", admin, { user_prompt: "hello" });
    const events = sseEvents(stream.body);
    expect(events.find((entry) => entry.event === "node_complete" && entry.data.nodeId === "measure")!.data.output).toMatchObject({ promptLength: 5 });
    expect(events.some((entry) => entry.event === "node_redacted")).toBe(false);
  });
});

/** A toolset with the content rules tools, a client whose reveal rule allows emails, the app listening, and EMAIL redacted through the gateway by a workflow. */
async function gatewayFixture(context: TestContext, admin: string) {
  const created = await call(context, "POST", "/api/guard/profiles", admin, { document: { id: "pii", name: "PII", version: "1", reveal: { rules: [] } } });
  expect(created.statusCode, created.body).toBe(201);
  const toolsetResponse = await call(context, "POST", "/api/mcp/toolsets", admin, { name: "Privacy tools", projectId: "default", members: [{ kind: "content_rules", ruleSetId: "pii" }] });
  expect(toolsetResponse.statusCode, toolsetResponse.body).toBe(201);
  const toolset = toolsetResponse.json<{ toolset: McpToolset }>().toolset;
  const clientResponse = await call(context, "POST", "/api/mcp/clients", admin, { name: "Workflow", toolsetIds: [toolset.id], role: "builder" });
  expect(clientResponse.statusCode, clientResponse.body).toBe(201);
  const { client, token } = clientResponse.json<{ client: McpClient; token: string }>();
  const rules = await call(context, "PUT", "/api/guard/profiles/pii", admin, {
    document: { id: "pii", name: "PII", version: "1", reveal: { rules: [{ dataClasses: ["email"], subjects: { gatewayClients: [client.id] } }] } }
  });
  expect(rules.statusCode, rules.body).toBe(200);

  await context.app.listen({ host: "127.0.0.1", port: 0 });
  const address = context.app.server.address();
  const base = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  const connection = { endpoint: `${base}/mcp/${toolset.slug}`, authType: "bearer", bearerToken: token };

  // Redacted through the gateway first (as a client would), then restored by the workflow under test.
  await context.store.upsertWorkflow(
    chain("wf-redact", [
      node("start", "manual_trigger"),
      node("redact", "mcp_tool", { serverId: "http_mcp", connection, toolName: "redact_sensitive_data", argsTemplate: JSON.stringify({ text: `Mail ${EMAIL} today` }), retry: { enabled: false } }),
      node("out", "output")
    ])
  );
  const redactRun = (await call(context, "POST", "/api/workflows/wf-redact/execute", admin, {})).json<RunResult>();
  expect(redactRun.status, redactRun.error).toBe("success");
  const redacted = outputOf(redactRun, "redact").structured as { redacted: string; redaction_id: string };
  expect(redacted.redacted).not.toContain(EMAIL);

  const restoreWorkflow = chain("wf-restore", [
    node("start", "manual_trigger"),
    node("restore", "mcp_tool", {
      serverId: "http_mcp",
      connection,
      toolName: "restore_sensitive_data",
      argsTemplate: JSON.stringify({ text: redacted.redacted, redaction_id: redacted.redaction_id }),
      retry: { enabled: false }
    }),
    node("measure", "code_node", { code: "return { restoredLength: String(input.restore.structured.restored).length };" }),
    node("out", "output")
  ]);
  await context.store.upsertWorkflow(restoreWorkflow);
  return { redacted };
}

describe("an MCP Tool node that calls the gateway's restore_sensitive_data", () => {
  it("keeps the restored values out of the live stream and history as their placeholders; downstream nodes get them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { redacted } = await gatewayFixture(context, admin);
    const stream = await call(context, "POST", "/api/workflows/wf-restore/execute/stream", admin, {});
    const events = sseEvents(stream.body);
    const result = events.find((entry) => entry.event === "result")!.data as RunResult;
    expect(result.status, result.error).toBe("success");
    // The restore gave the value back, and the next node got it.
    expect(outputOf(result, "measure").restoredLength).toBe(PROMPT_LENGTH);
    expect(stream.body).not.toContain(EMAIL);
    const history = (await call(context, "GET", `/api/executions/${result.executionId}`, admin)).json<RunResult>();
    expect(JSON.stringify(history)).not.toContain(EMAIL);
    // History keeps the placeholder the restore turned back.
    expect((outputOf(history, "restore").structured as { restored: string }).restored).toBe(redacted.redacted);
  });

  it("corrects what earlier events showed of the value: the stream ends as history keeps it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await gatewayFixture(context, admin);
    // The run's input holds the value in clear: the trigger's events carry it until the restore lists it.
    const stream = await call(context, "POST", "/api/workflows/wf-restore/execute/stream", admin, { user_prompt: `Mail ${EMAIL} today` });
    const events = sseEvents(stream.body);
    const result = events.find((entry) => entry.event === "result")!.data as RunResult;
    expect(result.status, result.error).toBe("success");
    const corrected = events.filter((entry) => entry.event === "node_redacted");
    expect(corrected.map((entry) => entry.data.nodeId)).toContain("start");
    expect(JSON.stringify(corrected)).not.toContain(EMAIL);
    const firstCorrection = events.findIndex((entry) => entry.event === "node_redacted");
    expect(JSON.stringify(events.slice(firstCorrection))).not.toContain(EMAIL);
    const history = (await call(context, "GET", `/api/executions/${result.executionId}`, admin)).json<RunResult>();
    expect(JSON.stringify(history.nodeResults)).not.toContain(EMAIL);
    const view = streamedView(events);
    for (const entry of history.nodeResults) {
      expect(view.get(entry.nodeId)?.output, entry.nodeId).toEqual(entry.output);
      expect(view.get(entry.nodeId)?.input, entry.nodeId).toEqual(entry.input);
    }
  });
});
