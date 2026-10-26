import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Strings only the demo carries: fake-backend code, the banner, recorded fixtures. */
const DEMO_MARKERS = ["l2m-demo:state:v1", "everything runs in your browser", "wf-demo-support-agent", "Support agent with MCP tools and memory"];

/** Builds one mode into a temp folder in a child process (esbuild cannot run inside jsdom). */
function bundle(mode: "production" | "demo"): { code: string; html: string; css: string } {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `l2m-web-${mode}-`));
  try {
    const vite = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
    execFileSync(process.execPath, [vite, "build", "--mode", mode, "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], { cwd: webRoot, stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } });
    const read = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? read(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    const files = read(outDir);
    const text = (suffix: string) => files.filter((file) => file.endsWith(suffix)).map((file) => fs.readFileSync(file, "utf8")).join("\n");
    return { code: text(".js"), html: text(".html"), css: text(".css") };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

describe("the demo stays out of normal builds", () => {
  it("only the demo build carries demo code and fixtures; the normal build is untouched", () => {
    const normal = bundle("production");
    // Plain booleans: a failing diff of a whole bundle helps nobody.
    for (const marker of DEMO_MARKERS) expect(normal.code.includes(marker), `normal build contains "${marker}"`).toBe(false);
    expect(normal.html).toContain('src="/assets/');

    const demo = bundle("demo");
    for (const marker of DEMO_MARKERS) expect(demo.code.includes(marker), `demo build lacks "${marker}"`).toBe(true);
    expect(demo.html).toContain('src="/demo/assets/');
    // The demo makes no request off its own origin.
    expect(`${demo.code}\n${demo.html}\n${demo.css}`.includes("fonts.googleapis.com"), "demo build loads remote fonts").toBe(false);
  }, 240_000);

  it("no module outside src/demo imports from it", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== path.join(webRoot, "src", "demo")) walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && /from\s+["'][^"']*\/demo\//.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(webRoot, full));
        }
      }
    };
    walk(path.join(webRoot, "src"));
    expect(offenders).toEqual([]);
  });
});
