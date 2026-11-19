/**
 * v78 — sharing a workflow with a person. Whoever may invite members to the workflow's project shares it by email
 * with read or execute; the person then sees and opens it (and runs it, with execute and a role that may run), never edits it.
 * Shares are audited, listed to managers, and gone with the workflow or the user.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(env: Record<string, string> = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-user-shares-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git"),
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

type Role = "admin" | "builder" | "operator" | "viewer";

async function login(context: TestContext, role: Role, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie for ${name}`);
  return { cookie: cookie.split(";")[0]!, id: user.id, email };
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

function flow(id: string, projectId: string): Workflow {
  return {
    id,
    name: `Flow ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  };
}

/** Strict isolation: nobody but the owner (project admin), an editor and admins reaches project "team" without a share. */
async function seed() {
  const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
  const owner = await login(context, "builder", "owner");
  const operator = await login(context, "operator", "olivia");
  const viewer = await login(context, "viewer", "victor");
  const outsider = await login(context, "builder", "oscar");
  const editor = await login(context, "builder", "edith");
  await context.store.upsertProject({ id: "team", name: "Team" });
  await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
  await context.store.upsertProjectRole({ userId: editor.id, projectId: "team", role: "editor" });
  await context.store.upsertWorkflow(flow("wf-team", "team"));
  return { context, owner, operator, viewer, outsider, editor };
}

describe("workflow shares with people", () => {
  it("a read share lets the person see and open the workflow, not run or edit it", async () => {
    const { context, owner, viewer } = await seed();
    expect((await call(context, "GET", "/api/workflows/wf-team", viewer.cookie)).statusCode).toBe(404);

    const shared = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: "VICTOR@example.com", accessLevel: "read" });
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({ share: { userId: viewer.id, email: viewer.email, accessLevel: "read", effectiveAccess: "read" } });

    expect((await call(context, "GET", "/api/workflows/wf-team", viewer.cookie)).statusCode).toBe(200);
    const list = await call(context, "GET", "/api/workflows", viewer.cookie);
    expect(list.json<Array<{ id: string }>>().map((workflow) => workflow.id)).toContain("wf-team");
    const paged = await call(context, "GET", "/api/workflows?page=1&pageSize=50", viewer.cookie);
    expect(paged.json<{ items: Array<{ id: string }> }>().items.map((workflow) => workflow.id)).toContain("wf-team");
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", viewer.cookie, {})).statusCode).toBe(403);
    const mine = await call(context, "GET", "/api/workflows/shared-with-me", viewer.cookie);
    expect(mine.json()).toEqual({
      workflows: [{ id: "wf-team", name: "Flow wf-team", projectId: "team", updatedAt: expect.any(String), accessLevel: "read", effectiveAccess: "read", shareOnly: true }]
    });
    expect((await call(context, "GET", "/api/workflows/shared-with-me", owner.cookie)).json()).toEqual({ workflows: [] });
  });

  it("an execute share runs it; a read share does not, and a viewer's execute share reads", async () => {
    const { context, owner, outsider, viewer, operator } = await seed();
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: outsider.email, accessLevel: "read" })).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", outsider.cookie, {})).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: outsider.email, accessLevel: "execute" })).statusCode).toBe(200);
    const run = await call(context, "POST", "/api/workflows/wf-team/execute", outsider.cookie, {});
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json<{ status: string }>().status).toBe("success");
    // The run is the person's to read.
    const runs = await call(context, "GET", "/api/executions?workflowId=wf-team", outsider.cookie);
    expect(runs.statusCode).toBe(200);
    expect(runs.body).toContain("wf-team");

    const viewerShare = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { userId: viewer.id, accessLevel: "execute" });
    expect(viewerShare.json()).toMatchObject({ share: { accessLevel: "execute", effectiveAccess: "read" } });
    expect((await call(context, "POST", "/api/workflows/wf-team/execute", viewer.cookie, {})).statusCode).toBe(403);
    const operatorShare = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { userId: operator.id, accessLevel: "execute" });
    expect(operatorShare.json()).toMatchObject({ share: { effectiveAccess: "execute" } });
  });

  it("a share never lets a builder edit, and only those who may invite project members manage shares", async () => {
    const { context, owner, outsider, operator, editor } = await seed();
    // A project editor may change the workflow but not open it to people, as they may not add members.
    const byEditor = await call(context, "POST", "/api/workflows/wf-team/user-shares", editor.cookie, { email: outsider.email });
    expect(byEditor.statusCode).toBe(403);
    expect((await call(context, "GET", "/api/workflows/wf-team/user-shares", editor.cookie)).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/workflows/wf-team/shares", editor.cookie)).json()).not.toHaveProperty("userShares");
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: outsider.email, accessLevel: "execute" })).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-team", outsider.cookie)).statusCode).toBe(200);
    const edit = await call(context, "PUT", "/api/workflows/wf-team", outsider.cookie, { ...flow("wf-team", "team"), name: "Mine now" });
    expect(edit.statusCode).toBe(403);
    expect((await context.store.getWorkflow("wf-team"))?.name).toBe("Flow wf-team");
    // The person it is shared with cannot share it on, list who has it or remove shares.
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", outsider.cookie, { email: operator.email })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/workflows/wf-team/user-shares", outsider.cookie)).statusCode).toBe(403);
    expect((await call(context, "DELETE", `/api/workflows/wf-team/user-shares/${outsider.id}`, outsider.cookie)).statusCode).toBe(403);
    const shares = await call(context, "GET", "/api/workflows/wf-team/shares", outsider.cookie);
    expect(shares.json()).not.toHaveProperty("userShares");
    // Someone who cannot read it at all gets 404.
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", operator.cookie, { email: operator.email })).statusCode).toBe(404);
  });

  it("refuses unknown emails, service accounts and yourself", async () => {
    const { context, owner } = await seed();
    const unknown = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: "nobody@example.com" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toMatch(/No user with the email nobody@example.com/);
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: owner.email })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, {})).statusCode).toBe(400);
    await context.store.createServiceAccount({ id: "svc-1", email: "ci+0@service.invalid", role: "operator", description: null, createdBy: owner.id });
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { userId: "svc-1" })).statusCode).toBe(400);
  });

  it("lists shares to managers with their effective access, audits changes, and removes them", async () => {
    const { context, owner, operator, viewer } = await seed();
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "execute" });
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: viewer.email, accessLevel: "execute" });
    const listed = await call(context, "GET", "/api/workflows/wf-team/user-shares", owner.cookie);
    expect(listed.statusCode).toBe(200);
    const rows = listed.json<{ userShares: Array<{ email: string; effectiveAccess: string; sharedBy: string }> }>().userShares;
    expect(rows.map((row) => [row.email, row.effectiveAccess, row.sharedBy]).sort()).toEqual([
      [operator.email, "execute", owner.email],
      [viewer.email, "read", owner.email]
    ]);
    const shares = await call(context, "GET", "/api/workflows/wf-team/shares", owner.cookie);
    expect(shares.json<{ userShares: unknown[] }>().userShares).toHaveLength(2);

    expect((await call(context, "DELETE", `/api/workflows/wf-team/user-shares/${operator.id}`, owner.cookie)).statusCode).toBe(200);
    expect((await call(context, "DELETE", `/api/workflows/wf-team/user-shares/${operator.id}`, owner.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/workflows/wf-team", operator.cookie)).statusCode).toBe(404);

    const audit = await context.store.listAuditLogs({ category: "sharing", pageSize: 50 });
    const types = audit.items.map((entry) => entry.eventType);
    expect(types.filter((type) => type === "workflow.user_share")).toHaveLength(2);
    expect(types).toContain("workflow.user_unshare");
    expect(audit.items.find((entry) => entry.eventType === "workflow.user_share" && (entry.metadata as Record<string, unknown> | null)?.targetUserId === viewer.id)?.metadata).toMatchObject({
      accessLevel: "execute",
      effectiveAccess: "read",
      targetEmail: viewer.email
    });
  });

  it("a move to another project keeps the shares, and the move's audit counts them", async () => {
    const { context, owner, operator } = await seed();
    const admin = await login(context, "admin", "ada");
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "read" });
    await context.store.upsertProject({ id: "other", name: "Other" });
    const moved = await call(context, "POST", "/api/workflows/wf-team/transfer", admin.cookie, { targetProjectId: "other" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-team", operator.cookie)).statusCode).toBe(200);
    const audit = await context.store.listAuditLogs({ category: "workflow", pageSize: 50 });
    expect(audit.items.find((entry) => entry.eventType === "workflow.transfer")?.metadata).toMatchObject({ targetProjectId: "other", userShareCount: 1 });
  });

  it("lists the workflows shared to a project to its members, with the access they get there", async () => {
    const { context, owner, operator, viewer, outsider } = await seed();
    await context.store.upsertProject({ id: "ops", name: "Ops" });
    await context.store.upsertProjectRole({ userId: operator.id, projectId: "ops", role: "editor" });
    await context.store.upsertProjectRole({ userId: viewer.id, projectId: "ops", role: "viewer" });
    expect((await call(context, "POST", "/api/workflows/wf-team/shares", owner.cookie, { projectId: "ops", accessLevel: "execute" })).statusCode).toBe(200);

    const forOperator = await call(context, "GET", "/api/projects/ops/shared-workflows", operator.cookie);
    expect(forOperator.statusCode, forOperator.body).toBe(200);
    expect(forOperator.json()).toMatchObject({ workflows: [{ id: "wf-team", name: "Flow wf-team", ownerProjectId: "team", accessLevel: "execute", effectiveAccess: "execute" }] });
    const forViewer = await call(context, "GET", "/api/projects/ops/shared-workflows", viewer.cookie);
    expect(forViewer.json()).toMatchObject({ workflows: [{ id: "wf-team", effectiveAccess: "read" }] });
    // A global viewer who edits in ops still may not run (the run routes need operator and up).
    await context.store.upsertProjectRole({ userId: viewer.id, projectId: "ops", role: "editor" });
    expect((await call(context, "GET", "/api/projects/ops/shared-workflows", viewer.cookie)).json()).toMatchObject({ workflows: [{ id: "wf-team", effectiveAccess: "read" }] });
    // A missing project reads the same as one you cannot see.
    expect((await call(context, "GET", "/api/projects/nope/shared-workflows", outsider.cookie)).statusCode).toBe(404);
    // Not a member of ops (strict isolation): the project reads as missing.
    expect((await call(context, "GET", "/api/projects/ops/shared-workflows", outsider.cookie)).statusCode).toBe(404);
    // The owning project lists its own workflows elsewhere.
    expect((await call(context, "GET", "/api/projects/team/shared-workflows", owner.cookie)).json()).toEqual({ workflows: [] });
  });

  it("a deleted workflow or user takes its shares along", async () => {
    const { context, owner, operator } = await seed();
    const admin = await login(context, "admin", "ada");
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "read" });
    expect((await call(context, "DELETE", "/api/workflows/wf-team", admin.cookie)).statusCode).toBe(200);
    expect(await context.store.listWorkflowsSharedToUser(operator.id)).toEqual([]);
    await context.store.upsertWorkflow(flow("wf-team", "team"));
    expect((await call(context, "GET", "/api/workflows/wf-team", operator.cookie)).statusCode).toBe(404);

    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "read" });
    expect((await call(context, "DELETE", `/api/users/${operator.id}`, admin.cookie)).statusCode).toBe(200);
    expect(await context.store.listWorkflowUserShares("wf-team")).toEqual([]);
  });
});

describe("project members by email", () => {
  it("adds a member by email and lists members with their emails", async () => {
    const { context, viewer } = await seed();
    const admin = await login(context, "admin", "ada");
    const added = await call(context, "POST", "/api/projects/team/members", admin.cookie, { email: "Victor@Example.com", role: "viewer" });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ membership: { userId: viewer.id, role: "viewer" } });
    const members = await call(context, "GET", "/api/projects/team/members", admin.cookie);
    expect(members.json<{ members: Array<{ userId: string; email: string | null }> }>().members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: viewer.id, email: viewer.email })])
    );
    const unknown = await call(context, "POST", "/api/projects/team/members", admin.cookie, { email: "nobody@example.com", role: "viewer" });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>().error).toMatch(/Invite them first/);
    expect((await call(context, "POST", "/api/projects/team/members", admin.cookie, { role: "viewer" })).statusCode).toBe(400);
    expect((await call(context, "POST", "/api/projects/team/members", admin.cookie, { userId: viewer.id, email: viewer.email, role: "viewer" })).statusCode).toBe(400);
  });
});

describe("what the editor may show", () => {
  it("answers canEdit, canRun and canShare per user and workflow", async () => {
    const { context, owner, operator, viewer, outsider, editor } = await seed();
    const access = async (cookie: string) => (await call(context, "GET", "/api/workflows/wf-team/access", cookie)).json<Record<string, unknown>>();
    expect(await access(owner.cookie)).toMatchObject({ canEdit: true, canRun: true, canShare: true });
    expect(await access(owner.cookie)).not.toHaveProperty("canShareWithProjects");
    // A project editor may change the workflow but not share it, with people or with projects: canShare follows the
    // share routes, which refuse the editor.
    expect(await access(editor.cookie)).toMatchObject({ canEdit: true, canShare: false });
    expect((await call(context, "POST", "/api/workflows/wf-team/user-shares", editor.cookie, { email: viewer.email, accessLevel: "read" })).statusCode).toBe(403);
    expect((await call(context, "GET", "/api/workflows/wf-team/access", viewer.cookie)).statusCode).toBe(404);
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: viewer.email, accessLevel: "execute" });
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: operator.email, accessLevel: "execute" });
    await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: outsider.email, accessLevel: "execute" });
    expect(await access(viewer.cookie)).toMatchObject({ role: "viewer", canEdit: false, canRun: false, canShare: false });
    // An operator with an execute share runs the saved workflow.
    expect(await access(operator.cookie)).toMatchObject({ role: "operator", canEdit: false, canRun: true, canShare: false });
    expect(await access(outsider.cookie)).toMatchObject({ role: "builder", canEdit: false, canRun: true, canShare: false });
  });
});

describe("sharing with another project takes what sharing with people takes (project:invite)", () => {
  it("refuses a project editor without project:invite; the project admin shares and unshares", async () => {
    const { context, owner, editor } = await seed();
    await context.store.upsertProject({ id: "ops", name: "Ops" });
    const refused = await call(context, "POST", "/api/workflows/wf-team/shares", editor.cookie, { projectId: "ops", accessLevel: "execute" });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/invite members/);
    expect(await context.store.listWorkflowShares("wf-team")).toEqual([]);

    expect((await call(context, "POST", "/api/workflows/wf-team/shares", owner.cookie, { projectId: "ops", accessLevel: "execute" })).statusCode).toBe(200);
    // An existing share stays; the editor may not remove it either.
    expect((await call(context, "DELETE", "/api/workflows/wf-team/shares/ops", editor.cookie)).statusCode).toBe(403);
    expect((await context.store.listWorkflowShares("wf-team")).map((share) => share.projectId)).toEqual(["ops"]);
    expect((await call(context, "DELETE", "/api/workflows/wf-team/shares/ops", owner.cookie)).statusCode).toBe(200);
  });
});
