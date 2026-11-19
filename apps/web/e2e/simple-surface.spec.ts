import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Keeping the editor simple: switches that only choose between an older and a newer behaviour show on nodes saved
 * with the older one (with a one-click upgrade), not on new nodes; rarely used settings sit under one More section;
 * the workflow's rarely changed settings sit under "More settings"; and the version pill says what production
 * triggers run today. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "simple-surface");

function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function openStudio(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
  await page.reload();
  await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
  await sidebarItem(page, "Editor").click();
}

const canvasNode = (page: Page, name: string) => page.locator(".react-flow__node").filter({ hasText: name }).first();

/** Opens a node's inspector (a dispatched double click: the node may sit under the editor's banners). */
async function inspect(page: Page, name: string) {
  await canvasNode(page, name).dispatchEvent("dblclick");
  const inspector = page.getByRole("dialog", { name: /^Inspect / });
  await expect(inspector).toBeVisible();
  return inspector;
}

async function closeInspector(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^Inspect / })).toHaveCount(0);
}

test.describe("a simple editor", () => {
  test.setTimeout(180_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test("older-behaviour switches show only on nodes saved with them, with a one-click upgrade", async ({ page }) => {
    const modelServerCalls: string[] = [];
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerCalls.push(route.request().url());
      await route.abort();
    });
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-simple-${stamp}`;
    const url = `${API_URL}/health`;
    const condition = [{ field: "ok", operator: "eq", value: "true" }];
    const created = await page.request.post("/api/workflows", {
      data: {
        id: workflowId,
        name: `E2E Simple ${stamp}`,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "start", type: "manual_trigger", name: "Start", position: { x: 40, y: 200 }, config: {} },
          { id: "new_http", type: "http_request", name: "New call", position: { x: 300, y: 80 }, config: { method: "GET", urlTemplate: url, failOnHttpError: true } },
          { id: "old_http", type: "http_request", name: "Old call", position: { x: 300, y: 320 }, config: { method: "GET", urlTemplate: url } },
          { id: "new_loop", type: "loop_node", name: "New loop", position: { x: 560, y: 80 }, config: { inputKey: "items", itemVariable: "item", collectResults: true, routeBranches: true } },
          { id: "old_loop", type: "loop_node", name: "Old loop", position: { x: 560, y: 320 }, config: { inputKey: "items", itemVariable: "item" } },
          { id: "new_filter", type: "filter_node", name: "New filter", position: { x: 820, y: 80 }, config: { mode: "items", conditions: condition } },
          { id: "old_filter", type: "filter_node", name: "Old filter", position: { x: 820, y: 320 }, config: { conditions: condition } }
        ],
        edges: [
          { id: "e1", source: "start", target: "new_http" },
          { id: "e2", source: "start", target: "old_http" },
          { id: "e3", source: "new_http", target: "new_loop" },
          { id: "e4", source: "old_http", target: "old_loop" },
          { id: "e5", source: "new_loop", target: "new_filter" },
          { id: "e6", source: "old_loop", target: "old_filter" }
        ]
      }
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    try {
      await openEditor(page, workflowId);
      await expect(canvasNode(page, "Old filter")).toBeVisible();

      // New nodes: no switches, no notice; the rarely used fields sit under one closed More section.
      let inspector = await inspect(page, "New call");
      await expect(inspector.getByRole("tab")).toHaveText(["Parameters", "Trace"]);
      await expect(inspector.getByRole("button", { name: /Fail on HTTP error status/ })).toHaveCount(0);
      await expect(inspector.getByTestId("legacy-behaviour")).toHaveCount(0);
      const more = inspector.getByTestId("advanced-fields");
      await expect(more).not.toHaveAttribute("open", "");
      await expect(inspector.getByLabel("On Error Behavior")).toBeHidden();
      await page.screenshot({ path: path.join(SHOT_DIR, "after-01-new-http.png") });
      await more.getByText("More", { exact: true }).click();
      await expect(inspector.getByLabel("Timeout (ms)")).toBeVisible();
      await expect(inspector.getByLabel(/Retry on status/)).toBeVisible();
      await expect(inspector.getByLabel("On Error Behavior")).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "after-02-new-http-more.png") });
      await closeInspector(page);

      inspector = await inspect(page, "New loop");
      await expect(inspector.getByRole("button", { name: /Collect results/ })).toHaveCount(0);
      await expect(inspector.getByRole("button", { name: /Branches route in the loop/ })).toHaveCount(0);
      await expect(inspector.getByLabel("Item Variable")).toBeHidden();
      await closeInspector(page);

      inspector = await inspect(page, "New filter");
      await expect(inspector.getByLabel(/^Mode/)).toHaveCount(0);
      await expect(inspector.getByLabel(/^Items from/)).toBeHidden();
      await closeInspector(page);

      // Saved nodes on the older behaviour: the switch, and the upgrade.
      inspector = await inspect(page, "Old call");
      await expect(inspector.getByTestId("legacy-behaviour")).toContainText("an HTTP error status does not always fail it");
      await expect(inspector.getByRole("button", { name: /Fail on HTTP error status/ })).toHaveAttribute("aria-pressed", "false");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-03-old-http.png") });
      await closeInspector(page);

      inspector = await inspect(page, "Old filter");
      await expect(inspector.getByLabel(/^Mode/)).toHaveValue("gate");
      await expect(inspector.getByTestId("legacy-behaviour")).toContainText("passes or stops the whole input");
      await closeInspector(page);

      inspector = await inspect(page, "Old loop");
      const collect = inspector.getByRole("button", { name: /Collect results/ });
      const route = inspector.getByRole("button", { name: /Branches route in the loop/ });
      await expect(collect).toHaveAttribute("aria-pressed", "false");
      await expect(route).toHaveAttribute("aria-pressed", "false");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-04-old-loop.png") });
      await inspector.getByRole("button", { name: "Upgrade to the new behaviour" }).click();
      await expect(collect).toHaveAttribute("aria-pressed", "true");
      await expect(route).toHaveAttribute("aria-pressed", "true");
      await expect(inspector.getByTestId("legacy-behaviour")).toContainText("Upgraded to the new behaviour when you save");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-05-old-loop-upgraded.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();
      await expect(inspector).toHaveCount(0);
      await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => {
          const stored = (await (await page.request.get(`/api/workflows/${workflowId}`)).json()) as { nodes: Array<{ id: string; config: Record<string, unknown> }> };
          return stored.nodes.find((node) => node.id === "old_loop")?.config;
        })
        .toMatchObject({ inputKey: "items", itemVariable: "item", collectResults: true, routeBranches: true });

      // Once upgraded and saved, the Loop looks like a new one.
      inspector = await inspect(page, "Old loop");
      await expect(inspector.getByRole("button", { name: /Collect results/ })).toHaveCount(0);
      await expect(inspector.getByTestId("legacy-behaviour")).toHaveCount(0);
      await closeInspector(page);

      // The workflow's rarely changed settings: one "More settings" group in the More actions menu.
      const hud = page.getByRole("banner");
      await hud.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Strict templates" })).toHaveCount(0);
      await page.getByRole("menuitem", { name: /^More settings/ }).click();
      await expect(page.getByRole("menuitemcheckbox", { name: "Strict templates" })).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "after-06-more-settings.png") });
      await hud.getByRole("button", { name: "More actions" }).click();
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
    expect(modelServerCalls).toEqual([]);
  });

  test("the version pill says what production triggers run today", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const readyId = `wf-e2e-live-${stamp}`;
    const unfinishedId = `wf-e2e-live-paused-${stamp}`;
    const hook = (id: string, extra: Array<Record<string, unknown>> = []) => ({
      id,
      name: `E2E Live ${id}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [{ id: "hook", type: "webhook_input", name: "Hook", position: { x: 80, y: 180 }, config: { path: `${id}-hook`, method: "POST" } }, ...extra],
      edges: extra.length > 0 ? [{ id: "e1", source: "hook", target: String(extra[0]!.id) }] : []
    });
    expect((await page.request.post("/api/workflows", { data: hook(readyId) })).ok()).toBeTruthy();
    // An HTTP Request without a URL: the draft saves, but production's triggers are paused until it is finished.
    const unfinished = hook(unfinishedId, [{ id: "call", type: "http_request", name: "Call", position: { x: 380, y: 180 }, config: { method: "GET", urlTemplate: "" } }]);
    expect((await page.request.post("/api/workflows", { data: unfinished })).ok()).toBeTruthy();
    try {
      await openEditor(page, readyId);
      const pill = page.getByRole("button", { name: /^Release:/ });
      await expect(pill).toHaveText(/Live: draft/);
      await expect(pill).toHaveAttribute("title", /Production triggers .* run the latest save \(v1\) until a version is published/);
      await page.screenshot({ path: path.join(SHOT_DIR, "after-07-pill-live-draft.png") });
      await pill.click();
      const dialog = page.getByRole("dialog", { name: "Publish to production" });
      await dialog.getByRole("button", { name: "Publish v1" }).click();
      await expect(dialog.getByText(/Published v1/)).toBeVisible();
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(pill).toHaveText(/Live: version 1$/);
      await page.screenshot({ path: path.join(SHOT_DIR, "after-08-pill-live-version.png") });

      await openEditor(page, unfinishedId);
      await expect(pill).toHaveText(/Live: paused/);
      // Dismissing the notice keeps the pill's answer.
      await page.getByTestId("draft-warnings").getByRole("button", { name: "Dismiss" }).click();
      await expect(pill).toHaveText(/Live: paused/);
      await page.screenshot({ path: path.join(SHOT_DIR, "after-09-pill-live-paused.png") });
    } finally {
      await page.request.delete(`/api/workflows/${readyId}`);
      await page.request.delete(`/api/workflows/${unfinishedId}`);
    }
  });
});
