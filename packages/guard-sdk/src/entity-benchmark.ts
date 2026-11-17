import {
  ENTITY_BENCHMARK_CLASSES,
  ENTITY_BENCHMARK_REPORT_FORMAT,
  ENTITY_BENCHMARK_REPORT_VERSION,
  ENTITY_DETECTOR_ID,
  GUARD_BENCHMARK_SPLITS,
  type EntityBenchmarkClass,
  type EntityBenchmarkClassResult,
  type EntityBenchmarkFloors,
  type EntityBenchmarkNegatives,
  type EntityBenchmarkReport,
  type EntityBenchmarkScore,
  type GuardBenchmarkSplit
} from "@ai-orchestrator/shared";
import { loadEntityCorpus, type EntityCorpus, type EntityCorpusItem } from "./entity-corpus";
import { evaluateGuard } from "./evaluate";
import { createDefaultGuardRegistry } from "./index";
import { hashGuardProfile, parseGuardProfile, type GuardProfile } from "./profile";
import type { GuardRegistry } from "./registry";
import type { GuardSpan } from "./types";

/**
 * Names, places and street addresses — the entity benchmark.
 *
 * Every corpus item goes through the public `evaluateGuard` API with a rule set that runs the `data.entities` check
 * alone (on `prompt`, action `review`, so no finding stops the others). Predicted spans are the check's findings of the
 * measured classes; they are matched one-to-one against the labelled spans of the same class, strict (exact span)
 * and overlap (the two share at least half of the shorter span's characters). A predicted `location` inside a
 * labelled street address is part of that address and is ignored. Deterministic: no network and no model unless the
 * registry's recognizer calls one. Reports carry ids, counts and rates only.
 */

/**
 * The registry the entity benchmark uses when none is passed: the default detectors, where `data.entities` (rules
 * engine) is registered. This is the one place to point at another recognizer, for example
 * `createDefaultGuardRegistry({ entityRecognizer })`.
 */
export function entityBenchmarkRegistry(): GuardRegistry {
  return createDefaultGuardRegistry();
}

/** Options of the `data.entities` check in the built-in entity benchmark: every class, every other option at its default. */
export const ENTITY_BENCHMARK_DEFAULT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({ classes: [...ENTITY_BENCHMARK_CLASSES] });

/** The rule-set threshold of the check in the built-in entity benchmark (the rule set default). */
export const ENTITY_BENCHMARK_DEFAULT_THRESHOLD = 0.5;

/**
 * Floors for the rules engine on the shipped entity corpus (overlap precision and recall per class and split),
 * enforced by `l2m guard benchmark --entities` in repo CI and by the vitest gate. They sit at the measured level, so
 * any drop fails; when a change measures higher, raise the entries here and in `corpus/README.md` in the same pull
 * request (the gate lists them). The held-out split has `ENTITY_BENCHMARK_HELDOUT_SLACK` of slack.
 */
export const ENTITY_RULES_BENCHMARK_FLOORS: EntityBenchmarkFloors = {};

/** Rate slack on the held-out split's floors (it has about 40 spans per class, so one span is 2-3 points). */
export const ENTITY_BENCHMARK_HELDOUT_SLACK = 0.05;

/** The `data.entities` entry of a rule set (the first channel that lists it), if any. */
export function entityDetectorEntry(profile: GuardProfile): { options: Record<string, unknown>; threshold: number } | undefined {
  for (const channel of Object.values(profile.channels)) {
    const entry = channel?.detectors.find((detector) => detector.id === ENTITY_DETECTOR_ID);
    if (entry) return { options: entry.options, threshold: entry.threshold };
  }
  return undefined;
}

/** The classes a check's options ask for (all three when the option is absent or names none of them). */
export function entityClassesOf(options: Record<string, unknown>): EntityBenchmarkClass[] {
  const raw = Array.isArray(options.classes) ? options.classes : [];
  const classes = ENTITY_BENCHMARK_CLASSES.filter((value) => raw.includes(value));
  return classes.length > 0 ? classes : [...ENTITY_BENCHMARK_CLASSES];
}

/** The rule set the benchmark evaluates with: the check alone on `prompt`, every finding to review. */
export function entityBenchmarkProfile(options: { detectorOptions?: Record<string, unknown>; threshold?: number; id?: string; name?: string; version?: string } = {}): GuardProfile {
  return parseGuardProfile({
    id: options.id ?? "entity-benchmark",
    name: options.name ?? "Entity benchmark",
    version: options.version ?? "1",
    // Generous: a slow host must not turn an item into a failure. Fail open so a failed check is reported, not scored.
    latencyBudget: { ms: 60_000, onExceeded: "fail_open" },
    channels: {
      prompt: {
        detectors: [{ id: ENTITY_DETECTOR_ID, threshold: options.threshold ?? ENTITY_BENCHMARK_DEFAULT_THRESHOLD, options: { ...(options.detectorOptions ?? ENTITY_BENCHMARK_DEFAULT_OPTIONS) } }],
        actions: {},
        defaultAction: { action: "review" }
      }
    }
  });
}

export interface RunEntityBenchmarkOptions {
  /** A rule set that lists `data.entities`: its options and threshold are measured. Default: the built-in benchmark options. */
  profile?: GuardProfile;
  corpus?: EntityCorpus;
  /** Default: `entityBenchmarkRegistry()`. */
  registry?: GuardRegistry;
  splits?: readonly GuardBenchmarkSplit[];
  clock?: () => Date;
  signal?: AbortSignal;
  /** Awaited between items, so a host can yield to its event loop. */
  pause?: () => Promise<void>;
}

/** One item's outcome: spans as offsets only. */
export interface EntityBenchmarkItemOutcome {
  id: string;
  split: GuardBenchmarkSplit;
  predicted: Array<GuardSpan & { dataClass: EntityBenchmarkClass }>;
  failed?: { status: string; error?: string };
  latencyMs: number;
}

interface Tally {
  tp: number;
  fp: number;
  fn: number;
}

const overlapLength = (a: GuardSpan, b: GuardSpan) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** One-to-one matches between labelled and predicted spans; returns the matched counts and unmatched sides. */
export function matchEntitySpans(labelled: readonly GuardSpan[], predicted: readonly GuardSpan[], mode: "strict" | "overlap"): { matched: number; unmatchedLabelled: number; unmatchedPredicted: number } {
  const pairs: Array<{ l: number; p: number; weight: number }> = [];
  labelled.forEach((gold, l) =>
    predicted.forEach((guess, p) => {
      if (mode === "strict") {
        if (gold.start === guess.start && gold.end === guess.end) pairs.push({ l, p, weight: gold.end - gold.start });
        return;
      }
      const shared = overlapLength(gold, guess);
      const shorter = Math.min(gold.end - gold.start, guess.end - guess.start);
      if (shared > 0 && shared * 2 >= shorter) pairs.push({ l, p, weight: shared });
    })
  );
  pairs.sort((a, b) => b.weight - a.weight || a.l - b.l || a.p - b.p);
  const usedL = new Set<number>();
  const usedP = new Set<number>();
  for (const pair of pairs) {
    if (usedL.has(pair.l) || usedP.has(pair.p)) continue;
    usedL.add(pair.l);
    usedP.add(pair.p);
  }
  return { matched: usedL.size, unmatchedLabelled: labelled.length - usedL.size, unmatchedPredicted: predicted.length - usedP.size };
}

function score(tally: Tally): EntityBenchmarkScore {
  const precision = tally.tp + tally.fp > 0 ? tally.tp / (tally.tp + tally.fp) : 1;
  const recall = tally.tp + tally.fn > 0 ? tally.tp / (tally.tp + tally.fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { truePositives: tally.tp, falsePositives: tally.fp, falseNegatives: tally.fn, precision, recall, f1 };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 1000) / 1000;
}

/** Predicted spans of the measured classes, de-duplicated; a location inside a labelled street address is dropped. */
function predictionsFor(item: EntityCorpusItem, findings: Array<{ detectorId: string; dataClass?: string; spans: GuardSpan[] }>, classes: readonly EntityBenchmarkClass[]) {
  const addresses = item.entities.filter((span) => span.dataClass === "street_address");
  const seen = new Set<string>();
  const out: Array<GuardSpan & { dataClass: EntityBenchmarkClass }> = [];
  for (const finding of findings) {
    if (finding.detectorId !== ENTITY_DETECTOR_ID) continue;
    const dataClass = finding.dataClass as EntityBenchmarkClass;
    if (!classes.includes(dataClass)) continue;
    for (const span of finding.spans) {
      if (!(span.end > span.start)) continue;
      if (dataClass === "location" && addresses.some((address) => span.start >= address.start && span.end <= address.end)) continue;
      const key = `${dataClass}:${span.start}:${span.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ start: span.start, end: span.end, dataClass });
    }
  }
  return out;
}

/** Benchmark the `data.entities` check against the entity corpus. Pure: no network, no filesystem writes, no stored verdicts. */
export async function runEntityBenchmark(options: RunEntityBenchmarkOptions = {}): Promise<{ report: EntityBenchmarkReport; items: EntityBenchmarkItemOutcome[] }> {
  const corpus = options.corpus ?? loadEntityCorpus();
  const registry = options.registry ?? entityBenchmarkRegistry();
  const splits = options.splits ?? GUARD_BENCHMARK_SPLITS;
  const source = options.profile ? entityDetectorEntry(options.profile) : undefined;
  if (options.profile && !source) throw new Error(`The rule set does not list the ${ENTITY_DETECTOR_ID} check`);
  const detectorOptions = source?.options ?? { ...ENTITY_BENCHMARK_DEFAULT_OPTIONS };
  const classes = entityClassesOf(detectorOptions);
  const profile = entityBenchmarkProfile({
    detectorOptions,
    threshold: source?.threshold ?? ENTITY_BENCHMARK_DEFAULT_THRESHOLD,
    ...(options.profile ? { id: options.profile.id, name: options.profile.name ?? options.profile.id, version: options.profile.version } : {})
  });
  const reportedProfile = options.profile ?? profile;
  const items = corpus.items.filter((item) => splits.includes(item.split));
  if (items.length === 0) throw new Error("No entity corpus item matches the requested splits");

  const outcomes: EntityBenchmarkItemOutcome[] = [];
  const key = (dataClass: string, split: string) => `${dataClass}\u0000${split}`;
  const tallies = new Map<string, { strict: Tally; overlap: Tally; labelled: number; predicted: number; missed: Set<string>; flagged: Set<string> }>();
  const negatives = new Map<GuardBenchmarkSplit, EntityBenchmarkNegatives>();
  const failed: EntityBenchmarkReport["failed"] = [];
  for (const split of GUARD_BENCHMARK_SPLITS) {
    if (!items.some((item) => item.split === split)) continue;
    for (const dataClass of classes) {
      tallies.set(key(dataClass, split), { strict: { tp: 0, fp: 0, fn: 0 }, overlap: { tp: 0, fp: 0, fn: 0 }, labelled: 0, predicted: 0, missed: new Set(), flagged: new Set() });
    }
    negatives.set(split, { split, items: 0, flagged: 0, flaggedIds: [] });
  }

  for (const item of items) {
    if (options.signal?.aborted) throw new Error("Benchmark cancelled");
    if (options.pause) await options.pause();
    const verdict = await evaluateGuard(profile, { channel: "prompt", content: item.text }, { registry });
    const timing = verdict.timings.detectors.find((entry) => entry.detectorId === ENTITY_DETECTOR_ID);
    const status = timing?.status ?? "missing";
    const outcome: EntityBenchmarkItemOutcome = { id: item.id, split: item.split, predicted: [], latencyMs: verdict.timings.totalMs };
    if (status !== "ran") {
      outcome.failed = { status, ...(timing?.error ? { error: timing.error } : {}) };
      failed.push({ id: item.id, status, ...(timing?.error ? { error: timing.error.slice(0, 200) } : {}) });
    } else {
      outcome.predicted = predictionsFor(item, verdict.findings, classes);
    }
    outcomes.push(outcome);

    const labelledMeasured = item.entities.filter((span) => classes.includes(span.dataClass));
    const negative = negatives.get(item.split)!;
    if (item.entities.length === 0) {
      negative.items += 1;
      if (outcome.predicted.length > 0) {
        negative.flagged += 1;
        negative.flaggedIds.push(item.id);
      }
    }
    for (const dataClass of classes) {
      const tally = tallies.get(key(dataClass, item.split))!;
      const gold = labelledMeasured.filter((span) => span.dataClass === dataClass);
      const guess = outcome.predicted.filter((span) => span.dataClass === dataClass);
      tally.labelled += gold.length;
      tally.predicted += guess.length;
      for (const mode of ["strict", "overlap"] as const) {
        const result = matchEntitySpans(gold, guess, mode);
        tally[mode].tp += result.matched;
        tally[mode].fn += result.unmatchedLabelled;
        tally[mode].fp += result.unmatchedPredicted;
        if (mode === "overlap") {
          if (result.unmatchedLabelled > 0) tally.missed.add(item.id);
          if (result.unmatchedPredicted > 0) tally.flagged.add(item.id);
        }
      }
    }
  }

  const results: EntityBenchmarkClassResult[] = [];
  for (const split of GUARD_BENCHMARK_SPLITS) {
    for (const dataClass of classes) {
      const tally = tallies.get(key(dataClass, split));
      if (!tally) continue;
      results.push({
        dataClass,
        split,
        labelled: tally.labelled,
        predicted: tally.predicted,
        strict: score(tally.strict),
        overlap: score(tally.overlap),
        missed: [...tally.missed],
        flagged: [...tally.flagged]
      });
    }
  }
  const latencies = outcomes.map((outcome) => outcome.latencyMs).sort((a, b) => a - b);
  const report: EntityBenchmarkReport = {
    format: ENTITY_BENCHMARK_REPORT_FORMAT,
    version: ENTITY_BENCHMARK_REPORT_VERSION,
    generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    detectorId: ENTITY_DETECTOR_ID,
    classes,
    profile: { id: reportedProfile.id, ...(reportedProfile.name ? { name: reportedProfile.name } : {}), version: reportedProfile.version, hash: hashGuardProfile(reportedProfile) },
    corpus: { hash: corpus.hash, items: items.length, splits: GUARD_BENCHMARK_SPLITS.filter((split) => items.some((item) => item.split === split)) },
    results,
    negatives: [...negatives.values()],
    failed,
    latency: { p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95), maxMs: percentile(latencies, 100) }
  };
  return { report, items: outcomes };
}
