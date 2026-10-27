/**
 * Phase 10.8 — MCP testing and reliability over the API: recording a manual
 * run into a cassette, the cassette routes and their RBAC, replaying an
 * execution (strict and lenient), eval runs recorded and replayed against
 * cassettes, snapshot export, the snapshot mock adapter, the CI check
 * endpoint, and migration 26.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpCassette, McpCassetteRecord, McpCassetteSummary, McpCheckReport, McpReplayReport, McpSnapshotFile, Workflow } from "@ai-orchestrator/shared";
import { hashToolSnapshot } from "@ai-orchestrator/mcp-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { acceptedSnapshotFor } from "./services/mcp-cassette-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-testing-"));
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function registerServer(context: TestContext, adminCookie: string, body: Record<string, unknown> = {}): Promise<string> {
  const created = await call(context, "POST", "/api/mcp/servers", adminCookie, { name: "Mock", adapterId: "mock-mcp", probeEnabled: false, ...body });
  expect(created.statusCode).toBe(201);
  const id = created.json<{ server: { id: string } }>().server.id;
  const probe = await call(context, "POST", `/api/mcp/servers/${id}/probe`, adminCookie);
  expect(probe.statusCode).toBe(200);
  return id;
}

/** Webhook → MCP Tool node calling `toolName` → output. */
function toolWorkflow(id: string, registryServerId: string, toolName: string, argsTemplate: string, createdBy?: string): Workflow {
  return {
    id,
    name: `Tool ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "tool", type: "mcp_tool", name: "Tool", position: { x: 200, y: 0 }, config: { registryServerId, toolName, argsTemplate, retry: { enabled: false } } },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: { responseTemplate: "{{results.tool.tool_output}}" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "tool" },
      { id: "e2", source: "tool", target: "output" }
    ],
    ...(createdBy ? { createdBy } : {})
  } as Workflow;
}

type RunResult = {
  status: string;
  executionId?: string;
  error?: string;
  nodeResults: Array<{ nodeId: string; output?: Record<string, unknown> }>;
  mcpCassette?: McpCassetteSummary;
  mcpReplay?: McpReplayReport;
};

const toolOutput = (result: RunResult) => result.nodeResults.find((entry) => entry.nodeId === "tool")?.output?.tool_output;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("migration 26", () => {
  it("adds the cassette table with indexes and a rollback", () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 26);
    expect(migration?.description).toContain("10.8");
    expect(migration!.up).toContain("CREATE TABLE IF NOT EXISTS mcp_cassettes");
    for (const column of ["execution_id", "workflow_id", "project_id", "eval_run_id", "fixture_id", "call_count", "truncated", "cassette_json", "created_at TIMESTAMPTZ"]) {
      expect(migration!.up).toContain(column);
    }
    expect(migration!.up).toContain("idx_mcp_cassettes_execution");
    expect(migration!.down).toContain("DROP TABLE IF EXISTS mcp_cassettes");
    expect(Math.max(...MIGRATIONS.map((entry) => entry.version))).toBeGreaterThanOrEqual(26);
  });
});

describe("record and replay of a manual run", () => {
  it("records a cassette, shows a badge, replays with identical output and enforces RBAC", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");
    const secret = await context.secretService.createSecret({ name: "mock-key", provider: "custom", value: "tok-SUPERSECRET-0042" });
    const serverId = await registerServer(context, admin.cookie, { secretRef: secret });
    await context.store.upsertWorkflow(toolWorkflow("wf-clock", serverId, "get_current_time", '{"tz":"UTC"}'));
    await context.store.upsertWorkflow(toolWorkflow("wf-kb", serverId, "lookup_kb", '{"topic":"tok-SUPERSECRET-0042"}'));

    const recorded = await call(context, "POST", "/api/workflows/wf-clock/execute", builder.cookie, { record: true });
    expect(recorded.statusCode).toBe(200);
    const recordedRun = recorded.json<RunResult>();
    expect(recordedRun.status).toBe("success");
    expect(recordedRun.mcpCassette).toMatchObject({ source: "manual", workflowId: "wf-clock", projectId: "default", truncated: false });
    expect(recordedRun.mcpCassette!.callCount).toBeGreaterThanOrEqual(1);
    const cassetteId = recordedRun.mcpCassette!.id;

    const plain = await call(context, "POST", "/api/workflows/wf-clock/execute", builder.cookie, {});
    expect(plain.json<RunResult>().mcpCassette).toBeUndefined();

    // Runs page badge.
    const history = await call(context, "GET", "/api/executions?workflowId=wf-clock", viewer.cookie);
    const items = history.json<{ items: Array<{ id: string; mcpCassette?: { id: string; callCount: number } }> }>().items;
    const badged = items.filter((item) => item.mcpCassette);
    expect(badged).toHaveLength(1);
    expect(badged[0].mcpCassette).toEqual({ id: cassetteId, callCount: recordedRun.mcpCassette!.callCount, truncated: false });
    const executionId = badged[0].id;

    // Cassette routes: builder reads, viewer and operator do not.
    for (const cookie of [viewer.cookie, operator.cookie]) {
      expect((await call(context, "GET", "/api/mcp/cassettes", cookie)).statusCode).toBe(403);
      expect((await call(context, "GET", `/api/mcp/cassettes/${cassetteId}`, cookie)).statusCode).toBe(403);
    }
    const list = await call(context, "GET", "/api/mcp/cassettes?workflowId=wf-clock", builder.cookie);
    expect(list.json<{ total: number; items: McpCassetteSummary[] }>()).toMatchObject({ total: 1, items: [{ id: cassetteId, executionId }] });
    const detail = await call(context, "GET", `/api/mcp/cassettes/${cassetteId}`, builder.cookie);
    const record = detail.json<{ cassette: McpCassetteRecord }>().cassette;
    expect(record.cassette.servers).toEqual([
      expect.objectContaining({ key: `registry:${serverId}`, adapterId: "mock-mcp", registryServerId: serverId, snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    ]);
    expect(record.cassette.entries.find((entry) => entry.method === "tools/call")).toMatchObject({ name: "get_current_time", args: { tz: "UTC" } });
    const exported = await call(context, "GET", `/api/mcp/cassettes/${cassetteId}/export`, builder.cookie);
    expect(exported.headers["content-disposition"]).toContain(`${cassetteId}.json`);
    expect(exported.json<McpCassette>().format).toBe("l2m.mcp-cassette");
    expect((await call(context, "GET", "/api/mcp/cassettes/nope", builder.cookie)).statusCode).toBe(404);

    // Replay: same output even though the clock moved, no live call needed.
    await sleep(1100);
    expect((await call(context, "POST", `/api/executions/${executionId}/replay`, viewer.cookie, {})).statusCode).toBe(403);
    const replay = await call(context, "POST", `/api/executions/${executionId}/replay`, builder.cookie, {});
    expect(replay.statusCode).toBe(200);
    const replayRun = replay.json<RunResult>();
    expect(replayRun.status).toBe("success");
    expect(toolOutput(replayRun)).toEqual(toolOutput(recordedRun));
    expect(replayRun.mcpReplay).toMatchObject({ cassetteId, mode: "strict", live: 0, unmatched: [] });
    const replayed = await context.store.getExecutionHistory(replayRun.executionId!);
    expect(replayed).toMatchObject({ triggerType: "mcp_replay", status: "success" });
    expect(replayed!.customData).toMatchObject({ mcpReplay: { sourceExecutionId: executionId, cassetteId, mode: "strict" } });

    // The workflow changed: strict replay fails clearly, lenient falls through to the live server.
    await context.store.upsertWorkflow(toolWorkflow("wf-clock", serverId, "get_current_time", '{"tz":"Asia/Tokyo"}'));
    const strict = await call(context, "POST", `/api/executions/${executionId}/replay`, builder.cookie, { mode: "strict" });
    const strictRun = strict.json<RunResult>();
    expect(strictRun.status).toBe("error");
    expect(JSON.stringify(strictRun)).toContain("Cassette replay (strict)");
    expect(strictRun.mcpReplay!.unmatched[0]).toMatchObject({ method: "tools/call", name: "get_current_time" });
    const lenient = await call(context, "POST", `/api/executions/${executionId}/replay`, builder.cookie, { mode: "lenient" });
    const lenientRun = lenient.json<RunResult>();
    expect(lenientRun.status).toBe("success");
    expect(lenientRun.mcpReplay).toMatchObject({ mode: "lenient", live: 1 });
    expect((toolOutput(lenientRun) as { timezone: string }).timezone).toBe("Asia/Tokyo");

    // Secrets never reach a cassette, even when a tool argument carries one.
    const kb = (await call(context, "POST", "/api/workflows/wf-kb/execute", builder.cookie, { record: true })).json<RunResult>();
    const kbCassette = (await call(context, "GET", `/api/mcp/cassettes/${kb.mcpCassette!.id}`, builder.cookie)).body;
    expect(kbCassette).not.toContain("SUPERSECRET");
    expect(kbCassette).toContain("[REDACTED]");

    // A run without a cassette cannot be replayed; admins delete cassettes, builders do not.
    const plainId = items.find((item) => !item.mcpCassette)!.id;
    expect((await call(context, "POST", `/api/executions/${plainId}/replay`, builder.cookie, {})).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/executions/${executionId}/replay`, builder.cookie, { mode: "loose" })).statusCode).toBe(400);
    expect((await call(context, "DELETE", `/api/mcp/cassettes/${cassetteId}`, builder.cookie)).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/mcp/cassettes/${cassetteId}`, admin.cookie)).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/mcp/cassettes/${cassetteId}`, admin.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", `/api/executions/${executionId}/replay`, builder.cookie, {})).statusCode).toBe(404);
  }, 30_000);

  it("marks a cassette truncated at the size limit", async () => {
    const context = await createTestContext({ MCP_CASSETTE_MAX_CALLS: "1" });
    const admin = await login(context, "admin");
    const serverId = await registerServer(context, admin.cookie);
    const workflow = toolWorkflow("wf-big", serverId, "get_current_time", '{"tz":"UTC"}');
    workflow.nodes.push({
      id: "tool2",
      type: "mcp_tool",
      name: "Second tool",
      position: { x: 300, y: 100 },
      config: { registryServerId: serverId, toolName: "lookup_kb", argsTemplate: '{"topic":"rag"}', retry: { enabled: false } }
    });
    workflow.edges = [
      { id: "e1", source: "hook", target: "tool" },
      { id: "e2", source: "tool", target: "tool2" },
      { id: "e3", source: "tool2", target: "output" }
    ];
    await context.store.upsertWorkflow(workflow);
    const run = (await call(context, "POST", "/api/workflows/wf-big/execute", admin.cookie, { record: true })).json<RunResult>();
    expect(run.status).toBe("success");
    expect(run.mcpCassette).toMatchObject({ truncated: true, callCount: 1 });
  });
});

describe("eval runs against cassettes", () => {
  it("records one cassette per fixture and replays the dataset from them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerServer(context, admin.cookie);
    await context.store.upsertWorkflow(toolWorkflow("wf-eval", serverId, "get_current_time", '{"tz":"UTC"}'));
    const dataset = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Clock" })).json<{ dataset: { id: string } }>().dataset;
    for (const name of ["first", "second"]) {
      const fixture = await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, admin.cookie, {
        name,
        input: { question: name },
        scorers: [{ type: "contains", needle: "UTC" }]
      });
      expect(fixture.statusCode).toBe(200);
    }

    const recorded = await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", record: true });
    expect(recorded.statusCode).toBe(200);
    const recordedRunId = recorded.json<{ runId: string }>().runId;
    const cassettes = (await call(context, "GET", `/api/mcp/cassettes?evalRunId=${recordedRunId}`, admin.cookie)).json<{ items: McpCassetteSummary[] }>().items;
    expect(cassettes).toHaveLength(2);
    expect(cassettes.every((entry) => entry.source === "eval" && entry.fixtureId)).toBe(true);
    const runs = (await call(context, "GET", "/api/eval/runs", admin.cookie)).json<{ runs: Array<{ id: string; mcpCassettes: number }> }>().runs;
    expect(runs.find((run) => run.id === recordedRunId)?.mcpCassettes).toBe(2);

    await sleep(1100);
    const replayed = await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { evalRunId: recordedRunId } });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<{ summary: { pass: number; error: number } }>().summary).toMatchObject({ pass: 2, error: 0 });
    const outputs = async (runId: string) =>
      (await call(context, "GET", `/api/eval/runs/${runId}`, admin.cookie))
        .json<{ results: Array<{ fixtureName: string; output: unknown }> }>()
        .results.sort((a, b) => a.fixtureName.localeCompare(b.fixtureName))
        .map((entry) => entry.output);
    expect(await outputs(replayed.json<{ runId: string }>().runId)).toEqual(await outputs(recordedRunId));

    // One cassette for every fixture.
    const single = await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { cassetteId: cassettes[0].id } });
    expect(single.json<{ summary: { pass: number } }>().summary.pass).toBe(2);

    // Bad option combinations.
    expect((await call(context, "POST", "/api/eval/runs", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", record: true, replay: { evalRunId: recordedRunId } })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/eval/runs", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: {} })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/eval/runs", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { cassetteId: "nope" } })).statusCode).toBe(404);
    // Replaying from an eval run that does not exist is refused up front.
    const missing = await call(context, "POST", "/api/eval/runs", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { evalRunId: "run_missing" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Eval run not found" });
    expect((await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { evalRunId: "run_missing" } })).statusCode).toBe(404);
    // A run that recorded nothing for these fixtures leaves each fixture with an error.
    const other = (await call(context, "POST", "/api/eval/datasets", admin.cookie, { name: "Other" })).json<{ dataset: { id: string } }>().dataset;
    await call(context, "POST", `/api/eval/datasets/${other.id}/fixtures`, admin.cookie, { name: "x", input: {} });
    const unrelated = await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: other.id, workflowId: "wf-eval" });
    const empty = await call(context, "POST", "/api/eval/runs?wait=true", admin.cookie, { datasetId: dataset.id, workflowId: "wf-eval", replay: { evalRunId: unrelated.json<{ runId: string }>().runId } });
    expect(empty.json<{ summary: { error: number } }>().summary.error).toBe(2);
  }, 30_000);
});

describe("snapshots and snapshot mock servers", () => {
  it("exports the accepted snapshot and serves it from a snapshot_mock server", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const serverId = await registerServer(context, admin.cookie);
    expect((await call(context, "GET", `/api/mcp/servers/${serverId}/snapshot/export`, viewer.cookie)).statusCode).toBe(403);
    const exported = await call(context, "GET", `/api/mcp/servers/${serverId}/snapshot/export`, builder.cookie);
    expect(exported.statusCode).toBe(200);
    const file = exported.json<McpSnapshotFile>();
    expect(file).toMatchObject({ format: "l2m.mcp-snapshot", version: 1, server: { id: serverId, adapterId: "mock-mcp" } });
    expect(file.snapshot.tools.map((tool) => tool.name)).toContain("lookup_kb");
    expect(hashToolSnapshot(file.snapshot.tools)).toBe(file.snapshot.hash);
    expect(file.catalog?.prompts.map((prompt) => prompt.name)).toEqual(["explain_topic"]);

    const unprobed = await call(context, "POST", "/api/mcp/servers", admin.cookie, { name: "Later", adapterId: "mock-mcp", probeEnabled: false });
    const unprobedId = unprobed.json<{ server: { id: string } }>().server.id;
    expect((await call(context, "GET", `/api/mcp/servers/${unprobedId}/snapshot/export`, builder.cookie)).statusCode).toBe(409);

    // A registry server generated from the snapshot: same tools, offline answers.
    const mockId = await registerServer(context, admin.cookie, { name: "Mock of Mock", adapterId: "snapshot_mock", connection: { sourceServerId: serverId } });
    const mock = (await context.store.getMcpServer(mockId))!;
    expect(mock.status).toBe("healthy");
    expect((await acceptedSnapshotFor(context.store, mock))?.hash).toBe(file.snapshot.hash);
    await context.store.upsertWorkflow(toolWorkflow("wf-mock", mockId, "lookup_kb", '{"topic":"mcp"}'));
    const run = (await call(context, "POST", "/api/workflows/wf-mock/execute", builder.cookie, {})).json<RunResult>();
    expect(run.status).toBe("success");
    expect(String(toolOutput(run))).toContain("Mock response from 'lookup_kb'");
  });
});

describe("CI check endpoint", () => {
  it("reports clean, breaking, unreachable and policy-blocked servers, with API keys", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const serverId = await registerServer(context, admin.cookie);
    await context.store.upsertWorkflow(toolWorkflow("wf-uses-calc", serverId, "calculator", '{"expression":"1+1"}', builder.id));

    const key = (await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "ci" })).json<{ key: string }>().key;
    const check = (payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) =>
      context.app.inject({ method: "POST", url: "/api/mcp/check", headers, payload: payload as object });

    expect((await check({}, { cookie: viewer.cookie })).statusCode).toBe(403);
    expect((await check({}, {})).statusCode).toBe(401);
    const clean = await check({ serverIds: [serverId] });
    expect(clean.statusCode).toBe(200);
    const cleanReport = clean.json<McpCheckReport>();
    expect(cleanReport).toMatchObject({ ok: true, failures: [], blockedTools: [] });
    expect(cleanReport.servers[0]).toMatchObject({ serverId, reachable: true, breaking: false });
    expect(cleanReport.servers[0].currentHash).toBe(cleanReport.servers[0].acceptedHash);
    const probesBefore = (await context.store.listMcpServerProbes(serverId)).length;

    // Policy-blocked tool a workflow depends on.
    const rule = await call(context, "POST", "/api/mcp/policies", admin.cookie, { name: "No calculator", effect: "deny", toolPattern: "calculator" });
    expect(rule.statusCode).toBe(201);
    const blocked = (await check({ serverIds: [serverId] })).json<McpCheckReport>();
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedTools).toEqual([expect.objectContaining({ workflowId: "wf-uses-calc", toolName: "calculator", nodeId: "tool", reason: "policy" })]);
    expect(blocked.failures.map((failure) => failure.kind)).toEqual(["policy_blocked"]);
    expect((await check({ serverIds: [serverId], failOnPolicyBlocked: false })).json<McpCheckReport>().ok).toBe(true);
    expect((await check({ serverIds: [serverId], workflowIds: ["other"] })).json<McpCheckReport>().blockedTools).toEqual([]);
    await call(context, "DELETE", `/api/mcp/policies/${rule.json<{ rule: { id: string } }>().rule.id}`, admin.cookie);

    // Breaking: the accepted snapshot had a tool the server no longer serves.
    const current = (await acceptedSnapshotFor(context.store, (await context.store.getMcpServer(serverId))!))!;
    const tools = [...current.tools, { name: "retired_tool", description: "", inputSchema: { type: "object" } }];
    await context.store.recordMcpServerProbe({
      probe: { id: "mcpprobe_fake", serverId, startedAt: new Date().toISOString(), ok: true, latencyMs: 1, toolCount: tools.length, error: null, snapshotId: "mcpsnap_fake" },
      status: "healthy",
      snapshot: {
        id: "mcpsnap_fake",
        serverId,
        hash: hashToolSnapshot(tools),
        tools,
        toolCount: tools.length,
        previousSnapshotId: current.id,
        changes: [],
        breaking: false,
        createdAt: new Date().toISOString()
      },
      keepProbes: 500
    });
    const breaking = (await check({ serverIds: [serverId] })).json<McpCheckReport>();
    expect(breaking.ok).toBe(false);
    expect(breaking.servers[0]).toMatchObject({ breaking: true, acceptedHash: hashToolSnapshot(tools) });
    expect(breaking.servers[0].changes).toEqual([expect.objectContaining({ tool: "retired_tool", kind: "tool_removed", breaking: true })]);
    expect(breaking.failures).toEqual([expect.objectContaining({ kind: "breaking", serverId })]);

    // Unreachable.
    const deadId = (
      await call(context, "POST", "/api/mcp/servers", admin.cookie, { name: "Dead", adapterId: "http_mcp", connection: { endpoint: "http://127.0.0.1:9/mcp", timeoutMs: 2000 }, probeEnabled: false })
    ).json<{ server: { id: string } }>().server.id;
    const unreachable = (await check({ serverIds: [deadId] })).json<McpCheckReport>();
    expect(unreachable.ok).toBe(false);
    expect(unreachable.servers[0]).toMatchObject({ serverId: deadId, reachable: false, currentHash: null });
    expect(unreachable.failures[0].kind).toBe("unreachable");
    expect((await check({ serverIds: [deadId], failOnUnreachable: false })).json<McpCheckReport>().ok).toBe(true);

    // Everything, and unknown ids.
    expect((await check({})).json<McpCheckReport>().servers.map((server) => server.serverId).sort()).toEqual([deadId, serverId].sort());
    expect((await check({ serverIds: ["mcp_nope"] })).statusCode).toBe(404);
    expect((await check({ toolsetId: "nope" })).statusCode).toBe(404);
    // The check probes without recording anything.
    expect((await context.store.listMcpServerProbes(serverId)).length).toBe(probesBefore + 1);
  }, 30_000);
});
