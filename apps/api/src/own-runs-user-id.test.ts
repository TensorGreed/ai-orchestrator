/**
 * v80 — own runs by user id. A run records the id of the person who started it (`triggered_by_user_id`), and "their own
 * runs" (a person who has a workflow only through a share with them) is judged by that id and the session owner only:
 * an email never counts (after the v80 upgrade a background job sets the id on the runs recorded before;
 * db/execution-starter-v80-upgrade.test.ts).
 * An approver's resume changes neither the id nor "started by"; the approver is on the decision. Signed-in form
 * submissions and chats are the submitter's own runs. Release history and the publish preview leave out what comes
 * from other people's runs (gate reasons, figures, the replay job) for such a person.
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
import { QueueService } from "./services/queue-service.js";
import { SecretService } from "./services/secret-service.js";
import { WorkflowVersionService } from "./services/workflow-version-service.js";
import { testSql } from "./test-support/test-sql.js";
import { openTestStore } from "./test-support/test-store.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(options: { queue?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-own-runs-id-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    PROJECT_ISOLATION: "strict",
    GIT_SYNC_WORKDIR: path.join(tempDir, "git")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const queue = options.queue === true ? new QueueService(store, { pollIntervalMs: 3_600_000 }) : undefined;
  const app = await createApp(config, store, secretService, authService, undefined, queue);
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
interface Person {
  cookie: string;
  id: string;
  email: string;
}

async function login(context: TestContext, role: Role, name: string): Promise<Person> {
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

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function echoWorkflow(id: string, trigger: { type: string; config: Record<string, unknown> } = { type: "manual_trigger", config: {} }): Workflow {
  return {
    id,
    name: `Echo ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "team",
    nodes: [
      { id: "start", type: trigger.type, name: "Start", position: { x: 0, y: 0 }, config: trigger.config },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  } as Workflow;
}

function gatedWorkflow(id: string): Workflow {
  return {
    ...echoWorkflow(id),
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      {
        id: "gate",
        type: "approval_gate",
        name: "Gate",
        position: { x: 200, y: 0 },
        config: { message: "Go on?", approverRoles: ["operator", "builder", "admin"], allowSelfApproval: true, timeoutMinutes: 60, timeoutOutcome: "fallback" }
      },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "done" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "gate" },
      { id: "e2", source: "gate", sourceHandle: "approved", target: "out" }
    ]
  };
}

/** Project "team" (Owen is its admin) with wf-team and wf-gated; Olivia (operator) has both only through a share. */
async function seed(options: { queue?: boolean } = {}) {
  const context = await createTestContext(options);
  const admin = await login(context, "admin", "ada");
  const owner = await login(context, "builder", "owen");
  const olivia = await login(context, "operator", "olivia");
  await context.store.upsertProject({ id: "team", name: "Team" });
  await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
  await context.store.upsertWorkflow(echoWorkflow("wf-team"));
  await context.store.upsertWorkflow(gatedWorkflow("wf-gated"));
  const share = async (person: Person, workflowId: string, accessLevel: "read" | "execute" = "execute") => {
    const shared = await call(context, "POST", `/api/workflows/${workflowId}/user-shares`, owner.cookie, { email: person.email, accessLevel });
    expect(shared.statusCode, shared.body).toBeLessThan(300);
  };
  for (const workflowId of ["wf-team", "wf-gated"]) await share(olivia, workflowId);
  const run = async (person: Person, workflowId = "wf-team"): Promise<string> => {
    const response = await call(context, "POST", `/api/workflows/${workflowId}/execute`, person.cookie, { input: {} });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ executionId: string }>().executionId;
  };
  return { context, admin, owner, olivia, share, run };
}

const listRuns = async (context: TestContext, person: Person, query = "") => {
  const response = await call(context, "GET", `/api/executions${query}`, person.cookie);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ items: Array<{ id: string }>; total: number }>();
  return { ids: body.items.map((item) => item.id).sort(), total: body.total };
};

const inbox = async (context: TestContext, person: Person) =>
  (await call(context, "GET", "/api/approvals?status=all", person.cookie)).json<{ items: Array<{ executionId: string }> }>().items.map((item) => item.executionId).sort();

describe("own runs by user id (v80)", () => {
  it("every run a signed-in person starts records their user id", async () => {
    const { context, owner, olivia, run } = await seed();
    const own = await run(olivia);
    expect(await context.store.getExecutionStarter(own)).toBe(olivia.id);
    expect(await context.store.getExecutionStarter(await run(owner))).toBe(owner.id);
    // The manual trigger route as well (builders and up).
    const manual = await call(context, "POST", "/api/triggers/manual/wf-team", owner.cookie, {});
    expect(manual.statusCode, manual.body).toBe(200);
    expect(await context.store.getExecutionStarter(manual.json<{ executionId: string }>().executionId)).toBe(owner.id);
    expect(await context.store.getExecutionStarter("no-such-run")).toBeNull();
  });

  it("a deleted account's runs stay hidden from a new account with the same email", async () => {
    const { context, admin, olivia, share, run } = await seed();
    const oldRun = await run(olivia);
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    expect(paused.json<{ status: string }>().status, paused.body).toBe("waiting_approval");
    const oldPaused = paused.json<{ executionId: string }>().executionId;
    // A run with only their email (no starter's user id): nobody's own run, not even theirs.
    const legacyAt = new Date().toISOString();
    await context.store.saveExecutionHistory({ id: "run-legacy", workflowId: "wf-team", status: "success", startedAt: legacyAt, completedAt: legacyAt, triggerType: "manual", triggeredBy: olivia.email });
    expect((await listRuns(context, olivia)).ids).toEqual([oldPaused, oldRun].sort());

    expect(await context.store.deleteUserKeepingAdmin(olivia.id)).not.toBe("not_found");
    await pause(5);
    const again = await login(context, "operator", "olivia");
    expect(again.id).not.toBe(olivia.id);
    for (const workflowId of ["wf-team", "wf-gated"]) await share(again, workflowId);

    expect(await listRuns(context, again)).toEqual({ ids: [], total: 0 });
    for (const id of [oldRun, oldPaused, "run-legacy"]) {
      expect((await call(context, "GET", `/api/executions/${id}`, again.cookie)).statusCode, id).toBe(404);
    }
    expect(await inbox(context, again)).toEqual([]);
    expect((await call(context, "POST", `/api/approvals/${oldPaused}/approve`, again.cookie, {})).statusCode).toBe(404);
    // Their new runs are theirs; an admin still sees everything.
    const fresh = await run(again);
    expect(await listRuns(context, again)).toEqual({ ids: [fresh], total: 1 });
    expect((await listRuns(context, admin)).total).toBe(4);
  });

  it("a run is the person's by its starter's user id only, never by its email or triggered_by", async () => {
    const { context, olivia } = await seed();
    const now = new Date().toISOString();
    const save = async (id: string, triggeredBy: string, triggeredByUserId?: string) =>
      await context.store.saveExecutionHistory({ id, workflowId: "wf-team", status: "success", startedAt: now, completedAt: now, triggerType: "manual", triggeredBy, ...(triggeredByUserId ? { triggeredByUserId } : {}) });
    await save("run-email", olivia.email.toUpperCase());
    await save("run-id-text", olivia.id);
    await save("run-other-id", olivia.email, "usr_someone_else");
    await save("run-hers", "approver@example.com", olivia.id);
    expect((await listRuns(context, olivia)).ids).toEqual(["run-hers"]);
    for (const id of ["run-email", "run-id-text", "run-other-id"]) {
      expect((await call(context, "GET", `/api/executions/${id}`, olivia.cookie)).statusCode, id).toBe(404);
    }
    expect((await call(context, "GET", "/api/executions/run-hers", olivia.cookie)).statusCode).toBe(200);
  });

  it("a run resumed by someone else's approval stays the starter's", async () => {
    const { context, owner, olivia } = await seed();
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    const executionId = paused.json<{ executionId: string }>().executionId;
    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, owner.cookie, {});
    expect(approved.statusCode, approved.body).toBeLessThan(300);
    const finished = await context.store.getExecutionHistory(executionId);
    expect(finished?.status).toBe("success");
    expect(await context.store.getExecutionStarter(executionId)).toBe(olivia.id);
    expect((await listRuns(context, olivia)).ids).toEqual([executionId]);
    // "Started by" stays Olivia (the run list, its detail); the approver is on the decision.
    expect(finished?.triggeredBy).toBe(olivia.email);
    const listed = (await call(context, "GET", "/api/executions", owner.cookie)).json<{ items: Array<{ id: string; triggeredBy?: string | null }> }>();
    expect(listed.items.find((item) => item.id === executionId)?.triggeredBy).toBe(olivia.email);
    const [decision] = await context.store.listApprovalRequestsForExecution(executionId);
    expect(decision).toMatchObject({ status: "approved", decidedBy: owner.email, decidedByUserId: owner.id, requestedBy: olivia.email });
    // The run's audit entries name its starter; the decision's names the approver.
    const audit = await context.store.listAuditLogsForExecution(executionId);
    expect(audit.filter((entry) => entry.eventType === "execution.success").map((entry) => entry.actorEmail)).toEqual([olivia.email]);
    expect(audit.filter((entry) => entry.eventType === "approval.decided").map((entry) => entry.actorEmail)).toEqual([owner.email]);
  });

  it("a run paused before v80 with no history row resumes as its first requester's, by the rule migration 80 follows", async () => {
    const { context, owner, olivia } = await seed();
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    const executionId = paused.json<{ executionId: string }>().executionId;
    // As an older build could leave it: a paused state without the starter, naming an earlier approver as its
    // triggered_by (it paused again after a resume), and no history row yet. The first request names Olivia.
    const state = (await context.store.getWorkflowExecutionState(executionId))!;
    const { triggeredByUserId: _dropped, ...olderState } = state.state as Record<string, unknown>;
    await context.store.saveWorkflowExecutionState({ ...state, triggeredBy: owner.email, state: olderState } as never);
    await testSql(context.store).run("DELETE FROM execution_history WHERE id = ?", executionId);
    expect(await context.store.getExecutionHistory(executionId)).toBeNull();

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, owner.cookie, {});
    expect(approved.statusCode, approved.body).toBeLessThan(300);
    const finished = await context.store.getExecutionHistory(executionId);
    expect(finished?.status).toBe("success");
    expect(finished?.triggeredBy).toBe(olivia.email);
    // Her account is older than the run, so the email names her.
    expect(await context.store.getExecutionStarter(executionId)).toBe(olivia.id);
    expect((await listRuns(context, olivia)).ids).toEqual([executionId]);
  });

  it("a paused run whose history records no starter (migration 80 could tell nobody) stays nobody's after the resume", async () => {
    const { context, owner, olivia } = await seed();
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    const executionId = paused.json<{ executionId: string }>().executionId;
    const state = (await context.store.getWorkflowExecutionState(executionId))!;
    // Nor whose sessions it used (a run that kept the workflow's sessions).
    const { triggeredByUserId: _dropped, sessionOwner: _owner, ...olderState } = state.state as Record<string, unknown>;
    await context.store.saveWorkflowExecutionState({ ...state, state: olderState } as never);
    await testSql(context.store).run("UPDATE execution_history SET triggered_by_user_id = NULL, session_owner = NULL WHERE id = ?", executionId);

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, owner.cookie, {});
    expect(approved.statusCode, approved.body).toBeLessThan(300);
    expect((await context.store.getExecutionHistory(executionId))?.status).toBe("success");
    // Not re-judged by its email at the resume, and never the approver's.
    expect(await context.store.getExecutionStarter(executionId)).toBeNull();
    expect((await listRuns(context, olivia)).ids).toEqual([]);
  });

  it("a run paused before the upgrade that the background fill has not reached yet resumes as its starter's, by the fill's rule", async () => {
    const { context, owner, olivia } = await seed();
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    const executionId = paused.json<{ executionId: string }>().executionId;
    const state = (await context.store.getWorkflowExecutionState(executionId))!;
    const { triggeredByUserId: _dropped, ...olderState } = state.state as Record<string, unknown>;
    await context.store.saveWorkflowExecutionState({ ...state, state: olderState } as never);
    await testSql(context.store).run("UPDATE execution_history SET triggered_by_user_id = NULL WHERE id = ?", executionId);
    // The fill is still to reach it.
    await testSql(context.store).run("DELETE FROM schema_markers WHERE name = 'execution_starter_backfill'");
    await testSql(context.store).run("INSERT INTO schema_markers (name, created_at) VALUES ('execution_starter_fill_upto:1000000', ?)", new Date().toISOString());
    expect((await context.store.getExecutionStarterFill()).done).toBe(false);
    expect((await listRuns(context, olivia)).ids).toEqual([]);

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, owner.cookie, {});
    expect(approved.statusCode, approved.body).toBeLessThan(300);
    expect((await context.store.getExecutionHistory(executionId))?.status).toBe("success");
    expect(await context.store.getExecutionStarter(executionId)).toBe(olivia.id);
    expect((await listRuns(context, olivia)).ids).toEqual([executionId]);
  });

  it("a retry of a run whose starter's account is gone, with no session owner recorded, is refused", async () => {
    const { context, owner } = await seed();
    const now = new Date().toISOString();
    await context.store.saveExecutionHistory({ id: "run-of-gone", workflowId: "wf-team", status: "error", startedAt: now, completedAt: now, triggerType: "manual", triggeredBy: "gone@example.com", triggeredByUserId: "usr_gone", inputJson: {}, error: "boom" });
    const retried = await call(context, "POST", "/api/executions/run-of-gone/retry", owner.cookie, {});
    expect(retried.statusCode, retried.body).toBe(409);
  });

  it("a queued run's record carries the starter's id", async () => {
    const { context, olivia, run } = await seed({ queue: true });
    const executionId = await run(olivia);
    expect(await context.store.getExecutionStarter(executionId)).toBe(olivia.id);
  });
});

describe("signed-in forms and chats", () => {
  it("a signed-in form submission is the submitter's own run, in their own sessions", async () => {
    const { context, owner, olivia, share } = await seed();
    await context.store.upsertWorkflow(echoWorkflow("wf-form", { type: "form_trigger", config: { path: "team-intake", authMode: "session", fields: [{ name: "note", type: "text" }] } }));
    await share(olivia, "wf-form", "read");
    const submitted = await call(context, "POST", "/api/forms/team-intake", olivia.cookie, { note: "hello" });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const executionId = submitted.json<{ executionId: string }>().executionId;
    expect(await context.store.getExecutionStarter(executionId)).toBe(olivia.id);
    expect(await context.store.getExecutionSessionOwner(executionId)).toBe(olivia.id);
    expect(await listRuns(context, olivia, "?workflowId=wf-form")).toEqual({ ids: [executionId], total: 1 });
    expect((await call(context, "GET", `/api/executions/${executionId}`, olivia.cookie)).statusCode).toBe(200);
    // The project's admin submits too: their run is theirs and stays hidden from Olivia.
    const owners = await call(context, "POST", "/api/forms/team-intake", owner.cookie, { note: "mine" });
    const ownersRun = owners.json<{ executionId: string }>().executionId;
    expect(await context.store.getExecutionStarter(ownersRun)).toBe(owner.id);
    expect((await call(context, "GET", `/api/executions/${ownersRun}`, olivia.cookie)).statusCode).toBe(404);
  });

  it("a public form submission records no person", async () => {
    const { context, owner } = await seed();
    await context.store.upsertWorkflow(echoWorkflow("wf-public-form", { type: "form_trigger", config: { path: "public-intake", fields: [{ name: "note", type: "text" }] } }));
    const submitted = await context.app.inject({ method: "POST", url: "/api/forms/public-intake", payload: { note: "hi" } });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const executionId = submitted.json<{ executionId: string }>().executionId;
    expect(await context.store.getExecutionStarter(executionId)).toBeNull();
    expect(await context.store.getExecutionSessionOwner(executionId)).toBeNull();
    expect((await listRuns(context, owner, "?workflowId=wf-public-form")).total).toBe(1);
  });

  it("a signed-in chat records the person who chatted", async () => {
    const { context, olivia, share } = await seed();
    await context.store.upsertWorkflow(echoWorkflow("wf-chat", { type: "chat_trigger", config: { authMode: "session" } }));
    await share(olivia, "wf-chat", "read");
    const said = await call(context, "POST", "/api/chat/wf-chat", olivia.cookie, { message: "hi" });
    expect(said.statusCode, said.body).toBe(200);
    const runs = await listRuns(context, olivia, "?workflowId=wf-chat");
    expect(runs.total).toBe(1);
    expect(await context.store.getExecutionStarter(runs.ids[0]!)).toBe(olivia.id);
  });
});

describe("release history and the publish preview for someone who sees only their own runs", () => {
  it("leave out the gate's reasons, figures and replay job; project members still see them", async () => {
    const { context, admin, owner, olivia } = await seed();
    const versions = new WorkflowVersionService(context.store);
    const hook = (result: string): Workflow => ({ ...echoWorkflow("wf-team"), nodes: [echoWorkflow("wf-team").nodes[0]!, { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: result } }] });
    await versions.snapshot({ workflow: await context.store.upsertWorkflow(hook("one")), changeNote: "v1" });
    await context.store.createEvalDataset({ id: "set-team", name: "Golden team", workflowId: "wf-team" });
    await context.store.createEvalFixture({ id: "fx-refund", datasetId: "set-team", name: "Refund over 100", input: {} });
    const gate = await call(context, "PUT", "/api/workflows/wf-team/release-gate", owner.cookie, { enabled: true, datasetIds: ["set-team"] });
    expect(gate.statusCode, gate.body).toBe(200);
    const v2 = (await versions.snapshot({ workflow: await context.store.upsertWorkflow(hook("two")), changeNote: "v2" })).version;
    const overridden = await call(context, "POST", "/api/workflows/wf-team/publish", admin.cookie, { version: v2, override: { reason: "Hotfix" } });
    expect(overridden.statusCode, overridden.body).toBe(200);

    const preview = async (person: Person) => {
      const response = await call(context, "GET", `/api/workflows/wf-team/publish-preview?version=${v2}`, person.cookie);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ preview: { verdict: string; reasons: string[]; stats: unknown; replayRunId: string | null; detailsHidden?: boolean } }>().preview;
    };
    const full = await preview(owner);
    expect(full.reasons.length).toBeGreaterThan(0);
    expect(full.stats).not.toBeNull();
    expect(full.detailsHidden).toBeUndefined();
    const hidden = await preview(olivia);
    expect(hidden).toMatchObject({ verdict: full.verdict, reasons: [], stats: null, replayRunId: null, detailsHidden: true });

    const history = async (person: Person) => {
      const response = await call(context, "GET", "/api/workflows/wf-team/releases", person.cookie);
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ releases: Array<{ version: number; gateReasons: string[]; replayRunId: string | null; reason: string | null }>; detailsHidden?: boolean }>();
    };
    const ownersView = await history(owner);
    expect(ownersView.releases.find((release) => release.version === v2)?.gateReasons.length).toBeGreaterThan(0);
    expect(ownersView.detailsHidden).toBeUndefined();
    const oliviasView = await history(olivia);
    expect(oliviasView.detailsHidden).toBe(true);
    expect(oliviasView.releases.map((release) => release.version)).toEqual(ownersView.releases.map((release) => release.version));
    for (const release of oliviasView.releases) expect(release).toMatchObject({ gateReasons: [], replayRunId: null });
    // The publisher's own reason is not run data: it stays.
    expect(oliviasView.releases.find((release) => release.version === v2)?.reason).toBe("Hotfix");
  });
});
