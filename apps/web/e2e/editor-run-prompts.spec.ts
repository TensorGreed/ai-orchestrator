import { expect, test, type Page } from "@playwright/test";

/**
 * The editor's Run button sends its built-in prompts only to workflows that read them: a workflow with no model, agent,
 * prompt node or {{user_prompt}} gets neither, and one that names {{user_prompt}} still gets it.
 * Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

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

function workflow(id: string, note: string) {
  return {
    id,
    name: `E2E Run prompts ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "note", type: "set_node", name: "Note", position: { x: 100, y: 180 }, config: { assignments: [{ key: "copy", valueTemplate: note }] } },
      { id: "out", type: "output", name: "Output", position: { x: 400, y: 180 }, config: {} }
    ],
    edges: [{ id: "e1", source: "note", target: "out" }]
  };
}

async function runFromEditor(page: Page, workflowId: string): Promise<Record<string, unknown>> {
  await page.reload();
  await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
  await sidebarItem(page, "Editor").click();
  await expect(page.locator(".react-flow__node").filter({ hasText: "Note" }).first()).toBeVisible();
  const sent = page.waitForRequest((request) => request.method() === "POST" && request.url().includes(`/api/workflows/${workflowId}/execute`));
  await page.getByRole("banner").getByRole("button", { name: "Run workflow" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  await expect(page.locator(".react-flow__node").filter({ hasText: "Output" }).first().getByTestId("node-run-preview")).toContainText("success", { timeout: 60_000 });
  return body;
}

test.describe("editor run prompts", () => {
  test.setTimeout(120_000);

  test("sends no prompt to a workflow that does not read one, and keeps it for one that does", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const plain = `wf-e2e-noprompt-${stamp}`;
    const reads = `wf-e2e-prompt-${stamp}`;
    try {
      expect((await page.request.post("/api/workflows", { data: workflow(plain, "fixed text") })).ok()).toBeTruthy();
      expect((await page.request.post("/api/workflows", { data: workflow(reads, "You asked: {{user_prompt}}") })).ok()).toBeTruthy();

      const plainBody = await runFromEditor(page, plain);
      expect(plainBody).not.toHaveProperty("user_prompt");
      expect(plainBody).not.toHaveProperty("system_prompt");
      const plainRun = (await (await page.request.get(`/api/executions?workflowId=${plain}&page=1&pageSize=1`)).json()) as { items?: Array<{ id: string }> };
      if (plainRun.items?.[0]) {
        const detail = await (await page.request.get(`/api/executions/${plainRun.items[0].id}`)).text();
        expect(detail).not.toContain("America/Toronto");
      }

      const readsBody = await runFromEditor(page, reads);
      expect(readsBody.user_prompt).toEqual(expect.any(String));
      expect(readsBody).not.toHaveProperty("system_prompt");
    } finally {
      await page.request.delete(`/api/workflows/${plain}`);
      await page.request.delete(`/api/workflows/${reads}`);
    }
  });
});
