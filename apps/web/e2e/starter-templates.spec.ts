import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Starter templates: the gallery's Starters and its "Runs without setup" filter, starters that run with no setup from
 * the editor, and the forms that replaced raw JSON (Switch cases, Form Trigger fields, sub-workflow mappings, vector
 * store settings). Any request towards a local Ollama port fails the suite.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "starter-templates");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const ollamaAttempts: string[] = [];
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
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

function card(name: string) {
  return page.locator(".tpl-card").filter({ has: page.locator(".tpl-card-name", { hasText: name }) });
}

async function useStarter(name: string): Promise<void> {
  await sidebarItem("Templates").click();
  await page.getByRole("button", { name: "Starters", exact: true }).click();
  await card(name).getByRole("button", { name: "Use Template" }).click();
  await expect(sidebarItem("Editor")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue(`${name} (from template)`);
}

function canvasNode(label: string) {
  return page.locator(".react-flow__node").filter({ hasText: label }).first();
}

async function inspect(label: string) {
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await canvasNode(label).dblclick();
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  await expect(inspector).toBeVisible();
  return inspector;
}

async function runAndExpectAllOk(): Promise<void> {
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  const status = page.locator(".hud-run-status .hud-run-label");
  await expect(status).toContainText("last run", { timeout: 30_000 });
  await expect(status).toHaveText(/ \d+ ok$/);
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

test("the gallery shows ten starters, and the filter keeps only templates that run without setup", async () => {
  await sidebarItem("Templates").click();
  const filter = page.getByRole("button", { name: "Runs without setup" });
  await expect(filter).toHaveAttribute("aria-pressed", "false");
  await page.screenshot({ path: path.join(SHOT_DIR, "after-01-gallery.png") });

  await page.getByRole("button", { name: "Starters", exact: true }).click();
  await expect(page.locator(".tpl-card")).toHaveCount(10);
  await expect(page.locator(".tpl-card .tpl-dep-pill-none")).toHaveCount(10);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-02-starters.png"), fullPage: true });

  await page.getByRole("button", { name: "All", exact: true }).click();
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tpl-card").first()).toBeVisible();
  const shown = await page.locator(".tpl-card").count();
  expect(shown).toBeGreaterThanOrEqual(10);
  await expect(page.locator(".tpl-card .tpl-dep-pill-none")).toHaveCount(shown);
  await expect(page.locator(".tpl-card [data-testid^='tpl-needs-model-']")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-03-runs-without-setup.png"), fullPage: true });
  await filter.click();
});

test("a starter that calls the sample API runs from the editor with no setup", async () => {
  test.setTimeout(120_000);
  await useStarter("Schedule: fetch, filter and notify");
  await runAndExpectAllOk();
  await expect(canvasNode("Notify (sample)").getByTestId("node-run-preview")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "after-04-schedule-run.png") });
});

test("the sub-workflow starter brings its sub-workflow and runs it", async () => {
  test.setTimeout(120_000);
  await useStarter("Call a sub-workflow");
  const inspector = await inspect("Format a greeting");
  // The mapping is rows, not JSON.
  await expect(inspector.getByLabel("From this workflow 1")).toHaveValue("name");
  await expect(inspector.getByLabel("Sub-workflow input 1")).toHaveValue("name");
  await expect(inspector.getByLabel("Input Mapping (JSON object)")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-05-sub-workflow-mapping.png") });
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await runAndExpectAllOk();
  const names = await page.request.get("/api/workflows").then(async (response) => JSON.stringify(await response.json()));
  expect(names).toContain("Format a greeting (sub-workflow)");
});

test("Switch cases and Form Trigger fields are rows", async () => {
  test.setTimeout(120_000);
  await useStarter("Form intake: route requests");
  let inspector = await inspect("Route by topic");
  await expect(inspector.getByLabel("Case 1 value")).toHaveValue("Sales");
  await expect(inspector.getByLabel("Case 2 output")).toHaveValue("support");
  await expect(inspector.getByLabel("Cases array (JSON)")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-06-switch-cases.png") });
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  inspector = await inspect("Contact form");
  await expect(inspector.getByLabel("Field 3 name")).toHaveValue("topic");
  await expect(inspector.getByLabel("Field 3 choices")).toHaveValue("Sales, Support, Other");
  await expect(inspector.getByLabel("Fields (JSON array)")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-07-form-fields.png") });
  await inspector.getByRole("button", { name: "Close inspector" }).click();
});

test("the document search starter runs on the local embedder and shows typed vector store settings", async () => {
  test.setTimeout(120_000);
  await useStarter("Search a few documents");
  await runAndExpectAllOk();
  const inspector = await inspect("Search the articles");
  await inspector.getByTestId("advanced-fields").locator("summary").first().click();
  await inspector.getByLabel("Embedder").selectOption("openai-embedder");
  await expect(inspector.getByRole("textbox", { name: "Model", exact: true })).toBeVisible();
  await expect(inspector.getByLabel("Vector Store Extra Config (JSON)")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-08-vector-store-settings.png") });
  await inspector.getByRole("button", { name: "Close inspector" }).click();
  await page.getByRole("alertdialog", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click();
  await expect(inspector).toHaveCount(0);
});

test("the webhook starter's URL and test URL answer not found until its trigger is turned on; the editor runs it either way", async () => {
  test.setTimeout(120_000);
  const before = await workflowIds();
  await useStarter("Webhook: reshape and reply");
  await runAndExpectAllOk();

  let id = "";
  await expect
    .poll(async () => {
      id = [...(await workflowIds())].find((candidate) => !before.has(candidate)) ?? "";
      return id;
    }, { timeout: 15_000 })
    .not.toBe("");
  const stored = async () =>
    (await (await page.request.get(`/api/workflows/${id}`)).json()) as { nodes: Array<{ type: string; config: Record<string, unknown> }> };
  const hookConfig = (await stored()).nodes.find((node) => node.type === "webhook_input")!.config;
  expect(hookConfig.active).toBe(false);
  const url = `/webhook/${String(hookConfig.path)}`;
  const off = await page.request.post(url, { data: { name: "Ada Lovelace" } });
  expect(off.status()).toBe(404);
  expect(await off.json()).toMatchObject({ code: "trigger_off" });
  // The test URL honours Off too (the page's session may run it); the editor's Webhook run says so and still runs.
  const testOff = await page.request.post(`/webhook-test/${String(hookConfig.path)}`, { data: { name: "Ada Lovelace" } });
  expect(testOff.status()).toBe(404);
  expect(await testOff.json()).toMatchObject({ code: "trigger_off" });
  await page.getByRole("button", { name: "Webhook run", exact: true }).click();
  const runDialog = page.getByRole("dialog", { name: "Webhook run" });
  await expect(runDialog.getByTestId("webhook-run-off-note")).toContainText("A webhook in this workflow is off");
  await runDialog.getByRole("button", { name: "Cancel" }).click();

  const inspector = await inspect("Incoming request");
  await expect(inspector.getByTestId("live-entry-off")).toContainText("Run in the editor works either way.");
  await page.screenshot({ path: path.join(SHOT_DIR, "after-09-webhook-off.png") });
  await inspector.getByTestId("live-entry-off").getByRole("button", { name: "Turn on" }).click();
  await expect(inspector.getByTestId("live-entry-on")).toBeVisible();
  await inspector.getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await stored()).nodes.find((node) => node.type === "webhook_input")!.config.active, { timeout: 15_000 }).toBeUndefined();

  const on = await page.request.post(url, { data: { first_name: "Ada", last_name: "Lovelace", email: "ADA@example.com", plan: "enterprise" } });
  expect(on.status()).toBe(200);
  expect(await on.text()).toContain("Ada Lovelace");
  // The validation's repro: the caller gets the Webhook Response's body, though the Run result node runs after it.
  const repro = await page.request.post(url, { data: { first_name: "Grace", last_name: "Hopper", email: "G@x.com", orders: 12 } });
  expect(repro.status()).toBe(200);
  expect(await repro.json()).toEqual({ customer: "Grace Hopper", email: "g@x.com", vip: true });
  const testRoute = await page.request.post(`/webhook-test/${String(hookConfig.path)}`, { data: { first_name: "Grace", last_name: "Hopper", email: "G@x.com", orders: 12 } });
  expect(await testRoute.json()).toEqual({ customer: "Grace Hopper", email: "g@x.com", vip: true });
});
