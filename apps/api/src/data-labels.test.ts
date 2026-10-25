/**
 * Phase 16 — data labels over the API: input labels from where the run
 * started, per-node labels in the stored history only when a profile tracks
 * them, recordings that keep the propagated labels, labels on session memory
 * and the session tool cache (migration 37), and the zero-config path where
 * nothing of this shows up.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DataLabels, RunFacts, Workflow } from "@ai-orchestrator/shared";
import { createDefaultGuardProfile } from "@ai-orchestrator/guard-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createRunScope } from "./run-scope.js";

interface TestContext {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const EMAIL = "maria.gonzalez@example.org";

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-labels-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "info",
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

async function login(context: TestContext, role: "admin" | "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

/** hook → note (copies the prompt) → guard (the given profile) → pass / blocked. */
function labelledWorkflow(id: string, profileId: string): Workflow {
  return {
    id,
    name: `Labels ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "note", type: "set_node", name: "Note", position: { x: 100, y: 0 }, config: { assignments: [{ key: "copy", valueTemplate: "{{user_prompt}}" }] } },
      { id: "guard", type: "guard", name: "Guard", position: { x: 200, y: 0 }, config: { profileId } },
      { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "{{results.note.copy}}" } },
      { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "note" },
      { id: "e2", source: "note", target: "guard" },
      { id: "e3", source: "guard", sourceHandle: "pass", target: "pass" },
      { id: "e4", source: "guard", sourceHandle: "blocked", target: "blocked" }
    ]
  } as Workflow;
}

type RunResult = { status: string; executionId: string; nodeResults: Array<{ nodeId: string; status: string; labels?: DataLabels; output?: Record<string, unknown> }> };

function storedNodeResults(context: TestContext, executionId: string): string {
  const row = (context.store as unknown as { queryOne: (sql: string, params: unknown[]) => { node_results_json: string } | undefined }).queryOne(
    "SELECT node_results_json FROM execution_history WHERE id = ?",
    [executionId]
  );
  return row?.node_results_json ?? "";
}

async function trackingProfile(context: TestContext, cookie: string): Promise<void> {
  const document = { ...createDefaultGuardProfile(), id: "tracking", name: "Tracking", version: "1", labels: "propagated" };
  const created = await call(context, "POST", "/api/guard/profiles", cookie, { document });
  expect(created.statusCode, created.body).toBe(201);
}

describe("migration 37", () => {
  it("adds nullable labels columns to session memory and the session tool cache, with a rollback", () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 37)!;
    expect(migration.description).toContain("Phase 16");
    expect(migration.up).toContain("ALTER TABLE session_memory ADD COLUMN IF NOT EXISTS labels_json TEXT");
    expect(migration.up).toContain("ALTER TABLE session_tool_cache ADD COLUMN IF NOT EXISTS labels_json TEXT");
    expect(migration.down).toContain("ALTER TABLE session_memory DROP COLUMN IF EXISTS labels_json");
    expect(migration.down).toContain("ALTER TABLE session_tool_cache DROP COLUMN IF EXISTS labels_json");
    expect(migration.up).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("exists in the SQLite schema", async () => {
    const context = await createTestContext();
    const columns = (table: string) =>
      (context.store as unknown as { queryAll: (sql: string) => Array<{ name: string }> }).queryAll(`PRAGMA table_info(${table})`).map((column) => column.name);
    expect(columns("session_memory")).toContain("labels_json");
    expect(columns("session_tool_cache")).toContain("labels_json");
  });
});

describe("labels on runs", () => {
  it("zero config: a run under the default profile stores no labels anywhere", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    context.store.upsertWorkflow(labelledWorkflow("wf-plain", "default"));
    const run = (await call(context, "POST", "/api/workflows/wf-plain/execute", cookie, { user_prompt: `Write to ${EMAIL}` })).json<RunResult>();
    expect(run.status).toBe("success");
    expect(run.nodeResults.every((entry) => entry.labels === undefined)).toBe(true);
    expect(storedNodeResults(context, run.executionId)).not.toContain("labels");
  });

  it("a profile that tracks labels: an editor run's input is user input, scanned classes are stored per node", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    context.store.upsertWorkflow(labelledWorkflow("wf-tracked", "tracking"));
    const run = (await call(context, "POST", "/api/workflows/wf-tracked/execute", admin, { user_prompt: `Write to ${EMAIL}` })).json<RunResult>();
    expect(run.status).toBe("success");
    const labels = (nodeId: string) => run.nodeResults.find((entry) => entry.nodeId === nodeId)?.labels;
    // The trigger's output holds nothing here; the note copies the prompt and the scan finds the email.
    expect(labels("hook")).toEqual(L(["user"]));
    expect(labels("note")).toEqual(L(["user"], ["email"]));
    // The guard allowed the email (the default actions), so the class stays.
    expect(labels("guard")).toEqual(L(["user"], ["email"]));
    const stored = JSON.parse(storedNodeResults(context, run.executionId)) as Array<{ nodeId: string; labels?: DataLabels }>;
    expect(stored.find((entry) => entry.nodeId === "note")?.labels).toEqual(L(["user"], ["email"]));

    // A recording keeps the propagated labels on its facts.
    const recording = await call(context, "POST", "/api/replay/recordings", admin, { executionId: run.executionId, name: "Labelled" });
    expect(recording.statusCode, recording.body).toBe(201);
    const facts = context.store.getReplayRecording(recording.json<{ recording: { id: string } }>().recording.id)!.facts as RunFacts;
    expect(facts.nodes.find((entry) => entry.nodeId === "note")?.labels).toEqual(L(["user"], ["email"]));
  });

  it("a webhook run's input is external", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    context.store.upsertWorkflow(labelledWorkflow("wf-hook", "tracking"));
    const response = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-hook", payload: { user_prompt: "hello" } });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const latest = context.store.listExecutionHistory({ workflowId: "wf-hook" } as never) as unknown as { items: Array<{ id: string }> };
    const stored = JSON.parse(storedNodeResults(context, latest.items[0]!.id)) as Array<{ nodeId: string; labels?: DataLabels }>;
    expect(stored.find((entry) => entry.nodeId === "hook")?.labels).toEqual(L(["untrusted_external"]));
  });
});

describe("labels on session memory and the tool cache", () => {
  it("stores labels only when given, merges them, keeps them on a save without labels; older rows read as none", async () => {
    const context = await createTestContext();
    const store = context.store;
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "old" }]);
    expect(store.loadSessionMemoryLabels("ns", "s1")).toBeNull();
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "a" }], L(["user"]));
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "b" }], L(["untrusted_external"], ["email"]));
    expect(store.loadSessionMemoryLabels("ns", "s1")).toEqual(L(["user", "untrusted_external"], ["email"]));
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "c" }]);
    expect(store.loadSessionMemoryLabels("ns", "s1")).toEqual(L(["user", "untrusted_external"], ["email"]));
    expect(store.loadSessionMemory("ns", "s1")).toEqual([{ role: "user", content: "c" }]);

    const plain = store.saveSessionToolCall({ namespace: "ns", sessionId: "s1", toolName: "t", args: {}, output: 1 });
    const labelled = store.saveSessionToolCall({ namespace: "ns", sessionId: "s1", toolName: "t", args: {}, output: 2, labels: L(["untrusted_external"]) });
    expect(plain.labels).toBeUndefined();
    expect(store.getSessionToolCall({ namespace: "ns", sessionId: "s1", id: plain.id })!.labels).toBeUndefined();
    expect(store.getSessionToolCall({ namespace: "ns", sessionId: "s1", id: labelled.id })!.labels).toEqual(L(["untrusted_external"]));
    expect(store.listSessionToolCalls({ namespace: "ns", sessionId: "s1" }).find((row) => row.id === labelled.id)!.labels).toEqual(L(["untrusted_external"]));
  });

  it("the run scope reads labels from the row it read the messages from", async () => {
    const context = await createTestContext();
    const store = context.store;
    const workflow = { ...labelledWorkflow("wf-mem", "default"), projectId: "default" };
    const scope = createRunScope({
      getWorkflow: () => workflow,
      listWorkflowShares: () => [],
      getSecretProjectId: () => null,
      listSecretIdsSharedToProject: () => [],
      canUseSecretsInProject: () => true,
      defaultSecretsShared: true,
      getMcpServerProjectId: () => undefined,
      resolveRegisteredMcpServer: () => {
        throw new Error("none");
      },
      legacyNamespaceOwnerProjects: () => [],
      resolveSecret: async () => undefined,
      knowledgeBaseStoreFor: () => ({}) as never,
      sessions: {
        loadMemory: (namespace, sessionId) => store.loadSessionMemory(namespace, sessionId),
        saveMemory: (namespace, sessionId, messages, labels) => store.saveSessionMemory(namespace, sessionId, messages, labels),
        loadMemoryLabels: (namespace, sessionId) => store.loadSessionMemoryLabels(namespace, sessionId),
        saveToolCall: (input) => store.saveSessionToolCall(input),
        listToolCalls: (input) => store.listSessionToolCalls(input),
        getToolCall: (input) => store.getSessionToolCall(input),
        saveArtifact: (input) => store.saveSessionArtifact(input),
        loadArtifact: (input) => store.loadSessionArtifact(input)
      }
    });
    const memory = scope.dependenciesFor(workflow, {}).memoryStore;
    await memory.saveMessages("wf-mem:note", "s", [{ role: "user", content: "hi" }], { labels: L(["user"], ["iban"]) });
    expect(await memory.loadLabels!("wf-mem:note", "s")).toEqual(L(["user"], ["iban"]));
    await memory.saveMessages("wf-mem:note", "other", [{ role: "user", content: "hi" }]);
    expect(await memory.loadLabels!("wf-mem:note", "other")).toBeNull();
  });
});
