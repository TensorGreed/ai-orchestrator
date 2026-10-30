/**
 * Phase 12.4 — stored rule conditions that no longer parse, on both stores (Postgres when TEST_POSTGRES_URL is set).
 *
 * A manual or restored edit can leave `conditions_json` as text that is not JSON. It is treated exactly like
 * conditions that no longer validate: the rule is marked invalid in the store and the API, an allow never matches, a
 * deny or require_approval covers its whole scope, and saving another change cannot turn an invalid allow into a rule
 * without conditions. Only SQL NULL, an empty string and the JSON literal `null` mean "no conditions".
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { McpToolPolicyRule } from "@ai-orchestrator/shared";
import { evaluateMcpToolPolicy, type McpToolPolicyRequest } from "@ai-orchestrator/mcp-sdk";
import { createApp } from "../app.js";
import { parseConfig } from "../config.js";
import { AuthService } from "../services/auth-service.js";
import { SecretService } from "../services/secret-service.js";
import type { Store } from "./store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, type TestStoreKind, testStorePool } from "../test-support/test-store.js";
import { SqliteStore } from "./database.js";
import { mapMcpToolPolicyExtras } from "./store-shared.js";

const kinds: TestStoreKind[] = testPostgresUrl() ? ["sqlite", "postgres"] : ["sqlite"];
if (!testPostgresUrl()) noticePostgresSkipped("stored MCP policy conditions that no longer parse");

const call = (args: Record<string, unknown>): McpToolPolicyRequest => ({
  projectId: "default",
  role: "builder",
  adapterId: "mock-mcp",
  toolName: "calculator",
  arguments: args
});

function ruleInput(id: string, effect: McpToolPolicyRule["effect"], toolPattern: string): Parameters<Store["createMcpToolPolicy"]>[0] {
  return {
    id,
    name: id,
    description: null,
    effect,
    projectId: null,
    roles: [],
    serverId: null,
    toolPattern,
    conditions: { all: [{ path: "a", op: "equals", value: 1 }] },
    enabled: true
  };
}

describe("mapMcpToolPolicyExtras: what counts as no conditions", () => {
  it("only NULL, an empty string and JSON null; text that does not parse is invalid", () => {
    for (const none of [null, undefined, "", "null"]) {
      const mapped = mapMcpToolPolicyExtras({ id: "mtp_none", conditions_json: none });
      expect(mapped.conditions, String(none)).toBeNull();
      expect(mapped.invalid, String(none)).toBeUndefined();
    }
    for (const broken of ['{"all":[{"op":"equals"', "not json", "{", 42]) {
      expect(mapMcpToolPolicyExtras({ id: "mtp_broken", conditions_json: broken }), String(broken)).toMatchObject({ conditions: null, invalid: true });
    }
  });
});

for (const kind of kinds) {
  describe(`stored MCP policy conditions that no longer parse [${kind}]`, () => {
    let current: TestStore | undefined;
    let reopened: SqliteStore | undefined;
    let app: FastifyInstance | undefined;
    afterEach(async () => {
      await app?.close();
      app = undefined;
      await reopened?.close().catch(() => undefined);
      reopened = undefined;
      await current?.cleanup().catch(() => undefined);
      current = undefined;
    });

    /** Runs `sql` directly against the store's database (a manual or restored edit), then returns a usable store. */
    async function tamper(sql: string): Promise<Store> {
      const test = current!;
      if (test.kind === "postgres") {
        const pool = testStorePool(test);
        try {
          await pool.query(sql);
        } finally {
          await pool.end();
        }
        return test.store;
      }
      await test.store.close();
      const db = new Database(test.file!);
      db.exec(sql);
      db.close();
      reopened = await SqliteStore.create(test.file!);
      return reopened;
    }

    it("marks the rule invalid; an allow never matches and a deny covers its whole scope", async () => {
      current = await createTestStore({ kind });
      await current.store.createMcpToolPolicy({ ...ruleInput("mtp_deny_all", "deny", "*"), conditions: null });
      await current.store.createMcpToolPolicy(ruleInput("mtp_allow", "allow", "calculator"));
      await current.store.createMcpToolPolicy(ruleInput("mtp_deny", "deny", "other"));
      const store = await tamper(`UPDATE mcp_tool_policies SET conditions_json = '{"all":[{"op":"equals"' WHERE id IN ('mtp_allow', 'mtp_deny')`);

      const rules = await store.listMcpToolPolicies();
      const byId = new Map(rules.map((rule) => [rule.id, rule]));
      expect(byId.get("mtp_allow")).toMatchObject({ conditions: null, invalid: true });
      expect(byId.get("mtp_deny")).toMatchObject({ conditions: null, invalid: true });
      expect(byId.get("mtp_deny_all")!.invalid).toBeUndefined();
      expect(await store.getMcpToolPolicy("mtp_allow")).toMatchObject({ invalid: true });

      // The invalid allow carves nothing out of the deny, even when its old condition would have held.
      expect(evaluateMcpToolPolicy(rules, call({ a: 1 }))).toMatchObject({ allowed: false, rule: { id: "mtp_deny_all" } });
      // The invalid deny covers every call in its scope, whatever the arguments.
      const deny = byId.get("mtp_deny")!;
      expect(evaluateMcpToolPolicy([deny], { ...call({ a: 2 }), toolName: "other" })).toMatchObject({ allowed: false, rule: { id: "mtp_deny" } });
    });

    it("shows the rule as invalid in the API and keeps it failing closed through edits", async () => {
      current = await createTestStore({ kind });
      await current.store.createMcpToolPolicy(ruleInput("mtp_allow", "allow", "calculator"));
      const store = await tamper(`UPDATE mcp_tool_policies SET conditions_json = 'not json' WHERE id = 'mtp_allow'`);
      await store.ensureDefaultProject();
      const config = parseConfig({
        LOG_LEVEL: "warn",
        SEED_SAMPLE_WORKFLOWS: "false",
        SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
        COOKIE_SECURE: "false",
        RATE_LIMIT_ENABLED: "false",
        MCP_PROBE_INTERVAL_MS: "0"
      });
      const authService = new AuthService(store, config.SESSION_TTL_HOURS);
      app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
      await app.ready();
      await authService.register({ email: "admin@example.com", password: "admin-Pass-123!", role: "admin" });
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "admin-Pass-123!" } });
      const setCookie = login.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0];

      const listed = await app.inject({ method: "GET", url: "/api/mcp/policies", headers: { cookie } });
      expect(listed.json<{ rules: McpToolPolicyRule[] }>().rules.find((rule) => rule.id === "mtp_allow")).toMatchObject({ invalid: true, conditions: null });

      // Clearing the conditions of an invalid allow would allow every call in its scope: refused.
      const cleared = await app.inject({ method: "PUT", url: "/api/mcp/policies/mtp_allow", headers: { cookie }, payload: { conditions: null } });
      expect(cleared.statusCode).toBe(400);
      expect(cleared.json<{ error: string }>().error).toMatch(/stored conditions are invalid/);

      // Another change leaves the stored conditions alone: still invalid.
      const renamed = await app.inject({ method: "PUT", url: "/api/mcp/policies/mtp_allow", headers: { cookie }, payload: { name: "Renamed" } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json<{ rule: McpToolPolicyRule }>().rule).toMatchObject({ name: "Renamed", invalid: true });

      // New conditions fix it.
      const fixed = await app.inject({
        method: "PUT",
        url: "/api/mcp/policies/mtp_allow",
        headers: { cookie },
        payload: { conditions: { all: [{ path: "a", op: "equals", value: 1 }] } }
      });
      expect(fixed.statusCode).toBe(200);
      expect(fixed.json<{ rule: McpToolPolicyRule }>().rule.invalid).toBeUndefined();
    });
  });
}
