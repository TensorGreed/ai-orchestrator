import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Your integrations: an API added from its OpenAPI spec (served by this test on 127.0.0.1) shows its operations in the
 * palette; one becomes an HTTP Request node with a form, and its run sends the request with the secret in the header
 * the spec names. A registered MCP server's tools show as `<server> · <tool>`; one becomes an MCP Tool node with an
 * arguments form, and its run calls the tool. No model is called; a request to a local model server fails the test.
 * Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOTS = process.env.E2E_SHOTS_DIR ?? "test-results";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.resolve(here, "../../api/src/fixtures/openapi/tickets.openapi.yaml"), "utf8");

const modelServerHits: string[] = [];
const received: Array<{ method: string; url: string; key: string | undefined; body: string }> = [];
let server: Server;
let base = "";

test.beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/openapi.yaml") {
        response.writeHead(200, { "content-type": "application/yaml" });
        response.end(fixture.replace("http://127.0.0.1:1/api", `${base}/api`));
        return;
      }
      if (request.url?.startsWith("/api/")) {
        received.push({ method: request.method ?? "", url: request.url, key: request.headers["x-api-key"] as string | undefined, body });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "T-1", created: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function openStudio(page: Page): Promise<void> {
  await page.context().route(/:11434\//, async (route) => {
    modelServerHits.push(route.request().url());
    await route.abort();
  });
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
}

async function createWorkflow(page: Page, id: string): Promise<void> {
  const response = await page.request.post("/api/workflows", {
    data: {
      id,
      name: `E2E Integrations ${id}`,
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      nodes: [{ id: "start", type: "webhook_input", name: "Start", position: { x: 0, y: 0 }, config: { path: `${id}-in` } }],
      edges: []
    }
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/?workflowId=${encodeURIComponent(id)}&mode=editor`);
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
  const debug = page.getByRole("button", { name: "Debug mode: ON" });
  if (await debug.isVisible()) await debug.click();
}

function canvasNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: page.locator(".wf-card-name", { hasText: label }) });
}

async function save(page: Page): Promise<void> {
  const saved = page.waitForResponse((response) => response.url().includes("/api/workflows") && response.request().method() === "POST");
  await page.getByRole("banner").getByRole("button", { name: /^Save/ }).click();
  expect((await saved).status()).toBe(200);
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("your integrations in the palette", () => {
  test.setTimeout(150_000);

  test.afterEach(() => {
    expect(modelServerHits).toEqual([]);
  });

  test("an API added from its OpenAPI spec becomes palette nodes with a form, and runs with its secret", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-catalog-api-${Date.now()}`;
    let specId: string | null = null;
    let secretId: string | null = null;
    try {
      await createWorkflow(page, id);
      const secret = await page.request.post("/api/secrets", { data: { name: `desk-key-${Date.now()}`, provider: "custom", value: "desk-e2e-key" } });
      expect(secret.ok(), await secret.text()).toBeTruthy();
      secretId = ((await secret.json()) as { id: string }).id;
      await openEditor(page, id);

      await page.getByRole("button", { name: "Add node" }).click();
      const palette = page.getByRole("dialog", { name: "Add a node" });
      await palette.getByRole("button", { name: "Add an API…" }).click();
      const dialog = page.getByRole("dialog", { name: "Your integrations" });
      await dialog.getByLabel("Spec URL").fill(`${base}/openapi.yaml`);
      await dialog.getByRole("button", { name: "Add API" }).click();
      await expect(dialog.getByRole("status")).toContainText("Added Ticket Desk: 3 operations in the palette.");
      await page.screenshot({ path: `${SHOTS}/catalog-add-api.png` });
      await dialog.getByRole("button", { name: "Close" }).click();
      const specs = (await (await page.request.get("/api/catalog/openapi-specs")).json()) as { specs: Array<{ id: string; name: string }> };
      specId = specs.specs.find((spec) => spec.name === "Ticket Desk")?.id ?? null;

      await canvasNode(page, "Start").click();
      await page.getByRole("button", { name: "Add node" }).click();
      await page.getByRole("textbox", { name: "Search nodes" }).fill("create a ticket");
      await expect(palette.getByRole("option").first()).toContainText("Ticket Desk · Create a ticket");
      await expect(palette.getByRole("option").first()).toContainText("Best match");
      await page.screenshot({ path: `${SHOTS}/catalog-palette-search.png` });
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();

      await canvasNode(page, "Ticket Desk · Create a ticket").dblclick();
      const form = page.getByTestId("openapi-operation-form");
      await expect(form).toContainText("POST /tickets");
      await form.getByLabel("title").fill("{{ user_prompt }}");
      await form.getByLabel("priority").fill("3");
      await page.getByRole("combobox", { name: "Key secret" }).selectOption(secretId!);
      await expect(page.getByText("Sent in the X-API-Key header.", { exact: true })).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/catalog-operation-form.png` });
      await page.getByRole("button", { name: "Save changes" }).click();
      await save(page);

      const before = received.length;
      const run = await page.request.post(`/api/workflows/${id}/execute`, { data: { user_prompt: "Printer jam" } });
      expect(run.ok(), await run.text()).toBeTruthy();
      expect(((await run.json()) as { status: string }).status).toBe("success");
      const sent = received.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: "POST", url: "/api/tickets", key: "desk-e2e-key" });
      expect(JSON.parse(sent[0]!.body)).toEqual({ title: "Printer jam", priority: 3 });
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
      if (specId) await page.request.delete(`/api/catalog/openapi-specs/${specId}`);
      if (secretId) await page.request.delete(`/api/secrets/${secretId}`);
    }
  });

  test("a registered MCP server's tools become palette nodes with an arguments form", async ({ page }) => {
    await openStudio(page);
    const id = `wf-e2e-catalog-mcp-${Date.now()}`;
    let serverId: string | null = null;
    try {
      await createWorkflow(page, id);
      const created = await page.request.post("/api/mcp/servers", { data: { name: "E2E tools", adapterId: "mock-mcp", probeEnabled: false } });
      expect(created.ok(), await created.text()).toBeTruthy();
      serverId = ((await created.json()) as { server: { id: string } }).server.id;
      expect((await page.request.post(`/api/mcp/servers/${serverId}/probe`)).ok()).toBeTruthy();
      await openEditor(page, id);

      await canvasNode(page, "Start").click();
      await page.getByRole("button", { name: "Add node" }).click();
      const palette = page.getByRole("dialog", { name: "Add a node" });
      await page.getByRole("textbox", { name: "Search nodes" }).fill("calculator");
      await expect(palette.getByRole("option").first()).toContainText("E2E tools · calculator");
      await expect(palette.getByRole("region", { name: "Your integrations" }).or(palette.getByLabel("Your integrations")).first()).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(palette).toBeHidden();

      await canvasNode(page, "E2E tools · calculator").dblclick();
      const form = page.getByTestId("mcp-args-form");
      await expect(form).toBeVisible();
      await form.getByLabel("expression").fill("{{ user_prompt }}");
      await page.screenshot({ path: `${SHOTS}/catalog-mcp-form.png` });
      await page.getByRole("button", { name: "Save changes" }).click();
      await save(page);

      const run = await page.request.post(`/api/workflows/${id}/execute`, { data: { user_prompt: "6*7" } });
      expect(run.ok(), await run.text()).toBeTruthy();
      const result = (await run.json()) as { status: string };
      expect(result.status).toBe("success");
      expect(JSON.stringify(result)).toContain("42");
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
      if (serverId) await page.request.delete(`/api/mcp/servers/${serverId}`);
    }
  });
});
