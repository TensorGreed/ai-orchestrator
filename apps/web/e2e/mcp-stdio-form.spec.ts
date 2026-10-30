import { expect, test, type Page } from "@playwright/test";

/**
 * An admin registers a local (stdio) MCP server from the form's own fields, sees the host note, switches transport
 * and edits the same connection as JSON. The server is deleted at the end.
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

test("registers a local command MCP server from the stdio fields", async ({ page }) => {
  test.setTimeout(120_000);
  await openStudio(page);
  const name = `E2E stdio ${Date.now()}`;
  try {
    await page.locator("aside.app-sidebar").getByRole("button", { name: "Servers", exact: true }).click();
    await page.getByRole("button", { name: "+ Register server" }).click();
    const form = page.getByRole("form", { name: "Register MCP server" });
    await form.getByLabel("Name", { exact: true }).fill(name);

    await expect(form.getByLabel("Endpoint URL")).toBeVisible();
    await form.getByLabel("Local command (stdio)").check();
    await expect(form.getByLabel("Endpoint URL")).toHaveCount(0);
    await expect(form.getByText(/runs on the machine running the L2M API/)).toBeVisible();

    await form.getByLabel("Paste a command line").fill(`node -e "setTimeout(() => {}, 1000)" "two words"`);
    await form.getByRole("button", { name: "Fill command and arguments" }).click();
    await expect(form.getByLabel("Command", { exact: true })).toHaveValue("node");
    await expect(form.getByLabel("Argument 3", { exact: true })).toHaveValue("two words");

    await form.getByText("Advanced: edit as JSON").click();
    const json = form.getByLabel("Connection (JSON)");
    await expect(json).toHaveValue(/"two words"/);
    await form.getByRole("button", { name: "Move argument 3 up" }).click();
    await expect(json).toHaveValue(/"two words",\s+"setTimeout/);

    await form.getByRole("button", { name: "Register server" }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    const listed = await page.request.get("/api/mcp/servers");
    const server = ((await listed.json()) as { servers: Array<{ id: string; name: string; adapterId: string; connection: { command: string; args: string[] } }> }).servers.find(
      (entry) => entry.name === name
    );
    expect(server?.adapterId).toBe("stdio_mcp");
    expect(server?.connection.command).toBe("node");
    expect(server?.connection.args).toContain("two words");
  } finally {
    const listed = await page.request.get("/api/mcp/servers");
    if (listed.ok()) {
      for (const entry of ((await listed.json()) as { servers: Array<{ id: string; name: string }> }).servers) {
        if (entry.name === name) await page.request.delete(`/api/mcp/servers/${encodeURIComponent(entry.id)}`);
      }
    }
  }
});
