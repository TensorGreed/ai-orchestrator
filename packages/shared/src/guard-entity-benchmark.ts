/**
 * Names, places and street addresses: the entity benchmark report.
 *
 * A span-annotated corpus (`packages/guard-sdk/corpus/entities/`, main and held-out splits) is run through the
 * `data.entities` check, and every predicted span is matched against the labelled ones, per data class and split:
 * strict (the exact span) and overlap (the spans share at least half of the shorter one's characters). This file is
 * the contract the runner (guard-sdk `runEntityBenchmark`), the CLI, the API and the web UI share: the report shape and
 * the floors gate. Reports carry ids, counts and rates only: never corpus text, matched values or evidence.
 */

import { z } from "zod";

/** The corpus splits (the same as the red-team benchmark's; kept here so this file imports nothing at runtime from it). */
const SPLITS = ["main", "heldout"] as const;
type GuardBenchmarkSplit = (typeof SPLITS)[number];

export const ENTITY_BENCHMARK_REPORT_FORMAT = "l2m.entity-benchmark";
export const ENTITY_BENCHMARK_REPORT_VERSION = 1;

/** The detector the entity benchmark measures. */
export const ENTITY_DETECTOR_ID = "data.entities";

/** The data classes the `data.entities` check emits and the corpus labels. */
export const ENTITY_BENCHMARK_CLASSES = ["person_name", "location", "street_address"] as const;
export type EntityBenchmarkClass = (typeof ENTITY_BENCHMARK_CLASSES)[number];

export const ENTITY_BENCHMARK_MATCHES = ["strict", "overlap"] as const;
export type EntityBenchmarkMatch = (typeof ENTITY_BENCHMARK_MATCHES)[number];

const rate = z.number().min(0).max(1);
const count = z.number().int().nonnegative();

export const entityBenchmarkScoreSchema = z.object({
  truePositives: count,
  falsePositives: count,
  falseNegatives: count,
  /** 1 when nothing was predicted. */
  precision: rate,
  /** 1 when nothing was labelled. */
  recall: rate,
  f1: rate
});
export type EntityBenchmarkScore = z.infer<typeof entityBenchmarkScoreSchema>;

export const entityBenchmarkClassResultSchema = z.object({
  dataClass: z.enum(ENTITY_BENCHMARK_CLASSES),
  split: z.enum(SPLITS),
  /** Labelled spans of this class. */
  labelled: count,
  /** Predicted spans of this class. */
  predicted: count,
  strict: entityBenchmarkScoreSchema,
  overlap: entityBenchmarkScoreSchema,
  /** Item ids with a labelled span the check did not find (overlap matching). */
  missed: z.array(z.string()),
  /** Item ids with a predicted span that matches no labelled span (overlap matching). */
  flagged: z.array(z.string())
});
export type EntityBenchmarkClassResult = z.infer<typeof entityBenchmarkClassResultSchema>;

export const entityBenchmarkNegativesSchema = z.object({
  split: z.enum(SPLITS),
  /** Items with no labelled span at all (look-alikes and plain text). */
  items: count,
  /** Of those, items where the check predicted any span of a measured class. */
  flagged: count,
  flaggedIds: z.array(z.string())
});
export type EntityBenchmarkNegatives = z.infer<typeof entityBenchmarkNegativesSchema>;

export const entityBenchmarkReportSchema = z.object({
  format: z.literal(ENTITY_BENCHMARK_REPORT_FORMAT),
  version: z.literal(ENTITY_BENCHMARK_REPORT_VERSION),
  generatedAt: z.string(),
  detectorId: z.string(),
  /** The data classes measured (the check's `classes` option). */
  classes: z.array(z.enum(ENTITY_BENCHMARK_CLASSES)),
  profile: z.object({ id: z.string(), name: z.string().optional(), version: z.string(), hash: z.string() }),
  corpus: z.object({ hash: z.string(), items: count, splits: z.array(z.enum(SPLITS)) }),
  results: z.array(entityBenchmarkClassResultSchema),
  negatives: z.array(entityBenchmarkNegativesSchema),
  /** Items on which the check did not run (an error, a timeout, not registered); their labelled spans count as missed. */
  failed: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().optional() })),
  latency: z.object({ p50Ms: z.number().nonnegative(), p95Ms: z.number().nonnegative(), maxMs: z.number().nonnegative() })
});
export type EntityBenchmarkReport = z.infer<typeof entityBenchmarkReportSchema>;

/** Parse an entity benchmark report; throws with the zod issues listed. */
export function parseEntityBenchmarkReport(raw: unknown): EntityBenchmarkReport {
  const result = entityBenchmarkReportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Not an entity benchmark report: ${result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

// --- Gate ---------------------------------------------------------------------

export interface EntityBenchmarkFloor {
  /** Lowest acceptable precision (overlap matching). */
  precision: number;
  /** Lowest acceptable recall (overlap matching). */
  recall: number;
}

/** Data class → split → floor, on overlap matching. */
export type EntityBenchmarkFloors = Partial<Record<EntityBenchmarkClass, Partial<Record<GuardBenchmarkSplit, EntityBenchmarkFloor>>>>;

export interface EntityBenchmarkFailure {
  kind: "floor" | "missing_floor" | "failed_items";
  dataClass?: EntityBenchmarkClass;
  split?: GuardBenchmarkSplit;
  metric?: "precision" | "recall";
  expected?: number;
  actual?: number;
  message: string;
}

export interface EntityBenchmarkJudgement {
  ok: boolean;
  failures: EntityBenchmarkFailure[];
  /** Classes and splits measured above their floor: raise the floor to the measured value (the ratchet). */
  floorsToRaise: Array<{ dataClass: EntityBenchmarkClass; split: GuardBenchmarkSplit }>;
}

export interface EntityBenchmarkGateOptions {
  /** Rate slack on the held-out split (default 0): it is small, so one span is a step of a few points. */
  heldoutSlack?: number;
  /** Fail on a measured class and split with no floor (the CI gate does, so new results get a floor). Default false. */
  requireFloors?: boolean;
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
/** Slack on rate comparisons, so float noise never fails a gate. */
const EPSILON = 1e-9;
const roundDown = (value: number) => Math.floor(value * 10_000 + EPSILON) / 10_000;

/** Check a report against absolute floors; any item on which the check did not run fails the gate too. */
export function judgeEntityBenchmark(report: EntityBenchmarkReport, floors: EntityBenchmarkFloors, options: EntityBenchmarkGateOptions = {}): EntityBenchmarkJudgement {
  const failures: EntityBenchmarkFailure[] = [];
  const floorsToRaise: EntityBenchmarkJudgement["floorsToRaise"] = [];
  if (report.failed.length > 0) {
    failures.push({
      kind: "failed_items",
      message: `${report.failed.length} item(s) were not checked (${[...new Set(report.failed.map((entry) => entry.status))].join(", ")}): ${report.failed
        .slice(0, 10)
        .map((entry) => entry.id)
        .join(", ")}${report.failed.length > 10 ? ", …" : ""}`
    });
  }
  const slackFor = (split: GuardBenchmarkSplit) => (split === "heldout" ? Math.max(0, options.heldoutSlack ?? 0) : 0);
  for (const result of report.results) {
    const floor = floors[result.dataClass]?.[result.split];
    const where = `${result.dataClass} (${result.split})`;
    if (!floor) {
      if (options.requireFloors) {
        failures.push({
          kind: "missing_floor",
          dataClass: result.dataClass,
          split: result.split,
          message: `${where}: no floor set; measured precision ${pct(result.overlap.precision)}, recall ${pct(result.overlap.recall)}`
        });
      }
      continue;
    }
    const slack = slackFor(result.split);
    for (const metric of ["precision", "recall"] as const) {
      const actual = result.overlap[metric];
      if (actual + slack + EPSILON < floor[metric]) {
        failures.push({
          kind: "floor",
          dataClass: result.dataClass,
          split: result.split,
          metric,
          expected: floor[metric],
          actual,
          message: `${where}: ${metric} ${pct(actual)} is below the floor ${pct(floor[metric])}; ${metric === "recall" ? `missed in ${result.missed.join(", ") || "none"}` : `flagged in ${result.flagged.join(", ") || "none"}`}`
        });
      }
    }
    // Floors are written rounded down to 4 decimals (entityBenchmarkMeasuredFloors), so compare at that precision.
    if (roundDown(result.overlap.precision) > floor.precision + EPSILON || roundDown(result.overlap.recall) > floor.recall + EPSILON) floorsToRaise.push({ dataClass: result.dataClass, split: result.split });
  }
  return { ok: failures.length === 0, failures, floorsToRaise };
}

/** The measured overlap precision and recall as floors (rounded down to 4 decimals), for pasting into a floors table. */
export function entityBenchmarkMeasuredFloors(report: EntityBenchmarkReport): EntityBenchmarkFloors {
  const floors: EntityBenchmarkFloors = {};
  for (const result of report.results) {
    floors[result.dataClass] = { ...floors[result.dataClass], [result.split]: { precision: roundDown(result.overlap.precision), recall: roundDown(result.overlap.recall) } };
  }
  return floors;
}
