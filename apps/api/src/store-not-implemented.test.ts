/**
 * A store method the Postgres store does not implement yet throws
 * StoreNotImplementedError; a route that lets it reach the error handler
 * answers 501 with the method named, not a 500.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { StoreNotImplementedError } from "./db/store-errors.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

const opened: Array<{ app: FastifyInstance; store: SqliteStore; tempDir: string }> = [];

afterEach(async () => {
  for (const { app, store, tempDir } of opened.splice(0)) {
    await app.close();
    await store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function setup(): Promise<{ app: FastifyInstance; store: SqliteStore; authService: AuthService; config: AppConfig }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-store-501-"));
  const store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
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
  opened.push({ app, store, tempDir });
  return { app, store, authService, config };
}

describe("StoreNotImplementedError", () => {
  it("answers 501 naming the method instead of a 500", async () => {
    const { app, store, authService, config } = await setup();
    await authService.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
    const raw = login.headers["set-cookie"];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;

    vi.spyOn(store, "listWorkflows").mockRejectedValue(new StoreNotImplementedError("listWorkflows"));
    const response = await app.inject({ method: "GET", url: "/api/workflows", headers: { cookie } });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: "listWorkflows is not available on this store in this release." });
  });
});
