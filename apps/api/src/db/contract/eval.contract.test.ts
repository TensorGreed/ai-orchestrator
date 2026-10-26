/**
 * Phase 13.1 — store contract: eval datasets, fixtures (golden-set cases), runs and results, on both stores.
 */
import { expect, it } from "vitest";
import { GUARD_SIMULATION_JOB_DATASET_PREFIX } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

async function seedRun(store: Store, id: string, datasetId: string, overrides: Partial<Parameters<Store["createEvalRun"]>[0]> = {}) {
  await store.createEvalRun({ id, datasetId, workflowId: "wf-1", ...overrides });
}

describeStoreContract("store contract: evals", (ctx) => {
  it("creates datasets and lists them newest first with fixture and golden counts", async () => {
    const store = ctx.store();
    // Datasets have no insert-order tie-break on SQLite, so they are created a few milliseconds apart.
    await store.createEvalDataset({ id: "ds-a", name: "A", projectId: "p1" });
    await tick();
    await store.createEvalDataset({ id: "ds-b", name: "B", description: "golden", projectId: "p1", workflowId: "wf-1", createdBy: "u1" });
    await tick();
    await store.createEvalDataset({ id: "ds-c", name: "C", projectId: "p2" });
    await store.createEvalFixture({ id: "f1", datasetId: "ds-b", name: "one", input: { q: 1 } });
    await store.createEvalFixture({ id: "f2", datasetId: "ds-b", name: "two", input: "x", recordingId: "rec-1" });

    expect((await store.listEvalDatasets()).map((d) => d.id)).toEqual(["ds-c", "ds-b", "ds-a"]);
    expect((await store.listEvalDatasets({ projectId: "p1" })).map((d) => d.id)).toEqual(["ds-b", "ds-a"]);
    expect((await store.listEvalDatasets({ workflowId: "wf-1" })).map((d) => d.id)).toEqual(["ds-b"]);
    const b = await store.getEvalDataset("ds-b");
    expect(b).toEqual({
      id: "ds-b",
      name: "B",
      description: "golden",
      projectId: "p1",
      workflowId: "wf-1",
      createdBy: "u1",
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO),
      fixtureCount: 2,
      goldenRunCount: 1
    });
    const a = await store.getEvalDataset("ds-a");
    expect(a).toMatchObject({ description: null, workflowId: null, createdBy: null, fixtureCount: 0, goldenRunCount: 0 });
    expect(await store.getEvalDataset("missing")).toBeNull();
  });

  it("stores fixtures with JSON fields, keeps insert order, and finds one by recording", async () => {
    const store = ctx.store();
    await store.createEvalDataset({ id: "ds", name: "D" });
    for (let index = 0; index < 5; index += 1) {
      await store.createEvalFixture({ id: `f${index}`, datasetId: "ds", name: `n${index}`, input: { index } });
    }
    await store.createEvalFixture({
      id: "fx",
      datasetId: "ds",
      name: "full",
      input: null,
      expected: { answer: 42 },
      scorers: [{ type: "contains", value: "x" }],
      recordingId: "rec-9"
    });
    await store.createEvalFixture({ id: "fe", datasetId: "ds", name: "empty scorers", input: 1, scorers: [] });
    const list = await store.listEvalFixtures("ds");
    expect(list.map((f) => f.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "fx", "fe"]);
    const fx = await store.getEvalFixture("fx");
    expect(fx).toEqual({
      id: "fx",
      datasetId: "ds",
      name: "full",
      input: null,
      expected: { answer: 42 },
      scorers: [{ type: "contains", value: "x" }],
      recordingId: "rec-9",
      required: false,
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO)
    });
    expect(await store.getEvalFixture("f0")).toMatchObject({ input: { index: 0 }, expected: null, scorers: null, recordingId: null });
    expect((await store.getEvalFixture("fe"))?.scorers).toBeNull();
    expect((await store.findEvalFixtureByRecording("ds", "rec-9"))?.id).toBe("fx");
    expect(await store.findEvalFixtureByRecording("other", "rec-9")).toBeNull();
    expect(await store.getEvalFixtureDatasetId("fx")).toBe("ds");
    expect(await store.getEvalFixtureDatasetId("nope")).toBeNull();
    expect(await store.evalFixtureIdsForRecording("rec-9")).toEqual(["fx"]);
    expect(await store.getEvalFixture("missing")).toBeNull();
  });

  it("marks a fixture required and deletes fixtures once", async () => {
    const store = ctx.store();
    await store.createEvalDataset({ id: "ds", name: "D" });
    await store.createEvalFixture({ id: "f1", datasetId: "ds", name: "a", input: 1, recordingId: "rec" });
    await store.createEvalFixture({ id: "f2", datasetId: "ds", name: "b", input: 1, recordingId: "rec" });
    await store.createEvalFixture({ id: "f3", datasetId: "ds", name: "c", input: 1 });
    expect(await store.setEvalFixtureRequired("f1", true)).toBe(true);
    expect((await store.getEvalFixture("f1"))?.required).toBe(true);
    expect(await store.setEvalFixtureRequired("f1", false)).toBe(true);
    expect((await store.getEvalFixture("f1"))?.required).toBe(false);
    expect(await store.setEvalFixtureRequired("missing", true)).toBe(false);
    expect(await store.deleteEvalFixture("f3")).toBe(true);
    expect(await store.deleteEvalFixture("f3")).toBe(false);
    expect(await store.deleteEvalFixturesForRecording("rec")).toBe(2);
    expect(await store.deleteEvalFixturesForRecording("rec")).toBe(0);
    expect(await store.listEvalFixtures("ds")).toEqual([]);
  });

  it("creates a run with defaults and reads every field back", async () => {
    const store = ctx.store();
    await seedRun(store, "r-min", "ds");
    expect(await store.getEvalRun("r-min")).toEqual({
      id: "r-min",
      kind: "eval",
      datasetId: "ds",
      datasetIds: ["ds"],
      workflowId: "wf-1",
      workflowName: null,
      status: "running",
      startedAt: expect.stringMatching(ISO),
      completedAt: null,
      triggeredBy: null,
      scorers: null,
      summary: null,
      error: null,
      candidate: null,
      workflowHash: null,
      workflowVersion: null,
      options: null,
      progress: null
    });
    await seedRun(store, "r-full", "ds", {
      workflowName: "WF",
      triggeredBy: "alice",
      triggeredByUserId: "u-1",
      scorers: [{ type: "exact" }],
      kind: "replay",
      status: "queued",
      datasetIds: ["ds", "ds2"],
      candidate: { releaseEligible: true },
      workflowHash: "h1",
      workflowVersion: 3,
      options: { concurrency: 2 },
      progress: { done: 0 }
    });
    expect(await store.getEvalRun("r-full")).toMatchObject({
      kind: "replay",
      status: "queued",
      datasetIds: ["ds", "ds2"],
      workflowName: "WF",
      triggeredBy: "alice",
      scorers: [{ type: "exact" }],
      candidate: { releaseEligible: true },
      workflowHash: "h1",
      workflowVersion: 3,
      options: { concurrency: 2 },
      progress: { done: 0 }
    });
    expect(await store.getEvalRun("missing")).toBeNull();
  });

  it("updates progress only while queued or running, and finalizes with the status guard", async () => {
    const store = ctx.store();
    await seedRun(store, "r1", "ds", { status: "queued" });
    await store.updateEvalRunProgress({ id: "r1", status: "running", progress: { done: 1 } });
    expect(await store.getEvalRun("r1")).toMatchObject({ status: "running", progress: { done: 1 } });
    await store.updateEvalRunProgress({ id: "r1", progress: { done: 2 } });
    expect((await store.getEvalRun("r1"))?.progress).toEqual({ done: 2 });

    expect(await store.finalizeEvalRun({ id: "r1", status: "canceled", onlyFrom: ["queued", "running"] })).toBe(true);
    const canceled = await store.getEvalRun("r1");
    expect(canceled).toMatchObject({ status: "canceled", progress: { done: 2 }, summary: null, error: null });
    expect(canceled?.completedAt).toMatch(ISO);
    // A late finish never overwrites a canceled run; a late heartbeat never revives it.
    expect(await store.finalizeEvalRun({ id: "r1", status: "completed", summary: { pass: 1 }, onlyFrom: ["running"] })).toBe(false);
    await store.updateEvalRunProgress({ id: "r1", status: "running", progress: { done: 9 } });
    expect(await store.getEvalRun("r1")).toMatchObject({ status: "canceled", progress: { done: 2 } });
    // Without a guard the write lands; a missing summary keeps the stored one.
    expect(await store.finalizeEvalRun({ id: "r1", status: "errored", summary: { pass: 0 }, error: "boom" })).toBe(true);
    expect(await store.finalizeEvalRun({ id: "r1", status: "failed" })).toBe(true);
    expect(await store.getEvalRun("r1")).toMatchObject({ status: "failed", summary: { pass: 0 }, error: null });
    await store.updateEvalRunSummary("r1", { pass: 5 }, { done: 5 });
    expect(await store.getEvalRun("r1")).toMatchObject({ summary: { pass: 5 }, progress: { done: 5 } });
    expect(await store.finalizeEvalRun({ id: "missing", status: "completed" })).toBe(false);
  });

  it("lists runs newest first with every filter and pagination", async () => {
    const store = ctx.store();
    await seedRun(store, "r1", "ds-a");
    await seedRun(store, "r2", "ds-b", { kind: "replay", datasetIds: ["ds-b", "ds_a%"], workflowId: "wf-2" });
    await seedRun(store, "r3", `${GUARD_SIMULATION_JOB_DATASET_PREFIX}sim-1`, { kind: "replay" });
    await seedRun(store, "r4", "ds-a", { status: "queued" });
    expect((await store.listEvalRuns()).map((r) => r.id)).toEqual(["r4", "r3", "r2", "r1"]);
    expect((await store.listEvalRuns({ excludeSimulations: true })).map((r) => r.id)).toEqual(["r4", "r2", "r1"]);
    expect((await store.listEvalRuns({ datasetId: "ds-a" })).map((r) => r.id)).toEqual(["r4", "r1"]);
    // Set ids inside the list match literally (`_` and `%` are not wildcards).
    expect((await store.listEvalRuns({ datasetId: "ds_a%" })).map((r) => r.id)).toEqual(["r2"]);
    expect((await store.listEvalRuns({ datasetId: "dsXa%" })).map((r) => r.id)).toEqual([]);
    expect((await store.listEvalRuns({ workflowId: "wf-2" })).map((r) => r.id)).toEqual(["r2"]);
    expect((await store.listEvalRuns({ workflowIds: [] })).map((r) => r.id)).toEqual([]);
    expect((await store.listEvalRuns({ workflowIds: ["wf-2", "zz"] })).map((r) => r.id)).toEqual(["r2"]);
    expect((await store.listEvalRuns({ kind: "replay" })).map((r) => r.id)).toEqual(["r3", "r2"]);
    expect((await store.listEvalRuns({ statuses: ["queued"] })).map((r) => r.id)).toEqual(["r4"]);
    expect((await store.listEvalRuns({ limit: 2 })).map((r) => r.id)).toEqual(["r4", "r3"]);
    expect((await store.listEvalRuns({ limit: 2, offset: 2 })).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect((await store.listEvalRuns({ limit: 0 })).map((r) => r.id)).toEqual(["r4"]);
  });

  it("records results in order, lists them without the diff and reads one with it", async () => {
    const store = ctx.store();
    await seedRun(store, "run", "ds");
    await store.recordEvalResult({
      id: "res-1",
      runId: "run",
      fixtureId: "f1",
      fixtureName: "first",
      status: "pass",
      executionId: "ex-1",
      score: { exact: 1 },
      output: { text: "hi" },
      durationMs: 12.7,
      tokenInput: 3.2,
      tokenOutput: 4,
      tokenTotal: 7,
      recordingId: "rec-1",
      verdict: "same",
      diff: { changed: [] },
      costUsd: 0.0125
    });
    await store.recordEvalResult({ id: "res-2", runId: "run", fixtureId: "f2", status: "error", error: "bad", costUsd: Number.NaN });
    await store.recordEvalResult({ id: "res-3", runId: "run", fixtureId: "f1", status: "skipped", output: null });
    const list = await store.listEvalResults("run");
    expect(list.map((r) => r.id)).toEqual(["res-1", "res-2", "res-3"]);
    expect(list[0]).toEqual({
      id: "res-1",
      runId: "run",
      fixtureId: "f1",
      fixtureName: "first",
      recordingId: "rec-1",
      status: "pass",
      executionId: "ex-1",
      score: { exact: 1 },
      output: { text: "hi" },
      error: null,
      durationMs: 12,
      tokenInput: 3,
      tokenOutput: 4,
      tokenTotal: 7,
      costUsd: 0.0125,
      verdict: "same"
    });
    expect(list[1]).toMatchObject({ error: "bad", costUsd: null, durationMs: null, output: null, score: null, verdict: null });
    // `null` output is stored as JSON "null", which reads back as null.
    expect(list[2].output).toBeNull();
    expect(await store.getEvalResult("run", "res-1")).toMatchObject({ id: "res-1", diff: { changed: [] } });
    expect(await store.getEvalResult("run", "res-2")).toMatchObject({ diff: null });
    expect(await store.getEvalResult("other", "res-1")).toBeNull();
    expect((await store.evalRunIdsForResults({ fixtureIds: ["f1"] })).sort()).toEqual(["run"]);
    expect(await store.evalRunIdsForResults({ resultIds: ["res-2", "nope"] })).toEqual(["run"]);
    expect(await store.evalRunIdsForResults({})).toEqual([]);
  });

  it("deletes a dataset with its fixtures, runs and results", async () => {
    const store = ctx.store();
    await store.createEvalDataset({ id: "ds", name: "D" });
    await store.createEvalDataset({ id: "keep", name: "K" });
    await store.createEvalFixture({ id: "f1", datasetId: "ds", name: "a", input: 1 });
    await seedRun(store, "run", "ds");
    await seedRun(store, "other", "keep");
    await store.recordEvalResult({ id: "res", runId: "run", fixtureId: "f1", status: "pass" });
    await store.recordEvalResult({ id: "res-keep", runId: "other", fixtureId: "f1", status: "pass" });
    expect(await store.deleteEvalDataset("ds")).toBe(true);
    expect(await store.getEvalDataset("ds")).toBeNull();
    expect(await store.getEvalFixture("f1")).toBeNull();
    expect(await store.getEvalRun("run")).toBeNull();
    expect(await store.listEvalResults("run")).toEqual([]);
    expect(await store.listEvalResults("other")).toHaveLength(1);
    expect(await store.deleteEvalDataset("ds")).toBe(false);
  });

  it("prunes old finished runs, keeping each set's newest run and newest finished run", async () => {
    const store = ctx.store();
    // Oldest first: a1 finished, a2 finished, a3 running (newest of ds-a). b1 finished alone in ds-b.
    await seedRun(store, "a1", "ds-a");
    await store.finalizeEvalRun({ id: "a1", status: "completed" });
    await seedRun(store, "a2", "ds-a");
    await store.finalizeEvalRun({ id: "a2", status: "failed" });
    await seedRun(store, "b1", "ds-b");
    await store.finalizeEvalRun({ id: "b1", status: "completed" });
    await seedRun(store, "m1", "ds-c", { datasetIds: ["ds-c", "ds-b"] });
    await store.finalizeEvalRun({ id: "m1", status: "completed" });
    await seedRun(store, "a3", "ds-a");
    await store.recordEvalResult({ id: "res-a1", runId: "a1", fixtureId: "f", status: "pass" });
    await store.recordEvalResult({ id: "res-b1", runId: "b1", fixtureId: "f", status: "pass" });

    // Nothing started before this instant.
    expect(await store.pruneEvalRuns({ before: "2000-01-01T00:00:00.000Z" })).toBe(0);
    const future = new Date(Date.now() + 60_000).toISOString();
    // a1: finished, not newest of ds-a, not its newest finished (a2) → deleted.
    // b1: ds-b's newest and newest finished is m1 (it lists ds-b) → deleted.
    expect(await store.pruneEvalRuns({ before: future })).toBe(2);
    expect((await store.listEvalRuns()).map((r) => r.id).sort()).toEqual(["a2", "a3", "m1"]);
    expect(await store.listEvalResults("a1")).toEqual([]);
    expect(await store.listEvalResults("b1")).toEqual([]);
    expect(await store.pruneEvalRuns({ before: future })).toBe(0);
  });
});
