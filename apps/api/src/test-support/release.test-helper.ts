/**
 * Shared harness of the unpublish tests (release-unpublish.test.ts and the unpublish part of
 * release-entry-points.test.ts): an app over the test store (SQLite, or Postgres under TEST_STORE=postgres), sign-ins
 * by role, saved versions and the production / test webhook calls.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Workflow, WorkflowNode } from "@ai-orchestrator/shared";
import { createApp } from "../app.js";
import { parseConfig, type AppConfig } from "../config.js";
import type { Store } from "../db/store.js";
import { AuthService } from "../services/auth-service.js";
import { SchedulerService } from "../services/scheduler-service.js";
import { SecretService } from "../services/secret-service.js";
import { WorkflowVersionService } from "../services/workflow-version-service.js";
import { openTestStore } from "./test-store.js";

export interface ReleaseTestContext {
  app: FastifyInstance;
  store: Store;
  authService: AuthService;
  config: AppConfig;
  tempDir: string;
  scheduler?: SchedulerService;
}

export type ReleaseTestRole = "admin" | "builder" | "operator" | "viewer";

export async function createReleaseTestContext(options: { scheduler?: boolean } = {}): Promise<ReleaseTestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-unpublish-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const secretService = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const scheduler = options.scheduler ? new SchedulerService(store, () => undefined) : undefined;
  const app = await createApp(config, store, secretService, authService, scheduler);
  await app.ready();
  return { app, store, authService, config, tempDir, ...(scheduler ? { scheduler } : {}) };
}

export async function closeReleaseTestContext(context: ReleaseTestContext): Promise<void> {
  context.scheduler?.stop();
  await context.app.close();
  try {
    await context.store.close();
  } catch {
    // Already closed by the app shutdown hooks.
  }
  fs.rmSync(context.tempDir, { recursive: true, force: true });
}

export async function loginAs(context: ReleaseTestContext, role: ReleaseTestRole, name: string = role): Promise<{ cookie: string; id: string; email: string }> {
  const email = `${name}@example.com`;
  const password = `${name}-Pass-123!`;
  const existing = await context.store.getUserByEmail(email);
  const id = existing ? existing.id : (await context.authService.register({ email, password, role })).id;
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`Login failed for ${name}: ${response.body}`);
  const raw = response.headers["set-cookie"];
  const values = Array.isArray(raw) ? raw : [raw ?? ""];
  const cookie = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`))!;
  return { cookie: cookie.split(";")[0]!, id, email };
}

export const callAs = (context: ReleaseTestContext, method: "GET" | "POST" | "PUT" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

export function testNode(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type: type as WorkflowNode["type"], name: id, position: { x: 0, y: 0 }, config };
}

/** webhook → output that answers `answer`. */
export function hookWorkflow(id: string, answer: string, projectId = "default", hookPath = `hook-${id}`): Workflow {
  return {
    id,
    name: `Release ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [testNode("hook", "webhook_input", { path: hookPath, method: "POST" }), testNode("out", "output", { responseTemplate: answer })],
    edges: [{ id: "e1", source: "hook", target: "out" }]
  } as Workflow;
}

/** Saves the draft and snapshots it as the next version, as the save route does. */
export async function saveVersion(context: ReleaseTestContext, workflow: Workflow): Promise<number> {
  const saved = await context.store.upsertWorkflow(workflow);
  return (await new WorkflowVersionService(context.store).snapshot({ workflow: saved, changeNote: "test" })).version;
}

/** Turns the release gate on over a golden set of the workflow (created when missing). */
export async function enableReleaseGate(context: ReleaseTestContext, cookie: string, workflowId: string, settings: Record<string, unknown> = {}) {
  const datasetId = `set-${workflowId}`;
  if (!await context.store.getEvalDataset(datasetId)) await context.store.createEvalDataset({ id: datasetId, name: `Golden ${workflowId}`, workflowId });
  return await callAs(context, "PUT", `/api/workflows/${workflowId}/release-gate`, cookie, { enabled: true, datasetIds: [datasetId], ...settings });
}

export async function productionHook(context: ReleaseTestContext, hookPath: string): Promise<{ status: number; output: unknown }> {
  const response = await context.app.inject({ method: "POST", url: `/webhook/${hookPath}`, payload: {} });
  return { status: response.statusCode, output: response.json<{ output?: unknown }>().output };
}

export async function testRouteHook(context: ReleaseTestContext, hookPath: string): Promise<{ status: number; output: unknown }> {
  const response = await context.app.inject({ method: "POST", url: `/webhook-test/${hookPath}`, payload: {} });
  return { status: response.statusCode, output: response.json<{ output?: unknown }>().output };
}
