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
//   - links to a section index end in "/" (without it GitHub Pages answers with a redirect);
//   - every docs page but the docs home shows a breadcrumb trail with the same names as its
//     BreadcrumbList (less the leading "L2M" crumb);
//   - every article in the JSON-LD (TechArticle, BlogPosting) has a datePublished and a dateModified
//     that are W3C dates, not in the future, modified no earlier than published;
//   - every image has a width and a height (no layout shift), and no page loads a stylesheet, font or
//     preconnect from another origin;
//   - every indexable page but the landing is linked from the content of another page (an orphan
//     reached only from the nav or sidebar fails);
//   - each sitemap URL is its page's canonical URL; every docs URL has a <lastmod>, each <lastmod> is
//     a W3C date, not in the future, and the same day as the page's JSON-LD dateModified;
//   - the docs blog has its Atom feed at /docs/blog/feed.xml, every post it links is in the sitemap,
//     and the landing and every blog page link it from their head;
//   - no page shows a banned word (see BANNED_WORDS: the old names of content rules and data rules,
//     an external key manager's vendor name, and a competing workflow tool's name) in its visible text, title, description or
//     alt/aria-label/title attributes. Code is exempt: text inside <code>, <pre>, <kbd>, <samp>,
//     <script>, <style> and <svg> is not visible prose, so a config key or a node type id that
//     must be typed literally (such as `GUARD_*`) may appear in code;
//   - no text file of the built site (HTML, scripts, styles, XML, JSON, text, SVG, the demo included)
//     contains the competing workflow tool's name anywhere, code included, in any case. Images and
//     fonts are not read, and data: URIs inside text files are skipped.
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
 * The visible breadcrumb trails of a page (each `<nav aria-label="Breadcrumb">`): per trail, its items'
 * names and link targets (`href` is undefined for the current page, which is not a link).
 */
export function visibleBreadcrumbs(html) {
  return [...html.matchAll(/<nav\b[^>]*aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/gi)].map((nav) =>
    [...nav[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => ({
      name: decode(item[1].replace(/<svg\b[\s\S]*?<\/svg>/gi, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim(),
      href: tags(item[1], "a")[0]?.href
    }))
  );
}

/** A W3C date or date-time (the forms sitemaps and schema.org dates use), as a Date; null when it is not one. */
export function w3cDate(value) {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-](\d{2}):(\d{2})))?$/) : null;
  if (!match) return null;
  const [, year, month, day, , hour = "0", minute = "0", , second = "0", , , offsetHours = "0", offsetMinutes = "0"] = match;
  // A real calendar day (no 2026-02-30, which Date would roll over to March) and a real time of day.
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHours) > 23 || Number(offsetMinutes) > 59) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const ARTICLE_TYPES = new Set(["Article", "TechArticle", "BlogPosting", "NewsArticle"]);
/** A day of leeway for dates in the future: build machines and git committers sit in different time zones. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** Two dates of "the same day" may be up to 36 hours apart once time zones are counted (UTC-12 to UTC+14). */
const SAME_DAY_MS = 36 * 60 * 60 * 1000;

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

/** The competing workflow tool's name, built from its letters so it never sits in the repository. */
const COMPETITOR_NAME = new RegExp(`(?<![a-z0-9])${["n", "8", "n"].join("")}(?![a-z0-9])`, "i");
/** File types of the built site that are read as text by the name check. */
export const SITE_TEXT_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".xml", ".txt", ".json", ".webmanifest", ".svg", ".md", ".map"]);

/**
 * Where a text file of the built site names the competing workflow tool, with a little context, or
 * null. Unlike the banned-word check this covers code too (a node type id in a table, a bundled
 * string). It is not part of a longer word or token (so a hash such as `a1n8nb` passes), and data:
 * URIs are skipped, since base64 can spell anything.
 */
export function competitorNameIn(text) {
  const scanned = text.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[^"'()\s]*/gi, " ");
  const match = COMPETITOR_NAME.exec(scanned);
  if (!match) return null;
  const at = match.index;
  return scanned.slice(Math.max(0, at - 40), at + match[0].length + 40).replace(/\s+/g, " ").trim();
}

/** Every file of the site whose type is in SITE_TEXT_EXTENSIONS, as paths relative to the site. */
async function textFiles(dir, root = dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await textFiles(full, root)));
    else if (SITE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(path.relative(root, full));
  }
  return files.sort();
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

/**
 * The part of a page that counts for inbound links: a docs page's content area (#VPContent) up to
 * the doc footer (edit link, last-updated date, previous / next pager), without the breadcrumbs,
 * since those only repeat the sidebar and the nav; a landing page's body without its header, nav and footer.
 */
export function contentOf(web, html) {
  if (!web.startsWith("docs/")) return html.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, "");
  const start = html.indexOf('id="VPContent"');
  if (start < 0) return html;
  const ends = ['class="VPDocFooter', "<script"].map((marker) => html.indexOf(marker, start)).filter((index) => index > start);
  return html.slice(start, ends.length > 0 ? Math.min(...ends) : undefined).replace(/<nav\b[^>]*class="[^"]*hub-breadcrumbs[\s\S]*?<\/nav>/g, "");
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

async function readBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { title: new Set(), description: new Set() };
  const data = JSON.parse(await fs.readFile(file, "utf8"));
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
  const baseline = options.baseline ?? (await readBaseline(options.baselineFile));

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
  const canonicals = new Map();
  const titles = new Map();
  const descriptions = new Map();
  const seenLong = { title: new Set(), description: new Set() };
  const brokenLinks = [];
  let linkCount = 0;
  let breadcrumbPages = 0;
  let jsonLdPages = 0;
  const pages = [];
  /** Per indexable page: the names in its JSON-LD BreadcrumbList and its article's dateModified. */
  const jsonLdCrumbs = new Map();
  const modifiedDates = new Map();
  const now = options.now ?? Date.now();
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
    canonicals.set(web, head.canonical);
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
      let articles = 0;
      let breadcrumbLists = 0;
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
          if (ARTICLE_TYPES.has(item?.["@type"])) {
            articles += 1;
            // Article dates: both present, real W3C dates, not in the future, and modified no earlier than published.
            const published = w3cDate(item.datePublished);
            const modified = w3cDate(item.dateModified);
            if (!published) fail(`${where}: the ${item["@type"]} has no valid datePublished (${item.datePublished ?? "missing"})`);
            if (!modified) fail(`${where}: the ${item["@type"]} has no valid dateModified (${item.dateModified ?? "missing"})`);
            for (const [name, date] of [["datePublished", published], ["dateModified", modified]]) {
              if (date && date.getTime() > now + DAY_MS) fail(`${where}: the ${item["@type"]}'s ${name} ${date.toISOString()} is in the future`);
            }
            if (published && modified && modified.getTime() + DAY_MS < published.getTime()) fail(`${where}: the ${item["@type"]} was modified (${item.dateModified}) before it was published (${item.datePublished})`);
            if (modified) modifiedDates.set(web, modified);
          }
          if (item?.["@type"] === "BreadcrumbList") {
            const elements = Array.isArray(item.itemListElement) ? item.itemListElement : [];
            breadcrumbLists += 1;
            jsonLdCrumbs.set(
              web,
              elements.map((element) => ({ name: String(element?.name ?? "").trim(), url: typeof element?.item === "string" ? element.item : element?.item?.["@id"] }))
            );
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
      // One trail and one article per page: a second one would contradict the first (and only one is checked).
      if (breadcrumbLists > 1) fail(`${where}: has ${breadcrumbLists} BreadcrumbLists in its JSON-LD (one per page)`);
      if (articles > 1) fail(`${where}: has ${articles} articles in its JSON-LD (one per page)`);
    }

    // The docs show exactly the trail their BreadcrumbList describes, once (structured data must match
    // what the page shows): the same names in the same order, each link going where its JSON-LD item
    // says. The docs home is where the trail starts and shows none.
    if (web.startsWith("docs/") && web !== "docs/index.html" && jsonLdCrumbs.has(web)) {
      const trails = visibleBreadcrumbs(html);
      const described = jsonLdCrumbs.get(web);
      const names = (items) => items.map((item) => item.name);
      if (trails.length === 0) fail(`${where}: shows no breadcrumb trail, but its JSON-LD has a BreadcrumbList`);
      else if (trails.length > 1) fail(`${where}: shows ${trails.length} breadcrumb trails (one per page)`);
      else if (JSON.stringify(names(trails[0])) !== JSON.stringify(names(described))) {
        fail(`${where}: shows the breadcrumbs "${names(trails[0]).join(" › ")}", but its JSON-LD says "${names(described).join(" › ")}"`);
      } else {
        const wrong = trails[0].find((item, index) => {
          if (item.href === undefined) return index !== trails[0].length - 1;
          try {
            return new URL(item.href, `${SITE}/${web}`).href !== described[index].url;
          } catch {
            return true;
          }
        });
        if (wrong) fail(`${where}: the breadcrumb "${wrong.name}" links ${wrong.href ?? "nowhere"}, not where its JSON-LD item points`);
        else breadcrumbPages += 1;
      }
    }

    // Layout shift: every image carries its width and height, so the browser reserves its box.
    for (const attrs of tags(html, "img")) {
      if (!attrs.width || !attrs.height) fail(`${where}: <img src="${attrs.src ?? ""}"> has no width and height (it shifts the layout when it loads)`);
    }
    // Render-blocking: no stylesheet or font from another origin (fonts are self-hosted).
    for (const attrs of tags(html, "link")) {
      const rel = (attrs.rel ?? "").toLowerCase();
      if (!/\bstylesheet\b|\bpreload\b|\bpreconnect\b/.test(rel) || !attrs.href) continue;
      let url;
      try {
        url = new URL(attrs.href, `${SITE}/${web}`);
      } catch {
        continue;
      }
      if (url.origin !== SITE) fail(`${where}: loads ${rel} ${attrs.href} from another origin (self-host it)`);
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
  if (jsonLdPages > 0) pass(`JSON-LD parses on ${jsonLdPages} pages, with a BreadcrumbList on all but the landing, and valid article dates`);
  if (breadcrumbPages > 0) pass(`${breadcrumbPages} docs pages show the breadcrumb trail their JSON-LD describes`);
  if (warnings.length > 0) pass(`${warnings.length} long title(s) or description(s) are on the baseline (warnings)`);

  // Internal links and assets, with fragments; links in the canonical form; inbound links for orphans.
  const inbound = new Map();
  for (const { web, html } of pages) {
    const base = addressesOf(web).at(-1);
    // Only indexable pages give a page an inbound link: a 404 page or a noindex page passes nothing on.
    const contentLinks = new Set(indexable.has(web) ? references(contentOf(web, html)) : []);
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
      if (file.endsWith(`${path.sep}index.html`) && !url.pathname.endsWith("/") && !url.pathname.endsWith(".html")) {
        brokenLinks.push(`/${web}: ${ref} leaves out the trailing slash of a section index (GitHub Pages answers it with a redirect); link ${url.pathname}/`);
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
      const target = path.relative(site, file).split(path.sep).join("/");
      if (target !== web && file.endsWith(".html") && contentLinks.has(ref)) {
        if (!inbound.has(target)) inbound.set(target, new Set());
        inbound.get(target).add(web);
      }
    }
  }
  for (const message of brokenLinks) fail(`broken link: ${message}`);
  pass(`${linkCount} internal links and assets checked on ${pages.length} pages`);

  // Orphans: every indexable page but the landing is linked from the content of another page, not
  // only from the nav and sidebar (search engines find and weigh pages through links in content).
  const linkedPages = [...indexable.keys()].filter((web) => web !== "index.html");
  for (const web of linkedPages) if (!inbound.has(web)) fail(`/${web} is an orphan: no other page links to it from its content (nav and sidebar do not count)`);
  if (linkedPages.length > 0) pass(`${linkedPages.length} pages checked for inbound links from content`);

  // The blog's feed.
  const feed = path.join(site, "docs", "blog", "feed.xml");
  if (existsSync(path.join(site, "docs", "blog", "index.html"))) {
    if (!existsSync(feed)) fail("the blog has no feed at /docs/blog/feed.xml");
    else if (!/^<\?xml[^>]*\?>\s*<feed\s+xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/.test(await fs.readFile(feed, "utf8"))) fail("/docs/blog/feed.xml is not an Atom feed");
    else pass("/docs/blog/feed.xml is an Atom feed");
    // Feed readers find the feed from the landing and from the blog's pages.
    const feedUrl = `${SITE}/docs/blog/feed.xml`;
    for (const { web, html } of pages) {
      if (web !== "index.html" && !web.startsWith("docs/blog/")) continue;
      const links = tags(html.slice(0, Math.max(html.search(/<\/head>/i), 0)), "link").filter((attrs) => attrs.rel?.toLowerCase() === "alternate" && /application\/(atom|rss)\+xml/i.test(attrs.type ?? ""));
      if (!links.some((attrs) => new URL(attrs.href ?? "", `${SITE}/${web}`).href === feedUrl)) fail(`/${web}: no <link rel="alternate" type="application/atom+xml"> to ${feedUrl} in its head`);
    }
  }

  // sitemap.xml
  const sitemapFile = path.join(site, "sitemap.xml");
  if (!existsSync(sitemapFile)) {
    fail("sitemap.xml is missing from the site root");
  } else {
    const sitemapXml = await fs.readFile(sitemapFile, "utf8");
    const urls = [...sitemapXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => decode(match[1]));
    // <lastmod>: search engines use it only while it stays accurate. Every docs page has one (from git);
    // a landing page has one when git dated its file. Each is a W3C date, not in the future, and the
    // same day as the page's own dateModified (within 36 hours, so time zones never make it fail).
    const lastmods = new Map();
    for (const [, entry] of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = decode(entry.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1] ?? "");
      const raw = entry.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1];
      if (raw === undefined) {
        if (loc.startsWith(`${SITE}/docs/`)) fail(`sitemap entry ${loc} has no <lastmod>`);
        continue;
      }
      const date = w3cDate(raw);
      if (!date) fail(`sitemap entry ${loc} has a <lastmod> that is not a W3C date: ${raw}`);
      else if (date.getTime() > now + DAY_MS) fail(`sitemap entry ${loc} has a <lastmod> in the future: ${raw}`);
      else lastmods.set(loc, date);
    }
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
      else if (canonicals.get(web) && canonicals.get(web) !== url) fail(`sitemap lists ${url}, but the page's canonical is ${canonicals.get(web)}`);
      const modified = modifiedDates.get(web);
      const lastmod = lastmods.get(url);
      if (modified && lastmod && Math.abs(modified.getTime() - lastmod.getTime()) > SAME_DAY_MS) {
        fail(`sitemap lists ${url} as modified ${lastmod.toISOString()}, but its JSON-LD dateModified is ${modified.toISOString()}`);
      }
      listed.add(web);
    }
    for (const web of indexable.keys()) if (!listed.has(web)) fail(`/${web} is indexable but not in sitemap.xml`);
    if (existsSync(feed)) {
      const inSitemap = new Set(urls);
      for (const [, href] of (await fs.readFile(feed, "utf8")).matchAll(/<entry>[\s\S]*?<link[^>]*href="([^"]+)"[\s\S]*?<\/entry>/g)) {
        if (!inSitemap.has(decode(href))) fail(`the feed links ${decode(href)}, which is not in sitemap.xml`);
      }
    }
    pass(`sitemap.xml lists ${urls.length} URLs`);
  }

  // The competing workflow tool's name in any text file, code and the demo included.
  let textFileCount = 0;
  let namedFiles = 0;
  for (const file of await textFiles(site)) {
    textFileCount += 1;
    const context = competitorNameIn(await fs.readFile(path.join(site, file), "utf8"));
    if (context !== null) {
      namedFiles += 1;
      fail(`/${file.split(path.sep).join("/")}: names the competing workflow tool (…${context}…)`);
    }
  }
  if (namedFiles === 0) pass(`no text file of the site names the competing workflow tool (${textFileCount} files read)`);

  // The landing must have JSON-LD (checked per page above); say so plainly when it has none.
  const landing = path.join(site, "index.html");
  if (existsSync(landing) && jsonLdBlocks(await fs.readFile(landing, "utf8")).length === 0) fail("the landing (/) has no JSON-LD");

  return { failures, passes, warnings };
}
