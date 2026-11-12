// Renders the knowledge hub's share cards (1200×630 PNG) in the landing card's style:
//   apps/docs/docs/public/social/<section>.png        one per section (Learn, Glossary, Recipes, Blog),
//                                                     the default for every page in it
//   apps/docs/docs/public/social/pages/<page>.png     one per page that asks for it with
//                                                     `socialCard: true` in its frontmatter (flagship
//                                                     guides and blog posts), named after its path
//                                                     (learn/agents/x.md → learn--agents--x.png)
//
//   node scripts/social-card/render-sections.mjs [--pages-only]
//   (needs a Playwright Chromium: `pnpm exec playwright install chromium`, or CHROMIUM_EXECUTABLE_PATH)
//
// The PNGs are committed, and the docs build picks a page's own card when its file exists. They are
// rendered here rather than in the docs build because the build has no browser: the Pages workflow
// builds the docs before it installs one, and a second renderer would add a native dependency.
// Run this after adding a flagship guide or a post, or after changing the template below.
import { existsSync, promises as fs, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const docsSrc = path.join(repo, "apps", "docs", "docs");
const outDir = path.join(docsSrc, "public", "social");
const maxBytes = 300 * 1024;

const SECTIONS = [
  { id: "learn", eyebrow: "LEARN · GUIDED TRACKS", title: ["Learn MCP and", "AI agents, step", "by step."], lead: "Plain-language guides with runnable examples.", accent: "#8ae2ff" },
  { id: "glossary", eyebrow: "GLOSSARY", title: ["MCP and agent", "terms, in plain", "words."], lead: "One short definition per term, with examples.", accent: "#7ee2b8" },
  { id: "recipes", eyebrow: "RECIPES", title: ["Agent workflows", "you can import", "today."], lead: "A diagram of every node, the JSON, a demo link.", accent: "#ffb454" },
  { id: "blog", eyebrow: "BLOG", title: ["Notes on running", "MCP agents."], lead: "Release notes, design notes, field reports.", accent: "#c6a2ff" }
];

const escapeXml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Splits a title into lines of at most `width` characters, on word boundaries. */
export function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function cardSvg({ eyebrow, title, lead, accent, address }) {
  const size = title.length > 3 ? 52 : 64;
  const step = Math.round(size * 1.18);
  const top = 170;
  const fonts = path.relative(here, path.join(repo, "docs", "assets", "fonts")).split(path.sep).join("/");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      @font-face { font-family: "Inter"; src: url("${fonts}/inter-latin-var.woff2") format("woff2"); font-weight: 100 900; }
      @font-face { font-family: "JetBrains Mono"; src: url("${fonts}/jetbrains-mono-latin-var.woff2") format("woff2"); font-weight: 100 800; }
      .sans { font-family: "Inter", sans-serif; }
      .mono { font-family: "JetBrains Mono", monospace; }
    </style>
    <radialGradient id="glow" cx="62%" cy="0%" r="85%"><stop offset="0%" stop-color="#0e1422" /><stop offset="60%" stop-color="#07090f" /></radialGradient>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${accent}" stop-opacity="0.18" /><stop offset="100%" stop-color="${accent}" stop-opacity="0" /></radialGradient>
    <linearGradient id="mark" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#18c8b2" /><stop offset="100%" stop-color="#17bca9" /></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)" />
  <ellipse cx="1010" cy="300" rx="380" ry="300" fill="url(#halo)" />
  <g fill="none" stroke="${accent}" stroke-opacity="0.5" stroke-width="2">
    <circle cx="1010" cy="300" r="120" /><circle cx="1010" cy="300" r="200" stroke-opacity="0.25" /><circle cx="1010" cy="300" r="280" stroke-opacity="0.12" />
  </g>
  <circle cx="1010" cy="300" r="14" fill="${accent}" />
  <circle cx="1130" cy="300" r="7" fill="${accent}" fill-opacity="0.8" />
  <circle cx="868" cy="159" r="6" fill="${accent}" fill-opacity="0.6" />
  <text x="64" y="96" class="mono" font-size="19" font-weight="500" letter-spacing="3.5" fill="${accent}">${escapeXml(eyebrow)}</text>
  <text class="sans" font-size="${size}" font-weight="700" letter-spacing="-1.5" fill="#e9ecf3">
    ${title.map((line, index) => `<tspan x="62" y="${top + index * step}">${escapeXml(line)}</tspan>`).join("\n    ")}
  </text>
  <text x="64" y="${top + title.length * step + 18}" class="sans" font-size="24" fill="#9aa3b5">${escapeXml(lead)}</text>
  <g transform="translate(64 528) scale(0.04297)">
    <rect width="1024" height="1024" rx="96" fill="#f2f2f2" />
    <g fill="none" stroke="url(#mark)" stroke-width="36" stroke-linecap="round" stroke-linejoin="round">
      <path d="M262 332 L500 94 Q540 56 578 92" /><path d="M262 522 L560 224" /><path d="M262 742 Q226 778 262 814" />
      <path d="M454 742 L724 472 Q760 436 796 472" /><path d="M454 932 L760 626" /><path d="M698 124 Q740 90 776 124 Q802 146 790 180" />
    </g>
  </g>
  <text x="124" y="561" class="sans" font-size="32" font-weight="700" fill="#e9ecf3">L²M</text>
  <text x="204" y="559" class="mono" font-size="21" fill="#9aa3b5">${escapeXml(address)}</text>
</svg>
`;
}

/** Markdown pages under a folder that ask for their own card. */
function flagshipPages(folder) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md") && name !== "index.md") {
        const source = readFileSync(full, "utf8");
        const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        if (!/^socialCard:\s*true\s*$/m.test(fm)) continue;
        const title = (fm.match(/^title:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
        found.push({ relativePath: path.relative(docsSrc, full).split(path.sep).join("/"), title });
      }
    }
  };
  if (existsSync(path.join(docsSrc, folder))) walk(path.join(docsSrc, folder));
  return found;
}

const jobs = [];
if (!process.argv.includes("--pages-only")) {
  for (const section of SECTIONS) jobs.push({ file: path.join(outDir, `${section.id}.png`), svg: cardSvg({ ...section, address: `lsquarem.com/docs/${section.id}` }) });
}
for (const folder of ["learn", "blog"]) {
  const section = SECTIONS.find((item) => item.id === folder);
  for (const page of flagshipPages(folder)) {
    const name = `${page.relativePath.replace(/\.md$/, "").replace(/\//g, "--")}.png`;
    const lines = wrap(page.title, 22).slice(0, 4);
    jobs.push({
      file: path.join(outDir, "pages", name),
      svg: cardSvg({ eyebrow: section.eyebrow, title: lines, lead: "", accent: section.accent, address: `lsquarem.com/docs/${page.relativePath.replace(/\.md$/, "")}`.slice(0, 60) })
    });
  }
}

await fs.mkdir(path.join(outDir, "pages"), { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const job of jobs) {
    const source = path.join(here, `.render-${process.pid}.svg`);
    await fs.writeFile(source, job.svg);
    try {
      await page.goto(pathToFileURL(source).href, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: job.file, type: "png", clip: { x: 0, y: 0, width: 1200, height: 630 } });
    } finally {
      await fs.rm(source, { force: true });
    }
    const { size } = await fs.stat(job.file);
    console.log(`Wrote ${path.relative(repo, job.file)} (${Math.round(size / 1024)} KB)`);
    if (size > maxBytes) {
      console.error(`  over ${maxBytes / 1024} KB`);
      failed = true;
    }
  }
} finally {
  await browser.close();
}
if (failed) process.exit(1);
