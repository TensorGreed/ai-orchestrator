/**
 * Phase 15.2 — the background runner shared by eval runs and replay jobs:
 * the concurrency cap, progress, cancel, the budget stop, skipped
 * hand-written cases, interrupted-on-restart and shutdown.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplayRunResponse, RunFacts, Workflow } from "@ai-orchestrator/shared";
import { SqliteStore, type ReplayRecordingRecord } from "../db/database.js";
import { EVAL_RUN_STALE_MS, EvalService, type EvalReplayDeps, type EvalWorkflowExecutor } from "./eval-service.js";

let tempDir: string;
let store: SqliteStore;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-eval-runner-"));
  store = await SqliteStore.create(path.join(tempDir, "orchestrator.db"));
  store.ensureDefaultProject();
  store.upsertWorkflow({ id: "wf", name: "WF", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as Workflow);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Already closed.
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function datasetWith(svc: EvalService, count: number, extra: { workflowId?: string } = {}) {
  const dataset = svc.createDataset({ name: "set", ...extra })!;
  for (let index = 0; index < count; index += 1) svc.addFixture({ datasetId: dataset.id, name: `case-${index}`, input: { n: index }, expected: { n: index } });
  return dataset;
}

function facts(output: unknown, costUsd: number | null = 0.01): RunFacts {
  return {
    status: "success",
    error: null,
    output,
    nodes: [],
    toolCalls: [],
    modelCalls: [],
    guard: [],
    totals: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd, durationMs: 20, modelCalls: 1, toolCalls: 0 }
  };
}

describe("eval runs in the background", () => {
  it("caps cases running at once across runs and reports progress after each case", async () => {
    let running = 0;
    let peak = 0;
    const executor: EvalWorkflowExecutor = async (input) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(15);
      running -= 1;
      return { executionId: input.executionId, output: input.fixtureInput };
    };
    const svc = new EvalService(store, executor, undefined, { concurrency: 2 });
    const a = datasetWith(svc, 4);
    const b = datasetWith(svc, 3);
    const first = svc.enqueueRun({ datasetId: a.id, workflowId: "wf" });
    const second = svc.enqueueRun({ datasetId: b.id, workflowId: "wf" });
    expect(first.status).toBe("queued");
    expect(first.kind).toBe("eval");
    expect(first.progress).toMatchObject({ total: 4, done: 0 });
    const seen: number[] = [];
    svc.subscribe(first.id, (run) => seen.push(run.progress?.done ?? -1));
    await Promise.all([svc.wait(first.id), svc.wait(second.id)]);
    expect(peak).toBe(2);
    expect(seen).toEqual([1, 2, 3, 4, 4]);
    const done = svc.getRun(first.id)!;
    expect(done.status).toBe("completed");
    expect(done.summary).toMatchObject({ total: 4, pass: 4, fail: 0, error: 0, passRate: 1 });
    expect(done.progress).toMatchObject({ total: 4, done: 4, running: 0, pass: 4 });
    expect(done.results).toHaveLength(4);
    expect(svc.getRun(second.id)!.summary).toMatchObject({ total: 3, pass: 3 });
  });

  it("rejects a dataset over the case limit", () => {
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { maxCases: 2 });
    const dataset = datasetWith(svc, 3);
    expect(() => svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf" })).toThrow(/at most 2/);
  });

  it("cancels: queued cases never start and running executions are aborted", async () => {
    const gate = deferred();
    const started: string[] = [];
    const aborted: string[] = [];
    const executor: EvalWorkflowExecutor = async (input) => {
      started.push(input.fixtureName);
      await gate.promise;
      return { executionId: input.executionId, output: input.fixtureInput };
    };
    const svc = new EvalService(store, executor, undefined, { concurrency: 1, abortExecution: (id) => aborted.push(id) });
    const dataset = datasetWith(svc, 3);
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf" });
    await sleep(5);
    expect(svc.getRunView(run.id)!.status).toBe("running");
    const canceled = svc.cancel(run.id)!;
    expect(canceled.status).toBe("canceled");
    expect(aborted).toHaveLength(1);
    gate.resolve();
    await svc.wait(run.id);
    expect(started).toEqual(["case-0"]);
    const after = svc.getRun(run.id)!;
    expect(after.status).toBe("canceled");
    expect(after.results).toHaveLength(1);
    expect(after.summary).toMatchObject({ total: 3, pass: 1 });
    // A finished run is returned as it is.
    expect(svc.cancel(run.id)!.status).toBe("canceled");
    expect(svc.cancel("run_missing")).toBeNull();
  });

  it("marks runs a stopped server left behind as interrupted, and only stale ones with several instances", () => {
    let now = new Date("2026-10-23T10:00:00Z");
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { now: () => now });
    store.createEvalRun({ id: "run_old", datasetId: "ds", workflowId: "wf", status: "running", progress: { updatedAt: "2026-10-23T09:00:00Z" } });
    store.createEvalRun({ id: "run_fresh", datasetId: "ds", workflowId: "wf", status: "running", progress: { updatedAt: "2026-10-23T09:59:00Z" } });
    store.createEvalRun({ id: "run_queued", datasetId: "ds", workflowId: "wf", status: "queued", progress: { updatedAt: "2026-10-23T09:59:30Z" } });
    expect(svc.recoverInterrupted({ onlyStale: true })).toBe(1);
    expect(store.getEvalRun("run_old")!.status).toBe("interrupted");
    expect(store.getEvalRun("run_fresh")!.status).toBe("running");
    now = new Date(now.getTime() + EVAL_RUN_STALE_MS);
    expect(svc.recoverInterrupted({ onlyStale: true })).toBe(2);
    store.createEvalRun({ id: "run_again", datasetId: "ds", workflowId: "wf", status: "running" });
    expect(svc.recoverInterrupted()).toBe(1);
    expect(store.getEvalRun("run_again")).toMatchObject({ status: "interrupted", error: expect.stringContaining("server stopped") });
  });

  it("marks its own runs interrupted on shutdown", async () => {
    const gate = deferred();
    const svc = new EvalService(store, async (input) => {
      await gate.promise;
      return { executionId: input.executionId, output: null };
    });
    const dataset = datasetWith(svc, 2);
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf" });
    await sleep(5);
    svc.shutdown();
    gate.resolve();
    await svc.wait(run.id);
    expect(svc.getRunView(run.id)!.status).toBe("interrupted");
  });

  it("startRun still waits and returns the summary", async () => {
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: input.fixtureInput }));
    const dataset = datasetWith(svc, 2);
    const result = await svc.startRun({ datasetId: dataset.id, workflowId: "wf" });
    expect(result.summary).toMatchObject({ total: 2, pass: 2 });
  });
});

describe("replay jobs", () => {
  const recordingFor = (id: string, output: unknown): ReplayRecordingRecord =>
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
      createdAt: "2026-10-23T00:00:00Z",
      createdBy: null,
      capturedWorkflow: {},
      input: { q: id },
      nodes: {},
      facts: facts(output),
      mcpCassette: null
    }) as ReplayRecordingRecord;

  function replayDeps(recordings: Map<string, ReplayRecordingRecord>, answer: (recording: ReplayRecordingRecord) => { output: unknown; verdict?: "pass" | "fail" | "error"; costUsd?: number | null }): EvalReplayDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      resolveCandidate: (workflowId, request) => ({ workflow: store.getWorkflow(workflowId)!, kind: request.version ? "version" : "draft", version: request.version ?? null, workflowHash: "cand-hash" }),
      getRecording: (id) => recordings.get(id) ?? null,
      replayCase: async ({ recording, executionId }) => {
        calls.push(recording.id);
        const result = answer(recording);
        const candidateFacts = facts(result.output, result.costUsd === undefined ? 0.01 : result.costUsd);
        return {
          recordingId: recording.id,
          executionId,
          candidate: { kind: "draft", version: null, workflowHash: "cand-hash" },
          status: "success",
          diff: { health: [] } as unknown as ReplayRunResponse["diff"],
          verdict: result.verdict ?? "pass",
          reasons: result.verdict === "error" ? ["strict cassette miss"] : [],
          facts: candidateFacts
        };
      },
      actorFor: (email) => ({ id: "u1", email, role: "builder" })
    };
  }

  it("replays every golden run, scores it against the recording, skips hand-written cases and stores the diff", async () => {
    const recordings = new Map(["rec_a", "rec_b", "rec_c"].map((id) => [id, recordingFor(id, { answer: id })]));
    const deps = replayDeps(recordings, (recording) => (recording.id === "rec_b" ? { output: { answer: "changed" } } : recording.id === "rec_c" ? { output: null, verdict: "error" } : { output: recording.facts.output }));
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { replay: deps });
    const set = svc.createDataset({ name: "golden", workflowId: "wf" })!;
    for (const recording of recordings.values()) svc.addGoldenRun({ datasetId: set.id, recording });
    svc.addFixture({ datasetId: set.id, name: "hand-written", input: {}, expected: {} });

    const job = svc.enqueueReplayJob({ datasetIds: [set.id] }, { workflowId: "wf", actor: { id: "u1", email: "b@example.com", role: "builder" } });
    expect(job).toMatchObject({ kind: "replay", status: "queued", candidate: { kind: "draft", workflowHash: "cand-hash" }, options: { mcpMode: "strict", maxCostUsd: 5 } });
    await svc.wait(job.id);
    const run = svc.getRun(job.id)!;
    expect(run.status).toBe("completed");
    expect(run.summary).toMatchObject({ total: 4, pass: 1, fail: 1, error: 1, skipped: 1, passRate: 1 / 3, costUsd: 0.03 });
    const byName = new Map(run.results.map((result) => [result.fixtureName, result]));
    expect(byName.get("rec_a")).toMatchObject({ status: "pass", verdict: "pass", recordingId: "rec_a", costUsd: 0.01 });
    const failed = byName.get("rec_b")!;
    expect(failed.status).toBe("fail");
    expect(failed.score!.details.map((detail) => detail.type)).toEqual(["status", "json_equal"]);
    expect(failed.score!.details[1]!.reason).toContain("answer changed");
    expect(byName.get("rec_c")).toMatchObject({ status: "error", error: "strict cassette miss" });
    expect(byName.get("hand-written")).toMatchObject({ status: "skipped" });
    expect(deps.calls.sort()).toEqual(["rec_a", "rec_b", "rec_c"]);
    const detail = svc.getCase(job.id, failed.id)!;
    expect(detail.replay).toMatchObject({ recordingId: "rec_b", verdict: "pass" });
    expect(detail.replay).not.toHaveProperty("facts");
  });

  it("stops scheduling cases once the budget is spent", async () => {
    const recordings = new Map(["r1", "r2", "r3"].map((id) => [id, recordingFor(id, { ok: true })]));
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { concurrency: 1, replay: replayDeps(recordings, () => ({ output: { ok: true }, costUsd: 0.6 })) });
    const set = svc.createDataset({ name: "golden", workflowId: "wf" })!;
    for (const recording of recordings.values()) svc.addGoldenRun({ datasetId: set.id, recording });
    const job = svc.enqueueReplayJob({ datasetIds: [set.id], maxCostUsd: 1 }, { workflowId: "wf", actor: { id: "u1", email: "b@example.com", role: "builder" } });
    await svc.wait(job.id);
    const run = svc.getRun(job.id)!;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Stopped after 2 of 3 cases");
    expect(run.results).toHaveLength(2);
    expect(run.progress!.spentUsd).toBe(1.2);
  });

  it("refuses sets of another workflow, sets without golden runs, and a missing candidate version", () => {
    const deps = replayDeps(new Map(), () => ({ output: null }));
    deps.resolveCandidate = (workflowId, request) => {
      if (request.version) throw new Error(`Version ${request.version} of this workflow was not found.`);
      return { workflow: store.getWorkflow(workflowId)!, kind: "draft", version: null, workflowHash: "h" };
    };
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { replay: deps });
    const actor = { id: "u1", email: "b@example.com", role: "builder" as const };
    const other = svc.createDataset({ name: "other", workflowId: "wf-other" })!;
    expect(() => svc.enqueueReplayJob({ datasetIds: [other.id] }, { workflowId: "wf", actor })).toThrow(/does not belong/);
    const empty = svc.createDataset({ name: "empty", workflowId: "wf" })!;
    svc.addFixture({ datasetId: empty.id, name: "hand", input: {} });
    expect(() => svc.enqueueReplayJob({ datasetIds: [empty.id] }, { workflowId: "wf", actor })).toThrow(/no golden runs/);
    svc.addGoldenRun({ datasetId: empty.id, recording: recordingFor("rec_x", {}) });
    expect(() => svc.enqueueReplayJob({ datasetIds: [empty.id], version: 9 }, { workflowId: "wf", actor })).toThrow(/Version 9/);
  });
});
