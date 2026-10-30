/**
 * Phase 10.1 — per-tool MCP telemetry: extraction from execution traces,
 * persistence, retention and the rollup endpoints.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { type McpToolCallRecord } from "./db/database.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { extractMcpToolCalls, rollupMcpToolCalls, splitEvenly } from "./services/mcp-tool-telemetry.js";
import { SecretService } from "./services/secret-service.js";
import { UsageService } from "./services/usage-service.js";
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-telemetry-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
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
  const context: TestContext = { app, store, authService, secretService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // The store may already be closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Cookie '${cookieName}' was not set`);
  return cookie.split(";")[0];
}

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  return extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

async function createServer(context: TestContext, cookie: string) {
  const response = await context.app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { cookie },
    payload: { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false }
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ server: { id: string } }>().server;
}

type ChatReply = {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage?: [number, number];
};

/** A local OpenAI-style chat endpoint that plays back scripted replies. */
async function startFakeModel(script: ChatReply[]) {
  let index = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = script[Math.min(index, script.length - 1)];
      index += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: reply.content ?? "",
                tool_calls: (reply.toolCalls ?? []).map((entry) => ({
                  id: entry.id,
                  type: "function",
                  function: { name: entry.name, arguments: JSON.stringify(entry.args) }
                }))
              }
            }
          ],
          ...(reply.usage ? { usage: { prompt_tokens: reply.usage[0], completion_tokens: reply.usage[1] } } : {})
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to bind fake model");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function agentWorkflow(registryServerId: string, baseUrl: string): Workflow {
  return {
    id: "wf-telemetry",
    name: "Telemetry agent",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "agent",
        type: "agent_orchestrator",
        name: "Agent",
        position: { x: 200, y: 0 },
        config: { userPromptTemplate: "add some numbers", maxIterations: 3, toolCallingEnabled: true }
      },
      {
        id: "model",
        type: "llm_call",
        name: "Model",
        position: { x: 200, y: 160 },
        config: {
          provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl, extra: { apiKey: "test-key", maxRetries: 0 } }
        }
      },
      {
        id: "tool",
        type: "mcp_tool",
        name: "Registry tools",
        position: { x: 340, y: 160 },
        config: { registryServerId, toolName: "calculator" }
      },
      {
        id: "direct",
        type: "mcp_tool",
        name: "Inline time",
        position: { x: 400, y: 0 },
        config: { serverId: "mock-mcp", toolName: "get_current_time", argsTemplate: "{}" }
      },
      { id: "output", type: "output", name: "Output", position: { x: 600, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "agent" },
      { id: "e2", source: "agent", target: "direct" },
      { id: "e3", source: "direct", target: "output" },
      { id: "e4", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e5", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  };
}

let seq = 0;
function call(overrides: Partial<McpToolCallRecord>): Omit<McpToolCallRecord, "createdAt"> {
  seq += 1;
  return {
    id: `row_${seq}`,
    executionId: "exec_seed",
    workflowId: "wf",
    nodeId: "n",
    registryServerId: null,
    adapterId: "mock-mcp",
    toolName: "calculator",
    samplingRequests: null,
    samplingInputTokens: null,
    samplingOutputTokens: null,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    ok: true,
    error: null,
    turnInputTokens: null,
    turnOutputTokens: null,
    estimatedCostUsd: null,
    source: "workflow",
    clientId: null,
    ...overrides
  };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

describe("MCP tool telemetry: end to end", () => {
  it("records agent and direct calls when an execution finishes and rolls them up", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const server = await createServer(context, admin);
    const model = await startFakeModel([
      {
        toolCalls: [
          { id: "c1", name: "mock-mcp__calculator", args: { expression: "1+1" } },
          { id: "c2", name: "mock-mcp__calculator", args: { expression: "2+2" } }
        ],
        usage: [101, 21]
      },
      { content: "Both done.", usage: [60, 6] }
    ]);
    try {
      await context.store.upsertWorkflow(agentWorkflow(server.id, model.baseUrl));
      const run = await context.app.inject({
        method: "POST",
        url: "/api/workflows/wf-telemetry/execute",
        headers: { cookie: admin },
        payload: {}
      });
      expect(run.statusCode).toBe(200);
      const executionId = run.json<{ executionId?: string }>().executionId;

      const registryCalls = await context.store.listMcpToolCalls({ registryServerId: server.id, since: ago(HOUR) });
      expect(registryCalls).toHaveLength(2);
      expect(registryCalls.map((row) => row.turnInputTokens).sort()).toEqual([50, 51]);
      expect(registryCalls.map((row) => row.turnOutputTokens).sort()).toEqual([10, 11]);
      for (const row of registryCalls) {
        expect(row).toMatchObject({ adapterId: "mock-mcp", toolName: "calculator", nodeId: "agent", ok: true });
        expect(row.durationMs).not.toBeNull();
        if (executionId) expect(row.executionId).toBe(executionId);
      }
      const pricing = new UsageService(context.store);
      const expectedCost =
        (pricing.estimateCostUsd("openai", "gpt-4o-mini", 51, 11, 0) ?? 0) +
        (pricing.estimateCostUsd("openai", "gpt-4o-mini", 50, 10, 0) ?? 0);
      const storedCost = registryCalls.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
      expect(storedCost).toBeGreaterThan(0);
      expect(storedCost).toBeCloseTo(expectedCost, 9);

      const inlineCalls = await context.store.listMcpToolCalls({ registryServerId: null, since: ago(HOUR) });
      expect(inlineCalls).toHaveLength(1);
      expect(inlineCalls[0]).toMatchObject({
        nodeId: "direct",
        toolName: "get_current_time",
        registryServerId: null,
        turnInputTokens: null,
        estimatedCostUsd: null
      });

      const builder = await login(context, "builder");
      const telemetry = await context.app.inject({
        method: "GET",
        url: `/api/mcp/servers/${server.id}/telemetry?window=24h`,
        headers: { cookie: builder }
      });
      expect(telemetry.statusCode).toBe(200);
      const body = telemetry.json<{ window: string; totals: { calls: number }; tools: Array<Record<string, unknown>> }>();
      expect(body.window).toBe("24h");
      expect(body.totals.calls).toBe(2);
      expect(body.tools).toEqual([
        expect.objectContaining({ toolName: "calculator", calls: 2, errors: 0, inputTokens: 101, outputTokens: 21 })
      ]);

      const inline = await context.app.inject({ method: "GET", url: "/api/mcp/telemetry", headers: { cookie: builder } });
      expect(inline.statusCode).toBe(200);
      expect(inline.json<{ window: string; tools: Array<Record<string, unknown>> }>()).toMatchObject({
        window: "7d",
        tools: [expect.objectContaining({ adapterId: "mock-mcp", toolName: "get_current_time", calls: 1, costUsd: null })]
      });
    } finally {
      await model.close();
    }
  });

  it("records a failed registry MCP Tool node as an error call", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const server = await createServer(context, admin);
    await context.store.upsertWorkflow({
      id: "wf-broken",
      name: "Broken",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "calc",
          type: "mcp_tool",
          name: "Calc",
          position: { x: 200, y: 0 },
          config: { registryServerId: server.id, toolName: "no_such_tool", argsTemplate: "{}" }
        },
        { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "start", target: "calc" },
        { id: "e2", source: "calc", target: "output" }
      ]
    });
    const run = await context.app.inject({ method: "POST", url: "/api/workflows/wf-broken/execute", headers: { cookie: admin }, payload: {} });
    expect(run.statusCode).toBe(400);
    const rows = await context.store.listMcpToolCalls({ registryServerId: server.id, since: ago(HOUR) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adapterId: "mock-mcp", toolName: "no_such_tool", ok: false });
    expect(rows[0].error).toBeTruthy();
  });
});

describe("MCP tool telemetry: argument summaries (Phase 12.4)", () => {
  const runAgent = async (context: TestContext) => {
    const admin = await login(context, "admin");
    const server = await createServer(context, admin);
    const model = await startFakeModel([
      {
        toolCalls: [
          { id: "c1", name: "mock-mcp__calculator", args: { expression: "1+1" } },
          { id: "c2", name: "mock-mcp__calculator", args: { expression: "Add 4111 1111 1111 1111 to my total" } }
        ],
        usage: [10, 2]
      },
      { content: "Done.", usage: [5, 1] }
    ]);
    try {
      await context.store.upsertWorkflow(agentWorkflow(server.id, model.baseUrl));
      const run = await context.app.inject({ method: "POST", url: "/api/workflows/wf-telemetry/execute", headers: { cookie: admin }, payload: {} });
      expect(run.statusCode).toBe(200);
      return { admin, server, executionId: run.json<{ executionId: string }>().executionId };
    } finally {
      await model.close();
    }
  };

  it("keeps a safe summary, the subject and the project on each workflow call, and shows it to admins only", async () => {
    const context = await createTestContext();
    const { admin, server, executionId } = await runAgent(context);
    const rows = await context.store.listMcpToolCallsForExecution(executionId);
    expect(rows).toHaveLength(3);
    const agentRows = rows.filter((row) => row.nodeId === "agent");
    // `1+1` is not a safe token and the card number is flagged: both keep only shape, class and a keyed hash.
    const expressions = agentRows.map((row) => row.argsSummary?.fields.expression);
    expect(expressions.map((field) => [field?.classes ?? [], field?.len, field?.values, field?.hashes?.length]).sort()).toEqual([
      [[], "1-8", undefined, 1],
      [["card_number"], "33-128", undefined, 1]
    ]);
    const direct = rows.find((row) => row.nodeId === "direct")!;
    expect(direct.argsSummary).toEqual({ v: 3, kid: expect.stringMatching(/^[0-9a-f]{8}$/), fields: {} });
    for (const row of rows) {
      expect(row).toMatchObject({ subjectRole: "admin", subjectSource: "user", projectId: "default" });
    }
    expect(JSON.stringify(rows)).not.toContain("4111");

    const probe = await context.app.inject({ method: "POST", url: `/api/mcp/servers/${server.id}/probe`, headers: { cookie: admin } });
    expect(probe.statusCode).toBe(200);
    const catalog = async (cookie: string) => {
      const response = await context.app.inject({ method: "GET", url: "/api/mcp/tools?detail=true", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      const tool = response.json<{ tools: Array<{ serverId: string; name: string; recentCalls?: Array<Record<string, unknown>> }> }>().tools.find(
        (entry) => entry.serverId === server.id && entry.name === "calculator"
      );
      return tool?.recentCalls ?? [];
    };
    const forAdmin = await catalog(admin);
    expect(forAdmin).toHaveLength(2);
    expect(forAdmin.every((entry) => entry.subjectRole === "admin" && (entry.argsSummary as { v?: number } | null)?.v === 3)).toBe(true);
    const forBuilder = await catalog(await login(context, "builder"));
    expect(forBuilder).toHaveLength(2);
    expect(forBuilder.some((entry) => "argsSummary" in entry || "subjectRole" in entry)).toBe(false);
  });

  it("keeps the new columns empty with MCP_TOOL_ARGUMENT_SUMMARIES=false", async () => {
    const context = await createTestContext({ MCP_TOOL_ARGUMENT_SUMMARIES: "false" });
    const { executionId } = await runAgent(context);
    const rows = await context.store.listMcpToolCallsForExecution(executionId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatchObject({ argsSummary: null, subjectRole: null, subjectSource: null, projectId: null });
    }
  });

  it("stores and reads the summary columns, and reads an unknown summary version as null", async () => {
    const context = await createTestContext();
    const summary = {
      v: 2 as const,
      fields: { state: { type: "string" as const, values: ["open"] }, account: { type: "number" as const, mag: 7, hashes: ["AAAAAAAAAAAAAAAAAAAAAA"] } },
      truncated: true as const
    };
    await context.store.insertMcpToolCall({
      ...call({ id: "sum_1", executionId: "exec_sum" }),
      argsSummary: summary,
      subjectRole: "operator",
      subjectSource: "client",
      projectId: "proj-x"
    });
    await context.store.replaceMcpToolCallsForExecution("exec_sum_2", [call({ id: "sum_2", executionId: "exec_sum_2" })]);
    expect((await context.store.listMcpToolCallsForExecution("exec_sum"))[0]).toMatchObject({
      argsSummary: summary,
      subjectRole: "operator",
      subjectSource: "client",
      projectId: "proj-x"
    });
    expect((await context.store.listMcpToolCallsForExecution("exec_sum_2"))[0]).toMatchObject({
      argsSummary: null,
      subjectRole: null,
      subjectSource: null,
      projectId: null
    });
    await context.store.insertMcpToolCall({
      ...call({ id: "sum_3", executionId: "exec_sum_3" }),
      argsSummary: { v: 1, fields: {} } as unknown as typeof summary
    });
    expect((await context.store.listMcpToolCallsForExecution("exec_sum_3"))[0]?.argsSummary).toBeNull();
  });
});

describe("MCP tool telemetry: extraction", () => {
  const price = new UsageService({} as Store);
  const priceTurn = (providerId: string, model: string, i: number, o: number, c: number) =>
    price.estimateCostUsd(providerId, model, i, o, c);
  const workflow = {
    id: "wf",
    nodes: [
      { id: "agent", type: "agent_orchestrator" },
      { id: "direct", type: "mcp_tool", config: { registryServerId: "mcp_reg", toolName: "calculator" } },
      { id: "attached", type: "mcp_tool", config: { serverId: "mock-mcp", toolName: "calculator" } }
    ]
  };
  const agentOutput = (telemetry: Record<string, unknown>, usage?: Record<string, number>) => ({
    _telemetry: telemetry,
    _mcpTools: {
      "mock-mcp__calculator": { adapterId: "mock-mcp", toolName: "calculator", registryServerId: "mcp_reg" },
      http_mcp__search: { adapterId: "http_mcp", toolName: "search" }
    },
    steps: [
      {
        iteration: 1,
        requestedTools: [{ id: "a" }, { id: "b" }, { id: "c" }],
        usage,
        toolResults: [
          { toolCallId: "a", toolName: "mock-mcp__calculator", output: 1, startedAt: "2026-10-01T00:00:00.000Z", durationMs: 12 },
          { toolCallId: "b", toolName: "http_mcp__search", output: null, error: "boom", durationMs: 30 },
          { toolCallId: "c", toolName: "session_cache_list", output: [] }
        ]
      }
    ]
  });

  it("splits a turn's tokens evenly across the calls it requested and prices them", () => {
    const rows = extractMcpToolCalls({
      executionId: "e1",
      workflow,
      priceTurn,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: "2026-10-01T00:00:00.000Z",
          output: agentOutput({ providerId: "openai", model: "gpt-4o" }, { inputTokens: 100, outputTokens: 10 })
        },
        { nodeId: "attached", status: "skipped", startedAt: "2026-10-01T00:00:00.000Z" }
      ]
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      registryServerId: "mcp_reg",
      adapterId: "mock-mcp",
      toolName: "calculator",
      durationMs: 12,
      ok: true,
      turnInputTokens: 34,
      turnOutputTokens: 4
    });
    expect(rows[0].estimatedCostUsd).toBe(price.estimateCostUsd("openai", "gpt-4o", 34, 4, 0));
    expect(rows[1]).toMatchObject({
      registryServerId: null,
      adapterId: "http_mcp",
      toolName: "search",
      ok: false,
      error: "boom",
      turnInputTokens: 33,
      turnOutputTokens: 3
    });
    expect(rows[1].startedAt).toBe("2026-10-01T00:00:00.000Z");
    expect([0, 1, 2].map((index) => splitEvenly(100, 3, index))).toEqual([34, 33, 33]);
  });

  it("leaves cost null for an unpriced model and tokens null when the turn reported none", () => {
    const unpriced = extractMcpToolCalls({
      executionId: "e2",
      workflow,
      priceTurn,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: "2026-10-01T00:00:00.000Z",
          output: agentOutput({ providerId: "ollama", model: "llama3" }, { inputTokens: 9, outputTokens: 3 })
        }
      ]
    });
    expect(unpriced[0]).toMatchObject({ turnInputTokens: 3, turnOutputTokens: 1, estimatedCostUsd: null });

    const noUsage = extractMcpToolCalls({
      executionId: "e3",
      workflow,
      priceTurn,
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: "2026-10-01T00:00:00.000Z",
          output: agentOutput({ providerId: "openai", model: "gpt-4o" })
        }
      ]
    });
    expect(noUsage[0]).toMatchObject({ turnInputTokens: null, turnOutputTokens: null, estimatedCostUsd: null });
  });

  it("scans delegated worker agents and failed direct nodes, truncating long errors", () => {
    const worker = agentOutput({ providerId: "openai", model: "gpt-4o" }, { inputTokens: 3, outputTokens: 3 });
    const rows = extractMcpToolCalls({
      executionId: "e4",
      workflow,
      priceTurn,
      registryAdapterId: (id) => (id === "mcp_reg" ? "stdio_mcp" : undefined),
      nodeResults: [
        {
          nodeId: "agent",
          status: "success",
          startedAt: "2026-10-01T00:00:00.000Z",
          output: {
            _mcpTools: {},
            steps: [
              {
                iteration: 1,
                requestedTools: [{ id: "w" }],
                toolResults: [{ toolCallId: "w", toolName: "delegate_to_Worker", output: worker, durationMs: 50 }]
              }
            ]
          }
        },
        { nodeId: "direct", status: "error", startedAt: "2026-10-01T00:00:01.000Z", durationMs: 7, error: "x".repeat(2000) }
      ]
    });
    expect(rows.map((row) => `${row.nodeId}:${row.adapterId}:${row.toolName}`)).toEqual([
      "agent:mock-mcp:calculator",
      "agent:http_mcp:search",
      "direct:stdio_mcp:calculator"
    ]);
    const direct = rows[2];
    expect(direct).toMatchObject({ registryServerId: "mcp_reg", ok: false, durationMs: 7, estimatedCostUsd: null });
    expect(direct.error?.length).toBeLessThanOrEqual(500);
  });

  it("carries the tool policy's decision to the call it was made for (agent by tool call id, direct node)", () => {
    const shadow = { effect: "allow", decidedBy: "default", matched: [{ ruleId: "mtp_s", mode: "shadow", effect: "deny" }], shadow: { effect: "deny", ruleId: "mtp_s", changed: true } };
    const approved = { effect: "require_approval", decidedBy: "rule", ruleId: "mtp_a", approval: "approved", matched: [{ ruleId: "mtp_a", mode: "enforce", effect: "require_approval" }] };
    const output = {
      ...agentOutput({ providerId: "openai", model: "gpt-4o" }),
      _toolPolicy: { decisions: [{ tool: "calculator", server: "mock-mcp", toolCallId: "a", ...shadow }] }
    };
    const rows = extractMcpToolCalls({
      executionId: "e5",
      workflow,
      priceTurn,
      registryAdapterId: () => "stdio_mcp",
      nodeResults: [
        { nodeId: "agent", status: "success", startedAt: "2026-10-01T00:00:00.000Z", output },
        {
          nodeId: "direct",
          status: "success",
          startedAt: "2026-10-01T00:00:01.000Z",
          output: {
            invocation_request: { registry_server_id: "mcp_reg", tool_name: "calculator" },
            _toolPolicy: { decisions: [{ tool: "calculator", server: "stdio_mcp", ...approved }] }
          }
        }
      ]
    });
    expect(rows.map((row) => [row.nodeId, row.toolName, row.policyDecision ?? null])).toEqual([
      ["agent", "calculator", shadow],
      ["agent", "search", null],
      ["direct", "calculator", approved]
    ]);
  });
});

describe("MCP tool telemetry: storage and endpoints", () => {
  it("prunes tool calls with execution history retention and replaces rows per execution", async () => {
    const context = await createTestContext();
    await context.store.replaceMcpToolCallsForExecution("exec_a", [
      call({ executionId: "exec_a", startedAt: ago(40 * 24 * HOUR) }),
      call({ executionId: "exec_a", startedAt: ago(HOUR) })
    ]);
    await context.store.replaceMcpToolCallsForExecution("exec_b", [call({ executionId: "exec_b", startedAt: ago(HOUR) })]);
    const since = ago(365 * 24 * HOUR);
    expect(await context.store.listMcpToolCalls({ registryServerId: null, since })).toHaveLength(3);

    await context.store.replaceMcpToolCallsForExecution("exec_b", [call({ executionId: "exec_b", startedAt: ago(HOUR) })]);
    expect(await context.store.listMcpToolCalls({ registryServerId: null, since })).toHaveLength(3);

    await context.store.pruneExecutionHistory({ before: ago(30 * 24 * HOUR) });
    const left = await context.store.listMcpToolCalls({ registryServerId: null, since });
    expect(left).toHaveLength(2);
    expect(left.every((row) => row.startedAt > ago(31 * 24 * HOUR))).toBe(true);
  });

  it("computes per-tool rollups with nearest-rank percentiles inside the window", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const server = await createServer(context, admin);
    const other = await createServer(context, admin);
    const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    await context.store.replaceMcpToolCallsForExecution("exec_math", [
      ...durations.map((durationMs, index) =>
        call({
          registryServerId: server.id,
          toolName: "calculator",
          durationMs,
          startedAt: ago((index + 1) * 60_000),
          turnInputTokens: 10,
          turnOutputTokens: 2,
          estimatedCostUsd: index < 5 ? 0.001 : null
        })
      ),
      call({ registryServerId: server.id, toolName: "calculator", durationMs: 5, ok: false, error: "nope", startedAt: ago(30_000) }),
      call({ registryServerId: server.id, toolName: "lookup_kb", durationMs: 400, startedAt: ago(2 * HOUR) }),
      call({ registryServerId: server.id, toolName: "lookup_kb", durationMs: 1, startedAt: ago(3 * 24 * HOUR) }),
      call({ registryServerId: other.id, toolName: "calculator", startedAt: ago(HOUR) })
    ]);

    const builder = await login(context, "builder");
    const get = (url: string, cookie = builder) => context.app.inject({ method: "GET", url, headers: { cookie } });

    const day = (await get(`/api/mcp/servers/${server.id}/telemetry?window=24h`)).json<{
      totals: Record<string, unknown>;
      tools: Array<Record<string, unknown>>;
    }>();
    expect(day.tools.map((tool) => tool.toolName)).toEqual(["calculator", "lookup_kb"]);
    expect(day.tools[0]).toMatchObject({
      calls: 11,
      errors: 1,
      p50Ms: 50,
      p95Ms: 100,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.005
    });
    expect(day.tools[0].errorRate).toBeCloseTo(1 / 11, 10);
    expect(day.tools[1]).toMatchObject({ calls: 1, errors: 0, p50Ms: 400, p95Ms: 400, costUsd: null, inputTokens: 0 });
    expect(day.totals).toMatchObject({ calls: 12, errors: 1 });

    const week = (await get(`/api/mcp/servers/${server.id}/telemetry`)).json<{
      window: string;
      tools: Array<Record<string, unknown>>;
    }>();
    expect(week.window).toBe("7d");
    expect(week.tools.find((tool) => tool.toolName === "lookup_kb")).toMatchObject({ calls: 2, p50Ms: 1, p95Ms: 400 });

    expect((await get(`/api/mcp/servers/${server.id}/telemetry?window=1y`)).statusCode).toBe(400);
    expect((await get(`/api/mcp/telemetry?window=bogus`)).statusCode).toBe(400);
    expect((await get(`/api/mcp/servers/mcp_missing/telemetry`)).statusCode).toBe(404);

    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");
    expect((await get(`/api/mcp/servers/${server.id}/telemetry`, operator)).statusCode).toBe(403);
    expect((await get(`/api/mcp/telemetry`, viewer)).statusCode).toBe(403);
    expect((await context.app.inject({ method: "GET", url: `/api/mcp/telemetry` })).statusCode).toBe(401);
  });

  it("rolls up a list of calls without a store", () => {
    const rollup = rollupMcpToolCalls(
      [
        { ...call({ adapterId: "a", toolName: "t" }), createdAt: "" },
        { ...call({ adapterId: "b", toolName: "t", ok: false }), createdAt: "" }
      ],
      { byAdapter: true }
    );
    expect(rollup.tools.map((tool) => `${tool.adapterId}/${tool.toolName}`).sort()).toEqual(["a/t", "b/t"]);
    expect(rollup.totals).toMatchObject({ calls: 2, errors: 1, errorRate: 0.5 });
  });
});
