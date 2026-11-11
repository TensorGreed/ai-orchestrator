/**
 * 13.2 — key and gateway client rotation across two API instances on one Postgres database (each a full app with its
 * own store and pool, cluster mode): the same key or client rotated on both at once rotates once, and the keys and
 * tokens that come out of it work on both instances. Postgres only (skipped without TEST_POSTGRES_URL).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpClient, McpToolset } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("key rotation across API instances");

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

interface Instance {
  app: FastifyInstance;
  store: PostgresStore;
}

run("key rotation across two API instances", () => {
  let primary: TestStore | undefined;
  const instances: Instance[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const instance of instances.splice(0)) {
      await instance.app.close();
      await instance.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function start(count: number): Promise<Instance[]> {
    primary ??= await createTestStore({ kind: "postgres" });
    for (let i = 0; i < count; i += 1) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-key-rotation-"));
      tempDirs.push(tempDir);
      const store = await openTestStoreTwin(primary, { maxConnections: 6 });
      await store.ensureDefaultProject();
      const config = parseConfig({
        LOG_LEVEL: "warn",
        SEED_SAMPLE_WORKFLOWS: "false",
        SECRET_MASTER_KEY_BASE64: MASTER_KEY,
        COOKIE_SECURE: "false",
        RATE_LIMIT_ENABLED: "false",
        MCP_PROBE_INTERVAL_MS: "0",
        GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
        HA_INSTANCE_ID: `instance-${i}`,
        HA_ENABLED: "true",
        HA_RENEW_INTERVAL_MS: "100",
        CLUSTER_HEARTBEAT_MS: "200",
        CLUSTER_INSTANCE_TIMEOUT_MS: "1500",
        CLUSTER_CANCEL_CHECK_MS: "0"
      });
      const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), new AuthService(store, config.SESSION_TTL_HOURS));
      await app.ready();
      instances.push({ app, store });
    }
    return instances;
  }

  async function loginAs(instance: Instance, role: "admin" | "builder", name: string): Promise<string> {
    const email = `${name}@example.com`;
    const password = `${name}-Pass-123!`;
    if (!(await instance.store.getUserByEmail(email))) await new AuthService(instance.store, 24).register({ email, password, role });
    const login = await instance.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode).toBe(200);
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  const call = (instance: Instance, method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
    instance.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it("a personal key rotated on both instances at once rotates once; old and new keys work on both", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a!, "builder", "ana");
    for (let round = 0; round < 3; round += 1) {
      const created = (await call(a!, "POST", "/api/auth/api-keys", { cookie }, { name: `ci-${round}`, role: "operator" })).json<{ key: string; record: { id: string } }>();
      const results = await Promise.all([
        call(a!, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { cookie }, {}),
        call(b!, "POST", `/api/auth/api-keys/${created.record.id}/rotate`, { cookie }, {})
      ]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const loser = results.find((response) => response.statusCode === 409)!;
      expect(loser.json<{ code: string }>().code).toBe("already_rotated");
      const winner = results.find((response) => response.statusCode === 200)!.json<{ key: string; record: { scopes: string[] } }>();
      expect(winner.record.scopes).toEqual(["role:operator"]);
      for (const instance of [a!, b!]) {
        for (const key of [created.key, winner.key]) {
          const me = await call(instance, "GET", "/api/auth/me", { authorization: `Bearer ${key}` });
          expect(me.statusCode).toBe(200);
          expect(me.json<{ user: { role: string } }>().user.role).toBe("operator");
        }
      }
      const keys = (await a!.store.listApiKeys()).filter((key) => key.name === `ci-${round}`);
      expect(keys).toHaveLength(2);
    }
  });

  it("a gateway client rotated on both instances at once rotates once; old and new tokens work on both", async () => {
    const [a, b] = await start(2);
    const cookie = await loginAs(a!, "admin", "root");
    const toolset = (await call(a!, "POST", "/api/mcp/toolsets", { cookie }, { name: "Desk", members: [] })).json<{ toolset: McpToolset }>().toolset;
    const created = (await call(a!, "POST", "/api/mcp/clients", { cookie }, { name: "agent", toolsetIds: [toolset.id], role: "viewer" })).json<{ client: McpClient; token: string }>();
    const results = await Promise.all([
      call(a!, "POST", `/api/mcp/clients/${created.client.id}/rotate`, { cookie }, {}),
      call(b!, "POST", `/api/mcp/clients/${created.client.id}/rotate`, { cookie }, {})
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(["rotation_conflict", "rotation_pending"]).toContain(results.find((response) => response.statusCode === 409)!.json<{ code: string }>().code);
    const winner = results.find((response) => response.statusCode === 200)!.json<{ token: string; client: McpClient }>();
    expect(winner.client.previousTokenPrefix).toBe(created.client.tokenPrefix);
    for (const instance of [a!, b!]) {
      for (const token of [created.token, winner.token]) {
        const init = await instance.app.inject({
          method: "POST",
          url: `/mcp/${toolset.slug}`,
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
          payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
        });
        expect(init.statusCode).toBe(200);
      }
    }
  });
});
