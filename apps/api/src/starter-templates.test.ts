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
import { LIVE_ENTRY_NODE_TYPES, type Workflow } from "@ai-orchestrator/shared";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { openTestStore } from "./test-support/test-store.js";
import { AuthService } from "./services/auth-service.js";
import { SecretService } from "./services/secret-service.js";
import { STARTER_API_BASE_TOKEN, STARTER_TEMPLATE_CATEGORY, seedTemplatesIfEmpty, selfApiBaseUrl } from "./services/seed-service.js";
import { SAMPLE_ORDERS } from "./sample-data-routes.js";
import { buildGatewayCatalog } from "./services/mcp-gateway-catalog.js";

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

  it("the Featured template runs without setup", async () => {
    const featured = (await call("GET", "/api/templates")).json<{ templates: TemplateRow[] }>().templates.filter((template) => template.featured);
    expect(featured.length).toBeGreaterThan(0);
    for (const template of featured) expect(template.dependencies, template.id).toEqual([]);
    const runnable = (await call("GET", "/api/templates?setup=none")).json<{ templates: TemplateRow[] }>().templates;
    expect(runnable[0]?.featured).toBe(true);
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

  it("Webhook: reshape and reply answers a request to its URL with the Webhook Response, though a node runs after it", async () => {
    const { workflow } = await useStarter("Webhook: reshape and reply");
    const nodes = workflow.nodes.map((node) => (node.type === "webhook_input" ? { ...node, config: { ...node.config, active: true } } : node));
    const saved = await context.app.inject({ method: "PUT", url: `/api/workflows/${workflow.id}`, headers: { cookie: context.cookie }, payload: { ...workflow, nodes } });
    expect(saved.statusCode).toBe(200);
    const path = String(workflow.nodes.find((node) => node.type === "webhook_input")?.config.path);
    // The validation's repro: a curl to the starter's URL got the trailing Run result node's output instead.
    const payload = { first_name: "Grace", last_name: "Hopper", email: "G@x.com", orders: 12 };
    for (const route of ["webhook", "webhook-test"]) {
      const answered = await context.app.inject({ method: "POST", url: `/${route}/${path}`, ...(route === "webhook-test" ? { headers: { cookie: context.cookie } } : {}), payload });
      expect(answered.statusCode, route).toBe(200);
      expect(answered.json(), route).toEqual({ customer: "Grace Hopper", email: "g@x.com", vip: true });
    }
    // The compat entry point (the editor's Webhook run) returns the run, whose output is the reply.
    const result = await webhookRun(workflow);
    expect(result.output.__webhookResponse).toMatchObject({ statusCode: 200, body: { customer: "Ada Lovelace", email: "ada@example.com", vip: true } });
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
    // The failure went to the connected Error output: handled, so the run succeeded and the hint does not say to
    // connect it (the validation saw "partial", a red node and that hint).
    expect(result.status).toBe("success");
    const call = result.nodeResults.filter((entry) => entry.nodeId === "call").at(-1) as NodeResult & { handled?: boolean; errorRemediation?: string };
    expect(call.handled).toBe(true);
    expect(call.errorRemediation ?? "").not.toMatch(/connect the node's Error output/);
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

  it("removes the sub-workflow it made when saving the main workflow fails", async () => {
    const { store } = context!;
    const companions = async () => (await store.listWorkflows()).filter((workflow) => workflow.name === "Format a greeting (sub-workflow)").length;
    const before = await companions();
    const original = store.upsertWorkflow.bind(store);
    store.upsertWorkflow = (async (workflow: Parameters<Store["upsertWorkflow"]>[0], options?: Parameters<Store["upsertWorkflow"]>[1]) => {
      // The companion is saved first; the main workflow is the next save.
      if (workflow.name !== "Format a greeting (sub-workflow)") throw new Error("disk full");
      return original(workflow, options);
    }) as Store["upsertWorkflow"];
    try {
      const template = (await starterTemplates()).find((entry) => entry.name === "Call a sub-workflow")!;
      const used = await call("POST", `/api/templates/${template.id}/use`, {});
      expect(used.statusCode).toBe(500);
    } finally {
      store.upsertWorkflow = original;
    }
    expect(await companions()).toBe(before);
  });

  it("seeding again leaves a user's own template with a starter's name alone", async () => {
    const { store, baseUrl } = context!;
    // The user's template is the only one with that name (as when it was made before the starters shipped).
    const builtIn = (await store.listTemplates()).find((template) => template.name === "Call an MCP tool")!;
    await store.deleteTemplate(builtIn.id);
    const workflowJson = JSON.stringify({ id: "mine", name: "Call an MCP tool", nodes: [], edges: [] });
    await store.upsertTemplate({ id: "user-own-template", name: "Call an MCP tool", description: "mine", category: "Mine", tags: [], author: "someone", workflowJson, nodeCount: 0 });
    await seedTemplatesIfEmpty(store, workspaceRoot, { apiBaseUrl: baseUrl });
    const own = await store.getTemplate("user-own-template");
    expect(own?.category).toBe("Mine");
    expect(own?.workflowJson).toBe(workflowJson);
    expect((await store.getTemplate(builtIn.id))?.category).toBe(STARTER_TEMPLATE_CATEGORY);
  });
});

describe("starters start switched off", () => {
  const anonymous = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    context.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const turnOn = async (workflow: Workflow, nodeId: string) => {
    const nodes = workflow.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const { active: _off, ...config } = node.config as Record<string, unknown>;
      return { ...node, config };
    });
    const saved = await context.app.inject({ method: "PUT", url: `/api/workflows/${workflow.id}`, headers: { cookie: context.cookie }, payload: { ...workflow, nodes } });
    expect(saved.statusCode, saved.body).toBe(200);
  };

  it("every webhook, form, chat, MCP trigger and schedule in a starter is off, and its description says so", () => {
    let entries = 0;
    for (const file of starterFiles) {
      const exported = JSON.parse(fs.readFileSync(path.join(starterDir, file), "utf8")) as { workflow: Workflow; companions?: Array<{ workflow: Workflow }> };
      for (const workflow of [exported.workflow, ...(exported.companions ?? []).map((companion) => companion.workflow)]) {
        const live = workflow.nodes.filter((node) => LIVE_ENTRY_NODE_TYPES.has(node.type));
        for (const node of live) expect((node.config as Record<string, unknown>).active, `${file} ${node.id}`).toBe(false);
        if (live.length > 0) expect(workflow.description, file).toMatch(/switched off/);
        entries += live.length;
      }
    }
    expect(entries).toBe(3);
    const approval = JSON.parse(fs.readFileSync(path.join(starterDir, "starter-approval.json"), "utf8")) as { workflow: Workflow };
    const gate = approval.workflow.nodes.find((node) => node.type === "approval_gate")!;
    expect(gate.config).toMatchObject({ allowSelfApproval: true });
    expect(String((gate.config as Record<string, unknown>).message)).toMatch(/Self-approval is on/);
    expect(approval.workflow.description).toMatch(/Self-approval is on: whoever starts a run may approve it themselves/);
  });

  it("the webhook starter's URL and test URL answer not found until it is turned on; the editor runs it", async () => {
    const { workflow } = await useStarter("Webhook: reshape and reply");
    const hook = workflow.nodes.find((node) => node.type === "webhook_input")!;
    expect(hook.config).toMatchObject({ active: false });
    const webhookPath = String((hook.config as Record<string, unknown>).path);
    const body = { first_name: "Ada", last_name: "Lovelace", email: "ADA@example.com", plan: "enterprise" };
    // Its editor is told it is off; anyone else gets the plain 404 (it has no token to check).
    const anonymousOff = await anonymous("POST", `/webhook/${webhookPath}`, body);
    expect(anonymousOff.statusCode).toBe(404);
    expect(anonymousOff.json()).toEqual({ error: "No webhook endpoint matches this path and method" });
    const off = await context.app.inject({ method: "POST", url: `/webhook/${webhookPath}`, headers: { cookie: context.cookie }, payload: body });
    expect(off.statusCode).toBe(404);
    expect(off.json()).toMatchObject({ code: "trigger_off", error: "This webhook is turned off. Turn it on in the workflow editor to accept live calls." });
    // Another method or path does not advertise it either.
    const wrongMethod = await anonymous("GET", `/webhook/${webhookPath}`);
    expect(wrongMethod.statusCode).toBe(404);
    expect(JSON.stringify(wrongMethod.json().availableEndpoints ?? [])).not.toContain(`"${webhookPath}"`);
    const elsewhere = await anonymous("POST", `/webhook/no-such-${webhookPath}`, body);
    expect(JSON.stringify(elsewhere.json().availableEndpoints ?? [])).not.toContain(`"${webhookPath}"`);
    // The editor's runs (Run, Webhook run) work while it is off; the test URL answers as production does, and an
    // anonymous caller gets the plain 404.
    expect((await run(workflow)).status).toBe("success");
    expect((await webhookRun(workflow)).status).toBe("success");
    const test = await context.app.inject({ method: "POST", url: `/webhook-test/${webhookPath}`, headers: { cookie: context.cookie }, payload: body });
    expect(test.statusCode, test.body).toBe(404);
    expect(test.json()).toMatchObject({ code: "trigger_off" });
    expect((await anonymous("POST", `/webhook-test/${webhookPath}`, body)).json()).toEqual({ error: "No webhook endpoint matches this path and method" });

    await turnOn(workflow, hook.id);
    const on = await anonymous("POST", `/webhook/${webhookPath}`, body);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.body).toContain("Ada Lovelace");
    const testOn = await context.app.inject({ method: "POST", url: `/webhook-test/${webhookPath}`, headers: { cookie: context.cookie }, payload: body });
    expect(testOn.statusCode, testOn.body).toBe(200);
  });

  it("the form starter's page and submissions answer not found until it is turned on", async () => {
    const { workflow } = await useStarter("Form intake: route requests");
    const form = workflow.nodes.find((node) => node.type === "form_trigger")!;
    const formPath = String((form.config as Record<string, unknown>).path);
    const page = await anonymous("GET", `/api/forms/${formPath}`);
    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("This form is turned off");
    const submit = await anonymous("POST", `/api/forms/${formPath}`, { name: "Grace", email: "grace@example.com", topic: "Support", message: "Help" });
    expect(submit.statusCode).toBe(404);
    expect(submit.json()).toMatchObject({ code: "trigger_off" });
    expect((await webhookRun(workflow)).status).toBe("success");

    await turnOn(workflow, form.id);
    expect((await anonymous("GET", `/api/forms/${formPath}`)).statusCode).toBe(200);
    const accepted = await anonymous("POST", `/api/forms/${formPath}`, { name: "Grace", email: "grace@example.com", topic: "Support", message: "Help" });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("an off chat or MCP trigger answers not found, and the MCP gateway leaves its tool out", async () => {
    const echo = { id: "reply", type: "output", name: "Reply", position: { x: 300, y: 0 }, config: {} };
    const workflow = (id: string, trigger: Record<string, unknown>): Workflow =>
      ({
        id,
        name: `Off ${id}`,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [{ id: "start", name: "Start", position: { x: 0, y: 0 }, ...trigger }, echo],
        edges: [{ id: "e1", source: "start", target: "reply" }]
      }) as unknown as Workflow;
    await context.store.upsertWorkflow(workflow("wf-chat-off", { type: "chat_trigger", config: { path: "chat-off", authMode: "public", active: false } }));
    expect((await anonymous("POST", "/api/chat/wf-chat-off", { message: "hi" })).json()).toEqual({ error: "Not found" });
    const chat = await context.app.inject({ method: "POST", url: "/api/chat/wf-chat-off", headers: { cookie: context.cookie }, payload: { message: "hi" } });
    expect(chat.statusCode).toBe(404);
    expect(chat.json()).toMatchObject({ code: "trigger_off", error: "This chat is turned off. Turn it on in the workflow editor to accept live calls." });

    const mcpOff = workflow("wf-mcp-off", { type: "mcp_server_trigger", config: { path: "mcp-off", toolName: "off_tool", authMode: "public", active: false } });
    await context.store.upsertWorkflow(mcpOff);
    expect((await anonymous("GET", "/api/mcp-server/mcp-off/manifest")).statusCode).toBe(404);
    const invoke = await anonymous("POST", "/api/mcp-server/mcp-off/invoke", { arguments: {} });
    expect(invoke.statusCode).toBe(404);
    expect(invoke.json()).toMatchObject({ code: "trigger_off" });

    const catalogStore = {
      getWorkflow: async (id: string) => await context.store.getWorkflow(id),
      listMcpServers: async () => [],
      getMcpToolSnapshot: async () => null,
      listMcpToolPolicies: async () => [],
      listMcpToolClassifications: async () => [],
      listMcpToolOpenWorldOverrides: async () => [],
      listDataDestinations: async () => []
    };
    const toolset = { id: "ts", slug: "ts", name: "TS", description: null, projectId: null, enabled: true, members: [{ kind: "workflow", workflowId: "wf-mcp-off" }] };
    const off = await buildGatewayCatalog({ toolset: toolset as never, role: "admin" as never, store: catalogStore as never });
    expect(off.tools.map((tool) => tool.name)).toEqual([]);
    expect(off.warnings.join(" ")).toMatch(/'off_tool' is turned off/);
    await context.store.upsertWorkflow({ ...mcpOff, nodes: mcpOff.nodes.map((node) => (node.id === "start" ? { ...node, config: { path: "mcp-off", toolName: "off_tool", authMode: "public" } } : node)) });
    const on = await buildGatewayCatalog({ toolset: toolset as never, role: "admin" as never, store: catalogStore as never });
    expect(on.tools.map((tool) => tool.name)).toEqual(["off_tool"]);
    expect((await anonymous("GET", "/api/mcp-server/mcp-off/manifest")).statusCode).toBe(200);
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
