import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Runs report what really happened (the end-user validation's B4, B8, B9): a handled failure reads as handled, an error
 * workflow's run is in Runs and linked to the failed run both ways, and the run tape counts nodes. Any request towards a
 * local Ollama port fails the suite.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "runs-report");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const ollamaAttempts: string[] = [];
const created: string[] = [];

function sidebarItem(label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
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

async function runInEditor(): Promise<string> {
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  const status = page.locator(".hud-run-status .hud-run-label");
  await expect(status).toContainText("last run", { timeout: 30_000 });
  return (await status.textContent()) ?? "";
}

async function saveWorkflow(workflow: Record<string, unknown>): Promise<void> {
  const response = await page.request.post("/api/workflows", { data: workflow });
  expect(response.ok(), await response.text()).toBeTruthy();
  created.push(String(workflow.id));
}

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
});

test.afterAll(async () => {
  for (const id of created) await page.request.delete(`/api/workflows/${id}`);
  await context.close();
  expect(ollamaAttempts, "the studio tried to reach a local Ollama").toEqual([]);
});

test("a failure sent to its connected Error output reads as handled, not failed (the Retry starter)", async () => {
  test.setTimeout(120_000);
  await useStarter("Retry, then fall back");
  const label = await runInEditor();
  // The validation saw "3 of 4 ok · 1 failed", a red node and a partial run.
  expect(label).toMatch(/· 4 of 4 ok · 1 handled$/);
  await expect(canvasNode("Call the service").locator(".wf-node").first()).toHaveClass(/status-handled/);
  await expect(canvasNode("Call the service").locator(".wf-status-ring")).toHaveAttribute("title", "Failed, handled by its Error output");
  await page.getByRole("tab", { name: "Run tape" }).click();
  const tape = page.getByRole("table", { name: "Run tape" });
  await expect(tape).toBeVisible();
  await expect(page.locator(".run-tape-head")).toContainText("status success");
  await expect(page.locator(".run-tape-lane-handled")).toHaveCount(1);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-01-retry-handled.png") });
});

test("the run tape counts the nodes that ran, not a Loop body's lanes per pass", async () => {
  test.setTimeout(120_000);
  await useStarter("Loop over items and collect");
  const label = await runInEditor();
  const nodesOnCanvas = await page.locator(".react-flow__node").count();
  // The top bar counts nodes too (it said "7 ok" for a 5-node Loop workflow).
  expect(Number(/· (\d+) ok$/.exec(label)?.[1])).toBeLessThanOrEqual(nodesOnCanvas);
  await page.getByRole("tab", { name: "Run tape" }).click();
  const lanes = page.getByRole("table", { name: "Run tape" }).getByRole("row");
  await expect(lanes.first()).toBeVisible();
  const laneCount = await lanes.count();
  const nodeCount = await page.locator(".react-flow__node").count();
  const head = (await page.locator(".run-tape-head > span").first().textContent()) ?? "";
  const counted = Number(/· (\d+) nodes? ·/.exec(head)?.[1]);
  // A body node ran once per item, so there are more lanes than nodes; the head counts nodes.
  expect(laneCount).toBeGreaterThan(counted);
  expect(counted).toBeLessThanOrEqual(nodeCount);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-02-run-tape-count.png") });
});

test("an error workflow's run is in Runs, and the failed run links to it and back", async () => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const handlerId = `wf-e2e-handler-${stamp}`;
  const failingId = `wf-e2e-fails-${stamp}`;
  const position = { x: 80, y: 180 };
  await saveWorkflow({
    id: handlerId,
    name: `E2E Error handler ${stamp}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "trigger", type: "error_trigger", name: "On error", position, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 380, y: 180 }, config: { responseTemplate: "{{source_workflow_name}} failed", outputKey: "result" } }
    ],
    edges: [{ id: "e1", source: "trigger", target: "out" }]
  });
  await saveWorkflow({
    id: failingId,
    name: `E2E Fails ${stamp}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    settings: { errorWorkflowId: handlerId },
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position, config: {} },
      { id: "sub", type: "execute_workflow", name: "Missing", position: { x: 380, y: 180 }, config: { workflowId: `does-not-exist-${stamp}` } },
      { id: "out", type: "output", name: "Out", position: { x: 680, y: 180 }, config: {} }
    ],
    edges: [
      { id: "e1", source: "start", target: "sub" },
      { id: "e2", source: "sub", target: "out" }
    ]
  });
  const run = await page.request.post(`/api/workflows/${failingId}/execute`, { data: {} });
  const { executionId } = (await run.json()) as { executionId: string };
  // The handler's run is recorded (the validation found none).
  let errorRunId = "";
  await expect
    .poll(async () => {
      const listed = (await (await page.request.get(`/api/executions?workflowId=${handlerId}`)).json()) as { items: Array<{ id: string; triggerType: string; status: string }> };
      errorRunId = listed.items[0]?.id ?? "";
      return listed.items.map((item) => `${item.triggerType}:${item.status}`);
    }, { timeout: 30_000 })
    .toEqual(["error:success"]);

  await sidebarItem("Runs").click();
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
  const failedRow = page.locator(".executions-table tbody tr.execution-row", { hasText: executionId.slice(0, 8) }).first();
  await expect(failedRow).toBeVisible({ timeout: 30_000 });
  await failedRow.click();
  const forward = page.getByTestId("execution-run-link").filter({ hasText: "Error workflow ran" });
  await expect(forward).toContainText(`run ${errorRunId.slice(0, 8)}`);
  await expect(forward).toContainText(`E2E Error handler ${stamp}`);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-03-failed-run-links-error-run.png") });

  await forward.getByRole("button", { name: `run ${errorRunId.slice(0, 8)}` }).click();
  const errorRow = page.locator(".executions-table tbody tr.execution-row", { hasText: errorRunId.slice(0, 8) }).first();
  await expect(errorRow).toBeVisible({ timeout: 30_000 });
  await expect(errorRow).toContainText("error");
  const back = page.getByTestId("execution-run-link").filter({ hasText: "Error workflow for" });
  await expect(back).toContainText(`run ${executionId.slice(0, 8)}`);
  await page.screenshot({ path: path.join(SHOT_DIR, "after-04-error-run-in-runs.png") });
});
