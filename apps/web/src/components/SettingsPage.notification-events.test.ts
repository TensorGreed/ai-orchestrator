import { NOTIFICATION_EVENT_TYPES } from "@ai-orchestrator/shared";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_EVENTS } from "./SettingsPage";

describe("notification event picker", () => {
  it("offers exactly the event names the server emits", () => {
    expect(NOTIFICATION_EVENTS.map((e) => e.value)).toEqual([...NOTIFICATION_EVENT_TYPES]);
    expect(NOTIFICATION_EVENTS.map((e) => e.value)).toContain("execution.failure");
    expect(NOTIFICATION_EVENTS.every((e) => e.label.length > 0)).toBe(true);
  });
});
