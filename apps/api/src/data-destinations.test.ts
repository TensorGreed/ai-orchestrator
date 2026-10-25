/**
 * Phase 16 — data destinations over the API: anyone signed in reads, only
 * admins change rows, every change audited, built-ins read-only, plain
 * validation messages, duplicates refused, the "not classified yet" list
 * derived from configuration (scoped to what the user can read, hosts only),
 * and migration 38.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DataDestinationRow, UnclassifiedDestination, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { AuthService } from "./services/auth-service.js";
import { collectConfiguredDestinations, DataDestinationService } from "./services/data-destination-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const MASTER_KEY = crypto.randomBytes(32).toString("base64");

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-destinations-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: MASTER_KEY,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    ...overrides
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
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      context.store.close();
    } catch {
      // already closed
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function workflow(id: string, projectId: string, nodes: Array<{ id: string; type: string; name?: string; config: Record<string, unknown> }>): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: nodes.map((node, index) => ({ ...node, name: node.name ?? node.id, position: { x: index * 100, y: 0 } })),
    edges: []
  } as unknown as Workflow;
}

const corp = { name: "Corp network", kind: "http", host: "*.corp.example", tier: "private", region: "EU West 1", holdsDataClasses: ["email"] };

describe("data destination routes", () => {
  it("lets anyone signed in read, only admins change, and audits every change", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");

    expect((await context.app.inject({ method: "GET", url: "/api/data-destinations" })).statusCode).toBe(401);
    const empty = (await call(context, "GET", "/api/data-destinations", viewer.cookie)).json() as { destinations: DataDestinationRow[]; builtIns: DataDestinationRow[]; canEdit: boolean };
    expect(empty.destinations).toEqual([]);
    expect(empty.canEdit).toBe(false);
    expect(empty.builtIns.map((row) => row.id)).toContain("builtin:openai");
    expect(empty.builtIns.every((row) => row.builtIn)).toBe(true);

    expect((await call(context, "POST", "/api/data-destinations", builder.cookie, corp)).statusCode).toBe(403);
    const created = await call(context, "POST", "/api/data-destinations", admin.cookie, corp);
    expect(created.statusCode).toBe(201);
    const row = (created.json() as { destination: DataDestinationRow }).destination;
    expect(row).toMatchObject({ name: "Corp network", kind: "http", host: "*.corp.example", tier: "private", region: "eu-west-1", holdsDataClasses: ["email"], builtIn: false, createdBy: "admin@example.com" });
    expect(row.id).toMatch(/^dst_/);

    const listed = (await call(context, "GET", "/api/data-destinations", builder.cookie)).json() as { destinations: DataDestinationRow[] };
    expect(listed.destinations.map((entry) => entry.id)).toEqual([row.id]);
    expect(((await call(context, "GET", "/api/data-destinations", admin.cookie)).json() as { canEdit: boolean }).canEdit).toBe(true);

    expect((await call(context, "PUT", `/api/data-destinations/${row.id}`, builder.cookie, { ...corp, tier: "public" })).statusCode).toBe(403);
    const updated = await call(context, "PUT", `/api/data-destinations/${row.id}`, admin.cookie, { ...corp, tier: "vendor", region: "" });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { destination: DataDestinationRow }).destination).toMatchObject({ tier: "vendor", region: "unknown", updatedBy: "admin@example.com" });

    expect((await call(context, "DELETE", `/api/data-destinations/${row.id}`, viewer.cookie)).statusCode).toBe(403);
    const deleted = await call(context, "DELETE", `/api/data-destinations/${row.id}`, admin.cookie);
    expect(deleted.json()).toEqual({ deleted: true, id: row.id });
    expect((await call(context, "DELETE", `/api/data-destinations/${row.id}`, admin.cookie)).statusCode).toBe(404);
    expect((await call(context, "PUT", `/api/data-destinations/${row.id}`, admin.cookie, corp)).statusCode).toBe(404);

    const audit = context.store.listAuditLogs({ resourceType: "data_destination", pageSize: 50 }).items;
    expect(audit.map((entry) => entry.eventType).sort()).toEqual(["data_destination.created", "data_destination.deleted", "data_destination.updated"]);
    const update = audit.find((entry) => entry.eventType === "data_destination.updated")!;
    expect(JSON.stringify(update)).toContain('"tier":"private"');
    expect(JSON.stringify(update)).toContain('"tier":"vendor"');
  });

  it("explains invalid rows in plain language, refuses duplicates and keeps built-ins read-only", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const invalid = await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "x", kind: "http", host: "not a host", tier: "public" });
    expect(invalid.statusCode).toBe(400);
    const body = invalid.json() as { error: string; issues: Array<{ path: string; message: string }> };
    expect(body.error).toMatch(/Enter a host name/);
    expect(body.issues[0]!.path).toBe("host");
    expect(((await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "p", kind: "model_provider", tier: "vendor" })).json() as { error: string }).error).toMatch(/Choose the model provider/);
    // Authority and URL spellings are refused, never stored as a different host.
    for (const host of ["localhost:80@evil.com", "[::1].evil.com", "localhost:evil", "evil.com/localhost", "local\\host", "localhost?x", "local host"]) {
      const response = await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "x", kind: "http", host, tier: "local" });
      expect(response.statusCode, host).toBe(400);
      expect((response.json() as { error: string }).error, host).toMatch(/Enter a host name/);
    }
    expect(((await call(context, "GET", "/api/data-destinations", admin.cookie)).json() as { destinations: unknown[] }).destinations).toEqual([]);

    expect((await call(context, "POST", "/api/data-destinations", admin.cookie, corp)).statusCode).toBe(201);
    const duplicate = await call(context, "POST", "/api/data-destinations", admin.cookie, { ...corp, name: "Again", host: "*.CORP.example" });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error: string }).error).toMatch(/"Corp network" already classifies this destination/);

    const other = (await call(context, "POST", "/api/data-destinations", admin.cookie, { name: "Lab", kind: "http", host: "10.20.0.0/16", tier: "local" })).json() as { destination: DataDestinationRow };
    expect((await call(context, "PUT", `/api/data-destinations/${other.destination.id}`, admin.cookie, corp)).statusCode).toBe(409);

    for (const method of ["PUT", "DELETE"] as const) {
      const response = await call(context, method, "/api/data-destinations/builtin:openai", admin.cookie, method === "PUT" ? corp : undefined);
      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: string }).error).toMatch(/Built-in destinations are read-only/);
    }
  });

  it("lists configured destinations nothing classifies, scoped to what the user can read, without paths or secrets", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    context.store.upsertProject({ id: "team", name: "Team" });
    context.store.upsertProject({ id: "other", name: "Other" });
    context.store.upsertProjectRole({ userId: builder.id, projectId: "team", role: "editor" });
    context.store.upsertWorkflow(
      workflow("wf-team", "team", [
        { id: "model", type: "llm_call", name: "Ask model", config: { provider: { providerId: "openai_compatible", model: "m", baseUrl: "https://llm.example.net/v1" } } },
        { id: "default-model", type: "llm_call", config: { provider: { providerId: "openai", model: "gpt" } } },
        { id: "hook", type: "http_request", config: { method: "POST", urlTemplate: "https://hooks.example.org/path/with-token-abc123?key=SECRET" } },
        { id: "templated", type: "http_request", config: { method: "GET", urlTemplate: "https://{{results.x.host}}/api" } },
        { id: "slack", type: "slack_send_message", config: { webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXSECRET" } }
      ])
    );
    context.store.upsertWorkflow(workflow("wf-other", "other", [{ id: "crm", type: "http_request", config: { method: "GET", urlTemplate: "https://crm.other.example/api" } }]));
    context.store.createMcpServer({ id: "gh", name: "GitHub", adapterId: "http-mcp", connection: { endpoint: "https://mcp.github.example/mcp", transport: "http_streamable" }, projectId: "other" });
    context.store.createMcpServer({ id: "files", name: "Files", adapterId: "http-mcp", connection: { endpoint: "http://localhost:7001/mcp" } });

    const adminList = (await call(context, "GET", "/api/data-destinations/unclassified", admin.cookie)).json() as { destinations: UnclassifiedDestination[] };
    expect(adminList.destinations.map((entry) => [entry.kind, entry.targetId ?? null, entry.host ?? null])).toEqual([
      ["model_provider", "openai_compatible", "llm.example.net"],
      ["mcp_server", "gh", "mcp.github.example"],
      ["connector", "slack_send_message", "hooks.slack.com"],
      ["http", null, "crm.other.example"],
      ["http", null, "hooks.example.org"]
    ]);
    const text = JSON.stringify(adminList);
    for (const secret of ["SECRET", "with-token", "T000", "/services/"]) expect(text).not.toContain(secret);
    expect(adminList.destinations[0]!.seenIn).toEqual(['Workflow "Flow wf-team" · Ask model']);
    expect(adminList.destinations[0]!.current.tier).toBe("public");

    const builderList = (await call(context, "GET", "/api/data-destinations/unclassified", builder.cookie)).json() as { destinations: UnclassifiedDestination[] };
    expect(builderList.destinations.map((entry) => entry.host)).toEqual(["llm.example.net", "hooks.slack.com", "hooks.example.org"]);

    // Classifying one takes it off the list.
    const suggestion = adminList.destinations[0]!.suggestion;
    expect((await call(context, "POST", "/api/data-destinations", admin.cookie, suggestion)).statusCode).toBe(201);
    const after = (await call(context, "GET", "/api/data-destinations/unclassified", admin.cookie)).json() as { destinations: UnclassifiedDestination[] };
    expect(after.destinations.map((entry) => entry.host)).not.toContain("llm.example.net");
  });

  it("answers 501 when the store is not SQLite", async () => {
    const service = new DataDestinationService({ store: null, readableWorkflowIds: () => null, readableProjectIds: () => null });
    expect(service.available).toBe(false);
    expect(service.rows()).toEqual([]);
    expect(() => service.list()).toThrow(/SQLite/);
  });
});

describe("collectConfiguredDestinations", () => {
  it("reads providers (with default hosts), MCP servers, HTTP and connector nodes", () => {
    const found = collectConfiguredDestinations({
      env: { OLLAMA_BASE_URL: "http://gpu.internal:11434/v1" },
      mcpServers: [{ id: "reg", name: "Registry server", connection: { endpoint: "https://mcp.example.com/mcp" } }],
      workflows: [
        workflow("w", "default", [
          { id: "a", type: "llm_call", config: { provider: { providerId: "anthropic", model: "m" } } },
          { id: "b", type: "llm_call", config: { provider: { providerId: "ollama", model: "m" } } },
          { id: "c", type: "llm_call", config: { provider: { providerId: "azure_openai", model: "m", extra: { endpoint: "https://res.openai.azure.com" } } } },
          { id: "d", type: "azure_openai_chat_model", config: { endpoint: "https://res2.openai.azure.com", deployment: "x" } },
          { id: "e", type: "mcp_tool", config: { registryServerId: "reg", toolName: "t" } },
          { id: "f", type: "mcp_tool", config: { serverId: "http-mcp", toolName: "t", connection: { endpoint: "http://10.0.0.5:7001/mcp" } } },
          { id: "g", type: "web_browse", config: { url: "https://news.example.com/today" } },
          { id: "h", type: "google_drive_source", config: {} },
          { id: "i", type: "noop_node", config: { url: "https://ignored.example.com" } }
        ])
      ]
    });
    expect(found.map((entry) => entry.ref)).toEqual([
      { kind: "mcp_server", id: "reg", host: "mcp.example.com" },
      { kind: "model_provider", id: "anthropic", host: "api.anthropic.com" },
      { kind: "model_provider", id: "ollama", host: "gpu.internal" },
      { kind: "model_provider", id: "azure_openai", host: "res.openai.azure.com" },
      { kind: "model_provider", id: "azure_openai", host: "res2.openai.azure.com" },
      { kind: "mcp_server", id: "reg", host: "mcp.example.com" },
      { kind: "mcp_server", host: "10.0.0.5" },
      { kind: "http", host: "news.example.com" },
      { kind: "connector", id: "google_drive_source" }
    ]);
  });
});

describe("collectConfiguredDestinations edge cases", () => {
  it("never assumes the default host for a base URL it cannot read, and skips offline providers and disabled nodes", () => {
    const flow = workflow("w", "default", [
      { id: "templated", type: "llm_call", config: { provider: { providerId: "openai", model: "m", baseUrl: "https://{{$env.LLM_HOST}}/v1" } } },
      { id: "echo", type: "llm_call", config: { provider: { providerId: "echo", model: "m" } } },
      { id: "gemini", type: "llm_call", config: { provider: { providerId: "gemini", model: "m", baseUrl: "https://stray.example.com" } } },
      { id: "off", type: "http_request", config: { method: "GET", urlTemplate: "https://disabled.example.com/x" } },
      { id: "plain", type: "llm_call", config: { provider: { providerId: "openai", model: "m" } } }
    ]);
    const nodes = flow.nodes.map((node) => (node.id === "off" ? { ...node, disabled: true } : node));
    const found = collectConfiguredDestinations({ env: {}, mcpServers: [], workflows: [{ ...flow, nodes }] });
    expect(found.map((entry) => entry.ref)).toEqual([
      // Templated base URL: the real host is unknown, so no host (not the default api.openai.com).
      { kind: "model_provider", id: "openai" },
      // The Gemini adapter always calls its default host.
      { kind: "model_provider", id: "gemini", host: "generativelanguage.googleapis.com" },
      { kind: "model_provider", id: "openai", host: "api.openai.com" }
    ]);
  });

  it("reads the published version too, adding only what the draft does not send to", () => {
    const draft = workflow("w", "default", [{ id: "a", type: "http_request", config: { method: "GET", urlTemplate: "https://both.example.com/x" } }]);
    const published = workflow("w", "default", [
      { id: "a", type: "http_request", config: { method: "GET", urlTemplate: "https://both.example.com/y" } },
      { id: "b", type: "http_request", name: "Old hook", config: { method: "GET", urlTemplate: "https://old.example.com/x" } }
    ]);
    const found = collectConfiguredDestinations({ env: {}, mcpServers: [], workflows: [{ id: "w", name: "Flow w", nodes: draft.nodes, published }] });
    expect(found).toEqual([
      { ref: { kind: "http", host: "both.example.com" }, seenIn: 'Workflow "Flow w" · a' },
      { ref: { kind: "http", host: "old.example.com" }, seenIn: 'Workflow "Flow w" (published) · Old hook' }
    ]);
  });

  it("the not-classified-yet list reads the published version from the store", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const published = workflow("wf-pub", "default", [{ id: "hook", type: "http_request", name: "Hook", config: { method: "GET", urlTemplate: "https://published-only.example.com/x" } }]);
    context.store.upsertWorkflow(published);
    context.store.writeWorkflowVersion({ id: "wv-1", workflowId: "wf-pub", version: 1, workflowJson: JSON.stringify(published) });
    context.store.publishWorkflowVersion(
      { id: "rel-1", workflowId: "wf-pub", version: 1, workflowHash: "h", replayRunId: null, verdict: "ungated", reason: null, gateReasons: [], approval: null, publishedAt: new Date().toISOString(), publishedBy: null, publishedByUserId: null },
      null
    );
    context.store.upsertWorkflow(workflow("wf-pub", "default", [{ id: "hook", type: "http_request", name: "Hook", config: { method: "GET", urlTemplate: "https://draft-only.example.com/x" } }]));
    const list = (await call(context, "GET", "/api/data-destinations/unclassified", admin.cookie)).json() as { destinations: UnclassifiedDestination[] };
    expect(list.destinations.map((entry) => [entry.host, entry.seenIn])).toEqual([
      ["draft-only.example.com", ['Workflow "Flow wf-pub" · Hook']],
      ["published-only.example.com", ['Workflow "Flow wf-pub" (published) · Hook']]
    ]);
  });
});

describe("migration 38", () => {
  it("creates data_destinations with a unique match index and a rollback, in Postgres DDL", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 38)!;
    expect(migration.description).toContain("Data destinations");
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS data_destinations");
    expect(migration.up).toContain("TIMESTAMPTZ");
    expect(migration.up).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_data_destinations_match");
    expect(migration.down).toContain("DROP TABLE IF EXISTS data_destinations");
  });

  it("creates the SQLite table on open and keeps rows across reopen", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-destinations-db-"));
    try {
      const file = path.join(tempDir, "orchestrator.db");
      const store = await SqliteStore.create(file);
      store.insertDataDestination({ id: "dst_1", name: "Lab", kind: "http", targetId: null, host: "10.0.0.0/8", tier: "local", region: "unknown", holdsDataClasses: [], note: null, actor: "a" });
      expect(() => store.insertDataDestination({ id: "dst_2", name: "Lab again", kind: "http", targetId: null, host: "10.0.0.0/8", tier: "private", region: "unknown", holdsDataClasses: [], note: null, actor: "a" })).toThrow();
      store.close();
      const reopened = await SqliteStore.create(file);
      expect(reopened.listDataDestinations().map((row) => [row.id, row.tier])).toEqual([["dst_1", "local"]]);
      reopened.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
