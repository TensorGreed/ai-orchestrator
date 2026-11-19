import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The first hour across the editor's newer pieces together: a New workflow saves on its first edit and that edit can
 * still be undone; an LLM Call added with an output's + is connected and starts on Echo; a node's Error output has a
 * + that connects after it; and a draft with unfinished settings and Error output notes saves and lists both. (A
 * workflow stored with invalid error settings is covered by the API's draft-save tests and ErrorOutput.test.tsx: the
 * API refuses to store one now.) Undo after a run keeps the run's results on the canvas.
 * No model server is contacted (a request to a local model port fails the test). Everything it makes is removed.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "first-hour");

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
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
  const debug = page.getByRole("button", { name: "Debug mode: ON" });
  if (await debug.isVisible()) await debug.click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(400);
}

function canvasNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator(".wf-card-name, .wf-hub-name", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }) });
}

const edgeCount = (page: Page) => page.locator(".react-flow__edge").count();
const nodeCount = (page: Page) => page.locator(".react-flow__node").count();

async function pickInPalette(page: Page, query: string): Promise<void> {
  await page.getByRole("textbox", { name: "Search nodes" }).fill(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add a node" })).toBeHidden();
}

async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/workflows"));
  await page.getByRole("banner").getByRole("button", { name: /^Save/ }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
}

type StoredWorkflow = {
  nodes: Array<{ id: string; type: string; config: Record<string, unknown>; errorConfig?: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; sourceHandle?: string }>;
};

async function stored(page: Page, id: string): Promise<StoredWorkflow> {
  return (await (await page.request.get(`/api/workflows/${id}`)).json()) as StoredWorkflow;
}

async function createWorkflow(page: Page, workflow: Record<string, unknown>): Promise<void> {
  const response = await page.request.post("/api/workflows", { data: { schemaVersion: "1.0.0", workflowVersion: 1, ...workflow } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("first hour", () => {
  test.setTimeout(150_000);
  const made: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of made.splice(0)) await page.request.delete(`/api/workflows/${id}`);
    expect(modelServerHits, "the studio tried to reach a local model server").toEqual([]);
  });

  test("a New workflow saves on its first edit, and that edit can still be undone", async ({ page }) => {
    await openStudio(page);
    await page.goto("/?mode=dashboard");
    await page.getByRole("button", { name: "New workflow" }).first().click();
    await expect(page.getByLabel("Workflow name")).toBeVisible();
    const start = canvasNode(page, "User Prompt");
    await expect(start).toBeVisible();
    const nodesBefore = await nodeCount(page);
    const edgesBefore = await edgeCount(page);

    // The first edit: a node added after the selected one. It is saved, once.
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/workflows")) posts.push(request.url());
    });
    const firstSave = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/workflows"));
    await start.click();
    await page.getByRole("button", { name: "Add node" }).click();
    await pickInPalette(page, "no operation");
    const saved = await firstSave;
    expect(saved.ok()).toBeTruthy();
    const id = ((await saved.json()) as { id: string }).id;
    made.push(id);
    await expect.poll(() => nodeCount(page)).toBe(nodesBefore + 1);
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);

    // Undo steps back over it: the save did not clear the history.
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Control+z");
    await expect.poll(() => nodeCount(page)).toBe(nodesBefore);
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => nodeCount(page)).toBe(nodesBefore + 1);
    await page.waitForTimeout(800);
    expect(posts).toHaveLength(1);
  });

  test("an LLM Call added with an output's + is connected and starts on Echo", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-first-hour-llm-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, {
      id,
      name: `E2E First hour LLM ${id}`,
      nodes: [
        { id: "ask", type: "text_input", name: "Ask", position: { x: 80, y: 180 }, config: { text: "hello" } },
        { id: "shape", type: "set_node", name: "Shape", position: { x: 400, y: 180 }, config: { assignments: [{ key: "prompt", valueTemplate: "{{text}}" }] } }
      ],
      edges: [{ id: "e1", source: "ask", target: "shape" }]
    });
    await openEditor(page, id);
    const edgesBefore = await edgeCount(page);
    const shape = canvasNode(page, "Shape");
    await shape.hover();
    await shape.getByRole("button", { name: "Add a node after this step" }).click();
    await expect(page.getByRole("dialog", { name: "Add a node" })).toContainText("Connects after “Shape”");
    await pickInPalette(page, "LLM Call");
    const llm = canvasNode(page, "LLM Call");
    await expect(llm).toBeVisible();
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);
    await page.screenshot({ path: path.join(SHOT_DIR, "llm-call-from-plus.png") });
    await save(page);
    const workflow = await stored(page, id);
    const llmNode = workflow.nodes.find((node) => node.type === "llm_call");
    expect(llmNode?.config.provider).toMatchObject({ providerId: "echo" });
    expect(workflow.edges).toContainEqual(expect.objectContaining({ source: "shape", target: llmNode?.id }));
  });

  test("a node's Error output has a + that connects after it", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-first-hour-err-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, {
      id,
      name: `E2E First hour error ${id}`,
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 60, y: 160 }, config: {} },
        { id: "call", type: "http_request", name: "Call API", position: { x: 360, y: 160 }, config: { method: "GET", urlTemplate: "https://api.example.com/x", failOnHttpError: true, onError: "branch" } }
      ],
      edges: [{ id: "e1", source: "start", target: "call" }]
    });
    await openEditor(page, id);
    const call = canvasNode(page, "Call API");
    const errorOutput = call.getByTestId("node-error-output");
    // The wrapper has no height of its own; its handle is what shows.
    await expect(call.locator('[data-handleid="error"]')).toBeVisible();
    await call.hover();
    await errorOutput.getByRole("button", { name: "Add a node after the error output" }).click();
    await expect(page.getByRole("dialog", { name: "Add a node" })).toContainText("Connects after “Call API”");
    await pickInPalette(page, "set");
    await expect(canvasNode(page, "Set / Transform")).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await page.screenshot({ path: path.join(SHOT_DIR, "error-output-plus.png") });
    // Connected, the + on the error output is hidden like any connected output's.
    await expect(errorOutput.getByRole("button", { name: "Add a node after the error output" })).toHaveClass(/wf-handle-add-connected/);
    await save(page);
    const workflow = await stored(page, id);
    const set = workflow.nodes.find((node) => node.type === "set_node");
    expect(workflow.edges).toContainEqual(expect.objectContaining({ source: "call", target: set?.id, sourceHandle: "error" }));
    // Below the HTTP node, not on its main row.
    const callBox = (await call.boundingBox())!;
    const setBox = (await canvasNode(page, "Set / Transform").boundingBox())!;
    expect(setBox.y).toBeGreaterThan(callBox.y + 20);
  });

  test("a draft with an unfinished setting and an unconnected Error output saves, and lists both", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-first-hour-draft-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, {
      id,
      name: `E2E First hour draft ${id}`,
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 60, y: 160 }, config: {} },
        { id: "call", type: "http_request", name: "Call API", position: { x: 360, y: 160 }, config: { method: "GET", onError: "branch", retryOnStatus: "5xx, soon" } }
      ],
      edges: [{ id: "e1", source: "start", target: "call" }]
    });
    await openEditor(page, id);
    const banner = page.getByTestId("draft-warnings");
    // On open: what stops a run (the URL and the retry list), not the notes yet.
    await expect(banner).toContainText("Unfinished draft");
    await expect(banner).toContainText("Retry on status");
    await expect(banner).not.toContainText("Error output");
    await page.getByLabel("Workflow name").fill(`E2E First hour draft ${id} saved`);
    await save(page);
    // After a save the notes show too; nothing blocked the save.
    await expect(banner).toContainText("nothing is connected to this node's Error output");
    await expect(banner).toContainText("Unfinished draft");
    await page.screenshot({ path: path.join(SHOT_DIR, "draft-banner-error-output.png") });
  });

  test("undo after a run steps back over the edit and keeps the run's results on the canvas", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-first-hour-undo-run-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, {
      id,
      name: `E2E First hour undo run ${id}`,
      nodes: [
        { id: "start", type: "manual_trigger", name: "Start", position: { x: 60, y: 160 }, config: {} },
        { id: "shape", type: "set_node", name: "Shape", position: { x: 380, y: 160 }, config: { assignments: [{ key: "greeting", valueTemplate: "hi" }] } }
      ],
      edges: [{ id: "e1", source: "start", target: "shape" }]
    });
    // Debug mode on, so a run's output preview shows under each node.
    await page.goto(`/?workflowId=${encodeURIComponent(id)}&mode=editor`);
    await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
    const debugOff = page.getByRole("button", { name: "Debug mode: OFF" });
    if (await debugOff.isVisible()) await debugOff.click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(400);
    const shape = canvasNode(page, "Shape");
    const start = canvasNode(page, "Start");
    // Measured against Start: a run can open panels that shift the whole canvas on screen.
    const offset = async () => Math.round((await shape.boundingBox())!.y - (await start.boundingBox())!.y);
    const offsetBefore = await offset();
    const before = (await shape.boundingBox())!;
    // An edit (a move), then a run.
    await page.mouse.move(before.x + 40, before.y + 20);
    await page.mouse.down();
    await page.mouse.move(before.x + 40, before.y + 160, { steps: 8 });
    await page.mouse.up();
    await expect.poll(offset).toBeGreaterThan(offsetBefore + 60);
    await page.getByRole("banner").getByRole("button", { name: /^Run/ }).click();
    await expect(page.locator(".hud-run-status .hud-run-label")).toContainText("last run", { timeout: 30_000 });
    await expect(shape.getByTestId("node-run-preview")).toBeVisible({ timeout: 30_000 });
    // Undo moves it back; the run's preview stays.
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Control+z");
    await expect.poll(offset).toBeLessThan(offsetBefore + 20);
    await expect(shape.getByTestId("node-run-preview")).toBeVisible();
  });
});
