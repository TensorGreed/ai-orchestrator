/**
 * Phase 10.2 — MCP tool policy: routes, RBAC, audit, evaluator, whose role a
 * run is evaluated with, and the workflows.created_by column.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpToolPolicyRule, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { resolveMcpToolPolicySubject } from "./services/mcp-tool-policy.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const tempDirs: string[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-policy-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
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
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
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
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Cookie '${cookieName}' was not set`);
  return cookie.split(";")[0];
}

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  return { cookie: extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME), id: user.id };
}

async function registerMockServer(context: TestContext, adminCookie: string): Promise<string> {
  const created = await context.app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { cookie: adminCookie },
    payload: { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false }
  });
  const id = created.json<{ server: { id: string } }>().server.id;
  const probe = await context.app.inject({ method: "POST", url: `/api/mcp/servers/${id}/probe`, headers: { cookie: adminCookie } });
  expect(probe.statusCode).toBe(200);
  return id;
}

async function createRule(context: TestContext, adminCookie: string, payload: Record<string, unknown>) {
  const response = await context.app.inject({ method: "POST", url: "/api/mcp/policies", headers: { cookie: adminCookie }, payload });
  expect(response.statusCode).toBe(201);
  return response.json<{ rule: McpToolPolicyRule }>().rule;
}

function calculatorWorkflow(id: string, registryServerId: string): Workflow {
  return {
    id,
    name: `Calculator ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      {
        id: "hook",
        type: "webhook_input",
        name: "Webhook",
        position: { x: 0, y: 0 },
        config: { path: `calc-${id}`, method: "POST" }
      },
      {
        id: "calc",
        type: "mcp_tool",
        name: "Calculator",
        position: { x: 200, y: 0 },
        config: { registryServerId, toolName: "calculator", argsTemplate: "{\"expression\":\"20+22\"}", retry: { enabled: false } }
      },
      { id: "output", type: "output", name: "Output", position: { x: 400, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "calc" },
      { id: "e2", source: "calc", target: "output" }
    ]
  };
}

describe("MCP tool policy routes", () => {
  it("enforces RBAC on every route", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");
    const viewer = await login(context, "viewer");
    const serverId = await registerMockServer(context, admin.cookie);
    const rule = await createRule(context, admin.cookie, { effect: "deny", toolPattern: "calculator" });

    const call = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
      context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const evaluateBody = { role: "viewer", serverId, toolName: "calculator", projectId: "default" };

    for (const cookie of [operator.cookie, viewer.cookie]) {
      expect((await call(cookie, "GET", "/api/mcp/policies")).statusCode).toBe(403);
      expect((await call(cookie, "POST", "/api/mcp/policies/evaluate", evaluateBody)).statusCode).toBe(403);
    }
    expect((await call(builder.cookie, "GET", "/api/mcp/policies")).statusCode).toBe(200);
    expect((await call(builder.cookie, "POST", "/api/mcp/policies/evaluate", evaluateBody)).statusCode).toBe(200);

    for (const cookie of [builder.cookie, operator.cookie, viewer.cookie]) {
      expect((await call(cookie, "POST", "/api/mcp/policies", { effect: "deny" })).statusCode).toBe(403);
      expect((await call(cookie, "PUT", `/api/mcp/policies/${rule.id}`, { enabled: false })).statusCode).toBe(403);
      expect((await call(cookie, "DELETE", `/api/mcp/policies/${rule.id}`)).statusCode).toBe(403);
      expect(
        (await call(cookie, "PUT", `/api/mcp/servers/${serverId}/tools/calculator/classification`, { readOnly: true })).statusCode
      ).toBe(403);
    }
    expect((await context.app.inject({ method: "GET", url: "/api/mcp/policies" })).statusCode).toBe(401);
  });

  it("creates, updates and deletes rules with validation and audit events", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin.cookie);
    const post = (payload: Record<string, unknown>) =>
      context.app.inject({ method: "POST", url: "/api/mcp/policies", headers: { cookie: admin.cookie }, payload });

    expect((await post({ effect: "maybe" })).statusCode).toBe(400);
    expect((await post({ effect: "deny", toolPattern: "bad pattern!" })).statusCode).toBe(400);
    expect((await post({ effect: "deny", projectId: "nope" })).json<{ error: string }>().error).toContain("Project 'nope'");
    expect((await post({ effect: "deny", serverId: "nope" })).json<{ error: string }>().error).toContain("neither a registered");
    expect((await post({ effect: "deny", roles: ["root"] })).statusCode).toBe(400);

    const rule = await createRule(context, admin.cookie, {
      name: " Viewers: no calculator ",
      effect: "deny",
      roles: ["viewer", "viewer"],
      serverId,
      toolPattern: "calc*"
    });
    expect(rule).toMatchObject({
      name: "Viewers: no calculator",
      effect: "deny",
      roles: ["viewer"],
      serverId,
      toolPattern: "calc*",
      projectId: null,
      enabled: true,
      createdBy: "admin@example.com"
    });
    // An adapter id is a valid server for inline-configured servers.
    await createRule(context, admin.cookie, { effect: "allow", serverId: "mock-mcp" });

    const updated = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/policies/${rule.id}`,
      headers: { cookie: admin.cookie },
      payload: { enabled: false, projectId: "default" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ rule: McpToolPolicyRule }>().rule).toMatchObject({
      enabled: false,
      projectId: "default",
      name: "Viewers: no calculator",
      toolPattern: "calc*",
      roles: ["viewer"]
    });
    expect(
      (await context.app.inject({ method: "PUT", url: `/api/mcp/policies/${rule.id}`, headers: { cookie: admin.cookie }, payload: {} })).statusCode
    ).toBe(400);
    expect(
      (await context.app.inject({ method: "PUT", url: "/api/mcp/policies/missing", headers: { cookie: admin.cookie }, payload: { enabled: true } }))
        .statusCode
    ).toBe(404);

    const list = await context.app.inject({ method: "GET", url: "/api/mcp/policies", headers: { cookie: admin.cookie } });
    expect(list.json<{ rules: McpToolPolicyRule[]; roles: string[] }>().rules).toHaveLength(2);
    expect(list.json<{ roles: string[] }>().roles).toEqual(["admin", "builder", "operator", "viewer"]);

    const deleted = await context.app.inject({ method: "DELETE", url: `/api/mcp/policies/${rule.id}`, headers: { cookie: admin.cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(await context.store.getMcpToolPolicy(rule.id)).toBeNull();

    const classified = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${serverId}/tools/calculator/classification`,
      headers: { cookie: admin.cookie },
      payload: { readOnly: true }
    });
    expect(classified.statusCode).toBe(200);
    const cleared = await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${serverId}/tools/calculator/classification`,
      headers: { cookie: admin.cookie },
      payload: { readOnly: null }
    });
    expect(cleared.json()).toMatchObject({ override: null, classification: { readOnly: false, source: "unknown" } });

    const events = (await context.store.listAuditLogs({ resourceType: "mcp_policy" })).items.map((entry) => entry.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        "mcp_policy.created",
        "mcp_policy.updated",
        "mcp_policy.deleted",
        "mcp_policy.classification_set",
        "mcp_policy.classification_cleared"
      ])
    );
  });

  it("dry-runs decisions with matching rules and classification", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin.cookie);
    const deny = await createRule(context, admin.cookie, { name: "Viewers off", effect: "deny", roles: ["viewer"], serverId });
    const allow = await createRule(context, admin.cookie, { effect: "allow", roles: ["viewer"], serverId, toolPattern: "lookup_kb" });

    const evaluate = (payload: Record<string, unknown>) =>
      context.app.inject({ method: "POST", url: "/api/mcp/policies/evaluate", headers: { cookie: builder.cookie }, payload });

    const denied = (await evaluate({ projectId: "default", role: "viewer", serverId, toolName: "calculator" })).json();
    expect(denied).toMatchObject({
      allowed: false,
      reason: "policy",
      ruleId: deny.id,
      ruleName: "Viewers off",
      decidedBy: "rule",
      server: { kind: "registry", id: serverId, adapterId: "mock-mcp" }
    });
    expect(denied.matchedRules.map((rule: McpToolPolicyRule) => rule.id)).toEqual([deny.id]);

    const carved = (await evaluate({ role: "viewer", serverId, toolName: "lookup_kb" })).json();
    expect(carved).toMatchObject({ allowed: true, decidingRuleId: allow.id, overriddenDenies: [{ denyId: deny.id, byId: allow.id }] });
    expect(carved.classification).toEqual({ readOnly: true, source: "annotation" });

    const noWrite = (await evaluate({ role: "builder", serverId, toolName: "calculator", noWriteTools: true })).json();
    expect(noWrite).toMatchObject({ allowed: false, reason: "no_write_tools", classification: { readOnly: false, source: "unknown" } });

    await context.app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${serverId}/tools/calculator/classification`,
      headers: { cookie: admin.cookie },
      payload: { readOnly: true }
    });
    const manual = (await evaluate({ role: "builder", serverId, toolName: "calculator", noWriteTools: true })).json();
    expect(manual).toMatchObject({ allowed: true, classification: { readOnly: true, source: "manual" }, manualReadOnly: true });

    const inline = (await evaluate({ role: "viewer", serverId: "mock-mcp", toolName: "calculator" })).json();
    expect(inline).toMatchObject({ allowed: true, decidedBy: "default", server: { kind: "inline", adapterId: "mock-mcp" } });

    expect((await evaluate({ role: "viewer", serverId: "nope", toolName: "x" })).statusCode).toBe(404);
    expect((await evaluate({ role: "root", serverId, toolName: "x" })).statusCode).toBe(400);
  });

  it("marks, but does not hide, tools the caller's role cannot use", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin.cookie);
    const rule = await createRule(context, admin.cookie, { name: "No builder calc", effect: "deny", roles: ["builder"], toolPattern: "calculator" });

    const tools = await context.app.inject({ method: "GET", url: `/api/mcp/servers/${serverId}/tools`, headers: { cookie: builder.cookie } });
    const body = tools.json<{
      policy: { role: string; projectId: string };
      tools: Array<{ name: string; access: { allowed: boolean; ruleId?: string }; classification: { source: string } }>;
    }>();
    expect(body.policy).toEqual({ role: "builder", projectId: "default" });
    expect(body.tools).toHaveLength(5);
    const calc = body.tools.find((tool) => tool.name === "calculator")!;
    expect(calc.access).toMatchObject({ allowed: false, reason: "policy", ruleId: rule.id, ruleName: "No builder calc" });
    expect(calc.classification).toEqual({ readOnly: false, source: "unknown" });
    expect(body.tools.find((tool) => tool.name === "lookup_kb")!.classification).toEqual({ readOnly: true, source: "annotation" });

    const adminView = await context.app.inject({ method: "GET", url: `/api/mcp/servers/${serverId}/tools`, headers: { cookie: admin.cookie } });
    expect(adminView.json<{ tools: Array<{ access: { allowed: boolean } }> }>().tools.every((tool) => tool.access.allowed)).toBe(true);

    // Inline discovery: the adapter id is the server.
    await createRule(context, admin.cookie, { effect: "deny", roles: ["builder"], serverId: "mock-mcp", toolPattern: "lookup_kb" });
    const discovered = await context.app.inject({
      method: "POST",
      url: "/api/mcp/discover-tools",
      headers: { cookie: builder.cookie },
      payload: { serverId: "mock-mcp", projectId: "default" }
    });
    const discoveredTools = discovered.json<{ tools: Array<{ name: string; access: { allowed: boolean }; annotations?: unknown }> }>().tools;
    expect(discoveredTools).toHaveLength(5);
    expect(discoveredTools.find((tool) => tool.name === "lookup_kb")!.access.allowed).toBe(false);
    expect(discoveredTools.find((tool) => tool.name === "calculator")!.access.allowed).toBe(false);
    expect(discoveredTools.find((tool) => tool.name === "get_current_time")!.annotations).toEqual({ readOnlyHint: true });
  });
});

describe("whose role a run is evaluated with", () => {
  it("uses the triggering user's role for manual runs", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin.cookie);
    // Owned by the admin, so a builder-only rule can only apply through the triggering user.
    await context.store.upsertWorkflow(calculatorWorkflow("wf-manual", serverId), { createdBy: admin.id });
    await createRule(context, admin.cookie, { name: "Builders: no calculator", effect: "deny", roles: ["builder"], toolPattern: "calculator" });

    const run = (cookie: string) =>
      context.app.inject({ method: "POST", url: "/api/workflows/wf-manual/execute", headers: { cookie }, payload: {} });

    const asBuilder = await run(builder.cookie);
    expect(asBuilder.statusCode).toBe(400);
    expect(asBuilder.body).toContain("blocked by policy 'Builders: no calculator'");
    expect(asBuilder.body).toContain("for role builder");
    expect((await run(admin.cookie)).statusCode).toBe(200);
  });

  it("uses the workflow owner's role for webhook runs, and viewer when the owner is unknown", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin.cookie);

    const saved = await context.app.inject({
      method: "POST",
      url: "/api/workflows",
      headers: { cookie: builder.cookie },
      payload: calculatorWorkflow("wf-hook", serverId)
    });
    expect(saved.statusCode).toBe(200);
    expect(await context.store.getWorkflowCreatedBy("wf-hook")).toBe(builder.id);

    const hook = () => context.app.inject({ method: "POST", url: "/webhook/calc-wf-hook", payload: {} });
    expect((await hook()).statusCode).toBe(200);

    const builderRule = await createRule(context, admin.cookie, { effect: "deny", roles: ["builder"], toolPattern: "calculator" });
    const blocked = await hook();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.body).toContain("for role builder");

    await context.app.inject({ method: "DELETE", url: `/api/mcp/policies/${builderRule.id}`, headers: { cookie: admin.cookie } });
    await createRule(context, admin.cookie, { name: "Viewers: no calculator", effect: "deny", roles: ["viewer"], toolPattern: "calculator" });
    expect((await hook()).statusCode).toBe(200);

    // No recorded owner: the run is evaluated as viewer.
    await context.store.upsertWorkflow({ ...calculatorWorkflow("wf-orphan", serverId) });
    expect(await context.store.getWorkflowCreatedBy("wf-orphan")).toBeNull();
    const orphan = await context.app.inject({ method: "POST", url: "/webhook/calc-wf-orphan", payload: {} });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.body).toContain("for role viewer");
  });

  it("resolves subjects: user, owner, missing owner, unknown owner", async () => {
    const users: Record<string, { id: string; email: string; role: string }> = {
      "u-builder": { id: "u-builder", email: "b@example.com", role: "builder" }
    };
    const owners: Record<string, string | null> = { "wf-owned": "u-builder", "wf-gone": "u-deleted", "wf-none": null };
    const store = {
      getWorkflowCreatedBy: async (id: string) => owners[id] ?? null,
      getUserById: async (id: string) => users[id] ?? null
    };

    expect(await resolveMcpToolPolicySubject(store, "wf-owned", { id: "u-op", email: "op@example.com", role: "operator" })).toEqual({
      role: "operator",
      source: "user",
      userId: "u-op",
      email: "op@example.com"
    });
    expect(await resolveMcpToolPolicySubject(store, "wf-owned")).toEqual({
      role: "builder",
      source: "owner",
      userId: "u-builder",
      email: "b@example.com"
    });
    expect(await resolveMcpToolPolicySubject(store, "wf-gone")).toMatchObject({
      role: "viewer",
      source: "fallback",
      fallbackReason: "the workflow owner no longer exists"
    });
    expect(await resolveMcpToolPolicySubject(store, "wf-none")).toMatchObject({
      role: "viewer",
      source: "fallback",
      fallbackReason: "the workflow has no recorded owner"
    });
  });
});

describe("workflows.created_by", () => {
  it("is set on create, duplicate and import, and never changed by later saves", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const other = await login(context, "builder", "other-builder");
    const serverId = await registerMockServer(context, admin.cookie);
    const workflow = calculatorWorkflow("wf-owned", serverId);

    await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie: builder.cookie }, payload: workflow });
    expect(await context.store.getWorkflowCreatedBy("wf-owned")).toBe(builder.id);

    const resaved = await context.app.inject({
      method: "PUT",
      url: "/api/workflows/wf-owned",
      headers: { cookie: other.cookie },
      payload: { ...workflow, name: "Renamed", settings: { noWriteTools: true } }
    });
    expect(resaved.statusCode).toBe(200);
    expect(await context.store.getWorkflowCreatedBy("wf-owned")).toBe(builder.id);
    expect((await context.store.getWorkflow("wf-owned"))?.settings).toEqual({ noWriteTools: true });

    const duplicate = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-owned/duplicate",
      headers: { cookie: other.cookie },
      payload: { name: "Copy" }
    });
    expect(await context.store.getWorkflowCreatedBy(duplicate.json<{ id: string }>().id)).toBe(other.id);

    const imported = await context.app.inject({
      method: "POST",
      url: "/api/workflows/import",
      headers: { cookie: other.cookie },
      // Its own webhook path: an active workflow's path is not free for another one (Phase 15.4).
      payload: { workflow: calculatorWorkflow("wf-imported", serverId) }
    });
    expect(imported.statusCode).toBe(200);
    expect(await context.store.getWorkflowCreatedBy("wf-imported")).toBe(other.id);
  });

  // SQLite-specific: the embedded migrate() upgrading a pre-10.2 SQLite file rewound with better-sqlite3.
  it("is added to an existing database and backfilled from the earliest version author", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-policy-migrate-"));
    tempDirs.push(tempDir);
    const dbFile = path.join(tempDir, "orchestrator.db");
    const first = await SqliteStore.create(dbFile);
    await first.ensureDefaultProject();
    await first.upsertWorkflow({ id: "wf-a", name: "A", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    await first.upsertWorkflow({ id: "wf-b", name: "B", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    await first.close();

    // Rewind the file to the pre-10.2 schema: no created_by column, no policy tables.
    const raw = new Database(dbFile);
    raw.exec("ALTER TABLE workflows DROP COLUMN created_by");
    raw.exec("DROP TABLE mcp_tool_policies");
    raw.exec("DROP TABLE mcp_tool_classifications");
    const insertVersion = raw.prepare(
      "INSERT INTO workflow_versions (id, workflow_id, version, workflow_json, created_by, change_note, created_at) VALUES (?, ?, ?, '{}', ?, NULL, ?)"
    );
    insertVersion.run("v1", "wf-a", 1, null, "2026-01-01T00:00:00.000Z");
    insertVersion.run("v2", "wf-a", 2, "u-first", "2026-01-02T00:00:00.000Z");
    insertVersion.run("v3", "wf-a", 3, "u-later", "2026-01-03T00:00:00.000Z");
    raw.close();

    const upgraded = await SqliteStore.create(dbFile);
    try {
      expect((await upgraded.getWorkflow("wf-a"))?.name).toBe("A");
      expect(await upgraded.getWorkflowCreatedBy("wf-a")).toBe("u-first");
      expect(await upgraded.getWorkflowCreatedBy("wf-b")).toBeNull();
      expect(await upgraded.listMcpToolPolicies()).toEqual([]);
      const rule = await upgraded.createMcpToolPolicy({
        id: "r1",
        name: null,
        description: null,
        effect: "deny",
        projectId: null,
        roles: ["viewer"],
        serverId: null,
        toolPattern: "*",
        enabled: true
      });
      expect(await upgraded.listMcpToolPolicies()).toEqual([rule]);
      expect(await upgraded.setMcpToolClassification({ registryServerId: "mcp_x", toolName: "t", readOnly: true, setBy: null })).toMatchObject({
        readOnly: true
      });
    } finally {
      await upgraded.close();
    }
  });
});
