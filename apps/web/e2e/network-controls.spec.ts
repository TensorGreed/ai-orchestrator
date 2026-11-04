import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 13.2 — network controls in the studio: Settings > Access control > Network shows the deployment's lists read-only
 * with this browser's address, and an MCP client's Network panel sets its address list. A call from outside the
 * client's list is refused with a JSON-RPC 403; once the address is listed it is accepted. The suite signs in once
 * and shares the browser context across its tests.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const made: { toolsetId?: string; toolsetSlug?: string; clientId?: string; clientName?: string; token?: string } = {};

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

async function initialize(): Promise<{ status: number; body: { error?: { code: number; message: string } } }> {
  const response = await page.request.post(`${API_URL}/mcp/${made.toolsetSlug}`, {
    headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-network", version: "1" } } }
  });
  return { status: response.status(), body: (await response.json()) as { error?: { code: number; message: string } } };
}

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  const request = page.request;
  made.clientName = `E2E network client ${stamp}`;
  const toolset = await request.post("/api/mcp/toolsets", { data: { name: `E2E network toolset ${stamp}`, projectId: "default" } });
  expect(toolset.ok()).toBeTruthy();
  const created = ((await toolset.json()) as { toolset: { id: string; slug: string } }).toolset;
  made.toolsetId = created.id;
  made.toolsetSlug = created.slug;
  const client = await request.post("/api/mcp/clients", { data: { name: made.clientName, toolsetIds: [made.toolsetId], role: "viewer" } });
  expect(client.ok()).toBeTruthy();
  const issued = (await client.json()) as { client: { id: string }; token: string };
  made.clientId = issued.client.id;
  made.token = issued.token;
});

test.afterAll(async () => {
  const request = page.request;
  if (made.clientId) await request.post(`/api/mcp/clients/${made.clientId}/revoke`);
  if (made.toolsetId) await request.delete(`/api/mcp/toolsets/${made.toolsetId}`);
  await context.close();
});

test("shows the deployment's network lists read-only with this browser's address", async () => {
  await page.locator("button.hud-account").click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  await page.getByRole("tab", { name: "Network", exact: true }).click();
  const section = page.getByRole("region", { name: "Network" });
  await expect(section.getByTestId("network-your-ip")).toContainText("Your address is");
  await expect(section.getByTestId("network-mode")).toBeVisible();
  const scopes = section.getByRole("table", { name: "Network scopes" });
  for (const env of ["NETWORK_ALLOW_UI", "NETWORK_ALLOW_API", "NETWORK_ALLOW_WEBHOOK", "NETWORK_ALLOW_PUBLIC", "NETWORK_ALLOW_MCP_GATEWAY", "NETWORK_ALLOW_METRICS"]) {
    await expect(scopes.getByText(env, { exact: true })).toBeVisible();
  }
  await expect(section.getByRole("table", { name: "Network settings" })).toContainText("NETWORK_BREAK_GLASS_CIDRS");
  // Read-only: nothing to save here.
  await expect(section.getByRole("button")).toHaveCount(0);
  await shot("01-settings-network");
});

test("limits a client to its addresses from the client's Network panel", async () => {
  expect((await initialize()).status).toBe(200);

  await sidebarItem("Clients").click();
  const row = page.getByRole("list", { name: "MCP clients" }).getByRole("listitem").filter({ hasText: made.clientName! });
  await expect(row.getByTestId("client-network-summary")).toHaveText("any address");
  await row.getByRole("button", { name: "Network" }).click();
  const panel = row.getByRole("form", { name: "Client network" });
  const addresses = panel.getByLabel("Allowed addresses");
  page.once("dialog", (dialog) => void dialog.accept());
  await addresses.fill("not-an-address");
  await panel.getByRole("button", { name: "Save network settings" }).click();
  await expect(panel.getByText("'not-an-address' is not an IP address or CIDR range")).toBeVisible();

  // An address range this browser's requests do not come from: the client's calls are refused.
  await addresses.fill("198.51.100.0/24");
  await panel.getByRole("button", { name: "Save network settings" }).click();
  await expect(panel.getByRole("status")).toHaveText("Saved");
  await expect(row.getByTestId("client-network-summary")).toHaveText("1 address range");
  await shot("02-client-network-panel");
  const refused = await initialize();
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatchObject({ code: -32001, message: "Access from this address is not allowed" });

  // Loopback in both families (the test talks to the API on this host): accepted again.
  await addresses.fill("127.0.0.0/8\n::1");
  await panel.getByRole("button", { name: "Save network settings" }).click();
  await expect(row.getByTestId("client-network-summary")).toHaveText("2 address ranges");
  expect((await initialize()).status).toBe(200);
  const listed = (await (await page.request.get("/api/mcp/clients")).json()) as { clients: Array<{ id: string; allowedIps: string[] }> };
  expect(listed.clients.find((client) => client.id === made.clientId)?.allowedIps).toEqual(["127.0.0.0/8", "::1/128"]);
});
