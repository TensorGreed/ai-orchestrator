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
});
