import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * 6.4 — agent tools in the editor: the palette offers the built-in tools as ready MCP Tool nodes, a built-in tool
 * node shows its provider fields, and a Workflow Tool node on an agent's tool port previews the tool the agent will
 * see from the child workflow's trigger. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "agent-tools");

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

test.describe("agent tools", () => {
  test.setTimeout(180_000);

  test("built-in tool presets, their fields, and a Workflow Tool's preview of the child's tool", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const childId = `wf-e2e-tool-child-${stamp}`;
    const parentId = `wf-e2e-tool-parent-${stamp}`;
    try {
      const child = await page.request.post("/api/workflows", {
        data: {
          id: childId,
          name: `E2E Order lookup ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            {
              id: "start",
              type: "sub_workflow_trigger",
              name: "Start",
              position: { x: 80, y: 180 },
              config: { readOnly: true, description: "Looks up an order by id.", inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } }
            },
            { id: "out", type: "output", name: "Output", position: { x: 380, y: 180 }, config: { responseTemplate: "shipped", outputKey: "result" } }
          ],
          edges: [{ id: "e1", source: "start", target: "out" }]
        }
      });
      expect(child.ok()).toBeTruthy();
      const parent = await page.request.post("/api/workflows", {
        data: {
          id: parentId,
          name: `E2E Agent tools ${stamp}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "in", type: "webhook_input", name: "Hook", position: { x: 40, y: 180 }, config: { path: `e2e-tools-${stamp}`, method: "POST" } },
            { id: "agent", type: "agent_orchestrator", name: "Agent", position: { x: 340, y: 180 }, config: { maxIterations: 4, toolCallingEnabled: true, thinkTool: true } },
            { id: "model", type: "llm_call", name: "Model", position: { x: 240, y: 420 }, config: { provider: { providerId: "openai", model: "gpt-4o-mini" } } },
            { id: "wiki", type: "mcp_tool", name: "Wikipedia", position: { x: 400, y: 420 }, config: { serverId: "l2m-tools", toolName: "__all__", connection: { provider: "wikipedia" } } },
            { id: "lookup", type: "workflow_tool", name: "Order lookup tool", position: { x: 560, y: 420 }, config: { workflowId: childId } },
            { id: "out", type: "output", name: "Output", position: { x: 640, y: 180 }, config: { responseTemplate: "{{results.agent.answer}}", outputKey: "result" } }
          ],
          edges: [
            { id: "e1", source: "in", target: "agent" },
            { id: "e2", source: "agent", target: "out" },
            { id: "e3", source: "agent", sourceHandle: "chat_model", target: "model" },
            { id: "e4", source: "agent", sourceHandle: "tool", target: "wiki" },
            { id: "e5", source: "agent", sourceHandle: "tool", target: "lookup" }
          ]
        }
      });
      expect(parent.ok()).toBeTruthy();
      const validated = await page.request.post(`/api/workflows/${parentId}/validate`);
      expect(validated.ok()).toBeTruthy();
      const report = (await validated.json()) as { issues?: Array<{ code: string }> };
      expect((report.issues ?? []).map((issue) => issue.code)).not.toContain("invalid_tool_attachment");
      expect((report.issues ?? []).map((issue) => issue.code)).not.toContain("workflow_tool_not_attached");

      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(parentId);
      await sidebarItem(page, "Editor").click();

      // The Workflow Tool node previews the child's tool.
      await page.locator(".react-flow__node").filter({ hasText: "Order lookup tool" }).first().dblclick();
      const inspector = page.getByRole("dialog", { name: /^Inspect / });
      const preview = inspector.getByTestId("workflow-tool-preview");
      await expect(preview).toContainText("Looks up an order by id.");
      await expect(preview).toContainText("Sub-Workflow Trigger");
      await expect(preview).toContainText('"order_id"');
      // Read-only comes from the child's own trigger, not from a toggle on this node.
      await expect(inspector.getByTestId("workflow-tool-read-only")).toContainText("declares itself read-only");
      await expect(inspector.getByRole("button", { name: /Read-only workflow/ })).toHaveCount(0);
      await expect(inspector.getByText(`workflow:${childId}`)).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "01-workflow-tool-preview.png") });
      await inspector.getByRole("button", { name: "Close inspector" }).click();

      // The built-in tool node shows its provider fields.
      await page.locator(".react-flow__node").filter({ hasText: "Wikipedia" }).first().dblclick();
      await expect(inspector.getByRole("combobox", { name: /Built-in tool/ })).toHaveValue("wikipedia");
      await expect(inspector.getByLabel(/Language edition/)).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "02-built-in-tool-fields.png") });
      await inspector.getByRole("button", { name: "Close inspector" }).click();

      // The palette lists the built-in tools as their own rows.
      await page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: /Add node/ }).click();
      await page.getByRole("textbox", { name: "Search nodes" }).fill("Wolfram");
      await expect(page.locator(".node-palette-node-row").filter({ hasText: "Wolfram Alpha" })).toHaveAttribute("id", "palette-row-built-in-tool:wolfram");
      await page.screenshot({ path: path.join(SHOT_DIR, "03-palette-built-in-tools.png") });
    } finally {
      await page.request.delete(`/api/workflows/${parentId}`);
      await page.request.delete(`/api/workflows/${childId}`);
    }
  });
});
