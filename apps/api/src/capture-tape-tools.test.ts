/**
 * Capture masking and tool definitions in the model tape, end to end: a
 * production capture of an agent run whose tools carry a dictionary term (in
 * a tool name and in a description) replays in strict mode from its tape,
 * both when the tool comes from an MCP server (masked like the cassette's
 * `tools/list` copy, which replay builds from) and when it is a worker
 * delegate tool or a built-in tool (rebuilt at replay, so kept as written).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { EvalRunView, ReplayCaptureView, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const servers: http.Server[] = [];
const EMAIL = "jane.doe@example.com";
const TERM = "atlas";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-tape-tools-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
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

async function login(context: TestContext, role: "admin" | "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A streamable-HTTP MCP server listing one tool whose name and description hold the dictionary term. */
async function startMcp() {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as { id?: string; method?: string };
      response.setHeader("content-type", "application/json");
      if (rpc.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
      } else if (rpc.method === "tools/list") {
        const tools = [{ name: `${TERM}-search`, description: `Search the ${TERM} catalog`, inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } }];
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools } }));
      } else if (rpc.method === "tools/call") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "nothing" }] } }));
      } else {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: {} }));
      }
    });
  });
  return { endpoint: `http://127.0.0.1:${await listen(server)}/mcp` };
}

/**
 * A chat endpoint that answers at once. (A supervisor that delegates is not
 * used: the worker's result it gets back carries latencies, so the next
 * supervisor request never matches the tape, masked or not.)
 */
async function startModel() {
  const requests: Array<{ tools?: Array<{ function?: { name?: string } }>; messages: Array<{ role: string }> }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(JSON.parse(body) as (typeof requests)[number]);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    });
  });
  return { baseUrl: `http://127.0.0.1:${await listen(server)}/v1`, requests };
}

const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id) => ({ id, type, name, position: { x: 0, y: 0 }, config });
const chatModel = (id: string, baseUrl: string) => node(id, "llm_call", { provider: { providerId: "openai", model: "m", baseUrl, extra: { apiKey: "test-key", maxRetries: 0 } } });

/** webhook → agent (an MCP server's tools) → output. */
function mcpAgent(id: string, serverId: string, baseUrl: string): Workflow {
  return {
    id,
    name: "Catalog agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("agent", "agent_orchestrator", { maxIterations: 2, toolCallingEnabled: true }),
      chatModel("model", baseUrl),
      node("tool", "mcp_tool", { registryServerId: serverId, toolName: "__all__" }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "hook", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e4", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  } as Workflow;
}

/** webhook → supervisor (one worker, whose name holds the term) → output. */
function supervisor(id: string, baseUrl: string): Workflow {
  return {
    id,
    name: "Desk supervisor",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      node("hook", "webhook_input", { path: `hook-${id}`, method: "POST" }),
      node("sup", "supervisor_node", { maxIterations: 3 }),
      chatModel("sup_model", baseUrl),
      node("worker", "agent_orchestrator", { systemPromptTemplate: "Answer briefly.", userPromptTemplate: "Help.", maxIterations: 1, toolCallingEnabled: false }, `${TERM}-Helper`),
      chatModel("worker_model", baseUrl),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "hook", target: "sup" },
      { id: "e2", source: "sup", target: "out" },
      { id: "e3", source: "sup", sourceHandle: "chat_model", target: "sup_model" },
      { id: "e4", source: "sup", sourceHandle: "worker", target: "worker" },
      { id: "e5", source: "worker", sourceHandle: "chat_model", target: "worker_model" }
    ]
  } as Workflow;
}

async function save(context: TestContext, workflow: Workflow): Promise<void> {
  const saved = await context.store.upsertWorkflow(workflow);
  await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" });
}

/** A guard profile whose dictionary holds the term, bound to the workflow, and capture on. */
async function bindDictionaryAndCapture(context: TestContext, admin: string, workflowId: string, terms: string[] = [TERM]): Promise<void> {
  const profile = await call(context, "POST", "/api/guard/profiles", admin, {
    document: { id: `dict-${workflowId}`, name: "Project names", version: "1", dictionaries: [{ dataClass: "project", terms }] }
  });
  expect(profile.statusCode, profile.body).toBe(201);
  const bound = await call(context, "PUT", `/api/guard/bindings/workflows/${workflowId}`, admin, { mode: "override", profileId: `dict-${workflowId}` });
  expect(bound.statusCode, bound.body).toBe(200);
  const capture = await call(context, "PUT", `/api/workflows/${workflowId}/replay-capture`, admin, { enabled: true, rate: 1 });
  expect(capture.statusCode, capture.body).toBe(200);
}

async function waitForCapture(context: TestContext, cookie: string, workflowId: string): Promise<ReplayCaptureView> {
  const until = Date.now() + 20_000;
  for (;;) {
    const page = (await call(context, "GET", `/api/workflows/${workflowId}/replay-captures`, cookie)).json<{ items: ReplayCaptureView[] }>();
    if (page.items.length > 0) return page.items[0]!;
    const settings = (await call(context, "GET", `/api/workflows/${workflowId}/replay-capture`, cookie)).json<{ settings: { lastDrop?: unknown } }>();
    if (settings.settings.lastDrop) throw new Error(`Capture dropped: ${JSON.stringify(settings.settings.lastDrop)}`);
    if (Date.now() > until) throw new Error("No capture arrived");
    await sleep(25);
  }
}

/** Promotes the capture and replays it with the model tape and strict MCP matching. */
async function replayStrict(context: TestContext, cookie: string, captureId: string) {
  const promoted = await call(context, "POST", `/api/replay/captures/${captureId}/promote`, cookie, {});
  expect(promoted.statusCode, promoted.body).toBe(200);
  const datasetId = promoted.json<{ result: { datasetId: string } }>().result.datasetId;
  const started = await call(context, "POST", "/api/replay/runs", cookie, { datasetIds: [datasetId], models: "replay", mcpMode: "strict" });
  expect(started.statusCode, started.body).toBe(202);
  const runId = started.json<{ run: EvalRunView }>().run.id;
  const until = Date.now() + 45_000;
  for (;;) {
    const run = (await call(context, "GET", `/api/replay/runs/${runId}`, cookie)).json<{ run: EvalRunView & { results: Array<{ status: string; error?: string | null }> } }>().run;
    if (!["queued", "running"].includes(run.status)) return run;
    if (Date.now() > until) throw new Error(`Job ${runId} still ${run.status}`);
    await sleep(50);
  }
}

describe("model-tape tool definitions survive capture masking", () => {
  it("an MCP tool with the term in its name and description is masked like the cassette copy, and a strict replay hits the tape", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const mcp = await startMcp();
    const model = await startModel();
    const created = await call(context, "POST", "/api/mcp/servers", admin, { name: "Catalog", adapterId: "http_mcp", probeEnabled: false, connection: { endpoint: mcp.endpoint } });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = created.json<{ server: { id: string } }>().server.id;
    await save(context, mcpAgent("wf-tape-mcp", serverId, model.baseUrl));
    await bindDictionaryAndCapture(context, admin, "wf-tape-mcp");

    const response = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-tape-mcp", payload: { user_prompt: `Find the ${TERM} entry for ${EMAIL}` } });
    expect(response.statusCode, response.body).toBe(200);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools?.map((tool) => tool.function?.name)).toEqual(expect.arrayContaining([`http_mcp__${TERM}-search`, "agent_clarify"]));
    const captured = await waitForCapture(context, admin, "wf-tape-mcp");
    // Strict replay: every model call answered from the tape, every MCP call from the cassette.
    const job = await replayStrict(context, admin, captured.id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.results.map((result) => [result.status, result.error ?? null])).toEqual([["pass", null]]);

    const recording = (await context.store.getReplayRecording(captured.id))!;
    const stored = JSON.stringify(recording);
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(`${TERM}-search`);
    // The tape's definition is exactly what the agent builds from the masked cassette.
    const listed = recording.mcpCassette!.entries.find((entry) => entry.method === "tools/list")!.result as Array<{ name: string; description: string }>;
    const taped = (recording.modelTape!.entries[0]!.request as { tools: Array<{ name: string; description: string }> }).tools;
    expect(taped).toContainEqual(expect.objectContaining({ name: `http_mcp__${listed[0]!.name}`, description: `[http_mcp] ${listed[0]!.description}` }));
    // An internal tool (rebuilt at replay) stays as written.
    expect(taped.map((tool) => tool.name)).toContain("agent_clarify");

    // Served from the tape: no new model call.
    expect(model.requests).toHaveLength(1);
  }, 90_000);

  it("a worker delegate tool and an internal tool holding a term are kept as written, and a strict replay hits the tape", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const model = await startModel();
    await save(context, supervisor("wf-tape-sup", model.baseUrl));
    // `reasonably` appears only in the built-in agent_clarify tool's description: masking it there made the replay miss.
    await bindDictionaryAndCapture(context, admin, "wf-tape-sup", [TERM, "reasonably"]);

    const response = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-tape-sup", payload: { user_prompt: `Ticket from ${EMAIL}` } });
    expect(response.statusCode, response.body).toBe(200);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools?.map((tool) => tool.function?.name)).toContain(`delegate_to_${TERM}-Helper`);
    const captured = await waitForCapture(context, admin, "wf-tape-sup");
    // Strict replay: every model call answered from the tape, every MCP call from the cassette.
    const job = await replayStrict(context, admin, captured.id);
    expect(job.status, job.error ?? "").toBe("completed");
    expect(job.results.map((result) => [result.status, result.error ?? null])).toEqual([["pass", null]]);

    const recording = (await context.store.getReplayRecording(captured.id))!;
    const stored = JSON.stringify(recording);
    expect(stored).not.toContain(EMAIL);
    const delegate = `delegate_to_${TERM}-Helper`;
    const supEntries = recording.modelTape!.entries.filter((entry) => entry.nodeId === "sup");
    const tools = (supEntries[0]!.request as { tools: Array<{ name: string; description: string }> }).tools;
    expect(tools).toContainEqual(expect.objectContaining({ name: delegate, description: expect.stringContaining(`${TERM}-Helper`) }));
    expect(tools).toContainEqual(expect.objectContaining({ name: "agent_clarify", description: expect.stringContaining("reasonably") }));

    expect(model.requests).toHaveLength(1);
  }, 90_000);
});
