import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 12.4 — an admin adds an argument-aware "Needs approval" rule from the Policies view, tests a call with
 * arguments against it, and sees the gateway approvals section. The rule is removed at the end.
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
