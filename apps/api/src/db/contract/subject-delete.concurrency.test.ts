/**
 * 13.3 — data-subject deletion on Postgres, concurrent with a retention purge, a workflow delete and a staff
 * pseudonymisation of the same rows (several connections). Every operation finishes (no deadlock, no lock error), no
 * row a deletion removed leaves a side row behind, and every run the deletion removed has its tombstone. Skipped
 * without TEST_POSTGRES_URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, type TestStore } from "../../test-support/test-store.js";
import { testSql } from "../../test-support/test-sql.js";

const enabled = Boolean(testPostgresUrl());
if (!enabled) noticePostgresSkipped("data-subject deletion concurrency");

const OLD = "2001-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";
const RUNS = 120;
const STAFF = "staff@example.com";

describe.skipIf(!enabled)("data-subject deletion against a purge, a workflow delete and a staff erasure (Postgres)", () => {
  let test: TestStore;

  beforeEach(async () => {
    test = await createTestStore({ kind: "postgres" });
  }, 60_000);

  afterEach(async () => {
    await test?.cleanup();
  }, 60_000);

  it("all finish without a deadlock and leave no orphan side rows", async () => {
    const store = test.store;
    const sql = testSql(store);
    await store.upsertWorkflow({ id: "wf", name: "W", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], projectId: "default" } as never);
    for (let index = 0; index < RUNS; index += 1) {
      const id = `run-${index}`;
      // Old runs (the purge takes them) with their side rows; triggered by the staff member.
      await sql.run(
        `INSERT INTO execution_history (id, workflow_id, status, started_at, triggered_by) VALUES (?, 'wf', 'success', ?, ?)`,
        id, OLD, STAFF
      );
      await sql.run(
        `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, requested_by, created_at, updated_at)
         VALUES (?, ?, 'wf', 'default', 'gate', 'approval_gate', 'approved', '{}', ?, ?, ?)`,
        `appr-${index}`, id, STAFF, OLD, OLD
      );
      await sql.run(
        `INSERT INTO mcp_tool_calls (id, execution_id, workflow_id, node_id, adapter_id, tool_name, started_at, ok, created_at)
         VALUES (?, ?, 'wf', 'n', 'http-mcp', 't', ?, 1, ?)`,
        `call-${index}`, id, OLD, OLD
      );
      await sql.run(
        `INSERT INTO usage_events (id, execution_id, workflow_id, user_email, status, total_tokens, cost_usd, created_at) VALUES (?, ?, 'wf', ?, 'success', 10, 0.25, ?)`,
        `ue-${index}`, id, STAFF, OLD
      );
    }
    const totalBefore = Number((await sql.all<{ t: string | number }>("SELECT COALESCE(SUM(total_tokens), 0) AS t FROM usage_events"))[0]!.t);

    const erasedAt = new Date().toISOString();
    const deleted: string[] = [];
    const subjectDeletes = (async () => {
      // Every other run, newest first, as a deletion walks its found rows.
      for (let index = RUNS - 1; index >= 0; index -= 2) {
        const id = `run-${index}`;
        const outcome = await store.deleteSubjectRow("execution", id, { requestId: "dsr-1", erasedAt });
        if (outcome.deleted) deleted.push(id);
      }
    })();
    const purge = (async () => {
      let removed = 0;
      for (;;) {
        const step = await store.pruneRetentionTable("execution_history", { before: CUT, limit: 10 });
        removed += step;
        if (step === 0) return removed;
      }
    })();
    const sidePurge = (async () => {
      for (const table of ["approval_requests", "mcp_tool_calls"] as const) {
        while ((await store.pruneRetentionTable(table, { before: CUT, limit: 10 })) > 0) {
          // Batches until the table holds nothing old.
        }
      }
    })();
    const workflowDelete = store.deleteWorkflow("wf").then(
      (result) => result,
      (error: unknown) => (error as { code?: string }).code ?? String(error)
    );
    const staff = store.pseudonymiseStaff({ emails: [STAFF], pseudonym: "erased-user-00000000", batch: 7 });

    const settled = await Promise.allSettled([subjectDeletes, purge, sidePurge, workflowDelete, staff]);
    const failures = settled.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);

    // No orphan side rows of a run a deletion removed, and each has its tombstone.
    for (const id of deleted) {
      expect(await sql.all("SELECT id FROM approval_requests WHERE execution_id = ?", id)).toEqual([]);
      expect(await sql.all("SELECT id FROM mcp_tool_calls WHERE execution_id = ?", id)).toEqual([]);
      expect(await sql.all("SELECT row_id FROM erasure_tombstones WHERE kind = 'run' AND row_id = ?", id)).toHaveLength(1);
    }
    // Usage rows are never deleted by either (totals and budgets keep their numbers).
    expect(Number((await sql.all<{ t: string | number }>("SELECT COALESCE(SUM(total_tokens), 0) AS t FROM usage_events"))[0]!.t)).toBe(totalBefore);
    // The staff member's email is gone from every row left; a later pass finds nothing (the first may have skipped locked rows).
    await store.pseudonymiseStaff({ emails: [STAFF], pseudonym: "erased-user-00000000" });
    expect(await sql.all("SELECT id FROM execution_history WHERE triggered_by = ?", STAFF)).toEqual([]);
    expect(await sql.all("SELECT id FROM approval_requests WHERE requested_by = ?", STAFF)).toEqual([]);
    expect(await sql.all("SELECT id FROM usage_events WHERE user_email = ?", STAFF)).toEqual([]);
  }, 120_000);
});
