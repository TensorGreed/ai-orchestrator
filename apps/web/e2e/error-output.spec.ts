import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * A node's Error output: choosing "Execute Fallback Branch" on an HTTP Request node gives it a red Error output on the
 * canvas, the output can be wired to a fallback step, and a run whose request gets an error status (fail on HTTP error
 * status is on) takes the fallback and skips the main path. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
/** Where the journey's screenshots go (the lane folder when set). */
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "error-output");

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

const canvasNode = (page: Page, name: string) => page.locator(".react-flow__node").filter({ hasText: name }).first();

test.describe("error output", () => {
  test.setTimeout(180_000);

  test("wires an HTTP Request's Error output and a failing run takes it", async ({ page }) => {
    // No model server is ever contacted from this journey.
    const modelServerCalls: string[] = [];
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerCalls.push(route.request().url());
      await route.abort();
    });

    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-error-output-${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Error output ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "start", type: "manual_trigger", name: "Start", position: { x: 60, y: 160 }, config: {} },
            {
              id: "call",
              type: "http_request",
              name: "Call API",
              position: { x: 340, y: 160 },
              config: { method: "GET", urlTemplate: `${API_URL}/e2e-missing-${stamp}`, failOnHttpError: true, retryCount: 0, responseType: "json", timeoutMs: 10000 }
            },
            { id: "main", type: "set_node", name: "Main path", position: { x: 640, y: 160 }, config: { assignments: [{ key: "path", valueTemplate: "main" }] } },
            { id: "out", type: "output", name: "Main out", position: { x: 920, y: 160 }, config: { responseTemplate: "{{path}}" } },
            { id: "fallback", type: "set_node", name: "Fallback", position: { x: 640, y: 400 }, config: { assignments: [{ key: "path", valueTemplate: "fallback {{status}}" }] } },
            { id: "fbout", type: "output", name: "Fallback out", position: { x: 920, y: 400 }, config: { responseTemplate: "{{path}}" } }
          ],
          edges: [
            { id: "e1", source: "start", target: "call" },
            { id: "e2", source: "call", target: "main" },
            { id: "e3", source: "main", target: "out" },
            { id: "e4", source: "fallback", target: "fbout" }
          ]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await sidebarItem(page, "Editor").click();
      const call = canvasNode(page, "Call API");
      await expect(call).toBeVisible();
      await expect(call.locator('[data-handleid="error"]')).toHaveCount(0);
      await expect(page.locator(".react-flow__edge")).toHaveCount(4);
      await page.screenshot({ path: path.join(SHOT_DIR, "01-before-no-error-output.png") });

      // More → On Error Behavior → Execute Fallback Branch. A node that fails on an error status shows no switch for it.
      await call.dblclick();
      const inspector = page.getByRole("dialog", { name: /^Inspect / });
      await expect(inspector.getByRole("button", { name: /Fail on HTTP error status/ })).toHaveCount(0);
      await inspector.getByTestId("advanced-fields").getByText("More", { exact: true }).click();
      await page.screenshot({ path: path.join(SHOT_DIR, "01b-http-more.png") });
      await inspector.getByRole("combobox", { name: "On Error Behavior" }).selectOption("branch");
      await expect(inspector.getByTestId("error-output-tip")).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "02-settings-fallback-branch.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();

      // The node now has a red Error output; drag it to the fallback step.
      const errorHandle = call.locator('[data-handleid="error"]');
      await expect(errorHandle).toBeVisible();
      const fallbackTarget = canvasNode(page, "Fallback").locator(".react-flow__handle.target").first();
      const from = (await errorHandle.boundingBox())!;
      const to = (await fallbackTarget.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      await page.mouse.up();
      await expect(page.locator(".react-flow__edge")).toHaveCount(5);
      await page.screenshot({ path: path.join(SHOT_DIR, "03-after-error-output-wired.png") });

      const hud = page.getByRole("banner");
      await hud.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(
          async () => {
            const saved = (await (await page.request.get(`/api/workflows/${workflowId}`)).json()) as {
              nodes: Array<{ id: string; config: Record<string, unknown> }>;
              edges: Array<{ source: string; target: string; sourceHandle?: string }>;
            };
            return [
              saved.nodes.find((node) => node.id === "call")?.config.onError,
              saved.edges.some((edge) => edge.source === "call" && edge.target === "fallback" && edge.sourceHandle === "error")
            ];
          },
          { timeout: 30_000 }
        )
        .toEqual(["branch", true]);

      // The request gets 404: the run takes the Error output and skips the main path.
      await hud.getByRole("button", { name: "Run workflow" }).click();
      await expect(canvasNode(page, "Fallback out").getByTestId("node-run-preview")).toContainText("success", { timeout: 60_000 });
      await expect(canvasNode(page, "Fallback").getByTestId("node-run-preview")).toContainText("fallback 404");
      await expect(canvasNode(page, "Main path").getByTestId("node-run-preview")).toContainText("skipped");
      await expect(call.getByTestId("node-run-preview")).toContainText("HTTP 404");
      await page.screenshot({ path: path.join(SHOT_DIR, "04-run-took-error-output.png") });
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
    expect(modelServerCalls).toEqual([]);
  });
});
