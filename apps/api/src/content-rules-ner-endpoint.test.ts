/**
 * The deployment's names and addresses service (CONTENT_RULES_NER_ENDPOINT), end to end against a local mock that
 * follows the endpoint contract: configuration, the engine shown in the detector list, document scans that batch
 * many cells into few requests under one overall time limit, and the judge option's save-time checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpToolset } from "@ai-orchestrator/shared";
import { createApp, type CreateAppOptions } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { startMockNerEndpoint, MOCK_NER_MODEL, type MockNerEndpoint, type MockNerEndpointOptions } from "./test-support/mock-ner-endpoint.js";
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
const servers: MockNerEndpoint[] = [];

async function createTestContext(env: Record<string, string> = {}, options: CreateAppOptions = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-ner-endpoint-"));
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
  while (servers.length > 0) await servers.pop()!.close();
});

async function serve(options: MockNerEndpointOptions = {}) {
  const server = await startMockNerEndpoint({ vocabulary: { "Alan Doyle": { label: "person_name", score: 0.97 }, Zyrtova: { label: "location", score: 0.9 } }, ...options });
  servers.push(server);
  return server;
}

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
  return (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function namesRuleSet(id: string, options: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: `Rules ${id}`,
    version: "1",
    channels: { prompt: { detectors: [{ id: "data.entities", threshold: 0.5, options }], defaultAction: { action: "allow" } } }
  };
}

async function engineOf(context: TestContext, cookie: string) {
  const response = await caller(context)(cookie, "GET", "/api/guard/detectors");
  expect(response.statusCode).toBe(200);
  return response.json<{ detectors: Array<{ id: string; engine?: Record<string, unknown> }> }>().detectors.find((detector) => detector.id === "data.entities")!.engine!;
}

describe("names and addresses service configuration", () => {
  it("is off by default, and refuses a URL with credentials, a query or another scheme", () => {
    expect(parseConfig({}).CONTENT_RULES_NER_ENDPOINT).toBeUndefined();
    expect(parseConfig({ CONTENT_RULES_NER_ENDPOINT: "" }).CONTENT_RULES_NER_ENDPOINT).toBeUndefined();
    expect(parseConfig({ CONTENT_RULES_NER_ENDPOINT: "http://ner:8000" }).CONTENT_RULES_NER_ENDPOINT).toBe("http://ner:8000");
    for (const bad of ["http://user:pw@ner:8000", "http://ner:8000/?key=1", "ftp://ner", "ner:8000"]) {
      expect(() => parseConfig({ CONTENT_RULES_NER_ENDPOINT: bad })).toThrow();
    }
    expect(parseConfig({}).CONTENT_SCAN_TIME_LIMIT_MS).toBe(120_000);
    expect(parseConfig({}).CONTENT_RULES_NER_ENDPOINT_TIMEOUT_MS).toBe(10_000);
    expect(parseConfig({}).CONTENT_RULES_NER_ENDPOINT_MAX_CONCURRENT).toBe(4);
    expect(parseConfig({ CONTENT_RULES_NER_ENDPOINT_MAX_CONCURRENT: "16" }).CONTENT_RULES_NER_ENDPOINT_MAX_CONCURRENT).toBe(16);
    for (const bad of ["0", "65", "two"]) expect(() => parseConfig({ CONTENT_RULES_NER_ENDPOINT_MAX_CONCURRENT: bad })).toThrow();
  });
});

describe("the detector list", () => {
  it("shows the built-in rules when no service is configured", async () => {
    const context = await createTestContext();
    const viewer = await login(context, "viewer");
    expect(await engineOf(context, viewer)).toMatchObject({ id: "rules", kind: "rules", status: "rules" });
  });

  it("shows the service's health and model, and its status when no model is loaded", async () => {
    const server = await serve({ token: "t0ken" });
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url, CONTENT_RULES_NER_ENDPOINT_TOKEN: "t0ken", OUTBOUND_DENY_PRIVATE: "true" });
    const viewer = await login(context, "viewer");
    const engine = await engineOf(context, viewer);
    expect(engine).toMatchObject({ id: "endpoint", kind: "endpoint", status: "loaded", model: MOCK_NER_MODEL });
    expect(JSON.stringify(engine)).not.toContain("t0ken");
    expect(server.authorizations.every((value) => value === "Bearer t0ken")).toBe(true);

    const idle = await serve({ ready: false });
    const other = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: idle.url });
    expect(await engineOf(other, await login(other, "viewer"))).toMatchObject({ kind: "endpoint", status: "not_ready", message: expect.stringContaining("No model is loaded") });
  });

  it("notes checks that went unchecked because the service was overloaded", async () => {
    const server = await serve();
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url });
    const builder = await login(context, "builder");
    const call = caller(context);
    expect((await call(builder, "POST", "/api/guard/profiles", { document: namesRuleSet("names", { classes: ["person_name"], engine: "endpoint" }) })).statusCode).toBe(201);
    for (let attempt = 0; attempt < 3; attempt += 1) server.answerNext(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "0" });
    const response = await call(builder, "POST", "/api/guard/profiles/names/scan-document", { source: { kind: "upload", contentBase64: b64("Dear Alan Doyle"), mediaType: "text/plain" } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("Doyle");
    const engine = await engineOf(context, await login(context, "viewer"));
    expect(engine.message).toEqual(expect.stringMatching(/Overloaded 1 time since the API started .*did not check names and addresses/));
  });
});

describe("document scans through the service", () => {
  it("send many CSV cells in few requests and report findings at their cells", async () => {
    const server = await serve();
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url });
    const builder = await login(context, "builder");
    const call = caller(context);
    expect((await call(builder, "POST", "/api/guard/profiles", { document: namesRuleSet("names", { classes: ["person_name", "location"] }) })).statusCode).toBe(201);
    const rows = ["id,name,town"];
    for (let row = 1; row <= 400; row += 1) rows.push(`${row},${row % 100 === 0 ? "Alan Doyle" : "nobody"},${row % 80 === 0 ? "Zyrtova" : "none"}`);
    const response = await call(builder, "POST", "/api/guard/profiles/names/scan-document", { source: { kind: "upload", contentBase64: b64(rows.join("\n")), mediaType: "text/csv" } });
    expect(response.statusCode, response.body).toBe(200);
    const { result } = response.json<{ result: { countsByClass: Record<string, number>; findings: Array<{ location: { label: string } }> } }>();
    expect(result.countsByClass).toEqual({ person_name: 4, location: 5 });
    // About 1,200 cells: 64 per request at most, so about 20 requests rather than one per cell.
    expect(server.requests.length).toBeLessThanOrEqual(25);
    expect(server.requests.every((request) => request.texts.length <= 64)).toBe(true);
    expect(response.body).not.toContain("Doyle");
  });

  it("stop at the overall time limit with a timeout", async () => {
    const server = await serve({ delayMs: 400 });
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url, CONTENT_SCAN_TIME_LIMIT_MS: "1000", CONTENT_RULES_NER_ENDPOINT_TIMEOUT_MS: "5000" });
    const builder = await login(context, "builder");
    const call = caller(context);
    expect((await call(builder, "POST", "/api/guard/profiles", { document: namesRuleSet("names", { classes: ["person_name"] }) })).statusCode).toBe(201);
    // Each cell group is one request of 400 ms; many groups exceed the 1 s limit.
    const rows = Array.from({ length: 2_000 }, (_, row) => `${row},Alan Doyle ${"x".repeat(150)}`);
    const started = Date.now();
    const response = await call(builder, "POST", "/api/guard/profiles/names/scan-document", { source: { kind: "upload", contentBase64: b64(rows.join("\n")), mediaType: "text/csv" } });
    expect(response.statusCode, response.body).toBe(504);
    expect(response.body).toContain("took longer than 1 s");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("fail with 503 when the service is down, without its details", async () => {
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: "http://127.0.0.1:1" });
    const builder = await login(context, "builder");
    const call = caller(context);
    expect((await call(builder, "POST", "/api/guard/profiles", { document: namesRuleSet("names", { classes: ["person_name"], engine: "endpoint" }) })).statusCode).toBe(201);
    const response = await call(builder, "POST", "/api/guard/profiles/names/scan-document", { source: { kind: "upload", contentBase64: b64("Dear Alan Doyle"), mediaType: "text/plain" } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("127.0.0.1");
    expect(response.body).not.toContain("Doyle");
  });
});

describe("the judge option when a rule set is saved", () => {
  it("needs a model, refuses credentials in it, and needs an admin for a custom address", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const admin = await login(context, "admin");
    const call = caller(context);
    const save = (cookie: string, id: string, judge: Record<string, unknown>) =>
      call(cookie, "POST", "/api/guard/profiles", { document: namesRuleSet(id, { classes: ["person_name"], judge }) });
    const missing = await save(builder, "j1", { enabled: true });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain("judge.model");
    const leaky = await save(builder, "j2", { enabled: true, model: { providerId: "openai", model: "gpt-test", apiKey: "sk-live" } });
    expect(leaky.statusCode).toBe(400);
    expect(leaky.body).not.toContain("sk-live");
    const custom = { enabled: true, model: { providerId: "openai_compatible", model: "judge", baseUrl: "https://llm.example" } };
    expect((await save(builder, "j3", custom)).statusCode).toBe(400);
    expect((await save(admin, "j4", custom)).statusCode).toBe(201);
    expect((await save(builder, "j5", { enabled: true, model: { providerId: "openai", model: "gpt-test" } })).statusCode).toBe(201);
  });
});

describe("content rules tools through the service", () => {
  async function gatewayTools(context: TestContext) {
    const admin = await login(context, "admin");
    const call = caller(context);
    expect((await call(admin, "POST", "/api/guard/profiles", { document: namesRuleSet("names", { classes: ["person_name"] }) })).statusCode).toBe(201);
    const toolset = (await call(admin, "POST", "/api/mcp/toolsets", { name: "Privacy tools", projectId: "default", members: [{ kind: "content_rules", ruleSetId: "names" }] })).json<{ toolset: McpToolset }>().toolset;
    const created = await call(admin, "POST", "/api/mcp/clients", { name: "Agent", toolsetIds: [toolset.id], role: "builder" });
    expect(created.statusCode, created.body).toBe(201);
    const token = created.json<{ token: string }>().token;
    const rpc = (body: unknown, session?: string) =>
      context.app.inject({
        method: "POST",
        url: `/mcp/${toolset.slug}`,
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(session ? { "mcp-session-id": session } : {}) },
        payload: JSON.stringify(body)
      });
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ner-test", version: "1" } } });
    const session = init.headers["mcp-session-id"] as string;
    return async (args: Record<string, unknown>) => {
      const response = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "detect_sensitive_data", arguments: args } }, session);
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json<{ result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> } }>().result;
      return { error: result.isError === true, text: result.content.map((entry) => entry.text).join("\n"), data: result.structuredContent ?? {} };
    };
  }

  it("send the strings of a call in few requests", async () => {
    const server = await serve();
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url });
    const detect = await gatewayTools(context);
    const texts = Array.from({ length: 200 }, (_, index) => (index % 50 === 0 ? `Alan Doyle ${index}` : `note ${index}`));
    // One JSON value with 200 strings: each string is a text to the service.
    const result = await detect({ value: { rows: texts }, entity_types: ["person_name"] });
    expect(result.error, result.text).toBe(false);
    expect(result.data.inputs[0].counts).toEqual({ person_name: 4 });
    expect(server.requests.length).toBe(Math.ceil(200 / 64));
    expect(result.text).not.toContain("Doyle");
  });

  it("stop at the overall time limit", async () => {
    const server = await serve({ delayMs: 400 });
    const context = await createTestContext({ CONTENT_RULES_NER_ENDPOINT: server.url, CONTENT_SCAN_TIME_LIMIT_MS: "1000", CONTENT_RULES_NER_ENDPOINT_MAX_REQUEST_CHARS: "5000" });
    const detect = await gatewayTools(context);
    const texts = Array.from({ length: 100 }, (_, index) => `${index} ${"word ".repeat(200)}`);
    const started = Date.now();
    const result = await detect({ texts, entity_types: ["person_name"] });
    expect(result.error).toBe(true);
    expect(result.text).toContain("took longer than 1 s");
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
