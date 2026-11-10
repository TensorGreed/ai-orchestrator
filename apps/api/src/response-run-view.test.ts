import { describe, expect, it } from "vitest";
import { HIDDEN_BY_RESPONSE_RULES, maskRunEvent, maskRunNodeData, runViewHidesNodeData } from "./response-run-view.js";

describe("run views below builder under response rules", () => {
  it("hide node data only for viewers and operators, only on externally answered runs, only while rules exist", () => {
    for (const trigger of ["webhook", "webhook_test", "chat", "mcp_server"]) expect(runViewHidesNodeData("viewer", trigger, true), trigger).toBe(true);
    expect(runViewHidesNodeData("operator", "webhook", true)).toBe(true);
    expect(runViewHidesNodeData("builder", "webhook", true)).toBe(false);
    expect(runViewHidesNodeData("admin", "chat", true)).toBe(false);
    expect(runViewHidesNodeData("viewer", "webhook", false)).toBe(false);
    for (const trigger of ["manual", "cron", "webhook_api", "mcp_gateway", null]) expect(runViewHidesNodeData("viewer", trigger, true), String(trigger)).toBe(false);
  });

  it("keeps status and timing of each node, the run's checked output, and drops data events", () => {
    const run = {
      id: "x",
      status: "error",
      output: { code: "content_filter" },
      error: "leak sk-live-x",
      nodeResults: [
        { nodeId: "a", status: "success", startedAt: "s", durationMs: 3, input: { q: "raw" }, output: { answer: "raw" }, activity: [{ kind: "tool", args: "raw" }] },
        { nodeId: "b", status: "error", startedAt: "s", error: "raw failure", errorCategory: "WORKFLOW_STOPPED" }
      ]
    };
    const masked = maskRunNodeData(run);
    expect(JSON.stringify(masked)).not.toContain("raw");
    expect(JSON.stringify(masked)).not.toContain("sk-live");
    expect(masked.output).toEqual({ code: "content_filter" });
    expect(masked.nodeResults).toEqual([
      { nodeId: "a", status: "success", startedAt: "s", durationMs: 3, output: HIDDEN_BY_RESPONSE_RULES },
      { nodeId: "b", status: "error", startedAt: "s", errorCategory: "WORKFLOW_STOPPED", output: HIDDEN_BY_RESPONSE_RULES, error: HIDDEN_BY_RESPONSE_RULES }
    ]);
    expect(maskRunEvent("node_complete", { nodeId: "a", status: "success", output: "raw" })).toEqual({ nodeId: "a", status: "success", output: HIDDEN_BY_RESPONSE_RULES });
    for (const event of ["llm_delta", "node_progress", "node_activity"]) expect(maskRunEvent(event, { delta: "raw" })).toBeNull();
    expect(maskRunEvent("node_start", { nodeId: "a" })).toEqual({ nodeId: "a" });
  });
});
