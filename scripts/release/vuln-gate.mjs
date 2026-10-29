#!/usr/bin/env node
// Release gate over Grype JSON reports (scripts/release/image-scan.sh writes them).
//
// Fails (exit 1) when any report has a finding at or above --fail-on severity; with --only-fixed, only findings
// that already have a fixed version count. The release workflow runs it with `--fail-on critical --only-fixed`:
// a release is blocked by a fixable CRITICAL, never by an unfixed one or a lower severity.
//
// Usage: node scripts/release/vuln-gate.mjs --fail-on <negligible|low|medium|high|critical|none> [--only-fixed]
//          <report.grype.json>...
// Prints a Markdown summary, also appended to $GITHUB_STEP_SUMMARY when that is set.

import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const SEVERITIES = ["negligible", "low", "medium", "high", "critical"];

/** Rank of a Grype severity ("Critical", "High", ...); unknown severities rank below negligible. */
export function severityRank(severity) {
  return SEVERITIES.indexOf(String(severity ?? "").toLowerCase());
}

/** The findings of one Grype JSON report, flattened to what the gate and the summary need. */
export function findingsOf(report) {
  return (report?.matches ?? []).map((match) => ({
    id: match.vulnerability?.id ?? "unknown",
    severity: match.vulnerability?.severity ?? "Unknown",
    fixState: match.vulnerability?.fix?.state ?? "unknown",
    fixVersions: match.vulnerability?.fix?.versions ?? [],
    packageName: match.artifact?.name ?? "unknown",
    packageVersion: match.artifact?.version ?? ""
  }));
}

/** Findings that block: severity at or above `failOn`, and fixed when `onlyFixed`. `failOn` "none" blocks nothing. */
export function blockingFindings(findings, { failOn, onlyFixed }) {
  if (failOn === "none") return [];
  const threshold = severityRank(failOn);
  if (threshold < 0) throw new Error(`unknown severity "${failOn}"; use one of ${SEVERITIES.join(", ")} or none`);
  return findings.filter((f) => severityRank(f.severity) >= threshold && (!onlyFixed || f.fixState === "fixed"));
}

export function parseArgs(argv) {
  const options = { failOn: "critical", onlyFixed: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fail-on") options.failOn = String(argv[++i] ?? "").toLowerCase();
    else if (arg === "--only-fixed") options.onlyFixed = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.files.push(arg);
  }
  if (options.files.length === 0) throw new Error("no Grype JSON reports given");
  return options;
}

/** Findings per severity, as `{ all, fixed }` (fixed: a fixed version exists). */
export function countBySeverity(findings) {
  const counts = Object.fromEntries(
    ["critical", "high", "medium", "low", "negligible", "unknown"].map((s) => [s, { all: 0, fixed: 0 }])
  );
  for (const f of findings) {
    const key = severityRank(f.severity) >= 0 ? f.severity.toLowerCase() : "unknown";
    counts[key].all += 1;
    if (f.fixState === "fixed") counts[key].fixed += 1;
  }
  return counts;
}

export function summarize(reports, options) {
  const rule =
    options.failOn === "none"
      ? "gate disabled (`--fail-on none`)"
      : `fails on ${options.onlyFixed ? "fixable " : ""}${options.failOn.toUpperCase()} or above`;
  const lines = [`### Vulnerability gate: ${rule}`, "", "Counts are all findings (fixable in brackets).", "", "| Report | Critical | High | Medium | Low | Blocking |", "|---|---|---|---|---|---|"];
  const blocking = [];
  for (const { name, findings } of reports) {
    const counts = countBySeverity(findings);
    const blocked = blockingFindings(findings, options);
    blocking.push(...blocked.map((f) => ({ ...f, report: name })));
    const cell = (severity) => `${counts[severity].all} (${counts[severity].fixed})`;
    lines.push(`| ${name} | ${cell("critical")} | ${cell("high")} | ${cell("medium")} | ${cell("low")} | ${blocked.length} |`);
  }
  if (blocking.length > 0) {
    lines.push("", "| Report | Vulnerability | Severity | Package | Fixed in |", "|---|---|---|---|---|");
    for (const f of blocking) {
      lines.push(`| ${f.report} | ${f.id} | ${f.severity} | ${f.packageName} ${f.packageVersion} | ${f.fixVersions.join(", ") || "-"} |`);
    }
  }
  lines.push("", blocking.length > 0 ? `**Blocked:** ${blocking.length} finding(s).` : "**Passed.**", "");
  return { markdown: lines.join("\n"), blocking };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const reports = options.files.map((file) => ({
    name: basename(file).replace(/\.grype\.json$/, ""),
    findings: findingsOf(JSON.parse(readFileSync(file, "utf8")))
  }));
  const { markdown, blocking } = summarize(reports, options);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.exitCode = blocking.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`vuln-gate: ${error.message}\n`);
    process.exitCode = 2;
  }
}
