import { describe, expect, it } from "vitest";
import { ENTITIES_DETECTOR_ID, parseGuardProfile } from "@ai-orchestrator/guard-sdk";
import { ContentScanSettings } from "./content-scan-settings.js";

function profileWith(options: Record<string, unknown>) {
  return parseGuardProfile({ id: "names", name: "Names", version: "1", channels: { prompt: { detectors: [{ id: ENTITIES_DETECTOR_ID, threshold: 0.5, options }] } } });
}

describe("content scan settings", () => {
  it("falls back to the defaults for invalid stored names and addresses options and warns once per rule set version", () => {
    const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
    const settings = new ContentScanSettings((message, metadata) => warnings.push({ message, metadata }));
    const broken = profileWith({ classes: ["person_name"], endpoint: "http://10.0.0.1/ner" });
    const first = settings.settingsOf({ id: "names", version: 3, profile: broken });
    expect(first.entities).toBeUndefined();
    expect(first.entitiesOptionsInvalid).toBe(true);
    settings.settingsOf({ id: "names", version: 3, profile: broken });
    expect(warnings).toEqual([{ message: expect.stringMatching(/invalid; the check's defaults are used/), metadata: { ruleSetId: "names", version: 3 } }]);
    settings.settingsOf({ id: "names", version: 4, profile: broken });
    expect(warnings.map((warning) => warning.metadata.version)).toEqual([3, 4]);
    // The warning names the rule set, never the options' values.
    expect(JSON.stringify(warnings)).not.toContain("10.0.0.1");
  });

  it("does not warn for valid options or no rule set", () => {
    const warnings: string[] = [];
    const settings = new ContentScanSettings((message) => warnings.push(message));
    expect(settings.settingsOf({ id: "names", version: 1, profile: profileWith({ classes: ["person_name"] }) }).entities?.classes).toEqual(["person_name"]);
    expect(settings.settingsOf(null)).toEqual({ dictionaries: [] });
    expect(warnings).toEqual([]);
  });
});
