import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * 12.2 — provenance sources in the editor: an admin sees and sets what a webhook's input counts as, switches a
 * node to "Sensitive output" and sees the badge on the canvas after a run; a secret is flagged sensitive on the
 * Secrets page; and an approved Human Approval shows who cleared the outside content in the run history.
 * Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
/** Where the journey's screenshots go (the lane folder when set). */
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "taint-sources");

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

test.describe("provenance sources", () => {
  test.setTimeout(180_000);

  test("sets a webhook's input trust, marks a node sensitive and sees the badge after a run", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-taint-${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Taint ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "hook", type: "webhook_input", name: "Partner hook", position: { x: 80, y: 180 }, config: { path: `e2e-taint-${stamp}`, method: "POST" } },
            { id: "note", type: "set_node", name: "Payroll lookup", position: { x: 380, y: 180 }, config: { assignments: [{ key: "copy", valueTemplate: "{{user_prompt}}" }] } },
            { id: "out", type: "output", name: "Output", position: { x: 680, y: 180 }, config: { responseTemplate: "{{results.note.copy}}", outputKey: "result" } }
          ],
          edges: [
            { id: "e1", source: "hook", target: "note" },
            { id: "e2", source: "note", target: "out" }
          ]
        }
      });
      expect(created.ok()).toBeTruthy();
      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await sidebarItem(page, "Editor").click();

      // The webhook: with no auth its input is outside content; an admin can fix it either way.
      await page.locator(".react-flow__node").filter({ hasText: "Partner hook" }).first().dblclick();
      const inspector = page.getByRole("dialog", { name: /^Inspect / });
      const trust = inspector.getByTestId("trigger-trust-field");
      await expect(trust.getByText(/With no auth, input counts as outside content/)).toBeVisible();
      const select = trust.getByRole("combobox", { name: "Input counts as" });
      await expect(select).toBeEnabled();
      await select.selectOption("untrusted_external");
      await expect(trust.getByText(/even from a verified caller/)).toBeVisible();
      await trust.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOT_DIR, "01-webhook-input-trust.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();

      // The lookup node: "Sensitive output" in its settings.
      await page.locator(".react-flow__node").filter({ hasText: "Payroll lookup" }).first().dblclick();
      const sensitive = inspector.getByTestId("sensitive-output-field");
      await sensitive.scrollIntoViewIfNeeded();
      const toggle = sensitive.getByRole("button");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: path.join(SHOT_DIR, "02-node-sensitive-output.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();

      const hud = page.getByRole("banner");
      await hud.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => {
          const saved = (await (await page.request.get(`/api/workflows/${workflowId}`)).json()) as { nodes: Array<{ id: string; config: Record<string, unknown> }> };
          return [saved.nodes.find((node) => node.id === "hook")?.config.inputTrust, saved.nodes.find((node) => node.id === "note")?.config.sensitiveOutput];
        }, { timeout: 30_000 })
        .toEqual(["untrusted_external", true]);

      await hud.getByRole("button", { name: "Run workflow" }).click();
      const badge = page.locator(".react-flow__node").filter({ hasText: "Payroll lookup" }).getByTestId("node-label-badge");
      await expect(badge).toHaveText("sensitive", { timeout: 60_000 });
      await expect(page.locator(".react-flow__node").filter({ hasText: "Partner hook" }).getByTestId("node-label-badge")).toHaveCount(0);
      await page.screenshot({ path: path.join(SHOT_DIR, "03-canvas-sensitive-badge.png") });
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
  });

  test("flags a secret sensitive output on the Secrets page", async ({ page }) => {
    await openStudio(page);
    const name = `E2E payroll db ${Date.now()}`;
    try {
      await sidebarItem(page, "Secrets").click();
      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.locator("#secret-value").fill("payroll-db-password-123");
      await page.getByLabel(/Sensitive output/).check();
      await page.getByRole("button", { name: "Create secret" }).click();
      const item = page.locator(".secret-item").filter({ hasText: name });
      await expect(item.getByText("sensitive output", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(item.getByRole("button", { name: "Clear sensitive" })).toBeVisible();
      await item.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOT_DIR, "04-secret-sensitive-output.png") });
    } finally {
      const listed = (await (await page.request.get("/api/secrets")).json()) as Array<{ id: string; name: string }>;
      for (const secret of listed.filter((entry) => entry.name === name)) await page.request.delete(`/api/secrets/${secret.id}`);
    }
  });

  test("an approved Human Approval shows who cleared the outside content", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-cleared-${stamp}`;
    const hookPath = `e2e-cleared-${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Cleared ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "hook", type: "webhook_input", name: "Hook", position: { x: 80, y: 180 }, config: { path: hookPath, method: "POST" } },
            { id: "review", type: "human_approval", name: "Review", position: { x: 380, y: 180 }, config: { approvalMessage: "Check the partner's text", timeoutMinutes: 30 } },
            { id: "out", type: "output", name: "Output", position: { x: 680, y: 180 }, config: { responseTemplate: "ok", outputKey: "result" } }
          ],
          edges: [
            { id: "e1", source: "hook", target: "review" },
            { id: "e2", source: "review", target: "out" }
          ]
        }
      });
      expect(created.ok()).toBeTruthy();
      const hook = await page.request.post(`${API_URL}/webhook/${hookPath}`, { data: { user_prompt: "partner text" } });
      expect(hook.status()).toBeLessThan(300);
      let approvalId = "";
      await expect
        .poll(async () => {
          const approvals = (await (await page.request.get("/api/approvals")).json()) as { items: Array<{ id: string; workflowId: string }> };
          approvalId = approvals.items.find((item) => item.workflowId === workflowId)?.id ?? "";
          return approvalId;
        }, { timeout: 30_000 })
        .not.toBe("");
      expect((await page.request.post(`/api/approvals/${approvalId}/approve`, { data: {} })).ok()).toBeTruthy();
      await expect.poll(async () => String(((await (await page.request.get(`/api/executions/${approvalId}`)).json()) as { status?: string }).status), { timeout: 30_000 }).toBe("success");

      await sidebarItem(page, "Runs").click();
      await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
      const row = page.locator(".executions-table tbody tr.execution-row", { hasText: approvalId.slice(0, 8) }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.click();
      const cleared = page.locator(".execution-trace-node", { hasText: "review" }).locator(".data-label-chip.is-cleared");
      await expect(cleared).toHaveText("cleared", { timeout: 30_000 });
      await expect(cleared).toHaveAttribute("title", new RegExp(`Outside content cleared by ${ADMIN_EMAIL.replace(".", "\\.")} at .* \\(Human Approval\\)`));
      await cleared.hover();
      await page.screenshot({ path: path.join(SHOT_DIR, "05-run-history-cleared.png") });
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
  });
});
