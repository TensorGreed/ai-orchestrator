/**
 * Integration catalog routes: registered MCP servers' tools and stored OpenAPI specs as palette entries. Specs are
 * read from a URL (outbound checks, size cap) or from uploaded text, kept to a project with builder access, refreshed
 * and removed; an HTTP Request node made from an operation runs through the normal HTTP Request path.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildOperationRequest, jsonTemplateFromForm, type OpenApiOperation, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { parseSpecText } from "./integration-catalog-routes.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const fixtureYaml = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/openapi/tickets.openapi.yaml"), "utf8");

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  secretService: SecretService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-catalog-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, secretService, config, tempDir };
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie for ${name}`);
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

// A local server: the spec (JSON and YAML), an oversized spec, a redirect, and the API the spec describes.
let server: Server;
let base = "";
let specVersion = 1;
const apiRequests: Array<{ method: string; url: string; key: string | undefined; body: string }> = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "";
      const spec = fixtureYaml.replace("http://127.0.0.1:1/api", `${base}/api`);
      if (url === "/spec.yaml" || url.startsWith("/spec.yaml?")) {
        response.writeHead(200, { "content-type": "application/yaml" });
        response.end(specVersion === 1 ? spec : spec.replace(/  \/tickets\/\{ticketId\}:[\s\S]*$/, ""));
      } else if (url === "/spec.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ openapi: "3.1.0", info: { title: "JSON API" }, servers: [{ url: "/api" }], paths: { "/ping": { get: { operationId: "ping" } } } }));
      } else if (url === "/big.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`{"openapi":"3.0.0","pad":"${"x".repeat(3 * 1024 * 1024)}"}`);
      } else if (url === "/swagger.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ swagger: "2.0", paths: {} }));
      } else if (url === "/missing") {
        response.writeHead(404);
        response.end();
      } else if (url.startsWith("/api/")) {
        apiRequests.push({ method: request.method ?? "", url, key: request.headers["x-api-key"] as string | undefined, body });
        response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, url }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("parseSpecText", () => {
  it("reads YAML and JSON specs and refuses neither", () => {
    expect(parseSpecText(fixtureYaml).operations.map((op) => op.id)).toEqual(["listTickets", "createTicket", "getTicket"]);
    expect(parseSpecText('{"openapi":"3.0.0","paths":{"/a":{"get":{}}}}').operations).toHaveLength(1);
    expect(() => parseSpecText("{not json")).toThrow(/not valid JSON/);
    expect(() => parseSpecText("a: [b")).toThrow(/neither JSON nor YAML/);
    // Alias bombs stop at the alias limit.
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 12 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n");
    expect(() => parseSpecText(bomb)).toThrow();
  });
});

describe("OpenAPI specs", () => {
  it("never shows a spec URL's query to readers, and keeps it for refresh", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    specVersion = 1;
    const created = await call(context, "POST", "/api/catalog/openapi-specs", builder.cookie, { url: `${base}/spec.yaml?token=s3cret` });
    expect(created.statusCode).toBe(201);
    const spec = created.json().spec;
    expect(spec.sourceUrl).toBe(`${base}/spec.yaml?…`);
    const catalog = (await call(context, "GET", "/api/catalog?projectId=default", builder.cookie)).json();
    expect(JSON.stringify(catalog)).not.toContain("s3cret");
    expect(JSON.stringify((await call(context, "GET", `/api/catalog/openapi-specs/${spec.id}`, builder.cookie)).json())).not.toContain("s3cret");
    expect((await call(context, "POST", `/api/catalog/openapi-specs/${spec.id}/refresh`, builder.cookie, {})).statusCode).toBe(200);
  });

  it("adds a spec from a URL, lists its operations in the catalog, refreshes and removes it", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    specVersion = 1;

    const created = await call(context, "POST", "/api/catalog/openapi-specs", builder.cookie, { url: `${base}/spec.yaml` });
    expect(created.statusCode).toBe(201);
    const spec = created.json().spec;
    expect(spec).toMatchObject({ name: "Ticket Desk", projectId: "default", operationCount: 3, baseUrl: `${base}/api`, sourceUrl: `${base}/spec.yaml` });
    expect(spec.operations).toBeUndefined();

    const catalog = (await call(context, "GET", "/api/catalog?projectId=default", builder.cookie)).json();
    expect(catalog.entries.map((entry: { label: string }) => entry.label)).toEqual([
      "Ticket Desk · List tickets",
      "Ticket Desk · Create a ticket",
      "Ticket Desk · Get a ticket"
    ]);
    expect(catalog.entries[1]).toMatchObject({
      key: `openapi:${spec.id}:createTicket`,
      kind: "openapi_operation",
      description: "POST /tickets",
      nodeType: "http_request",
      nodeConfig: {
        method: "POST",
        urlTemplate: `${base}/api/tickets`,
        failOnHttpError: true,
        secretAuth: { type: "header", name: "X-API-Key" },
        openapiOperation: { specId: spec.id, operationId: "createTicket", method: "POST", path: "/tickets", baseUrl: `${base}/api` },
        operationValues: {}
      }
    });
    expect(catalog.entries[1].nodeConfig.secretRef).toBeUndefined();
    expect(catalog.sources).toEqual([expect.objectContaining({ kind: "openapi_spec", id: spec.id, itemCount: 3 })]);

    const full = (await call(context, "GET", `/api/catalog/openapi-specs/${spec.id}`, builder.cookie)).json().spec;
    expect(full.operations[1].auth).toEqual({ type: "header", name: "X-API-Key" });

    // A relative server URL resolves against the spec URL.
    const json = await call(context, "POST", "/api/catalog/openapi-specs", builder.cookie, { url: `${base}/spec.json`, name: "Pinger" });
    expect(json.json().spec).toMatchObject({ name: "Pinger", baseUrl: `${base}/api` });

    specVersion = 2;
    const refreshed = await call(context, "POST", `/api/catalog/openapi-specs/${spec.id}/refresh`, builder.cookie, {});
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ spec: { operationCount: 2 }, removed: ["getTicket"], added: [] });

    const readAt = refreshed.json().spec.fetchedAt;
    const patched = await call(context, "PATCH", `/api/catalog/openapi-specs/${spec.id}`, builder.cookie, { name: "Desk", baseUrl: "https://desk.example.com/v2/" });
    expect(patched.json().spec).toMatchObject({ name: "Desk", baseUrl: "https://desk.example.com/v2" });
    // A rename is not a read of the spec.
    expect(patched.json().spec.fetchedAt).toBe(readAt);
    // A base URL someone set survives a refresh.
    const again = await call(context, "POST", `/api/catalog/openapi-specs/${spec.id}/refresh`, builder.cookie, {});
    expect(again.json().spec.baseUrl).toBe("https://desk.example.com/v2");

    const audit = await context.store.listAuditLogs({ resourceType: "openapi_spec" });
    expect(audit.items.map((row) => row.eventType)).toEqual(expect.arrayContaining(["openapi_spec.created", "openapi_spec.refreshed", "openapi_spec.updated"]));

    expect((await call(context, "DELETE", `/api/catalog/openapi-specs/${spec.id}`, builder.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", `/api/catalog/openapi-specs/${spec.id}`, builder.cookie)).statusCode).toBe(404);
  });

  it("adds a spec from uploaded text; an upload refreshes only with new text", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const created = await call(context, "POST", "/api/catalog/openapi-specs", builder.cookie, { specText: fixtureYaml, baseUrl: `${base}/api` });
    expect(created.statusCode).toBe(201);
    const spec = created.json().spec;
    expect(spec).toMatchObject({ sourceUrl: null, baseUrl: `${base}/api`, operationCount: 3 });
    const noText = await call(context, "POST", `/api/catalog/openapi-specs/${spec.id}/refresh`, builder.cookie, {});
    expect(noText.statusCode).toBe(400);
    expect(noText.json().error).toMatch(/Upload the new file/);
    const withText = await call(context, "POST", `/api/catalog/openapi-specs/${spec.id}/refresh`, builder.cookie, { specText: '{"openapi":"3.0.0","paths":{"/a":{"get":{}}}}' });
    expect(withText.json().spec.operationCount).toBe(1);
  });

  it("refuses bad specs, oversized ones, bad URLs and URLs the outbound checks block", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const post = (payload: unknown) => call(context, "POST", "/api/catalog/openapi-specs", builder.cookie, payload);
    expect((await post({ url: `${base}/swagger.json` })).json().error).toMatch(/Swagger 2.0/);
    expect((await post({ url: `${base}/big.json` })).json().error).toMatch(/larger than 2 MB/);
    expect((await post({ url: `${base}/missing` })).json().error).toMatch(/answered 404/);
    expect((await post({ url: "file:///etc/passwd" })).json().error).toMatch(/http:\/\/ or https:\/\//);
    expect((await post({ url: "https://user:pw@example.com/spec.json" })).json().error).toMatch(/user name or password/);
    expect((await post({ url: `${base}/spec.yaml`, specText: "x" })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ specText: fixtureYaml, baseUrl: "https://u:p@x.example.com" })).json().error).toMatch(/user name or password/);
    expect((await post({ specText: "x".repeat(2 * 1024 * 1024 + 1) })).statusCode).toBe(400);
    expect(await context.store.listOpenApiSpecs()).toEqual([]);

    const guarded = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true" });
    const guardedBuilder = await login(guarded, "builder");
    const blocked = await call(guarded, "POST", "/api/catalog/openapi-specs", guardedBuilder.cookie, { url: `${base}/spec.yaml` });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatch(/Could not read the spec/);
    const metadata = await call(guarded, "POST", "/api/catalog/openapi-specs", guardedBuilder.cookie, { url: "http://169.254.169.254/latest" });
    expect(metadata.statusCode).toBe(400);
  });

  it("keeps specs to their project: builders of the project manage them, others see nothing", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const member = await login(context, "builder", "member");
    const outsider = await login(context, "builder", "outsider");
    const reader = await login(context, "builder", "reader");
    const viewer = await login(context, "viewer");
    const operator = await login(context, "operator");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: member.id, projectId: "team", role: "editor" });
    await context.store.upsertProjectRole({ userId: reader.id, projectId: "team", role: "viewer" });
    await context.store.upsertProjectRole({ userId: viewer.id, projectId: "team", role: "editor" });

    const created = await call(context, "POST", "/api/catalog/openapi-specs", member.cookie, { projectId: "team", specText: fixtureYaml });
    expect(created.statusCode).toBe(201);
    const id = created.json().spec.id;

    expect((await call(context, "POST", "/api/catalog/openapi-specs", outsider.cookie, { projectId: "team", specText: fixtureYaml })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/catalog/openapi-specs?projectId=team", outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/catalog?projectId=team", outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", `/api/catalog/openapi-specs/${id}`, outsider.cookie)).statusCode).toBe(404);
    expect((await call(context, "DELETE", `/api/catalog/openapi-specs/${id}`, outsider.cookie)).statusCode).toBe(404);
    // A project viewer reads the catalog but cannot change it.
    expect((await call(context, "GET", `/api/catalog/openapi-specs/${id}`, reader.cookie)).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/catalog/openapi-specs/${id}`, reader.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", `/api/catalog/openapi-specs/${id}/refresh`, reader.cookie, { specText: fixtureYaml })).statusCode).toBe(403);
    // Viewers and operators never manage the catalog, whatever their project role.
    expect((await call(context, "GET", "/api/catalog?projectId=team", viewer.cookie)).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/catalog/openapi-specs", viewer.cookie, { projectId: "team", specText: fixtureYaml })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/catalog?projectId=team", operator.cookie)).statusCode).toBe(403);

    const memberCatalog = (await call(context, "GET", "/api/catalog?projectId=team", member.cookie)).json();
    expect(memberCatalog.entries).toHaveLength(3);
    // The default project's catalog does not show the team's specs.
    const admin = await login(context, "admin");
    expect((await call(context, "GET", "/api/catalog", admin.cookie)).json().entries).toEqual([]);
  });

  it("an HTTP Request node made from an operation runs with the secret sent as the spec says", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const spec = (await call(context, "POST", "/api/catalog/openapi-specs", admin.cookie, { specText: fixtureYaml.replace("http://127.0.0.1:1/api", `${base}/api`) })).json().spec;
    const full = (await call(context, "GET", `/api/catalog/openapi-specs/${spec.id}`, admin.cookie)).json().spec;
    const operation = full.operations.find((op: OpenApiOperation) => op.id === "createTicket") as OpenApiOperation;
    const values = { "body.title": "{{ user_prompt }}", "body.priority": "2" };
    const request = buildOperationRequest(operation, full.baseUrl, values);
    expect(request.errors).toEqual({});
    const secret = await context.secretService.createSecret({ name: "desk-key", provider: "custom", value: "desk-secret-value" });

    const workflow: Workflow = {
      id: "wf-catalog-http",
      name: "Catalog HTTP",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
        {
          id: "create",
          type: "http_request",
          name: "Ticket Desk · Create a ticket",
          position: { x: 200, y: 0 },
          config: {
            method: request.method,
            urlTemplate: request.urlTemplate,
            headersTemplate: request.headersTemplate,
            bodyTemplate: request.bodyTemplate,
            responseType: "json",
            failOnHttpError: true,
            secretRef: { secretId: secret.secretId },
            secretAuth: operation.auth,
            openapiOperation: { specId: spec.id, operationId: operation.id, method: operation.method, path: operation.path },
            operationValues: values
          }
        },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "in", target: "create" },
        { id: "e2", source: "create", target: "out" }
      ]
    };
    expect((await call(context, "POST", "/api/workflows", admin.cookie, workflow)).statusCode).toBeLessThan(300);
    const before = apiRequests.length;
    const run = await call(context, "POST", "/api/workflows/wf-catalog-http/execute", admin.cookie, { user_prompt: "Printer jam" });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe("success");
    const sent = apiRequests.slice(before);
    expect(sent).toEqual([{ method: "POST", url: "/api/tickets", key: "desk-secret-value", body: expect.any(String) }]);
    expect(JSON.parse(sent[0]!.body)).toEqual({ title: "Printer jam", priority: 2 });
    expect(JSON.stringify(run.json())).not.toContain("desk-secret-value");
  });
});

describe("MCP tools in the catalog", () => {
  it("lists a registered server's probed tools as `<server> · <tool>` entries", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const created = await call(context, "POST", "/api/mcp/servers", admin.cookie, { name: "Demo tools", adapterId: "mock-mcp", probeEnabled: false });
    expect(created.statusCode).toBe(201);
    const serverId = created.json().server.id;
    // Not probed yet: listed as a source with no tools.
    let catalog = (await call(context, "GET", "/api/catalog", builder.cookie)).json();
    expect(catalog.sources).toEqual([expect.objectContaining({ kind: "mcp_server", id: serverId, itemCount: 0, refreshedAt: null })]);
    expect((await call(context, "POST", `/api/mcp/servers/${serverId}/probe`, admin.cookie)).statusCode).toBe(200);
    catalog = (await call(context, "GET", "/api/catalog", builder.cookie)).json();
    const labels = catalog.entries.map((entry: { label: string }) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(["Demo tools · get_current_time", "Demo tools · calculator"]));
    expect(catalog.entries.find((entry: { itemId: string }) => entry.itemId === "calculator")).toMatchObject({
      key: `mcp:${serverId}:calculator`,
      kind: "mcp_tool",
      sourceId: serverId,
      description: expect.stringMatching(/math expression/),
      nodeType: "mcp_tool",
      nodeConfig: { registryServerId: serverId, serverId: "mock-mcp", toolName: "calculator", allowedTools: ["calculator"], argsTemplate: "{}", argValues: {} }
    });
    // A node made from the entry runs through the MCP Tool node, with the form's arguments.
    const entry = catalog.entries.find((item: { itemId: string }) => item.itemId === "calculator");
    const argValues = { expression: "{{ user_prompt }}" };
    const workflow: Workflow = {
      id: "wf-catalog-mcp",
      name: "Catalog MCP",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "in", type: "webhook_input", name: "In", position: { x: 0, y: 0 }, config: {} },
        {
          id: "calc",
          type: "mcp_tool",
          name: entry.label,
          position: { x: 200, y: 0 },
          config: { ...entry.nodeConfig, argValues, argsTemplate: jsonTemplateFromForm({ type: "object", properties: { expression: { type: "string" } } }, argValues).template }
        },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: {} }
      ],
      edges: [
        { id: "e1", source: "in", target: "calc" },
        { id: "e2", source: "calc", target: "out" }
      ]
    };
    expect((await call(context, "POST", "/api/workflows", admin.cookie, workflow)).statusCode).toBeLessThan(300);
    const run = await call(context, "POST", "/api/workflows/wf-catalog-mcp/execute", admin.cookie, { user_prompt: "2+3" });
    expect(run.json().status).toBe("success");
    expect(JSON.stringify(run.json().nodeResults ?? run.json())).toContain("5");

    // Builders only: the catalog is for adding nodes.
    const viewer = await login(context, "viewer");
    expect((await call(context, "GET", "/api/catalog", viewer.cookie)).statusCode).toBe(403);
  });
});
