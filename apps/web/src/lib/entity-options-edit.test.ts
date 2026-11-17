import { describe, expect, it } from "vitest";
import { channelOf, setDetector } from "./guard-profile-edit";
import {
  contextWordsText,
  defaultEntitiesOptions,
  entityClassesOf,
  entityMinScoreOf,
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
});
