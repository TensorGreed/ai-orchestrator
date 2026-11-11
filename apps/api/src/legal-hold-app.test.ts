/**
 * 13.3 — legal holds through the app: who may manage them (admins, and a deployment-wide custom role with
 * `legal_hold:manage`; never a builder or a project-scoped role), step-up, audit, the 409 a hold gives a workflow or
 * project delete, the badge status, and that the start-up purge keeps held history. Runs against the
 * store TEST_STORE names.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { retentionRowSql } from "./test-support/retention-rows.js";
import { AuthService, type UserRole } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];
const OLD = "2001-01-01T00:00:00.000Z";

async function createTestContext(env: Record<string, string> = {}, seed: string[] = []): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-legal-hold-app-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const sql = testSql(store);
  for (const statement of seed) await sql.run(statement);
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

async function login(context: TestContext, role: UserRole): Promise<{ cookie: string; userId: string }> {
  const email = `${role}-${crypto.randomUUID().slice(0, 6)}@example.com`;
  const password = `${role}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const header = response.headers["set-cookie"];
  const values = Array.isArray(header) ? header : [header ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return { cookie: cookie.split(";")[0]!, userId: user.id };
}

const workflow = (id: string, projectId = "default") => ({ id, name: `W ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId }) as never;

describe("legal holds in the app", () => {
  it("only hold managers list and place holds; a deployment-wide custom role with legal_hold:manage is one", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const viewer = await login(context, "viewer");
    await context.store.upsertProject({ id: "p1", name: "P1" });
    const place = (cookie: string) =>
      context.app.inject({ method: "POST", url: "/api/legal-holds", headers: { cookie }, payload: { name: "Matter", reason: "Litigation", scopeType: "project", scopeId: "p1" } });

    for (const who of [builder, viewer]) {
      expect((await context.app.inject({ method: "GET", url: "/api/legal-holds", headers: { cookie: who.cookie } })).statusCode).toBe(403);
      expect((await place(who.cookie)).statusCode).toBe(403);
    }
    expect((await context.app.inject({ method: "GET", url: "/api/legal-holds" })).statusCode).toBe(401);

    const placed = await place(admin.cookie);
    expect(placed.statusCode).toBe(201);
    const hold = (placed.json() as { hold: { id: string; scopeType: string; status: string } }).hold;
    expect(hold).toMatchObject({ scopeType: "project", status: "active" });
    const audit = (await context.store.listAuditLogs({ eventType: "legal_hold.placed", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ category: "data_protection", resourceType: "legal_hold", resourceId: hold.id });

    // A deployment-wide "compliance" role grants it to a builder; the same permission in a project role does not.
    await context.store.upsertCustomRole({ id: "compliance", projectId: null, name: "Compliance", description: null, permissions: ["legal_hold:manage"], createdBy: null });
    await context.store.upsertCustomRole({ id: "p1-compliance", projectId: "p1", name: "P1 compliance", description: null, permissions: ["legal_hold:manage"], createdBy: null });
    await context.store.upsertProjectRole({ userId: viewer.userId, projectId: "p1", role: "custom", customRoleId: "p1-compliance" });
    expect((await context.app.inject({ method: "GET", url: "/api/legal-holds", headers: { cookie: viewer.cookie } })).statusCode).toBe(403);
    await context.store.upsertProjectRole({ userId: builder.userId, projectId: "default", role: "custom", customRoleId: "compliance" });
    const listed = await context.app.inject({ method: "GET", url: "/api/legal-holds?status=active", headers: { cookie: builder.cookie } });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { holds: Array<{ id: string }> }).holds.map((h) => h.id)).toEqual([hold.id]);
    expect((await place(builder.cookie)).statusCode).toBe(201);

    // Only an admin hands out a role that manages legal holds.
    await context.store.upsertProjectRole({ userId: builder.userId, projectId: "p1", role: "project_admin" });
    const handOut = await context.app.inject({
      method: "POST",
      url: "/api/projects/p1/members",
      headers: { cookie: builder.cookie },
      payload: { userId: viewer.userId, role: "custom", customRoleId: "compliance" }
    });
    expect(handOut.statusCode).toBe(403);
  }, 60_000);

  it("a held workflow and project answer 409 legal_hold to a delete; released, they go", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.upsertProject({ id: "p2", name: "P2" });
    await context.store.upsertWorkflow(workflow("wf-1", "p2"));
    const placed = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "Acme", reason: "Litigation", scopeType: "workflow", scopeId: "wf-1" }
    });
    const hold = (placed.json() as { hold: { id: string; name: string } }).hold;
    const refused = await context.app.inject({ method: "DELETE", url: "/api/workflows/wf-1", headers: { cookie: admin.cookie } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "legal_hold", holds: [{ id: hold.id, name: "Acme" }] });
    expect((refused.json() as { error: string }).error).toContain("Acme");

    // The badge: held, with names for hold managers only.
    const status = await context.app.inject({ method: "GET", url: "/api/legal-holds/status?workflowId=wf-1", headers: { cookie: admin.cookie } });
    expect(status.json()).toEqual({ held: true, holds: [{ id: hold.id, name: "Acme" }] });
    const builder = await login(context, "builder");
    const builderStatus = await context.app.inject({ method: "GET", url: "/api/legal-holds/status?workflowId=wf-1", headers: { cookie: builder.cookie } });
    expect(builderStatus.json()).toEqual({ held: true, holds: [] });
    expect((await context.app.inject({ method: "GET", url: "/api/legal-holds/status?workflowId=wf-1&projectId=p2", headers: { cookie: admin.cookie } })).statusCode).toBe(400);

    const noReason = await context.app.inject({ method: "POST", url: `/api/legal-holds/${hold.id}/release`, headers: { cookie: admin.cookie }, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const released = await context.app.inject({ method: "POST", url: `/api/legal-holds/${hold.id}/release`, headers: { cookie: admin.cookie }, payload: { reason: "Settled" } });
    expect(released.statusCode).toBe(200);
    expect((await context.app.inject({ method: "POST", url: `/api/legal-holds/${hold.id}/release`, headers: { cookie: admin.cookie }, payload: { reason: "x" } })).statusCode).toBe(409);
    expect((await context.store.listAuditLogs({ eventType: "legal_hold.released", pageSize: 10 })).items).toHaveLength(1);
    expect((await context.app.inject({ method: "DELETE", url: "/api/workflows/wf-1", headers: { cookie: admin.cookie } })).statusCode).toBe(200);

    // A project hold refuses the project delete.
    await context.app.inject({ method: "POST", url: "/api/legal-holds", headers: { cookie: admin.cookie }, payload: { name: "P2 hold", reason: "r", scopeType: "project", scopeId: "p2" } });
    const project = await context.app.inject({ method: "DELETE", url: "/api/projects/p2", headers: { cookie: admin.cookie } });
    expect(project.statusCode).toBe(409);
    expect(project.json()).toMatchObject({ code: "legal_hold" });
  }, 60_000);

  it("a runs hold names existing runs; its items page; unknown runs and holds answer 404", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    await context.store.saveExecutionHistory({ id: "run-1", workflowId: "wf", status: "success", startedAt: OLD });
    const missing = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "Runs", reason: "r", scopeType: "runs", executionIds: ["ghost"] }
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await context.app.inject({ method: "POST", url: "/api/legal-holds", headers: { cookie: admin.cookie }, payload: { name: "Runs", reason: "r", scopeType: "runs" } });
    expect(invalid.statusCode).toBe(400);
    const organization = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "Org", reason: "r", scopeType: "organization", scopeId: "o1" }
    });
    expect(organization.statusCode).toBe(400);
    const placed = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "Runs", reason: "r", scopeType: "runs", executionIds: ["run-1"] }
    });
    const hold = (placed.json() as { hold: { id: string; itemCount: number } }).hold;
    expect(hold.itemCount).toBe(1);
    const items = await context.app.inject({ method: "GET", url: `/api/legal-holds/${hold.id}/items?limit=10`, headers: { cookie: admin.cookie } });
    expect(items.json()).toMatchObject({ total: 1, items: [{ kind: "execution", rowId: "run-1" }] });
    expect((await context.app.inject({ method: "GET", url: `/api/legal-holds/${hold.id}`, headers: { cookie: admin.cookie } })).statusCode).toBe(200);
    expect((await context.app.inject({ method: "GET", url: "/api/legal-holds/missing", headers: { cookie: admin.cookie } })).statusCode).toBe(404);
    expect((await context.app.inject({ method: "GET", url: "/api/legal-holds/missing/items", headers: { cookie: admin.cookie } })).statusCode).toBe(404);
    const status = await context.app.inject({ method: "GET", url: "/api/legal-holds/status?executionId=run-1", headers: { cookie: admin.cookie } });
    expect((status.json() as { held: boolean }).held).toBe(true);
  }, 60_000);

  it("review fixes: subject holds are admin-only, a key cannot release, a project admin cannot take the role away, a held workflow cannot be transferred", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const builder = await login(context, "builder");
    const other = await login(context, "viewer");
    await context.store.upsertProject({ id: "p5", name: "P5" });
    await context.store.upsertProject({ id: "p6", name: "P6" });
    await context.store.upsertWorkflow(workflow("wf-5", "p5"));
    await context.store.upsertCustomRole({ id: "compliance", projectId: null, name: "Compliance", description: null, permissions: ["legal_hold:manage"], createdBy: null });
    await context.store.upsertProjectRole({ userId: builder.userId, projectId: "p5", role: "custom", customRoleId: "compliance" });

    // A non-admin hold manager cannot place a subject hold (it would tell them whether a value is stored).
    const subject = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: builder.cookie },
      payload: { name: "S", reason: "r", scopeType: "subject", subject: { value: "someone@example.com" } }
    });
    expect(subject.statusCode).toBe(403);
    expect(subject.body).not.toContain("someone@example.com");

    // A project admin of p5 cannot remove or change the member whose role manages legal holds; an admin can.
    await context.store.upsertProjectRole({ userId: other.userId, projectId: "p5", role: "project_admin" });
    const remove = await context.app.inject({ method: "DELETE", url: `/api/projects/p5/members/${builder.userId}`, headers: { cookie: other.cookie } });
    expect(remove.statusCode).toBe(403);
    const change = await context.app.inject({
      method: "POST",
      url: "/api/projects/p5/members",
      headers: { cookie: other.cookie },
      payload: { userId: builder.userId, role: "viewer" }
    });
    expect(change.statusCode).toBe(403);
    expect((await context.store.getProjectRole(builder.userId, "p5"))?.customRoleId).toBe("compliance");

    // A held workflow cannot be transferred out of its project (409 legal_hold), nor moved by a save.
    const placed = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "P5 hold", reason: "r", scopeType: "project", scopeId: "p5" }
    });
    const hold = (placed.json() as { hold: { id: string } }).hold;
    const transfer = await context.app.inject({ method: "POST", url: "/api/workflows/wf-5/transfer", headers: { cookie: admin.cookie }, payload: { targetProjectId: "p6" } });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json()).toMatchObject({ code: "legal_hold" });
    expect((await context.store.getWorkflow("wf-5"))?.projectId).toBe("p5");

    // An API key (an admin service account's) cannot release a hold.
    const account = await context.app.inject({ method: "POST", url: "/api/service-accounts", headers: { cookie: admin.cookie }, payload: { name: "ops", role: "admin" } });
    const accountId = (account.json() as { serviceAccount: { id: string } }).serviceAccount.id;
    const created = await context.app.inject({ method: "POST", url: `/api/service-accounts/${accountId}/keys`, headers: { cookie: admin.cookie }, payload: { name: "ci" } });
    const key = (created.json() as { key: string }).key;
    const viaKey = await context.app.inject({
      method: "POST",
      url: `/api/legal-holds/${hold.id}/release`,
      headers: { authorization: `Bearer ${key}` },
      payload: { reason: "r" }
    });
    expect(viaKey.statusCode).toBe(403);
    expect((await context.store.getLegalHold(hold.id))?.status).toBe("active");
  }, 60_000);

  it("placing and releasing need step-up when it is on", async () => {
    const context = await createTestContext({ STEP_UP_MAX_AGE_MINUTES: "10" });
    const admin = await login(context, "admin");
    await context.store.upsertProject({ id: "p3", name: "P3" });
    const response = await context.app.inject({
      method: "POST",
      url: "/api/legal-holds",
      headers: { cookie: admin.cookie },
      payload: { name: "Matter", reason: "r", scopeType: "project", scopeId: "p3" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "step_up_required", stepUp: { action: "legal_hold.change" } });
    expect(await context.store.listLegalHolds()).toEqual([]);
  }, 60_000);

  it("the start-up purge keeps history under a hold placed before it", async () => {
    const seed = [
      retentionRowSql("execution_history", "held-run", OLD),
      retentionRowSql("execution_history", "free-run", OLD),
      `UPDATE execution_history SET workflow_id = 'other' WHERE id = 'free-run'`,
      `INSERT INTO legal_holds (id, name, reason, scope_type, scope_id, status, created_at) VALUES ('h', 'Matter', 'r', 'workflow', 'wf', 'active', '${OLD}')`
    ];
    const context = await createTestContext({}, seed);
    const ids = (await testSql(context.store).all<{ id: string }>(`SELECT id FROM execution_history ORDER BY id`)).map((row) => row.id);
    expect(ids).toEqual(["held-run"]);
  }, 60_000);
});
