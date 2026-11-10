import { describe, expect, it } from "vitest";
import { GUARD_CHANNEL_VALUES, GUARD_PLACEMENT_VALUES, GUARD_PROFILE_CHANNEL_VALUES, guardNodeConfigSchema, parseGuardPlacement } from "./guard";

describe("content rules coverage: shared contract", () => {
  it("adds the response and trigger_input channels to rule sets only", () => {
    expect(GUARD_PROFILE_CHANNEL_VALUES).toEqual([...GUARD_CHANNEL_VALUES, "egress", "response", "trigger_input"]);
    // The Content Rules node keeps its channel list.
    expect(GUARD_CHANNEL_VALUES).toEqual(["prompt", "model_output", "tool_arguments", "tool_result", "final_output"]);
    for (const channel of ["egress", "response", "trigger_input"]) {
      expect(guardNodeConfigSchema.safeParse({ channel }).success).toBe(false);
    }
  });

  it("keeps a Content Rules node config written before this change exactly as it was", () => {
    const stored = { profileId: "strict", channel: "tool_result", inputField: "payload.body", labels: ["untrusted_external"], approvalMessage: "Check it", timeoutMinutes: 60 };
    expect(guardNodeConfigSchema.parse(stored)).toEqual(stored);
  });

  it("lists the new placements after the existing ones", () => {
    expect(GUARD_PLACEMENT_VALUES).toEqual(["node", "agent", "gateway", "response", "retrieval", "reveal"]);
  });

  it("reads stored placements back, unknown ones as node as before", () => {
    for (const placement of GUARD_PLACEMENT_VALUES) expect(parseGuardPlacement(placement)).toBe(placement);
    expect(parseGuardPlacement("something_else")).toBe("node");
    expect(parseGuardPlacement(null)).toBe("node");
    expect(parseGuardPlacement(undefined)).toBe("node");
  });
});
