import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_BENCHMARK_CLASSES, ENTITY_DETECTOR_ID, entityBenchmarkReportSchema, judgeEntityBenchmark } from "@ai-orchestrator/shared";
import { loadGuardCorpus } from "./benchmark";
import { entityCorpusDir, loadEntityCorpus, parseEntityCorpus } from "./entity-corpus";
import {
  ENTITY_BENCHMARK_HELDOUT_SLACK,
  ENTITY_RULES_BENCHMARK_FLOORS,
  entityBenchmarkProfile,
  entityBenchmarkRegistry,
  entityClassesOf,
  entityDetectorEntry,
  matchEntitySpans,
  runEntityBenchmark
} from "./entity-benchmark";
import { entityCorpusDocument, entityMarkupOf, mainEntityCorpusText, parseEntityMarkup } from "./entity-corpus-generator";
import { GuardRegistry } from "./registry";
import { parseGuardProfile } from "./profile";
import type { GuardDetector, GuardFinding } from "./types";

const corpus = loadEntityCorpus();

/** A stand-in for the real check, for testing the runner only: answers with the given spans per text. */
function scriptedEntityDetector(answer: (text: string) => Array<{ start: number; end: number; dataClass: string }> | Error): GuardDetector {
  return {
    id: ENTITY_DETECTOR_ID,
    tier: "classifier",
    description: "test stand-in",
    channels: ["prompt"],
    categories: ["sensitive_data"],
    detect(_input, context): GuardFinding[] {
      const spans = answer(context.text);
      if (spans instanceof Error) throw spans;
      return spans.map((span) => ({
        detectorId: ENTITY_DETECTOR_ID,
        category: "sensitive_data",
        dataClass: span.dataClass,
        score: 0.9,
        spans: [{ start: span.start, end: span.end }],
        evidence: "***",
        message: "test"
      }));
    }
  };
}

const goldByText = new Map(corpus.items.map((item) => [item.text, item.entities]));
const oracle = () => new GuardRegistry().register(scriptedEntityDetector((text) => goldByText.get(text) ?? []));

describe("entity corpus", () => {
  it("the generator reproduces the committed main split exactly", () => {
    expect(readFileSync(join(entityCorpusDir(), "main.json"), "utf8")).toBe(mainEntityCorpusText());
  });

  it("has about 300 main and 120 held-out items, every class in both splits, and look-alikes with no span", () => {
    const main = corpus.items.filter((item) => item.split === "main");
    const heldout = corpus.items.filter((item) => item.split === "heldout");
    expect(main).toHaveLength(300);
    expect(heldout).toHaveLength(120);
    for (const split of [main, heldout]) {
      for (const dataClass of ENTITY_BENCHMARK_CLASSES) expect(split.filter((item) => item.entities.some((span) => span.dataClass === dataClass)).length).toBeGreaterThanOrEqual(20);
      expect(split.filter((item) => item.entities.length === 0).length).toBeGreaterThanOrEqual(25);
      expect(split.every((item) => item.lang === "en")).toBe(true);
    }
    for (const country of ["us", "uk", "ca", "au", "de", "fr"]) {
      expect(main.filter((item) => item.tags.includes(country) && item.entities.some((span) => span.dataClass === "street_address")).length).toBe(16);
    }
    expect(new Set(corpus.items.map((item) => item.text)).size).toBe(corpus.items.length);
    expect(corpus.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the red-team corpus as it was (the entity folder is not read by its loader)", () => {
    expect(loadGuardCorpus().files.some((file) => file.file.includes("entit"))).toBe(false);
  });

  it("markup round-trips and rejects bad spans", () => {
    const parsed = parseEntityMarkup("Dear ⟦person_name|Mary⟧, ship to ⟦street_address|12 Larkspur Lane\nLeeds LS6 2QT⟧.");
    expect(parsed.text).toBe("Dear Mary, ship to 12 Larkspur Lane\nLeeds LS6 2QT.");
    expect(parsed.entities).toEqual([
      { start: 5, end: 9, class: "person_name" },
      { start: 19, end: 49, class: "street_address" }
    ]);
    expect(entityMarkupOf(parsed.text, parsed.entities)).toBe("Dear ⟦person_name|Mary⟧, ship to ⟦street_address|12 Larkspur Lane\nLeeds LS6 2QT⟧.");
    expect(() => parseEntityMarkup("⟦org|Acme⟧")).toThrow(/Unknown class/);
    expect(() => parseEntityMarkup("⟦location| Leeds⟧")).toThrow(/outer whitespace/);
    expect(() => parseEntityMarkup("⟦location|Leeds")).toThrow(/Unclosed/);
    expect(() => parseEntityMarkup("Leeds⟧")).toThrow(/Unbalanced/);
    expect(() => parseEntityMarkup("⟦location|a ⟦location|b⟧⟧")).toThrow(/Nested/);
  });

  it("the loader refuses duplicate ids, spans outside the text and overlapping spans", () => {
    const doc = entityCorpusDocument("main", [{ id: "x-1", tags: [], markup: "⟦location|Leeds⟧" }], { description: "", source: "test" });
    expect(() => parseEntityCorpus([{ file: "a.json", document: doc }, { file: "b.json", document: doc }])).toThrow(/Duplicate/);
    const outside = structuredClone(doc);
    outside.items[0]!.entities = [{ start: 0, end: 50, class: "location" }];
    expect(() => parseEntityCorpus([{ file: "a.json", document: outside }])).toThrow(/outside the text/);
    const overlapping = structuredClone(doc);
    overlapping.items[0]!.entities = [{ start: 0, end: 3, class: "location" }, { start: 2, end: 5, class: "location" }];
    expect(() => parseEntityCorpus([{ file: "a.json", document: overlapping }])).toThrow(/overlap/);
  });
});

describe("span matching", () => {
  it("strict needs the exact span; overlap needs half of the shorter span; matches are one-to-one", () => {
    const gold = [{ start: 0, end: 10 }];
    expect(matchEntitySpans(gold, [{ start: 0, end: 10 }], "strict")).toEqual({ matched: 1, unmatchedLabelled: 0, unmatchedPredicted: 0 });
    expect(matchEntitySpans(gold, [{ start: 0, end: 9 }], "strict")).toEqual({ matched: 0, unmatchedLabelled: 1, unmatchedPredicted: 1 });
    expect(matchEntitySpans(gold, [{ start: 5, end: 30 }], "overlap").matched).toBe(1);
    expect(matchEntitySpans(gold, [{ start: 8, end: 30 }], "overlap").matched).toBe(0);
    expect(matchEntitySpans(gold, [{ start: 0, end: 6 }, { start: 4, end: 10 }], "overlap")).toEqual({ matched: 1, unmatchedLabelled: 0, unmatchedPredicted: 1 });
  });
});

describe("runEntityBenchmark", () => {
  it("scores a perfect stand-in at 1 everywhere, through the evaluate API", async () => {
    const { report } = await runEntityBenchmark({ registry: oracle(), clock: () => new Date("2026-11-17T00:00:00Z") });
    expect(entityBenchmarkReportSchema.parse(report)).toEqual(report);
    expect(report.failed).toEqual([]);
    expect(report.results).toHaveLength(6);
    for (const result of report.results) {
      expect(result.strict.precision).toBe(1);
      expect(result.strict.recall).toBe(1);
      expect(result.overlap.f1).toBe(1);
      expect(result.missed).toEqual([]);
    }
    expect(report.negatives.map((entry) => entry.flagged)).toEqual([0, 0]);
    expect(JSON.stringify(report)).not.toContain("Larkspur");
  });

  it("counts misses, false positives on look-alikes, and ignores places inside a labelled address", async () => {
    const lookalike = corpus.items.find((item) => item.entities.length === 0 && item.split === "main")!;
    const withAddress = corpus.items.find((item) => item.split === "main" && item.entities.some((span) => span.dataClass === "street_address"))!;
    const address = withAddress.entities.find((span) => span.dataClass === "street_address")!;
    const registry = new GuardRegistry().register(
      scriptedEntityDetector((text) => {
        if (text === lookalike.text) return [{ start: 0, end: 3, dataClass: "person_name" }];
        if (text === withAddress.text) return [{ start: address.start + 1, end: address.start + 4, dataClass: "location" }];
        return [];
      })
    );
    const { report } = await runEntityBenchmark({ registry, splits: ["main"] });
    const names = report.results.find((result) => result.dataClass === "person_name")!;
    expect(names.overlap.falsePositives).toBe(1);
    expect(names.flagged).toEqual([lookalike.id]);
    expect(names.overlap.recall).toBe(0);
    const places = report.results.find((result) => result.dataClass === "location")!;
    expect(places.overlap.falsePositives).toBe(0);
    expect(report.negatives).toEqual([expect.objectContaining({ split: "main", flagged: 1, flaggedIds: [lookalike.id] })]);
  });

  it("reports items the check did not run on (missing or failing), and counts their spans as missed", async () => {
    const missing = await runEntityBenchmark({ registry: new GuardRegistry(), splits: ["heldout"] });
    expect(missing.report.failed).toHaveLength(120);
    expect(missing.report.failed[0]).toMatchObject({ status: "missing" });
    expect(missing.report.results.every((result) => result.overlap.recall === 0 || result.labelled === 0)).toBe(true);
    const judgement = judgeEntityBenchmark(missing.report, {});
    expect(judgement.ok).toBe(false);
    expect(judgement.failures[0]!.kind).toBe("failed_items");

    const throwing = await runEntityBenchmark({ registry: new GuardRegistry().register(scriptedEntityDetector(() => new Error("recognizer down"))), splits: ["heldout"] });
    expect(throwing.report.failed[0]).toMatchObject({ status: "error", error: "recognizer down" });
  });

  it("measures a rule set's own options and classes, and refuses a rule set without the check", async () => {
    const profile = parseGuardProfile({
      id: "rs-names",
      name: "Names",
      version: "3",
      channels: { model_output: { detectors: [{ id: ENTITY_DETECTOR_ID, threshold: 0.7, options: { classes: ["person_name"] } }] } }
    });
    expect(entityDetectorEntry(profile)).toEqual({ options: { classes: ["person_name"] }, threshold: 0.7 });
    const { report } = await runEntityBenchmark({ profile, registry: oracle(), splits: ["main"] });
    expect(report.classes).toEqual(["person_name"]);
    expect(report.results.map((result) => result.dataClass)).toEqual(["person_name"]);
    expect(report.profile).toMatchObject({ id: "rs-names", version: "3" });
    await expect(runEntityBenchmark({ profile: parseGuardProfile({ id: "x", name: "x", version: "1", channels: {} }), registry: oracle() })).rejects.toThrow(/does not list/);
    expect(entityClassesOf({})).toEqual([...ENTITY_BENCHMARK_CLASSES]);
    expect(entityBenchmarkProfile().channels.prompt?.detectors[0]?.options).toEqual({ classes: [...ENTITY_BENCHMARK_CLASSES] });
  });
});

// The gate on the real check: runs once data.entities is registered in the default registry.
describe.skipIf(!entityBenchmarkRegistry().has(ENTITY_DETECTOR_ID))("rules engine floors", () => {
  it("meets ENTITY_RULES_BENCHMARK_FLOORS exactly (set every class and split; raise them when it measures higher)", async () => {
    const { report } = await runEntityBenchmark();
    const judgement = judgeEntityBenchmark(report, ENTITY_RULES_BENCHMARK_FLOORS, { heldoutSlack: ENTITY_BENCHMARK_HELDOUT_SLACK, requireFloors: true });
    expect(judgement.failures.map((failure) => failure.message)).toEqual([]);
    expect(judgement.floorsToRaise).toEqual([]);
  });
});
