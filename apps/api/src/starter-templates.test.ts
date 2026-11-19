/**
 * The starter templates (samples/starters): each one is seeded into the gallery, used by a builder like any template,
 * and runs to the end with no setup — no model, key, MCP server or outside service — against the API's own sample
 * data, the built-in sample MCP server and the local embedder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { STARTER_API_BASE_TOKEN, STARTER_TEMPLATE_CATEGORY, seedTemplatesIfEmpty, selfApiBaseUrl } from "./services/seed-service.js";
import { SAMPLE_ORDERS } from "./sample-data-routes.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const starterDir = path.join(workspaceRoot, "samples", "starters");
const starterFiles = fs.readdirSync(starterDir).filter((file) => file.endsWith(".json")).sort();

interface Context {
  app: FastifyInstance;
  store: Store;
  config: AppConfig;
  tempDir: string;
  baseUrl: string;
  cookie: string;
}

type NodeResult = { nodeId: string; status: string; output?: Record<string, any>; error?: string };
type RunResult = { status: string; executionId?: string; error?: string; output?: any; nodeResults: NodeResult[] };
type TemplateRow = { id: string; name: string; category: string; dependencies: unknown[]; featured: boolean };

let context: Context;

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-starters-"));
  const store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  const config = parseConfig({
    LOG_LEVEL: "warn",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:9",
    GIT_SYNC_WORKDIR: path.join(tempDir, "sync")
  });
  const authService = new AuthService(store, config.SESSION_TTL_HOURS);
  const app = await createApp(config, store, new SecretService(store, config.SECRET_MASTER_KEY_BASE64), authService);
  // The starters call the API's own sample data over HTTP, so this API listens on a real (free) port.
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = selfApiBaseUrl({ API_HOST: "127.0.0.1", API_PORT: address.port });
  await seedTemplatesIfEmpty(store, workspaceRoot, { apiBaseUrl: baseUrl });

  await authService.register({ email: "builder@example.com", password: "builder-Pass-123!", role: "builder" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "builder@example.com", password: "builder-Pass-123!" } });
  const raw = login.headers["set-cookie"];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? ""]).find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`))!.split(";")[0]!;
  context = { app, store, config, tempDir, baseUrl, cookie };
});

afterAll(async () => {
  await context?.app.close();
  try {
    await context?.store.close();
  } catch {
    // Closed by the app's shutdown hooks.
  }
  if (context) fs.rmSync(context.tempDir, { recursive: true, force: true });
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  context.app.inject({ method, url, headers: { cookie: context.cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function starterTemplates(): Promise<TemplateRow[]> {
  const list = (await call("GET", `/api/templates?category=${encodeURIComponent(STARTER_TEMPLATE_CATEGORY)}`)).json<{ templates: TemplateRow[] }>();
  return list.templates;
}

async function useStarter(name: string): Promise<{ workflow: Workflow; companions: Array<{ workflowId: string; name: string }> }> {
  const template = (await starterTemplates()).find((entry) => entry.name === name);
  if (!template) throw new Error(`No starter named ${name}`);
  const used = await call("POST", `/api/templates/${template.id}/use`, {});
  expect(used.statusCode).toBe(200);
  const body = used.json<{ workflowId: string; companions?: Array<{ workflowId: string; name: string }> }>();
  const workflow = (await call("GET", `/api/workflows/${body.workflowId}`)).json<Workflow>();
  return { workflow, companions: body.companions ?? [] };
}

const run = async (workflow: Workflow, input: Record<string, unknown> = {}) =>
  (await call("POST", `/api/workflows/${workflow.id}/execute`, input)).json<RunResult>();

/** "Webhook run" in the editor: the workflow's test payload through the webhook entry point. */
const webhookRun = async (workflow: Workflow) =>
  (await call("POST", "/api/webhooks/execute", { workflow_id: workflow.id, payload: workflow.settings?.testWebhookPayload ?? {} })).json<RunResult>();

const outputOf = (result: RunResult, nodeId: string) => {
  const entries = result.nodeResults.filter((entry) => entry.nodeId === nodeId);
  return entries[entries.length - 1]?.output ?? {};
};
const statusOf = (result: RunResult, nodeId: string) => result.nodeResults.filter((entry) => entry.nodeId === nodeId).at(-1)?.status;

function expectNoFailedNode(result: RunResult) {
  if (process.env.DBG) console.log("OUT", JSON.stringify(result.nodeResults.filter((e) => e.nodeId === "out").map((e) => e.output)).slice(0, 600));
  const failed = result.nodeResults.filter((entry) => entry.status === "error" && entry.nodeId !== "call");
  expect(failed.map((entry) => `${entry.nodeId}: ${entry.error}`)).toEqual([]);
}

describe("starter templates", () => {
  it("ships ten starters, seeded in the Starters category with their base URL filled in", async () => {
    expect(starterFiles).toHaveLength(10);
    const templates = await starterTemplates();
    expect(templates).toHaveLength(10);
    for (const template of templates) {
      const full = (await call("GET", `/api/templates/${template.id}`)).json<{ workflowJson: string }>();
      expect(full.workflowJson).not.toContain(STARTER_API_BASE_TOKEN);
    }
  });

  it("each one needs no setup and shows in the Runs without setup filter", async () => {
    const templates = await starterTemplates();
    expect(templates.every((template) => template.dependencies.length === 0)).toBe(true);
    const runnable = (await call("GET", "/api/templates?setup=none")).json<{ templates: TemplateRow[] }>().templates;
    for (const template of templates) expect(runnable.map((entry) => entry.id)).toContain(template.id);
    expect(runnable.every((template) => template.dependencies.length === 0)).toBe(true);
  });

  it("the gallery lists the starters right after the featured templates", async () => {
    const all = (await call("GET", "/api/templates")).json<{ templates: TemplateRow[] }>().templates;
    const firstOther = all.findIndex((template) => !template.featured && template.category !== STARTER_TEMPLATE_CATEGORY);
    const lastStarter = all.map((template) => template.category).lastIndexOf(STARTER_TEMPLATE_CATEGORY);
    if (firstOther >= 0) expect(lastStarter).toBeLessThan(firstOther);
  });

  it("Webhook: reshape and reply answers the caller with the reshaped request", async () => {
    const { workflow } = await useStarter("Webhook: reshape and reply");
    const result = await webhookRun(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(outputOf(result, "reshape")).toEqual({ fullName: "Ada Lovelace", email: "ada@example.com", isVip: true });
    expect(outputOf(result, "reply").__webhookResponse).toMatchObject({ statusCode: 200, body: { customer: "Ada Lovelace", email: "ada@example.com", vip: true } });
  });

  it("Schedule: fetch, filter and notify fetches the sample orders and notifies about the pending ones", async () => {
    const { workflow } = await useStarter("Schedule: fetch, filter and notify");
    // The schedule is off until the user turns it on.
    expect(workflow.nodes.find((node) => node.type === "schedule_trigger")?.config).toMatchObject({ active: false });
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(outputOf(result, "fetch").body.orders).toHaveLength(SAMPLE_ORDERS.length);
    const pending = SAMPLE_ORDERS.filter((order) => order.status === "pending").map((order) => order.id);
    expect(outputOf(result, "notify").body).toEqual({
      delivered: true,
      simulated: true,
      received: { channel: "#orders", text: `${pending.length} pending order(s): ${pending.join(", ")}` }
    });
    expect(outputOf(result, "out").result).toBe(`Sent to #orders: ${pending.length} pending order(s): ${pending.join(", ")}`);
  });

  it("Form intake: route requests sends a Support request down the support branch", async () => {
    const { workflow } = await useStarter("Form intake: route requests");
    const result = await webhookRun(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(statusOf(result, "support")).toBe("success");
    expect(statusOf(result, "sales")).toBe("skipped");
    expect(outputOf(result, "support")).toMatchObject({ team: "support", from: "Grace Hopper <grace@example.com>" });
  });

  it("CSV to JSON: parse, sort and total totals units per region", async () => {
    const { workflow } = await useStarter("CSV to JSON: parse, sort and total");
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(outputOf(result, "totals").items).toEqual([
      { region: "North", units_sum: 123 },
      { region: "South", units_sum: 53 },
      { region: "West", units_sum: 72 }
    ]);
    expect(outputOf(result, "file")).toMatchObject({ filename: "units-per-region.json", mimeType: "application/json" });
  });

  it("Approval before it goes out waits for a decision, then takes the approved path with the edited amount", async () => {
    const { workflow } = await useStarter("Approval before it goes out");
    const started = await run(workflow);
    expect(started.status).toBe("waiting_approval");
    const decided = await call("POST", `/api/approvals/${started.executionId}/approve`, { edits: { amount: 300 } });
    expect(decided.statusCode).toBe(200);
    const resumed = decided.json<RunResult>();
    expect(resumed.status).toBe("success");
    expect(outputOf(resumed, "approved")).toMatchObject({ decision: "approved", orderId: "ord_1003", amount: 300 });
  });

  it("Retry, then fall back retries the failing call and takes the Error output", async () => {
    const { workflow } = await useStarter("Retry, then fall back");
    const result = await run(workflow);
    expectNoFailedNode(result);
    expect(statusOf(result, "call")).toBe("error");
    expect(statusOf(result, "ok")).toBe("skipped");
    expect(outputOf(result, "fallback")).toMatchObject({ path: "fallback" });
    expect(String(outputOf(result, "fallback").reason)).toContain("503");
    expect(result.status).not.toBe("error");
  });

  it("Loop over items and collect works out each line total and collects them", async () => {
    const { workflow } = await useStarter("Loop over items and collect");
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(outputOf(result, "collect").items).toEqual([
      { sku: "PEN", total: 15 },
      { sku: "LAMP", total: 48 },
      { sku: "DESK", total: 180 }
    ]);
  });

  it("Call a sub-workflow creates the sub-workflow it calls and runs it", async () => {
    const { workflow, companions } = await useStarter("Call a sub-workflow");
    expect(companions).toHaveLength(1);
    const call = workflow.nodes.find((node) => node.type === "execute_workflow")!;
    expect(call.config.workflowId).toBe(companions[0]!.workflowId);
    expect(companions[0]!.workflowId).not.toBe("starter-sub-workflow-child");
    const child = (await context.app.inject({ method: "GET", url: `/api/workflows/${companions[0]!.workflowId}`, headers: { cookie: context.cookie } })).json<Workflow>();
    expect(child.projectId).toBe(workflow.projectId);
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(JSON.stringify(outputOf(result, "call"))).toContain("Hello, Katherine!");
  });

  it("Search a few documents finds the refunds article with the local embedder", async () => {
    const { workflow } = await useStarter("Search a few documents");
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(String(outputOf(result, "search").context)).toMatch(/^\[1\] Refunds:/);
  });

  it("Call an MCP tool calls the sample server's calculator", async () => {
    const { workflow } = await useStarter("Call an MCP tool");
    const result = await run(workflow);
    expect(result.status).toBe("success");
    expectNoFailedNode(result);
    expect(JSON.stringify(outputOf(result, "tool"))).toContain("64.47");
  });

  it("using a template twice gives the companion a new id each time", async () => {
    const first = await useStarter("Call a sub-workflow");
    const second = await useStarter("Call a sub-workflow");
    expect(first.companions[0]!.workflowId).not.toBe(second.companions[0]!.workflowId);
  });
});

describe("sample data routes", () => {
  it("answer with no sign-in", async () => {
    const orders = await context.app.inject({ method: "GET", url: "/api/sample-data/orders" });
    expect(orders.statusCode).toBe(200);
    expect(orders.json<{ orders: unknown[] }>().orders).toHaveLength(SAMPLE_ORDERS.length);
    const notify = await context.app.inject({ method: "POST", url: "/api/sample-data/notify", payload: { text: "hi" } });
    expect(notify.json()).toEqual({ delivered: true, simulated: true, received: { text: "hi" } });
    expect((await context.app.inject({ method: "GET", url: "/api/sample-data/status/503" })).statusCode).toBe(503);
  });

  it("refuse a body that is not an object, a large body and a status outside 200-599", async () => {
    expect((await context.app.inject({ method: "POST", url: "/api/sample-data/notify", payload: [1, 2] })).statusCode).toBe(400);
    const big = await context.app.inject({ method: "POST", url: "/api/sample-data/notify", payload: { text: "x".repeat(20_000) } });
    expect(big.statusCode).toBe(413);
    expect((await context.app.inject({ method: "GET", url: "/api/sample-data/status/100" })).statusCode).toBe(400);
    expect((await context.app.inject({ method: "GET", url: "/api/sample-data/status/abc" })).statusCode).toBe(400);
  });
});

describe("selfApiBaseUrl", () => {
  it("uses loopback when the API binds every interface", () => {
    expect(selfApiBaseUrl({ API_HOST: "0.0.0.0", API_PORT: 4000 })).toBe("http://127.0.0.1:4000");
    expect(selfApiBaseUrl({ API_HOST: "::", API_PORT: 4100 })).toBe("http://127.0.0.1:4100");
    expect(selfApiBaseUrl({ API_HOST: "10.0.0.5", API_PORT: 4000 })).toBe("http://10.0.0.5:4000");
    expect(selfApiBaseUrl({ API_HOST: "::1", API_PORT: 4000 })).toBe("http://[::1]:4000");
  });
});
