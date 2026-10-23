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
    const first = svc.enqueueRun({ datasetId: a.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    const second = svc.enqueueRun({ datasetId: b.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
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
    expect(() => svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" })).toThrow(/at most 2/);
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
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
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
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await sleep(5);
    svc.shutdown();
    gate.resolve();
    await svc.wait(run.id);
    expect(svc.getRunView(run.id)!.status).toBe("interrupted");
  });

  it("startRun still waits and returns the summary", async () => {
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: input.fixtureInput }));
    const dataset = datasetWith(svc, 2);
    const result = await svc.startRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
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
      actorFor: (_userId, email) => ({ id: "u1", email, role: "builder" })
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

  it("repeats each case, combines the repeats by the aggregate rule and flags flaky cases", async () => {
    const recordings = new Map(["rec_a"].map((id) => [id, recordingFor(id, { answer: id })]));
    let calls = 0;
    // pass, fail, pass: flaky; majority passes, all fails.
    const deps = replayDeps(recordings, (recording) => (++calls % 3 === 2 ? { output: { answer: "changed" } } : { output: recording.facts.output }));
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { replay: deps });
    const set = svc.createDataset({ name: "golden", workflowId: "wf" })!;
    svc.addGoldenRun({ datasetId: set.id, recording: recordings.get("rec_a")! });
    const actor = { id: "u1", email: "b@example.com", role: "builder" as const };
    for (const [aggregate, status] of [["majority", "pass"], ["all", "fail"], ["any", "pass"]] as const) {
      calls = 0;
      const job = svc.enqueueReplayJob({ datasetIds: [set.id], repeats: 3, aggregate }, { workflowId: "wf", actor });
      await svc.wait(job.id);
      const run = svc.getRun(job.id)!;
      expect(run.summary).toMatchObject({ total: 1, [status]: 1, flaky: 1, executions: 3 });
      expect(run.results[0]).toMatchObject({ status, repeats: { total: 3, pass: 2, fail: 1, error: 0, aggregate, flaky: true } });
      expect(run.summary!.costUsd).toBeCloseTo(0.03, 6);
    }
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

describe("review fixes: budgets, bookkeeping and storage", () => {
  const judgeSpec = { type: "llm_judge" as const, rubric: "r", providerId: "openai", model: "gpt-4o-mini" };

  it("reserves each case's worst-case judge spend, so concurrent cases never overshoot the budget on judges", async () => {
    let running = 0;
    let peak = 0;
    const judge = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(10);
      running -= 1;
      return { content: '{"score": 1}', costUsd: 0.1 };
    };
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: input.fixtureInput }), judge, {
      concurrency: 3,
      evalRunMaxCostUsd: 1,
      judgeCallCeilingUsd: () => 0.4
    });
    const dataset = svc.createDataset({ name: "set" })!;
    for (let index = 0; index < 10; index += 1) svc.addFixture({ datasetId: dataset.id, name: `case-${index}`, input: {}, scorers: [judgeSpec] });
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await svc.wait(run.id);
    const done = svc.getRun(run.id)!;
    // Two reservations of $0.40 fit in $1; a third waits for one to come back.
    expect(peak).toBe(2);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("could cost up to $0.4000");
    expect(done.progress!.spentUsd).toBeLessThanOrEqual(1);
    // Every case that started stayed within the budget with its reservation: spent + 0.4 <= 1 when it started.
    expect(done.results.length).toBe(7);
  });

  it("bounds a run's overshoot on model spend by the cases in flight", async () => {
    const recordings = new Map(["r1", "r2", "r3", "r4", "r5"].map((id) => [id, { id, workflowId: "wf", input: {}, facts: facts({ ok: true }), name: id } as unknown as ReplayRecordingRecord]));
    const replay: EvalReplayDeps = {
      resolveCandidate: (workflowId) => ({ workflow: store.getWorkflow(workflowId)!, kind: "draft", version: null, workflowHash: "h" }),
      getRecording: (id) => recordings.get(id) ?? null,
      replayCase: async ({ recording, executionId }) => {
        await sleep(10);
        return { recordingId: recording.id, executionId, candidate: { kind: "draft", version: null, workflowHash: "h" }, status: "success", diff: {} as ReplayRunResponse["diff"], verdict: "pass", reasons: [], facts: facts({ ok: true }, 0.6) };
      },
      actorFor: (_userId, email) => ({ id: "u1", email, role: "builder" })
    };
    const svc = new EvalService(store, async () => ({ output: null }), undefined, { concurrency: 3, replay });
    const set = svc.createDataset({ name: "golden", workflowId: "wf" })!;
    for (const recording of recordings.values()) svc.addGoldenRun({ datasetId: set.id, recording });
    const job = svc.enqueueReplayJob({ datasetIds: [set.id], maxCostUsd: 1 }, { workflowId: "wf", actor: { id: "u1", email: "b@example.com", role: "builder" } });
    await svc.wait(job.id);
    const run = svc.getRun(job.id)!;
    // Cases 1-3 start at $0; case 4 starts at $0.60 (under budget) while two are still in flight; then the
    // budget is spent. The overshoot is at most REPLAY_CONCURRENCY cases' model spend past the last check.
    expect(run.status).toBe("failed");
    expect(run.results).toHaveLength(4);
    expect(run.progress!.spentUsd).toBe(2.4);
    expect(run.progress!.spentUsd).toBeLessThanOrEqual(0.6 + 3 * 0.6);
  });

  it("counts an unpriced model or judge as cost unknown, with a warning on the run", async () => {
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: input.fixtureInput, facts: { ...facts({}), modelCalls: [{ nodeId: "a", iteration: null, providerId: "x", model: "y", inputTokens: 1, outputTokens: 1, costUsd: null, latencyMs: 1 }] } }), async () => ({ content: '{"score":1}', costUsd: null }), { judgeCallCeilingUsd: () => null });
    const dataset = svc.createDataset({ name: "set" })!;
    svc.addFixture({ datasetId: dataset.id, name: "a", input: {}, scorers: [judgeSpec] });
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await svc.wait(run.id);
    const done = svc.getRun(run.id)!;
    expect(done.status).toBe("completed");
    expect(done.progress!.costUnknown).toBe(true);
    expect(done.summary).toMatchObject({ costUnknown: true, warnings: [expect.stringContaining("no price")] });
    expect(done.results[0]!.score!.details[0]!.costUnknown).toBe(true);
  });

  it("gives the judge who each call is for, and caps judge calls per case across scorers", async () => {
    const contexts: unknown[] = [];
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: "x" }), async (input) => {
      contexts.push(input.context);
      return '{"score": 1}';
    });
    const dataset = svc.createDataset({ name: "set" })!;
    const many = Array.from({ length: 11 }, () => ({ ...judgeSpec, votes: 5 }));
    svc.addFixture({ datasetId: dataset.id, name: "a", input: {}, scorers: many });
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await svc.wait(run.id);
    expect(contexts).toHaveLength(50);
    expect(contexts[0]).toMatchObject({ runId: run.id, workflowId: "wf", actorEmail: "b@example.com", executionId: expect.any(String) });
    const details = svc.getRun(run.id)!.results[0]!.score!.details;
    expect(details.at(-1)!.reason).toContain("judge call limit reached (50 per case)");
  });

  it("never revives a finished run with a late progress write", () => {
    store.createEvalRun({ id: "run_done", datasetId: "ds", workflowId: "wf", status: "running" });
    store.finalizeEvalRun({ id: "run_done", status: "interrupted", error: "stopped" });
    store.updateEvalRunProgress({ id: "run_done", status: "running", progress: { done: 1 } });
    store.updateEvalRunProgress({ id: "run_done", progress: { done: 2 } });
    expect(store.getEvalRun("run_done")).toMatchObject({ status: "interrupted", progress: null });
  });

  it("settles a run whose store reads start failing, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let reads = 0;
      const flaky = new Proxy(store, {
        get(target, key, receiver) {
          if (key === "getEvalRun") {
            return (id: string) => {
              reads += 1;
              if (reads > 2) throw new Error("database is closed");
              return target.getEvalRun(id);
            };
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const warnings: string[] = [];
      const svc = new EvalService(flaky, async (input) => ({ executionId: input.executionId, output: input.fixtureInput }), undefined, { logger: { warn: (message) => warnings.push(message) } });
      const dataset = datasetWith(svc, 2);
      const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
      await svc.wait(run.id);
      await sleep(20);
      expect(svc.isActive(run.id)).toBe(false);
      expect(warnings.length).toBeGreaterThan(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("drops a run that waits for a slot when it is canceled, without starting its cases", async () => {
    const gate = deferred();
    const started: string[] = [];
    const svc = new EvalService(store, async (input) => {
      started.push(`${input.runId}:${input.fixtureName}`);
      await gate.promise;
      return { executionId: input.executionId, output: input.fixtureInput };
    }, undefined, { concurrency: 1 });
    const holder = svc.enqueueRun({ datasetId: datasetWith(svc, 1).id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    const waiting = svc.enqueueRun({ datasetId: datasetWith(svc, 2).id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await sleep(5);
    expect(svc.cancel(waiting.id)!.status).toBe("canceled");
    gate.resolve();
    await Promise.all([svc.wait(holder.id), svc.wait(waiting.id)]);
    expect(started).toEqual([`${holder.id}:case-0`]);
    expect(svc.getRun(waiting.id)).toMatchObject({ status: "canceled", results: [] });
    expect(svc.getRunView(holder.id)!.status).toBe("completed");
  });

  it("stores outputs and diffs over the size cap as truncation markers, scored on the full value, with secrets scrubbed", async () => {
    const big = { text: `${"x".repeat(5000)} the needle` };
    const svc = new EvalService(store, async (input) => ({ executionId: input.executionId, output: big, error: undefined }), undefined, {
      maxResultBytes: 1024,
      scrub: (text) => text.replaceAll("hunter2", "[secret]")
    });
    const dataset = svc.createDataset({ name: "set" })!;
    svc.addFixture({ datasetId: dataset.id, name: "a", input: {}, scorers: [{ type: "contains", path: "text", needle: "the needle" }, { type: "contains", path: "text", needle: "hunter2" }] });
    const run = svc.enqueueRun({ datasetId: dataset.id, workflowId: "wf", triggeredBy: "b@example.com", triggeredByUserId: "u1" });
    await svc.wait(run.id);
    const result = svc.getRun(run.id)!.results[0]!;
    expect(result.score!.details[0]!.pass).toBe(true);
    expect(result.output).toMatchObject({ truncated: true, maxBytes: 1024, bytes: expect.any(Number) });
    expect((result.output as { preview: string }).preview.length).toBe(2000);
    expect(result.score!.details[1]!.reason).toContain("[secret]");
    expect(result.score!.details[1]!.reason).not.toContain("hunter2");
  });

  it("prunes finished runs before the cutoff but keeps the newest run of every set", () => {
    for (const [id, datasetId, status] of [["run_a1", "ds_a", "completed"], ["run_b1", "ds_b", "completed"], ["run_a2", "ds_a", "completed"], ["run_a3", "ds_a", "running"]] as const) {
      store.createEvalRun({ id, datasetId, workflowId: "wf", status, ...(id === "run_b1" ? { kind: "replay", datasetIds: ["ds_b", "ds_a"] } : {}) });
      store.recordEvalResult({ id: `res_${id}`, runId: id, fixtureId: "f", status: "pass" });
    }
    // Everything started before the cutoff: run_a3 is ds_a's newest (and still running), run_a2 its newest finished, run_b1 ds_b's only run.
    expect(store.pruneEvalRuns({ before: "9999-01-01T00:00:00Z" })).toBe(1);
    expect(store.getEvalRun("run_a1")).toBeNull();
    expect(store.listEvalResults("run_a1")).toEqual([]);
    for (const id of ["run_a2", "run_a3", "run_b1"]) expect(store.getEvalRun(id)).not.toBeNull();
    expect(store.pruneEvalRuns({ before: "2000-01-01T00:00:00Z" })).toBe(0);
  });

  it("matches a dataset id literally when listing its runs, and pages through every interrupted run", () => {
    store.createEvalRun({ id: "run_like", datasetId: "ds_1", workflowId: "wf", kind: "replay", datasetIds: ["ds_1", "ds%"] });
    expect(store.listEvalRuns({ datasetId: "ds%" }).map((run) => run.id)).toEqual(["run_like"]);
    expect(store.listEvalRuns({ datasetId: "ds_" })).toEqual([]);
    const svc = new EvalService(store, async () => ({ output: null }));
    for (let index = 0; index < 505; index += 1) store.createEvalRun({ id: `run_q${index}`, datasetId: "ds", workflowId: "wf", status: "queued" });
    expect(svc.recoverInterrupted()).toBe(506);
  });
});
