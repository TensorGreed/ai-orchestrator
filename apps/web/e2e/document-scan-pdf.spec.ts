import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Scanning a PDF from a rule set's editor: an uploaded PDF is read on the server (in a worker), its findings show
 * page and line locations and masked previews only, and a PDF without a text layer (a scanned one) says nothing in it
 * was checked instead of showing a clean result.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "ChangeThisPassword123!";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4000";
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR;

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
const stamp = Date.now();
const profileId = `e2e-pdf-${stamp}`;
const profileName = `E2E PDF scan ${stamp}`;
const EMAIL = "jane.doe@example.com";

/** A PDF with one page per entry (its lines drawn with Helvetica); an empty entry is a page without text. */
function pdf(pages: string[][]): Buffer {
  const esc = (text: string) => `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: number[] = [];
  for (const lines of pages) {
    const content = lines.length > 0 ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `${esc(line)} Tj T*`).join(" ")} ET` : "q Q";
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.7\n";
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
  const created = await page.request.post("/api/guard/profiles", { data: { document: { id: profileId, name: profileName, version: "1" } } });
  expect(created.ok(), await created.text()).toBeTruthy();
});

test.afterAll(async () => {
  await page.request.delete(`/api/guard/profiles/${profileId}`);
  await context.close();
});

test("scans an uploaded PDF and shows page locations with masked previews", async () => {
  await page.locator("aside.app-sidebar").getByRole("button", { name: "Security", exact: true }).click();
  await page.getByRole("tab", { name: "Rule sets & bindings" }).click();
  await page.getByRole("complementary", { name: "Rule sets" }).getByRole("button", { name: new RegExp(profileName) }).click();
  const panel = page.getByRole("region", { name: "Scan a document" });
  await panel.getByLabel("Document", { exact: true }).setInputFiles({ name: "form.pdf", mimeType: "application/pdf", buffer: pdf([["Application", `Email ${EMAIL}`], ["Card 4111 1111 1111 1111"]]) });
  await panel.getByRole("button", { name: "Scan document" }).click();
  const result = panel.getByRole("status", { name: "Scan result" });
  await expect(result).toContainText("PDF", { timeout: 30_000 });
  await expect(result).toContainText("2 pages");
  await expect(result.getByRole("row").filter({ hasText: "page 1, line 2, column 7" })).toBeVisible();
  await expect(result.getByRole("row").filter({ hasText: "page 2, line 1, column 6" })).toBeVisible();
  await expect(result).not.toContainText(EMAIL);
  await shot("document-scan-pdf");
});

test("says a scanned PDF (no text layer) was not checked", async () => {
  const panel = page.getByRole("region", { name: "Scan a document" });
  await panel.getByLabel("Document", { exact: true }).setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: pdf([[]]) });
  await panel.getByRole("button", { name: "Scan document" }).click();
  await expect(panel.getByText(/No text layer: this looks like a scanned PDF/)).toBeVisible({ timeout: 30_000 });
  await shot("document-scan-pdf-scanned");
});
