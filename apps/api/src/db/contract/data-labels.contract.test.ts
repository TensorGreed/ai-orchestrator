/**
 * Phase 13.1 — store contract: the data-subject lookup's rows (paging every row exactly once, one row's text, counts)
 * and erasure with its cascades, on SQLite and Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import type { Store } from "../store.js";
import type { ReplayRecordingInsert, SubjectStoreKind } from "../database.js";

async function pageAll(store: Store, kind: SubjectStoreKind, size: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const page = await store.subjectTextPage(kind, after, size);
    pages += 1;
    ids.push(...page.rows.map((row) => row.id));
    if (page.lastRowid === null || page.rows.length < size) break;
    expect(page.lastRowid).toBeGreaterThan(after);
    after = page.lastRowid;
  }
  return { ids, pages };
}

function recording(id: string, workflowId = "wf"): ReplayRecordingInsert {
  return {
    id,
    workflowId,
    projectId: "default",
    name: `Golden ${id}`,
    notes: "call alice@example.com",
    sourceExecutionId: null,
    sourceTriggerType: null,
    sourceStatus: "success",
    workflowHash: "h",
    workflowSavedVersion: null,
    capturedWorkflowJson: JSON.stringify({ id: workflowId }),
    inputJson: JSON.stringify({ email: "alice@example.com" }),
    nodeOutputsJson: "{}",
    factsJson: "{}",
    mcpCassetteJson: null,
    capabilities: { model: false, mcp: false, memory: false } as unknown as ReplayRecordingInsert["capabilities"],
    bytes: 10,
    truncated: false,
    createdAt: new Date().toISOString(),
    createdBy: null
  };
}

describeStoreContract("store contract: data-subject rows", (ctx) => {
  it("pages replay, eval and gate runs (not other runs) once each, in creation order; counts and reads one", async () => {
    const store = ctx.store();
    for (let index = 0; index < 23; index += 1) {
      await store.saveExecutionHistory({
        id: `run-${String(index).padStart(2, "0")}`,
        workflowId: "wf",
        workflowName: index === 0 ? undefined : "Flow",
        status: "success",
        startedAt: new Date().toISOString(),
        triggerType: ["replay", "mcp_replay", "eval", "eval_judge"][index % 4],
        inputJson: { email: `user${index}@example.com` },
        error: index === 1 ? "failed for bob@example.com" : undefined
      });
    }
    await store.saveExecutionHistory({ id: "live", workflowId: "wf", status: "success", startedAt: new Date().toISOString(), triggerType: "manual" });
    expect(await store.countSubjectRows("execution")).toBe(23);
    const { ids, pages } = await pageAll(store, "execution", 10);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect(ids).not.toContain("live");
    expect(pages).toBe(3);
    expect(ids.slice(0, 3)).toEqual(["run-00", "run-01", "run-02"]);
    const one = await store.subjectTextRow("execution", "run-01");
    expect(one).toMatchObject({ kind: "execution", id: "run-01", workflowId: "wf", projectId: null, name: "Flow", status: "success" });
    expect(one?.texts.error).toBe("failed for bob@example.com");
    expect(JSON.parse(one!.texts.input!)).toEqual({ email: "user1@example.com" });
    expect(Object.keys(one!.texts).sort()).toEqual(["customData", "error", "input", "nodes", "output"]);
    expect((await store.subjectTextRow("execution", "run-00"))?.name).toBe("run-00");
    expect(await store.subjectTextRow("execution", "live")).toBeNull();
    expect(await store.subjectTextRow("execution", "missing")).toBeNull();
    const empty = await store.subjectTextPage("cassette", 0, 20);
    expect(empty).toEqual({ rows: [], lastRowid: null });
    expect(await store.countSubjectRows("cassette")).toBe(0);
  });

  it("deleting a run takes its tool calls, guard events and usage rows; a second delete finds nothing", async () => {
    const store = ctx.store();
    await store.saveExecutionHistory({ id: "run-1", workflowId: "wf", status: "success", startedAt: new Date().toISOString(), triggerType: "replay" });
    await store.insertGuardEvents([
      {
        id: "ge", verdictId: "v", executionId: "run-1", workflowId: "wf", projectId: null, nodeId: "n", placement: "pre", iteration: null, toolName: null,
        channel: "output", detectorId: null, category: null, dataClass: null, score: null, requestedAction: "allow", effectiveAction: "allow",
        verdictAction: "allow", shadow: false, evidence: [], profileId: "p", profileVersion: 1, profileHash: "h", latencyMs: 0, budgetExceeded: false,
        skippedDetectors: [], createdAt: new Date().toISOString()
      }
    ]);
    expect(await store.deleteSubjectRow("execution", "run-1")).toEqual({ deleted: true, cascaded: [] });
    expect(await store.listGuardEventsForExecution("run-1")).toEqual([]);
    expect(await store.deleteSubjectRow("execution", "run-1")).toEqual({ deleted: false, cascaded: [] });
    expect(await store.deleteSubjectRow("eval_result", "missing")).toEqual({ deleted: false, cascaded: [] });
    expect(await store.deleteSubjectRow("cassette", "missing")).toEqual({ deleted: false, cascaded: [] });
    expect(await store.deleteSubjectRow("recording", "missing")).toEqual({ deleted: false, cascaded: [] });
  });

  it("a golden run, its golden-set cases and their results are found, and deleted together", async () => {
    const store = ctx.store();
    await store.saveReplayRecording(recording("rec-1"));
    await store.createEvalDataset({ id: "ds", name: "Set", workflowId: "wf", projectId: "default" });
    await store.createEvalFixture({ id: "fx-1", datasetId: "ds", name: "Case 1", input: { email: "alice@example.com" }, recordingId: "rec-1" });
    await store.createEvalFixture({ id: "fx-2", datasetId: "ds", name: "Case 2", input: {}, expected: { ok: true } });
    await store.createEvalRun({ id: "run", datasetId: "ds", workflowId: "wf", kind: "replay", status: "completed" });
    await store.recordEvalResult({ id: "res-1", runId: "run", fixtureId: "fx-1", fixtureName: "Case 1", status: "fail", error: "alice@example.com" });
    await store.recordEvalResult({ id: "res-2", runId: "run", fixtureId: "fx-2", status: "pass" });

    expect(await store.countSubjectRows("recording")).toBe(1);
    expect(await store.countSubjectRows("fixture")).toBe(2);
    expect(await store.countSubjectRows("eval_result")).toBe(2);
    expect((await pageAll(store, "fixture", 1)).ids.sort()).toEqual(["fx-1", "fx-2"]);
    const rec = await store.subjectTextRow("recording", "rec-1");
    expect(rec).toMatchObject({ kind: "recording", workflowId: "wf", projectId: "default", name: "Golden rec-1", status: "golden" });
    expect(rec?.texts.notes).toBe("call alice@example.com");
    expect(rec?.texts.modelTape).toBeNull();
    expect(await store.subjectTextRow("fixture", "fx-2")).toMatchObject({ workflowId: "wf", projectId: "default", name: "Case 2", status: null });
    expect(await store.subjectTextRow("eval_result", "res-2")).toMatchObject({ name: "res-2", status: "pass", workflowId: "wf" });

    const removed = await store.deleteSubjectRow("recording", "rec-1");
    expect(removed.deleted).toBe(true);
    expect([...removed.cascaded].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { kind: "fixture", id: "fx-1" },
      { kind: "eval_result", id: "res-1" }
    ]);
    expect(await store.getEvalFixture("fx-1")).toBeNull();
    expect(await store.getEvalFixture("fx-2")).not.toBeNull();
    expect((await store.listEvalResults("run")).map((r) => r.id)).toEqual(["res-2"]);
    expect(await store.deleteSubjectRow("fixture", "fx-2")).toEqual({ deleted: true, cascaded: [{ kind: "eval_result", id: "res-2" }] });
    expect(await store.countSubjectRows("eval_result")).toBe(0);
  });
});
