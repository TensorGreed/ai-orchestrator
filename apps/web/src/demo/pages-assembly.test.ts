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

/** A page head the search-engine checks accept. */
function page(title: string, canonical: string, extraHead = "") {
  return `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="About ${title}." /><link rel="canonical" href="${canonical}" />${extraHead}</head><body><h1>${title}</h1></body></html>`;
}

const jsonLd = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SoftwareApplication","name":"L2M"}]}</script>';

function repo(options: { demo?: "built" | "broken" | "missing"; cname?: boolean; docsSitemap?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-pages-"));
  roots.push(root);
  write(root, "docs/index.html", page("L2M", "https://lsquarem.com/", jsonLd));
  write(root, "docs/integrations.html", page("L2M integrations", "https://lsquarem.com/integrations.html"));
  write(root, "docs/404.html", '<html lang="en"><head><title>Not found</title><meta name="robots" content="noindex" /></head></html>');
  write(root, "docs/robots.txt", "User-agent: *\nAllow: /\n\nSitemap: https://lsquarem.com/sitemap.xml\n");
  if (options.cname !== false) write(root, "docs/CNAME", "lsquarem.com\n");
  write(root, "apps/docs/docs/.vitepress/dist/index.html", page("L2M documentation", "https://lsquarem.com/docs/"));
  write(root, "apps/docs/docs/.vitepress/dist/guide/start.html", page("Start | L2M", "https://lsquarem.com/docs/guide/start"));
  write(root, "apps/docs/docs/.vitepress/dist/404.html", '<html lang="en"><head><title>404 | L2M</title><meta name="robots" content="noindex"></head></html>');
  if (options.docsSitemap !== false) {
    write(
      root,
      "apps/docs/docs/.vitepress/dist/sitemap.xml",
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://lsquarem.com/docs/</loc></url><url><loc>https://lsquarem.com/docs/guide/start</loc></url></urlset>'
    );
  }
  if (options.demo === "built") {
    write(root, "apps/web/dist-demo/index.html", '<meta name="robots" content="noindex" /><script type="module" src="/demo/assets/index-abc.js"></script>');
    write(root, "apps/web/dist-demo/assets/index-abc.js", "console.log(1)");
  }
  if (options.demo === "broken") write(root, "apps/web/dist-demo/index.html", '<script type="module" src="/src/main.tsx"></script>');
  return root;
}

function checkSeo(site: string) {
  const result = spawnSync(process.execPath, [checkScript, "--seo-only", "--site", site], { encoding: "utf8" });
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
    expect(urls).toEqual(["https://lsquarem.com/", "https://lsquarem.com/integrations.html", "https://lsquarem.com/docs/", "https://lsquarem.com/docs/guide/start"]);
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
});
