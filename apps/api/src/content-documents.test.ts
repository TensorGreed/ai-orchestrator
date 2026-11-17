/**
 * Scanning documents with content rules, end to end: the rule set page's "Scan a document" test
 * (`POST /api/guard/profiles/:id/scan-document`) and the gateway's `scan_document` tool on a toolset's content rules
 * member (off by default; URL fetches only with their own switch, from listed hosts, never to private addresses).
 * Every network call stays on this machine: a local HTTP server, or a fetch stand-in behind the outbound checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset } from "@ai-orchestrator/shared";
import { createApp, type CreateAppOptions } from "./app.js";
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

async function createTestContext(env: Record<string, string> = {}, options: CreateAppOptions = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-content-docs-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService, undefined, undefined, undefined, options);
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

async function login(context: TestContext, role: "admin" | "builder" | "viewer"): Promise<string> {
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
const CARD = "4111 1111 1111 1111";
const SUPPORT = "support@acme.example";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function ruleSet(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: `Rules ${id}`, version: "1", allowList: { values: [SUPPORT] }, ...extra };
}

// A local server: the only "remote" document source any test uses.
let server: http.Server;
let base = "";
const served: string[] = [];
beforeAll(async () => {
  server = http.createServer((request, response) => {
    served.push(request.url ?? "");
    if ((request.url ?? "").startsWith("/people.csv")) {
      response.setHeader("content-type", "text/csv");
      response.end(`name,email\nJane,${EMAIL}\nSupport,${SUPPORT}\n`);
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<html><body><p>Card ${CARD}</p><div hidden>${EMAIL}</div></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function auditRows(store: Store, eventType: string): Promise<Array<Record<string, unknown>>> {
  return await testSql(store).all(`SELECT * FROM audit_logs WHERE event_type = '${eventType}'`);
}

describe("the rule set page's document scan", () => {
  it("scans an upload with the latest version, a draft or a saved version, with locations and masked previews only", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const builder = await login(context, "builder");
    expect((await call(builder, "POST", "/api/guard/profiles", { document: ruleSet("docs") })).statusCode).toBe(201);
    const text = `Notes\nWrite to ${EMAIL} or ${SUPPORT}\nCard: ${CARD}\n`;
    const response = await call(builder, "POST", "/api/guard/profiles/docs/scan-document", { source: { kind: "upload", contentBase64: b64(text), filename: "notes.txt", mediaType: "text/plain" } });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: Record<string, any> }>();
    expect(result).toMatchObject({ sniffedType: "text", typeMismatch: false, riskLevel: "high", countsByClass: { card_number: 1, email: 1 }, source: { kind: "upload", filename: "notes.txt" }, ruleSet: { id: "docs", version: 1 } });
    expect(result.findings.map((finding: { location: { label: string } }) => finding.location.label)).toEqual(["line 2, column 10", "line 3, column 7"]);
    expect(response.body).not.toContain(EMAIL);
    expect(response.body).not.toContain(CARD);

    // A draft without the allow-list reports the support address too; nothing is saved.
    const draft = await call(builder, "POST", "/api/guard/profiles/docs/scan-document", { source: { kind: "upload", contentBase64: b64(text) }, document: ruleSet("docs", { allowList: undefined }) });
    expect(draft.statusCode, draft.body).toBe(200);
    expect(draft.json<{ result: { countsByClass: Record<string, number> } }>().result.countsByClass).toEqual({ card_number: 1, email: 2 });
    expect((await call(builder, "GET", "/api/guard/profiles/docs/versions")).json<{ versions: unknown[] }>().versions).toHaveLength(1);
    const saved = await call(builder, "POST", "/api/guard/profiles/docs/scan-document", { source: { kind: "upload", contentBase64: b64(text) }, version: 1 });
    expect(saved.statusCode).toBe(200);
    expect((await call(builder, "POST", "/api/guard/profiles/docs/scan-document", { source: { kind: "upload", contentBase64: b64(text) }, version: 9 })).statusCode).toBe(404);
    expect((await call(builder, "POST", "/api/guard/profiles/nope/scan-document", { source: { kind: "upload", contentBase64: b64(text) } })).statusCode).toBe(404);

    // Redacted text: masks or placeholders, never the value; no rule events (a test), an audit entry without content.
    const masked = await call(builder, "POST", "/api/guard/profiles/docs/scan-document", { source: { kind: "upload", contentBase64: b64(text) }, redact: "placeholder" });
    const redacted = masked.json<{ result: { redacted: { style: string; text: string } } }>().result.redacted;
    expect(redacted).toEqual({ style: "placeholder", text: `Notes\nWrite to [EMAIL_1] or ${SUPPORT}\nCard: [CARD_NUMBER_1]\n` });
    expect(await testSql(context.store).all("SELECT * FROM guard_events")).toEqual([]);
    const audit = await auditRows(context.store, "guard.document_scan_test");
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
    expect(JSON.parse(String(audit[0]!.metadata_json ?? audit[0]!.metadata ?? "{}"))).toMatchObject({ source: "upload", type: "text" });
  });

  it("fetches a URL under the deployment's outbound policy, and refuses it when private addresses are denied", async () => {
    const open = await createTestContext();
    const builder = await login(open, "builder");
    const response = await caller(open)(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "url", url: `${base}/page?token=secret-token` } });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: Record<string, any> }>();
    expect(result.source).toEqual({ kind: "url", origin: base, pathHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(result.findings.map((finding: { dataClass: string; location: { label: string } }) => [finding.dataClass, finding.location.label])).toEqual([
      ["card_number", "visible text, line 1, column 6"],
      ["email", "hidden text, line 1, column 1"]
    ]);
    const audit = JSON.stringify(await auditRows(open.store, "guard.document_scan_test"));
    expect(audit).not.toContain("secret-token");
    expect(audit).not.toContain("/page");

    const closed = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true" });
    const closedBuilder = await login(closed, "builder");
    const before = served.length;
    const refused = await caller(closed)(closedBuilder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "url", url: `${base}/page` } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "blocked_url", reason: "address_blocked" });
    expect(served.length).toBe(before);
    const metadata = await caller(closed)(closedBuilder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "url", url: "http://169.254.169.254/latest/meta-data" } });
    expect(metadata.statusCode).toBe(422);
  });

  it("refuses unsupported files, viewers, and more than 10 scans a minute", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const builder = await login(context, "builder");
    const pdf = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("%PDF-1.7 ..."), mediaType: "application/pdf" } });
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json()).toMatchObject({ code: "unsupported_type" });
    const viewer = await login(context, "viewer");
    expect((await call(viewer, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("x") } })).statusCode).toBe(403);
    expect((await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "ftp" } })).statusCode).toBe(400);
    // The PDF counted as one of the ten.
    for (let i = 0; i < 9; i += 1) {
      expect((await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("hello") } })).statusCode).toBe(200);
    }
    const limited = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("hello") } });
    expect(limited.statusCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// The gateway tool
// ---------------------------------------------------------------------------

interface Gateway {
  context: TestContext;
  admin: string;
  toolset: McpToolset;
  client: McpClient;
  token: string;
}

async function gateway(env: Record<string, string> = {}, options: CreateAppOptions = {}, documents?: Record<string, unknown>, toolsetExtra: Record<string, unknown> = {}): Promise<Gateway> {
  const context = await createTestContext(env, options);
  const call = caller(context);
  const admin = await login(context, "admin");
  expect((await call(admin, "POST", "/api/guard/profiles", { document: ruleSet("pii") })).statusCode).toBe(201);
  const created = await call(admin, "POST", "/api/mcp/toolsets", { name: "Docs", projectId: "default", members: [{ kind: "content_rules", ruleSetId: "pii", ...(documents ? { documents } : {}) }], ...toolsetExtra });
  expect(created.statusCode, created.body).toBe(201);
  const toolset = created.json<{ toolset: McpToolset }>().toolset;
  const client = await call(admin, "POST", "/api/mcp/clients", { name: "Doc agent", toolsetIds: [toolset.id], role: "builder" });
  expect(client.statusCode, client.body).toBe(201);
  const body = client.json<{ client: McpClient; token: string }>();
  return { context, admin, toolset, client: body.client, token: body.token };
}

let requestId = 100;

async function rpc(fixture: Gateway, body: unknown, session?: string) {
  return fixture.context.app.inject({
    method: "POST",
    url: `/mcp/${fixture.toolset.slug}`,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${fixture.token}`, ...(session ? { "mcp-session-id": session } : {}) },
    payload: JSON.stringify(body)
  });
}

function tools(fixture: Gateway) {
  let session: string | undefined;
  const ensure = async () => {
    if (session) return session;
    const response = await rpc(fixture, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "docs-test", version: "1" } } });
    expect(response.statusCode, response.body).toBe(200);
    session = response.headers["mcp-session-id"] as string;
    return session;
  };
  return {
    async list(): Promise<Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }>> {
      const response = await rpc(fixture, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/list" }, await ensure());
      return response.json<{ result: { tools: Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: { properties: Record<string, unknown> } }> } }>().result.tools;
    },
    async call(name: string, args: Record<string, unknown>): Promise<{ error: boolean; text: string; data: Record<string, any> }> {
      const response = await rpc(fixture, { jsonrpc: "2.0", id: (requestId += 1), method: "tools/call", params: { name, arguments: args } }, await ensure());
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json<{ result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> } }>();
      return { error: body.result.isError === true, text: body.result.content.map((entry) => entry.text).join("\n"), data: (body.result.structuredContent ?? {}) as Record<string, any> };
    }
  };
}

async function stored(store: Store): Promise<{ events: Array<Record<string, unknown>>; audit: Array<Record<string, unknown>> }> {
  const sql = testSql(store);
  return {
    events: await sql.all("SELECT * FROM guard_events WHERE node_id = 'scan_document'"),
    audit: await sql.all("SELECT * FROM audit_logs WHERE event_type = 'mcp_gateway.content_document_scan'")
  };
}

describe("the scan_document gateway tool", () => {
  it("is off unless the member turns documents on, and the admin API requires hosts when URLs are allowed", async () => {
    const fixture = await gateway();
    expect((await tools(fixture).list()).map((tool) => tool.name)).not.toContain("scan_document");
    const call = caller(fixture.context);
    const noHosts = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", documents: { enabled: true, allowUrls: true, allowedHosts: [] } }] });
    expect(noHosts.statusCode).toBe(400);
    const urlsOff = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", documents: { enabled: false, allowUrls: true, allowedHosts: ["a.example"] } }] });
    expect(urlsOff.statusCode).toBe(400);
    const badHost = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", documents: { enabled: true, allowUrls: true, allowedHosts: ["http://x/"] } }] });
    expect(badHost.statusCode).toBe(400);
    const on = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", ruleSetId: "pii", documents: { enabled: true } }] });
    expect(on.statusCode, on.body).toBe(200);
    const view = await call(fixture.admin, "GET", `/api/mcp/toolsets/${fixture.toolset.id}`);
    expect(view.json<{ toolset: { members: Array<Record<string, unknown>> } }>().toolset.members[0]).toMatchObject({ kind: "content_rules", documents: { enabled: true, allowUrls: false, allowedHosts: [] } });
    const audit = JSON.stringify(await auditRows(fixture.context.store, "mcp_toolset.updated"));
    expect(audit).toContain("documentScanning");

    const listed = await tools(fixture).list();
    const tool = listed.find((entry) => entry.name === "scan_document");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(Object.keys(tool!.inputSchema.properties)).not.toContain("url");
    // Builders cannot change toolsets.
    const builder = await login(fixture.context, "builder");
    expect((await call(builder, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", documents: { enabled: true } }] })).statusCode).toBe(403);
  });

  it("scans inline content with the member's rule set, records rule events and audit without values, and refuses URLs", async () => {
    const fixture = await gateway({}, {}, { enabled: true });
    const client = tools(fixture);
    const csv = `name,email,card\nJane,${EMAIL},${CARD}\nHelp,${SUPPORT},\n`;
    const result = await client.call("scan_document", { content_base64: b64(csv), media_type: "text/csv", filename: "people.csv", redact_style: "placeholder" });
    expect(result.error, result.text).toBe(false);
    expect(result.data).toMatchObject({ sniffedType: "csv", riskLevel: "high", countsByClass: { card_number: 1, email: 1 }, ruleSet: { id: "pii", version: 1 } });
    expect(result.data.findings.map((finding: { location: { label: string } }) => finding.location.label)).toEqual(["row 2, column 2 (email)", "row 2, column 3 (card)"]);
    expect(result.data.redacted).toMatchObject({ style: "placeholder", text: `name,email,card\nJane,[EMAIL_1],[CARD_NUMBER_1]\nHelp,${SUPPORT},`, redaction_id: expect.stringMatching(/^red_/) });
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).not.toContain(CARD);
    // The redaction can be restored only through the restore tool's rules (none here): placeholders stay.
    const restored = await client.call("restore_sensitive_data", { text: "[EMAIL_1]", redaction_id: result.data.redacted.redaction_id });
    expect(restored.data.restored).toBe("[EMAIL_1]");

    const { events, audit } = await stored(fixture.context.store);
    expect(events.map((event) => event.data_class).sort()).toEqual(["card_number", "email"]);
    expect(events.every((event) => event.channel === "tool_arguments" && event.effective_action === "redact")).toBe(true);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify({ events, audit })).not.toContain(EMAIL);
    expect(JSON.stringify({ events, audit })).not.toContain(CARD);

    const url = await client.call("scan_document", { url: `${base}/people.csv` });
    expect(url).toMatchObject({ error: true });
    expect(url.text).toMatch(/does not allow fetching documents from URLs/);
    const both = await client.call("scan_document", { content_base64: b64("x"), url: `${base}/x` });
    expect(both.error).toBe(true);
    const zip = await client.call("scan_document", { content_base64: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString("base64") });
    expect(zip.text).toMatch(/Zip and Office/);
  });

  it("fetches only from listed hosts, through the outbound checks, and never from private addresses", async () => {
    const fetched: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(input), headers: new Headers(init?.headers) });
      if (String(input).includes("/redirect")) return new Response(null, { status: 302, headers: { location: "http://intranet.example.test/secret" } });
      return new Response(`<html><body><p>Mail ${EMAIL}</p><img alt="card ${CARD}"></body></html>`, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const resolver = async (host: string) => (host === "intranet.example.test" ? ["10.1.2.3"] : ["93.184.216.34"]);
    const fixture = await gateway({ OUTBOUND_DENY_PRIVATE: "false" }, { documentScanNetwork: { resolver, fetchImpl } }, { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test", "*.example.test", "127.0.0.1"] }, { trackSessionLabels: true });
    const client = tools(fixture);
    const listed = (await client.list()).find((entry) => entry.name === "scan_document");
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(Object.keys(listed!.inputSchema.properties)).toContain("url");

    const result = await client.call("scan_document", { url: "https://docs.example.test/page?session=tok-123" });
    expect(result.error, result.text).toBe(false);
    expect(result.data.source).toMatchObject({ kind: "url", origin: "https://docs.example.test" });
    expect(result.data.findings.map((finding: { location: { label: string } }) => finding.location.label)).toEqual(["visible text, line 1, column 6", "alt of <img>"]);
    expect(fetched[0]!.headers.get("cookie")).toBeNull();
    expect(fetched[0]!.headers.get("authorization")).toBeNull();
    const { events, audit } = await stored(fixture.context.store);
    expect(events.every((event) => event.channel === "tool_result")).toBe(true);
    expect(JSON.stringify(audit)).toContain("https://docs.example.test");
    expect(JSON.stringify({ events, audit })).not.toContain("tok-123");
    expect(JSON.stringify({ events, audit })).not.toContain(EMAIL);
    // A fetched page is outside content: the session carries untrusted_external from here on.
    const raised = await testSql(fixture.context.store).all("SELECT metadata_json FROM audit_logs WHERE event_type = 'mcp_gateway.session_labels_raised'");
    expect(JSON.stringify(raised)).toContain("untrusted_external");

    // Not on the list: refused before any request, audited as denied.
    const count = fetched.length;
    const other = await client.call("scan_document", { url: "https://elsewhere.test/doc" });
    expect(other.text).toMatch(/not on this toolset's list/);
    expect(fetched.length).toBe(count);
    expect(JSON.stringify((await stored(fixture.context.store)).audit)).toContain('"denied"');
    // A listed host that resolves to a private address, a redirect into the private network, and a loopback literal:
    // all refused, although OUTBOUND_DENY_PRIVATE is false for nodes.
    expect((await client.call("scan_document", { url: "http://intranet.example.test/secret" })).text).toMatch(/address is not allowed/);
    expect((await client.call("scan_document", { url: "https://docs.example.test/redirect" })).text).toMatch(/address is not allowed/);
    const before = served.length;
    expect((await client.call("scan_document", { url: `${base}/people.csv` })).text).toMatch(/address is not allowed/);
    expect((await client.call("scan_document", { url: `${base}/people.csv` })).text).not.toMatch(/OUTBOUND/);
    expect(served.length).toBe(before);
    expect(fetched.some((entry) => entry.url.includes("intranet"))).toBe(false);
  });
});
