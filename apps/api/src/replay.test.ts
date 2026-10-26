/**
 * Phase 15.1 — golden runs and replay over the API: saving a run as a golden
 * run (scrubbed of secrets, copied out of execution history), replays that
 * never reach Slack, outbound HTTP, live MCP servers, session memory or the
 * error workflow, the run diff and verdict, RBAC, the Runs page badge,
 * survival of history pruning, the size cap and migration 30.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ReplayRecordingDetail, ReplayRecordingSummary, ReplayRunResponse, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { AuthService } from "./services/auth-service.js";
import { projectSessionNamespace } from "./run-scope.js";
import { ReplayRecordingService } from "./services/replay-recording-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  dbPath: string;
}

const contexts: TestContext[] = [];
const closers: Array<() => Promise<void>> = [];
const PLANTED = "sk-planted-REPLAY-value-1a2b3c4d5e6f7a8b9c0d";

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-replay-"));
  const dbPath = path.join(tempDir, "orchestrator.db");
  const store = await SqliteStore.create(dbPath);
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, secretService, config, tempDir, dbPath };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length > 0) await closers.pop()!();
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A local endpoint standing in for Slack, outbound HTTP targets and the error workflow's notifier: it only counts hits per path. */
async function startCounter() {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = (request.url ?? "/").split("?")[0]!;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind counter");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${address.port}`, count: (route: string) => hits.get(route) ?? 0 };
}

/** A local OpenAI-style endpoint that replies with a fixed answer and echoes the bearer token into it. */
async function startEchoModel(answer: string) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: `${answer} (auth was ${String(request.headers.authorization ?? "")})` } }],
          usage: { prompt_tokens: 40, completion_tokens: 8 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls: () => calls };
}

async function registerServer(context: TestContext, adminCookie: string): Promise<string> {
  const created = await call(context, "POST", "/api/mcp/servers", adminCookie, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ server: { id: string } }>().server.id;
  expect((await call(context, "POST", `/api/mcp/servers/${id}/probe`, adminCookie)).statusCode).toBe(200);
  return id;
}

/**
 * start → MCP tool (clock) → code → label → Slack → HTTP → output; the
 * error workflow is wf-error. `escape` gives the code node a script that
 * tries to break out of the JavaScript sandbox and call the counter's /code
 * route; the sandbox blocks it, so the call never happens.
 */
function sideEffectWorkflow(options: { serverId: string; base: string; answer?: string; tz?: string; broken?: boolean; escape?: boolean }): Workflow {
  const code = options.escape
    ? `try { const p = this.constructor.constructor('return process')(); await p.getBuiltinModule('node:http').get(${JSON.stringify(`${options.base}/code`)}); } catch (e) {} return { shaped: true };`
    : "return { shaped: true };";
  const label = options.broken
    ? { id: "label", type: "stop_and_error", name: "Label", position: { x: 375, y: 0 }, config: { message: "candidate broke" } }
    : { id: "label", type: "set_node", name: "Label", position: { x: 375, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: options.answer ?? "v1" }] } };
  return {
    id: "wf-golden",
    name: "Golden",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    settings: { errorWorkflowId: "wf-error" },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "tool",
        type: "mcp_tool",
        name: "Clock",
        position: { x: 150, y: 0 },
        config: { registryServerId: options.serverId, toolName: "get_current_time", argsTemplate: JSON.stringify({ tz: options.tz ?? "UTC" }), retry: { enabled: false } }
      },
      { id: "shape", type: "code_node", name: "Shape", position: { x: 300, y: 0 }, config: { code } },
      label,
      { id: "notify", type: "slack_send_message", name: "Notify", position: { x: 450, y: 0 }, config: { authType: "webhook", webhookUrl: `${options.base}/slack`, text: "done" } },
      { id: "post", type: "http_request", name: "Post", position: { x: 600, y: 0 }, config: { method: "POST", urlTemplate: `${options.base}/http`, retry: { enabled: false } } },
      { id: "output", type: "output", name: "Output", position: { x: 750, y: 0 }, config: { responseTemplate: "{{results.label.answer}} at {{results.tool.tool_output}}" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "tool" },
      { id: "e2", source: "tool", target: "shape" },
      { id: "e3", source: "shape", target: "label" },
      { id: "e4", source: "label", target: "notify" },
      { id: "e5", source: "notify", target: "post" },
      { id: "e6", source: "post", target: "output" }
    ]
  } as Workflow;
}

/** The error workflow: anything it runs hits the counter's /error route. */
function errorWorkflow(base: string): Workflow {
  return {
    id: "wf-error",
    name: "On error",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "post", type: "http_request", name: "Page", position: { x: 150, y: 0 }, config: { method: "POST", urlTemplate: `${base}/error`, retry: { enabled: false } } },
      { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "post" },
      { id: "e2", source: "post", target: "output" }
    ]
  } as Workflow;
}

/** start → agent (echo model, Simple Memory) → output. */
function agentWorkflow(baseUrl: string, secretId: string, options: { codeThrows?: boolean } = {}): Workflow {
  const nodes: Workflow["nodes"] = [
    { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
    {
      id: "agent",
      type: "agent_orchestrator",
      name: "Agent",
      position: { x: 150, y: 0 },
      config: { systemPromptTemplate: "Be brief.", userPromptTemplate: "Say hi", maxIterations: 2, toolCallingEnabled: false }
    },
    {
      id: "model",
      type: "llm_call",
      name: "Model",
      position: { x: 150, y: 160 },
      config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, secretRef: { secretId }, extra: { maxRetries: 0 } } }
    },
    { id: "memory", type: "local_memory", name: "Memory", position: { x: 300, y: 160 }, config: { namespace: "golden-mem", sessionIdTemplate: "{{session_id}}" } },
    { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: {} }
  ];
  const edges: Workflow["edges"] = [
    { id: "e1", source: "start", target: "agent" },
    { id: "e5", source: "agent", sourceHandle: "chat_model", target: "model" },
    { id: "e6", source: "agent", sourceHandle: "memory", target: "memory" }
  ];
  if (options.codeThrows) {
    nodes.push({ id: "check", type: "stop_and_error", name: "Check", position: { x: 300, y: 0 }, config: { message: "candidate broke" } });
    edges.push({ id: "e2", source: "agent", target: "check" }, { id: "e3", source: "check", target: "output" });
  } else {
    edges.push({ id: "e2", source: "agent", target: "output" });
  }
  return { id: "wf-agent", name: "Agent", schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", settings: { errorWorkflowId: "wf-error" }, nodes, edges } as Workflow;
}

async function saveGolden(context: TestContext, cookie: string, executionId: string, name = "Baseline"): Promise<ReplayRecordingSummary> {
  const response = await call(context, "POST", "/api/replay/recordings", cookie, { executionId, name });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ recording: ReplayRecordingSummary }>().recording;
}

async function replay(context: TestContext, cookie: string, recordingId: string, body: Record<string, unknown> = {}): Promise<ReplayRunResponse> {
  const response = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, cookie, body);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ReplayRunResponse>();
}

function rawRows(context: TestContext): string {
  const db = new Database(context.dbPath, { readonly: true });
  try {
    return JSON.stringify(db.prepare("SELECT * FROM replay_recordings").all());
  } finally {
    db.close();
  }
}

// ~2 s of fixed waits plus polling per test: CI's 2-core runners need more than vitest's 5 s default.
describe("golden runs with side effects stubbed", { timeout: 30_000 }, () => {
  it("saves a golden run and replays it without calling Slack, outbound HTTP or a live MCP server", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");
    const counter = await startCounter();
    const serverId = await registerServer(context, admin.cookie);
    await context.store.upsertWorkflow(errorWorkflow(counter.base));
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base }));

    const recorded = await call(context, "POST", "/api/workflows/wf-golden/execute", builder.cookie, { record: true });
    expect(recorded.statusCode).toBe(200);
    const recordedRun = recorded.json<{ status: string; executionId: string }>();
    expect(recordedRun.status).toBe("success");
    expect(counter.count("/slack")).toBe(1);
    expect(counter.count("/http")).toBe(1);

    // RBAC: viewers and operators read golden runs but cannot save or replay them.
    for (const cookie of [viewer.cookie, operator.cookie]) {
      expect((await call(context, "POST", "/api/replay/recordings", cookie, { executionId: recordedRun.executionId, name: "x" })).statusCode).toBe(403);
    }
    expect((await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: "missing", name: "x" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: recordedRun.executionId })).statusCode).toBe(400);

    const golden = await saveGolden(context, builder.cookie, recordedRun.executionId);
    expect(golden).toMatchObject({
      workflowId: "wf-golden",
      sourceExecutionId: recordedRun.executionId,
      sourceStatus: "success",
      truncated: false,
      capabilities: { mcp: "cassette", models: "tape", memory: "empty" }
    });

    const list = await call(context, "GET", "/api/replay/recordings?workflowId=wf-golden", viewer.cookie);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ total: number }>().total).toBe(1);
    const detail = await call(context, "GET", `/api/replay/recordings/${golden.id}`, viewer.cookie);
    expect(detail.statusCode).toBe(200);
    const recording = detail.json<{ recording: ReplayRecordingDetail }>().recording;
    expect(recording.mcpCallCount).toBeGreaterThanOrEqual(1);
    expect(recording.nodes.notify).toMatchObject({ nodeType: "slack_send_message", status: "success" });
    expect(JSON.stringify(recording)).not.toContain("capturedWorkflow");
    for (const cookie of [viewer.cookie, operator.cookie]) {
      expect((await call(context, "POST", `/api/replay/recordings/${golden.id}/replay`, cookie, {})).statusCode).toBe(403);
      expect((await call(context, "DELETE", `/api/replay/recordings/${golden.id}`, cookie)).statusCode).toBe(403);
    }

    // Runs page badge.
    const history = await call(context, "GET", "/api/executions?workflowId=wf-golden", viewer.cookie);
    const badged = history.json<{ items: Array<{ id: string; goldenRuns?: { count: number; latestId: string } }> }>().items.filter((item) => item.goldenRuns);
    expect(badged).toEqual([expect.objectContaining({ id: recordedRun.executionId, goldenRuns: { count: 1, latestId: golden.id } })]);

    // Replay of the unchanged draft: pass, and nothing external happened.
    await sleep(1100);
    const same = await replay(context, builder.cookie, golden.id);
    expect(same.verdict, JSON.stringify(same.reasons)).toBe("pass");
    expect(same.candidate.kind).toBe("draft");
    expect(same.diff.output.equal).toBe(true);
    expect(same.diff.toolCalls.steps.every((step) => step.kind === "matched")).toBe(true);
    // Identifiers survive scrubbing; only secret values and arguments are scrubbed.
    expect(same.facts.toolCalls[0]).toMatchObject({ server: serverId, tool: "get_current_time", nodeId: "tool" });
    expect(same.diff.health.filter((entry) => entry.blocking)).toEqual([]);
    expect(counter.count("/slack")).toBe(1);
    expect(counter.count("/http")).toBe(1);
    const replayed = await context.store.getExecutionHistory(same.executionId);
    expect(replayed).toMatchObject({ triggerType: "replay", workflowId: "wf-golden" });
    expect(replayed!.customData).toMatchObject({ replay: { recordingId: golden.id, sourceExecutionId: recordedRun.executionId } });
    // A replay is not a golden run source.
    expect((await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: same.executionId, name: "x" })).statusCode).toBe(409);
    // Replays stay out of MCP tool-call telemetry.
    expect(await context.store.listMcpToolCallsForExecution(same.executionId)).toEqual([]);
    expect((await context.store.listMcpToolCallsForExecution(recordedRun.executionId)).length).toBeGreaterThan(0);

    // Determinism: replaying again gives the same verdict and facts.
    const again = await replay(context, builder.cookie, golden.id);
    expect(again.verdict).toBe("pass");
    expect(again.facts.output).toEqual(same.facts.output);

    // A changed answer fails with an output diff, still with no side effects.
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, answer: "v2" }));
    const changed = await replay(context, builder.cookie, golden.id, { draft: true });
    expect(changed.verdict).toBe("fail");
    expect(changed.diff.output.equal).toBe(false);
    expect(JSON.stringify(changed.diff.output.changes)).toContain("v2");
    expect(counter.count("/slack")).toBe(1);
    expect(counter.count("/http")).toBe(1);

    // Changed tool arguments have no recorded answer in either mode (lenient only reuses answers for repeated calls). Never live.
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, tz: "Asia/Tokyo" }));
    const strict = await replay(context, builder.cookie, golden.id, { mcpMode: "strict" });
    expect(strict.verdict).toBe("error");
    expect(strict.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "mcp_unmatched", blocking: true })]));
    const lenient = await replay(context, builder.cookie, golden.id, { mcpMode: "lenient" });
    expect(lenient.verdict).toBe("error");
    expect(lenient.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "mcp_unmatched", blocking: true })]));
    expect(counter.count("/slack")).toBe(1);

    // A code node is answered from the recording: a candidate script that escapes the JavaScript sandbox never runs,
    // and since its code changed, the replay says it could not judge it instead of passing on the old output.
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, escape: true }));
    const escaped = await replay(context, builder.cookie, golden.id);
    expect(escaped.verdict, JSON.stringify(escaped.reasons)).toBe("error");
    expect(escaped.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "config_changed", nodeId: "shape", blocking: true })]));
    expect(escaped.reasons.join(" ")).toContain("code changed since the golden run; code nodes are not executed in replay");
    await sleep(200);
    expect(counter.count("/code")).toBe(0);

    // A broken candidate: the run fails, the error workflow and its notifications are not fired.
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, broken: true }));
    const broken = await replay(context, builder.cookie, golden.id);
    expect(broken.status).toBe("error");
    expect(broken.verdict).toBe("fail");
    await sleep(300);
    expect(counter.count("/error")).toBe(0);
    expect((await context.store.listExecutionHistory({ workflowId: "wf-error", page: 1, pageSize: 10 })).total).toBe(0);
    // The same candidate run for real does fire it, so the check above is meaningful.
    await call(context, "POST", "/api/workflows/wf-golden/execute", builder.cookie, {});
    for (let attempt = 0; attempt < 40 && counter.count("/error") === 0; attempt += 1) await sleep(50);
    expect(counter.count("/error")).toBe(1);

    // Bad requests and unknown versions.
    expect((await call(context, "POST", `/api/replay/recordings/${golden.id}/replay`, builder.cookie, { draft: true, version: 1 })).statusCode).toBe(400);
    expect((await call(context, "POST", `/api/replay/recordings/${golden.id}/replay`, builder.cookie, { version: 999 })).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/replay/recordings/nope/replay`, builder.cookie, {})).statusCode).toBe(404);

    // The escaping script cannot reach the network even in a real run: the JavaScript sandbox blocks the escape.
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, escape: true }));
    const real = await call(context, "POST", "/api/workflows/wf-golden/execute", builder.cookie, {});
    expect(real.statusCode).toBe(200);
    await sleep(200);
    expect(counter.count("/code")).toBe(0);
  });

  it("keeps golden runs when execution history and cassettes are pruned, and deletes them with their workflow", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const serverId = await registerServer(context, admin.cookie);
    await context.store.upsertWorkflow(errorWorkflow(counter.base));
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base }));
    const run = (await call(context, "POST", "/api/workflows/wf-golden/execute", builder.cookie, { record: true })).json<{ executionId: string }>();
    const golden = await saveGolden(context, builder.cookie, run.executionId);

    await context.store.pruneExecutionHistory({ before: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await context.store.getExecutionHistory(run.executionId)).toBeNull();
    expect(await context.store.getMcpCassetteForExecution(run.executionId)).toBeNull();

    const kept = await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie);
    expect(kept.statusCode).toBe(200);
    const result = await replay(context, builder.cookie, golden.id);
    expect(result.verdict, JSON.stringify(result.reasons)).toBe("pass");
    expect(counter.count("/slack")).toBe(1);

    // A saved version as the candidate: the draft moves on, version 7 still matches the golden run.
    await context.store.writeWorkflowVersion({ id: "ver-7", workflowId: "wf-golden", version: 7, workflowJson: JSON.stringify(sideEffectWorkflow({ serverId, base: counter.base })) });
    await context.store.upsertWorkflow(sideEffectWorkflow({ serverId, base: counter.base, answer: "draft" }));
    const versioned = await replay(context, builder.cookie, golden.id, { version: 7 });
    expect(versioned.candidate).toMatchObject({ kind: "version", version: 7 });
    expect(versioned.verdict, JSON.stringify(versioned.reasons)).toBe("pass");
    expect((await replay(context, builder.cookie, golden.id, { draft: true })).verdict).toBe("fail");

    expect((await call(context, "DELETE", `/api/replay/recordings/${golden.id}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie)).statusCode).toBe(404);

    const second = (await call(context, "POST", "/api/workflows/wf-golden/execute", builder.cookie, { record: true })).json<{ executionId: string }>();
    const another = await saveGolden(context, builder.cookie, second.executionId);
    expect((await call(context, "DELETE", "/api/workflows/wf-golden", admin.cookie)).statusCode).toBeLessThan(300);
    expect(await context.store.getReplayRecording(another.id)).toBeNull();
  });

  it("replays a saved version under the workflow's current project, not the project it was saved in", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await context.store.upsertProject({ id: "proj-a", name: "Project A" });
    await context.store.upsertProject({ id: "proj-b", name: "Project B" });
    await context.store.upsertVariable({ id: "var-a", projectId: "proj-a", key: "GREETING", value: "from A" });
    await context.store.upsertVariable({ id: "var-b", projectId: "proj-b", key: "GREETING", value: "from B" });
    const moved = (projectId: string): Workflow =>
      ({
        id: "wf-moved",
        name: "Moved",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId,
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "output", type: "output", name: "Output", position: { x: 150, y: 0 }, config: { responseTemplate: "{{vars.GREETING}}" } }
        ],
        edges: [{ id: "e1", source: "start", target: "output" }]
      }) as Workflow;
    // Version 3 was saved while the workflow lived in project A; it has since moved to project B.
    await context.store.writeWorkflowVersion({ id: "ver-3", workflowId: "wf-moved", version: 3, workflowJson: JSON.stringify(moved("proj-a")) });
    await context.store.upsertWorkflow(moved("proj-b"));
    const run = (await call(context, "POST", "/api/workflows/wf-moved/execute", builder.cookie, {})).json<{ executionId: string; output: unknown }>();
    expect(JSON.stringify(run.output)).toContain("from B");
    const golden = await saveGolden(context, builder.cookie, run.executionId);

    const versioned = await replay(context, builder.cookie, golden.id, { version: 3 });
    expect(versioned.candidate).toMatchObject({ kind: "version", version: 3 });
    expect(JSON.stringify(versioned.facts.output)).not.toContain("from A");
    expect(versioned.verdict, JSON.stringify(versioned.reasons)).toBe("pass");
    expect(await context.store.getExecutionHistory(versioned.executionId)).toMatchObject({ workflowId: "wf-moved" });
  });

  it("scrubs secrets from the stored golden run and keeps session memory untouched in a replay", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const model = await startEchoModel("Hello");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: PLANTED });
    await context.store.upsertWorkflow(errorWorkflow(counter.base));
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));

    const run = await call(context, "POST", "/api/workflows/wf-agent/execute", builder.cookie, { session_id: "sess-1" });
    expect(run.json<{ status: string }>().status).toBe("success");
    // The model leaked the key into its answer; the stored execution is what golden runs copy from.
    const memoryBefore = await context.store.loadSessionMemory(projectSessionNamespace("default", "golden-mem"), "sess-1");
    expect(memoryBefore.length).toBeGreaterThan(0);

    const golden = await saveGolden(context, builder.cookie, run.json<{ executionId: string }>().executionId);
    const raw = rawRows(context);
    expect(raw).toContain(golden.id);
    expect(raw).not.toContain(PLANTED);
    expect(raw).not.toContain(Buffer.from(PLANTED).toString("base64"));
    expect(raw).toContain("[REDACTED]");
    const detail = (await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie)).body;
    expect(detail).not.toContain(PLANTED);

    const callsBefore = model.calls();
    const result = await replay(context, builder.cookie, golden.id);
    // Models are live in a replay; the recorded memory is not loaded, and nothing is written back.
    expect(model.calls()).toBeGreaterThan(callsBefore);
    expect(result.verdict, JSON.stringify(result.reasons)).toBe("pass");
    expect(JSON.stringify(result)).not.toContain(PLANTED);
    expect(await context.store.loadSessionMemory(projectSessionNamespace("default", "golden-mem"), "sess-1")).toEqual(memoryBefore);

    // Failing candidate: no error workflow.
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId, { codeThrows: true }));
    const broken = await replay(context, builder.cookie, golden.id);
    expect(broken.status).toBe("error");
    await sleep(300);
    expect(counter.count("/error")).toBe(0);
    expect(await context.store.loadSessionMemory(projectSessionNamespace("default", "golden-mem"), "sess-1")).toEqual(memoryBefore);
  });

  it("records a replay's model spend but never sends a budget alert from it", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const model = await startEchoModel("Hello");
    const secret = await context.secretService.createSecret({ name: "Model key", provider: "openai", value: PLANTED });
    await context.store.upsertWorkflow(errorWorkflow(counter.base));
    await context.store.upsertWorkflow(agentWorkflow(model.baseUrl, secret.secretId));
    const run = (await call(context, "POST", "/api/workflows/wf-agent/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);

    // A one-token budget: any spend crosses it and would post to the budget's channel.
    await context.store.createBudget({ id: "bud-1", name: "Tiny", scopeType: "workflow", scopeId: "wf-agent", period: "day", limitType: "tokens", limitValue: 1, action: "warn", notifyChannel: `${counter.base}/budget` });
    const result = await replay(context, builder.cookie, golden.id);
    expect(result.verdict, JSON.stringify(result.reasons)).toBe("pass");
    await sleep(300);
    expect(counter.count("/budget")).toBe(0);

    // A live run of the same workflow does alert, so the check above is meaningful.
    await call(context, "POST", "/api/workflows/wf-agent/execute", builder.cookie, {});
    for (let attempt = 0; attempt < 40 && counter.count("/budget") === 0; attempt += 1) await sleep(50);
    expect(counter.count("/budget")).toBe(1);
  });

  it("never lets a chart load its data URL in a replay, and calls that replay inconclusive", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const chartWorkflow = (url: string | null) =>
      ({
        id: "wf-chart",
        name: "Chart",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          {
            id: "chart",
            type: "chart",
            name: "Chart",
            position: { x: 150, y: 0 },
            config: { spec: { mark: "bar", data: url ? { url } : { values: [{ a: "x", b: 1 }] }, encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } } }
          },
          { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "charted" } }
        ],
        edges: [
          { id: "e1", source: "start", target: "chart" },
          { id: "e2", source: "chart", target: "output" }
        ]
      }) as Workflow;
    await context.store.upsertWorkflow(chartWorkflow(null));
    const run = (await call(context, "POST", "/api/workflows/wf-chart/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);
    expect((await replay(context, builder.cookie, golden.id)).verdict).toBe("pass");

    await context.store.upsertWorkflow(chartWorkflow(`${counter.base}/chart-data?secret=abc`));
    const result = await replay(context, builder.cookie, golden.id);
    expect(counter.count("/chart-data")).toBe(0);
    expect(result.verdict).toBe("error");
    expect(result.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "blocked_load", nodeId: "chart", blocking: true })]));
  });

  it("refuses to save the same run twice and caps the bytes one workflow's golden runs may use", async () => {
    const context = await createTestContext({ REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW: "65536" });
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow({
      id: "wf-sized",
      name: "Sized",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "set", type: "set_node", name: "Set", position: { x: 150, y: 0 }, config: { assignments: [{ key: "blob", valueTemplate: "word ".repeat(4000) }] } },
        { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "done" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "set" },
        { id: "e2", source: "set", target: "output" }
      ]
    } as Workflow);
    const execute = async () => (await call(context, "POST", "/api/workflows/wf-sized/execute", builder.cookie, {})).json<{ executionId: string }>().executionId;

    const first = await execute();
    const golden = await saveGolden(context, builder.cookie, first);
    expect(golden.bytes).toBeGreaterThan(20_000);
    const again = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: first, name: "Again" });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string; code: string }>()).toMatchObject({ code: "duplicate" });
    expect(again.json<{ error: string }>().error).toContain(golden.id);

    let refused: { statusCode: number; body: string } | null = null;
    for (let attempt = 0; attempt < 6 && !refused; attempt += 1) {
      const response = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: await execute(), name: `Run ${attempt}` });
      if (response.statusCode !== 201) refused = response;
    }
    expect(refused?.statusCode).toBe(409);
    expect(refused?.body).toContain("REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW");
    const saved = (await context.store.listReplayRecordings({ workflowId: "wf-sized" })).items;
    expect(saved.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(65536);
  });

  it("caps the bytes all golden runs in the deployment may use", async () => {
    const context = await createTestContext({ REPLAY_RECORDINGS_MAX_TOTAL_BYTES: "65536" });
    const builder = await login(context, "builder");
    const sized = (id: string): Workflow =>
      ({
        id,
        name: id,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "set", type: "set_node", name: "Set", position: { x: 150, y: 0 }, config: { assignments: [{ key: "blob", valueTemplate: "word ".repeat(4000) }] } },
          { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "done" } }
        ],
        edges: [
          { id: "e1", source: "start", target: "set" },
          { id: "e2", source: "set", target: "output" }
        ]
      }) as Workflow;
    let refused: { statusCode: number; body: string } | null = null;
    // A new workflow each time: only the deployment-wide cap can stop this.
    for (let attempt = 0; attempt < 6 && !refused; attempt += 1) {
      await context.store.upsertWorkflow(sized(`wf-total-${attempt}`));
      const executionId = (await call(context, "POST", `/api/workflows/wf-total-${attempt}/execute`, builder.cookie, {})).json<{ executionId: string }>().executionId;
      const response = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId, name: `Run ${attempt}` });
      if (response.statusCode !== 201) refused = response;
    }
    expect(refused?.statusCode).toBe(409);
    expect(refused?.body).toContain("REPLAY_RECORDINGS_MAX_TOTAL_BYTES");
    expect(await context.store.sumReplayRecordingBytes()).toBeLessThanOrEqual(65536);
  });

  it("refuses an oversized run or a spent budget before scrubbing it", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384", REPLAY_RECORDINGS_MAX_TOTAL_BYTES: "16384" });
    const builder = await login(context, "builder");
    const workflow = (id: string, template: string): Workflow =>
      ({
        id,
        name: id,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "output", type: "output", name: "Output", position: { x: 150, y: 0 }, config: { responseTemplate: template } }
        ],
        edges: [{ id: "e1", source: "start", target: "output" }]
      }) as Workflow;
    const scrub = vi.spyOn(ReplayRecordingService.prototype, "scrubValue");

    // The run's own output cannot be cut, and it is far over the per-run limit.
    await context.store.upsertWorkflow(workflow("wf-huge", "word ".repeat(20_000)));
    const huge = (await call(context, "POST", "/api/workflows/wf-huge/execute", builder.cookie, {})).json<{ executionId: string }>().executionId;
    scrub.mockClear();
    const tooLarge = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: huge, name: "Huge" });
    expect(tooLarge.statusCode).toBe(413);
    expect(scrub).not.toHaveBeenCalled();

    // A deployment whose golden runs nearly fill the budget refuses the next save without scrubbing anything.
    await context.store.upsertWorkflow(workflow("wf-small", "word ".repeat(600)));
    const small = (await call(context, "POST", "/api/workflows/wf-small/execute", builder.cookie, {})).json<{ executionId: string }>().executionId;
    vi.spyOn(context.store, "sumReplayRecordingBytes").mockResolvedValue(16384 - 500);
    scrub.mockClear();
    const spent = await call(context, "POST", "/api/replay/recordings", builder.cookie, { executionId: small, name: "Small" });
    expect(spent.statusCode).toBe(409);
    expect(spent.body).toContain("REPLAY_RECORDINGS_MAX_TOTAL_BYTES");
    expect(scrub).not.toHaveBeenCalled();
  });

  it("warns when scrubbing changed a recorded value the replay feeds to the candidate", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const cursor = "f".repeat(64);
    const scrubbedWorkflow = (template: string): Workflow =>
      ({
        id: "wf-scrub",
        name: "Scrub",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "page", type: "code_node", name: "Page", position: { x: 150, y: 0 }, config: { code: `return { token: "next-page-7", cursor: "${cursor}", count: 3 };` } },
          { id: "plain", type: "code_node", name: "Plain", position: { x: 300, y: 0 }, config: { code: "return { ok: true };" } },
          { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: { responseTemplate: template } }
        ],
        edges: [
          { id: "e1", source: "start", target: "page" },
          { id: "e2", source: "page", target: "plain" },
          { id: "e3", source: "plain", target: "output" }
        ]
      }) as Workflow;
    await context.store.upsertWorkflow(scrubbedWorkflow("{{results.page.count}} items"));
    const run = (await call(context, "POST", "/api/workflows/wf-scrub/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);
    expect(golden.capabilities.scrubbed).toEqual({ input: false, output: false, nodes: ["page"] });
    const detail = (await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    expect(JSON.stringify(detail.nodes.page!.output)).not.toContain(cursor);

    const result = await replay(context, builder.cookie, golden.id);
    expect(result.verdict, JSON.stringify(result.reasons)).toBe("pass");
    const warnings = result.diff.health.filter((warning) => warning.kind === "scrubbed_recording");
    expect(warnings).toEqual([expect.objectContaining({ nodeId: "page", blocking: false })]);
    expect(warnings[0]!.message).toContain("[REDACTED]");
  });

  it("calls a replay inconclusive when it reaches a side effect or code node the golden run never saw", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const branchWorkflow = (extra: "none" | "write" | "code"): Workflow => {
      const nodes: Workflow["nodes"] = [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "label", type: "set_node", name: "Label", position: { x: 150, y: 0 }, config: { assignments: [{ key: "answer", valueTemplate: "v1" }] } },
        { id: "output", type: "output", name: "Output", position: { x: 300, y: 0 }, config: { responseTemplate: "{{results.label.answer}}" } }
      ] as Workflow["nodes"];
      const edges: Workflow["edges"] = [
        { id: "e1", source: "start", target: "label" },
        { id: "e2", source: "label", target: "output" }
      ];
      if (extra === "write") {
        nodes.push({ id: "side", type: "http_request", name: "Side", position: { x: 150, y: 150 }, config: { method: "POST", urlTemplate: `${counter.base}/side`, retry: { enabled: false } } } as Workflow["nodes"][number]);
        edges.push({ id: "e3", source: "start", target: "side" });
      } else if (extra === "code") {
        nodes.push({ id: "side", type: "code_node", name: "Side", position: { x: 150, y: 150 }, config: { code: "return { ran: true };" } } as Workflow["nodes"][number]);
        edges.push({ id: "e3", source: "start", target: "side" });
      }
      return { id: "wf-branch", name: "Branch", schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes, edges } as Workflow;
    };
    await context.store.upsertWorkflow(branchWorkflow("none"));
    const run = (await call(context, "POST", "/api/workflows/wf-branch/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);
    expect((await replay(context, builder.cookie, golden.id)).verdict).toBe("pass");

    for (const extra of ["write", "code"] as const) {
      await context.store.upsertWorkflow(branchWorkflow(extra));
      const result = await replay(context, builder.cookie, golden.id);
      // The output is unchanged, so this used to pass while the new node went untested.
      expect(result.diff.output.equal).toBe(true);
      expect(result.verdict, extra).toBe("error");
      expect(result.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "unrecorded_stub", nodeId: "side", blocking: true })]));
    }
    expect(counter.count("/side")).toBe(0);
  });

  it("replays a code node in a loop iteration by iteration, and calls a changed one inconclusive", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const loopWorkflow = (code: string): Workflow =>
      ({
        id: "wf-loop",
        name: "Loop",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "items", type: "code_node", name: "Items", position: { x: 150, y: 0 }, config: { code: "return { list: ['a', 'b', 'c'] };" } },
          { id: "loop", type: "loop_node", name: "Loop", position: { x: 300, y: 0 }, config: { inputKey: "list", itemVariable: "item" } },
          { id: "shout", type: "code_node", name: "Shout", position: { x: 450, y: 0 }, config: { code } },
          { id: "output", type: "output", name: "Output", position: { x: 600, y: 0 }, config: { responseTemplate: "{{results.loop}}" } }
        ],
        edges: [
          { id: "e1", source: "start", target: "items" },
          { id: "e2", source: "items", target: "loop" },
          { id: "e3", source: "loop", target: "shout" },
          { id: "e4", source: "shout", target: "output" }
        ]
      }) as Workflow;
    await context.store.upsertWorkflow(loopWorkflow("return { up: String(input.item).toUpperCase() };"));
    const run = (await call(context, "POST", "/api/workflows/wf-loop/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status, JSON.stringify(run)).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);
    const detail = (await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    expect(detail.nodes.shout!.runs?.map((entry) => (entry.output as { up?: string }).up)).toEqual(["A", "B", "C"]);

    const same = await replay(context, builder.cookie, golden.id);
    expect(same.verdict, JSON.stringify(same.reasons)).toBe("pass");
    const replayed = (await context.store.getExecutionHistory(same.executionId))!;
    const shoutOutputs = (replayed.nodeResults as Array<{ nodeId: string; output?: unknown }>).filter((entry) => entry.nodeId === "shout").map((entry) => (entry.output as { up?: string }).up);
    expect(shoutOutputs).toEqual(["A", "B", "C"]);

    await context.store.upsertWorkflow(loopWorkflow("return { up: String(input.item).toLowerCase() };"));
    const changed = await replay(context, builder.cookie, golden.id);
    expect(changed.verdict).toBe("error");
    expect(changed.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "config_changed", nodeId: "shout", blocking: true })]));
  });

  it("calls a replay inconclusive when a stubbed write node is called more often than recorded", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const counter = await startCounter();
    const loopWorkflow = (list: string[]): Workflow =>
      ({
        id: "wf-loop-write",
        name: "Loop write",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "default",
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
          { id: "items", type: "set_node", name: "Items", position: { x: 150, y: 0 }, config: { assignments: [{ key: "list", valueTemplate: JSON.stringify(list) }] } },
          { id: "loop", type: "loop_node", name: "Loop", position: { x: 300, y: 0 }, config: { inputKey: "list", itemVariable: "item" } },
          { id: "post", type: "http_request", name: "Post", position: { x: 450, y: 0 }, config: { method: "POST", urlTemplate: `${counter.base}/post`, retry: { enabled: false } } },
          { id: "output", type: "output", name: "Output", position: { x: 600, y: 0 }, config: { responseTemplate: "done" } }
        ],
        edges: [
          { id: "e1", source: "start", target: "items" },
          { id: "e2", source: "items", target: "loop" },
          { id: "e3", source: "loop", target: "post" },
          { id: "e4", source: "post", target: "output" }
        ]
      }) as Workflow;
    await context.store.upsertWorkflow(loopWorkflow(["a", "b"]));
    const run = (await call(context, "POST", "/api/workflows/wf-loop-write/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status, JSON.stringify(run)).toBe("success");
    expect(counter.count("/post")).toBe(2);
    const golden = await saveGolden(context, builder.cookie, run.executionId);

    const same = await replay(context, builder.cookie, golden.id);
    expect(same.verdict, JSON.stringify(same.reasons)).toBe("pass");
    await context.store.upsertWorkflow(loopWorkflow(["a"]));
    expect((await replay(context, builder.cookie, golden.id)).diff.health.some((warning) => warning.kind === "recording_overrun")).toBe(false);

    await context.store.upsertWorkflow(loopWorkflow(["a", "b", "c"]));
    const over = await replay(context, builder.cookie, golden.id);
    expect(over.verdict).toBe("error");
    expect(over.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "recording_overrun", nodeId: "post", blocking: true })]));
    expect(over.diff.health.find((warning) => warning.kind === "recording_overrun")!.message).toContain("post");
    expect(counter.count("/post")).toBe(2);
  });

  it("truncates the largest node outputs to fit REPLAY_RECORDING_MAX_BYTES", async () => {
    const context = await createTestContext({ REPLAY_RECORDING_MAX_BYTES: "16384" });
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow({
      id: "wf-big",
      name: "Big",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "big", type: "code_node", name: "Big", position: { x: 150, y: 0 }, config: { code: "return { blob: 'x'.repeat(40000) };" } },
        { id: "small", type: "code_node", name: "Small", position: { x: 300, y: 0 }, config: { code: "return { ok: true };" } },
        { id: "output", type: "output", name: "Output", position: { x: 450, y: 0 }, config: { responseTemplate: "done" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "big" },
        { id: "e2", source: "big", target: "small" },
        { id: "e3", source: "small", target: "output" }
      ]
    } as Workflow);
    const run = (await call(context, "POST", "/api/workflows/wf-big/execute", builder.cookie, {})).json<{ executionId: string; status: string }>();
    expect(run.status).toBe("success");
    const golden = await saveGolden(context, builder.cookie, run.executionId);
    expect(golden.truncated).toBe(true);
    expect(golden.bytes).toBeLessThanOrEqual(16384);
    const detail = (await call(context, "GET", `/api/replay/recordings/${golden.id}`, builder.cookie)).json<{ recording: ReplayRecordingDetail }>().recording;
    expect(detail.nodes.big!.output).toMatchObject({ _replayTruncated: true });
    expect(detail.nodes.small!.output).toMatchObject({ ok: true });

    // Replaying a cut output proves nothing either way: the verdict is inconclusive, not fail.
    const result = await replay(context, builder.cookie, golden.id);
    expect(result.verdict).toBe("error");
    expect(result.diff.health).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "truncated_recording", nodeId: "big", blocking: true })]));
  });
});

describe("migration 30", () => {
  it("adds replay_recordings in Postgres DDL with a down path", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    // Contiguous from 1. v31 is reserved for a feature branch that may not have landed yet.
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    expect(Math.max(...versions)).toBeGreaterThanOrEqual(30);
    const migration = MIGRATIONS.find((entry) => entry.version === 30)!;
    expect(migration.description).toContain("15.1");
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS replay_recordings");
    expect(migration.down).toContain("DROP TABLE IF EXISTS replay_recordings");
    for (const fragment of ["source_execution_id TEXT,", "captured_workflow_json TEXT NOT NULL", "mcp_cassette_json TEXT", "created_at TIMESTAMPTZ NOT NULL", "idx_replay_recordings_workflow"]) {
      expect(migration.up).toContain(fragment);
    }
  });

  it("creates the same table in SQLite", async () => {
    const context = await createTestContext();
    const db = new Database(context.dbPath, { readonly: true });
    try {
      const columns = (db.prepare("PRAGMA table_info(replay_recordings)").all() as Array<{ name: string }>).map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["id", "workflow_id", "project_id", "source_execution_id", "captured_workflow_json", "node_outputs_json", "facts_json", "mcp_cassette_json", "capabilities_json", "truncated", "created_at"]));
    } finally {
      db.close();
    }
  });
});
