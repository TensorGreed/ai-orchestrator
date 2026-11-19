import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Counts what a new user has to read: the visible fields, toggles and buttons of the node inspector for the ten node
 * types a first workflow uses most, and of the editor's chrome. Not a check: it runs only with SURFACE_COUNT=1 and
 * writes `surface-count.json` and `surface-count.md` to SURFACE_COUNT_DIR (default test-results/surface-count).
 *
 * "Default view" is what opens: the first tab, nothing expanded. "Everything" adds every tab but Input, Output and
 * Trace, and every closed section of the inspector opened.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const OUT_DIR = process.env.SURFACE_COUNT_DIR ?? path.join("test-results", "surface-count");

const NODE_TYPES = [
  "webhook_input",
  "schedule_trigger",
  "http_request",
  "set_node",
  "if_node",
  "switch_node",
  "filter_node",
  "loop_node",
  "llm_call",
  "agent_orchestrator"
] as const;

interface Counts {
  fields: number;
  toggles: number;
  buttons: number;
  tabs: number;
  tips: number;
  total: number;
}

/** Visible controls inside `root`, by kind. Tips are the inspector's explanation boxes (read, not clicked). */
async function countControls(root: Locator, bodyOnly = false): Promise<Counts> {
  return root.evaluate((element, onlyBody) => {
    // checkVisibility also hides what sits in a closed <details> (its content is skipped, not removed).
    const visible = (node: Element) => {
      const html = node as HTMLElement;
      if (!html.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
      const rect = html.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };
    // `onlyBody`: just the tab's content (the inspector's sections), without the header, tabs and footer around it.
    const all = (selector: string) =>
      [...element.querySelectorAll(selector)].filter((node) => visible(node) && (!onlyBody || node.closest(".insp-section") !== null));
    const codeEditors = all(".cm-editor");
    const fields =
      all("input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea").filter((node) => !node.closest(".cm-editor")).length +
      codeEditors.length;
    const toggles = all(".cfg-toggle, input[type=checkbox], input[type=radio], [role=switch]").length;
    const tabs = all("[role=tab]").length;
    const buttons = all("button, summary, [role=button], a[href]").filter(
      (node) => !node.matches(".cfg-toggle, [role=tab], [role=switch]") && !node.closest(".cm-editor") && !node.matches(".cfg-help > summary")
    ).length;
    const tips = all(".cfg-tip").length;
    return { fields, toggles, buttons, tabs, tips, total: fields + toggles + buttons + tabs };
  }, bodyOnly);
}

async function openStudio(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("aside.app-sidebar")).toBeVisible({ timeout: 60_000 });
}

test.describe("surface count", () => {
  test.skip(process.env.SURFACE_COUNT !== "1", "set SURFACE_COUNT=1 to count the editor's visible surface");
  test.setTimeout(240_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test("counts the inspector and the editor chrome", async ({ page }) => {
    await page.context().route(/:11434(\/|$)/, (route) => route.abort());
    await openStudio(page);
    const definitions = (await (await page.request.get("/api/definitions")).json()) as {
      nodes: Array<{ type: string; label: string; sampleConfig: Record<string, unknown> }>;
    };
    const stamp = Date.now();
    const workflowId = `wf-e2e-surface-${stamp}`;
    const nodes = NODE_TYPES.map((type, index) => {
      const definition = definitions.nodes.find((entry) => entry.type === type);
      if (!definition) throw new Error(`No definition for ${type}`);
      const config = { ...definition.sampleConfig };
      if (type === "llm_call" || type === "agent_orchestrator") config.provider = { providerId: "echo", model: "echo-1" };
      if (type === "webhook_input") config.path = `surface-${stamp}`;
      return {
        id: `n${index}`,
        type,
        name: `${definition.label} ${index}`,
        position: { x: 60 + (index % 5) * 280, y: 80 + Math.floor(index / 5) * 260 },
        config
      };
    });
    const created = await page.request.post("/api/workflows", {
      data: { id: workflowId, name: `E2E Surface ${stamp}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes, edges: [] }
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const rows: Array<{ nodeType: string; defaultView: Counts; everything: Counts }> = [];
    let chrome: { header: Counts; moreMenu: Counts; canvas: Counts } | null = null;
    try {
      await page.reload();
      await page.getByLabel("Workflow", { exact: true }).selectOption(workflowId);
      await page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Editor", exact: true }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(nodes.length);

      const header = await countControls(page.getByRole("banner"));
      await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
      const menu = page.getByRole("menu").last();
      await expect(menu).toBeVisible();
      const moreMenu = await countControls(menu);
      await page.screenshot({ path: path.join(OUT_DIR, "chrome-more-actions.png") });
      await page.getByRole("banner").getByRole("button", { name: "More actions" }).click();
      await expect(menu).toBeHidden();
      const canvas = await countControls(page.locator(".react-flow").first());
      chrome = { header, moreMenu, canvas };

      for (const node of nodes) {
        // Nodes may sit under the header's banners: a dispatched double click opens the inspector all the same.
        await page.locator(".react-flow__node").filter({ hasText: node.name }).first().dispatchEvent("dblclick");
        const inspector = page.getByRole("dialog", { name: /^Inspect / });
        await expect(inspector).toBeVisible();
        await page.waitForTimeout(300);
        const defaultView = await countControls(inspector);
        await page.screenshot({ path: path.join(OUT_DIR, `inspector-${node.type}.png`) });

        // Everything: the inspector's frame once, plus the content of every tab but Input, Output and Trace with every
        // closed section opened.
        const frame = await countControls(inspector);
        const firstBody = await countControls(inspector, true);
        const seen: Counts = {
          fields: frame.fields - firstBody.fields,
          toggles: frame.toggles - firstBody.toggles,
          buttons: frame.buttons - firstBody.buttons,
          tabs: frame.tabs,
          tips: frame.tips - firstBody.tips,
          total: 0
        };
        const tabNames = (await inspector.getByRole("tab").allInnerTexts()).map((name) => name.trim()).filter((name) => !/^(Input|Output|Trace)/.test(name));
        for (const tabName of tabNames.length > 0 ? tabNames : [""]) {
          if (tabName) await inspector.getByRole("tab", { name: new RegExp(`^${tabName}`) }).click();
          for (let round = 0; round < 3; round += 1) {
            const closed = inspector.locator("details:not([open]):not(.cfg-help):not(.cfg-multi-select) > summary");
            const count = await closed.count();
            if (count === 0) break;
            for (let index = count - 1; index >= 0; index -= 1) await closed.nth(index).click().catch(() => undefined);
          }
          const body = await countControls(inspector, true);
          seen.fields += body.fields;
          seen.toggles += body.toggles;
          seen.buttons += body.buttons;
          seen.tips += body.tips;
        }
        seen.total = seen.fields + seen.toggles + seen.buttons + seen.tabs;
        rows.push({ nodeType: node.type, defaultView, everything: seen });
        await page.keyboard.press("Escape");
        const discard = page.getByRole("button", { name: /^Discard/ });
        if (await discard.isVisible().catch(() => false)) await discard.click();
        await expect(inspector).toHaveCount(0);
      }
    } finally {
      await page.request.delete(`/api/workflows/${workflowId}`);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, "surface-count.json"), JSON.stringify({ rows, chrome }, null, 2));
    const line = (name: string, counts: Counts) =>
      `| ${name} | ${counts.fields} | ${counts.toggles} | ${counts.buttons} | ${counts.tabs} | ${counts.tips} | ${counts.total} |`;
    const markdown = [
      "| Node type (default view) | Fields | Toggles | Buttons | Tabs | Tips | Total |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((row) => line(row.nodeType, row.defaultView)),
      "",
      "| Node type (everything) | Fields | Toggles | Buttons | Tabs | Tips | Total |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((row) => line(row.nodeType, row.everything)),
      "",
      "| Editor chrome | Fields | Toggles | Buttons | Tabs | Tips | Total |",
      "|---|---|---|---|---|---|---|",
      ...(chrome ? [line("Header", chrome.header), line("More actions menu", chrome.moreMenu), line("Canvas", chrome.canvas)] : [])
    ].join("\n");
    fs.writeFileSync(path.join(OUT_DIR, "surface-count.md"), `${markdown}\n`);
    console.log(markdown);
  });
});
