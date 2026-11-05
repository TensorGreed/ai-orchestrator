import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_GUARD_PROFILE_DOCUMENT } from "@ai-orchestrator/guard-sdk";
import { parseGuardBenchmarkReport } from "@ai-orchestrator/shared";
import { formatGuardBenchmark } from "./guard-benchmark";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, type CliIo } from "./main";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-cli-benchmark-"));
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function io(): CliIo & { out: () => string; err: () => string } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return { stdin: new PassThrough(), stdout, stderr, env: {}, out: () => out, err: () => err };
}

const file = (name: string) => path.join(tempDir, name);
function writeJson(name: string, value: unknown): string {
  fs.writeFileSync(file(name), JSON.stringify(value));
  return file(name);
}

describe("l2m guard benchmark", () => {
  it("passes the default rule set on its floors and writes the report and JUnit", async () => {
    const run = io();
    expect(await main(["guard", "benchmark", "--builtin", "--out", file("builtin.json"), "--junit", file("builtin.xml")], run)).toBe(EXIT_OK);
    expect(run.out()).toContain("PASS: every category is at or above the default rule set's floors.");
    expect(run.out()).toMatch(/main\s+detected \d+\/240/);
    const report = parseGuardBenchmarkReport(JSON.parse(fs.readFileSync(file("builtin.json"), "utf8")));
    expect(report.categories).toHaveLength(22);
    expect(fs.statSync(file("builtin.json")).mode & 0o777).toBe(0o600);
    const junit = fs.readFileSync(file("builtin.xml"), "utf8");
    expect(junit).toContain('<testsuites name="l2m guard benchmark" tests="22" failures="0">');
    expect(junit).toContain('name="path_traversal (main)"');
  });

  it("fails a rule set that regresses against a baseline, and passes it against itself", async () => {
    const baseline = io();
    const strict = writeJson("strict.json", { ...DEFAULT_GUARD_PROFILE_DOCUMENT, id: "team", name: "Team" });
    expect(await main(["guard", "benchmark", "--profile", strict, "--split", "main", "--category", "dlp_secrets", "--category", "sql_injection", "--out", file("team.json")], baseline)).toBe(EXIT_OK);
    expect(baseline.out()).toContain("No gate");

    const same = io();
    expect(await main(["guard", "benchmark", "--profile", strict, "--split", "main", "--category", "dlp_secrets", "--category", "sql_injection", "--baseline", file("team.json")], same)).toBe(EXIT_OK);
    expect(same.out()).toContain("PASS: no regression against the baseline.");

    // An export (`{ document }`) works as a rule set file; this one checks nothing.
    const loose = writeJson("loose.json", { document: { id: "team", name: "Team", version: "2", channels: {} } });
    const worse = io();
    expect(await main(["guard", "benchmark", "--profile", loose, "--split", "main", "--category", "dlp_secrets", "--category", "sql_injection", "--baseline", file("team.json"), "--junit", file("team.xml"), "--json"], worse)).toBe(EXIT_FAILED);
    const body = JSON.parse(worse.out()) as { ok: boolean; gate: string; judgement: { failures: Array<{ category: string; metric: string }>; newlyMissed: unknown[] } };
    expect(body).toMatchObject({ ok: false, gate: "baseline" });
    expect(body.judgement.failures.map((failure) => `${failure.category}:${failure.metric}`).sort()).toEqual(["dlp_secrets:detection", "sql_injection:detection"]);
    expect(body.judgement.newlyMissed.length).toBeGreaterThan(30);
    expect(fs.readFileSync(file("team.xml"), "utf8")).toContain('failures="2"');
    // No corpus content leaves the report.
    expect(worse.out()).not.toContain("DROP TABLE");
  });

  it("says how to update the floors on a floor failure and names floors to raise", () => {
    const report = parseGuardBenchmarkReport(JSON.parse(fs.readFileSync(file("builtin.json"), "utf8")));
    const failed = formatGuardBenchmark(
      report,
      { ok: false, failures: [{ kind: "floor", category: "jailbreak", split: "main", metric: "detection", expected: 1, actual: 0.7, message: "jailbreak (main): detection low" }], newlyMissed: [], newlyFlagged: [], corpusChanged: false },
      { gate: "floors", floorsToRaise: [{ category: "sql_injection", split: "heldout" }] }
    );
    expect(failed).toContain("set the new measured counts in BUILT_IN_PROFILE_BENCHMARK_FLOORS");
    expect(failed).toContain("Above the floor: sql_injection (heldout). Raise these floors");
    const passed = formatGuardBenchmark(report, { ok: true, failures: [], newlyMissed: [], newlyFlagged: [], corpusChanged: false }, { gate: "floors", floorsToRaise: [] });
    expect(passed).not.toContain("Above the floor");
  });

  it("runs the reference workflow suite when asked", async () => {
    const run = io();
    expect(await main(["guard", "benchmark", "--builtin", "--suite", "profile", "--suite", "workflow", "--split", "main", "--json"], run)).toBe(EXIT_OK);
    const body = JSON.parse(run.out()) as { report: { workflow: { results: Array<{ configuration: string; attackSucceeded: number }> } } };
    expect(body.report.workflow.results.map((result) => [result.configuration, result.attackSucceeded])).toEqual([["guard", 0], ["guard_untrusted_write_approval", 0]]);
  }, 30_000);

  it("refuses bad usage with exit 2", async () => {
    const cases: string[][] = [
      ["guard", "benchmark"],
      ["guard", "benchmark", "--builtin", "--profile", file("strict.json")],
      ["guard", "benchmark", "--builtin", "--split", "test"],
      ["guard", "benchmark", "--builtin", "--suite", "all"],
      ["guard", "benchmark", "--builtin", "--tolerance", "5"],
      ["guard", "benchmark", "--builtin", "--category", "nope"],
      ["guard", "benchmark", "--builtin", "--baseline", writeJson("not-report.json", { hello: 1 })],
      ["guard", "benchmark", "--profile", writeJson("bad-profile.json", { id: "x" })],
      ["guard", "benchmark", "--builtin", "extra"]
    ];
    for (const argv of cases) {
      const run = io();
      expect(await main(argv, run), argv.join(" ")).toBe(EXIT_USAGE);
    }
  });
});
