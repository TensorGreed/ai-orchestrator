import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 12.7 — red-team benchmark: an admin runs the corpus through the built-in
 * rule set on Security > Benchmark and sees the totals, the category table
 * and the trend; then benchmarks an unsaved draft of their own rule set from
 * the rule set editor and sees it compared with the rule set's stored result.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const profileId = `e2e-bench-${stamp}`;
const profileName = `E2E benchmark ${stamp}`;

async function shot(name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
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

test.beforeAll(async ({ browser }) => {
  await signIn(browser);
  const created = await page.request.post("/api/guard/profiles", {
    data: {
      document: {
        id: profileId,
        name: profileName,
        version: "1",
        channels: { prompt: { detectors: [{ id: "injection.direct", threshold: 0.5 }], defaultAction: { action: "allow" }, actions: { prompt_injection: { action: "block" } } } }
      }
    }
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const stored = await page.request.post(`/api/guard/profiles/${profileId}/benchmark`, { data: {} });
  expect(stored.ok(), await stored.text()).toBeTruthy();
});

test.afterAll(async () => {
  await page.request.delete(`/api/guard/profiles/${profileId}`);
  await context.close();
});

test("runs the default rule set's benchmark on Security > Benchmark", async () => {
  await page.locator("aside.app-sidebar").getByRole("button", { name: "Security", exact: true }).click();
  await page.getByRole("tab", { name: "Benchmark" }).click();
  await page.getByLabel("Rule set").selectOption("default");
  await page.getByRole("button", { name: "Run benchmark" }).click();
  await expect(page.getByRole("status").filter({ hasText: /stored benchmark/ })).toBeVisible({ timeout: 30_000 });
  const totals = page.getByLabel("Benchmark totals");
  await expect(totals.getByText("Detected · main")).toBeVisible();
  await expect(totals.getByText("Detected · held-out")).toBeVisible();
  await expect(page.getByRole("rowheader", { name: /Path traversal/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "Benchmark history" }).getByRole("row").nth(1)).toBeVisible();
  await shot("guard-benchmark-tab");
});

test("benchmarks an unsaved draft from the rule set editor", async () => {
  await page.getByRole("tab", { name: "Rule sets & bindings" }).click();
  await page.getByRole("complementary", { name: "Rule sets" }).getByRole("button", { name: new RegExp(profileName) }).click();
  await page.getByRole("button", { name: "Benchmark this draft" }).click();
  const card = page.getByTestId("guard-bench-draft");
  await expect(card).toContainText("Detects", { timeout: 30_000 });
  await expect(card).toContainText("The draft was not saved and its result is not stored.");
  await expect(card).toContainText("No regression against the last stored benchmark (v1).");
  await shot("guard-benchmark-draft");
});
