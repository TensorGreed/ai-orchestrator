import { describe, expect, it } from "vitest";
import type { RawSpan } from "./gliner.js";
import type { NerPrompt } from "./models/manifest.js";
import { calibrate, entitiesFromRaw, NER_CALIBRATED_CUT, NER_MIN_RAW_CUTOFF, planPrompts, rawCutoff } from "./spans.js";

const prompts: NerPrompt[] = [
  { prompt: "name", class: "person_name", addressPart: false, threshold: 0.5 },
  { prompt: "location street", class: "street_address", addressPart: false, threshold: 0.45 },
  { prompt: "location city", class: "location", addressPart: true, threshold: 0.4, joinThreshold: 0.3 },
  { prompt: "location state", class: "location", addressPart: true, threshold: 0.5, joinThreshold: 0.3 },
  { prompt: "location zip", class: null, addressPart: true, threshold: 0.5, joinThreshold: 0.3 }
];
const model = { prompts };
const ALL = ["person_name", "location", "street_address"] as const;

/** Raw spans by text: `find(text, "Main Street", "location street", 0.7)`. */
function raw(text: string, plan: ReturnType<typeof planPrompts>, items: Array<[string, string, number]>): RawSpan[] {
  return items.map(([value, prompt, score]) => {
    const start = text.indexOf(value);
    if (start < 0) throw new Error(`${value} not in text`);
    return { start, end: start + value.length, prompt: plan.prompts.findIndex((entry) => entry.prompt === prompt), score };
  });
}

function run(text: string, items: Array<[string, string, number]>, labels: readonly (typeof ALL)[number][] = ALL, threshold?: number) {
  const plan = planPrompts(model, labels, threshold);
  return entitiesFromRaw(text, raw(text, plan, items), plan, 6).map((entity) => ({ label: entity.label, text: text.slice(entity.start, entity.end), score: entity.score }));
}

describe("calibration", () => {
  it("maps the prompt's threshold to the calibrated cut and keeps the order", () => {
    expect(calibrate(0.4, 0.4)).toBe(NER_CALIBRATED_CUT);
    expect(calibrate(1, 0.4)).toBe(1);
    expect(calibrate(0, 0.4)).toBe(0);
    expect(calibrate(0.2, 0.4)).toBe(0.4);
    expect(calibrate(0.7, 0.4)).toBe(0.9);
    expect(calibrate(0.5, 0.4)).toBeLessThan(calibrate(0.6, 0.4));
  });

  it("finds the raw cut-off for a calibrated score", () => {
    for (const threshold of [0.3, 0.45, 0.6]) {
      for (const wanted of [0.5, 0.8, 0.9, 0.97]) expect(calibrate(rawCutoff(wanted, threshold), threshold)).toBeCloseTo(wanted, 2);
    }
    expect(rawCutoff(0, 0.5)).toBe(NER_MIN_RAW_CUTOFF);
  });
});

describe("planPrompts", () => {
  it("sends the labels' prompts, and the address parts only with street addresses", () => {
    expect(planPrompts(model, ["person_name"]).prompts.map((prompt) => prompt.prompt)).toEqual(["name"]);
    expect(planPrompts(model, ["location"]).prompts.map((prompt) => prompt.prompt)).toEqual(["location city", "location state"]);
    expect(planPrompts(model, ["street_address"]).prompts.map((prompt) => prompt.prompt)).toEqual(["location street", "location city", "location state", "location zip"]);
  });

  it("reads address parts down to their join threshold", () => {
    const plan = planPrompts(model, ALL);
    expect(plan.cuts.find((cut) => cut.prompt === "location city")!.cutoff).toBe(0.3);
    expect(plan.cuts.find((cut) => cut.prompt === "name")!.cutoff).toBeCloseTo(0.5);
    expect(planPrompts(model, ["location"]).cuts.find((cut) => cut.prompt === "location city")!.cutoff).toBeCloseTo(0.4);
  });

  it("raises the cut-offs for a higher request threshold", () => {
    const plan = planPrompts(model, ["person_name"], 0.9);
    expect(plan.cuts[0]!.cutoff).toBeCloseTo(0.75);
  });
});

describe("entitiesFromRaw", () => {
  it("joins a street with the city, state and postcode after it", () => {
    const text = "Ship to Anna Lee, 1234 Main Street, Springfield, IL 62704 by Friday.";
    expect(
      run(text, [
        ["Anna Lee", "name", 0.95],
        ["1234 Main Street", "location street", 0.7],
        ["Springfield", "location city", 0.35],
        ["IL", "location state", 0.32]
      ])
    ).toEqual([
      { label: "person_name", text: "Anna Lee", score: 0.98 },
      { label: "street_address", text: "1234 Main Street, Springfield, IL 62704", score: 0.891 }
    ]);
  });

  it("joins across a line break and a unit, and takes a unit before the street", () => {
    const text = "Flat 4, 104 Willowmere Lane, Apt 2B\nLeeds LS26 3JW";
    expect(run(text, [["104 Willowmere Lane", "location street", 0.6], ["Leeds", "location city", 0.5]])).toEqual([
      { label: "street_address", text: "Flat 4, 104 Willowmere Lane, Apt 2B\nLeeds LS26 3JW", score: 0.855 }
    ]);
  });

  it("takes a 'postcode town' line the model read as a street into the address", () => {
    const text = "Écrire au 89 impasse des Vignes, 44907 Nantes.";
    expect(run(text, [["89 impasse des Vignes", "location street", 0.6], ["44907 Nantes", "location street", 0.55]])).toEqual([
      { label: "street_address", text: "89 impasse des Vignes, 44907 Nantes", score: 0.855 }
    ]);
  });

  it("does not report a street without a house number, a PO box or a unit alone", () => {
    expect(run("Traffic on the high street is slow; Main Street pricing.", [["high street", "location street", 0.9], ["Main Street", "location street", 0.9]])).toEqual([]);
    expect(run("Send cheques to PO Box 9460.", [["PO Box 9460", "location street", 0.9]])).toEqual([]);
    expect(run("Level 3 of the building", [["Level 3", "location street", 0.9]])).toEqual([]);
  });

  it("reports parts not next to a street as places, and never a postcode alone", () => {
    const text = "Flights from Boston to Denver, CO 80202.";
    expect(run(text, [["Boston", "location city", 0.6], ["Denver", "location city", 0.5], ["CO", "location state", 0.6], ["80202", "location zip", 0.9]])).toEqual([
      { label: "location", text: "Boston", score: 0.867 },
      { label: "location", text: "Denver", score: 0.833 },
      { label: "location", text: "CO", score: 0.84 }
    ]);
  });

  it("does not join parts too far away or under their join threshold", () => {
    const text = "12 Main Street is near the old mill in Springfield";
    expect(run(text, [["12 Main Street", "location street", 0.7], ["Springfield", "location city", 0.9]])).toEqual([
      { label: "street_address", text: "12 Main Street", score: 0.891 },
      { label: "location", text: "Springfield", score: 0.967 }
    ]);
    const near = "12 Main Street, Springfield";
    expect(run(near, [["12 Main Street", "location street", 0.7], ["Springfield", "location city", 0.2]], ALL, 0.3)).toEqual([
      { label: "street_address", text: "12 Main Street", score: 0.891 },
      { label: "location", text: "Springfield", score: 0.4 }
    ]);
  });

  it("strips a title and a suffix from names", () => {
    expect(run("Dear Dr. Okafor and Harold Jenkins Jr., hello", [["Dr. Okafor", "name", 0.9], ["Harold Jenkins Jr.", "name", 0.9]], ["person_name"])).toEqual([
      { label: "person_name", text: "Okafor", score: 0.96 },
      { label: "person_name", text: "Harold Jenkins", score: 0.96 }
    ]);
  });

  it("filters by the request threshold and the requested labels", () => {
    const text = "Anna Lee lives in Paris.";
    const items: Array<[string, string, number]> = [
      ["Anna Lee", "name", 0.55],
      ["Paris", "location city", 0.9]
    ];
    expect(run(text, items, ["location"])).toEqual([{ label: "location", text: "Paris", score: 0.967 }]);
    expect(run(text, items, ALL, 0.85).map((entity) => entity.text)).toEqual(["Paris"]);
  });

  it("ignores raw spans that are out of range or name an unknown prompt", () => {
    const plan = planPrompts(model, ALL);
    expect(
      entitiesFromRaw("Anna", [
        { start: 0, end: 10, prompt: 0, score: 0.9 },
        { start: 0, end: 4, prompt: 99, score: 0.9 },
        { start: 2, end: 2, prompt: 0, score: 0.9 }
      ], plan, 6)
    ).toEqual([]);
  });

  it("trims a name suffix in linear time, even across a long run of whitespace", () => {
    const text = `Alice${" ".repeat(100_000)}Smith Jr.`;
    const started = performance.now();
    expect(run(text, [[text, "name", 0.9]], ["person_name"])[0]!.text.endsWith("Smith")).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("does not run away on a long run of separators or text after an address", () => {
    const text = `12 Main Street${",".repeat(50_000)} Springfield`;
    const started = performance.now();
    expect(run(text, [["12 Main Street", "location street", 0.7], ["Springfield", "location city", 0.9]]).map((entity) => entity.label)).toEqual(["street_address", "location"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
