// Run with: node --test scripts/release/vuln-gate.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { blockingFindings, findingsOf, parseArgs, severityRank, summarize } from "./vuln-gate.mjs";

const match = (id, severity, state) => ({
  vulnerability: { id, severity, fix: { state, versions: state === "fixed" ? ["9.9.9"] : [] } },
  artifact: { name: `pkg-${id}`, version: "1.0.0" }
});

const report = {
  matches: [
    match("CVE-1", "Critical", "fixed"),
    match("CVE-2", "Critical", "not-fixed"),
    match("CVE-3", "High", "fixed"),
    match("CVE-4", "Medium", "wont-fix"),
    match("CVE-5", "Unknown", "fixed")
  ]
};

test("severityRank orders Grype severities and ranks unknown lowest", () => {
  assert.ok(severityRank("Critical") > severityRank("High"));
  assert.ok(severityRank("negligible") > severityRank("Unknown"));
  assert.equal(severityRank(undefined), -1);
});

test("the release default blocks only fixable criticals", () => {
  const blocked = blockingFindings(findingsOf(report), { failOn: "critical", onlyFixed: true });
  assert.deepEqual(blocked.map((f) => f.id), ["CVE-1"]);
});

test("without --only-fixed unfixed findings block too", () => {
  const blocked = blockingFindings(findingsOf(report), { failOn: "critical", onlyFixed: false });
  assert.deepEqual(blocked.map((f) => f.id), ["CVE-1", "CVE-2"]);
});

test("a lower threshold includes higher severities", () => {
  const blocked = blockingFindings(findingsOf(report), { failOn: "high", onlyFixed: true });
  assert.deepEqual(blocked.map((f) => f.id), ["CVE-1", "CVE-3"]);
});

test("none disables the gate and unknown thresholds are refused", () => {
  assert.deepEqual(blockingFindings(findingsOf(report), { failOn: "none", onlyFixed: false }), []);
  assert.throws(() => blockingFindings([], { failOn: "severe", onlyFixed: false }), /unknown severity/);
});

test("an empty report and a report without matches pass", () => {
  assert.deepEqual(findingsOf({}), []);
  const { blocking, markdown } = summarize([{ name: "api-linux-amd64", findings: [] }], { failOn: "critical", onlyFixed: true });
  assert.equal(blocking.length, 0);
  assert.match(markdown, /\*\*Passed\.\*\*/);
});

test("parseArgs reads options and requires a report", () => {
  assert.deepEqual(parseArgs(["--fail-on", "HIGH", "--only-fixed", "a.json"]), { failOn: "high", onlyFixed: true, files: ["a.json"] });
  assert.throws(() => parseArgs(["--fail-on", "high"]), /no Grype JSON reports/);
  assert.throws(() => parseArgs(["--bogus", "a.json"]), /unknown option/);
});

test("the CLI exits 1 on a blocking finding and 0 otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "vuln-gate-"));
  const file = join(dir, "web-linux-arm64.grype.json");
  writeFileSync(file, JSON.stringify(report));
  const script = fileURLToPath(new URL("./vuln-gate.mjs", import.meta.url));
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "" };

  const blocked = spawnSync(process.execPath, [script, "--fail-on", "critical", "--only-fixed", file], { encoding: "utf8", env });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /\| web-linux-arm64 \| CVE-1 \| Critical \| pkg-CVE-1 1\.0\.0 \| 9\.9\.9 \|/);

  const passed = spawnSync(process.execPath, [script, "--fail-on", "none", file], { encoding: "utf8", env });
  assert.equal(passed.status, 0);

  const misuse = spawnSync(process.execPath, [script, "--fail-on", "critical"], { encoding: "utf8", env });
  assert.equal(misuse.status, 2);
});
