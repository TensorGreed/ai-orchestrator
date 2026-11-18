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
import { DEFAULT_GUARD_PROFILE_DOCUMENT, parseGuardProfile } from "@ai-orchestrator/guard-sdk";
import { ContentDocumentScanService } from "./services/content-document-scan-service.js";
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
const LETTER = `Dear Mr. Alan Doyle,\nPlease send the forms to 42 Dunmore Street, Springfield, IL 62704.\nMail ${EMAIL}\n`;

/** A small PDF: one page per entry (its lines), and a comment on the first page. */
function pdf(pages: string[][], comment?: string): Buffer {
  const esc = (text: string) => `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  pages.forEach((lines, index) => {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${esc(line)} Tj T*`).join(" ")} ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const annots = index === 0 && comment ? ` /Annots [<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents ${esc(comment)} >>]` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R${annots} >>`);
    kids.push(objects.length);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.7\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

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
    if ((request.url ?? "").startsWith("/form.pdf")) {
      // Declared as a download: the bytes decide that it is a PDF.
      response.setHeader("content-type", "application/octet-stream");
      response.end(pdf([["Applicant", `Email ${EMAIL}`]]));
      return;
    }
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

    // A PDF served as a generic download is read as a PDF (the bytes decide).
    const fetchedPdf = await caller(open)(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "url", url: `${base}/form.pdf` } });
    expect(fetchedPdf.statusCode, fetchedPdf.body).toBe(200);
    expect(fetchedPdf.json<{ result: Record<string, unknown> }>().result).toMatchObject({ sniffedType: "pdf", mediaType: "application/octet-stream", typeMismatch: true, countsByClass: { email: 1 } });

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

  it("finds names and street addresses when the rule set runs data.entities or the scan names them", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const builder = await login(context, "builder");
    const entities = { prompt: { detectors: [{ id: "data.entities", threshold: 0.5, options: { classes: ["person_name", "street_address"] } }], defaultAction: { action: "allow" } } };
    expect((await call(builder, "POST", "/api/guard/profiles", { document: ruleSet("names", { channels: entities }) })).statusCode).toBe(201);
    const response = await call(builder, "POST", "/api/guard/profiles/names/scan-document", { source: { kind: "upload", contentBase64: b64(LETTER), mediaType: "text/plain" }, redact: "placeholder" });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: Record<string, any> }>();
    expect(result.countsByClass).toMatchObject({ person_name: 1, street_address: 1, email: 1 });
    expect(result.findings.find((finding: { dataClass: string }) => finding.dataClass === "person_name")).toMatchObject({ maskedPreview: "A••• D••••", location: { label: "line 1, column 10" } });
    expect(result.redacted.text).toContain("Dear Mr. [PERSON_NAME_1],");
    expect(response.body).not.toContain("Dunmore");
    // The built-in rule set does not look for them, unless the scan names them.
    const builtIn = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64(LETTER) } });
    expect(builtIn.json<{ result: { countsByClass: Record<string, number> } }>().result.countsByClass).toEqual({ email: 1 });
    const named = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64(LETTER) }, entityTypes: ["street_address"] });
    expect(named.json<{ result: { countsByClass: Record<string, number> } }>().result.countsByClass).toEqual({ street_address: 1 });
  });

  it("stops the rule set test's fetch when the caller goes away", async () => {
    let aborted = false;
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      })) as typeof fetch;
    const service = new ContentDocumentScanService({
      limits: { maxBytes: 1024 * 1024, maxChars: 100_000, fetchTimeoutMs: 60_000, firstByteTimeoutMs: 60_000, maxConcurrent: 1 },
      outbound: { denyPrivate: false, allowlist: [] },
      resolver: async () => ["93.184.216.34"],
      fetchImpl
    });
    const disconnect = new AbortController();
    setTimeout(() => disconnect.abort(), 50);
    const user = { id: "u1", email: "builder@example.com", role: "builder" } as Parameters<ContentDocumentScanService["testScan"]>[2];
    const scan = service.testScan({ source: { kind: "url", url: "https://docs.example.test/slow" } }, { id: "default", version: 1, profile: parseGuardProfile(DEFAULT_GUARD_PROFILE_DOCUMENT) }, user, disconnect.signal);
    await expect(scan).rejects.toMatchObject({ code: "cancelled", status: 499 });
    expect(aborted).toBe(true);
    // The slot was given back.
    await expect(service.withSlot(async () => "free")).resolves.toBe("free");
  });

  it("reads a PDF's pages and comments, reports a page limit, and says when a PDF has no text layer", async () => {
    const context = await createTestContext({ CONTENT_SCAN_MAX_PAGES: "2" });
    const call = caller(context);
    const builder = await login(context, "builder");
    const document = pdf([["Applicant", `Email ${EMAIL}`], [`Card ${CARD}`], ["third page"]], `Call ${SUPPORT} or ${EMAIL}`);
    const response = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: document.toString("base64"), filename: "form.pdf", mediaType: "application/pdf" }, redact: "mask" });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: Record<string, any> }>();
    expect(result).toMatchObject({ sniffedType: "pdf", typeMismatch: false, encoding: "pdf", truncated: true, pages: { total: 3, checked: 2 }, textLayer: "present", pagesWithoutText: 0 });
    expect(result.findings.map((finding: { location: { label: string } }) => finding.location.label)).toEqual(["page 1, line 2, column 7", "page 1, comment 1", "page 1, comment 1", "page 2, line 1, column 6"]);
    expect(result.redacted.text).toContain("[not checked: pages 3 to 3, past the page limit]");
    expect(response.body).not.toContain(EMAIL);
    expect(response.body).not.toContain(CARD);
    const audit = await auditRows(context.store, "guard.document_scan_test");
    expect(JSON.parse(String(audit.at(-1)!.metadata_json ?? audit.at(-1)!.metadata ?? "{}"))).toMatchObject({ type: "pdf", pages: { total: 3, checked: 2 }, textLayer: "present" });

    // A page with no text drawn on it reads as a PDF without a text layer, not as a clean one.
    const blank = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: pdf([[]]).toString("base64") } });
    expect(blank.statusCode, blank.body).toBe(200);
    expect(blank.json<{ result: Record<string, unknown> }>().result).toMatchObject({ sniffedType: "pdf", textLayer: "empty", pagesWithoutText: 1, findings: [] });
  });

  it("refuses unsupported files, viewers, and more than 10 scans a minute", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const builder = await login(context, "builder");
    const broken = await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("%PDF-1.7 ..."), mediaType: "application/pdf" } });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ code: "invalid_document" });
    const viewer = await login(context, "viewer");
    expect((await call(viewer, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "upload", contentBase64: b64("x") } })).statusCode).toBe(403);
    expect((await call(builder, "POST", "/api/guard/profiles/default/scan-document", { source: { kind: "ftp" } })).statusCode).toBe(400);
    // The broken PDF counted as one of the ten.
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
    const document = await client.call("scan_document", { content_base64: pdf([[`Email ${EMAIL}`]]).toString("base64"), filename: "form.pdf" });
    expect(document.error, document.text).toBe(false);
    expect(document.data).toMatchObject({ sniffedType: "pdf", pages: { total: 1, checked: 1 }, textLayer: "present", countsByClass: { email: 1 } });
    expect(document.data.findings[0].location).toMatchObject({ kind: "pdf", page: 1, line: 1, column: 7, label: "page 1, line 1, column 7" });
    expect(document.text).not.toContain(EMAIL);
  });

  it("fetches only from listed hosts, through the outbound checks, and never from private addresses", async () => {
    const fetched: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(input), headers: new Headers(init?.headers) });
      if (String(input).includes("/redirect")) return new Response(null, { status: 302, headers: { location: "http://intranet.example.test/secret" } });
      return new Response(`<html><body><p>Mail ${EMAIL}</p><img alt="card ${CARD}"></body></html>`, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const resolver = async (host: string) => (host === "intranet.example.test" ? ["10.1.2.3"] : ["93.184.216.34"]);
    const fixture = await gateway({ OUTBOUND_DENY_PRIVATE: "false" }, { documentScanNetwork: { resolver, fetchImpl } }, { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test", "*.example.test", new URL(base).host] }, { trackSessionLabels: true });
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

  it("finds names and street addresses in a document when the member's rule set runs data.entities", async () => {
    const context = await createTestContext();
    const call = caller(context);
    const admin = await login(context, "admin");
    const entities = { prompt: { detectors: [{ id: "data.entities", threshold: 0.5, options: { classes: ["person_name", "street_address"] } }], defaultAction: { action: "allow" } } };
    expect((await call(admin, "POST", "/api/guard/profiles", { document: ruleSet("names", { channels: entities }) })).statusCode).toBe(201);
    const created = await call(admin, "POST", "/api/mcp/toolsets", { name: "Names", projectId: "default", members: [{ kind: "content_rules", ruleSetId: "names", documents: { enabled: true } }] });
    expect(created.statusCode, created.body).toBe(201);
    const toolset = created.json<{ toolset: McpToolset }>().toolset;
    const client = (await call(admin, "POST", "/api/mcp/clients", { name: "Names agent", toolsetIds: [toolset.id], role: "builder" })).json<{ client: McpClient; token: string }>();
    const fixture: Gateway = { context, admin, toolset, client: client.client, token: client.token };
    const result = await tools(fixture).call("scan_document", { content_base64: b64(LETTER), redact_style: "mask" });
    expect(result.error, result.text).toBe(false);
    expect(result.data.countsByClass).toMatchObject({ person_name: 1, street_address: 1, email: 1 });
    expect(result.data.riskLevel).toBe("medium");
    expect(result.text).not.toContain("Doyle");
    expect(result.text).not.toContain("Dunmore");
    const { events } = await stored(context.store);
    expect(events.find((event) => event.data_class === "person_name")).toMatchObject({ detector_id: "data.entities" });
    expect(JSON.stringify(events)).not.toContain("Doyle");
  });

  it("matches listed hosts on the scheme's default port only, unless the entry names a port", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const resolver = async () => ["93.184.216.34"];
    const fixture = await gateway({}, { documentScanNetwork: { resolver, fetchImpl } }, { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test", "files.example.test:8443"] });
    const client = tools(fixture);
    expect((await client.call("scan_document", { url: "https://docs.example.test/a" })).error).toBe(false);
    expect((await client.call("scan_document", { url: "http://docs.example.test/a" })).error).toBe(false);
    expect((await client.call("scan_document", { url: "https://docs.example.test:443/a" })).error).toBe(false);
    const otherPort = await client.call("scan_document", { url: "https://docs.example.test:8443/a" });
    expect(otherPort.text).toMatch(/Host 'docs.example.test:8443' is not on this toolset's list/);
    expect((await client.call("scan_document", { url: "https://files.example.test:8443/a" })).error).toBe(false);
    expect((await client.call("scan_document", { url: "https://files.example.test/a" })).error).toBe(true);
    expect(fetched.map((url) => new URL(url).host)).toEqual(["docs.example.test", "docs.example.test", "docs.example.test", "files.example.test:8443"]);
    const call = caller(fixture.context);
    const badPort = await call(fixture.admin, "PUT", `/api/mcp/toolsets/${fixture.toolset.id}`, { members: [{ kind: "content_rules", documents: { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test:70000"] } }] });
    expect(badPort.statusCode).toBe(400);
  });

  it("stops the fetch when the client cancels the call", async () => {
    let aborted = false;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        started();
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      })) as typeof fetch;
    const resolver = async () => ["93.184.216.34"];
    const fixture = await gateway({ CONTENT_SCAN_FETCH_TIMEOUT_MS: "60000", CONTENT_SCAN_FIRST_BYTE_TIMEOUT_MS: "60000" }, { documentScanNetwork: { resolver, fetchImpl } }, { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test"] });
    const initialize = await rpc(fixture, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "docs-test", version: "1" } } });
    const session = initialize.headers["mcp-session-id"] as string;
    const id = (requestId += 1);
    const pending = rpc(fixture, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "scan_document", arguments: { url: "https://docs.example.test/slow" } } }, session);
    await fetchStarted;
    await rpc(fixture, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "not needed" } }, session);
    const response = await pending;
    expect(aborted).toBe(true);
    expect(response.body).not.toContain("finding");
    const audit = JSON.stringify((await stored(fixture.context.store)).audit);
    expect(audit).toContain("cancelled");
  });

  it("keeps no redaction and records no findings for a call cancelled while the document is read", async () => {
    let cancel!: () => Promise<unknown>;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode("Mail ana@example.com or call 415-555-0134.\n"));
            await cancel();
            controller.close();
          }
        }),
        { status: 200, headers: { "content-type": "text/plain" } }
      )) as typeof fetch;
    const resolver = async () => ["93.184.216.34"];
    const fixture = await gateway({}, { documentScanNetwork: { resolver, fetchImpl } }, { enabled: true, allowUrls: true, allowedHosts: ["docs.example.test"] });
    const initialize = await rpc(fixture, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "docs-test", version: "1" } } });
    const session = initialize.headers["mcp-session-id"] as string;
    const id = (requestId += 1);
    cancel = async () => await rpc(fixture, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "not needed" } }, session);
    const response = await rpc(fixture, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "scan_document", arguments: { url: "https://docs.example.test/doc", redact_style: "token" } } }, session);
    expect(response.body).not.toContain("redaction_id");
    const { events, audit } = await stored(fixture.context.store);
    expect(events).toEqual([]);
    expect(audit.map((row) => row.outcome)).toEqual(["failure"]);
    expect(JSON.stringify(audit)).toContain("cancelled");
    expect(await testSql(fixture.context.store).all("SELECT id FROM content_redactions")).toEqual([]);
  });
});
