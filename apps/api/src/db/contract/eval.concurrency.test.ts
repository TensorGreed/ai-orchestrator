/**
 * Phase 13.1 — evals and production capture with two PostgresStores on one database (two API processes): the
 * conditional writes apply once whichever process gets there first. Postgres only; skipped without TEST_POSTGRES_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresStore } from "../postgres-store.js";
import type { Store } from "../store.js";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore, openTestStoreTwin } from "../../test-support/test-store.js";

const enabled = Boolean(testPostgresUrl());
if (!enabled) noticePostgresSkipped("eval and capture concurrency");

const ROUNDS = 8;

function candidate(id: string, capturedAt: string): Parameters<Store["saveReplayRecording"]>[0] {
  return {
    id,
    workflowId: "wf-1",
    projectId: null,
    name: id,
    notes: null,
    sourceExecutionId: null,
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
    createdAt: capturedAt,
    createdBy: null,
    status: "candidate",
    capturedAt
  };
}

describe.skipIf(!enabled)("eval and capture writes across two Postgres stores", () => {
  let first: TestStore;
  let second: PostgresStore;

  beforeEach(async () => {
    first = await createTestStore({ kind: "postgres" });
    second = await openTestStoreTwin(first!, { maxConnections: 4 });
  }, 60_000);

  afterEach(async () => {
    await second?.close().catch(() => undefined);
    await first?.cleanup();
  }, 60_000);

  it("a candidate promoted by both processes at once is promoted once", async () => {
    const promotion = {
      name: "Golden",
      capturedWorkflowJson: "{}",
      inputJson: null,
      nodeOutputsJson: "{}",
      factsJson: "{}",
      mcpCassetteJson: null,
      bytes: 10,
      workflowHash: "h",
      createdBy: null
    };
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = `c-${round}`;
      await first.store.saveReplayRecording(candidate(id, "2026-10-01T00:00:00.000Z"));
      const results = await Promise.all([
        first.store.promoteReplayCapture(id, { ...promotion, createdBy: "a" }),
        second.promoteReplayCapture(id, { ...promotion, createdBy: "b" })
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await first.store.getReplayRecordingSummary(id))?.status).toBe("golden");
    }
  });

  it("an eval run finished and canceled at once ends in exactly one of the two", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = `r-${round}`;
      await first.store.createEvalRun({ id, datasetId: "ds", workflowId: "wf-1" });
      const [completed, canceled] = await Promise.all([
        first.store.finalizeEvalRun({ id, status: "completed", summary: { pass: 1 }, onlyFrom: ["running"] }),
        second.finalizeEvalRun({ id, status: "canceled", onlyFrom: ["queued", "running"] })
      ]);
      expect(Number(completed) + Number(canceled)).toBe(1);
      expect((await second.getEvalRun(id))?.status).toBe(completed ? "completed" : "canceled");
    }
  });

  it("prunes run by both processes at once delete and count each run once", async () => {
    for (let index = 0; index < 12; index += 1) {
      await first.store.createEvalRun({ id: `p-${index}`, datasetId: "ds", workflowId: "wf-1" });
      await first.store.recordEvalResult({ id: `res-${index}`, runId: `p-${index}`, fixtureId: "f", status: "pass" });
      await first.store.finalizeEvalRun({ id: `p-${index}`, status: "completed" });
    }
    const before = new Date(Date.now() + 60_000).toISOString();
    const counts = await Promise.all([first.store.pruneEvalRuns({ before }), second.pruneEvalRuns({ before })]);
    // The newest run of the set is kept; the other eleven go, counted once between the two prunes.
    expect(counts[0] + counts[1]).toBe(11);
    expect((await first.store.listEvalRuns()).map((run) => run.id)).toEqual(["p-11"]);
    expect(await first.store.listEvalResults("p-0")).toEqual([]);

    for (let index = 0; index < 10; index += 1) {
      await first.store.saveReplayRecording(candidate(`old-${index}`, `2026-01-0${(index % 9) + 1}T00:00:00.000Z`));
    }
    const pruned = await Promise.all([first.store.pruneReplayCaptures("2026-06-01T00:00:00.000Z"), second.pruneReplayCaptures("2026-06-01T00:00:00.000Z")]);
    expect(pruned[0] + pruned[1]).toBe(10);
  });
});
