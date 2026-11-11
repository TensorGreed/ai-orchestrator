/**
 * 13.3 R1 — `GET`/`PUT /api/projects/:id/retention` in the app: who may read and change a project's values (admins and
 * the project's admins change; members read; strict isolation hides the project from others), the deployment's bounds,
 * step-up, the audit entry, the purge applying the new value, and the Security page marking a rule event whose run was
 * deleted. Runs against the store TEST_STORE names (SQLite by default; the Postgres suite runs it again).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ProjectRetentionView, RetentionAdminView } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService, type SafeUser, type UserRole } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

async function createTestContext(env: Record<string, string> = {}, prepare?: (store: Store) => Promise<void>): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-project-retention-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  await store.upsertProject({ id: "proj-a", name: "Project A", createdBy: "ana" });
  await store.upsertWorkflow({ id: "wf-a", name: "wf-a", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "proj-a" } as never);
  await prepare?.(store);
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync"),
    ...env
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, secretService, authService);
  await app.ready();
  const context: TestContext = { app, store, authService, config, tempDir };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
});

async function login(context: TestContext, role: UserRole): Promise<{ cookie: string; user: SafeUser }> {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const password = `${role}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, user };
}

async function addMember(context: TestContext, admin: string, userId: string, role: "project_admin" | "editor" | "viewer"): Promise<void> {
  const response = await context.app.inject({ method: "POST", url: "/api/projects/proj-a/members", headers: { cookie: admin }, payload: { userId, role } });
  expect(response.statusCode, response.body).toBe(200);
}

const get = (context: TestContext, cookie: string, project = "proj-a") =>
  context.app.inject({ method: "GET", url: `/api/projects/${project}/retention`, headers: { cookie } });
const put = (context: TestContext, cookie: string, classes: Record<string, number | null>, project = "proj-a") =>
  context.app.inject({ method: "PUT", url: `/api/projects/${project}/retention`, headers: { cookie }, payload: { classes } });

describe("per-project retention routes", () => {
  it("an admin sets and clears values; the view shows what is inherited and the change is audited", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const initial = (await get(context, admin.cookie)).json<ProjectRetentionView>();
    expect(initial).toMatchObject({ projectId: "proj-a", canEdit: true, bounds: { minDays: 1, maxDays: null } });
    expect(initial.classes.map((entry) => [entry.class, entry.days, entry.effectiveDays])).toEqual([
      ["runs", null, 30],
      ["tool_calls", null, 30],
      ["rule_events", null, 30],
      ["agent_memory", null, 0]
    ]);
    expect(initial.exemptions).toMatch(/Golden runs/);

    const saved = await put(context, admin.cookie, { runs: 7, rule_events: 400 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<ProjectRetentionView>().classes.filter((entry) => entry.days !== null).map((entry) => [entry.class, entry.days])).toEqual([
      ["runs", 7],
      ["rule_events", 400]
    ]);
    const cleared = await put(context, admin.cookie, { runs: null, agent_memory: 0 });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await context.store.listRetentionPolicies({ scopeId: "proj-a" })).map((policy) => [policy.dataClass, policy.days])).toEqual([
      ["agent_memory", 0],
      ["rule_events", 400]
    ]);

    const audits = await testSql(context.store).all<{ metadata_json: string; project_id: string }>(
      `SELECT metadata_json, project_id FROM audit_logs WHERE event_type = 'project.retention.update' ORDER BY created_at, id`
    );
    expect(audits).toHaveLength(2);
    // Rows written in the same millisecond order by their random ids: compare without the order.
    expect(audits.map((row) => JSON.parse(row.metadata_json))).toEqual(
      expect.arrayContaining([
        { before: {}, after: { runs: 7, rule_events: 400 } },
        { before: { runs: 7, rule_events: 400 }, after: { runs: null, agent_memory: 0 } }
      ])
    );
    expect(audits.every((row) => row.project_id === "proj-a")).toBe(true);

    // The admin page lists the project.
    const adminView = (await context.app.inject({ method: "GET", url: "/api/admin/retention", headers: { cookie: admin.cookie } })).json<RetentionAdminView>();
    expect(adminView.projectOverrides).toEqual([{ projectId: "proj-a", projectName: "Project A", classes: { agent_memory: 0, rule_events: 400 } }]);
  });

  it("refuses values outside the deployment's bounds, keep-forever under a maximum, and malformed bodies", async () => {
    const context = await createTestContext({ RETENTION_MIN_DAYS: "7", RETENTION_MAX_DAYS: "365" });
    const admin = await login(context, "admin");
    for (const classes of [{ runs: 3 }, { tool_calls: 400 }, { agent_memory: 0 }] as Array<Record<string, number>>) {
      const response = await put(context, admin.cookie, classes);
      expect(response.statusCode, JSON.stringify(classes)).toBe(400);
      expect(response.json()).toMatchObject({ code: "retention_out_of_bounds", bounds: { minDays: 7, maxDays: 365 } });
    }
    for (const body of [{ classes: { usage: 30 } }, { classes: { runs: 1.5 } }, { classes: { runs: -1 } }, { runs: 30 }]) {
      const response = await context.app.inject({ method: "PUT", url: "/api/projects/proj-a/retention", headers: { cookie: admin.cookie }, payload: body });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await context.store.listRetentionPolicies()).toEqual([]);
    expect((await put(context, admin.cookie, { runs: 7, tool_calls: 365 })).statusCode).toBe(200);
  });

  it("project admins change their project; members read it; others are refused", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const owner = await login(context, "builder");
    const editor = await login(context, "builder");
    const outsider = await login(context, "builder");
    const viewer = await login(context, "viewer");
    await addMember(context, admin.cookie, owner.user.id, "project_admin");
    await addMember(context, admin.cookie, editor.user.id, "editor");

    expect((await put(context, owner.cookie, { runs: 14 })).statusCode).toBe(200);
    expect((await get(context, owner.cookie)).json<ProjectRetentionView>().deploymentAdmin).toBe(false);
    expect((await get(context, owner.cookie)).json<ProjectRetentionView>().canEdit).toBe(true);

    for (const reader of [editor, viewer, outsider]) {
      const view = await get(context, reader.cookie);
      expect(view.statusCode).toBe(200);
      expect(view.json<ProjectRetentionView>()).toMatchObject({ canEdit: false });
      const refused = await put(context, reader.cookie, { runs: 1 });
      expect(refused.statusCode).toBe(403);
    }
    expect((await get(context, admin.cookie, "proj-missing")).statusCode).toBe(404);
    expect((await put(context, admin.cookie, { runs: 1 }, "proj-missing")).statusCode).toBe(404);
    expect((await context.store.listRetentionPolicies()).map((policy) => policy.days)).toEqual([14]);
  });

  it("strict isolation: a project is hidden from users who are not its members", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const admin = await login(context, "admin");
    const outsider = await login(context, "builder");
    expect((await get(context, outsider.cookie)).statusCode).toBe(404);
    expect((await put(context, outsider.cookie, { runs: 1 })).statusCode).toBe(404);
    const member = await login(context, "builder");
    await addMember(context, admin.cookie, member.user.id, "viewer");
    expect((await get(context, member.cookie)).statusCode).toBe(200);
    expect((await put(context, member.cookie, { runs: 1 })).statusCode).toBe(403);
  });

  it("asks for a fresh MFA check when step-up is on", async () => {
    const context = await createTestContext({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await login(context, "admin");
    const refused = await put(context, admin.cookie, { runs: 7 });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "project_retention.change" } });
    expect(await context.store.listRetentionPolicies()).toEqual([]);
    // Reading needs none.
    expect((await get(context, admin.cookie)).statusCode).toBe(200);
  });

  it("the backlog follows a project's shorter value; rule events kept longer show their run as deleted", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const sql = testSql(context.store);
    await sql.run(`INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-a', 'wf-a', 'success', '${daysAgo(10)}')`);
    await sql.run(`INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-live', 'wf-a', 'success', '${daysAgo(1)}')`);
    const event = (id: string, executionId: string, placement: string) =>
      `INSERT INTO guard_events (id, verdict_id, execution_id, workflow_id, project_id, node_id, placement, channel, requested_action, effective_action,
        verdict_action, profile_id, profile_version, profile_hash, created_at)
        VALUES ('${id}', 'v-${id}', '${executionId}', 'wf-a', 'proj-a', 'n', '${placement}', 'input', 'allow', 'allow', 'allow', 'p', 1, 'h', '${daysAgo(10)}')`;
    await sql.run(event("ev-gone", "run-a", "node"));
    await sql.run(event("ev-live", "run-live", "node"));
    await sql.run(event("ev-gateway", "mcpgw_1", "gateway"));
    expect((await put(context, admin.cookie, { runs: 7, rule_events: 400 })).statusCode).toBe(200);

    // The backlog counts the project's own cutoff: run-a (10 days) is due under 7 days, not under the deployment's 30.
    const view = await context.app.inject({ method: "GET", url: "/api/admin/retention", headers: { cookie: admin.cookie } });
    expect(view.json<RetentionAdminView>().classes.find((entry) => entry.class === "runs")?.backlog).toBe(1);
    // The purge deletes the run (as the service tests show); its rule event, kept 400 days, stays.
    await sql.run(`DELETE FROM execution_history WHERE id = 'run-a'`);

    const events = await context.app.inject({ method: "GET", url: "/api/guard/events", headers: { cookie: admin.cookie } });
    expect(events.statusCode, events.body).toBe(200);
    const byId = new Map(events.json<{ events: Array<{ id: string; runDeleted?: boolean }> }>().events.map((entry) => [entry.id, entry]));
    expect(byId.get("ev-gone")?.runDeleted).toBe(true);
    expect(byId.get("ev-live")?.runDeleted).toBeUndefined();
    expect(byId.get("ev-gateway")?.runDeleted).toBeUndefined();
  });

  it("only an admin may keep tool calls or rule events for less than the deployment; project admins may raise them", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const owner = await login(context, "builder");
    await addMember(context, admin.cookie, owner.user.id, "project_admin");

    for (const classes of [{ rule_events: 7 }, { tool_calls: 29 }, { runs: 400, rule_events: 1 }] as Array<Record<string, number>>) {
      const refused = await put(context, owner.cookie, classes);
      expect(refused.statusCode, JSON.stringify(classes)).toBe(403);
      expect(refused.json()).toMatchObject({ code: "retention_admin_required" });
    }
    expect(await context.store.listRetentionPolicies()).toEqual([]);
    const denied = await testSql(context.store).all<{ metadata_json: string; outcome: string }>(
      `SELECT metadata_json, outcome FROM audit_logs WHERE event_type = 'project.retention.update_denied' ORDER BY created_at, id`
    );
    expect(denied).toHaveLength(3);
    // Rows written in the same millisecond order by their random ids: find the first refusal by what it asked for.
    const first = denied.find((row) => (JSON.parse(row.metadata_json) as { requested?: Record<string, number> }).requested?.rule_events === 7)!;
    expect(JSON.parse(first.metadata_json)).toMatchObject({ refused: ["rule_events"], requested: { rule_events: 7 } });
    expect(denied.every((row) => row.outcome === "failure")).toBe(true);

    // Raising them, matching the deployment, shortening runs and setting memory (kept forever by the deployment) are fine.
    expect((await put(context, owner.cookie, { rule_events: 400, tool_calls: 30, runs: 1, agent_memory: 3 })).statusCode).toBe(200);
    // An admin may shorten them; the project admin may then return them to the default, but not shorten them again.
    expect((await put(context, admin.cookie, { rule_events: 7 })).statusCode).toBe(200);
    expect((await put(context, owner.cookie, { rule_events: 14 })).statusCode).toBe(403);
    expect((await put(context, owner.cookie, { rule_events: null })).statusCode).toBe(200);
    expect((await context.store.listRetentionPolicies({ scopeId: "proj-a" })).map((policy) => [policy.dataClass, policy.days])).toEqual([
      ["agent_memory", 3],
      ["runs", 1],
      ["tool_calls", 30]
    ]);
  });

  it("with the deployment keeping tool calls forever, any number of days is shorter", async () => {
    const context = await createTestContext({ EXECUTION_HISTORY_RETENTION_DAYS: "0" });
    const admin = await login(context, "admin");
    const owner = await login(context, "builder");
    await addMember(context, admin.cookie, owner.user.id, "project_admin");
    expect((await put(context, owner.cookie, { tool_calls: 3650 })).statusCode).toBe(403);
    expect((await put(context, owner.cookie, { tool_calls: 0 })).statusCode).toBe(200);
    expect((await put(context, admin.cookie, { tool_calls: 3650 })).statusCode).toBe(200);
  });

  it("the start-up purge gives older memory to a project only for its own workflows' default namespaces", async () => {
    const workflowWith = (id: string, projectId: string, nodeId: string) =>
      ({ id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, projectId, edges: [], nodes: [{ id: nodeId, type: "llm_call", name: nodeId, position: { x: 0, y: 0 }, config: {} }] }) as never;
    const context = await createTestContext({}, async (store) => {
      await store.upsertProject({ id: "proj-b", name: "Project B", createdBy: "ana" });
      await store.upsertWorkflow(workflowWith("team:wf1", "proj-b", "node1"));
      await store.upsertWorkflow(workflowWith("team", "proj-a", "wf1:node1"));
      await store.upsertWorkflow(workflowWith("crm", "proj-a", "n"));
      await store.upsertWorkflow(workflowWith("wf-own", "proj-a", "agent"));
      await store.setRetentionPolicies({ scopeId: "proj-a", values: { agent_memory: 7 }, updatedBy: "ana" });
      const sql = testSql(store);
      for (const [sessionId, namespace] of [
        ["b-legacy", "team:wf1:node1"],
        ["unowned", "crm:emea"],
        ["a-legacy", "wf-own:agent"]
      ]) {
        await sql.run(
          `INSERT INTO session_memory (namespace, session_id, messages_json, created_at, updated_at) VALUES ('${namespace}', '${sessionId}', '[]', '${daysAgo(10)}', '${daysAgo(10)}')`
        );
      }
    });
    const rows = await testSql(context.store).all<{ session_id: string }>(`SELECT session_id FROM session_memory ORDER BY session_id`);
    expect(rows.map((row) => row.session_id)).toEqual(["b-legacy", "unowned"]);
  });
});
