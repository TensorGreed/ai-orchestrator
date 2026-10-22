import { describe, expect, it } from "vitest";
import {
  channelOf,
  duplicateDocument,
  setActionRule,
  setChannelEnabled,
  setDefaultAction,
  setDetector,
  setShadowForAction,
  setSpotlighting,
  suggestProfileId
} from "./guard-profile-edit";

const doc = () => ({
  id: "p",
  name: "P",
  version: "1",
  channels: {
    prompt: {
      detectors: [{ id: "guard.dlp", threshold: 0.6 }],
      actions: { email: { action: "allow" } },
      defaultAction: { action: "block" }
    }
  }
});

describe("guard profile edits", () => {
  it("never mutates the original document", () => {
    const original = doc();
    const next = setDetector(original, "prompt", "guard.injection.direct", true, 0.7);
    expect(original.channels.prompt.detectors).toHaveLength(1);
    expect(channelOf(next, "prompt")!.detectors.map((entry) => entry.id)).toEqual(["guard.dlp", "guard.injection.direct"]);
  });

  it("edits thresholds, removes detectors and toggles channels", () => {
    let next = setDetector(doc(), "prompt", "guard.dlp", true, 0.9);
    expect(channelOf(next, "prompt")!.detectors[0]!.threshold).toBe(0.9);
    next = setDetector(next, "prompt", "guard.dlp", false);
    expect(channelOf(next, "prompt")!.detectors).toEqual([]);
    next = setChannelEnabled(next, "tool_result", true);
    expect(channelOf(next, "tool_result")).toEqual({ detectors: [], actions: {}, defaultAction: { action: "block" } });
    next = setChannelEnabled(next, "prompt", false);
    expect(channelOf(next, "prompt")).toBeNull();
  });

  it("sets per-rule shadow and the channel fallback", () => {
    let next = setActionRule(doc(), "prompt", "email", { action: "mask", shadow: true });
    expect(channelOf(next, "prompt")!.actions.email).toEqual({ action: "mask", shadow: true });
    next = setActionRule(next, "prompt", "email", { action: "mask", shadow: false });
    expect(channelOf(next, "prompt")!.actions.email).toEqual({ action: "mask" });
    next = setActionRule(next, "prompt", "email", null);
    expect(channelOf(next, "prompt")!.actions).toEqual({});
    next = setDefaultAction(next, "prompt", "review");
    expect(channelOf(next, "prompt")!.defaultAction.action).toBe("review");
  });

  it("sets profile-level shadow mode and spotlighting", () => {
    const shadowed = setShadowForAction(doc(), "block", true);
    expect(shadowed.shadow).toEqual({ block: true });
    expect(setShadowForAction(shadowed, "block", false).shadow).toEqual({});
    expect(setSpotlighting(doc(), "datamark").spotlighting).toEqual({ mode: "datamark", hardenSystemPrompt: true });
    expect(setSpotlighting(setSpotlighting(doc(), "delimiters"), "off").spotlighting).toBeUndefined();
  });

  it("duplicates under a fresh id", () => {
    const copy = duplicateDocument({ ...doc(), version: "7" }, "p-copy", "P (copy)");
    expect(copy).toMatchObject({ id: "p-copy", name: "P (copy)", version: "1" });
    expect(suggestProfileId("Default guard profile (copy)", new Set(["default-guard-profile-copy"]))).toBe("default-guard-profile-copy-2");
  });
});
