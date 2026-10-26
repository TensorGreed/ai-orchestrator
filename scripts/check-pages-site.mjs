// Checks the assembled lsquarem.com site (see scripts/assemble-pages-site.mjs) in a real browser:
//   - the hero's primary button goes to /demo/ and the demo loads;
//   - the nav's "Live demo" button is visible at 360 px and 1440 px;
//   - every internal link and asset on the landing pages answers 200, and every #fragment exists;
//   - no request leaves the site's origin (fonts are self-hosted, no trackers);
//   - no console errors on the landing pages or the demo.
//
//   pnpm docs:build && pnpm --filter @ai-orchestrator/web build:demo
//   node scripts/assemble-pages-site.mjs
//   node scripts/check-pages-site.mjs [--site <dir>] [--port <n>]
//   (needs a Playwright Chromium: `pnpm exec playwright install chromium`, or CHROMIUM_EXECUTABLE_PATH)
//
// The site is served by a small static server that resolves paths the way GitHub Pages does
// (`/docs/foo` serves `foo.html`, `/demo` redirects to `/demo/`). Exit 1 on any failure.
import { createServer } from "node:http";
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(option("--site", path.join(repoRoot, "_site")));
const port = Number(option("--port", "4632"));
if ([4000, 4100, 5173, 5199].includes(port)) {
  console.error(`Port ${port} is reserved for the dev servers; pick another with --port.`);
  process.exit(2);
}
if (!existsSync(path.join(site, "index.html")) || !existsSync(path.join(site, "demo", "index.html"))) {
  console.error(`No assembled site with a demo at ${site}. Build the docs and the demo, then run scripts/assemble-pages-site.mjs.`);
  process.exit(2);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon"
};

const isFile = (file) => existsSync(file) && statSync(file).isFile();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  const target = path.join(site, pathname);
  if (!target.startsWith(site)) {
    res.writeHead(403).end();
    return;
  }
  let file = null;
  if (pathname.endsWith("/")) file = path.join(target, "index.html");
  else if (isFile(target)) file = target;
  else if (isFile(`${target}.html`)) file = `${target}.html`;
  else if (isFile(path.join(target, "index.html"))) {
    res.writeHead(301, { location: `${pathname}/${url.search}` }).end();
    return;
  }
  if (!file || !isFile(file)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  res.end(await fs.readFile(file));
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${port}`;

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.log(`  ✗ ${message}`);
};
const pass = (message) => console.log(`  ✓ ${message}`);

// CHROMIUM_EXECUTABLE_PATH uses an installed Chromium instead of the one Playwright downloads.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });

/** A page that records console errors and every request that leaves the origin. */
async function openPage(viewport, label) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") fail(`${label}: console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => fail(`${label}: page error: ${error.message}`));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      fail(`${label}: request left the origin: ${url}`);
    }
  });
  return { context, page };
}

/** Scrolls through the page so lazy images load and every reveal runs. */
async function scrollThrough(page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(40);
  }
  await page.waitForLoadState("networkidle");
}

const landingPages = ["/", "/integrations.html"];

// 1. Hero primary button → /demo/, and the demo loads.
console.log("Hero call to action");
{
  const { context, page } = await openPage({ width: 1440, height: 900 }, "/");
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  const primary = page.locator(".hero .hero-actions a.btn-primary").first();
  const label = (await primary.innerText()).trim();
  label.startsWith("Try the live demo") ? pass(`primary button reads "${label}"`) : fail(`primary button reads "${label}"`);
  const resolved = await primary.evaluate((anchor) => new URL(anchor.href).pathname);
  resolved === "/demo/" ? pass("primary button points at /demo/") : fail(`primary button points at ${resolved}`);
  await Promise.all([page.waitForURL(/\/demo\//), primary.click()]);
  try {
    await page.getByRole("button", { name: "Editor" }).first().waitFor({ timeout: 15_000 });
    pass("the demo studio loaded");
  } catch {
    fail("the demo studio did not load");
  }
  await page.waitForLoadState("networkidle");
  await context.close();
}

// 2. The nav's demo button is visible at phone and desktop widths.
console.log("Nav demo button");
for (const pathname of landingPages) {
  for (const width of [360, 1440]) {
    const { context, page } = await openPage({ width, height: 800 }, `${pathname} @${width}`);
    await page.goto(`${origin}${pathname}`, { waitUntil: "load" });
    const button = page.locator(".topbar .btn-demo");
    const visible = (await button.count()) === 1 && (await button.isVisible());
    const box = visible ? await button.boundingBox() : null;
    const inside = box !== null && box.x >= 0 && box.x + box.width <= width;
    visible && inside ? pass(`${pathname} at ${width}px`) : fail(`${pathname} at ${width}px: nav demo button not fully visible`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    overflow <= 0 ? pass(`${pathname} at ${width}px: no horizontal scroll`) : fail(`${pathname} at ${width}px: ${overflow}px horizontal scroll`);
    await context.close();
  }
}

// 3. Internal links and assets answer 200; fragments exist. Also no off-origin requests and
//    no console errors while each page loads fully, in both themes.
console.log("Links, assets, requests and console");
const checked = new Map();
async function status(url) {
  if (!checked.has(url)) checked.set(url, fetch(url, { redirect: "follow" }).then((r) => r.status, () => 0));
  return checked.get(url);
}
for (const pathname of landingPages) {
  for (const colorScheme of ["dark", "light"]) {
    const { context, page } = await openPage({ width: 1440, height: 900 }, `${pathname} (${colorScheme})`);
    await page.emulateMedia({ colorScheme });
    await page.goto(`${origin}${pathname}`, { waitUntil: "networkidle" });
    await scrollThrough(page);
    if (colorScheme === "light") {
      await context.close();
      continue;
    }
    const refs = await page.evaluate(() => {
      const values = [];
      document.querySelectorAll("a[href]").forEach((el) => values.push(el.getAttribute("href")));
      document.querySelectorAll("img[src], script[src]").forEach((el) => values.push(el.getAttribute("src")));
      document.querySelectorAll("link[href]").forEach((el) => {
        if (el.getAttribute("rel") !== "canonical") values.push(el.getAttribute("href"));
      });
      return values;
    });
    const ids = new Set(await page.evaluate(() => [...document.querySelectorAll("[id]")].map((el) => el.id)));
    for (const ref of new Set(refs)) {
      const url = new URL(ref, `${origin}${pathname}`);
      if (url.origin !== origin) continue;
      if (url.hash && url.pathname === new URL(`${origin}${pathname}`).pathname && !ids.has(url.hash.slice(1))) {
        fail(`${pathname}: link to missing fragment ${ref}`);
      }
      url.hash = "";
      const code = await status(url.href);
      if (code !== 200) fail(`${pathname}: ${ref} answered ${code}`);
    }
    pass(`${pathname}: ${new Set(refs).size} links and assets checked`);
    await context.close();
  }
}

// Fragments that point at another page (./#studio from the integrations page).
for (const pathname of landingPages) {
  const html = await fs.readFile(path.join(site, pathname === "/" ? "index.html" : pathname), "utf8");
  for (const [, target, hash] of html.matchAll(/href="\.\/(index\.html)?#([\w-]+)"/g)) {
    const landing = await fs.readFile(path.join(site, "index.html"), "utf8");
    if (!landing.includes(`id="${hash}"`)) fail(`${pathname}: link to missing fragment ${target ?? ""}#${hash}`);
  }
}

// The demo itself stays on its origin and logs no errors.
console.log("Demo");
{
  const { context, page } = await openPage({ width: 1440, height: 900 }, "/demo/");
  await page.goto(`${origin}/demo/?mode=editor&workflowId=wf-demo-support-agent`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  pass("deep link into the demo editor loaded");
  await context.close();
}

await browser.close();
server.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
