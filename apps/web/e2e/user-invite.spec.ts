import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Roadmap 7.3 — an admin invites a user through the API, the invitee opens the link in a fresh browser, chooses a
 * password and lands in the studio; the link then no longer works. Lists answer with the page envelope when asked.
 * The invited user is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "user-invite");

test.describe("user invites", () => {
  test.setTimeout(120_000);

  test("an invitee sets a password from the link and is signed in", async ({ page, browser }) => {
    await expect
      .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
      .toBeTruthy();
    const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(login.ok()).toBeTruthy();

    const email = `invitee-${Date.now()}@example.com`;
    const invited = await page.request.post("/api/users/invite", { data: { email, role: "builder" } });
    expect(invited.status()).toBe(201);
    const body = (await invited.json()) as { user: { id: string }; inviteUrl?: string; emailed: boolean };
    expect(body.emailed).toBe(false);
    expect(body.inviteUrl).toBeTruthy();
    const link = new URL(body.inviteUrl!);

    try {
      const users = (await (await page.request.get("/api/users?page=1&pageSize=100")).json()) as { items: Array<{ id: string; pending?: boolean }>; total: number };
      expect(users.items.find((user) => user.id === body.user.id)?.pending).toBe(true);

      const invitee = await browser.newContext();
      try {
        const invitePage = await invitee.newPage();
        await invitePage.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
        await invitePage.goto(`/${link.search}`);
        await expect(invitePage.getByText(email)).toBeVisible();
        await expect.poll(() => new URL(invitePage.url()).searchParams.has("invite")).toBe(false);
        await invitePage.screenshot({ path: path.join(SHOT_DIR, "accept-invite.png") });
        await invitePage.getByLabel("Password", { exact: true }).fill("Invitee-Pass-123");
        await invitePage.getByLabel("Confirm password").fill("Invitee-Pass-123");
        await invitePage.getByRole("button", { name: "Set password and sign in" }).click();
        await expect(invitePage.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
        const me = (await (await invitePage.request.get("/api/auth/me")).json()) as { user: { email: string; role: string } };
        expect(me.user).toMatchObject({ email, role: "builder" });

        const reused = await invitee.newPage();
        const again = await reused.request.post("/api/auth/invite/lookup", { data: { token: link.searchParams.get("invite") } });
        expect(again.status()).toBe(404);
      } finally {
        await invitee.close();
      }
    } finally {
      await page.request.delete(`/api/users/${body.user.id}`);
    }
  });
});
