import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 12.4 — an admin adds an argument-aware "Needs approval" rule from the Policies view, tests a call with
 * arguments against it, and sees the gateway approvals section. The rule is removed at the end.
 *
 * Then least privilege from real runs: a gateway client calls two tools, the admin simulates a draft rule, asks for
 * suggestions, previews one, accepts it in shadow mode and enforces it. Everything it made is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

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

test("adds an argument-aware approval rule and tests a call against it", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const name = `E2E big sums ${Date.now()}`;
  try {
    await page.locator("aside.app-sidebar").getByRole("button", { name: "Policies", exact: true }).click();
    await page.getByRole("button", { name: "+ Add rule" }).click();
    const form = page.getByRole("form", { name: "Add tool policy rule" });
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("combobox", { name: "Effect", exact: true }).selectOption("require_approval");
    await form.getByRole("combobox", { name: "Server", exact: true }).selectOption("mock-mcp");
    await form.getByLabel("Tool name or pattern").fill("calculator");
    await form.getByRole("button", { name: "+ Add condition" }).click();
    await form.getByLabel("Condition 1 argument path").fill("expression");
    await form.getByRole("combobox", { name: "Condition 1 operator" }).selectOption("starts_with");
    await form.getByLabel("Condition 1 value").fill("1000");
    await form.getByRole("button", { name: "Add rule" }).click();

    const rules = page.getByRole("list", { name: "Tool policy rules" });
    const rule = rules.getByRole("listitem").filter({ hasText: name });
    await expect(rule.getByText("Needs approval")).toBeVisible();
    await expect(rule.getByText('expression starts with "1000"')).toBeVisible();

    const tester = page.getByRole("form", { name: "Test a tool against the policy" });
    await tester.getByRole("combobox", { name: "Role", exact: true }).selectOption("builder");
    await tester.getByRole("combobox", { name: "Server", exact: true }).selectOption("mock-mcp");
    await tester.getByLabel("Tool", { exact: true }).fill("calculator");
    await tester.getByLabel("Arguments (JSON, optional)").fill('{"expression": "1000*3"}');
    await tester.getByRole("button", { name: "Check" }).click();
    const result = page.getByRole("status").filter({ hasText: "Matched:" });
    await expect(result.getByText(/needs approval by policy/)).toBeVisible();
    await expect(result.getByText(`Matched: needs approval ${name} (when expression starts with "1000")`)).toBeVisible();

    await tester.getByLabel("Arguments (JSON, optional)").fill('{"expression": "2+2"}');
    await tester.getByRole("button", { name: "Check" }).click();
    await expect(page.getByRole("status").getByText("Allowed", { exact: true })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Gateway approvals" })).toBeVisible();
    await expect(page.getByText("Nothing is waiting for approval.")).toBeVisible();
  } finally {
    const listed = await page.request.get("/api/mcp/policies");
    if (listed.ok()) {
      const { rules } = (await listed.json()) as { rules: Array<{ id: string; name: string | null }> };
      for (const entry of rules.filter((candidate) => candidate.name === name)) {
        await page.request.delete(`/api/mcp/policies/${encodeURIComponent(entry.id)}`);
      }
    }
  }
});

test("suggests least-privilege rules from a client's calls, previews, accepts in shadow and enforces them", async ({ page }) => {
  test.setTimeout(180_000);
  await openStudio(page);
  const stamp = Date.now();
  const clientName = `E2E least privilege ${stamp}`;
  let serverId: string | null = null;
  let toolsetId: string | null = null;
  let clientId: string | null = null;
  try {
    // A registered mock server, a toolset with it, and an operator client that calls two of its tools 20 times.
    const server = await page.request.post("/api/mcp/servers", { data: { name: `E2E LP tools ${stamp}`, adapterId: "mock-mcp", probeEnabled: false } });
    expect(server.ok()).toBeTruthy();
    serverId = ((await server.json()) as { server: { id: string } }).server.id;
    expect((await page.request.post(`/api/mcp/servers/${serverId}/probe`)).ok()).toBeTruthy();
    const toolset = await page.request.post("/api/mcp/toolsets", {
      data: { name: `E2E LP toolset ${stamp}`, projectId: "default", members: [{ kind: "server", serverId }] }
    });
    expect(toolset.ok()).toBeTruthy();
    const { toolset: created } = (await toolset.json()) as { toolset: { id: string; slug: string } };
    toolsetId = created.id;
    const client = await page.request.post("/api/mcp/clients", { data: { name: clientName, toolsetIds: [toolsetId], role: "operator" } });
    expect(client.ok()).toBeTruthy();
    const issued = (await client.json()) as { client: { id: string }; token: string };
    clientId = issued.client.id;

    const headers = { authorization: `Bearer ${issued.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await page.request.post(`${API_URL}/mcp/${created.slug}`, {
      headers,
      data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } }
    });
    expect(init.ok()).toBeTruthy();
    const session = { ...headers, "mcp-session-id": init.headers()["mcp-session-id"]! };
    const listed = await page.request.post(`${API_URL}/mcp/${created.slug}`, { headers: session, data: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    const timeTool = names.find((name) => name.endsWith("get_current_time"))!;
    const calcTool = names.find((name) => name.endsWith("calculator"))!;
    for (let index = 0; index < 20; index += 1) {
      const call =
        index % 2 === 0
          ? { name: timeTool, arguments: { tz: index % 4 === 0 ? "UTC" : "Asia/Tokyo" } }
          : { name: calcTool, arguments: { expression: `${index}+1` } };
      const response = await page.request.post(`${API_URL}/mcp/${created.slug}`, {
        headers: session,
        data: { jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: call }
      });
      expect(response.ok()).toBeTruthy();
    }

    await page.locator("aside.app-sidebar").getByRole("button", { name: "Policies", exact: true }).click();

    // Simulate a draft rule from the editor without saving it.
    await page.getByRole("button", { name: "+ Add rule" }).click();
    const form = page.getByRole("form", { name: "Add tool policy rule" });
    await form.getByRole("combobox", { name: "Server", exact: true }).selectOption(serverId);
    await form.getByLabel("Tool name or pattern").fill("calculator");
    await form.getByRole("button", { name: "What would this have done in the last 7 days?" }).click();
    const report = form.getByLabel("Simulation result");
    await expect(report.getByRole("button", { name: /Newly denied/ })).toBeVisible();
    await expect(report.getByText(clientName)).toBeVisible();
    await form.getByRole("button", { name: "Cancel" }).click();

    const panel = page.getByRole("region", { name: "Rule suggestions" });
    await panel.getByRole("button", { name: "Suggest rules" }).click();
    await expect(panel.getByRole("status")).toContainText("calls from the last 30 days");
    const suggestion = panel.getByRole("listitem", { name: `Suggestion for Gateway client ${clientName}` });
    const proposed = suggestion.getByRole("list", { name: "Suggested rules" });
    await expect(proposed.getByText("every other tool")).toBeVisible();
    await expect(proposed.getByText("get_current_time", { exact: true })).toBeVisible();
    await expect(proposed.getByText("calculator", { exact: true })).toBeVisible();

    await suggestion.getByRole("button", { name: "Preview impact" }).click();
    await expect(suggestion.getByLabel("Simulation result")).toBeVisible();
    await suggestion.getByRole("button", { name: "Accept in shadow mode" }).click();

    const accepted = panel.getByRole("listitem", { name: `Accepted suggestion for Gateway client ${clientName}` });
    await expect(accepted.getByText("In shadow", { exact: true })).toBeVisible();
    const rules = page.getByRole("list", { name: "Tool policy rules" });
    const shadowRules = rules.getByRole("listitem").filter({ hasText: clientName });
    await expect(shadowRules).toHaveCount(3);
    await expect(shadowRules.getByText("Shadow", { exact: true })).toHaveCount(3);

    page.once("dialog", (dialog) => void dialog.accept());
    await accepted.getByRole("button", { name: /Enforce/ }).click();
    await expect(accepted).toHaveCount(0);
    await expect(shadowRules.getByText("Shadow", { exact: true })).toHaveCount(0);
  } finally {
    const listed = await page.request.get("/api/mcp/policies");
    if (listed.ok() && clientId) {
      const { rules } = (await listed.json()) as { rules: Array<{ id: string; clientIds?: string[] }> };
      for (const entry of rules.filter((candidate) => candidate.clientIds?.includes(clientId!))) {
        await page.request.delete(`/api/mcp/policies/${encodeURIComponent(entry.id)}`);
      }
    }
    if (clientId) await page.request.post(`/api/mcp/clients/${clientId}/revoke`);
    if (toolsetId) await page.request.delete(`/api/mcp/toolsets/${toolsetId}`);
    if (serverId) await page.request.delete(`/api/mcp/servers/${serverId}`);
  }
});
