/**
 * Drift guard for the auto-generated docs at apps/docs/docs/nodes/reference/.
 *
 * If a contributor edits packages/shared/src/definitions.ts but forgets to
 * regenerate the docs, this test fails with the precise list of files that
 * are out of date. Fix is one command:
 *
 *   pnpm --filter @ai-orchestrator/docs gen:nodes
 *
 * Lives here (in @ai-orchestrator/shared) because it asserts a contract on
 * how this package's `nodeDefinitions` is mirrored downstream.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GENERATED_DIR = path.join(REPO_ROOT, "apps", "docs", "docs", "nodes", "reference");

describe("node reference docs are in lock-step with packages/shared/definitions.ts", () => {
  it("regenerator produces no diff against the committed files", () => {
    if (!fs.existsSync(GENERATED_DIR)) {
      // Fresh checkout that hasn't run gen:nodes — skip rather than fail.
      // CI runs `pnpm docs:build` (or equivalent) before this test in the
      // happy path; if you see this skip locally, run `pnpm --filter
      // @ai-orchestrator/docs gen:nodes` once.
      console.warn(`Skipping drift check: ${GENERATED_DIR} does not exist yet`);
      return;
    }

    const beforeFiles: Record<string, string> = {};
    for (const f of fs.readdirSync(GENERATED_DIR)) {
      if (f.endsWith(".md")) {
        beforeFiles[f] = fs.readFileSync(path.join(GENERATED_DIR, f), "utf8");
      }
    }

    const result = spawnSync("pnpm", ["--filter", "@ai-orchestrator/docs", "gen:nodes"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: true
    });
    if (result.status !== 0) {
      throw new Error(
        `Failed to run gen:nodes (status=${result.status}):\n${result.stdout}\n${result.stderr}`
      );
    }

    const afterFiles: Record<string, string> = {};
    for (const f of fs.readdirSync(GENERATED_DIR)) {
      if (f.endsWith(".md")) {
        afterFiles[f] = fs.readFileSync(path.join(GENERATED_DIR, f), "utf8");
      }
    }

    const drifted: string[] = [];
    const allKeys = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
    for (const key of allKeys) {
      if (beforeFiles[key] !== afterFiles[key]) drifted.push(key);
    }

    if (drifted.length > 0) {
      // Restore the committed content so the test failure doesn't leave the
      // working tree mutated for the next debugger to puzzle over.
      for (const [name, content] of Object.entries(beforeFiles)) {
        fs.writeFileSync(path.join(GENERATED_DIR, name), content);
      }
      throw new Error(
        `Node reference docs are out of date with packages/shared/src/definitions.ts.\n` +
          `Drifted files (${drifted.length}): ${drifted.join(", ")}\n` +
          `Fix: pnpm --filter @ai-orchestrator/docs gen:nodes`
      );
    }
    expect(drifted).toEqual([]);
  }, 60_000);
});
