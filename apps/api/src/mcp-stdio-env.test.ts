/**
 * Stdio MCP servers started on the API host get a minimal part of the API's environment: the master key and the
 * database URL stay out unless MCP_STDIO_INHERIT_ENV=true, and MCP_STDIO_ENV_PASSTHROUGH adds names. End to end
 * through the Fastify app (register, probe, playground call).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpPlaygroundCallResponse } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

/** A legacy server with one read-only tool, `env`, that answers with its whole environment. */
const ENV_REPORTING_SERVER = `
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    const answer = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\\n');
    if (req.method === 'initialize') {
      answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env', version: '1' } });
    } else if (req.method === 'tools/list') {
      answer({ tools: [{ name: 'env', description: 'Report the environment', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
    } else if (req.method === 'tools/call') {
      answer({ content: [{ type: 'text', text: JSON.stringify(process.env) }] });
    } else if (req.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'unknown' } }) + '\\n');
    }
  }
});
`;

/** What a deployment would have in the API's own environment. */
const API_PROCESS_ENV = {
  SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
  DATABASE_URL: "postgres://l2m:not-a-real-password@db.internal:5432/l2m",
  L2M_ENVFIX_EXTRA_REGION: "eu-west"
};

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [name, value] of Object.entries(API_PROCESS_ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

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
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function createTestContext(overrides: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-mcp-stdio-env-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: API_PROCESS_ENV.SECRET_MASTER_KEY_BASE64,
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

async function adminCookie(context: TestContext): Promise<string> {
  const email = "admin@example.com";
  const password = "admin-Pass-123!";
  await context.authService.register({ email, password, role: "admin" });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie: ${response.body}`);
  return cookie.split(";")[0]!;
}

/** Register the env-reporting server, probe it and return the environment its `env` tool saw. */
async function serverEnvironment(overrides: Record<string, string> = {}): Promise<Record<string, string>> {
  const context = await createTestContext(overrides);
  const admin = await adminCookie(context);
  const created = await context.app.inject({
    method: "POST",
    url: "/api/mcp/servers",
    headers: { cookie: admin },
    payload: {
      name: "Env report",
      adapterId: "stdio_mcp",
      connection: { command: process.execPath, args: ["-e", ENV_REPORTING_SERVER], env: { SERVER_OWN: "own" }, timeoutMs: 10_000 },
      probeEnabled: false
    }
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().server.id as string;
  const probe = await context.app.inject({ method: "POST", url: `/api/mcp/servers/${id}/probe`, headers: { cookie: admin } });
  expect(probe.json().probe.ok).toBe(true);
  const call = await context.app.inject({
    method: "POST",
    url: `/api/mcp/servers/${id}/playground/call`,
    headers: { cookie: admin },
    payload: { toolName: "env", args: {} }
  });
  expect(call.statusCode).toBe(200);
  const content = (call.json() as McpPlaygroundCallResponse).result.content[0] as { text?: string };
  return JSON.parse(content.text ?? "{}") as Record<string, string>;
}

describe("stdio MCP server environment", () => {
  it("keeps the master key and the database URL out by default", async () => {
    const env = await serverEnvironment();
    expect(env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("L2M_ENVFIX_EXTRA_REGION");
    expect(env.SERVER_OWN).toBe("own");
    expect(env.PATH).toBeTruthy();
  });

  it("passes names listed in MCP_STDIO_ENV_PASSTHROUGH", async () => {
    const env = await serverEnvironment({ MCP_STDIO_ENV_PASSTHROUGH: "L2M_ENVFIX_EXTRA_*" });
    expect(env.L2M_ENVFIX_EXTRA_REGION).toBe("eu-west");
    expect(env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
  });

  it("passes the whole environment with MCP_STDIO_INHERIT_ENV=true", async () => {
    const env = await serverEnvironment({ MCP_STDIO_INHERIT_ENV: "true" });
    expect(env.SECRET_MASTER_KEY_BASE64).toBe(API_PROCESS_ENV.SECRET_MASTER_KEY_BASE64);
    expect(env.DATABASE_URL).toBe(API_PROCESS_ENV.DATABASE_URL);
    expect(env.SERVER_OWN).toBe("own");
  });
});

describe("MCP stdio environment settings", () => {
  it("default to the minimal environment and read blank as unset", () => {
    expect(parseConfig({}).MCP_STDIO_INHERIT_ENV).toBeUndefined();
    expect(parseConfig({ MCP_STDIO_INHERIT_ENV: "" }).MCP_STDIO_INHERIT_ENV).toBeUndefined();
    expect(parseConfig({ MCP_STDIO_INHERIT_ENV: "true" }).MCP_STDIO_INHERIT_ENV).toBe(true);
    expect(parseConfig({ MCP_STDIO_ENV_PASSTHROUGH: "JAVA_HOME, MY_TOOL_*" }).MCP_STDIO_ENV_PASSTHROUGH).toBe("JAVA_HOME, MY_TOOL_*");
  });

  it("refuses a passthrough entry that is not a variable name, and * alone", () => {
    expect(() => parseConfig({ MCP_STDIO_ENV_PASSTHROUGH: "*" })).toThrow(/MCP_STDIO_INHERIT_ENV/);
    expect(() => parseConfig({ MCP_STDIO_ENV_PASSTHROUGH: "GOOD,NOT A NAME" })).toThrow(/MCP_STDIO_ENV_PASSTHROUGH/);
    expect(() => parseConfig({ MCP_STDIO_INHERIT_ENV: "maybe" })).toThrow();
  });
});
