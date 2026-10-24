/**
 * Phase 15.6 — the pure part of guard policy simulation: grouping guard
 * rows into verdicts (with and without verdict numbers), classifying each
 * checkpoint, detector and data-class changes, checkpoints not reached,
 * divergence from the tape or cassette, and the summary sentence.
 */
import { describe, expect, it } from "vitest";
import { summariseGuardSimulation, type GuardSimulationWorkflow, type RunFactGuardVerdict } from "@ai-orchestrator/shared";
import { classifyGuardChange, compareGuardCheckpoints, divergenceOf, groupGuardVerdicts, simulateCase } from "./guard-simulation-diff.js";

const row = (overrides: Partial<RunFactGuardVerdict> = {}): RunFactGuardVerdict => ({
  nodeId: "agent",
  placement: "agent",
  channel: "prompt",
  detectorId: null,
  effectiveAction: "allow",
  shadow: false,
  ...overrides
});

describe("classifyGuardChange", () => {
  it("separates newly blocked, no longer blocked, other changes and unchanged", () => {
    expect(classifyGuardChange("allow", "block")).toBe("newly_blocked");
    expect(classifyGuardChange("mask", "review")).toBe("newly_blocked");
    expect(classifyGuardChange("require_approval", "allow")).toBe("no_longer_blocked");
    expect(classifyGuardChange("block", "mask")).toBe("no_longer_blocked");
    expect(classifyGuardChange("allow", "mask")).toBe("action_changed");
    expect(classifyGuardChange("block", "review")).toBe("action_changed");
    expect(classifyGuardChange("redact", "redact")).toBe("unchanged");
  });
});

describe("groupGuardVerdicts", () => {
  it("groups by verdict number when every row has one", () => {
    const verdicts = groupGuardVerdicts([
      row({ verdict: 0, detectorId: "dlp", effectiveAction: "mask" }),
      row({ verdict: 1, channel: "model_output" }),
      row({ verdict: 0, detectorId: "injection", effectiveAction: "allow" })
    ]);
    expect(verdicts.map((verdict) => [verdict.channel, verdict.rows.length])).toEqual([
      ["prompt", 2],
      ["model_output", 1]
    ]);
  });

  it("splits legacy rows at a repeated detector or a clean row", () => {
    const verdicts = groupGuardVerdicts([
      row({ detectorId: "dlp", effectiveAction: "mask" }),
      row({ detectorId: "injection" }),
      row({ detectorId: "dlp", effectiveAction: "mask" }),
      row(),
      row()
    ]);
    expect(verdicts.map((verdict) => verdict.rows.length)).toEqual([2, 1, 1, 1]);
  });
});

describe("compareGuardCheckpoints", () => {
  it("pairs checkpoints by place and occurrence, with detector and data-class changes", () => {
    const recorded = [
      row({ verdict: 0 }),
      row({ verdict: 1, detectorId: "dlp.patterns", dataClass: "email", effectiveAction: "allow" }),
      row({ verdict: 2, channel: "model_output", detectorId: "dlp.patterns", dataClass: "card_number", effectiveAction: "block" })
    ];
    const replayed = [
      row({ verdict: 0 }),
      row({ verdict: 1, detectorId: "dlp.patterns", dataClass: "email", effectiveAction: "mask" }),
      row({ verdict: 2, channel: "model_output", detectorId: "dlp.patterns", dataClass: "card_number", effectiveAction: "allow" })
    ];
    const { counts, checkpoints } = compareGuardCheckpoints(recorded, replayed);
    expect(counts).toEqual({ newlyBlocked: 0, noLongerBlocked: 1, actionChanged: 1, nowMasked: 1, unchanged: 1, notReached: 0 });
    expect(checkpoints).toEqual([
      {
        nodeId: "agent",
        placement: "agent",
        channel: "prompt",
        occurrence: 2,
        before: "allow",
        after: "mask",
        change: "action_changed",
        detectors: [{ detectorId: "dlp.patterns", dataClass: "email", before: "allow", after: "mask", change: "action_changed" }]
      },
      {
        nodeId: "agent",
        placement: "agent",
        channel: "model_output",
        occurrence: 1,
        before: "block",
        after: "allow",
        change: "no_longer_blocked",
        detectors: [{ detectorId: "dlp.patterns", dataClass: "card_number", before: "block", after: "allow", change: "no_longer_blocked" }]
      }
    ]);
  });

  it("counts shadow findings as letting content through", () => {
    const recorded = [row({ verdict: 0, detectorId: "injection", effectiveAction: "block", shadow: true })];
    const replayed = [row({ verdict: 0, detectorId: "injection", effectiveAction: "block" })];
    const { counts, checkpoints } = compareGuardCheckpoints(recorded, replayed);
    expect(counts.newlyBlocked).toBe(1);
    expect(checkpoints[0]).toMatchObject({ before: "allow", after: "block" });
    expect(checkpoints[0]!.detectors[0]).toMatchObject({ before: "allow", after: "block" });
  });

  it("counts checkpoints the replay never reached apart, and compares new ones with allow", () => {
    const recorded = [row({ verdict: 0, nodeId: "a" }), row({ verdict: 1, nodeId: "b", detectorId: "dlp", effectiveAction: "block" })];
    const replayed = [row({ verdict: 0, nodeId: "a", detectorId: "dlp", effectiveAction: "block" }), row({ verdict: 1, nodeId: "c" })];
    const { counts, checkpoints } = compareGuardCheckpoints(recorded, replayed);
    expect(counts).toMatchObject({ newlyBlocked: 1, notReached: 1, unchanged: 1, noLongerBlocked: 0 });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ nodeId: "a", before: "allow", after: "block" });
  });
});

describe("divergenceOf and simulateCase", () => {
  const recording = { id: "rec_1", name: "Run 1", createdAt: "2026-10-01T00:00:00.000Z", guard: [row({ verdict: 0, detectorId: "dlp", dataClass: "email" })] };
  const tapeMiss = {
    status: "error",
    error: "1 model call had no recorded answer on the model tape",
    executionId: "exec_1",
    diff: {
      diff: { health: [{ kind: "model_unmatched", nodeId: "agent", message: "1 model call had no recorded answer on the model tape: no entry", blocking: true }], toolCalls: { steps: [] } },
      modelTape: { replayedCalls: 3, liveCalls: 0, matchedCalls: 2 }
    }
  };

  it("finds the first model call the tape could not answer", () => {
    expect(divergenceOf(tapeMiss)).toMatchObject({ step: 3, kind: "model", nodeId: "agent" });
  });

  it("finds the first tool call the cassette could not answer", () => {
    const steps = [
      { kind: "matched", baseline: { nodeId: "agent" }, candidate: { nodeId: "agent" }, argsChanged: false, argChanges: [], outcomeChanged: false },
      { kind: "matched", baseline: { nodeId: "agent" }, candidate: { nodeId: "agent" }, argsChanged: true, argChanges: [], outcomeChanged: true }
    ];
    const stored = { status: "error", error: "x", executionId: "e", diff: { diff: { health: [{ kind: "mcp_unmatched", nodeId: null, message: "1 MCP call had no recorded answer", blocking: true }], toolCalls: { steps } } } };
    expect(divergenceOf(stored)).toMatchObject({ step: 2, kind: "tool", nodeId: "agent" });
  });

  it("reads a truncated diff's error text, without a step", () => {
    expect(divergenceOf({ status: "error", error: "1 model call had no recorded answer on the model tape", executionId: "e", diff: { truncated: true, bytes: 9, maxBytes: 1, preview: "" } })).toMatchObject({ step: null, kind: "model" });
    expect(divergenceOf({ status: "pass", error: null, executionId: "e", diff: null })).toBeNull();
  });

  it("calls a tape miss after a guard change 'diverged', an impact rather than an error", () => {
    const replayed = [row({ verdict: 0, detectorId: "dlp", dataClass: "email", effectiveAction: "mask" })];
    const entry = simulateCase({ recordingId: "rec_1", recording, stored: tapeMiss, replayed, workflowChanged: true });
    expect(entry).toMatchObject({ outcome: "diverged", divergedAt: { step: 3, kind: "model" }, counts: { actionChanged: 1, nowMasked: 1 } });
  });

  it("does not blame the guard for a miss when the workflow changed and no verdict did", () => {
    const replayed = [row({ verdict: 0, detectorId: "dlp", dataClass: "email" })];
    const entry = simulateCase({ recordingId: "rec_1", recording, stored: tapeMiss, replayed, workflowChanged: true });
    expect(entry.outcome).toBe("not_simulated");
    expect(entry.reason).toMatch(/workflow changed/);
    // With the recorded workflow, a miss with no verdict change still comes from the guard profile (spotlighting, canaries).
    expect(simulateCase({ recordingId: "rec_1", recording, stored: tapeMiss, replayed, workflowChanged: false }).outcome).toBe("diverged");
  });

  it("reports cases that could not run, and deleted recordings", () => {
    const noTape = { status: "error", error: "no model tape", executionId: "e", diff: { diff: { health: [{ kind: "no_model_tape", nodeId: null, message: "This golden run has no model tape", blocking: true }] } } };
    expect(simulateCase({ recordingId: "rec_1", recording, stored: noTape, replayed: [], workflowChanged: false })).toMatchObject({ outcome: "not_simulated", reason: "This golden run has no model tape" });
    expect(simulateCase({ recordingId: "rec_1", recording, stored: { status: "error", error: "lost access", executionId: null, diff: null }, replayed: [], workflowChanged: false })).toMatchObject({ outcome: "not_simulated", reason: "lost access" });
    expect(simulateCase({ recordingId: "rec_1", recording: null, stored: null, replayed: [], workflowChanged: false })).toMatchObject({ outcome: "not_simulated" });
  });
});

describe("summariseGuardSimulation", () => {
  it("counts runs per kind of change and writes one plain sentence", () => {
    const counts = (overrides: Partial<Record<string, number>> = {}) => ({ newlyBlocked: 0, noLongerBlocked: 0, actionChanged: 0, nowMasked: 0, unchanged: 1, notReached: 0, ...overrides });
    const workflows: GuardSimulationWorkflow[] = [
      {
        workflowId: "a",
        workflowName: "A",
        projectId: null,
        jobId: "run_a",
        cases: [
          { recordingId: "1", recordingName: "1", recordedAt: null, executionId: "e1", outcome: "compared", counts: counts({ newlyBlocked: 2 }), checkpoints: [{ nodeId: "n", placement: "node", channel: "prompt", occurrence: 1, before: "allow", after: "block", change: "newly_blocked", detectors: [{ detectorId: "dlp", dataClass: "email", before: null, after: "block", change: "newly_blocked" }] }] },
          { recordingId: "2", recordingName: "2", recordedAt: null, executionId: "e2", outcome: "diverged", divergedAt: { step: 1, kind: "model", nodeId: null, message: "" }, counts: counts({ actionChanged: 1, nowMasked: 1 }), checkpoints: [] }
        ]
      },
      { workflowId: "b", workflowName: "B", projectId: null, jobId: "run_b", cases: [{ recordingId: "3", recordingName: "3", recordedAt: null, executionId: "e3", outcome: "compared", counts: counts(), checkpoints: [] }] },
      { workflowId: "c", workflowName: "C", projectId: null, jobId: null, error: "could not start", cases: [] }
    ];
    const summary = summariseGuardSimulation(workflows);
    expect(summary).toMatchObject({ runs: 3, workflows: 2, compared: 2, diverged: 1, runsNewlyBlocked: 1, runsNowMasked: 1, runsNoLongerBlocked: 0, runsChanged: 2, runsUnchanged: 1 });
    expect(summary.byDataClass).toEqual({ email: { newlyBlocked: 1, noLongerBlocked: 0, actionChanged: 0 } });
    expect(summary.byDetector).toEqual({ dlp: { newlyBlocked: 1, noLongerBlocked: 0, actionChanged: 0 } });
    expect(summary.sentence).toBe("Across 3 recent runs in 2 workflows: 1 newly blocked, 1 now masked, 0 no longer blocked. 1 run diverged after the guard change.");
    expect(summariseGuardSimulation([]).sentence).toBe("No recent recorded runs to simulate.");
  });
});
