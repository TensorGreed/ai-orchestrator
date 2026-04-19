import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";

async function ensureAuthenticated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get("http://localhost:4000/health");
        return response.ok();
      },
      { timeout: 60_000 }
    )
    .toBeTruthy();

  const sessionCheck = await page.request.get("/api/auth/me");
  if (!sessionCheck.ok()) {
    const loginResponse = await page.request.post("/api/auth/login", {
      data: {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD
      }
    });
    expect(loginResponse.ok()).toBeTruthy();
  }
}

async function openStudio(page: Page): Promise<void> {
  await ensureAuthenticated(page);
  await page.goto("/");
  await expect(page.getByLabel("Studio modes")).toBeVisible({ timeout: 60_000 });
}

test.describe("golden journeys", () => {
  test.setTimeout(180_000);

  test("login, create workflow, configure node, save, execute, inspect history, create secret, and use template", async ({
    page
  }) => {
    await openStudio(page);

    await page.getByRole("button", { name: "New Workflow" }).click();
    await expect(page.getByRole("button", { name: "Execute workflow" })).toBeVisible();

    const userPromptNode = page.locator(".react-flow__node").filter({ hasText: "User Prompt" }).first();
    await userPromptNode.dblclick();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();
    await page.getByLabel("Text").fill("E2E configured prompt");
    await page.getByRole("button", { name: "Save changes" }).click();

    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("button", { name: "Execute workflow" }).click();

    const leftMenu = page.getByRole("complementary");
    await leftMenu.getByRole("button", { name: "Runs" }).click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await expect(page.locator(".executions-table tbody tr").first()).toBeVisible();
    await expect.poll(async () => {
      const firstRow = page.locator(".executions-table tbody tr").first();
      return ((await firstRow.textContent()) ?? "").toLowerCase();
    }).toContain("success");

    const secretName = `E2E Secret ${Date.now()}`;
    const createSecretResponse = await page.request.post("/api/secrets", {
      data: {
        name: secretName,
        provider: "custom",
        value: "sk-e2e-secret-token",
        projectId: "default"
      }
    });
    expect(createSecretResponse.ok()).toBeTruthy();
    await expect.poll(async () => {
      const listSecretsResponse = await page.request.get("/api/secrets?projectId=default");
      if (!listSecretsResponse.ok()) {
        return false;
      }
      const secrets = (await listSecretsResponse.json()) as Array<{ name?: string }>;
      return secrets.some((secret) => secret.name === secretName);
    }).toBeTruthy();

    const headerWorkflowSelect = page.locator("header .workflow-select");
    const activeWorkflowId = await headerWorkflowSelect.inputValue();
    expect(activeWorkflowId).not.toBe("");
    const templateName = `E2E Template ${Date.now()}`;
    const createTemplateResponse = await page.request.post("/api/templates", {
      data: {
        name: templateName,
        category: "E2E",
        workflowId: activeWorkflowId
      }
    });
    expect(createTemplateResponse.ok()).toBeTruthy();
    const createdTemplate = (await createTemplateResponse.json()) as { id: string; name: string };

    await page.getByRole("button", { name: "Tmpl" }).click();
    await expect(page.getByRole("heading", { name: "Template Gallery" })).toBeVisible();
    const templateCard = page.locator(".tpl-card").filter({ hasText: templateName });
    await expect(templateCard).toBeVisible();
    const useTemplateButton = templateCard.getByRole("button", { name: "Use Template" });
    await expect(useTemplateButton).toBeVisible();
    const useTemplateResponse = await page.request.post(`/api/templates/${createdTemplate.id}/use`);
    expect(useTemplateResponse.ok()).toBeTruthy();
    const importedTemplateWorkflow = (await useTemplateResponse.json()) as { workflowId: string; name: string };
    await page.reload();
    await expect(page.locator("header .workflow-select")).toContainText(importedTemplateWorkflow.name);
  });

  test("approves a waiting human-approval execution via API journey", async ({ page }) => {
    await ensureAuthenticated(page);

    const workflowId = `wf-e2e-approval-${Date.now()}`;
    const workflowName = `E2E Approval Flow ${Date.now()}`;
    const inputNodeId = "input-node";
    const approvalNodeId = "approval-node";
    const outputNodeId = "output-node";

    const createWorkflowResponse = await page.request.post("/api/workflows", {
      data: {
        id: workflowId,
        name: workflowName,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          {
            id: inputNodeId,
            type: "text_input",
            name: "Input",
            position: { x: 80, y: 180 },
            config: { text: "approve me" }
          },
          {
            id: approvalNodeId,
            type: "human_approval",
            name: "Approval",
            position: { x: 360, y: 180 },
            config: {
              approvalMessage: "Approve this test run",
              timeoutMinutes: 30
            }
          },
          {
            id: outputNodeId,
            type: "output",
            name: "Output",
            position: { x: 650, y: 180 },
            config: {
              responseTemplate: "approved={{approval.approved}}",
              outputKey: "result"
            }
          }
        ],
        edges: [
          { id: "edge-1", source: inputNodeId, target: approvalNodeId },
          { id: "edge-2", source: approvalNodeId, target: outputNodeId }
        ]
      }
    });
    expect(createWorkflowResponse.ok()).toBeTruthy();

    const executeResponse = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: {} });
    expect(executeResponse.ok()).toBeTruthy();
    const executeBody = await executeResponse.json();
    expect(executeBody.status).toBe("waiting_approval");

    const approvalsResponse = await page.request.get("/api/approvals");
    expect(approvalsResponse.ok()).toBeTruthy();
    const approvals = (await approvalsResponse.json()) as { items: Array<{ id: string; workflowId: string }> };
    const pending = approvals.items.find((item) => item.workflowId === workflowId);
    expect(pending).toBeTruthy();

    const approveResponse = await page.request.post(`/api/approvals/${pending!.id}/approve`, { data: {} });
    expect(approveResponse.ok()).toBeTruthy();
    const approveBody = await approveResponse.json();
    expect(approveBody.status).toBe("success");

    await expect.poll(async () => {
      const history = await page.request.get(`/api/executions/${pending!.id}`);
      if (!history.ok()) return "pending";
      const body = await history.json();
      return String(body.status);
    }).toBe("success");
  });
});
