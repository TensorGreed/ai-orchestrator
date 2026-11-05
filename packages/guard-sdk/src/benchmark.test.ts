import { describe, expect, it } from "vitest";
import { checkGuardBenchmarkFloors, compareGuardBenchmarks, guardBenchmarkFloorsToRaise, judgeGuardBenchmark, parseGuardBenchmarkReport } from "@ai-orchestrator/shared";
import {
  BENCHMARK_PUBLIC_ADDRESS,
  BUILT_IN_PROFILE_BENCHMARK_FLOORS,
  BUILT_IN_PROFILE_HELDOUT_SLACK_ITEMS,
  benchmarkResolver,
  loadGuardCorpus,
  parseGuardCorpus,
  runGuardBenchmark
} from "./benchmark";
import { createDefaultGuardProfile } from "./default-profile";
import { parseGuardProfile } from "./profile";

/**
 * Phase 12.7 — the corpus benchmark gate for the default rule set. Floors sit
 * at the measured level in `BUILT_IN_PROFILE_BENCHMARK_FLOORS` and are listed
 * in `corpus/README.md`; change them there and here together.
 */

const corpus = loadGuardCorpus();

describe("content rules corpus", () => {
  it("has a main and a held-out split for every category, each with attacks and benign items", () => {
    const categories = new Set(corpus.files.map((file) => file.category));
    expect([...categories].sort()).toEqual([
      "argument_validation",
      "canary_leak",
      "command_injection",
      "direct_injection",
      "dlp_secrets",
      "egress_ssrf",
      "exfiltration",
      "indirect_injection",
      "jailbreak",
      "path_traversal",
      "sql_injection"
    ]);
    for (const category of categories) {
      for (const split of ["main", "heldout"] as const) {
        const file = corpus.files.find((entry) => entry.category === category && entry.split === split);
        expect(file, `${category} ${split}`).toBeDefined();
        expect(file!.items.some((item) => item.label === "attack")).toBe(true);
        expect(file!.items.some((item) => item.label === "benign")).toBe(true);
        expect(file!.owasp.length).toBeGreaterThan(0);
      }
    }
    expect(corpus.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses duplicate ids and malformed files", () => {
    const item = { id: "x-1", label: "attack", content: "a" };
    expect(() => parseGuardCorpus([
      { file: "a.json", split: "main", document: { category: "a", channel: "prompt", items: [item] } },
      { file: "b.json", split: "heldout", document: { category: "a", channel: "prompt", items: [item] } }
    ])).toThrow(/Duplicate corpus item id 'x-1'/);
    expect(() => parseGuardCorpus([{ file: "a.json", split: "main", document: { category: "a", channel: "nowhere", items: [item] } }])).toThrow(/Invalid corpus file main\/a.json/);
  });

  it("decodes contentB64 to the same content, so the hash does not depend on the encoding", () => {
    const value = { note: "caf\u00e9 \u2713", n: [1, 2] };
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    const doc = (item: object) => [{ file: "a.json", split: "main" as const, document: { category: "a", channel: "prompt", items: [item] } }];
    const plain = parseGuardCorpus(doc({ id: "x-1", label: "attack", content: value }));
    const b64 = parseGuardCorpus(doc({ id: "x-1", label: "attack", contentB64: encoded }));
    expect(b64.files[0]?.items[0]).toEqual({ id: "x-1", label: "attack", content: value });
    expect(b64.hash).toBe(plain.hash);
    expect(() => parseGuardCorpus(doc({ id: "x-1", label: "attack", content: "a", contentB64: encoded }))).toThrow(/both content and contentB64/);
    expect(() => parseGuardCorpus(doc({ id: "x-1", label: "attack", contentB64: "!!!" }))).toThrow(/undecodable contentB64/);
  });

  it("answers DNS from the corpus and resolves every other name to one public address", async () => {
    const resolve = benchmarkResolver(corpus);
    expect(await resolve("rebind.attacker.example")).toEqual(["10.0.0.7"]);
    expect(await resolve("api.example.com")).toEqual([BENCHMARK_PUBLIC_ADDRESS]);
  });
});

describe("default rule set benchmark", () => {
  it("meets the measured floors on both splits", async () => {
    const { report } = await runGuardBenchmark({ profile: createDefaultGuardProfile() });
    expect(parseGuardBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
    const failures = checkGuardBenchmarkFloors(report, BUILT_IN_PROFILE_BENCHMARK_FLOORS, { heldoutSlackItems: BUILT_IN_PROFILE_HELDOUT_SLACK_ITEMS });
    expect(failures.map((failure) => failure.message)).toEqual([]);
    // The main split is exact and every floor sits at the measured level (the ratchet), so nothing is above its floor.
    expect(checkGuardBenchmarkFloors(report, BUILT_IN_PROFILE_BENCHMARK_FLOORS)).toEqual([]);
    expect(guardBenchmarkFloorsToRaise(report, BUILT_IN_PROFILE_BENCHMARK_FLOORS)).toEqual([]);
    // Every category and split has a floor, so a new category cannot slip in ungated.
    for (const result of report.categories) expect(BUILT_IN_PROFILE_BENCHMARK_FLOORS[result.category]?.[result.split], `${result.category} ${result.split}`).toBeDefined();
    expect(report.splits).toEqual(["main", "heldout"]);
    expect(report.latency.p95Ms).toBeGreaterThanOrEqual(report.latency.p50Ms);
    // Reports carry ids and counts, never corpus content.
    expect(JSON.stringify(report)).not.toContain("Ignore all previous instructions");
  });

  it("is deterministic apart from timings", async () => {
    const strip = (value: Awaited<ReturnType<typeof runGuardBenchmark>>["report"]) => ({ ...value, generatedAt: "", latency: null });
    const clock = () => new Date("2026-11-04T00:00:00Z");
    const first = await runGuardBenchmark({ profile: createDefaultGuardProfile(), categories: ["sql_injection", "egress_ssrf"], clock });
    const second = await runGuardBenchmark({ profile: createDefaultGuardProfile(), categories: ["sql_injection", "egress_ssrf"], clock });
    expect(strip(second.report)).toEqual(strip(first.report));
  });
});

describe("any rule set, compared with a baseline", () => {
  const loose = parseGuardProfile({ id: "loose", name: "Loose", version: "1", channels: {} });

  it("benchmarks a rule set that checks nothing as missing every attack and flagging nothing", async () => {
    const { report } = await runGuardBenchmark({ profile: loose, splits: ["main"] });
    expect(report.splits).toEqual(["main"]);
    for (const result of report.categories) {
      expect(result.detected).toBe(0);
      expect(result.falsePositives).toBe(0);
      expect(result.attackActions).toEqual({ allow: result.attacks });
    }
    expect(report.detectors).toEqual([]);
  });

  it("lists regressions and newly missed ids against the built-in baseline", async () => {
    const { report: baseline } = await runGuardBenchmark({ profile: createDefaultGuardProfile(), categories: ["direct_injection", "sql_injection"], splits: ["main"] });
    const { report: current } = await runGuardBenchmark({ profile: loose, categories: ["direct_injection", "sql_injection"], splits: ["main"] });
    const comparison = compareGuardBenchmarks(baseline, current);
    expect(comparison.failures.map((failure) => [failure.category, failure.metric])).toEqual([
      ["direct_injection", "detection"],
      ["sql_injection", "detection"]
    ]);
    expect(comparison.newlyMissed.map((entry) => entry.id)).toContain("di-a01");
    expect(comparison.corpusChanged).toBe(false);
    expect(judgeGuardBenchmark(current, { baseline }).ok).toBe(false);
    // The other way round nothing regresses: detection rose and the loose rule set flagged nothing.
    expect(judgeGuardBenchmark(baseline, { baseline: current }).ok).toBe(true);
  });

  it("refuses an unknown category filter", async () => {
    await expect(runGuardBenchmark({ profile: loose, categories: ["nope"] })).rejects.toThrow(/No corpus category/);
  });
});
