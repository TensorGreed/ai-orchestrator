/**
 * Phase 13.1 — the dead-executor reconcile reads which runs the queue holds before it opens the transaction that locks
 * owner rows. An owner that ages past the window (or is claimed) between that read and the transaction must wait for
 * the next pass: failing it there would skip its queue check and fail a run a live queue job drives. The gap is
 * widened on purpose here by pausing right after the queue read. Postgres only.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestStore, noticePostgresSkipped, testPostgresUrl, testStorePool, type TestStore } from "../../test-support/test-store.js";
import { failRunsOwnedBy, reconcileDeadExecutorRuns } from "./cluster.js";
import { createPgContext, type PgContext } from "./context.js";

const run = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("cluster reconcile race");

/** A context that runs `pause` once, right after the reconcile's queue read (the one query naming execution_queue). */
function pausingAfterQueueRead(ctx: PgContext, pause: () => Promise<void>): PgContext {
  let paused = false;
  return {
    ...ctx,
    query: async <T extends object>(sql: string, params?: unknown[]): Promise<T[]> => {
      const rows = await ctx.query<T>(sql, params);
      if (!paused && sql.includes("execution_queue")) {
        paused = true;
        await pause();
      }
      return rows;
    }
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

run("cluster reconcile on Postgres: owners that change after the queue read", () => {
  let primary: TestStore | undefined;
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  async function setup() {
    primary = await createTestStore({ kind: "postgres" });
    pool = testStorePool(primary);
    const store = primary.store;
    const running = async (id: string) =>
      store.saveExecutionHistory({ id, workflowId: "wf", status: "running", startedAt: new Date(Date.now() - 1_000).toISOString() });
    return { store, ctx: createPgContext(pool, store), running };
  }

  it("does not fail a queue-driven run whose owner ages past the window after the queue read", async () => {
    const { store, ctx, running } = await setup();
    await running("r-old");
    await running("r-resumed");
    await store.claimClusterRunOwner({ executionId: "r-old", instanceId: "gone" });
    await sleep(400);
    // An approval resume: a live queue job drives the run under another id.
    await store.enqueueExecution({
      id: "r-resumed:req-1:1",
      workflowId: "wf",
      payload: { executionId: "r-resumed", workflowId: "wf", triggerType: "approval_resume", resume: { executionId: "r-resumed" } },
      scheduledAt: new Date().toISOString()
    });
    await store.claimClusterRunOwner({ executionId: "r-resumed", instanceId: "gone" });
    // Only r-old is past the 200 ms window at the candidate read; r-resumed passes it during the pause.
    const failed = await reconcileDeadExecutorRuns(pausingAfterQueueRead(ctx, () => sleep(400)), { error: "lost", deadAfterMs: 200, selfId: "self" });
    expect(failed.map((row) => row.id)).toEqual(["r-old"]);
    expect((await store.getExecutionHistory("r-resumed"))!.status).toBe("running");
    // The next pass checks it against the queue and leaves it to the queue's lease.
    expect(await reconcileDeadExecutorRuns(ctx, { error: "lost", deadAfterMs: 200, selfId: "self" })).toEqual([]);
    expect((await store.getExecutionHistory("r-resumed"))!.status).toBe("running");
  });

  it("leaves an owner claimed after the queue read for the next restart pass", async () => {
    const { store, ctx, running } = await setup();
    await running("r-first");
    await running("r-late");
    await store.claimClusterRunOwner({ executionId: "r-first", instanceId: "fixed" });
    await store.enqueueExecution({ id: "r-late:req-2:1", workflowId: "wf", payload: { executionId: "r-late", workflowId: "wf" }, scheduledAt: new Date().toISOString() });
    const failed = await failRunsOwnedBy(
      pausingAfterQueueRead(ctx, () => store.claimClusterRunOwner({ executionId: "r-late", instanceId: "fixed" })),
      { instanceId: "fixed", error: "restarted" }
    );
    expect(failed.map((row) => row.id)).toEqual(["r-first"]);
    expect((await store.getExecutionHistory("r-late"))!.status).toBe("running");
    expect(await failRunsOwnedBy(ctx, { instanceId: "fixed", error: "restarted" })).toEqual([]);
    expect((await store.getExecutionHistory("r-late"))!.status).toBe("running");
  });
});
