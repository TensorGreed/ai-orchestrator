/**
 * Phase 11.2 — approved write-tool results are kept to answer an agent's
 * re-run. They are stored encrypted (never redacted, never in plaintext), at
 * the top level and inside a paused sub-workflow, and the agent gets the exact
 * original value back after the next approval.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const servers: http.Server[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-tool-results-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
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
      context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: "admin" | "builder", name: string): Promise<string> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const sha1 = (value: string) => crypto.createHash("sha1").update(value).digest("hex");

/** A streamable-HTTP MCP server with one write tool whose result holds a commit-like sha and a usage counter. */
async function startWriteServer() {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}") as { id?: string; method?: string; params?: { name?: string; arguments?: { email?: string } } };
      response.setHeader("content-type", "application/json");
      if (rpc.method === "initialize") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2024-11-05", capabilities: {} } }));
      } else if (rpc.method === "tools/list") {
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { tools: [{ name: "write_record", description: "Write a record", inputSchema: { type: "object", properties: { email: { type: "string" } } } }] }
          })
        );
      } else if (rpc.method === "tools/call") {
        const email = String(rpc.params?.arguments?.email ?? "");
        calls.push(email);
        const structured = { sha: sha1(email), usage: { total_tokens: 3 } };
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured } }));
      } else {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, result: {} }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}

/** A chat endpoint that writes a@ then b@ and records every request it gets. */
async function startModel() {
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
      requests.push(parsed);
      const done = parsed.messages.filter((message) => message.role === "tool").length;
      const email = done === 0 ? "a@example.org" : done === 1 ? "b@example.org" : "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: email ? "" : "All done.",
                tool_calls: email ? [{ id: `call-${done}`, type: "function", function: { name: "http_mcp__write_record", arguments: JSON.stringify({ email }) } }] : []
              }
            }
          ]
        })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

function agentWorkflow(id: string, serverId: string, baseUrl: string): Workflow {
  return {
    id,
    name: `Agent ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    settings: { writeToolApproval: { enabled: true, approverRoles: ["admin"], timeoutMinutes: 60 } },
    nodes: [
      node("in", "manual_trigger"),
      node("agent", "agent_orchestrator", { userPromptTemplate: "write the records", maxIterations: 6, toolCallingEnabled: true }),
      node("model", "llm_call", { provider: { providerId: "openai", model: "m", baseUrl, extra: { apiKey: "test-key", maxRetries: 0 } } }),
      node("tool", "mcp_tool", { registryServerId: serverId, toolName: "__all__" }),
      node("out", "output")
    ],
    edges: [
      { id: "e1", source: "in", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
      { id: "e4", source: "agent", sourceHandle: "tool", target: "tool" }
    ]
  } as Workflow;
}

type RunResult = { status: string; executionId?: string; error?: string };

async function approve(context: TestContext, cookie: string, executionId: string): Promise<RunResult> {
  const response = await context.app.inject({ method: "POST", url: `/api/approvals/${executionId}/approve`, headers: { cookie }, payload: {} });
  expect(response.statusCode).toBe(200);
  return response.json<RunResult>();
}

function toolMessages(requests: Array<{ messages: Array<{ role: string; content?: unknown }> }>): string[] {
  const last = requests[requests.length - 1]!;
  return last.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
}

describe("approved write-tool results are stored encrypted", () => {
  async function setup() {
    const context = await createTestContext();
    const admin = await login(context, "admin", "admin");
    const builder = await login(context, "builder", "builder");
    const mcp = await startWriteServer();
    const model = await startModel();
    const created = await context.app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      headers: { cookie: admin },
      payload: { name: "Records", adapterId: "http_mcp", probeEnabled: false, connection: { endpoint: mcp.endpoint } }
    });
    expect(created.statusCode, created.body).toBe(201);
    const serverId = created.json<{ server: { id: string } }>().server.id;
    return { context, admin, builder, mcp, model, serverId };
  }

  function expectSealed(context: TestContext, executionId: string, sha: string) {
    const stored = context.store.getWorkflowExecutionState(executionId)!;
    const text = JSON.stringify(stored.state);
    expect(text).not.toContain(sha);
    expect(text).not.toContain("total_tokens");
    expect(text).toContain("approvedToolResultsSealed");
    expect(text).not.toContain("[REDACTED]");
    expect(text).not.toContain("\"approvedToolResults\"");
  }

  function expectExactResult(requests: Parameters<typeof toolMessages>[0], sha: string) {
    const aResult = toolMessages(requests).find((content) => content.includes(sha));
    expect(aResult).toBeDefined();
    expect(aResult).toContain("\"total_tokens\":3");
    expect(aResult).not.toContain("[REDACTED]");
  }

  it("gives the agent the exact result back after the next approval", async () => {
    const { context, admin, builder, mcp, model, serverId } = await setup();
    context.store.upsertWorkflow(agentWorkflow("wf-agent", serverId, model.baseUrl));
    const run = (await context.app.inject({ method: "POST", url: "/api/workflows/wf-agent/execute", headers: { cookie: builder }, payload: {} })).json<RunResult>();
    expect(run.status).toBe("waiting_approval");

    // Approve write A: it runs, then the agent asks for write B.
    const second = await approve(context, admin, run.executionId!);
    expect(second.status).toBe("waiting_approval");
    expect(mcp.calls).toEqual(["a@example.org"]);
    const shaA = sha1("a@example.org");
    expectSealed(context, run.executionId!, shaA);

    // Approve write B: A is answered from the stored result, B runs once.
    const done = await approve(context, admin, run.executionId!);
    expect(done.status).toBe("success");
    expect(mcp.calls).toEqual(["a@example.org", "b@example.org"]);
    expectExactResult(model.requests, shaA);
  });

  it("does the same for a write inside a sub-workflow", async () => {
    const { context, admin, builder, mcp, model, serverId } = await setup();
    context.store.upsertWorkflow(agentWorkflow("wf-child-agent", serverId, model.baseUrl));
    const parent = {
      id: "wf-parent-agent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [node("in", "manual_trigger"), node("call", "execute_workflow", { workflowId: "wf-child-agent" }), node("out", "output")],
      edges: [
        { id: "p1", source: "in", target: "call" },
        { id: "p2", source: "call", target: "out" }
      ]
    } as Workflow;
    context.store.upsertWorkflow(parent);
    const run = (await context.app.inject({ method: "POST", url: "/api/workflows/wf-parent-agent/execute", headers: { cookie: builder }, payload: {} })).json<RunResult>();
    expect(run.status).toBe("waiting_approval");

    const second = await approve(context, admin, run.executionId!);
    expect(second.status).toBe("waiting_approval");
    expect(mcp.calls).toEqual(["a@example.org"]);
    const shaA = sha1("a@example.org");
    const stored = JSON.stringify(context.store.getWorkflowExecutionState(run.executionId!)!.state);
    expect(stored).toContain("childState");
    expectSealed(context, run.executionId!, shaA);

    const done = await approve(context, admin, run.executionId!);
    expect(done.status).toBe("success");
    expect(mcp.calls).toEqual(["a@example.org", "b@example.org"]);
    expectExactResult(model.requests, shaA);
  });

  it("asks again, without failing, when the sealed results cannot be opened", async () => {
    const { context, admin, builder, mcp, model, serverId } = await setup();
    context.store.upsertWorkflow(agentWorkflow("wf-agent-bad", serverId, model.baseUrl));
    const run = (await context.app.inject({ method: "POST", url: "/api/workflows/wf-agent-bad/execute", headers: { cookie: builder }, payload: {} })).json<RunResult>();
    const second = await approve(context, admin, run.executionId!);
    expect(second.status).toBe("waiting_approval");
    const pending = context.store.getWorkflowExecutionState(run.executionId!)!;
    const state = pending.state as Record<string, unknown>;
    context.store.saveWorkflowExecutionState({ ...pending, state: { ...state, approvedToolResultsSealed: "v1.AAAA.AAAA.AAAA" } } as never);

    // Write A's stored result is gone, so the re-run asks for A again instead of failing.
    const third = await approve(context, admin, run.executionId!);
    expect(third.status).toBe("waiting_approval");
    expect(mcp.calls).toEqual(["a@example.org", "b@example.org"].slice(0, 1));
  });
});
