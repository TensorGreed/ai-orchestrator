import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Defaults that do not look like config, and safe ones: nodes added from the palette start with placeholders (an empty
 * HTTP URL, one empty Set row, an empty Filter condition, an empty Loop key, an appending Merge), a Schedule Trigger
 * starts off in the browser's time zone with "Off" on its card, Expose as MCP Tool asks for a bearer token, saving a
 * public webhook says so in one line, a click on the selected node opens its settings, and "New workflow" saves
 * nothing until it has a node (Clear does not save it). No model is called; what it makes is removed.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "new-node-defaults");

test.use({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Lisbon" });

async function openStudio(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.context().route(/:11434(\/|$)/, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
  });
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  page.on("dialog", (dialog) => void dialog.accept());
  return attempts;
}

async function workflowIds(page: Page): Promise<Set<string>> {
  const listed = await page.request.get("/api/workflows");
  if (!listed.ok()) return new Set();
  const body = (await listed.json()) as Array<{ id: string }> | { items?: Array<{ id: string }> };
  return new Set((Array.isArray(body) ? body : (body.items ?? [])).map((row) => row.id));
}

function canvasNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator(".wf-card-name", { hasText: label }) }).first();
}

async function addFromPalette(page: Page, query: string): Promise<void> {
  await page.getByRole("button", { name: "Add node" }).click();
  await page.getByRole("textbox", { name: "Search nodes" }).fill(query);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Add a node" })).toBeHidden();
}

async function newEmptyWorkflow(page: Page): Promise<void> {
  await page.goto("/?mode=dashboard");
  await page.getByRole("button", { name: "New workflow" }).first().click();
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
}

async function inspect(page: Page, label: string): Promise<Locator> {
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await canvasNode(page, label).dblclick();
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  await expect(inspector).toBeVisible();
  return inspector;
}

async function closeInspector(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^Inspect / })).toBeHidden();
}

test.describe("new node defaults", () => {
  test.setTimeout(180_000);
  let before = new Set<string>();

  test.afterEach(async ({ page }) => {
    for (const id of await workflowIds(page)) if (!before.has(id)) await page.request.delete(`/api/workflows/${id}`);
  });

  test("New workflow and Clear save nothing; the first node added saves it once", async ({ page }) => {
    const ollama = await openStudio(page);
    before = await workflowIds(page);
    await newEmptyWorkflow(page);
    await page.waitForTimeout(1500);
    expect(await workflowIds(page)).toEqual(before);

    const saved = page.waitForResponse((response) => response.url().endsWith("/api/workflows") && response.request().method() === "POST");
    await addFromPalette(page, "set");
    expect((await saved).status()).toBe(200);
    await expect.poll(async () => (await workflowIds(page)).size).toBe(before.size + 1);
    expect(ollama).toEqual([]);
  });

  test("palette nodes start with placeholders, not example values", async ({ page }) => {
    const ollama = await openStudio(page);
    before = await workflowIds(page);
    await newEmptyWorkflow(page);
    for (const query of ["http request", "filter", "loop", "set", "merge"]) await addFromPalette(page, query);

    let inspector = await inspect(page, "HTTP Request");
    const url = inspector.getByRole("textbox", { name: "URL Template" });
    await expect(url).toHaveValue("");
    await expect(url).toHaveAttribute("placeholder", /api\.example\.com/);
    await page.screenshot({ path: path.join(SHOT_DIR, "after-http.png") });
    await closeInspector(page);

    inspector = await inspect(page, "Filter");
    await expect(inspector.getByRole("textbox", { name: "Field" })).toHaveValue("");
    await expect(inspector.getByRole("textbox", { name: "Field" })).toHaveAttribute("placeholder", "status");
    await closeInspector(page);

    inspector = await inspect(page, "Loop / ForEach");
    await expect(inspector.getByRole("textbox", { name: "Input Key" })).toHaveValue("");
    await expect(inspector.getByRole("textbox", { name: "Input Key" })).toHaveAttribute("placeholder", "items");
    await expect(inspector.getByTestId("loop-input-key-hint")).toContainText("The list to repeat over");
    await closeInspector(page);

    inspector = await inspect(page, "Set / Transform");
    await expect(inspector.getByRole("textbox", { name: "Key" })).toHaveCount(1);
    await expect(inspector.getByRole("textbox", { name: "Key" })).toHaveValue("");
    await expect(inspector.getByRole("textbox", { name: "Value Template" })).toHaveValue("");
    await page.screenshot({ path: path.join(SHOT_DIR, "after-set.png") });
    await closeInspector(page);

    // The Merge was added straight after the Set, a Loop body node: it collects the loop's passes.
    inspector = await inspect(page, "Merge / Join");
    await expect(inspector.getByRole("combobox", { name: "Merge Mode" })).toHaveValue("collect_loop_passes");
    await closeInspector(page);
    expect(ollama).toEqual([]);
  });

  test("a Schedule Trigger starts off in the browser's time zone, says Off on its card, and turns on in one click", async ({ page }) => {
    const ollama = await openStudio(page);
    before = await workflowIds(page);
    await newEmptyWorkflow(page);
    await addFromPalette(page, "schedule");
    const schedule = canvasNode(page, "Schedule Trigger");
    const off = schedule.getByTestId("node-off-badge");
    await expect(off).toHaveText("Off");
    await page.screenshot({ path: path.join(SHOT_DIR, "after-schedule-card.png") });

    // "Off" opens the settings, where the notice turns it on.
    await off.click();
    const inspector = page.getByRole("dialog", { name: /^Inspect / });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("textbox", { name: "Timezone" })).toHaveValue("Europe/Lisbon");
    await expect(inspector.getByTestId("live-entry-off")).toContainText("Off: the schedule starts no run");
    await page.screenshot({ path: path.join(SHOT_DIR, "after-schedule-inspector.png") });
    await inspector.getByTestId("live-entry-off").getByRole("button", { name: "Turn on" }).click();
    await inspector.getByRole("button", { name: "Save changes" }).click();
    await expect(inspector).toBeHidden();
    await expect(schedule.getByTestId("node-off-badge")).toHaveCount(0);
    expect(ollama).toEqual([]);
  });

  test("Expose as MCP Tool asks for a bearer token; a saved public webhook gets a one-line warning", async ({ page }) => {
    const ollama = await openStudio(page);
    before = await workflowIds(page);
    await newEmptyWorkflow(page);
    await addFromPalette(page, "expose as mcp tool");
    const inspector = await inspect(page, "Expose as MCP Tool");
    await expect(inspector.getByRole("combobox", { name: "Auth Mode" })).toHaveValue("bearer");
    await expect(inspector.getByTestId("mcp-trigger-needs-secret")).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "after-mcp-tool.png") });
    await closeInspector(page);

    await addFromPalette(page, "webhook input");
    await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
    const warnings = page.getByTestId("draft-warnings");
    await expect(warnings).toContainText("Public webhook: anyone who can reach this server can call it.", { timeout: 30_000 });
    // The MCP tool asks for a token: no warning for it.
    await expect(warnings).not.toContainText("Public MCP tool");
    await page.screenshot({ path: path.join(SHOT_DIR, "after-public-webhook-warning.png") });
    expect(ollama).toEqual([]);
  });

  test("a click on the selected node opens its settings; the first click only selects", async ({ page }) => {
    const ollama = await openStudio(page);
    before = await workflowIds(page);
    await page.goto("/?mode=dashboard");
    await page.getByRole("button", { name: "New workflow" }).first().click();
    await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    const output = canvasNode(page, "Output");
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
    await output.click();
    await page.waitForTimeout(400);
    await expect(page.getByRole("dialog", { name: /^Inspect / })).toBeHidden();
    await output.click();
    await expect(page.getByRole("dialog", { name: /^Inspect / })).toBeVisible();
    expect(ollama).toEqual([]);
  });
});
