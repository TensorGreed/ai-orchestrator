// Assembles the lsquarem.com Pages artifact (see .github/workflows/pages.yml):
//   /        the marketing landing (`docs/`)
//   /docs/   the VitePress build (`apps/docs/docs/.vitepress/dist`)
//   /demo/   the static live demo (`apps/web/dist-demo`), only when it built
//   /sitemap.xml  one sitemap for the site: the indexable landing pages, then every docs page
//                 from the VitePress sitemap (which is folded in and not published on its own);
//                 the demo is an app shell marked noindex and stays out of it
//
// The landing, the docs, their sitemap and the CNAME check are required. The demo is not:
// without a usable demo build the site is assembled without /demo/ and a
// GitHub Actions warning says so.
//
//   node scripts/assemble-pages-site.mjs [--root <repo>] [--out <dir outside the repo>]
//   DEMO_OUTCOME=<outcome of the demo build step> names it in the warning.
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`::error title=Pages site not assembled::${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
/** An option's value; given without one (or as ""), it is an error rather than a default. */
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) fail(`${name} needs a directory.`);
  return value;
};

const repoRoot = path.resolve(option("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const out = path.resolve(option("--out") ?? path.join(repoRoot, "_site"));

// The output folder is deleted first. It is either the default `_site/` in the repository or a
// folder outside it; never another folder in the repository, the filesystem root, or a folder
// holding the repository or the current directory.
const holds = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const defaultOut = path.join(repoRoot, "_site");
const allowed = out === defaultOut || !holds(repoRoot, out);
if (!allowed || out === path.parse(out).root || holds(out, repoRoot) || holds(out, process.cwd())) {
  fail(`Refusing to use ${out} as the output folder: use the default ${defaultOut} or a folder outside the repository that holds neither it nor the current directory.`);
}

async function demoBuildIsUsable(dir) {
  const index = path.join(dir, "index.html");
  if (!existsSync(index)) return false;
  if (!(await fs.readFile(index, "utf8")).includes('src="/demo/assets/')) return false;
  const assets = path.join(dir, "assets");
  return existsSync(assets) && (await fs.readdir(assets)).some((name) => name.endsWith(".js"));
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

// 1. Marketing landing at the root.
await fs.cp(path.join(repoRoot, "docs"), out, { recursive: true });

// 2. Product docs at /docs/.
const docsBuild = path.join(repoRoot, "apps", "docs", "docs", ".vitepress", "dist");
if (!existsSync(path.join(docsBuild, "index.html"))) fail(`No docs build at ${path.relative(repoRoot, docsBuild)}.`);
await fs.cp(docsBuild, path.join(out, "docs"), { recursive: true });

// 3. One sitemap at the root: the landing pages (not 404.html or any page marked noindex), then the docs.
const SITE = "https://lsquarem.com";
const docsSitemap = path.join(out, "docs", "sitemap.xml");
if (!existsSync(docsSitemap)) fail("The docs build has no sitemap.xml (VitePress `sitemap` option).");
const docsUrls = [...(await fs.readFile(docsSitemap, "utf8")).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
if (docsUrls.length === 0) fail("The docs sitemap lists no pages.");
const landingUrls = [];
for (const name of (await fs.readdir(out)).filter((file) => file.endsWith(".html") && file !== "404.html").sort()) {
  const html = await fs.readFile(path.join(out, name), "utf8");
  if (/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(html)) continue;
  landingUrls.push(name === "index.html" ? `${SITE}/` : `${SITE}/${name}`);
}
landingUrls.sort((a, b) => (a === `${SITE}/` ? -1 : b === `${SITE}/` ? 1 : a.localeCompare(b)));
const escapeXml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (value) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...[...new Set([...landingUrls, ...docsUrls.map(unescapeXml)])].map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`),
  "</urlset>",
  ""
].join("\n");
await fs.writeFile(path.join(out, "sitemap.xml"), sitemap);
await fs.rm(docsSitemap);
console.log(`Wrote sitemap.xml: ${landingUrls.length} landing page(s) and ${docsUrls.length} docs page(s)`);

// 4. Pages needs the CNAME at the site root.
const cname = path.join(out, "CNAME");
if (!existsSync(cname) || !(await fs.readFile(cname, "utf8")).includes("lsquarem.com")) fail("CNAME for lsquarem.com is missing from the site root.");

// 5. The live demo at /demo/, when it built.
const demoBuild = path.join(repoRoot, "apps", "web", "dist-demo");
if (await demoBuildIsUsable(demoBuild)) {
  await fs.cp(demoBuild, path.join(out, "demo"), { recursive: true });
  console.log("Assembled /demo/ from apps/web/dist-demo");
} else {
  const outcome = process.env.DEMO_OUTCOME ? ` (demo build: ${process.env.DEMO_OUTCOME})` : "";
  console.log(`::warning title=Live demo not deployed::apps/web/dist-demo has no usable build${outcome}; the site deploys without /demo/.`);
}

console.log(`Assembled ${path.relative(repoRoot, out) || out}: ${(await fs.readdir(out)).sort().join(", ")}`);
