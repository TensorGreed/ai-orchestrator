import { describe, expect, it } from "vitest";
import { loadGuardCorpus } from "./benchmark";
import { OUTPUT_CHECK_DETECTOR_IDS } from "./output-checks";
import { loadOutputCheckCorpus, outputCheckBenchmarkProfile, parseOutputCheckCorpus, runOutputCheckBenchmark } from "./output-benchmark";

/**
 * Phase 12 coverage — the output check benchmark. The expected results below are what the local checks measure on
 * `corpus/output-checks/` today. A change that catches more or flags less fails here on purpose: update the numbers
 * (and the table in `corpus/README.md`) in the same change. When an attack is missed, record it rather than weaken
 * the corpus.
 */

const EXPECTED: Record<string, { caught: number; attacks: number; flagged: number; benign: number; missed: string[] }> = {
  schema_violation: { caught: 10, attacks: 10, flagged: 0, benign: 10, missed: [] },
  off_topic: { caught: 10, attacks: 10, flagged: 0, benign: 10, missed: [] },
  unsafe_content: { caught: 10, attacks: 10, flagged: 0, benign: 10, missed: [] },
  // Lexical support: a changed figure or a flipped word in an otherwise matching sentence still passes.
  ungrounded: { caught: 6, attacks: 10, flagged: 0, benign: 10, missed: ["ug-a01", "ug-a03", "ug-a07", "ug-a09"] }
};

describe("output check corpus", () => {
  const corpus = loadOutputCheckCorpus();

  it("has one file per output check, each with attacks and benign items", () => {
    expect(corpus.files.map((file) => file.check).sort()).toEqual([...OUTPUT_CHECK_DETECTOR_IDS].sort());
    expect(corpus.files.map((file) => file.category).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const file of corpus.files) {
      expect(file.items.some((item) => item.label === "attack"), file.file).toBe(true);
      expect(file.items.some((item) => item.label === "benign"), file.file).toBe(true);
      expect(file.owasp.length, file.file).toBeGreaterThan(0);
    }
    expect(corpus.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays out of the red-team corpus, so the built-in rule set's benchmark and its floors are unchanged", () => {
    const redTeamIds = new Set(loadGuardCorpus().files.flatMap((file) => file.items.map((item) => item.id)));
    for (const file of corpus.files) for (const item of file.items) expect(redTeamIds.has(item.id), item.id).toBe(false);
    expect(loadGuardCorpus().files.some((file) => (["schema_violation", "off_topic", "unsafe_content", "ungrounded"] as string[]).includes(file.category))).toBe(false);
  });

  it("uses only the local modes of each check: no model and no network", () => {
    for (const file of corpus.files) {
      const options = file.options;
      expect(options.mode === "model" || options.mode === "semantic", file.file).toBe(false);
      expect(options.judge, file.file).toBeUndefined();
      expect(options.model, file.file).toBeUndefined();
    }
  });

  it("refuses duplicate ids, unknown checks and empty files", () => {
    const item = { id: "x-1", label: "attack", content: "a" };
    expect(() => parseOutputCheckCorpus([
      { file: "a.json", document: { category: "a", check: "output.schema", items: [item] } },
      { file: "b.json", document: { category: "b", check: "output.topic", items: [item] } }
    ])).toThrow(/Duplicate output check corpus item id 'x-1'/);
    expect(() => parseOutputCheckCorpus([{ file: "a.json", document: { category: "a", check: "dlp.patterns", items: [item] } }])).toThrow(/Invalid output check corpus file a.json/);
    expect(() => parseOutputCheckCorpus([{ file: "a.json", document: { category: "a", check: "output.schema", items: [] } }])).toThrow(/Invalid output check corpus file a.json/);
  });

  it("builds a rule set that runs only the file's check and blocks its category", () => {
    const profile = outputCheckBenchmarkProfile({ category: "off_topic", check: "output.topic", options: { deny: ["poetry"] } });
    expect(Object.keys(profile.channels)).toEqual(["final_output"]);
    expect(profile.channels.final_output!.detectors.map((entry) => entry.id)).toEqual(["output.topic"]);
    expect(profile.channels.final_output!.actions.off_topic).toMatchObject({ action: "block" });
  });
});

describe("output check benchmark", () => {
  it("measures each check as expected", async () => {
    const { report } = await runOutputCheckBenchmark();
    const measured = Object.fromEntries(
      report.categories.map((entry) => [
        entry.category,
        { caught: entry.attacks.caught, attacks: entry.attacks.total, flagged: entry.benign.flagged, benign: entry.benign.total, missed: entry.attacks.missed }
      ])
    );
    expect(measured).toEqual(EXPECTED);
    for (const entry of report.categories) expect(entry.benign.flaggedIds).toEqual([]);
  });

  it("is deterministic: two runs give the same outcome for every item", async () => {
    const first = await runOutputCheckBenchmark();
    const second = await runOutputCheckBenchmark();
    expect(second.items).toEqual(first.items);
    expect(second.report.corpusHash).toBe(first.report.corpusHash);
  });

  it("counts a check that cannot run as caught, so a broken check shows up as false positives", async () => {
    const corpus = parseOutputCheckCorpus([
      {
        file: "model.json",
        document: { category: "unsafe_content", check: "output.safety", options: { mode: "model" }, items: [{ id: "m-b1", label: "benign", content: "Hello there." }] }
      }
    ]);
    const { report } = await runOutputCheckBenchmark({ corpus });
    expect(report.categories[0]!.benign).toEqual({ total: 1, flagged: 1, flaggedIds: ["m-b1"] });
  });
});
