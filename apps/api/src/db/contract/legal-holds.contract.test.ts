/**
 * 13.3 — store contract: legal holds on both stores. A hold keeps rows from every purge and from the deletes that
 * check holds (workflow, project, golden set, case, golden run, cassette, data-subject row); releasing it lets the next
 * purge take what was due.
 */
import { expect, it } from "vitest";
import type { LegalHoldItemKind, LegalHoldScopeType } from "@ai-orchestrator/shared";
import { describeStoreContract } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";
import { retentionRowSql as insert } from "../../test-support/retention-rows.js";
import { RETENTION_TABLES, type RetentionTable } from "../retention-tables.js";
import { LegalHoldError } from "../legal-hold-sql.js";
import type { Store } from "../store.js";

const OLD = "2001-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";
const NOW = "2026-11-10T00:00:00.000Z";

/** The column that names a row of `table` in these tests. */
const NAME_COLUMN: Partial<Record<RetentionTable, string>> = { session_memory: "session_id", session_artifacts: "artifact_key" };

/** The anchor columns of each retention table (the helper's rows use workflow `wf`, run `run`, namespace `ns`). */
const ANCHOR_COLUMNS: Record<Exclude<RetentionTable, "retention_runs">, Array<"workflow_id" | "project_id" | "execution_id" | "namespace">> = {
  execution_history: ["workflow_id"],
  mcp_tool_calls: ["workflow_id", "project_id", "execution_id"],
  guard_events: ["workflow_id", "project_id", "execution_id"],
  approval_requests: ["workflow_id", "project_id", "execution_id"],
  mcp_cassettes: ["workflow_id", "project_id", "execution_id"],
  mcp_gateway_approvals: ["project_id"],
  execution_queue: ["workflow_id"],
  execution_queue_dlq: ["workflow_id"],
  session_memory: ["namespace"],
  session_artifacts: ["namespace"],
  session_tool_cache: ["namespace"],
  usage_events: ["workflow_id", "project_id", "execution_id"],
  ai_gateway_requests: ["project_id"]
};

function workflow(id: string, projectId: string) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId } as never;
}

let holdSeq = 0;
async function hold(
  store: Store,
  scopeType: LegalHoldScopeType,
  scopeId: string | null,
  items: Array<{ kind: LegalHoldItemKind; rowId: string }> = []
) {
  holdSeq += 1;
  const id = `hold-${holdSeq}`;
  return await store.placeLegalHold({
    id,
    name: `Hold ${holdSeq}`,
    reason: "Litigation",
    matterRef: "M-1",
    scopeType,
    scopeId: scopeId ?? id,
    endsAt: null,
    createdBy: "admin@example.com",
    createdAt: new Date(Date.parse(NOW) + holdSeq).toISOString(),
    items
  });
}

async function release(store: Store, id: string) {
  return await store.releaseLegalHold({ id, releasedBy: "admin@example.com", reason: "Settled", releasedAt: NOW });
}

describeStoreContract("store contract: legal holds", (ctx) => {
  const sql = () => testSql(ctx.store());

  async function names(table: string, column = "id"): Promise<string[]> {
    const rows = await sql().all<{ name: string }>(`SELECT ${column} AS name FROM ${table} ORDER BY ${column}`);
    return rows.map((row) => row.name);
  }

  it("places, lists, pages items and releases a hold; a released hold stays released", async () => {
    const store = ctx.store();
    const placed = await hold(store, "runs", null, [
      { kind: "execution", rowId: "run-a" },
      { kind: "execution", rowId: "run-b" },
      { kind: "execution", rowId: "run-b" }
    ]);
    expect(placed).toMatchObject({ name: placed.name, scopeType: "runs", scopeId: placed.id, status: "active", matterRef: "M-1", itemCount: 2 });
    const other = await hold(store, "project", "p1");
    expect((await store.listLegalHolds()).map((h) => h.id)).toEqual([other.id, placed.id]);
    expect((await store.listLegalHolds({ status: "active" })).map((h) => h.id)).toEqual([other.id, placed.id]);
    const page = await store.listLegalHoldItems(placed.id, { offset: 1, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: "execution", rowId: "run-b" });

    const released = await release(store, other.id);
    expect(released).toMatchObject({ status: "released", releasedBy: "admin@example.com", releaseReason: "Settled" });
    expect(released?.releasedAt).toBeTruthy();
    // Again: unchanged, still released.
    expect(await store.releaseLegalHold({ id: other.id, releasedBy: "x", reason: "again", releasedAt: NOW })).toMatchObject({ releasedBy: "admin@example.com" });
    expect(await store.releaseLegalHold({ id: "missing", releasedBy: "x", reason: "r", releasedAt: NOW })).toBeNull();
    expect((await store.listLegalHolds({ status: "released" })).map((h) => h.id)).toEqual([other.id]);
    expect(await store.getLegalHold("missing")).toBeNull();
  });

  it("a project hold keeps every retention table's rows of the project past their age; a release lets the next purge take them", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "Held" });
    await store.upsertProject({ id: "other", name: "Free" });
    await store.upsertWorkflow(workflow("wf", "proj"));
    await store.upsertWorkflow(workflow("wf-free", "other"));
    const tables = Object.keys(ANCHOR_COLUMNS) as Array<keyof typeof ANCHOR_COLUMNS>;
    for (const table of tables) {
      await sql().run(insert(table, "held", OLD));
      await sql().run(insert(table, "free", OLD));
      const nameColumn = NAME_COLUMN[table] ?? "id";
      const set = (tag: string, values: Record<string, string>) =>
        sql().run(
          `UPDATE ${table} SET ${ANCHOR_COLUMNS[table].map((column) => `${column} = '${values[column]}'`).join(", ")} WHERE ${nameColumn} = '${tag}'`
        );
      await set("held", { workflow_id: "wf", project_id: "proj", execution_id: "run-held", namespace: "proj:wf:n1" });
      await set("free", { workflow_id: "wf-free", project_id: "other", execution_id: "run-free", namespace: "other:wf-free:n1" });
    }
    const placed = await hold(store, "project", "proj");
    for (const table of tables) {
      expect(await store.countRetentionDue(table, { before: CUT, cap: 100 }), table).toBe(1);
      expect(await store.pruneRetentionTable(table, { before: CUT, limit: 100 }), table).toBe(1);
      expect(await names(table, NAME_COLUMN[table] ?? "id"), table).toEqual(["held"]);
    }
    await release(store, placed.id);
    for (const table of tables) {
      expect(await store.pruneRetentionTable(table, { before: CUT, limit: 100 }), table).toBe(1);
      expect(await names(table, NAME_COLUMN[table] ?? "id"), table).toEqual([]);
    }
  });

  it("a workflow hold and a runs hold keep their rows; agent memory under the workflow's namespaces too", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "P" });
    await store.upsertWorkflow(workflow("wf-h", "proj"));
    await store.upsertWorkflow(workflow("wf-x", "proj"));
    const seed = async (statement: string) => await sql().run(statement);
    for (const [tag, wf] of [["a", "wf-h"], ["b", "wf-x"], ["c", "wf-x"]] as const) {
      await seed(insert("execution_history", tag, OLD));
      await sql().run(`UPDATE execution_history SET workflow_id = ? WHERE id = ?`, wf, tag);
      await seed(insert("mcp_tool_calls", `tc-${tag}`, OLD));
      await sql().run(`UPDATE mcp_tool_calls SET workflow_id = ?, execution_id = ? WHERE id = ?`, wf, tag, `tc-${tag}`);
    }
    for (const [tag, ns] of [
      ["legacy", "wf-h:n1"],
      ["scoped", "proj:wf-h:n1"],
      ["sibling", "proj:wf-x:n1"],
      ["prefix", "wf-hh:n1"]
    ] as const) {
      await seed(insert("session_memory", tag, OLD));
      await sql().run(`UPDATE session_memory SET namespace = ? WHERE session_id = ?`, ns, tag);
    }
    await hold(store, "workflow", "wf-h");
    await hold(store, "runs", null, [{ kind: "execution", rowId: "c" }]);
    expect(await store.pruneRetentionTable("execution_history", { before: CUT, limit: 100 })).toBe(1);
    expect(await names("execution_history")).toEqual(["a", "c"]);
    expect(await store.pruneRetentionTable("mcp_tool_calls", { before: CUT, limit: 100 })).toBe(1);
    expect(await names("mcp_tool_calls")).toEqual(["tc-a", "tc-c"]);
    expect(await store.pruneRetentionTable("session_memory", { before: CUT, limit: 100 })).toBe(2);
    expect(await names("session_memory", "session_id")).toEqual(["legacy", "scoped"]);
  });

  it("eval runs, captured runs and rule simulations a hold keeps survive their purges", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-e", "default"));
    await store.createEvalDataset({ id: "ds", name: "Set", workflowId: "wf-e" });
    await store.createEvalDataset({ id: "ds2", name: "Other", workflowId: "wf-o" });
    // Oldest first; the newest of each set stays anyway.
    for (const [id, set] of [["e1", "ds"], ["e2", "ds"], ["o1", "ds2"], ["o2", "ds2"], ["e-new", "ds"], ["o-new", "ds2"]] as const) {
      await store.createEvalRun({ id, datasetId: set, workflowId: set === "ds" ? "wf-e" : "wf-o", kind: "eval", status: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await store.recordEvalResult({ id: "res-o1", runId: "o1", fixtureId: "f", status: "pass", executionId: "run-o1" } as never);
    await hold(store, "workflow", "wf-e");
    await hold(store, "runs", null, [{ kind: "execution", rowId: "run-o1" }]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await store.pruneEvalRuns({ before: future })).toBe(1);
    expect((await store.listEvalRuns()).map((r) => r.id).sort()).toEqual(["e-new", "e1", "e2", "o-new", "o1"]);

    // Captured runs: one held by an item, one by its workflow, one free.
    for (const [id, wf] of [["cap-item", "wf-c"], ["cap-wf", "wf-e"], ["cap-free", "wf-c"]] as const) {
      await store.saveReplayRecording({
        id, workflowId: wf, projectId: null, name: id, notes: null, sourceExecutionId: null, sourceTriggerType: "manual", sourceStatus: "success",
        workflowHash: "h", workflowSavedVersion: null, capturedWorkflowJson: "{}", inputJson: null, nodeOutputsJson: "{}", factsJson: "{}",
        mcpCassetteJson: null, capabilities: { mcp: "none", models: "live", memory: "empty", workflowSource: "captured" }, bytes: 10, truncated: false,
        createdAt: OLD, createdBy: null, status: "candidate", capturedAt: OLD
      } as never);
    }
    await hold(store, "subject", null, [{ kind: "recording", rowId: "cap-item" }]);
    expect((await store.oldestReplayCaptures("wf-c", 10)).map((c) => c.id)).toEqual(["cap-free"]);
    expect(await store.oldestReplayCaptureIds("wf-c", 10)).toEqual(["cap-free"]);
    expect(await store.pruneReplayCaptures(CUT)).toBe(1);
    expect((await names("replay_recordings")).sort()).toEqual(["cap-item", "cap-wf"]);

    // Simulations: a simulation whose finished job is held stays with that job.
    await store.createEvalDataset({ id: "sim-ds", name: "Sim", workflowId: "wf-s" });
    await store.createEvalRun({ id: "job-held", datasetId: "sim-ds", workflowId: "wf-e", kind: "replay", status: "completed" });
    await store.createEvalRun({ id: "job-free", datasetId: "sim-ds", workflowId: "wf-s", kind: "replay", status: "completed" });
    const sim = (id: string, jobIds: string[]) => ({
      id, profileId: "p", sourceKind: "draft", sourceVersion: null, simulatedHash: "h", baseVersion: null, jobIds, summary: null,
      status: "completed", error: null, createdAt: OLD, createdBy: null, createdByUserId: null, finishedAt: OLD
    });
    await store.insertGuardSimulation(sim("sim-held", ["job-held"]) as never);
    await store.insertGuardSimulation(sim("sim-free", ["job-free"]) as never);
    expect(await store.pruneGuardSimulations({ before: CUT })).toBe(1);
    expect(await store.getGuardSimulation("sim-held")).not.toBeNull();
    expect(await store.getEvalRun("job-held")).not.toBeNull();
    expect(await store.getGuardSimulation("sim-free")).toBeNull();
    expect(await store.getEvalRun("job-free")).toBeNull();
  });

  it("deletes that check holds refuse with LegalHoldError naming the hold, and go through once it is released", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "proj", name: "P" });
    await store.upsertWorkflow(workflow("wf-d", "proj"));
    const projectHold = await hold(store, "project", "proj");
    const refused = await store.deleteWorkflow("wf-d").then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(LegalHoldError);
    expect((refused as LegalHoldError).holds).toEqual([{ id: projectHold.id, name: projectHold.name }]);
    expect((refused as LegalHoldError).message).toContain(projectHold.name);
    expect(await store.getWorkflow("wf-d")).not.toBeNull();
    await release(store, projectHold.id);

    // A run of the workflow under a runs hold keeps the whole workflow.
    await store.saveExecutionHistory({ id: "run-d", workflowId: "wf-d", status: "success", startedAt: OLD });
    const runHold = await hold(store, "runs", null, [{ kind: "execution", rowId: "run-d" }]);
    await expect(store.deleteWorkflow("wf-d")).rejects.toBeInstanceOf(LegalHoldError);
    await release(store, runHold.id);
    expect(await store.deleteWorkflow("wf-d")).toBe(true);
    expect(await store.getExecutionHistory("run-d")).toBeNull();

    // A project delete: refused under a project hold.
    const again = await hold(store, "project", "proj");
    await expect(store.deleteProject("proj")).rejects.toBeInstanceOf(LegalHoldError);
    await release(store, again.id);
    expect(await store.deleteProject("proj")).toBe(true);

    // Golden set, case, golden run and cassette.
    await store.createEvalDataset({ id: "gs", name: "Set", workflowId: "wf-g" });
    await store.createEvalFixture({ id: "case", datasetId: "gs", name: "Case", input: {} });
    const caseHold = await hold(store, "subject", null, [{ kind: "fixture", rowId: "case" }]);
    await expect(store.deleteEvalFixture("case")).rejects.toBeInstanceOf(LegalHoldError);
    await expect(store.deleteEvalDataset("gs")).rejects.toBeInstanceOf(LegalHoldError);
    expect(await store.getEvalFixture("case")).not.toBeNull();
    await release(store, caseHold.id);
    expect(await store.deleteEvalFixture("case")).toBe(true);
    expect(await store.deleteEvalDataset("gs")).toBe(true);

    await sql().run(insert("mcp_cassettes", "cas", OLD));
    const cassetteHold = await hold(store, "workflow", "wf");
    await expect(store.deleteMcpCassette("cas")).rejects.toBeInstanceOf(LegalHoldError);
    await release(store, cassetteHold.id);
    expect(await store.deleteMcpCassette("cas")).toBe(true);
  });

  it("a data-subject delete leaves a held row and names the hold", async () => {
    const store = ctx.store();
    await store.saveExecutionHistory({ id: "run-s", workflowId: "wf-s", status: "success", startedAt: OLD });
    const placed = await hold(store, "subject", null, [{ kind: "execution", rowId: "run-s" }]);
    const outcome = await store.deleteSubjectRow("execution", "run-s");
    expect(outcome).toEqual({ deleted: false, cascaded: [], heldBy: [{ id: placed.id, name: placed.name }] });
    expect(await store.getExecutionHistory("run-s")).not.toBeNull();
    await release(store, placed.id);
    expect((await store.deleteSubjectRow("execution", "run-s")).deleted).toBe(true);
  });

  it("the session tool cache keeps every call of a held session past its cap", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-t", "default"));
    await hold(store, "workflow", "wf-t");
    for (let index = 0; index < 402; index += 1) {
      await store.saveSessionToolCall({ namespace: "wf-t:n1", sessionId: "s", toolName: "t", args: {}, output: index });
    }
    expect(Number((await sql().get<{ n: number }>(`SELECT COUNT(*) AS n FROM session_tool_cache WHERE namespace = 'wf-t:n1'`))?.n)).toBe(402);
  }, 60_000);

  it("rows of tables a hold cannot name stay purgeable (the purge log)", async () => {
    const store = ctx.store();
    expect(Object.keys(RETENTION_TABLES)).toContain("retention_runs");
    await sql().run(insert("retention_runs", "r1", OLD));
    await hold(store, "project", "default");
    expect(await store.pruneRetentionTable("retention_runs", { before: CUT, limit: 10 })).toBe(1);
  });
});
