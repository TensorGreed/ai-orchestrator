import { describe, expect, it } from "vitest";
import {
  channelOf,
  duplicateDocument,
  setActionRule,
  setChannelEnabled,
  setDefaultAction,
  setDetector,
  setLabelTracking,
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

describe("rule set edits", () => {
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

  it("turns label tracking on and removes the field when off", () => {
    const original = doc();
    const on = setLabelTracking(original, true);
    expect(on.labels).toBe("propagated");
    expect("labels" in original).toBe(false);
    expect("labels" in setLabelTracking(on, false)).toBe(false);
  });
});

describe("fields the form does not show", () => {
  const buffered = () => ({
    id: "b",
    name: "B",
    version: "1",
    channels: {
      final_output: {
        detectors: [{ id: "output.grounding", threshold: 0.5 }],
        actions: { ungrounded: { action: "block", stream: "buffer", futureField: { keep: true } }, card_number: { action: "protect", providerId: "token_vault" } },
        defaultAction: { action: "block", stream: "buffer", providerId: "token_vault", shadow: true }
      }
    }
  });

  it("survive toggling detectors, rules and the default action", () => {
    let next = setDetector(buffered(), "final_output", "dlp.patterns", true);
    next = setDetector(next, "final_output", "dlp.patterns", false);
    next = setActionRule(next, "final_output", "email", { action: "redact" });
    next = setChannelEnabled(next, "final_output", true);
    const view = channelOf(next, "final_output")!;
    expect(view.actions.ungrounded).toEqual({ action: "block", stream: "buffer", futureField: { keep: true } });
    expect(view.actions.card_number).toEqual({ action: "protect", providerId: "token_vault" });
    expect(view.defaultAction).toEqual({ action: "block", stream: "buffer", providerId: "token_vault", shadow: true });
    const raw = (next.channels as Record<string, { actions: Record<string, unknown> }>).final_output!.actions.ungrounded;
    expect(raw).toEqual({ action: "block", stream: "buffer", futureField: { keep: true } });
  });

  it("survive changing a rule's action and the default action", () => {
    let next = setActionRule(buffered(), "final_output", "ungrounded", { action: "review" });
    next = setDefaultAction(next, "final_output", "review");
    const view = channelOf(next, "final_output")!;
    expect(view.actions.ungrounded).toEqual({ action: "review", stream: "buffer", futureField: { keep: true } });
    expect(view.defaultAction).toMatchObject({ action: "review", stream: "buffer", providerId: "token_vault" });
  });
});
