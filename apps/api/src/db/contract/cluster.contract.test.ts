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
