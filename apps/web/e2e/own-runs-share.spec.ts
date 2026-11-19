import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * A workflow shared with a person, who is not a member of its project: they see only their own runs of it. The admin
 * runs it first; the operator it is shared with runs it from the editor, the run picker reads "Your runs" and lists only
 * their run, and the admin's run answers 404 to them. Needs a server with PROJECT_ISOLATION=strict (with role
 * isolation an operator reads every project, so the share is never all they have); skipped otherwise. No model is
 * called. Everything it makes is removed at the end. Also: a deep link opens any workflow the person can read (and
 * only those), a person with no project of their own lands on the workflows shared with them, and the publish dialog
 * shows them a gate's verdict without the reasons and figures taken from other people's runs.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "own-runs-share");

/** Fails the test if the page tries to reach a local Ollama. */
async function guardLocalModels(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.context().route(/:11434(\/|$)/, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
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

function flow(id: string, projectId: string, name = "E2E Own runs flow") {
  return {
    id,
    name,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    projectId,
    nodes: [
      { id: "start", type: "manual_trigger", name: "Start", position: { x: 100, y: 180 }, config: {} },
      { id: "out", type: "output", name: "Out", position: { x: 400, y: 180 }, config: { responseTemplate: "done" } }
    ],
    edges: [{ id: "e1", source: "start", target: "out" }]
  };
}

test.describe("own runs only", () => {
  test.setTimeout(180_000);

  test("an operator with a workflow only through a share sees only their own runs in the editor and the API", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const id = `wf-e2e-own-runs-${stamp}`;
    const projectId = `e2e-own-runs-${stamp}`;
    const homeId = `e2e-own-runs-home-${stamp}`;
    const userIds: string[] = [];
    try {
      expect((await page.request.post("/api/projects", { data: { id: projectId, name: "E2E Own runs" } })).ok()).toBeTruthy();
      const created = await page.request.post("/api/workflows", { data: flow(id, projectId) });
      expect(created.ok(), await created.text()).toBeTruthy();
      const adminRun = await page.request.post(`/api/workflows/${id}/execute`, { data: { input: {} } });
      expect(adminRun.ok(), await adminRun.text()).toBeTruthy();
      const adminRunId = ((await adminRun.json()) as { executionId: string }).executionId;

      const operator = await makeUser(page, `e2e-own-runs-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      // The operator works in a project of their own; the workflow's project is not theirs.
      expect((await page.request.post("/api/projects", { data: { id: homeId, name: "E2E Operator home" } })).ok()).toBeTruthy();
      const member = await page.request.post(`/api/projects/${homeId}/members`, { data: { email: operator.email, role: "viewer" } });
      expect(member.ok(), await member.text()).toBeTruthy();
      const shared = await page.request.post(`/api/workflows/${id}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } });
      expect(shared.ok(), await shared.text()).toBeTruthy();

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        const access = (await (await as.page.request.get(`/api/workflows/${id}/access`)).json()) as { ownRunsOnly?: boolean };
        test.skip(access.ownRunsOnly !== true, "Needs a server with PROJECT_ISOLATION=strict");

        // Before running: none of the admin's runs.
        expect((await as.page.request.get(`/api/executions/${adminRunId}`)).status()).toBe(404);
        expect(((await (await as.page.request.get(`/api/executions?workflowId=${id}`)).json()) as { total: number }).total).toBe(0);

        // Opened from "Shared with you" on the dashboard of their own project.
        await as.page.goto(`/?projectId=${encodeURIComponent(homeId)}&mode=dashboard`);
        const sharedWithYou = as.page.getByRole("region", { name: "Shared with you" });
        await expect(sharedWithYou).toBeVisible({ timeout: 60_000 });
        await sharedWithYou.getByRole("button", { name: /E2E Own runs flow/ }).click();
        await expect(as.page.getByLabel("Workflow name")).toHaveValue("E2E Own runs flow", { timeout: 60_000 });
        const run = as.page.getByRole("button", { name: "Run workflow" });
        await expect(run).not.toHaveAttribute("aria-disabled", "true");
        await run.click();
        const picker = as.page.getByLabel("Your runs");
        await expect(picker).toBeVisible({ timeout: 30_000 });
        await expect.poll(async () => await picker.locator("option").count(), { timeout: 30_000 }).toBe(1);
        await expect(picker.locator("option").first()).toContainText("Latest");
        await as.page.screenshot({ path: path.join(SHOT_DIR, "operator-own-runs.png") });

        const listed = (await (await as.page.request.get(`/api/executions?workflowId=${id}`)).json()) as { items: Array<{ id: string }>; total: number };
        expect(listed.total).toBe(1);
        expect(listed.items[0]!.id).not.toBe(adminRunId);
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }

      // The admin still sees both runs.
      expect(((await (await page.request.get(`/api/executions?workflowId=${id}`)).json()) as { total: number }).total).toBe(2);
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
      await page.request.delete(`/api/projects/${projectId}`);
      await page.request.delete(`/api/projects/${homeId}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });
});

test.describe("opening shared workflows (strict isolation)", () => {
  test.setTimeout(180_000);

  test("a deep link opens a workflow shared with you and stays on it; one you cannot read is not found", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const projectId = `e2e-link-${stamp}`;
    const homeId = `e2e-link-home-${stamp}`;
    const shared = `wf-e2e-link-shared-${stamp}`;
    const hidden = `wf-e2e-link-hidden-${stamp}`;
    const own = `wf-e2e-link-own-${stamp}`;
    const userIds: string[] = [];
    try {
      for (const [id, name] of [[projectId, "E2E Link team"], [homeId, "E2E Link home"]] as const) {
        expect((await page.request.post("/api/projects", { data: { id, name } })).ok()).toBeTruthy();
      }
      for (const [id, project, name] of [[shared, projectId, "E2E Link shared"], [hidden, projectId, "E2E Link hidden"], [own, homeId, "E2E Link own"]] as const) {
        const created = await page.request.post("/api/workflows", { data: flow(id, project, name) });
        expect(created.ok(), await created.text()).toBeTruthy();
      }
      const operator = await makeUser(page, `e2e-link-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      expect((await page.request.post(`/api/projects/${homeId}/members`, { data: { email: operator.email, role: "viewer" } })).ok()).toBeTruthy();
      expect((await page.request.post(`/api/workflows/${shared}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } })).ok()).toBeTruthy();

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        const access = (await (await as.page.request.get(`/api/workflows/${shared}/access`)).json()) as { ownRunsOnly?: boolean };
        test.skip(access.ownRunsOnly !== true, "Needs a server with PROJECT_ISOLATION=strict");

        const name = as.page.getByLabel("Workflow name");
        await as.page.goto(`/?projectId=${encodeURIComponent(homeId)}&workflowId=${encodeURIComponent(shared)}&mode=editor`);
        await expect(name).toHaveValue("E2E Link shared", { timeout: 60_000 });
        // It stays open: the project's own workflow does not replace it.
        await as.page.waitForTimeout(2_000);
        await expect(name).toHaveValue("E2E Link shared");
        await as.page.screenshot({ path: path.join(SHOT_DIR, "deep-link-shared.png") });

        // A workflow in another project, not shared with them, and one that does not exist: the same answer.
        for (const id of [hidden, `wf-e2e-link-missing-${stamp}`]) {
          await as.page.goto(`/?projectId=${encodeURIComponent(homeId)}&workflowId=${encodeURIComponent(id)}&mode=editor`);
          await expect(as.page.getByText("Workflow not found").first()).toBeVisible({ timeout: 60_000 });
          await expect(name).toHaveValue("E2E Link own", { timeout: 30_000 });
          await expect(as.page.getByText("E2E Link hidden")).toHaveCount(0);
        }
        await as.page.screenshot({ path: path.join(SHOT_DIR, "deep-link-not-found.png") });
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      for (const id of [shared, hidden, own]) await page.request.delete(`/api/workflows/${id}`);
      for (const id of [projectId, homeId]) await page.request.delete(`/api/projects/${id}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });

  test("a deep link opens a workflow of another of your projects while one project is active (either isolation mode)", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const [a, b] = [`e2e-link-a-${stamp}`, `e2e-link-b-${stamp}`];
    const [inA, inB] = [`wf-e2e-link-a-${stamp}`, `wf-e2e-link-b-${stamp}`];
    const userIds: string[] = [];
    try {
      for (const [id, name] of [[a, "E2E Link A"], [b, "E2E Link B"]] as const) {
        expect((await page.request.post("/api/projects", { data: { id, name } })).ok()).toBeTruthy();
      }
      for (const [id, project, name] of [[inA, a, "E2E Link in A"], [inB, b, "E2E Link in B"]] as const) {
        expect((await page.request.post("/api/workflows", { data: flow(id, project, name) })).ok()).toBeTruthy();
      }
      const builder = await makeUser(page, `e2e-link-builder-${stamp}@example.com`, "builder");
      userIds.push(builder.id);
      for (const project of [a, b]) {
        expect((await page.request.post(`/api/projects/${project}/members`, { data: { email: builder.email, role: "viewer" } })).ok()).toBeTruthy();
      }
      const as = await pageAs(browser, builder.email, builder.password);
      try {
        const name = as.page.getByLabel("Workflow name");
        await as.page.goto(`/?projectId=${encodeURIComponent(a)}&workflowId=${encodeURIComponent(inB)}&mode=editor`);
        await expect(name).toHaveValue("E2E Link in B", { timeout: 60_000 });
        await as.page.waitForTimeout(2_000);
        await expect(name).toHaveValue("E2E Link in B");
        await expect(as.page.getByText("Workflow not found")).toHaveCount(0);
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      for (const id of [inA, inB]) await page.request.delete(`/api/workflows/${id}`);
      for (const id of [a, b]) await page.request.delete(`/api/projects/${id}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });

  test("someone in no project lands on the workflows shared with them, with no offer to create a project", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const projectId = `e2e-nomember-${stamp}`;
    const id = `wf-e2e-nomember-${stamp}`;
    // Shared from the default project, the one the page falls back to: still listed as shared, not as the project's.
    const fromDefault = `wf-e2e-nomember-default-${stamp}`;
    const userIds: string[] = [];
    try {
      expect((await page.request.post("/api/projects", { data: { id: projectId, name: "E2E No-member team" } })).ok()).toBeTruthy();
      expect((await page.request.post("/api/workflows", { data: flow(id, projectId, "E2E No-member shared") })).ok()).toBeTruthy();
      expect((await page.request.post("/api/workflows", { data: flow(fromDefault, "default", "E2E No-member from default") })).ok()).toBeTruthy();
      const operator = await makeUser(page, `e2e-nomember-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      for (const shared of [id, fromDefault]) {
        expect((await page.request.post(`/api/workflows/${shared}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } })).ok()).toBeTruthy();
      }

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        const projects = (await (await as.page.request.get("/api/projects")).json()) as { projects: unknown[] };
        test.skip(projects.projects.length > 0, "Needs a server with PROJECT_ISOLATION=strict");

        // They are in no project, so the page never asks what is shared with one (no 404s in the console).
        const projectShareRequests: string[] = [];
        as.page.on("request", (request) => {
          if (/\/api\/projects\/[^/]+\/shared-workflows/.test(request.url())) projectShareRequests.push(request.url());
        });
        await as.page.goto("/");
        const sharedWithYou = as.page.getByRole("region", { name: "Shared with you" });
        await expect(sharedWithYou).toBeVisible({ timeout: 60_000 });
        await expect(sharedWithYou.getByRole("button", { name: /E2E No-member shared/ })).toBeVisible();
        await expect(sharedWithYou.getByRole("button", { name: /E2E No-member from default/ })).toBeVisible();
        await expect(as.page.getByText("You are not a member of any project yet")).toBeVisible();
        await expect(as.page.getByText(/Nothing is shared with you yet/)).toHaveCount(0);
        // An operator may not create projects: no offer to.
        await expect(as.page.getByRole("button", { name: "New project" })).toHaveCount(0);
        await expect(as.page.locator("option", { hasText: "New project" })).toHaveCount(0);
        await as.page.screenshot({ path: path.join(SHOT_DIR, "no-project-landing.png") });

        await sharedWithYou.getByRole("button", { name: /E2E No-member shared/ }).click();
        await expect(as.page.getByLabel("Workflow name")).toHaveValue("E2E No-member shared", { timeout: 60_000 });
        expect(projectShareRequests).toEqual([]);
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      for (const shared of [id, fromDefault]) await page.request.delete(`/api/workflows/${shared}`);
      await page.request.delete(`/api/projects/${projectId}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });
});

test.describe("switching project after opening a shared workflow (either isolation mode)", () => {
  test.setTimeout(240_000);

  test("an explicit project switch opens that project's workflow, also while a link's access check is pending", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const [team, homeA, homeB] = [`e2e-switch-team-${stamp}`, `e2e-switch-a-${stamp}`, `e2e-switch-b-${stamp}`];
    const [shared, ownA, ownB] = [`wf-e2e-switch-shared-${stamp}`, `wf-e2e-switch-a-${stamp}`, `wf-e2e-switch-b-${stamp}`];
    const userIds: string[] = [];
    try {
      for (const [id, name] of [[team, "E2E Switch team"], [homeA, "E2E Switch A"], [homeB, "E2E Switch B"]] as const) {
        expect((await page.request.post("/api/projects", { data: { id, name } })).ok()).toBeTruthy();
      }
      for (const [id, project, name] of [[shared, team, "E2E Switch shared"], [ownA, homeA, "E2E Switch own A"], [ownB, homeB, "E2E Switch own B"]] as const) {
        const created = await page.request.post("/api/workflows", { data: flow(id, project, name) });
        expect(created.ok(), await created.text()).toBeTruthy();
      }
      const operator = await makeUser(page, `e2e-switch-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      for (const project of [homeA, homeB]) {
        expect((await page.request.post(`/api/projects/${project}/members`, { data: { email: operator.email, role: "viewer" } })).ok()).toBeTruthy();
      }
      expect((await page.request.post(`/api/workflows/${shared}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } })).ok()).toBeTruthy();

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        // Runs in either isolation mode: the person reads the shared workflow through the share (strict) or their role.
        const name = as.page.getByLabel("Workflow name");
        const projectPicker = as.page.getByLabel("Project", { exact: true });

        // 1. Opened from a link: it stays open until the person switches project; then that project's workflow opens.
        await as.page.goto(`/?projectId=${encodeURIComponent(homeA)}&workflowId=${encodeURIComponent(shared)}&mode=editor`);
        await expect(name).toHaveValue("E2E Switch shared", { timeout: 60_000 });
        await as.page.waitForTimeout(1_500);
        await expect(name).toHaveValue("E2E Switch shared");
        await projectPicker.selectOption(homeB);
        await expect(name).toHaveValue("E2E Switch own B", { timeout: 30_000 });
        await as.page.waitForTimeout(1_500);
        await expect(name).toHaveValue("E2E Switch own B");

        // 2. Opened from "Shared with you": the same.
        await as.page.goto(`/?projectId=${encodeURIComponent(homeB)}&mode=dashboard`);
        const sharedWithYou = as.page.getByRole("region", { name: "Shared with you" });
        await expect(sharedWithYou).toBeVisible({ timeout: 60_000 });
        await sharedWithYou.getByRole("button", { name: /E2E Switch shared/ }).click();
        await expect(name).toHaveValue("E2E Switch shared", { timeout: 60_000 });
        await projectPicker.selectOption(homeA);
        await expect(name).toHaveValue("E2E Switch own A", { timeout: 30_000 });

        // 3. A switch while the link's access check is still pending wins over the link.
        let releaseAccess: () => void = () => undefined;
        const accessHeld = new Promise<void>((resolve) => (releaseAccess = resolve));
        let accessSeen = false;
        await as.page.route(`**/api/workflows/${shared}/access`, async (route) => {
          accessSeen = true;
          await accessHeld;
          await route.continue();
        });
        await as.page.goto(`/?projectId=${encodeURIComponent(homeA)}&workflowId=${encodeURIComponent(shared)}&mode=editor`);
        await expect.poll(() => accessSeen, { timeout: 60_000 }).toBe(true);
        await projectPicker.selectOption(homeB);
        releaseAccess();
        await expect(name).toHaveValue("E2E Switch own B", { timeout: 30_000 });
        await as.page.waitForTimeout(2_000);
        await expect(name).toHaveValue("E2E Switch own B");
        await expect(as.page.getByText("Workflow not found")).toHaveCount(0);
        await as.page.unroute(`**/api/workflows/${shared}/access`);

        // 4. A switch made on the Runs page, then Debug on a run of the shared workflow: the run's workflow stays open.
        const ran = await as.page.request.post(`/api/workflows/${shared}/execute`, { data: { input: {} } });
        expect(ran.ok(), await ran.text()).toBeTruthy();
        await as.page.goto(`/?projectId=${encodeURIComponent(homeA)}&mode=executions`);
        await expect(projectPicker).toBeVisible({ timeout: 60_000 });
        await projectPicker.selectOption(homeB);
        const debug = as.page.getByRole("button", { name: "Debug", exact: true }).first();
        await expect(debug).toBeVisible({ timeout: 30_000 });
        await debug.click();
        await expect(name).toHaveValue("E2E Switch shared", { timeout: 30_000 });
        await as.page.waitForTimeout(2_000);
        await expect(name).toHaveValue("E2E Switch shared");
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      for (const id of [shared, ownA, ownB]) await page.request.delete(`/api/workflows/${id}`);
      for (const id of [team, homeA, homeB]) await page.request.delete(`/api/projects/${id}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });

  test("a click on a workflow while a link's access check is pending wins over the link", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const [team, home] = [`e2e-race-team-${stamp}`, `e2e-race-home-${stamp}`];
    const [shared, own, other] = [`wf-e2e-race-shared-${stamp}`, `wf-e2e-race-own-${stamp}`, `wf-e2e-race-other-${stamp}`];
    const userIds: string[] = [];
    try {
      for (const [id, name] of [[team, "E2E Race team"], [home, "E2E Race home"]] as const) {
        expect((await page.request.post("/api/projects", { data: { id, name } })).ok()).toBeTruthy();
      }
      for (const [id, project, name] of [[shared, team, "E2E Race shared"], [own, home, "E2E Race own"], [other, home, "E2E Race other"]] as const) {
        expect((await page.request.post("/api/workflows", { data: flow(id, project, name) })).ok()).toBeTruthy();
      }
      const operator = await makeUser(page, `e2e-race-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      expect((await page.request.post(`/api/projects/${home}/members`, { data: { email: operator.email, role: "viewer" } })).ok()).toBeTruthy();
      expect((await page.request.post(`/api/workflows/${shared}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } })).ok()).toBeTruthy();

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        // Runs in either isolation mode.
        let releaseAccess: () => void = () => undefined;
        const accessHeld = new Promise<void>((resolve) => (releaseAccess = resolve));
        let accessSeen = false;
        await as.page.route(`**/api/workflows/${shared}/access`, async (route) => {
          accessSeen = true;
          await accessHeld;
          await route.continue();
        });
        // The link is held on the dashboard, where the person opens another workflow from the grid.
        await as.page.goto(`/?projectId=${encodeURIComponent(home)}&workflowId=${encodeURIComponent(shared)}&mode=dashboard`);
        await expect.poll(() => accessSeen, { timeout: 60_000 }).toBe(true);
        await as.page.getByRole("article").filter({ has: as.page.getByRole("heading", { name: "E2E Race other" }) }).getByRole("button", { name: "Open" }).click();
        const name = as.page.getByLabel("Workflow name");
        await expect(name).toHaveValue("E2E Race other", { timeout: 30_000 });
        releaseAccess();
        await as.page.waitForTimeout(2_500);
        await expect(name).toHaveValue("E2E Race other");
        await as.page.unroute(`**/api/workflows/${shared}/access`);
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }
      expect(ollama).toEqual([]);
    } finally {
      for (const id of [shared, own, other]) await page.request.delete(`/api/workflows/${id}`);
      for (const id of [team, home]) await page.request.delete(`/api/projects/${id}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });
});

test.describe("own runs only: releases", () => {
  test.setTimeout(180_000);

  test("the publish dialog shows them the gate's verdict with a note instead of its reasons and figures", async ({ page, browser }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const projectId = `e2e-gate-${stamp}`;
    const homeId = `e2e-gate-home-${stamp}`;
    const id = `wf-e2e-gate-shared-${stamp}`;
    const userIds: string[] = [];
    let setId: string | null = null;
    try {
      for (const [project, name] of [[projectId, "E2E Gate team"], [homeId, "E2E Gate home"]] as const) {
        expect((await page.request.post("/api/projects", { data: { id: project, name } })).ok()).toBeTruthy();
      }
      const created = await page.request.post("/api/workflows", { data: flow(id, projectId, "E2E Gate shared") });
      expect(created.ok(), await created.text()).toBeTruthy();
      const set = await page.request.post("/api/eval/datasets", { data: { name: `E2E Gate set ${stamp}`, workflowId: id } });
      expect(set.ok(), await set.text()).toBeTruthy();
      setId = ((await set.json()) as { dataset: { id: string } }).dataset.id;
      const gate = await page.request.put(`/api/workflows/${id}/release-gate`, { data: { enabled: true, datasetIds: [setId] } });
      expect(gate.ok(), await gate.text()).toBeTruthy();
      const operator = await makeUser(page, `e2e-gate-${stamp}@example.com`, "operator");
      userIds.push(operator.id);
      expect((await page.request.post(`/api/projects/${homeId}/members`, { data: { email: operator.email, role: "viewer" } })).ok()).toBeTruthy();
      expect((await page.request.post(`/api/workflows/${id}/user-shares`, { data: { email: operator.email, accessLevel: "execute" } })).ok()).toBeTruthy();

      const as = await pageAs(browser, operator.email, operator.password);
      try {
        const access = (await (await as.page.request.get(`/api/workflows/${id}/access`)).json()) as { ownRunsOnly?: boolean };
        test.skip(access.ownRunsOnly !== true, "Needs a server with PROJECT_ISOLATION=strict");

        await as.page.goto(`/?projectId=${encodeURIComponent(homeId)}&workflowId=${encodeURIComponent(id)}&mode=editor`);
        await expect(as.page.getByLabel("Workflow name")).toHaveValue("E2E Gate shared", { timeout: 60_000 });
        await as.page.getByRole("button", { name: /^Release: / }).click();
        const dialog = as.page.getByRole("dialog", { name: "Publish to production" });
        await expect(dialog.getByText("Blocked", { exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(dialog.getByText(/come from other people's runs, so only its verdict is shown/)).toBeVisible();
        await expect(dialog.locator(".release-reasons")).toHaveCount(0);
        await as.page.screenshot({ path: path.join(SHOT_DIR, "publish-preview-own-runs.png") });
        expect(as.ollama).toEqual([]);
      } finally {
        await as.context.close();
      }

      // The project's admin still sees why it is blocked.
      const preview = (await (await page.request.get(`/api/workflows/${id}/publish-preview?version=1`)).json()) as { preview: { reasons: string[]; detailsHidden?: boolean } };
      expect(preview.preview.reasons.length).toBeGreaterThan(0);
      expect(preview.preview.detailsHidden).toBeUndefined();
      expect(ollama).toEqual([]);
    } finally {
      await page.request.put(`/api/workflows/${id}/release-gate`, { data: { enabled: false, datasetIds: [] } });
      await page.request.delete(`/api/workflows/${id}`);
      if (setId) await page.request.delete(`/api/eval/datasets/${setId}`);
      for (const project of [projectId, homeId]) await page.request.delete(`/api/projects/${project}`);
      for (const userId of userIds) await page.request.delete(`/api/users/${userId}`);
    }
  });
});
