import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * Knowledge and privacy out of the box (the end-user validation's B2 and friction items 9 and 13):
 *
 * - a PDF picked on the Knowledge page is read page by page (no raw PDF source in the chunks), each chunk shows its
 *   page, and a Word file is refused with a message that says what to upload instead;
 * - the test search with the built-in Token embedder ranks hybrid and says so;
 * - a Content Rules node redacts personal data with one tick ("Redact personal data"), and a run of it redacts a name,
 *   an email and a phone number.
 *
 * No model is called (no LLM node; the Token embedder is local). Everything it makes is removed at the end.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? path.join("test-results", "knowledge-privacy");

/** Fails the test if the page tries to reach a local Ollama. */
async function guardLocalModels(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.context().route(/:11434(\/|$)/, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
  });
  return attempts;
}

async function signIn(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.request.get(`${API_URL}/health`).catch(() => null))?.ok() ?? false, { timeout: 60_000 })
    .toBeTruthy();
  const login = await page.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(login.ok(), await login.text()).toBeTruthy();
  await page.addInitScript(() => window.localStorage.setItem("l2m:welcome-dismissed", "1"));
}

function sidebarItem(page: Page, label: string) {
  return page.locator("aside.app-sidebar").getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: label, exact: true });
}

/** A small PDF: one page per entry (its lines). */
function pdf(pages: string[][]): Buffer {
  const esc = (text: string) => `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${esc(line)} Tj T*`).join(" ")} ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test.describe("knowledge and privacy out of the box", () => {
  test.setTimeout(180_000);

  test("a PDF is read page by page, a Word file is refused, and the test search ranks hybrid", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const stamp = Date.now();
    const name = `E2E Policies ${stamp}`;
    const created = await page.request.post("/api/knowledge-bases", { data: { name, embedderId: "token-embedder", projectId: "default" } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const kbId = ((await created.json()) as { knowledgeBase: { id: string } }).knowledgeBase.id;
    try {
      await page.goto("/");
      await sidebarItem(page, "Knowledge").click();
      await page.getByRole("button", { name: new RegExp(name) }).first().click({ timeout: 30_000 });
      const uploadSection = page.locator("section.kb-section").filter({ has: page.getByRole("heading", { name: "Upload a document" }) });
      const fileInput = uploadSection.locator('input[type="file"]');
      await expect(fileInput).toHaveAttribute("accept", /\.pdf/);

      // The validation's repro: loyalty.pdf, picked on the upload form.
      await fileInput.setInputFiles({
        name: "loyalty.pdf",
        mimeType: "application/pdf",
        buffer: pdf([
          ["Loyalty programme", "Members earn 2 points per dollar spent."],
          ["Refunds", "Refunds take five to seven business days to arrive."]
        ])
      });
      await expect(page.getByRole("status").filter({ hasText: "loyalty.pdf" })).toContainText("each page is read");
      await page.getByRole("button", { name: "Upload & ingest" }).click();
      await expect(page.locator(".kb-success")).toContainText("2 chunks from 2 pages with text (of 2)", { timeout: 30_000 });
      const chunkList = page.locator(".kb-chunk-list").last();
      await expect(chunkList).toContainText("page 1");
      await expect(chunkList).toContainText("Members earn 2 points per dollar spent.");
      await expect(chunkList).not.toContainText("%PDF");
      await page.screenshot({ path: path.join(SHOT_DIR, "01-pdf-uploaded.png") });

      // A Word file (a zip archive) is refused, and nothing is stored.
      await fileInput.setInputFiles({ name: "policy.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64, 7)]) });
      await page.getByRole("button", { name: "Upload & ingest" }).click();
      await expect(page.locator(".settings-error")).toContainText("Save it as a PDF", { timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, "02-docx-refused.png") });
      const sources = (await (await page.request.get(`/api/knowledge-bases/${kbId}`)).json()) as { sources: Array<{ sourceId: string }> };
      expect(sources.sources.map((source) => source.sourceId)).toEqual(["loyalty.pdf"]);

      // The test search says how it ranks, and finds the refund page.
      await expect(page.getByText(/ranks the way a RAG Retrieve node does by default: hybrid/)).toBeVisible();
      await page.getByPlaceholder("how do I reset my password").fill("how long do refunds take?");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      const first = page.locator(".kb-chunk-list").first().locator(".kb-chunk-item").first();
      await expect(first).toContainText("Refunds take five to seven business days", { timeout: 30_000 });
      await expect(first).toContainText("page 2");
      await expect(first).toContainText("fused score");
      await page.screenshot({ path: path.join(SHOT_DIR, "03-hybrid-search.png") });
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/knowledge-bases/${kbId}`);
    }
  });

  test("one tick on a Content Rules node redacts a name, an email and a phone number", async ({ page }) => {
    const ollama = await guardLocalModels(page);
    await signIn(page);
    const id = `wf-e2e-redact-${Date.now()}`;
    try {
      const created = await page.request.post("/api/workflows", {
        data: {
          id,
          name: "E2E Redact personal data",
          schemaVersion: "1.0.0",
          workflowVersion: 1,
          nodes: [
            { id: "hook", type: "webhook_input", name: "Intake", position: { x: 40, y: 180 }, config: { path: `${id}-in`, method: "POST" } },
            { id: "rules", type: "guard", name: "Content Rules", position: { x: 340, y: 180 }, config: { profileId: "effective" } },
            { id: "out", type: "output", name: "Output", position: { x: 640, y: 180 }, config: { responseTemplate: "{{results.rules.user_prompt}}", outputKey: "result" } }
          ],
          edges: [
            { id: "e1", source: "hook", target: "rules" },
            { id: "e2", source: "rules", sourceHandle: "pass", target: "out" }
          ]
        }
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      await page.goto(`/?workflowId=${encodeURIComponent(id)}&mode=editor`);
      await expect(page.getByLabel("Workflow name")).toBeVisible({ timeout: 60_000 });
      await page.locator(".react-flow__node").filter({ hasText: "Content Rules" }).first().dblclick();
      const inspector = page.getByRole("dialog", { name: /^Inspect / });
      const toggle = inspector.getByRole("checkbox", { name: "Redact personal data" });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect(inspector.locator("#guard-profile-select")).toHaveValue("redact-personal-data");
      await page.screenshot({ path: path.join(SHOT_DIR, "04-redact-toggle.png") });
      await inspector.getByRole("button", { name: "Save changes" }).click();
      await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .poll(async () => {
          const saved = (await (await page.request.get(`/api/workflows/${id}`)).json()) as { nodes: Array<{ id: string; config: Record<string, unknown> }> };
          return saved.nodes.find((node) => node.id === "rules")?.config.profileId;
        }, { timeout: 30_000 })
        .toBe("redact-personal-data");

      const run = await page.request.post(`/api/workflows/${id}/execute`, { data: { user_prompt: "My name is Dr. Ana Diaz and my email is ana.diaz@example.com, phone +1 415 555 0134" } });
      expect(run.ok(), await run.text()).toBeTruthy();
      const output = JSON.stringify(((await run.json()) as { output?: unknown }).output);
      expect(output).toContain("[REDACTED:person_name]");
      expect(output).toContain("[REDACTED:email]");
      expect(output).toContain("[REDACTED:phone]");
      expect(output).not.toContain("ana.diaz@example.com");

      // The rule set list shows the preset, built in.
      await sidebarItem(page, "Security").click();
      const ruleSets = page.locator("main button, main [role=tab]").filter({ hasText: "Rule sets" }).first();
      if (await ruleSets.isVisible().catch(() => false)) await ruleSets.click();
      await expect(page.getByRole("button", { name: /Redact personal data/ }).first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(SHOT_DIR, "05-rule-set-list.png") });
      expect(ollama).toEqual([]);
    } finally {
      await page.request.delete(`/api/workflows/${id}`);
    }
  });
});
