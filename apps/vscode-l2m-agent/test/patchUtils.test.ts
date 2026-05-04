import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyUnifiedDiff,
  extractPatchFile,
  resolveWorkspacePath,
  validateSingleFilePatch
} from "../src/patchUtils";

describe("patch utilities", () => {
  it("rejects action targets outside the workspace", () => {
    const root = path.resolve("workspace-root");

    expect(resolveWorkspacePath(root, "src/app.ts")).toMatchObject({
      relativePath: "src/app.ts"
    });
    expect(() => resolveWorkspacePath(root, "../outside.ts")).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath(root, path.resolve("outside.ts"))).toThrow(/outside the workspace/);
  });

  it("extracts and validates a single patch target", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new"
    ].join("\n");

    expect(extractPatchFile(diff, undefined)).toBe("src/app.ts");
    expect(() => validateSingleFilePatch(diff, "src/app.ts")).not.toThrow();
    expect(() => validateSingleFilePatch(diff, "src/other.ts")).toThrow(/does not match/);
  });

  it("rejects multi-file patches in one action", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+A",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-b",
      "+B"
    ].join("\n");

    expect(() => validateSingleFilePatch(diff, "src/a.ts")).toThrow(/single-file/);
  });

  it("applies supported unified diffs and detects context mismatches", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three"
    ].join("\n");

    expect(applyUnifiedDiff("one\ntwo\nthree\n", diff)).toBe("one\nTWO\nthree");
    expect(() => applyUnifiedDiff("one\nwrong\nthree\n", diff)).toThrow(/context mismatch/);
  });
});
