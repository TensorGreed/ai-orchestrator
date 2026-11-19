import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Model defaults: a new LLM Call starts on the built-in Echo model, opening a model node asks no model server for its
 * models (only "Load models" does), and the template gallery says which templates need a model. Any request towards a
 * local Ollama port fails the suite.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "model-defaults");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
/** Requests the browser tried to send to a local Ollama port (blocked); any one fails the suite. */
const ollamaAttempts: string[] = [];
/** Model-list requests the studio sent, with their bodies. */
const modelListRequests: Array<Record<string, unknown>> = [];
let workflowIdsBefore = new Set<string>();

function sidebarItem(label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function workflowIds(): Promise<Set<string>> {
  const listed = await page.request.get("/api/workflows");
  if (!listed.ok()) return new Set();
  const body = (await listed.json()) as Array<{ id: string }> | { items?: Array<{ id: string }>; workflows?: Array<{ id: string }> };
  const rows = Array.isArray(body) ? body : (body.items ?? body.workflows ?? []);
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
  page.on("request", (request) => {
    if (request.url().includes("/api/providers/models")) {
      modelListRequests.push(JSON.parse(request.postData() ?? "{}") as Record<string, unknown>);
    }
  });
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  workflowIdsBefore = await workflowIds();
});

test.afterAll(async () => {
  for (const id of await workflowIds()) {
    if (!workflowIdsBefore.has(id)) await page.request.delete(`/api/workflows/${id}`);
  }
  await context.close();
  expect(ollamaAttempts, "the studio tried to reach a local Ollama").toEqual([]);
});

test("a new LLM Call starts on Echo and opening it lists no models", async () => {
  test.setTimeout(120_000);
  await sidebarItem("Home").click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await expect(sidebarItem("Editor")).toHaveAttribute("aria-current", "page");

  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("textbox", { name: "Search nodes" }).fill("LLM Call");
  await page.locator(".node-palette-node-row").filter({ hasText: "LLM Call" }).first().click();

  const llmNode = page.locator(".react-flow__node").filter({ hasText: "LLM Call" }).first();
  await expect(llmNode).toBeVisible();
  await llmNode.dblclick();
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  await expect(inspector).toBeVisible();
  const providerPicker = inspector.getByRole("combobox", { name: "Provider" });
  await expect(providerPicker).toHaveValue("echo");
  await expect(inspector.getByTestId("echo-provider-tip")).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Load models" })).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-01-llm-call-echo.png") });

  // Switching to Ollama shows the explicit action and still asks nothing.
  await providerPicker.selectOption("ollama");
  const loadModels = inspector.getByRole("button", { name: "Load models" });
  await expect(loadModels).toBeVisible();
  await page.waitForTimeout(500);
  expect(modelListRequests).toEqual([]);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-02-ollama-load-models.png") });

  // Only the click asks, and it goes through the API, never from the browser to a local port.
  await loadModels.click();
  await expect(inspector.getByText(/No models (found|listed)|models? loaded|fetch failed|Could not load/)).toBeVisible({ timeout: 15_000 });
  expect(modelListRequests).toHaveLength(1);
  expect(modelListRequests[0]).toMatchObject({ providerId: "ollama" });

  await providerPicker.selectOption("echo");
  await expect(inspector.getByRole("button", { name: "Load models" })).toHaveCount(0);
  await inspector.getByRole("button", { name: "Close inspector" }).click();
});

test("the agent's Language Models drawer offers LLM Call", async () => {
  await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: /Add node/ }).click();
  await page.getByRole("textbox", { name: "Search nodes" }).fill("Agent Orchestrator");
  await page.locator(".node-palette-node-row").filter({ hasText: "Agent Orchestrator" }).first().click();
  // The agent's own "add chat model" port opens the Language Models drawer.
  await page.getByRole("button", { name: /^Add chat model/i }).first().click();
  await expect(page.getByRole("heading", { name: "Language Models" })).toBeVisible();
  await expect(page.locator(".node-palette-node-row").filter({ hasText: "LLM Call" }).first()).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, "after-03-language-models-drawer.png") });
  expect(modelListRequests).toHaveLength(1);
});

test("the template gallery says which templates need a model", async () => {
  await page.keyboard.press("Escape");
  await sidebarItem("Templates").click();
  await expect(page.getByTestId("tpl-deps-builtin-conditional-flow")).toContainText("Runs without setup");
  await expect(page.getByTestId("tpl-deps-builtin-rag-flow")).toContainText("Runs without setup");
  await expect(page.getByTestId("tpl-deps-builtin-agentic-mcp-flow")).toContainText("Runs without setup");
  await expect(page.getByTestId("tpl-needs-model-builtin-structured-output-flow")).toBeVisible();
  await expect(page.getByTestId("tpl-needs-model-builtin-vscode-l2m-coding-agent-flow")).toBeVisible();
  await page.getByTestId("tpl-deps-builtin-structured-output-flow").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOT_DIR, "after-04-templates.png"), fullPage: true });
});
