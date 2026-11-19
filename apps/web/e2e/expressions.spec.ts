import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Writing templates: after a run, typing {{ in a template field lists the run's fields and inserts the chosen path;
 * a field name dragged from the Input pane inserts {{path}}; a {{ }} the run had no value for is named under the
 * field; Strict templates (workflow menu) makes that missing value fail the node; and a node added from the palette
 * gets an id made from its label. No model server is contacted (a request to a local model port fails the test).
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "expressions");

const modelServerHits: string[] = [];

async function openStudio(page: Page): Promise<void> {
  await page.context().route(/:11434(\/|$)/, async (route) => {
    modelServerHits.push(route.request().url());
    await route.abort();
  });
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => {
    window.localStorage.setItem("l2m:welcome-dismissed", "1");
    // Side by side, so the Input pane and the parameters are both in view.
    window.localStorage.setItem("l2m:inspector-layout", "split");
  });
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
  // Run data reaches the inspector in debug mode.
  const debugOff = page.getByRole("button", { name: "Debug mode: OFF" });
  if (await debugOff.isVisible()) await debugOff.click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(400);
}

function canvasNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator(".wf-card-name, .wf-hub-name", { hasText: new RegExp(`^${label}$`) }) });
}

async function run(page: Page): Promise<void> {
  await page.getByRole("banner").getByRole("button", { name: /^Run/ }).click();
  await expect(page.locator(".hud-run-status .hud-run-label")).toContainText("last run", { timeout: 30_000 });
}

async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/workflows"));
  await page.getByRole("banner").getByRole("button", { name: /^Save/ }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
}

const position = (x: number) => ({ x, y: 200 });

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("writing templates", () => {
  test.setTimeout(150_000);
  const made: string[] = [];

  test.beforeEach(async ({ page }) => {
    await openStudio(page);
  });

  test.afterEach(async ({ page }) => {
    for (const id of made.splice(0)) await page.request.delete(`/api/workflows/${id}`);
    expect(modelServerHits).toEqual([]);
  });

  test("autocomplete, drag, missing-value note and strict templates", async ({ page }) => {
    const id = `wf-e2e-expr-${Date.now()}`;
    made.push(id);
    const workflow = {
      id,
      name: `E2E Expressions ${id}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "start", type: "text_input", name: "Start", position: position(100), config: { text: "hello" } },
        {
          id: "fetch_items",
          type: "set_node",
          name: "Fetch items",
          position: position(400),
          config: { assignments: [{ key: "order", valueTemplate: '{"customer":"Ada","total":42}' }, { key: "status", valueTemplate: "paid" }] }
        },
        { id: "report", type: "output", name: "Report", position: position(700), config: { responseTemplate: "" } }
      ],
      edges: [
        { id: "e1", source: "start", target: "fetch_items" },
        { id: "e2", source: "fetch_items", target: "report" }
      ]
    };
    expect((await page.request.post("/api/workflows", { data: workflow })).ok()).toBeTruthy();
    await openEditor(page, id);
    await run(page);

    await canvasNode(page, "Report").dblclick();
    const inspector = page.getByRole("dialog", { name: /Inspect Report/ });
    await expect(inspector).toBeVisible();
    const field = inspector.getByRole("textbox", { name: "Response Template" });
    await field.click();

    // Autocomplete: {{ lists the run's fields; typing filters; Enter inserts and closes the braces.
    await field.pressSequentially("Hi {{");
    const list = inspector.getByTestId("template-suggest");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option").first()).toContainText("order");
    await expect(list.getByRole("option").first()).toContainText("Fetch items");
    await page.screenshot({ path: path.join(SHOT_DIR, "01-autocomplete.png") });
    await field.pressSequentially("cust");
    await expect(list.getByRole("option").first()).toContainText("order.customer");
    await page.keyboard.press("Enter");
    await expect(field).toHaveValue("Hi {{order.customer}}");
    await expect(inspector.locator(".expression-preview pre").first()).toHaveText("Hi Ada");

    // Drag a field name from the Input pane into the field: it inserts {{status}}.
    await field.press("End");
    await field.pressSequentially(" / ");
    const statusKey = inspector.locator('th[data-template-path="status"]').first();
    await expect(statusKey).toBeVisible();
    await statusKey.dragTo(field);
    await expect(field).toHaveValue(/\{\{status\}\}/);
    await page.screenshot({ path: path.join(SHOT_DIR, "02-dragged.png") });

    // A {{ }} the run had no value for is named under the field.
    await field.fill("Hi {{order.nope}}");
    const warning = inspector.getByTestId("template-missing-warning");
    await expect(warning).toContainText("{{order.nope}}");
    await expect(warning).toContainText("renders empty");
    await page.screenshot({ path: path.join(SHOT_DIR, "03-missing-note.png") });
    await inspector.getByRole("button", { name: "Save changes" }).click();
    await expect(inspector).toBeHidden();

    // Strict templates: the same template fails the node.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Strict templates" }).click();
    await save(page);
    const storedWorkflow = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { settings?: { strictTemplates?: boolean } };
    expect(storedWorkflow.settings?.strictTemplates).toBe(true);
    await run(page);
    await canvasNode(page, "Report").dblclick();
    await expect(page.getByRole("dialog", { name: /Inspect Report/ })).toContainText("{{order.nope}} has no value", { timeout: 15_000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "04-strict-failure.png") });
  });

  test("a node added from the palette gets an id made from its label", async ({ page }) => {
    const id = `wf-e2e-ids-${Date.now()}`;
    made.push(id);
    const workflow = {
      id,
      name: `E2E Ids ${id}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [{ id: "start", type: "text_input", name: "Start", position: position(100), config: { text: "hello" } }],
      edges: []
    };
    expect((await page.request.post("/api/workflows", { data: workflow })).ok()).toBeTruthy();
    await openEditor(page, id);
    for (let index = 0; index < 2; index += 1) {
      await page.getByRole("button", { name: /Add node/ }).first().click();
      await page.getByRole("textbox", { name: "Search nodes" }).fill("HTTP Request");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "Add a node" })).toBeHidden();
    }
    await save(page);
    const stored = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { nodes: Array<{ id: string; type: string }> };
    expect(stored.nodes.filter((node) => node.type === "http_request").map((node) => node.id).sort()).toEqual(["http_request", "http_request_2"]);
  });
});
