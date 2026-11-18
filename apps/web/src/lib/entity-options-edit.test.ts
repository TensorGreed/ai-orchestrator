import { describe, expect, it } from "vitest";
import { channelOf, setDetector } from "./guard-profile-edit";
import {
  contextWordsText,
  defaultEntitiesOptions,
  entityClassesOf,
  entityEngineOf,
  entityJudgeOf,
  entityMinScoreOf,
  withEntityJudge,
  withContextWords,
  withEntityClass,
  withEntityMinScore,
  withEntityOption
} from "./entity-options-edit";

describe("names and addresses options", () => {
  it("starts a new data.entities entry with every class", () => {
    const document = setDetector({ id: "r", name: "R", version: "1", channels: { prompt: { detectors: [] } } }, "prompt", "data.entities", true);
    expect(channelOf(document, "prompt")!.detectors).toEqual([{ id: "data.entities", threshold: 0.5, options: defaultEntitiesOptions() }]);
    // Other detectors start without options.
    expect(channelOf(setDetector(document, "prompt", "dlp.patterns", true), "prompt")!.detectors[1]).toEqual({ id: "dlp.patterns", threshold: 0.5 });
  });

  it("turns classes on and off, never leaving none, and drops thresholds of classes turned off", () => {
    let options: Record<string, unknown> = { classes: ["person_name", "street_address"], minScore: { person_name: 0.9 } };
    options = withEntityClass(options, "location", true);
    expect(entityClassesOf(options)).toEqual(["person_name", "location", "street_address"]);
    options = withEntityClass(options, "person_name", false);
    expect(options).toEqual({ classes: ["location", "street_address"] });
    options = withEntityClass(withEntityClass(options, "location", false), "street_address", false);
    expect(entityClassesOf(options)).toEqual(["street_address"]);
  });

  it("stores only scores and options that differ from the defaults", () => {
    let options: Record<string, unknown> = { classes: ["person_name"] };
    expect(entityMinScoreOf(options, "person_name")).toBe(0.75);
    options = withEntityMinScore(options, "person_name", 0.9);
    expect(options.minScore).toEqual({ person_name: 0.9 });
    options = withEntityMinScore(options, "person_name", 0.75);
    expect(options).toEqual({ classes: ["person_name"] });
    expect(withEntityMinScore(options, "person_name", 7).minScore).toEqual({ person_name: 1 });
    expect(withEntityOption(withEntityOption(options, "engine", "rules"), "engine", undefined)).toEqual(options);
  });

  it("reads and writes context words", () => {
    const options = withContextWords({ classes: ["person_name"] }, "boost", "patient, doctor\npatient,  ");
    expect(options.contextWords).toEqual({ boost: ["patient", "doctor"] });
    expect(contextWordsText(options, "boost")).toBe("patient, doctor");
    expect(withContextWords(options, "boost", " ")).toEqual({ classes: ["person_name"] });
  });

  it("reads the engine, defaulting to auto", () => {
    expect(entityEngineOf({})).toBe("auto");
    expect(entityEngineOf({ engine: "union" })).toBe("union");
    expect(entityEngineOf({ engine: "bogus" })).toBe("auto");
  });

  it("edits the judge, storing defaults as nothing and removing it all when turned off", () => {
    const on = withEntityJudge({ classes: ["person_name"] }, { enabled: true });
    expect(on).toEqual({ classes: ["person_name"], judge: { enabled: true } });
    expect(entityJudgeOf(on)).toEqual({ enabled: true, model: undefined, band: [0.35, 0.7], maxSpans: 20 });
    const model = withEntityJudge(on, { model: { providerId: "openai", model: "gpt-test" } });
    const band = withEntityJudge(model, { band: [0.2, 1.5] });
    expect(band.judge).toEqual({ enabled: true, model: { providerId: "openai", model: "gpt-test" }, band: [0.2, 1] });
    expect(withEntityJudge(band, { band: [0.35, 0.7] }).judge).not.toHaveProperty("band");
    expect(withEntityJudge(band, { maxSpans: 80 }).judge).toMatchObject({ maxSpans: 50 });
    expect(withEntityJudge(band, { maxSpans: 20 }).judge).not.toHaveProperty("maxSpans");
    expect(withEntityJudge(band, { enabled: false })).toEqual({ classes: ["person_name"] });
  });
});
