/**
 * Someone who has a workflow only through a share with them (not a member of its project, not through a project
 * share, not an admin) sees only their own runs of it: the runs they started and the runs whose sessions are theirs.
 * Anyone else's run answers 404, as a missing one, on every run route: lists, detail, events, exports, approvals,
 * questions, retry, replay, cancel and copying a run's data. Project members keep the full view.
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-own-runs-"));
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
  // A queue that never polls: the dead-letter route is registered, and nothing runs from it.
  const queue = options.queue === false ? undefined : new QueueService(store, { pollIntervalMs: 3_600_000 });
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

function echoWorkflow(id: string): Workflow {
  return {
    id,
    name: `Echo ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "team",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "said {{note}}" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  };
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

/**
 * Project "team" with wf-team and wf-gated. Owen administers the project and Mia is a viewer member there. Olivia
 * (operator) and Gus (builder) have both workflows only through a share with them (can view and run).
 */
async function seed(options: { queue?: boolean } = {}) {
  const context = await createTestContext(options);
  const admin = await login(context, "admin", "ada");
  const owner = await login(context, "builder", "owen");
  const member = await login(context, "viewer", "mia");
  const olivia = await login(context, "operator", "olivia");
  const gus = await login(context, "builder", "gus");
  await context.store.upsertProject({ id: "team", name: "Team" });
  await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
  await context.store.upsertProjectRole({ userId: member.id, projectId: "team", role: "viewer" });
  await context.store.upsertWorkflow(echoWorkflow("wf-team"));
  await context.store.upsertWorkflow(gatedWorkflow("wf-gated"));
  for (const workflowId of ["wf-team", "wf-gated"]) {
    for (const person of [olivia, gus]) {
      const shared = await call(context, "POST", `/api/workflows/${workflowId}/user-shares`, owner.cookie, { email: person.email, accessLevel: "execute" });
      expect(shared.statusCode, shared.body).toBeLessThan(300);
    }
  }
  const run = async (person: Person, workflowId = "wf-team", extra: Record<string, unknown> = {}): Promise<string> => {
    const response = await call(context, "POST", `/api/workflows/${workflowId}/execute`, person.cookie, { input: { note: person.email }, ...extra });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ executionId: string }>().executionId;
  };
  return { context, admin, owner, member, olivia, gus, run };
}

const listRuns = async (context: TestContext, person: Person, query = "") => {
  const response = await call(context, "GET", `/api/executions${query}`, person.cookie);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ items: Array<{ id: string }>; total: number }>();
  return { ids: body.items.map((item) => item.id).sort(), total: body.total };
};

const inboxIds = async (context: TestContext, person: Person, query = "") =>
  (await call(context, "GET", `/api/approvals${query}`, person.cookie)).json<{ items: Array<{ executionId: string }> }>().items.map((item) => item.executionId).sort();

describe("a person who has a workflow only through a share with them sees only their own runs", () => {
  it("run lists and the run picker hold only their own runs, counted before paging; project members and admins see all", async () => {
    const { context, admin, owner, member, olivia, gus, run } = await seed();
    const ownerRun = await run(owner);
    const oliviaRun = await run(olivia);
    const gusRun = await run(gus);
    // A run someone else started that ran in Olivia's sessions is hers too; one that ran in Gus's is not.
    const now = new Date().toISOString();
    await context.store.saveExecutionHistory({ id: "run-in-olivias-session", workflowId: "wf-team", status: "success", startedAt: now, completedAt: now, triggerType: "retry", triggeredBy: owner.email });
    await context.store.setExecutionSessionOwner("run-in-olivias-session", olivia.id);
    await context.store.saveExecutionHistory({ id: "run-by-scheduler", workflowId: "wf-team", status: "success", startedAt: now, completedAt: now, triggerType: "schedule", triggeredBy: "scheduler" });

    const all = [ownerRun, oliviaRun, gusRun, "run-in-olivias-session", "run-by-scheduler"].sort();
    expect(await listRuns(context, olivia)).toEqual({ ids: [oliviaRun, "run-in-olivias-session"].sort(), total: 2 });
    expect(await listRuns(context, olivia, "?workflowId=wf-team&pageSize=1")).toMatchObject({ total: 2 });
    expect(await listRuns(context, gus, "?workflowId=wf-team")).toEqual({ ids: [gusRun], total: 1 });
    for (const person of [owner, member, admin]) expect(await listRuns(context, person)).toEqual({ ids: all, total: 5 });
  });

  it("someone else's run answers 404 on its detail, events, manifest, bundle and rule events; their own opens", async () => {
    const { context, owner, member, olivia, run } = await seed();
    const ownerRun = await run(owner);
    const oliviaRun = await run(olivia);
    for (const suffix of ["", "/events", "/manifest", "/bundle", "/guard-events"]) {
      const other = await call(context, "GET", `/api/executions/${ownerRun}${suffix}`, olivia.cookie);
      expect(other.statusCode, `other ${suffix}`).toBe(404);
      expect(other.json<{ error: string }>().error, suffix).toMatch(/not found/i);
      const own = await call(context, "GET", `/api/executions/${oliviaRun}${suffix}`, olivia.cookie);
      expect(own.statusCode, `own ${suffix}: ${own.body.slice(0, 200)}`).toBe(200);
      expect((await call(context, "GET", `/api/executions/${ownerRun}${suffix}`, member.cookie)).statusCode, `member ${suffix}`).toBe(200);
    }
    // A run id that does not exist answers the same.
    expect((await call(context, "GET", "/api/executions/no-such-run", olivia.cookie)).json()).toEqual(
      (await call(context, "GET", `/api/executions/${ownerRun}`, olivia.cookie)).json()
    );
  });

  it("retry, replay, cancel and reusing a run's data refuse someone else's run as missing", async () => {
    const { context, owner, olivia, gus, run } = await seed();
    const ownerRun = await run(owner);
    const gusRun = await run(gus);
    const retried = await call(context, "POST", `/api/executions/${ownerRun}/retry`, gus.cookie, {});
    expect(retried.statusCode, retried.body).toBe(404);
    const replayed = await call(context, "POST", `/api/executions/${ownerRun}/replay`, gus.cookie, {});
    expect(replayed.statusCode, replayed.body).toBe(404);
    const canceled = await call(context, "POST", `/api/executions/${ownerRun}/cancel`, olivia.cookie, {});
    expect(canceled.statusCode, canceled.body).toBe(404);
    // The editor's "run with this run's data" (pinned outputs, the run's input) is for those who may edit the
    // workflow; a share never gives that, so a share-only builder is refused before any run is read, whoever's it is.
    for (const source of [ownerRun, gusRun]) {
      const copied = await call(context, "POST", "/api/workflows/wf-team/execute", gus.cookie, { sourceExecutionId: source });
      expect(copied.statusCode, copied.body).toBe(403);
      expect(copied.json<{ refusedOptions: string[] }>().refusedOptions).toEqual(["sourceExecutionId"]);
    }
    // A finished run cannot be canceled, but the answer is about the run, not about access.
    expect((await call(context, "POST", `/api/executions/${gusRun}/cancel`, gus.cookie, {})).statusCode).not.toBe(404);
  });

  it("approvals: lists, filters and decisions cover only their own runs", async () => {
    const { context, owner, member, olivia } = await seed();
    const pause = async (person: Person) => {
      const response = await call(context, "POST", "/api/workflows/wf-gated/execute", person.cookie, { input: {} });
      expect(response.json<{ status: string }>().status, response.body).toBe("waiting_approval");
      return response.json<{ executionId: string }>().executionId;
    };
    const ownersPaused = await pause(owner);
    const oliviasPaused = await pause(olivia);
    const inbox = async (person: Person, query = "") =>
      (await call(context, "GET", `/api/approvals${query}`, person.cookie)).json<{ items: Array<{ executionId: string }> }>().items.map((item) => item.executionId).sort();

    expect(await inbox(olivia)).toEqual([oliviasPaused]);
    expect(await inbox(olivia, "?status=all&workflowId=wf-gated")).toEqual([oliviasPaused]);
    expect(await inbox(member)).toEqual([ownersPaused, oliviasPaused].sort());
    expect((await call(context, "GET", `/api/approvals?executionId=${ownersPaused}`, olivia.cookie)).statusCode).toBe(404);

    for (const decision of ["approve", "reject"]) {
      const refused = await call(context, "POST", `/api/approvals/${ownersPaused}/${decision}`, olivia.cookie, {});
      expect(refused.statusCode, refused.body).toBe(404);
    }
    expect((await context.store.getWorkflowExecutionState(ownersPaused))!.status).toBe("waiting_approval");
    // With the execution queue in use a decision answers 202 and the resume runs on the queue.
    const approved = await call(context, "POST", `/api/approvals/${oliviasPaused}/approve`, olivia.cookie, {});
    expect(approved.statusCode, approved.body).toBe(202);
    // The project's people still decide the owner's run.
    expect((await call(context, "POST", `/api/approvals/${ownersPaused}/approve`, owner.cookie, {})).statusCode).toBe(202);
  });

  it("questions from tools (elicitations) show only for their own runs, also in the MCP overview count", async () => {
    const { context, owner, member, olivia, gus, run } = await seed();
    const ownerRun = await run(owner);
    const oliviaRun = await run(olivia);
    const ask = async (id: string, executionId: string, createdBy: string) =>
      await context.store.createMcpElicitation({
        id,
        executionId,
        workflowId: "wf-team",
        nodeId: "out",
        serverId: "mock-mcp",
        toolName: "ask",
        message: `question ${id}`,
        requestedSchema: { type: "object", properties: {} },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdBy,
        triggerType: "manual"
      });
    await ask("elc_owner", ownerRun, owner.id);
    await ask("elc_olivia", oliviaRun, olivia.id);
    const listed = async (person: Person) =>
      (await call(context, "GET", "/api/mcp/elicitations", person.cookie)).json<{ items: Array<{ id: string }> }>().items.map((item) => item.id).sort();
    expect(await listed(olivia)).toEqual(["elc_olivia"]);
    expect((await call(context, "GET", "/api/mcp/elicitations/elc_owner", olivia.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/mcp/elicitations/elc_owner/answer", olivia.cookie, { action: "decline" })).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/mcp/elicitations/elc_olivia", olivia.cookie)).statusCode).toBe(200);
    // Owen, the project's admin, sees both. Mia, a viewer member, keeps the rule from before: someone else's question
    // only for people who may run the workflow.
    expect(await listed(owner)).toEqual(["elc_olivia", "elc_owner"]);
    expect((await call(context, "GET", "/api/mcp/elicitations/elc_owner", member.cookie)).statusCode).toBe(404);
    // The MCP overview counts what the list shows: Gus has no question of his own.
    const pending = async (person: Person) =>
      (await call(context, "GET", "/api/mcp/overview", person.cookie)).json<{ elicitations: { pending: number } }>().elicitations.pending;
    expect(await pending(gus)).toBe(0);
    expect(await pending(owner)).toBe(2);
    await ask("elc_gus", await run(gus), gus.id);
    expect(await pending(gus)).toBe(1);
  });

  it("the access answer says so; data from many people's runs leaves the workflow out", async () => {
    const { context, admin, owner, member, olivia, gus, run } = await seed();
    const access = async (person: Person) =>
      (await call(context, "GET", "/api/workflows/wf-team/access", person.cookie)).json<{ ownRunsOnly: boolean }>().ownRunsOnly;
    expect(await access(olivia)).toBe(true);
    expect(await access(gus)).toBe(true);
    expect(await access(owner)).toBe(false);
    expect(await access(member)).toBe(false);
    expect(await access(admin)).toBe(false);

    // Dead-lettered queue jobs.
    await context.store.enqueueExecution({ id: "job-team", workflowId: "wf-team", payload: {}, maxAttempts: 1 });
    await context.store.markQueueItemFailed("job-team", "boom");
    expect((await call(context, "GET", "/api/queue/dlq", olivia.cookie)).json()).toEqual([]);
    expect((await call(context, "GET", "/api/queue/dlq", owner.cookie)).json<unknown[]>()).toHaveLength(1);

    // Golden runs saved from someone else's run.
    const ownerRun = await run(owner);
    const saved = await call(context, "POST", "/api/replay/recordings", owner.cookie, { executionId: ownerRun, name: "golden" });
    expect(saved.statusCode, saved.body).toBe(201);
    const goldenId = saved.json<{ recording: { id: string } }>().recording.id;
    expect((await call(context, "GET", "/api/replay/recordings", gus.cookie)).json()).toEqual({ items: [], total: 0 });
    expect((await call(context, "GET", "/api/replay/recordings?workflowId=wf-team", gus.cookie)).json()).toEqual({ items: [], total: 0 });
    expect((await call(context, "GET", `/api/replay/recordings/${goldenId}`, gus.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/replay/recordings?workflowId=wf-team", owner.cookie)).json<{ total: number }>().total).toBe(1);

    // Captured production runs.
    const captures = await call(context, "GET", "/api/workflows/wf-team/replay-captures", gus.cookie);
    expect(captures.statusCode, captures.body).toBe(200);
    expect(captures.json()).toEqual({ items: [], total: 0 });

    // Content-rule events (and their stats) of someone else's run.
    await context.store.insertGuardEvents([
      {
        id: "ge-owner", verdictId: "v", executionId: ownerRun, workflowId: "wf-team", projectId: "team", nodeId: "out", placement: "pre",
        iteration: null, toolName: null, channel: "output", detectorId: null, category: null, dataClass: null, score: null,
        requestedAction: "allow", effectiveAction: "allow", verdictAction: "allow", shadow: false, evidence: [], profileId: "p",
        profileVersion: 1, profileHash: "h", latencyMs: 0, budgetExceeded: false, skippedDetectors: [], createdAt: new Date().toISOString()
      }
    ]);
    const ruleEvents = async (person: Person) => (await call(context, "GET", "/api/guard/events", person.cookie)).json<{ total: number }>().total;
    expect(await ruleEvents(olivia)).toBe(0);
    expect(await ruleEvents(member)).toBe(1);
    expect((await call(context, "GET", `/api/executions/${ownerRun}/guard-events`, olivia.cookie)).statusCode).toBe(404);
  });

  it("a run approved by a project member stays theirs (the resume records the approver as who acted)", async () => {
    const { context, owner, olivia } = await seed({ queue: false });
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: {} });
    expect(paused.json<{ status: string }>().status, paused.body).toBe("waiting_approval");
    const executionId = paused.json<{ executionId: string }>().executionId;
    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, owner.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await call(context, "GET", `/api/executions/${executionId}`, olivia.cookie)).statusCode).toBe(200);
    expect((await listRuns(context, olivia)).ids).toEqual([executionId]);
    expect(await inboxIds(context, olivia, "?status=all")).toEqual([executionId]);
  });

  it("golden sets, evaluations, replay jobs and release gate cases of the workflow answer 404 to them", async () => {
    const { context, owner, gus, run } = await seed();
    const ownerRun = await run(owner);
    const saved = await call(context, "POST", "/api/replay/recordings", owner.cookie, { executionId: ownerRun, name: "golden" });
    expect(saved.statusCode, saved.body).toBe(201);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    const created = await call(context, "POST", "/api/eval/datasets", owner.cookie, { name: "Golden set", workflowId: "wf-team" });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const datasetId = created.json<{ dataset: { id: string } }>().dataset.id;
    const added = await call(context, "POST", `/api/eval/datasets/${datasetId}/recordings`, owner.cookie, { recordingId });
    expect(added.statusCode, added.body).toBeLessThan(300);

    const listed = (await call(context, "GET", "/api/eval/datasets?workflowId=wf-team", gus.cookie)).json<{ datasets: Array<{ id: string }> }>().datasets;
    expect(listed).toEqual([]);
    expect((await call(context, "GET", `/api/eval/datasets/${datasetId}/fixtures`, gus.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/eval/datasets/${datasetId}/export`, gus.cookie)).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/eval/runs?wait=true", gus.cookie, { datasetId, workflowId: "wf-team" })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/replay/runs", gus.cookie, { datasetIds: [datasetId] })).statusCode).toBe(404);
    expect((await call(context, "POST", "/api/replay/estimate", gus.cookie, { datasetIds: [datasetId] })).statusCode).toBe(404);
    expect((await call(context, "GET", "/api/workflows/wf-team/release-gate/cases", gus.cookie)).statusCode).toBe(404);
    // The project's people keep them.
    expect((await call(context, "GET", `/api/eval/datasets/${datasetId}/fixtures`, owner.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-team/release-gate/cases", owner.cookie)).statusCode).toBe(200);
  });

  it("someone who also reads the workflow through their project, or through a share to it, sees every run", async () => {
    const { context, owner, olivia, gus, run } = await seed();
    const ownerRun = await run(owner);
    const oliviaRun = await run(olivia);
    await context.store.upsertProjectRole({ userId: olivia.id, projectId: "team", role: "viewer" });
    expect(await listRuns(context, olivia)).toEqual({ ids: [ownerRun, oliviaRun].sort(), total: 2 });
    expect((await call(context, "GET", `/api/executions/${ownerRun}`, olivia.cookie)).statusCode).toBe(200);

    // Gus's own project "gus-home", with wf-team shared to it: every run.
    await context.store.upsertProject({ id: "gus-home", name: "Gus" });
    await context.store.upsertProjectRole({ userId: gus.id, projectId: "gus-home", role: "editor" });
    const shared = await call(context, "POST", "/api/workflows/wf-team/shares", owner.cookie, { projectId: "gus-home", accessLevel: "read" });
    expect(shared.statusCode, shared.body).toBeLessThan(300);
    expect((await call(context, "GET", `/api/executions/${ownerRun}`, gus.cookie)).statusCode).toBe(200);
    expect((await call(context, "GET", "/api/workflows/wf-team/access", gus.cookie)).json<{ ownRunsOnly: boolean }>().ownRunsOnly).toBe(false);
  });
});

describe("own runs only meets approvals around a Loop that routes branches", () => {
  /** start -> gate (Approval Gate) -> loop over [1,2,3] (routes branches) -> IF x > 1 -> big / small. */
  function gatedLoopWorkflow(id: string): Workflow {
    return {
      ...echoWorkflow(id),
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "gate",
          type: "approval_gate",
          name: "Gate",
          position: { x: 100, y: 0 },
          config: { message: "Go on?", approverRoles: ["operator", "builder", "admin"], allowSelfApproval: true, timeoutMinutes: 60, timeoutOutcome: "fallback" }
        },
        { id: "src", type: "set_node", name: "Src", position: { x: 200, y: 0 }, config: { assignments: [{ key: "xs", valueTemplate: "[1,2,3]", type: "json" }] } },
        { id: "loop", type: "loop_node", name: "Loop", position: { x: 300, y: 0 }, config: { inputKey: "xs", itemVariable: "x", routeBranches: true } },
        { id: "if", type: "if_node", name: "If", position: { x: 400, y: 0 }, config: { condition: "{{x}} > 1" } },
        { id: "big", type: "set_node", name: "Big", position: { x: 500, y: 0 }, config: { assignments: [{ key: "big", valueTemplate: "{{x}}", type: "auto" }] } },
        { id: "small", type: "set_node", name: "Small", position: { x: 500, y: 100 }, config: { assignments: [{ key: "small", valueTemplate: "{{x}}", type: "auto" }] } }
      ],
      edges: [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "src" },
        { id: "e3", source: "src", target: "loop" },
        { id: "e4", source: "loop", target: "if" },
        { id: "e5", source: "if", sourceHandle: "true", target: "big" },
        { id: "e6", source: "if", sourceHandle: "false", target: "small" }
      ]
    };
  }

  /** start -> src -> loop -> ask (Human Approval in the body). */
  function approvalInLoopWorkflow(id: string): Workflow {
    return {
      ...echoWorkflow(id),
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "src", type: "set_node", name: "Src", position: { x: 100, y: 0 }, config: { assignments: [{ key: "xs", valueTemplate: "[1]", type: "json" }] } },
        { id: "loop", type: "loop_node", name: "Loop", position: { x: 200, y: 0 }, config: { inputKey: "xs", itemVariable: "x", routeBranches: true } },
        { id: "ask", type: "human_approval", name: "Ask", position: { x: 300, y: 0 }, config: { approvalMessage: "ok?", timeoutMinutes: 30 } }
      ],
      edges: [
        { id: "e1", source: "start", target: "src" },
        { id: "e2", source: "src", target: "loop" },
        { id: "e3", source: "loop", target: "ask" }
      ]
    };
  }

  const share = async (context: TestContext, owner: Person, workflowId: string, people: Person[]) => {
    for (const person of people) {
      const shared = await call(context, "POST", `/api/workflows/${workflowId}/user-shares`, owner.cookie, { email: person.email, accessLevel: "execute" });
      expect(shared.statusCode, shared.body).toBeLessThan(300);
    }
  };

  it("a paused run before the Loop is listed and decided only by its owner (and the project); the resumed Loop routes once per item", async () => {
    const { context, owner, member, olivia, gus } = await seed({ queue: false });
    await context.store.upsertWorkflow(gatedLoopWorkflow("wf-gated-loop"));
    await share(context, owner, "wf-gated-loop", [olivia, gus]);

    const paused = await call(context, "POST", "/api/workflows/wf-gated-loop/execute", olivia.cookie, { input: {} });
    expect(paused.json<{ status: string }>().status, paused.body).toBe("waiting_approval");
    const executionId = paused.json<{ executionId: string }>().executionId;

    expect(await inboxIds(context, olivia)).toEqual([executionId]);
    expect(await inboxIds(context, gus)).toEqual([]);
    expect(await inboxIds(context, gus, "?status=all&workflowId=wf-gated-loop")).toEqual([]);
    expect(await inboxIds(context, member)).toEqual([executionId]);
    expect((await call(context, "GET", `/api/approvals?executionId=${executionId}`, gus.cookie)).statusCode).toBe(404);
    for (const decision of ["approve", "reject"]) {
      expect((await call(context, "POST", `/api/approvals/${executionId}/${decision}`, gus.cookie, {})).statusCode).toBe(404);
    }
    expect((await context.store.getWorkflowExecutionState(executionId))!.status).toBe("waiting_approval");

    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, olivia.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    const detail = await call(context, "GET", `/api/executions/${executionId}`, olivia.cookie);
    expect(detail.statusCode, detail.body).toBe(200);
    const nodeResults = detail.json<{ nodeResults: Array<{ nodeId: string; status: string }> }>().nodeResults;
    const ran = (nodeId: string) => nodeResults.filter((entry) => entry.nodeId === nodeId && entry.status === "success").length;
    // Routed per pass after the resume: x = 2 and 3 take "true", x = 1 takes "false"; nothing runs twice.
    expect(ran("if")).toBe(3);
    expect(ran("big")).toBe(2);
    expect(ran("small")).toBe(1);
    // The resumed run is still Olivia's alone.
    expect((await call(context, "GET", `/api/executions/${executionId}`, gus.cookie)).statusCode).toBe(404);
    expect((await listRuns(context, gus, "?workflowId=wf-gated-loop")).total).toBe(0);
    expect((await listRuns(context, olivia, "?workflowId=wf-gated-loop")).ids).toEqual([executionId]);
  });

  it("a Human Approval in a Loop body fails the run and leaves nothing in anyone's inbox", async () => {
    const { context, owner, member, olivia, gus } = await seed({ queue: false });
    await context.store.upsertWorkflow(approvalInLoopWorkflow("wf-loop-ask"));
    await share(context, owner, "wf-loop-ask", [olivia, gus]);
    const response = await call(context, "POST", "/api/workflows/wf-loop-ask/execute", olivia.cookie, { input: {} });
    const body = response.json<{ status: string; executionId: string; error?: string }>();
    expect(body.status, response.body).toBe("error");
    expect(response.body).toContain("Approvals cannot pause inside a Loop body");
    for (const person of [olivia, gus, member, owner]) {
      expect(await inboxIds(context, person, "?status=all&workflowId=wf-loop-ask")).toEqual([]);
    }
    // The failed run is Olivia's: Gus cannot open it.
    expect((await call(context, "GET", `/api/executions/${body.executionId}`, gus.cookie)).statusCode).toBe(404);
    expect((await call(context, "GET", `/api/executions/${body.executionId}`, olivia.cookie)).statusCode).toBe(200);
  });
});

describe("no difference between someone else's run and a missing one, and read shares keep chat memory to the person", () => {
  it("an action the share does not allow answers 404 for someone else's run and 403 only for their own", async () => {
    const { context, owner, gus, run } = await seed();
    const ownerRun = await run(owner);
    const gusRun = await run(gus);
    // Golden runs need write, which a share never gives: someone else's run is missing, their own is forbidden.
    const otherGolden = await call(context, "POST", "/api/replay/recordings", gus.cookie, { executionId: ownerRun, name: "g" });
    expect(otherGolden.statusCode, otherGolden.body).toBe(404);
    expect(otherGolden.json()).toEqual((await call(context, "POST", "/api/replay/recordings", gus.cookie, { executionId: "no-such-run", name: "g" })).json());
    expect((await call(context, "POST", "/api/replay/recordings", gus.cookie, { executionId: gusRun, name: "g" })).statusCode).toBe(403);

    // With a read share, retry and replay (execute) answer the same way.
    const downgraded = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: gus.email, accessLevel: "read" });
    expect(downgraded.statusCode, downgraded.body).toBeLessThan(300);
    for (const action of ["retry", "replay"]) {
      const other = await call(context, "POST", `/api/executions/${ownerRun}/${action}`, gus.cookie, {});
      expect(other.statusCode, `${action}: ${other.body}`).toBe(404);
      expect(other.json()).toEqual((await call(context, "POST", `/api/executions/no-such-run/${action}`, gus.cookie, {})).json());
      expect((await call(context, "POST", `/api/executions/${gusRun}/${action}`, gus.cookie, {})).statusCode, action).toBe(403);
    }
  });

  it("a builder with a read share chats in sessions of their own, and the chat run is theirs", async () => {
    const { context, owner, gus } = await seed();
    const chat: Workflow = {
      ...echoWorkflow("wf-chat"),
      nodes: [
        { id: "start", type: "chat_trigger", name: "Chat", position: { x: 0, y: 0 }, config: { authMode: "session" } },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: "ok" } }
      ]
    };
    await context.store.upsertWorkflow(chat);
    const shared = await call(context, "POST", "/api/workflows/wf-chat/user-shares", owner.cookie, { email: gus.email, accessLevel: "read" });
    expect(shared.statusCode, shared.body).toBeLessThan(300);
    const said = await call(context, "POST", "/api/chat/wf-chat", gus.cookie, { message: "hi", session_id: "someone-elses-session" });
    expect(said.statusCode, said.body).toBe(200);
    const runs = await listRuns(context, gus, "?workflowId=wf-chat");
    expect(runs.total).toBe(1);
    expect(await context.store.getExecutionSessionOwner(runs.ids[0]!)).toBe(gus.id);

    // The manual trigger route keeps an execute-share runner's sessions to them too, as /execute does.
    const manual = await call(context, "POST", "/api/triggers/manual/wf-team", gus.cookie, { note: "x" });
    expect(manual.statusCode, manual.body).toBe(200);
    expect(await context.store.getExecutionSessionOwner(manual.json<{ executionId: string }>().executionId)).toBe(gus.id);
  });
});
