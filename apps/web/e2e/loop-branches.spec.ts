import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Branches inside a Loop body: a Loop saved without branch routing runs the nodes after both IF outputs once, after
 * the loop; with **Branches route in the loop** turned on in the Loop's form, each pass runs only the output the IF
 * takes, and a Merge collecting loop passes gathers both outputs in item order. Everything it makes is removed.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "loop-branches");

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

const PRODUCTS = [
  { name: "pen", price: 10 },
  { name: "lamp", price: 30 },
  { name: "desk", price: 50 }
];

type RunDetail = {
  nodeResults?: Array<{ nodeId: string; status: string; output?: Record<string, unknown> }>;
  result?: { nodeResults?: Array<{ nodeId: string; status: string; output?: Record<string, unknown> }> };
};

async function latestRun(page: Page, workflowId: string) {
  const latest = (await (await page.request.get(`/api/executions?workflowId=${workflowId}&page=1&pageSize=1`)).json()) as { items: Array<{ id: string }> };
  const detail = (await (await page.request.get(`/api/executions/${latest.items[0]!.id}`)).json()) as RunDetail;
  const results = detail.nodeResults ?? detail.result?.nodeResults ?? [];
  return {
    statuses: (id: string) => results.filter((entry) => entry.nodeId === id).map((entry) => entry.status),
    outputOf: (id: string) => results.filter((entry) => entry.nodeId === id).at(-1)?.output
  };
}

test.describe("branches in a Loop body", () => {
  test.setTimeout(180_000);

  test("route per pass once the Loop's option is on", async ({ page }) => {
    const modelServerCalls: string[] = [];
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerCalls.push(route.request().url());
      await route.abort();
    });

    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-loop-branches-${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Loop branches ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "start", type: "manual_trigger", name: "Start", position: { x: 40, y: 200 }, config: {} },
            {
              id: "fetch",
              type: "set_node",
              name: "Fetch products",
              position: { x: 300, y: 200 },
              config: { assignments: [{ key: "items", valueTemplate: JSON.stringify(PRODUCTS), type: "json" }] }
            },
            // Saved without routeBranches, as a Loop from before the option.
            { id: "loop", type: "loop_node", name: "Each product", position: { x: 560, y: 200 }, config: { inputKey: "items", itemVariable: "product", maxIterations: 100 } },
            { id: "check", type: "if_node", name: "Over 25", position: { x: 820, y: 200 }, config: { condition: "{{ product.price > 25 }}" } },
            { id: "large", type: "set_node", name: "Tag large", position: { x: 1080, y: 80 }, config: { assignments: [{ key: "large", valueTemplate: "{{product.name}}", type: "auto" }] } },
            { id: "small", type: "set_node", name: "Tag small", position: { x: 1080, y: 320 }, config: { assignments: [{ key: "small", valueTemplate: "{{product.name}}", type: "auto" }] } },
            { id: "merge", type: "merge_node", name: "All tags", position: { x: 1340, y: 200 }, config: { mode: "collect_loop_passes" } }
          ],
          edges: [
            { id: "e1", source: "start", target: "fetch" },
            { id: "e2", source: "fetch", target: "loop" },
            { id: "e3", source: "loop", target: "check" },
            { id: "e4", source: "check", sourceHandle: "true", target: "large" },
            { id: "e5", source: "check", sourceHandle: "false", target: "small" },
            { id: "e6", source: "large", target: "merge" },
            { id: "e7", source: "small", target: "merge" }
          ]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await sidebarItem(page, "Editor").click();
      await expect(canvasNode(page, "Each product")).toBeVisible();

      // Before: both outputs' nodes run once, after the loop, with the last product.
      const hud = page.getByRole("banner");
      await hud.getByRole("button", { name: "Run workflow" }).click();
      await expect(canvasNode(page, "All tags").getByTestId("node-run-preview")).toContainText("success", { timeout: 60_000 });
      await expect(canvasNode(page, "Over 25").getByTestId("node-run-preview")).toContainText("3 passes");
      await page.screenshot({ path: path.join(SHOT_DIR, "before-01-loop-without-routing.png") });
      let run = await latestRun(page, workflowId);
      expect(run.statuses("large")).toEqual(["success"]);
      expect(run.statuses("small")).toEqual(["success"]);
      expect(run.outputOf("small")).toEqual({ small: "desk" });

      // Turn the option on in the Loop's form and save.
      await canvasNode(page, "Each product").dblclick();
      const inspector = page.getByRole("dialog", { name: /^Inspect / });
      const toggle = inspector.getByRole("button", { name: /Branches route in the loop/ });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await toggle.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOT_DIR, "after-01-loop-option.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();
      await expect(inspector).toHaveCount(0);
      await hud.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(
          async () => {
            const saved = (await (await page.request.get(`/api/workflows/${workflowId}`)).json()) as { nodes: Array<{ id: string; config: Record<string, unknown> }> };
            return saved.nodes.find((entry) => entry.id === "loop")?.config.routeBranches;
          },
          { timeout: 30_000 }
        )
        .toBe(true);
      await expect(canvasNode(page, "Each product")).toContainText("routes branches");

      // After: each pass runs only the output it takes.
      await hud.getByRole("button", { name: "Run workflow" }).click();
      await expect(canvasNode(page, "Tag large").getByTestId("node-run-preview")).toContainText("2 passes", { timeout: 60_000 });
      await expect(canvasNode(page, "All tags").getByTestId("node-run-preview")).toContainText("3 items");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-02-run-routed.png") });
      run = await latestRun(page, workflowId);
      expect(run.statuses("large")).toEqual(["success", "success"]);
      expect(run.statuses("small")).toEqual(["success"]);
      expect(run.outputOf("merge")).toEqual({ items: [{ small: "pen" }, { large: "lamp" }, { large: "desk" }], count: 3 });
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
    expect(modelServerCalls).toEqual([]);
  });
});
