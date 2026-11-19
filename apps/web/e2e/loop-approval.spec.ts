import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * A Human Approval in a Loop body asks once per pass: a 3-item loop asks three times, one request after another, each
 * with its item and pass. Approve, reject (the rejection goes to the approval's Error output), approve; the run then
 * shows each pass's approval on the run tape. Everything it makes is removed.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "loop-approval");

function sidebarItem(page: Page, label: string | RegExp) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: typeof label === "string" });
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

const PRODUCTS = ["pen", "lamp", "desk"];

type NodeResult = { nodeId: string; status: string; output?: Record<string, unknown>; loopPass?: { pass: number; of: number } };

async function runDetail(page: Page, executionId: string): Promise<{ status: string; nodeResults: NodeResult[] }> {
  const detail = (await (await page.request.get(`/api/executions/${executionId}`)).json()) as { status: string; nodeResults?: NodeResult[]; result?: { nodeResults?: NodeResult[] } };
  return { status: detail.status, nodeResults: detail.nodeResults ?? detail.result?.nodeResults ?? [] };
}

test.describe("Human Approval in a Loop body", () => {
  test.setTimeout(180_000);

  test("asks once per pass: approve, reject, approve", async ({ page }) => {
    const modelServerCalls: string[] = [];
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerCalls.push(route.request().url());
      await route.abort();
    });

    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-loop-approval-${stamp}`;
    const workflowName = `E2E Loop approval ${stamp}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: workflowName,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "start", type: "manual_trigger", name: "Start", position: { x: 40, y: 200 }, config: {} },
            { id: "fetch", type: "set_node", name: "Fetch products", position: { x: 300, y: 200 }, config: { assignments: [{ key: "items", valueTemplate: JSON.stringify(PRODUCTS), type: "json" }] } },
            { id: "loop", type: "loop_node", name: "Each product", position: { x: 560, y: 200 }, config: { inputKey: "items", itemVariable: "product", maxIterations: 100, routeBranches: true, collectResults: true } },
            { id: "ask", type: "human_approval", name: "Ask to order", position: { x: 820, y: 200 }, config: { approvalMessage: "Order a {{product}}?", timeoutMinutes: 60, onError: "branch" } },
            { id: "order", type: "set_node", name: "Order", position: { x: 1080, y: 80 }, config: { assignments: [{ key: "ordered", valueTemplate: "{{product}}", type: "auto" }] } },
            { id: "skip", type: "set_node", name: "Not ordered", position: { x: 1080, y: 320 }, config: { assignments: [{ key: "skipped", valueTemplate: "{{product}}", type: "auto" }] } }
          ],
          edges: [
            { id: "e1", source: "start", target: "fetch" },
            { id: "e2", source: "fetch", target: "loop" },
            { id: "e3", source: "loop", target: "ask" },
            { id: "e4", source: "ask", target: "order" },
            { id: "e5", source: "ask", sourceHandle: "error", target: "skip" }
          ]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      // No warning about the approval in the Loop body any more.
      const validation = (await (await page.request.post(`/api/workflows/${workflowId}/validate`)).json()) as { issues?: Array<{ code: string }> };
      expect((validation.issues ?? []).map((issue) => issue.code)).not.toContain("human_approval_in_loop");

      const started = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: { input: {} } });
      expect(started.ok(), await started.text()).toBeTruthy();
      const { executionId, status } = (await started.json()) as { executionId: string; status: string };
      expect(status).toBe("waiting_approval");

      await page.reload();
      // The item's name carries the waiting count ("Approvals 1 waiting").
      await sidebarItem(page, /^Approvals/).click();
      const decisions: Array<{ product: string; decision: "Approve" | "Reject" }> = [
        { product: "pen", decision: "Approve" },
        { product: "lamp", decision: "Reject" },
        { product: "desk", decision: "Approve" }
      ];
      for (const [index, step] of decisions.entries()) {
        const card = page.locator("article.approval-card.is-pending").filter({ hasText: workflowName }).filter({ hasText: `Order a ${step.product}?` });
        // A decision resumes the run on the queue (WORKER_MODE=all); the page shows the next pass's request when it comes
        // in, without a Refresh.
        await expect(card).toHaveCount(1, { timeout: 15_000 });
        await expect(card).toContainText(`Pass ${index + 1} of 3 (loop)`);
        if (index === 1) await page.screenshot({ path: path.join(SHOT_DIR, "after-01-approval-pass-2.png") });
        if (step.decision === "Reject") await card.getByLabel(/Reason/).fill("Not this month");
        await card.getByRole("button", { name: step.decision, exact: true }).click();
        await expect(card).toHaveCount(0, { timeout: 30_000 });
        await expect(page.locator(".approvals-notice")).toContainText(step.decision === "Approve" ? "Approved" : "Rejected");
      }

      await expect.poll(async () => (await runDetail(page, executionId)).status, { timeout: 30_000 }).toBe("partial");
      const run = await runDetail(page, executionId);
      const ran = (id: string, key: string) => run.nodeResults.filter((entry) => entry.nodeId === id && entry.status === "success").map((entry) => entry.output?.[key]);
      expect(ran("order", "ordered")).toEqual(["pen", "desk"]);
      expect(ran("skip", "skipped")).toEqual(["lamp"]);
      expect(run.nodeResults.filter((entry) => entry.nodeId === "ask").map((entry) => [entry.status, entry.loopPass?.pass])).toEqual([
        ["success", 1],
        ["error", 2],
        ["success", 3]
      ]);

      // The run tape names each approval's pass.
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await sidebarItem(page, "Editor").click();
      await page.getByRole("tab", { name: "Run tape" }).click();
      const tape = page.getByRole("table", { name: "Run tape" });
      await expect(tape).toContainText("pass 2 of 3", { timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, "after-02-run-tape.png") });
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }
    expect(modelServerCalls).toEqual([]);
  });
});
