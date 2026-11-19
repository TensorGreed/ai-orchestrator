import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Model choices from the end-user validation (2026-11-19): templates say which provider key they need (B12), Describe
 * it shows the saved credential a build uses (B14), a model node's name follows its model, and a swarm's agents get one
 * model in one click. No model is called: the provider is only picked, never run. Any request towards a local Ollama
 * port fails the suite.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "model-choices");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const ollamaAttempts: string[] = [];
let workflowIdsBefore = new Set<string>();
const secretIds: string[] = [];

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

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  workflowIdsBefore = await workflowIds();
});

test.afterAll(async () => {
  for (const id of await workflowIds()) {
    if (!workflowIdsBefore.has(id)) await page.request.delete(`/api/workflows/${id}`);
  }
  for (const id of secretIds) await page.request.delete(`/api/secrets/${id}`);
  await context.close();
  expect(ollamaAttempts, "the studio tried to reach a local Ollama").toEqual([]);
});

test("the gallery says which provider key a template needs", async () => {
  await sidebarItem("Templates").click();
  const citations = page.getByTestId("tpl-needs-model-builtin-rag-with-citations-flow");
  await expect(citations).toHaveText("Needs an OpenAI key");
  // A template on a model server without a key still says it needs a model.
  await expect(page.getByTestId("tpl-needs-model-builtin-structured-output-flow")).toHaveText("Needs a model");
  await citations.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOT_DIR, "after-01-gallery-needs-key.png") });
});

test("a swarm's agents get one model in one click, and model names follow it", async () => {
  test.setTimeout(120_000);
  const used = await page.request.post("/api/templates/builtin-supervisor-worker-swarm-flow/use");
  expect(used.ok()).toBeTruthy();
  const { workflowId } = (await used.json()) as { workflowId: string };
  await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
  const supervisorModel = page.locator(".react-flow__node").filter({ hasText: "Supervisor Chat Model (echo)" });
  await expect(supervisorModel).toBeVisible({ timeout: 30_000 });

  await supervisorModel.dblclick();
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  await expect(inspector).toBeVisible();
  // Every agent is on the same model: nothing to offer yet.
  await expect(inspector.getByTestId("use-model-for-all-agents")).toHaveCount(0);
  await inspector.getByRole("combobox", { name: "Provider" }).selectOption("anthropic");
  await expect(inspector.getByLabel("Node name")).toHaveValue("Supervisor Chat Model (anthropic)");
  const offer = inspector.getByTestId("use-model-for-all-agents");
  await expect(offer).toContainText("2 other agents use another model.");
  await page.screenshot({ path: path.join(SHOT_DIR, "after-02-use-for-all-agents.png") });
  await offer.getByRole("button", { name: "Use for all agents in this workflow" }).click();
  await expect(inspector).toBeHidden();

  for (const label of ["Supervisor Chat Model (anthropic)", "Researcher Chat (anthropic)", "Computer Chat (anthropic)"]) {
    await expect(page.locator(".react-flow__node").filter({ hasText: label })).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOT_DIR, "after-03-swarm-on-one-model.png") });

  // One undo takes the whole change back.
  // An empty spot of the canvas (left of the agents, under the toolbar).
  await page.locator(".react-flow__pane").click({ position: { x: 150, y: 250 } });
  await page.keyboard.press("Control+z");
  for (const label of ["Supervisor Chat Model (echo)", "Researcher Chat (echo)", "Computer Chat (echo)"]) {
    await expect(page.locator(".react-flow__node").filter({ hasText: label })).toBeVisible();
  }
});

test("Describe it shows the saved credential a build uses", async () => {
  const created = await page.request.post("/api/secrets", {
    data: { name: "Team Anthropic key", provider: "anthropic", value: "sk-ant-e2e-not-a-real-key" }
  });
  expect(created.ok()).toBeTruthy();
  const secret = (await created.json()) as { id: string };
  secretIds.push(secret.id);
  // The builder's model choice under More is kept per browser: start from the default.
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith("l2m:builder-model")) window.localStorage.removeItem(key);
  });
  await page.goto("/?mode=dashboard");
  await page.getByRole("button", { name: "Describe it…" }).click();
  const dialog = page.getByRole("dialog", { name: "Describe a workflow" });
  await expect(dialog.getByTestId("builder-model")).toContainText("Anthropic");
  await dialog.getByText("More", { exact: true }).click();
  const credential = dialog.getByLabel("Credential");
  await expect(credential).toHaveValue(secret.id);
  await expect(credential.locator("option:checked")).toHaveText("Team Anthropic key (anthropic)");
  await page.screenshot({ path: path.join(SHOT_DIR, "after-04-describe-credential.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.request.delete(`/api/secrets/${secret.id}`);
  secretIds.length = 0;
});
