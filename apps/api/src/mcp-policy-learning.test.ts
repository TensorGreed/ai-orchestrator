/**
 * Phase 12.4 — policies learned from real runs over the API: simulate, shadow hits, and the suggestion review flow
 * (generate, accept in shadow, enforce, dismiss), admin only and audited. Runs on the test store (SQLite, or
 * Postgres under TEST_STORE=postgres).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpPolicySimulationResult, McpPolicySuggestion, McpToolPolicyRule, ToolArgumentSummary } from "@ai-orchestrator/shared";
import { evaluateMcpToolPolicy, toolArgumentHashKeyId } from "@ai-orchestrator/mcp-sdk";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { McpToolCallWrite } from "./db/database.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { toolArgumentHashKey } from "./services/tool-argument-summary.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-policy-learning-"));
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

async function login(context: TestContext, role: "admin" | "builder" | "operator" | "viewer"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const values = ([] as string[]).concat(response.headers["set-cookie"] ?? []);
  return values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
}

async function setup() {
  const context = await createTestContext();
  const admin = await login(context, "admin");
  const builder = await login(context, "builder");
  const created = await context.app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { cookie: admin },
    payload: { name: "Mock tools", adapterId: "mock-mcp", probeEnabled: false }
  });
  const serverId = created.json<{ server: { id: string } }>().server.id;
  await context.store.upsertWorkflow({ id: "wf_notes", name: "Release notes", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
  let seq = 0;
  const kid = toolArgumentHashKeyId(toolArgumentHashKey(context.config.SECRET_MASTER_KEY_BASE64));
  const record = async (overrides: Partial<McpToolCallWrite> = {}) => {
    seq += 1;
    await context.store.insertMcpToolCall({
      id: `mtc_${String(seq).padStart(5, "0")}`,
      executionId: `exec_${seq}`,
      workflowId: "wf_notes",
      nodeId: "agent",
      registryServerId: serverId,
      adapterId: "mock-mcp",
      toolName: seq % 2 === 0 ? "calculator" : "echo",
      startedAt: new Date(Date.now() - (60 + seq) * 1000).toISOString(),
      durationMs: 3,
      ok: true,
      error: null,
      turnInputTokens: null,
      turnOutputTokens: null,
      estimatedCostUsd: null,
      subjectRole: "builder",
      subjectSource: "user",
      projectId: "default",
      argsSummary: { v: 3, kid, fields: { op: { type: "string", values: [seq % 4 < 2 ? "add" : "mul"] } } } as ToolArgumentSummary,
      ...overrides
    });
  };
  const call = (method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: unknown) =>
    context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  /** What the enforced rules decide now for a builder in the workflow calling `toolName` on the server. */
  const decide = async (toolName: string) =>
    evaluateMcpToolPolicy(await context.store.listMcpToolPolicies(), {
      role: "builder",
      projectId: "default",
      adapterId: "mock-mcp",
      registryServerId: serverId,
      toolName,
      workflowId: "wf_notes",
      clientId: null,
      arguments: { op: "add" },
      dataLabels: null
    }).effect;
  const generateAndAccept = async () => {
    for (let index = 0; index < 20; index += 1) await record();
    const generated = await call("POST", "/api/mcp/policies/suggestions/generate", admin, {});
    const [suggestion] = generated.json<{ result: { suggestions: McpPolicySuggestion[] } }>().result.suggestions;
    const accepted = await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/accept`, admin, { fingerprint: suggestion!.fingerprint });
    expect(accepted.statusCode, accepted.body).toBe(200);
    return { suggestion: suggestion!, rules: accepted.json<{ rules: McpToolPolicyRule[] }>().rules };
  };
  const audits = async (eventType: string) =>
    (await context.store.listAuditLogs({ resourceType: "mcp_policy" })).items.filter((entry) => entry.eventType === eventType);
  return { context, admin, builder, serverId, record, call, decide, generateAndAccept, audits };
}

describe("MCP policy simulation and suggestions API", () => {
  it("is admin only and validates its input", async () => {
    const { builder, admin, call } = await setup();
    for (const [method, url] of [
      ["POST", "/api/mcp/policies/simulate"],
      ["GET", "/api/mcp/policies/shadow-hits"],
      ["GET", "/api/mcp/policies/suggestions"],
      ["POST", "/api/mcp/policies/suggestions/generate"],
      ["POST", "/api/mcp/policies/suggestions/mps_x/accept"],
      ["POST", "/api/mcp/policies/suggestions/mps_x/dismiss"],
      ["POST", "/api/mcp/policies/suggestions/mps_x/enforce"],
      ["POST", "/api/mcp/policies/mtp_x/enforce"]
    ] as const) {
      expect((await call(method, url, builder, method === "POST" ? {} : undefined)).statusCode, url).toBe(403);
    }
    expect((await call("POST", "/api/mcp/policies/simulate", admin, {})).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/simulate", admin, { windowDays: 14, addRule: { effect: "deny" } })).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/simulate", admin, { addRule: { effect: "deny" }, extra: 1 })).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/simulate", admin, { rules: [{ keep: "mtp_missing" }] })).statusCode).toBe(400);
    expect((await call("GET", "/api/mcp/policies/shadow-hits?days=90", admin)).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/suggestions/generate", admin, { minCalls: 1 })).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/suggestions/mps_x/accept", admin, {})).statusCode).toBe(400);
    expect((await call("POST", "/api/mcp/policies/suggestions/mps_x/accept", admin, { fingerprint: "a".repeat(64) })).statusCode).toBe(404);
  });

  it("simulates a draft rule on recorded calls without changing anything", async () => {
    const { context, admin, record, call, audits } = await setup();
    for (let index = 0; index < 4; index += 1) await record();
    await record({ argsSummary: null });
    const response = await call("POST", "/api/mcp/policies/simulate", admin, {
      windowDays: 7,
      addRule: { effect: "deny", toolPattern: "echo", conditions: { all: [{ path: "op", op: "equals", value: "add" }] } }
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ simulation: McpPolicySimulationResult }>().simulation;
    expect(result).toMatchObject({ scanned: 5, capped: false, counts: { newly_denied: 1, unchanged: 3, not_summarised: 1 } });
    expect(result.groups[0]).toMatchObject({ kind: "workflow", id: "wf_notes", name: "Release notes" });
    expect(result.examples.newly_denied[0]?.summary).toMatchObject({ v: 3, fields: { op: { type: "string", values: ["add"] } } });
    expect(await context.store.listMcpToolPolicies()).toEqual([]);
    // Audited by rule hash and filters, never the rule's literals.
    const [audit] = await audits("mcp_policy.simulated");
    expect(audit?.metadata).toMatchObject({ windowDays: 7, mode: "add_rule", filters: {}, scanned: 5 });
    expect((audit?.metadata as { ruleHashes: string[] }).ruleHashes).toHaveLength(1);
    expect(JSON.stringify(audit?.metadata)).not.toContain("add\"");
  });

  it("generates, accepts in shadow, counts shadow hits and enforces, auditing each step", async () => {
    const { context, admin, record, call } = await setup();
    for (let index = 0; index < 20; index += 1) await record();
    const generated = await call("POST", "/api/mcp/policies/suggestions/generate", admin, {});
    expect(generated.statusCode, generated.body).toBe(200);
    const [suggestion] = generated.json<{ result: { suggestions: McpPolicySuggestion[] } }>().result.suggestions;
    expect(suggestion?.rules.map((rule) => `${rule.effect}:${rule.toolPattern}`)).toEqual(["deny:*", "allow:calculator", "allow:echo"]);
    // Generating again right away is rate limited.
    expect((await call("POST", "/api/mcp/policies/suggestions/generate", admin, {})).statusCode).toBe(429);

    const listed = await call("GET", "/api/mcp/policies/suggestions", admin);
    expect(listed.json<{ suggestions: McpPolicySuggestion[] }>().suggestions.map((entry) => entry.id)).toEqual([suggestion!.id]);

    // Accepting needs the fingerprint of the proposal reviewed.
    expect((await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/accept`, admin, { fingerprint: "0".repeat(64) })).statusCode).toBe(409);
    const accepted = await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/accept`, admin, { fingerprint: suggestion!.fingerprint });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const { rules } = accepted.json<{ rules: McpToolPolicyRule[] }>();
    expect(rules.map((rule) => rule.mode)).toEqual(["shadow", "shadow", "shadow"]);
    expect((await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/accept`, admin, { fingerprint: suggestion!.fingerprint })).statusCode).toBe(409);
    expect((await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/dismiss`, admin, {})).statusCode).toBe(409);

    const deny = rules.find((rule) => rule.effect === "deny")!;
    await record({
      toolName: "delete_all",
      policyDecision: {
        effect: "allow",
        decidedBy: "default",
        matched: [{ ruleId: deny.id, mode: "shadow", effect: "deny" }],
        shadow: { effect: "deny", ruleId: deny.id, changed: true }
      }
    });
    const hits = await call("GET", "/api/mcp/policies/shadow-hits?days=7", admin);
    expect(hits.json<{ shadowHits: { rules: Array<{ ruleId: string; matched: number; wouldChange: number }> } }>().shadowHits.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: deny.id, matched: 1, wouldChange: 1 })])
    );

    const enforced = await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/enforce`, admin, {});
    expect(enforced.statusCode, enforced.body).toBe(200);
    expect(enforced.json<{ rules: McpToolPolicyRule[] }>().rules.map((rule) => `${rule.effect}:${rule.mode}`)).toEqual([
      "allow:enforce",
      "allow:enforce",
      "deny:enforce"
    ]);
    expect((await call("POST", `/api/mcp/policies/${deny.id}/enforce`, admin, {})).statusCode).toBe(409);

    const events = (await context.store.listAuditLogs({ resourceType: "mcp_policy" })).items.map((entry) => entry.eventType);
    expect(events.filter((event) => event === "mcp_policy.created")).toHaveLength(3);
    expect(events.filter((event) => event === "mcp_policy.enforced")).toHaveLength(3);
    expect(events).toContain("mcp_policy.suggestion_accepted");
    const enforcedAudit = (await context.store.listAuditLogs({ resourceType: "mcp_policy" })).items.find(
      (entry) => entry.eventType === "mcp_policy.enforced" && entry.resourceId === deny.id
    );
    expect(enforcedAudit?.metadata).toMatchObject({ shadowMatched: 1, shadowWouldChangeAlone: 1, suggestionShadowWouldChange: 1, previousMode: "shadow" });
  });

  it("dismisses a suggestion and enforces a single shadow rule", async () => {
    const { context, admin, record, call } = await setup();
    for (let index = 0; index < 20; index += 1) await record();
    const [suggestion] = (await call("POST", "/api/mcp/policies/suggestions/generate", admin, {})).json<{ result: { suggestions: McpPolicySuggestion[] } }>()
      .result.suggestions;
    const dismissed = await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/dismiss`, admin, {});
    expect(dismissed.json<{ suggestion: McpPolicySuggestion }>().suggestion.status).toBe("dismissed");
    expect((await call("GET", "/api/mcp/policies/suggestions", admin)).json<{ suggestions: unknown[] }>().suggestions).toEqual([]);
    expect((await call("GET", "/api/mcp/policies/suggestions?status=all", admin)).json<{ suggestions: unknown[] }>().suggestions).toHaveLength(1);

    const created = await call("POST", "/api/mcp/policies", admin, { effect: "deny", toolPattern: "echo", mode: "shadow" });
    const rule = created.json<{ rule: McpToolPolicyRule }>().rule;
    const enforced = await call("POST", `/api/mcp/policies/${rule.id}/enforce`, admin, {});
    expect(enforced.json<{ rule: McpToolPolicyRule }>().rule.mode).toBe("enforce");
    const events = (await context.store.listAuditLogs({ resourceType: "mcp_policy" })).items.map((entry) => entry.eventType);
    expect(events).toEqual(expect.arrayContaining(["mcp_policy.suggestion_dismissed", "mcp_policy.enforced"]));
  });

  it("refuses to accept a suggestion that would now loosen a rule added since", async () => {
    const { admin, record, call } = await setup();
    for (let index = 0; index < 20; index += 1) await record();
    const [suggestion] = (await call("POST", "/api/mcp/policies/suggestions/generate", admin, {})).json<{ result: { suggestions: McpPolicySuggestion[] } }>()
      .result.suggestions;
    await call("POST", "/api/mcp/policies", admin, { effect: "deny", toolPattern: "echo" });
    const accepted = await call("POST", `/api/mcp/policies/suggestions/${suggestion!.id}/accept`, admin, { fingerprint: suggestion!.fingerprint });
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json<{ error: string }>().error).toMatch(/carve an exception/);
  });

  it("refuses to enforce a suggestion's deny alone, and enforcing the suggestion keeps the scope's tools allowed", async () => {
    const { admin, call, decide, generateAndAccept, audits } = await setup();
    const { suggestion, rules } = await generateAndAccept();
    const deny = rules.find((rule) => rule.effect === "deny")!;
    const alone = await call("POST", `/api/mcp/policies/${deny.id}/enforce`, admin, {});
    expect(alone.statusCode).toBe(409);
    expect(alone.json<{ error: string }>().error).toMatch(/still in shadow: .*calculator.*echo/);
    expect(await audits("mcp_policy.enforced")).toEqual([]);
    expect(await decide("calculator")).toBe("allow");

    const together = await call("POST", `/api/mcp/policies/suggestions/${suggestion.id}/enforce`, admin, {});
    expect(together.statusCode, together.body).toBe(200);
    expect(await decide("calculator")).toBe("allow");
    expect(await decide("echo")).toBe("allow");
    expect(await decide("delete_all")).toBe("deny");
  });

  it("re-checks tighten-only when enforcing: an allow may not carve a deny added since", async () => {
    const { context, admin, call, generateAndAccept, audits } = await setup();
    const { suggestion, rules } = await generateAndAccept();
    // Days later an admin denies echo for everyone, enforced.
    const incident = (await call("POST", "/api/mcp/policies", admin, { name: "Incident: no echo", effect: "deny", toolPattern: "echo" })).json<{ rule: McpToolPolicyRule }>().rule;
    const group = await call("POST", `/api/mcp/policies/suggestions/${suggestion.id}/enforce`, admin, {});
    expect(group.statusCode).toBe(409);
    expect(group.json<{ error: string }>().error).toMatch(/Incident: no echo/);
    const echoAllow = rules.find((rule) => rule.toolPattern === "echo")!;
    expect((await call("POST", `/api/mcp/policies/${echoAllow.id}/enforce`, admin, {})).statusCode).toBe(409);
    // Nothing changed and nothing was audited.
    const after = await context.store.listMcpToolPolicies();
    expect(after.filter((rule) => rule.id !== incident.id).map((rule) => rule.mode)).toEqual(["shadow", "shadow", "shadow"]);
    expect(await audits("mcp_policy.enforced")).toEqual([]);
    // A shadow deny added since does not count: it decides nothing yet.
    await call("DELETE", `/api/mcp/policies/${incident.id}`, admin);
    await call("POST", "/api/mcp/policies", admin, { effect: "deny", toolPattern: "echo", mode: "shadow" });
    expect((await call("POST", `/api/mcp/policies/suggestions/${suggestion.id}/enforce`, admin, {})).statusCode).toBe(200);
  });

  it("refuses a suggestion's deny while an update of its rules is still in shadow", async () => {
    const { context, admin, call, generateAndAccept } = await setup();
    const { suggestion, rules } = await generateAndAccept();
    const extra = await context.store.createMcpToolPolicy({ ...rules[1]!, id: "mtp_extra", name: "Least privilege: add_label", toolPattern: "add_label", mode: "shadow" });
    const stored = await context.store.upsertOpenMcpPolicySuggestion({
      id: "mps_update",
      scopeKind: "workflow",
      scopeId: "wf_notes",
      scopeName: "Release notes",
      serverId: suggestion.serverId,
      serverName: null,
      fingerprint: "e".repeat(64),
      rules: [],
      evidence: { calls: 4, scopeCalls: 4, roles: ["builder"], tools: [], capped: false, updates: { suggestionIds: [suggestion.id], ruleIds: rules.map((rule) => rule.id), addedTools: ["add_label"] } },
      windowDays: 30,
      windowStart: new Date(Date.now() - 86_400_000).toISOString(),
      windowEnd: new Date().toISOString(),
      callCount: 4,
      createdBy: null,
      now: new Date().toISOString()
    });
    await context.store.transitionMcpPolicySuggestion(stored.suggestion.id, { from: "open", to: "accepted", decidedBy: "a", decidedAt: new Date().toISOString(), acceptedRuleIds: [extra.id] });
    const refused = await call("POST", `/api/mcp/policies/suggestions/${suggestion.id}/enforce`, admin, {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toMatch(/add_label|mtp_extra/);
    // The update's allows can go first (they carve their own scope's deny, on purpose), then the suggestion.
    expect((await call("POST", `/api/mcp/policies/suggestions/mps_update/enforce`, admin, {})).statusCode).toBe(200);
    expect((await call("POST", `/api/mcp/policies/suggestions/${suggestion.id}/enforce`, admin, {})).statusCode).toBe(200);
  });

  it("enforces a rule once when two admins enforce it at once", async () => {
    const { admin, call, audits } = await setup();
    const rule = (await call("POST", "/api/mcp/policies", admin, { effect: "deny", toolPattern: "echo", mode: "shadow" })).json<{ rule: McpToolPolicyRule }>().rule;
    const results = await Promise.all([call("POST", `/api/mcp/policies/${rule.id}/enforce`, admin, {}), call("POST", `/api/mcp/policies/${rule.id}/enforce`, admin, {})]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await audits("mcp_policy.enforced")).toHaveLength(1);
  });
});
