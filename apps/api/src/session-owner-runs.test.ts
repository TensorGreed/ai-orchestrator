/**
 * Session memory, the session tool cache and session artifacts of runs started by operators (and by people who run a
 * workflow only through a share with them) are kept to that person: knowing someone's session id does not continue
 * their session. Builders and admins with project access, and API keys, keep the workflow's sessions.
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
import { sessionOwnerUser } from "./db/person-sessions.js";
import { testSql } from "./test-support/test-sql.js";
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

async function createTestContext(env: Record<string, string> = {}, options: { queue?: boolean } = {}): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-session-owner-"));
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
  const queue = options.queue ? new QueueService(store, { pollIntervalMs: 20 }) : undefined;
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


/** Loads the note saved for this session (if any), then saves the run's note under the same session id. */
function notebook(id: string, projectId: string): Workflow {
  return {
    id,
    name: `Notebook ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "load", type: "session_artifact_load", name: "Load", position: { x: 200, y: 0 }, config: { namespace: "notes", artifactKey: "n" } },
      { id: "save", type: "session_artifact_save", name: "Save", position: { x: 400, y: 0 }, config: { namespace: "notes", artifactKey: "n", valueTemplate: "{{note}}" } },
      { id: "out", type: "output", name: "Out", position: { x: 600, y: 0 }, config: { responseTemplate: "seen=[{{results.load.artifact}}]" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "load" },
      { id: "e2", source: "load", target: "save" },
      { id: "e3", source: "save", target: "out" }
    ]
  };
}

async function runNote(context: TestContext, cookie: string, workflowId: string, note: string, route: "execute" | "webhook" = "execute"): Promise<string> {
  const response =
    route === "execute"
      ? await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, { input: { note }, sessionId: "shared-session" })
      : await call(context, "POST", "/api/webhooks/execute", cookie, { workflow_id: workflowId, payload: { note }, session_id: "shared-session" });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ status: string; output?: unknown }>();
  expect(body.status, response.body).toBe("success");
  const seen = /seen=\[([^\]]*)\]/.exec(response.body);
  return seen ? seen[1]! : "";
}

describe("session memory kept to the person for operators and share-only runners", () => {
  it("an operator's session is theirs: another operator or a builder with the same session id starts empty", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const otto = await login(context, "operator", "otto");
    const builder = await login(context, "builder", "bea");
    await context.store.upsertWorkflow(notebook("wf-notes", "default"));

    expect(await runNote(context, olivia.cookie, "wf-notes", "olivia-1")).toBe("");
    expect(await runNote(context, olivia.cookie, "wf-notes", "olivia-2")).toBe("olivia-1");
    // Same session id, another person: nothing of Olivia's.
    expect(await runNote(context, otto.cookie, "wf-notes", "otto-1")).toBe("");
    expect(await runNote(context, otto.cookie, "wf-notes", "otto-2", "webhook")).toBe("otto-1");
    // A builder's runs use the workflow's sessions, as before: not the operators'.
    expect(await runNote(context, builder.cookie, "wf-notes", "bea-1")).toBe("");
    expect(await runNote(context, builder.cookie, "wf-notes", "bea-2")).toBe("bea-1");
    expect(await runNote(context, olivia.cookie, "wf-notes", "olivia-3", "webhook")).toBe("olivia-2");
  });

  it("an API key keeps the workflow's sessions, whatever the role", async () => {
    const context = await createTestContext();
    const builder = await login(context, "builder", "bea");
    await context.store.upsertWorkflow(notebook("wf-notes", "default"));
    await runNote(context, builder.cookie, "wf-notes", "bea-1");
    // A key limited to the operator role: still the workflow's sessions.
    const created = await call(context, "POST", "/api/auth/api-keys", builder.cookie, { name: "ops", role: "operator" });
    expect(created.statusCode, created.body).toBe(200);
    const token = created.json<{ key: string }>().key;
    const run = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-notes/execute",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: { note: "key-1" }, sessionId: "shared-session" }
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.body).toContain("seen=[bea-1]");
  });

  it("a builder who runs a workflow only through a share with them gets their own sessions; the project's builders do not", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const guest = await login(context, "builder", "guest");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertWorkflow(notebook("wf-team", "team"));
    const shared = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: guest.email, accessLevel: "execute" });
    expect(shared.statusCode, shared.body).toBeLessThan(300);

    expect(await runNote(context, owner.cookie, "wf-team", "owner-1")).toBe("");
    expect(await runNote(context, guest.cookie, "wf-team", "guest-1")).toBe("");
    expect(await runNote(context, guest.cookie, "wf-team", "guest-2")).toBe("guest-1");
    expect(await runNote(context, owner.cookie, "wf-team", "owner-2")).toBe("owner-1");
  });

  it("an operator's run paused for approval saves to the operator's session after a builder approves it", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const lead = await login(context, "builder", "lead");
    const gated: Workflow = {
      ...notebook("wf-gated", "default"),
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "gate", type: "approval_gate", name: "Gate", position: { x: 200, y: 0 }, config: { message: "Save?", approverRoles: ["builder", "admin"], timeoutMinutes: 60, timeoutOutcome: "fallback" } },
        { id: "save", type: "session_artifact_save", name: "Save", position: { x: 400, y: 0 }, config: { namespace: "notes", artifactKey: "n", valueTemplate: "{{note}}" } },
        { id: "out", type: "output", name: "Out", position: { x: 600, y: 0 }, config: { responseTemplate: "saved" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", sourceHandle: "approved", target: "save" },
        { id: "e3", source: "save", target: "out" }
      ]
    };
    await context.store.upsertWorkflow(gated);
    await context.store.upsertWorkflow(notebook("wf-notes", "default"));
    const paused = await call(context, "POST", "/api/workflows/wf-gated/execute", olivia.cookie, { input: { note: "approved-note" }, sessionId: "shared-session" });
    expect(paused.json<{ status: string }>().status, paused.body).toBe("waiting_approval");
    const executionId = paused.json<{ executionId: string }>().executionId;
    const approved = await call(context, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ status: string }>().status).toBe("success");
    // The same namespace and session from another workflow of the project: Olivia sees it, the builder does not.
    expect(await runNote(context, lead.cookie, "wf-notes", "lead-1")).toBe("");
    expect(await runNote(context, olivia.cookie, "wf-notes", "olivia-1")).toBe("approved-note");
  });

  it("a queued run by an operator uses the operator's sessions, decided when the job runs", async () => {
    const context = await createTestContext({}, { queue: true });
    const olivia = await login(context, "operator", "olivia");
    const otto = await login(context, "operator", "otto");
    await context.store.upsertWorkflow(notebook("wf-notes", "default"));
    expect(await runNote(context, olivia.cookie, "wf-notes", "olivia-1")).toBe("");
    const queued = async (cookie: string, note: string) => {
      const enqueued = await call(context, "POST", "/api/workflows/wf-notes/enqueue", cookie, { input: { note }, sessionId: "shared-session" });
      expect(enqueued.statusCode, enqueued.body).toBe(200);
      const executionId = enqueued.json<{ executionId: string }>().executionId;
      const until = Date.now() + 20_000;
      for (;;) {
        const history = await context.store.getExecutionHistory(executionId);
        if (history && ["success", "error"].includes(history.status)) return JSON.stringify(history.nodeResults);
        if (Date.now() > until) throw new Error("The queued run did not finish");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    // Otto's queued run with Olivia's session id sees nothing of hers; Olivia's own queued run does.
    expect(await queued(otto.cookie, "otto-1")).toContain("seen=[]");
    expect(await queued(olivia.cookie, "olivia-2")).toContain("seen=[olivia-1]");
  });

  it("a signed-in chat by a viewer or an operator keeps its memory to that person", async () => {
    const context = await createTestContext();
    const vera = await login(context, "viewer", "vera");
    const olivia = await login(context, "operator", "olivia");
    const chat: Workflow = {
      ...notebook("wf-chat", "default"),
      nodes: [
        { id: "start", type: "chat_trigger", name: "Chat", position: { x: 0, y: 0 }, config: { authMode: "session" } },
        ...notebook("wf-chat", "default").nodes.slice(1).map((node) => (node.id === "save" ? { ...node, config: { ...node.config, valueTemplate: "{{message}}" } } : node))
      ]
    };
    await context.store.upsertWorkflow(chat);
    const say = async (cookie: string, message: string) => {
      const response = await call(context, "POST", "/api/chat/wf-chat", cookie, { message, session_id: "chat-1" });
      expect(response.statusCode, response.body).toBe(200);
      return /seen=\[([^\]]*)\]/.exec(response.body)?.[1] ?? "";
    };
    expect(await say(vera.cookie, "vera-1")).toBe("");
    expect(await say(vera.cookie, "vera-2")).toBe("vera-1");
    expect(await say(olivia.cookie, "olivia-1")).toBe("");
  });
});

describe("a retry keeps the failed run's session scope (v79)", () => {
  /** Loads the session note, saves the run's note, then stops with an error. */
  const failingNotebook = (): Workflow => ({
    ...notebook("wf-fail", "default"),
    nodes: [
      ...notebook("wf-fail", "default").nodes.filter((node) => node.id !== "out"),
      { id: "boom", type: "stop_and_error", name: "Boom", position: { x: 600, y: 0 }, config: { message: "stop here" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "load" },
      { id: "e2", source: "load", target: "save" },
      { id: "e3", source: "save", target: "boom" }
    ]
  });
  const loaded = (body: string): string => {
    const parsed = JSON.parse(body) as { nodeResults?: Array<{ nodeId: string; output?: { artifact?: unknown } }> };
    const artifact = parsed.nodeResults?.find((entry) => entry.nodeId === "load")?.output?.artifact;
    return artifact === undefined || artifact === null ? "" : String(artifact);
  };

  it("an operator's failed run retried by a builder stays in the operator's scope, in a namespace of its own", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const bea = await login(context, "builder", "bea");
    await context.store.upsertWorkflow(failingNotebook());
    await context.store.upsertWorkflow(notebook("wf-notes", "default"));

    const first = await call(context, "POST", "/api/workflows/wf-fail/execute", olivia.cookie, { input: { note: "olivia-1" }, sessionId: "shared-session" });
    expect(first.json<{ status: string }>().status, first.body).toBe("error");
    const failedId = first.json<{ executionId: string }>().executionId;
    expect(await context.store.getExecutionSessionOwner(failedId)).toBe(olivia.id);

    const retried = await call(context, "POST", `/api/executions/${failedId}/retry`, bea.cookie, { input: { note: "bea-retry" }, sessionId: "shared-session" });
    expect(retried.statusCode, retried.body).toBeLessThan(500);
    // The builder's retry does not read Olivia's note into their view...
    expect(loaded(retried.body)).toBe("");
    const retryId = retried.json<{ executionId: string }>().executionId;
    // ...stays kept to Olivia, in a namespace of its own (so a retry of the retry does too)...
    const retryOwner = await context.store.getExecutionSessionOwner(retryId);
    expect(retryOwner).toMatch(/^repeat:/);
    expect(sessionOwnerUser(retryOwner!)).toBe(olivia.id);
    // ...and wrote neither into the workflow's session nor into the session Olivia uses.
    expect(await runNote(context, bea.cookie, "wf-notes", "bea-1")).toBe("");
    const oliviaNext = await call(context, "POST", "/api/workflows/wf-fail/execute", olivia.cookie, { input: { note: "olivia-2" }, sessionId: "shared-session" });
    expect(loaded(oliviaNext.body)).toBe("olivia-1");
  });

  it("an operator's own retry continues their session", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    await context.store.upsertWorkflow(failingNotebook());
    const first = await call(context, "POST", "/api/workflows/wf-fail/execute", olivia.cookie, { input: { note: "olivia-1" }, sessionId: "shared-session" });
    const failedId = first.json<{ executionId: string }>().executionId;
    // Retry is a builder route: Olivia, promoted to builder, retries the run she started as an operator.
    expect(await context.store.updateUserRole(olivia.id, "builder")).toBe(true);
    const retried = await call(context, "POST", `/api/executions/${failedId}/retry`, olivia.cookie, { input: { note: "olivia-2" }, sessionId: "shared-session" });
    expect(loaded(retried.body)).toBe("olivia-1");
  });

  it("a run that used the workflow's sessions records no owner", async () => {
    const context = await createTestContext();
    const bea = await login(context, "builder", "bea");
    await context.store.upsertWorkflow(failingNotebook());
    const first = await call(context, "POST", "/api/workflows/wf-fail/execute", bea.cookie, { input: { note: "bea-1" }, sessionId: "shared-session" });
    expect(await context.store.getExecutionSessionOwner(first.json<{ executionId: string }>().executionId)).toBeNull();
  });
});

describe("operators run the released version", () => {
  it("an operator runs the published version while a builder runs the draft; an operator cannot ask for the draft", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const bea = await login(context, "builder", "bea");
    const flow = (text: string): Workflow => ({
      id: "wf-rel",
      name: "Released",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: text } }
      ],
      edges: [{ id: "e1", source: "start", target: "out" }]
    });
    expect((await call(context, "POST", "/api/workflows", bea.cookie, flow("released"))).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-rel/publish", bea.cookie, { version: 1 })).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/workflows/wf-rel", bea.cookie, flow("unreleased draft"))).statusCode).toBe(200);
    const operatorRun = await call(context, "POST", "/api/workflows/wf-rel/execute", olivia.cookie, { input: {} });
    expect(operatorRun.statusCode, operatorRun.body).toBe(200);
    expect(operatorRun.body).toContain("released");
    expect(operatorRun.body).not.toContain("unreleased draft");
    expect((await call(context, "POST", "/api/workflows/wf-rel/execute", bea.cookie, { input: {} })).body).toContain("unreleased draft");
    expect((await call(context, "POST", "/api/workflows/wf-rel/execute?channel=draft", olivia.cookie, { input: {} })).statusCode).toBe(403);
  });
});

describe("a non-owner's retry reads none of the owner's memory (v79)", () => {
  const fixedNotebook = (): Workflow => {
    const flow = notebook("wf-fixed", "default");
    return {
      ...flow,
      nodes: [
        ...flow.nodes
          .filter((node) => node.id !== "out")
          .map((node) => (node.id === "load" || node.id === "save" ? { ...node, config: { ...node.config, sessionIdTemplate: "fixed" } } : node)),
        { id: "boom", type: "stop_and_error", name: "Boom", position: { x: 600, y: 0 }, config: { message: "stop here" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "load" },
        { id: "e2", source: "load", target: "save" },
        { id: "e3", source: "save", target: "boom" }
      ]
    };
  };
  const loaded = (body: string): string => {
    const parsed = JSON.parse(body) as { nodeResults?: Array<{ nodeId: string; output?: { artifact?: unknown } }> };
    const artifact = parsed.nodeResults?.find((entry) => entry.nodeId === "load")?.output?.artifact;
    return artifact === undefined || artifact === null ? "" : String(artifact);
  };

  it("with a fixed session template, and when the failed run's owner went unrecorded (a canceled run)", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const bea = await login(context, "builder", "bea");
    await context.store.upsertWorkflow(fixedNotebook());
    const first = await call(context, "POST", "/api/workflows/wf-fixed/execute", olivia.cookie, { input: { note: "olivia-secret" } });
    expect(first.json<{ status: string }>().status, first.body).toBe("error");
    const second = await call(context, "POST", "/api/workflows/wf-fixed/execute", olivia.cookie, { input: { note: "olivia-2" } });
    expect(loaded(second.body)).toBe("olivia-secret");
    const failedId = second.json<{ executionId: string }>().executionId;

    const retried = await call(context, "POST", `/api/executions/${failedId}/retry`, bea.cookie, { input: { note: "bea" } });
    expect(retried.statusCode, retried.body).toBeLessThan(500);
    expect(loaded(retried.body)).toBe("");

    // A run whose owner was never recorded (a cancel skips the final write) is judged by who started it.
    await testSql(context.store).run("UPDATE execution_history SET session_owner = NULL WHERE id = ?", failedId);
    expect(await context.store.getExecutionSessionOwner(failedId)).toBeNull();
    const again = await call(context, "POST", `/api/executions/${failedId}/retry`, bea.cookie, { input: { note: "bea-2" } });
    expect(loaded(again.body)).toBe("");
    // Nothing went into the workflow's sessions, and Olivia's session is as she left it.
    const beaOwn = await call(context, "POST", "/api/workflows/wf-fixed/execute", bea.cookie, { input: { note: "bea-own" } });
    expect(loaded(beaOwn.body)).toBe("");
    const oliviaNext = await call(context, "POST", "/api/workflows/wf-fixed/execute", olivia.cookie, { input: { note: "olivia-3" } });
    expect(loaded(oliviaNext.body)).toBe("olivia-2");
  });

  it("a run of a deleted person is not retried", async () => {
    const context = await createTestContext();
    const olivia = await login(context, "operator", "olivia");
    const admin = await login(context, "admin", "ada");
    await context.store.upsertWorkflow(fixedNotebook());
    const first = await call(context, "POST", "/api/workflows/wf-fixed/execute", olivia.cookie, { input: { note: "olivia-1" } });
    const failedId = first.json<{ executionId: string }>().executionId;
    expect((await call(context, "DELETE", `/api/users/${olivia.id}`, admin.cookie)).statusCode).toBeLessThan(300);
    const retried = await call(context, "POST", `/api/executions/${failedId}/retry`, admin.cookie, { input: { note: "x" } });
    expect(retried.statusCode, retried.body).toBe(409);
  });
});

describe("one rule for who may edit: a builder role and workflow:write on the workflow", () => {
  const released = (projectId: string, text: string): Workflow => ({
    id: "wf-rel",
    name: "Released",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 200, y: 0 }, config: { responseTemplate: text } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  });

  it("an operator with an editor membership runs the released version and cannot ask for the draft", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const olivia = await login(context, "operator", "olivia");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertProjectRole({ userId: olivia.id, projectId: "team", role: "editor" });
    expect((await call(context, "POST", "/api/workflows", owner.cookie, released("team", "v1-released"))).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-rel/publish", owner.cookie, { version: 1 })).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/workflows/wf-rel", owner.cookie, released("team", "unreleased draft"))).statusCode).toBe(200);

    const run = await call(context, "POST", "/api/workflows/wf-rel/execute", olivia.cookie, { input: {} });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.body).toContain("v1-released");
    expect(run.body).not.toContain("unreleased draft");
    expect((await call(context, "POST", "/api/workflows/wf-rel/execute?channel=draft", olivia.cookie, { input: {} })).statusCode).toBe(403);
    expect((await call(context, "POST", "/api/workflows/wf-rel/execute", owner.cookie, { input: {} })).body).toContain("unreleased draft");
    const access = await call(context, "GET", "/api/workflows/wf-rel/access", olivia.cookie);
    expect(access.json<{ canEdit: boolean; canRun: boolean }>()).toMatchObject({ canEdit: false, canRun: true });
  });

  it("a builder who may run but not edit (a share to their project) gets no editor options and sessions of their own", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const guest = await login(context, "builder", "guest");
    const other = await login(context, "builder", "other");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProject({ id: "ops", name: "Ops" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertProjectRole({ userId: guest.id, projectId: "ops", role: "editor" });
    await context.store.upsertProjectRole({ userId: other.id, projectId: "ops", role: "editor" });
    await context.store.upsertWorkflow(notebook("wf-team", "team"));
    await context.store.upsertWorkflowShare({ workflowId: "wf-team", projectId: "ops", accessLevel: "execute" });

    const options = await call(context, "POST", "/api/workflows/wf-team/execute", guest.cookie, { input: { note: "x" }, startNodeId: "save" });
    expect(options.statusCode, options.body).toBe(403);
    expect(options.json<{ refusedOptions: string[] }>().refusedOptions).toEqual(["startNodeId"]);
    const access = await call(context, "GET", "/api/workflows/wf-team/access", guest.cookie);
    expect(access.json<{ canEdit: boolean; canRun: boolean }>()).toMatchObject({ canEdit: false, canRun: true });

    expect(await runNote(context, owner.cookie, "wf-team", "owner-1")).toBe("");
    expect(await runNote(context, guest.cookie, "wf-team", "guest-1")).toBe("");
    expect(await runNote(context, guest.cookie, "wf-team", "guest-2", "webhook")).toBe("guest-1");
    // Another runner of the same share does not continue the guest's session, and the owner keeps the workflow's.
    expect(await runNote(context, other.cookie, "wf-team", "other-1")).toBe("");
    expect(await runNote(context, owner.cookie, "wf-team", "owner-2")).toBe("owner-1");
  });

  it("a share-only runner is kept to their own sessions whatever the role, also with a key capped at operator", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const guest = await login(context, "builder", "guest");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertWorkflow(notebook("wf-team", "team"));
    const shared = await call(context, "POST", "/api/workflows/wf-team/user-shares", owner.cookie, { email: guest.email, accessLevel: "execute" });
    expect(shared.statusCode, shared.body).toBeLessThan(300);
    expect(await runNote(context, owner.cookie, "wf-team", "owner-1")).toBe("");
    expect(await runNote(context, guest.cookie, "wf-team", "guest-1")).toBe("");

    const created = await call(context, "POST", "/api/auth/api-keys", guest.cookie, { name: "ops", role: "operator" });
    expect(created.statusCode, created.body).toBe(200);
    const token = created.json<{ key: string }>().key;
    const run = await context.app.inject({
      method: "POST",
      url: "/api/workflows/wf-team/execute",
      headers: { authorization: `Bearer ${token}` },
      payload: { input: { note: "key-1" }, sessionId: "shared-session" }
    });
    expect(run.statusCode, run.body).toBe(200);
    // The guest's own session, not the workflow's (which holds owner-1).
    expect(run.body).toContain("seen=[guest-1]");
  });

  it("a builder who may only run a workflow runs the released version from the manual trigger route and on retry, and may not replay", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const guest = await login(context, "builder", "guest");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProject({ id: "ops", name: "Ops" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertProjectRole({ userId: guest.id, projectId: "ops", role: "editor" });
    const failing = (message: string): Workflow => ({
      ...released("team", message),
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "boom", type: "stop_and_error", name: "Boom", position: { x: 200, y: 0 }, config: { message } }
      ],
      edges: [{ id: "e1", source: "start", target: "boom" }]
    });
    expect((await call(context, "POST", "/api/workflows", owner.cookie, failing("v1-released stop"))).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/workflows/wf-rel/publish", owner.cookie, { version: 1 })).statusCode).toBe(200);
    expect((await call(context, "PUT", "/api/workflows/wf-rel", owner.cookie, failing("unreleased draft stop"))).statusCode).toBe(200);
    await context.store.upsertWorkflowShare({ workflowId: "wf-rel", projectId: "ops", accessLevel: "execute" });

    const manual = await call(context, "POST", "/api/triggers/manual/wf-rel", guest.cookie, {});
    expect(manual.statusCode, manual.body).toBe(200);
    const manualRun = manual.json<{ executionId: string }>().executionId;
    const history = await call(context, "GET", `/api/executions/${manualRun}`, guest.cookie);
    expect(history.body).toContain("v1-released stop");
    expect(history.body).not.toContain("unreleased draft stop");

    const withOptions = await call(context, "POST", `/api/executions/${manualRun}/retry`, guest.cookie, { startNodeId: "boom" });
    expect(withOptions.statusCode, withOptions.body).toBe(403);
    expect(withOptions.json<{ refusedOptions: string[] }>().refusedOptions).toEqual(["startNodeId"]);
    const retried = await call(context, "POST", `/api/executions/${manualRun}/retry`, guest.cookie, {});
    expect(retried.body).toContain("v1-released stop");
    expect(retried.body).not.toContain("unreleased draft stop");

    // The owner's failed draft run from a node: the guest's retry runs the released version from the start, with none
    // of that run's editor options (start node, run mode, node outputs).
    const ownerFromNode = await call(context, "POST", "/api/workflows/wf-rel/execute", owner.cookie, { input: {}, startNodeId: "boom" });
    const ownerRun = ownerFromNode.json<{ executionId: string; nodeResults: Array<{ nodeId: string }> }>();
    expect(ownerFromNode.body).toContain("unreleased draft stop");
    expect(ownerRun.nodeResults.map((entry) => entry.nodeId)).not.toContain("start");
    const guestRetry = await call(context, "POST", `/api/executions/${ownerRun.executionId}/retry`, guest.cookie, {});
    expect([200, 400]).toContain(guestRetry.statusCode);
    expect(guestRetry.body).toContain("v1-released stop");
    expect(guestRetry.body).not.toContain("unreleased draft stop");
    expect(guestRetry.json<{ nodeResults: Array<{ nodeId: string }> }>().nodeResults.map((entry) => entry.nodeId)).toContain("start");

    const replay = await call(context, "POST", `/api/executions/${manualRun}/replay`, guest.cookie, {});
    expect(replay.statusCode, replay.body).toBe(403);
    // The owner, who may edit it, still runs the draft from the manual trigger route.
    const ownerManual = await call(context, "POST", "/api/triggers/manual/wf-rel", owner.cookie, {});
    const ownerHistory = await call(context, "GET", `/api/executions/${ownerManual.json<{ executionId: string }>().executionId}`, owner.cookie);
    expect(ownerHistory.body).toContain("unreleased draft stop");
  });

  it("golden-run replays, replay jobs and eval runs run the draft, so a builder who may only run the workflow gets 403", async () => {
    const context = await createTestContext({ PROJECT_ISOLATION: "strict" });
    const owner = await login(context, "builder", "owner");
    const guest = await login(context, "builder", "guest");
    await context.store.upsertProject({ id: "team", name: "Team" });
    await context.store.upsertProject({ id: "ops", name: "Ops" });
    await context.store.upsertProjectRole({ userId: owner.id, projectId: "team", role: "project_admin" });
    await context.store.upsertProjectRole({ userId: guest.id, projectId: "ops", role: "editor" });
    expect((await call(context, "POST", "/api/workflows", owner.cookie, released("team", "golden"))).statusCode).toBe(200);
    await context.store.upsertWorkflowShare({ workflowId: "wf-rel", projectId: "ops", accessLevel: "execute" });

    const run = await call(context, "POST", "/api/workflows/wf-rel/execute", owner.cookie, { input: {} });
    expect(run.statusCode, run.body).toBe(200);
    const saved = await call(context, "POST", "/api/replay/recordings", owner.cookie, { executionId: run.json<{ executionId: string }>().executionId, name: "golden" });
    expect(saved.statusCode, saved.body).toBeLessThan(300);
    const recordingId = saved.json<{ recording: { id: string } }>().recording.id;
    const set = await call(context, "POST", "/api/eval/datasets", owner.cookie, { name: "Set", workflowId: "wf-rel" });
    expect(set.statusCode, set.body).toBeLessThan(300);
    const setId = set.json<{ dataset: { id: string } }>().dataset.id;
    expect((await call(context, "POST", `/api/eval/datasets/${setId}/recordings`, owner.cookie, { recordingId })).statusCode).toBeLessThan(300);

    const guestReplay = await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, guest.cookie, {});
    expect(guestReplay.statusCode, guestReplay.body).toBe(403);
    expect(guestReplay.body).toContain("workflow:write");
    const guestEval = await call(context, "POST", "/api/eval/runs", guest.cookie, { datasetId: setId, workflowId: "wf-rel" });
    expect(guestEval.statusCode, guestEval.body).toBe(403);
    const guestJob = await call(context, "POST", "/api/replay/runs", guest.cookie, { datasetIds: [setId] });
    expect(guestJob.statusCode, guestJob.body).toBe(403);
    expect((await call(context, "POST", "/api/replay/estimate", guest.cookie, { datasetIds: [setId] })).statusCode).toBe(403);

    expect((await call(context, "POST", `/api/replay/recordings/${recordingId}/replay`, owner.cookie, {})).statusCode).toBe(200);
    expect((await call(context, "POST", "/api/replay/runs", owner.cookie, { datasetIds: [setId] })).statusCode).toBe(202);
  });
});
