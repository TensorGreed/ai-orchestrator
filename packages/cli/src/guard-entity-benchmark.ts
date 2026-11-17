/**
 * `l2m guard benchmark --entities`: the names, places and street addresses corpus through the `data.entities` check,
 * offline (no server, network or model; the rules engine unless the registry is given another recognizer).
 *
 *   --entities                 the built-in options (every class), gated on ENTITY_RULES_BENCHMARK_FLOORS
 *   --entities --profile <f>   the rule set's own `data.entities` options and threshold; reports only
 *   --split main|heldout       one split (repeatable)
 *   --out <report.json> --junit <file> --json
 *
 * Exit 0 when the gate passes (or there is no gate), 1 on a floor failure, a missing floor or an item the check did
 * not run on, 2 on a usage error.
 */
import path from "node:path";
import {
  ENTITY_BENCHMARK_HELDOUT_SLACK,
  ENTITY_RULES_BENCHMARK_FLOORS,
  entityBenchmarkRegistry,
  entityDetectorEntry,
  parseGuardProfile,
  runEntityBenchmark,
  type GuardProfile
} from "@ai-orchestrator/guard-sdk";
import {
  ENTITY_DETECTOR_ID,
  GUARD_BENCHMARK_SPLITS,
  entityBenchmarkMeasuredFloors,
  judgeEntityBenchmark,
  type EntityBenchmarkJudgement,
  type EntityBenchmarkReport,
  type GuardBenchmarkSplit
} from "@ai-orchestrator/shared";
import { listFlag, oneFlag, UsageError, type ParsedArgs } from "./args";
import { isObject, readJsonFile, write, writePrivateFile, type CliIo } from "./api";

/** Flags of `l2m guard benchmark` that only apply to the red-team corpus. */
const RED_TEAM_ONLY_FLAGS = ["builtin", "suite", "category", "baseline", "tolerance"] as const;

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

function loadProfile(file: string): GuardProfile {
  const raw = readJsonFile(file);
  const document = isObject(raw) && isObject(raw.document) ? raw.document : raw;
  let profile: GuardProfile;
  try {
    profile = parseGuardProfile(document);
  } catch (error) {
    throw new UsageError(`${file} is not a valid rule set: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!entityDetectorEntry(profile)) throw new UsageError(`${file} does not list the ${ENTITY_DETECTOR_ID} check, so there is nothing to measure with --entities`);
  return profile;
}

export async function runGuardEntityBenchmarkCommand(args: ParsedArgs, io: CliIo): Promise<number> {
  for (const flag of RED_TEAM_ONLY_FLAGS) {
    if (args.booleans.has(flag) || listFlag(args, flag).length > 0) throw new UsageError(`--${flag} does not apply to --entities`);
  }
  const splitValues = listFlag(args, "split");
  for (const value of splitValues) {
    if (!(GUARD_BENCHMARK_SPLITS as readonly string[]).includes(value)) throw new UsageError(`--split must be one of ${GUARD_BENCHMARK_SPLITS.join(", ")} (got ${JSON.stringify(value.slice(0, 40))})`);
  }
  const splits = splitValues.length > 0 ? ([...new Set(splitValues)] as GuardBenchmarkSplit[]) : undefined;
  const profileFile = oneFlag(args, "profile");
  const profile = profileFile ? loadProfile(profileFile) : undefined;
  const gated = profile === undefined;

  const { report } = await runEntityBenchmark({ registry: entityBenchmarkRegistry(), ...(profile ? { profile } : {}), ...(splits ? { splits } : {}) });
  const judgement: EntityBenchmarkJudgement = gated
    ? judgeEntityBenchmark(report, ENTITY_RULES_BENCHMARK_FLOORS, { heldoutSlack: ENTITY_BENCHMARK_HELDOUT_SLACK, requireFloors: true })
    : judgeEntityBenchmark(report, {});

  const out = oneFlag(args, "out");
  if (out) writePrivateFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  const junit = oneFlag(args, "junit");
  if (junit) writePrivateFile(path.resolve(junit), buildEntityBenchmarkJunit(report, judgement));
  if (args.booleans.has("json")) {
    write(io.stdout, JSON.stringify({ ok: judgement.ok, gate: gated ? "floors" : "none", report, judgement }, null, 2));
  } else {
    write(io.stdout, formatEntityBenchmark(report, judgement, { gated }));
  }
  return judgement.ok ? 0 : 1;
}

/** The text summary: one line per class and split, look-alikes, then what failed and what to raise. */
export function formatEntityBenchmark(report: EntityBenchmarkReport, judgement: EntityBenchmarkJudgement, options: { gated: boolean }): string {
  const lines: string[] = [];
  lines.push(`Entity benchmark: ${report.profile.name ?? report.profile.id} (${report.detectorId}), corpus ${report.corpus.hash.slice(0, 12)}, ${report.corpus.items} items`);
  lines.push("  overlap matching (strict in brackets)");
  for (const result of report.results) {
    lines.push(
      `  ${result.dataClass.padEnd(15)} ${result.split.padEnd(8)} precision ${pct(result.overlap.precision).padStart(6)} (${pct(result.strict.precision)})  recall ${pct(result.overlap.recall).padStart(6)} (${pct(result.strict.recall)})  F1 ${pct(result.overlap.f1).padStart(6)}  labelled ${result.labelled}, predicted ${result.predicted}`
    );
  }
  for (const entry of report.negatives) lines.push(`  look-alikes     ${entry.split.padEnd(8)} flagged ${entry.flagged}/${entry.items}${entry.flaggedIds.length > 0 ? `: ${entry.flaggedIds.join(", ")}` : ""}`);
  lines.push("", `  Latency p50 ${report.latency.p50Ms.toFixed(2)} ms, p95 ${report.latency.p95Ms.toFixed(2)} ms`, "");
  if (!options.gated) {
    lines.push(judgement.ok ? "No gate: --profile measures a rule set's options and only reports." : `Not measured cleanly: ${judgement.failures.map((failure) => failure.message).join("; ")}`);
    return lines.join("\n");
  }
  if (judgement.ok) {
    lines.push("PASS: every class is at or above the rules engine's floors.");
  } else {
    lines.push(`FAIL: ${judgement.failures.length} problem${judgement.failures.length === 1 ? "" : "s"}`);
    for (const failure of judgement.failures) lines.push(`  - ${failure.message}`);
  }
  const missing = judgement.failures.some((failure) => failure.kind === "missing_floor");
  // Floors only mean something when the check ran on every item.
  if (report.failed.length === 0 && (missing || judgement.floorsToRaise.length > 0)) {
    if (judgement.floorsToRaise.length > 0) lines.push(`Above the floor: ${judgement.floorsToRaise.map((entry) => `${entry.dataClass} (${entry.split})`).join(", ")}.`);
    lines.push(
      "Set ENTITY_RULES_BENCHMARK_FLOORS in packages/guard-sdk/src/entity-benchmark.ts to the measured values:",
      JSON.stringify(entityBenchmarkMeasuredFloors(report), null, 2)
    );
  }
  return lines.join("\n");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** JUnit XML: one test case per class and split, plus one for items the check did not run on. */
export function buildEntityBenchmarkJunit(report: EntityBenchmarkReport, judgement: EntityBenchmarkJudgement): string {
  const cases: string[] = [];
  let failed = 0;
  const classname = `l2m.guard.entities.${report.profile.id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const push = (name: string, problems: EntityBenchmarkJudgement["failures"], out: string) => {
    if (problems.length > 0) failed += 1;
    const failure = problems.length > 0 ? `<failure message="${esc(problems.map((problem) => problem.message).join("; "))}" type="${problems[0]!.kind}"/>` : "";
    cases.push(`    <testcase classname="${esc(classname)}" name="${esc(name)}" time="0">${failure}<system-out>${esc(out)}</system-out></testcase>`);
  };
  for (const result of report.results) {
    push(
      `${result.dataClass} (${result.split})`,
      judgement.failures.filter((failure) => failure.dataClass === result.dataClass && failure.split === result.split),
      `precision ${pct(result.overlap.precision)}; recall ${pct(result.overlap.recall)}; strict precision ${pct(result.strict.precision)}; strict recall ${pct(result.strict.recall)}; missed in: ${result.missed.join(", ") || "none"}; flagged in: ${result.flagged.join(", ") || "none"}`
    );
  }
  push("items checked", judgement.failures.filter((failure) => failure.kind === "failed_items"), `not checked: ${report.failed.map((entry) => entry.id).join(", ") || "none"}`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="l2m guard benchmark --entities" tests="${cases.length}" failures="${failed}">`,
    `  <testsuite name="${esc(`l2m guard benchmark --entities ${report.profile.id}`)}" tests="${cases.length}" failures="${failed}" errors="0" timestamp="${esc(report.generatedAt)}">`,
    `    <properties><property name="profile_hash" value="${esc(report.profile.hash)}"/><property name="corpus_hash" value="${esc(report.corpus.hash)}"/></properties>`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ""
  ].join("\n");
}
