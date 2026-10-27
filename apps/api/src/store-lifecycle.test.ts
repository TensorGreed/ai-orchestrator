/**
 * The app's use of the Store interface around its lifecycle: shutdown waits for the store to close.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { SqliteStore } from "./db/database.js";
import { AuthService } from "./services/auth-service.js";
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
});
