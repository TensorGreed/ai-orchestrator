/**
 * 13.2 — rotating personal API keys, service-account keys and gateway client tokens with a grace window.
 *
 * Runs on the store TEST_STORE names (SQLite by default, Postgres in the Postgres job). The two-instance races on one
 * Postgres database are in key-rotation-two-instance.test.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { McpClient, McpToolset } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface Ctx {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: Ctx[] = [];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function boot(env: Record<string, string> = {}): Promise<Ctx> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-key-rotation-"));
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
    ...env
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  await app.ready();
  const ctx = { app, store, authService, config, tempDir };
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (contexts.length > 0) {
    const ctx = contexts.pop()!;
    await ctx.app.close();
    try {
      await ctx.store.close();
    } catch {
      // Closed by the app.
    }
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  }
});

async function signIn(ctx: Ctx, email: string, role: "admin" | "builder" | "operator" | "viewer"): Promise<{ id: string; cookie: string }> {
  const password = "Rotate-Pass-123!";
  const user = await ctx.authService.register({ email, password, role });
  const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(login.statusCode).toBe(200);
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${ctx.config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  return { id: user.id, cookie };
}

const withCookie = (ctx: Ctx, cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const withKey = (ctx: Ctx, key: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: { authorization: `Bearer ${key}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

interface KeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  supersededBy: string | null;
  rotatedAt: string | null;
}

const body = <T>(response: LightMyRequestResponse) => response.json<T>();

async function createKey(ctx: Ctx, cookie: string, payload: Record<string, unknown>): Promise<{ key: string; record: KeyRecord }> {
  const response = await withCookie(ctx, cookie, "POST", "/api/auth/api-keys", payload);
  expect(response.statusCode).toBe(200);
  return body(response);
}

async function auditOf(ctx: Ctx, eventType: string) {
  return (await ctx.store.listAuditLogs({ eventType, pageSize: 50 })).items;
}

describe("personal API key rotation", () => {
  it("issues a new key with the same name and scope; both work for the grace window, the old one fails after it", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "ci", role: "operator" });
    const before = Date.now();
    const rotated = await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {});
    expect(rotated.statusCode).toBe(200);
    const result = body<{ key: string; record: KeyRecord; previous: KeyRecord }>(rotated);
    expect(result.key).not.toBe(created.key);
    expect(result.record).toMatchObject({ name: "ci", scopes: ["role:operator"], expiresAt: null, supersededBy: null });
    expect(result.previous).toMatchObject({ id: created.record.id, supersededBy: result.record.id });
    // Default grace: 24 hours.
    const graceEnd = Date.parse(result.previous.expiresAt!);
    expect(graceEnd).toBeGreaterThanOrEqual(before + DAY - 1000);
    expect(graceEnd).toBeLessThanOrEqual(Date.now() + DAY + 1000);
    expect(result.previous.rotatedAt).toBeTruthy();

    // Both keys work, with the same limit (operator ceiling).
    for (const key of [created.key, result.key]) {
      const me = await withKey(ctx, key, "GET", "/api/auth/me");
      expect(me.statusCode).toBe(200);
      expect(body<{ user: { role: string } }>(me).user.role).toBe("operator");
    }
    // After the window: the old key is refused, the new one still works.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + DAY + HOUR);
    expect((await withKey(ctx, created.key, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await withKey(ctx, result.key, "GET", "/api/auth/me")).statusCode).toBe(200);
    vi.restoreAllMocks();

    // Audited, with both key ids and the window; never the key.
    const [entry] = await auditOf(ctx, "api_key.rotate");
    expect(entry).toMatchObject({ resourceId: created.record.id, actorUserId: ana.id });
    expect(entry!.metadata).toMatchObject({ newKeyId: result.record.id, graceHours: 24, ownerKind: "human", previousKeyPrefix: created.record.keyPrefix });
    expect(JSON.stringify(entry)).not.toContain(result.key.split(".")[1]!);
  });

  it("graceHours 0 ends the old key at once; a rotated key cannot be rotated again; bad windows are refused", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "ci" });
    expect((await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { graceHours: 169 })).statusCode).toBe(400);
    expect((await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { graceHours: -1 })).statusCode).toBe(400);
    expect((await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { graceHours: 2, extra: true })).statusCode).toBe(400);
    const rotated = await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { graceHours: 0 });
    expect(rotated.statusCode).toBe(200);
    const result = body<{ key: string; record: KeyRecord }>(rotated);
    expect((await withKey(ctx, created.key, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await withKey(ctx, result.key, "GET", "/api/auth/me")).statusCode).toBe(200);

    const again = await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {});
    expect(again.statusCode).toBe(409);
    expect(body<{ code: string }>(again).code).toBe("already_rotated");
    // The replacement rotates as usual.
    expect((await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${result.record.id}/rotate`, {})).statusCode).toBe(200);
    // A revoked key is inactive.
    const other = await createKey(ctx, ana.cookie, { name: "old" });
    await withCookie(ctx, ana.cookie, "DELETE", `/api/auth/api-keys/${other.record.id}`);
    const revoked = await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${other.record.id}/rotate`, {});
    expect(revoked.statusCode).toBe(409);
    expect(body<{ code: string }>(revoked).code).toBe("inactive");
  });

  it("keeps the key's lifetime and limits: an expiring key gets the same lifetime, never a longer one", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "short", expiresInDays: 10, projects: ["default"] });
    const lifetime = Date.parse(created.record.expiresAt!) - Date.parse((await ctx.store.listApiKeys(ana.id))[0]!.createdAt);
    const rotated = body<{ record: KeyRecord & { createdAt: string } }>(
      await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { graceHours: 1 })
    );
    expect(rotated.record.scopes).toEqual(["project:default"]);
    const newLifetime = Date.parse(rotated.record.expiresAt!) - Date.parse(rotated.record.createdAt);
    expect(Math.abs(newLifetime - lifetime)).toBeLessThan(5000);
  });

  it("only the owner rotates a personal key: another user's key, even for an admin, reads as missing", async () => {
    const ctx = await boot();
    const admin = await signIn(ctx, "root@example.com", "admin");
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "ci" });
    expect((await withCookie(ctx, admin.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {})).statusCode).toBe(404);
    // A viewer cannot rotate at all (as for create).
    const viewer = await signIn(ctx, "vic@example.com", "viewer");
    expect((await withCookie(ctx, viewer.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {})).statusCode).toBe(403);
    expect((await withKey(ctx, created.key, "GET", "/api/auth/me")).statusCode).toBe(200);
  });

  it("a scoped key rotates only itself, and its replacement ends no later than it", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const scoped = await createKey(ctx, ana.cookie, { name: "scoped", role: "builder", expiresInDays: 3 });
    const other = await createKey(ctx, ana.cookie, { name: "other" });
    const refused = await withKey(ctx, scoped.key, "POST", `/api/auth/api-keys/${other.record.id}/rotate`, {});
    expect(refused.statusCode).toBe(403);
    const self = await withKey(ctx, scoped.key, "POST", `/api/auth/api-keys/${scoped.record.id}/rotate`, {});
    expect(self.statusCode).toBe(200);
    const result = body<{ key: string; record: KeyRecord }>(self);
    expect(result.record.scopes).toEqual(["role:builder"]);
    expect(Date.parse(result.record.expiresAt!)).toBeLessThanOrEqual(Date.parse(scoped.record.expiresAt!));
    const [entry] = await auditOf(ctx, "api_key.rotate");
    expect(entry!.metadata).toMatchObject({ rotatedWithApiKeyId: scoped.record.id });
  });

  it("step-up on: a session needs a fresh MFA check and a personal key is refused (D9)", async () => {
    const ctx = await boot({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const ana = await signIn(ctx, "ana@example.com", "builder");
    // Creating a key through the API is gated too, so the key is issued directly.
    const created = await ctx.app.inject({ method: "POST", url: "/api/auth/api-keys", headers: { cookie: ana.cookie }, payload: { name: "ci" } });
    expect(created.statusCode).toBe(403);
    const { ApiKeyService } = await import("./services/api-key-service.js");
    const issued = await new ApiKeyService(ctx.store).create({ userId: ana.id, name: "ci" });
    const bySession = await withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${issued.record.id}/rotate`, {});
    expect(bySession.statusCode).toBe(403);
    expect(body<{ code: string; stepUp: { action: string } }>(bySession)).toMatchObject({ code: "step_up_required", stepUp: { action: "api_key.rotate" } });
    const byKey = await withKey(ctx, issued.plaintext, "POST", `/api/auth/api-keys/${issued.record.id}/rotate`, {});
    expect(byKey.statusCode).toBe(403);
    expect(body<{ stepUp: { credential: string } }>(byKey).stepUp.credential).toBe("api_key");
    // Nothing was rotated.
    expect((await ctx.store.listApiKeys(ana.id)).map((key) => key.supersededBy)).toEqual([null]);
  });

  it("with nobody rotating nothing changes: keys list with supersededBy and rotatedAt null and verify as before", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "ci" });
    const listed = body<{ keys: KeyRecord[] }>(await withCookie(ctx, ana.cookie, "GET", "/api/auth/api-keys"));
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]).toMatchObject({ id: created.record.id, expiresAt: null, supersededBy: null, rotatedAt: null });
    expect((await withKey(ctx, created.key, "GET", "/api/auth/me")).statusCode).toBe(200);
  });

  it("two rotations of one key at once: exactly one succeeds", async () => {
    const ctx = await boot();
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const created = await createKey(ctx, ana.cookie, { name: "ci" });
    const results = await Promise.all([
      withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {}),
      withCookie(ctx, ana.cookie, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, {})
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect((await ctx.store.listApiKeys(ana.id)).filter((key) => !key.supersededBy)).toHaveLength(1);
  });
});

describe("service-account key rotation", () => {
  async function serviceAccount(ctx: Ctx, cookie: string) {
    const account = await withCookie(ctx, cookie, "POST", "/api/service-accounts", { name: "deployer", role: "operator" });
    expect(account.statusCode).toBe(201);
    return body<{ serviceAccount: { id: string } }>(account).serviceAccount.id;
  }

  it("an admin rotates a service account's key; scope and limits are kept, the old key works for the window", async () => {
    const ctx = await boot();
    const admin = await signIn(ctx, "root@example.com", "admin");
    const accountId = await serviceAccount(ctx, admin.cookie);
    const created = body<{ key: string; record: KeyRecord }>(
      await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${accountId}/keys`, { name: "ci", projects: ["default"] })
    );
    const rotated = await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${accountId}/keys/${created.record.id}/rotate`, { graceHours: 2 });
    expect(rotated.statusCode).toBe(200);
    const result = body<{ key: string; record: KeyRecord; previous: KeyRecord }>(rotated);
    expect(result.record).toMatchObject({ name: "ci", scopes: ["project:default"] });
    expect(Date.parse(result.previous.expiresAt!) - Date.now()).toBeLessThanOrEqual(2 * HOUR + 1000);
    for (const key of [created.key, result.key]) {
      const me = await withKey(ctx, key, "GET", "/api/auth/me");
      expect(me.statusCode).toBe(200);
      expect(body<{ user: { role: string } }>(me).user.role).toBe("operator");
    }
    const [entry] = await auditOf(ctx, "api_key.rotate");
    expect(entry!.metadata).toMatchObject({ ownerKind: "service", serviceAccountId: accountId, graceHours: 2 });
    // The account's own key cannot rotate through the personal route.
    expect((await withKey(ctx, result.key, "POST", `/api/auth/api-keys/${result.record.id}/rotate`, {})).statusCode).toBe(403);
    // A key of another account (or a person) reads as missing under this account.
    const ana = await signIn(ctx, "ana@example.com", "builder");
    const personal = await createKey(ctx, ana.cookie, { name: "mine" });
    expect((await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${accountId}/keys/${personal.record.id}/rotate`, {})).statusCode).toBe(404);
    expect((await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${ana.id}/keys/${personal.record.id}/rotate`, {})).statusCode).toBe(404);
  });

  it("SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS caps new and rotated keys; unset leaves keys without expiry", async () => {
    const ctx = await boot({ SERVICE_ACCOUNT_KEY_MAX_AGE_DAYS: "30" });
    const admin = await signIn(ctx, "root@example.com", "admin");
    const accountId = await serviceAccount(ctx, admin.cookie);
    const created = body<{ key: string; record: KeyRecord }>(
      await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${accountId}/keys`, { name: "ci", expiresInDays: 365 })
    );
    expect(Math.abs(Date.parse(created.record.expiresAt!) - (Date.now() + 30 * DAY))).toBeLessThan(10_000);
    const rotated = body<{ record: KeyRecord }>(
      await withCookie(ctx, admin.cookie, "POST", `/api/service-accounts/${accountId}/keys/${created.record.id}/rotate`, {})
    );
    expect(Date.parse(rotated.record.expiresAt!)).toBeLessThanOrEqual(Date.now() + 30 * DAY + 10_000);
    // Personal keys are not affected.
    const personal = await createKey(ctx, admin.cookie, { name: "mine" });
    expect(personal.record.expiresAt).toBeNull();

    const plain = await boot();
    const root = await signIn(plain, "root@example.com", "admin");
    const other = await serviceAccount(plain, root.cookie);
    const unlimited = body<{ record: KeyRecord }>(await withCookie(plain, root.cookie, "POST", `/api/service-accounts/${other}/keys`, { name: "ci" }));
    expect(unlimited.record.expiresAt).toBeNull();
  });
});

describe("gateway client rotation", () => {
  async function fixture(ctx: Ctx) {
    const admin = await signIn(ctx, "root@example.com", "admin");
    const toolset = body<{ toolset: McpToolset }>(await withCookie(ctx, admin.cookie, "POST", "/api/mcp/toolsets", { name: "Desk", members: [] })).toolset;
    const created = body<{ client: McpClient; token: string }>(
      await withCookie(ctx, admin.cookie, "POST", "/api/mcp/clients", { name: "agent", toolsetIds: [toolset.id], role: "viewer" })
    );
    return { admin, toolset, client: created.client, token: created.token };
  }

  const initialize = (ctx: Ctx, slug: string, token: string, sessionId?: string) =>
    ctx.app.inject({
      method: "POST",
      url: `/mcp/${slug}`,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      },
      payload: JSON.stringify(
        sessionId
          ? { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
          : { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }
      )
    });

  it("issues a new token; both work in the window, a live session survives, the old token fails after it", async () => {
    const ctx = await boot();
    const { admin, toolset, client, token } = await fixture(ctx);
    const opened = await initialize(ctx, toolset.slug, token);
    expect(opened.statusCode).toBe(200);
    const sessionId = opened.headers["mcp-session-id"] as string;

    const rotated = await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, { graceHours: 1 });
    expect(rotated.statusCode).toBe(200);
    const result = body<{ client: McpClient & { status: string; activeSessions: number }; token: string }>(rotated);
    expect(result.token).not.toBe(token);
    expect(result.client).toMatchObject({ id: client.id, name: "agent", role: "viewer", toolsetIds: [toolset.id], previousTokenPrefix: client.tokenPrefix, status: "active", activeSessions: 1 });
    expect(result.client).not.toHaveProperty("previousTokenHash");
    expect(result.client).not.toHaveProperty("tokenHash");

    // The open session keeps working with either token; a new session opens with either.
    expect((await initialize(ctx, toolset.slug, token, sessionId)).statusCode).toBe(200);
    expect((await initialize(ctx, toolset.slug, result.token, sessionId)).statusCode).toBe(200);
    expect((await initialize(ctx, toolset.slug, token)).statusCode).toBe(200);
    expect((await initialize(ctx, toolset.slug, result.token)).statusCode).toBe(200);
    // A wrong secret on the old prefix is refused.
    expect((await initialize(ctx, toolset.slug, `${client.tokenPrefix}.wrong`)).statusCode).toBe(401);

    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * HOUR);
    const late = await initialize(ctx, toolset.slug, token);
    expect(late.statusCode).toBe(401);
    expect(late.body).toContain("expired");
    vi.restoreAllMocks();
    expect((await initialize(ctx, toolset.slug, result.token)).statusCode).toBe(200);

    const [entry] = await auditOf(ctx, "mcp_client.rotated");
    expect(entry!.metadata).toMatchObject({ previousTokenPrefix: client.tokenPrefix, tokenPrefix: result.client.tokenPrefix, graceHours: 1 });
  });

  it("graceHours 0 ends the old token at once; a second rotation in the window needs graceHours 0; revoked clients and builders are refused", async () => {
    const ctx = await boot();
    const { admin, toolset, client, token } = await fixture(ctx);
    const first = body<{ token: string; client: McpClient }>(await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {}));
    expect((await initialize(ctx, toolset.slug, token)).statusCode).toBe(200);
    // A second click while the old token is in its window is refused: it would cut that token off without warning.
    const pending = await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {});
    expect(pending.statusCode).toBe(409);
    expect(body<{ code: string }>(pending).code).toBe("rotation_pending");
    expect((await initialize(ctx, toolset.slug, token)).statusCode).toBe(200);
    const second = body<{ token: string; client: McpClient }>(await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, { graceHours: 0 }));
    expect(second.client.previousTokenPrefix).toBeNull();
    expect((await initialize(ctx, toolset.slug, token)).statusCode).toBe(401);
    expect((await initialize(ctx, toolset.slug, first.token)).statusCode).toBe(401);
    expect((await initialize(ctx, toolset.slug, second.token)).statusCode).toBe(200);

    const builder = await signIn(ctx, "bob@example.com", "builder");
    expect((await withCookie(ctx, builder.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {})).statusCode).toBe(403);
    expect((await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/mcc_missing/rotate`, {})).statusCode).toBe(404);
    await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/revoke`);
    const revoked = await withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {});
    expect(revoked.statusCode).toBe(409);
    expect(body<{ code: string }>(revoked).code).toBe("inactive");
  });

  it("two rotations of one client at once: exactly one applies and its token works", async () => {
    const ctx = await boot();
    const { admin, toolset, client, token } = await fixture(ctx);
    const results = await Promise.all([
      withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {}),
      withCookie(ctx, admin.cookie, "POST", `/api/mcp/clients/${client.id}/rotate`, {})
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winner = body<{ token: string }>(results.find((response) => response.statusCode === 200)!);
    expect((await initialize(ctx, toolset.slug, winner.token)).statusCode).toBe(200);
    expect((await initialize(ctx, toolset.slug, token)).statusCode).toBe(200);
  });
});
