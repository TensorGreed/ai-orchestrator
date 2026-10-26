import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// scripts/assemble-pages-site.mjs, which the Pages workflow runs to put the landing, docs and demo together.
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/assemble-pages-site.mjs");
const roots: string[] = [];

function write(root: string, file: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function repo(options: { demo?: "built" | "broken" | "missing"; cname?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-pages-"));
  roots.push(root);
  write(root, "docs/index.html", "<h1>L2M</h1>");
  if (options.cname !== false) write(root, "docs/CNAME", "lsquarem.com\n");
  write(root, "apps/docs/docs/.vitepress/dist/index.html", "<h1>Docs</h1>");
  if (options.demo === "built") {
    write(root, "apps/web/dist-demo/index.html", '<script type="module" src="/demo/assets/index-abc.js"></script>');
    write(root, "apps/web/dist-demo/assets/index-abc.js", "console.log(1)");
  }
  if (options.demo === "broken") write(root, "apps/web/dist-demo/index.html", '<script type="module" src="/src/main.tsx"></script>');
  return root;
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
});
