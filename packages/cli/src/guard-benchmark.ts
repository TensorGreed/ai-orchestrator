/**
 * 12.7 — `l2m guard benchmark`: the red-team corpus through a rule set,
 * offline. No server, no network, no model: the corpus ships with guard-sdk,
 * and the reference workflow suite uses a scripted model and mock tools.
 *
 *   --builtin            the default rule set, gated on its absolute floors
 *                        (the measured results, BUILT_IN_PROFILE_BENCHMARK_FLOORS; one item of
 *                        slack per held-out category)
 *   --profile <file>     a rule set document (JSON; an export with a `document` field works too),
 *                        gated only on regression against --baseline
 *   --baseline <file>    a report written earlier with --out: fail on a drop in detection,
 *                        a rise in false positives or in workflow attack success beyond --tolerance
 *
 * Exit 0 when the gate passes, 1 on a floor failure, a regression or an
 * error, 2 on a usage error.
 */
import path from "node:path";
import {
  BUILT_IN_PROFILE_BENCHMARK_FLOORS,
  BUILT_IN_PROFILE_HELDOUT_SLACK_ITEMS,
  createDefaultGuardProfile,
  parseGuardProfile,
  type GuardProfile
} from "@ai-orchestrator/guard-sdk";
import {
  GUARD_BENCHMARK_SPLITS,
  GUARD_BENCHMARK_SUITES,
  guardBenchmarkFloorsToRaise,
  judgeGuardBenchmark,
  parseGuardBenchmarkReport,
  type GuardBenchmarkJudgement,
  type GuardBenchmarkReport,
  type GuardBenchmarkSplit,
  type GuardBenchmarkSuite
} from "@ai-orchestrator/shared";
import { runGuardBenchmarkSuites } from "@ai-orchestrator/workflow-engine";
import { listFlag, oneFlag, UsageError, type CommandFlags, type ParsedArgs } from "./args";
import { isObject, readJsonFile, write, writePrivateFile, type CliIo } from "./api";

export const GUARD_BENCHMARK_FLAGS: CommandFlags = {
  values: ["profile", "suite", "split", "category", "baseline", "tolerance", "out", "junit"],
  booleans: ["builtin", "json"]
};

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function oneOf<T extends string>(values: string[], allowed: readonly T[], flag: string): T[] | undefined {
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${flag} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value.slice(0, 40))})`);
  }
  return [...new Set(values)] as T[];
}

function loadProfile(file: string): GuardProfile {
  const raw = readJsonFile(file);
  const document = isObject(raw) && isObject(raw.document) ? raw.document : raw;
  try {
    return parseGuardProfile(document);
  } catch (error) {
    throw new UsageError(`${file} is not a valid rule set: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadBaseline(file: string): GuardBenchmarkReport {
  const raw = readJsonFile(file);
  // A `--json` capture holds the report next to its judgement.
  const report = isObject(raw) && isObject(raw.report) ? raw.report : raw;
  try {
    return parseGuardBenchmarkReport(report);
  } catch (error) {
    throw new UsageError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runGuardBenchmarkCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  const builtin = args.booleans.has("builtin");
  const profileFile = oneFlag(args, "profile");
  if (builtin === (profileFile !== undefined)) throw new UsageError("l2m guard benchmark needs exactly one of --builtin and --profile <file>");
  const suites = oneOf(listFlag(args, "suite"), GUARD_BENCHMARK_SUITES, "suite") as GuardBenchmarkSuite[] | undefined;
  const splits = oneOf(listFlag(args, "split"), GUARD_BENCHMARK_SPLITS, "split") as GuardBenchmarkSplit[] | undefined;
  const categories = listFlag(args, "category");
  const toleranceRaw = oneFlag(args, "tolerance");
  const tolerance = toleranceRaw === undefined ? undefined : Number(toleranceRaw);
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)) throw new UsageError("--tolerance must be a fraction between 0 and 1 (0.02 allows two points)");
  const baselineFile = oneFlag(args, "baseline");
  const baseline = baselineFile ? loadBaseline(baselineFile) : undefined;
  const profile = profileFile ? loadProfile(profileFile) : createDefaultGuardProfile();

  let report: GuardBenchmarkReport;
  try {
    report = await runGuardBenchmarkSuites({
      profile,
      suites: suites ?? ["profile"],
      ...(splits ? { splits } : {}),
      ...(categories.length > 0 ? { categories } : {})
    });
  } catch (error) {
    if (error instanceof Error && /^No corpus category/.test(error.message)) throw new UsageError(error.message);
    throw error;
  }
  const judgement = judgeGuardBenchmark(report, {
    ...(builtin ? { floors: BUILT_IN_PROFILE_BENCHMARK_FLOORS, heldoutSlackItems: BUILT_IN_PROFILE_HELDOUT_SLACK_ITEMS } : {}),
    ...(baseline ? { baseline } : {}),
    ...(tolerance !== undefined ? { tolerance } : {})
  });

  const out = oneFlag(args, "out");
  if (out) writePrivateFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const junit = oneFlag(args, "junit");
  if (junit) writePrivateFile(path.resolve(junit), buildGuardBenchmarkJunit(report, judgement));
  if (args.booleans.has("json")) {
    write(io.stdout, JSON.stringify({ ok: judgement.ok, gate: builtin ? "floors" : baseline ? "baseline" : "none", report, judgement }, null, 2));
  } else {
    write(
      io.stdout,
      formatGuardBenchmark(report, judgement, {
        gate: builtin ? "floors" : baseline ? "baseline" : "none",
        ...(builtin ? { floorsToRaise: guardBenchmarkFloorsToRaise(report, BUILT_IN_PROFILE_BENCHMARK_FLOORS) } : {})
      })
    );
  }
  return judgement.ok ? 0 : 1;
}

/** The text summary: totals per split, one line per category, the workflow suite, then what failed. */
export function formatGuardBenchmark(
  report: GuardBenchmarkReport,
  judgement: GuardBenchmarkJudgement,
  options: { gate: "floors" | "baseline" | "none"; floorsToRaise?: Array<{ category: string; split: string }> }
): string {
  const lines: string[] = [];
  lines.push(`Guard benchmark: ${report.profile.name ?? report.profile.id} (hash ${report.profile.hash.slice(0, 12)}), corpus ${report.corpus.hash.slice(0, 12)}`);
  for (const total of report.totals) {
    lines.push(`  ${total.split.padEnd(8)} detected ${total.detected}/${total.attacks} (${pct(total.detectionRate)}), false positives ${total.falsePositives}/${total.benign} (${pct(total.falsePositiveRate)})`);
  }
  lines.push("");
  const width = Math.max(...report.categories.map((entry) => entry.category.length), 8);
  for (const entry of report.categories) {
    lines.push(`  ${entry.category.padEnd(width)}  ${entry.split.padEnd(8)} detected ${`${entry.detected}/${entry.attacks}`.padStart(6)}  false positives ${`${entry.falsePositives}/${entry.benign}`.padStart(6)}`);
  }
  if (report.workflow) {
    lines.push("", `  Reference workflow suite (${report.workflow.suite} ${report.workflow.version}):`);
    for (const result of report.workflow.results) {
      lines.push(`    ${result.configuration.padEnd(31)} ${result.split.padEnd(8)} attacks succeeded ${result.attackSucceeded}/${result.attacks}, paused ${result.pausedForApproval}, false positives ${result.falsePositives}/${result.benign}`);
    }
  }
  lines.push("", `  Latency p50 ${report.latency.p50Ms.toFixed(2)} ms, p95 ${report.latency.p95Ms.toFixed(2)} ms`);
  lines.push("");
  if (options.gate === "none") {
    lines.push("No gate: pass --baseline <report.json> to fail on regressions (write one with --out).");
  } else if (judgement.ok) {
    lines.push(options.gate === "floors" ? "PASS: every category is at or above the default rule set's floors." : "PASS: no regression against the baseline.");
  } else {
    lines.push(`FAIL: ${judgement.failures.length} problem${judgement.failures.length === 1 ? "" : "s"}`);
    for (const failure of judgement.failures) lines.push(`  - ${failure.message}`);
    if (options.gate === "floors") {
      lines.push(
        "A drop is a regression to fix. If the corpus changed on purpose, set the new measured counts in BUILT_IN_PROFILE_BENCHMARK_FLOORS (packages/guard-sdk/src/benchmark.ts) and corpus/README.md in the same pull request."
      );
    }
  }
  if (options.floorsToRaise && options.floorsToRaise.length > 0) {
    lines.push(
      `Above the floor: ${options.floorsToRaise.map((entry) => `${entry.category} (${entry.split})`).join(", ")}. Raise these floors in packages/guard-sdk/src/benchmark.ts to the measured counts so the gain cannot slip back.`
    );
  }
  if (judgement.corpusChanged) lines.push("Note: the baseline was measured on another corpus; rates still compare.");
  if (judgement.newlyMissed.length > 0) lines.push(`Newly missed: ${judgement.newlyMissed.map((change) => change.id).join(", ")}`);
  if (judgement.newlyFlagged.length > 0) lines.push(`Newly flagged: ${judgement.newlyFlagged.map((change) => change.id).join(", ")}`);
  return lines.join("\n");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * JUnit XML: one test case per category and split (and per workflow suite
 * configuration and split). A case fails when the gate found a problem in
 * it; the missed and flagged ids are in its system-out.
 */
export function buildGuardBenchmarkJunit(report: GuardBenchmarkReport, judgement: GuardBenchmarkJudgement): string {
  const failuresFor = (category: string, split: string) => judgement.failures.filter((failure) => failure.category === category && failure.split === split);
  const cases: string[] = [];
  let failed = 0;
  const classname = `l2m.guard.benchmark.${report.profile.id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const push = (name: string, problems: typeof judgement.failures, out: string) => {
    if (problems.length > 0) failed += 1;
    const failure = problems.length > 0 ? `<failure message="${esc(problems.map((problem) => problem.message).join("; "))}" type="${problems[0]!.kind}"/>` : "";
    cases.push(`    <testcase classname="${esc(classname)}" name="${esc(name)}" time="0">${failure}<system-out>${esc(out)}</system-out></testcase>`);
  };
  for (const entry of report.categories) {
    push(
      `${entry.category} (${entry.split})`,
      failuresFor(entry.category, entry.split),
      `detected ${entry.detected}/${entry.attacks}; false positives ${entry.falsePositives}/${entry.benign}; missed: ${entry.missed.join(", ") || "none"}; flagged: ${entry.flagged.map((flag) => flag.id).join(", ") || "none"}`
    );
  }
  for (const result of report.workflow?.results ?? []) {
    const category = `workflow:${result.configuration}`;
    push(
      `${category} (${result.split})`,
      failuresFor(category, result.split),
      `attacks succeeded ${result.attackSucceeded}/${result.attacks}; paused ${result.pausedForApproval}; false positives ${result.falsePositives}/${result.benign}; succeeded: ${result.succeeded.join(", ") || "none"}`
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="l2m guard benchmark" tests="${cases.length}" failures="${failed}">`,
    `  <testsuite name="${esc(`l2m guard benchmark ${report.profile.id}`)}" tests="${cases.length}" failures="${failed}" errors="0" timestamp="${esc(report.generatedAt)}">`,
    `    <properties><property name="profile_hash" value="${esc(report.profile.hash)}"/><property name="corpus_hash" value="${esc(report.corpus.hash)}"/></properties>`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ""
  ].join("\n");
}
