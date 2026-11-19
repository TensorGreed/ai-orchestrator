import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Describe it: on Echo the builder explains that a real model is needed and offers templates; with a model (a mock
 * OpenAI-compatible server started here that answers with canned tool calls) a description becomes a previewed draft,
 * saved as a new workflow from Home and from an empty canvas. Nothing is overwritten. Any request towards a local
 * Ollama port fails the suite. The API must be able to reach 127.0.0.1 (the default outbound settings).
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "workflow-builder");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const ollamaAttempts: string[] = [];
let workflowIdsBefore = new Set<string>();
let mockServer: http.Server;
let mockBaseUrl = "";
const modelRequests: Array<{ messages: Array<{ role: string }> }> = [];

const draft = {
  name: "Order intake",
  description: "Takes an order from a webhook, shapes it and posts it to the shop API",
  nodes: [
    { id: "incoming_order", type: "webhook_input", label: "Incoming order", config: { path: "orders", method: "POST" } },
    {
      id: "shape_order",
      type: "set_node",
      label: "Shape order",
      config: { assignments: [{ key: "orderId", valueTemplate: "{{webhook.id}}", type: "auto" }] }
    },
    {
      id: "post_order",
      type: "http_request",
      label: "Post order",
      config: { method: "POST", urlTemplate: "https://shop.example.com/orders", bodyTemplate: "{\"id\": \"{{shape_order.orderId}}\"}" }
    }
  ],
  edges: [
    { source: "incoming_order", target: "shape_order" },
    { source: "shape_order", target: "post_order" }
  ]
};

/** The model's turns, by how many tool results the request already holds: catalog, details, a broken draft, a fixed one. */
const turns = [
  { name: "list_node_types", arguments: { query: "webhook set http" } },
  { name: "get_node_types", arguments: { types: ["webhook_input", "set_node", "http_request"] } },
  { name: "submit_workflow", arguments: { ...draft, edges: [{ source: "incoming_order", target: "nowhere" }] } },
  { name: "submit_workflow", arguments: draft }
];

function sidebarItem(label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function workflowIds(): Promise<Set<string>> {
  const listed = await page.request.get("/api/workflows");
  if (!listed.ok()) return new Set();
  const body = (await listed.json()) as Array<{ id: string }> | { items?: Array<{ id: string }> };
  const rows = Array.isArray(body) ? body : (body.items ?? []);
  return new Set(rows.map((row) => row.id));
}

async function signIn(browser: Browser): Promise<void> {
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(/:11434(\/|$)/, async (route) => {
    ollamaAttempts.push(route.request().url());
    await route.abort();
  });
  page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => {
    window.localStorage.setItem("l2m:welcome-dismissed", "1");
  });
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  mockServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { messages?: Array<{ role: string }> };
      modelRequests.push({ messages: parsed.messages ?? [] });
      const toolResults = (parsed.messages ?? []).filter((message) => message.role === "tool").length;
      const turn = turns[toolResults];
      const message = turn
        ? { role: "assistant", content: null, tool_calls: [{ id: `call_${modelRequests.length}`, type: "function", function: { name: turn.name, arguments: JSON.stringify(turn.arguments) } }] }
        : { role: "assistant", content: "Done." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "mock-builder", choices: [{ index: 0, message, finish_reason: turn ? "tool_calls" : "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockBaseUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}/v1`;
  await signIn(browser);
  workflowIdsBefore = await workflowIds();
});

test.afterAll(async () => {
  for (const id of await workflowIds()) {
    if (!workflowIdsBefore.has(id)) await page.request.delete(`/api/workflows/${id}`);
  }
  await context.close();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  expect(ollamaAttempts, "the studio tried to reach a local Ollama").toEqual([]);
});

test("on Echo it explains that a real model is needed and offers three templates", async () => {
  await sidebarItem("Home").click();
  await page.getByRole("button", { name: "Describe it…" }).click();
  const dialog = page.getByRole("dialog", { name: "Describe a workflow" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("builder-model")).toContainText("Echo");
  await dialog.getByLabel("What should the workflow do?").fill("When an order comes in on a webhook, post it to our shop API");
  await page.screenshot({ path: path.join(SHOT_DIR, "after-01-describe.png") });
  await dialog.getByRole("button", { name: "Build" }).click();
  const callout = dialog.getByTestId("builder-needs-model");
  await expect(callout).toContainText("needs a real model");
  await expect(callout.getByRole("button", { name: "Use template" })).toHaveCount(3);
  expect(modelRequests).toHaveLength(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-02-echo-templates.png") });
});

test("with a model it previews the draft and saves it as a new workflow", async () => {
  const dialog = page.getByRole("dialog", { name: "Describe a workflow" });
  await dialog.getByText("More", { exact: true }).click();
  await dialog.getByLabel("Provider").selectOption("openai_compatible");
  await dialog.getByLabel("Model", { exact: true }).fill("mock-builder");
  await dialog.getByLabel("Base URL").fill(mockBaseUrl);
  await dialog.getByRole("button", { name: "Build" }).click();

  const preview = dialog.getByRole("region", { name: "Preview" });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByRole("img", { name: "Preview of Order intake" })).toBeVisible();
  await expect(dialog.getByTestId("builder-preview-nodes")).toContainText("Incoming order");
  await expect(dialog.getByTestId("builder-preview-nodes")).toContainText("Shape order");
  await expect(dialog.getByTestId("builder-preview-nodes")).toContainText("Post order");
  await expect(dialog.getByTestId("builder-preview-addresses")).toContainText("https://shop.example.com/orders");
  // Catalog, details, the rejected draft and the fixed one: four model turns, none after the accepted draft.
  expect(modelRequests).toHaveLength(4);
  expect(await workflowIds()).toEqual(workflowIdsBefore);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-03-preview.png") });

  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebarItem("Editor")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".react-flow__node").filter({ hasText: "Shape order" })).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const after = await workflowIds();
  expect(after.size).toBe(workflowIdsBefore.size + 1);
  for (const id of workflowIdsBefore) expect(after.has(id)).toBe(true);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-04-inserted.png") });
});

test("an empty canvas offers it too, and inserting makes another new draft", async () => {
  const idsBefore = await workflowIds();
  // Clear asks first (a browser confirm, accepted by the dialog handler).
  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  const start = page.getByTestId("canvas-empty-start");
  await expect(start).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, "after-05-empty-canvas.png") });
  await start.getByRole("button", { name: "Describe it…" }).click();

  const dialog = page.getByRole("dialog", { name: "Describe a workflow" });
  // The model chosen under More is kept in this browser.
  await expect(dialog.getByTestId("builder-model")).toContainText("mock-builder");
  modelRequests.length = 0;
  await dialog.getByLabel("What should the workflow do?").fill("Take orders from a webhook and post them to the shop");
  await dialog.getByRole("button", { name: "Build" }).click();
  await expect(dialog.getByRole("region", { name: "Preview" })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const after = await workflowIds();
  expect(after.size).toBe(idsBefore.size + 1);
});
