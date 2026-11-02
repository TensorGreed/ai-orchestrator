import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 12.6 — model allowlists: an admin adds a deployment entry and a project override on Security → Models, a builder's
 * LLM node with a model off the list shows the warning in the node editor, and its run fails at that node. The suite
 * signs in once and removes every entry and workflow it made.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "model-allowlist");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const workflowId = `wf-e2e-models-${stamp}`;
const pattern = `e2e-allowed-${stamp}-*`;
/** The confirm dialogs the Models tab showed (each accepted). */
const dialogs: string[] = [];

function sidebarItem(label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function signIn(browser: Browser): Promise<void> {
  context = await browser.newContext();
  page = await context.newPage();
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
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

/** Removes the entries this suite added (and only those), so other specs run with empty lists. */
async function removeOurEntries(): Promise<void> {
  const listed = await page.request.get("/api/model-allowlist");
  if (!listed.ok()) return;
  const { entries } = (await listed.json()) as { entries: Array<{ id: string; modelGlob: string; note: string | null }> };
  for (const entry of entries.filter((row) => row.modelGlob === pattern || row.note === `e2e ${stamp}`)) {
    await page.request.delete(`/api/model-allowlist/${entry.id}`);
  }
}

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  const created = await page.request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: `E2E Models ${stamp}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "text", type: "text_input", name: "Question", position: { x: 80, y: 180 }, config: { text: "hello" } },
        { id: "llm", type: "llm_call", name: "Ask the model", position: { x: 380, y: 180 }, config: { provider: { providerId: "echo", model: "not-on-the-list" }, promptKey: "prompt" } },
        { id: "out", type: "output", name: "Answer", position: { x: 680, y: 180 }, config: { responseTemplate: "{{answer}}", outputKey: "result" } }
      ],
      edges: [
        { id: "e1", source: "text", target: "llm" },
        { id: "e2", source: "llm", target: "out" }
      ]
    }
  });
  expect(created.ok()).toBeTruthy();
});

test.afterAll(async () => {
  await removeOurEntries();
  await page.request.delete(`/api/workflows/${workflowId}`);
  await context.close();
});

test("an admin adds a deployment entry and a project override on Security → Models", async () => {
  await sidebarItem("Security").click();
  await page.getByRole("tab", { name: "Models" }).click();
  await expect(page.getByText(/a project list can\s+only narrow the deployment list/)).toBeVisible();

  const deploymentForm = page.getByRole("form", { name: "Add a deployment entry" });
  await deploymentForm.getByLabel("Provider").selectOption("echo");
  await deploymentForm.getByLabel("Model pattern").fill(pattern);
  await deploymentForm.getByLabel("Note").fill(`e2e ${stamp}`);
  await expect(deploymentForm.getByText("Only listed models will be allowed; every other model call will be refused.")).toBeVisible();
  await deploymentForm.getByRole("button", { name: "Add" }).click();
  const deploymentTable = page.getByRole("table", { name: "Deployment models" });
  await expect(deploymentTable.getByText(pattern)).toBeVisible();
  // The first entry of an empty list is confirmed.
  expect(dialogs.at(-1)).toContain("Only listed models will be allowed; every other model call will be refused.");
  await page.screenshot({ path: path.join(SHOT_DIR, "01-models-deployment-entry.png") });

  await page.getByRole("region", { name: "Project override" }).getByLabel("Project", { exact: true }).selectOption("default");
  const projectForm = page.getByRole("form", { name: /^Add an entry for / });
  await projectForm.getByLabel("Model pattern").fill(pattern);
  await projectForm.getByLabel("Note").fill(`e2e ${stamp}`);
  await projectForm.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("table", { name: /^Models for / }).getByText(pattern)).toBeVisible();
  await page.screenshot({ path: path.join(SHOT_DIR, "02-models-project-override.png"), fullPage: true });

  // A duplicate is refused with the API's reason.
  await deploymentForm.getByLabel("Provider").selectOption("echo");
  await deploymentForm.getByLabel("Model pattern").fill(pattern);
  await deploymentForm.getByRole("button", { name: "Add" }).click();
  await expect(deploymentForm.getByRole("alert")).toContainText("already on the list");
});

test("the node editor warns about a model off the list, and the run fails at that node", async () => {
  await page.reload();
  await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
  await sidebarItem("Editor").click();
  await page.locator(".react-flow__node").filter({ hasText: "Ask the model" }).first().dblclick();
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  const warning = inspector.getByTestId("model-allowlist-warning");
  await expect(warning).toContainText('Model "not-on-the-list" on provider "echo" is not on this deployment\'s model allowlist.');
  await warning.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOT_DIR, "03-node-model-warning.png") });
  await inspector.getByRole("button", { name: "Close inspector" }).click();

  const run = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: {} });
  const result = (await run.json()) as { status: string; nodeResults: Array<{ nodeId: string; status: string; errorCategory?: string }> };
  expect(result.status).toBe("error");
  expect(result.nodeResults.find((entry) => entry.nodeId === "llm")).toMatchObject({ status: "error", errorCategory: "model_not_allowed" });
});

test("removing the entries allows every model again", async () => {
  await sidebarItem("Security").click();
  await page.getByRole("tab", { name: "Models" }).click();
  const deploymentTable = page.getByRole("table", { name: "Deployment models" });
  await deploymentTable.getByRole("button", { name: `Remove Echo (built-in demo) ${pattern}` }).click();
  await page.getByRole("region", { name: "Project override" }).getByLabel("Project", { exact: true }).selectOption("default");
  await page.getByRole("table", { name: /^Models for / }).getByRole("button", { name: `Remove Any provider ${pattern}` }).click();
  await expect(page.getByText(/No deployment list: every provider and model is allowed/)).toBeVisible();
  // Each removal was confirmed.
  expect(dialogs.filter((message) => message.startsWith("Remove "))).toHaveLength(2);
  const run = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: {} });
  expect(((await run.json()) as { status: string }).status).toBe("success");
});
