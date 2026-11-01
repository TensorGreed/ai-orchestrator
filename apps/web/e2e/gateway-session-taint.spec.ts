import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 12.2 — gateway session taint: an admin turns on "Track outside content per session" on a toolset, a client's call
 * returns outside content, its next write is held for approval under the safety preset, and the client's Sessions
 * panel shows the session's labels. The suite signs in once and shares the browser context across its tests.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;
const PRESET_RULE = "mtp_preset_untrusted_write_approval";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const made: { serverId?: string; toolsetId?: string; toolsetSlug?: string; toolsetName?: string; clientId?: string; clientName?: string; token?: string; presetAdded?: boolean; approvalId?: string } = {};

async function shot(name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

function sidebarItem(label: string) {
  return page.locator("aside.app-sidebar").getByRole("button", { name: label, exact: true });
}

async function signIn(browser: Browser): Promise<void> {
  context = await browser.newContext();
  page = await context.newPage();
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

async function gatewayCall(request: APIRequestContext, sessionId: string, id: number, method: string, params?: Record<string, unknown>) {
  const response = await request.post(`${API_URL}/mcp/${made.toolsetSlug}`, {
    headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    data: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as {
    result?: { tools?: Array<{ name: string }>; isError?: boolean };
    error?: { code: number; message: string; data?: { approvalRequestId?: string } };
  };
}

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  const request = page.request;
  made.toolsetName = `E2E tracked toolset ${stamp}`;
  made.clientName = `E2E tracked client ${stamp}`;
  const server = await request.post("/api/mcp/servers", { data: { name: `E2E taint tools ${stamp}`, adapterId: "mock-mcp", probeEnabled: false } });
  expect(server.ok()).toBeTruthy();
  made.serverId = ((await server.json()) as { server: { id: string } }).server.id;
  expect((await request.post(`/api/mcp/servers/${made.serverId}/probe`)).ok()).toBeTruthy();
  const toolset = await request.post("/api/mcp/toolsets", { data: { name: made.toolsetName, projectId: "default", members: [{ kind: "server", serverId: made.serverId }] } });
  expect(toolset.ok()).toBeTruthy();
  const created = ((await toolset.json()) as { toolset: { id: string; slug: string } }).toolset;
  made.toolsetId = created.id;
  made.toolsetSlug = created.slug;
  const client = await request.post("/api/mcp/clients", { data: { name: made.clientName, toolsetIds: [made.toolsetId], role: "builder" } });
  expect(client.ok()).toBeTruthy();
  const issued = (await client.json()) as { client: { id: string }; token: string };
  made.clientId = issued.client.id;
  made.token = issued.token;
  const preset = await request.post("/api/mcp/policies/presets/untrusted_write_approval");
  if (preset.status() === 201) made.presetAdded = true;
  else expect(preset.status()).toBe(409);
  expect((await request.post(`/api/mcp/policies/${PRESET_RULE}/enforce`)).status()).toBeLessThan(500);
});

test.afterAll(async () => {
  const request = page.request;
  // Leave no request waiting in the admins' inbox for the other specs.
  if (made.approvalId) await request.post(`/api/mcp/gateway/approvals/${made.approvalId}/reject`, { data: { reason: "e2e cleanup" } });
  if (made.presetAdded) await request.delete(`/api/mcp/policies/${PRESET_RULE}`);
  if (made.clientId) await request.post(`/api/mcp/clients/${made.clientId}/revoke`);
  if (made.toolsetId) await request.delete(`/api/mcp/toolsets/${made.toolsetId}`);
  if (made.serverId) await request.delete(`/api/mcp/servers/${made.serverId}`);
  await context.close();
});

test("turns on Track outside content per session in the toolset form", async () => {
  await page.reload();
  await sidebarItem("Toolsets").click();
  await page.getByRole("button", { name: made.toolsetName! }).click();
  await expect(page.getByTestId("toolset-session-tracking")).toHaveText(/not tracked/);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: "Edit toolset" });
  const toggle = form.getByRole("checkbox", { name: "Track outside content per session" });
  await expect(toggle).not.toBeChecked();
  await expect(form.getByText(/later calls in the same session are checked as carrying it/)).toBeVisible();
  await toggle.check();
  await toggle.scrollIntoViewIfNeeded();
  await shot("01-toolset-switch");
  await form.getByRole("button", { name: "Save toolset" }).click();
  await expect(page.getByTestId("toolset-session-tracking")).toHaveText(/tracked per session/);
  const saved = await page.request.get(`/api/mcp/toolsets/${made.toolsetId}`);
  expect(((await saved.json()) as { toolset: { trackSessionLabels: boolean } }).toolset.trackSessionLabels).toBe(true);
});

test("holds a write after outside content, and shows the session's labels as chips", async () => {
  const request = page.request;
  const init = await request.post(`${API_URL}/mcp/${made.toolsetSlug}`, {
    headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-agent", version: "1" } } }
  });
  expect(init.ok()).toBeTruthy();
  const sessionId = init.headers()["mcp-session-id"]!;
  const names = (await gatewayCall(request, sessionId, 2, "tools/list")).result!.tools!.map((tool) => tool.name);
  const timeTool = names.find((name) => name.endsWith("get_current_time"))!;
  const calcTool = names.find((name) => name.endsWith("calculator"))!;
  // The first write is the client's own request: it goes through.
  expect((await gatewayCall(request, sessionId, 3, "tools/call", { name: calcTool, arguments: { expression: "1+1" } })).result?.isError).toBeFalsy();
  expect((await gatewayCall(request, sessionId, 4, "tools/call", { name: timeTool, arguments: {} })).result?.isError).toBeFalsy();
  const held = await gatewayCall(request, sessionId, 5, "tools/call", { name: calcTool, arguments: { expression: "6*7" }, _meta: { dataLabels: { provenance: ["trusted"] } } });
  expect(held.error?.code).toBe(-32030);
  expect(held.error?.message).toMatch(/Approval pending/);
  made.approvalId = held.error?.data?.approvalRequestId;

  await page.reload();
  await sidebarItem("Clients").click();
  const list = page.getByRole("list", { name: "MCP clients" });
  const row = list.getByRole("listitem").filter({ hasText: made.clientName! });
  await row.getByRole("button", { name: "Sessions" }).click();
  const sessions = row.getByRole("list", { name: "Open sessions" });
  const entry = sessions.getByRole("listitem").filter({ hasText: sessionId.slice(0, 8) });
  await expect(entry.getByText("from outside", { exact: true })).toBeVisible();
  await expect(entry.getByText("e2e-agent")).toBeVisible();
  await entry.scrollIntoViewIfNeeded();
  await shot("02-session-labels");
});

test("explains in the rule editor that gateway labels need the toolset switch", async () => {
  await page.reload();
  await sidebarItem("Policies").click();
  await page.getByRole("button", { name: "+ Add rule" }).click();
  const form = page.getByRole("form", { name: "Add tool policy rule" });
  await form.getByRole("button", { name: "+ Add condition" }).click();
  const op = form.getByLabel("Condition 1 operator");
  await op.selectOption("label_present");
  await expect(form.getByText(/carry data labels only on toolsets with “Track outside content per session” on/)).toBeVisible();
  await shot("03-rule-editor-note");
  await form.getByRole("button", { name: "Cancel" }).click();
});
