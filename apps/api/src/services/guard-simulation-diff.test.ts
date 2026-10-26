/**
 * Phase 15.6 — the pure part of guard policy simulation: collecting checks
 * in the sink, classifying each checkpoint on the stack's combined action
 * (enforced and stacked profiles, the stack's short-circuit), detector and
 * data-class changes, checkpoints not reached, a stale recording, divergence
 * from the tape or cassette, and the summary sentence.
 */
import { describe, expect, it } from "vitest";
import { summariseGuardSimulation, type GuardSimulationWorkflow } from "@ai-orchestrator/shared";
import type { GuardVerdictEvent } from "@ai-orchestrator/workflow-engine";
import { classifyGuardChange, compareGuardChecks, divergenceOf, simulateCase, type SimulatedReplay } from "./guard-simulation-diff.js";
import { GuardSimulationSink, GuardSimulationVault, type SimulatedGuardCheck, type SimulatedGuardVerdict } from "./guard-simulation-sink.js";

let nextId = 0;
const verdict = (profileId: string, action: string, findings: Array<{ detectorId: string; dataClass?: string; action: string; shadow?: boolean }> = []): SimulatedGuardVerdict => ({
  profileId,
  version: 1,
  hash: `h-${profileId}`,
  action,
  findings:
    findings.length === 0
      ? [{ detectorId: null, dataClass: null, effectiveAction: action, shadow: false }]
      : findings.map((finding) => ({ detectorId: finding.detectorId, dataClass: finding.dataClass ?? null, effectiveAction: finding.action, shadow: finding.shadow ?? false }))
});
const check = (action: string, verdicts: SimulatedGuardVerdict[], overrides: Partial<SimulatedGuardCheck> = {}): SimulatedGuardCheck => ({
  id: `c${(nextId += 1)}`,
  nodeId: "agent",
  placement: "agent",
  channel: "prompt",
  iteration: null,
  toolName: null,
  action,
  verdicts,
  ...overrides
});

const ok = (executionId = "e"): SimulatedReplay => ({
  status: "success",
  error: null,
  executionId,
  response: { recordingId: "r", executionId, candidate: { kind: "draft", version: null, workflowHash: "h" }, status: "success", diff: { health: [], toolCalls: { steps: [] } } as never, verdict: "pass", reasons: [] }
});
const withHealth = (health: Array<{ kind: string; nodeId: string | null; message: string; blocking: boolean }>, extra: Record<string, unknown> = {}, steps: unknown[] = []): SimulatedReplay => {
  const base = ok();
  return { ...base, status: "error", response: { ...base.response!, diff: { health, toolCalls: { steps } } as never, verdict: "error", ...extra } };
};

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

describe("GuardSimulationSink", () => {
  const event = (profileId: string, checkId: string, index: number, action: string, stackAction: string, actions: GuardVerdictEvent["verdict"]["actions"] = []): GuardVerdictEvent =>
    ({
      executionId: "e",
      workflowId: "w",
      nodeId: "agent",
      placement: "agent",
      iteration: 2,
      channel: "tool_input",
      toolName: "send",
      profile: { profileId, version: 1, hash: `h-${profileId}` },
      verdict: { action, actions, findings: [], timings: { totalMs: 1 }, budget: { exceeded: false, skippedDetectors: [] } },
      check: { id: checkId, index, action: stackAction }
    }) as unknown as GuardVerdictEvent;

  it("groups every profile's verdict of one check, keeps the stack's action, and lists event rows for the facts", () => {
    const sink = new GuardSimulationSink();
    sink.record(event("enforced", "c1", 0, "allow", "block"));
    sink.record(event("team", "c1", 1, "block", "block", [{ detectorId: "dlp.patterns", category: "dlp", dataClass: "email", score: 1, requested: "block", effective: "block", shadow: false }] as never));
    sink.record(event("enforced", "c2", 0, "allow", "allow"));
    expect(sink.checks).toHaveLength(2);
    expect(sink.checks[0]).toMatchObject({ id: "c1", action: "block", iteration: 2, toolName: "send", channel: "tool_input" });
    expect(sink.checks[0]!.verdicts.map((entry) => entry.profileId)).toEqual(["enforced", "team"]);
    expect(sink.checks[0]!.verdicts[1]!.findings).toEqual([{ detectorId: "dlp.patterns", dataClass: "email", effectiveAction: "block", shadow: false }]);
    expect(sink.rows).toHaveLength(3);
    expect(sink.rows[1]).toMatchObject({ detectorId: "dlp.patterns", dataClass: "email", effectiveAction: "block" });
  });

  it("keeps tokens a simulation creates in memory and reads the live vault without writing to it", async () => {
    const live = { written: 0, getByToken: async (token: string) => (token === "tok_live" ? { token, dataClass: "email" as const, value: "a@b.c", createdAt: "x" } : undefined), getByValueHash: async () => undefined, put: async () => void (live.written += 1) };
    const vault = new GuardSimulationVault(live);
    await vault.put({ token: "tok_sim", dataClass: "email", value: "x@y.z", valueHash: "vh", createdAt: "x" });
    expect(live.written).toBe(0);
    expect(vault.size).toBe(1);
    expect((await vault.getByToken("tok_sim"))?.value).toBe("x@y.z");
    expect((await vault.getByValueHash("vh"))?.token).toBe("tok_sim");
    expect((await vault.getByToken("tok_live"))?.value).toBe("a@b.c");
  });
});

describe("compareGuardChecks", () => {
  it("pairs checkpoints by place and occurrence, with detector and data-class changes and node names", () => {
    const baseline = [
      check("allow", [verdict("p", "allow")]),
      check("allow", [verdict("p", "allow", [{ detectorId: "dlp.patterns", dataClass: "email", action: "allow" }])]),
      check("block", [verdict("p", "block", [{ detectorId: "dlp.patterns", dataClass: "card_number", action: "block" }])], { channel: "model_output" })
    ];
    const candidate = [
      check("allow", [verdict("p", "allow")]),
      check("mask", [verdict("p", "mask", [{ detectorId: "dlp.patterns", dataClass: "email", action: "mask" }])]),
      check("allow", [verdict("p", "allow", [{ detectorId: "dlp.patterns", dataClass: "card_number", action: "allow" }])], { channel: "model_output" })
    ];
    const { counts, checkpoints } = compareGuardChecks(baseline, candidate, new Map([["agent", "Support agent"]]));
    expect(counts).toEqual({ newlyBlocked: 0, noLongerBlocked: 1, actionChanged: 1, nowMasked: 1, unchanged: 1, notReached: 0 });
    expect(checkpoints).toEqual([
      {
        nodeId: "agent",
        nodeName: "Support agent",
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
        nodeName: "Support agent",
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

  it("classifies on the stack's combined action: an enforced profile that already blocks hides P's change", () => {
    // Enforced E first blocks; the stack stops there. With P now blocking too (and evaluated first as the enforced one), nothing changes for the traffic.
    const baseline = [check("block", [verdict("E", "block", [{ detectorId: "secret.key", action: "block" }])])];
    const candidate = [check("block", [verdict("P", "block", [{ detectorId: "dlp.patterns", dataClass: "email", action: "block" }])])];
    const { counts, checkpoints } = compareGuardChecks(baseline, candidate);
    expect(counts).toMatchObject({ newlyBlocked: 0, noLongerBlocked: 0, unchanged: 1 });
    expect(checkpoints).toHaveLength(0);
  });

  it("never counts one checkpoint in both directions when the stack's short-circuit moves", () => {
    // [P, Q]: P blocked before. Now P allows and Q (never reached before) blocks: still blocked.
    const baseline = [check("block", [verdict("P", "block", [{ detectorId: "dlp.patterns", dataClass: "email", action: "block" }])])];
    const candidate = [check("block", [verdict("P", "allow"), verdict("Q", "block", [{ detectorId: "secret.key", action: "block" }])])];
    const { counts, checkpoints } = compareGuardChecks(baseline, candidate);
    expect(counts).toMatchObject({ newlyBlocked: 0, noLongerBlocked: 0, actionChanged: 0, unchanged: 1 });
    expect(checkpoints).toHaveLength(0);

    // P (second in the stack after an allowing E) newly blocks: one checkpoint, newly blocked, with per-detector detail.
    const before = [check("allow", [verdict("E", "allow"), verdict("P", "allow")])];
    const after = [check("block", [verdict("E", "allow"), verdict("P", "block", [{ detectorId: "dlp.patterns", dataClass: "email", action: "block" }])])];
    const changed = compareGuardChecks(before, after);
    expect(changed.counts).toMatchObject({ newlyBlocked: 1, noLongerBlocked: 0, unchanged: 0 });
    expect(changed.checkpoints[0]!.detectors).toEqual([{ detectorId: "dlp.patterns", dataClass: "email", before: null, after: "block", change: "newly_blocked" }]);
  });

  it("keeps agent checks of different iterations and tools apart", () => {
    const baseline = [check("allow", [verdict("p", "allow")], { channel: "tool_input", iteration: 1, toolName: "a" }), check("allow", [verdict("p", "allow")], { channel: "tool_input", iteration: 2, toolName: "b" })];
    const candidate = [check("allow", [verdict("p", "allow")], { channel: "tool_input", iteration: 2, toolName: "b" })];
    const { counts } = compareGuardChecks(baseline, candidate);
    expect(counts).toMatchObject({ unchanged: 1, notReached: 1 });
  });

  it("counts shadow findings as letting content through", () => {
    const baseline = [check("allow", [verdict("p", "allow", [{ detectorId: "injection", action: "block", shadow: true }])])];
    const candidate = [check("block", [verdict("p", "block", [{ detectorId: "injection", action: "block" }])])];
    const { counts, checkpoints } = compareGuardChecks(baseline, candidate);
    expect(counts.newlyBlocked).toBe(1);
    expect(checkpoints[0]!.detectors[0]).toMatchObject({ before: "allow", after: "block" });
  });

  it("counts checkpoints the simulated replay never reached apart, and compares new ones with allow", () => {
    const baseline = [check("allow", [verdict("p", "allow")], { nodeId: "a" }), check("block", [verdict("p", "block")], { nodeId: "b" })];
    const candidate = [check("block", [verdict("p", "block")], { nodeId: "a" }), check("allow", [verdict("p", "allow")], { nodeId: "c" })];
    const { counts, checkpoints } = compareGuardChecks(baseline, candidate);
    expect(counts).toMatchObject({ newlyBlocked: 1, notReached: 1, unchanged: 1, noLongerBlocked: 0 });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ nodeId: "a", nodeName: null, before: "allow", after: "block" });
  });
});

describe("divergenceOf and simulateCase", () => {
  const recording = { id: "rec_1", name: "Run 1", createdAt: "2026-10-01T00:00:00.000Z" };
  const tapeMiss = withHealth([{ kind: "model_unmatched", nodeId: "agent", message: "1 model call had no recorded answer on the model tape: no entry", blocking: true }], {
    modelTape: { replayedCalls: 3, liveCalls: 0, matchedCalls: 2, recordedUsage: { inputTokens: 0, outputTokens: 0, costUsd: null } }
  });
  const allow = [check("allow", [verdict("p", "allow", [{ detectorId: "dlp", dataClass: "email", action: "allow" }])])];
  const masked = [check("mask", [verdict("p", "mask", [{ detectorId: "dlp", dataClass: "email", action: "mask" }])])];

  it("finds the first model call the tape could not answer", () => {
    expect(divergenceOf(tapeMiss)).toMatchObject({ step: 3, kind: "model", nodeId: "agent" });
    expect(divergenceOf(ok())).toBeNull();
  });

  it("finds the first tool call the cassette could not answer", () => {
    const steps = [
      { kind: "matched", baseline: { nodeId: "agent" }, candidate: { nodeId: "agent" }, argsChanged: false, argChanges: [], outcomeChanged: false },
      { kind: "matched", baseline: { nodeId: "agent" }, candidate: { nodeId: "agent" }, argsChanged: true, argChanges: [], outcomeChanged: true }
    ];
    expect(divergenceOf(withHealth([{ kind: "mcp_unmatched", nodeId: null, message: "1 MCP call had no recorded answer", blocking: true }], {}, steps))).toMatchObject({ step: 2, kind: "tool", nodeId: "agent" });
  });

  it("calls a tape miss after a guard change 'diverged', an impact rather than an error", async () => {
    const entry = simulateCase({ recordingId: "rec_1", recording, baseline: { replay: ok("b"), checks: allow }, candidate: { replay: tapeMiss, checks: masked }, profileChanged: true });
    expect(await entry).toMatchObject({ outcome: "diverged", divergedAt: { step: 3, kind: "model" }, counts: { actionChanged: 1, nowMasked: 1 }, baselineExecutionId: "b" });
  });

  it("blames a miss on the profile when it changed without changing a checkpoint (spotlighting), but not when the profile is the current one", async () => {
    expect((await simulateCase({ recordingId: "rec_1", recording, baseline: { replay: ok(), checks: allow }, candidate: { replay: tapeMiss, checks: allow }, profileChanged: true })).outcome).toBe("diverged");
    const same = await simulateCase({ recordingId: "rec_1", recording, baseline: { replay: ok(), checks: allow }, candidate: { replay: tapeMiss, checks: allow }, profileChanged: false });
    expect(same.outcome).toBe("not_simulated");
    expect(same.reason).toMatch(/not the guard's/);
  });

  it("calls a recording the baseline cannot follow stale, never an impact", async () => {
    const entry = await simulateCase({ recordingId: "rec_1", recording, baseline: { replay: tapeMiss, checks: allow }, candidate: { replay: ok(), checks: masked }, profileChanged: true });
    expect(entry.outcome).toBe("not_simulated");
    expect(entry.reason).toMatch(/recording is stale/);
    expect(entry.counts.actionChanged).toBe(0);
  });

  it("reports cases that could not run, and deleted recordings", async () => {
    const noTape = withHealth([{ kind: "no_model_tape", nodeId: null, message: "This golden run has no model tape", blocking: true }]);
    expect(await simulateCase({ recordingId: "rec_1", recording, baseline: { replay: ok(), checks: [] }, candidate: { replay: noTape, checks: [] } })).toMatchObject({ outcome: "not_simulated", reason: "This golden run has no model tape" });
    expect(await simulateCase({ recordingId: "rec_1", recording, baseline: null, candidate: null, skipped: "lost access" })).toMatchObject({ outcome: "not_simulated", reason: "lost access" });
    expect(await simulateCase({ recordingId: "rec_1", recording: null, baseline: null, candidate: null })).toMatchObject({ outcome: "not_simulated" });
    const threw: SimulatedReplay = { status: "error", error: "boom", executionId: null, response: null };
    expect(await simulateCase({ recordingId: "rec_1", recording, baseline: { replay: ok(), checks: [] }, candidate: { replay: threw, checks: [] } })).toMatchObject({ outcome: "not_simulated", reason: "boom" });
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
