import { expect, test, type Page } from "@playwright/test";

// The static demo under /demo/: no API, no database, no network beyond the page's own origin.
const SHOTS = process.env.DEMO_SCREENSHOT_DIR;
const DEMO_HOST = `localhost:${process.env.DEMO_PORT ?? 4319}`;

function sidebarItem(page: Page, label: string) {
  // Items with a count badge (Approvals) carry the count in their name.
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: new RegExp(`^${label}(\\s+\\d+ waiting)?$`) });
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function nodeIds(page: Page): Promise<string[]> {
  return page.locator(".react-flow__node").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id") ?? ""));
}

/** Drags from one node's outgoing handle to another node's incoming handle. */
async function connect(page: Page, sourceId: string, targetId: string) {
  const source = page.locator(`.react-flow__node[data-id="${sourceId}"] .react-flow__handle.source`).first();
  const target = page.locator(`.react-flow__node[data-id="${targetId}"] .react-flow__handle.target`).first();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

test("the demo journey: banner, template, edit, save, persist, recorded run, security, approvals, reset", async ({ page }) => {
  const offOrigin: string[] = [];
  const consoleErrors: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.host !== DEMO_HOST) offOrigin.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  // The banner and the tour, which can be skipped.
  await page.goto("/demo/");
  const banner = page.getByRole("region", { name: "Live demo" });
  await expect(banner).toContainText("everything runs in your browser; nothing is saved on a server.");
  await expect(banner.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs/");
  await expect(banner.getByRole("link", { name: "Self-host L2M" })).toHaveAttribute("href", /\/docs\/getting-started\//);
  const tour = page.getByRole("complementary", { name: "Demo tour" });
  await expect(tour).toContainText("Build an agent");
  await shot(page, "01-home-banner-tour");
  await tour.getByRole("button", { name: "Skip tour" }).click();
  await expect(tour).toBeHidden();

  // A template opens in the editor as a workflow of the visitor's own.
  await sidebarItem(page, "Templates").click();
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  await shot(page, "02-templates");
  const card = page.locator('[data-testid^="tpl-card-"]').filter({ hasText: "Basic LLM Flow" }).first();
  await card.getByRole("button", { name: "Use Template" }).click();
  await expect(sidebarItem(page, "Editor")).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  const workflowId = new URL(page.url()).searchParams.get("workflowId");
  expect(workflowId).toMatch(/^wf-basic-llm-flow-\d+$/);

  // Add a node and connect it.
  const before = await nodeIds(page);
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByLabel("Search nodes").fill("output");
  await page.locator("#palette-row-output").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  const added = (await nodeIds(page)).find((id) => !before.includes(id))!;
  await page.keyboard.press("Escape");
  const edgesBefore = await page.locator(".react-flow__edge").count();
  const lastOutput = before.find((id) => id.startsWith("output"))!;
  await connect(page, lastOutput, added);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgesBefore + 1);

  // Save, reload: the change is still there.
  await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem("l2m-demo:state:v1") ?? "{}").workflows?.find((w: { id: string }) => w.id === id)?.nodes.length, workflowId)).toBe(5);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await expect(page.locator(".react-flow__edge")).toHaveCount(edgesBefore + 1);
  await shot(page, "03-edited-template-persisted");

  // An edited workflow has no recording: the demo says so and points at one that does.
  await page.getByRole("banner").getByRole("button", { name: "Run workflow" }).click();
  const notice = page.locator(".demo-notice");
  await expect(notice).toContainText("Runs need a real deployment");
  await expect(notice).toContainText("Here is a recorded run of a similar workflow");
  await shot(page, "04-not-recorded-notice");
  await notice.getByRole("button", { name: "Close" }).click();

  // A recorded workflow replays its run to the end.
  await page.goto("/demo/?workflowId=wf-demo-support-agent&mode=editor");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("banner").getByRole("button", { name: "Run workflow" }).click();
  await expect(page.getByText(/status\s+running/)).toBeVisible();
  await shot(page, "05-recorded-run-replaying");
  await expect(page.getByText(/status\s+success/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/last run \d+\s*ms/).first()).toBeVisible();
  await shot(page, "06-recorded-run-finished");

  // Security: the recorded guard block.
  await sidebarItem(page, "Security").click();
  await expect(page.getByRole("heading", { name: "Security", exact: true })).toBeVisible();
  await expect(page.getByText("Blocked", { exact: true }).first()).toBeVisible();
  await shot(page, "07-security");

  // Approvals: decide one on demo data.
  await sidebarItem(page, "Approvals").click();
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);
  await shot(page, "08-approvals");
  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByText(/Approved\./).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(1);

  // Release gate on the gated workflow.
  await page.goto("/demo/?workflowId=wf-demo-faq-release&mode=editor");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await shot(page, "09-release-gated-workflow");

  // Reset: the visitor's workflow and decisions are gone.
  await page.getByRole("region", { name: "Live demo" }).getByRole("button", { name: "Reset demo" }).click();
  await page.waitForURL(/\/demo\/$/);
  await expect(page.getByRole("complementary", { name: "Demo tour" })).toBeVisible();
  const state = await page.evaluate(() => localStorage.getItem("l2m-demo:state:v1"));
  expect(state === null || !state.includes(workflowId!)).toBe(true);
  await page.goto("/demo/?mode=approvals");
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(2);

  expect(offOrigin, "requests that left the page's origin").toEqual([]);
  expect(consoleErrors, "console errors").toEqual([]);
});
