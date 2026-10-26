/**
 * The app's use of the Store interface around its lifecycle: shutdown waits for the store to close, and a feature
 * that turns itself off without a store method asks `storeImplements` (a Postgres stub would throw).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { PostgresStore } from "./db/postgres-store.js";
import { rethrowStoreNotImplemented, StoreNotImplementedError } from "./db/store-errors.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
import { SecretService } from "./services/secret-service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("store lifecycle", () => {
  it("app shutdown waits for the store's close to finish", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-store-close-"));
    dirs.push(dir);
    const store = await SqliteStore.create(path.join(dir, "orchestrator.db"));
    await store.ensureDefaultProject();
    const close = store.close.bind(store);
    let closed = false;
    store.close = async () => {
      // A pooled store ends its connections asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await close();
      closed = true;
    };
    const config = parseConfig({
      LOG_LEVEL: "warn",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(dir, "sync")
    });
    const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
    await app.ready();
    await app.close();
    expect(closed).toBe(true);
  });

  it("the deployment's destination rules profile is off on a store without guard profiles, not an error", async () => {
    let asked = 0;
    // A Postgres store that has not reached parity: getGuardProfile is one of its stubs.
    const store = Object.create(PostgresStore.prototype) as Store;
    Object.defineProperty(store, "getGuardProfile", {
      value: async () => {
        asked += 1;
        throw new Error("getGuardProfile is not available on this store in this release.");
      }
    });
    expect(PostgresStore.unimplemented.has("getGuardProfile")).toBe(true);
    const guard = new GuardService(store, {} as SecretService, { autoApply: false });
    await expect(guard.deploymentProfile()).resolves.toBeUndefined();
    expect(asked).toBe(0);
  });

  it("a route whose own catch maps errors to 400 still answers 501 for a store method the store does not implement", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-store-501-"));
    dirs.push(dir);
    const store = await SqliteStore.create(path.join(dir, "orchestrator.db"));
    await store.ensureDefaultProject();
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
    try {
      await authService.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
      const raw = login.headers["set-cookie"];
      const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
      await store.upsertWorkflow({ id: "wf-501", name: "501", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never);

      store.upsertVariable = async () => {
        throw new StoreNotImplementedError("upsertVariable");
      };
      store.deleteWorkflow = async () => {
        throw new StoreNotImplementedError("deleteWorkflow");
      };
      const variable = await app.inject({ method: "POST", url: "/api/variables", headers: { cookie }, payload: { projectId: "default", key: "REGION", value: "eu" } });
      expect(variable.statusCode, variable.body).toBe(501);
      expect(variable.json<{ error: string }>().error).toBe("upsertVariable is not available on this store in this release.");
      const deleted = await app.inject({ method: "DELETE", url: "/api/workflows/wf-501", headers: { cookie } });
      expect(deleted.statusCode, deleted.body).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("rethrowStoreNotImplemented passes every other error on to the route's own handling", () => {
    expect(() => rethrowStoreNotImplemented(new Error("bad input"))).not.toThrow();
    expect(() => rethrowStoreNotImplemented("text")).not.toThrow();
    expect(() => rethrowStoreNotImplemented(new StoreNotImplementedError("x"))).toThrow(StoreNotImplementedError);
  });
});
