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

function facts(output: unknown, durationMs: number): RunFacts {
  return {
    status: "success",
    error: null,
    output,
    nodes: [],
    toolCalls: [],
    modelCalls: [],
    guard: [],
    totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, durationMs, modelCalls: 1, toolCalls: 0 }
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

/** What one replayed attempt measured: its latency and the guard verdicts it added against the recording. */
interface AttemptPlan {
  latencyMs: number;
  guardAdded?: RunFactGuardVerdict[];
}

function delta(baseline: number, candidate: number) {
  return { baseline, candidate, delta: candidate - baseline, pct: baseline === 0 ? null : ((candidate - baseline) / baseline) * 100 };
}

/** Replays answer from `plan(recordingId, repeatIndex)`: the diff carries the planned latency and guard verdicts. */
function replayDeps(recordings: Map<string, ReplayRecordingRecord>, plan: (recordingId: string, repeatIndex: number) => AttemptPlan): EvalReplayDeps {
  return {
    resolveCandidate: async (workflowId, request) => ({ workflow: (await store.getWorkflow(workflowId))!, kind: request.version ? "version" : "draft", version: request.version ?? null, workflowHash: "cand-hash" }),
    getRecording: async (id) => recordings.get(id) ?? null,
    replayCase: async ({ recording, executionId, repeatIndex }) => {
      const attempt = plan(recording.id, repeatIndex ?? 0);
      const diff = {
        health: [],
        totals: { tokens: delta(15, 15), costUsd: delta(0.01, 0.01), latencyMs: delta(RECORDED_LATENCY_MS, attempt.latencyMs), toolCalls: delta(0, 0) },
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
        facts: facts(recording.facts.output, attempt.latencyMs)
      } satisfies ReplayRunResponse;
    },
    actorFor: async (_userId, email) => ({ id: "u1", email, role: "builder" })
  };
}

async function runJob(plan: (recordingId: string, repeatIndex: number) => AttemptPlan, repeats = 3) {
  const recordings = new Map(["rec_a", "rec_b", "rec_c"].map((id) => [id, recordingFor(id)]));
  const svc = new EvalService(store, async () => ({ output: null }), undefined, { replay: replayDeps(recordings, plan) });
  const set = (await svc.createDataset({ name: "golden", workflowId: "wf" }))!;
  for (const recording of recordings.values()) await svc.addGoldenRun({ datasetId: set.id, recording });
  const job = await svc.enqueueReplayJob({ datasetIds: [set.id], repeats, aggregate: "all" }, { workflowId: "wf", actor });
  await svc.wait(job.id);
  const run = (await svc.getRun(job.id))!;
  expect(run.status).toBe("completed");
  return { svc, run, setId: set.id };
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
    candidateOptions: releaseCandidateOptionsSchema.parse({ repeats: 3, aggregate: "all" }),
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
      expect(judgement.reasons.join()).toMatch(/recorded them for only one repeat: run the gate's suite with repeats 1, or remove those limits/);
    }
    // A cost-only gate never needed them.
    expect((await judge(job, { maxCostIncreasePct: 10, noNewGuardBlocks: false }, legacy)).judgement.verdict).toBe("passed");
  });
});
