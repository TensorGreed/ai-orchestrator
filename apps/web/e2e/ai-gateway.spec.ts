import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * 12.6b — the /v1 AI gateway: an admin creates a route set and a route on the AI routes page, grants the set to a
 * client on its Governance, the client calls /v1/chat/completions with its token (JSON and a stream) against an
 * in-process OpenAI-compatible upstream on 127.0.0.1, and the page's usage counts the requests. The suite signs in
 * once and shares the browser context.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let upstream: http.Server;
let upstreamUrl = "";
const stamp = Date.now();
const alias = `e2e-chat-${stamp}`;
const setName = `E2E apps ${stamp}`;
const made: { setId?: string; clientId?: string; clientName?: string; token?: string } = {};

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

/** An OpenAI-compatible upstream: one JSON answer, or a short stream. */
async function startUpstream(): Promise<void> {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += String(part)));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const content of ["Hello ", "from the stream."]) {
          res.write(`data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "u", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "u",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from upstream." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        })
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
}

test.beforeAll(async ({ browser }) => {
  await startUpstream();
  await signIn(browser);
  made.clientName = `E2E app client ${stamp}`;
  // A client with no toolset: it only calls /v1.
  const client = await page.request.post("/api/mcp/clients", { data: { name: made.clientName, toolsetIds: [], role: "builder" } });
  expect(client.ok()).toBeTruthy();
  const created = (await client.json()) as { client: { id: string }; token: string };
  made.clientId = created.client.id;
  made.token = created.token;
});

test.afterAll(async () => {
  if (made.setId) await page.request.delete(`/api/ai-gateway/route-sets/${made.setId}`);
  if (made.clientId) await page.request.post(`/api/mcp/clients/${made.clientId}/revoke`);
  await context?.close();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
});

test("an admin creates a route set and a route on the AI routes page", async () => {
  await sidebarItem("AI routes").click();
  await expect(page.getByRole("heading", { name: "AI routes", level: 2 })).toBeVisible();
  await expect(page.getByTestId("ai-gateway-endpoint")).toContainText("/v1");
  await page.getByRole("button", { name: "+ New route set" }).click();
  const form = page.getByRole("form", { name: "New route set" });
  await form.getByLabel("Name").fill(setName);
  await form.getByRole("button", { name: "Create route set" }).click();
  const card = page.getByRole("article", { name: `Route set ${setName}` });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "+ Add route" }).click();
  const routeForm = card.getByRole("form", { name: "New route" });
  await routeForm.getByLabel("Model name").fill(alias);
  await routeForm.getByRole("combobox", { name: /^Provider/ }).selectOption("openai_compatible");
  await routeForm.getByLabel("Upstream model").fill("upstream-model");
  await routeForm.getByLabel("Base URL (optional)").fill(upstreamUrl);
  await routeForm.getByRole("button", { name: "Add route" }).click();
  await expect(card.getByTestId("ai-route-row")).toContainText(alias);
  const sets = (await (await page.request.get("/api/ai-gateway/route-sets")).json()) as { routeSets: Array<{ id: string; name: string }> };
  made.setId = sets.routeSets.find((entry) => entry.name === setName)?.id;
  expect(made.setId).toBeTruthy();
  await shot("ai-routes-page");
});

test("the client sees no models until the set is granted on its Governance", async () => {
  const before = await page.request.get(`${API_URL}/v1/models`, { headers: { authorization: `Bearer ${made.token}` } });
  expect(before.status()).toBe(200);
  expect(((await before.json()) as { data: unknown[] }).data).toEqual([]);
  await sidebarItem("Clients").click();
  const row = page.getByRole("list", { name: "MCP clients" }).getByRole("listitem").filter({ hasText: made.clientName! });
  await row.getByRole("button", { name: "Governance" }).click();
  const grants = page.getByTestId("gateway-client-ai-grants");
  await grants.getByRole("checkbox", { name: new RegExp(setName) }).check();
  await grants.getByRole("button", { name: "Save" }).click();
  await expect(grants.getByText("Saved")).toBeVisible();
  await shot("client-ai-grants");
});

test("the client calls /v1 with its token, as JSON and as a stream", async () => {
  const headers = { authorization: `Bearer ${made.token}`, "content-type": "application/json" };
  const models = (await (await page.request.get(`${API_URL}/v1/models`, { headers })).json()) as { data: Array<{ id: string }> };
  expect(models.data.map((model) => model.id)).toEqual([alias]);
  const answer = await page.request.post(`${API_URL}/v1/chat/completions`, { headers, data: { model: alias, messages: [{ role: "user", content: "hi" }] } });
  expect(answer.status()).toBe(200);
  const body = (await answer.json()) as { model: string; choices: Array<{ message: { content: string } }> };
  expect(body.model).toBe(alias);
  expect(body.choices[0]!.message.content).toBe("Hello from upstream.");
  const stream = await page.request.post(`${API_URL}/v1/chat/completions`, {
    headers,
    data: { model: alias, messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } }
  });
  const text = await stream.text();
  expect(text).toContain("from the stream.");
  expect(text.trim().endsWith("data: [DONE]")).toBeTruthy();
  const wrong = await page.request.post(`${API_URL}/v1/chat/completions`, { headers: { ...headers, authorization: "Bearer nope" }, data: { model: alias, messages: [] } });
  expect(wrong.status()).toBe(401);
});

test("the AI routes page counts the requests", async () => {
  await sidebarItem("AI routes").click();
  const usage = page.getByTestId("ai-gateway-usage");
  // This run's model name: its two requests (rows of earlier runs on the same database stay in the totals).
  const row = usage.getByRole("row").filter({ hasText: alias });
  await expect(row.getByRole("cell").nth(2)).toHaveText("2");
  await expect(row.getByRole("cell").nth(3)).toHaveText("15");
  await shot("ai-routes-usage");
});
