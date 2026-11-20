import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startMockOAuthProvider, type MockOAuthProvider } from "../../api/src/fixtures/mock-oauth-provider";

/**
 * Connected accounts, end to end against a local mock provider (never a real one): an admin sets up the Slack app on
 * the Secrets page, connects in a popup, picks the account in an HTTP Request node's Auth, and runs it; the token is
 * renewed after the provider stops accepting it and on Refresh; a refused refresh shows Needs reconnect and Reconnect
 * fixes it; Disconnect revokes and removes it.
 *
 * Needs the API started with CONNECTED_ACCOUNTS_TEST_PROVIDER_URL=http://127.0.0.1:<E2E_MOCK_OAUTH_PORT> and
 * APP_PUBLIC_URL set to the web origin; skipped otherwise. A request to a local model server fails the test.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const MOCK_PORT = process.env.E2E_MOCK_OAUTH_PORT;
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "connected-accounts");

const modelServerHits: string[] = [];
let mock: MockOAuthProvider | undefined;

test.skip(!MOCK_PORT, "set E2E_MOCK_OAUTH_PORT (and point the API's CONNECTED_ACCOUNTS_TEST_PROVIDER_URL at it)");

test.beforeAll(async () => {
  if (MOCK_PORT) mock = await startMockOAuthProvider({ port: Number(MOCK_PORT) });
});

test.afterAll(async () => {
  await mock?.close();
});

function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

async function openSecrets(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
  await sidebarItem(page, "Secrets").click();
  await expect(page.getByRole("article", { name: "Connected accounts" })).toBeVisible();
}

async function accountId(page: Page): Promise<string | undefined> {
  const listed = (await (await page.request.get("/api/secrets?projectId=default")).json()) as Array<{ id: string; provider: string }>;
  return listed.find((secret) => secret.provider === "oauth_account")?.id;
}

test.describe("connected accounts", () => {
  test.setTimeout(240_000);

  test("set up, connect, use from HTTP Request, renew, reconnect and disconnect", async ({ page }) => {
    await page.context().route(/:11434(\/|$)/, async (route) => {
      modelServerHits.push(route.request().url());
      await route.abort();
    });
    await expect
      .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
      .toBeTruthy();
    const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(login.ok()).toBeTruthy();
    await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
    page.on("dialog", (dialog) => void dialog.accept());

    const workflowId = `wf-e2e-connected-${Date.now()}`;
    try {
      // 1. Set up the Slack app: the exact redirect URL is shown to copy.
      await openSecrets(page);
      const slack = page.getByTestId("connect-provider-slack");
      await slack.getByRole("button", { name: "Set up app" }).click();
      await expect(slack.getByLabel("Redirect URL")).toHaveValue(/\/api\/connect\/callback$/);
      const scope = slack.getByLabel("Use this app for");
      if (await scope.isVisible()) await scope.selectOption("instance");
      await slack.getByLabel("Client ID").fill("l2m-test-client");
      await slack.getByLabel("Client secret").fill("l2m-test-secret");
      await page.screenshot({ path: path.join(SHOT_DIR, "connect-01-app-setup.png"), fullPage: true });
      await slack.getByRole("button", { name: "Save app" }).click();
      await expect(slack.getByText("App set up for all projects")).toBeVisible();

      // 2. Connect in a popup; the popup closes itself and the account shows.
      const popupPromise = page.waitForEvent("popup");
      await slack.getByRole("button", { name: "Connect Slack" }).click();
      const popup = await popupPromise;
      await popup.waitForEvent("close", { timeout: 30_000 });
      const row = page.locator(".connected-account").filter({ hasText: "Slack · Mock Workspace" });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText("Connected", { exact: true })).toBeVisible();
      await expect(row.getByText(/Token renews automatically · expires in/)).toBeVisible();
      await expect(row.getByText("Scopes: chat:write, chat:write.public")).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "connect-02-connected.png"), fullPage: true });
      const secretId = await accountId(page);
      expect(secretId).toBeTruthy();
      // Nothing the browser can read carries a token.
      expect(JSON.stringify(await (await page.request.get("/api/secrets?projectId=default")).json())).not.toMatch(/at-slack-|rt-slack-/);

      // 3. Use it from an HTTP Request node.
      const created = await page.request.post("/api/workflows", {
        data: {
          id: workflowId,
          name: `E2E Connected ${workflowId}`,
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "start", type: "webhook_input", name: "Start", position: { x: 0, y: 0 }, config: { path: `${workflowId}-in` } },
            {
              id: "whoami",
              type: "http_request",
              name: "Who am I",
              position: { x: 280, y: 0 },
              config: { method: "GET", urlTemplate: `${mock!.url}/resource/whoami`, secretRef: { secretId }, secretAuth: { type: "connected" }, failOnHttpError: true }
            }
          ],
          edges: [{ id: "e1", source: "start", target: "whoami" }]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
      await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
      await page.locator(".react-flow__node").filter({ hasText: "Who am I" }).dblclick();
      await expect(page.getByLabel("Auth")).toHaveValue("connected");
      await expect(page.getByLabel(/^Account/)).toHaveValue(secretId!);
      await expect(page.getByLabel(/^Account/).locator("option", { hasText: "+ Connect Slack…" })).toHaveCount(1);
      await page.screenshot({ path: path.join(SHOT_DIR, "connect-03-http-auth.png"), fullPage: true });

      const execute = async () => (await (await page.request.post(`/api/workflows/${workflowId}/execute`, { data: {} })).json()) as { status: string };
      expect((await execute()).status).toBe("success");

      // 4. The provider stops accepting the token: the run renews it once and succeeds.
      const refreshesBefore = mock!.stats.refreshes;
      mock!.control({ expireAccess: true });
      expect((await execute()).status).toBe("success");
      expect(mock!.stats.refreshes).toBe(refreshesBefore + 1);

      // 5. Refresh on the Secrets page.
      await openSecrets(page);
      await row.getByRole("button", { name: "Refresh" }).click();
      await expect(page.getByText("Slack · Mock Workspace: token renewed.")).toBeVisible();
      expect(mock!.stats.refreshes).toBe(refreshesBefore + 2);

      // 6. A refused refresh asks for a reconnect; Reconnect fixes it and keeps the secret.
      mock!.control({ refuseRefresh: true });
      await row.getByRole("button", { name: "Refresh" }).click();
      await expect(row.getByText("Needs reconnect", { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, "connect-04-needs-reconnect.png"), fullPage: true });
      mock!.control({ refuseRefresh: false });
      const reconnectPopup = page.waitForEvent("popup");
      await row.getByRole("button", { name: "Reconnect" }).click();
      await (await reconnectPopup).waitForEvent("close", { timeout: 30_000 });
      await expect(row.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(await accountId(page)).toBe(secretId);
      expect((await execute()).status).toBe("success");

      // 7. Disconnect revokes at the provider and removes the account.
      const revocations = mock!.stats.revocations;
      await row.getByRole("button", { name: "Disconnect" }).click();
      await expect(page.getByText("Slack · Mock Workspace disconnected and revoked.")).toBeVisible();
      await expect(row).toHaveCount(0);
      expect(mock!.stats.revocations).toBe(revocations + 1);
      expect(await accountId(page)).toBeUndefined();
      expect(modelServerHits).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
      const leftover = await accountId(page);
      if (leftover) await page.request.delete(`/api/connect/accounts/${leftover}`);
      await page.request.delete("/api/connect/providers/slack/app");
    }
  });
});
