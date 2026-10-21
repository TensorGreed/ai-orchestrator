import { describe, expect, it } from "vitest";
import { hashGuardProfile, parseGuardProfile, parseSerializedGuardProfile, serializeGuardProfile } from "./profile";
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
