/**
 * Replay repeats record latency and new guard blocks for every attempt, so a
 * release gate with a latency or guard limit judges a job with repeats above
 * 1 at its worst attempt instead of refusing it. Latencies and guard verdicts
 * come from the injected replay (no clock is read), and the job runs on the
 * test store (SQLite, or Postgres under TEST_STORE=postgres).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  judgeReleaseGate,
  releaseCandidateOptionsSchema,
  releaseGatePolicySchema,
  type EvalCaseDetail,
  type EvalScorerSpec,
  type ReleaseGatePolicyInput,
  type ReplayRunResponse,
  type RunDiff,
  type RunFactGuardVerdict,
  type RunFacts,
  type Workflow
} from "@ai-orchestrator/shared";
import type { ReplayRecordingRecord } from "../db/database.js";
import type { Store } from "../db/store.js";
import { openTestStore } from "../test-support/test-store.js";
import type { EvalLlmJudge } from "./eval-scorers.js";
import { EvalService, type EvalReplayDeps } from "./eval-service.js";
import { ReleaseService } from "./release-service.js";

let tempDir: string;
let store: Store;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-replay-attempts-"));
  store = await openTestStore(path.join(tempDir, "orchestrator.db"));
  await store.ensureDefaultProject();
  await store.upsertWorkflow({ id: "wf", name: "WF", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as Workflow);
});

afterEach(async () => {
  try {
    await store.close();
  } catch {
    // Already closed.
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const RECORDED_LATENCY_MS = 100;
const actor = { id: "u1", email: "b@example.com", role: "builder" as const };

function facts(output: unknown, durationMs: number, costUsd = 0.01): RunFacts {
  return {
    status: "success",
    error: null,
    output,
    nodes: [],
    toolCalls: [],
    modelCalls: [],
    guard: [],
    totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd, durationMs, modelCalls: 1, toolCalls: 0 }
  };
}

const recordingFor = (id: string): ReplayRecordingRecord =>
  ({
    id,
    workflowId: "wf",
    projectId: "default",
    name: id,
    notes: null,
    sourceExecutionId: null,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "h",
    workflowSavedVersion: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 1,
    truncated: false,
    createdAt: new Date().toISOString(),
    createdBy: null,
    capturedWorkflow: {},
    input: { q: id },
    nodes: {},
    facts: facts({ answer: id }, RECORDED_LATENCY_MS),
    mcpCassette: null
  }) as ReplayRecordingRecord;

const verdict = (effectiveAction: string, shadow = false): RunFactGuardVerdict => ({ nodeId: "agent", placement: "output", channel: "model", detectorId: "pii", effectiveAction, shadow });

/**
 * What one replayed attempt measured: its latency (and cost) and the guard
 * verdicts it added against its reference run. With baseline reruns, the
 * baseline's own latency and cost in that repeat, or that it was inconclusive.
 */
interface AttemptPlan {
  latencyMs: number;
  costUsd?: number;
  guardAdded?: RunFactGuardVerdict[];
  baselineLatencyMs?: number;
  baselineCostUsd?: number;
  baselineError?: boolean;
}

function delta(baseline: number, candidate: number) {
  return { baseline, candidate, delta: candidate - baseline, pct: baseline === 0 ? null : ((candidate - baseline) / baseline) * 100 };
}

const RECORDED_COST_USD = 0.01;

/**
 * Replays answer from `plan(recordingId, repeatIndex)`: the diff carries the
 * planned latency, cost and guard verdicts, compared with the recording or,
 * when the job reruns the baseline, with that repeat's baseline run.
 */
function replayDeps(recordings: Map<string, ReplayRecordingRecord>, plan: (recordingId: string, repeatIndex: number) => AttemptPlan): EvalReplayDeps {
  const totals = (reference: RunFacts["totals"], latencyMs: number, costUsd: number) => ({
    tokens: delta(15, 15),
    costUsd: delta(reference.costUsd ?? 0, costUsd),
    latencyMs: delta(reference.durationMs ?? 0, latencyMs),
    toolCalls: delta(0, 0)
  });
  return {
    resolveCandidate: async (workflowId, request) => ({ workflow: (await store.getWorkflow(workflowId))!, kind: request.version ? "version" : "draft", version: request.version ?? null, workflowHash: "cand-hash" }),
    getRecording: async (id) => recordings.get(id) ?? null,
    baselineFor: async () => ({ workflow: (await store.getWorkflow("wf"))!, kind: "version", version: 1, source: "version" }),
    replayCase: async ({ recording, executionId, repeatIndex, role, baseline }) => {
      const attempt = plan(recording.id, repeatIndex ?? 0);
      if (role === "baseline") {
        const ran = facts(recording.facts.output, attempt.baselineLatencyMs ?? RECORDED_LATENCY_MS, attempt.baselineCostUsd ?? RECORDED_COST_USD);
        return {
          recordingId: recording.id,
          executionId,
          candidate: { kind: "version", version: 1, workflowHash: "h" },
          status: "success",
          diff: { health: [], totals: totals(recording.facts.totals, ran.totals.durationMs!, ran.totals.costUsd!), guard: { added: [], removed: [], changed: [] } } as unknown as RunDiff,
          verdict: attempt.baselineError ? "error" : "pass",
          reasons: attempt.baselineError ? ["The baseline run failed."] : [],
          facts: ran
        } satisfies ReplayRunResponse;
      }
      const reference = baseline ? baseline.facts.totals : recording.facts.totals;
      const costUsd = attempt.costUsd ?? RECORDED_COST_USD;
      const diff = {
        health: [],
        totals: totals(reference, attempt.latencyMs, costUsd),
        guard: { added: attempt.guardAdded ?? [], removed: [], changed: [] }
      } as unknown as RunDiff;
      return {
        recordingId: recording.id,
        executionId,
        candidate: { kind: "draft", version: null, workflowHash: "cand-hash" },
        status: "success",
        diff,
        verdict: "pass",
        reasons: [],
        facts: facts(recording.facts.output, attempt.latencyMs, costUsd)
      } satisfies ReplayRunResponse;
    },
    actorFor: async (_userId, email) => ({ id: "u1", email, role: "builder" })
  };
}

/** An LLM judge that always passes and costs $0.005 a call (only `llm_judge` scorers call it). */
const JUDGE_COST_USD = 0.005;
const judgeCall: EvalLlmJudge = async () => ({ content: "{\"score\": 1}", costUsd: JUDGE_COST_USD });
const judgeScorers: EvalScorerSpec[] = [{ type: "status", expect: "success" }, { type: "llm_judge", rubric: "Is it right?", providerId: "openai", model: "gpt-4o-mini" }];

/** The job's comparison settings, which the gate's candidate options name too. */
interface JobSettings {
  scorers?: EvalScorerSpec[];
  repeats?: number;
  aggregate?: "all" | "majority" | "any";
  compare?: "recording" | "baseline_rerun";
}

async function runJob(plan: (recordingId: string, repeatIndex: number) => AttemptPlan, settings: JobSettings = {}) {
  const jobSettings = { repeats: 3, aggregate: "all" as const, ...settings };
  const recordings = new Map(["rec_a", "rec_b", "rec_c"].map((id) => [id, recordingFor(id)]));
  const svc = new EvalService(store, async () => ({ output: null }), judgeCall, { replay: replayDeps(recordings, plan) });
  const set = (await svc.createDataset({ name: "golden", workflowId: "wf" }))!;
  for (const recording of recordings.values()) await svc.addGoldenRun({ datasetId: set.id, recording });
  const job = await svc.enqueueReplayJob({ datasetIds: [set.id], ...jobSettings }, { workflowId: "wf", actor });
  await svc.wait(job.id);
  const run = (await svc.getRun(job.id))!;
  expect(run.status).toBe("completed");
  return { svc, run, setId: set.id, settings: jobSettings };
}

function releaseService(loadCase: (runId: string, resultId: string) => Promise<EvalCaseDetail | null>): ReleaseService {
  const unused = () => {
    throw new Error("not used by evidenceFor");
  };
  return new ReleaseService({
    store,
    resolveVersion: unused,
    hashOf: unused,
    loadJob: unused,
    loadCase,
    recordingCreatedAt: async (id) => (await store.getReplayRecording(id))?.createdAt ?? null,
    access: unused,
    readableWorkflowIds: unused,
    audit: () => undefined,
    notify: async () => undefined,
    redact: (value) => value,
    onPublished: () => undefined,
    snapshotDraft: unused
  });
}

async function judge(job: Awaited<ReturnType<typeof runJob>>, policyInput: ReleaseGatePolicyInput, loadCase?: (runId: string, resultId: string) => Promise<EvalCaseDetail | null>) {
  const gate = {
    workflowId: "wf",
    datasetIds: [job.setId],
    candidateOptions: releaseCandidateOptionsSchema.parse(job.settings),
    enforced: false
  };
  const service = releaseService(loadCase ?? (async (runId, resultId) => await job.svc.getCase(runId, resultId)));
  const evidence = await service.evidenceFor(job.run, gate);
  const judgement = judgeReleaseGate(evidence, releaseGatePolicySchema.parse({ minCases: 1, ...policyInput }), { expected: { workflowHash: "cand-hash", datasetIds: [job.setId] } });
  return { evidence, judgement, codes: judgement.checks.map((check) => check.code) };
}

describe("replay repeats record latency and guard blocks per attempt", () => {
  it("stores every attempt's latency and new guard blocks on the case diff", async () => {
    const job = await runJob((recordingId, repeatIndex) => ({
      latencyMs: 100 + repeatIndex * 10,
      // A shadow verdict and an allow never count; a review does.
      guardAdded: recordingId === "rec_b" && repeatIndex === 1 ? [verdict("review"), verdict("block", true), verdict("allow")] : []
    }));
    const result = job.run.results.find((entry) => entry.fixtureName === "rec_b")!;
    const detail = (await job.svc.getCase(job.run.id, result.id))!;
    expect(detail.replay?.attempts?.map((attempt) => [attempt.repeatIndex, attempt.latencyMs, attempt.newGuardBlocks])).toEqual([
      [0, 100, 0],
      [1, 110, 1],
      [2, 120, 0]
    ]);
  });

  it("fails the latency limit on the one slow attempt of three", async () => {
    const job = await runJob((recordingId, repeatIndex) => ({ latencyMs: recordingId === "rec_b" && repeatIndex === 2 ? 400 : 100 }));
    const { evidence, judgement, codes } = await judge(job, { maxP95LatencyIncreasePct: 50, noNewGuardBlocks: false });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    // Each case carries its deciding repeat's pair and every repeat's own pair.
    expect(evidence.cases.map((entry) => entry.repeats?.latencyMs?.map((pair) => pair?.candidate)).sort()).toEqual([[100, 100, 100], [100, 100, 100], [100, 100, 400]]);
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(300, 6);
    expect(judgement.stats.repeatSelection?.latency).toEqual({ by: "repeat", repeat: 3 });
    expect(judgement.reasons).toEqual(["p95 latency rose 300% at repeat 3; the gate allows 50%."]);
    expect(judgement.verdict).toBe("blocked");
    expect(codes).toContain("latency");
    expect(codes).not.toContain("repeats_unchecked");
  });

  it("fails the guard limit on the one attempt of three that adds a block", async () => {
    const job = await runJob((recordingId, repeatIndex) => ({ latencyMs: 100, guardAdded: recordingId === "rec_c" && repeatIndex === 1 ? [verdict("block")] : [] }));
    const { evidence, judgement, codes } = await judge(job, { noNewGuardBlocks: true });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    expect(judgement.verdict).toBe("blocked");
    expect(judgement.stats.newGuardBlocks).toBe(1);
    expect(codes).toEqual(["guard_blocks"]);
  });

  it("passes latency and guard limits when every attempt is within them", async () => {
    const job = await runJob((_recordingId, repeatIndex) => ({ latencyMs: 100 + repeatIndex * 5 }));
    const { evidence, judgement } = await judge(job, { maxP95LatencyIncreasePct: 50, noNewGuardBlocks: true });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    expect(judgement.reasons).toEqual([]);
    expect(judgement.verdict).toBe("passed");
  });

  it("treats a result stored before attempts carried latency and guard data as unchecked, with the same refusal", async () => {
    const job = await runJob(() => ({ latencyMs: 100 }));
    // The attempts as they were stored before: cost only.
    const legacy = async (runId: string, resultId: string): Promise<EvalCaseDetail | null> => {
      const detail = await job.svc.getCase(runId, resultId);
      if (!detail?.replay?.attempts) return detail;
      const attempts = detail.replay.attempts.map(({ latencyMs: _latency, newGuardBlocks: _guard, ...rest }) => rest);
      return { ...detail, replay: { ...detail.replay, attempts } };
    };
    for (const policy of [{ maxP95LatencyIncreasePct: 50, noNewGuardBlocks: false }, { noNewGuardBlocks: true }]) {
      const { evidence, judgement, codes } = await judge(job, policy, legacy);
      expect(evidence.job.repeatsUnchecked).toBe(true);
      expect(evidence.job.repeatsUncheckedLimits).toEqual(["guard", "latency"]);
      expect(judgement.verdict).toBe("blocked");
      expect(codes).toEqual(["repeats_unchecked"]);
      // The refusal names only the limit the policy has.
      expect(judgement.reasons.join()).toMatch(
        policy.maxP95LatencyIncreasePct !== undefined
          ? /checks latency limits per run, .* recorded latency for only one repeat \(it ran before replays recorded every repeat\): run the gate again, or remove that limit/
          : /checks guard limits per run, .* recorded guard verdicts for only one repeat \(it ran before replays recorded every repeat\): run the gate again, or remove that limit/
      );
    }
    const both = await judge(job, { maxP95LatencyIncreasePct: 50, noNewGuardBlocks: true }, legacy);
    expect(both.judgement.reasons.join()).toMatch(/checks latency and guard limits per run, .* recorded them for only one repeat .*: run the gate again, or remove those limits/);
    // A cost-only gate never needed them.
    expect((await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, legacy)).judgement.verdict).toBe("passed");
  });
});

describe("baseline reruns with repeats: each repeat is judged against its own baseline", () => {
  const rerun = { repeats: 3, compare: "baseline_rerun" } as const;

  it("records each repeat's own baseline latency and cost beside its candidate figures", async () => {
    const job = await runJob((_recordingId, repeatIndex) => ({ latencyMs: 1050 + repeatIndex, baselineLatencyMs: 1000 + repeatIndex, costUsd: 0.02, baselineCostUsd: 0.01 + repeatIndex / 1000 }), rerun);
    const result = job.run.results.find((entry) => entry.fixtureName === "rec_a")!;
    const detail = (await job.svc.getCase(job.run.id, result.id))!;
    expect(detail.replay?.attempts?.map((attempt) => [attempt.latencyMs, attempt.baselineLatencyMs, attempt.candidateCostUsd, attempt.baselineCostUsd])).toEqual([
      [1050, 1000, 0.02, 0.01],
      [1051, 1001, 0.02, 0.011],
      [1052, 1002, 0.02, 0.012]
    ]);
  });

  it("passes a 10% limit when every repeat is 5% above its own baseline, even when one repeat ran slow for both", async () => {
    // Repeat 2 hit a slow provider for the baseline and the candidate alike.
    const job = await runJob(
      (_recordingId, repeatIndex) =>
        repeatIndex === 1
          ? { baselineLatencyMs: 3000, latencyMs: 3150, baselineCostUsd: 0.03, costUsd: 0.0315 }
          : { baselineLatencyMs: 1000, latencyMs: 1050, baselineCostUsd: 0.01, costUsd: 0.0105 },
      rerun
    );
    const { evidence, judgement } = await judge(job, { maxP95LatencyIncreasePct: 10, maxCostIncreasePct: 10, noNewGuardBlocks: true });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    // Each case counts at one repeat's own pair, never one repeat's candidate against another's baseline.
    for (const entry of evidence.cases) expect((entry.latencyMs.candidate! - entry.latencyMs.baseline!) / entry.latencyMs.baseline!).toBeCloseTo(0.05, 6);
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(5, 6);
    expect(judgement.stats.costIncreasePct).toBeCloseTo(5, 6);
    expect(judgement.reasons).toEqual([]);
    expect(judgement.verdict).toBe("passed");
  });

  it("fails a 10% limit on the one repeat that is 50% above its own baseline", async () => {
    // rec_b's other repeats are slower in absolute terms (2100 ms) but only 5% above their own baseline.
    const job = await runJob(
      (recordingId, repeatIndex) =>
        recordingId !== "rec_b" ? { baselineLatencyMs: 1000, latencyMs: 1050 } : repeatIndex === 2 ? { baselineLatencyMs: 1000, latencyMs: 1500 } : { baselineLatencyMs: 2000, latencyMs: 2100 },
      rerun
    );
    const { evidence, judgement, codes } = await judge(job, { maxP95LatencyIncreasePct: 10, noNewGuardBlocks: false });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    const slow = evidence.cases.find((entry) => entry.repeats?.latencyMs?.some((pair) => pair?.candidate === 1500))!;
    expect(slow.repeats?.latencyMs?.[2]).toEqual({ baseline: 1000, candidate: 1500 });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(judgement.verdict).toBe("blocked");
    expect(codes).toEqual(["latency"]);
  });

  it("fails a cost limit on the one repeat whose cost rose 50% over its own baseline", async () => {
    const job = await runJob((recordingId, repeatIndex) => ({ latencyMs: 100, baselineCostUsd: 0.02, costUsd: recordingId === "rec_a" && repeatIndex === 0 ? 0.03 : 0.02 }), rerun);
    const { judgement, codes } = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false });
    expect(judgement.verdict).toBe("blocked");
    expect(codes).toEqual(["cost"]);
  });

  it("checks a majority case with one inconclusive baseline rerun on the repeats whose candidate ran", async () => {
    const job = await runJob((recordingId, repeatIndex) => ({ latencyMs: 105, baselineLatencyMs: 100, baselineError: recordingId === "rec_a" && repeatIndex === 0 }), { ...rerun, aggregate: "majority" });
    const result = job.run.results.find((entry) => entry.fixtureName === "rec_a")!;
    const detail = (await job.svc.getCase(job.run.id, result.id))!;
    expect(detail.replay?.attempts?.[0]).toMatchObject({ executionId: null, latencyMs: null, baselineLatencyMs: null, newGuardBlocks: null });
    const { evidence, judgement } = await judge(job, { maxP95LatencyIncreasePct: 10, noNewGuardBlocks: true });
    expect(evidence.job.repeatsUnchecked).toBeUndefined();
    expect(evidence.cases.find((entry) => entry.id === result.fixtureId)?.status).toBe("pass");
    expect(judgement.verdict).toBe("passed");
    // The inconclusive repeat keeps its slot, so index k stays repeat k: the first is empty, the second is repeat 2's pair.
    const latency = evidence.cases.find((entry) => entry.id === result.fixtureId)?.repeats?.latencyMs;
    expect(latency?.[0]).toBeNull();
    expect(latency?.[1]).toEqual({ baseline: 100, candidate: 105 });
    expect(latency).toHaveLength(3);
  });

  it("merges several result rows of one case position by position, at the worst pair of each repeat", async () => {
    const job = await runJob(() => ({ latencyMs: 100 }), { repeats: 2 });
    const original = job.run.results.find((entry) => entry.fixtureName === "rec_a")!;
    const extra = { ...original, id: "extra-row" };
    // The second row's repeat 2 ran slow.
    const slower = async (runId: string, resultId: string): Promise<EvalCaseDetail | null> => {
      const detail = await job.svc.getCase(runId, resultId === "extra-row" ? original.id : resultId);
      if (resultId !== "extra-row" || !detail?.replay?.attempts) return detail;
      return { ...detail, replay: { ...detail.replay, attempts: detail.replay.attempts.map((attempt) => (attempt.repeatIndex === 1 ? { ...attempt, latencyMs: 300 } : attempt)) } };
    };
    const withExtra = { ...job, run: { ...job.run, results: [...job.run.results, extra] } };
    const { evidence } = await judge(withExtra, { maxP95LatencyIncreasePct: 50, noNewGuardBlocks: false }, slower);
    const merged = evidence.cases.find((entry) => entry.id === original.fixtureId);
    expect(merged?.repeats?.latencyMs).toEqual([
      { baseline: 100, candidate: 100 },
      { baseline: 100, candidate: 300 }
    ]);
  });

  it("treats repeats stored without their own baseline as unchecked for latency, and judges cost on the deciding repeat", async () => {
    const job = await runJob((_recordingId, repeatIndex) => ({ latencyMs: 1050, baselineLatencyMs: 1000, costUsd: repeatIndex === 1 ? 0.03 : 0.0105, baselineCostUsd: repeatIndex === 1 ? 0.03 : 0.01 }), rerun);
    // Attempts as stored before they carried their baseline's figures.
    const legacy = async (runId: string, resultId: string): Promise<EvalCaseDetail | null> => {
      const detail = await job.svc.getCase(runId, resultId);
      if (!detail?.replay?.attempts) return detail;
      const attempts = detail.replay.attempts.map(({ baselineLatencyMs: _latency, baselineCostUsd: _cost, ...rest }) => rest);
      return { ...detail, replay: { ...detail.replay, attempts } };
    };
    const latency = await judge(job, { maxP95LatencyIncreasePct: 10, noNewGuardBlocks: false }, legacy);
    expect(latency.evidence.job.repeatsUnchecked).toBe(true);
    expect(latency.evidence.job.repeatsUncheckedLimits).toEqual(["latency"]);
    expect(latency.codes).toEqual(["repeats_unchecked"]);
    // Every repeat's guard verdicts were recorded, so a guard-only gate (the default) checks them.
    const guardOnly = await judge(job, { noNewGuardBlocks: true }, legacy);
    expect(guardOnly.codes).toEqual([]);
    expect(guardOnly.judgement.verdict).toBe("passed");
    expect(latency.judgement.reasons.join()).toMatch(/checks latency limits per run, .*: run the gate again, or remove that limit\./);
    // Cost: the deciding repeat's own pair (+5%), never a repeat's candidate against another repeat's baseline (+200%).
    const cost = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, legacy);
    expect(cost.judgement.stats.costIncreasePct).toBeCloseTo(5, 6);
    expect(cost.judgement.verdict).toBe("passed");
  });
});

describe("repeats: cost is compared like with like, and the worst repeat adds the most", () => {
  for (const compare of ["recording", "baseline_rerun"] as const) {
    it(`gives an LLM-judged job the same cost verdict with repeats 1, 2 and 3 (compare: ${compare})`, async () => {
      for (const repeats of [1, 2, 3]) {
        // The candidate's model cost equals its baseline's; only the judge calls cost extra.
        const job = await runJob(() => ({ latencyMs: 100, baselineLatencyMs: 100, costUsd: 0.01, baselineCostUsd: 0.01 }), { repeats, compare, scorers: judgeScorers });
        const { evidence, judgement } = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false });
        expect(evidence.cases.map((entry) => entry.costUsd)).toEqual([0.01, 0.01, 0.01].map((usd) => ({ baseline: usd, candidate: usd })));
        expect(judgement.stats.costIncreasePct).toBe(0);
        expect(judgement.verdict).toBe("passed");
        if (repeats > 1) {
          const result = job.run.results.find((entry) => entry.fixtureName === "rec_a")!;
          const attempt = (await job.svc.getCase(job.run.id, result.id))!.replay!.attempts![0]!;
          // The repeat's spend includes its judge call; the gate compares its model cost.
          expect(attempt.costUsd).toBeCloseTo(0.01 + JUDGE_COST_USD, 9);
          expect(attempt.candidateCostUsd).toBe(0.01);
        }
      }
    });
  }

  it("judges attempts stored before they carried their model cost on the deciding repeat's own pair", async () => {
    const job = await runJob((_recordingId, repeatIndex) => ({ latencyMs: 100, costUsd: repeatIndex === 1 ? 0.012 : 0.01 }), { repeats: 2, scorers: judgeScorers });
    const legacy = async (runId: string, resultId: string): Promise<EvalCaseDetail | null> => {
      const detail = await job.svc.getCase(runId, resultId);
      if (!detail?.replay?.attempts) return detail;
      return { ...detail, replay: { ...detail.replay, attempts: detail.replay.attempts.map(({ candidateCostUsd: _cost, ...rest }) => rest) } };
    };
    const { evidence, judgement } = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, legacy);
    // Never the judge-inclusive spend (0.015, 0.017) against the model-only baseline.
    expect(evidence.cases.map((entry) => entry.costUsd)).toEqual([0.01, 0.01, 0.01].map((usd) => ({ baseline: usd, candidate: usd })));
    expect(judgement.verdict).toBe("passed");
  });

  for (const slowFirst of [true, false]) {
    it(`blocks on a slow, expensive repeat that a small high-ratio repeat would hide (slow repeat ${slowFirst ? "deciding" : "second"})`, async () => {
      // rec_a: one repeat adds 2700 ms and $0.009 over its own baseline (+90%), the other 100 ms and $0.001 (+100%).
      const big = { baselineLatencyMs: 3000, latencyMs: 5700, baselineCostUsd: 0.01, costUsd: 0.019 };
      const small = { baselineLatencyMs: 100, latencyMs: 200, baselineCostUsd: 0.001, costUsd: 0.002 };
      const flat = { baselineLatencyMs: 1000, latencyMs: 1000, baselineCostUsd: 0.01, costUsd: 0.01 };
      const job = await runJob((recordingId, repeatIndex) => (recordingId !== "rec_a" ? flat : (repeatIndex === 0) === slowFirst ? big : small), { repeats: 2, compare: "baseline_rerun" });
      const { evidence, judgement, codes } = await judge(job, { maxCostIncreasePct: 5, maxP95LatencyIncreasePct: 50, noNewGuardBlocks: false });
      const caseA = evidence.cases.find((entry) => entry.repeats?.latencyMs?.some((pair) => pair?.baseline === 3000))!;
      expect(caseA.repeats?.latencyMs?.[slowFirst ? 0 : 1]).toEqual({ baseline: 3000, candidate: 5700 });
      expect(caseA.repeats?.costUsd?.[slowFirst ? 0 : 1]).toEqual({ baseline: 0.01, candidate: 0.019 });
      expect(judgement.stats.costIncreasePct).toBeCloseTo(30, 6);
      expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(90, 6);
      expect(judgement.verdict).toBe("blocked");
      expect(codes.sort()).toEqual(["cost", "latency"]);
    });
  }

  it("still passes when every repeat is 5% above its own baseline, whatever their sizes", async () => {
    const job = await runJob(
      (_recordingId, repeatIndex) => [
        { baselineLatencyMs: 100, latencyMs: 105, baselineCostUsd: 0.001, costUsd: 0.00105 },
        { baselineLatencyMs: 3000, latencyMs: 3150, baselineCostUsd: 0.03, costUsd: 0.0315 },
        { baselineLatencyMs: 1000, latencyMs: 1050, baselineCostUsd: 0.01, costUsd: 0.0105 }
      ][repeatIndex]!,
      { repeats: 3, compare: "baseline_rerun" }
    );
    const { judgement } = await judge(job, { maxCostIncreasePct: 10, maxP95LatencyIncreasePct: 10, noNewGuardBlocks: true });
    expect(judgement.stats.costIncreasePct).toBeCloseTo(5, 6);
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(5, 6);
    expect(judgement.verdict).toBe("passed");
  });

  it("never pairs one repeat's candidate with another repeat's baseline when no repeat has both", async () => {
    const job = await runJob(
      (_recordingId, repeatIndex) =>
        repeatIndex === 0 ? { baselineLatencyMs: 1000, latencyMs: 1050, baselineCostUsd: 0.01, costUsd: 0.0105 } : { baselineLatencyMs: 3000, latencyMs: 3150, baselineCostUsd: 0.03, costUsd: 0.0315 },
      { repeats: 2, compare: "baseline_rerun" }
    );
    // Repeat 1 lost its baseline figures, repeat 2 its candidate figures.
    const torn = async (runId: string, resultId: string): Promise<EvalCaseDetail | null> => {
      const detail = await job.svc.getCase(runId, resultId);
      if (!detail?.replay?.attempts) return detail;
      const attempts = detail.replay.attempts.map((attempt) =>
        attempt.repeatIndex === 0 ? { ...attempt, baselineCostUsd: null, baselineLatencyMs: null } : { ...attempt, candidateCostUsd: null, latencyMs: null }
      );
      return { ...detail, replay: { ...detail.replay, attempts } };
    };
    const cost = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, torn);
    // Cost: the deciding repeat's own pair from the case diff (+5%), not 0.0105 against 0.03.
    expect(cost.evidence.cases.map((entry) => entry.costUsd)).toEqual([0, 1, 2].map(() => ({ baseline: 0.01, candidate: 0.0105 })));
    expect(cost.judgement.verdict).toBe("passed");
    // Latency: unchecked, with the same refusal; guard verdicts were recorded and stay checked.
    const latency = await judge(job, { maxP95LatencyIncreasePct: 10, noNewGuardBlocks: true }, torn);
    expect(latency.evidence.job.repeatsUncheckedLimits).toEqual(["latency"]);
    expect(latency.codes).toEqual(["repeats_unchecked"]);
    expect((await judge(job, { noNewGuardBlocks: true }, torn)).judgement.verdict).toBe("passed");
  });
});

describe("repeats: the gate is never more lenient than the deciding repeats", () => {
  const rerun = { repeats: 2, compare: "baseline_rerun" } as const;
  const flat = { baselineLatencyMs: 1000, latencyMs: 1000, baselineCostUsd: 0.01, costUsd: 0.01 };

  it("blocks a 30% p95 limit at the deciding repeat's +50% when a larger repeat of the same case rose 20%", async () => {
    // rec_a: the deciding repeat 1000 → 1500 ms (+50%), the other 3000 → 3600 ms (adds more time, but +20%).
    const job = await runJob((recordingId, repeatIndex) => (recordingId !== "rec_a" ? flat : repeatIndex === 0 ? { ...flat, latencyMs: 1500 } : { ...flat, baselineLatencyMs: 3000, latencyMs: 3600 }), rerun);
    const { judgement, codes } = await judge(job, { maxP95LatencyIncreasePct: 30, noNewGuardBlocks: false });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(judgement.stats.repeatSelection?.latency).toEqual({ by: "deciding" });
    expect(judgement.reasons).toEqual(["p95 latency rose 50%; the gate allows 30%."]);
    expect(codes).toEqual(["latency"]);
  });

  it("blocks the same shape when the +50% repeat is not the deciding one, and names it", async () => {
    const job = await runJob((recordingId, repeatIndex) => (recordingId !== "rec_a" ? flat : repeatIndex === 1 ? { ...flat, latencyMs: 1500 } : { ...flat, baselineLatencyMs: 3000, latencyMs: 3600 }), rerun);
    const { judgement } = await judge(job, { maxP95LatencyIncreasePct: 30, noNewGuardBlocks: false });
    expect(judgement.stats.p95LatencyIncreasePct).toBeCloseTo(50, 6);
    expect(judgement.reasons).toEqual(["p95 latency rose 50% at repeat 2; the gate allows 30%."]);
  });

  it("blocks a 10% cost limit at the deciding repeat's figure when a far larger repeat rose 1%", async () => {
    // rec_a: the deciding repeat $0.001 → $0.01, the other $1.00 → $1.01.
    const job = await runJob((recordingId, repeatIndex) => (recordingId !== "rec_a" ? flat : repeatIndex === 0 ? { ...flat, baselineCostUsd: 0.001, costUsd: 0.01 } : { ...flat, baselineCostUsd: 1, costUsd: 1.01 }), rerun);
    const { judgement, codes } = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false });
    // ($0.03 − $0.021) / $0.021, as a single repeat judges it.
    expect(judgement.stats.costIncreasePct).toBeCloseTo((0.009 / 0.021) * 100, 6);
    expect(judgement.stats.repeatSelection?.cost).toEqual({ by: "deciding" });
    expect(codes).toEqual(["cost"]);
  });

  it("never passes where judging the deciding repeats alone blocks (seeded random repeat sets)", async () => {
    // A small deterministic generator (mulberry32): a failure reproduces from its seed.
    const random = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rank = (value: number | null) => value ?? Number.NEGATIVE_INFINITY;
    let stricter = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const next = random(seed);
      const compare = seed % 3 === 0 ? ("recording" as const) : ("baseline_rerun" as const);
      const repeats = 2 + (seed % 2);
      const plans = new Map<string, AttemptPlan>();
      for (const recordingId of ["rec_a", "rec_b", "rec_c"]) {
        for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
          const baselineLatencyMs = Math.round(100 + next() * 4900);
          const baselineCostUsd = Math.round((0.001 + next() * 0.05) * 1e6) / 1e6;
          plans.set(`${recordingId}:${repeatIndex}`, {
            baselineLatencyMs,
            baselineCostUsd,
            // Against the recording (100 ms, $0.01) or this repeat's own baseline.
            latencyMs: Math.round((compare === "recording" ? RECORDED_LATENCY_MS : baselineLatencyMs) * (0.7 + next() * 1.2)),
            costUsd: Math.round((compare === "recording" ? 0.01 : baselineCostUsd) * (0.7 + next() * 1.2) * 1e6) / 1e6
          });
        }
      }
      const job = await runJob((recordingId, repeatIndex) => plans.get(`${recordingId}:${repeatIndex}`)!, { repeats, compare });
      const policyInput = { maxCostIncreasePct: Math.floor(next() * 60), maxP95LatencyIncreasePct: Math.floor(next() * 60), noNewGuardBlocks: false };
      const { evidence, judgement } = await judge(job, policyInput);
      expect(evidence.cases.every((entry) => entry.repeats?.costUsd?.length === repeats && entry.repeats?.latencyMs?.length === repeats), `seed ${seed}`).toBe(true);
      const decidingOnly = judgeReleaseGate(
        { ...evidence, cases: evidence.cases.map(({ repeats: _repeats, ...rest }) => rest) },
        releaseGatePolicySchema.parse({ minCases: 1, ...policyInput }),
        { expected: { workflowHash: "cand-hash", datasetIds: [job.setId] } }
      );
      expect(rank(judgement.stats.costIncreasePct), `seed ${seed} cost`).toBeGreaterThanOrEqual(rank(decidingOnly.stats.costIncreasePct));
      expect(rank(judgement.stats.p95LatencyIncreasePct), `seed ${seed} latency`).toBeGreaterThanOrEqual(rank(decidingOnly.stats.p95LatencyIncreasePct));
      if (decidingOnly.verdict === "blocked") expect(judgement.verdict, `seed ${seed}`).toBe("blocked");
      if (judgement.verdict === "blocked" && decidingOnly.verdict === "passed") stricter += 1;
    }
    expect(stricter).toBeGreaterThan(0);
  }, 60_000);
});
