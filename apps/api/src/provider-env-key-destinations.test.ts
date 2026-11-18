/**
 * A deployment env model key (OPENAI_API_KEY, ANTHROPIC_API_KEY, AZURE_OPENAI_API_KEY) never reaches a host a builder
 * chose: not through model listing, a provider test, a workflow run or a knowledge base. A request-supplied base URL
 * also goes through the outbound URL checks.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
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
const servers: http.Server[] = [];
const ENV = {
  OPENAI_API_KEY: "sk-env-openai-SECRET",
  ANTHROPIC_API_KEY: "sk-ant-env-SECRET",
  AZURE_OPENAI_API_KEY: "azure-env-SECRET"
};
const savedEnv: Record<string, string | undefined> = {};

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-env-key-dest-"));
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
    ...overrides
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

async function login(context: TestContext, role: "admin" | "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${role}: ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  return values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
}

/** A host the builder controls: it records every request's headers and answers like a model server. */
async function captureServer(): Promise<{ baseUrl: string; seen: Array<{ url: string; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    const url = request.url ?? "";
    response.end(
      JSON.stringify(
        url.includes("embeddings")
          ? { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] }
          : url.includes("messages")
            ? { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
            : url.includes("models")
              ? { data: [{ id: "stolen-model" }] }
              : { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen };
}

function sawEnvKey(seen: Array<{ headers: IncomingHttpHeaders }>): boolean {
  return seen.some((request) => JSON.stringify(request.headers).includes("SECRET"));
}

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  savedEnv.PROVIDER_ENV_KEY_BASE_URLS = process.env.PROVIDER_ENV_KEY_BASE_URLS;
  delete process.env.PROVIDER_ENV_KEY_BASE_URLS;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

describe("a builder-chosen base URL never receives a deployment env key", () => {
  it("model listing sends no env key to it (OpenAI, Anthropic, Azure OpenAI)", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const target = await captureServer();
    for (const payload of [
      { providerId: "openai", baseUrl: target.baseUrl },
      { providerId: "anthropic", baseUrl: target.baseUrl },
      { providerId: "azure_openai", baseUrl: target.baseUrl.replace(/\/v1$/, "") }
    ]) {
      const response = await context.app.inject({ method: "POST", url: "/api/providers/models", headers: { cookie }, payload });
      expect(response.statusCode, payload.providerId).toBe(200);
      expect(response.json(), payload.providerId).toEqual({ models: [] });
    }
    expect(target.seen).toEqual([]);
  });

  it("a provider test sends no env key to it", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const target = await captureServer();
    for (const provider of [
      { providerId: "openai", model: "gpt-4o-mini", baseUrl: target.baseUrl },
      { providerId: "anthropic", model: "claude-sonnet-5-5", baseUrl: target.baseUrl },
      { providerId: "azure_openai", model: "dep", baseUrl: target.baseUrl.replace(/\/v1$/, "") }
    ]) {
      const response = await context.app.inject({ method: "POST", url: "/api/providers/test", headers: { cookie }, payload: { provider } });
      expect(response.json().ok, provider.providerId).toBe(false);
      expect(response.json().message, provider.providerId).toMatch(/secret/i);
      expect(response.body).not.toContain("SECRET");
    }
    expect(target.seen).toEqual([]);
  });

  it("a workflow run sends no env key to a node's custom base URL", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const target = await captureServer();
    const workflow = {
      id: "wf-env-key",
      name: "Env key",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "in", type: "text_input", name: "In", position: { x: 0, y: 0 }, config: { text: "hello" } },
        { id: "llm", type: "llm_call", name: "LLM", position: { x: 200, y: 0 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini", baseUrl: target.baseUrl }, retry: { enabled: false, maxAttempts: 1, delayMs: 1 } } },
        { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
      ],
      edges: [
        { id: "e1", source: "in", target: "llm" },
        { id: "e2", source: "llm", target: "out" }
      ]
    };
    expect((await context.app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: workflow })).statusCode).toBe(200);
    const run = await context.app.inject({ method: "POST", url: "/api/workflows/wf-env-key/execute", headers: { cookie }, payload: {} });
    expect(run.body).toMatch(/secret for a custom base URL/);
    expect(target.seen).toEqual([]);
  });

  it("an operator-listed gateway gets the env key; any other host still does not", async () => {
    const target = await captureServer();
    process.env.PROVIDER_ENV_KEY_BASE_URLS = target.baseUrl;
    const context = await createTestContext({ PROVIDER_ENV_KEY_BASE_URLS: target.baseUrl });
    const cookie = await login(context, "builder");
    const listed = await context.app.inject({ method: "POST", url: "/api/providers/models", headers: { cookie }, payload: { providerId: "openai", baseUrl: target.baseUrl } });
    expect(listed.json()).toEqual({ models: [{ id: "stolen-model", label: "stolen-model" }] });
    expect(target.seen[0]?.headers.authorization).toBe(`Bearer ${ENV.OPENAI_API_KEY}`);
    const other = await captureServer();
    await context.app.inject({ method: "POST", url: "/api/providers/models", headers: { cookie }, payload: { providerId: "openai", baseUrl: other.baseUrl } });
    expect(other.seen).toEqual([]);
  });

  it("a knowledge base's custom embeddings endpoint gets no env key", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "admin");
    const target = await captureServer();
    const created = await context.app.inject({
      method: "POST",
      url: "/api/knowledge-bases",
      headers: { cookie },
      payload: { name: "Custom endpoint", embedderId: "openai-embedder", embedderConfig: { baseUrl: target.baseUrl } }
    });
    expect(created.statusCode).toBe(200);
    const kbId = (created.json() as { knowledgeBase: { id: string } }).knowledgeBase.id;
    await context.app.inject({ method: "POST", url: `/api/knowledge-bases/${kbId}/ingest`, headers: { cookie }, payload: { sourceId: "s", documents: [{ content: "hello" }] } });
    // The ingest reached the endpoint (so the check below is not vacuous), without the env key.
    expect(target.seen.length).toBeGreaterThan(0);
    expect(sawEnvKey(target.seen)).toBe(false);
  });
});

describe("a request-supplied base URL goes through the outbound URL checks", () => {
  it("model listing to a private address is refused under OUTBOUND_DENY_PRIVATE", async () => {
    const context = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true" });
    const cookie = await login(context, "builder");
    const target = await captureServer();
    const response = await context.app.inject({ method: "POST", url: "/api/providers/models", headers: { cookie }, payload: { providerId: "openai_compatible", baseUrl: target.baseUrl } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/OUTBOUND_DENY_PRIVATE/);
    expect(target.seen).toEqual([]);
  });

  it("a base URL with literal template braces is still checked", async () => {
    const context = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true" });
    const cookie = await login(context, "builder");
    const target = await captureServer();
    for (const suffix of ["#{{", "?x={{y}}"]) {
      const response = await context.app.inject({
        method: "POST",
        url: "/api/providers/test",
        headers: { cookie },
        payload: { provider: { providerId: "openai_compatible", model: "m", baseUrl: `${target.baseUrl}${suffix}` } }
      });
      expect(response.json().ok, suffix).toBe(false);
      expect(response.json().message, suffix).toMatch(/OUTBOUND_DENY_PRIVATE/);
    }
    expect(target.seen).toEqual([]);
  });

  it("a base URL whose name does not resolve is refused by the check, not left to the provider client", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const response = await context.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: { cookie },
      payload: { provider: { providerId: "openai_compatible", model: "m", baseUrl: "http://no-such-host.invalid/v1" } }
    });
    expect(response.json().ok).toBe(false);
    expect(response.json().message).toMatch(/resolve/i);
  });

  it("a provider test or run to a metadata address is refused before any request", async () => {
    const context = await createTestContext();
    const cookie = await login(context, "builder");
    const response = await context.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: { cookie },
      payload: { provider: { providerId: "openai_compatible", model: "m", baseUrl: "http://169.254.169.254/v1" } }
    });
    expect(response.json().ok).toBe(false);
    expect(response.json().message).toMatch(/link local|metadata/i);
  });

  it("a provider test to a private address is refused under OUTBOUND_DENY_PRIVATE, and allowed when allowlisted", async () => {
    const target = await captureServer();
    const port = new URL(target.baseUrl).port;
    const denied = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true" });
    const deniedCookie = await login(denied, "builder");
    const refused = await denied.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: { cookie: deniedCookie },
      payload: { provider: { providerId: "openai_compatible", model: "m", baseUrl: target.baseUrl } }
    });
    expect(refused.json().ok).toBe(false);
    expect(target.seen).toEqual([]);
    const allowed = await createTestContext({ OUTBOUND_DENY_PRIVATE: "true", OUTBOUND_ALLOWLIST: `127.0.0.1:${port}` });
    const allowedCookie = await login(allowed, "builder");
    const passed = await allowed.app.inject({
      method: "POST",
      url: "/api/providers/test",
      headers: { cookie: allowedCookie },
      payload: { provider: { providerId: "openai_compatible", model: "m", baseUrl: target.baseUrl } }
    });
    expect(passed.json().ok).toBe(true);
    expect(target.seen.length).toBeGreaterThan(0);
  });
});
