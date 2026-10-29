import { describe, expect, it } from "vitest";
import { ENTRY_NODE_TYPES, isEntryNodeType, nodeDefinitions } from "@ai-orchestrator/shared";
import { decideLostJob, lostJobEffects, type LostJobInput } from "./queue-leases.js";

const base: LostJobInput = { attempts: 1, maxAttempts: 3, countsAttempt: true, resume: false, history: null };
const running = (nodeResults: unknown[]) => ({ status: "running", completedAt: null, nodeResultsJson: JSON.stringify(nodeResults) });

describe("entry node types", () => {
  it("are the Input category of the node definitions: triggers and static inputs, nothing that acts", () => {
    for (const type of ["webhook_input", "manual_trigger", "schedule_trigger", "form_trigger", "chat_trigger", "mcp_server_trigger", "text_input"]) {
      expect(isEntryNodeType(type)).toBe(true);
    }
    for (const type of ["llm_call", "agent_orchestrator", "http_request", "mcp_tool", "code_node"]) expect(isEntryNodeType(type)).toBe(false);
    expect(ENTRY_NODE_TYPES.size).toBe(nodeDefinitions.filter((node) => node.category === "Input").length);
  });
});

describe("decideLostJob: side effects", () => {
  it("a tracked claim is re-run until a node other than an entry node started, whatever history says", () => {
    const history = running([{ nodeId: "webhook", status: "success" }]);
    expect(decideLostJob({ ...base, history, effects: { tracked: true, started: false } })).toBe("requeue");
    expect(decideLostJob({ ...base, history: running([{ nodeId: "webhook", status: "success" }, { nodeId: "agent", status: "running" }]), effects: { tracked: true, started: true } })).toBe("interrupt");
    // The progress write of the started node may have failed: the marker still decides.
    expect(decideLostJob({ ...base, history: null, effects: { tracked: true, started: true } })).toBe("interrupt");
    // Out of attempts with nothing started: dead-lettered as worker lost.
    expect(decideLostJob({ ...base, attempts: 3, history, effects: { tracked: true, started: false } })).toBe("dead_letter");
    // A finished run stays finished.
    expect(decideLostJob({ ...base, history: { status: "success", completedAt: "c", nodeResultsJson: "[]" }, effects: { tracked: true, started: true } })).toBe("finished");
  });

  it("an untracked claim (taken by an instance without the marker) keeps the earlier rule", () => {
    expect(decideLostJob({ ...base, history: running([{ nodeId: "n1", status: "success" }]), effects: { tracked: false, started: false } })).toBe("interrupt");
    expect(decideLostJob({ ...base, history: running([{ nodeId: "n1", status: "running" }]) })).toBe("requeue");
  });

  it("lostJobEffects trusts the marker only when it belongs to the claim that was lost", () => {
    expect(lostJobEffects({ claim_token: "t", effects_token: "t", effects_started: 1 })).toEqual({ tracked: true, started: true });
    expect(lostJobEffects({ claim_token: "t", effects_token: "t", effects_started: 0 })).toEqual({ tracked: true, started: false });
    expect(lostJobEffects({ claim_token: "t2", effects_token: "t", effects_started: 1 })).toEqual({ tracked: false, started: false });
    expect(lostJobEffects({ claim_token: null, effects_token: null, effects_started: 0 })).toEqual({ tracked: false, started: false });
  });
});
