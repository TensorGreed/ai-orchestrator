import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Lists of items: a Filter in items mode keeps the matching items of a list, a Set field typed auto keeps a boolean,
 * a Loop collects its passes, a Merge collects a loop body's passes, and the body node's card counts every pass.
 * Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "item-nodes");

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

test.describe("lists of items", () => {
  test.setTimeout(180_000);

  test("filters items, keeps types, and collects loop passes", async ({ page }) => {
    const modelServerCalls: string[] = [];
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerCalls.push(route.request().url());
      await route.abort();
    });

    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-item-nodes-${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Items ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "start", type: "manual_trigger", name: "Start", position: { x: 40, y: 160 }, config: {} },
            {
              id: "fetch",
              type: "set_node",
              name: "Fetch products",
              position: { x: 300, y: 160 },
              config: { assignments: [{ key: "body", valueTemplate: JSON.stringify({ page: 1, items: PRODUCTS }), type: "json" }] }
            },
            {
              id: "filter",
              type: "filter_node",
              name: "Pricey only",
              position: { x: 560, y: 160 },
              config: { mode: "items", itemsFrom: "", conditions: [{ field: "price", operator: "gt", value: "25" }], combineWith: "AND", passMode: "pass" }
            },
            { id: "loop", type: "loop_node", name: "Each product", position: { x: 820, y: 160 }, config: { inputKey: "items", itemVariable: "product", maxIterations: 100, collectResults: true } },
            {
              id: "body",
              type: "set_node",
              name: "Shape row",
              position: { x: 1080, y: 160 },
              config: {
                assignments: [
                  { key: "name", valueTemplate: "{{product.name}}", type: "auto" },
                  { key: "expensive", valueTemplate: "{{ product.price > 40 }}", type: "auto" }
                ]
              }
            },
            { id: "merge", type: "merge_node", name: "All rows", position: { x: 1340, y: 160 }, config: { mode: "collect_loop_passes" } }
          ],
          edges: [
            { id: "e1", source: "start", target: "fetch" },
            { id: "e2", source: "fetch", target: "filter" },
            { id: "e3", source: "filter", target: "loop" },
            { id: "e4", source: "loop", target: "body" },
            { id: "e5", source: "body", target: "merge" }
          ]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await sidebarItem(page, "Editor").click();
      await expect(canvasNode(page, "Pricey only")).toBeVisible();
      await expect(canvasNode(page, "Pricey only")).toContainText("items of first list");

      // The Filter's form: items mode with Items from.
      await canvasNode(page, "Pricey only").dblclick();
      let inspector = page.getByRole("dialog", { name: /^Inspect / });
      await expect(inspector.getByLabel(/^Mode/)).toHaveValue("items");
      await expect(inspector.getByLabel(/^Items from/)).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "after-01-filter-items-mode.png") });
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);

      // The Set form: each field has a Type.
      await canvasNode(page, "Shape row").dblclick();
      inspector = page.getByRole("dialog", { name: /^Inspect / });
      await expect(inspector.getByLabel(/^Type/).nth(1)).toHaveValue("auto");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-02-set-field-types.png") });
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);

      const hud = page.getByRole("banner");
      await hud.getByRole("button", { name: "Run workflow" }).click();
      await expect(canvasNode(page, "All rows").getByTestId("node-run-preview")).toContainText("success", { timeout: 60_000 });
      await expect(canvasNode(page, "Pricey only").getByTestId("node-run-preview")).toContainText("2 items");
      await expect(canvasNode(page, "Shape row").getByTestId("node-run-preview")).toContainText("2 passes · 2 items");
      await expect(canvasNode(page, "All rows").getByTestId("node-run-preview")).toContainText("2 items");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-03-run.png") });

      const latest = (await (await page.request.get(`/api/executions?workflowId=${workflowId}&page=1&pageSize=1`)).json()) as { items: Array<{ id: string }> };
      const detail = (await (await page.request.get(`/api/executions/${latest.items[0]!.id}`)).json()) as {
        nodeResults?: Array<{ nodeId: string; output?: Record<string, unknown> }>;
        result?: { nodeResults?: Array<{ nodeId: string; output?: Record<string, unknown> }> };
      };
      const results = detail.nodeResults ?? detail.result?.nodeResults ?? [];
      const outputOf = (id: string) => results.filter((entry) => entry.nodeId === id).at(-1)?.output;
      expect(outputOf("filter")).toMatchObject({ items: [PRODUCTS[1], PRODUCTS[2]], count: 2, total: 3, items_from: "body.items" });
      const rows = [
        { name: "lamp", expensive: false },
        { name: "desk", expensive: true }
      ];
      expect(outputOf("loop")).toMatchObject({ count: 2, collected: rows });
      expect(outputOf("merge")).toEqual({ items: rows, count: 2 });

      // The body node's Run data says it shows the last pass.
      await canvasNode(page, "Shape row").dblclick();
      inspector = page.getByRole("dialog", { name: /^Inspect / });
      await expect(inspector.getByTestId("run-data-status")).toContainText("last of 2 passes");
      await page.screenshot({ path: path.join(SHOT_DIR, "after-04-body-run-data.png") });
      await page.keyboard.press("Escape");
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
    expect(modelServerCalls).toEqual([]);
  });
});
