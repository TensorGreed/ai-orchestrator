/**
 * Phase 12.2 — provenance policies over the API: safety presets (created in shadow, enforced through the tighten-only
 * checks), the per-workflow "Approve writes only after untrusted content" switch, per-tool open-world overrides, the
 * labels recorded on telemetry rows, and simulation over them.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  mcpSafetyPresetRule,
  mcpSafetyPresetRuleId,
  untrustedWriteSwitchRule,
  untrustedWriteSwitchRuleId,
  type McpPolicySimulationResult,
  type McpToolPolicyRule,
  type Workflow
} from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { McpPolicyEnforceGuard, Store } from "./db/store.js";
import { McpPolicyEnforceRefusedError } from "./db/store-errors.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { wrapStore?: (store: Store) => Store } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-taint-"));
  const opened = await openTestStore(path.join(tempDir, "orchestrator.db"));
  const store = options.wrapStore ? options.wrapStore(opened) : opened;
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

function extractCookie(setCookieHeader: string | string[] | undefined, cookieName: string): string {
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const cookie = values.find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Cookie '${cookieName}' was not set`);
  return cookie.split(";")[0];
}

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  return extractCookie(response.headers["set-cookie"], context.config.SESSION_COOKIE_NAME);
}

function caller(context: TestContext) {
  return (cookie: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    context.app.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function registerMockServer(context: TestContext, adminCookie: string): Promise<string> {
  const call = caller(context);
  const created = await call(adminCookie, "POST", "/api/mcp/servers", { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false });
  const id = created.json<{ server: { id: string } }>().server.id;
  expect((await call(adminCookie, "POST", `/api/mcp/servers/${id}/probe`)).statusCode).toBe(200);
  return id;
}

function calculatorWorkflow(id: string, registryServerId: string): Workflow {
  return {
    id,
    name: `Calculator ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `calc-${id}`, method: "POST" } },
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

describe("safety presets", () => {
  it("lists the presets for builders and lets only admins add one, in shadow, once", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const operator = await login(context, "operator");

    expect((await call(operator, "GET", "/api/mcp/policies/presets")).statusCode).toBe(403);
    const listed = await call(builder, "GET", "/api/mcp/policies/presets");
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ presets: Array<{ id: string; added: boolean }> }>().presets.map((preset) => [preset.id, preset.added])).toEqual([
      ["untrusted_write_approval", false],
      ["sensitive_no_open_world", false]
    ]);
    expect((await call(builder, "POST", "/api/mcp/policies/presets/untrusted_write_approval")).statusCode).toBe(403);
    expect((await call(admin, "POST", "/api/mcp/policies/presets/nope")).statusCode).toBe(404);

    const added = await call(admin, "POST", "/api/mcp/policies/presets/untrusted_write_approval");
    expect(added.statusCode).toBe(201);
    expect(added.json<{ rule: McpToolPolicyRule }>().rule).toMatchObject({
      id: mcpSafetyPresetRuleId("untrusted_write_approval"),
      mode: "shadow",
      effect: "require_approval",
      annotationHint: "not_read_only",
      createdBy: "admin@example.com"
    });
    expect((await call(admin, "POST", "/api/mcp/policies/presets/untrusted_write_approval")).statusCode).toBe(409);
    const after = (await call(builder, "GET", "/api/mcp/policies/presets")).json<{ presets: Array<{ id: string; added: boolean; mode?: string; customised?: boolean }> }>();
    expect(after.presets[0]).toMatchObject({ added: true, mode: "shadow", customised: false });

    const audit = (await context.store.listAuditLogs({ eventType: "mcp_policy.created", pageSize: 5 })).items;
    expect(audit[0]?.metadata).toMatchObject({ preset: "untrusted_write_approval", mode: "shadow" });

    // Enforcing is the usual step, with its checks.
    const enforced = await call(admin, "POST", `/api/mcp/policies/${mcpSafetyPresetRuleId("untrusted_write_approval")}/enforce`);
    expect(enforced.statusCode, enforced.body).toBe(200);
    expect(enforced.json<{ rule: McpToolPolicyRule }>().rule.mode).toBe("enforce");
  });

  it("adds an additive rule: a deny enforced after the preset still denies a write with untrusted content", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin);
    expect((await call(admin, "POST", "/api/mcp/policies/presets/untrusted_write_approval")).statusCode).toBe(201);
    const presetId = mcpSafetyPresetRuleId("untrusted_write_approval");
    const stored = await context.store.getMcpToolPolicy(presetId);
    expect(stored?.additive).toBe(true);
    // Enforcing it no longer counts as carving anything: it never sets a rule aside.
    expect((await call(admin, "POST", `/api/mcp/policies/${presetId}/enforce`)).statusCode).toBe(200);
    const evaluate = () =>
      call(admin, "POST", "/api/mcp/policies/evaluate", {
        role: "builder",
        serverId,
        toolName: "calculator",
        projectId: "default",
        arguments: { expression: "1+1" },
        labels: ["untrusted_external"]
      });
    expect((await evaluate()).json()).toMatchObject({ effect: "require_approval" });

    const deny = await call(admin, "POST", "/api/mcp/policies", { name: "No write tools", effect: "deny", annotationHint: "not_read_only" });
    expect(deny.statusCode).toBe(201);
    expect((await evaluate()).json()).toMatchObject({ allowed: false, effect: "deny", ruleName: "No write tools" });

    // Admins see the flag; the rule editor cannot change it.
    const listed = (await call(admin, "GET", "/api/mcp/policies")).json<{ rules: McpToolPolicyRule[] }>().rules;
    expect(listed.find((rule) => rule.id === presetId)?.additive).toBe(true);
    expect(listed.find((rule) => rule.id !== presetId)?.additive).toBeUndefined();
    const edited = await call(admin, "PUT", `/api/mcp/policies/${presetId}`, { additive: false, name: "Renamed" });
    expect(edited.statusCode).toBe(200);
    expect((await context.store.getMcpToolPolicy(presetId))?.additive).toBe(true);
    expect((await evaluate()).json()).toMatchObject({ effect: "deny" });
  });
});

describe("the workflow's untrusted-write switch", () => {
  it("creates an enforced workflow-scoped rule, and removes it again", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    const serverId = await registerMockServer(context, admin);
    expect((await call(builder, "POST", "/api/workflows", calculatorWorkflow("wf-switch", serverId))).statusCode).toBe(200);
    const url = "/api/workflows/wf-switch/untrusted-write-approval";

    expect((await call(viewer, "GET", url)).json()).toMatchObject({ switch: { enabled: false } });
    expect((await call(viewer, "PUT", url, { enabled: true })).statusCode).toBe(403);
    expect((await call(builder, "PUT", url, { enabled: "yes" })).statusCode).toBe(400);
    expect((await call(builder, "PUT", "/api/workflows/missing/untrusted-write-approval", { enabled: true })).statusCode).toBe(404);

    const on = await call(builder, "PUT", url, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ switch: { enabled: true, mode: "enforce", customised: false } });
    const rule = await context.store.getMcpToolPolicy(untrustedWriteSwitchRuleId("wf-switch"));
    expect(rule).toMatchObject({ workflowIds: ["wf-switch"], mode: "enforce", effect: "require_approval" });
    // Turning it on again changes nothing.
    expect((await call(builder, "PUT", url, { enabled: true })).json()).toMatchObject({ switch: { enabled: true } });

    // A plain webhook is untrusted: the write tool now waits for an approval.
    const hooked = await context.app.inject({ method: "POST", url: "/webhook/calc-wf-switch", payload: { note: "hello" } });
    expect(hooked.body).toMatch(/approval/i);

    const off = await call(builder, "PUT", url, { enabled: false });
    expect(off.json()).toMatchObject({ switch: { enabled: false } });
    expect(await context.store.getMcpToolPolicy(untrustedWriteSwitchRuleId("wf-switch"))).toBeNull();
    const audits = (await context.store.listAuditLogs({ eventType: "mcp_policy.deleted", pageSize: 5 })).items;
    expect(audits[0]?.metadata).toMatchObject({ source: "workflow_switch", workflowId: "wf-switch" });
  });

  it("never weakens a deny an admin enforces later: a write with untrusted content is still denied", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin);
    expect((await call(builder, "POST", "/api/workflows", calculatorWorkflow("wf-strict", serverId))).statusCode).toBe(200);
    const on = await call(builder, "PUT", "/api/workflows/wf-strict/untrusted-write-approval", { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect((await context.store.getMcpToolPolicy(untrustedWriteSwitchRuleId("wf-strict")))?.additive).toBe(true);

    // Later, an admin enforces a deny on every write tool.
    const deny = await call(admin, "POST", "/api/mcp/policies", { name: "No writes anywhere", effect: "deny", annotationHint: "not_read_only", mode: "shadow" });
    expect(deny.statusCode).toBe(201);
    expect((await call(admin, "POST", `/api/mcp/policies/${deny.json<{ rule: McpToolPolicyRule }>().rule.id}/enforce`)).statusCode).toBe(200);

    const evaluate = await call(admin, "POST", "/api/mcp/policies/evaluate", {
      role: "builder",
      serverId,
      toolName: "calculator",
      projectId: "default",
      workflowId: "wf-strict",
      arguments: { expression: "1+1" },
      labels: ["untrusted_external"]
    });
    expect(evaluate.json()).toMatchObject({ allowed: false, effect: "deny", ruleName: "No writes anywhere" });
    // A real run from a public webhook (untrusted) is denied, not held for approval.
    const hooked = await context.app.inject({ method: "POST", url: "/webhook/calc-wf-strict", payload: { note: "hello" } });
    expect(hooked.body).toContain("No writes anywhere");
    expect(hooked.body).not.toMatch(/waiting_approval/);

    // Turning it on with the deny already enforced works too, and the deny still wins.
    expect((await call(builder, "POST", "/api/workflows", calculatorWorkflow("wf-strict-2", serverId))).statusCode).toBe(200);
    expect((await call(builder, "PUT", "/api/workflows/wf-strict-2/untrusted-write-approval", { enabled: true })).statusCode).toBe(200);
  });

  it("creates and enforces in one transaction: a refusal writes nothing, is audited and answers 409", async () => {
    const context = await createTestContext({
      wrapStore: (store) =>
        new Proxy(store, {
          get(target, property, receiver) {
            if (property === "createEnforcedMcpToolPolicy") {
              return async (input: McpToolPolicyRule, options: { guard: McpPolicyEnforceGuard }) =>
                await target.createEnforcedMcpToolPolicy(input, { guard: (state) => options.guard(state) ?? "Refused for the test." });
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
        })
    });
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin);
    expect((await call(admin, "POST", "/api/workflows", calculatorWorkflow("wf-refused", serverId))).statusCode).toBe(200);
    const refused = await call(admin, "PUT", "/api/workflows/wf-refused/untrusted-write-approval", { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain("Refused for the test.");
    expect(await context.store.getMcpToolPolicy(untrustedWriteSwitchRuleId("wf-refused"))).toBeNull();
    const audit = (await context.store.listAuditLogs({ eventType: "mcp_policy.create_refused", pageSize: 5 })).items;
    expect(audit[0]?.metadata).toMatchObject({ source: "workflow_switch", workflowId: "wf-refused", reason: "Refused for the test." });
  });

  it("never shows the rule in shadow: the guard sees it in shadow inside the transaction only", async () => {
    const context = await createTestContext();
    const seen: Array<string | undefined> = [];
    const draft = { ...untrustedWriteSwitchRule("wf-tx"), createdBy: null };
    const rule = await context.store.createEnforcedMcpToolPolicy(draft, {
      guard: (state) => {
        seen.push(state.rules.find((entry) => entry.id === draft.id)?.mode);
        return null;
      }
    });
    expect(seen).toEqual(["shadow"]);
    expect(rule).toMatchObject({ id: draft.id, mode: "enforce", additive: true });
    await expect(context.store.createEnforcedMcpToolPolicy({ ...draft, id: "other" }, { guard: () => "no" })).rejects.toBeInstanceOf(McpPolicyEnforceRefusedError);
    expect(await context.store.getMcpToolPolicy("other")).toBeNull();
  });

  it("only lets an admin turn off a rule an admin has changed", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin);
    expect((await call(builder, "POST", "/api/workflows", calculatorWorkflow("wf-custom", serverId))).statusCode).toBe(200);
    const url = "/api/workflows/wf-custom/untrusted-write-approval";
    expect((await call(builder, "PUT", url, { enabled: true })).statusCode).toBe(200);
    expect((await call(admin, "PUT", `/api/mcp/policies/${untrustedWriteSwitchRuleId("wf-custom")}`, { serverId })).statusCode).toBe(200);
    expect((await call(builder, "GET", url)).json()).toMatchObject({ switch: { enabled: true, customised: true } });
    expect((await call(builder, "PUT", url, { enabled: false })).statusCode).toBe(403);
    expect((await call(admin, "PUT", url, { enabled: false })).statusCode).toBe(200);
  });
});

describe("open-world overrides", () => {
  it("lets admins set and clear a tool's open-world value, shown on the server's tools", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const serverId = await registerMockServer(context, admin);
    const url = `/api/mcp/servers/${serverId}/tools/calculator/open-world`;
    expect((await call(builder, "PUT", url, { openWorld: false })).statusCode).toBe(403);
    expect((await call(admin, "PUT", url, { openWorld: "no" })).statusCode).toBe(400);

    const tools = async () =>
      (await call(builder, "GET", `/api/mcp/servers/${serverId}/tools`)).json<{ tools: Array<{ name: string; openWorld?: { openWorld: boolean; source: string }; manualOpenWorld?: boolean | null }> }>()
        .tools.find((tool) => tool.name === "calculator");
    // The mock server sends nothing over the network: the tool's hint decides (missing = open world).
    expect(await tools()).toMatchObject({ openWorld: { openWorld: true, source: "annotation" }, manualOpenWorld: null });

    const set = await call(admin, "PUT", url, { openWorld: false });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ openWorld: { openWorld: false, source: "manual" }, manualOpenWorld: false });
    expect(await tools()).toMatchObject({ openWorld: { openWorld: false, source: "manual" }, manualOpenWorld: false });
    const audit = (await context.store.listAuditLogs({ eventType: "mcp_policy.open_world_set", pageSize: 5 })).items;
    expect(audit[0]?.metadata).toMatchObject({ serverId, toolName: "calculator", openWorld: false });

    // A deny on open-world tools follows the override.
    expect((await call(admin, "POST", "/api/mcp/policies", { effect: "deny", annotationHint: "open_world", serverId })).statusCode).toBe(201);
    const evaluate = (toolName: string) => call(builder, "POST", "/api/mcp/policies/evaluate", { role: "builder", serverId, toolName, projectId: "default" });
    expect((await evaluate("calculator")).json()).toMatchObject({ allowed: true, openWorld: { openWorld: false, source: "manual" } });
    expect((await evaluate("get_current_time")).json()).toMatchObject({ allowed: false });

    // An inline server: the connection sent decides its destination; without one it is unknown, so open world.
    const inline = (connection?: Record<string, unknown>) =>
      call(builder, "POST", "/api/mcp/policies/evaluate", { role: "builder", serverId: "http_mcp", toolName: "post_note", projectId: "default", ...(connection ? { connection } : {}) });
    expect((await inline()).json()).toMatchObject({ openWorld: { openWorld: true, source: "unknown" } });
    expect((await inline({ endpoint: "https://notes.example.com/mcp" })).json()).toMatchObject({ openWorld: { openWorld: true, source: "unknown" } });
    expect((await inline({ endpoint: "http://127.0.0.1:9000/mcp" })).json()).toMatchObject({ openWorld: { source: "annotation" } });
    expect(JSON.stringify((await inline({ endpoint: "http://127.0.0.1:9000/mcp", headers: { authorization: "Bearer s3cr3t" } })).json())).not.toContain("s3cr3t");

    expect((await call(admin, "PUT", url, { openWorld: null })).json()).toMatchObject({ override: null, manualOpenWorld: null });
    expect((await evaluate("calculator")).json()).toMatchObject({ allowed: false });
    expect(await context.store.listMcpToolOpenWorldOverrides(serverId)).toEqual([]);
  });
});

describe("recorded labels and simulation", () => {
  it("records the labels each call was decided with, and simulates label rules from them", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin);
    expect((await call(admin, "POST", "/api/workflows", calculatorWorkflow("wf-labels", serverId))).statusCode).toBe(200);
    const hooked = await context.app.inject({ method: "POST", url: "/webhook/calc-wf-labels", payload: { secret: "s3cr3t-value" } });
    expect(hooked.statusCode, hooked.body).toBe(200);

    const [row] = await context.store.scanMcpToolCalls({ since: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 60_000).toISOString(), before: null, limit: 10, sources: ["workflow"] });
    expect(row?.labels).toEqual({ provenance: ["untrusted_external"], tracked: false });
    expect(row?.policyDecision ?? null).toBeNull();
    expect(JSON.stringify(row?.labels)).not.toContain("s3cr3t");

    const simulate = async (addRule: Record<string, unknown>) => {
      const response = await call(admin, "POST", "/api/mcp/policies/simulate", { windowDays: 7, addRule });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ simulation: McpPolicySimulationResult }>().simulation;
    };
    const { id: _id, mode: _mode, ...untrusted } = mcpSafetyPresetRule("untrusted_write_approval");
    expect((await simulate(untrusted)).counts).toMatchObject({ newly_needs_approval: 1, undetermined: 0 });
    // `sensitive` needs a run that tracked labels: this one did not, so the call stays undetermined.
    const { id: _sid, mode: _smode, ...sensitive } = mcpSafetyPresetRule("sensitive_no_open_world");
    expect((await simulate(sensitive)).counts).toMatchObject({ undetermined: 1 });
  });

  it("changes nothing for a workflow when no preset or switch is on", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const serverId = await registerMockServer(context, admin);
    expect((await call(admin, "POST", "/api/workflows", calculatorWorkflow("wf-plain", serverId))).statusCode).toBe(200);
    const hooked = await context.app.inject({ method: "POST", url: "/webhook/calc-wf-plain", payload: {} });
    expect(hooked.statusCode).toBe(200);
    expect(await context.store.listMcpToolPolicies()).toEqual([]);
  });
});
