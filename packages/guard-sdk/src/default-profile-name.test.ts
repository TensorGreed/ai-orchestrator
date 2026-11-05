import { describe, expect, it } from "vitest";
import { DEFAULT_GUARD_PROFILE_DISPLAY_NAME, DEFAULT_GUARD_PROFILE_DOCUMENT, DEFAULT_GUARD_PROFILE_ID, guardProfileDisplayName } from "./default-profile";

describe("guardProfileDisplayName", () => {
  it("shows the built-in's stored name as its display name", () => {
    expect(guardProfileDisplayName(DEFAULT_GUARD_PROFILE_ID, DEFAULT_GUARD_PROFILE_DOCUMENT.name as string)).toBe(DEFAULT_GUARD_PROFILE_DISPLAY_NAME);
    expect(DEFAULT_GUARD_PROFILE_DISPLAY_NAME).toBe("Default rule set");
  });

  it("leaves every other name alone, including a renamed built-in row and the same name on another id", () => {
    expect(guardProfileDisplayName(DEFAULT_GUARD_PROFILE_ID, "Renamed elsewhere")).toBe("Renamed elsewhere");
    expect(guardProfileDisplayName("support", DEFAULT_GUARD_PROFILE_DOCUMENT.name as string)).toBe(DEFAULT_GUARD_PROFILE_DOCUMENT.name);
    expect(guardProfileDisplayName("support", undefined)).toBeUndefined();
  });
});
