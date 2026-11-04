/**
 * 12.6 (D7) — model allowlists: optional `{providerId, modelGlob}` entries for the deployment and per project. A call
 * is allowed when it matches the deployment list (if any) AND the project's list (if any); no entries = every model,
 * as before. One seam (a gated provider registry) covers every call path: the LLM node, an agent's chat model, a
 * supervisor's worker, MCP sampling in a run and on the gateway, the provider test panel. Builders get a warning, the
 * Security page's Models tab edits the lists (admins only, audited), and v55 migrates an existing database.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset, ModelAllowlistEntry, Workflow, WorkflowValidationResult } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

// A provider that calls the first tool it is offered once, then answers: it makes a supervisor delegate to a worker.
vi.mock("@ai-orchestrator/provider-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@ai-orchestrator/provider-sdk")>();
  return {
    ...sdk,
    createDefaultProviderRegistry: () => {
      const registry = sdk.createDefaultProviderRegistry();
      registry.register({
        definition: { id: "scripted", label: "Scripted", supportsTools: true, configSchema: {} },
        generate: async (request) => {
          const tool = (request.tools ?? []).find((entry) => !entry.name.startsWith("session_cache") && entry.name !== "agent_clarify");
          const delegated = request.messages.some((message) => message.role === "tool");
          if (tool && !delegated) return { content: "", toolCalls: [{ id: "call_1", name: tool.name, arguments: { task_prompt: "say hi" } }] };
          return { content: "done", toolCalls: [] };
        }
      });
      return registry;
    }
  };
});

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
  file: string;
}

const contexts: TestContext[] = [];

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-model-allowlist-"));
  const file = path.join(tempDir, "orchestrator.db");
  const store = await openTestStore(file);
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "p1", name: "Project one" });
  await store.upsertProject({ id: "p2", name: "Project two" });
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
  const context: TestContext = { app, store, authService, secretService, config, tempDir, file };
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

async function login(context: TestContext, role: Role): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

function caller(context: TestContext) {
  return (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

const position = { x: 0, y: 0 };

/** Text input → prompt → LLM Call (echo, `model`) → output. */
function llmWorkflow(id: string, projectId: string, model: string, providerId = "echo"): Workflow {
  return {
    id,
    name: `LLM ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "text", type: "text_input", name: "Text", position, config: { text: "hello" } },
      { id: "template", type: "prompt_template", name: "Prompt", position, config: { template: "{{user_prompt}}", outputKey: "prompt" } },
      { id: "llm", type: "llm_call", name: "Ask", position, config: { provider: { providerId, model }, promptKey: "prompt", systemPromptKey: "system_prompt" } },
      { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
    ],
    edges: [
      { id: "e1", source: "text", target: "template" },
      { id: "e2", source: "template", target: "llm" },
      { id: "e3", source: "llm", target: "out" }
    ]
  };
}

/** Manual trigger → agent with an attached chat model (echo, `model`) → output. */
function agentWorkflow(id: string, projectId: string, model: string): Workflow {
  return {
    id,
    name: `Agent ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "trigger", type: "manual_trigger", name: "Run", position, config: {} },
      { id: "agent", type: "agent_orchestrator", name: "Agent", position, config: { userPromptTemplate: "hello", maxIterations: 2, toolCallingEnabled: false } },
      { id: "agent_chat", type: "llm_call", name: "Agent model", position, config: { provider: { providerId: "echo", model }, promptKey: "prompt", systemPromptKey: "system_prompt" } },
      { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "agent" },
      { id: "e2", source: "agent", target: "out" },
      { id: "e3", source: "agent", sourceHandle: "chat_model", target: "agent_chat" }
    ]
  };
}

/** A supervisor (scripted model) that delegates once to a worker agent whose chat model is echo `workerModel`. */
function supervisorWorkflow(id: string, workerModel: string): Workflow {
  return {
    id,
    name: `Supervisor ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "trigger", type: "manual_trigger", name: "Run", position, config: {} },
      { id: "boss", type: "supervisor_node", name: "Boss", position, config: { userPromptTemplate: "delegate", maxIterations: 3 } },
      { id: "boss_chat", type: "llm_call", name: "Boss model", position, config: { provider: { providerId: "scripted", model: "boss" }, promptKey: "prompt", systemPromptKey: "system_prompt" } },
      { id: "worker", type: "agent_orchestrator", name: "Worker", position, config: { userPromptTemplate: "{{user_prompt}}", maxIterations: 2, toolCallingEnabled: false } },
      { id: "worker_chat", type: "llm_call", name: "Worker model", position, config: { provider: { providerId: "echo", model: workerModel }, promptKey: "prompt", systemPromptKey: "system_prompt" } },
      { id: "out", type: "output", name: "Out", position, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "boss" },
      { id: "e2", source: "boss", target: "out" },
      { id: "e3", source: "boss", sourceHandle: "chat_model", target: "boss_chat" },
      { id: "e4", source: "boss", sourceHandle: "worker", target: "worker" },
      { id: "e5", source: "worker", sourceHandle: "chat_model", target: "worker_chat" }
    ]
  };
}

/** Manual trigger → MCP Tool calling the mock server's summarize_with_model (it asks the client to sample) → output. */
function samplingWorkflow(id: string, serverId: string): Workflow {
  return {
    id,
    name: `Sampling ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "trigger", type: "manual_trigger", name: "Run", position, config: {} },
      { id: "tool", type: "mcp_tool", name: "Summarize", position, config: { registryServerId: serverId, toolName: "summarize_with_model", argsTemplate: "{\"text\":\"hello world\"}", retry: { enabled: false } } },
      { id: "out", type: "output", name: "Out", position, config: {} }
    ],
    edges: [
      { id: "e1", source: "trigger", target: "tool" },
      { id: "e2", source: "tool", target: "out" }
    ]
  };
}

interface RunResult {
  status: string;
  executionId: string;
  error?: string;
  nodeResults: Array<{ nodeId: string; status: string; error?: string; errorCategory?: string; retryable?: boolean; output?: unknown }>;
}

async function run(context: TestContext, cookie: string, workflowId: string): Promise<RunResult> {
  const response = await caller(context)(cookie, "POST", `/api/workflows/${workflowId}/execute`, {});
  // A run that ends in an error answers 400 with the same result body.
  expect([200, 400], response.body).toContain(response.statusCode);
  return response.json<RunResult>();
}

async function addEntry(context: TestContext, admin: string, entry: Record<string, unknown>): Promise<ModelAllowlistEntry> {
  const response = await caller(context)(admin, "POST", "/api/model-allowlist", entry);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ entry: ModelAllowlistEntry }>().entry;
}

async function deniedEvents(store: Store) {
  return (await store.listAuditLogs({ eventType: "model_allowlist.call_denied", pageSize: 100 })).items;
}

async function registerSamplingServer(context: TestContext, admin: string): Promise<string> {
  const call = caller(context);
  const created = await call(admin, "POST", "/api/mcp/servers", {
    name: "Sampler",
    adapterId: "mock-mcp",
    probeEnabled: false,
    sampling: { allow: true, maxTokens: 200, allowedModels: [], maxRequestsPerCall: 3, defaultModel: { providerId: "echo", model: "sampler-model" } }
  });
  expect(created.statusCode, created.body).toBe(201);
  const serverId = created.json<{ server: { id: string } }>().server.id;
  expect((await call(admin, "POST", `/api/mcp/servers/${serverId}/probe`)).statusCode).toBe(200);
  return serverId;
}

describe("migration v55", () => {
  it("adds the allowlist table with a rollback, right after v53 and v54", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    expect(versions.filter((version) => version >= 53)).toEqual([53, 54, 55]);
    const migration = MIGRATIONS.find((entry) => entry.version === 55)!;
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS model_allowlist_entries");
    expect(migration.up).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_model_allowlist_entries_match");
    expect(migration.down).toContain("DROP TABLE IF EXISTS model_allowlist_entries");
  });

  it("upgrades an existing v54 database, which then allows every model until an admin adds an entry", async () => {
    const context = await createTestContext();
    const sql = testSql(context.store);
    // A database from before v55: no table, and (Postgres) no v55 in schema_migrations.
    await sql.run("DROP TABLE model_allowlist_entries");
    if (sql.kind === "postgres") await sql.run("DELETE FROM schema_migrations WHERE version = 55");
    await context.app.close();
    await context.store.close();
    const reopened = await openTestStore(context.file);
    try {
      expect(await reopened.listModelAllowlistEntries()).toEqual([]);
      if (sql.kind === "postgres") {
        const versions = await testSql(reopened).all<{ version: number | string }>("SELECT version FROM schema_migrations WHERE version >= 52 ORDER BY version");
        expect(versions.map((row) => Number(row.version))).toEqual([52, 53, 54, 55]);
      }
      const entry: ModelAllowlistEntry = { id: "mal_1", scope: "project", projectId: "p1", providerId: "openai", modelGlob: "gpt-4o*", note: null, createdAt: new Date().toISOString(), createdBy: "a@example.com" };
      expect(await reopened.insertModelAllowlistEntry(entry, 200)).toEqual({ ok: true, entry });
      expect(await reopened.insertModelAllowlistEntry({ ...entry, id: "mal_2" }, 200)).toEqual({ ok: false, reason: "duplicate" });
      expect(await reopened.insertModelAllowlistEntry({ ...entry, id: "mal_3", modelGlob: "other" }, 1)).toEqual({ ok: false, reason: "limit" });
      // Another scope has its own limit.
      expect((await reopened.insertModelAllowlistEntry({ ...entry, id: "mal_4", scope: "deployment", projectId: null }, 1)).ok).toBe(true);
      expect((await reopened.listModelAllowlistEntries()).map((row) => [row.id, row.scope, row.projectId])).toEqual([
        ["mal_4", "deployment", null],
        ["mal_1", "project", "p1"]
      ]);
      expect(await reopened.deleteModelAllowlistEntry("mal_1")).toMatchObject({ id: "mal_1", projectId: "p1" });
      expect(await reopened.deleteModelAllowlistEntry("mal_1")).toBeNull();
    } finally {
      await reopened.close();
    }
    contexts.splice(contexts.indexOf(context), 1);
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  });
});

describe("with no entries", () => {
  it("every call path runs as before, the echo provider included", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerSamplingServer(context, admin);
    await context.store.upsertWorkflow(llmWorkflow("wf-llm", "p1", "anything"));
    await context.store.upsertWorkflow(agentWorkflow("wf-agent", "p1", "anything"));
    await context.store.upsertWorkflow(supervisorWorkflow("wf-sup", "anything"));
    await context.store.upsertWorkflow(samplingWorkflow("wf-sample", serverId));
    expect((await run(context, admin, "wf-llm")).status).toBe("success");
    expect((await run(context, admin, "wf-agent")).status).toBe("success");
    expect((await run(context, admin, "wf-sup")).status).toBe("success");
    const sampled = await run(context, admin, "wf-sample");
    expect(sampled.status, JSON.stringify(sampled.nodeResults)).toBe("success");
    const test = await caller(context)(admin, "POST", "/api/providers/test", { provider: { providerId: "echo", model: "anything" }, projectId: "p1" });
    expect(test.statusCode).toBe(200);
    expect(await deniedEvents(context.store)).toEqual([]);
    const validation = await caller(context)(admin, "POST", "/api/workflows/wf-llm/validate", {});
    expect(validation.json<WorkflowValidationResult>().issues).toEqual([]);
  });
});

describe("enforcement", () => {
  it("the LLM node: a deployment list allows and denies by glob, with a typed node error and one audit event per run", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "allowed-*" });
    await context.store.upsertWorkflow(llmWorkflow("wf-ok", "p1", "allowed-small"));
    await context.store.upsertWorkflow(llmWorkflow("wf-denied", "p1", "other-model"));
    await context.store.upsertWorkflow(llmWorkflow("wf-other-provider", "p1", "allowed-small", "ollama"));
    expect((await run(context, admin, "wf-ok")).status).toBe("success");
    const denied = await run(context, admin, "wf-denied");
    expect(denied.status).toBe("error");
    expect(denied.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({
      status: "error",
      errorCategory: "model_not_allowed",
      retryable: false,
      error: 'Model "other-model" on provider "echo" is not on this deployment\'s model allowlist.'
    });
    // The provider id is part of the match: the same model name on ollama is refused before any request is made.
    const otherProvider = await run(context, admin, "wf-other-provider");
    expect(otherProvider.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(2);
    const event = events.find((entry) => (entry.metadata as { model: string }).model === "other-model")!;
    expect(event).toMatchObject({ outcome: "denied", projectId: "p1" });
    expect(event.metadata).toMatchObject({ providerId: "echo", refusedBy: "deployment", source: "run", nodeId: "llm", executionId: denied.executionId, workflowId: "wf-denied" });
  });

  it("a project list narrows the deployment list and cannot widen it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "*" });
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    await context.store.upsertWorkflow(llmWorkflow("p1-small", "p1", "small"));
    await context.store.upsertWorkflow(llmWorkflow("p1-large", "p1", "large"));
    await context.store.upsertWorkflow(llmWorkflow("p2-large", "p2", "large"));
    expect((await run(context, admin, "p1-small")).status).toBe("success");
    const narrowed = await run(context, admin, "p1-large");
    expect(narrowed.nodeResults.find((entry) => entry.nodeId === "llm")?.error).toBe('Model "large" on provider "echo" is not on the model allowlist of project "p1".');
    expect((await run(context, admin, "p2-large")).status).toBe("success");

    // A project entry for a provider the deployment list leaves out does not let it through.
    await addEntry(context, admin, { scope: "project", projectId: "p2", providerId: "ollama", modelGlob: "*" });
    await context.store.upsertWorkflow(llmWorkflow("p2-ollama", "p2", "llama3.1", "ollama"));
    const widened = await run(context, admin, "p2-ollama");
    expect(widened.nodeResults.find((entry) => entry.nodeId === "llm")?.error).toContain("not on this deployment's model allowlist");
  });

  it("an agent's attached chat model and a supervisor's worker are covered", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await addEntry(context, admin, { scope: "deployment", providerId: "*", modelGlob: "boss" });
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "ok-*" });
    await context.store.upsertWorkflow(agentWorkflow("wf-agent-ok", "default", "ok-agent"));
    await context.store.upsertWorkflow(agentWorkflow("wf-agent-denied", "default", "agent-model"));
    expect((await run(context, admin, "wf-agent-ok")).status).toBe("success");
    const agent = await run(context, admin, "wf-agent-denied");
    expect(agent.nodeResults.find((entry) => entry.nodeId === "agent")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });

    await context.store.upsertWorkflow(supervisorWorkflow("wf-sup", "worker-model"));
    const supervisor = await run(context, admin, "wf-sup");
    // The worker's refusal reaches the supervisor as the delegation's tool error, like any failed worker.
    const steps = (supervisor.nodeResults.find((entry) => entry.nodeId === "boss")?.output as { steps: Array<{ toolResults: Array<{ toolName: string; error?: string }> }> }).steps;
    expect(steps[0]!.toolResults[0]).toMatchObject({ toolName: "delegate_to_Worker", error: 'Model "worker-model" on provider "echo" is not on this deployment\'s model allowlist.' });
    const events = await deniedEvents(context.store);
    expect(events.map((event) => (event.metadata as { model: string }).model).sort()).toEqual(["agent-model", "worker-model"]);
  });

  it("MCP sampling in a run is refused as a sampling error", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerSamplingServer(context, admin);
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "not-the-sampler" });
    await context.store.upsertWorkflow(samplingWorkflow("wf-sample", serverId));
    const result = await run(context, admin, "wf-sample");
    const node = result.nodeResults.find((entry) => entry.nodeId === "tool");
    expect(node?.status).toBe("error");
    expect(node?.error).toContain('Model "sampler-model" on provider "echo" is not on this deployment\'s model allowlist.');
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ model: "sampler-model", source: "run", workflowId: "wf-sample" });
  });

  it("gateway sampling uses the toolset's project list and answers with a tool error", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerSamplingServer(context, admin);
    const toolsetResponse = await call(admin, "POST", "/api/mcp/toolsets", { name: "Gateway tools", projectId: "p1", members: [{ kind: "server", serverId }] });
    expect(toolsetResponse.statusCode, toolsetResponse.body).toBe(201);
    const toolset = toolsetResponse.json<{ toolset: McpToolset }>().toolset;
    const clientResponse = await call(admin, "POST", "/api/mcp/clients", { name: "IDE agent", toolsetIds: [toolset.id], role: "builder" });
    const { client, token } = clientResponse.json<{ client: McpClient; token: string }>();
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${toolset.slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "allowlist-test", version: "1" } } });
    const sessionId = init.headers["mcp-session-id"] as string;
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
    const name = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name).find((tool) => tool.endsWith("__summarize_with_model"))!;
    const summarize = async (id: number) => {
      const response = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text: "hello world" } } }, { "mcp-session-id": sessionId });
      expect(response.statusCode).toBe(200);
      return response.json<{ result: { isError?: boolean; content: Array<{ text?: string }> } }>().result;
    };
    expect((await summarize(3)).isError).not.toBe(true);

    // Another project's list does not apply; the toolset's project's list does.
    await addEntry(context, admin, { scope: "project", projectId: "p2", providerId: "echo", modelGlob: "nothing" });
    expect((await summarize(4)).isError).not.toBe(true);
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "nothing" });
    const refused = await summarize(5);
    expect(refused.isError).toBe(true);
    expect(refused.content.map((part) => part.text ?? "").join(" ")).toContain('is not on the model allowlist of project "p1"');
    await summarize(6);
    // Audited once per session, node, provider and model.
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: "p1" });
    expect(events[0]!.metadata).toMatchObject({ source: "gateway_sampling", clientId: client.id, toolsetId: toolset.id, model: "sampler-model", refusedBy: "project" });
  });

  it("the provider test panel is refused with 403: the editor's project, else the secret's project, else default", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const call = caller(context);
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    const p1Secret = await context.secretService.createSecret({ name: "P1 key", provider: "echo", value: "p1-key-value", projectId: "p1" });
    const defaultSecret = await context.secretService.createSecret({ name: "Default key", provider: "echo", value: "default-key-value" });
    const probe = (model: string, input: { projectId?: string; secretId?: string } = {}) =>
      call(admin, "POST", "/api/providers/test", {
        provider: { providerId: "echo", model, ...(input.secretId ? { secretRef: { secretId: input.secretId } } : {}) },
        ...(input.projectId ? { projectId: input.projectId } : {})
      });
    // No project, no secret: the default project's list (empty here).
    expect((await probe("large")).statusCode).toBe(200);
    expect((await probe("large", { secretId: defaultSecret.secretId })).statusCode).toBe(200);
    expect((await probe("small", { projectId: "p1" })).statusCode).toBe(200);
    const refused = await probe("large", { projectId: "p1" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ ok: false, code: "MODEL_NOT_ALLOWED", providerId: "echo", model: "large", refusedBy: "project" });
    // A p1 secret with no projectId: p1's list applies, and naming another project does not get around it.
    expect((await probe("large", { secretId: p1Secret.secretId })).json()).toMatchObject({ code: "MODEL_NOT_ALLOWED", refusedBy: "project" });
    expect((await probe("large", { secretId: p1Secret.secretId, projectId: "p2" })).statusCode).toBe(403);
    // The default project's list applies to a test with no project and no secret.
    await addEntry(context, admin, { scope: "project", projectId: "default", providerId: "echo", modelGlob: "tiny" });
    expect((await probe("large")).statusCode).toBe(403);
    await addEntry(context, admin, { scope: "deployment", providerId: "openai", modelGlob: "*" });
    expect((await probe("small", { projectId: "p1" })).json()).toMatchObject({ refusedBy: "deployment" });
    const events = await deniedEvents(context.store);
    expect(events.map((event) => (event.metadata as { source: string }).source)).toEqual(Array(events.length).fill("provider_test"));
    expect(events.map((event) => event.projectId).sort()).toEqual(["default", "p1", "p1", "p1", "p1"]);
  });
});

describe("builder warnings and the check endpoint", () => {
  it("validation warns (the workflow stays valid) and the check answers for a project, Azure deployments included", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const call = caller(context);
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "ok" });
    await addEntry(context, admin, { scope: "deployment", providerId: "azure_openai", modelGlob: "prod-*" });
    await context.store.upsertWorkflow(llmWorkflow("wf-warn", "p1", "not-ok"));
    const validation = (await call(builder, "POST", "/api/workflows/wf-warn/validate", {})).json<WorkflowValidationResult>();
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([
      expect.objectContaining({ code: "model_not_allowed", severity: "warning", nodeId: "llm", message: expect.stringContaining('Ask: Model "not-ok" on provider "echo"') })
    ]);
    // Saving is not refused.
    const saved = await call(builder, "PUT", "/api/workflows/wf-warn", { ...llmWorkflow("wf-warn", "default", "still-not-ok") });
    expect(saved.statusCode, saved.body).toBe(200);

    const check = async (query: string) => (await call(builder, "GET", `/api/model-allowlist/check?${query}`)).json<Record<string, unknown>>();
    expect(await check("providerId=echo&model=ok&projectId=p1")).toMatchObject({ allowed: true, reason: "allowed", model: "ok", projectId: "p1" });
    expect(await check("providerId=echo&model=nope")).toMatchObject({ allowed: false, reason: "deployment" });
    expect(await check("providerId=azure_openai&model=x&deployment=prod-eu")).toMatchObject({ allowed: true, model: "prod-eu" });
    expect((await call(builder, "GET", "/api/model-allowlist/check")).statusCode).toBe(400);
  });

  it("N1: validation warns for a RAG node's embedder and the Azure OpenAI embeddings deployment, not the token embedder", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const call = caller(context);
    await addEntry(context, admin, { scope: "deployment", providerId: "ollama", modelGlob: "*" });
    await context.store.upsertWorkflow({
      id: "wf-embed-warn",
      name: "Embed warn",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "p1",
      nodes: [
        { id: "text", type: "text_input", name: "Text", position, config: { text: "find it" } },
        { id: "rag", type: "rag_retrieve", name: "Retrieve", position, config: { embedderId: "openai-embedder", vectorStoreId: "in-memory-vector-store" } },
        { id: "local", type: "rag_retrieve", name: "Local", position, config: { embedderId: "token-embedder", vectorStoreId: "in-memory-vector-store" } },
        { id: "embed", type: "embeddings_azure_openai", name: "Embed", position, config: { endpoint: "https://x.openai.azure.com", deployment: "prod-embed" } },
        { id: "out", type: "output", name: "Out", position, config: {} }
      ],
      edges: [
        { id: "e1", source: "text", target: "rag" },
        { id: "e2", source: "rag", target: "local" },
        { id: "e3", source: "local", target: "embed" },
        { id: "e4", source: "embed", target: "out" }
      ]
    });
    // Other issues of this sketch workflow (missing secrets) do not matter here: only the allowlist's warnings.
    const validation = (await call(builder, "POST", "/api/workflows/wf-embed-warn/validate", {})).json<WorkflowValidationResult>();
    expect(validation.issues.filter((issue) => issue.code === "model_not_allowed")).toEqual([
      expect.objectContaining({ severity: "warning", nodeId: "rag", message: expect.stringContaining('Retrieve: Model "text-embedding-3-small" on provider "openai"') }),
      expect.objectContaining({ severity: "warning", nodeId: "embed", message: expect.stringContaining('Embed: Model "prod-embed" on provider "azure_openai"') })
    ]);
  });

  it("N4: a check without a project answers for the default project, whose list a project-less workflow's runs use", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const call = caller(context);
    await addEntry(context, admin, { scope: "project", projectId: "default", providerId: "echo", modelGlob: "small" });
    const unscoped = llmWorkflow("wf-no-project", "default", "large");
    delete (unscoped as Partial<Workflow>).projectId;
    await context.store.upsertWorkflow(unscoped);
    expect((await run(context, admin, "wf-no-project")).nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
    // The builder has no role in the default project; the implicit default still answers, as the run would refuse.
    expect((await call(builder, "GET", "/api/model-allowlist/check?providerId=echo&model=large")).json()).toMatchObject({ allowed: false, reason: "project", projectId: "default" });
    expect((await call(builder, "GET", "/api/model-allowlist/check?providerId=echo&model=small")).json()).toMatchObject({ allowed: true, projectId: "default" });
    // Naming a project still needs access to it.
    expect((await call(builder, "GET", "/api/model-allowlist/check?providerId=echo&model=small&projectId=default")).statusCode).toBe(403);
  });
});

describe("editing the lists", () => {
  it("admins add and remove entries (audited); builders and viewers read only", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const call = caller(context);
    expect((await call(builder, "POST", "/api/model-allowlist", { scope: "deployment", providerId: "echo", modelGlob: "*" })).statusCode).toBe(403);
    const entry = await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "openai", modelGlob: "gpt-4o*", note: "Approved by security" });
    expect(entry).toMatchObject({ scope: "project", projectId: "p1", providerId: "openai", modelGlob: "gpt-4o*", note: "Approved by security", createdBy: "admin@example.com" });
    expect((await call(admin, "POST", "/api/model-allowlist", { scope: "project", projectId: "p1", providerId: "openai", modelGlob: "gpt-4o*" })).statusCode).toBe(409);
    expect((await call(admin, "POST", "/api/model-allowlist", { scope: "project", projectId: "missing", providerId: "openai", modelGlob: "*" })).statusCode).toBe(404);
    expect((await call(admin, "POST", "/api/model-allowlist", { scope: "project", providerId: "openai", modelGlob: "*" })).statusCode).toBe(400);

    const asBuilder = (await call(builder, "GET", "/api/model-allowlist")).json<{ entries: ModelAllowlistEntry[]; providers: Array<{ id: string }>; canEdit: boolean }>();
    expect(asBuilder.canEdit).toBe(false);
    expect(asBuilder.entries.map((row) => row.id)).toEqual([entry.id]);
    // Notes and who added an entry are for admins.
    expect(asBuilder.entries[0]).toMatchObject({ note: null, createdBy: null });
    expect(asBuilder.providers.map((provider) => provider.id)).toEqual(expect.arrayContaining(["*", "echo", "openai", "azure_openai", "gemini", "mistral", "cohere", "huggingface"]));
    // Viewers and operators do not read the lists or the check.
    expect((await call(viewer, "GET", "/api/model-allowlist")).statusCode).toBe(403);
    expect((await call(viewer, "GET", "/api/model-allowlist/check?providerId=echo&model=x")).statusCode).toBe(403);
    const asAdmin = (await call(admin, "GET", "/api/model-allowlist")).json<{ canEdit: boolean; entries: ModelAllowlistEntry[] }>();
    expect(asAdmin.canEdit).toBe(true);
    expect(asAdmin.entries[0]).toMatchObject({ note: "Approved by security", createdBy: "admin@example.com" });
    // Provider ids and patterns are stored lower case, so a case variant is a duplicate.
    expect((await call(admin, "POST", "/api/model-allowlist", { scope: "project", projectId: "p1", providerId: "OpenAI", modelGlob: "GPT-4o*" })).statusCode).toBe(409);

    expect((await call(builder, "DELETE", `/api/model-allowlist/${entry.id}`)).statusCode).toBe(403);
    expect((await call(admin, "DELETE", `/api/model-allowlist/${entry.id}`)).statusCode).toBe(200);
    expect((await call(admin, "DELETE", `/api/model-allowlist/${entry.id}`)).statusCode).toBe(404);

    const added = (await context.store.listAuditLogs({ eventType: "model_allowlist.entry_added", pageSize: 10 })).items;
    const removed = (await context.store.listAuditLogs({ eventType: "model_allowlist.entry_removed", pageSize: 10 })).items;
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ resourceId: entry.id, projectId: "p1", actorEmail: "admin@example.com" });
    expect(added[0]!.metadata).toMatchObject({ scope: "project", providerId: "openai", modelGlob: "gpt-4o*" });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ resourceId: entry.id });
  });
});

describe("replays", () => {
  it("a tape replay reports what the allowlist would refuse and uses the recorded answer; a live replay is refused", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const call = caller(context);
    await context.store.upsertWorkflow(llmWorkflow("wf-golden", "p1", "recorded-model"));
    const recorded = await call(admin, "POST", "/api/workflows/wf-golden/execute", { record: true });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const executionId = recorded.json<{ executionId: string }>().executionId;
    const golden = await call(admin, "POST", "/api/replay/recordings", { executionId, name: "Baseline" });
    expect(golden.statusCode, golden.body).toBe(201);
    const recordingId = golden.json<{ recording: { id: string } }>().recording.id;
    const set = await call(admin, "POST", "/api/eval/datasets", { name: "Allowlist suite", workflowId: "wf-golden" });
    const setId = set.json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(admin, "POST", `/api/eval/datasets/${setId}/recordings`, { recordingId })).statusCode).toBe(201);

    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "another-model" });
    const started = await call(admin, "POST", "/api/replay/runs", { datasetIds: [setId], models: "replay" });
    expect(started.statusCode, started.body).toBe(202);
    const runId = started.json<{ run: { id: string } }>().run.id;
    let job: { status: string; summary: Record<string, number>; results: Array<{ id: string }> };
    const until = Date.now() + 30_000;
    for (;;) {
      job = (await call(admin, "GET", `/api/replay/runs/${runId}`)).json<{ run: typeof job }>().run;
      if (!["queued", "running"].includes(job.status)) break;
      if (Date.now() > until) throw new Error("Replay job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(job.summary).toMatchObject({ total: 1, pass: 1 });
    const detail = (await call(admin, "GET", `/api/replay/runs/${runId}/results/${job.results[0]!.id}`)).json<{
      result: { replay: { diff: { health: Array<{ kind: string; nodeId: string | null; blocking: boolean; message: string }> } } };
    }>().result;
    expect(detail.replay.diff.health.filter((warning) => warning.kind === "model_not_allowed")).toEqual([
      { kind: "model_not_allowed", nodeId: "llm", blocking: false, message: expect.stringContaining('Model "recorded-model" on provider "echo" is not on the model allowlist of project "p1".') }
    ]);
    // Reported, not refused: no refusal is audited.
    expect(await deniedEvents(context.store)).toEqual([]);

    // A replay with live models makes a new call: refused like any run.
    const live = await call(admin, "POST", `/api/replay/recordings/${recordingId}/replay`, {});
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json<{ verdict: string }>().verdict).not.toBe("pass");
    expect((await deniedEvents(context.store)).map((event) => (event.metadata as { source: string }).source)).toEqual(["run"]);
  }, 60_000);
});

/** Records a golden run of `workflowId` and puts it in a new dataset; returns the recording and dataset ids. */
async function goldenDataset(context: TestContext, admin: string, workflowId: string) {
  const call = caller(context);
  const recorded = await call(admin, "POST", `/api/workflows/${workflowId}/execute`, { record: true });
  expect(recorded.statusCode, recorded.body).toBe(200);
  const executionId = recorded.json<{ executionId: string }>().executionId;
  const golden = await call(admin, "POST", "/api/replay/recordings", { executionId, name: "Baseline" });
  expect(golden.statusCode, golden.body).toBe(201);
  const recordingId = golden.json<{ recording: { id: string } }>().recording.id;
  const set = await call(admin, "POST", "/api/eval/datasets", { name: `Suite ${workflowId}`, workflowId });
  const setId = set.json<{ dataset: { id: string } }>().dataset.id;
  expect((await call(admin, "POST", `/api/eval/datasets/${setId}/recordings`, { recordingId })).statusCode).toBe(201);
  return { recordingId, setId, goldenExecutionId: executionId };
}

interface JobResultDetail {
  replay: { executionId?: string; diff: { health: Array<{ kind: string; nodeId: string | null; blocking: boolean; message: string }> } };
  score?: { details: Array<{ type: string; pass: boolean; message?: string; error?: string }> };
}

async function runJob(context: TestContext, admin: string, body: Record<string, unknown>): Promise<{ job: { status: string; summary: Record<string, number> }; detail: JobResultDetail }> {
  const call = caller(context);
  const started = await call(admin, "POST", "/api/replay/runs", body);
  expect(started.statusCode, started.body).toBe(202);
  const runId = started.json<{ run: { id: string } }>().run.id;
  let job: { status: string; summary: Record<string, number>; results: Array<{ id: string }> };
  const until = Date.now() + 30_000;
  for (;;) {
    job = (await call(admin, "GET", `/api/replay/runs/${runId}`)).json<{ run: typeof job }>().run;
    if (!["queued", "running"].includes(job.status)) break;
    if (Date.now() > until) throw new Error("Replay job did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = (await call(admin, "GET", `/api/replay/runs/${runId}/results/${job.results[0]!.id}`)).json<{ result: JobResultDetail }>().result;
  return { job, detail };
}

describe("replays and recorded runs (fixes)", () => {
  it("a lenient replay's tape miss is a live call: the project's list refuses it, audited once as a run", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(llmWorkflow("wf-lenient", "p1", "recorded-model"));
    const { setId } = await goldenDataset(context, admin, "wf-lenient");
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "recorded-model" });
    // The draft switched the node to a model p1 does not allow: the tape has no answer for it.
    await context.store.upsertWorkflow(llmWorkflow("wf-lenient", "p1", "switched-model"));
    const { detail } = await runJob(context, admin, { datasetIds: [setId], models: "replay", mcpMode: "lenient", draft: true });
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: "p1" });
    expect(events[0]!.metadata).toMatchObject({ source: "run", model: "switched-model", refusedBy: "project", nodeId: "llm", workflowId: "wf-lenient", executionId: expect.any(String) });
    const execution = await context.store.getExecutionHistory((events[0]!.metadata as { executionId: string }).executionId);
    const nodeResults = (execution as { nodeResults?: Array<{ nodeId: string; status: string; errorCategory?: string }> } | null)?.nodeResults ?? [];
    expect(nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
    // Nothing was answered from the tape, so nothing claims "the recorded answer".
    expect(detail.replay.diff.health.filter((warning) => warning.kind === "model_not_allowed")).toEqual([]);
  }, 60_000);

  it("a recorded run is checked once, by the run's own project view", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "ok-*" });
    await context.store.upsertWorkflow(llmWorkflow("wf-rec-ok", "p1", "ok-model"));
    await context.store.upsertWorkflow(llmWorkflow("wf-rec-denied", "p1", "other"));
    const call = caller(context);
    const ok = await call(admin, "POST", "/api/workflows/wf-rec-ok/execute", { record: true });
    expect(ok.json<{ status: string }>().status).toBe("success");
    const denied = await call(admin, "POST", "/api/workflows/wf-rec-denied/execute", { record: true });
    const result = denied.json<RunResult>();
    expect(result.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ source: "run", executionId: result.executionId, refusedBy: "deployment" });
  });

  it("an eval judge's model is checked against the workflow's project list", async () => {
    const context = await createTestContext({ EVAL_JUDGE_ENABLED: "true", EVAL_JUDGE_ALLOW_ENV_CREDENTIALS: "true" });
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(llmWorkflow("wf-judged", "p1", "recorded-model"));
    const { setId } = await goldenDataset(context, admin, "wf-judged");
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "recorded-model" });
    const { detail } = await runJob(context, admin, { datasetIds: [setId], models: "replay", scorers: [{ type: "llm_judge", rubric: "It answers.", providerId: "echo", model: "judge-model" }] });
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: "p1" });
    expect(events[0]!.metadata).toMatchObject({ source: "eval_judge", model: "judge-model", workflowId: "wf-judged" });
    const judge = detail.score?.details.find((entry) => entry.type === "llm_judge");
    expect(judge?.pass).toBe(false);
    expect(JSON.stringify(judge)).toContain("is not on the model allowlist of project");
  }, 60_000);
});

describe("sub-workflows and error workflows use their own project's list", () => {
  /** p1's caller runs p2's child (shared to p1 with execute); the child's LLM uses `model`. */
  async function crossProject(context: TestContext, admin: string, model: string) {
    const call = caller(context);
    await context.store.upsertWorkflow(llmWorkflow("wf-child", "p2", model));
    await context.store.upsertWorkflow({
      id: "wf-parent",
      name: "Parent",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "p1",
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position, config: {} },
        { id: "sub", type: "execute_workflow", name: "Sub", position, config: { workflowId: "wf-child", mode: "sync" } },
        { id: "out", type: "output", name: "Out", position, config: {} }
      ],
      edges: [
        { id: "e1", source: "start", target: "sub" },
        { id: "e2", source: "sub", target: "out" }
      ]
    });
    expect((await call(admin, "POST", "/api/workflows/wf-child/shares", { projectId: "p1", accessLevel: "execute" })).statusCode).toBe(200);
  }

  it("a parent's narrow list does not apply to another project's child", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await crossProject(context, admin, "large");
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    const result = await run(context, admin, "wf-parent");
    expect(result.status, JSON.stringify(result.nodeResults)).toBe("success");
    expect(await deniedEvents(context.store)).toEqual([]);
  });

  it("the child's own narrow list applies when the parent's project allows the model", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await crossProject(context, admin, "large");
    await addEntry(context, admin, { scope: "project", projectId: "p2", providerId: "echo", modelGlob: "small" });
    const result = await run(context, admin, "wf-parent");
    expect(result.status).toBe("error");
    expect(JSON.stringify(result.nodeResults)).toContain('is not on the model allowlist of project \\"p2\\"');
    const events = await deniedEvents(context.store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: "p2" });
    expect(events[0]!.metadata).toMatchObject({ source: "run", workflowId: "wf-child", executionId: result.executionId });
  });

  it("an error workflow is checked for its own project, audited once per failed run", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const call = caller(context);
    await context.store.upsertWorkflow(llmWorkflow("wf-on-error", "p2", "large"));
    expect((await call(admin, "POST", "/api/workflows/wf-on-error/shares", { projectId: "p1", accessLevel: "execute" })).statusCode).toBe(200);
    await context.store.upsertWorkflow({
      id: "wf-fails",
      name: "Fails",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "p1",
      settings: { errorWorkflowId: "wf-on-error" },
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position, config: {} },
        { id: "sub", type: "execute_workflow", name: "Missing", position, config: { workflowId: "does-not-exist" } },
        { id: "out", type: "output", name: "Out", position, config: {} }
      ],
      edges: [
        { id: "e1", source: "start", target: "sub" },
        { id: "e2", source: "sub", target: "out" }
      ]
    } as Workflow);
    await addEntry(context, admin, { scope: "project", projectId: "p2", providerId: "echo", modelGlob: "small" });
    const failed = await run(context, admin, "wf-fails");
    expect(failed.status).toBe("error");
    await vi.waitFor(async () => expect(await deniedEvents(context.store)).toHaveLength(1), { timeout: 5000 });
    const [event] = await deniedEvents(context.store);
    expect(event).toMatchObject({ projectId: "p2" });
    expect(event!.metadata).toMatchObject({ source: "run", workflowId: "wf-on-error", sourceExecutionId: failed.executionId, nodeId: "llm" });
  });
});

describe("embeddings (RAG and knowledge bases)", () => {
  it("a RAG node's embedder is checked for the workflow's project, before any text is sent", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await addEntry(context, admin, { scope: "deployment", providerId: "ollama", modelGlob: "*" });
      await context.store.upsertWorkflow({
        id: "wf-rag",
        name: "RAG",
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        projectId: "p1",
        nodes: [
          { id: "text", type: "text_input", name: "Text", position, config: { text: "find it" } },
          { id: "rag", type: "rag_retrieve", name: "Retrieve", position, config: { embedderId: "openai-embedder", vectorStoreId: "in-memory-vector-store", documents: [{ id: "d1", text: "a document" }], retry: { enabled: false } } },
          { id: "out", type: "output", name: "Out", position, config: {} }
        ],
        edges: [
          { id: "e1", source: "text", target: "rag" },
          { id: "e2", source: "rag", target: "out" }
        ]
      });
      const result = await run(context, admin, "wf-rag");
      expect(result.nodeResults.find((entry) => entry.nodeId === "rag")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("api.openai.com"))).toEqual([]);
      const events = await deniedEvents(context.store);
      expect(events).toHaveLength(1);
      expect(events[0]!.metadata).toMatchObject({ source: "run", operation: "embed", providerId: "openai", model: "text-embedding-3-small", nodeId: "rag" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("knowledge-base ingest and search refuse an embedder the knowledge base's project does not allow", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const call = caller(context);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const created = await call(admin, "POST", "/api/knowledge-bases", { name: "Docs", projectId: "p1", embedderId: "mistral-embedder", embedderConfig: {} });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const kbId = created.json<{ knowledgeBase?: { id: string }; id?: string }>().knowledgeBase?.id ?? created.json<{ id: string }>().id;
      await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "openai", modelGlob: "*" });
      const ingest = await call(admin, "POST", `/api/knowledge-bases/${kbId}/ingest`, { documents: [{ content: "a document" }] });
      expect(ingest.statusCode).toBe(403);
      expect(ingest.json()).toMatchObject({ code: "MODEL_NOT_ALLOWED", error: expect.stringContaining('Model "mistral-embed" on provider "mistral"') });
      const search = await call(admin, "POST", `/api/knowledge-bases/${kbId}/search`, { query: "find" });
      expect(search.statusCode).toBe(403);
      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("api.mistral.ai"))).toEqual([]);
      const events = await deniedEvents(context.store);
      expect(events.map((event) => event.metadata)).toEqual([
        expect.objectContaining({ source: "knowledge_base", knowledgeBaseId: kbId, operation: "embed" }),
        expect.objectContaining({ source: "knowledge_base", knowledgeBaseId: kbId, operation: "embed" })
      ]);
      // The local token embedder is not a model call.
      const local = await call(admin, "POST", "/api/knowledge-bases", { name: "Local", projectId: "p1", embedderId: "token-embedder", embedderConfig: {} });
      const localId = local.json<{ knowledgeBase?: { id: string }; id?: string }>().knowledgeBase?.id ?? local.json<{ id: string }>().id;
      expect((await call(admin, "POST", `/api/knowledge-bases/${localId}/ingest`, { documents: [{ content: "a document" }] })).statusCode).toBeLessThan(300);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("reads and project lifecycle", () => {
  it("a builder reads the deployment list and the projects they can read; the check refuses other projects", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const call = caller(context);
    const builderUser = (await context.store.getUserByEmail("builder@example.com"))!;
    await context.store.upsertProjectRole({ userId: builderUser.id, projectId: "p1", role: "editor" });
    const deployment = await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "*" });
    const p1 = await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    await addEntry(context, admin, { scope: "project", projectId: "p2", providerId: "echo", modelGlob: "secret-model", note: "p2 only" });
    const listed = (await call(builder, "GET", "/api/model-allowlist")).json<{ entries: ModelAllowlistEntry[] }>();
    expect(listed.entries.map((entry) => entry.id).sort()).toEqual([deployment.id, p1.id].sort());
    expect((await call(builder, "GET", "/api/model-allowlist/check?providerId=echo&model=small&projectId=p1")).json()).toMatchObject({ allowed: true });
    expect((await call(builder, "GET", "/api/model-allowlist/check?providerId=echo&model=small&projectId=p2")).statusCode).toBe(403);
    expect((await call(admin, "GET", "/api/model-allowlist/check?providerId=echo&model=small&projectId=p2")).json()).toMatchObject({ allowed: false, reason: "project" });
  });

  it("deleting a project deletes its entries, so a re-created project starts with none", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const call = caller(context);
    await context.store.upsertProject({ id: "payments", name: "Payments" });
    await addEntry(context, admin, { scope: "project", projectId: "payments", providerId: "echo", modelGlob: "small" });
    const kept = await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    expect((await call(admin, "DELETE", "/api/projects/payments")).statusCode).toBe(200);
    expect((await context.store.listModelAllowlistEntries()).map((entry) => entry.id)).toEqual([kept.id]);
    await context.store.upsertProject({ id: "payments", name: "Payments again" });
    await context.store.upsertWorkflow(llmWorkflow("wf-payments", "payments", "large"));
    expect((await run(context, admin, "wf-payments")).status).toBe("success");
  });

  it("a gateway toolset with no project uses the default project's list", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerSamplingServer(context, admin);
    const toolsetResponse = await call(admin, "POST", "/api/mcp/toolsets", { name: "Shared tools", members: [{ kind: "server", serverId }] });
    expect(toolsetResponse.statusCode, toolsetResponse.body).toBe(201);
    const toolset = toolsetResponse.json<{ toolset: McpToolset }>().toolset;
    expect(toolset.projectId ?? null).toBeNull();
    const { token } = (await call(admin, "POST", "/api/mcp/clients", { name: "IDE agent", toolsetIds: [toolset.id], role: "builder" })).json<{ client: McpClient; token: string }>();
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${toolset.slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "allowlist-test", version: "1" } } });
    const sessionId = init.headers["mcp-session-id"] as string;
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
    const name = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name).find((tool) => tool.endsWith("__summarize_with_model"))!;
    await addEntry(context, admin, { scope: "project", projectId: "default", providerId: "echo", modelGlob: "nothing" });
    const response = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: { text: "hello world" } } }, { "mcp-session-id": sessionId });
    const result = response.json<{ result: { isError?: boolean; content: Array<{ text?: string }> } }>().result;
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.text ?? "").join(" ")).toContain('is not on the model allowlist of project "default"');
  });
});

describe("the allowlist snapshot", () => {
  it("with no entries a run survives a store read failure; an edit applies on this instance at once", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(llmWorkflow("wf-snap", "p1", "large"));
    const read = vi.spyOn(context.store, "listModelAllowlistEntries");
    read.mockRejectedValue(new Error("pool timeout"));
    try {
      expect((await run(context, admin, "wf-snap")).status).toBe("success");
    } finally {
      read.mockRestore();
    }
    const counted = vi.spyOn(context.store, "listModelAllowlistEntries");
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "small" });
    const readsAfterEdit = counted.mock.calls.length;
    const refused = await run(context, admin, "wf-snap");
    expect(refused.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ errorCategory: "model_not_allowed" });
    // The run's model call read nothing from the store (the 2 s background re-read may land once meanwhile).
    expect(counted.mock.calls.length - readsAfterEdit).toBeLessThanOrEqual(1);
    counted.mockRestore();
  });
});

describe("with gateway Guard and gateway budgets", () => {
  /** One token costs one dollar for these echo models, so any charged call shows a cost. */
  const PRICING = JSON.stringify({ echo: { "sampler-model": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 }, priced: { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 } } });

  it("a refused gateway sampling call is audited and recorded with its toolset, and its cost is not charged", async () => {
    const context = await createTestContext({ LLM_PRICING_OVERRIDES_JSON: PRICING });
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerSamplingServer(context, admin);
    const toolset = (await call(admin, "POST", "/api/mcp/toolsets", { name: "Gateway tools", projectId: "p1", members: [{ kind: "server", serverId }] })).json<{ toolset: McpToolset }>().toolset;
    const { client, token } = (await call(admin, "POST", "/api/mcp/clients", { name: "IDE agent", toolsetIds: [toolset.id], role: "builder" })).json<{ client: McpClient; token: string }>();
    const budget = await call(admin, "POST", "/api/budgets", { name: "IDE dollars", scopeType: "mcp_client", scopeId: client.id, limitType: "usd", limitValue: 1_000_000, action: "warn", period: "month", warnThresholdPct: 0.8 });
    expect(budget.statusCode, budget.body).toBe(200);
    const clientSpend = async () =>
      (await call(admin, "GET", `/api/mcp/clients/${client.id}/budgets`)).json<{ budgets: Array<{ name: string; current?: number }> }>().budgets.find((entry) => entry.name === "IDE dollars")!.current ?? 0;
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${toolset.slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "allowlist-test", version: "1" } } });
    const sessionId = init.headers["mcp-session-id"] as string;
    const listed = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sessionId });
    const name = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name).find((tool) => tool.endsWith("__summarize_with_model"))!;
    const summarize = async (id: number) =>
      (await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { text: "hello world" } } }, { "mcp-session-id": sessionId })).json<{ result: { isError?: boolean } }>().result;
    const rows = async () =>
      (await context.store.listMcpToolCallsForClient(client.id, new Date(Date.now() - 60_000).toISOString())).filter((row) => row.toolName === "summarize_with_model");

    // Allowed: the sampling is priced and charged to the client's budget.
    expect((await summarize(3)).isError).not.toBe(true);
    const [allowedRow] = await rows();
    expect(allowedRow!.estimatedCostUsd).toBeGreaterThan(0);
    const spentBefore = await clientSpend();
    expect(spentBefore).toBeCloseTo(allowedRow!.estimatedCostUsd!, 6);

    // Refused by the toolset project's list: a tool error, nothing priced, nothing more charged.
    await addEntry(context, admin, { scope: "project", projectId: "p1", providerId: "echo", modelGlob: "nothing" });
    expect((await summarize(4)).isError).toBe(true);
    const refusedRow = (await rows()).find((row) => row.id !== allowedRow!.id)!;
    expect(refusedRow).toMatchObject({ source: "gateway", clientId: client.id, toolsetId: toolset.id, estimatedCostUsd: null });
    expect((refusedRow.samplingInputTokens ?? 0) + (refusedRow.samplingOutputTokens ?? 0)).toBe(0);
    expect(await clientSpend()).toBeCloseTo(spentBefore, 6);
    const [denied] = await deniedEvents(context.store);
    expect(denied!.metadata).toMatchObject({ source: "gateway_sampling", clientId: client.id, toolsetId: toolset.id, refusedBy: "project" });
  });

  it("a run's refused model call adds no tokens or cost to its usage", async () => {
    const context = await createTestContext({ LLM_PRICING_OVERRIDES_JSON: PRICING });
    const admin = await login(context, "admin");
    await context.store.upsertWorkflow(llmWorkflow("wf-priced", "p1", "priced"));
    const sql = testSql(context.store);
    const usageOf = async (executionId: string) =>
      (await sql.all<{ total_tokens: number | string; cost_usd: number | string; llm_call_count: number | string }>("SELECT total_tokens, cost_usd, llm_call_count FROM usage_events WHERE execution_id = ?", executionId)).map((row) => ({
        tokens: Number(row.total_tokens),
        cost: Number(row.cost_usd),
        calls: Number(row.llm_call_count)
      }));
    const allowed = await run(context, admin, "wf-priced");
    expect(allowed.status).toBe("success");
    const [allowedUsage] = await usageOf(allowed.executionId);
    expect(allowedUsage!.cost).toBeGreaterThan(0);

    await addEntry(context, admin, { scope: "deployment", providerId: "echo", modelGlob: "other" });
    const refused = await run(context, admin, "wf-priced");
    expect(refused.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
    for (const usage of await usageOf(refused.executionId)) expect(usage).toEqual({ tokens: 0, cost: 0, calls: 0 });
  });

  it("closing the app stops both the allowlist and the budget re-read timers", async () => {
    const context = await createTestContext();
    const allowlistReads = vi.spyOn(context.store, "listModelAllowlistEntries");
    const budgetReads = vi.spyOn(context.store, "listBudgets");
    await context.app.close();
    const after = { allowlist: allowlistReads.mock.calls.length, budgets: budgetReads.mock.calls.length };
    // Both copies are re-read every 2 s while the app runs.
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    expect({ allowlist: allowlistReads.mock.calls.length, budgets: budgetReads.mock.calls.length }).toEqual(after);
    allowlistReads.mockRestore();
    budgetReads.mockRestore();
  });
});
