/**
 * Phase 13.1 — a write that refers to a user or project that is gone. Postgres keeps foreign keys from sessions,
 * api_keys, mfa_secrets, sso_identities and user_project_roles; a violation (23503, reachable only when the parent is
 * deleted between a route's existence check and the write) is StoreReferenceMissingError, which the API answers with
 * 409 and a plain message instead of the database's text. SQLite enforces only the sessions key (the same error
 * there); for the others it never did and still writes the row.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { StoreReferenceMissingError } from "./db/store-errors.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind } from "./test-support/test-store.js";

const writes: Record<string, (store: Store) => Promise<unknown>> = {
  upsertProjectRole: (store) => store.upsertProjectRole({ userId: "ghost", projectId: "default", role: "viewer" }),
  upsertProjectRoleForMissingProject: async (store) => {
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "viewer" });
    return store.upsertProjectRole({ userId: "u1", projectId: "gone-project", role: "viewer" });
  },
  saveSession: (store) => store.saveSession({ id: "s1", userId: "ghost", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  saveApiKey: (store) => store.saveApiKey({ id: "k1", userId: "ghost", name: "k", keyPrefix: "pre", keyHash: "hash" }),
  upsertMfaSecret: (store) => store.upsertMfaSecret({ userId: "ghost", secretIv: "iv", secretAuthTag: "tag", secretCiphertext: "ct", backupCodes: [], enabled: false, activatedAt: null }),
  upsertSsoIdentity: (store) => store.upsertSsoIdentity({ id: "i1", userId: "ghost", provider: "saml", subject: "sub" })
};

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("store reference missing");

let current: TestStore | undefined;
afterEach(async () => {
  await current?.cleanup();
  current = undefined;
});

for (const kind of kinds) {
  describe(`a write referring to a missing user or project [${kind}]`, () => {
    for (const [name, write] of Object.entries(writes)) {
      // SQLite enforces only the sessions key (declared with the table it has always had).
      const enforced = kind === "postgres" || name === "saveSession";
      it(`${name}: ${enforced ? "StoreReferenceMissingError" : "written (SQLite never enforced the key)"}`, async () => {
        current = await createTestStore({ kind });
        await current.store.ensureDefaultProject();
        if (enforced) {
          const error = await write(current.store).then(() => undefined, (caught: unknown) => caught);
          expect(error).toBeInstanceOf(StoreReferenceMissingError);
          expect((error as StoreReferenceMissingError).statusCode).toBe(409);
          expect((error as Error).message).toBe("The user or project this change refers to no longer exists.");
        } else {
          await expect(write(current.store)).resolves.not.toThrow();
        }
      }, 60_000);
    }
  });
}

describe("POST /api/projects/:id/members when the user disappears before the write", () => {
  const dirs: string[] = [];
  const apps: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  /** An app whose store says the user exists, then fails the membership write the way `failure` says. */
  async function appWithFailingWrite(failure: () => Error) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-ref-missing-"));
    dirs.push(dir);
    const real = await SqliteStore.create(path.join(dir, "orchestrator.db"));
    await real.ensureDefaultProject();
    const store = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "upsertProjectRole") {
          return async (input: { userId: string }) => {
            if (input.userId === "ghost") throw failure();
            return target.upsertProjectRole(input as never);
          };
        }
        if (property === "getUserById") {
          return async (id: string) =>
            id === "ghost" ? { id, email: "ghost@example.com", role: "viewer", createdAt: "", updatedAt: "" } : target.getUserById(id);
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }) as unknown as Store;
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(dir, "sync")
    });
    const authService = new AuthService(store, config.SESSION_TTL_HOURS);
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
    await app.ready();
    apps.push(app);
    await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
    const setCookie = login.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : String(setCookie)).split(";")[0]!;
    const project = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { name: "Team" } });
    return { app, cookie, projectId: (project.json() as { id: string }).id };
  }

  it("answers 409 with a plain message for a missing-reference failure", async () => {
    const { app, cookie, projectId } = await appWithFailingWrite(() => new StoreReferenceMissingError());
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie }, payload: { userId: "ghost", role: "editor" } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "The user or project this change refers to no longer exists." });
  });

  it("does not return a database error's text (constraint names) to the client", async () => {
    const raw = () =>
      Object.assign(new Error('insert or update on table "user_project_roles" violates foreign key constraint "user_project_roles_user_id_fkey"'), { code: "23503" });
    const { app, cookie, projectId } = await appWithFailingWrite(raw);
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie }, payload: { userId: "ghost", role: "editor" } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("user_project_roles");
    expect(response.json()).toEqual({ error: "Internal server error" });
  });

  it("still answers 400 with the reason for a membership the RBAC service refuses", async () => {
    const { app, cookie, projectId } = await appWithFailingWrite(() => new StoreReferenceMissingError());
    const response = await app.inject({ method: "POST", url: `/api/projects/${projectId}/members`, headers: { cookie }, payload: { userId: "ghost", role: "custom" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "customRoleId is required when role is 'custom'" });
  });
});
