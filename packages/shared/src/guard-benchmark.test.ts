import { describe, expect, it } from "vitest";
import {
  checkGuardBenchmarkFloors,
  compareGuardBenchmarks,
  guardBenchmarkFloorsToRaise,
  guardBenchmarkHeadline,
  guardBenchmarkRequestSchema,
  judgeGuardBenchmark,
  parseGuardBenchmarkReport,
  type GuardBenchmarkCategoryResult,
  type GuardBenchmarkReport,
  type GuardWorkflowSuiteResult
} from "./guard-benchmark";

function category(name: string, detected: number, flagged: string[], missed: string[] = [], split: "main" | "heldout" = "main"): GuardBenchmarkCategoryResult {
  return {
    category: name,
    split,
    channel: "prompt",
    owasp: ["LLM01"],
    attacks: 10,
    benign: 10,
    detected,
    falsePositives: flagged.length,
    detectionRate: detected / 10,
    falsePositiveRate: flagged.length / 10,
    missed,
    flagged: flagged.map((id) => ({ id, action: "block", detectors: ["injection.direct"] })),
    attackActions: { block: detected, allow: 10 - detected },
    benignActions: { allow: 10 - flagged.length, block: flagged.length }
  };
}

function report(categories: GuardBenchmarkCategoryResult[], workflow?: GuardWorkflowSuiteResult[], hash = "c1"): GuardBenchmarkReport {
  const attacks = categories.reduce((sum, entry) => sum + entry.attacks, 0);
  const detected = categories.reduce((sum, entry) => sum + entry.detected, 0);
  const benign = categories.reduce((sum, entry) => sum + entry.benign, 0);
  const falsePositives = categories.reduce((sum, entry) => sum + entry.falsePositives, 0);
  return {
    format: "l2m.guard-benchmark",
    version: 1,
    generatedAt: "2026-11-04T00:00:00.000Z",
    profile: { id: "p", version: "1", hash: "h" },
    corpus: { hash, items: attacks + benign, attacks, benign, categories: [...new Set(categories.map((entry) => entry.category))] },
    splits: ["main"],
    totals: [{ split: "main", attacks, benign, detected, falsePositives, detectionRate: detected / attacks, falsePositiveRate: falsePositives / benign }],
    categories,
    detectors: [],
    latency: { p50Ms: 0.1, p95Ms: 0.4, maxMs: 1 },
    ...(workflow ? { workflow: { suite: "reference-agent", version: "1", categories: ["indirect_injection"], results: workflow } } : {})
  };
}

const wf = (succeeded: number): GuardWorkflowSuiteResult => ({
  configuration: "guard",
  split: "main",
  attacks: 10,
  benign: 10,
  detected: 10 - succeeded,
  detectionRate: (10 - succeeded) / 10,
  attackSucceeded: succeeded,
  attackSuccessRate: succeeded / 10,
  falsePositives: 0,
  falsePositiveRate: 0,
  succeeded: Array.from({ length: succeeded }, (_, index) => `ii-a0${index}`),
  flagged: [],
  pausedForApproval: 0
});

describe("content rules benchmark gate", () => {
  it("fails floors on low detection and high false positives, and passes at the floor exactly", () => {
    const current = report([category("direct_injection", 9, ["di-b01"], ["di-a03"])]);
    expect(checkGuardBenchmarkFloors(current, { direct_injection: { main: { detection: 9 / 10, falsePositive: 1 / 10 } } })).toEqual([]);
    const failures = checkGuardBenchmarkFloors(current, { direct_injection: { main: { detection: 1, falsePositive: 0 } } });
    expect(failures.map((failure) => failure.metric)).toEqual(["detection", "false_positive"]);
    expect(failures[0]!.message).toContain("missed di-a03");
    // A split without a floor is not gated.
    expect(checkGuardBenchmarkFloors(current, { direct_injection: { heldout: { detection: 1, falsePositive: 0 } } })).toEqual([]);
  });

  it("allows held-out slack of whole items only, keeps the main split exact and lists floors to raise", () => {
    const floors = { direct_injection: { main: { detection: 1, falsePositive: 0 }, heldout: { detection: 1, falsePositive: 0 } } };
    const oneOff = report([category("direct_injection", 9, ["di-b01"], ["di-a03"]), category("direct_injection", 9, ["h-di-b01"], ["h-di-a03"], "heldout")]);
    const slack = checkGuardBenchmarkFloors(oneOff, floors, { heldoutSlackItems: 1 });
    expect(slack.map((failure) => `${failure.split}:${failure.metric}`)).toEqual(["main:detection", "main:false_positive"]);
    const twoOff = report([category("direct_injection", 8, ["h-di-b01", "h-di-b02"], ["h-di-a03", "h-di-a04"], "heldout")]);
    expect(checkGuardBenchmarkFloors(twoOff, floors, { heldoutSlackItems: 1 }).map((failure) => failure.metric)).toEqual(["detection", "false_positive"]);
    expect(judgeGuardBenchmark(oneOff, { floors, heldoutSlackItems: 1 }).failures).toHaveLength(2);
    const better = report([category("direct_injection", 10, [])]);
    expect(guardBenchmarkFloorsToRaise(better, { direct_injection: { main: { detection: 0.9, falsePositive: 0 } } })).toEqual([{ category: "direct_injection", split: "main" }]);
    expect(guardBenchmarkFloorsToRaise(better, floors)).toEqual([]);
  });

  it("compares with a baseline per category, lists changed ids and honours a tolerance", () => {
    const baseline = report([category("direct_injection", 10, []), category("sql_injection", 8, ["sq-b01"], ["sq-a01", "sq-a02"])]);
    const current = report([category("direct_injection", 9, ["di-b02"], ["di-a07"]), category("sql_injection", 9, [], ["sq-a01"]), category("jailbreak", 1, ["jb-b01"])]);
    const comparison = compareGuardBenchmarks(baseline, current);
    expect(comparison.failures.map((failure) => `${failure.category}:${failure.metric}`)).toEqual(["direct_injection:detection", "direct_injection:false_positive"]);
    expect(comparison.newlyMissed).toEqual([{ category: "direct_injection", split: "main", id: "di-a07" }]);
    expect(comparison.newlyFlagged).toEqual([{ category: "direct_injection", split: "main", id: "di-b02" }]);
    expect(compareGuardBenchmarks(baseline, current, { tolerance: 0.1 }).failures).toEqual([]);
    expect(compareGuardBenchmarks(baseline, report(current.categories, undefined, "c2")).corpusChanged).toBe(true);
  });

  it("fails when the workflow suite's attack success rises", () => {
    const judgement = judgeGuardBenchmark(report([category("indirect_injection", 10, [])], [wf(2)]), { baseline: report([category("indirect_injection", 10, [])], [wf(0)]) });
    expect(judgement.ok).toBe(false);
    expect(judgement.failures[0]).toMatchObject({ category: "workflow:guard", metric: "attack_success", expected: 0, actual: 0.2 });
    expect(judgeGuardBenchmark(report([category("indirect_injection", 10, [])])).ok).toBe(true);
  });

  it("parses reports, computes headlines and validates requests", () => {
    const value = report([category("direct_injection", 9, ["di-b01"])]);
    expect(parseGuardBenchmarkReport(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(() => parseGuardBenchmarkReport({ format: "other" })).toThrow(/Not a content rules benchmark report/);
    expect(guardBenchmarkHeadline(value)).toEqual({ detectionRate: 0.9, falsePositiveRate: 0.1 });
    expect(guardBenchmarkRequestSchema.safeParse({ document: {}, version: 2 }).success).toBe(false);
    expect(guardBenchmarkRequestSchema.safeParse({ suites: ["profile", "workflow"], splits: ["heldout"] }).success).toBe(true);
    expect(guardBenchmarkRequestSchema.safeParse({ extra: true }).success).toBe(false);
  });
});
