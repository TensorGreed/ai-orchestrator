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
        // The API may still be starting: a refused connection is "not yet", not a failure.
        const response = await page.request.get(`${API_URL}/health`).catch(() => null);
        return response?.ok() ?? false;
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

    // Wait until the run is in the history, so the Runs page lists it when it loads.
    await expect
      .poll(
        async () => {
          const history = await page.request.get("/api/executions?page=1&pageSize=1");
          if (!history.ok()) return 0;
          return ((await history.json()) as { items?: unknown[] }).items?.length ?? 0;
        },
        { timeout: 60_000 }
      )
      .toBeGreaterThan(0);

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
  test("publishes a saved version: production runs it while the draft moves on", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-release-${stamp}`;
    const hookPath = `e2e-release-${stamp}`;
    const workflow = (answer: string) => ({
      id: workflowId,
      name: `E2E Release ${stamp}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position: { x: 80, y: 180 }, config: { path: hookPath, method: "POST" } },
        { id: "out", type: "output", name: "Output", position: { x: 380, y: 180 }, config: { responseTemplate: answer, outputKey: "result" } }
      ],
      edges: [{ id: "edge-1", source: "hook", target: "out" }]
    });
    expect((await page.request.post("/api/workflows", { data: workflow("first") })).ok()).toBeTruthy();
    expect((await page.request.put(`/api/workflows/${workflowId}`, { data: workflow("second") })).ok()).toBeTruthy();

    // Open the editor on the workflow and publish v1 from the version pill.
    await page.reload();
    await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
    await sidebarItem(page, "Editor").click();
    const pill = page.getByRole("button", { name: /^Release:/ });
    await expect(pill).toHaveText(/v2 · not published/);
    await pill.click();
    const dialog = page.getByRole("dialog", { name: "Publish to production" });
    await dialog.getByLabel("Version").selectOption("1");
    await expect(dialog.getByText("No release gate", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Publish v1" }).click();
    await expect(dialog.getByText(/Published v1/)).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(pill).toHaveText(/v1 live · draft \+1/);

    const prod = await page.request.post(`${API_URL}/webhook/${hookPath}`, { data: {} });
    expect(await prod.json()).toMatchObject({ output: { result: "first" } });
    const draft = await page.request.post(`${API_URL}/webhook-test/${hookPath}`, { data: {} });
    expect(await draft.json()).toMatchObject({ output: { result: "second" } });
  });

  test("captures a production run, masks it, and promotes it from the inbox into a golden set", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-capture-${stamp}`;
    const hookPath = `e2e-capture-${stamp}`;
    const workflow = {
      id: workflowId,
      name: `E2E Capture ${stamp}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position: { x: 80, y: 180 }, config: { path: hookPath, method: "POST" } },
        { id: "out", type: "output", name: "Output", position: { x: 380, y: 180 }, config: { responseTemplate: "thanks", outputKey: "result" } }
      ],
      edges: [{ id: "edge-1", source: "hook", target: "out" }]
    };
    expect((await page.request.post("/api/workflows", { data: workflow })).ok()).toBeTruthy();

    // Evaluations → Golden sets on this workflow: turn capture on with the defaults, then sample every run for the test.
    await page.reload();
    await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
    await sidebarItem(page, "Evaluations").click();
    const capture = page.getByRole("region", { name: "Production capture" });
    await expect(capture.getByText("Off. Production runs are not recorded.")).toBeVisible();
    await expect(capture.getByText(/Turn on capture and a sample/)).toBeVisible();
    await capture.getByRole("checkbox", { name: "Capture production runs" }).check();
    await expect(capture.getByText(/Capturing 10% of production runs, up to 20 a day, personal data masked/)).toBeVisible();
    await capture.getByText("Advanced").click();
    await capture.getByLabel("Sample rate (%)").fill("100");
    await capture.getByRole("button", { name: "Save" }).click();
    await expect(capture.getByText(/Capturing 100% of production runs/)).toBeVisible();

    // A production webhook run carrying an email address.
    const prod = await page.request.post(`${API_URL}/webhook/${hookPath}`, { data: { user_prompt: "Refund for jane.doe@example.com" } });
    expect(prod.ok()).toBeTruthy();

    // It lands in the inbox, masked, and is promoted in one click.
    const inbox = capture.getByRole("list", { name: "Captured runs" });
    await expect
      .poll(
        async () => {
          await capture.getByLabel("Filter by outcome").selectOption("success");
          await capture.getByLabel("Filter by outcome").selectOption("");
          return inbox.getByRole("listitem").count().catch(() => 0);
        },
        { timeout: 30_000 }
      )
      .toBe(1);
    const row = inbox.getByRole("listitem").first();
    await expect(row.getByText("email", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Promote" }).click();
    await expect(capture.getByText("1 promoted to “Captured”.")).toBeVisible();
    await expect(capture.getByText(/No captured runs yet/)).toBeVisible();

    // The case is in the auto-created "Captured" golden set.
    const sets = page.getByRole("list", { name: "Golden sets" });
    const setRow = sets.getByRole("button").filter({ hasText: "Captured" }).filter({ hasText: workflow.name });
    await expect(setRow).toBeVisible();
    await setRow.click();
    const cases = page.getByRole("region", { name: "Cases" });
    await expect(cases.getByText(/Captured webhook/)).toBeVisible();

    // An admin finds the person's masked copy; bare digits offer "Read as" and a country.
    await page.getByRole("button", { name: "← Golden sets" }).click();
    const lookup = page.getByRole("region", { name: "Find a person's data" });
    await lookup.getByLabel("Value").fill("4155550123");
    await lookup.getByLabel("Read as").selectOption("phone");
    await expect(lookup.getByLabel("Country")).toHaveValue("");
    await lookup.getByLabel("Value").fill("jane.doe@example.com");
    await expect(lookup.getByLabel("Read as")).toHaveCount(0);
    await lookup.getByRole("button", { name: "Search" }).click();
    await expect(lookup.getByText(/Searched as email address\. [1-9]\d* certain, 0 possible\./)).toBeVisible();
    const matches = lookup.getByRole("list", { name: "Matches" });
    await expect(matches.getByRole("listitem").filter({ hasText: "stored masked" }).first()).toBeVisible();
    await expect(lookup.getByRole("button", { name: /Delete selected \([1-9]/ })).toBeEnabled();
  });

  test("simulates a guard profile change on recent recorded runs before saving it", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const profileId = `e2e-sim-${stamp}`;
    const workflowId = `wf-e2e-sim-${stamp}`;
    const profile = {
      id: profileId,
      name: `E2E simulation ${stamp}`,
      version: "1",
      channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "allow" } }, defaultAction: { action: "allow" } } }
    };
    expect((await page.request.post("/api/guard/profiles", { data: { document: profile } })).ok()).toBeTruthy();
    const created = await page.request.post("/api/workflows", {
      data: {
        id: workflowId,
        name: `E2E Guarded ${stamp}`,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "hook", type: "webhook_input", name: "Hook", position: { x: 0, y: 0 }, config: { path: `e2e-sim-${stamp}`, method: "POST" } },
          { id: "guard", type: "guard", name: "Prompt guard", position: { x: 200, y: 0 }, config: {} },
          { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "passed" } },
          { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } }
        ],
        edges: [
          { id: "e1", source: "hook", target: "guard" },
          { id: "e2", source: "guard", sourceHandle: "pass", target: "pass" },
          { id: "e3", source: "guard", sourceHandle: "blocked", target: "blocked" }
        ]
      }
    });
    expect(created.ok()).toBeTruthy();
    expect((await page.request.put(`/api/guard/bindings/workflows/${workflowId}`, { data: { mode: "override", profileId } })).ok()).toBeTruthy();
    const run = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: { record: true, user_prompt: "Write to someone@example.com please" } });
    expect(run.ok()).toBeTruthy();
    const { executionId } = (await run.json()) as { executionId: string };
    expect((await page.request.post("/api/replay/recordings", { data: { executionId, name: "E2E guarded run" } })).ok()).toBeTruthy();

    // Security → Profiles: change email to block, simulate before saving.
    await sidebarItem(page, "Security").click();
    await page.getByRole("tab", { name: "Profiles & bindings" }).click();
    await page.getByRole("complementary", { name: "Guard profiles" }).getByRole("button", { name: new RegExp(profile.name) }).click();
    await page.getByLabel("Action for email").selectOption("block");
    await page.getByRole("button", { name: "Simulate on recent traffic" }).click();
    await expect(page.getByTestId("guard-sim-sentence")).toHaveText("Across 1 recent run in 1 workflow: 1 newly blocked, 0 now masked, 0 no longer blocked.", { timeout: 60_000 });
    await page.getByText("Details", { exact: true }).click();
    await expect(page.getByText("E2E guarded run")).toBeVisible();
    // Nothing was saved: the editor still offers to save the change.
    await expect(page.getByRole("button", { name: "Save new version" })).toBeEnabled();
  });

  test("turns on tracking where data came from and sees it on the run", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const profileId = `e2e-labels-${stamp}`;
    const workflowId = `wf-e2e-labels-${stamp}`;
    const profile = {
      id: profileId,
      name: `E2E labels ${stamp}`,
      version: "1",
      channels: { prompt: { detectors: [{ id: "dlp.patterns", threshold: 0.5 }], actions: { email: { action: "allow" } }, defaultAction: { action: "allow" } } }
    };
    expect((await page.request.post("/api/guard/profiles", { data: { document: profile } })).ok()).toBeTruthy();
    const created = await page.request.post("/api/workflows", {
      data: {
        id: workflowId,
        name: `E2E Labels ${stamp}`,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "hook", type: "webhook_input", name: "Hook", position: { x: 0, y: 0 }, config: { path: `e2e-labels-${stamp}`, method: "POST" } },
          { id: "note", type: "set_node", name: "Note", position: { x: 100, y: 0 }, config: { assignments: [{ key: "copy", valueTemplate: "{{user_prompt}}" }] } },
          { id: "guard", type: "guard", name: "Prompt guard", position: { x: 200, y: 0 }, config: {} },
          { id: "pass", type: "output", name: "Pass", position: { x: 400, y: 0 }, config: { responseTemplate: "passed" } },
          { id: "blocked", type: "output", name: "Blocked", position: { x: 400, y: 200 }, config: { responseTemplate: "blocked" } }
        ],
        edges: [
          { id: "e1", source: "hook", target: "note" },
          { id: "e2", source: "note", target: "guard" },
          { id: "e3", source: "guard", sourceHandle: "pass", target: "pass" },
          { id: "e4", source: "guard", sourceHandle: "blocked", target: "blocked" }
        ]
      }
    });
    expect(created.ok()).toBeTruthy();
    expect((await page.request.put(`/api/guard/bindings/workflows/${workflowId}`, { data: { mode: "override", profileId } })).ok()).toBeTruthy();

    // Security → Profiles: one switch, off by default.
    await sidebarItem(page, "Security").click();
    await page.getByRole("tab", { name: "Profiles & bindings" }).click();
    await page.getByRole("complementary", { name: "Guard profiles" }).getByRole("button", { name: new RegExp(profile.name) }).click();
    const tracking = page.getByRole("switch", { name: "Track where data came from" });
    await expect(tracking).not.toBeChecked();
    await tracking.check();
    await page.getByRole("button", { name: "Save new version" }).click();
    await expect
      .poll(async () => ((await (await page.request.get(`/api/guard/profiles/${profileId}`)).json()) as { latest?: { document?: { labels?: string } } }).latest?.document?.labels, {
        timeout: 30_000
      })
      .toBe("propagated");

    const run = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: { user_prompt: "Write to someone@example.com please" } });
    expect(run.ok()).toBeTruthy();
    const { executionId } = (await run.json()) as { executionId: string };

    // Runs: the run's trace says where each step's data came from and what it holds.
    await sidebarItem(page, "Runs").click();
    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    const row = page.locator(".executions-table tbody tr.execution-row", { hasText: executionId.slice(0, 8) }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const noteChips = page.locator(".execution-trace-node", { hasText: "note" }).locator(".data-label-chips");
    await expect(noteChips).toHaveAttribute("aria-label", "Data labels: from a person · contains email", { timeout: 30_000 });
  });

  test("an enforced release gate holds a case added later until an admin admits it", async ({ page }) => {
    await openStudio(page);
    const stamp = Date.now();
    const workflowId = `wf-e2e-admission-${stamp}`;
    const workflow = {
      id: workflowId,
      name: `E2E Admission ${stamp}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [
        { id: "hook", type: "webhook_input", name: "Hook", position: { x: 80, y: 180 }, config: { path: `e2e-admission-${stamp}`, method: "POST" } },
        { id: "out", type: "output", name: "Output", position: { x: 380, y: 180 }, config: { responseTemplate: "ok", outputKey: "result" } }
      ],
      edges: [{ id: "edge-1", source: "hook", target: "out" }]
    };
    expect((await page.request.post("/api/workflows", { data: workflow })).ok()).toBeTruthy();
    const goldenRun = async (name: string) => {
      const run = await page.request.post(`/api/workflows/${workflowId}/execute`, { data: { record: true } });
      expect(run.ok(), await run.text()).toBeTruthy();
      const saved = await page.request.post("/api/replay/recordings", { data: { executionId: (await run.json()).executionId, name } });
      expect(saved.ok(), await saved.text()).toBeTruthy();
      return (await saved.json()).recording.id as string;
    };
    const created = await page.request.post("/api/eval/datasets", { data: { name: `Admission suite ${stamp}`, workflowId } });
    const setId = (await created.json()).dataset.id as string;
    expect((await page.request.post(`/api/eval/datasets/${setId}/recordings`, { data: { recordingId: await goldenRun("Counted case") } })).ok()).toBeTruthy();
    const gate = await page.request.put(`/api/workflows/${workflowId}/release-gate`, { data: { enabled: true, enforced: true, datasetIds: [setId] } });
    expect(gate.ok(), await gate.text()).toBeTruthy();
    // Added after the gate was enforced: it waits for admission.
    expect((await page.request.post(`/api/eval/datasets/${setId}/recordings`, { data: { recordingId: await goldenRun("Late case") } })).ok()).toBeTruthy();

    await page.reload();
    await sidebarItem(page, "Evaluations").click();
    await page.getByRole("tab", { name: "Release gates" }).click();
    await page.getByRole("tabpanel", { name: "Release gates" }).getByLabel("Workflow", { exact: true }).selectOption(workflowId);
    const cases = page.locator("section.gate-cases-card");
    await expect(cases.getByRole("status").filter({ hasText: "waiting for admin admission" })).toHaveText(
      "1 new case waiting for admin admission. It runs but doesn't count yet."
    );
    await expect(cases.getByText("waiting for admission", { exact: true })).toBeVisible();
    await cases.getByRole("button", { name: "Admit Late case" }).click();
    await expect(cases.getByText('"Late case" now counts.')).toBeVisible();
    await expect(cases.getByText(/waiting for admin admission/)).toHaveCount(0);
    await expect(cases.getByText("2 admitted · 0 required")).toBeVisible();

    // The toggle follows the server: it turns on once the gate saved it.
    await cases.getByLabel("Counted case is required").click();
    await expect(cases.getByLabel("Counted case is required")).toBeChecked();
    await expect(cases.getByText("required", { exact: true })).toBeVisible();

    // Adding a golden set to the enforced gate admits nothing unless the admin confirms it.
    const extra = await page.request.post("/api/eval/datasets", { data: { name: `Extra suite ${stamp}`, workflowId } });
    const extraId = (await extra.json()).dataset.id as string;
    expect((await page.request.post(`/api/eval/datasets/${extraId}/recordings`, { data: { recordingId: await goldenRun("Extra case") } })).ok()).toBeTruthy();
    await page.reload();
    await sidebarItem(page, "Evaluations").click();
    await page.getByRole("tab", { name: "Release gates" }).click();
    await page.getByRole("tabpanel", { name: "Release gates" }).getByLabel("Workflow", { exact: true }).selectOption(workflowId);
    await page.getByLabel(new RegExp(`Extra suite ${stamp}`)).check();
    const admitAdded = page.getByLabel("Admit 1 case from the added set?");
    await expect(admitAdded).not.toBeChecked();
    await admitAdded.check();
    await page.getByRole("button", { name: "Save gate" }).click();
    await expect(page.getByText("Gate saved.")).toBeVisible();
    await expect(cases.getByText("3 admitted · 1 required")).toBeVisible();
    await expect(cases.getByText(/waiting for admin admission/)).toHaveCount(0);
  });
});
