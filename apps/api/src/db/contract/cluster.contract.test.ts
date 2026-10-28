/**
 * Phase 13.1 — store contract: the cluster registry and inline-run owners, on both stores. Liveness is judged
 * on the store's clock (the database's on Postgres), so the tests wait for a heartbeat to age rather than fake a time.
 */
import { expect, it } from "vitest";
import type { ClusterInstanceHeartbeat, Store } from "../store.js";
import { describeStoreContract } from "../../test-support/test-store.js";

function beat(id: string, overrides: Partial<ClusterInstanceHeartbeat> = {}): ClusterInstanceHeartbeat {
  return {
    id,
    workerMode: "all",
    haEnabled: true,
    isLeader: false,
    pools: ["default"],
    concurrency: 5,
    running: 0,
    appVersion: "1.2.3",
    schemaVersion: 7,
    capabilities: ["bus-v1"],
    hostname: "host-a",
    busConnected: true,
    startedAt: "2026-10-28T10:00:00.000Z",
    ...overrides
  };
}

async function until<T>(read: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function runningRun(store: Store, id: string): Promise<void> {
  await store.saveExecutionHistory({ id, workflowId: "wf", status: "running", startedAt: new Date(Date.now() - 1_000).toISOString() });
}

describeStoreContract("store contract: cluster registry", (ctx) => {
  it("upserts a heartbeat, reads every field back and judges liveness", async () => {
    const store = ctx.store();
    await store.heartbeatClusterInstance(beat("i1"));
    await store.heartbeatClusterInstance(beat("i2", { workerMode: "worker", haEnabled: false, isLeader: true, pools: ["default", "gpu"], concurrency: null, running: 3, appVersion: null, schemaVersion: null, capabilities: [], hostname: "host-b", busConnected: false }));
    const listed = await store.listClusterInstances({ liveWithinMs: 60_000 });
    expect(listed.map((row) => row.id).sort()).toEqual(["i1", "i2"]);
    const i2 = listed.find((row) => row.id === "i2")!;
    expect(i2).toMatchObject({
      workerMode: "worker", haEnabled: false, isLeader: true, pools: ["default", "gpu"], concurrency: null, running: 3, appVersion: null,
      schemaVersion: null, capabilities: [], hostname: "host-b", busConnected: false, startedAt: "2026-10-28T10:00:00.000Z", live: true
    });
    expect(listed.find((row) => row.id === "i1")).toMatchObject({ haEnabled: true, concurrency: 5, capabilities: ["bus-v1"], busConnected: true, live: true });
    expect(Date.parse(i2.heartbeatAt)).toBeGreaterThan(Date.now() - 60_000);

    // A second heartbeat updates the row in place.
    await store.heartbeatClusterInstance(beat("i1", { running: 7, isLeader: true }));
    const again = await store.listClusterInstances({ liveWithinMs: 60_000 });
    expect(again).toHaveLength(2);
    expect(again.find((row) => row.id === "i1")).toMatchObject({ running: 7, isLeader: true });

    // Aged past a short window, both are no longer live; pruning removes them.
    await until(async () => (await store.listClusterInstances({ liveWithinMs: 30 })).every((row) => !row.live), "the heartbeats to age");
    await until(async () => (await store.pruneClusterInstances({ olderThanMs: 30 })) === 2, "the prune");
    expect(await store.listClusterInstances({ liveWithinMs: 60_000 })).toEqual([]);
  });

  it("deletes one instance's row", async () => {
    const store = ctx.store();
    await store.heartbeatClusterInstance(beat("gone"));
    await store.heartbeatClusterInstance(beat("kept"));
    await store.deleteClusterInstance("gone");
    await store.deleteClusterInstance("never-there");
    expect((await store.listClusterInstances({ liveWithinMs: 60_000 })).map((row) => row.id)).toEqual(["kept"]);
  });

  it("fails only the running runs of dead instances, skips queued runs and its own, and forgets their owners", async () => {
    const store = ctx.store();
    for (const id of ["r-dead", "r-dead-finished", "r-dead-queued", "r-self", "r-orphan", "r-live"]) await runningRun(store, id);
    // An owner with no registry row at all (pruned, or never registered), claimed before "dead" last beat.
    await store.claimClusterRunOwner({ executionId: "r-orphan", instanceId: "unregistered" });
    await store.heartbeatClusterInstance(beat("dead"));
    await store.heartbeatClusterInstance(beat("self"));
    await store.saveExecutionHistory({ id: "r-dead-finished", workflowId: "wf", status: "success", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    await store.enqueueExecution({ id: "r-dead-queued", workflowId: "wf", payload: {}, scheduledAt: new Date().toISOString() });
    await store.claimClusterRunOwner({ executionId: "r-dead", instanceId: "dead" });
    await store.claimClusterRunOwner({ executionId: "r-dead-finished", instanceId: "dead" });
    await store.claimClusterRunOwner({ executionId: "r-dead-queued", instanceId: "dead" });
    await store.claimClusterRunOwner({ executionId: "r-self", instanceId: "self" });

    // Nothing is stale yet.
    expect(await store.reconcileDeadExecutorRuns({ error: "lost", deadAfterMs: 60_000, selfId: "self" })).toEqual([]);

    // "dead" stops beating; "live" keeps beating; the window is short.
    await store.heartbeatClusterInstance(beat("live"));
    await store.claimClusterRunOwner({ executionId: "r-live", instanceId: "live" });
    await until(async () => (await store.listClusterInstances({ liveWithinMs: 40 })).some((row) => row.id === "dead" && !row.live), "dead to age");
    await store.heartbeatClusterInstance(beat("live"));
    const failed = await store.reconcileDeadExecutorRuns({ error: "interrupted: lost", deadAfterMs: 40, selfId: "self" });
    expect(failed.map((run) => [run.id, run.instanceId]).sort()).toEqual([
      ["r-dead", "dead"],
      ["r-orphan", "unregistered"]
    ]);
    expect(failed[0]!.workflowId).toBe("wf");
    expect(await store.getExecutionHistory("r-dead")).toMatchObject({ status: "error", error: "interrupted: lost" });
    expect((await store.getExecutionHistory("r-dead"))!.completedAt).toBeTruthy();
    expect((await store.getExecutionHistory("r-dead-finished"))!.status).toBe("success");
    expect((await store.getExecutionHistory("r-dead-queued"))!.status).toBe("running");
    expect((await store.getExecutionHistory("r-self"))!.status).toBe("running");
    expect((await store.getExecutionHistory("r-live"))!.status).toBe("running");
    // The dead owners are forgotten, so a second pass does nothing.
    expect(await store.reconcileDeadExecutorRuns({ error: "x", deadAfterMs: 40, selfId: "self" })).toEqual([]);
  });

  it("skips a run a live queue job carries under another id (an approval resume), keyed on the payload's execution id", async () => {
    const store = ctx.store();
    // Ids with LIKE wildcards and a quote, so the preselection must escape them.
    const resumed = 'r-res_1%"q';
    const lookalike = "r-res-1xq";
    for (const id of [resumed, lookalike, "r-plain"]) await runningRun(store, id);
    await store.enqueueExecution({
      id: `${resumed}:req-1:1730000000000`,
      workflowId: "wf",
      payload: { executionId: resumed, workflowId: "wf", triggerType: "approval_resume", resume: { executionId: resumed } },
      scheduledAt: new Date().toISOString()
    });
    for (const id of [resumed, lookalike, "r-plain"]) await store.claimClusterRunOwner({ executionId: id, instanceId: "gone" });
    const failed = await until(async () => {
      const result = await store.reconcileDeadExecutorRuns({ error: "lost", deadAfterMs: 20, selfId: "self" });
      return result.length > 0 ? result : null;
    }, "the unregistered owner's runs to age");
    expect(failed.map((run) => run.id).sort()).toEqual([lookalike, "r-plain"].sort());
    expect((await store.getExecutionHistory(resumed))!.status).toBe("running");
    expect((await store.getExecutionHistory(lookalike))!.status).toBe("error");

    // The same for a restarted instance's own runs.
    await runningRun(store, "r-mine-resumed");
    await store.enqueueExecution({ id: "r-mine-resumed:req-2:1", workflowId: "wf", payload: { executionId: "r-mine-resumed", workflowId: "wf" }, scheduledAt: new Date().toISOString() });
    await store.claimClusterRunOwner({ executionId: "r-mine-resumed", instanceId: "fixed" });
    expect(await store.failRunsOwnedBy({ instanceId: "fixed", error: "restarted" })).toEqual([]);
    expect((await store.getExecutionHistory("r-mine-resumed"))!.status).toBe("running");
  });

  it("re-assigns a run's owner, and releases it only for the owner named", async () => {
    const store = ctx.store();
    await runningRun(store, "r1");
    await store.claimClusterRunOwner({ executionId: "r1", instanceId: "a" });
    await store.claimClusterRunOwner({ executionId: "r1", instanceId: "b" });
    await store.releaseClusterRunOwner({ executionId: "r1", instanceId: "a" });
    // Still owned by b, which has no registry row: once old enough, it is reconciled as b's.
    await until(async () => (await store.reconcileDeadExecutorRuns({ error: "x", deadAfterMs: 20, selfId: "self" })).length === 1, "b's run to be failed");
    await runningRun(store, "r2");
    await store.claimClusterRunOwner({ executionId: "r2", instanceId: "b" });
    await store.releaseClusterRunOwner({ executionId: "r2", instanceId: "b" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await store.reconcileDeadExecutorRuns({ error: "x", deadAfterMs: 20, selfId: "self" })).toEqual([]);
  });

  it("fails the running runs recorded under one instance id (its previous process) and forgets them", async () => {
    const store = ctx.store();
    for (const id of ["mine-1", "mine-done", "mine-queued", "theirs"]) await runningRun(store, id);
    await store.saveExecutionHistory({ id: "mine-done", workflowId: "wf", status: "success", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    await store.enqueueExecution({ id: "mine-queued", workflowId: "wf", payload: {}, scheduledAt: new Date().toISOString() });
    for (const id of ["mine-1", "mine-done", "mine-queued"]) await store.claimClusterRunOwner({ executionId: id, instanceId: "fixed-id" });
    await store.claimClusterRunOwner({ executionId: "theirs", instanceId: "other" });
    const failed = await store.failRunsOwnedBy({ instanceId: "fixed-id", error: "restarted" });
    expect(failed).toEqual([{ id: "mine-1", workflowId: "wf", instanceId: "fixed-id" }]);
    expect(await store.getExecutionHistory("mine-1")).toMatchObject({ status: "error", error: "restarted" });
    expect((await store.getExecutionHistory("mine-queued"))!.status).toBe("running");
    expect((await store.getExecutionHistory("theirs"))!.status).toBe("running");
    expect(await store.failRunsOwnedBy({ instanceId: "fixed-id", error: "again" })).toEqual([]);
    // The other instance's owner row is untouched: once it is old and unregistered it is reconciled as its own.
    await until(async () => (await store.reconcileDeadExecutorRuns({ error: "x", deadAfterMs: 20, selfId: "fixed-id" })).some((run) => run.id === "theirs"), "the other's run");
  });

  it("a final write fenced with the reconcile's mark never replaces a run the reconcile failed", async () => {
    const store = ctx.store();
    const mark = "interrupted: the instance running this run stopped responding";
    const final = (id: string, status: string, options: { unlessCanceled?: boolean; unlessInterruptedWith?: string } = { unlessCanceled: true, unlessInterruptedWith: mark }) =>
      store.saveExecutionHistory({ id, workflowId: "wf", status, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }, options);
    for (const id of ["f-taken", "f-kept"]) await runningRun(store, id);
    await store.claimClusterRunOwner({ executionId: "f-taken", instanceId: "silent" });
    await until(async () => (await store.reconcileDeadExecutorRuns({ error: mark, deadAfterMs: 20, selfId: "leader" })).length === 1, "the reconcile");
    // The silent instance's late result, whatever it is, is refused.
    expect(await final("f-taken", "success")).toBe(false);
    expect(await final("f-taken", "canceled")).toBe(false);
    expect(await final("f-taken", "error")).toBe(false);
    expect(await store.getExecutionHistory("f-taken")).toMatchObject({ status: "error", error: mark });
    // A run the reconcile never touched is written as before, and the fence alone (no other guard) works too.
    expect(await final("f-kept", "success")).toBe(true);
    expect((await store.getExecutionHistory("f-kept"))!.status).toBe("success");
    expect(await final("f-kept", "success", { unlessInterruptedWith: mark })).toBe(true);
    // The canceled guard still applies beside it.
    await runningRun(store, "f-canceled");
    await final("f-canceled", "canceled", {});
    expect(await final("f-canceled", "success")).toBe(false);
    expect(await final("f-canceled", "canceled")).toBe(true);
  });

  it("a reconcile racing the owner's final writes: each run ends exactly one way", async () => {
    const store = ctx.store();
    const mark = "interrupted: raced";
    const ids = Array.from({ length: 24 }, (_, i) => `race-${i}`);
    for (const id of ids) {
      await runningRun(store, id);
      await store.claimClusterRunOwner({ executionId: id, instanceId: "racer" });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const [reconciled, written] = await Promise.all([
      store.reconcileDeadExecutorRuns({ error: mark, deadAfterMs: 20, selfId: "leader" }),
      Promise.all(
        ids.map(async (id) =>
          await store.saveExecutionHistory(
            { id, workflowId: "wf", status: "success", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() },
            { unlessCanceled: true, unlessInterruptedWith: mark }
          )
        )
      )
    ]);
    const failed = new Set(reconciled.map((run) => run.id));
    for (const [index, id] of ids.entries()) {
      const record = (await store.getExecutionHistory(id))!;
      if (failed.has(id)) {
        expect(written[index], id).toBe(false);
        expect(record).toMatchObject({ status: "error", error: mark });
      } else {
        expect(written[index], id).toBe(true);
        expect(record.status).toBe("success");
      }
    }
  });

  it("lists which of the given runs were canceled", async () => {
    const store = ctx.store();
    await runningRun(store, "a");
    await runningRun(store, "b");
    await store.saveExecutionHistory({ id: "b", workflowId: "wf", status: "canceled", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    await store.saveExecutionHistory({ id: "c", workflowId: "wf", status: "canceled", startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    expect(await store.listCanceledExecutionIds([])).toEqual([]);
    expect((await store.listCanceledExecutionIds(["a", "b", "missing"])).sort()).toEqual(["b"]);
  });
});
