/**
 * 12.7 — pure helpers behind Security > Benchmark and the rule set editor's
 * "Benchmark this draft": category rows across splits, the trend per stored
 * version, the comparison line, and who may benchmark a draft.
 */

import type { GuardBenchmarkCategoryResult, GuardBenchmarkJudgement, GuardBenchmarkListEntry, GuardBenchmarkReport } from "@ai-orchestrator/shared";

const CATEGORY_LABELS: Record<string, string> = {
  direct_injection: "Direct prompt injection",
  jailbreak: "Jailbreak",
  indirect_injection: "Indirect injection (tool results)",
  sql_injection: "SQL injection",
  exfiltration: "Exfiltration in answers",
  command_injection: "Command injection",
  path_traversal: "Path traversal",
  egress_ssrf: "Egress and SSRF",
  dlp_secrets: "Secrets and personal data",
  canary_leak: "Canary (system prompt) leak",
  argument_validation: "Tool argument validation"
};

export function benchmarkCategoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category]!;
  const text = category.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function percent(rate: number): string {
  const value = rate * 100;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

export interface BenchmarkCategoryRow {
  category: string;
  label: string;
  channel: string;
  owasp: string[];
  main: GuardBenchmarkCategoryResult | null;
  heldout: GuardBenchmarkCategoryResult | null;
}

/** One row per category, its main and held-out results side by side, in report order. */
export function benchmarkCategoryRows(report: GuardBenchmarkReport): BenchmarkCategoryRow[] {
  const rows = new Map<string, BenchmarkCategoryRow>();
  for (const result of report.categories) {
    const row = rows.get(result.category) ?? { category: result.category, label: benchmarkCategoryLabel(result.category), channel: result.channel, owasp: result.owasp, main: null, heldout: null };
    row[result.split] = result;
    rows.set(result.category, row);
  }
  return [...rows.values()];
}

export interface BenchmarkTrendPoint {
  id: string;
  label: string;
  createdAt: string;
  detectionRate: number;
  falsePositiveRate: number;
  heldoutDetectionRate: number | null;
  attackSuccessRate: number | null;
  /** The corpus changed since the point before, so the step may come from the corpus rather than the rule set. */
  corpusChanged: boolean;
}

/**
 * Stored benchmarks (newest first, as the API lists them) as a trend, oldest
 * first. Main-split rates are the headline when the main split ran; a
 * benchmark of the held-out split alone shows its held-out rates.
 */
export function benchmarkTrend(entries: readonly GuardBenchmarkListEntry[]): BenchmarkTrendPoint[] {
  const ordered = [...entries].reverse();
  return ordered.map((entry, index) => {
    const main = entry.splits.find((split) => split.split === "main");
    const heldout = entry.splits.find((split) => split.split === "heldout");
    const headline = main ?? heldout;
    return {
      id: entry.id,
      label: `v${entry.profileVersion}`,
      createdAt: entry.createdAt,
      detectionRate: headline?.detectionRate ?? entry.detectionRate,
      falsePositiveRate: headline?.falsePositiveRate ?? entry.falsePositiveRate,
      heldoutDetectionRate: heldout && main ? heldout.detectionRate : null,
      attackSuccessRate: entry.attackSuccessRate,
      corpusChanged: index > 0 && ordered[index - 1]!.corpusHash !== entry.corpusHash
    };
  });
}

/** How a result compares with the stored one before it, in one line. */
export function benchmarkComparisonLine(comparison: GuardBenchmarkJudgement | null, baseline: { profileVersion: number } | null): string {
  if (!comparison || !baseline) return "First stored benchmark of this rule set: nothing to compare with yet.";
  const against = `the last stored benchmark (v${baseline.profileVersion})`;
  if (comparison.ok) {
    const better = comparison.newlyMissed.length === 0 && comparison.newlyFlagged.length === 0;
    return better ? `No regression against ${against}.` : `No rate regression against ${against}, though some items changed.`;
  }
  return `${comparison.failures.length} regression${comparison.failures.length === 1 ? "" : "s"} against ${against}.`;
}

/** Who may benchmark the editor's unsaved draft: the rule set editor's rule (the server checks it too). */
export function benchmarkDraftDenial(role: string, profile: { builtIn: boolean; enforced?: boolean }): string | null {
  if (role === "admin") return null;
  if (role !== "builder") return "Only admins and builders can run content rules benchmarks.";
  if (profile.builtIn) return "The default rule set is read-only: only an admin can benchmark a draft of it. Duplicate it to benchmark your own.";
  if (profile.enforced) return "A project enforces this rule set: only an admin can benchmark a draft of it.";
  return null;
}

/** Saved versions may be benchmarked by builders and admins, the default rule set included. */
export function canRunBenchmark(role: string): boolean {
  return role === "admin" || role === "builder";
}
