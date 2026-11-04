/**
 * 12.6b — the /v1 AI gateway across two in-process replicas on one Postgres database in cluster mode (HA_ENABLED):
 * a client's per-minute rate is counted in the shared buckets, and each replica sees the other's usage rows in
 * budget checks. The upstream is an in-process OpenAI-compatible server on 127.0.0.1. Postgres only (skipped without
 * TEST_POSTGRES_URL).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AiGatewayRouteSet, McpClient } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig } from "./config.js";
import type { PostgresStore } from "./db/postgres-store.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, type TestStore } from "./test-support/test-store.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("the /v1 AI gateway across replicas");

const PRICING = JSON.stringify({ openai_compatible: { "up-model": { inputUsdPer1M: 1_000_000, outputUsdPer1M: 1_000_000 } } });

interface Replica {
  app: FastifyInstance;
  store: PostgresStore;
}

run("/v1 AI gateway across replicas on one Postgres database", () => {
  let primary: TestStore | undefined;
  const replicas: Replica[] = [];
  const tempDirs: string[] = [];
  const masterKey = crypto.randomBytes(32).toString("base64");
  let upstream: http.Server | undefined;

  afterEach(async () => {
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream!.close(resolve));
      upstream = undefined;
    }
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  async function startUpstream(): Promise<string> {
    upstream = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "up",
            object: "chat.completion",
            created: 1,
            model: "up-model",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
          })
        );
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  }

  async function addReplica(name: string): Promise<Replica> {
    primary ??= await createTestStore({ kind: "postgres" });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-aigw-cluster-"));
    tempDirs.push(tempDir);
    const store = await openTestStoreTwin(primary, { maxConnections: 8 });
    const config = parseConfig({
      LOG_LEVEL: "error",
      SEED_SAMPLE_WORKFLOWS: "false",
      SECRET_MASTER_KEY_BASE64: masterKey,
      COOKIE_SECURE: "false",
      RATE_LIMIT_ENABLED: "false",
      MCP_PROBE_INTERVAL_MS: "0",
      GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
      DB_TYPE: "postgres",
      DB_POSTGRESDB_HOST: "unused-the-store-is-passed-in",
      HA_ENABLED: "true",
      HA_INSTANCE_ID: name,
      HA_RENEW_INTERVAL_MS: "100",
      CLUSTER_HEARTBEAT_MS: "200",
      CLUSTER_INSTANCE_TIMEOUT_MS: "5000",
      LLM_PRICING_OVERRIDES_JSON: PRICING
    });
    const app = await createApp(
      config,
      store,
      new SecretService(store, config.SECRET_MASTER_KEY_BASE64),
      new AuthService(store, config.SESSION_TTL_HOURS),
      undefined,
      undefined,
      undefined,
      { lifecycle: new AppLifecycle() }
    );
    await app.ready();
    const replica = { app, store };
    replicas.push(replica);
    return replica;
  }

  async function adminCookie(replica: Replica): Promise<string> {
    if (!(await replica.store.getUserByEmail("admin@example.com"))) {
      await new AuthService(replica.store, 24).register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
    }
    const login = await replica.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
    return String([login.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  }

  async function setup(a: Replica, setInput: Record<string, unknown>) {
    const admin = await adminCookie(a);
    const baseUrl = await startUpstream();
    const call = async <T>(method: "POST" | "PUT", url: string, payload: unknown) => {
      const response = await a.app.inject({ method, url, headers: { cookie: admin }, payload: payload as object });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json<T>();
    };
    const set = await call<AiGatewayRouteSet>("POST", "/api/ai-gateway/route-sets", { name: "Apps", projectId: "default", ...setInput });
    await call("POST", `/api/ai-gateway/route-sets/${set.id}/routes`, { alias: "gpt-test", providerId: "openai_compatible", model: "up-model", baseUrl });
    const { client, token } = await call<{ client: McpClient; token: string }>("POST", "/api/mcp/clients", { name: "App", toolsetIds: [], role: "builder" });
    await call("PUT", `/api/ai-gateway/clients/${client.id}/grants`, { routeSetIds: [set.id] });
    return { admin, set, client, token, call };
  }

  const chat = (replica: Replica, token: string) =>
    replica.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] })
    });

  it("counts a client's per-minute rate across replicas in the shared buckets", async () => {
    const a = await addReplica("aigw-a");
    const b = await addReplica("aigw-b");
    const { token } = await setup(a, { rateLimit: { requestsPerMinute: 3 } });
    expect((await chat(a, token)).statusCode).toBe(200);
    expect((await chat(b, token)).statusCode).toBe(200);
    expect((await chat(a, token)).statusCode).toBe(200);
    const limited = await chat(b, token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string } }>().error.code).toBe("rate_limit_exceeded");
    expect((await chat(a, token)).statusCode).toBe(429);
    const rows = await a.store.listAiGatewayRequests({ from: "1970-01-01T00:00:00.000Z", limit: 10 });
    expect(rows).toHaveLength(3);
  });

  it("refuses on one replica once requests through the other used up the client's budget", async () => {
    const a = await addReplica("aigw-c");
    const b = await addReplica("aigw-d");
    const { client, call } = await setup(a, {});
    const { token } = await (async () => {
      const created = await call<{ client: McpClient; token: string }>("POST", "/api/mcp/clients", { name: "Budgeted", toolsetIds: [], role: "builder" });
      await call("PUT", `/api/ai-gateway/clients/${created.client.id}/grants`, { routeSetIds: (await a.store.listAiGatewayClientGrants(client.id)) });
      await call("POST", "/api/budgets", { name: "Cap", scopeType: "mcp_client", scopeId: created.client.id, period: "day", limitType: "tokens", limitValue: 3, action: "block" });
      return created;
    })();
    expect((await chat(a, token)).statusCode).toBe(200);
    // B reads the budget within its snapshot refresh and counts A's request row.
    const deadline = Date.now() + 10_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await chat(b, token)).statusCode;
      if (status === 429) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe(429);
  });
});
