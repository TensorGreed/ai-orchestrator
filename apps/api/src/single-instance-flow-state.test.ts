/**
 * Phase 13.1 — outside cluster mode (SQLite, or Postgres with HA_ENABLED off; TEST_STORE picks the store) the shared
 * flow state stays out of the way: a sign-in's TOTP step lives in memory (no pending_challenges row), the session
 * cleanup prunes nothing new, community-node installs are not refused for being in a cluster, and /health does not
 * warn about X-Forwarded-For.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { AuthService } from "./services/auth-service.js";
import { challengeIdHash } from "./services/challenge-store.js";
import { generateTotpCode } from "./services/mfa-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, type TestStore } from "./test-support/test-store.js";

describe("shared flow state outside cluster mode", () => {
  let testStore: TestStore | undefined;
  let app: FastifyInstance | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await testStore?.cleanup();
    testStore = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function boot(overrides: Record<string, string> = {}) {
    testStore = await createTestStore();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-single-"));
    tempDirs.push(tempDir);
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      ...overrides
    });
    const store = testStore.store;
    app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
    await app.ready();
    return { app, store, tempDir };
  }

  it("keeps a sign-in's TOTP step in memory, single use", async () => {
    const { app, store } = await boot();
    await new AuthService(store, 24).register({ email: "solo@example.com", password: "solo-Pass-123!", role: "admin" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "solo@example.com", password: "solo-Pass-123!" } });
    const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
    const { secret } = (await app.inject({ method: "POST", url: "/api/auth/mfa/enroll", headers: { cookie } })).json<{ secret: string }>();
    expect((await app.inject({ method: "POST", url: "/api/auth/mfa/activate", headers: { cookie }, payload: { code: generateTotpCode(secret) } })).statusCode).toBe(200);

    const challenged = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "solo@example.com", password: "solo-Pass-123!" } });
    const challenge = challenged.json<{ mfaChallenge: string }>().mfaChallenge;
    // Nothing in the database: the challenge store is the in-process one.
    expect(await store.consumePendingChallenge({ idHash: challengeIdHash(challenge), kind: "mfa_login" })).toBeNull();
    expect((await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge, code: generateTotpCode(secret) } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { challenge, code: generateTotpCode(secret) } })).statusCode).toBe(401);
  });

  it("does not refuse community-node installs for being in a cluster, and lists installs as allowed", async () => {
    const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-single-community-"));
    tempDirs.push(pluginsDir);
    const { app, store } = await boot({ COMMUNITY_NODES_ENABLED: "true", COMMUNITY_NODES_DIR: pluginsDir, COMMUNITY_NODES_ALLOWLIST: "l2m-nodes-other" });
    await new AuthService(store, 24).register({ email: "solo-admin@example.com", password: "solo-Pass-123!", role: "admin" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "solo-admin@example.com", password: "solo-Pass-123!" } });
    const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
    // Not in the allowlist: refused for that reason (before any npm call), as before, never with the cluster-mode 409.
    const install = await app.inject({ method: "POST", url: "/api/community-nodes/install", headers: { cookie }, payload: { packageSpec: "l2m-nodes-example" } });
    expect(install.statusCode).toBe(400);
    expect(install.json<{ error: string }>().error).toContain("ALLOWLIST");
    expect((await app.inject({ method: "GET", url: "/api/community-nodes", headers: { cookie } })).json<{ installAllowed: boolean }>().installAllowed).toBe(true);
  });

  it("does not warn about X-Forwarded-For", async () => {
    const { app } = await boot();
    await app.inject({ method: "GET", url: "/health", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect((await app.inject({ method: "GET", url: "/health" })).json<{ warnings?: unknown }>().warnings).toBeUndefined();
  });
});
