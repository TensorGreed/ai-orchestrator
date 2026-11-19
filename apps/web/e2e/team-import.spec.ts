import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Import and team flows: importing a workflow file whose id is already here asks first (a new workflow by default,
 * replace only on request, with what it changes); an admin invites a person from Settings; a workflow is shared with a
 * person by email; and a viewer's editor shows Save, Add node, Clear and Run disabled with the reason. No model is
 * called. Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "team-import");

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

async function signIn(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email, password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
}

async function openEditor(page: Page, workflowId: string): Promise<void> {
  await page.goto(`/?workflowId=${encodeURIComponent(workflowId)}&mode=editor`);
  await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
}

function flow(id: string, name: string, withOutput = false) {
  return {
    id,
    name,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: position(100), config: {} },
      { id: "line", type: "set_node", name: "Line", position: position(400), config: { assignments: [{ key: "line", valueTemplate: "one" }] } },
      ...(withOutput ? [{ id: "out", type: "output", name: "Out", position: position(700), config: {} }] : [])
    ],
    edges: [{ id: "e1", source: "start", target: "line" }, ...(withOutput ? [{ id: "e2", source: "line", target: "out" }] : [])]
  };
}

/** Invites and accepts a user through the API; returns its id and password. */
async function makeUser(page: Page, email: string, role: "viewer" | "operator" | "builder") {
  const invited = await page.request.post("/api/users/invite", { data: { email, role } });
  expect(invited.status(), await invited.text()).toBe(201);
  const body = (await invited.json()) as { user: { id: string }; inviteUrl: string };
  const token = new URLSearchParams(new URL(body.inviteUrl).hash.slice(1)).get("invite");
  const password = "Team-Pass-12345";
  const accepted = await page.request.post("/api/auth/invite/accept", { data: { token, password } });
  expect(accepted.ok(), await accepted.text()).toBeTruthy();
  return { id: body.user.id, email, password };
}

async function pageAs(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const ollama = await guardLocalModels(page);
  await signIn(page, email, password);
  return { context, page, ollama };
}

test.describe("import and team", () => {
  test.setTimeout(180_000);

  test("importing a file with an id that is here imports a new workflow unless you choose replace", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const id = `wf-e2e-import-${Date.now()}`;
    const made: string[] = [id];
    try {
      expect((await page.request.post("/api/workflows", { data: flow(id, "E2E Import original") })).ok()).toBeTruthy();
      await openEditor(page, id);
      const file = { name: `${id}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ workflow: flow(id, "E2E Import edited", true) })) };

      // Default: a new workflow, the stored one untouched.
      await page.locator('input[type="file"][accept="application/json"]').first().setInputFiles(file);
      const dialog = page.getByRole("dialog", { name: "This workflow is already here" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("radio", { name: /Import as a new workflow/ })).toBeChecked();
      await page.screenshot({ path: path.join(SHOT_DIR, "import-conflict-default.png") });
      await dialog.getByRole("button", { name: "Import as new" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByLabel("Workflow name")).toHaveValue("E2E Import edited (imported)");
      const list = (await (await page.request.get("/api/workflows")).json()) as Array<{ id: string; name: string }>;
      const copy = list.find((item) => item.name === "E2E Import edited (imported)");
      expect(copy).toBeTruthy();
      made.push(copy!.id);
      expect(copy!.id).not.toBe(id);
      expect(((await (await page.request.get(`/api/workflows/${id}`)).json()) as { name: string }).name).toBe("E2E Import original");

      // Replace: chosen explicitly, with what it changes.
      await openEditor(page, id);
      await page.locator('input[type="file"][accept="application/json"]').first().setInputFiles(file);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: /Replace E2E Import original/ }).check();
      await expect(dialog.getByText("1 node added: Out")).toBeVisible();
      await expect(dialog.getByText("1 connection added")).toBeVisible();
      await expect(dialog.getByText("Workflow settings changed: name")).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "import-conflict-replace.png") });
      await dialog.getByRole("button", { name: "Replace E2E Import original" }).click();
      await expect(dialog).toBeHidden();
      const replaced = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { name: string; nodes: unknown[] };
      expect(replaced.name).toBe("E2E Import edited");
      expect(replaced.nodes).toHaveLength(3);
      expect(ollama).toEqual([]);
    } finally {
      for (const workflowId of made) await page.request.delete(`/api/workflows/${workflowId}`);
    }
  });

  test("an admin invites from Settings, shares a workflow by email, and the viewer's editor is read-only", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const id = `wf-e2e-team-${stamp}`;
    const invitedEmail = `e2e-invited-${stamp}@example.com`;
    const userIds: string[] = [];
    try {
      // Invite user dialog.
      await page.goto("/");
      await page.locator("aside.app-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Users", exact: true }).click();
      await page.getByRole("button", { name: "Invite user" }).click();
      const invite = page.getByRole("dialog", { name: "Invite user" });
      await invite.getByLabel("Email").fill(invitedEmail);
      await invite.getByLabel("Role").selectOption("operator");
      await invite.getByRole("button", { name: "Send invite" }).click();
      await expect(invite.getByLabel("Invite link")).toHaveValue(/#invite=/);
      await page.screenshot({ path: path.join(SHOT_DIR, "invite-dialog-link.png") });
      await invite.getByRole("button", { name: "Done" }).click();
      await expect(page.getByRole("cell", { name: new RegExp(`^${invitedEmail}`) })).toBeVisible();
      const users = (await (await page.request.get("/api/users")).json()) as { users: Array<{ id: string; email: string }> };
      userIds.push(users.users.find((user) => user.email === invitedEmail)!.id);

      // Share with a viewer by email from the editor.
      const viewer = await makeUser(page, `e2e-viewer-${stamp}@example.com`, "viewer");
      userIds.push(viewer.id);
      expect((await page.request.post("/api/workflows", { data: flow(id, "E2E Team flow", true) })).ok()).toBeTruthy();
      await openEditor(page, id);
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Share…" }).click();
      const share = page.getByRole("dialog", { name: /Share "E2E Team flow"/ });
      await share.getByLabel("Email").fill(viewer.email);
      await share.getByLabel("Access").selectOption("execute");
      await share.getByRole("button", { name: "Share with person" }).click();
      await expect(share.getByRole("status")).toContainText("is a viewer, so they can view it but not run it");
      await expect(share.getByRole("cell", { name: new RegExp(`^${viewer.email}`) })).toBeVisible();
      await page.screenshot({ path: path.join(SHOT_DIR, "share-people.png") });
      await share.getByRole("button", { name: "Close share dialog" }).click();

      // The viewer opens it read-only.
      const as = await pageAs(browser, viewer.email, viewer.password);
      try {
        await openEditor(as.page, id);
        const save = as.page.getByRole("button", { name: /^Save/ });
        await expect(save).toHaveAttribute("aria-disabled", "true");
        await expect(save).toHaveAttribute("title", /viewer role/);
        await expect(as.page.getByRole("button", { name: "Run workflow" })).toHaveAttribute("aria-disabled", "true");
        await expect(as.page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: /Add node/ })).toHaveAttribute("aria-disabled", "true");
        const clear = as.page.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Clear", exact: true });
        await expect(clear).toHaveAttribute("aria-disabled", "true");
        await clear.click({ force: true });
        await expect(as.page.locator(".react-flow__node")).toHaveCount(3);
        await as.page.screenshot({ path: path.join(SHOT_DIR, "viewer-editor.png") });
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });
});
