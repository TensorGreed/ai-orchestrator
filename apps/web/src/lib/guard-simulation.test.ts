import { describe, expect, it } from "vitest";
import { actionTransition, checkpointPlace, pollRetryDelay, simulateDenial, simulationFinished } from "./guard-simulation";

describe("guard simulation helpers", () => {
  it("names a checkpoint by its node's name, with the tool and the occurrence when there is one", () => {
    expect(checkpointPlace({ nodeId: "guard", nodeName: "Prompt guard", channel: "prompt", occurrence: 1 })).toBe("Prompt guard · prompt");
    expect(checkpointPlace({ nodeId: "agent", nodeName: null, channel: "tool_input", occurrence: 2, toolName: "send_email" })).toBe("agent · tool input (send_email) #2");
    expect(checkpointPlace({ nodeId: null, channel: "prompt", occurrence: 1 })).toBe("run · prompt");
    expect(actionTransition({ before: null, after: "block" })).toBe("nothing → block");
  });

  it("lets admins simulate any profile and builders only profiles they may save", () => {
    expect(simulateDenial("admin", { builtIn: true, enforced: true })).toBeNull();
    expect(simulateDenial("builder", { builtIn: false })).toBeNull();
    expect(simulateDenial("builder", { builtIn: true })).toMatch(/built-in profile is read-only/);
    expect(simulateDenial("builder", { builtIn: false, enforced: true })).toMatch(/A project enforces this profile/);
    expect(simulateDenial("viewer", { builtIn: false })).toMatch(/Only admins and builders/);
  });

  it("backs off between failed polls, capped at 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempt) => pollRetryDelay(attempt))).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("treats every status but running as finished", () => {
    expect(simulationFinished({ status: "interrupted" })).toBe(true);
    expect(simulationFinished({ status: "running" })).toBe(false);
    expect(simulationFinished(null)).toBe(false);
  });
});
