import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const EXTERNAL_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../samples/external-imports/if-two-branches.json"
);

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

async function ensureAuthenticated(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${API_URL}/health`);
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

/** The "Orbit" shell: a persistent `<aside class="app-sidebar">` with one button per workspace mode. */
function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function openStudio(page: Page): Promise<void> {
  await ensureAuthenticated(page);
  // Suppress the first-login welcome modal — it intercepts clicks on the
  // workflow editor and isn't part of any journey under test here.
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
  await expect(sidebarItem(page, "Home")).toBeVisible();
}

test.describe("golden journeys", () => {
  test.setTimeout(180_000);

  test("login, create workflow, configure node, save, execute, inspect history, create secret, and use template", async ({
    page
  }) => {
    await openStudio(page);

    // Dashboard ("Home") → New workflow drops us into the editor with a starter graph.
    await sidebarItem(page, "Home").click();
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
    await page.getByRole("button", { name: "New workflow" }).click();
    await expect(sidebarItem(page, "Editor")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Run workflow" })).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();

    // Configure the starter User Prompt node in the docked inspector drawer.
    const userPromptNode = page.locator(".react-flow__node").filter({ hasText: "User Prompt" }).first();
    await userPromptNode.dblclick();
    const inspector = page.getByRole("dialog", { name: /^Inspect / });
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("button", { name: "Save changes" })).toBeVisible();
    await inspector.getByLabel("Text", { exact: true }).fill("E2E configured prompt");
    await inspector.getByRole("button", { name: "Save changes" }).click();

    // Save via the HUD pill, then run via the primary HUD button.
    const hud = page.getByRole("banner");
    await hud.getByRole("button", { name: "Save", exact: true }).click();
    await hud.getByRole("button", { name: "Run workflow" }).click();

    // Inspect history in the Runs workspace.
    await sidebarItem(page, "Runs").click();
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

    // The HUD breadcrumb carries the active workflow switcher.
    const hudWorkflowSelect = hud.getByRole("combobox", { name: "Workflow", exact: true });
    const activeWorkflowId = await hudWorkflowSelect.inputValue();
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

    await sidebarItem(page, "Templates").click();
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
    const templateCard = page.getByTestId(`tpl-card-${createdTemplate.id}`);
    await expect(templateCard).toBeVisible();
    await expect(templateCard).toContainText(templateName);
    const useTemplateButton = templateCard.getByRole("button", { name: "Use Template" });
    await expect(useTemplateButton).toBeVisible();
    const useTemplateResponse = await page.request.post(`/api/templates/${createdTemplate.id}/use`);
    expect(useTemplateResponse.ok()).toBeTruthy();
    const importedTemplateWorkflow = (await useTemplateResponse.json()) as { workflowId: string; name: string };
    await page.reload();
    await expect(page.getByRole("banner").getByRole("combobox", { name: "Workflow", exact: true })).toContainText(
      importedTemplateWorkflow.name
    );
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
    // With the execution queue in use the resume is queued (202); otherwise it runs inline.
    const approveBody = (await approveResponse.json()) as { queued?: boolean; status?: string };
    if (approveBody.queued) expect(approveResponse.status()).toBe(202);
    else expect(approveBody.status).toBe("success");

    await expect.poll(async () => {
      const history = await page.request.get(`/api/executions/${pending!.id}`);
      if (!history.ok()) return "pending";
      const body = await history.json();
      return String(body.status);
    }).toBe("success");
  });

  test("imports a workflow from another builder with a preview and a checklist", async ({ page }) => {
    await openStudio(page);

    await sidebarItem(page, "Home").click();
    await page.getByRole("button", { name: "Import…" }).click();
    const dialog = page.getByRole("dialog", { name: "Import from another builder" });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("import-file-input").setInputFiles(EXTERNAL_FIXTURE);

    // Preview first: nothing is stored until the user confirms.
    await expect(dialog.getByRole("button", { name: "Import workflow" })).toBeVisible();
    await expect(dialog.getByText(/mapped/).first()).toBeVisible();
    const importedName = `Imported ${Date.now()}`;
    await dialog.getByRole("textbox", { name: "Workflow name" }).fill(importedName);
    await dialog.getByRole("button", { name: "Import workflow" }).click();

    await expect(dialog).toBeHidden();
    await expect(sidebarItem(page, "Editor")).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("textbox", { name: "Workflow name" })).toHaveValue(importedName);
    const checklist = page.getByRole("complementary", { name: "Import checklist" });
    await expect(checklist).toBeVisible();

    await checklist.getByRole("button", { name: "Validate" }).click();
    await expect(checklist.getByText(/Saved and valid|Validation found/)).toBeVisible();

    await checklist.getByRole("button", { name: "Dismiss import checklist" }).click();
    await expect(checklist).toBeHidden();
  });
});
