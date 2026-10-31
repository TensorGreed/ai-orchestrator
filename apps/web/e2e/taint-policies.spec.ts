import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 12.2 — provenance policies: an admin adds the "untrusted content ⇒ write tools need approval" safety preset
 * in shadow mode and enforces it, turns on a workflow's "Approve writes only after untrusted content" switch, and
 * overrides a tool's open-world value on a server's Tools table. Everything it made is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("button", { name: label, exact: true });
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

test("adds a safety preset in shadow and enforces it", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  try {
    await sidebarItem(page, "Policies").click();
    const card = page.getByTestId("mcp-preset-untrusted_write_approval");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Add in shadow" }).click();
    await expect(card.getByText("shadow")).toBeVisible();
    const rules = page.getByRole("list", { name: "Tool policy rules" });
    const rule = rules.getByRole("listitem").filter({ hasText: "Untrusted content: write tools need approval" });
    await expect(rule).toBeVisible();
    // A preset's rule is additive: it never sets another rule aside.
    await expect(rule.getByText("Additive", { exact: true })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await shot(page, "01-safety-presets");

    page.once("dialog", (dialog) => void dialog.accept());
    await rule.getByRole("button", { name: "Enforce" }).click();
    await expect(rule.getByRole("button", { name: "Enforce" })).toHaveCount(0);
    await page.reload();
    await sidebarItem(page, "Policies").click();
    await expect(page.getByTestId("mcp-preset-untrusted_write_approval").getByText("enforced")).toBeVisible();
  } finally {
    await page.request.delete("/api/mcp/policies/mtp_preset_untrusted_write_approval");
  }
});

test("turns on a workflow's untrusted-write switch from the editor", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const workflowId = `wf-e2e-untrusted-${Date.now()}`;
  const saved = await page.request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "E2E untrusted writes",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        { id: "hook", type: "webhook_input", name: "Webhook", position: { x: 0, y: 0 }, config: { path: `${workflowId}-hook`, method: "POST" } },
        { id: "out", type: "output", name: "Output", position: { x: 300, y: 0 }, config: {} }
      ],
      edges: [{ id: "edge-1", source: "hook", target: "out" }]
    }
  });
  expect(saved.ok()).toBeTruthy();
  try {
    await page.reload();
    await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
    await sidebarItem(page, "Editor").click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitemcheckbox", { name: /Ask before write tools/ }).click();
    const dialog = page.getByRole("dialog", { name: "Ask before write tools" });
    const box = dialog.getByLabel("Approve writes only after untrusted content");
    await expect(box).toBeEnabled();
    await box.click();
    await expect(box).toBeChecked();
    await expect(dialog.getByText(/Independent of the setting above/)).toBeVisible();
    await shot(page, "02-untrusted-write-switch");
    const state = await (await page.request.get(`/api/workflows/${workflowId}/untrusted-write-approval`)).json();
    expect(state.switch).toMatchObject({ enabled: true, mode: "enforce" });
    await box.click();
    await expect(box).not.toBeChecked();
    await dialog.getByRole("button", { name: "Done" }).click();
  } finally {
    await page.request.put(`/api/workflows/${workflowId}/untrusted-write-approval`, { data: { enabled: false } });
    await page.request.delete(`/api/workflows/${workflowId}`);
  }
});

test("overrides a tool's open-world value on the server's Tools table", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const created = await page.request.post("/api/mcp/servers", { data: { name: `E2E open world ${Date.now()}`, adapterId: "mock-mcp", probeEnabled: false } });
  expect(created.ok()).toBeTruthy();
  const serverId = ((await created.json()) as { server: { id: string; name: string } }).server.id;
  const serverName = ((await created.json()) as { server: { name: string } }).server.name;
  expect((await page.request.post(`/api/mcp/servers/${serverId}/probe`)).ok()).toBeTruthy();
  try {
    await page.reload();
    await sidebarItem(page, "Servers").click();
    await page.getByText(serverName).first().click();
    const select = page.getByLabel("Open world for calculator");
    await expect(select).toBeVisible();
    await expect(page.getByText("tool's hint").first()).toBeVisible();
    await select.selectOption("closed");
    await expect(select).toHaveValue("closed");
    await expect(page.getByText("set by an admin").first()).toBeVisible();
    await select.scrollIntoViewIfNeeded();
    await shot(page, "03-open-world-override");
  } finally {
    await page.request.delete(`/api/mcp/servers/${serverId}`);
  }
});
