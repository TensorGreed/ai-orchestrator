import { describe, expect, it } from "vitest";
import {
  aggregateReleaseRepeats,
  defaultReleaseGate,
  judgeReleaseGate,
  releaseGateAdminOnlyChanges,
  releaseGateLoosening,
  releaseGatePolicySchema,
  releaseScorersMatch,
  releaseGateSettingsSchema,
  releasePublishInputSchema,
  type ReleaseGateCase,
  type ReleaseGateEvidence
} from "./release";

const HASH = "a".repeat(64);
const NOW = new Date("2026-10-24T12:00:00.000Z");
const policy = (input: Record<string, unknown> = {}) => releaseGatePolicySchema.parse(input);

const passing = (id: string, extra: Partial<ReleaseGateCase> = {}): ReleaseGateCase => ({
  id,
  status: "pass",
  scorers: [{ type: "status", pass: true }],
  costUsd: { baseline: 0.01, candidate: 0.01 },
  latencyMs: { baseline: 1000, candidate: 1000 },
  newGuardBlocks: 0,
  recordingCreatedAt: "2026-10-20T00:00:00.000Z",
  ...extra
});

const evidence = (cases: ReleaseGateCase[], job: Partial<ReleaseGateEvidence["job"]> = {}): ReleaseGateEvidence => ({
  job: { id: "run_1", status: "completed", workflowHash: HASH, datasetIds: ["set_a"], liveWrites: false, ...job },
  cases
});

const expected = { workflowHash: HASH, datasetIds: ["set_a"] };

describe("judgeReleaseGate", () => {
  it("passes a clean job and blocks a missing one", () => {
    const ok = judgeReleaseGate(evidence([passing("c1"), passing("c2"), passing("c3")]), policy(), { expected, now: NOW });
    expect(ok).toMatchObject({ verdict: "passed", reasons: [] });
    expect(ok.stats).toMatchObject({ cases: 3, pass: 3, passRate: 1, regressions: 0 });
    expect(judgeReleaseGate(null, policy(), { expected, now: NOW }).verdict).toBe("blocked");
  });

  it("asks for approval when the gate always requires it", () => {
    const judged = judgeReleaseGate(evidence([passing("c1"), passing("c2"), passing("c3")]), policy(), { expected, requireApproval: true, now: NOW });
    expect(judged.verdict).toBe("needs_approval");
  });

  it("binds to the exact hash, the gate's sets and a completed job", () => {
    const cases = [passing("c1"), passing("c2"), passing("c3")];
    const reasons = judgeReleaseGate(evidence(cases, { workflowHash: "b".repeat(64), datasetIds: ["set_b"], status: "running" }), policy(), {
      expected,
      now: NOW
    }).reasons.join("\n");
    expect(reasons).toMatch(/different workflow hash/);
    expect(reasons).toMatch(/did not cover the gate's golden set set_a/);
    expect(reasons).toMatch(/is running, not completed/);
  });

  it("refuses live writes and a lenient job on a strict gate", () => {
    const cases = [passing("c1"), passing("c2"), passing("c3")];
    const judged = judgeReleaseGate(evidence(cases, { liveWrites: true, mcpMode: "lenient" }), policy(), { expected: { ...expected, mcpMode: "strict" }, now: NOW });
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join("\n")).toMatch(/live write calls/);
    expect(judged.reasons.join("\n")).toMatch(/strictly/);
  });

  it("refuses a job that ran with overrides the gate does not specify", () => {
    const cases = [passing("c1"), passing("c2"), passing("c3")];
    const judged = judgeReleaseGate(evidence(cases, { overrides: ["overrides (guardProfiles)"] }), policy(), { expected, now: NOW });
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons.join("\n")).toMatch(/settings the gate does not specify \(overrides \(guardProfiles\)\)/);
    expect(judgeReleaseGate(evidence(cases, { overrides: [] }), policy(), { expected, now: NOW }).verdict).toBe("passed");
  });

  it("counts regressions, pass rate and minimum cases", () => {
    const cases = [passing("c1"), { ...passing("c2"), status: "fail" as const }, { ...passing("c3"), status: "error" as const }];
    const strict = judgeReleaseGate(evidence(cases), policy(), { expected, now: NOW });
    expect(strict.stats).toMatchObject({ regressions: 2, passRate: 1 / 3 });
    expect(strict.verdict).toBe("blocked");
    // Errors left out: one regression, pass rate over the two judged cases.
    const lenient = judgeReleaseGate(evidence(cases), policy({ errorsCountAsFailures: false, maxRegressions: 1, minPassRate: 0.5 }), { expected, now: NOW });
    expect(lenient.stats).toMatchObject({ regressions: 1, passRate: 0.5 });
    expect(lenient.verdict).toBe("passed");
    expect(judgeReleaseGate(evidence([passing("c1")]), policy(), { expected, now: NOW }).reasons.join()).toMatch(/needs at least 3/);
  });

  it("does not count a case the baseline also failed as a regression", () => {
    const cases = [passing("c1"), passing("c2"), { ...passing("c3"), status: "fail" as const, baselineStatus: "fail" as const }];
    const judged = judgeReleaseGate(evidence(cases), policy({ minPassRate: 0.6 }), { expected, now: NOW });
    expect(judged.stats.regressions).toBe(0);
    expect(judged.verdict).toBe("passed");
  });

  it("checks required scorers, cost, latency and guard blocks", () => {
    const cases = [
      passing("c1", { costUsd: { baseline: 0.01, candidate: 0.03 }, latencyMs: { baseline: 1000, candidate: 3000 } }),
      passing("c2", { scorers: [{ type: "status", pass: true }, { type: "json_equal", pass: false }], newGuardBlocks: 1 }),
      passing("c3")
    ];
    const judged = judgeReleaseGate(
      evidence(cases),
      policy({ requiredScorers: ["json_equal"], maxCostIncreasePct: 10, maxP95LatencyIncreasePct: 50 }),
      { expected, now: NOW }
    );
    const text = judged.reasons.join("\n");
    expect(judged.verdict).toBe("blocked");
    expect(text).toMatch(/Required scorer json_equal did not pass on 3 cases/);
    expect(text).toMatch(/Cost rose 66.7%/);
    expect(text).toMatch(/p95 latency rose 200%/);
    expect(text).toMatch(/1 guard block/);
  });

  it("needs a baseline rerun when a golden run is older than the gate allows (decision 3)", () => {
    const cases = [passing("c1", { recordingCreatedAt: "2026-08-01T00:00:00.000Z" }), passing("c2"), passing("c3")];
    expect(judgeReleaseGate(evidence(cases), policy(), { expected, now: NOW }).reasons.join()).toMatch(/days old/);
    expect(judgeReleaseGate(evidence(cases, { compare: "recording" }), policy(), { expected, now: NOW }).verdict).toBe("blocked");
    expect(judgeReleaseGate(evidence(cases, { compare: "baseline_rerun" }), policy(), { expected, now: NOW }).verdict).toBe("passed");
  });

  it("re-judges under a looser policy", () => {
    const cases = [passing("c1"), passing("c2"), { ...passing("c3"), status: "fail" as const }];
    expect(judgeReleaseGate(evidence(cases), policy(), { expected, now: NOW }).verdict).toBe("blocked");
    expect(judgeReleaseGate(evidence(cases), policy({ maxRegressions: 1, minPassRate: 0.6 }), { expected, now: NOW }).verdict).toBe("passed");
  });
});

describe("aggregateReleaseRepeats", () => {
  it("aggregates repeats by mode", () => {
    expect(aggregateReleaseRepeats(["pass", "fail", "pass"], "all")).toBe("fail");
    expect(aggregateReleaseRepeats(["pass", "fail", "pass"], "majority")).toBe("pass");
    expect(aggregateReleaseRepeats(["fail", "fail", "pass"], "any")).toBe("pass");
    expect(aggregateReleaseRepeats(["error", "error"], "all")).toBe("error");
    expect(aggregateReleaseRepeats(["skipped"], "all")).toBe("skipped");
    expect(aggregateReleaseRepeats(["pass", "error"], "majority")).toBe("error");
  });
});

describe("gate settings", () => {
  const settings = (input: Record<string, unknown>) => releaseGateSettingsSchema.parse({ enabled: true, datasetIds: ["set_a"], ...input });

  it("validates settings", () => {
    expect(releaseGateSettingsSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(releaseGateSettingsSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(releaseGateSettingsSchema.safeParse({ enabled: true, datasetIds: ["a"], requireApproval: true }).success).toBe(false);
    expect(releaseGateSettingsSchema.safeParse({ enabled: true, datasetIds: ["a", "a"] }).success).toBe(false);
    expect(defaultReleaseGate("wf").policy).toMatchObject({ minPassRate: 1, maxRegressions: 0, minCases: 3, maxRecordingAgeDays: 30 });
  });

  it("names every way a change loosens the gate", () => {
    const before = settings({
      policy: { maxCostIncreasePct: 10 },
      candidateOptions: { mcpMode: "strict" },
      requireApproval: true,
      approvers: { approverRoles: ["admin"] }
    });
    expect(releaseGateLoosening(before, before)).toEqual([]);
    const tighter = settings({
      datasetIds: ["set_a", "set_b"],
      policy: { maxCostIncreasePct: 5, minCases: 5 },
      candidateOptions: { mcpMode: "strict" },
      requireApproval: true,
      approvers: { approverRoles: ["admin"] }
    });
    expect(releaseGateLoosening(before, tighter)).toEqual([]);
    const looser = releaseGateSettingsSchema.parse({
      enabled: false,
      datasetIds: [],
      policy: { minPassRate: 0.5, maxRegressions: 2, errorsCountAsFailures: false, noNewGuardBlocks: false, minCases: 1, maxRecordingAgeDays: 90 },
      candidateOptions: { mcpMode: "lenient" },
      approvers: { approverRoles: ["admin", "builder"], allowSelfApproval: true }
    });
    const reasons = releaseGateLoosening(before, looser);
    for (const fragment of [
      "disables",
      "removes golden set",
      "pass rate",
      "more regressions",
      "errors",
      "cost limit",
      "guard blocks",
      "minimum number",
      "older golden runs",
      "strictly",
      "requiring approval",
      "self-approval",
      "widens"
    ]) {
      expect(reasons.join("\n")).toContain(fragment);
    }
  });
});

describe("Phase 15.4 review fixes", () => {
  const settings = (input: Record<string, unknown>) => releaseGateSettingsSchema.parse({ enabled: true, datasetIds: ["set_a"], ...input });
  const cases = [passing("c1"), passing("c2"), passing("c3")];

  it("replays MCP strictly unless the gate says otherwise (L3)", () => {
    expect(judgeReleaseGate(evidence(cases, { mcpMode: "lenient" }), policy(), { expected, now: NOW }).reasons.join()).toMatch(/strictly/);
    expect(judgeReleaseGate(evidence(cases, { mcpMode: "lenient" }), policy(), { expected: { ...expected, mcpMode: "lenient" }, now: NOW }).verdict).toBe("passed");
  });

  it("requires releaseEligible when the job carries it, and judges by its own checks when it does not (contract addendum)", () => {
    const refused = judgeReleaseGate(evidence(cases, { releaseEligible: false, releaseIneligibleReasons: ["guard profile override"] }), policy(), { expected, now: NOW });
    expect(refused.verdict).toBe("blocked");
    expect(refused.reasons.join()).toMatch(/not eligible to prove a release \(guard profile override\)/);
    expect(judgeReleaseGate(evidence(cases, { releaseEligible: true }), policy(), { expected, now: NOW }).verdict).toBe("passed");
    expect(judgeReleaseGate(evidence(cases), policy(), { expected, now: NOW }).verdict).toBe("passed");
  });

  it("refuses a job judged with other scorers or over sets that changed since it was queued (H2, M4)", () => {
    expect(judgeReleaseGate(evidence(cases, { scorerMismatch: "ran with its own scorers (regex)" }), policy(), { expected, now: NOW }).reasons.join()).toMatch(/its own scorers \(regex\).*the gate judges with its own scorers/);
    expect(judgeReleaseGate(evidence(cases, { staleSets: ["set_a"] }), policy(), { expected, now: NOW }).reasons.join()).toMatch(/set_a changed after replay job/);
    expect(judgeReleaseGate(evidence(cases, { noSetSnapshot: true }), policy(), { expected, now: NOW }).reasons.join()).toMatch(/queued before release gates existed/);
    expect(judgeReleaseGate(evidence(cases, { repeatsUnchecked: true }), policy({ maxP95LatencyIncreasePct: 10 }), { expected, now: NOW }).reasons.join()).toMatch(/repeats 1, or remove those limits/);
    expect(releaseScorersMatch(undefined, null)).toBe(true);
    expect(releaseScorersMatch([], [])).toBe(true);
    expect(releaseScorersMatch(undefined, [{ type: "status" }])).toBe(false);
    expect(releaseScorersMatch([{ type: "regex", pattern: "a" }], [{ pattern: "a", type: "regex" }])).toBe(true);
  });

  it("counts a case without a complete diff as an error when the policy has cost, latency or guard limits (L5)", () => {
    const blind = [passing("c1"), passing("c2"), passing("c3", { diffMissing: true })];
    const judged = judgeReleaseGate(evidence(blind), policy(), { expected, now: NOW });
    expect(judged.verdict).toBe("blocked");
    expect(judged.stats).toMatchObject({ pass: 2, error: 1 });
    // Without any such limit the diff does not matter.
    expect(judgeReleaseGate(evidence(blind), policy({ noNewGuardBlocks: false }), { expected, now: NOW }).verdict).toBe("passed");
  });

  it("treats adding approvers to a gate without any as widening, and every approver or job-setting change as admin-only (H1, M2)", () => {
    const base = settings({ approvers: null });
    const withSelf = settings({ approvers: { approverUsers: ["me@example.com"], allowSelfApproval: true } });
    expect(releaseGateLoosening(base, withSelf)).toEqual(expect.arrayContaining(["widens who may approve", "allows self-approval"]));
    const restricted = settings({ approvers: { approverRoles: ["admin"] } });
    // Narrowing approvers is not loosening, but it is still the admin's call on an enforced gate.
    const narrower = settings({ approvers: { approverRoles: ["admin"], approverUsers: ["lead@example.com"] } });
    expect(releaseGateLoosening(narrower, restricted)).toEqual([]);
    expect(releaseGateAdminOnlyChanges(narrower, restricted)).toEqual(["changes who may approve"]);
    expect(releaseGateAdminOnlyChanges(restricted, restricted)).toEqual([]);
    for (const candidateOptions of [{ repeats: 5, aggregate: "any" }, { aggregate: "majority" }, { compare: "recording" }, { mcpMode: "lenient" }, { scorers: [{ type: "status" }] }, { maxCostUsd: 99 }]) {
      const after = settings({ candidateOptions });
      expect(releaseGateAdminOnlyChanges(settings({ candidateOptions: { compare: "baseline_rerun" } }), after).length, JSON.stringify(candidateOptions)).toBeGreaterThan(0);
    }
    expect(releaseGateLoosening(settings({}), settings({ candidateOptions: { repeats: 5, aggregate: "any" } }))).toEqual(expect.arrayContaining(["accepts a case that passes on fewer repeats", "gives a flaky case more tries to pass"]));
    expect(releaseGateLoosening(settings({ candidateOptions: { compare: "baseline_rerun" } }), settings({}))).toContain("stops rerunning the baseline");
    // Unset MCP mode is strict: naming strict changes nothing.
    expect(releaseGateAdminOnlyChanges(settings({}), settings({ candidateOptions: { mcpMode: "strict" } }))).toEqual([]);
  });
});

describe("publish input", () => {
  it("takes an override or an approval request, not both", () => {
    expect(releasePublishInputSchema.safeParse({ version: 2 }).success).toBe(true);
    expect(releasePublishInputSchema.safeParse({ version: 2, override: { reason: "hotfix" }, requestApproval: { reason: "x" } }).success).toBe(false);
    expect(releasePublishInputSchema.safeParse({ version: 2, override: { reason: " " } }).success).toBe(false);
    expect(releasePublishInputSchema.safeParse({ version: 2, workflowHash: "xyz" }).success).toBe(false);
  });
});
