/**
 * Phase 13.1 — store contract: MCP cassettes, golden runs and replay candidates, checked golden-run saves, capture
 * promotion into a golden set and golden-set import. The same assertions on SQLite and (TEST_POSTGRES_URL) Postgres.
 */
import { expect, it } from "vitest";
import type { McpCassette } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { ReplayRecordingInsert } from "../database.js";
import type { ReplayRecordingLimits } from "../store.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
const ROOMY: ReplayRecordingLimits = { maxPerWorkflow: 100, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: 10_000_000 };

function cassette(calls: number, overrides: Partial<McpCassette> = {}): McpCassette {
  return {
    version: 1,
    servers: [{ serverId: "srv", label: "Server" }],
    entries: Array.from({ length: calls }, (_, index) => ({ serverId: "srv", toolName: `tool_${index}`, args: {}, result: { ok: true } })),
    bytes: 100 + calls,
    truncated: false,
    ...overrides
  } as unknown as McpCassette;
}

function cassetteInput(id: string, overrides: Partial<{ executionId: string | null; workflowId: string | null; projectId: string | null; evalRunId: string | null; fixtureId: string | null; source: "manual" | "eval" | "replay" | "import"; cassette: McpCassette }> = {}) {
  return {
    id,
    executionId: "executionId" in overrides ? overrides.executionId! : `exec-${id}`,
    workflowId: "workflowId" in overrides ? overrides.workflowId! : "wf-1",
    workflowName: "Workflow one",
    projectId: "projectId" in overrides ? overrides.projectId! : "default",
    source: overrides.source ?? "manual",
    evalRunId: overrides.evalRunId ?? null,
    fixtureId: overrides.fixtureId ?? null,
    cassette: overrides.cassette ?? cassette(2),
    createdBy: "tester"
  };
}

function recording(id: string, overrides: Partial<ReplayRecordingInsert> = {}): ReplayRecordingInsert {
  return {
    id,
    workflowId: "wf-1",
    projectId: "default",
    name: `Run ${id}`,
    notes: null,
    sourceExecutionId: `exec-${id}`,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "hash-1",
    workflowSavedVersion: 3,
    capturedWorkflowJson: JSON.stringify({ id: "wf-1", nodes: [] }),
    inputJson: JSON.stringify({ q: id }),
    nodeOutputsJson: JSON.stringify({ n1: { status: "success", output: { a: 1 } } }),
    factsJson: JSON.stringify({ status: "success" }),
    mcpCassetteJson: null,
    modelTapeJson: null,
    memorySeedJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 10,
    truncated: false,
    createdAt: new Date().toISOString(),
    createdBy: "tester",
    ...overrides
  };
}

function promotion(bytes = 20) {
  return {
    name: "Promoted",
    capturedWorkflowJson: JSON.stringify({ id: "wf-1", nodes: ["re-scrubbed"] }),
    inputJson: JSON.stringify({ q: "masked" }),
    nodeOutputsJson: "{}",
    factsJson: JSON.stringify({ status: "success" }),
    mcpCassetteJson: null,
    modelTapeJson: null,
    memorySeedJson: null,
    bytes,
    workflowHash: "hash-2",
    createdBy: "promoter"
  };
}

describeStoreContract("store contract: MCP cassettes", (ctx) => {
  it("saves a cassette and reads back its summary and full record", async () => {
    const store = ctx.store();
    const summary = await store.saveMcpCassette(cassetteInput("cas-1", { cassette: cassette(3, { truncated: true } as Partial<McpCassette>) }));
    expect(summary).toEqual({
      id: "cas-1",
      executionId: "exec-cas-1",
      workflowId: "wf-1",
      workflowName: "Workflow one",
      projectId: "default",
      source: "manual",
      evalRunId: null,
      fixtureId: null,
      callCount: 3,
      serverCount: 1,
      bytes: 103,
      truncated: true,
      createdAt: expect.stringMatching(ISO),
      createdBy: "tester"
    });
    expect(await store.getMcpCassetteSummary("cas-1")).toEqual(summary);
    const record = await store.getMcpCassette("cas-1");
    expect(record).toMatchObject(summary);
    expect(record?.cassette.entries).toHaveLength(3);
    expect(await store.getMcpCassette("missing")).toBeNull();
    expect(await store.getMcpCassetteSummary("missing")).toBeNull();
  });

  it("nullable fields stay null and an unknown source reads as manual", async () => {
    const store = ctx.store();
    const summary = await store.saveMcpCassette(
      cassetteInput("cas-n", { executionId: null, workflowId: null, projectId: null, source: "weird" as never })
    );
    expect(summary).toMatchObject({ executionId: null, workflowId: null, projectId: null, source: "manual", evalRunId: null, fixtureId: null });
  });

  it("finds the newest cassette of an execution and lists an eval run's cassettes oldest first", async () => {
    const store = ctx.store();
    await store.saveMcpCassette(cassetteInput("cas-a", { executionId: "exec-x", evalRunId: "run-1", fixtureId: "fx-1", source: "eval" }));
    await pause();
    await store.saveMcpCassette(cassetteInput("cas-b", { executionId: "exec-x", evalRunId: "run-1", fixtureId: "fx-2", source: "eval", cassette: cassette(5) }));
    await pause();
    await store.saveMcpCassette(cassetteInput("cas-c", { executionId: "exec-y", evalRunId: "run-2" }));
    expect((await store.getMcpCassetteForExecution("exec-x"))?.id).toBe("cas-b");
    expect(await store.getMcpCassetteForExecution("exec-none")).toBeNull();
    expect((await store.listMcpCassettesForEvalRun("run-1")).map((c) => [c.id, c.fixtureId, c.source])).toEqual([
      ["cas-a", "fx-1", "eval"],
      ["cas-b", "fx-2", "eval"]
    ]);
    const badges = await store.mcpCassetteBadgesForExecutions(["exec-x", "exec-y", "exec-x", "", "exec-none"]);
    expect([...badges.entries()].sort()).toEqual([
      ["exec-x", { id: "cas-b", callCount: 5, truncated: false }],
      ["exec-y", { id: "cas-c", callCount: 2, truncated: false }]
    ]);
    expect((await store.mcpCassetteBadgesForExecutions([])).size).toBe(0);
  });

  it("lists newest first with filters, workflow scope, a clamped limit and offset", async () => {
    const store = ctx.store();
    for (const [id, workflowId, projectId] of [["c1", "wf-1", "p1"], ["c2", "wf-2", "p1"], ["c3", "wf-1", "p2"], ["c4", "wf-3", "p2"]] as const) {
      await store.saveMcpCassette(cassetteInput(id, { workflowId, projectId, evalRunId: id === "c4" ? "run-9" : null }));
      await pause();
    }
    const all = await store.listMcpCassettes();
    expect(all.total).toBe(4);
    expect(all.items.map((c) => c.id)).toEqual(["c4", "c3", "c2", "c1"]);
    expect((await store.listMcpCassettes({ workflowId: "wf-1" })).items.map((c) => c.id)).toEqual(["c3", "c1"]);
    expect((await store.listMcpCassettes({ projectId: "p1" })).items.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect((await store.listMcpCassettes({ evalRunId: "run-9" })).items.map((c) => c.id)).toEqual(["c4"]);
    expect(await store.listMcpCassettes({ workflowIds: [] })).toEqual({ items: [], total: 0 });
    const scoped = await store.listMcpCassettes({ workflowIds: ["wf-2", "wf-3"], limit: 1, offset: 1 });
    expect(scoped.total).toBe(2);
    expect(scoped.items.map((c) => c.id)).toEqual(["c2"]);
    expect((await store.listMcpCassettes({ limit: 0 })).items).toHaveLength(1);
    expect((await store.listMcpCassettes({ offset: -5, limit: 2 })).items.map((c) => c.id)).toEqual(["c4", "c3"]);
  });

  it("deletes a cassette once", async () => {
    const store = ctx.store();
    await store.saveMcpCassette(cassetteInput("cas-d"));
    expect(await store.deleteMcpCassette("cas-d")).toBe(true);
    expect(await store.deleteMcpCassette("cas-d")).toBe(false);
    expect(await store.getMcpCassette("cas-d")).toBeNull();
  });
});

describeStoreContract("store contract: golden runs and replay candidates", (ctx) => {
  it("saves a golden run and reads back the summary and the parsed record", async () => {
    const store = ctx.store();
    const createdAt = new Date().toISOString();
    const summary = await store.saveReplayRecording(
      recording("rec-1", {
        createdAt,
        notes: "first",
        mcpCassetteJson: JSON.stringify(cassette(1)),
        modelTapeJson: JSON.stringify({ version: 1, calls: [] }),
        memorySeedJson: JSON.stringify({ entries: [] }),
        truncated: true,
        capabilities: {
          mcp: "cassette",
          models: "tape",
          memory: "seeded",
          workflowSource: "current",
          scrubbed: { input: true, output: false, nodes: ["n1"] }
        } as never
      })
    );
    expect(summary).toEqual({
      id: "rec-1",
      workflowId: "wf-1",
      projectId: "default",
      name: "Run rec-1",
      notes: "first",
      sourceExecutionId: "exec-rec-1",
      sourceTriggerType: "manual",
      sourceStatus: "success",
      workflowHash: "hash-1",
      workflowSavedVersion: 3,
      capabilities: { mcp: "cassette", models: "tape", memory: "seeded", workflowSource: "current", scrubbed: { input: true, output: false, nodes: ["n1"] } },
      bytes: 10,
      truncated: true,
      createdAt,
      createdBy: "tester",
      status: "golden",
      capturedAt: null
    });
    expect(await store.getReplayRecordingSummary("rec-1")).toEqual(summary);
    const record = await store.getReplayRecording("rec-1");
    expect(record).toMatchObject(summary);
    expect(record?.capturedWorkflow).toEqual({ id: "wf-1", nodes: [] });
    expect(record?.input).toEqual({ q: "rec-1" });
    expect(record?.nodes).toEqual({ n1: { status: "success", output: { a: 1 } } });
    expect(record?.facts).toEqual({ status: "success" });
    expect(record?.mcpCassette?.entries).toHaveLength(1);
    expect(record?.modelTape).toEqual({ version: 1, calls: [] });
    expect(record?.memorySeed).toEqual({ entries: [] });
    expect(await store.getReplayRecording("missing")).toBeNull();
    expect(await store.getReplayRecordingSummary("missing")).toBeNull();
  });

  it("empty optional JSON reads as null and a candidate keeps its capture time", async () => {
    const store = ctx.store();
    const capturedAt = new Date().toISOString();
    await store.saveReplayRecording(
      recording("cand-1", { status: "candidate", capturedAt, inputJson: null, workflowSavedVersion: null, notes: null, sourceExecutionId: null, sourceTriggerType: null, createdBy: null })
    );
    const record = await store.getReplayRecording("cand-1");
    expect(record).toMatchObject({ status: "candidate", capturedAt, input: null, mcpCassette: null, modelTape: null, memorySeed: null, workflowSavedVersion: null, notes: null, sourceExecutionId: null, sourceTriggerType: null, createdBy: null });
  });

  it("counts, sums and finds golden runs only (candidates have their own count)", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("g1", { bytes: 10, sourceExecutionId: "exec-1" }));
    await pause();
    await store.saveReplayRecording(recording("g2", { bytes: 15, sourceExecutionId: "exec-1" }));
    await store.saveReplayRecording(recording("g3", { bytes: 7, workflowId: "wf-2", sourceExecutionId: "exec-2" }));
    await store.saveReplayRecording(recording("c1", { bytes: 1000, status: "candidate", capturedAt: new Date().toISOString(), sourceExecutionId: "exec-3" }));
    expect(await store.countReplayRecordingsForWorkflow("wf-1")).toBe(2);
    expect(await store.countReplayRecordingsForWorkflow("wf-1", "candidate")).toBe(1);
    expect(await store.countReplayRecordingsForWorkflow("wf-none")).toBe(0);
    expect(await store.sumReplayRecordingBytesForWorkflow("wf-1")).toBe(25);
    expect(await store.sumReplayRecordingBytesForWorkflow("wf-none")).toBe(0);
    expect(await store.sumReplayRecordingBytes()).toBe(32);
    expect(await store.findReplayRecordingIdForExecution("exec-1")).toBe("g1");
    expect(await store.findReplayRecordingIdForExecution("exec-3")).toBeNull();
    expect(await store.findReplayRecordingIdForExecution("exec-3", "candidate")).toBe("c1");
    const badges = await store.replayGoldenBadgesForExecutions(["exec-1", "exec-2", "exec-3", "exec-1", ""]);
    expect([...badges.entries()].sort()).toEqual([
      ["exec-1", { count: 2, latestId: "g2" }],
      ["exec-2", { count: 1, latestId: "g3" }]
    ]);
    expect((await store.replayGoldenBadgesForExecutions([])).size).toBe(0);
  });

  it("lists newest first, filtered by status, workflow and workflow scope, with a clamped page", async () => {
    const store = ctx.store();
    const base = Date.now();
    const at = (offset: number) => new Date(base + offset * 1000).toISOString();
    await store.saveReplayRecording(recording("r1", { createdAt: at(1) }));
    await store.saveReplayRecording(recording("r2", { createdAt: at(2), workflowId: "wf-2" }));
    await store.saveReplayRecording(recording("r3", { createdAt: at(3), status: "candidate", capturedAt: at(3) }));
    await store.saveReplayRecording(recording("r4", { createdAt: at(4), workflowId: "wf-3" }));
    const all = await store.listReplayRecordings();
    expect(all.total).toBe(4);
    expect(all.items.map((r) => r.id)).toEqual(["r4", "r3", "r2", "r1"]);
    expect((await store.listReplayRecordings({ status: "golden" })).items.map((r) => r.id)).toEqual(["r4", "r2", "r1"]);
    expect((await store.listReplayRecordings({ status: "candidate", workflowId: "wf-1" })).items.map((r) => r.id)).toEqual(["r3"]);
    expect(await store.listReplayRecordings({ workflowIds: [] })).toEqual({ items: [], total: 0 });
    const page = await store.listReplayRecordings({ workflowIds: ["wf-1", "wf-3"], limit: 2, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.items.map((r) => r.id)).toEqual(["r3", "r1"]);
    expect((await store.listReplayRecordings({ limit: 0 })).items).toHaveLength(1);
  });

  it("reads back imported and captured capability details", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(
      recording("imp-1", {
        capabilities: {
          mcp: "bogus",
          models: "live",
          memory: "empty",
          workflowSource: "captured",
          origin: "imported",
          recordedAt: "2026-01-01T00:00:00.000Z",
          sourceWorkflowId: 7,
          capture: { rate: 0.5, masked: true, maskingVerified: false, dataClasses: ["email", 3], values: { email: 2, x: "y" }, keptFromWorkflow: 1, publishedVersion: 4, source: "api_key" }
        } as never
      })
    );
    expect((await store.getReplayRecordingSummary("imp-1"))?.capabilities).toEqual({
      mcp: "none",
      models: "live",
      memory: "empty",
      workflowSource: "captured",
      origin: "imported",
      recordedAt: "2026-01-01T00:00:00.000Z",
      sourceWorkflowId: null,
      capture: { rate: 0.5, masked: true, maskingVerified: false, dataClasses: ["email"], values: { email: 2 }, notDetectableAfterMasking: [], keptFromWorkflow: 1, publishedVersion: 4, source: "api_key" }
    });
  });

  it("deletes a golden run once", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("del-1"));
    expect(await store.deleteReplayRecording("del-1")).toBe(true);
    expect(await store.deleteReplayRecording("del-1")).toBe(false);
    expect(await store.getReplayRecording("del-1")).toBeNull();
  });
});

describeStoreContract("store contract: checked golden-run saves", (ctx) => {
  it("saves when the checks pass and refuses a duplicate of the same execution", async () => {
    const store = ctx.store();
    const first = await store.saveReplayRecordingChecked(recording("a", { sourceExecutionId: "exec-1" }), { uniqueExecution: true, limits: ROOMY });
    expect(first).toMatchObject({ saved: { id: "a", status: "golden" } });
    expect(await store.saveReplayRecordingChecked(recording("b", { sourceExecutionId: "exec-1" }), { uniqueExecution: true })).toEqual({ refused: "duplicate", existingId: "a" });
    // A candidate of the same execution is a different status, so it is not a duplicate of the golden run.
    expect(
      await store.saveReplayRecordingChecked(recording("c", { sourceExecutionId: "exec-1", status: "candidate", capturedAt: new Date().toISOString() }), { uniqueExecution: true })
    ).toMatchObject({ saved: { id: "c", status: "candidate" } });
    // Without uniqueExecution the same execution may be saved again.
    expect(await store.saveReplayRecordingChecked(recording("d", { sourceExecutionId: "exec-1" }), {})).toMatchObject({ saved: { id: "d" } });
    expect(await store.getReplayRecordingSummary("b")).toBeNull();
  });

  it("refuses by count, then workflow bytes, then total bytes, counting golden runs only", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("g1", { bytes: 40 }));
    await store.saveReplayRecording(recording("g2", { bytes: 30, workflowId: "wf-2" }));
    await store.saveReplayRecording(recording("cand", { bytes: 10_000, status: "candidate", capturedAt: new Date().toISOString() }));
    expect(await store.saveReplayRecordingChecked(recording("x1", { bytes: 1 }), { limits: { maxPerWorkflow: 1, maxBytesPerWorkflow: 1000, maxTotalBytes: 1000 } })).toEqual({ refused: "count", used: 1, bytes: 1 });
    expect(await store.saveReplayRecordingChecked(recording("x2", { bytes: 11 }), { limits: { maxPerWorkflow: 5, maxBytesPerWorkflow: 50, maxTotalBytes: 1000 } })).toEqual({ refused: "workflow_bytes", used: 40, bytes: 11 });
    expect(await store.saveReplayRecordingChecked(recording("x3", { bytes: 31 }), { limits: { maxPerWorkflow: 5, maxBytesPerWorkflow: 1000, maxTotalBytes: 100 } })).toEqual({ refused: "total_bytes", used: 70, bytes: 31 });
    expect(await store.saveReplayRecordingChecked(recording("x4", { bytes: 30 }), { limits: { maxPerWorkflow: 5, maxBytesPerWorkflow: 1000, maxTotalBytes: 100 } })).toMatchObject({ saved: { id: "x4" } });
    expect(await store.countReplayRecordingsForWorkflow("wf-1")).toBe(2);
  });

  it("two checked saves of one execution at once save it once", async () => {
    const store = ctx.store();
    const results = await Promise.all([
      store.saveReplayRecordingChecked(recording("p1", { sourceExecutionId: "exec-race" }), { uniqueExecution: true }),
      store.saveReplayRecordingChecked(recording("p2", { sourceExecutionId: "exec-race" }), { uniqueExecution: true })
    ]);
    expect(results.filter((result) => "saved" in result)).toHaveLength(1);
    expect(results.find((result) => !("saved" in result))).toMatchObject({ refused: "duplicate" });
  });
});

describeStoreContract("store contract: capture promotion into a golden set", (ctx) => {
  async function candidate(id = "cand-1", bytes = 5) {
    await ctx.store().saveReplayRecording(recording(id, { status: "candidate", capturedAt: new Date().toISOString(), bytes }));
  }

  it("promotes a candidate into a named set it creates, then reuses that set", async () => {
    const store = ctx.store();
    await candidate("cand-1");
    await candidate("cand-2");
    const findOrCreate = { id: "set-new", name: "Production captures", workflowId: "wf-1", projectId: "default", createdBy: "promoter" };
    const first = await store.promoteReplayCaptureToGoldenSet({
      recordingId: "cand-1",
      promotion: promotion(20),
      target: { findOrCreate },
      fixture: { id: "fx-1" },
      limits: ROOMY
    });
    expect(first).toEqual({ datasetId: "set-new", fixtureId: "fx-1" });
    const promoted = await store.getReplayRecording("cand-1");
    expect(promoted).toMatchObject({ status: "golden", name: "Promoted", bytes: 20, workflowHash: "hash-2", createdBy: "promoter", input: { q: "masked" } });
    expect(promoted?.capturedWorkflow).toEqual({ id: "wf-1", nodes: ["re-scrubbed"] });
    const second = await store.promoteReplayCaptureToGoldenSet({
      recordingId: "cand-2",
      promotion: promotion(20),
      target: { findOrCreate: { ...findOrCreate, id: "set-other" } },
      fixture: { id: "fx-2", name: "Named case" },
      limits: ROOMY
    });
    expect(second).toEqual({ datasetId: "set-new", fixtureId: "fx-2" });
    expect(await store.getEvalDataset("set-other")).toBeNull();
    const dataset = await store.getEvalDataset("set-new");
    expect(dataset).toMatchObject({ name: "Production captures", workflowId: "wf-1", fixtureCount: 2, goldenRunCount: 2 });
    const fixtures = await store.listEvalFixtures("set-new");
    expect(fixtures.map((f) => [f.id, f.name, f.recordingId, f.input]).sort()).toEqual([
      ["fx-1", "Promoted", "cand-1", { q: "masked" }],
      ["fx-2", "Named case", "cand-2", { q: "masked" }]
    ]);
  });

  it("refuses a run that is not a candidate, a deleted set and a full workflow, leaving everything as it was", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("golden-1", { bytes: 50 }));
    await candidate("cand-1");
    await store.createEvalDataset({ id: "set-1", name: "Set", workflowId: "wf-1" });
    const base = { promotion: promotion(20), fixture: { id: "fx-1" }, limits: ROOMY };
    expect(await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "golden-1", target: { datasetId: "set-1" } })).toEqual({ refused: "not_candidate" });
    expect(await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "missing", target: { datasetId: "set-1" } })).toEqual({ refused: "not_candidate" });
    expect(await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "cand-1", target: { datasetId: "set-gone" } })).toEqual({ refused: "set_gone" });
    expect(
      await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "cand-1", target: { datasetId: "set-1" }, limits: { ...ROOMY, maxBytesPerWorkflow: 60 } })
    ).toEqual({ refused: "workflow_bytes", used: 50, bytes: 20 });
    expect((await store.getReplayRecordingSummary("cand-1"))?.status).toBe("candidate");
    expect(await store.listEvalFixtures("set-1")).toEqual([]);
    expect(await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "cand-1", target: { datasetId: "set-1" } })).toEqual({ datasetId: "set-1", fixtureId: "fx-1" });
    expect(await store.promoteReplayCaptureToGoldenSet({ ...base, recordingId: "cand-1", target: { datasetId: "set-1" }, fixture: { id: "fx-again" } })).toEqual({ refused: "not_candidate" });
  });

  it("a failing case insert rolls back the promotion and the set it made", async () => {
    const store = ctx.store();
    await candidate("cand-1");
    await store.createEvalDataset({ id: "set-1", name: "Set", workflowId: "wf-1" });
    await store.createEvalFixture({ id: "fx-taken", datasetId: "set-1", name: "Taken", input: null });
    await expect(
      store.promoteReplayCaptureToGoldenSet({
        recordingId: "cand-1",
        promotion: promotion(20),
        target: { findOrCreate: { id: "set-new", name: "New", workflowId: "wf-1" } },
        fixture: { id: "fx-taken" },
        limits: ROOMY
      })
    ).rejects.toThrow();
    expect((await store.getReplayRecordingSummary("cand-1"))?.status).toBe("candidate");
    expect(await store.getEvalDataset("set-new")).toBeNull();
  });

  it("two promotions of one candidate at once promote it once", async () => {
    const store = ctx.store();
    await candidate("cand-1");
    await store.createEvalDataset({ id: "set-1", name: "Set", workflowId: "wf-1" });
    const results = await Promise.all(
      ["fx-a", "fx-b"].map((id) =>
        store.promoteReplayCaptureToGoldenSet({ recordingId: "cand-1", promotion: promotion(20), target: { datasetId: "set-1" }, fixture: { id }, limits: ROOMY })
      )
    );
    expect(results.filter((result) => "fixtureId" in result)).toHaveLength(1);
    expect(results.find((result) => !("fixtureId" in result))).toEqual({ refused: "not_candidate" });
    expect(await store.listEvalFixtures("set-1")).toHaveLength(1);
  });
});

describeStoreContract("store contract: golden-set import", (ctx) => {
  const importCase = (id: string, bytes: number) => ({
    recording: recording(id, { bytes, capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured", origin: "imported", sourceWorkflowId: "wf-src" } as never }),
    fixture: { id: `fx-${id}`, name: `Case ${id}`, input: { q: id }, expected: { ok: true } }
  });

  it("creates the set, its golden runs and its cases together", async () => {
    const store = ctx.store();
    const result = await store.importGoldenSet({
      dataset: { id: "set-imp", name: "Imported", workflowId: "wf-1", createdBy: "importer" },
      cases: [importCase("i1", 10), importCase("i2", 10)],
      limits: ROOMY
    });
    expect(result).toEqual({ recordingIds: ["i1", "i2"] });
    expect(await store.getEvalDataset("set-imp")).toMatchObject({ name: "Imported", workflowId: "wf-1", createdBy: "importer", fixtureCount: 2, goldenRunCount: 2 });
    expect((await store.getReplayRecordingSummary("i1"))?.capabilities).toMatchObject({ origin: "imported", sourceWorkflowId: "wf-src" });
    const fixtures = await store.listEvalFixtures("set-imp");
    expect(fixtures.map((f) => [f.id, f.recordingId, f.expected]).sort()).toEqual([
      ["fx-i1", "i1", { ok: true }],
      ["fx-i2", "i2", { ok: true }]
    ]);
  });

  it("a case over the limits refuses the whole import and leaves nothing behind", async () => {
    const store = ctx.store();
    const result = await store.importGoldenSet({
      dataset: { id: "set-imp", name: "Imported", workflowId: "wf-1" },
      cases: [importCase("i1", 10), importCase("i2", 10), importCase("i3", 10)],
      limits: { ...ROOMY, maxPerWorkflow: 2 }
    });
    expect(result).toEqual({ refused: "count", used: 2, bytes: 10 });
    expect(await store.getEvalDataset("set-imp")).toBeNull();
    expect(await store.getReplayRecordingSummary("i1")).toBeNull();
    expect(await store.listReplayRecordings()).toEqual({ items: [], total: 0 });
    expect(await store.getEvalFixture("fx-i1")).toBeNull();
  });
});
