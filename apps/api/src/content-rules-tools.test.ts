/**
 * Content rules as MCP gateway tools, end to end: a toolset's `content_rules` member lists detect, redact and restore;
 * restore is denied unless a reveal rule names the calling gateway client; redaction maps are bound to the client and
 * the toolset's project, expire, and never leave the server; rule events and audit entries carry no raw values.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpGatewaySessionView, McpToolset } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
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

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-content-tools-"));
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

async function login(context: TestContext, role: "admin" | "builder"): Promise<string> {
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

const EMAIL = "jane.doe@example.com";
const PHONE = "+1 415 555 0134";
const CARD = "4111 1111 1111 1111";
const SUPPORT = "support@acme.example";

function ruleSet(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `Rules ${id}`, version: "1", allowList: { values: [SUPPORT] }, ...extra };
}

interface Fixture {
  context: TestContext;
  admin: string;
  toolset: McpToolset;
  plain: McpToolset;
  otherProject: McpToolset;
  client: McpClient;
  token: string;
  peer: McpClient;
  peerToken: string;
  outsider: McpClient;
  outsiderToken: string;
}

async function setup(): Promise<Fixture> {
  const context = await createTestContext();
  const call = caller(context);
  const admin = await login(context, "admin");
  const created = await call(admin, "POST", "/api/guard/profiles", { document: ruleSet("pii") });
  expect(created.statusCode, created.body).toBe(201);
  const project = await call(admin, "POST", "/api/projects", { name: "Second" });
  expect(project.statusCode, project.body).toBeLessThan(300);
  const secondProjectId = project.json<{ id: string }>().id;
  const makeToolset = async (body: Record<string, unknown>) => {
    const response = await call(admin, "POST", "/api/mcp/toolsets", body);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ toolset: McpToolset }>().toolset;
  };
  const toolset = await makeToolset({ name: "Privacy tools", projectId: "default", trackSessionLabels: true, members: [{ kind: "content_rules", ruleSetId: "pii" }] });
  const plain = await makeToolset({ name: "Plain tools", projectId: "default", members: [] });
  const otherProject = await makeToolset({ name: "Second privacy", projectId: secondProjectId, members: [{ kind: "content_rules", ruleSetId: "pii" }] });
  const makeClient = async (name: string, toolsetIds: string[]) => {
    const response = await call(admin, "POST", "/api/mcp/clients", { name, toolsetIds, role: "builder" });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ client: McpClient; token: string }>();
  };
  const first = await makeClient("Support agent", [toolset.id, plain.id, otherProject.id]);
  const peer = await makeClient("Peer agent", [toolset.id]);
  const outsider = await makeClient("Outside agent", [otherProject.id]);
  return { context, admin, toolset, plain, otherProject, client: first.client, token: first.token, peer: peer.client, peerToken: peer.token, outsider: outsider.client, outsiderToken: outsider.token };
}

let requestId = 100;

async function rpc(context: TestContext, slug: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return context.app.inject({
    method: "POST",
    url: `/mcp/${slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...headers },
    payload: JSON.stringify(body)
  });
}

async function openSession(context: TestContext, slug: string, token: string): Promise<string> {
  const response = await rpc(context, slug, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "content-tools-test", version: "1" } }
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.headers["mcp-session-id"] as string;
}

interface ToolOutcome {
  error: boolean;
  text: string;
  data: Record<string, any>;
}

function tools(fixture: Fixture, which: "client" | "peer" | "outsider" = "client", toolset?: McpToolset) {
  const token = which === "client" ? fixture.token : which === "peer" ? fixture.peerToken : fixture.outsiderToken;
  const slug = (toolset ?? (which === "outsider" ? fixture.otherProject : fixture.toolset)).slug;
  let session: string | undefined;
  const ensure = async () => (session ??= await openSession(fixture.context, slug, token));
  return {
    sessionId: ensure,
    async list(): Promise<Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }>> {
      const id = await ensure();
      const response = await rpc(fixture.context, slug, token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/list" }, { "mcp-session-id": id });
      return response.json<{ result: { tools: Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }> } }>().result.tools;
    },
    async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
      const id = await ensure();
      const response = await rpc(fixture.context, slug, token, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": id });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ result?: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }; error?: unknown }>();
      if (body.error) throw new Error(JSON.stringify(body.error));
      const text = body.result!.content.map((entry) => entry.text).join("\n");
      return { error: body.result!.isError === true, text, data: (body.result!.structuredContent ?? {}) as Record<string, any> };
    }
  };
}

async function addRevealRule(fixture: Fixture, rules: Array<Record<string, unknown>>, id = "pii") {
  const response = await caller(fixture.context)(fixture.admin, "PUT", `/api/guard/profiles/${id}`, { document: ruleSet(id, { reveal: { rules } }) });
  expect(response.statusCode, response.body).toBe(200);
}

async function eventsAndAudit(store: Store): Promise<string> {
  const sql = testSql(store);
  const events = await sql.all("SELECT * FROM guard_events WHERE execution_id LIKE 'mcpgw_%'");
  const audit = await sql.all("SELECT * FROM audit_logs WHERE event_type LIKE 'mcp_gateway.%'");
  return JSON.stringify({ events, audit });
}

describe("content rules tools on the MCP gateway", () => {
  it("are listed only on a toolset with the content_rules member, with a read-only hint on detect only", async () => {
    const fixture = await setup();
    const listed = await tools(fixture).list();
    expect(listed.map((tool) => tool.name).sort()).toEqual(["detect_sensitive_data", "redact_sensitive_data", "restore_sensitive_data"]);
    expect(listed.find((tool) => tool.name === "detect_sensitive_data")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(listed.find((tool) => tool.name === "redact_sensitive_data")?.annotations).toMatchObject({ readOnlyHint: false });
    expect(listed.find((tool) => tool.name === "restore_sensitive_data")?.annotations).toMatchObject({ readOnlyHint: false });
    expect(await tools(fixture, "client", fixture.plain).list()).toEqual([]);
    // The admin view names the member and its rule set; a second member is refused.
    const view = await caller(fixture.context)(fixture.admin, "GET", `/api/mcp/toolsets/${fixture.toolset.id}`);
    expect(view.json<{ toolset: { members: Array<{ kind: string; label: string }> } }>().toolset.members).toEqual([expect.objectContaining({ kind: "content_rules", label: "Content rules (Rules pii)" })]);
    const twice = await caller(fixture.context)(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules" }, { kind: "content_rules", ruleSetId: "pii" }] });
    expect(twice.statusCode).toBe(400);
    const missing = await caller(fixture.context)(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.plain.id}`, { members: [{ kind: "content_rules", ruleSetId: "nope" }] });
    expect(missing.statusCode).toBe(400);
    const added = await caller(fixture.context)(fixture.admin, "POST", `/api/mcp/toolsets/${fixture.toolset.id}/members`, { kind: "content_rules" });
    expect(added.statusCode).toBe(400);
    // Only admins change toolsets.
    const builder = await login(fixture.context, "builder");
    expect((await caller(fixture.context)(builder, "PUT", `/api/mcp/toolsets/${fixture.plain.id}`, { members: [{ kind: "content_rules" }] })).statusCode).toBe(403);
  });

  it("detects with masked previews and a risk level per input, honours the allow-list, and records rule events without values", async () => {
    const fixture = await setup();
    const client = tools(fixture);
    const result = await client.call("detect_sensitive_data", {
      texts: [`Mail ${EMAIL} or ${SUPPORT}`, `Card ${CARD}`, "Nothing here", "Host 10.20.30.40"],
      entity_types: ["email", "card_number", "ip_address"]
    });
    expect(result.error, result.text).toBe(false);
    expect(result.data.riskLevel).toBe("high");
    expect(result.data.inputs.map((input: { riskLevel: string }) => input.riskLevel)).toEqual(["medium", "high", "none", "medium"]);
    expect(result.data.inputs[0].findings).toEqual([expect.objectContaining({ dataClass: "email", preview: "j•••••••@e••••••.com" })]);
    expect(result.data.inputs[3].counts).toEqual({ ip_address: 1 });
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).not.toContain(CARD);
    // A call's own allow-list.
    const allowed = await client.call("detect_sensitive_data", { text: `Mail ${EMAIL}`, allow_list: [EMAIL] });
    expect(allowed.data.inputs[0].riskLevel).toBe("none");
    // A JSON value: paths, never value-like keys.
    const value = await client.call("detect_sensitive_data", { value: { customer: { contact: EMAIL }, [EMAIL]: "x" } });
    // Keys are scanned too, by position: the value-like key never appears in a path.
    expect(value.data.inputs[0].findings).toEqual([
      expect.objectContaining({ dataClass: "email", path: "$.customer.contact" }),
      expect.objectContaining({ dataClass: "email", path: "${#1}{key}" })
    ]);
    // Bad input and an unavailable rule set are tool errors.
    expect((await client.call("detect_sensitive_data", { text: "a", texts: ["b"] })).error).toBe(true);
    expect((await client.call("detect_sensitive_data", { text: "a", rule_set_id: "default" })).text).toMatch(/not available to this toolset/);
    const stored = await eventsAndAudit(fixture.context.store);
    expect(stored).toContain("detect_sensitive_data");
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(CARD);
  });

  it("redacts with placeholders, restores nothing by default, then restores what a reveal rule allows the client", async () => {
    const fixture = await setup();
    const client = tools(fixture);
    const input = `Hi [EMAIL_1], write to ${EMAIL} or call ${PHONE}; again ${EMAIL}. Support: ${SUPPORT}`;
    const redacted = await client.call("redact_sensitive_data", { text: input });
    expect(redacted.error, redacted.text).toBe(false);
    // The typed [EMAIL_1] is reserved: the real email becomes [EMAIL_2], both times; the allow-listed address stays.
    expect(redacted.data.redacted).toBe(`Hi [EMAIL_1], write to [EMAIL_2] or call [PHONE_1]; again [EMAIL_2]. Support: ${SUPPORT}`);
    expect(redacted.data.redaction_id).toMatch(/^red_/);
    expect(redacted.data.counts).toEqual({ email: 2, phone: 1 });
    expect(redacted.text).not.toContain(EMAIL);
    expect(redacted.text).not.toContain(PHONE);
    const redactionId = redacted.data.redaction_id as string;

    const denied = await client.call("restore_sensitive_data", { text: redacted.data.redacted, redaction_id: redactionId });
    expect(denied.error).toBe(false);
    expect(denied.data.restored).toBe(redacted.data.redacted);
    expect(denied.data.withheld).toEqual(
      expect.arrayContaining([expect.objectContaining({ dataClass: "email", reason: "no_rule" }), expect.objectContaining({ dataClass: "phone", reason: "no_rule" })])
    );

    // A rule naming this client for emails; phone numbers ask for approval, which a gateway call cannot wait for.
    await addRevealRule(fixture, [
      { name: "Support agent emails", dataClasses: ["email"], subjects: { gatewayClients: [fixture.client.id] } },
      { dataClasses: ["phone"], subjects: { gatewayClients: [fixture.client.id] }, requireApproval: true }
    ]);
    const restored = await client.call("restore_sensitive_data", { text: redacted.data.redacted, redaction_id: redactionId });
    expect(restored.data.restored).toBe(`Hi [EMAIL_1], write to ${EMAIL} or call [PHONE_1]; again ${EMAIL}. Support: ${SUPPORT}`);
    expect(restored.data.restoredClasses).toEqual([{ dataClass: "email", count: 2 }]);
    expect(restored.data.withheld).toEqual([expect.objectContaining({ dataClass: "phone", reason: "approval_required" })]);

    // The session now carries the sensitive label and the restored class.
    const sessions = await caller(fixture.context)(fixture.admin, "GET", `/api/mcp/clients/${fixture.client.id}/sessions`);
    const session = sessions.json<{ sessions: McpGatewaySessionView[] }>().sessions.find((entry) => entry.toolsetId === fixture.toolset.id);
    expect(session?.labels?.provenance).toContain("sensitive");
    expect(session?.labels?.dataClasses).toContain("email");

    // Audited and recorded without values (counts, classes and token hashes only).
    const stored = await eventsAndAudit(fixture.context.store);
    expect(stored).toContain("mcp_gateway.content_restore");
    expect(stored).not.toContain(EMAIL);
    expect(stored).not.toContain(PHONE);
    expect(stored).not.toContain(redactionId);
    const sql = testSql(fixture.context.store);
    const row = await sql.get<{ entries_sealed: string }>("SELECT entries_sealed FROM content_redactions WHERE id = ?", redactionId);
    expect(row?.entries_sealed).toMatch(/^v1\./);
    expect(row?.entries_sealed).not.toContain(EMAIL);
  });

  it("binds a redaction to its client and project, and lets it expire", async () => {
    const fixture = await setup();
    await addRevealRule(fixture, [{ dataClasses: ["email"], subjects: { gatewayClients: [fixture.client.id, fixture.peer.id, fixture.outsider.id] } }]);
    const redacted = await tools(fixture).call("redact_sensitive_data", { text: `Mail ${EMAIL}`, ttl_seconds: 120 });
    const redactionId = redacted.data.redaction_id as string;
    const args = { text: "Mail [EMAIL_1]", redaction_id: redactionId };
    // Another client of the same toolset.
    const peer = await tools(fixture, "peer").call("restore_sensitive_data", args);
    expect(peer.error).toBe(true);
    expect(peer.text).toBe("Unknown or expired redaction_id");
    // The same client through a toolset of another project.
    const elsewhere = await tools(fixture, "client", fixture.otherProject).call("restore_sensitive_data", args);
    expect(elsewhere.text).toBe("Unknown or expired redaction_id");
    // The owner can, until the map expires.
    expect((await tools(fixture).call("restore_sensitive_data", args)).data.restored).toBe(`Mail ${EMAIL}`);
    const sql = testSql(fixture.context.store);
    const row = await sql.get<{ expires_at: string; created_at: string }>("SELECT expires_at, created_at FROM content_redactions WHERE id = ?", redactionId);
    expect(new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime()).toBe(120_000);
    await sql.run("UPDATE content_redactions SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), redactionId);
    expect((await tools(fixture).call("restore_sensitive_data", args)).text).toBe("Unknown or expired redaction_id");
  });

  it("supports token, mask and hash styles; tokens restore within the toolset's project only", async () => {
    const fixture = await setup();
    await addRevealRule(fixture, [{ dataClasses: ["email"], subjects: { gatewayClients: [fixture.client.id, fixture.outsider.id] } }]);
    const client = tools(fixture);
    const tokenized = await client.call("redact_sensitive_data", { text: `Mail ${EMAIL}`, style: "token" });
    expect(tokenized.data.redacted).toMatch(/^Mail tok_email_[A-Za-z0-9_-]{16}$/);
    expect(tokenized.data.redaction_id).toMatch(/^red_/);
    expect((await client.call("restore_sensitive_data", { text: tokenized.data.redacted, redaction_id: tokenized.data.redaction_id })).data.restored).toBe(`Mail ${EMAIL}`);
    // Without its redaction, or through another redaction of the same client, a token stays a token.
    const bare = await client.call("restore_sensitive_data", { text: tokenized.data.redacted });
    expect(bare.data.restored).toBe(tokenized.data.redacted);
    expect(bare.data.withheld).toEqual([expect.objectContaining({ reason: "unknown_token" })]);
    const placeholderRedaction = await client.call("redact_sensitive_data", { text: `Other ${EMAIL}` });
    const borrowed = await client.call("restore_sensitive_data", { text: tokenized.data.redacted, redaction_id: placeholderRedaction.data.redaction_id });
    expect(borrowed.data.restored).toBe(tokenized.data.redacted);
    const otherProject = await tools(fixture, "outsider").call("restore_sensitive_data", { text: tokenized.data.redacted });
    expect(otherProject.data.restored).toBe(tokenized.data.redacted);

    const masked = await client.call("redact_sensitive_data", { value: { a: [`Mail ${EMAIL}`] }, style: "mask" });
    expect(masked.data.redacted).toEqual({ a: ["Mail j•••••••@e••••••.com"] });
    expect(masked.data.redaction_id).toBeUndefined();
    const hashed = await client.call("redact_sensitive_data", { texts: [EMAIL, EMAIL], style: "hash" });
    expect(hashed.data.redacted[0]).toMatch(/^hash_email_[0-9a-f]{24}$/);
    expect(hashed.data.redacted[1]).toBe(hashed.data.redacted[0]);
    const elsewhere = await tools(fixture, "outsider").call("redact_sensitive_data", { text: EMAIL, style: "hash" });
    expect(elsewhere.data.redacted).not.toBe(hashed.data.redacted[0]);
  });

  it("restores nothing for a reveal rule that names another client or only roles", async () => {
    const fixture = await setup();
    await addRevealRule(fixture, [
      { dataClasses: ["email"], subjects: { roles: ["admin", "builder"] } },
      { dataClasses: ["email"], subjects: { gatewayClients: [fixture.peer.id] } }
    ]);
    const client = tools(fixture);
    const redacted = await client.call("redact_sensitive_data", { text: `Mail ${EMAIL}` });
    const restored = await client.call("restore_sensitive_data", { text: redacted.data.redacted, redaction_id: redacted.data.redaction_id });
    expect(restored.data.restored).toBe("Mail [EMAIL_1]");
    expect(restored.data.withheld).toEqual([expect.objectContaining({ dataClass: "email", reason: "no_rule" })]);
  });

  it("applies tool rules with the call's arguments: deny by condition, and refuse rules that ask for approval", async () => {
    const fixture = await setup();
    const call = caller(fixture.context);
    const deny = await call(fixture.admin, "POST", "/api/mcp/policies", {
      effect: "deny",
      serverId: "l2m-content-rules",
      toolPattern: "redact_sensitive_data",
      conditions: { all: [{ path: "style", op: "equals", value: "mask" }] }
    });
    expect(deny.statusCode, deny.body).toBe(201);
    const approval = await call(fixture.admin, "POST", "/api/mcp/policies", { effect: "require_approval", serverId: "l2m-content-rules", toolPattern: "restore_sensitive_data" });
    expect(approval.statusCode, approval.body).toBe(201);
    const client = tools(fixture);
    expect((await client.call("redact_sensitive_data", { text: EMAIL, style: "mask" })).error).toBe(true);
    expect((await client.call("redact_sensitive_data", { text: EMAIL })).error).toBe(false);
    const restore = await client.call("restore_sensitive_data", { text: "[EMAIL_1]" });
    expect(restore.error).toBe(true);
    expect(restore.text).toMatch(/needs an approval/);
    const sql = testSql(fixture.context.store);
    expect(Number((await sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'mcp_gateway.tool_denied'"))?.n)).toBe(2);
  });

  it("audits refused restores, refuses sensitive keys and deep values, and keeps one rule event per data class", async () => {
    const fixture = await setup();
    const client = tools(fixture);
    const guessed = await client.call("restore_sensitive_data", { text: "[EMAIL_1]", redaction_id: "red_aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(guessed.text).toBe("Unknown or expired redaction_id");
    const sql = testSql(fixture.context.store);
    const audit = await sql.all<{ outcome: string; metadata_json?: string }>("SELECT * FROM audit_logs WHERE event_type = 'mcp_gateway.content_restore'");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).toContain("unknown_redaction");
    expect(JSON.stringify(audit)).not.toContain("red_aaaaaaaaaaaaaaaaaaaaaaaa");

    const keyed = await client.call("redact_sensitive_data", { value: { [EMAIL]: "contact" } });
    expect(keyed.error).toBe(true);
    expect(keyed.text).toMatch(/object key holds sensitive data/);
    expect(keyed.text).not.toContain(EMAIL);
    expect((await client.call("detect_sensitive_data", { value: { [EMAIL]: "contact" } })).data.inputs[0].findings).toEqual([expect.objectContaining({ dataClass: "email", path: "${#0}{key}" })]);
    let deep: unknown = EMAIL;
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect((await client.call("redact_sensitive_data", { value: deep })).text).toMatch(/nested deeper/);

    const many = Array.from({ length: 50 }, (_, index) => `user${index}@example.org`).join(" ");
    await client.call("detect_sensitive_data", { text: many });
    const rows = await sql.all<{ verdict_id: string; data_class: string }>("SELECT verdict_id, data_class FROM guard_events WHERE node_id = 'detect_sensitive_data'");
    const perVerdict = new Map<string, string[]>();
    for (const row of rows) perVerdict.set(row.verdict_id, [...(perVerdict.get(row.verdict_id) ?? []), row.data_class]);
    // Each call: one event per data class, however many findings (50 emails here).
    for (const classes of perVerdict.values()) expect(new Set(classes).size).toBe(classes.length);
    expect(rows.length).toBe(perVerdict.size);
  });
});
