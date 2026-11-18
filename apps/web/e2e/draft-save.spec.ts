import { expect, test, type Page } from "@playwright/test";

/**
 * Drafts and run feedback in the editor: a workflow saves without an Output node and with unfinished node settings
 * (listed above the canvas), opening a workflow shows its latest run, "Webhook run" asks for a test payload and keeps
 * it, the webhook's direct API URL names the API's port, "New workflow" saves nothing until the first edit, and a Loop
 * run gives no duplicate React key. No model is called. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";

const position = (x: number) => ({ x, y: 180 });

/** Fails the test if the page (or a model listing it asks for) tries to reach a local Ollama. */
async function guardLocalModels(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.route(/:11434\//, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
  });
  await page.route("**/api/providers/**", async (route) => {
    const body = route.request().postData() ?? "";
    if (/11434|"ollama"/i.test(body)) {
      attempts.push(`${route.request().url()} ${body.slice(0, 120)}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
  return attempts;
}

async function signIn(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
}

function hookFlow(id: string, extraNodes: unknown[] = [], extraEdges: unknown[] = []) {
  return {
    id,
    name: `E2E Draft ${id}`,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "hook", type: "webhook_input", name: "Orders hook", position: position(100), config: { path: `${id}-orders`, method: "POST" } },
      { id: "line", type: "set_node", name: "Order line", position: position(400), config: { assignments: [{ key: "line", valueTemplate: "order for {{webhook.customer}}" }] } },
      ...extraNodes
    ],
    edges: [{ id: "e1", source: "hook", target: "line" }, ...extraEdges]
  };
}

test.describe("editor drafts and run feedback", () => {
  test.setTimeout(150_000);

  test("saves a draft without an Output node and lists what it still lacks", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const id = `wf-e2e-draft-${Date.now()}`;
    try {
      const draft = hookFlow(id, [{ id: "post", type: "http_request", name: "Post order", position: position(700), config: { method: "POST" } }], [
        { id: "e2", source: "line", target: "post" }
      ]);
      expect((await page.request.post("/api/workflows", { data: draft })).ok()).toBeTruthy();
      await openEditor(page, id);

      const notice = page.getByTestId("draft-warnings");
      await expect(notice).toContainText("Unfinished draft");
      await expect(notice).toContainText("HTTP Request node requires a non-empty urlTemplate.");
      // Nothing is published, so production would run this draft: its live triggers are paused.
      await expect(notice.getByTestId("live-triggers-paused")).toContainText("Live triggers");

      const saved = page.waitForResponse((response) => response.url().includes(`/api/workflows`) && response.request().method() === "POST");
      await page.getByRole("banner").getByRole("button", { name: /^Save/ }).click();
      expect((await saved).status()).toBe(200);
      await expect(page.locator(".error-banner")).toHaveCount(0);
      await expect(notice).toContainText("No Output node");

      await notice.getByRole("button", { name: "Post order" }).click();
      await expect(page.getByRole("complementary").or(page.locator(".insp")).first()).toBeVisible();
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });

  test("shows the latest run when a workflow is opened, and runs a webhook with its test payload", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const id = `wf-e2e-hook-${Date.now()}`;
    try {
      expect((await page.request.post("/api/workflows", { data: hookFlow(id) })).ok()).toBeTruthy();
      const run = await page.request.post(`/api/workflows/${id}/execute`, { data: {} });
      expect(run.ok()).toBeTruthy();

      await openEditor(page, id);
      await expect(page.locator(".hud-run-status .hud-run-label")).toContainText("last run", { timeout: 15_000 });
      await expect(page.getByRole("option", { name: "No run loaded" })).toHaveCount(0);

      await page.getByRole("button", { name: "Webhook run" }).click();
      const dialog = page.getByRole("dialog", { name: "Webhook run" });
      const field = dialog.getByLabel("Test payload (JSON)");
      await expect(field).toHaveValue("{}");
      await field.fill('{"customer": "Ana", "api_key": "sk-test"}');
      await dialog.getByRole("button", { name: "Run" }).click();
      await expect(dialog.getByRole("alert")).toContainText("cannot hold credentials");

      await field.fill('{"customer": "Ana"}');
      const sent = page.waitForRequest((request) => request.url().includes("/api/webhooks/execute/stream"));
      await dialog.getByRole("button", { name: "Run" }).click();
      expect((await sent).postDataJSON()).toMatchObject({ workflow_id: id, payload: { customer: "Ana" } });
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".hud-run-status .hud-run-label")).toContainText("ok", { timeout: 30_000 });

      const latest = (await (await page.request.get(`/api/executions?workflowId=${id}&page=1&pageSize=1`)).json()) as { items: Array<{ id: string }> };
      const detail = await (await page.request.get(`/api/executions/${latest.items[0]!.id}`)).text();
      expect(detail).toContain("order for Ana");

      const stored = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { settings?: { testWebhookPayload?: unknown } };
      expect(stored.settings?.testWebhookPayload).toEqual({ customer: "Ana" });
      await page.reload();
      await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("button", { name: "Webhook run" }).click();
      await expect(page.getByRole("dialog", { name: "Webhook run" }).getByLabel("Test payload (JSON)")).toHaveValue(
        JSON.stringify({ customer: "Ana" }, null, 2)
      );
      await page.keyboard.press("Escape");
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });

  test("names the API's real port in the webhook's direct URL", async ({ page }) => {
    await guardLocalModels(page);
    await signIn(page);
    const id = `wf-e2e-url-${Date.now()}`;
    try {
      expect((await page.request.post("/api/workflows", { data: hookFlow(id) })).ok()).toBeTruthy();
      await openEditor(page, id);
      await page.locator(".react-flow__node").filter({ hasText: "Orders hook" }).first().dblclick();
      const tip = page.locator(".cfg-tip").filter({ hasText: "Production URL" });
      await expect(tip).toBeVisible();
      const apiPort = new URL(API_URL).port || "80";
      const appPort = new URL(page.url()).port;
      if (apiPort !== appPort) {
        await expect(tip).toContainText(`:${apiPort}/webhook/${id}-orders`);
      }
      if (apiPort !== "4000") await expect(tip).not.toContainText(":4000/");
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });

  test("New workflow saves nothing until the first edit", async ({ page }) => {
    await guardLocalModels(page);
    await signIn(page);
    const count = async () => {
      const response = await page.request.get("/api/workflows?page=1&pageSize=200");
      const body = (await response.json()) as { total?: number; items?: unknown[] } | unknown[];
      return Array.isArray(body) ? body.length : (body.total ?? body.items?.length ?? 0);
    };
    const before = await count();
    await page.goto("/?mode=dashboard");
    await page.getByRole("button", { name: "New workflow" }).first().click();
    const name = page.getByLabel("Workflow name");
    await expect(name).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await count()).toBe(before);

    const created = `E2E new workflow ${Date.now()}`;
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/workflows") && response.request().method() === "POST");
    await name.fill(created);
    expect((await saved).status()).toBe(200);
    await expect.poll(count).toBe(before + 1);
    const list = (await (await page.request.get("/api/workflows?page=1&pageSize=200")).json()) as { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
    const items = Array.isArray(list) ? list : (list.items ?? []);
    const mine = items.find((item) => item.name.startsWith("E2E new workflow"));
    if (mine) await page.request.delete(`/api/workflows/${mine.id}`);
  });

  test("a Loop run lists each pass without a duplicate React key", async ({ page }) => {
    await guardLocalModels(page);
    const keyWarnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && message.text().includes("same key")) keyWarnings.push(message.text().slice(0, 200));
    });
    await signIn(page);
    const id = `wf-e2e-loop-${Date.now()}`;
    try {
      const loop = {
        id,
        name: `E2E Loop ${id}`,
        schemaVersion: "1.0.0",
        workflowVersion: 1,
        nodes: [
          { id: "items", type: "set_node", name: "Items", position: position(100), config: { assignments: [{ key: "rows", valueTemplate: '["a","b","c"]' }] } },
          { id: "loop", type: "loop_node", name: "Loop", position: position(400), config: { inputKey: "rows", itemVariable: "row" } },
          { id: "each", type: "set_node", name: "Each row", position: position(700), config: { assignments: [{ key: "seen", valueTemplate: "{{row}}" }] } }
        ],
        edges: [
          { id: "e1", source: "items", target: "loop" },
          { id: "e2", source: "loop", target: "each" }
        ]
      };
      expect((await page.request.post("/api/workflows", { data: loop })).ok()).toBeTruthy();
      await openEditor(page, id);
      await page.getByRole("banner").getByRole("button", { name: "Run workflow" }).click();
      await expect(page.locator(".hud-run-status .hud-run-label")).toContainText("last run", { timeout: 30_000 });
      await page.getByRole("tab", { name: "Logs" }).click();
      await expect(page.locator(".node-status-item").first()).toBeVisible();
      // The body node is listed once per pass.
      await expect.poll(async () => page.locator(".node-status-item").filter({ hasText: "Each row" }).count()).toBe(3);
      expect(keyWarnings).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });
});
