/**
 * Phase 13.1 — checked golden-run writes on Postgres from two store instances (two pools) on one database: the
 * duplicate and limit checks, capture promotion and golden-set import each apply once, however the two race.
 * Postgres only (SQLite's single writer already serialises them; see replay.contract.test.ts for both stores).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { postgresStoreConfig } from "../create-store.js";
import type { ReplayRecordingInsert } from "../database.js";
import { PostgresStore } from "../postgres-store.js";
import type { ReplayRecordingLimits, Store } from "../store.js";
import { createTestStore, noticePostgresSkipped, testPostgresSettings, testPostgresUrl, type TestStore } from "../../test-support/test-store.js";

const ROUNDS = 8;

function recording(id: string, overrides: Partial<ReplayRecordingInsert> = {}): ReplayRecordingInsert {
  return {
    id,
    workflowId: "wf-1",
    projectId: "default",
    name: id,
    notes: null,
    sourceExecutionId: `exec-${id}`,
    sourceTriggerType: "manual",
    sourceStatus: "success",
    workflowHash: "h",
    workflowSavedVersion: null,
    capturedWorkflowJson: "{}",
    inputJson: null,
    nodeOutputsJson: "{}",
    factsJson: "{}",
    mcpCassetteJson: null,
    capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" },
    bytes: 10,
    truncated: false,
    createdAt: new Date().toISOString(),
    createdBy: null,
    ...overrides
  };
}

const promotion = {
  name: "Promoted",
  capturedWorkflowJson: "{}",
  inputJson: null,
  nodeOutputsJson: "{}",
  factsJson: "{}",
  mcpCassetteJson: null,
  bytes: 10,
  workflowHash: "h2",
  createdBy: null
};

const postgres = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("checked golden-run writes from two stores");

postgres("checked golden-run writes from two stores on one Postgres database", () => {
  let first: TestStore | undefined;
  let second: PostgresStore | undefined;
  let a: Store;
  let b: Store;

  beforeEach(async () => {
    first = await createTestStore({ kind: "postgres" });
    second = await PostgresStore.create(postgresStoreConfig(testPostgresSettings(), { schema: first.schema!, maxConnections: 4 }));
    a = first.store;
    b = second;
  }, 60_000);

  afterEach(async () => {
    await second?.close().catch(() => undefined);
    second = undefined;
    await first?.cleanup();
    first = undefined;
  }, 60_000);

  it("the same execution saved through both stores at once is saved once", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const execution = `exec-dup-${round}`;
      const results = await Promise.all([
        a.saveReplayRecordingChecked(recording(`a-${round}`, { sourceExecutionId: execution }), { uniqueExecution: true }),
        b.saveReplayRecordingChecked(recording(`b-${round}`, { sourceExecutionId: execution }), { uniqueExecution: true })
      ]);
      expect(results.filter((result) => "saved" in result)).toHaveLength(1);
      expect(results.find((result) => !("saved" in result))).toMatchObject({ refused: "duplicate" });
    }
  });

  it("the per-workflow count limit holds when both stores save the last slot at once", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const workflowId = `wf-count-${round}`;
      const limits: ReplayRecordingLimits = { maxPerWorkflow: 1, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: 1_000_000_000 };
      const results = await Promise.all([
        a.saveReplayRecordingChecked(recording(`ca-${round}`, { workflowId }), { limits }),
        b.saveReplayRecordingChecked(recording(`cb-${round}`, { workflowId }), { limits })
      ]);
      expect(results.filter((result) => "saved" in result)).toHaveLength(1);
      expect(results.find((result) => !("saved" in result))).toEqual({ refused: "count", used: 1, bytes: 10 });
      expect(await a.countReplayRecordingsForWorkflow(workflowId)).toBe(1);
    }
  });

  it("the deployment byte budget holds across two workflows saved at once", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const used = await a.sumReplayRecordingBytes();
      const limits: ReplayRecordingLimits = { maxPerWorkflow: 100, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: used + 15 };
      const results = await Promise.all([
        a.saveReplayRecordingChecked(recording(`ta-${round}`, { workflowId: `wf-ta-${round}` }), { limits }),
        b.saveReplayRecordingChecked(recording(`tb-${round}`, { workflowId: `wf-tb-${round}` }), { limits })
      ]);
      expect(results.filter((result) => "saved" in result)).toHaveLength(1);
      expect(results.find((result) => !("saved" in result))).toEqual({ refused: "total_bytes", used: used + 10, bytes: 10 });
      expect(await b.sumReplayRecordingBytes()).toBe(used + 10);
    }
  });

  it("a candidate promoted through both stores at once is promoted once, with one case", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = `cand-${round}`;
      await a.saveReplayRecording(recording(id, { status: "candidate", capturedAt: new Date().toISOString() }));
      const limits: ReplayRecordingLimits = { maxPerWorkflow: 1000, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: 1_000_000_000 };
      // Both find-or-create the same named set: one set is made and both would join it.
      const target = (setId: string) => ({ findOrCreate: { id: setId, name: `Captures ${round}`, workflowId: "wf-1" } });
      const results = await Promise.all([
        a.promoteReplayCaptureToGoldenSet({ recordingId: id, promotion, target: target(`set-a-${round}`), fixture: { id: `fx-a-${round}` }, limits }),
        b.promoteReplayCaptureToGoldenSet({ recordingId: id, promotion, target: target(`set-b-${round}`), fixture: { id: `fx-b-${round}` }, limits })
      ]);
      const won = results.filter((result): result is { datasetId: string; fixtureId: string } => "fixtureId" in result);
      expect(won).toHaveLength(1);
      expect(results.find((result) => !("fixtureId" in result))).toEqual({ refused: "not_candidate" });
      expect(await a.listEvalFixtures(won[0]!.datasetId)).toHaveLength(1);
      expect((await a.getReplayRecordingSummary(id))?.status).toBe("golden");
    }
  });

  it("two candidates of one workflow promoted at once into its last slot: one promoted, one refused, nothing half-done", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const workflowId = `wf-slot-${round}`;
      await a.saveReplayRecording(recording(`s1-${round}`, { workflowId, status: "candidate", capturedAt: new Date().toISOString() }));
      await a.saveReplayRecording(recording(`s2-${round}`, { workflowId, status: "candidate", capturedAt: new Date().toISOString() }));
      await a.createEvalDataset({ id: `set-slot-${round}`, name: "Slot", workflowId });
      const limits: ReplayRecordingLimits = { maxPerWorkflow: 1, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: 1_000_000_000 };
      const results = await Promise.all([
        a.promoteReplayCaptureToGoldenSet({ recordingId: `s1-${round}`, promotion, target: { datasetId: `set-slot-${round}` }, fixture: { id: `fs1-${round}` }, limits }),
        b.promoteReplayCaptureToGoldenSet({ recordingId: `s2-${round}`, promotion, target: { datasetId: `set-slot-${round}` }, fixture: { id: `fs2-${round}` }, limits })
      ]);
      expect(results.filter((result) => "fixtureId" in result)).toHaveLength(1);
      expect(results.find((result) => !("fixtureId" in result))).toEqual({ refused: "count", used: 1, bytes: 10 });
      expect(await a.countReplayRecordingsForWorkflow(workflowId)).toBe(1);
      expect(await a.countReplayRecordingsForWorkflow(workflowId, "candidate")).toBe(1);
      expect(await a.listEvalFixtures(`set-slot-${round}`)).toHaveLength(1);
    }
  });

  it("two imports that each fit alone but not together: one lands whole, the other leaves nothing", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const workflowId = `wf-imp-${round}`;
      const limits: ReplayRecordingLimits = { maxPerWorkflow: 3, maxBytesPerWorkflow: 1_000_000, maxTotalBytes: 1_000_000_000 };
      const importOf = (side: string) => ({
        dataset: { id: `set-${side}-${round}`, name: `Import ${side}`, workflowId },
        cases: [1, 2].map((n) => ({
          recording: recording(`imp-${side}-${round}-${n}`, { workflowId }),
          fixture: { id: `fx-${side}-${round}-${n}`, name: `Case ${n}`, input: null }
        })),
        limits
      });
      const results = await Promise.all([a.importGoldenSet(importOf("a")), b.importGoldenSet(importOf("b"))]);
      const landed = results.filter((result) => "recordingIds" in result);
      expect(landed).toHaveLength(1);
      expect(results.find((result) => !("recordingIds" in result))).toEqual({ refused: "count", used: 3, bytes: 10 });
      expect(await a.countReplayRecordingsForWorkflow(workflowId)).toBe(2);
      const sides = await Promise.all(["a", "b"].map((side) => a.getEvalDataset(`set-${side}-${round}`)));
      expect(sides.filter(Boolean)).toHaveLength(1);
      expect(sides.find(Boolean)).toMatchObject({ fixtureCount: 2, goldenRunCount: 2 });
    }
  });
});
