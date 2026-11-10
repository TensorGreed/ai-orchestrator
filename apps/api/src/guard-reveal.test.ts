/**
 * Phase 12 coverage — the controlled reveal step over the API:
 *
 * - migration v69: the token vault records the project and run that issued each token;
 * - a run's vault writes its project, and a Reveal node reveals only that project's tokens;
 * - a reveal writes rule events (placement and action `reveal`, token hashes, never values) and an audit entry;
 * - a signed-in admin's run reveals; a webhook run of the same workflow does not (role rules never match it);
 * - reveal rules come only from rule sets bound to the run; an approval is decided by another admin;
 * - revealed values are never stored: run history, live events and replay capture keep the tokens;
 * - simulations, candidate rule set runs (replays) and eval runs never reveal.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { MIGRATIONS } from "./db/migrations.js";
import { contiguousMigrationVersions } from "./db/migration-versions.test-helper.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";
import { AuthService } from "./services/auth-service.js";
import { GuardService } from "./services/guard-service.js";
import { LogStreamingService } from "./services/log-streaming-service.js";
import { QueueService } from "./services/queue-service.js";
import { resolveMcpToolPolicySubject } from "./services/mcp-tool-policy.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";
import { SecretService } from "./services/secret-service.js";
import { GuardSimulationSink, GuardSimulationVault } from "./services/guard-simulation-sink.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  queue?: QueueService;
}

const contexts: TestContext[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop()!;
    context.queue?.stop();
    await context.app.close();
    try {
      await context.store.close();
    } catch {
      // Already closed by the app shutdown hooks.
    }
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function createTestContext(options: { queue?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reveal-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue ? new QueueService(store, { pollIntervalMs: 20 }) : undefined;
  const app = await createApp(config, store, secretService, authService, undefined, queue);
  await app.ready();
  const context = { app, store, authService, config, tempDir, ...(queue ? { queue } : {}) };
  contexts.push(context);
  return context;
}

async function login(context: TestContext, role: "admin" | "builder" | "viewer", email = `${role}@example.com`): Promise<string> {
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return cookie.split(";")[0]!;
}

const call = (context: TestContext, method: "GET" | "POST" | "PUT", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

const EMAIL = "ana.lopez@example.org";

const SUPPORT_RULES = {
  id: "support",
  name: "Support",
  version: "1",
  channels: {
    prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "protect" } }, defaultAction: { action: "allow" } }
  },
  reveal: { rules: [{ name: "Admins", dataClasses: ["email"], subjects: { roles: ["admin"] } }] }
};

/** hook → protect (token vault) → out: issues the tokens the reveal workflows read. */
function protectWorkflow(id: string): Workflow {
  return {
    id,
    name: `Protect ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "protect", type: "guard", name: "Protect", position: { x: 100, y: 0 }, config: { profileId: "support", channel: "prompt", inputField: "user_prompt" } },
      { id: "vault", type: "guard_protection", name: "Vault", position: { x: 100, y: 100 }, config: { providerId: "token_vault", dataClasses: ["email"] } },
      { id: "out", type: "output", name: "Out", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "protect" },
      { id: "e2", source: "protect", sourceHandle: "pass", target: "out" },
      { id: "e3", source: "protect", sourceHandle: "protection", target: "vault" }
    ]
  } as Workflow;
}

/** hook → reveal → out */
function revealWorkflow(id: string, config: Record<string, unknown> = {}): Workflow {
  return {
    id,
    name: `Reveal ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `hook-${id}`, method: "POST" } },
      { id: "reveal", type: "guard_reveal", name: "Reveal", position: { x: 200, y: 0 }, config: { inputField: "user_prompt", ...config } },
      { id: "out", type: "output", name: "Out", position: { x: 300, y: 0 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "hook", target: "reveal" },
      { id: "e2", source: "reveal", target: "out" }
    ]
  } as Workflow;
}

type RunResult = { status: string; executionId?: string; error?: string; nodeResults: Array<{ nodeId: string; status: string; output?: Record<string, any> }> };
const outputOf = (run: RunResult, nodeId: string) => run.nodeResults.find((entry) => entry.nodeId === nodeId)?.output ?? {};

/** The rule set saved, a token issued for EMAIL in the default project, and the reveal workflow stored (and bound). */
async function setUp(context: TestContext, admin: string, options: { rules?: Record<string, unknown>; bind?: boolean; workflowId?: string } = {}) {
  const rules = options.rules ?? SUPPORT_RULES;
  expect((await call(context, "POST", "/api/guard/profiles", admin, { id: String(rules.id), document: rules })).statusCode).toBe(201);
  if (rules.id !== "support") expect((await call(context, "POST", "/api/guard/profiles", admin, { id: "support", document: SUPPORT_RULES })).statusCode).toBe(201);
  await context.store.upsertWorkflow(protectWorkflow("wf-protect"));
  const protect = (await call(context, "POST", "/api/workflows/wf-protect/execute", admin, { user_prompt: `Mail ${EMAIL} today` })).json<RunResult>();
  expect(protect.status, protect.error).toBe("success");
  const token = String(outputOf(protect, "protect").user_prompt).split(" ")[1]!;
  expect(token).toMatch(/^tok_email_/);
  const workflow = revealWorkflow(options.workflowId ?? "wf-reveal");
  const saved = await context.store.upsertWorkflow(workflow);
  await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" });
  if (options.bind !== false) {
    const bound = await call(context, "PUT", `/api/guard/bindings/workflows/${workflow.id}`, admin, { mode: "override", profileId: rules.id });
    expect(bound.statusCode, bound.body).toBe(200);
  }
  return { token, workflow, protect };
}

describe("migration v69", () => {
  it("adds the issuing project and run to the token vault, with a rollback, in both stores", async () => {
    const versions = MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    expect(versions).toEqual(contiguousMigrationVersions(versions));
    const migration = MIGRATIONS.find((entry) => entry.version === 69)!;
    expect(migration.up).toContain("ALTER TABLE guard_token_vault ADD COLUMN IF NOT EXISTS project_id TEXT");
    expect(migration.up).toContain("CREATE INDEX IF NOT EXISTS idx_guard_token_vault_project");
    expect(migration.down).toContain("DROP COLUMN IF EXISTS project_id");
    const context = await createTestContext();
    const sql = testSql(context.store);
    const columns = (
      sql.kind === "sqlite"
        ? await sql.all<{ name: string }>(`PRAGMA table_info(guard_token_vault)`)
        : await sql.all<{ name: string }>(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?`, "guard_token_vault")
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["project_id", "execution_id"]));
  });
});

describe("Reveal over the API", () => {
  it("reveals for a signed-in admin's run without storing the value, records hashes and an audit entry, and keeps tokens on a webhook run", async () => {
    const dispatched = vi.spyOn(LogStreamingService.prototype, "dispatchAudit");
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const viewer = await login(context, "viewer");
    const { token, workflow, protect } = await setUp(context, admin);

    const run = (await call(context, "POST", `/api/workflows/${workflow.id}/execute`, admin, { user_prompt: `Mail ${token} today` })).json<RunResult>();
    expect(run.status, run.error).toBe("success");
    expect(outputOf(run, "reveal").reveal.revealed).toEqual([expect.objectContaining({ dataClass: "email", count: 1 })]);
    // Downstream nodes of the run get the value; the run's result and history keep the token.
    expect(outputOf(run, "reveal").user_prompt).toBe(`Mail ${token} today`);
    expect(JSON.stringify(run)).not.toContain(EMAIL);
    for (const cookie of [admin, viewer]) {
      const history = await call(context, "GET", `/api/executions/${run.executionId}`, cookie);
      expect(history.statusCode, history.body).toBe(200);
      expect(history.body).toContain(token);
      expect(history.body).not.toContain(EMAIL);
    }

    const sql = testSql(context.store);
    const row = await sql.get<{ project_id: string | null; execution_id: string | null }>(`SELECT project_id, execution_id FROM guard_token_vault WHERE token = ?`, token);
    expect(row).toMatchObject({ project_id: "default", execution_id: protect.executionId });

    const events = (await call(context, "GET", `/api/guard/events?action=reveal`, admin)).json<{ events: Array<Record<string, any>> }>().events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ placement: "reveal", channel: "reveal", nodeId: "reveal", dataClass: "email", requestedAction: "reveal", effectiveAction: "reveal", verdictAction: "reveal", profileId: "support" });
    expect(JSON.stringify(events)).not.toContain(EMAIL);
    expect(JSON.stringify(events)).not.toContain(token);
    const audit = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "success", resourceId: workflow.id, projectId: "default", actorType: "user" });
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
    // The entry reaches log streaming like every other audit entry.
    expect(dispatched.mock.calls.map(([event]) => (event as { eventType?: string }).eventType)).toContain("content_rules.reveal");
    dispatched.mockRestore();

    // A webhook run acts as the workflow's owner, not a signed-in person: the admin role rule never matches it.
    const hook = await context.app.inject({ method: "POST", url: `/webhook/hook-${workflow.id}`, payload: { user_prompt: `Mail ${token} today` } });
    expect(hook.statusCode, hook.body).toBe(200);
    const refused = (await call(context, "GET", `/api/guard/events?action=block`, admin)).json<{ events: Array<Record<string, any>> }>().events.filter((event) => event.placement === "reveal");
    expect(refused).toEqual([expect.objectContaining({ dataClass: "email", requestedAction: "reveal", effectiveAction: "block" })]);
    expect(hook.body).not.toContain(EMAIL);
    const denied = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", outcome: "denied", pageSize: 10 })).items;
    expect(denied).toHaveLength(1);
    // Nobody started that run: the system is the actor.
    expect(denied[0]).toMatchObject({ actorType: "system" });
  });

  it("uses only rule sets bound to the run: a node naming an unbound rule set reveals nothing", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { token } = await setUp(context, admin, { bind: false });
    await context.store.upsertWorkflow(revealWorkflow("wf-named", { profileId: "support" }));
    for (const id of ["wf-reveal", "wf-named"]) {
      const run = (await call(context, "POST", `/api/workflows/${id}/execute`, admin, { user_prompt: `Mail ${token} today` })).json<RunResult>();
      expect(run.status, run.error).toBe("success");
      expect(outputOf(run, "reveal").reveal.revealed).toEqual([]);
      expect(outputOf(run, "reveal").reveal.refused).toEqual([expect.objectContaining({ dataClass: "email", reason: "no_rule" })]);
    }
  });

  it("asks another admin to approve: the person who started the run cannot approve their own reveal", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const other = await login(context, "admin", "second-admin@example.com");
    const approval = { ...SUPPORT_RULES, id: "approval", name: "Approval", reveal: { rules: [{ dataClasses: ["email"], subjects: { roles: ["admin"] }, requireApproval: true }] } };
    const { token, workflow } = await setUp(context, admin, { rules: approval });
    const run = (await call(context, "POST", `/api/workflows/${workflow.id}/execute`, admin, { user_prompt: `Mail ${token} today` })).json<RunResult>();
    expect(run.status, run.error).toBe("waiting_approval");
    const pending = (await call(context, "GET", "/api/approvals", other)).json<{ items: Array<Record<string, any>> }>().items;
    expect(pending).toEqual([expect.objectContaining({ executionId: run.executionId, kind: "guard", allowSelfApproval: false, approverRoles: ["admin"], requireRejectReason: true })]);
    expect((await call(context, "POST", `/api/approvals/${run.executionId}/approve`, admin, {})).statusCode).toBe(403);
    const approved = await call(context, "POST", `/api/approvals/${run.executionId}/approve`, other, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.body).not.toContain(EMAIL);
    const history = await call(context, "GET", `/api/executions/${run.executionId}`, admin);
    expect(history.json<RunResult>().status).toBe("success");
    expect(history.body).not.toContain(EMAIL);
    const audit = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    // The approver as the approval records them.
    expect(audit[0]!.metadata).toMatchObject({ approved: true, approvedBy: "second-admin@example.com" });
  });

  it("keeps a run that revealed values out of replay capture", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { token, workflow } = await setUp(context, admin);
    expect((await call(context, "PUT", `/api/workflows/${workflow.id}/replay-capture`, admin, { enabled: true, rate: 1, maxPerDay: 10 })).statusCode).toBe(200);
    const key = (await call(context, "POST", "/api/auth/api-keys", admin, { name: "CI" })).json<{ key: string }>().key;
    const viaKey = (payload: unknown) =>
      context.app.inject({ method: "POST", url: `/api/workflows/${workflow.id}/execute`, headers: { authorization: `Bearer ${key}` }, payload: payload as object });
    const revealing = await viaKey({ user_prompt: `Mail ${token} today` });
    expect(revealing.statusCode, revealing.body).toBe(200);
    expect(revealing.json<RunResult>().nodeResults.find((entry) => entry.nodeId === "reveal")?.output?.reveal.revealed).toHaveLength(1);
    const plain = await viaKey({ user_prompt: "Nothing to reveal" });
    expect(plain.statusCode, plain.body).toBe(200);
    const until = Date.now() + 20_000;
    let items: Array<{ sourceExecutionId?: string; executionId?: string }> = [];
    while (Date.now() < until) {
      items = (await call(context, "GET", `/api/workflows/${workflow.id}/replay-captures`, admin)).json<{ items: typeof items }>().items;
      if (items.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    items = (await call(context, "GET", `/api/workflows/${workflow.id}/replay-captures`, admin)).json<{ items: typeof items }>().items;
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).toContain(plain.json<RunResult>().executionId!);
    expect(JSON.stringify(items)).not.toContain(revealing.json<RunResult>().executionId!);
  });

  it("refuses a builder's save of a rule set with reveal rules", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder");
    const saved = await call(context, "POST", "/api/guard/profiles", builder, { id: "support", document: SUPPORT_RULES });
    expect(saved.statusCode).toBe(403);
  });
});

describe("Reveal and service accounts", () => {
  const rulesFor = (subjects: Record<string, unknown>) => ({ ...SUPPORT_RULES, reveal: { rules: [{ name: "Bots", dataClasses: ["email"], subjects }] } });

  async function serviceAccount(context: TestContext, admin: string) {
    const created = await call(context, "POST", "/api/service-accounts", admin, { name: "crm-bot", role: "admin", description: "CRM sync" });
    expect(created.statusCode, created.body).toBe(201);
    const account = created.json<{ serviceAccount: { id: string; email: string } }>().serviceAccount;
    const issued = await call(context, "POST", `/api/service-accounts/${account.id}/keys`, admin, { name: "ci" });
    expect(issued.statusCode, issued.body).toBe(201);
    const key = issued.json<{ key: string; record: { id: string } }>();
    return { account, key: key.key, keyId: key.record.id };
  }

  const viaKey = (context: TestContext, key: string, url: string, payload: unknown) =>
    context.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` }, payload: payload as object });

  it("an admin-role service account's key run never matches role rules or reveals older tokens, but matches a rule naming it", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { account, key, keyId } = await serviceAccount(context, admin);
    const { token, workflow } = await setUp(context, admin, { rules: { ...rulesFor({ roles: ["admin"] }), id: "bots" } });
    // A token issued before tokens were scoped to a project (a signed-in admin's run could reveal it).
    const legacy = new GuardService(context.store, new SecretService(context.store, context.config.SECRET_MASTER_KEY_BASE64));
    await legacy.vault.put({ token: "tok_email_LLLLLLLLLLLLLLLL", dataClass: "email", value: "legacy@example.org", createdAt: new Date().toISOString() });

    const byRole = (await viaKey(context, key, `/api/workflows/${workflow.id}/execute`, { user_prompt: `Mail ${token}` })).json<RunResult>();
    expect(byRole.status, byRole.error).toBe("success");
    expect(outputOf(byRole, "reveal").reveal.revealed).toEqual([]);
    expect(outputOf(byRole, "reveal").reveal.refused).toEqual([expect.objectContaining({ reason: "no_rule" })]);

    const named = await call(context, "PUT", "/api/guard/profiles/bots", admin, { document: { ...rulesFor({ serviceAccounts: [account.id] }), id: "bots" } });
    expect(named.statusCode, named.body).toBe(200);
    const byId = (await viaKey(context, key, `/api/workflows/${workflow.id}/execute`, { user_prompt: `Mail ${token} and tok_email_LLLLLLLLLLLLLLLL` })).json<RunResult>();
    expect(byId.status, byId.error).toBe("success");
    expect(outputOf(byId, "reveal").reveal.revealed).toEqual([expect.objectContaining({ dataClass: "email", count: 1 })]);
    expect(outputOf(byId, "reveal").reveal.refused).toEqual([expect.objectContaining({ reason: "unscoped_token" })]);
    const audit = (await context.store.listAuditLogs({ eventType: "content_rules.reveal", outcome: "success", pageSize: 10 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "user", actorUserId: account.id });
    expect(audit[0]!.metadata).toMatchObject({ actorServiceAccount: true, actorApiKeyId: keyId, subject: { source: "service_account", serviceAccountId: account.id } });
  });

  it("marks a service account's queued run from the stored account kind", async () => {
    const context = await createTestContext({ queue: true });
    const admin = await login(context, "admin");
    const { account, key } = await serviceAccount(context, admin);
    const { token, workflow } = await setUp(context, admin, { rules: { ...rulesFor({ roles: ["admin"] }), id: "bots" } });
    const run = async () => {
      const enqueued = await viaKey(context, key, `/api/workflows/${workflow.id}/enqueue`, { userPrompt: `Mail ${token}` });
      expect(enqueued.statusCode, enqueued.body).toBe(200);
      const executionId = enqueued.json<{ executionId: string }>().executionId;
      const until = Date.now() + 20_000;
      for (;;) {
        const history = await context.store.getExecutionHistory(executionId);
        if (history && ["success", "error"].includes(history.status)) return history;
        if (Date.now() > until) throw new Error("The queued run did not finish");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const reveal = (history: { nodeResults: unknown }) => (history.nodeResults as Array<{ nodeId: string; output?: Record<string, any> }>).find((entry) => entry.nodeId === "reveal")?.output?.reveal;
    // The admin role rule never matches the service account's queued run.
    const byRole = await run();
    expect(byRole.status).toBe("success");
    expect(reveal(byRole)).toMatchObject({ revealed: [], refused: [expect.objectContaining({ reason: "no_rule" })] });
    expect(JSON.stringify(byRole)).not.toContain(EMAIL);
    // A rule naming it does.
    expect((await call(context, "PUT", "/api/guard/profiles/bots", admin, { document: { ...rulesFor({ serviceAccounts: [account.id] }), id: "bots" } })).statusCode).toBe(200);
    const byId = await run();
    expect(reveal(byId).revealed).toEqual([expect.objectContaining({ dataClass: "email", count: 1 })]);
    expect(JSON.stringify(byId)).not.toContain(EMAIL);
  });

  it("refuses reveal rules that list a service account as a user or a person as a service account", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin");
    const { account } = await serviceAccount(context, admin);
    const adminId = (await context.store.getUserByEmail("admin@example.com"))!.id;
    const asUser = await call(context, "POST", "/api/guard/profiles", admin, { id: "bad-user", document: { ...rulesFor({ users: [account.id] }), id: "bad-user" } });
    expect(asUser.statusCode).toBe(400);
    expect(asUser.json<{ error: string }>().error).toContain("is a service account");
    const asAccount = await call(context, "POST", "/api/guard/profiles", admin, { id: "bad-account", document: { ...rulesFor({ serviceAccounts: [adminId] }), id: "bad-account" } });
    expect(asAccount.statusCode).toBe(400);
    expect(asAccount.json<{ error: string }>().error).toContain("is not a service account");
    const fine = await call(context, "POST", "/api/guard/profiles", admin, { id: "good", document: { ...rulesFor({ users: [adminId], serviceAccounts: [account.id] }), id: "good" } });
    expect(fine.statusCode, fine.body).toBe(201);
  });
});

describe("resolveMcpToolPolicySubject and service accounts", () => {
  const users = new Map([
    ["sa-1", { id: "sa-1", email: "renamed-bot@example.com", role: "admin", kind: "service" }],
    ["u-1", { id: "u-1", email: "ana@example.com", role: "admin", kind: "human" }]
  ]);
  const store = { getWorkflowCreatedBy: async () => "sa-1", getUserById: async (id: string) => users.get(id) ?? null };

  it("marks a run a service account started from its stored kind, whatever the actor carries", async () => {
    expect(await resolveMcpToolPolicySubject(store, "wf", { id: "sa-1", email: "renamed-bot@example.com", role: "admin", apiKeyId: "key-1" })).toEqual({
      role: "admin",
      source: "user",
      userId: "sa-1",
      email: "renamed-bot@example.com",
      apiKeyId: "key-1",
      serviceAccountId: "sa-1"
    });
    expect((await resolveMcpToolPolicySubject(store, "wf", { id: "u-1", email: "ana@example.com", role: "admin" })).serviceAccountId).toBeUndefined();
  });

  it("leaves the owner's run of a workflow a service account created unmarked (webhook, schedule)", async () => {
    const subject = await resolveMcpToolPolicySubject(store, "wf", null);
    expect(subject).toMatchObject({ source: "owner", userId: "sa-1" });
    expect(subject.serviceAccountId).toBeUndefined();
  });
});

describe("GuardService reveal wiring", () => {
  async function service() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-reveal-svc-"));
    dirs.push(dir);
    const store = await openTestStore(path.join(dir, "db.sqlite"));
    await store.ensureDefaultProject();
    const secrets = new SecretService(store, crypto.randomBytes(32).toString("base64"));
    const audits: Array<Record<string, unknown>> = [];
    const guard = new GuardService(store, secrets, { autoApply: false, audit: async (event) => audits.push(event as unknown as Record<string, unknown>) });
    await guard.ensureBuiltIns();
    return { store, guard, audits };
  }

  it("scopes a run's vault writes to its project and run, and reads them back", async () => {
    const { guard } = await service();
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "proj-a", executionId: "exec-1" });
    await runtime.vault!.put({ token: "tok_email_AAAAAAAAAAAAAAAA", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await runtime.vault!.getByToken("tok_email_AAAAAAAAAAAAAAAA")).toMatchObject({ value: EMAIL, projectId: "proj-a", executionId: "exec-1" });
    await guard.vault.put({ token: "tok_email_BBBBBBBBBBBBBBBB", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await guard.vault.getByToken("tok_email_BBBBBBBBBBBBBBBB")).toMatchObject({ projectId: null, executionId: null });
    expect(runtime.projectId).toBe("proj-a");
    expect(runtime.onReveal).toBeTypeOf("function");
    expect(runtime.revealDisabled).toBeUndefined();
  });

  it("tags tokens a project-less gateway toolset or route set issues with a scope no workflow run matches", async () => {
    const { guard } = await service();
    const resolution = { source: "none" as const, stack: [], chain: [] };
    const runtime = guard.gatewayRuntime({ executionId: "mcpgw_1", toolsetId: "ts-1", clientId: "c-1", projectId: null }, resolution);
    await runtime.vault!.put({ token: "tok_email_GGGGGGGGGGGGGGGG", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await runtime.vault!.getByToken("tok_email_GGGGGGGGGGGGGGGG")).toMatchObject({ projectId: "gateway:ts-1" });
    expect(runtime.revealDisabled).toBe(true);
    const scoped = guard.gatewayRuntime({ executionId: "mcpgw_2", toolsetId: "ts-2", clientId: "c-1", projectId: "proj-a" }, resolution);
    await scoped.vault!.put({ token: "tok_email_HHHHHHHHHHHHHHHH", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await scoped.vault!.getByToken("tok_email_HHHHHHHHHHHHHHHH")).toMatchObject({ projectId: "proj-a" });
  });

  it("scopes a sub-workflow in another project to that project, with reveal off", async () => {
    const { guard } = await service();
    const runtime = guard.runtimeFor({ workflowId: "wf", projectId: "proj-a", executionId: "exec-1" });
    expect(runtime.forWorkflow!({ id: "child", projectId: "proj-a" })).toBe(runtime);
    const child = runtime.forWorkflow!({ id: "child", projectId: "proj-b" });
    expect(child).toMatchObject({ projectId: "proj-b", revealDisabled: true });
    expect(child.onReveal).toBeUndefined();
    await child.vault!.put({ token: "tok_email_IIIIIIIIIIIIIIII", dataClass: "email", value: EMAIL, createdAt: new Date().toISOString() });
    expect(await child.vault!.getByToken("tok_email_IIIIIIIIIIIIIIII")).toMatchObject({ projectId: "proj-b", executionId: "exec-1" });
    // A grandchild back in the run's project still never reveals under the child's scope.
    expect(child.forWorkflow!({ id: "grandchild", projectId: null }).revealDisabled).toBe(true);
  });

  it("writes no reveal events when the audit entry cannot be written, and audits unattended runs as the system", async () => {
    const { store, guard } = await service();
    const failing = new GuardService(store, new SecretService(store, crypto.randomBytes(32).toString("base64")), {
      autoApply: false,
      audit: async () => {
        throw new Error("audit down");
      }
    });
    const event = {
      executionId: "exec-a",
      workflowId: "wf",
      nodeId: "reveal",
      subject: { source: "owner", role: "admin", userId: "u-owner" },
      profiles: [{ profileId: "default", version: 1, hash: "h1" }],
      revealed: [],
      refused: [{ dataClass: "email", count: 1, tokenHashes: ["aaaa"], reason: "no_rule" as const }],
      approved: false
    };
    await expect(failing.recordReveal(event, { workflowId: "wf", projectId: "proj-a", executionId: "exec-a" })).rejects.toThrow("audit down");
    expect((await guard.listEvents({ executionId: "exec-a" })).events).toHaveLength(0);
  });

  it("turns reveal off for simulations, candidate rule set runs (replays) and eval runs", async () => {
    const { guard } = await service();
    const simulation = { sink: new GuardSimulationSink(), vault: new GuardSimulationVault() };
    for (const context of [
      { workflowId: "wf", simulation },
      { workflowId: "wf", profileOverride: { profileId: "default" } },
      { workflowId: "wf", runSource: "eval" as const }
    ]) {
      const runtime = guard.runtimeFor(context);
      expect(runtime.revealDisabled).toBe(true);
      expect(runtime.onReveal).toBeUndefined();
    }
  });

  it("records revealed and refused classes as reveal events with hashes, and audits the step", async () => {
    const { guard, audits } = await service();
    await guard.recordReveal(
      {
        executionId: "exec-9",
        workflowId: "wf",
        nodeId: "reveal",
        subject: { source: "user", role: "admin", userId: "u-1" },
        profiles: [{ profileId: "default", version: 1, hash: "h1" }],
        revealed: [{ dataClass: "email", count: 2, tokenHashes: ["aaaa", "bbbb"], rule: { profileId: "default", version: 1, index: 0 } }],
        refused: [{ dataClass: "card_number", count: 1, tokenHashes: ["cccc"], reason: "other_project" }],
        approved: false
      },
      { workflowId: "wf", projectId: "proj-a", executionId: "exec-9" }
    );
    const { events } = await guard.listEvents({ executionId: "exec-9" });
    expect(events.map((event) => [event.dataClass, event.effectiveAction, event.verdictAction])).toEqual(
      expect.arrayContaining([
        ["email", "reveal", "reveal"],
        ["card_number", "block", "reveal"]
      ])
    );
    const email = events.find((event) => event.dataClass === "email")!;
    expect(email.evidence.map((entry) => entry.evidence)).toEqual(["sha256:aaaa", "sha256:bbbb"]);
    expect(email.profileHash).toBe("h1");
    expect(audits).toEqual([expect.objectContaining({ eventType: "content_rules.reveal", outcome: "success", projectId: "proj-a", actor: { type: "user", userId: "u-1" } })]);
    // A run nobody signed in to start (webhook, schedule): the system acts, the subject is in the metadata.
    await guard.recordReveal(
      {
        executionId: "exec-10",
        workflowId: "wf",
        nodeId: "reveal",
        subject: { source: "owner", role: "admin", userId: "u-owner" },
        profiles: [{ profileId: "default", version: 1, hash: "h1" }],
        revealed: [],
        refused: [{ dataClass: "email", count: 1, tokenHashes: ["dddd"], reason: "no_rule" }],
        approved: false
      },
      { workflowId: "wf", projectId: "proj-a", executionId: "exec-10" }
    );
    expect(audits[1]).toMatchObject({ outcome: "denied", actor: { type: "system" }, metadata: { subject: { source: "owner", userId: "u-owner" } } });
    const stats = await guard.stats({ executionId: "exec-9" });
    expect(stats.verdicts).toEqual([{ key: "reveal", count: 1 }]);
  });
});
