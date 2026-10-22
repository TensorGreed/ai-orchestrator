import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(apiDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

// Vitest's module interop hides CommonJS import problems that crash `pnpm start`
// (tsx on Node's own ESM loader). This loads the guard engine the way the API does.
describe("guard engine under Node's ESM loader", () => {
  it("loads and parses SQL with the default registry", () => {
    const out = execFileSync(tsxBin, [path.join(apiDir, "src", "fixtures", "guard-esm-smoke.mts")], { cwd: apiDir, encoding: "utf8", timeout: 60_000 });
    const result = JSON.parse(out.trim().split("\n").pop()!) as { action: string; detectors: string[] };
    expect(result.action).toBe("block");
    expect(result.detectors).toContain("tool.sql");
  }, 90_000);
});
