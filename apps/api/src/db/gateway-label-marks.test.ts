import { describe, expect, it } from "vitest";
import { labelMarkRaiseHeld, mergeLabelMark, type McpGatewayLabelMark, type McpGatewayLabelMarkRaise } from "./gateway-label-marks.js";

const IDLE = 60_000;
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const key = { clientId: "c1", toolsetId: "t1", scopeKey: "" };

function raise(provenance: string[], dataClasses: string[] = [], extra: Partial<McpGatewayLabelMarkRaise> = {}): McpGatewayLabelMarkRaise {
  return { ...key, provenance, dataClasses, now: new Date(NOW).toISOString(), expiresAt: new Date(NOW + IDLE * 1.5).toISOString(), ...extra };
}

/** A stored mark holding `provenance` and `classes`, written `ageMs` ago with a lifetime of 1.5 idle windows. */
function stored(provenance: string[], classes: string[] = [], ageMs = 0): McpGatewayLabelMark {
  const writtenAt = NOW - ageMs;
  return mergeLabelMark(null, raise(provenance, classes, { now: new Date(writtenAt).toISOString(), expiresAt: new Date(writtenAt + IDLE * 1.5).toISOString() })).next;
}

describe("labelMarkRaiseHeld (gateway mark write throttle)", () => {
  it("holds a raise the stored mark already has while it has more than the minimum to live", () => {
    const seen = stored(["untrusted_external"], ["pii.email"], IDLE / 4);
    expect(labelMarkRaiseHeld(seen, raise(["untrusted_external"]), NOW, IDLE)).toBe(true);
    expect(labelMarkRaiseHeld(seen, raise(["untrusted_external", "trusted"], ["pii.email"]), NOW, IDLE)).toBe(true);
  });

  it("never holds a raise that would add a label, a class or a note", () => {
    const seen = stored(["untrusted_external"], [], 0);
    expect(labelMarkRaiseHeld(seen, raise(["untrusted_external", "sensitive"]), NOW, IDLE)).toBe(false);
    expect(labelMarkRaiseHeld(seen, raise(["untrusted_external"], ["pii.email"]), NOW, IDLE)).toBe(false);
    expect(labelMarkRaiseHeld(seen, raise([], [], { unobserved: true }), NOW, IDLE)).toBe(false);
  });

  it("never holds a mark's first raise", () => {
    const seen = { ...stored(["untrusted_external"]), raiseAudited: false };
    expect(labelMarkRaiseHeld(seen, raise(["untrusted_external"]), NOW, IDLE)).toBe(false);
  });

  it("writes again once the mark was written half an idle window ago or more, or when no mark was seen", () => {
    expect(labelMarkRaiseHeld(stored(["untrusted_external"], [], IDLE / 2), raise(["untrusted_external"]), NOW, IDLE)).toBe(false);
    expect(labelMarkRaiseHeld(stored(["untrusted_external"], [], IDLE * 2), raise(["untrusted_external"]), NOW, IDLE)).toBe(false);
    expect(labelMarkRaiseHeld(undefined, raise(["untrusted_external"]), NOW, IDLE)).toBe(false);
    expect(labelMarkRaiseHeld(null, raise([]), NOW, IDLE)).toBe(false);
  });
});
