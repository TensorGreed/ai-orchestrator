/**
 * The code sandbox plan is settled before the API serves anything (review
 * finding M3): until it is, code nodes are refused, and if it cannot be
 * determined they stay refused instead of falling back to the host.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type CreateAppOptions } from "./app";
import { parseConfig, type AppConfig } from "./config";
import { SqliteStore } from "./db/database";
import { AuthService } from "./services/auth-service";
import { SecretService } from "./services/secret-service";

interface Ctx {
  app: FastifyInstance;
  store: SqliteStore;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: Ctx[] = [];

function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    LOG_LEVEL: "fatal",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    SEED_SAMPLE_WORKFLOWS: "false",
    ...overrides
  };
}

async function createCtx(env: Record<string, string>, options: CreateAppOptions): Promise<Ctx> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-code-startup-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  const config = parseConfig(baseEnv(env));
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = createApp(config, store, secretService, authService, undefined, undefined, undefined, options);
  const ctx = { app, store, authService, config, tempDir };
  contexts.push(ctx);
  return ctx;
}

async function builderCookie(ctx: Ctx): Promise<string> {
  ctx.authService.register({ email: "builder@example.com", password: "builder-password", role: "builder" });
  const response = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "builder@example.com", password: "builder-password" } });
  const header = response.headers["set-cookie"];
  const raw = (Array.isArray(header) ? header : [header ?? ""]).find((entry) => entry.startsWith(`${ctx.config.SESSION_COOKIE_NAME}=`)) ?? "";
  return raw.split(";")[0] ?? "";
}

const dockerOnly = { locate: (runtime: string) => (runtime === "docker" ? "/usr/bin/docker" : null) };

afterEach(async () => {
  while (contexts.length > 0) {
    const ctx = contexts.pop()!;
    await ctx.app.close();
    ctx.store.close?.();
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

describe("code sandbox plan at startup", () => {
  it("the API is not ready until the plan has settled, then runs code under it", async () => {
    // One check per image (JS and Python); hold both until the test releases them.
    const pending: Array<(present: boolean) => void> = [];
    const imagePresent = () => new Promise<boolean>((resolve) => { pending.push(resolve); });
    const ctx = await createCtx({ CODE_SANDBOX_MODE: "auto" }, { codeSandboxDeps: { locator: dockerOnly, imagePresent } });
    let ready = false;
    const readyPromise = ctx.app.ready().then(() => { ready = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ready).toBe(false);
    for (const release of pending) release(false);
    await readyPromise;
    expect(ready).toBe(true);
    const cookie = await builderCookie(ctx);
    const response = await ctx.app.inject({ method: "POST", url: "/api/code-node/test", headers: { cookie }, payload: { code: "return 1 + 1;" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ result: 2 });
  });

  it("fails closed when the plan cannot be determined: code nodes stay disabled", async () => {
    const imagePresent = () => Promise.reject(new Error("runtime probe exploded"));
    const ctx = await createCtx({ CODE_SANDBOX_MODE: "auto" }, { codeSandboxDeps: { locator: dockerOnly, imagePresent } });
    await ctx.app.ready();
    const cookie = await builderCookie(ctx);
    const response = await ctx.app.inject({ method: "POST", url: "/api/code-node/test", headers: { cookie }, payload: { code: "return 1;" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/could not be set up/);
  });

  it("CODE_NODES_ENABLED=false is in force from the first request", async () => {
    const ctx = await createCtx({ CODE_NODES_ENABLED: "false" }, {});
    await ctx.app.ready();
    const cookie = await builderCookie(ctx);
    const response = await ctx.app.inject({ method: "POST", url: "/api/code-node/test", headers: { cookie }, payload: { code: "return 1;" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatch(/CODE_NODES_ENABLED=false/);
  });
});

describe("code sandbox configuration", () => {
  it("validates CODE_SANDBOX_PYTHON_IN_PROCESS, the Python uid/gid and EXPRESSION_MEMORY_MB", () => {
    expect(parseConfig(baseEnv()).CODE_SANDBOX_PYTHON_IN_PROCESS).toBe("allow");
    expect(parseConfig(baseEnv({ CODE_SANDBOX_PYTHON_IN_PROCESS: "deny" })).CODE_SANDBOX_PYTHON_IN_PROCESS).toBe("deny");
    expect(() => parseConfig(baseEnv({ CODE_SANDBOX_PYTHON_IN_PROCESS: "sometimes" }))).toThrow(/CODE_SANDBOX_PYTHON_IN_PROCESS/);
    expect(parseConfig(baseEnv({ CODE_SANDBOX_PYTHON_UID: "" })).CODE_SANDBOX_PYTHON_UID).toBeUndefined();
    expect(parseConfig(baseEnv({ CODE_SANDBOX_PYTHON_UID: "65534", CODE_SANDBOX_PYTHON_GID: "65534" }))).toMatchObject({ CODE_SANDBOX_PYTHON_UID: 65534, CODE_SANDBOX_PYTHON_GID: 65534 });
    expect(() => parseConfig(baseEnv({ CODE_SANDBOX_PYTHON_UID: "nobody" }))).toThrow(/CODE_SANDBOX_PYTHON_UID/);
    expect(parseConfig(baseEnv()).EXPRESSION_MEMORY_MB).toBe(64);
    expect(() => parseConfig(baseEnv({ EXPRESSION_MEMORY_MB: "2" }))).toThrow(/EXPRESSION_MEMORY_MB/);
  });
});
