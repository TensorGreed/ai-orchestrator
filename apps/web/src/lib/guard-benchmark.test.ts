import { describe, expect, it } from "vitest";
import type { GuardBenchmarkCategoryResult, GuardBenchmarkListEntry, GuardBenchmarkReport } from "@ai-orchestrator/shared";
import { benchmarkCategoryLabel, benchmarkCategoryRows, benchmarkComparisonLine, benchmarkDraftDenial, benchmarkTrend, canRunBenchmark, percent } from "./guard-benchmark";

function category(name: string, split: "main" | "heldout", detected: number, flagged: number): GuardBenchmarkCategoryResult {
  return {
    category: name,
    split,
    channel: "prompt",
    owasp: ["LLM01"],
    attacks: 10,
    benign: 10,
    detected,
    falsePositives: flagged,
    detectionRate: detected / 10,
    falsePositiveRate: flagged / 10,
    missed: [],
    flagged: [],
    attackActions: {},
    benignActions: {}
  };
}

function entry(id: string, version: number, corpusHash: string, splits: GuardBenchmarkListEntry["splits"]): GuardBenchmarkListEntry {
  return { id, profileId: "p", profileVersion: version, profileHash: "h", corpusHash, suites: ["profile"], detectionRate: 0.5, falsePositiveRate: 0.5, splits, attackSuccessRate: null, createdBy: null, createdAt: `2026-11-0${version}T00:00:00.000Z` };
}

describe("content rules benchmark helpers", () => {
  it("labels categories and rates", () => {
    expect(benchmarkCategoryLabel("egress_ssrf")).toBe("Egress and SSRF");
    expect(benchmarkCategoryLabel("brand_new_thing")).toBe("Brand new thing");
    expect(percent(0.9142)).toBe("91.4%");
    expect(percent(1)).toBe("100%");
  });

  it("puts each category's main and held-out results on one row", () => {
    const report = { categories: [category("jailbreak", "main", 7, 0), category("sql_injection", "main", 10, 0), category("jailbreak", "heldout", 3, 1)] } as GuardBenchmarkReport;
    const rows = benchmarkCategoryRows(report);
    expect(rows.map((row) => [row.category, row.main?.detected, row.heldout?.detected ?? null])).toEqual([["jailbreak", 7, 3], ["sql_injection", 10, null]]);
    expect(rows[0]!.label).toBe("Jailbreak");
  });

  it("turns the stored list into a trend, oldest first, noting corpus changes", () => {
    const trend = benchmarkTrend([
      entry("c", 3, "corpus-2", [{ split: "heldout", detectionRate: 0.6, falsePositiveRate: 0.1 }]),
      entry("b", 2, "corpus-1", [{ split: "main", detectionRate: 0.9, falsePositiveRate: 0.1 }, { split: "heldout", detectionRate: 0.7, falsePositiveRate: 0.2 }]),
      entry("a", 1, "corpus-1", [{ split: "main", detectionRate: 0.8, falsePositiveRate: 0.2 }])
    ]);
    expect(trend.map((point) => [point.label, point.detectionRate, point.heldoutDetectionRate, point.corpusChanged])).toEqual([
      ["v1", 0.8, null, false],
      ["v2", 0.9, 0.7, false],
      ["v3", 0.6, null, true]
    ]);
  });

  it("says how a result compares with the last stored one", () => {
    expect(benchmarkComparisonLine(null, null)).toMatch(/First stored benchmark/);
    const ok = { ok: true, failures: [], newlyMissed: [], newlyFlagged: [], corpusChanged: false };
    expect(benchmarkComparisonLine(ok, { profileVersion: 4 })).toBe("No regression against the last stored benchmark (v4).");
    const failed = { ...ok, ok: false, failures: [{ kind: "regression" as const, category: "x", split: "main" as const, metric: "detection" as const, expected: 1, actual: 0.5, message: "m" }] };
    expect(benchmarkComparisonLine(failed, { profileVersion: 4 })).toBe("1 regression against the last stored benchmark (v4).");
  });

  it("lets builders benchmark saved versions of any rule set, and drafts of the rule sets they may edit", () => {
    expect(canRunBenchmark("builder")).toBe(true);
    expect(canRunBenchmark("viewer")).toBe(false);
    expect(benchmarkDraftDenial("admin", { builtIn: true })).toBeNull();
    expect(benchmarkDraftDenial("builder", { builtIn: false })).toBeNull();
    expect(benchmarkDraftDenial("builder", { builtIn: true })).toMatch(/default rule set is read-only/);
    expect(benchmarkDraftDenial("builder", { builtIn: false, enforced: true })).toMatch(/A project enforces/);
    expect(benchmarkDraftDenial("operator", { builtIn: false })).toMatch(/Only admins and builders/);
  });
});
