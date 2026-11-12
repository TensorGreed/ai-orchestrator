/**
 * The MCP conformance baselines (apps/api/conformance/baselines/*.yaml): every run has one, every entry names a
 * scenario the pinned conformance package really has, and every entry carries a reason (a comment above it, or
 * above its group). The suite itself runs in CI as the "MCP conformance" job.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const conformanceDir = path.resolve(here, "../conformance");
const cli = path.resolve(here, "../../../node_modules/@modelcontextprotocol/conformance/dist/index.js");

function runNames(): string[] {
  return execFileSync(process.execPath, [path.join(conformanceDir, "run.mjs"), "--list"], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function knownScenarios(): Set<string> {
  const listing = execFileSync(process.execPath, [cli, "list"], { encoding: "utf8" });
  return new Set([...listing.matchAll(/^\s+- ([\w/.-]+)/gm)].map((match) => match[1]!));
}

interface Baseline {
  role: "server" | "client";
  entries: Array<{ scenario: string; hasReason: boolean }>;
}

function parseBaseline(file: string): Baseline {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const roleLine = lines.find((line) => /^(server|client):/.test(line));
  const role = roleLine?.startsWith("server") ? "server" : "client";
  const entries: Baseline["entries"] = [];
  let reasonSeen = false;
  for (const line of lines) {
    if (/^\s{2}#/.test(line)) {
      reasonSeen = true;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const entry = /^\s{2}- (\S+)\s*$/.exec(line);
    // A reason is a comment above the entry or above its group of entries; a blank line ends the group.
    if (entry) entries.push({ scenario: entry[1]!, hasReason: reasonSeen });
    else if (line.trim() === "" || /^(server|client):/.test(line)) reasonSeen = false;
  }
  return { role, entries };
}

describe("MCP conformance baselines", () => {
  it("has one baseline per run, and none without a run", () => {
    const files = fs.readdirSync(path.join(conformanceDir, "baselines")).map((file) => file.replace(/\.yaml$/, "")).sort();
    expect(files).toEqual([...runNames()].sort());
  });

  it("lists only scenarios of the pinned conformance package, with a reason, once each", () => {
    const known = knownScenarios();
    expect(known.size).toBeGreaterThan(50);
    for (const run of runNames()) {
      const baseline = parseBaseline(path.join(conformanceDir, "baselines", `${run}.yaml`));
      expect(baseline.role, run).toBe(run.startsWith("server") ? "server" : "client");
      const seen = new Set<string>();
      for (const entry of baseline.entries) {
        expect(known.has(entry.scenario), `${run}: unknown scenario ${entry.scenario}`).toBe(true);
        expect(entry.hasReason, `${run}: ${entry.scenario} has no reason`).toBe(true);
        expect(seen.has(entry.scenario), `${run}: ${entry.scenario} listed twice`).toBe(false);
        seen.add(entry.scenario);
      }
    }
  });

  it("pins the conformance package and the SDK v2 oracle to exact versions", () => {
    const root = JSON.parse(fs.readFileSync(path.resolve(here, "../../../package.json"), "utf8")) as { devDependencies: Record<string, string> };
    const api = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(root.devDependencies["@modelcontextprotocol/conformance"]).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(api.devDependencies["@modelcontextprotocol/client"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
