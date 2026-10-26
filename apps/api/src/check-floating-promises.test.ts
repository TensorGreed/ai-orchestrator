/**
 * The promise misuse check (`pnpm lint` in apps/api) over a fixture: every line marked `expect: <kind>` is reported
 * with that kind, and no line marked `clean:` is.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(apiRoot, "scripts/fixtures/promise-misuse");

describe("check-floating-promises", () => {
  it("reports union-typed promises in conditions and comparisons, and un-awaited returns inside try", () => {
    const result = spawnSync(process.execPath, ["scripts/check-floating-promises.mjs", "--only", path.join(fixtureDir, "tsconfig.json")], {
      cwd: apiRoot,
      encoding: "utf8"
    });
    expect(result.status, result.stderr).toBe(1);
    const reported = new Map<number, string>();
    for (const line of result.stdout.split("\n")) {
      const match = /misuse\.ts:(\d+)\s+(\S+)/.exec(line);
      if (match) reported.set(Number(match[1]), match[2]!);
    }
    const source = fs.readFileSync(path.join(fixtureDir, "misuse.ts"), "utf8").split("\n");
    const expected = new Map<number, string>();
    source.forEach((text, index) => {
      const want = /\/\/ expect: (\S+)/.exec(text);
      if (want) expected.set(index + 1, want[1]!);
    });
    expect(expected.size).toBeGreaterThan(4);
    expect(Object.fromEntries(reported)).toEqual(Object.fromEntries(expected));
  }, 60_000);
});
