import { describe, expect, it } from "vitest";
import { guardBenchmarkReportSchema } from "./guard-benchmark";
import { entityBenchmarkMeasuredFloors, judgeEntityBenchmark, parseEntityBenchmarkReport, type EntityBenchmarkReport } from "./guard-entity-benchmark";

const score = (tp: number, fp: number, fn: number) => {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
};

function report(overrides: Partial<EntityBenchmarkReport> = {}): EntityBenchmarkReport {
  return {
    format: "l2m.entity-benchmark",
    version: 1,
    generatedAt: "2026-11-17T00:00:00.000Z",
    detectorId: "data.entities",
    classes: ["person_name"],
    profile: { id: "p", version: "1", hash: "h" },
    corpus: { hash: "c", items: 10, splits: ["main", "heldout"] },
    results: [
      { dataClass: "person_name", split: "main", labelled: 4, predicted: 3, strict: score(2, 1, 2), overlap: score(2, 1, 2), missed: ["m-1"], flagged: ["m-2"] },
      { dataClass: "person_name", split: "heldout", labelled: 3, predicted: 3, strict: score(1, 2, 2), overlap: score(1, 2, 2), missed: ["h-1"], flagged: ["h-2"] }
    ],
    negatives: [{ split: "main", items: 2, flagged: 1, flaggedIds: ["m-2"] }],
    failed: [],
    latency: { p50Ms: 1, p95Ms: 2, maxMs: 3 },
    ...overrides
  };
}

describe("entity benchmark gate", () => {
  it("passes at the measured floors and lists nothing to raise", () => {
    const floors = entityBenchmarkMeasuredFloors(report());
    expect(floors.person_name?.main).toEqual({ precision: 0.6666, recall: 0.5 });
    expect(judgeEntityBenchmark(report(), floors)).toEqual({ ok: true, failures: [], floorsToRaise: [] });
  });

  it("fails below a floor, with the item ids, and allows held-out slack", () => {
    const floors = { person_name: { main: { precision: 0.9, recall: 0.5 }, heldout: { precision: 0.35, recall: 0.35 } } };
    const strict = judgeEntityBenchmark(report(), floors);
    expect(strict.ok).toBe(false);
    expect(strict.failures.map((failure) => `${failure.split}:${failure.metric}`)).toEqual(["main:precision", "heldout:precision", "heldout:recall"]);
    expect(strict.failures[0]!.message).toContain("m-2");
    const slack = judgeEntityBenchmark(report(), floors, { heldoutSlack: 0.05 });
    expect(slack.failures.map((failure) => `${failure.split}:${failure.metric}`)).toEqual(["main:precision"]);
  });

  it("lists floors to raise, requires floors when asked, and fails on unchecked items", () => {
    expect(judgeEntityBenchmark(report(), { person_name: { main: { precision: 0.5, recall: 0.5 } } }).floorsToRaise).toEqual([{ dataClass: "person_name", split: "main" }]);
    const missing = judgeEntityBenchmark(report(), {}, { requireFloors: true });
    expect(missing.failures.map((failure) => failure.kind)).toEqual(["missing_floor", "missing_floor"]);
    const failed = judgeEntityBenchmark(report({ failed: [{ id: "m-9", status: "error" }] }), entityBenchmarkMeasuredFloors(report()));
    expect(failed.ok).toBe(false);
    expect(failed.failures[0]).toMatchObject({ kind: "failed_items" });
    expect(failed.failures[0]!.message).toContain("m-9");
  });

  it("parses reports and rides along in the content rules benchmark report as an optional field", () => {
    expect(parseEntityBenchmarkReport(report())).toEqual(report());
    expect(() => parseEntityBenchmarkReport({ format: "other" })).toThrow(/Not an entity benchmark report/);
    const shape = guardBenchmarkReportSchema.shape.entities;
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse(report()).success).toBe(true);
    // A stored entity block this build cannot read is dropped; the red-team report around it still parses.
    expect(shape.parse({ ...report(), version: 2 })).toBeUndefined();
  });
});
