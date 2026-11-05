/**
 * Phase 12.7 — the red-team benchmark report.
 *
 * A benchmark runs a labelled attack corpus (attacks and benign look-alikes,
 * per category and split) through a rule set and reports, per category,
 * the detection rate (attacks not allowed) and the false-positive rate
 * (benign items not allowed), which detectors caught what, the action split
 * and the content rules's latency. The optional reference workflow suite runs the
 * tool-result attacks end to end through an agent with a scripted model and
 * mock MCP sinks and reports whether the attack succeeded (a forbidden tool
 * was called, or a canary or collector URL reached the answer).
 *
 * The runner lives in guard-sdk (`runGuardBenchmark`) and workflow-engine
 * (`runReferenceWorkflowSuite`); this file is the contract the API, the CLI
 * and the web UI share: the report shape, the gate (floors and baseline
 * comparison) and the request body of `POST /api/guard/profiles/:id/benchmark`.
 * Reports never carry corpus content, matched values or evidence: ids, counts
 * and detector names only.
 */

import { z } from "zod";

export const GUARD_BENCHMARK_REPORT_FORMAT = "l2m.guard-benchmark";
export const GUARD_BENCHMARK_REPORT_VERSION = 1;

export const GUARD_BENCHMARK_SPLITS = ["main", "heldout"] as const;
export type GuardBenchmarkSplit = (typeof GUARD_BENCHMARK_SPLITS)[number];

export const GUARD_BENCHMARK_SUITES = ["profile", "workflow"] as const;
export type GuardBenchmarkSuite = (typeof GUARD_BENCHMARK_SUITES)[number];

/** How many stored benchmarks a rule set keeps; older ones are deleted when a new one is stored. */
export const GUARD_BENCHMARK_HISTORY_PER_PROFILE = 50;

const rate = z.number().min(0).max(1);
const count = z.number().int().nonnegative();

export const guardBenchmarkFlaggedSchema = z.object({
  id: z.string(),
  action: z.string(),
  detectors: z.array(z.string())
});
export type GuardBenchmarkFlagged = z.infer<typeof guardBenchmarkFlaggedSchema>;

export const guardBenchmarkCategoryResultSchema = z.object({
  category: z.string(),
  split: z.enum(GUARD_BENCHMARK_SPLITS),
  channel: z.string(),
  owasp: z.array(z.string()),
  attacks: count,
  benign: count,
  detected: count,
  falsePositives: count,
  detectionRate: rate,
  falsePositiveRate: rate,
  /** Attack ids the rule set allowed. */
  missed: z.array(z.string()),
  /** Benign ids the rule set did not allow, with the action and the detectors that acted. */
  flagged: z.array(guardBenchmarkFlaggedSchema),
  /** Effective verdict action → number of attack items. */
  attackActions: z.record(z.string(), count),
  /** Effective verdict action → number of benign items. */
  benignActions: z.record(z.string(), count)
});
export type GuardBenchmarkCategoryResult = z.infer<typeof guardBenchmarkCategoryResultSchema>;

export const guardBenchmarkTotalsSchema = z.object({
  split: z.enum(GUARD_BENCHMARK_SPLITS),
  attacks: count,
  benign: count,
  detected: count,
  falsePositives: count,
  detectionRate: rate,
  falsePositiveRate: rate
});
export type GuardBenchmarkTotals = z.infer<typeof guardBenchmarkTotalsSchema>;

export const guardBenchmarkDetectorResultSchema = z.object({
  detectorId: z.string(),
  /** Attack items on which this detector's finding took effect (several detectors may share one item). */
  attacksCaught: count,
  /** Benign items on which this detector's finding took effect. */
  falsePositives: count
});
export type GuardBenchmarkDetectorResult = z.infer<typeof guardBenchmarkDetectorResultSchema>;

export const guardBenchmarkLatencySchema = z.object({
  p50Ms: z.number().nonnegative(),
  p95Ms: z.number().nonnegative(),
  maxMs: z.number().nonnegative()
});

export const GUARD_WORKFLOW_SUITE_CONFIGURATIONS = ["guard", "guard_untrusted_write_approval"] as const;
export type GuardWorkflowSuiteConfiguration = (typeof GUARD_WORKFLOW_SUITE_CONFIGURATIONS)[number];

export const guardWorkflowSuiteResultSchema = z.object({
  configuration: z.enum(GUARD_WORKFLOW_SUITE_CONFIGURATIONS),
  split: z.enum(GUARD_BENCHMARK_SPLITS),
  attacks: count,
  benign: count,
  /** Attack runs where the content rules stopped or rewrote something (any checkpoint not allowed). */
  detected: count,
  detectionRate: rate,
  /** Attack runs where a sink tool was called or the canary or collector URL reached the final answer. */
  attackSucceeded: count,
  attackSuccessRate: rate,
  /** Benign runs that did not finish with the user's answer (a checkpoint not allowed, a pause or a failure). */
  falsePositives: count,
  falsePositiveRate: rate,
  succeeded: z.array(z.string()),
  flagged: z.array(z.string()),
  /** Attack runs paused for an approval (the taint preset) instead of calling the sink. */
  pausedForApproval: count
});
export type GuardWorkflowSuiteResult = z.infer<typeof guardWorkflowSuiteResultSchema>;

export const guardWorkflowSuiteSchema = z.object({
  suite: z.string(),
  version: z.string(),
  /** Corpus categories the suite feeds through the agent's tool result. */
  categories: z.array(z.string()),
  results: z.array(guardWorkflowSuiteResultSchema)
});
export type GuardWorkflowSuiteReport = z.infer<typeof guardWorkflowSuiteSchema>;

export const guardBenchmarkReportSchema = z.object({
  format: z.literal(GUARD_BENCHMARK_REPORT_FORMAT),
  version: z.literal(GUARD_BENCHMARK_REPORT_VERSION),
  generatedAt: z.string(),
  profile: z.object({ id: z.string(), name: z.string().optional(), version: z.string(), hash: z.string() }),
  corpus: z.object({ hash: z.string(), items: count, attacks: count, benign: count, categories: z.array(z.string()) }),
  splits: z.array(z.enum(GUARD_BENCHMARK_SPLITS)),
  totals: z.array(guardBenchmarkTotalsSchema),
  categories: z.array(guardBenchmarkCategoryResultSchema),
  detectors: z.array(guardBenchmarkDetectorResultSchema),
  latency: guardBenchmarkLatencySchema,
  workflow: guardWorkflowSuiteSchema.optional()
});
export type GuardBenchmarkReport = z.infer<typeof guardBenchmarkReportSchema>;

// --- Gate ---------------------------------------------------------------------

export interface GuardBenchmarkFloor {
  /** Lowest acceptable detection rate. */
  detection: number;
  /** Highest acceptable false-positive rate. */
  falsePositive: number;
}

/** Category → split → floor. Categories or splits without a floor are not gated. */
export type GuardBenchmarkFloors = Record<string, Partial<Record<GuardBenchmarkSplit, GuardBenchmarkFloor>>>;

export interface GuardBenchmarkFailure {
  kind: "floor" | "regression";
  category: string;
  split: GuardBenchmarkSplit;
  metric: "detection" | "false_positive" | "attack_success";
  /** The floor or the baseline's value. */
  expected: number;
  actual: number;
  message: string;
}

export interface GuardBenchmarkItemChange {
  category: string;
  split: GuardBenchmarkSplit;
  id: string;
}

export interface GuardBenchmarkJudgement {
  ok: boolean;
  failures: GuardBenchmarkFailure[];
  /** Attack ids the baseline caught and this report missed. */
  newlyMissed: GuardBenchmarkItemChange[];
  /** Benign ids the baseline allowed and this report flagged. */
  newlyFlagged: GuardBenchmarkItemChange[];
  /** The baseline was measured on another corpus: rates still compare, and listed ids may be items the baseline did not have. */
  corpusChanged: boolean;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
/** Slack on rate comparisons, so float noise never fails a gate. */
const EPSILON = 1e-9;

export interface GuardBenchmarkFloorOptions {
  /**
   * Items of slack per category on the held-out split: detection may miss this many more attacks than the floor
   * and false positives may flag this many more benign items. Held-out files are small (10 items), so one item is a
   * 10-point step; the main split stays exact.
   */
  heldoutSlackItems?: number;
}

/** Check a report against absolute floors (the default rule set's gate in repo CI). */
export function checkGuardBenchmarkFloors(report: GuardBenchmarkReport, floors: GuardBenchmarkFloors, options: GuardBenchmarkFloorOptions = {}): GuardBenchmarkFailure[] {
  const failures: GuardBenchmarkFailure[] = [];
  const slackItems = Math.max(0, Math.floor(options.heldoutSlackItems ?? 0));
  for (const result of report.categories) {
    const floor = floors[result.category]?.[result.split];
    if (!floor) continue;
    const slack = result.split === "heldout" ? slackItems : 0;
    const detectionSlack = result.attacks > 0 ? slack / result.attacks : 0;
    const falsePositiveSlack = result.benign > 0 ? slack / result.benign : 0;
    if (result.attacks > 0 && result.detectionRate + detectionSlack + EPSILON < floor.detection) {
      failures.push({
        kind: "floor",
        category: result.category,
        split: result.split,
        metric: "detection",
        expected: floor.detection,
        actual: result.detectionRate,
        message: `${result.category} (${result.split}): detection ${pct(result.detectionRate)} is below the floor ${pct(floor.detection)}; missed ${result.missed.join(", ") || "none"}`
      });
    }
    if (result.benign > 0 && result.falsePositiveRate > floor.falsePositive + falsePositiveSlack + EPSILON) {
      failures.push({
        kind: "floor",
        category: result.category,
        split: result.split,
        metric: "false_positive",
        expected: floor.falsePositive,
        actual: result.falsePositiveRate,
        message: `${result.category} (${result.split}): false positives ${pct(result.falsePositiveRate)} are above the ceiling ${pct(floor.falsePositive)}; flagged ${result.flagged.map((entry) => entry.id).join(", ") || "none"}`
      });
    }
  }
  return failures;
}

/**
 * Categories where a report beats its floor (more caught, or fewer flagged): the floors can be raised to the
 * measured level so a later change cannot silently fall back (the ratchet). Never a failure.
 */
export function guardBenchmarkFloorsToRaise(report: GuardBenchmarkReport, floors: GuardBenchmarkFloors): Array<{ category: string; split: GuardBenchmarkSplit }> {
  const raise: Array<{ category: string; split: GuardBenchmarkSplit }> = [];
  for (const result of report.categories) {
    const floor = floors[result.category]?.[result.split];
    if (!floor) continue;
    const better = (result.attacks > 0 && result.detectionRate > floor.detection + EPSILON) || (result.benign > 0 && result.falsePositiveRate + EPSILON < floor.falsePositive);
    if (better) raise.push({ category: result.category, split: result.split });
  }
  return raise;
}

/**
 * Compare a report with a stored baseline of the same rule set (or another
 * version of it): per category and split, detection must not drop by more
 * than `tolerance` and false positives must not rise by more than it; in the
 * workflow suite, attack success must not rise. Categories the baseline does
 * not have are new and never a regression. Items newly missed or newly
 * flagged are listed by id.
 */
export function compareGuardBenchmarks(baseline: GuardBenchmarkReport, current: GuardBenchmarkReport, options: { tolerance?: number } = {}): Omit<GuardBenchmarkJudgement, "ok"> {
  const tolerance = Math.max(0, options.tolerance ?? 0);
  const failures: GuardBenchmarkFailure[] = [];
  const newlyMissed: GuardBenchmarkItemChange[] = [];
  const newlyFlagged: GuardBenchmarkItemChange[] = [];
  const key = (category: string, split: string) => `${category}\u0000${split}`;
  const before = new Map(baseline.categories.map((result) => [key(result.category, result.split), result]));
  for (const result of current.categories) {
    const old = before.get(key(result.category, result.split));
    if (!old) continue;
    if (result.attacks > 0 && old.attacks > 0 && result.detectionRate + tolerance + EPSILON < old.detectionRate) {
      failures.push({
        kind: "regression",
        category: result.category,
        split: result.split,
        metric: "detection",
        expected: old.detectionRate,
        actual: result.detectionRate,
        message: `${result.category} (${result.split}): detection fell from ${pct(old.detectionRate)} to ${pct(result.detectionRate)}`
      });
    }
    if (result.benign > 0 && result.falsePositiveRate > old.falsePositiveRate + tolerance + EPSILON) {
      failures.push({
        kind: "regression",
        category: result.category,
        split: result.split,
        metric: "false_positive",
        expected: old.falsePositiveRate,
        actual: result.falsePositiveRate,
        message: `${result.category} (${result.split}): false positives rose from ${pct(old.falsePositiveRate)} to ${pct(result.falsePositiveRate)}`
      });
    }
    const oldMissed = new Set(old.missed);
    const oldFlagged = new Set(old.flagged.map((entry) => entry.id));
    // With another corpus (corpusChanged) a listed id may be an item the baseline did not have.
    for (const id of result.missed) if (!oldMissed.has(id)) newlyMissed.push({ category: result.category, split: result.split, id });
    for (const entry of result.flagged) if (!oldFlagged.has(entry.id)) newlyFlagged.push({ category: result.category, split: result.split, id: entry.id });
  }
  if (baseline.workflow && current.workflow) {
    const oldRuns = new Map(baseline.workflow.results.map((result) => [key(result.configuration, result.split), result]));
    for (const result of current.workflow.results) {
      const old = oldRuns.get(key(result.configuration, result.split));
      if (!old || result.attacks === 0) continue;
      if (result.attackSuccessRate > old.attackSuccessRate + tolerance + EPSILON) {
        failures.push({
          kind: "regression",
          category: `workflow:${result.configuration}`,
          split: result.split,
          metric: "attack_success",
          expected: old.attackSuccessRate,
          actual: result.attackSuccessRate,
          message: `workflow suite ${result.configuration} (${result.split}): attack success rose from ${pct(old.attackSuccessRate)} to ${pct(result.attackSuccessRate)}`
        });
      }
    }
  }
  return { failures, newlyMissed, newlyFlagged, corpusChanged: baseline.corpus.hash !== current.corpus.hash };
}

/** The gate: floors (when given) and the baseline comparison (when given). */
export function judgeGuardBenchmark(
  report: GuardBenchmarkReport,
  options: { floors?: GuardBenchmarkFloors; heldoutSlackItems?: number; baseline?: GuardBenchmarkReport; tolerance?: number } = {}
): GuardBenchmarkJudgement {
  const failures = options.floors
    ? checkGuardBenchmarkFloors(report, options.floors, options.heldoutSlackItems !== undefined ? { heldoutSlackItems: options.heldoutSlackItems } : {})
    : [];
  const comparison = options.baseline
    ? compareGuardBenchmarks(options.baseline, report, options.tolerance !== undefined ? { tolerance: options.tolerance } : {})
    : { failures: [], newlyMissed: [], newlyFlagged: [], corpusChanged: false };
  const all = [...failures, ...comparison.failures];
  return { ok: all.length === 0, failures: all, newlyMissed: comparison.newlyMissed, newlyFlagged: comparison.newlyFlagged, corpusChanged: comparison.corpusChanged };
}

/** Parse a report file (a baseline); throws with the zod issues listed. */
export function parseGuardBenchmarkReport(raw: unknown): GuardBenchmarkReport {
  const result = guardBenchmarkReportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Not a content rules benchmark report: ${result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

// --- API ----------------------------------------------------------------------

/**
 * `POST /api/guard/profiles/:id/benchmark`. Without `document` or `version`
 * the rule set's latest saved version is benchmarked and the result stored;
 * `version` benchmarks (and stores) that saved version; `document` benchmarks
 * the editor's unsaved draft, which is returned and never stored.
 */
export const guardBenchmarkRequestSchema = z
  .object({
    document: z.record(z.string(), z.unknown()).optional(),
    version: z.number().int().positive().optional(),
    suites: z.array(z.enum(GUARD_BENCHMARK_SUITES)).min(1).max(GUARD_BENCHMARK_SUITES.length).optional(),
    splits: z.array(z.enum(GUARD_BENCHMARK_SPLITS)).min(1).max(GUARD_BENCHMARK_SPLITS.length).optional(),
    categories: z.array(z.string().trim().min(1).max(64)).min(1).max(64).optional()
  })
  .strict()
  .refine((value) => value.document === undefined || value.version === undefined, {
    message: "Send either the rule set document to benchmark or a saved version, not both"
  });
export type GuardBenchmarkRequest = z.infer<typeof guardBenchmarkRequestSchema>;

/** A stored benchmark (`guard_benchmarks`) as `GET /api/guard/profiles/:id/benchmarks` lists it: headline rates, no report. */
export interface GuardBenchmarkListEntry {
  id: string;
  profileId: string;
  profileVersion: number;
  profileHash: string;
  corpusHash: string;
  suites: string[];
  /** Over every category of every split that ran. */
  detectionRate: number;
  falsePositiveRate: number;
  splits: Array<{ split: string; detectionRate: number; falsePositiveRate: number }>;
  /** Highest attack success in the workflow suite, when it ran. */
  attackSuccessRate: number | null;
  createdBy: string | null;
  createdAt: string;
}

/** The response of a benchmark request: the report, how it compares with the previous stored one, and the stored row. */
export interface GuardBenchmarkResponse {
  report: GuardBenchmarkReport;
  /** Compared with the rule set's latest stored benchmark before this one (none on the first). */
  comparison: GuardBenchmarkJudgement | null;
  baseline: { id: string; profileVersion: number; createdAt: string } | null;
  /** Null for a draft and for a partial run (a category or split filter), which are never stored. */
  stored: { id: string; createdAt: string } | null;
  draft: boolean;
  /** A category or split filter was given: the report covers part of the corpus, so it is not stored. */
  partial: boolean;
}

/** Totals over the given split, or every split. */
export function guardBenchmarkHeadline(report: GuardBenchmarkReport, split?: GuardBenchmarkSplit): { detectionRate: number; falsePositiveRate: number } {
  const totals = report.totals.filter((entry) => !split || entry.split === split);
  const attacks = totals.reduce((sum, entry) => sum + entry.attacks, 0);
  const benign = totals.reduce((sum, entry) => sum + entry.benign, 0);
  const detected = totals.reduce((sum, entry) => sum + entry.detected, 0);
  const flagged = totals.reduce((sum, entry) => sum + entry.falsePositives, 0);
  return { detectionRate: attacks ? detected / attacks : 1, falsePositiveRate: benign ? flagged / benign : 0 };
}
