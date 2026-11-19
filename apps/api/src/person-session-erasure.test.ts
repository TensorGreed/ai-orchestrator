/**
 * v79 — session rows kept to one person (operators' runs) under erasure and user deletion: a data-subject deletion by
 * session id finds and removes them, a legal hold on the workflow keeps them until it is released, and deleting the
 * user removes their rows except what a hold keeps. Other people's rows are never touched.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { SubjectRequestView, Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { isPersonSessionOf } from "./db/person-sessions.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { openTestStore } from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

interface TestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
}

const contexts: TestContext[] = [];

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-person-erasure-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64"),
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
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

async function login(context: TestContext, role: "admin" | "operator", name: string): Promise<{ cookie: string; id: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const user = await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error(`No session cookie for ${name}`);
  return { cookie: cookie.split(";")[0]!, id: user.id };
}

const call = (context: TestContext, method: "GET" | "POST" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** Saves the run's note as a session artifact under the node's default namespace (`<workflowId>:save`). */
function notebook(id: string): Workflow {
  return {
    id,
    name: `Notebook ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId: "default",
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 0, y: 0 }, config: {} },
      { id: "save", type: "session_artifact_save", name: "Save", position: { x: 200, y: 0 }, config: { artifactKey: "n", valueTemplate: "{{note}}" } },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 0 }, config: { responseTemplate: "saved" } }
    ],
    edges: [
      { id: "e1", source: "start", target: "save" },
      { id: "e2", source: "save", target: "out" }
    ],
    settings: { dataProtection: { subjectRefs: ["{{session_id}}"] } }
  } as Workflow;
}

async function run(context: TestContext, cookie: string, workflowId: string, sessionId: string): Promise<void> {
  const response = await call(context, "POST", `/api/workflows/${workflowId}/execute`, cookie, { input: { note: `note-${sessionId}` }, sessionId });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<{ status: string }>().status, response.body).toBe("success");
}

async function artifactKeys(context: TestContext): Promise<Array<{ namespace: string; session_id: string }>> {
  return await testSql(context.store).all<{ namespace: string; session_id: string }>("SELECT namespace, session_id FROM session_artifacts ORDER BY namespace, session_id");
}

async function hold(context: TestContext, cookie: string, workflowId: string): Promise<string> {
  const response = await call(context, "POST", "/api/legal-holds", cookie, { name: "Matter", reason: "Litigation", scopeType: "workflow", scopeId: workflowId });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ hold?: { id: string }; id?: string }>().hold?.id ?? response.json<{ id: string }>().id;
}

async function waitFor(context: TestContext, cookie: string, id: string, status: SubjectRequestView["status"]): Promise<SubjectRequestView> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const view = (await call(context, "GET", `/api/data-protection/requests/${id}`, cookie)).json<SubjectRequestView>();
    if (view.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Request ${id} never reached ${status}`);
}

describe("person-keyed session rows", () => {
  it("a deletion by session id removes an operator's person-keyed rows; a workflow hold keeps them until released", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin", "ada");
    const olivia = await login(context, "operator", "olivia");
    const otto = await login(context, "operator", "otto");
    await context.store.upsertWorkflow(notebook("wf-pn"));
    await run(context, olivia.cookie, "wf-pn", "sess-olivia-1234");
    await run(context, otto.cookie, "wf-pn", "sess-otto-5678");
    const before = await artifactKeys(context);
    expect(before.filter((row) => isPersonSessionOf(row.namespace, olivia.id)).map((row) => row.session_id)).toEqual(["sess-olivia-1234"]);

    const holdId = await hold(context, admin.cookie, "wf-pn");
    const created = await call(context, "POST", "/api/data-protection/requests", admin.cookie, { type: "delete", value: "sess-olivia-1234", scan: false });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<SubjectRequestView>().id;
    const ready = await waitFor(context, admin.cookie, id, "ready");
    expect(ready.counts.memory_session ?? 0).toBeGreaterThan(0);
    expect((await call(context, "POST", `/api/data-protection/requests/${id}/confirm`, admin.cookie, {})).statusCode).toBe(200);
    // The hold on the workflow covers the person-keyed rows of its default namespace: nothing goes yet.
    await waitFor(context, admin.cookie, id, "deferred_by_hold");
    expect(await artifactKeys(context)).toEqual(before);

    expect((await call(context, "POST", `/api/legal-holds/${holdId}/release`, admin.cookie, { reason: "Settled" })).statusCode).toBe(200);
    await waitFor(context, admin.cookie, id, "done");
    const after = await artifactKeys(context);
    expect(after.filter((row) => isPersonSessionOf(row.namespace, olivia.id))).toEqual([]);
    // Otto's session is someone else's: untouched.
    expect(after.filter((row) => isPersonSessionOf(row.namespace, otto.id)).map((row) => row.session_id)).toEqual(["sess-otto-5678"]);
  });

  it("deleting a user removes their person-keyed rows, keeps what a hold keeps, and leaves other people's", async () => {
    const context = await createTestContext();
    const admin = await login(context, "admin", "ada");
    const olivia = await login(context, "operator", "olivia");
    const otto = await login(context, "operator", "otto");
    await context.store.upsertWorkflow(notebook("wf-held"));
    await context.store.upsertWorkflow(notebook("wf-free"));
    await run(context, olivia.cookie, "wf-held", "s-1");
    await run(context, olivia.cookie, "wf-free", "s-1");
    await run(context, otto.cookie, "wf-free", "s-1");
    await hold(context, admin.cookie, "wf-held");

    const deleted = await call(context, "DELETE", `/api/users/${olivia.id}`, admin.cookie);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    const rows = await artifactKeys(context);
    const hers = rows.filter((row) => isPersonSessionOf(row.namespace, olivia.id)).map((row) => row.namespace);
    expect(hers).toHaveLength(1);
    expect(hers[0]).toContain(":wf-held:save");
    expect(rows.filter((row) => isPersonSessionOf(row.namespace, otto.id))).toHaveLength(1);
  });
});

describe("isPersonSessionOf", () => {
  it("matches only the person's own keys", () => {
    expect(isPersonSessionOf("project:7:default:~person:5:usr_a:wf:save", "usr_a")).toBe(true);
    expect(isPersonSessionOf("project:7:default:~person:5:usrXa:wf:save", "usr_a")).toBe(false);
    expect(isPersonSessionOf("project:7:default:~person:6:usr_ab:wf:save", "usr_a")).toBe(false);
    expect(isPersonSessionOf("project:7:default:wf:save", "usr_a")).toBe(false);
    // A project id that itself reads like a person key does not fool it.
    expect(isPersonSessionOf("project:15:~person:5:usr_a:wf:save", "usr_a")).toBe(false);
  });
});
