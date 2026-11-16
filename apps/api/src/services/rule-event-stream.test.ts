import { describe, expect, it } from "vitest";
import type { GuardEventInsert } from "../db/database";
import {
  RULE_EVENT_MAX_EVIDENCE,
  RULE_EVENT_MAX_EVIDENCE_LENGTH,
  ruleEventLevel,
  ruleEventSource,
  ruleEventToLogStreamEvent,
  toRuleStreamEvent
} from "./rule-event-stream.js";

function row(overrides: Partial<GuardEventInsert> = {}): GuardEventInsert {
  return {
    id: "ev-1",
    verdictId: "vd-1",
    executionId: "exec-1",
    workflowId: "wf-1",
    projectId: "default",
    nodeId: "guard",
    placement: "node",
    iteration: null,
    toolName: null,
    channel: "prompt",
    detectorId: "dlp.patterns",
    category: "pii",
    dataClass: "email",
    score: 0.9,
    requestedAction: "redact",
    effectiveAction: "redact",
    verdictAction: "redact",
    shadow: false,
    evidence: [{ evidence: "m***@e******.org", spans: [{ start: 3, end: 29 }], message: "Email address" }],
    profileId: "default",
    profileVersion: 2,
    profileHash: "abc123",
    latencyMs: 4,
    budgetExceeded: false,
    skippedDetectors: [],
    createdAt: "2026-11-16T10:00:00.000Z",
    ...overrides
  };
}

describe("rule event stream schema", () => {
  it("maps a stored rule event to schema l2m.rule_event v1 with masked evidence", () => {
    const event = toRuleStreamEvent(row());
    expect(event).toEqual({
      schema: "l2m.rule_event",
      schemaVersion: 1,
      eventId: "ev-1",
      verdictId: "vd-1",
      source: "workflow",
      ruleSet: { id: "default", version: 2, hash: "abc123" },
      detector: { id: "dlp.patterns", category: "pii", dataClass: "email", score: 0.9 },
      action: { requested: "redact", effective: "redact", verdict: "redact", shadow: false },
      channel: "prompt",
      placement: "node",
      nodeId: "guard",
      toolName: null,
      iteration: null,
      executionId: "exec-1",
      workflowId: "wf-1",
      projectId: "default",
      latencyMs: 4,
      budgetExceeded: false,
      skippedDetectors: [],
      evidence: [{ masked: "m***@e******.org", digest: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), spanCount: 1, message: "Email address" }],
      evidenceWithheld: false
    });
  });

  it("sends digests only when evidence is withheld, and caps how much evidence goes out", () => {
    const withheld = toRuleStreamEvent(row(), { withholdEvidence: true });
    expect(withheld.evidenceWithheld).toBe(true);
    expect(withheld.evidence).toEqual([{ digest: toRuleStreamEvent(row()).evidence[0]!.digest, spanCount: 1 }]);
    expect(JSON.stringify(withheld)).not.toContain("m***@");

    const many = toRuleStreamEvent(
      row({ evidence: Array.from({ length: 9 }, (_, index) => ({ evidence: `${index}`.repeat(500), spans: [], message: "x" })) })
    );
    expect(many.evidence).toHaveLength(RULE_EVENT_MAX_EVIDENCE);
    expect(many.evidence[0]!.masked!.length).toBe(RULE_EVENT_MAX_EVIDENCE_LENGTH + 1);
  });

  it("names the source from the execution id and picks a level from the effective action", () => {
    expect(ruleEventSource("aigw_123")).toBe("ai_gateway");
    expect(ruleEventSource("mcpgw_123")).toBe("mcp_gateway");
    expect(ruleEventSource("exec-1")).toBe("workflow");
    expect(ruleEventLevel({ effectiveAction: "block", detectorId: "x" })).toBe("warn");
    expect(ruleEventLevel({ effectiveAction: "require_approval", detectorId: "x" })).toBe("warn");
    expect(ruleEventLevel({ effectiveAction: "mask", detectorId: "x" })).toBe("info");
    expect(ruleEventLevel({ effectiveAction: "allow", detectorId: null })).toBe("debug");
  });

  it("builds a log stream event in the rule_events category", () => {
    const blocked = ruleEventToLogStreamEvent(row({ executionId: "mcpgw_9", effectiveAction: "block", verdictAction: "block", toolName: "send_email", placement: "gateway", workflowId: null }));
    expect(blocked).toMatchObject({
      category: "rule_events",
      eventType: "content_rules.event",
      level: "warn",
      outcome: "denied",
      resourceType: "execution",
      resourceId: "mcpgw_9",
      projectId: "default",
      createdAt: "2026-11-16T10:00:00.000Z",
      metadata: { source: "mcp_gateway", toolName: "send_email", placement: "gateway" }
    });
    expect(blocked.message).toBe("Content rule block: dlp.patterns (email) on prompt at guard");
  });
});
