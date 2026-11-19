/**
 * The node ids a workflow uses now or used in a stored version, so the editor gives a new node an id that run history,
 * approvals and replays of a removed node do not already name.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-node-ids-"));
  const store = await openTestStore(path.join(dir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, masterKey), authService);
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await authService.register({ email: "builder@example.com", password: "Builder-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "builder@example.com", password: "Builder-Pass-123!" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  return { app, cookie };
}

const node = (id: string, x = 0) => ({ id, type: "text_input", name: id, position: { x, y: 0 }, config: { text: "x" } });

describe("GET /api/workflows/:id/node-ids", () => {
  it("lists the ids of the current workflow and of every stored version, removed nodes included", async () => {
    const { app, cookie } = await boot();
    const base = { id: "wf-ids", name: "Ids", schemaVersion: "1.0.0", workflowVersion: 1, edges: [] };
    const created = await app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: { ...base, nodes: [node("fetch_items"), node("set_1", 300)] } });
    expect(created.statusCode).toBe(200);
    const updated = await app.inject({ method: "PUT", url: "/api/workflows/wf-ids", headers: { cookie }, payload: { ...base, nodes: [node("fetch_items"), node("http_request", 300)] } });
    expect(updated.statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/api/workflows/wf-ids/node-ids", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ nodeIds: ["fetch_items", "http_request", "set_1"] });
  });

  it("answers 404 for a workflow that does not exist, and 401 without a session", async () => {
    const { app, cookie } = await boot();
    expect((await app.inject({ method: "GET", url: "/api/workflows/nope/node-ids", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/workflows/nope/node-ids" })).statusCode).toBe(401);
  });
});
