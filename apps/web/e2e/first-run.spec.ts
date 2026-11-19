import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * A new user's first run, walked as the quickstart page writes it: sign in with the admin account from `.env`, the
 * welcome window's "Run a starter", a starter's "Use Template", "Run workflow", then a node's data. Every label the
 * walk uses is checked against the page's own words, so the doc and the studio cannot drift apart. Also: Home lists the
 * starters first, and the Featured template runs without setup. No model is called; what it makes is removed.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "first-run");
const QUICKSTART = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs/docs/getting-started/quickstart.md");

/** The quickstart's "Sign in and run your first workflow" section. */
function quickstartSteps(): string {
  const text = fs.readFileSync(QUICKSTART, "utf8");
  const start = text.indexOf("## Sign in and run your first workflow");
  expect(start, "the quickstart has a first-run section").toBeGreaterThan(-1);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end === -1 ? undefined : end);
}

/** Fails the test if the page tries to reach a local Ollama. */
async function guardLocalModels(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.context().route(/:11434(\/|$)/, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
  });
  return attempts;
}

async function apiUp(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
}

async function workflowIds(page: Page): Promise<Set<string>> {
  const listed = await page.request.get("/api/workflows");
  if (!listed.ok()) return new Set();
  const body = (await listed.json()) as Array<{ id: string }> | { items?: Array<{ id: string }> };
  return new Set((Array.isArray(body) ? body : (body.items ?? [])).map((row) => row.id));
}

async function removeNew(page: Page, before: Set<string>): Promise<void> {
  for (const id of await workflowIds(page)) if (!before.has(id)) await page.request.delete(`/api/workflows/${id}`);
}

test("the quickstart's first run, word for word", async ({ page }) => {
  test.setTimeout(180_000);
  const ollama = await guardLocalModels(page);
  const steps = quickstartSteps();
  /** A label the walk clicks or reads, as the doc writes it in bold. */
  const label = (text: string) => {
    expect(steps, `the quickstart names **${text}**`).toContain(`**${text}**`);
    return text;
  };
  expect(steps).toContain("BOOTSTRAP_ADMIN_EMAIL");
  expect(steps).toContain("BOOTSTRAP_ADMIN_PASSWORD");
  expect(steps).toContain(`\`${ADMIN_EMAIL}\``);
  expect(steps).toContain(`\`${ADMIN_PASSWORD}\``);
  await apiUp(page);
  let before = new Set<string>();

  try {
    // 1. Sign in with the admin account from .env. (A new browser: the welcome window has not been dismissed.)
    await page.goto("/");
    await page.getByLabel(label("Email")).fill(ADMIN_EMAIL);
    await page.getByLabel(label("Password")).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: label("Sign in"), exact: true }).click();
    before = await workflowIds(page);

    // 2. The welcome window: Run a starter.
    const welcome = page.getByRole("dialog", { name: label("Welcome to L2M") });
    await expect(welcome).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "first-run-01-welcome.png") });
    await welcome.getByRole("button", { name: new RegExp(label("Run a starter")) }).click();

    // 3. Templates opens on the Starters; Use Template on the CSV starter.
    await expect(page.getByRole("heading", { name: label("Templates"), exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: label("Starters"), exact: true })).toHaveAttribute("aria-pressed", "true");
    const csv = page.locator(".tpl-card").filter({ has: page.locator(".tpl-card-name", { hasText: label("CSV to JSON: parse, sort and total") }) });
    await expect(csv.locator(".tpl-dep-pill-none")).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "first-run-02-starters.png") });
    await csv.getByRole("button", { name: label("Use Template") }).click();
    await expect(page.getByLabel("Workflow name")).toHaveValue("CSV to JSON: parse, sort and total (from template)", { timeout: 60_000 });

    // 4. Run workflow: the status reads "last run … N ok".
    await page.getByRole("button", { name: label("Run workflow"), exact: true }).click();
    const status = page.locator(".hud-run-status .hud-run-label");
    await expect(status).toContainText(label("last run"), { timeout: 30_000 });
    await expect(status).toHaveText(new RegExp(` \\d+ ${label("ok")}$`));
    await page.screenshot({ path: path.join(SHOT_DIR, "first-run-03-ran.png") });

    // 5. Double-click a node to see its data.
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.locator(".react-flow__node").filter({ hasText: label("Units per region") }).first().dblclick();
    const inspector = page.getByRole("dialog", { name: /^Inspect / });
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("North");
    await page.screenshot({ path: path.join(SHOT_DIR, "first-run-04-node-data.png") });
    await page.keyboard.press("Escape");

    // The closing line: Home lists the same Starters first, with Use; Describe it… and New workflow are there too.
    await page.goto("/?mode=dashboard");
    const row = page.getByTestId("home-starters");
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.getByRole("heading", { name: label("Starters") })).toBeVisible();
    await expect(row.getByRole("button", { name: new RegExp(`^${label("Use")} starter `) }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: label("New workflow") })).toBeVisible();
    expect(steps).toContain(`**${label("Home")}**`);
    expect(steps).toContain(`**${label("Describe it…")}**`);
    expect(steps).toContain(`**${label("Secrets")}**`);
    expect(ollama).toEqual([]);
  } finally {
    await removeNew(page, before);
  }
});

test.describe("Home and the gallery for a new user", () => {
  test.beforeEach(async ({ page }) => {
    await apiUp(page);
    const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(login.ok()).toBeTruthy();
    await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  });

  test("Home lists the starters before the workflows, and Use opens a new workflow from one", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    const before = await workflowIds(page);
    try {
      await page.goto("/?mode=dashboard");
      const row = page.getByTestId("home-starters");
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row.locator(".home-starter-card")).toHaveCount(4);
      // First on the page: above the search, folders and workflow cards.
      const rowTop = (await row.boundingBox())!.y;
      const searchTop = (await page.getByLabel("Search workflows").boundingBox())!.y;
      expect(rowTop).toBeLessThan(searchTop);
      await page.screenshot({ path: path.join(SHOT_DIR, "home-starters.png") });

      await row.getByRole("button", { name: "Use starter Loop over items and collect" }).click();
      await expect(page.getByLabel("Workflow name")).toHaveValue("Loop over items and collect (from template)", { timeout: 60_000 });
      await page.getByRole("button", { name: "Run workflow", exact: true }).click();
      await expect(page.locator(".hud-run-status .hud-run-label")).toHaveText(/ \d+ ok$/, { timeout: 30_000 });

      await page.goto("/?mode=dashboard");
      await page.getByTestId("home-starters").getByRole("button", { name: /^All \d+ starters$/ }).click();
      await expect(page.getByRole("button", { name: "Starters", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(".tpl-card")).toHaveCount(10);
      expect(ollama).toEqual([]);
    } finally {
      await removeNew(page, before);
    }
  });

  test("the Featured template runs without setup", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    const before = await workflowIds(page);
    try {
      await page.goto("/?mode=templates");
      const featured = page.locator(".tpl-card-featured").first();
      await expect(featured).toBeVisible({ timeout: 60_000 });
      await expect(featured.locator(".tpl-dep-pill-none")).toHaveText("Runs without setup");
      await expect(featured.locator("[data-testid^='tpl-needs-model-']")).toHaveCount(0);
      const name = (await featured.locator(".tpl-card-name").innerText()).trim();
      await featured.getByRole("button", { name: "Use Template" }).click();
      await expect(page.getByLabel("Workflow name")).toHaveValue(`${name} (from template)`, { timeout: 60_000 });
      await page.getByRole("button", { name: "Run workflow", exact: true }).click();
      await expect(page.locator(".hud-run-status .hud-run-label")).toHaveText(/ \d+ ok$/, { timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, "featured-ran.png") });
      expect(ollama).toEqual([]);
    } finally {
      await removeNew(page, before);
    }
  });
});
