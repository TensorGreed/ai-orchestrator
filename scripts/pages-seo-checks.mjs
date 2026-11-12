// Static search-engine and content checks on the assembled lsquarem.com site (see
// scripts/assemble-pages-site.mjs). scripts/check-pages-site.mjs runs them before its browser
// checks; `--seo-only` runs only these.
//
//   - robots.txt is at the root and points at https://lsquarem.com/sitemap.xml;
//   - sitemap.xml is at the root, lists only absolute https://lsquarem.com/ URLs of pages that exist
//     and may be indexed, never /demo/, and lists every indexable page;
//   - every indexable page (any HTML page but the demo, 404 pages and pages marked noindex) has a
//     lang, a title, a meta description and a canonical URL that is its own https://lsquarem.com/
//     address, and no two share a title or a description;
//   - titles are at most 60 characters and descriptions at most 155 (search results cut longer
//     ones). Pages that were already longer when the rule came in are listed in
//     scripts/pages-seo-baseline.json and reported as warnings; the list may only shrink, so an
//     entry whose page now fits (or is gone) fails until it is removed;
//   - every indexable page carries JSON-LD that parses, names a schema.org @context and gives every
//     item an @type; every indexable page but the landing (/) has a BreadcrumbList whose items are
//     pages of the site; the landing has no ratings or reviews;
//   - every internal link and asset (relative, root-relative or https://lsquarem.com/) on every
//     page of the landing and the docs resolves the way GitHub Pages serves it, and every #fragment
//     names an id on the target page;
//   - the docs blog has its Atom feed at /docs/blog/feed.xml;
//   - no page shows a banned word (see BANNED_WORDS: the old names of content rules and data rules,
//     an external key manager's vendor name, and a competing workflow tool's name) in its visible text, title, description or
//     alt/aria-label/title attributes. Code is exempt: text inside <code>, <pre>, <kbd>, <samp>,
//     <script>, <style> and <svg> is not visible prose, so a config key or a node type id that
//     must be typed literally (such as `GUARD_*` or an imported node type id) may appear in code.
import { existsSync, promises as fs, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SITE = "https://lsquarem.com";
export const MAX_TITLE = 60;
export const MAX_DESCRIPTION = 155;

/**
 * Words that must never appear in the site's visible text. Matched as whole words; "Guard" and
 * "DLP" only in that capitalisation, so "guardrail", "safeguard" or "guard against" stay allowed.
 */
export const BANNED_WORDS = [
  // The competing workflow tool's name, built from its letters so it never sits in the repository.
  { word: "the competing workflow tool's name", pattern: new RegExp(`\\b${["n", "8", "n"].join("")}\\b`, "i") },
  { word: "Guard", pattern: /\bGuard\b/ },
  { word: "DLP", pattern: /\bDLP\b/ },
  // The external key manager's vendor name, written as a pattern so the name itself never sits in the repository.
  { word: "the external key manager's vendor name", pattern: /\bcipher\s?trust\b/i }
];

const BASELINE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages-seo-baseline.json");

const ENTITIES = { quot: '"', apos: "'", lt: "<", gt: ">", amp: "&", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rarr: "→", larr: "←", middot: "·" };
const decode = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

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

/** The JSON-LD blocks of a page, raw. */
export function jsonLdBlocks(html) {
  return [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
}

/**
 * The text a reader sees: the body without code, scripts, styles, SVG and comments, plus the
 * title, the meta description and the alt, title and aria-label attributes.
 */
export function visibleText(html) {
  const head = pageHead(html);
  const attributes = [];
  for (const [, , value] of html.matchAll(/\s(alt|title|aria-label)\s*=\s*"([^"]*)"/gi)) attributes.push(decode(value));
  const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|pre|code|kbd|samp|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return [head.title, head.description, ...attributes, decode(body)].join("\n").replace(/[ \t]+/g, " ");
}

/** The banned words a page shows, each with a little context. */
export function bannedWordsIn(html) {
  const text = visibleText(html);
  const hits = [];
  for (const { word, pattern } of BANNED_WORDS) {
    const match = text.match(pattern);
    if (match) {
      const at = match.index ?? 0;
      hits.push({ word, context: text.slice(Math.max(0, at - 40), at + word.length + 40).replace(/\s+/g, " ").trim() });
    }
  }
  return hits;
}

/** The public addresses of a page file: `docs/a.html` → /docs/a and /docs/a.html, `x/index.html` → /x/. */
function addressesOf(relativeFile) {
  const web = relativeFile.split(path.sep).join("/");
  if (web === "index.html") return [`${SITE}/`];
  if (web.endsWith("/index.html")) return [`${SITE}/${web.slice(0, -"index.html".length)}`];
  return [`${SITE}/${web}`, `${SITE}/${web.slice(0, -".html".length)}`];
}

const isFile = (file) => existsSync(file) && statSync(file).isFile();

/** The file a site path is served from, the way GitHub Pages resolves it (`/a` → a.html or a/index.html). */
export function resolveSitePath(site, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = path.join(site, decoded);
  if (!target.startsWith(site)) return null;
  const candidates = decoded.endsWith("/") ? [path.join(target, "index.html")] : [target, `${target}.html`, path.join(target, "index.html")];
  return candidates.find(isFile) ?? null;
}

/** The page file a sitemap URL is served from, the way GitHub Pages resolves it. */
function fileOf(site, url) {
  const file = resolveSitePath(site, new URL(url).pathname);
  return file && file.endsWith(".html") ? file : null;
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

/** Every link and asset reference on a page: anchors, links, images, scripts, sources. */
function references(html) {
  const refs = [];
  for (const attrs of tags(html, "a")) if (attrs.href !== undefined) refs.push(attrs.href);
  for (const attrs of tags(html, "link")) if (attrs.href !== undefined) refs.push(attrs.href);
  for (const tag of ["img", "script", "source", "iframe"]) for (const attrs of tags(html, tag)) if (attrs.src !== undefined) refs.push(attrs.src);
  return refs.map((ref) => ref.trim()).filter((ref) => ref !== "" && ref !== "#");
}

const idCache = new Map();
async function idsOf(file) {
  if (!idCache.has(file)) {
    const html = await fs.readFile(file, "utf8");
    const ids = new Set();
    for (const [, , value] of html.matchAll(/\s(id|name)\s*=\s*"([^"]*)"/gi)) ids.add(decode(value));
    idCache.set(file, ids);
  }
  return idCache.get(file);
}

async function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return { title: new Set(), description: new Set() };
  const data = JSON.parse(await fs.readFile(BASELINE_FILE, "utf8"));
  return { title: new Set(data.longTitles ?? []), description: new Set(data.longDescriptions ?? []) };
}

/** Runs every check on the assembled site; returns what passed, what failed and what only warns. */
export async function checkSeo(site, options = {}) {
  site = path.resolve(site);
  const failures = [];
  const passes = [];
  const warnings = [];
  const fail = (message) => failures.push(message);
  const pass = (message) => passes.push(message);
  const warn = (message) => warnings.push(message);
  const baseline = options.baseline ?? (await readBaseline());

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

  // Every page: metadata on indexable ones, links and banned words on all of them.
  const indexable = new Map();
  const titles = new Map();
  const descriptions = new Map();
  const seenLong = { title: new Set(), description: new Set() };
  const brokenLinks = [];
  let linkCount = 0;
  let jsonLdPages = 0;
  const pages = [];
  for (const file of await htmlFiles(site)) {
    const web = file.split(path.sep).join("/");
    const html = await fs.readFile(path.join(site, file), "utf8");
    const head = pageHead(html);
    if (web === "demo/index.html") {
      head.robots.includes("noindex") ? pass("/demo/ is marked noindex") : fail('/demo/ has no <meta name="robots" content="noindex">');
      continue;
    }
    // The demo is an app shell built by Vite; its own build checks it.
    if (web.startsWith("demo/")) continue;
    pages.push({ web, html });
    const where = `/${web}`;

    for (const { word, context } of bannedWordsIn(html)) fail(`${where}: shows the banned word "${word}" (…${context}…)`);

    if (path.basename(web) === "404.html" || head.robots.includes("noindex")) continue;
    const addresses = addressesOf(file);
    indexable.set(web, addresses);
    if (!head.lang) fail(`${where}: <html> has no lang`);
    if (!head.title) fail(`${where}: no <title>`);
    if (!head.description) fail(`${where}: no meta description`);
    if (!head.canonical) fail(`${where}: no canonical URL`);
    else if (!addresses.includes(head.canonical)) fail(`${where}: canonical ${head.canonical} is not the page's own address (${addresses.join(" or ")})`);
    if (head.title) titles.set(head.title, [...(titles.get(head.title) ?? []), where]);
    if (head.description) descriptions.set(head.description, [...(descriptions.get(head.description) ?? []), where]);
    for (const [kind, value, max] of [["title", head.title, MAX_TITLE], ["description", head.description, MAX_DESCRIPTION]]) {
      if ([...value].length <= max) continue;
      const message = `${where}: the ${kind} is ${[...value].length} characters (at most ${max})`;
      if (baseline[kind].has(where)) {
        seenLong[kind].add(where);
        warn(`${message}, listed in scripts/pages-seo-baseline.json`);
      } else {
        fail(message);
      }
    }

    // JSON-LD.
    const blocks = jsonLdBlocks(html);
    if (blocks.length === 0) {
      fail(`${where}: no JSON-LD`);
    } else {
      jsonLdPages += 1;
      const types = [];
      for (const [index, block] of blocks.entries()) {
        let data;
        try {
          data = JSON.parse(block);
        } catch (error) {
          fail(`${where}: JSON-LD block ${index + 1} does not parse: ${error.message}`);
          continue;
        }
        const context = data["@context"];
        if (typeof context !== "string" || !/^https?:\/\/schema\.org\/?$/.test(context)) fail(`${where}: JSON-LD block ${index + 1} has no schema.org @context`);
        const items = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
        for (const item of items) {
          if (typeof item?.["@type"] !== "string" || item["@type"].trim() === "") fail(`${where}: JSON-LD block ${index + 1} has an item without @type`);
          else types.push(item["@type"]);
          if (item?.["@type"] === "BreadcrumbList") {
            const elements = Array.isArray(item.itemListElement) ? item.itemListElement : [];
            if (elements.length === 0) fail(`${where}: the BreadcrumbList has no items`);
            for (const [position, element] of elements.entries()) {
              if (element?.position !== position + 1) fail(`${where}: breadcrumb ${position + 1} has position ${element?.position}`);
              if (typeof element?.name !== "string" || element.name.trim() === "") fail(`${where}: breadcrumb ${position + 1} has no name`);
              const target = typeof element?.item === "string" ? element.item : element?.item?.["@id"];
              if (typeof target !== "string" || !target.startsWith(`${SITE}/`) || !fileOf(site, target)) fail(`${where}: breadcrumb ${position + 1} points at ${target}, which is not a page of the site`);
            }
          }
        }
        if (/aggregateRating|"review"/.test(block)) fail(`${where}: JSON-LD block ${index + 1} carries ratings or reviews`);
      }
      if (web !== "index.html" && !types.includes("BreadcrumbList")) fail(`${where}: no BreadcrumbList in its JSON-LD`);
    }
  }
  if (!existsSync(path.join(site, "demo", "index.html"))) fail("/demo/index.html is missing");
  for (const [title, where] of titles) if (where.length > 1) fail(`the title "${title}" is used by ${where.join(", ")}`);
  for (const [description, where] of descriptions) if (where.length > 1) fail(`one meta description is used by ${where.join(", ")}: "${description.slice(0, 80)}…"`);
  for (const kind of ["title", "description"]) {
    for (const where of baseline[kind]) {
      if (!seenLong[kind].has(where)) fail(`scripts/pages-seo-baseline.json lists ${where} for a long ${kind}, but it is no longer too long (or gone): remove the entry`);
    }
  }
  pass(`${indexable.size} indexable pages checked for lang, title, description, canonical and length`);
  if (jsonLdPages > 0) pass(`JSON-LD parses on ${jsonLdPages} pages, with a BreadcrumbList on all but the landing`);
  if (warnings.length > 0) pass(`${warnings.length} long title(s) or description(s) are on the baseline (warnings)`);

  // Internal links and assets, with fragments.
  for (const { web, html } of pages) {
    const base = addressesOf(web).at(-1);
    for (const ref of new Set(references(html))) {
      if (/^(mailto|tel|javascript|data|blob):/i.test(ref)) continue;
      let url;
      try {
        url = new URL(ref, base);
      } catch {
        brokenLinks.push(`/${web}: ${ref} is not a valid URL`);
        continue;
      }
      if (url.origin !== SITE) continue;
      linkCount += 1;
      const file = resolveSitePath(site, url.pathname);
      if (!file) {
        brokenLinks.push(`/${web}: ${ref} has no page or file`);
        continue;
      }
      if (url.hash.length > 1 && file.endsWith(".html")) {
        let fragment;
        try {
          fragment = decodeURIComponent(url.hash.slice(1));
        } catch {
          fragment = url.hash.slice(1);
        }
        if (!(await idsOf(file)).has(fragment)) brokenLinks.push(`/${web}: ${ref} names a fragment that is not on ${path.relative(site, file)}`);
      }
    }
  }
  for (const message of brokenLinks) fail(`broken link: ${message}`);
  pass(`${linkCount} internal links and assets checked on ${pages.length} pages`);

  // The blog's feed.
  const feed = path.join(site, "docs", "blog", "feed.xml");
  if (existsSync(path.join(site, "docs", "blog", "index.html"))) {
    if (!existsSync(feed)) fail("the blog has no feed at /docs/blog/feed.xml");
    else if (!/^<\?xml[^>]*\?>\s*<feed\s+xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(await fs.readFile(feed, "utf8"))) fail("/docs/blog/feed.xml is not an Atom feed");
    else pass("/docs/blog/feed.xml is an Atom feed");
  }

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

  // The landing must have JSON-LD (checked per page above); say so plainly when it has none.
  const landing = path.join(site, "index.html");
  if (existsSync(landing) && jsonLdBlocks(await fs.readFile(landing, "utf8")).length === 0) fail("the landing (/) has no JSON-LD");

  return { failures, passes, warnings };
}
