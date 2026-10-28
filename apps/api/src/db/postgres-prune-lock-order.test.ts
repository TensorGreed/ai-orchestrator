/**
 * Postgres: retention pruning never waits for a row lock, so it cannot deadlock with a workflow delete (prune.ts).
 * Two stores (two pools) on one schema: a builder's workflow delete is paused inside its transaction at a chosen
 * query, holding the rows it has reached, while the other store runs the prune jobs. Each prune skips the rows the
 * delete holds and finishes; the delete then completes, and a later prune takes what was skipped.
 *
 * The first test is the deadlock the old execution-history prune hit: it deleted cassettes and guard events and then
 * waited for an approval request the delete held, while the delete went on to wait for those cassettes. Postgres
 * aborted one of them (deadlock detected). Postgres only (skipped without TEST_POSTGRES_URL). SQLite runs each store
 * write synchronously in one process, so a prune and a delete never interleave there.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Workflow } from "@ai-orchestrator/shared";
import type { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";
import { deleteUnlockedInBatches } from "./postgres/prune.js";
import { createTestStore, noticePostgresSkipped, openTestStoreTwin, testPostgresUrl, testStorePool, type TestStore } from "../test-support/test-store.js";
import { delay, limitLockWaits, pauseAfter, resumeAllPaused, stillPending } from "../test-support/pg-interleave.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("postgres prune lock order");

const OLD = "2001-01-01T00:00:00.000Z";
const CUT = "2020-01-01T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(OLD) + minutes * 60_000).toISOString();

/** Old rows of `wf` in every table a prune job removes (history only with `history`). */
function oldRows(wf: string, options: { history?: boolean; jobs?: boolean } = {}): string[] {
  const rows = [
    `INSERT INTO approval_requests (id, execution_id, workflow_id, project_id, node_id, kind, status, spec_json, created_at, updated_at)
       VALUES ('req-${wf}', 'run-${wf}', '${wf}', 'default', 'gate', 'approval_gate', 'approved', '{}', '${OLD}', '${OLD}')`,
    `INSERT INTO mcp_cassettes (id, execution_id, workflow_id, cassette_json, created_at) VALUES ('cas-${wf}', 'run-${wf}', '${wf}', '{}', '${OLD}')`,
    `INSERT INTO guard_events (id, verdict_id, execution_id, workflow_id, node_id, placement, channel, requested_action, effective_action, verdict_action,
       profile_id, profile_version, profile_hash, created_at)
       VALUES ('ge-${wf}', 'v', 'run-${wf}', '${wf}', 'n', 'input', 'prompt', 'allow', 'allow', 'allow', 'p', 1, 'h', '${OLD}')`
  ];
  if (options.history) {
    rows.push(`INSERT INTO execution_history (id, workflow_id, status, started_at) VALUES ('run-${wf}', '${wf}', 'success', '${OLD}')`);
  }
  if (options.jobs) {
    rows.push(
      `INSERT INTO replay_recordings (id, workflow_id, name, source_status, workflow_hash, captured_workflow_json, node_outputs_json, facts_json, capabilities_json, bytes, created_at, status, captured_at)
         VALUES ('cap-${wf}', '${wf}', 'Capture', 'success', 'h', '{}', '{}', '{}', '{}', 2, '${OLD}', 'candidate', '${OLD}')`,
      // Three finished jobs of one set: the newest stays, the two before it go.
      ...[1, 2, 3].flatMap((n) => [
        `INSERT INTO eval_runs (id, dataset_id, workflow_id, status, started_at, created_at) VALUES ('job-${wf}-${n}', 'set-${wf}', '${wf}', 'completed', '${at(n)}', '${at(n)}')`,
        `INSERT INTO eval_results (id, run_id, fixture_id, status, created_at) VALUES ('res-${wf}-${n}', 'job-${wf}-${n}', 'fix', 'pass', '${at(n)}')`
      ]),
      `INSERT INTO eval_runs (id, dataset_id, workflow_id, status, started_at, created_at) VALUES ('sim-job-${wf}', 'sim-set-${wf}', '${wf}', 'completed', '${OLD}', '${OLD}')`,
      `INSERT INTO eval_results (id, run_id, fixture_id, status, created_at) VALUES ('sim-res-${wf}', 'sim-job-${wf}', 'fix', 'pass', '${OLD}')`,
      `INSERT INTO guard_simulations (id, profile_id, source_kind, simulated_hash, job_ids_json, status, created_at)
         VALUES ('sim-${wf}', 'p', 'draft', 'h', '["sim-job-${wf}"]', 'completed', '${OLD}')`
    );
  }
  return rows;
}

const TABLES = ["execution_history", "approval_requests", "mcp_cassettes", "guard_events", "replay_recordings", "eval_runs", "eval_results", "guard_simulations"] as const;

run("Postgres: retention pruning never waits behind a workflow delete", () => {
  let primary: TestStore | undefined;
  let builderStore: PostgresStore | undefined;
  let sql: Pool | undefined;

  afterEach(async () => {
    resumeAllPaused();
    await sql?.end();
    sql = undefined;
    await builderStore?.close();
    builderStore = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  async function open(): Promise<{ admin: Store; builder: PostgresStore }> {
    primary = await createTestStore({ kind: "postgres" });
    builderStore = await openTestStoreTwin(primary, { maxConnections: 2 });
    sql = testStorePool(primary, { max: 2 });
    limitLockWaits(primary.store as unknown as PostgresStore);
    limitLockWaits(builderStore);
    return { admin: primary.store, builder: builderStore };
  }

  const workflow = (id: string): Workflow =>
    ({ id, name: id, schemaVersion: "1.0.0", workflowVersion: 1, projectId: "default", nodes: [], edges: [] }) as unknown as Workflow;

  async function seed(statements: string[]): Promise<void> {
    for (const statement of statements) await sql!.query(statement);
  }

  /** The ids left in every pruned table that belong to `wf` (by id suffix). */
  async function left(wf: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const table of TABLES) {
      const ids = (await sql!.query<{ id: string }>(`SELECT id FROM ${table} WHERE id LIKE $1 ORDER BY id`, [`%${wf}%`])).rows.map((row) => row.id);
      if (ids.length > 0) out[table] = ids;
    }
    return out;
  }

  /** `promise`'s outcome, or "still waiting" when it has not settled within `ms`. */
  async function within<T>(promise: Promise<T>, ms: number): Promise<{ value?: T; error?: unknown; waiting?: true }> {
    const outcome = await Promise.race([promise.then((value) => ({ value }), (error: unknown) => ({ error })), delay(ms).then(() => ({ waiting: true as const }))]);
    return outcome;
  }

  it("the execution-history prune skips the approval request a delete holds instead of waiting, and neither deadlocks", async () => {
    const { admin, builder } = await open();
    const wf = "wf-prune-dl";
    await admin.upsertWorkflow(workflow(wf));
    // No old history of this workflow: the two meet first on the approval request, then on the cassette.
    await seed(oldRows(wf));
    // The delete stops right after it marked the workflow's approval requests, holding them, before its cassettes.
    const pause = pauseAfter(builder, /SET workflow_deleted_at/);
    const removal = builder.deleteWorkflow(wf);
    removal.catch(() => undefined);
    await pause.reached;

    const prune = admin.pruneExecutionHistory({ before: CUT });
    prune.catch(() => undefined);
    // The old prune held the cassette here and waited for the request: resuming the delete then deadlocked.
    const blocked = await stillPending(prune, 1_000);
    pause.resume();
    const settled = await Promise.allSettled([removal, prune]);
    expect(settled.filter((entry) => entry.status === "rejected").map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([]);
    expect(blocked).toBe(false);
    expect(await removal).toBe(true);
    // The prune took the cassette and guard event; it skipped the request, which the delete kept as the audit trail.
    expect(await left(wf)).toEqual({ approval_requests: [`req-${wf}`] });
    await admin.pruneExecutionHistory({ before: CUT });
    expect(await left(wf)).toEqual({});
  }, 60_000);

  it("no prune job waits for the rows a workflow delete holds; each removes everything else and a later run takes the rest", async () => {
    const { admin, builder } = await open();
    const wf = "wf-prune-held";
    const other = "wf-prune-other";
    for (const id of [wf, other]) {
      await admin.upsertWorkflow(workflow(id));
      await seed(oldRows(id, { history: true, jobs: true }));
    }
    // The delete stops after its last eval_runs delete: it holds every row of the workflow it has reached.
    const pause = pauseAfter(builder, /DELETE FROM eval_runs WHERE workflow_id/);
    const removal = builder.deleteWorkflow(wf);
    removal.catch(() => undefined);
    await pause.reached;

    const outcomes = {
      history: await within(admin.pruneExecutionHistory({ before: CUT }), 5_000),
      evalRuns: await within(admin.pruneEvalRuns({ before: CUT }), 5_000),
      captures: await within(admin.pruneReplayCaptures(CUT), 5_000),
      simulations: await within(admin.pruneGuardSimulations({ before: CUT }), 5_000)
    };
    // Every prune finished while the delete still held its rows. Only the other workflow's rows went (two old jobs).
    expect(outcomes).toEqual({ history: { value: 1 }, evalRuns: { value: 2 }, captures: { value: 1 }, simulations: { value: 2 } });
    expect(await left(other)).toEqual({ eval_runs: [`job-${other}-3`], eval_results: [`res-${other}-3`] });
    // The workflow's own simulation went; its job was held by the delete and stays with it.
    expect(await left(wf)).toMatchObject({ execution_history: [`run-${wf}`], approval_requests: [`req-${wf}`], mcp_cassettes: [`cas-${wf}`], guard_events: [`ge-${wf}`] });

    pause.resume();
    expect(await removal).toBe(true);
    expect(await left(wf)).toEqual({ approval_requests: [`req-${wf}`] });
    await admin.pruneExecutionHistory({ before: CUT });
    expect(await left(wf)).toEqual({});
  }, 60_000);

  it("prunes and deletes of many workflows racing never deadlock", async () => {
    const { admin, builder } = await open();
    const ids = Array.from({ length: 8 }, (_, index) => `wf-prune-race-${index}`);
    for (const id of ids) {
      await admin.upsertWorkflow(workflow(id));
      await seed(oldRows(id, { history: true, jobs: true }));
    }
    const deletes = ids.map((id, index) => (index % 2 === 0 ? builder : admin).deleteWorkflow(id)); // promise-ok: settled together below
    const results = await Promise.allSettled([
      ...deletes,
      admin.pruneExecutionHistory({ before: CUT }),
      builder.pruneEvalRuns({ before: CUT }),
      admin.pruneReplayCaptures(CUT),
      builder.pruneGuardSimulations({ before: CUT }),
      admin.pruneExecutionHistory({ before: CUT })
    ]);
    expect(results.filter((entry) => entry.status === "rejected").map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([]);
    await admin.pruneExecutionHistory({ before: CUT });
    for (const id of ids) expect(await left(id)).toEqual({});
  }, 60_000);

  it("deletes in batches and skips a row another transaction holds", async () => {
    await open();
    for (let index = 0; index < 5; index += 1) {
      await sql!.query(`INSERT INTO mcp_cassettes (id, execution_id, workflow_id, cassette_json, created_at) VALUES ($1, 'run', 'wf', '{}', $2)`, [`cas-batch-${index}`, OLD]);
    }
    const holder = await sql!.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM mcp_cassettes WHERE id = 'cas-batch-2' FOR UPDATE`);
      expect(await deleteUnlockedInBatches(sql!, "mcp_cassettes", "created_at < $1", [CUT], 2)).toBe(4);
      await holder.query("COMMIT");
    } finally {
      holder.release();
    }
    expect((await sql!.query(`SELECT id FROM mcp_cassettes ORDER BY id`)).rows.map((row: { id: string }) => row.id)).toEqual(["cas-batch-2"]);
    expect(await deleteUnlockedInBatches(sql!, "mcp_cassettes", "created_at < $1", [CUT], 2)).toBe(1);
  }, 60_000);
});
