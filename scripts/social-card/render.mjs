// Renders scripts/social-card/social-card.svg to docs/assets/social-card.png (1200×630), the share
// card that the landing and the docs reference from their Open Graph and Twitter tags.
//
//   node scripts/social-card/render.mjs
//   (needs a Playwright Chromium: `pnpm exec playwright install chromium`, or CHROMIUM_EXECUTABLE_PATH)
//
// The PNG is committed; run this after changing the SVG, the fonts or the studio screenshot.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "social-card.svg");
const target = path.resolve(here, "..", "..", "docs", "assets", "social-card.png");
const maxBytes = 300 * 1024;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: target, type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
} finally {
  await browser.close();
}

const { size } = await fs.stat(target);
console.log(`Wrote ${path.relative(process.cwd(), target)} (${Math.round(size / 1024)} KB)`);
if (size > maxBytes) {
  console.error(`The share card is over ${maxBytes / 1024} KB; simplify the SVG or the screenshot.`);
  process.exit(1);
}
