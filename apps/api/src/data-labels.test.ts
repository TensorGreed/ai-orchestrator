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
import { GuardService } from "./services/guard-service.js";
import { createReplaySandbox } from "./services/replay-sandbox.js";

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
    expect(migration.up).toContain("ALTER TABLE session_artifacts ADD COLUMN IF NOT EXISTS labels_json TEXT");
    expect(migration.down).toContain("ALTER TABLE session_memory DROP COLUMN IF EXISTS labels_json");
    expect(migration.down).toContain("ALTER TABLE session_artifacts DROP COLUMN IF EXISTS labels_json");
    expect(migration.down).toContain("ALTER TABLE session_tool_cache DROP COLUMN IF EXISTS labels_json");
    for (const line of migration.up.split("\n").filter((entry) => entry.includes("labels_json"))) expect(line).not.toMatch(/NOT NULL|DEFAULT/);
    // The guard profile revision: one row, bumped by triggers on both profile tables; removed on rollback.
    expect(migration.up).toContain("CREATE TABLE IF NOT EXISTS guard_profile_revision");
    expect(migration.up).toContain("AFTER INSERT OR UPDATE OR DELETE ON guard_profiles");
    expect(migration.up).toContain("AFTER INSERT OR UPDATE OR DELETE ON guard_profile_versions");
    expect(migration.down).toContain("DROP TRIGGER IF EXISTS guard_profiles_revision ON guard_profiles");
    expect(migration.down).toContain("DROP TRIGGER IF EXISTS guard_profile_versions_revision ON guard_profile_versions");
    expect(migration.down).toContain("DROP FUNCTION IF EXISTS guard_profile_revision_bump()");
    expect(migration.down).toContain("DROP TABLE IF EXISTS guard_profile_revision");
  });

  it("exists in the SQLite schema", async () => {
    const context = await createTestContext();
    const columns = (table: string) =>
      (context.store as unknown as { queryAll: (sql: string) => Array<{ name: string }> }).queryAll(`PRAGMA table_info(${table})`).map((column) => column.name);
    expect(columns("session_memory")).toContain("labels_json");
    expect(columns("session_tool_cache")).toContain("labels_json");
    expect(columns("session_artifacts")).toContain("labels_json");
    const triggers = (context.store as unknown as { queryAll: (sql: string) => Array<{ name: string }> })
      .queryAll(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'guard_profile%revision%' ORDER BY name`)
      .map((row) => row.name);
    expect(triggers).toHaveLength(6);
    const before = context.store.guardProfileRevision();
    context.store.insertGuardProfile({ id: "p", name: "P", document: {}, hash: "h", createdBy: null });
    expect(context.store.guardProfileRevision()).toBeGreaterThan(before);
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
  it("stores labels only when given and merges them; a save without labels (untracked) clears them; older rows read as none", async () => {
    const context = await createTestContext();
    const store = context.store;
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "old" }]);
    expect(store.loadSessionMemoryLabels("ns", "s1")).toBeNull();
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "a" }], L(["user"]));
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "b" }], L(["untrusted_external"], ["email"]));
    expect(store.loadSessionMemoryLabels("ns", "s1")).toEqual(L(["user", "untrusted_external"], ["email"]));
    store.saveSessionMemory("ns", "s1", [{ role: "user", content: "c" }]);
    expect(store.loadSessionMemoryLabels("ns", "s1")).toBeNull();
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

describe("round 1 fixes", () => {
  it("session artifacts keep the labels of a tracked save; a save without labels clears them; older rows have none", async () => {
    const context = await createTestContext();
    const store = context.store;
    const key = { namespace: "ns", sessionId: "s1", artifactKey: "latest" };
    store.saveSessionArtifact({ ...key, value: { v: 0 } });
    expect(store.loadSessionArtifact(key)!.labels).toBeUndefined();
    const saved = store.saveSessionArtifact({ ...key, value: { v: 1 }, labels: L(["untrusted_external"], ["email"]) });
    expect(saved.labels).toEqual(L(["untrusted_external"], ["email"]));
    expect(store.loadSessionArtifact(key)!.labels).toEqual(L(["untrusted_external"], ["email"]));
    store.saveSessionArtifact({ ...key, value: { v: 2 } });
    expect(store.loadSessionArtifact(key)).toMatchObject({ value: { v: 2 } });
    expect(store.loadSessionArtifact(key)!.labels).toBeUndefined();
    store.saveSessionArtifact({ ...key, value: { v: 3 }, labels: L(["user"]) });
    expect(store.loadSessionArtifact(key)!.labels).toEqual(L(["user"]));
  });

  it("the run scope takes the labels' row from the messages read, without reading the messages again", async () => {
    const context = await createTestContext();
    const store = context.store;
    const workflow = { ...labelledWorkflow("wf-legacy", "default"), projectId: "default" };
    // A legacy (unprefixed) row from before project scoping, with labels.
    store.saveSessionMemory("wf-legacy:note", "s", [{ role: "user", content: "old" }], L(["untrusted_external"], ["iban"]));
    let messageReads = 0;
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
        loadMemory: (namespace, sessionId) => {
          messageReads += 1;
          return store.loadSessionMemory(namespace, sessionId);
        },
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
    expect(await memory.loadMessages("wf-legacy:note", "s")).toEqual([{ role: "user", content: "old" }]);
    const readsAfterMessages = messageReads;
    expect(await memory.loadLabels!("wf-legacy:note", "s")).toEqual(L(["untrusted_external"], ["iban"]));
    expect(messageReads).toBe(readsAfterMessages);
  });

  it("guard profiles: one cached check says whether any profile tracks labels; parsed versions are reused and frozen", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    // The store answers the cheap check (cached until the next profile write); the built-in default does not opt in.
    expect(context.store.anyGuardProfileUsesLabels()).toBe(false);
    await trackingProfile(context, admin);
    expect(context.store.anyGuardProfileUsesLabels()).toBe(true);
    const service = new GuardService(context.store, new SecretService(context.store, context.config.SECRET_MASTER_KEY_BASE64), { autoApply: true });
    const first = service.loadProfile("default")!;
    const second = service.loadProfile("default")!;
    expect(second.profile).toBe(first.profile);
    expect(Object.isFrozen(first.profile)).toBe(true);
    expect(service.mayUseLabels()).toBe(true);
    expect(service.runtimeFor({ workflowId: "wf", projectId: "default" }).mayUseLabels!()).toBe(true);
  });

  it("zero config: runs do not resolve guard profiles to learn they track nothing", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    context.store.upsertWorkflow({
      ...labelledWorkflow("wf-bare", "default"),
      nodes: labelledWorkflow("wf-bare", "default").nodes.filter((node) => node.type !== "guard"),
      edges: [
        { id: "e1", source: "hook", target: "note" },
        { id: "e2", source: "note", target: "pass" }
      ]
    } as Workflow);
    let checks = 0;
    const original = context.store.anyGuardProfileUsesLabels.bind(context.store);
    context.store.anyGuardProfileUsesLabels = () => {
      checks += 1;
      return original();
    };
    const versionReads: string[] = [];
    const getVersion = context.store.getGuardProfileVersion.bind(context.store);
    context.store.getGuardProfileVersion = (profileId: string, version?: number) => {
      versionReads.push(profileId);
      return getVersion(profileId, version);
    };
    const run = (await call(context, "POST", "/api/workflows/wf-bare/execute", builder, { user_prompt: "hello" })).json<RunResult>();
    expect(run.status).toBe("success");
    expect(checks).toBe(1);
    expect(versionReads).toEqual([]);
  });

  it("replays take the recording's input origin, not the replaying user's (Q7)", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    // Recorded while untracked (the default profile): the facts carry no labels, the source trigger was a webhook.
    context.store.upsertWorkflow(labelledWorkflow("wf-replayed", "default"));
    const hook = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-replayed", payload: { user_prompt: "hello" } });
    expect(hook.statusCode, hook.body).toBeLessThan(300);
    const source = (context.store.listExecutionHistory({ workflowId: "wf-replayed" } as never) as unknown as { items: Array<{ id: string }> }).items[0]!.id;
    const saved = await call(context, "POST", "/api/replay/recordings", admin, { executionId: source, name: "From a webhook" });
    expect(saved.statusCode, saved.body).toBe(201);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    expect(context.store.getReplayRecording(recordingId)!.sourceTriggerType).toBe("webhook");

    // The draft now tracks labels; an admin replays it.
    context.store.upsertWorkflow(labelledWorkflow("wf-replayed", "tracking"));
    const replayed = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, admin, { draft: true });
    expect(replayed.statusCode, replayed.body).toBe(200);
    const executionId = replayed.json<{ executionId: string }>().executionId;
    const stored = JSON.parse(storedNodeResults(context, executionId)) as Array<{ nodeId: string; labels?: DataLabels }>;
    expect(stored.find((entry) => entry.nodeId === "hook")?.labels).toEqual(L(["untrusted_external"]));
  });

  it("an MCP replay takes the source run's input origin", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    context.store.upsertWorkflow(labelledWorkflow("wf-mcp-replay", "default"));
    const recorded = (await call(context, "POST", "/api/workflows/wf-mcp-replay/execute", admin, { user_prompt: "hello", record: true })).json<RunResult & { mcpCassette?: { id: string } }>();
    expect(recorded.status).toBe("success");
    expect(recorded.mcpCassette?.id).toBeTruthy();
    // The source run came from outside (a webhook-style trigger): its replay must say so, whoever replays it.
    (context.store as unknown as { exec: (sql: string, params: unknown[]) => void }).exec("UPDATE execution_history SET trigger_type = ? WHERE id = ?", ["webhook", recorded.executionId]);
    context.store.upsertWorkflow(labelledWorkflow("wf-mcp-replay", "tracking"));
    const replay = await call(context, "POST", `/api/executions/${recorded.executionId}/replay`, admin, {});
    expect(replay.statusCode, replay.body).toBe(200);
    const replayRun = replay.json<RunResult>();
    expect(replayRun.nodeResults.find((entry) => entry.nodeId === "hook")?.labels).toEqual(L(["untrusted_external"]));
  });

  it("a recording's memory seed keeps the memory's labels, and a replay sandbox reads and merges them", async () => {
    const sandbox = createReplaySandbox({
      sessions: [
        { namespace: "n", sessionId: "s", messages: [{ role: "user", content: "hi" }], labels: L(["untrusted_external"], ["iban"]) },
        { namespace: "n", sessionId: "f", messages: [], labels: { provenance: ["trusted", "user"], dataClasses: [], source: "file" } }
      ],
      truncated: false
    });
    expect(await sandbox.memoryStore.loadLabels!("n", "s")).toEqual(L(["untrusted_external"], ["iban"]));
    expect((await sandbox.memoryStore.loadLabels!("n", "f"))?.provenance).toEqual(["user"]);
    await sandbox.memoryStore.saveMessages("n", "s", [], { labels: L(["user"], ["email"]) });
    expect(await sandbox.memoryStore.loadLabels!("n", "s")).toEqual(L(["user", "untrusted_external"], ["email", "iban"]));
    const saved = await sandbox.sessionArtifactStore.saveArtifact({ namespace: "n", sessionId: "s", artifactKey: "k", value: 1, labels: L(["user"]) });
    expect(saved.labels).toEqual(L(["user"]));
    // A save from an untracked run clears the labels (round 2, as the store does).
    await sandbox.sessionArtifactStore.saveArtifact({ namespace: "n", sessionId: "s", artifactKey: "k", value: 2 });
    expect((await sandbox.sessionArtifactStore.loadArtifact({ namespace: "n", sessionId: "s", artifactKey: "k" }))?.labels).toBeNull();
    await sandbox.memoryStore.saveMessages("n", "s", []);
    expect(await sandbox.memoryStore.loadLabels!("n", "s")).toBeNull();
  });
});

describe("round 2: imported golden runs and eval cases", () => {
  it("a golden run imported from a file always counts its input as outside content on replay, whatever trigger it claims", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    context.store.upsertWorkflow(labelledWorkflow("wf-imported", "default"));
    // Started in the editor: the recording says `manual`, a user's input.
    const run = (await call(context, "POST", "/api/workflows/wf-imported/execute", admin, { user_prompt: "hello" })).json<RunResult>();
    expect(run.status).toBe("success");
    const saved = await call(context, "POST", "/api/replay/recordings", admin, { executionId: run.executionId, name: "Typed in the editor" });
    expect(saved.statusCode, saved.body).toBe(201);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    expect(context.store.getReplayRecording(recordingId)!.sourceTriggerType).toBe("manual");
    const set = (await call(context, "POST", "/api/eval/datasets", admin, { name: "Set", workflowId: "wf-imported" })).json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${set}/recordings`, admin, { recordingId })).statusCode).toBe(201);
    const file = (await call(context, "GET", `/api/eval/datasets/${set}/export`, admin)).json<{ cases: Array<{ recording: { sourceTriggerType: string } }> }>();
    expect(file.cases[0]!.recording.sourceTriggerType).toBe("manual");
    const imported = await call(context, "POST", "/api/eval/datasets/import", admin, { file, workflowId: "wf-imported", name: "From a file" });
    expect(imported.statusCode, imported.body).toBe(201);

    context.store.upsertWorkflow(labelledWorkflow("wf-imported", "tracking"));
    const replayed = async (id: string) => {
      const response = await call(context, "POST", `/api/replay/recordings/${id}/replay`, admin, { draft: true });
      expect(response.statusCode, response.body).toBe(200);
      const stored = JSON.parse(storedNodeResults(context, response.json<{ executionId: string }>().executionId)) as Array<{ nodeId: string; labels?: DataLabels }>;
      return stored.find((entry) => entry.nodeId === "hook")?.labels;
    };
    const importedId = context.store
      .listReplayRecordings({ workflowId: "wf-imported" })
      .items.map((item) => item.id)
      .find((id) => context.store.getReplayRecording(id)!.capabilities.origin === "imported")!;
    expect(importedId).toBeTruthy();
    // The recorded run replays as a user's input; the same run read back from a file adds outside content.
    expect(await replayed(recordingId)).toEqual(L(["user"]));
    expect(await replayed(importedId)).toEqual(L(["user", "untrusted_external"]));
  }, 30_000);

  it("an eval case a builder typed runs as a user's input", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await trackingProfile(context, admin);
    context.store.upsertWorkflow(labelledWorkflow("wf-eval-labels", "tracking"));
    const dataset = (await call(context, "POST", "/api/eval/datasets", admin, { name: "Typed cases" })).json<{ dataset: { id: string } }>().dataset;
    const fixture = await call(context, "POST", `/api/eval/datasets/${dataset.id}/fixtures`, admin, { name: "one", input: { user_prompt: "hello" } });
    expect(fixture.statusCode, fixture.body).toBe(200);
    const evaluated = await call(context, "POST", "/api/eval/runs?wait=true", admin, { datasetId: dataset.id, workflowId: "wf-eval-labels" });
    expect(evaluated.statusCode, evaluated.body).toBe(200);
    const rows = (context.store as unknown as { queryAll: (sql: string, params: unknown[]) => Array<{ id: string }> }).queryAll(
      "SELECT id FROM execution_history WHERE workflow_id = ? AND trigger_type = 'eval'",
      ["wf-eval-labels"]
    );
    expect(rows).toHaveLength(1);
    const stored = JSON.parse(storedNodeResults(context, rows[0]!.id)) as Array<{ nodeId: string; labels?: DataLabels }>;
    expect(stored.find((entry) => entry.nodeId === "hook")?.labels).toEqual(L(["user"]));
  }, 30_000);
});
