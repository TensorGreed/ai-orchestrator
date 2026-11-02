import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 12.6 — budgets and rate limits on the MCP gateway: an admin sets a toolset's default rate limit in its detail and
 * a client's own limit in its Governance section, the client's calls over it are refused with retryLater, an admin
 * creates a budget for the client in Settings, FinOps, and the client's Governance shows the budget's usage; a
 * used-up block budget refuses the client's calls. The suite signs in once and shares the browser context.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const made: {
  serverId?: string;
  toolsetId?: string;
  toolsetSlug?: string;
  toolsetName?: string;
  clientId?: string;
  clientName?: string;
  token?: string;
  sessionId?: string;
  toolName?: string;
  budgetId?: string;
} = {};
let rpcId = 1;

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

type RpcBody = { result?: { tools?: Array<{ name: string }>; isError?: boolean }; error?: { code: number; message: string; data?: Record<string, unknown> } };

async function gatewayCall(request: APIRequestContext, method: string, params?: Record<string, unknown>): Promise<RpcBody> {
  const response = await request.post(`${API_URL}/mcp/${made.toolsetSlug}`, {
    headers: {
      authorization: `Bearer ${made.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(made.sessionId ? { "mcp-session-id": made.sessionId } : {})
    },
    data: { jsonrpc: "2.0", id: (rpcId += 1), method, ...(params ? { params } : {}) }
  });
  expect(response.ok()).toBeTruthy();
  if (!made.sessionId) made.sessionId = response.headers()["mcp-session-id"];
  return (await response.json()) as RpcBody;
}

const calculate = (request: APIRequestContext) => gatewayCall(request, "tools/call", { name: made.toolName, arguments: { expression: "6*7" } });

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  const request = page.request;
  made.toolsetName = `E2E limited toolset ${stamp}`;
  made.clientName = `E2E limited client ${stamp}`;
  const server = await request.post("/api/mcp/servers", { data: {
      name: `E2E limit tools ${stamp}`,
      adapterId: "mock-mcp",
      probeEnabled: false,
      // Sampling through the built-in echo model: the client's usage a budget counts.
      sampling: { allow: true, maxTokens: 200, allowedModels: [], defaultModel: { providerId: "echo", model: "echo-1" } }
    }
  });
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
  await gatewayCall(request, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e-limits-agent", version: "1" } });
  made.toolName = (await gatewayCall(request, "tools/list")).result!.tools!.map((tool) => tool.name).find((name) => name.endsWith("__calculator"));
  expect(made.toolName).toBeTruthy();
});

test.afterAll(async () => {
  const request = page.request;
  if (made.budgetId) await request.delete(`/api/budgets/${made.budgetId}`);
  if (made.clientId) await request.post(`/api/mcp/clients/${made.clientId}/revoke`);
  if (made.toolsetId) await request.delete(`/api/mcp/toolsets/${made.toolsetId}`);
  if (made.serverId) await request.delete(`/api/mcp/servers/${made.serverId}`);
  await context.close();
});

test("sets a toolset's default rate limit in its detail", async () => {
  await page.reload();
  await sidebarItem("Toolsets").click();
  await page.getByRole("button", { name: made.toolsetName! }).click();
  const section = page.getByTestId("gateway-rate-limit-toolset");
  await expect(section.getByText(/unless the client has its own limit/)).toBeVisible();
  await section.getByLabel("Calls at once").fill("4");
  await section.getByRole("button", { name: "Save" }).click();
  await expect(section.getByText("Saved")).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot("01-toolset-default-rate-limit");
  const listed = (await (await page.request.get("/api/mcp/toolsets")).json()) as { toolsets: Array<{ id: string; rateLimit: unknown }> };
  expect(listed.toolsets.find((toolset) => toolset.id === made.toolsetId)?.rateLimit).toEqual({ requestsPerMinute: null, burst: null, maxConcurrent: 4 });
});

test("sets the client's own rate limit in Governance, and refuses its calls over it with retryLater", async () => {
  await page.reload();
  await sidebarItem("Clients").click();
  const row = page.getByRole("list", { name: "MCP clients" }).getByRole("listitem").filter({ hasText: made.clientName! });
  await row.getByRole("button", { name: "Governance" }).click();
  const governance = row.getByRole("region", { name: "Client governance" });
  const limits = governance.getByTestId("gateway-rate-limit-client");
  await limits.getByLabel("Calls per minute").fill("2");
  await limits.getByRole("button", { name: "Save" }).click();
  await expect(limits.getByText("Saved")).toBeVisible();
  await expect(governance.getByText("No budget for this client.")).toBeVisible();
  await governance.scrollIntoViewIfNeeded();
  await shot("02-client-governance-rate-limit");

  const request = page.request;
  expect((await calculate(request)).result?.isError).toBeFalsy();
  expect((await calculate(request)).result?.isError).toBeFalsy();
  const refused = await calculate(request);
  expect(refused.error).toMatchObject({ code: -32029, data: { reason: "rate_limited" } });
  expect(refused.error?.message).toContain("2 calls per minute");
  // Lift the limit again for the budget test.
  await limits.getByLabel("Calls per minute").fill("");
  await limits.getByRole("button", { name: "Save" }).click();
  await expect(limits.getByText("Saved")).toBeVisible();
});

test("creates a budget for the client in Settings, shows its usage in Governance, and a used-up one refuses calls", async () => {
  await page.reload();
  await sidebarItem("Settings").click();
  await page.getByRole("tab", { name: "FinOps", exact: true }).click();
  await page.getByRole("button", { name: "+ New budget" }).click();
  const form = page.locator("form.finops-create-form");
  // The form's labels wrap their controls, so a select's name includes its options: find the label by its start.
  const field = (label: string) => form.locator("label").filter({ hasText: new RegExp(`^${label}`) }).locator("select, input").first();
  await field("Name").fill(`E2E client cap ${stamp}`);
  await field("Scope").selectOption("mcp_client");
  await field("Client").selectOption(made.clientId!);
  // A cap of one token, which the client's sampling below uses up.
  await field("Limit type").selectOption("tokens");
  await field("Limit value").fill("1");
  await field("Action").selectOption("block");
  await form.scrollIntoViewIfNeeded();
  await shot("03-settings-client-budget-form");
  await form.getByRole("button", { name: "Create budget" }).click();
  await expect(page.getByText(`MCP client: ${made.clientName}`)).toBeVisible();
  const budgets = (await (await page.request.get("/api/budgets")).json()) as { budgets: Array<{ id: string; name: string }> };
  made.budgetId = budgets.budgets.find((budget) => budget.name === `E2E client cap ${stamp}`)?.id;
  expect(made.budgetId).toBeTruthy();
  await shot("04-settings-client-budget-listed");

  // The client's server tool asks the model (sampling): its tokens count toward the budget.
  const request = page.request;
  const summary = await gatewayCall(request, "tools/call", { name: made.toolName!.replace(/__calculator$/, "__summarize_with_model"), arguments: { text: "Budgets cap what a client spends." } });
  expect(summary.result?.isError).toBeFalsy();
  // Used up: the client's next call is refused before it reaches the server.
  await expect.poll(async () => (await calculate(request)).error?.code, { timeout: 10_000 }).toBe(-32032);
  await page.reload();
  await sidebarItem("Clients").click();
  const row = page.getByRole("list", { name: "MCP clients" }).getByRole("listitem").filter({ hasText: made.clientName! });
  await row.getByRole("button", { name: "Governance" }).click();
  const box = row.getByTestId("gateway-client-budgets");
  await expect(box.getByText(`E2E client cap ${stamp}`)).toBeVisible();
  await expect(box).toContainText("this month");
  await expect(box).toContainText("blocks calls when used up");
  await expect(box).toContainText("(100%)");
  await box.scrollIntoViewIfNeeded();
  await shot("05-client-governance-budget");
});
