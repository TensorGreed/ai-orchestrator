/**
 * 12.2 lane t2 — provenance sources over the API:
 *
 * - a webhook's input is the user's only when the server verified the caller
 *   (bearer token or HMAC signature) or an admin set the trigger's trust;
 *   nothing in the request can choose it, and the trigger's result records
 *   it so replays and retries keep it;
 * - the per-trigger trust setting is admin-only: a builder's save cannot set,
 *   change or remove it (a builder's copy drops it);
 * - secrets flagged "sensitive output" (migration v51) make the nodes that
 *   use them sensitive on every run; clearing a flag is admin-only.
 */
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { effectiveTriggerTrust, triggerTrustState, type DataLabels, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { bindTriggerTrust, triggerTrustChanges, withoutTriggerTrust } from "./services/trigger-trust.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";
import { callAs, closeReleaseTestContext, createReleaseTestContext, hookWorkflow as releaseHookWorkflow, loginAs, type ReleaseTestContext } from "./test-support/release.test-helper.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-taint-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
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
  const app = await createApp(config, store, secretService, authService);
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
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const L = (provenance: DataLabels["provenance"], dataClasses: string[] = []): DataLabels => ({ provenance, dataClasses, source: "propagated" });

/** hook (webhook) → note (copies the prompt) → out */
function hookWorkflow(id: string, hookConfig: Record<string, unknown> = {}, noteConfig: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Taint ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST", ...hookConfig } },
      { id: "note", type: "set_node", name: "Note", position: { x: 100, y: 0 }, config: { assignments: [{ key: "copy", valueTemplate: "{{user_prompt}}" }], ...noteConfig } },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "{{results.note.copy}}" } }
    ],
    edges: [
      { id: "e1", source: "hook", target: "note" },
      { id: "e2", source: "note", target: "out" }
    ]
  } as Workflow;
}

/** The workflow as an admin's save stores it: each trust setting bound to its trigger. */
const bound = (workflow: Workflow): Workflow => ({ ...workflow, nodes: bindTriggerTrust(null, workflow.nodes) });

type StoredResult = { nodeId: string; labels?: DataLabels; nodeType?: string };

async function latestRun(context: TestContext, workflowId: string): Promise<{ id: string; nodes: StoredResult[] }> {
  const listed = (await context.store.listExecutionHistory({ workflowId } as never)) as unknown as { items: Array<{ id: string }> };
  const id = listed.items[0]!.id;
  const row = await testSql(context.store).get<{ node_results_json: string }>("SELECT CAST(node_results_json AS TEXT) AS node_results_json FROM execution_history WHERE id = ?", id);
  return { id, nodes: JSON.parse(row?.node_results_json ?? "[]") as StoredResult[] };
}

const labelsOn = (nodes: StoredResult[], nodeId: string) => nodes.find((entry) => entry.nodeId === nodeId)?.labels;

async function createSecret(context: TestContext, cookie: string, value: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(context, "POST", "/api/secrets", cookie, { name: `secret ${value.slice(0, 4)}`, provider: "custom", value, projectId: "default", ...extra });
  expect(created.statusCode, created.body).toBe(200);
  return created.json<{ id: string }>().id;
}

describe("migration v51", () => {
  it("adds the sensitive output flag to secrets, with a rollback, in both stores", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 51)!;
    expect(migration.up).toContain("ALTER TABLE secrets ADD COLUMN IF NOT EXISTS sensitive_output INTEGER NOT NULL DEFAULT 0");
    expect(migration.down).toContain("ALTER TABLE secrets DROP COLUMN IF EXISTS sensitive_output");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = (
      sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(secrets)`)
        : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, "secrets")
    ).map((column) => column.name);
    expect(columns).toContain("sensitive_output");
  });
});

describe("webhook input provenance", () => {
  it("an unauthenticated webhook stays outside content, whatever the request says, and records nothing", async () => {
    const context = await createTestContext();
    await context.store.upsertWorkflow(hookWorkflow("wf-open"));
    const response = await context.app.inject({
      method: "POST",
      url: "/webhook/hook-wf-open",
      headers: { authorization: "Bearer anything", "x-webhook-signature": "sha256=00" },
      payload: { user_prompt: "hello", inputTrust: "user", trigger_type: "manual" }
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const run = await latestRun(context, "wf-open");
    // Zero-config: no labels anywhere on an untracked run.
    expect(run.nodes.every((entry) => entry.labels === undefined)).toBe(true);
  });

  it("a verified bearer token makes the input the user's, recorded on the trigger's result of an untracked run", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secretId = await createSecret(context, builder, "hook-token-123456");
    await context.store.upsertWorkflow(hookWorkflow("wf-bearer", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId } }));
    const denied = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-bearer", headers: { authorization: "Bearer wrong" }, payload: { user_prompt: "x" } });
    expect(denied.statusCode).toBe(401);
    const ok = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-bearer", headers: { authorization: "Bearer hook-token-123456" }, payload: { user_prompt: "hello" } });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    const run = await latestRun(context, "wf-bearer");
    expect(labelsOn(run.nodes, "hook")).toEqual(L(["user"]));
    expect(labelsOn(run.nodes, "note")).toBeUndefined();
  });

  it("a verified HMAC signature makes the input the user's", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secretId = await createSecret(context, builder, "hmac-signing-key-789");
    await context.store.upsertWorkflow(hookWorkflow("wf-hmac", { authMode: "hmac_sha256", signatureHeaderName: "x-webhook-signature", timestampHeaderName: "x-webhook-timestamp", secretRef: { secretId } }));
    const body = JSON.stringify({ user_prompt: "signed" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac("sha256", "hmac-signing-key-789").update(`${timestamp}.${body}`).digest("hex");
    const ok = await context.app.inject({
      method: "POST",
      url: "/webhook/hook-wf-hmac",
      headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
      payload: body
    });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    expect(labelsOn((await latestRun(context, "wf-hmac")).nodes, "hook")).toEqual(L(["user"]));
  });

  it("an admin's trust setting wins: untrusted_external on an authenticated trigger, user on an open one", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const secretId = await createSecret(context, builder, "hook-token-abcdef");
    await context.store.upsertWorkflow(bound(hookWorkflow("wf-down", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId }, inputTrust: "untrusted_external" })));
    await context.store.upsertWorkflow(bound(hookWorkflow("wf-up", { inputTrust: "user" })));
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-down", headers: { authorization: "Bearer hook-token-abcdef" }, payload: { user_prompt: "a" } });
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-up", payload: { user_prompt: "b" } });
    expect(labelsOn((await latestRun(context, "wf-down")).nodes, "hook")).toEqual(L(["untrusted_external"]));
    expect(labelsOn((await latestRun(context, "wf-up")).nodes, "hook")).toEqual(L(["user"]));
  });
});

describe("replays and retries keep the recorded input labels", () => {
  it("an MCP replay of an authenticated webhook run keeps user; a retry of an open webhook run never becomes only the user's", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const secretId = await createSecret(context, admin, "hook-token-replay");
    await context.store.upsertWorkflow(hookWorkflow("wf-replay", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId } }));
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-replay", headers: { authorization: "Bearer hook-token-replay" }, payload: { user_prompt: "hello" } });
    const source = await latestRun(context, "wf-replay");
    expect(labelsOn(source.nodes, "hook")).toEqual(L(["user"]));
    // An MCP replay needs a recorded cassette: record a run, then give it the authenticated webhook run's trigger
    // and trigger labels. The replay keeps the recorded user label rather than reading the trigger type.
    const recorded = (await call(context, "POST", "/api/workflows/wf-replay/execute", admin, { user_prompt: "hello", record: true })).json<{ executionId: string; mcpCassette?: { id: string } }>();
    expect(recorded.mcpCassette?.id).toBeTruthy();
    const sourceRow = await testSql(context.store).get<{ node_results_json: string }>("SELECT CAST(node_results_json AS TEXT) AS node_results_json FROM execution_history WHERE id = ?", source.id);
    await testSql(context.store).run("UPDATE execution_history SET trigger_type = ?, node_results_json = ? WHERE id = ?", "webhook", sourceRow!.node_results_json, recorded.executionId);
    const replay = await call(context, "POST", `/api/executions/${recorded.executionId}/replay`, admin, {});
    expect(replay.statusCode, replay.body).toBe(200);
    expect(labelsOn(replay.json<{ nodeResults: StoredResult[] }>().nodeResults, "hook")).toEqual(L(["user"]));

    // An open webhook run fails; a builder's retry re-sends its input, which stays outside content.
    const failing = hookWorkflow("wf-retry");
    failing.nodes[1] = { ...failing.nodes[1]!, type: "code_node", config: { language: "javascript", code: "throw new Error('boom')" } } as Workflow["nodes"][number];
    await context.store.upsertWorkflow(failing);
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-retry", payload: { user_prompt: "from outside" } });
    const failed = await latestRun(context, "wf-retry");
    const retried = await call(context, "POST", `/api/executions/${failed.id}/retry`, admin, {});
    expect(retried.statusCode, retried.body).toBeLessThan(500);
    const retryRun = await latestRun(context, "wf-retry");
    expect(retryRun.id).not.toBe(failed.id);
    expect(labelsOn(retryRun.nodes, "hook")?.provenance).toEqual(["user", "untrusted_external"]);
    expect(retryRun.nodes.find((entry) => entry.nodeId === "hook")?.nodeType).toBe("webhook_input");

    // The trigger node is replaced (another id) before a retry of the retry: the recorded labels still count.
    const renamed = (await context.store.getWorkflow("wf-retry"))!;
    renamed.nodes = renamed.nodes.map((entry) => (entry.id === "hook" ? { ...entry, id: "hook2" } : entry));
    renamed.edges = renamed.edges.map((edge) => (edge.source === "hook" ? { ...edge, source: "hook2" } : edge));
    await context.store.upsertWorkflow(renamed);
    const again = await call(context, "POST", `/api/executions/${retryRun.id}/retry`, admin, {});
    expect(again.statusCode, again.body).toBeLessThan(500);
    const againRun = await latestRun(context, "wf-retry");
    expect(againRun.id).not.toBe(retryRun.id);
    expect(labelsOn(againRun.nodes, "hook2")?.provenance).toEqual(["user", "untrusted_external"]);
  });
});

describe("the trigger trust setting is admin-only", () => {
  it("a builder can neither set, change nor remove it; other edits keep it; an admin can change it", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    const created = await call(context, "POST", "/api/workflows", builder, hookWorkflow("wf-trust", { inputTrust: "user" }));
    expect(created.statusCode).toBe(403);
    expect(created.json<{ error: string }>().error).toContain("Only an admin");

    expect((await call(context, "POST", "/api/workflows", builder, hookWorkflow("wf-trust"))).statusCode).toBe(200);
    const raise = await call(context, "PUT", "/api/workflows/wf-trust", builder, hookWorkflow("wf-trust", { inputTrust: "user" }));
    expect(raise.statusCode).toBe(403);
    expect((await context.store.getWorkflow("wf-trust"))!.nodes[0]!.config.inputTrust).toBeUndefined();

    const set = await call(context, "PUT", "/api/workflows/wf-trust", admin, hookWorkflow("wf-trust", { inputTrust: "user" }));
    expect(set.statusCode, set.body).toBe(200);
    // The admin's save bound the setting to the trigger as saved.
    const stored = (await context.store.getWorkflow("wf-trust"))!;
    expect(stored.nodes[0]!.config.inputTrustFor).toEqual({ nodeType: "webhook_input", authMode: "none", secretId: null, path: "hook-wf-trust" });
    // The builder edits something else and sends the admin's setting back unchanged: fine.
    const rename = await call(context, "PUT", "/api/workflows/wf-trust", builder, { ...stored, name: "Renamed" });
    expect(rename.statusCode, rename.body).toBe(200);
    // Sending the setting without its binding, or another binding, is a change too.
    expect((await call(context, "PUT", "/api/workflows/wf-trust", builder, hookWorkflow("wf-trust", { inputTrust: "user" }))).statusCode).toBe(403);
    // Removing it, or a value the schema refuses, is refused too.
    expect((await call(context, "PUT", "/api/workflows/wf-trust", builder, hookWorkflow("wf-trust"))).statusCode).toBe(403);
    expect((await call(context, "PUT", "/api/workflows/wf-trust", builder, hookWorkflow("wf-trust", { inputTrust: "trusted" }))).statusCode).toBe(400);
    expect((await context.store.getWorkflow("wf-trust"))!.nodes[0]!.config.inputTrust).toBe("user");

    // A builder's import keeps the stored workflow's settings, whatever the file says (none for a new workflow).
    const imported = await call(context, "POST", "/api/workflows/import", builder, { workflow: bound(hookWorkflow("wf-imported", { inputTrust: "user" })) });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await context.store.getWorkflow("wf-imported"))!.nodes[0]!.config.inputTrust).toBeUndefined();
    const over = await call(context, "POST", "/api/workflows/import", builder, { workflow: { ...hookWorkflow("wf-trust", { inputTrust: "untrusted_external" }), name: "Imported over" } });
    expect(over.statusCode, over.body).toBe(200);
    expect((await context.store.getWorkflow("wf-trust"))!.nodes[0]!.config.inputTrust).toBe("user");

    // A builder's copy starts with the default trust.
    const copy = await call(context, "POST", "/api/workflows/wf-trust/duplicate", builder, { name: "Copy" });
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.json<Workflow>().nodes[0]!.config.inputTrust).toBeUndefined();
    const adminCopy = await call(context, "POST", "/api/workflows/wf-trust/duplicate", admin, { name: "Admin copy" });
    expect(adminCopy.json<Workflow>().nodes[0]!.config.inputTrust).toBe("user");
    // Its trigger got a path of its own; the copy's setting is bound to that path, so it still applies.
    expect(triggerTrustState(adminCopy.json<Workflow>().nodes[0]!)).toBe("active");
  });

  it("compares by node: a new trigger node with a setting is a change, a removed node is not", () => {
    const before = { nodes: [{ id: "a", config: { inputTrust: "user" } }, { id: "b", config: {} }] };
    expect(triggerTrustChanges(before, before)).toEqual([]);
    expect(triggerTrustChanges(before, { nodes: [{ id: "b", config: {} }] })).toEqual([]);
    expect(triggerTrustChanges(before, { nodes: [{ id: "c", config: { inputTrust: "user" } }] })).toEqual(["c"]);
    expect(triggerTrustChanges(before, { nodes: [{ id: "a", config: { inputTrust: "untrusted_external" } }] })).toEqual(["a"]);
    expect(triggerTrustChanges(null, { nodes: [{ id: "a", config: { inputTrust: "user" } }] })).toEqual(["a"]);
    const stripped = withoutTriggerTrust({ nodes: [{ id: "a", type: "webhook_input", name: "A", position: { x: 0, y: 0 }, config: { inputTrust: "user", path: "p" } }] } as Pick<Workflow, "nodes">);
    expect(stripped.nodes[0]!.config).toEqual({ path: "p" });
  });
});

describe("a trust setting is bound to the trigger an admin set it for", () => {
  it("is ignored once the trigger's type, auth mode, secret or path changes", () => {
    const node = bound(hookWorkflow("wf-bind", { authMode: "bearer_token", secretRef: { secretId: "s1" }, inputTrust: "user" })).nodes[0]!;
    expect(triggerTrustState(node)).toBe("active");
    const changed = (patch: Record<string, unknown>, type = node.type) => ({ ...node, type, config: { ...node.config, ...patch } });
    expect(triggerTrustState(changed({ authMode: "none" }))).toBe("reset");
    expect(triggerTrustState(changed({ secretRef: { secretId: "s2" } }))).toBe("reset");
    expect(triggerTrustState(changed({ secretRef: undefined }))).toBe("reset");
    expect(triggerTrustState(changed({ path: "elsewhere" }))).toBe("reset");
    expect(triggerTrustState(changed({}, "chat_trigger" as typeof node.type))).toBe("reset");
    // Other edits keep it, and so does a path written another way.
    expect(triggerTrustState(changed({ responseCode: 202, path: "/HOOK-wf-bind/" }))).toBe("active");
    // Never bound (set outside an admin's save): ignored.
    expect(triggerTrustState(hookWorkflow("wf-unbound", { inputTrust: "user" }).nodes[0]!)).toBe("reset");
  });

  it("a reset only tightens: an admin's untrusted_external on a verified webhook stays after a builder moves its path", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    const secretId = await createSecret(context, admin, "hook-token-tight1");
    const draft = hookWorkflow("wf-tight", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId }, inputTrust: "untrusted_external" });
    expect((await call(context, "POST", "/api/workflows", admin, draft)).statusCode).toBe(200);
    const stored = (await context.store.getWorkflow("wf-tight"))!;
    const moved = { ...stored, nodes: stored.nodes.map((entry) => (entry.id === "hook" ? { ...entry, config: { ...entry.config, path: "hook-wf-tight-moved" } } : entry)) };
    expect((await call(context, "PUT", "/api/workflows/wf-tight", builder, moved)).statusCode).toBe(200);
    expect(triggerTrustState((await context.store.getWorkflow("wf-tight"))!.nodes[0]!)).toBe("reset");
    const ok = await context.app.inject({ method: "POST", url: "/webhook/hook-wf-tight-moved", headers: { authorization: "Bearer hook-token-tight1" }, payload: { user_prompt: "relay" } });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    expect(labelsOn((await latestRun(context, "wf-tight")).nodes, "hook")).toEqual(L(["untrusted_external"]));
    // Each binding field changed: untrusted_external still applies.
    const node = (await context.store.getWorkflow("wf-tight"))!.nodes[0]!;
    for (const patch of [{ authMode: "none" }, { secretRef: { secretId: "other" } }, { path: "x" }]) {
      expect(effectiveTriggerTrust({ ...node, config: { ...node.config, ...patch } })).toBe("untrusted_external");
    }
    expect(effectiveTriggerTrust({ ...node, type: "chat_trigger" as typeof node.type })).toBe("untrusted_external");
  });

  it("a builder who opens the webhook keeps the save, but the admin's user trust no longer applies; an admin's save binds it again", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    const secretId = await createSecret(context, admin, "hook-token-bound1");
    const draft = hookWorkflow("wf-bound", { authMode: "bearer_token", authHeaderName: "authorization", secretRef: { secretId }, inputTrust: "user" });
    expect((await call(context, "POST", "/api/workflows", admin, draft)).statusCode).toBe(200);
    const stored = (await context.store.getWorkflow("wf-bound"))!;

    // The builder makes the webhook public, sending the admin's setting back as stored.
    const opened = { ...stored, nodes: stored.nodes.map((entry) => (entry.id === "hook" ? { ...entry, config: { ...entry.config, authMode: "none" } } : entry)) };
    const save = await call(context, "PUT", "/api/workflows/wf-bound", builder, opened);
    expect(save.statusCode, save.body).toBe(200);
    expect(triggerTrustState((await context.store.getWorkflow("wf-bound"))!.nodes[0]!)).toBe("reset");
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-bound", payload: { user_prompt: "anonymous" } });
    // Falls back to the default: an open webhook's input is outside content (nothing recorded on an untracked run).
    expect(labelsOn((await latestRun(context, "wf-bound")).nodes, "hook")).toBeUndefined();

    // Moving the trigger to another path does the same.
    const moved = { ...stored, nodes: stored.nodes.map((entry) => (entry.id === "hook" ? { ...entry, config: { ...entry.config, authMode: "none", path: "hook-wf-moved" } } : entry)) };
    expect((await call(context, "PUT", "/api/workflows/wf-bound", builder, moved)).statusCode).toBe(200);
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-moved", payload: { user_prompt: "anonymous" } });
    expect(labelsOn((await latestRun(context, "wf-bound")).nodes, "hook")).toBeUndefined();

    // An admin who saves it unchanged leaves it reset; one who confirms it (the binding removed) binds it again.
    const current = (await context.store.getWorkflow("wf-bound"))!;
    expect((await call(context, "PUT", "/api/workflows/wf-bound", admin, current)).statusCode).toBe(200);
    expect(triggerTrustState((await context.store.getWorkflow("wf-bound"))!.nodes[0]!)).toBe("reset");
    const confirmed = {
      ...current,
      nodes: current.nodes.map((entry) => {
        if (entry.id !== "hook") return entry;
        const { inputTrustFor: _binding, ...config } = entry.config;
        return { ...entry, config };
      })
    };
    expect((await call(context, "PUT", "/api/workflows/wf-bound", admin, confirmed)).statusCode).toBe(200);
    expect(triggerTrustState((await context.store.getWorkflow("wf-bound"))!.nodes[0]!)).toBe("active");
    await context.app.inject({ method: "POST", url: "/webhook/hook-wf-moved", payload: { user_prompt: "anonymous" } });
    expect(labelsOn((await latestRun(context, "wf-bound")).nodes, "hook")).toEqual(L(["user"]));
  });
});

describe("trust that comes with a copy from elsewhere is dropped", () => {
  it("a share link's import drops it, for an admin too", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    expect((await call(context, "POST", "/api/workflows", admin, hookWorkflow("wf-share", { inputTrust: "user" }))).statusCode).toBe(200);
    const link = (await call(context, "GET", "/api/workflows/wf-share/share-link", admin)).json<{ shareUrl: string }>().shareUrl;
    const imported = await call(context, "GET", link, admin);
    expect(imported.statusCode, imported.body).toBe(200);
    const copy = (await context.store.getWorkflow(imported.json<{ workflowId: string }>().workflowId))!;
    expect(copy.nodes[0]!.config.inputTrust).toBeUndefined();
    expect(copy.nodes[0]!.config.inputTrustFor).toBeUndefined();
  });

  it("a git pull drops it: the repository does not decide a trigger's trust", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const bareRepo = path.join(context.tempDir, "remote.git");
    fs.mkdirSync(bareRepo);
    const init = spawnSync("git", ["init", "--bare", "-b", "main", bareRepo], { encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    expect((await call(context, "POST", "/api/workflows", admin, hookWorkflow("wf-git", { inputTrust: "user" }))).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/git", admin, { repoUrl: bareRepo, defaultBranch: "main" })).statusCode).toBe(200);
    const push = await call(context, "POST", "/api/git/push", admin, { branch: "main" });
    expect(push.json<{ ok: boolean }>().ok, push.body).toBe(true);
    const pull = await call(context, "POST", "/api/git/pull", admin, { branch: "main" });
    expect(pull.json<{ ok: boolean; workflowsImported?: number }>(), pull.body).toMatchObject({ ok: true, workflowsImported: 1 });
    expect((await context.store.getWorkflow("wf-git"))!.nodes[0]!.config.inputTrust).toBeUndefined();
  });
});

describe("a release rollback that brings back another trust setting is an admin's", () => {
  const releaseContexts: ReleaseTestContext[] = [];
  afterEach(async () => {
    while (releaseContexts.length > 0) await closeReleaseTestContext(releaseContexts.pop()!);
  });

  it("a builder's rollback to a version with another trust is refused (403); an admin's goes through", async () => {
    const ctx = await createReleaseTestContext();
    releaseContexts.push(ctx);
    const builder = await loginAs(ctx, "builder");
    const admin = await loginAs(ctx, "admin");
    const versions = new WorkflowVersionService(ctx.store);
    const save = async (workflow: Workflow) => (await versions.snapshot({ workflow: await ctx.store.upsertWorkflow(workflow), changeNote: "test" })).version;
    const trusted = releaseHookWorkflow("wf-roll", "one");
    trusted.nodes[0] = { ...trusted.nodes[0]!, config: { ...trusted.nodes[0]!.config, inputTrust: "user" } };
    const v1 = await save(bound(trusted));
    const v2 = await save(releaseHookWorkflow("wf-roll", "two"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-roll/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    expect((await callAs(ctx, "POST", "/api/workflows/wf-roll/publish", builder.cookie, { version: v2 })).statusCode).toBe(200);
    const refused = await callAs(ctx, "POST", "/api/workflows/wf-roll/rollback", builder.cookie, { version: v1, reason: "Back" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toContain("only an admin");
    const back = await callAs(ctx, "POST", "/api/workflows/wf-roll/rollback", admin.cookie, { version: v1, reason: "Back" });
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe("secrets flagged sensitive output", () => {
  it("make the nodes that use them sensitive on every run; flagging is open to editors, clearing is admin-only", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    const secretId = await createSecret(context, builder, "hr-db-password-1");
    const listed = await call(context, "GET", "/api/secrets", builder);
    expect(listed.json<Array<{ id: string; sensitiveOutput: boolean }>>().find((entry) => entry.id === secretId)?.sensitiveOutput).toBe(false);

    await context.store.upsertWorkflow(hookWorkflow("wf-hr", {}, { connection: { secretRef: { secretId } } }));
    await call(context, "POST", "/api/workflows/wf-hr/execute", builder, { user_prompt: "a" });
    expect((await latestRun(context, "wf-hr")).nodes.every((entry) => entry.labels === undefined)).toBe(true);

    const flagged = await call(context, "PUT", `/api/secrets/${secretId}/sensitive-output`, builder, { sensitiveOutput: true });
    expect(flagged.statusCode, flagged.body).toBe(200);
    expect((await call(context, "GET", "/api/secrets", builder)).json<Array<{ id: string; sensitiveOutput: boolean }>>().find((entry) => entry.id === secretId)?.sensitiveOutput).toBe(true);
    await call(context, "POST", "/api/workflows/wf-hr/execute", builder, { user_prompt: "b" });
    expect(labelsOn((await latestRun(context, "wf-hr")).nodes, "note")?.provenance).toEqual(["user", "sensitive"]);

    expect((await call(context, "PUT", `/api/secrets/${secretId}/sensitive-output`, builder, { sensitiveOutput: false })).statusCode).toBe(403);
    expect((await call(context, "PUT", `/api/secrets/${secretId}/sensitive-output`, builder, { sensitiveOutput: "no" })).statusCode).toBe(400);
    expect((await call(context, "PUT", `/api/secrets/missing/sensitive-output`, builder, { sensitiveOutput: true })).statusCode).toBe(404);
    expect((await call(context, "PUT", `/api/secrets/${secretId}/sensitive-output`, admin, { sensitiveOutput: false })).statusCode).toBe(200);
    await call(context, "POST", "/api/workflows/wf-hr/execute", builder, { user_prompt: "c" });
    expect((await latestRun(context, "wf-hr")).nodes.every((entry) => entry.labels === undefined)).toBe(true);

    // A secret created flagged.
    const flaggedAtCreate = await createSecret(context, builder, "payroll-token-22", { sensitiveOutput: true });
    expect(await context.store.listSensitiveOutputSecretIds()).toEqual([flaggedAtCreate]);
    // Deleting a flagged secret (to create it again unflagged) is an admin's call, as clearing is; an unflagged one is not.
    const denied = await call(context, "DELETE", `/api/secrets/${flaggedAtCreate}`, builder);
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await call(context, "DELETE", `/api/secrets/${secretId}`, builder)).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/secrets/${flaggedAtCreate}`, admin)).statusCode).toBe(200);
  });

  it("a node flagged sensitive output is sensitive without any profile", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    await context.store.upsertWorkflow(hookWorkflow("wf-flag", {}, { sensitiveOutput: true }));
    await call(context, "POST", "/api/workflows/wf-flag/execute", builder, { user_prompt: "a" });
    expect(labelsOn((await latestRun(context, "wf-flag")).nodes, "note")?.provenance).toEqual(["user", "sensitive"]);
  });
});
