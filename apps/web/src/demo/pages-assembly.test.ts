import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/assemble-pages-site.mjs, which the Pages workflow runs to put the landing, docs and demo together,
// and scripts/check-pages-site.mjs, whose static search-engine checks (`--seo-only`) guard the result.
const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts");
const script = path.join(scripts, "assemble-pages-site.mjs");
const checkScript = path.join(scripts, "check-pages-site.mjs");
const roots: string[] = [];

function write(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** A breadcrumb trail as JSON-LD: [name, url] pairs. */
function crumbs(...items: Array<[string, string]>) {
  const list = items.map(([name, item], index) => ({ "@type": "ListItem", position: index + 1, name, item }));
  return `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "BreadcrumbList", itemListElement: list }] })}</script>`;
}

/** A page the search-engine checks accept. */
function page(title: string, canonical: string, extraHead = "", body = "") {
  return `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}." /><link rel="canonical" href="${canonical}" />${extraHead}</head><body><h1 id="top">${title}</h1>${body}</body></html>`;
}

/** The visible breadcrumb trail the docs theme renders, as [name, url] pairs; the last one is the page itself, not a link. */
function trail(...items: Array<[string, string]>) {
  const entries = items.map(([name, url], index) => {
    const separator = index > 0 ? '<svg aria-hidden="true"><path d="M6 3l5 5"/></svg>' : "";
    return `<li>${separator}${index === items.length - 1 ? `<span aria-current="page">${name}</span>` : `<a href="${url}">${name}</a>`}</li>`;
  });
  return `<nav class="hub-breadcrumbs" aria-label="Breadcrumb"><ol><!--[-->${entries.join("")}<!--]--></ol></nav>`;
}

const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SoftwareApplication","name":"L2M"}]}</script>';
const docsCrumb = crumbs(["Docs", "https://lsquarem.com/docs/"]);

function repo(options: { demo?: "built" | "broken" | "missing"; cname?: boolean; docsSitemap?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-pages-"));
  roots.push(root);
  write(root, "docs/index.html", page("L2M", "https://lsquarem.com/", jsonLd, '<a href="./docs/">Docs</a> <a href="./integrations.html">Integrations</a>'));
  write(root, "docs/integrations.html", page("L2M integrations", "https://lsquarem.com/integrations.html", crumbs(["L2M", "https://lsquarem.com/"], ["Integrations", "https://lsquarem.com/integrations.html"])));
  write(root, "docs/404.html", '<html lang="en"><head><title>Not found</title><meta name="robots" content="noindex" /></head></html>');
  write(root, "docs/robots.txt", "User-agent: *\nAllow: /\n\nSitemap: https://lsquarem.com/sitemap.xml\n");
  if (options.cname !== false) write(root, "docs/CNAME", "lsquarem.com\n");
  write(root, "apps/docs/docs/.vitepress/dist/index.html", page("L2M documentation", "https://lsquarem.com/docs/", docsCrumb, '<a href="/docs/guide/start">Start</a> <a href="/docs/learn/">Learn</a>'));
  write(root, "apps/docs/docs/.vitepress/dist/guide/start.html", page("Start | L2M", "https://lsquarem.com/docs/guide/start", crumbs(["Docs", "https://lsquarem.com/docs/"], ["Start", "https://lsquarem.com/docs/guide/start"]), trail(["Docs", "https://lsquarem.com/docs/"], ["Start", "https://lsquarem.com/docs/guide/start"])));
  write(
    root,
    "apps/docs/docs/.vitepress/dist/learn/index.html",
    page("Learn | L2M", "https://lsquarem.com/docs/learn/", crumbs(["Docs", "https://lsquarem.com/docs/"], ["Learn", "https://lsquarem.com/docs/learn/"]), `${trail(["Docs", "https://lsquarem.com/docs/"], ["Learn", "https://lsquarem.com/docs/learn/"])}<a href="/docs/learn/basics/loop#top">The loop</a>`)
  );
  write(
    root,
    "apps/docs/docs/.vitepress/dist/learn/basics/loop.html",
    page(
      "The loop | L2M",
      "https://lsquarem.com/docs/learn/basics/loop",
      crumbs(["L2M", "https://lsquarem.com/"], ["Docs", "https://lsquarem.com/docs/"], ["Learn", "https://lsquarem.com/docs/learn/"], ["The loop", "https://lsquarem.com/docs/learn/basics/loop"]),
      trail(["L2M", "https://lsquarem.com/"], ["Docs", "/docs/"], ["Learn", "/docs/learn/"], ["The loop", "https://lsquarem.com/docs/learn/basics/loop"])
    )
  );
  write(root, "apps/docs/docs/.vitepress/dist/404.html", '<html lang="en"><head><title>404 | L2M</title><meta name="robots" content="noindex"></head></html>');
  if (options.docsSitemap !== false) {
    write(
      root,
      "apps/docs/docs/.vitepress/dist/sitemap.xml",
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://lsquarem.com/docs/</loc><lastmod>2026-11-01T10:00:00.000Z</lastmod></url><url><loc>https://lsquarem.com/docs/guide/start</loc><lastmod>2026-11-02T10:00:00.000Z</lastmod></url><url><loc>https://lsquarem.com/docs/learn/</loc><lastmod>2026-11-03T10:00:00.000Z</lastmod></url><url><loc>https://lsquarem.com/docs/learn/basics/loop</loc><lastmod>2026-11-04T10:00:00.000Z</lastmod></url></urlset>'
    );
  }
  if (options.demo === "built") {
    write(root, "apps/web/dist-demo/index.html", '<meta name="robots" content="noindex" /><script type="module" src="/demo/assets/index-abc.js"></script>');
    write(root, "apps/web/dist-demo/assets/index-abc.js", "console.log(1)");
  }
  if (options.demo === "broken") write(root, "apps/web/dist-demo/index.html", '<script type="module" src="/src/main.tsx"></script>');
  return root;
}

function checkSeo(site: string, baseline: { longTitles?: string[]; longDescriptions?: string[] } = {}) {
  const baselineFile = path.join(site, "..", "seo-baseline.json");
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  const result = spawnSync(process.execPath, [checkScript, "--seo-only", "--site", site, "--baseline", baselineFile], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function edit(site: string, file: string, change: (content: string) => string) {
  const target = path.join(site, file);
  fs.writeFileSync(target, change(fs.readFileSync(target, "utf8")));
}

function assemble(root: string, env: Record<string, string> = {}, extraArgs: string[] = [], cwd?: string) {
  const result = spawnSync(process.execPath, [script, "--root", root, ...extraArgs], { encoding: "utf8", env: { ...process.env, ...env }, ...(cwd ? { cwd } : {}) });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, site: path.join(root, "_site") };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("the Pages site", () => {
  it("mounts the landing, the docs and a built demo", () => {
    const run = assemble(repo({ demo: "built" }));
    expect(run.status, run.output).toBe(0);
    for (const file of ["index.html", "CNAME", "docs/index.html", "demo/index.html", "demo/assets/index-abc.js"]) expect(fs.existsSync(path.join(run.site, file)), file).toBe(true);
    expect(run.output).not.toContain("::warning");
  });

  it("still deploys the landing and the docs when the demo did not build, with a warning", () => {
    for (const demo of ["missing", "broken"] as const) {
      const run = assemble(repo({ demo }), { DEMO_OUTCOME: "failure" });
      expect(run.status, run.output).toBe(0);
      expect(fs.existsSync(path.join(run.site, "index.html"))).toBe(true);
      expect(fs.existsSync(path.join(run.site, "docs/index.html"))).toBe(true);
      expect(fs.existsSync(path.join(run.site, "demo"))).toBe(false);
      expect(run.output).toContain("::warning title=Live demo not deployed::");
      expect(run.output).toContain("demo build: failure");
    }
  });

  it("refuses an output folder it would delete wrongly: empty, missing, the root, or one holding the repository or the current directory", () => {
    const root = repo({ demo: "built" });
    const nested = path.join(root, "work");
    fs.mkdirSync(nested);
    write(nested, "keep.txt", "keep");
    for (const extra of [["--out", ""], ["--out", "  "], ["--out"], ["--out", "--root"], ["--out", "/"], ["--out", root], ["--out", path.dirname(root)], ["--out", "."], ["--out", ".."]]) {
      const run = assemble(root, {}, extra, nested);
      expect(run.status, JSON.stringify(extra)).toBe(1);
      expect(run.output).toContain("::error");
    }
    // Everything is still there.
    expect(fs.readFileSync(path.join(nested, "keep.txt"), "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(root, "docs/index.html"))).toBe(true);
    // The default _site/ in the repository and a folder outside it work.
    expect(assemble(root, {}, ["--out", path.join(root, "_site")]).status).toBe(0);
    expect(fs.existsSync(path.join(root, "_site/demo/index.html"))).toBe(true);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-pages-out-"));
    roots.push(outside);
    expect(assemble(root, {}, ["--out", path.join(outside, "site")]).status).toBe(0);
    expect(fs.existsSync(path.join(outside, "site/docs/index.html"))).toBe(true);
  });

  it("refuses any other folder in the repository, such as apps/, and deletes nothing", () => {
    const root = repo({ demo: "built" });
    write(root, "apps/keep.txt", "keep");
    const before = fs.readdirSync(path.join(root, "apps")).sort();
    for (const out of [path.join(root, "apps"), path.join(root, "apps", "web"), path.join(root, "docs"), path.join(root, "new-site"), path.join(root, "_site", "nested")]) {
      const run = assemble(root, {}, ["--out", out]);
      expect(run.status, out).toBe(1);
      expect(run.output, out).toContain("::error");
    }
    expect(fs.readFileSync(path.join(root, "apps/keep.txt"), "utf8")).toBe("keep");
    expect(fs.readdirSync(path.join(root, "apps")).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, "apps/web/dist-demo/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs/CNAME"))).toBe(true);
    expect(fs.existsSync(path.join(root, "new-site"))).toBe(false);
  });

  it("fails without the CNAME, demo or not", () => {
    const run = assemble(repo({ demo: "built", cname: false }));
    expect(run.status).toBe(1);
    expect(run.output).toContain("CNAME");
  });

  it("writes one root sitemap: the indexable landing pages first, then the docs, without the demo or 404 pages", () => {
    const run = assemble(repo({ demo: "built" }));
    expect(run.status, run.output).toBe(0);
    const sitemap = fs.readFileSync(path.join(run.site, "sitemap.xml"), "utf8");
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(urls).toEqual([
      "https://lsquarem.com/",
      "https://lsquarem.com/integrations.html",
      "https://lsquarem.com/docs/",
      "https://lsquarem.com/docs/guide/start",
      "https://lsquarem.com/docs/learn/",
      "https://lsquarem.com/docs/learn/basics/loop"
    ]);
    // A docs page keeps the lastmod VitePress gave it.
    expect(sitemap).toContain("<url><loc>https://lsquarem.com/docs/</loc><lastmod>2026-11-01T10:00:00.000Z</lastmod></url>");
    expect(fs.existsSync(path.join(run.site, "docs/sitemap.xml"))).toBe(false);
    expect(fs.existsSync(path.join(run.site, "robots.txt"))).toBe(true);
  });

  it("fails without a docs sitemap", () => {
    const run = assemble(repo({ demo: "built", docsSitemap: false }));
    expect(run.status).toBe(1);
    expect(run.output).toContain("sitemap");
  });
});

describe("the search-engine checks on the assembled site", () => {
  function site() {
    const run = assemble(repo({ demo: "built" }));
    expect(run.status, run.output).toBe(0);
    return run.site;
  }

  it("pass on a complete site", () => {
    const run = checkSeo(site());
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("All checks passed.");
  });

  it("fail without robots.txt or the sitemap", () => {
    const withoutRobots = site();
    fs.rmSync(path.join(withoutRobots, "robots.txt"));
    expect(checkSeo(withoutRobots).output).toContain("robots.txt is missing");
    const withoutSitemap = site();
    fs.rmSync(path.join(withoutSitemap, "sitemap.xml"));
    const run = checkSeo(withoutSitemap);
    expect(run.status).toBe(1);
    expect(run.output).toContain("sitemap.xml is missing");
  });

  it("fail when a sitemap URL is not an absolute https://lsquarem.com/ URL, or lists the demo", () => {
    const relative = site();
    edit(relative, "sitemap.xml", (xml) => xml.replace("https://lsquarem.com/docs/guide/start", "/docs/guide/start"));
    const run = checkSeo(relative);
    expect(run.status).toBe(1);
    expect(run.output).toContain("sitemap URL is not an absolute https://lsquarem.com/ URL: /docs/guide/start");
    const otherHost = site();
    edit(otherHost, "sitemap.xml", (xml) => xml.replace("https://lsquarem.com/integrations.html", "http://lsquarem.com/integrations.html"));
    expect(checkSeo(otherHost).output).toContain("not an absolute https://lsquarem.com/ URL");
    const demo = site();
    edit(demo, "sitemap.xml", (xml) => xml.replace("</urlset>", "<url><loc>https://lsquarem.com/demo/</loc></url></urlset>"));
    expect(checkSeo(demo).output).toContain("sitemap lists the demo");
  });

  it("fail when an indexable page lacks a title, a description or its canonical URL", () => {
    for (const [change, message] of [
      [(html: string) => html.replace(/<title>[^<]*<\/title>/, ""), "/docs/guide/start.html: no <title>"],
      [(html: string) => html.replace(/<meta name="description"[^>]*>/, ""), "/docs/guide/start.html: no meta description"],
      [(html: string) => html.replace(/<link rel="canonical"[^>]*>/, ""), "/docs/guide/start.html: no canonical URL"],
      [(html: string) => html.replace("https://lsquarem.com/docs/guide/start", "https://lsquarem.com/docs/"), "canonical https://lsquarem.com/docs/ is not the page's own address"]
    ] as const) {
      const target = site();
      edit(target, "docs/guide/start.html", change);
      const run = checkSeo(target);
      expect(run.status, message).toBe(1);
      expect(run.output).toContain(message);
    }
  });

  it("fail when the demo is not marked noindex", () => {
    const target = site();
    edit(target, "demo/index.html", (html) => html.replace('<meta name="robots" content="noindex" />', ""));
    const run = checkSeo(target);
    expect(run.status).toBe(1);
    expect(run.output).toContain("/demo/ has no <meta name=\"robots\" content=\"noindex\">");
  });

  it("fail when the landing's JSON-LD is missing or does not parse", () => {
    const broken = site();
    edit(broken, "index.html", (html) => html.replace('"name":"L2M"}]}', '"name":"L2M"]}'));
    const run = checkSeo(broken);
    expect(run.status).toBe(1);
    expect(run.output).toContain("JSON-LD block 1 does not parse");
    const missing = site();
    edit(missing, "index.html", (html) => html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ""));
    expect(checkSeo(missing).output).toContain("the landing (/) has no JSON-LD");
  });

  it("fail on a title over 60 or a description over 155 characters, unless the page is on the baseline, and on a stale baseline entry", () => {
    const long = site();
    edit(long, "docs/guide/start.html", (html) => html.replace("<title>Start | L2M</title>", `<title>${"A very long title ".repeat(4)}| L2M</title>`).replace('content="About Start | L2M."', `content="${"word ".repeat(40)}"`));
    const run = checkSeo(long);
    expect(run.status).toBe(1);
    expect(run.output).toContain("/docs/guide/start.html: the title is 77 characters (at most 60)");
    expect(run.output).toContain("/docs/guide/start.html: the description is 199 characters (at most 155)");
    const allowed = checkSeo(long, { longTitles: ["/docs/guide/start.html"], longDescriptions: ["/docs/guide/start.html"] });
    expect(allowed.status, allowed.output).toBe(0);
    expect(allowed.output).toContain("listed in scripts/pages-seo-baseline.json");
    const stale = checkSeo(site(), { longTitles: ["/docs/guide/start.html"] });
    expect(stale.status).toBe(1);
    expect(stale.output).toContain("no longer too long (or gone): remove the entry");
  });

  it("fail on a broken internal link, a missing fragment or a section index linked without its slash", () => {
    for (const [ref, message] of [
      ["/docs/guide/missing", "/docs/guide/missing has no page or file"],
      ["/docs/guide/start#nowhere", "names a fragment that is not on docs/guide/start.html"],
      ["/docs/learn", "leaves out the trailing slash of a section index"],
      ["https://lsquarem.com/nope.html", "https://lsquarem.com/nope.html has no page or file"]
    ] as const) {
      const target = site();
      edit(target, "integrations.html", (html) => html.replace("</body>", `<a href="${ref}">x</a></body>`));
      const run = checkSeo(target);
      expect(run.status, ref).toBe(1);
      expect(run.output).toContain(message);
    }
  });

  it("fail when a knowledge-hub page is linked from nowhere but the nav", () => {
    const target = site();
    edit(target, "docs/learn/index.html", (html) => html.replace('<a href="/docs/learn/basics/loop#top">The loop</a>', ""));
    const run = checkSeo(target);
    expect(run.status).toBe(1);
    expect(run.output).toContain("/docs/learn/basics/loop.html is an orphan");
  });

  it("fail when a docs page outside the knowledge hub is linked from nowhere but the nav", () => {
    const target = site();
    edit(target, "docs/index.html", (html) => html.replace('<a href="/docs/guide/start">Start</a>', ""));
    const run = checkSeo(target);
    expect(run.status).toBe(1);
    expect(run.output).toContain("/docs/guide/start.html is an orphan");
    // A link from the landing's header or footer, or from a 404 page, does not count either.
    const navOnly = site();
    edit(navOnly, "index.html", (html) => html.replace('<a href="./integrations.html">Integrations</a>', "").replace("<body>", '<body><header><a href="./integrations.html">Integrations</a></header>'));
    edit(navOnly, "404.html", (html) => html.replace("</html>", '<body><a href="/integrations.html">Integrations</a></body></html>'));
    expect(checkSeo(navOnly).output).toContain("/integrations.html is an orphan");
  });

  it("fail when a docs page shows no breadcrumb trail, or one that differs from its BreadcrumbList", () => {
    const hidden = site();
    edit(hidden, "docs/guide/start.html", (html) => html.replace(/<nav class="hub-breadcrumbs"[\s\S]*?<\/nav>/, ""));
    expect(checkSeo(hidden).output).toContain("/docs/guide/start.html: shows no breadcrumb trail, but its JSON-LD has a BreadcrumbList");
    const different = site();
    edit(different, "docs/learn/basics/loop.html", (html) => html.replace('<span aria-current="page">The loop</span>', '<span aria-current="page">Loop</span>'));
    const run = checkSeo(different);
    expect(run.status).toBe(1);
    expect(run.output).toContain('shows the breadcrumbs "L2M › Docs › Learn › Loop", but its JSON-LD says "L2M › Docs › Learn › The loop"');
    // One crumb named "L2M › Docs" is not the two crumbs "L2M" and "Docs".
    const merged = site();
    edit(merged, "docs/learn/basics/loop.html", (html) =>
      html.replace(/<li><a href="https:\/\/lsquarem\.com\/">L2M<\/a><\/li><li><svg[\s\S]*?<\/svg><a href="\/docs\/">Docs<\/a><\/li>/, '<li><a href="https://lsquarem.com/">L2M › Docs</a></li>')
    );
    const mergedRun = checkSeo(merged);
    expect(mergedRun.status).toBe(1);
    expect(mergedRun.output).toContain('shows the breadcrumbs "L2M › Docs › Learn › The loop", but its JSON-LD says "L2M › Docs › Learn › The loop"');
    const twice = site();
    edit(twice, "docs/guide/start.html", (html) => html.replace("</body>", `${trail(["Docs", "https://lsquarem.com/docs/"], ["Start", "https://lsquarem.com/docs/guide/start"])}</body>`));
    expect(checkSeo(twice).output).toContain("/docs/guide/start.html: shows 2 breadcrumb trails (one per page)");
    const elsewhere = site();
    edit(elsewhere, "docs/learn/basics/loop.html", (html) => html.replace('<a href="/docs/learn/">Learn</a>', '<a href="/docs/guide/start">Learn</a>'));
    expect(checkSeo(elsewhere).output).toContain('/docs/learn/basics/loop.html: the breadcrumb "Learn" links /docs/guide/start, not where its JSON-LD item points');
  });

  it("show no trail on the docs home, and need none there", () => {
    const target = site();
    expect(fs.readFileSync(path.join(target, "docs/index.html"), "utf8")).not.toContain('aria-label="Breadcrumb"');
    expect(checkSeo(target).status).toBe(0);
  });

  it("fail on an article without valid dates, dated in the future, or modified before it was published", () => {
    const article = (dates: Record<string, string>) =>
      `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "TechArticle", headline: "Start", ...dates }] })}</script>`;
    const cases: Array<[Record<string, string>, string]> = [
      [{ dateModified: "2026-11-02T10:00:00.000Z" }, "the TechArticle has no valid datePublished (missing)"],
      [{ datePublished: "2026-11-01", dateModified: "last Tuesday" }, "the TechArticle has no valid dateModified (last Tuesday)"],
      [{ datePublished: "2026-11-01", dateModified: "2999-01-01T00:00:00Z" }, "dateModified 2999-01-01T00:00:00.000Z is in the future"],
      [{ datePublished: "2026-11-05", dateModified: "2026-11-01T00:00:00Z" }, "was modified (2026-11-01T00:00:00Z) before it was published (2026-11-05)"],
      [{ datePublished: "2026-02-30", dateModified: "2026-11-01T00:00:00Z" }, "the TechArticle has no valid datePublished (2026-02-30)"],
      [{ datePublished: "2026-11-01", dateModified: "2026-11-01T25:00:00Z" }, "the TechArticle has no valid dateModified (2026-11-01T25:00:00Z)"]
    ];
    for (const [dates, message] of cases) {
      const target = site();
      edit(target, "docs/guide/start.html", (html) => html.replace("</head>", `${article(dates)}</head>`));
      const run = checkSeo(target);
      expect(run.status, message).toBe(1);
      expect(run.output).toContain(message);
    }
    const good = site();
    // Published late on 2 November in New York, modified early that day in UTC: the same day, not "before".
    edit(good, "docs/guide/start.html", (html) => html.replace("</head>", `${article({ datePublished: "2026-11-01T22:00:00-05:00", dateModified: "2026-11-02T09:00:00Z" })}</head>`));
    const run = checkSeo(good);
    expect(run.status, run.output).toBe(0);
    const twoArticles = site();
    edit(twoArticles, "docs/guide/start.html", (html) => html.replace("</head>", `${article({ datePublished: "2026-10-01", dateModified: "2026-11-02T09:00:00Z" })}${article({ datePublished: "2026-10-01", dateModified: "2026-11-02T09:00:00Z" })}</head>`));
    expect(checkSeo(twoArticles).output).toContain("/docs/guide/start.html: has 2 articles in its JSON-LD (one per page)");
  });

  it("fail on a docs sitemap entry without <lastmod>, a <lastmod> that is not a date or is in the future, or one that disagrees with dateModified", () => {
    const cases: Array<[(xml: string) => string, string]> = [
      [(xml) => xml.replace("<lastmod>2026-11-02T10:00:00.000Z</lastmod>", ""), "sitemap entry https://lsquarem.com/docs/guide/start has no <lastmod>"],
      [(xml) => xml.replace("2026-11-02T10:00:00.000Z", "yesterday"), "has a <lastmod> that is not a W3C date: yesterday"],
      [(xml) => xml.replace("2026-11-02T10:00:00.000Z", "2999-01-01"), "has a <lastmod> in the future: 2999-01-01"]
    ];
    for (const [change, message] of cases) {
      const target = site();
      edit(target, "sitemap.xml", change);
      const run = checkSeo(target);
      expect(run.status, message).toBe(1);
      expect(run.output).toContain(message);
    }
    const stale = site();
    const article = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "TechArticle", datePublished: "2026-10-01", dateModified: "2026-11-09T10:00:00Z" }] })}</script>`;
    edit(stale, "docs/guide/start.html", (html) => html.replace("</head>", `${article}</head>`));
    expect(checkSeo(stale).output).toContain("sitemap lists https://lsquarem.com/docs/guide/start as modified 2026-11-02T10:00:00.000Z, but its JSON-LD dateModified is 2026-11-09T10:00:00.000Z");
    // A date-only <lastmod> and an evening dateModified in UTC-5 on the same day agree.
    const sameDay = site();
    edit(sameDay, "sitemap.xml", (xml) => xml.replace("2026-11-02T10:00:00.000Z", "2026-11-02"));
    const evening = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "TechArticle", datePublished: "2026-10-01", dateModified: "2026-11-02T23:30:00-05:00" }] })}</script>`;
    edit(sameDay, "docs/guide/start.html", (html) => html.replace("</head>", `${evening}</head>`));
    const run = checkSeo(sameDay);
    expect(run.status, run.output).toBe(0);
  });

  it("fail on an image without width and height, or a stylesheet or font from another origin", () => {
    const image = site();
    edit(image, "docs/guide/start.html", (html) => html.replace("</body>", '<img src="/docs/guide/start" alt="x" width="10"></body>'));
    expect(checkSeo(image).output).toContain('/docs/guide/start.html: <img src="/docs/guide/start"> has no width and height');
    const sized = site();
    edit(sized, "docs/guide/start.html", (html) => html.replace("</body>", '<img src="/docs/guide/start" alt="x" width="10" height="10"></body>'));
    expect(checkSeo(sized).status).toBe(0);
    const fonts = site();
    edit(fonts, "integrations.html", (html) => html.replace("</head>", '<link rel="stylesheet" href="https://fonts.example.org/css?family=Inter"></head>'));
    expect(checkSeo(fonts).output).toContain("/integrations.html: loads stylesheet https://fonts.example.org/css?family=Inter from another origin");
    const preconnect = site();
    edit(preconnect, "integrations.html", (html) => html.replace("</head>", '<link rel="preconnect" href="https://fonts.example.org"><link rel="modulepreload" href="/docs/guide/start"></head>'));
    const run = checkSeo(preconnect);
    expect(run.output).toContain("/integrations.html: loads preconnect https://fonts.example.org from another origin");
    expect(run.output).not.toContain("loads modulepreload");
  });

  it("fail when the landing or a blog page does not link the feed", () => {
    const feedLink = '<link rel="alternate" type="application/atom+xml" title="L2M blog" href="https://lsquarem.com/docs/blog/feed.xml" />';
    const blog = (landingLinksFeed: boolean) => {
      const target = site();
      write(target, "docs/blog/feed.xml", '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>L2M blog</title></feed>\n');
      write(
        target,
        "docs/blog/index.html",
        page("Blog | L2M", "https://lsquarem.com/docs/blog/", `${feedLink}${crumbs(["Docs", "https://lsquarem.com/docs/"], ["Blog", "https://lsquarem.com/docs/blog/"])}`, trail(["Docs", "https://lsquarem.com/docs/"], ["Blog", "https://lsquarem.com/docs/blog/"]))
      );
      edit(target, "sitemap.xml", (xml) => xml.replace("</urlset>", "<url><loc>https://lsquarem.com/docs/blog/</loc><lastmod>2026-11-05T10:00:00.000Z</lastmod></url></urlset>"));
      edit(target, "docs/index.html", (html) => html.replace("</body>", '<a href="/docs/blog/">Blog</a></body>'));
      if (landingLinksFeed) edit(target, "index.html", (html) => html.replace("</head>", `${feedLink}</head>`));
      return target;
    };
    const linked = checkSeo(blog(true));
    expect(linked.status, linked.output).toBe(0);
    const run = checkSeo(blog(false));
    expect(run.status).toBe(1);
    expect(run.output).toContain('/index.html: no <link rel="alternate" type="application/atom+xml"> to https://lsquarem.com/docs/blog/feed.xml in its head');
    const blogPage = blog(true);
    edit(blogPage, "docs/blog/index.html", (html) => html.replace(feedLink, ""));
    expect(checkSeo(blogPage).output).toContain('/docs/blog/index.html: no <link rel="alternate" type="application/atom+xml"> to https://lsquarem.com/docs/blog/feed.xml in its head');
  });

  it("fail when a page's JSON-LD does not parse, has no BreadcrumbList, or a breadcrumb points off the site", () => {
    const broken = site();
    edit(broken, "docs/guide/start.html", (html) => html.replace('"@graph"', '"@graph" oops'));
    expect(checkSeo(broken).output).toContain("/docs/guide/start.html: JSON-LD block 1 does not parse");
    const noCrumbs = site();
    edit(noCrumbs, "docs/guide/start.html", (html) => html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ""));
    expect(checkSeo(noCrumbs).output).toContain("/docs/guide/start.html: no JSON-LD");
    const wrongType = site();
    edit(wrongType, "docs/guide/start.html", (html) => html.replace('"BreadcrumbList"', '"WebPage"'));
    expect(checkSeo(wrongType).output).toContain("/docs/guide/start.html: no BreadcrumbList in its JSON-LD");
    const offSite = site();
    edit(offSite, "docs/guide/start.html", (html) => html.replace('"item":"https://lsquarem.com/docs/guide/start"', '"item":"https://example.org/start"'));
    expect(checkSeo(offSite).output).toContain("breadcrumb 2 points at https://example.org/start, which is not a page of the site");
  });

  it("fail on a banned word in visible text, but not in code", () => {
    // The competing tool's name is built from its letters, so it never sits in the repository.
    const competitor = ["n", "8", "n"].join("");
    const words: Array<[string, string]> = [
      [competitor, "the competing workflow tool's name"],
      ["Guard", "Guard"],
      ["DLP", "DLP"]
    ];
    for (const [word, label] of words) {
      const target = site();
      edit(target, "docs/guide/start.html", (html) => html.replace("</body>", `<p>Compare it with ${word} today.</p></body>`));
      const run = checkSeo(target);
      expect(run.status, word).toBe(1);
      expect(run.output).toContain(`shows the banned word "${label}"`);
    }
    const inAlt = site();
    edit(inAlt, "docs/guide/start.html", (html) => html.replace("</body>", '<img src="/docs/guide/start" alt="the DLP screen"></body>'));
    expect(checkSeo(inAlt).output).toContain('shows the banned word "DLP"');
    const inCode = site();
    edit(inCode, "docs/guide/start.html", (html) => html.replace("</body>", `<p>Set <code>GUARD_MODE</code>.</p><pre><code>Guard DLP</code></pre><p>Safeguards and guardrails are fine.</p></body>`));
    const run = checkSeo(inCode);
    expect(run.status, run.output).toBe(0);
    // The competing tool's name is refused anywhere in a built text file, code and scripts included.
    const competitorInCode = site();
    edit(competitorInCode, "docs/guide/start.html", (html) => html.replace("</body>", `<p>Map <code>${competitor}-nodes-base.webhook</code>.</p></body>`));
    const named = checkSeo(competitorInCode);
    expect(named.status).toBe(1);
    expect(named.output).toContain("names the competing workflow tool");
  });

  it("fail when a sitemap URL is not the page's canonical form, or the blog has no feed", () => {
    const target = site();
    edit(target, "sitemap.xml", (xml) => xml.replace("https://lsquarem.com/docs/guide/start<", "https://lsquarem.com/docs/guide/start.html<"));
    expect(checkSeo(target).output).toContain("sitemap lists https://lsquarem.com/docs/guide/start.html, but the page's canonical is https://lsquarem.com/docs/guide/start");
    const blog = site();
    write(blog, "docs/blog/index.html", page("Blog | L2M", "https://lsquarem.com/docs/blog/", crumbs(["Docs", "https://lsquarem.com/docs/"], ["Blog", "https://lsquarem.com/docs/blog/"])));
    expect(checkSeo(blog).output).toContain("the blog has no feed at /docs/blog/feed.xml");
  });
});
