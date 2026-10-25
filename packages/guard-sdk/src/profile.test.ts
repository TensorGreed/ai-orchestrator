import { describe, expect, it } from "vitest";
import { hashGuardProfile, parseGuardProfile, parseSerializedGuardProfile, profileUsesLabels, serializeGuardProfile } from "./profile";
import { GuardProfileError } from "./types";

describe("guard profiles", () => {
  it("fills defaults", () => {
    const profile = parseGuardProfile({ id: "p", name: "P", version: "1", channels: { prompt: { detectors: [{ id: "x" }] } } });
    expect(profile.channels.prompt?.detectors[0]?.threshold).toBe(0.5);
    expect(profile.channels.prompt?.defaultAction.action).toBe("block");
    expect(profile.latencyBudget).toEqual({ ms: 2000, onExceeded: "fail_closed" });
    expect(profile.protection.fallback).toBe("block");
  });

  it("rejects bad documents with every issue listed", () => {
    expect(() => parseGuardProfile({ id: "", name: "P", version: "1", channels: { nope: {} } })).toThrow(GuardProfileError);
    expect(() => parseGuardProfile({ id: "p", name: "P", version: "1", protection: { fallback: "protect" } })).toThrow(/fallback/);
  });

  it("serialises with a stable key order and hash", () => {
    const a = parseGuardProfile({ version: "1", name: "P", id: "p", channels: { prompt: { actions: { b: { action: "block" }, a: { action: "allow" } } } } });
    const b = parseGuardProfile({ id: "p", name: "P", version: "1", channels: { prompt: { actions: { a: { action: "allow" }, b: { action: "block" } } } } });
    expect(serializeGuardProfile(a)).toBe(serializeGuardProfile(b));
    expect(hashGuardProfile(a)).toBe(hashGuardProfile(b));
    expect(serializeGuardProfile(a).indexOf('"a"')).toBeLessThan(serializeGuardProfile(a).indexOf('"b"'));
    expect(parseSerializedGuardProfile(serializeGuardProfile(a))).toEqual(a);
    const c = parseGuardProfile({ ...b, version: "2" });
    expect(hashGuardProfile(c)).not.toBe(hashGuardProfile(a));
  });
});

/** The built-in default profile hash on main before Phase 16; adding the optional `labels` field must not change it. */
const DEFAULT_PROFILE_HASH = "38a972eb9d53a6890647cdc2b7c0f6ce4b9002fd33f497b2b195e3737d2e1aa5";

describe("propagated labels opt-in", () => {
  it("keeps the built-in default profile and its hash unchanged", async () => {
    const { createDefaultGuardProfile } = await import("./default-profile");
    const profile = createDefaultGuardProfile();
    expect(profile.labels).toBeUndefined();
    expect(serializeGuardProfile(profile)).not.toContain('"labels"');
    expect(profileUsesLabels(profile)).toBe(false);
    // The hash of the built-in default as it was before the labels field existed.
    expect(hashGuardProfile(profile)).toBe(DEFAULT_PROFILE_HASH);
  });

  it("is off when absent or fixed, on when propagated", () => {
    const base = { id: "p", name: "P", version: "1" };
    expect(profileUsesLabels(parseGuardProfile(base))).toBe(false);
    expect(profileUsesLabels(parseGuardProfile({ ...base, labels: "fixed" }))).toBe(false);
    expect(profileUsesLabels(parseGuardProfile({ ...base, labels: "propagated" }))).toBe(true);
    expect(profileUsesLabels(undefined)).toBe(false);
    expect(() => parseGuardProfile({ ...base, labels: "always" })).toThrow(GuardProfileError);
  });

  it("changes the hash only when set", () => {
    const base = parseGuardProfile({ id: "p", name: "P", version: "1" });
    const fixed = parseGuardProfile({ id: "p", name: "P", version: "1", labels: "fixed" });
    const propagated = parseGuardProfile({ id: "p", name: "P", version: "1", labels: "propagated" });
    expect(hashGuardProfile(propagated)).not.toBe(hashGuardProfile(base));
    expect(hashGuardProfile(fixed)).not.toBe(hashGuardProfile(propagated));
    expect(parseSerializedGuardProfile(serializeGuardProfile(propagated)).labels).toBe("propagated");
  });
});
