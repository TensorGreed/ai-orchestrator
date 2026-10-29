// Static search-engine checks on the assembled lsquarem.com site (see scripts/assemble-pages-site.mjs).
// scripts/check-pages-site.mjs runs them before its browser checks; `--seo-only` runs only these.
//
//   - robots.txt is at the root and points at https://lsquarem.com/sitemap.xml;
//   - sitemap.xml is at the root, lists only absolute https://lsquarem.com/ URLs of pages that exist
//     and may be indexed, never /demo/, and lists every indexable page;
//   - every indexable page (any HTML page but the demo, 404 pages and pages marked noindex) has a
//     lang, a title, a meta description and a canonical URL that is its own https://lsquarem.com/
//     address, and no two share a title or a description;
//   - the demo (/demo/) is marked noindex;
//   - the landing's JSON-LD parses and names schema.org types.
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

export const SITE = "https://lsquarem.com";

const decode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** The attributes of every `<tag ...>` in the HTML, lower-cased names, decoded values. */
function tags(html, tag) {
  const found = [];
  for (const [, body] of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))) {
    const attrs = {};
    for (const [, name, , doubleQuoted, singleQuoted, bare] of body.matchAll(/([\w:-]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[name.toLowerCase()] = decode(doubleQuoted ?? singleQuoted ?? bare ?? "");
    }
    found.push(attrs);
  }
  return found;
}

export function pageHead(html) {
  const head = html.slice(0, Math.max(html.search(/<\/head>/i), 0)) || html;
  const metas = tags(head, "meta");
  const meta = (key, value) => metas.find((attrs) => attrs[key]?.toLowerCase() === value)?.content?.trim() ?? "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return {
    lang: tags(html, "html")[0]?.lang ?? "",
    title: titleMatch ? decode(titleMatch[1]).trim() : "",
    description: meta("name", "description"),
    robots: meta("name", "robots").toLowerCase(),
    canonical: tags(head, "link").find((attrs) => attrs.rel?.toLowerCase() === "canonical")?.href?.trim() ?? ""
  };
}

/** The public addresses of a page file: `docs/a.html` → /docs/a and /docs/a.html, `x/index.html` → /x/. */
function addressesOf(relativeFile) {
  const web = relativeFile.split(path.sep).join("/");
  if (web === "index.html") return [`${SITE}/`];
  if (web.endsWith("/index.html")) return [`${SITE}/${web.slice(0, -"index.html".length)}`];
  return [`${SITE}/${web}`, `${SITE}/${web.slice(0, -".html".length)}`];
}

/** The page file a sitemap URL is served from, the way GitHub Pages resolves it. */
function fileOf(site, url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const target = path.join(site, pathname);
  const candidates = pathname.endsWith("/") ? [path.join(target, "index.html")] : [target, `${target}.html`, path.join(target, "index.html")];
  return candidates.find((file) => file.endsWith(".html") && existsSync(file)) ?? null;
}

async function htmlFiles(dir, root = dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(full, root)));
    else if (entry.name.endsWith(".html")) files.push(path.relative(root, full));
  }
  return files.sort();
}

/** Runs every check on the assembled site; returns what passed and what failed. */
export async function checkSeo(site) {
  const failures = [];
  const passes = [];
  const fail = (message) => failures.push(message);
  const pass = (message) => passes.push(message);

  // robots.txt
  const robotsFile = path.join(site, "robots.txt");
  if (!existsSync(robotsFile)) {
    fail("robots.txt is missing from the site root");
  } else {
    const robots = await fs.readFile(robotsFile, "utf8");
    if (!new RegExp(`^\\s*Sitemap:\\s*${SITE}/sitemap\\.xml\\s*$`, "mi").test(robots)) fail(`robots.txt does not point at ${SITE}/sitemap.xml`);
    else if (/^\s*Disallow:\s*\/\s*$/mi.test(robots)) fail("robots.txt disallows the whole site");
    else pass("robots.txt points at the sitemap");
  }

  // Indexable pages and their metadata.
  const indexable = new Map();
  const titles = new Map();
  const descriptions = new Map();
  for (const file of await htmlFiles(site)) {
    const web = file.split(path.sep).join("/");
    const html = await fs.readFile(path.join(site, file), "utf8");
    const head = pageHead(html);
    if (web === "demo/index.html") {
      head.robots.includes("noindex") ? pass("/demo/ is marked noindex") : fail('/demo/ has no <meta name="robots" content="noindex">');
      continue;
    }
    if (web.startsWith("demo/") || path.basename(web) === "404.html" || head.robots.includes("noindex")) continue;
    const addresses = addressesOf(file);
    indexable.set(web, addresses);
    const where = `/${web}`;
    if (!head.lang) fail(`${where}: <html> has no lang`);
    if (!head.title) fail(`${where}: no <title>`);
    if (!head.description) fail(`${where}: no meta description`);
    if (!head.canonical) fail(`${where}: no canonical URL`);
    else if (!addresses.includes(head.canonical)) fail(`${where}: canonical ${head.canonical} is not the page's own address (${addresses.join(" or ")})`);
    if (head.title) titles.set(head.title, [...(titles.get(head.title) ?? []), where]);
    if (head.description) descriptions.set(head.description, [...(descriptions.get(head.description) ?? []), where]);
  }
  if (!existsSync(path.join(site, "demo", "index.html"))) fail("/demo/index.html is missing");
  for (const [title, pages] of titles) if (pages.length > 1) fail(`the title "${title}" is used by ${pages.join(", ")}`);
  for (const [description, pages] of descriptions) if (pages.length > 1) fail(`one meta description is used by ${pages.join(", ")}: "${description.slice(0, 80)}…"`);
  pass(`${indexable.size} indexable pages checked for lang, title, description and canonical`);

  // sitemap.xml
  const sitemapFile = path.join(site, "sitemap.xml");
  if (!existsSync(sitemapFile)) {
    fail("sitemap.xml is missing from the site root");
  } else {
    const urls = [...(await fs.readFile(sitemapFile, "utf8")).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => decode(match[1]));
    if (urls.length === 0) fail("sitemap.xml lists no URLs");
    const listed = new Set();
    for (const url of urls) {
      if (!url.startsWith(`${SITE}/`)) {
        fail(`sitemap URL is not an absolute ${SITE}/ URL: ${url}`);
        continue;
      }
      if (new URL(url).pathname.startsWith("/demo")) {
        fail(`sitemap lists the demo: ${url}`);
        continue;
      }
      const file = fileOf(site, url);
      if (!file) {
        fail(`sitemap URL has no page: ${url}`);
        continue;
      }
      const web = path.relative(site, file).split(path.sep).join("/");
      if (!indexable.has(web)) fail(`sitemap lists a page that is not indexable: ${url}`);
      listed.add(web);
    }
    for (const web of indexable.keys()) if (!listed.has(web)) fail(`/${web} is indexable but not in sitemap.xml`);
    pass(`sitemap.xml lists ${urls.length} URLs`);
  }

  // JSON-LD on the landing.
  const landing = path.join(site, "index.html");
  if (existsSync(landing)) {
    const html = await fs.readFile(landing, "utf8");
    const blocks = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    if (blocks.length === 0) fail("the landing (/) has no JSON-LD");
    for (const [index, block] of blocks.entries()) {
      let data;
      try {
        data = JSON.parse(block);
      } catch (error) {
        fail(`the landing's JSON-LD block ${index + 1} does not parse: ${error.message}`);
        continue;
      }
      const context = data["@context"];
      if (typeof context !== "string" || !/^https?:\/\/schema\.org\/?$/.test(context)) fail(`the landing's JSON-LD block ${index + 1} has no schema.org @context`);
      const items = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      for (const item of items) if (typeof item?.["@type"] !== "string" || item["@type"].trim() === "") fail(`the landing's JSON-LD block ${index + 1} has an item without @type`);
      if (/aggregateRating|"review"/.test(block)) fail(`the landing's JSON-LD block ${index + 1} carries ratings or reviews`);
    }
    if (blocks.length > 0) pass(`the landing's JSON-LD parses (${blocks.length} block${blocks.length === 1 ? "" : "s"})`);
  }

  return { failures, passes };
}
