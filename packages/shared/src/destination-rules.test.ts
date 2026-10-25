import { describe, expect, it } from "vitest";
import {
  destinationPreviewRequestSchema,
  destinationRulesMode,
  destinationRulesObservingSentence,
  STARTER_DESTINATION_RULE
} from "./destination-rules";
import { emptyGuardSimulationCounts, summariseGuardSimulation, type GuardSimulationCheckpoint, type GuardSimulationWorkflow } from "./guard-simulation";

describe("deployment destination rules", () => {
  it("the starter rule keeps cards, IBANs, SSNs, national ids and credentials at most on the private network", () => {
    expect(STARTER_DESTINATION_RULE.allow.maxTier).toBe("private");
    expect(STARTER_DESTINATION_RULE.when.dataClasses).toEqual(["card_number", "iban", "us_ssn", "national_id", "credential"]);
  });

  it("modes and the observing sentence", () => {
    expect(destinationRulesMode([])).toBe("off");
    expect(destinationRulesMode([{ shadow: true }])).toBe("observing");
    expect(destinationRulesMode([{}, { shadow: false }])).toBe("enforcing");
    expect(destinationRulesMode([{ shadow: true }, {}])).toBe("mixed");
    expect(destinationRulesObservingSentence(3)).toBe("Observing: 3 requests would have been blocked this week");
    expect(destinationRulesObservingSentence(1)).toBe("Observing: 1 request would have been blocked this week");
  });

  it("a preview request validates its rows like a save", () => {
    expect(destinationPreviewRequestSchema.safeParse({ rows: [{ name: "API", kind: "http", host: "api.example.com", tier: "vendor" }] }).success).toBe(true);
    expect(destinationPreviewRequestSchema.safeParse({ rows: [{ name: "API", kind: "http", tier: "vendor" }] }).success).toBe(false);
    expect(destinationPreviewRequestSchema.safeParse({ rows: [], extra: 1 }).success).toBe(false);
  });
});

describe("simulation summary per destination", () => {
  const checkpoint = (change: GuardSimulationCheckpoint["change"], host: string, tier: "public" | "vendor"): GuardSimulationCheckpoint => ({
    nodeId: "n",
    placement: "node",
    channel: "egress",
    occurrence: 1,
    before: "allow",
    after: change === "newly_blocked" ? "block" : "allow",
    change,
    detectors: [{ detectorId: "<destinations>", dataClass: "card_number", before: null, after: "block", change: "newly_blocked" }],
    destination: { kind: "http", host, tier, region: "unknown", matchedBy: "unmatched" }
  });
  it("counts changed checkpoints per destination and names them in the sentence", () => {
    const workflows: GuardSimulationWorkflow[] = [
      {
        workflowId: "w",
        workflowName: "W",
        projectId: null,
        jobId: "j",
        cases: [
          {
            recordingId: "r1",
            recordingName: "r1",
            recordedAt: null,
            executionId: "e1",
            outcome: "compared",
            counts: { ...emptyGuardSimulationCounts(), newlyBlocked: 3 },
            checkpoints: [checkpoint("newly_blocked", "api.example.com", "public"), checkpoint("newly_blocked", "api.example.com", "public"), checkpoint("newly_blocked", "llm.vendor.example", "vendor")]
          }
        ]
      }
    ];
    const summary = summariseGuardSimulation(workflows);
    expect(summary.byDestination?.["api.example.com (public)"]).toMatchObject({ newlyBlocked: 2, tier: "public" });
    expect(summary.sentence).toContain("2 newly blocked going to api.example.com (public), 1 newly blocked going to llm.vendor.example (vendor)");
  });

  it("without destinations the summary and sentence are as before", () => {
    const summary = summariseGuardSimulation([]);
    expect(summary.byDestination).toBeUndefined();
    expect(summary.sentence).toBe("No recent recorded runs to simulate.");
  });
});
