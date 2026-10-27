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
  releaseAdmissionLoosening,
  releaseGateChecksWorsened,
  summarizeReleaseGateAdmission,
  type ReleaseGateCase,
  type ReleaseGateEvidence,
  type ReleaseGateReasonCheck
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
    expect(judgeReleaseGate(evidence(cases, { repeatsUnchecked: true }), policy({ maxP95LatencyIncreasePct: 10 }), { expected, now: NOW }).reasons.join()).toMatch(/recorded them for only one repeat \(it ran before replays recorded every repeat\): run the gate again, or remove those limits/);
    expect(releaseScorersMatch(undefined, null)).toBe(true);
    expect(releaseScorersMatch([], [])).toBe(true);
    expect(releaseScorersMatch(undefined, [{ type: "status" }])).toBe(false);
    expect(releaseScorersMatch([{ type: "regex", pattern: "a" }], [{ pattern: "a", type: "regex" }])).toBe(true);
  });

  it("refuses unchecked repeats only for the limits they cannot check", () => {
    const codes = (job: Partial<ReleaseGateEvidence["job"]>, input: Parameters<typeof policy>[0]) => judgeReleaseGate(evidence(cases, job), policy(input), { expected, now: NOW }).checks.map((check) => check.code);
    const latencyOnly = { repeatsUnchecked: true, repeatsUncheckedLimits: ["latency" as const] };
    expect(codes(latencyOnly, { noNewGuardBlocks: true })).not.toContain("repeats_unchecked");
    expect(codes(latencyOnly, { noNewGuardBlocks: false, maxP95LatencyIncreasePct: 10 })).toContain("repeats_unchecked");
    const guardOnly = { repeatsUnchecked: true, repeatsUncheckedLimits: ["guard" as const] };
    expect(codes(guardOnly, { noNewGuardBlocks: false, maxP95LatencyIncreasePct: 10 })).not.toContain("repeats_unchecked");
    expect(codes(guardOnly, { noNewGuardBlocks: true })).toContain("repeats_unchecked");
    // Without the list (evidence built before it existed) both limits are unchecked.
    expect(codes({ repeatsUnchecked: true }, { noNewGuardBlocks: true })).toContain("repeats_unchecked");
    expect(codes({ repeatsUnchecked: true }, { noNewGuardBlocks: false, maxCostIncreasePct: 10 })).not.toContain("repeats_unchecked");
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

describe("gate admission and required cases (enforced gates)", () => {
  const failing = (id: string): ReleaseGateCase => passing(id, { status: "fail", scorers: [{ type: "status", pass: false }] });
  /** 18 passing and 2 failing admitted cases: 90%. */
  const admittedCases = [...Array.from({ length: 18 }, (_, index) => passing(`a${index}`)), failing("a18"), failing("a19")];
  const gatePolicy = policy({ minPassRate: 0.95, maxRegressions: 10 });

  it("without admission every case counts, exactly as before admission existed", () => {
    const cases = [...admittedCases, ...Array.from({ length: 40 }, (_, index) => passing(`easy${index}`))];
    const before = judgeReleaseGate(evidence(cases), gatePolicy, { expected, now: NOW });
    const withNull = judgeReleaseGate(evidence(cases), gatePolicy, { expected, now: NOW, admission: null });
    expect(withNull).toEqual(before);
    // 58 of 60 is 96.7%: the dilution works on a gate without admission.
    expect(before.verdict).toBe("passed");
    expect(before.stats.admission).toBeUndefined();
  });

  it("dilution is blocked: 18/20 stays 18/20 when 40 easy cases wait for admission (58/60 would pass)", () => {
    const easy = Array.from({ length: 40 }, (_, index) => passing(`easy${index}`));
    const admission = { admittedIds: admittedCases.map((entry) => entry.id) };
    const judged = judgeReleaseGate(evidence([...admittedCases, ...easy]), gatePolicy, { expected, now: NOW, admission });
    expect(judged.verdict).toBe("blocked");
    expect(judged.stats).toMatchObject({ cases: 20, pass: 18, fail: 2, passRate: 0.9 });
    expect(judged.stats.admission).toMatchObject({ admitted: 20, pending: 40, pendingNotPassing: 0, required: 0, requiredFailures: [] });
    expect(judged.reasons.join("\n")).toMatch(/Pass rate 90% is below the required 95%/);
    // Once admitted they count.
    const all = { admittedIds: [...admittedCases, ...easy].map((entry) => entry.id) };
    expect(judgeReleaseGate(evidence([...admittedCases, ...easy]), gatePolicy, { expected, now: NOW, admission: all }).verdict).toBe("passed");
  });

  it("pending cases count toward no limit: not minCases, regressions, cost or guard blocks", () => {
    const admission = { admittedIds: ["c1", "c2"] };
    const cases = [passing("c1"), passing("c2"), failing("p1"), passing("p2", { newGuardBlocks: 3, costUsd: { baseline: 0.01, candidate: 9 } })];
    const judged = judgeReleaseGate(evidence(cases), policy({ maxCostIncreasePct: 10 }), { expected, now: NOW, admission });
    expect(judged.stats).toMatchObject({ cases: 2, regressions: 0, newGuardBlocks: 0, costIncreasePct: 0 });
    expect(judged.stats.admission).toMatchObject({ admitted: 2, pending: 2, pendingNotPassing: 1 });
    expect(judged.reasons).toEqual(["Only 2 cases judged; the gate needs at least 3."]);
  });

  it("a failing required case blocks even when every other case passes and the rate is met", () => {
    const cases = [...Array.from({ length: 19 }, (_, index) => passing(`c${index}`)), failing("must")];
    const admission = { admittedIds: cases.map((entry) => entry.id), requiredIds: ["must"], caseNames: { must: "Refund over limit" } };
    const lenient = policy({ minPassRate: 0.9, maxRegressions: 5 });
    expect(judgeReleaseGate(evidence(cases), lenient, { expected, now: NOW }).verdict).toBe("passed");
    const judged = judgeReleaseGate(evidence(cases), lenient, { expected, now: NOW, admission });
    expect(judged.verdict).toBe("blocked");
    expect(judged.reasons).toEqual(['Required case "Refund over limit" failed: a required case must pass whatever the pass rate.']);
    expect(judged.stats.admission?.requiredFailures).toEqual([{ id: "must", name: "Refund over limit", problem: "failed" }]);
  });

  it("a required case that is inconclusive, skipped or missing blocks whatever errorsCountAsFailures says", () => {
    const cases = [passing("c1"), passing("c2"), passing("c3"), passing("flaky", { status: "error" }), passing("off", { status: "skipped" })];
    const admission = { admittedIds: ["c1", "c2", "c3", "flaky", "off", "gone"], requiredIds: ["flaky", "off", "gone"], caseNames: { flaky: "Tape miss" } };
    const strict = judgeReleaseGate(evidence(cases), policy({ minPassRate: 0.5, maxRegressions: 5 }), { expected, now: NOW, admission });
    expect(strict.stats.admission?.requiredFailures.map((entry) => entry.problem)).toEqual(["was inconclusive", "did not run", "did not run"]);
    const lax = judgeReleaseGate(evidence(cases), policy({ minPassRate: 0.5, errorsCountAsFailures: false }), { expected, now: NOW, admission });
    expect(lax.verdict).toBe("blocked");
    expect(lax.stats.admission?.requiredFailures.map((entry) => entry.id)).toEqual(["flaky", "off", "gone"]);
    expect(lax.reasons).toContain('Required case "Tape miss" was inconclusive: a required case must pass whatever the pass rate.');
  });

  it("a required mark on a case that is not admitted has no effect", () => {
    const cases = [passing("c1"), passing("c2"), passing("c3"), failing("late")];
    const admission = { admittedIds: ["c1", "c2", "c3"], requiredIds: ["late"] };
    const judged = judgeReleaseGate(evidence(cases), policy({ minPassRate: 0.5 }), { expected, now: NOW, admission });
    expect(judged.verdict).toBe("passed");
    expect(judged.stats.admission).toMatchObject({ required: 0, requiredFailures: [] });
  });

  it("the shared summary the CLI uses gives the judge's counts", () => {
    const cases = [passing("c1"), failing("c2"), passing("p1"), failing("p2")];
    const admission = { admittedIds: ["c1", "c2"], requiredIds: ["c2"] };
    const judged = judgeReleaseGate(evidence(cases), policy(), { expected, now: NOW, admission });
    expect(summarizeReleaseGateAdmission(cases, admission)).toEqual(judged.stats.admission);
  });

  it("removing an admitted case or clearing required loosens the gate; admitting or requiring tightens it", () => {
    const before = { admittedIds: ["a", "b"], requiredIds: ["a"] };
    expect(releaseAdmissionLoosening(before, { admittedIds: ["a", "b", "c"], requiredIds: ["a", "b"] })).toEqual([]);
    expect(releaseAdmissionLoosening(before, { admittedIds: ["a"], requiredIds: ["a"] }, { b: "Big refund" })).toEqual(['removes admitted case "Big refund"']);
    expect(releaseAdmissionLoosening(before, { admittedIds: ["a", "b"], requiredIds: [] })).toEqual(['stops requiring case "a"']);
    const gate = releaseGateSettingsSchema.parse({ enabled: true, datasetIds: ["set_a"] });
    expect(releaseGateLoosening(gate, gate)).toEqual([]);
    expect(releaseGateLoosening(gate, gate, { before, after: { admittedIds: ["b"], requiredIds: [] } })).toEqual(['removes admitted case "a"', 'stops requiring case "a"']);
  });
});

describe("gate reason checks", () => {
  const failing = (id: string): ReleaseGateCase => passing(id, { status: "fail", scorers: [{ type: "status", pass: false }] });

  it("give every reason a stable code, in the same order, whose wording may change", () => {
    const cases = [passing("c1"), passing("c2"), failing("c3"), passing("p1")];
    const gatePolicy = policy({ minCases: 10, minPassRate: 0.9, maxRegressions: 5 });
    const judged = judgeReleaseGate(evidence(cases, { staleSets: ["set_a"] }), gatePolicy, { expected, now: NOW, admission: { admittedIds: ["c1", "c2", "c3"] } });
    expect(judged.checks.map((check) => check.code)).toEqual(["stale_sets:set_a", "min_cases", "pass_rate"]);
    expect(judged.checks).toHaveLength(judged.reasons.length);
    // A case waiting for admission is not in the wording: it must not change what a request is compared against.
    const plain = judgeReleaseGate(evidence(cases.slice(0, 3), { staleSets: ["set_a"] }), gatePolicy, { expected, now: NOW, admission: { admittedIds: ["c1", "c2", "c3"] } });
    expect(plain.reasons).toEqual(judged.reasons);
    expect(releaseGateChecksWorsened(judged.checks, plain.checks)).toEqual([]);
    expect(judgeReleaseGate(null, gatePolicy, { expected }).checks).toEqual([{ code: "no_job", measure: null }]);
    expect(judgeReleaseGate(evidence([passing("c1")]), policy({ minCases: 1 }), { expected, now: NOW, requireApproval: true }).checks).toEqual([
      { code: "approval_required", measure: null }
    ]);
  });

  it("are worse only for a new code or a higher measure; better numbers and vanished reasons are not", () => {
    const gatePolicy = policy({ minPassRate: 0.9, maxRegressions: 5 });
    const at = (pass: number, fail: number) =>
      judgeReleaseGate(evidence([...Array.from({ length: pass }, (_, i) => passing(`p${i}`)), ...Array.from({ length: fail }, (_, i) => failing(`f${i}`))]), gatePolicy, { expected, now: NOW }).checks;
    const before = at(8, 2);
    expect(before.map((check) => check.code)).toEqual(["pass_rate"]);
    expect(releaseGateChecksWorsened(before, at(9, 2))).toEqual([]);
    expect(releaseGateChecksWorsened(before, at(7, 3)).map((check) => check.code)).toEqual(["pass_rate"]);
    // A tighter minimum on the same numbers is worse too.
    const tighter = judgeReleaseGate(evidence([...Array.from({ length: 8 }, (_, i) => passing(`p${i}`)), failing("f0"), failing("f1")]), policy({ minPassRate: 0.95, maxRegressions: 5 }), { expected, now: NOW }).checks;
    expect(releaseGateChecksWorsened(before, tighter)).toHaveLength(1);
    expect(releaseGateChecksWorsened(before, [...before, { code: "required_case:f0", measure: null }]).map((check) => check.code)).toEqual(["required_case:f0"]);
    expect(releaseGateChecksWorsened(before, [])).toEqual([]);
  });

  it("recording_age has no measure, so the same golden run judged a day later is not worse", () => {
    const old = (now: string) =>
      judgeReleaseGate(evidence([passing("c1", { recordingCreatedAt: "2026-07-01T00:00:00.000Z" })]), policy({ maxRecordingAgeDays: 30, minCases: 1 }), { expected, now: new Date(now) });
    const day1 = old("2026-10-24T12:00:00.000Z");
    const day2 = old("2026-10-25T12:00:00.000Z");
    expect(day1.checks).toEqual([{ code: "recording_age", measure: null }]);
    expect(day2.reasons).not.toEqual(day1.reasons);
    expect(releaseGateChecksWorsened(day1.checks, day2.checks)).toEqual([]);
  });

  it("measure a stale or uncovered set by its admitted-case count, so more unrun cases count as worse", () => {
    const stale = (count: number) =>
      judgeReleaseGate(evidence([passing("c1")], { datasetIds: [], staleSets: ["s"], staleSetCounts: { s: count } }), policy({ minCases: 1 }), { expected: { ...expected, datasetIds: [] }, now: NOW }).checks;
    expect(stale(1)).toEqual([{ code: "stale_sets:s", measure: 1 }]);
    expect(releaseGateChecksWorsened(stale(1), stale(4)).map((check) => check.code)).toEqual(["stale_sets:s"]);
    expect(releaseGateChecksWorsened(stale(4), stale(4))).toEqual([]);
    const uncovered = (count: number) =>
      judgeReleaseGate(evidence([passing("c1")], { datasetIds: [] }), policy({ minCases: 1 }), { expected: { ...expected, datasetIds: ["s"], setCaseCounts: { s: count } }, now: NOW }).checks;
    expect(releaseGateChecksWorsened(uncovered(2), uncovered(5)).map((check) => check.code)).toEqual(["sets_not_covered:s"]);
  });

  it("carry one code per uncovered set, stale set, override and ineligible reason, and the gate's scorers", () => {
    const judge = (job: Partial<ReleaseGateEvidence["job"]>, sets: string[] = ["set_a"], scorersKey?: string) =>
      judgeReleaseGate(evidence([passing("c1")], { datasetIds: [], ...job }), policy({ minCases: 1 }), { expected: { ...expected, datasetIds: sets, scorersKey }, now: NOW }).checks;
    const worse = (before: ReleaseGateReasonCheck[], now: ReleaseGateReasonCheck[]) => releaseGateChecksWorsened(before, now).map((check) => check.code);
    expect(worse(judge({}, ["b"]), judge({}, ["b", "c"]))).toEqual(["sets_not_covered:c"]);
    expect(worse(judge({ staleSets: ["a"] }, []), judge({ staleSets: ["a", "b"] }, []))).toEqual(["stale_sets:b"]);
    expect(worse(judge({ overrides: ["repeats"] }, []), judge({ overrides: ["repeats", "model"] }, []))).toEqual(["overrides:model"]);
    expect(worse(judge({ releaseEligible: false, releaseIneligibleReasons: ["a"] }, []), judge({ releaseEligible: false, releaseIneligibleReasons: ["a", "b"] }, []))).toEqual(["ineligible:b"]);
    const mismatch = { scorerMismatch: "ran with its own scorers" };
    expect(worse(judge(mismatch, [], "aaa"), judge(mismatch, [], "bbb"))).toEqual(["scorer_mismatch:bbb"]);
    expect(worse(judge(mismatch, [], "aaa"), judge(mismatch, [], "aaa"))).toEqual([]);
  });
});

describe("repeats: cost and p95 latency at the worst selection of the repeats", () => {
  const pair = (baseline: number, candidate: number) => ({ baseline, candidate });
  const flat = (id: string) => passing(id, { latencyMs: pair(1000, 1000), repeats: { latencyMs: [pair(1000, 1000), pair(1000, 1000)] } });

  it("is never more lenient than the deciding repeats when a larger repeat rose less (p95)", () => {
    // rec_a: the deciding repeat 1000 → 1500 (+50%); repeat 2 adds more time (3000 → 3600) but only +20%.
    const caseA = passing("a", { latencyMs: pair(1000, 1500), repeats: { latencyMs: [pair(1000, 1500), pair(3000, 3600)] } });
    const judgement = judgeReleaseGate(evidence([caseA, flat("b"), flat("c")]), policy({ maxP95LatencyIncreasePct: 30 }), { expected, now: NOW });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(judgement.stats.repeatSelection?.latency).toEqual({ by: "deciding" });
    expect(judgement.reasons).toEqual(["p95 latency rose 50%; the gate allows 30%."]);
  });

  it("finds a repeat the deciding repeats hide, and names it", () => {
    const caseA = passing("a", { latencyMs: pair(3000, 3600), repeats: { latencyMs: [pair(3000, 3600), pair(1000, 1500)] } });
    const judgement = judgeReleaseGate(evidence([caseA, flat("b"), flat("c")]), policy({ maxP95LatencyIncreasePct: 30 }), { expected, now: NOW });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(judgement.reasons).toEqual(["p95 latency rose 50% at repeat 2; the gate allows 30%."]);
  });

  it("names each case's largest absolute or relative increase when no single repeat index shows it", () => {
    // Case a is worst at repeat 1, case b at repeat 2: only a per-case pick puts both in one set.
    const cost = (deciding: [number, number], repeats: Array<[number, number]>) => ({ costUsd: pair(...deciding), repeats: { costUsd: repeats.map(([b, c]) => pair(b, c)) } });
    const absolute = judgeReleaseGate(
      evidence([passing("a", cost([0.01, 0.01], [[0.01, 0.02], [0.01, 0.01]])), passing("b", cost([0.01, 0.01], [[0.01, 0.01], [0.01, 0.02]]))]),
      policy({ minCases: 1, maxCostIncreasePct: 60 }),
      { expected, now: NOW }
    );
    expect(absolute.stats.costIncreasePct).toBeCloseTo(100, 6);
    expect(absolute.reasons).toEqual(["Cost rose 100% at each case's repeat that added the most cost; the gate allows 60%."]);
    // Each case has a short repeat at +50% and a long one that adds more time at +5%: every repeat index and the
    // largest increase keep a long repeat at the top of p95 (+5%); only the relative pick shows the +50%.
    const relative = judgeReleaseGate(
      evidence([
        passing("a", { latencyMs: pair(2000, 2100), repeats: { latencyMs: [pair(100, 150), pair(2000, 2100)] } }),
        passing("b", { latencyMs: pair(2000, 2100), repeats: { latencyMs: [pair(2000, 2100), pair(100, 150)] } })
      ]),
      policy({ minCases: 1, maxP95LatencyIncreasePct: 30 }),
      { expected, now: NOW }
    );
    expect(relative.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(relative.stats.repeatSelection?.latency).toEqual({ by: "largest_relative_increase" });
    expect(relative.reasons).toEqual(["p95 latency rose 50% at each case's repeat that rose the most over its own baseline; the gate allows 30%."]);
  });

  it("falls back to the largest increase for a case whose baselines are all zero", () => {
    const caseA = passing("a", { costUsd: pair(0.01, 0.01), repeats: { costUsd: [pair(0, 0.001), pair(0, 0.02)] } });
    const caseB = passing("b", { costUsd: pair(0.01, 0.01), repeats: { costUsd: [pair(0.01, 0.01), pair(0.01, 0.01)] } });
    const judgement = judgeReleaseGate(evidence([caseA, caseB]), policy({ minCases: 1, maxCostIncreasePct: 10 }), { expected, now: NOW });
    // Repeat 2, the largest increase and the relative pick (which falls back to it) all give $0.01 → $0.03; repeat 2 comes first.
    expect(judgement.stats.costIncreasePct).toBeCloseTo(200, 6);
    expect(judgement.stats.repeatSelection?.cost).toEqual({ by: "repeat", repeat: 2 });
  });

  it("uses a case's deciding pair where a repeat has no pair, and judges cases without repeats as before", () => {
    const caseA = passing("a", { latencyMs: pair(1000, 1100), repeats: { latencyMs: [null, pair(1000, 1050)] } });
    const judgement = judgeReleaseGate(evidence([caseA, passing("b")]), policy({ minCases: 1, maxP95LatencyIncreasePct: 5 }), { expected, now: NOW });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(10, 6);
    expect(judgement.stats.repeatSelection?.latency).toEqual({ by: "deciding" });
    const plain = judgeReleaseGate(evidence([passing("a"), passing("b")]), policy({ minCases: 1, maxP95LatencyIncreasePct: 5 }), { expected, now: NOW });
    expect(plain.stats.repeatSelection).toBeUndefined();
    expect(plain.verdict).toBe("passed");
  });

  it("never passes where the deciding repeats alone block (seeded random repeat sets)", () => {
    // A small deterministic generator (mulberry32), so a failure reproduces from its seed.
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let stricter = 0;
    for (let seed = 1; seed <= 2000; seed += 1) {
      const next = random(seed);
      const repeats = 2 + Math.floor(next() * 3);
      const recording = next() < 0.3;
      const value = (scale: number) => Math.round(scale * (0.1 + next() * 3) * 1000) / 1000;
      const metric = (scale: number, shared: number | null) => {
        const pairs = Array.from({ length: repeats }, () => {
          if (next() < 0.1) return null;
          const baseline = shared ?? (next() < 0.05 ? 0 : value(scale));
          return pair(baseline, Math.max(0, Math.round((baseline || scale / 10) * (0.7 + next() * 1.1) * 1000) / 1000));
        });
        const decidingIndex = Math.floor(next() * repeats);
        const deciding = pairs[decidingIndex] ?? pair(shared ?? value(scale), value(scale));
        pairs[decidingIndex] = deciding;
        return { deciding, pairs };
      };
      const cases = Array.from({ length: 1 + Math.floor(next() * 6) }, (_unused, index) => {
        const cost = metric(0.01, recording ? value(0.01) : null);
        const latency = metric(1000, recording ? value(1000) : null);
        return passing(`c${index}`, { costUsd: cost.deciding, latencyMs: latency.deciding, repeats: { costUsd: cost.pairs, latencyMs: latency.pairs } });
      });
      const limits = policy({ minCases: 1, maxCostIncreasePct: Math.floor(next() * 60), maxP95LatencyIncreasePct: Math.floor(next() * 60) });
      const full = judgeReleaseGate(evidence(cases), limits, { expected, now: NOW });
      const decidingOnly = judgeReleaseGate(evidence(cases.map(({ repeats: _repeats, ...rest }) => rest)), limits, { expected, now: NOW });
      const rank = (value: number | null) => value ?? Number.NEGATIVE_INFINITY;
      expect(rank(full.stats.costIncreasePct), `seed ${seed} cost`).toBeGreaterThanOrEqual(rank(decidingOnly.stats.costIncreasePct));
      expect(rank(full.stats.p95LatencyIncreasePct), `seed ${seed} latency`).toBeGreaterThanOrEqual(rank(decidingOnly.stats.p95LatencyIncreasePct));
      if (decidingOnly.verdict === "blocked") expect(full.verdict, `seed ${seed}`).toBe("blocked");
      if (full.verdict === "blocked" && decidingOnly.verdict === "passed") stricter += 1;
    }
    // The repeats are not ignored: some sets block only at a repeat the deciding ones hide.
    expect(stricter).toBeGreaterThan(0);
  });
});
