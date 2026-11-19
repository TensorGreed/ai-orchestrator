/**
 * Importing a workflow JSON file: by default the import is a new workflow (a free id is kept, a taken one gets a new
 * id, and the copy gets its own trigger paths), and replacing the stored workflow with that id is an explicit
 * `mode: "replace"`. A dry run says which workflow the id belongs to and what a replace would change.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowDiff } from "@ai-orchestrator/shared";
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

async function createTestContext(): Promise<TestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-wf-import-"));
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

async function login(context: TestContext, role: "builder" | "viewer" = "builder"): Promise<string> {
  const email = `${role}@example.com`;
  const password = `${role}-Pass-123!`;
  await context.authService.register({ email, password, role });
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
  if (!cookie) throw new Error("No session cookie");
  return cookie.split(";")[0]!;
}

const position = { x: 0, y: 0 };

function hookFlow(extra: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-orders",
    name: "Orders",
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Hook", position, config: { path: "orders", method: "POST" } },
      { id: "set", type: "set_node", name: "Set", position, config: { assignments: [{ key: "line", valueTemplate: "x" }] } }
    ],
    edges: [{ id: "e1", source: "hook", target: "set" }],
    ...extra
  };
}

function edited(): Workflow {
  const flow = hookFlow({ name: "Orders v2" });
  flow.nodes = [
    flow.nodes[0]!,
    { ...flow.nodes[1]!, config: { assignments: [{ key: "line", valueTemplate: "y" }] } },
    { id: "out", type: "output", name: "Output", position, config: {} }
  ];
  flow.edges = [...flow.edges, { id: "e2", source: "set", target: "out" }];
  return flow;
}

const post = (context: TestContext, cookie: string, url: string, payload: unknown) =>
  context.app.inject({ method: "POST", url, headers: { cookie }, payload: payload as Record<string, unknown> });

describe("workflow JSON import", () => {
  it("keeps the file's id when no workflow has it", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const imported = await post(context, cookie, "/api/workflows/import", { json: JSON.stringify({ workflow: hookFlow() }) });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json<Workflow>()).toMatchObject({ id: "wf-orders", name: "Orders" });
  });

  it("imports a file whose id is taken as a new workflow with its own trigger paths, leaving the stored one alone", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    expect((await post(context, cookie, "/api/workflows", hookFlow())).statusCode).toBe(200);

    const imported = await post(context, cookie, "/api/workflows/import", { workflow: edited() });
    expect(imported.statusCode, imported.body).toBe(200);
    const copy = imported.json<Workflow>();
    expect(copy.id).not.toBe("wf-orders");
    expect(copy.name).toBe("Orders v2 (imported)");
    expect(copy.nodes.find((node) => node.id === "hook")?.config.path).toBe("orders-copy");
    const original = await context.store.getWorkflow("wf-orders");
    expect(original?.name).toBe("Orders");
    expect(original?.nodes).toHaveLength(2);
    const audit = await context.store.listAuditLogs({ category: "workflow", pageSize: 50 });
    expect(audit.items.find((entry) => entry.eventType === "workflow.import")).toMatchObject({ resourceId: copy.id, metadata: { mode: "new", sourceId: "wf-orders" } });
  });

  it("replaces the stored workflow only with mode replace, keeping a version of what it replaced", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    expect((await post(context, cookie, "/api/workflows", hookFlow())).statusCode).toBe(200);
    const replaced = await post(context, cookie, "/api/workflows/import", { workflow: edited(), mode: "replace" });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json<Workflow>()).toMatchObject({ id: "wf-orders", name: "Orders v2" });
    expect((await context.store.getWorkflow("wf-orders"))?.nodes).toHaveLength(3);
    const versions = await context.app.inject({ method: "GET", url: "/api/workflows/wf-orders/versions", headers: { cookie } });
    expect(versions.body).toContain("replaced by import");
    const audit = await context.store.listAuditLogs({ category: "workflow", pageSize: 50 });
    expect(audit.items.find((entry) => entry.eventType === "workflow.import")).toMatchObject({ resourceId: "wf-orders", metadata: { mode: "replace" } });
  });

  it("refuses mode replace when no workflow has the id", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    const replaced = await post(context, cookie, "/api/workflows/import", { workflow: hookFlow(), mode: "replace" });
    expect(replaced.statusCode).toBe(404);
    expect(await context.store.getWorkflow("wf-orders")).toBeNull();
  });

  it("previews on a dry run: the workflow it would save, the one it matches and the diff, without writing", async () => {
    const context = await createTestContext();
    const cookie = await login(context);
    expect((await post(context, cookie, "/api/workflows", hookFlow())).statusCode).toBe(200);
    const preview = await post(context, cookie, "/api/workflows/import", { workflow: edited(), dryRun: true });
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json<{ dryRun: boolean; mode: string; workflow: Workflow; existing: { id: string; name: string } | null; diff: WorkflowDiff | null }>();
    expect(body).toMatchObject({ dryRun: true, mode: "new", existing: { id: "wf-orders", name: "Orders" } });
    expect(body.workflow.id).not.toBe("wf-orders");
    expect(body.diff?.nodes.added.map((node) => node.id)).toEqual(["out"]);
    expect(body.diff?.nodes.changed.map((node) => node.id)).toEqual(["set"]);
    expect(body.diff?.edges.added.map((edge) => edge.id)).toEqual(["e2"]);
    expect(body.diff?.fields).toEqual(["name"]);
    const list = await context.store.listWorkflows();
    expect(list).toHaveLength(1);

    const fresh = await post(context, cookie, "/api/workflows/import", { workflow: hookFlow({ id: "wf-free" }), dryRun: true });
    expect(fresh.json()).toMatchObject({ dryRun: true, existing: null, diff: null, workflow: { id: "wf-free" } });
  });

  it("is a builder's action", async () => {
    const context = await createTestContext();
    const viewer = await login(context, "viewer");
    expect((await post(context, viewer, "/api/workflows/import", { workflow: hookFlow(), dryRun: true })).statusCode).toBe(403);
  });
});
