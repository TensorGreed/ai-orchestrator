import { expect, test, type Browser } from "@playwright/test";

/**
 * Passwords in the studio: an admin sets a temporary password for a user from Settings > Users (shown once); the user
 * signs in with it and changes it under Settings > Security. The user is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

async function signedInPage(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  const login = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(login.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
  return { context, page };
}

async function openSettings(page: import("@playwright/test").Page, tab: string) {
  await page.locator("button.hud-account").click();
  await page.getByRole("menuitem", { name: "Account settings" }).click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

test.describe("passwords", () => {
  test.setTimeout(120_000);

  test("an admin sets a temporary password; the user signs in with it and changes it", async ({ browser, request }) => {
    await expect
      .poll(async () => (await request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
      .toBeTruthy();
    const admin = await signedInPage(browser, ADMIN_EMAIL, ADMIN_PASSWORD);
    const email = `pw-${Date.now()}@example.com`;
    const created = await admin.page.request.post("/api/auth/register", { data: { email, password: "First-pass-123", role: "viewer" } });
    expect(created.ok()).toBeTruthy();
    const userId = ((await created.json()) as { user: { id: string } }).user.id;

    try {
      await openSettings(admin.page, "Users");
      admin.page.once("dialog", (dialog) => void dialog.accept());
      await admin.page.getByRole("button", { name: `Set a temporary password for ${email}` }).click();
      const shown = admin.page.locator("code.temporary-password");
      await expect(shown).toBeVisible();
      const temporary = (await shown.textContent())!.trim();
      expect(temporary).toMatch(/^[A-Za-z0-9_-]{24}$/);

      const user = await signedInPage(browser, email, temporary);
      try {
        await openSettings(user.page, "Security");
        await user.page.getByLabel("Current password").fill(temporary);
        await user.page.getByLabel(/^New password/).fill("Own-pass-word-456");
        await user.page.getByLabel("Confirm the new password").fill("Own-pass-word-456");
        await user.page.getByRole("button", { name: "Change password" }).click();
        await expect(user.page.getByText(/^Password changed\./)).toBeVisible();
      } finally {
        await user.context.close();
      }
      const fresh = await browser.newContext();
      try {
        expect((await fresh.request.post("/api/auth/login", { data: { email, password: temporary } })).status()).toBe(401);
        expect((await fresh.request.post("/api/auth/login", { data: { email, password: "Own-pass-word-456" } })).ok()).toBeTruthy();
      } finally {
        await fresh.close();
      }
    } finally {
      await admin.page.request.delete(`/api/users/${userId}`);
      await admin.context.close();
    }
  });
});
