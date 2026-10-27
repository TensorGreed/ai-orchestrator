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

/** The job's comparison settings, which the gate's candidate options name too. */
interface JobSettings {
  repeats?: number;
  aggregate?: "all" | "majority" | "any";
  compare?: "recording" | "baseline_rerun";
}

async function runJob(plan: (recordingId: string, repeatIndex: number) => AttemptPlan, settings: JobSettings = {}) {
  const jobSettings = { repeats: 3, aggregate: "all" as const, ...settings };
  const recordings = new Map(["rec_a", "rec_b", "rec_c"].map((id) => [id, recordingFor(id)]));
  const svc = new EvalService(store, async () => ({ output: null }), undefined, { replay: replayDeps(recordings, plan) });
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
    expect(evidence.cases.map((entry) => entry.latencyMs.candidate).sort((a, b) => a! - b!)).toEqual([100, 100, 400]);
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
      expect(judgement.verdict).toBe("blocked");
      expect(codes).toEqual(["repeats_unchecked"]);
      expect(judgement.reasons.join()).toMatch(/recorded them for only one repeat \(it ran before replays recorded every repeat\): run the gate again, or remove those limits/);
    }
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
    expect(detail.replay?.attempts?.map((attempt) => [attempt.latencyMs, attempt.baselineLatencyMs, attempt.baselineCostUsd])).toEqual([
      [1050, 1000, 0.01],
      [1051, 1001, 0.011],
      [1052, 1002, 0.012]
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
    const slow = evidence.cases.find((entry) => entry.latencyMs.candidate === 1500)!;
    expect(slow.latencyMs).toEqual({ baseline: 1000, candidate: 1500 });
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
    expect(latency.codes).toEqual(["repeats_unchecked"]);
    expect(latency.judgement.reasons.join()).toMatch(/run the gate again, or remove those limits/);
    // Cost: the deciding repeat's own pair (+5%), never a repeat's candidate against another repeat's baseline (+200%).
    const cost = await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, legacy);
    expect(cost.judgement.stats.costIncreasePct).toBeCloseTo(5, 6);
    expect(cost.judgement.verdict).toBe("passed");
  });
});
