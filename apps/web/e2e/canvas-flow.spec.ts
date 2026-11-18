import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Palette and canvas flow: search ranks the best match first, a node added from the palette lands after the
 * selected node (or the output whose `+` was used), connected and in view, Clear asks first, and one undo history
 * covers add, move, connect, disconnect and Clear. The HTTP Request form shows Headers and Body for POST, and its
 * Advanced section opens on the first click after typing in a field.
 * No model is called; a request to a local model server fails the test. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

const modelServerHits: string[] = [];
const SET_CONFIG = { assignments: [{ key: "copy", valueTemplate: "fixed" }] };

function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function openStudio(page: Page): Promise<void> {
  await page.context().route(/:11434\//, async (route) => {
    modelServerHits.push(route.request().url());
    await route.abort();
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

type NodeSpec = { id: string; type: string; name: string; x: number; y: number; config?: Record<string, unknown> };

async function createWorkflow(page: Page, id: string, nodes: NodeSpec[], edges: Array<[string, string]> = []): Promise<void> {
  const response = await page.request.post("/api/workflows", {
    data: {
      id,
      name: `E2E Canvas flow ${id}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        ...nodes.map((node) => ({ id: node.id, type: node.type, name: node.name, position: { x: node.x, y: node.y }, config: node.config ?? {} })),
        // Saving requires an Output node; it sits out of the way.
        ...(nodes.some((node) => node.type === "output") ? [] : [{ id: "out", type: "output", name: "Result", position: { x: 0, y: 260 }, config: {} }])
      ],
      edges: edges.map(([source, target], index) => ({ id: `e${index}`, source, target }))
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function openWorkflow(page: Page, id: string, firstNode: string): Promise<void> {
  await page.reload();
  await page.getByLabel("Workflow", { exact: true }).selectOption(id);
  await sidebarItem(page, "Editor").click();
  await expect(canvasNode(page, firstNode)).toBeVisible();
  // Room for the canvas: no run panel, and every node in view.
  const debug = page.getByRole("button", { name: "Debug mode: ON" });
  if (await debug.isVisible()) await debug.click();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(400);
}

function canvasNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator(".wf-card-name", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`) }) });
}

const edgeCount = (page: Page) => page.locator(".react-flow__edge").count();
const nodeCount = (page: Page) => page.locator(".react-flow__node").count();

async function addFromPalette(page: Page, query: string): Promise<void> {
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Search nodes" }).fill(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add a node" })).toBeHidden();
}

async function expectInView(page: Page, locator: Locator): Promise<void> {
  const canvas = await page.locator(".canvas-stage").boundingBox();
  const box = await locator.boundingBox();
  expect(canvas && box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(canvas!.x);
  expect(box!.y).toBeGreaterThanOrEqual(canvas!.y);
  expect(box!.x + box!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height);
}

async function undo(page: Page): Promise<void> {
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Control+z");
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("palette and canvas flow", () => {
  test.setTimeout(120_000);
  const made: string[] = [];

  test.afterEach(async ({ page }) => {
    for (const id of made.splice(0)) await page.request.delete(`/api/workflows/${id}`);
    expect(modelServerHits).toEqual([]);
  });

  test("search puts the exact match first, and an added node connects after the selected one, in view", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-canvas-insert-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, id, [{ id: "start", type: "webhook_input", name: "Start", x: 0, y: 0, config: { path: `${id}-in` } }]);
    await openWorkflow(page, id, "Start");

    // "output" used to add the Error Trigger (first category, matched on its description).
    await page.getByRole("button", { name: "Add node" }).click();
    await page.getByRole("textbox", { name: "Search nodes" }).fill("output");
    await expect(page.getByRole("dialog", { name: "Add a node" }).getByRole("option").first()).toContainText("Output");
    await expect(page.getByRole("dialog", { name: "Add a node" }).getByRole("option").first()).toContainText("Best match");
    await page.keyboard.press("Escape");

    await canvasNode(page, "Start").click();
    const edgesBefore = await edgeCount(page);
    await addFromPalette(page, "set");
    const set = canvasNode(page, "Set / Transform");
    await expect(set).toBeVisible();
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);
    await expectInView(page, set);
    // The new node is selected, so the next one chains after it, to its right.
    await addFromPalette(page, "http request");
    const http = canvasNode(page, "HTTP Request");
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 2);
    await expectInView(page, http);
    const setBox = (await set.boundingBox())!;
    const httpBox = (await http.boundingBox())!;
    expect(httpBox.x).toBeGreaterThan(setBox.x + setBox.width);
    await page.screenshot({ path: "test-results/canvas-flow-insert.png" });

    // One undo removes the node and its edge together.
    const nodesNow = await nodeCount(page);
    await undo(page);
    await expect.poll(() => nodeCount(page)).toBe(nodesNow - 1);
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);
  });

  test("the + on an output opens the palette connected after that output", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-canvas-plus-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, id, [
      { id: "start", type: "webhook_input", name: "Start", x: 0, y: 0, config: { path: `${id}-in` } },
      { id: "check", type: "if_node", name: "Check", x: 340, y: 0, config: { condition: "{{ok}}" } }
    ], [["start", "check"]]);
    await openWorkflow(page, id, "Check");
    const edgesBefore = await edgeCount(page);

    const check = canvasNode(page, "Check");
    await check.hover();
    await check.getByRole("button", { name: "Add a node after the false output" }).click();
    await expect(page.getByRole("dialog", { name: "Add a node" })).toContainText("Connects after “Check”");
    await page.getByRole("textbox", { name: "Search nodes" }).fill("no operation");
    await page.keyboard.press("Enter");
    await expect(canvasNode(page, "No Operation")).toBeVisible();
    await expect.poll(() => edgeCount(page)).toBe(edgesBefore + 1);
    // Saved, the new edge leaves the IF node's false output.
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/workflows"));
    await page.getByRole("banner").getByRole("button", { name: /^Save/ }).click();
    expect((await saved).ok()).toBeTruthy();
    const stored = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { edges: Array<{ source: string; target: string; sourceHandle?: string }>; nodes: Array<{ id: string; type: string }> };
    const noop = stored.nodes.find((node) => node.type === "noop_node");
    expect(stored.edges).toContainEqual(expect.objectContaining({ source: "check", target: noop?.id, sourceHandle: "false" }));
    await page.screenshot({ path: "test-results/canvas-flow-plus.png" });
  });

  test("Clear asks first and can be undone; moves and edge deletes undo and redo", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-canvas-undo-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, id, [
      { id: "start", type: "webhook_input", name: "Start", x: 0, y: 0, config: { path: `${id}-in` } },
      { id: "shape", type: "set_node", name: "Shape", x: 340, y: 0, config: SET_CONFIG },
      { id: "done", type: "output", name: "Done", x: 680, y: 0 }
    ], [["start", "shape"], ["shape", "done"]]);
    await openWorkflow(page, id, "Shape");

    // Move, then undo and redo.
    const shape = canvasNode(page, "Shape");
    const start = (await shape.boundingBox())!;
    await page.mouse.move(start.x + 40, start.y + 20);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + 220, { steps: 8 });
    await page.mouse.up();
    const moved = (await shape.boundingBox())!;
    expect(moved.y - start.y).toBeGreaterThan(100);
    await undo(page);
    await expect.poll(async () => Math.round((await shape.boundingBox())!.y)).toBe(Math.round(start.y));
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(async () => Math.round((await shape.boundingBox())!.y)).toBe(Math.round(moved.y));
    await undo(page);
    await expect.poll(async () => Math.round((await shape.boundingBox())!.y)).toBe(Math.round(start.y));

    // Right-click deletes an edge; undo brings it back.
    await expect.poll(() => edgeCount(page)).toBe(2);
    const edgeMid = await page.locator(".react-flow__edge-interaction").first().evaluate((path) => {
      const svgPath = path as SVGPathElement;
      const point = svgPath.getPointAtLength(svgPath.getTotalLength() / 2);
      const matrix = svgPath.getScreenCTM()!;
      return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
    });
    await page.mouse.click(edgeMid.x, edgeMid.y, { button: "right" });
    await expect.poll(() => edgeCount(page)).toBe(1);
    await undo(page);
    await expect.poll(() => edgeCount(page)).toBe(2);

    // Clear asks; dismissing keeps everything.
    const nodes = await nodeCount(page);
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(`all ${nodes} nodes`);
      void dialog.dismiss();
    });
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect.poll(() => nodeCount(page)).toBe(nodes);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect.poll(() => nodeCount(page)).toBe(0);
    await page.screenshot({ path: "test-results/canvas-flow-cleared.png" });
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Control+z");
    await expect.poll(() => nodeCount(page)).toBe(nodes);
    await expect.poll(() => edgeCount(page)).toBe(2);
  });

  test("connecting two nodes is one undo step", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-canvas-connect-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, id, [
      { id: "start", type: "webhook_input", name: "Start", x: 0, y: 0, config: { path: `${id}-in` } },
      { id: "shape", type: "set_node", name: "Shape", x: 400, y: 0, config: SET_CONFIG }
    ]);
    await openWorkflow(page, id, "Shape");
    const before = await edgeCount(page);
    const from = (await canvasNode(page, "Start").locator(".react-flow__handle-right").first().boundingBox())!;
    const to = (await canvasNode(page, "Shape").locator(".react-flow__handle-left").first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => edgeCount(page)).toBe(before + 1);
    await undo(page);
    await expect.poll(() => edgeCount(page)).toBe(before);
    await page.keyboard.press("Control+y");
    await expect.poll(() => edgeCount(page)).toBe(before + 1);
  });

  test("HTTP Request: Advanced opens on the first click after typing, and POST shows Headers and Body", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-canvas-http-${Date.now()}`;
    made.push(id);
    await createWorkflow(page, id, [{ id: "call", type: "http_request", name: "Call API", x: 0, y: 0, config: { method: "GET", urlTemplate: "https://placeholder.test" } }]);
    await openWorkflow(page, id, "Call API");
    await canvasNode(page, "Call API").dblclick();
    const inspector = page.getByRole("dialog", { name: "Inspect Call API" });
    await expect(inspector).toBeVisible();

    await inspector.getByLabel("URL Template").fill("https://api.example.com/items");
    const advanced = inspector.getByTestId("advanced-fields");
    await advanced.getByText("Advanced", { exact: true }).click();
    await expect(advanced).toHaveAttribute("open", "");
    await expect(inspector.getByLabel("Timeout (ms)")).toBeVisible();

    await inspector.getByLabel("Method").selectOption("POST");
    const body = inspector.getByLabel("Body Template");
    await expect(body).toBeVisible();
    await expect(inspector.getByLabel("Headers Template (JSON)")).toBeVisible();
    expect(await advanced.evaluate((element, target) => element.contains(target), await body.elementHandle())).toBe(false);
    await page.screenshot({ path: "test-results/canvas-flow-http-post.png" });
  });
});
