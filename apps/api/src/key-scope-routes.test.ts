/**
 * 13.2 — API keys limited to projects, route by route.
 *
 * A service account with the admin role holds a key limited to project `alpha` (so it acts as a builder there, in
 * `role` isolation, where a builder without a membership reaches every project). For every route such a key may call
 * (KEY_PROJECT_ROUTES), the table below has a row that aims the route at project `beta` and must be refused or
 * filtered, next to a check that the same route still works for `alpha` (so a broken key cannot pass the test).
 *
 * The table must name exactly the routes in KEY_PROJECT_ROUTES, and every other registered /api route must refuse the
 * key with the "limited to projects" answer, or be listed in NO_API_KEY_ROUTES (routes that never accept an API key).
 * A new route therefore fails this test until someone decides which side it is on: a route missed by the project check
 * fails here instead of failing open.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { KEY_PROJECT_ROUTES } from "./services/key-scopes.js";
import { QueueService } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";
import { openTestStore } from "./test-support/test-store.js";

const SCOPED_KEY_REFUSAL = "This API key is limited to projects and cannot call this route";

/**
 * Routes that never authenticate an API key (public, sign-in, session-only, or a trigger with its own credential): a
 * key limited to projects gets nothing from them that an anonymous caller would not. A trigger that can be set to
 * session auth (the chat trigger) checks it through requireRole, which refuses the key.
 */
const NO_API_KEY_ROUTES = new Set<string>([
  "GET /api/auth/oidc/callback",
  "GET /api/auth/oidc/login",
  "GET /api/auth/oidc/metadata",
  "GET /api/auth/saml/login",
  "GET /api/auth/saml/metadata",
  "GET /api/docs",
  "GET /api/forms/:path",
  "GET /api/mcp-server/:path/manifest",
  "GET /api/mcp/oauth/callback",
  "GET /api/openapi.json",
  "GET /api/workflows/import-shared",
  "POST /api/auth/break-glass",
  "POST /api/auth/invite/accept",
  "POST /api/auth/invite/lookup",
  "POST /api/auth/ldap/login",
  "POST /api/auth/login",
  "POST /api/auth/login/mfa",
  "POST /api/auth/logout",
  "POST /api/auth/saml/callback",
  "POST /api/chat/:workflowId",
  "POST /api/forms/:path",
  "POST /api/mcp-server/:path/invoke",
  "POST /api/webhooks/discord/:workflowId",
  "POST /api/webhooks/github/:workflowId",
  "POST /api/webhooks/slack/:workflowId",
  "POST /api/webhooks/stripe/:workflowId",
  "POST /api/webhooks/telegram/:workflowId"
]);

/** A valid body for routes that check their payload before the caller (so the sweep reaches the auth check). */
const SWEEP_PAYLOADS: Record<string, unknown> = {
  "POST /api/auth/register": { email: "someone@example.com", password: "Someone-Pass-123!" }
};

interface Ctx {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
  tempDir: string;
  adminCookie: string;
  key: string;
  approvalIds: { alpha: string; beta: string };
  /** Version numbers of the release workflows (v1, v2 each). */
  versions: Record<string, [number, number]>;
}

let ctx: Ctx;

function workflow(id: string, projectId: string, approval = false): Workflow {
  return {
    id,
    name: `Workflow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      ...(approval
        ? [{ id: "gate", type: "human_approval" as const, name: "Gate", position: { x: 200, y: 0 }, config: { approvalMessage: "ok?", timeoutMinutes: 60 } }]
        : []),
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: approval
      ? [
          { id: "e1", source: "start", target: "gate" },
          { id: "e2", source: "gate", target: "out" }
        ]
      : [{ id: "e1", source: "start", target: "out" }]
  };
}

async function saveRun(store: Store, id: string, workflowId: string, status = "error") {
  const now = new Date().toISOString();
  await store.saveExecutionHistory({ id, workflowId, status, startedAt: now, completedAt: status === "running" ? undefined : now, inputJson: {}, nodeResultsJson: [] });
}

const withKey = (method: string, url: string, payload?: unknown) =>
  ctx.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${ctx.key}` },
    ...(payload !== undefined ? { payload: payload as object } : {})
  });

const json = <T>(response: LightMyRequestResponse) => response.json<T>();

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-key-scope-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService, undefined, new QueueService(store, { pollIntervalMs: 20 }));
  await app.ready();

  await authService.register({ email: "admin@example.com", password: "Admin-Pass-123!", role: "admin" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "Admin-Pass-123!" } });
  const raw = login.headers["set-cookie"];
  const adminCookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;

  for (const id of ["alpha", "beta"]) await store.upsertProject({ id, name: id });
  await store.upsertWorkflow(workflow("wf-a", "alpha"));
  await store.upsertWorkflow(workflow("wf-b", "beta"));
  await store.upsertWorkflow(workflow("wf-gate-a", "alpha", true));
  await store.upsertWorkflow(workflow("wf-gate-b", "beta", true));
  await saveRun(store, "run-a", "wf-a");
  await saveRun(store, "run-b", "wf-b");
  await saveRun(store, "live-b", "wf-b", "running");

  const approvalIds = { alpha: "", beta: "" };
  for (const [project, id] of [["alpha", "wf-gate-a"], ["beta", "wf-gate-b"]] as const) {
    const run = json<{ status: string; executionId: string }>(await app.inject({ method: "POST", url: `/api/workflows/${id}/execute`, headers: { cookie: adminCookie }, payload: {} }));
    expect(run.status).toBe("waiting_approval");
    approvalIds[project] = run.executionId;
  }

  // Release workflows, each with two saved versions:
  //   wf-pub-*: nothing published;  wf-rel-*: v1 then v2 published (v2 live);
  //   wf-enf-a: as wf-rel-a, then a release gate turned on and enforced (no replay job has run).
  const versionService = new WorkflowVersionService(store);
  const versions: Record<string, [number, number]> = {};
  const adminCall = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as "GET", url, headers: { cookie: adminCookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  for (const [id, projectId] of [["wf-pub-a", "alpha"], ["wf-pub-b", "beta"], ["wf-rel-a", "alpha"], ["wf-rel-b", "beta"], ["wf-enf-a", "alpha"]] as const) {
    const saved: number[] = [];
    for (const name of ["one", "two"]) {
      const stored = await store.upsertWorkflow({ ...workflow(id, projectId), name: `${id} ${name}` });
      saved.push((await versionService.snapshot({ workflow: stored, changeNote: name })).version);
    }
    versions[id] = [saved[0]!, saved[1]!];
    if (id.startsWith("wf-pub-")) continue;
    for (const version of saved) {
      const published = await adminCall("POST", `/api/workflows/${id}/publish`, { version });
      expect(published.statusCode, published.body).toBe(200);
    }
  }
  await store.createEvalDataset({ id: "set-wf-enf-a", name: "Golden wf-enf-a", workflowId: "wf-enf-a" });
  const gate = await adminCall("PUT", "/api/workflows/wf-enf-a/release-gate", { enabled: true, enforced: true, datasetIds: ["set-wf-enf-a"] });
  expect(gate.statusCode, gate.body).toBe(200);

  // An admin service account, member of both projects, with a key limited to alpha.
  const account = await app.inject({ method: "POST", url: "/api/service-accounts", headers: { cookie: adminCookie }, payload: { name: "deployer", role: "admin" } });
  expect(account.statusCode).toBe(201);
  const accountId = json<{ serviceAccount: { id: string } }>(account).serviceAccount.id;
  for (const projectId of ["alpha", "beta"]) {
    await store.upsertProjectRole({ userId: accountId, projectId, role: "project_admin" });
  }
  const created = await app.inject({
    method: "POST",
    url: `/api/service-accounts/${accountId}/keys`,
    headers: { cookie: adminCookie },
    payload: { name: "ci", projects: ["alpha"] }
  });
  expect(created.statusCode).toBe(201);
  ctx = { app, store, config, tempDir, adminCookie, key: json<{ key: string }>(created).key, approvalIds, versions };
});

afterAll(async () => {
  await ctx.app.close();
  try {
    await ctx.store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
  fs.rmSync(ctx.tempDir, { recursive: true, force: true });
});

const refused = (response: LightMyRequestResponse) => {
  expect([403, 404], `${response.statusCode} ${response.body}`).toContain(response.statusCode);
};

const ok = (response: LightMyRequestResponse) => {
  expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
  expect(response.statusCode, response.body).toBeLessThan(300);
};

/** One row per route a key limited to projects may call: `beta` is refused or filtered out, `alpha` works. */
const ROUTE_TABLE: Record<string, () => Promise<void>> = {
  "GET /api/auth/me": async () => {
    const me = json<{ user: { role: string; projectScope: string[] }; memberships: Array<{ projectId: string }> }>(await withKey("GET", "/api/auth/me"));
    expect(me.user.role).toBe("builder");
    expect(me.user.projectScope).toEqual(["alpha"]);
    expect(me.memberships.map((m) => m.projectId)).toEqual(["alpha"]);
  },
  "GET /api/projects": async () => {
    const ids = json<{ projects: Array<{ id: string }> }>(await withKey("GET", "/api/projects")).projects.map((p) => p.id);
    expect(ids).toEqual(["alpha"]);
    const paged = json<{ items: Array<{ id: string }>; total: number }>(await withKey("GET", "/api/projects?page=1&pageSize=50"));
    expect(paged.items.map((p) => p.id)).toEqual(["alpha"]);
  },
  "GET /api/workflows": async () => {
    const ids = json<Array<{ id: string }>>(await withKey("GET", "/api/workflows")).map((w) => w.id).sort();
    expect(ids).toEqual(["wf-a", "wf-enf-a", "wf-gate-a", "wf-pub-a", "wf-rel-a"]);
    const paged = json<{ items: Array<{ id: string }>; total: number }>(await withKey("GET", "/api/workflows?page=1&pageSize=50"));
    expect(paged.total).toBe(5);
    expect(json<Array<{ id: string }>>(await withKey("GET", "/api/workflows?projectId=beta"))).toEqual([]);
  },
  "POST /api/workflows": async () => {
    refused(await withKey("POST", "/api/workflows", workflow("wf-new-b", "beta")));
    expect(await ctx.store.getWorkflow("wf-new-b")).toBeFalsy();
    refused(await withKey("POST", "/api/workflows", workflow("wf-new-default", "default")));
    ok(await withKey("POST", "/api/workflows", workflow("wf-new-a", "alpha")));
  },
  "GET /api/workflows/:id": async () => {
    refused(await withKey("GET", "/api/workflows/wf-b"));
    ok(await withKey("GET", "/api/workflows/wf-a"));
  },
  "PUT /api/workflows/:id": async () => {
    refused(await withKey("PUT", "/api/workflows/wf-b", { ...workflow("wf-b", "beta"), name: "changed" }));
    // Moving an alpha workflow into beta is refused too.
    refused(await withKey("PUT", "/api/workflows/wf-a", workflow("wf-a", "beta")));
    expect((await ctx.store.getWorkflow("wf-a"))?.projectId).toBe("alpha");
    ok(await withKey("PUT", "/api/workflows/wf-a", { ...workflow("wf-a", "alpha"), name: "renamed" }));
  },
  "POST /api/workflows/:id/execute": async () => {
    refused(await withKey("POST", "/api/workflows/wf-b/execute", {}));
    ok(await withKey("POST", "/api/workflows/wf-a/execute?channel=draft", {}));
  },
  "POST /api/workflows/:id/execute/stream": async () => {
    refused(await withKey("POST", "/api/workflows/wf-b/execute/stream", {}));
  },
  "POST /api/workflows/:id/publish": async () => {
    const [, pubB2] = ctx.versions["wf-pub-b"]!;
    refused(await withKey("POST", "/api/workflows/wf-pub-b/publish", { version: pubB2 }));
    expect(await ctx.store.getPublishedVersion("wf-pub-b")).toBeNull();
    // The key acts as a builder, though its owner is an admin: no override of the gate.
    const [enf1] = ctx.versions["wf-enf-a"]!;
    const override = await withKey("POST", "/api/workflows/wf-enf-a/publish", { version: enf1, override: { reason: "ship it" } });
    expect(override.statusCode, override.body).toBe(403);
    expect(json<{ error: string }>(override).error).toBe("Only admins can override the release gate");
    // A gated publish judges the replay jobs already run and starts none: with none, it is blocked.
    const runsBefore = (await ctx.store.listEvalRuns({ workflowId: "wf-enf-a" })).length;
    const gated = await withKey("POST", "/api/workflows/wf-enf-a/publish", { version: enf1 });
    expect(gated.statusCode, gated.body).toBe(409);
    expect((await ctx.store.listEvalRuns({ workflowId: "wf-enf-a" })).length).toBe(runsBefore);
    expect(await ctx.store.getPublishedVersion("wf-enf-a")).toBe(ctx.versions["wf-enf-a"]![1]);

    const [, pubA2] = ctx.versions["wf-pub-a"]!;
    const published = await withKey("POST", "/api/workflows/wf-pub-a/publish", { version: pubA2 });
    expect(published.statusCode, published.body).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-pub-a")).toBe(pubA2);
    const [entry] = (await ctx.store.listAuditLogs({ eventType: "release.published", resourceId: "wf-pub-a", pageSize: 5 })).items;
    expect(entry?.actorType).toBe("api_key");
    expect(entry?.metadata).toMatchObject({ actorServiceAccount: true });
    expect((entry?.metadata as { actorApiKeyId?: string }).actorApiKeyId).toBeTruthy();
  },
  "GET /api/workflows/:id/releases": async () => {
    refused(await withKey("GET", "/api/workflows/wf-rel-b/releases"));
    const view = json<{ releases: Array<{ version: number }>; publishedVersion: number }>(await withKey("GET", "/api/workflows/wf-rel-a/releases"));
    expect(view.releases.length).toBeGreaterThanOrEqual(2);
    expect(view.publishedVersion).toBe(ctx.versions["wf-rel-a"]![1]);
  },
  "GET /api/workflows/:id/release-state": async () => {
    refused(await withKey("GET", "/api/workflows/wf-rel-b/release-state"));
    const state = json<{ state: { publishedVersion: number; canPublish: boolean; canEditGate: boolean } }>(await withKey("GET", "/api/workflows/wf-rel-a/release-state")).state;
    expect(state.publishedVersion).toBe(ctx.versions["wf-rel-a"]![1]);
    expect(state.canPublish).toBe(true);
    // The key cannot call the gate settings route, so it is not offered.
    expect(state.canEditGate).toBe(false);
  },
  "GET /api/workflows/:id/publish-preview": async () => {
    refused(await withKey("GET", `/api/workflows/wf-rel-b/publish-preview?version=${ctx.versions["wf-rel-b"]![0]}`));
    const preview = json<{ preview: { version: number; verdict: string } }>(await withKey("GET", `/api/workflows/wf-enf-a/publish-preview?version=${ctx.versions["wf-enf-a"]![0]}`)).preview;
    expect(preview.version).toBe(ctx.versions["wf-enf-a"]![0]);
    expect(preview.verdict).toBe("blocked");
  },
  "POST /api/workflows/:id/rollback": async () => {
    const [relB1, relB2] = ctx.versions["wf-rel-b"]!;
    refused(await withKey("POST", "/api/workflows/wf-rel-b/rollback", { version: relB1, reason: "back" }));
    expect(await ctx.store.getPublishedVersion("wf-rel-b")).toBe(relB2);
    // On an enforced gate only an admin may roll back, and the key is capped at builder.
    const [enf1, enf2] = ctx.versions["wf-enf-a"]!;
    const enforced = await withKey("POST", "/api/workflows/wf-enf-a/rollback", { version: enf1, reason: "back" });
    expect(enforced.statusCode, enforced.body).toBe(403);
    expect(json<{ error: string }>(enforced).error).toMatch(/release gate is enforced: only an admin can roll back/);
    expect(await ctx.store.getPublishedVersion("wf-enf-a")).toBe(enf2);

    const [relA1] = ctx.versions["wf-rel-a"]!;
    ok(await withKey("POST", "/api/workflows/wf-rel-a/rollback", { version: relA1, reason: "back" }));
    expect(await ctx.store.getPublishedVersion("wf-rel-a")).toBe(relA1);
  },
  "GET /api/executions": async () => {
    const items = json<{ items: Array<{ workflowId: string }> }>(await withKey("GET", "/api/executions?pageSize=100")).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.workflowId.endsWith("-a") || item.workflowId === "wf-new-a")).toBe(true);
    expect(json<{ items: unknown[] }>(await withKey("GET", "/api/executions?workflowId=wf-b")).items).toEqual([]);
  },
  "GET /api/executions/:id": async () => {
    refused(await withKey("GET", "/api/executions/run-b"));
    ok(await withKey("GET", "/api/executions/run-a"));
  },
  "GET /api/executions/:id/events": async () => {
    refused(await withKey("GET", "/api/executions/run-b/events"));
  },
  "POST /api/executions/:id/retry": async () => {
    refused(await withKey("POST", "/api/executions/run-b/retry", {}));
  },
  "POST /api/executions/:id/cancel": async () => {
    refused(await withKey("POST", "/api/executions/live-b/cancel", {}));
    expect((await ctx.store.getExecutionHistory("live-b"))?.status).toBe("running");
  },
  "GET /api/approvals": async () => {
    const items = json<{ items: Array<{ workflowId: string }> }>(await withKey("GET", "/api/approvals")).items;
    expect(items.map((item) => item.workflowId)).toEqual(["wf-gate-a"]);
    refused(await withKey("GET", "/api/approvals?workflowId=wf-gate-b"));
    refused(await withKey("GET", `/api/approvals?executionId=${ctx.approvalIds.beta}`));
  },
  "POST /api/approvals/:id/approve": async () => {
    refused(await withKey("POST", `/api/approvals/${ctx.approvalIds.beta}/approve`, {}));
  },
  "POST /api/approvals/:id/reject": async () => {
    refused(await withKey("POST", `/api/approvals/${ctx.approvalIds.beta}/reject`, {}));
    expect(json<{ items: unknown[] }>(await ctx.app.inject({ method: "GET", url: "/api/approvals", headers: { cookie: ctx.adminCookie } })).items).toHaveLength(2);
  }
};

/** Every registered route as `METHOD /url`, from Fastify's route tree. */
function registeredRoutes(app: FastifyInstance): string[] {
  const tree = app.printRoutes({ commonPrefix: false });
  const routes: string[] = [];
  const stack: Array<{ depth: number; prefix: string }> = [];
  for (const line of tree.split("\n")) {
    const match = line.match(/^([\s│]*)(?:├──|└──)\s(.+?)\s\(([^)]+)\)\s*$/) ?? line.match(/^([\s│]*)(?:├──|└──)\s(.+?)\s*$/);
    if (!match) continue;
    const depth = match[1]!.length;
    const segment = match[2]!;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const full = (stack.length > 0 ? stack[stack.length - 1]!.prefix : "") + segment;
    stack.push({ depth, prefix: full });
    const methods = match[3];
    if (!methods) continue;
    for (const method of methods.split(",").map((m) => m.trim())) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      routes.push(`${method} ${full}`);
    }
  }
  return [...new Set(routes)];
}

describe("API keys limited to projects", () => {
  it("the route table covers exactly the routes such a key may call", () => {
    expect(Object.keys(ROUTE_TABLE).sort()).toEqual([...KEY_PROJECT_ROUTES].sort());
    const registered = new Set(registeredRoutes(ctx.app));
    for (const route of KEY_PROJECT_ROUTES) expect(registered.has(route), route).toBe(true);
  });

  for (const [route, check] of Object.entries(ROUTE_TABLE)) {
    it(`${route}: refuses or filters out the other project`, async () => {
      await check();
    });
  }

  it("every other /api route refuses the key, unless it never accepts API keys", async () => {
    const routes = registeredRoutes(ctx.app).filter((route) => route.split(" ")[1]!.startsWith("/api/"));
    expect(routes.length).toBeGreaterThan(200);
    const unexpected: string[] = [];
    for (const route of routes) {
      if (KEY_PROJECT_ROUTES.has(route) || NO_API_KEY_ROUTES.has(route)) continue;
      const [method, pattern] = route.split(" ") as [string, string];
      const url = pattern.replace(/:[A-Za-z_]+/g, "x").replace(/\*/g, "x");
      const response = await withKey(method, url, SWEEP_PAYLOADS[route] ?? (method === "GET" || method === "DELETE" ? undefined : {}));
      const body = response.headers["content-type"]?.toString().includes("json") ? (response.json() as { error?: string }) : {};
      if (response.statusCode !== 403 || body.error !== SCOPED_KEY_REFUSAL) unexpected.push(`${route} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
    }
    expect(unexpected).toEqual([]);
  });

  /**
   * Routes outside /api never call requireRole: each family is anonymous or takes its own credential, so an API key
   * is not a credential there at all. A new route outside /api fails this test until it is placed here (and, if it
   * calls requireRole, it belongs under /api and in the sweep above instead).
   */
  const OUTSIDE_API: Array<{ pattern: RegExp; why: string }> = [
    { pattern: /^(GET|POST|PUT|PATCH|DELETE) \/webhook(-test)?\/:path$/, why: "webhook triggers: anonymous, or the trigger's own token or HMAC" },
    { pattern: /^(GET|POST|DELETE) \/mcp\/:toolset$/, why: "the MCP gateway: MCP client credentials (a separate principal)" },
    { pattern: /^(GET|POST) \/v1\//, why: "the /v1 AI gateway: gateway client tokens (a separate principal)" },
    { pattern: /^GET \/(health|ready|metrics)$/, why: "probes and metrics: anonymous, limited by network controls" },
    { pattern: /^GET \/(widget\.js|helper-chat)$/, why: "the embeddable widget's static files: public" }
  ];

  it("every route outside /api is in a family that never takes an API key", () => {
    const outside = registeredRoutes(ctx.app).filter((route) => !route.split(" ")[1]!.startsWith("/api/"));
    expect(outside.length).toBeGreaterThan(0);
    const unplaced = outside.filter((route) => !OUTSIDE_API.some((family) => family.pattern.test(route)));
    expect(unplaced).toEqual([]);
    // Every family still matches a route, so the list does not go stale.
    for (const family of OUTSIDE_API) expect(outside.some((route) => family.pattern.test(route)), family.why).toBe(true);
  });

  it("a project-limited key is not a credential outside /api: it opens no MCP or /v1 gateway call", async () => {
    for (const [method, url] of [["POST", "/mcp/any-toolset"], ["GET", "/v1/models"], ["POST", "/v1/chat/completions"]] as const) {
      const response = await withKey(method, url, method === "POST" ? {} : undefined);
      expect(response.statusCode, `${method} ${url} -> ${response.body.slice(0, 120)}`).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }
  });

  it("the routes listed as never accepting API keys still exist", () => {
    const registered = new Set(registeredRoutes(ctx.app));
    for (const route of NO_API_KEY_ROUTES) expect(registered.has(route), route).toBe(true);
  });
});
