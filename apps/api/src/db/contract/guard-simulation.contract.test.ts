/**
 * Phase 13.1 — store contract: guard simulations (insert, conditional update, list order and paging, the running
 * list, pruning with their replay jobs) and the one-running-simulation index, on SQLite and Postgres.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { isOneRunningSimulationViolation } from "../store-errors.js";

const row = (id: string, overrides: Partial<{ status: string; createdAt: string; profileId: string; jobIds: string[]; detail: Record<string, unknown> | null }> = {}) => ({
  id,
  profileId: overrides.profileId ?? "p",
  sourceKind: "version" as const,
  sourceVersion: 2,
  simulatedHash: "hash",
  baseVersion: 1,
  jobIds: overrides.jobIds ?? [],
  detail: overrides.detail === undefined ? { workflows: ["wf"] } : overrides.detail,
  status: overrides.status ?? "completed",
  createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
  createdBy: "a@example.com",
  createdByUserId: "u1"
});

describeStoreContract("store contract: guard simulations", (ctx) => {
  it("inserts and reads a simulation back with its JSON fields and nulls", async () => {
    const store = ctx.store();
    const created = await store.insertGuardSimulation(row("s1", { status: "running", jobIds: ["j1", "j2"] }));
    expect(created).toEqual({
      id: "s1",
      profileId: "p",
      sourceKind: "version",
      sourceVersion: 2,
      simulatedHash: "hash",
      baseVersion: 1,
      jobIds: ["j1", "j2"],
      detail: { workflows: ["wf"] },
      status: "running",
      error: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      createdBy: "a@example.com",
      createdByUserId: "u1",
      finishedAt: null
    });
    const inline = await store.insertGuardSimulation({ ...row("s2", { detail: null }), sourceKind: "inline", sourceVersion: null, baseVersion: null, error: "boom", finishedAt: "2026-10-01T00:05:00.000Z" });
    expect(inline).toMatchObject({ sourceKind: "inline", sourceVersion: null, baseVersion: null, detail: null, error: "boom", finishedAt: "2026-10-01T00:05:00.000Z" });
    expect(await store.getGuardSimulation("s2")).toEqual(inline);
    expect(await store.getGuardSimulation("missing")).toBeNull();
  });

  it("updates only the given fields; onlyFrom refuses a row that left those statuses; nothing to set is no change", async () => {
    const store = ctx.store();
    await store.insertGuardSimulation(row("s1", { status: "running" }));
    expect(await store.updateGuardSimulation({ id: "s1" })).toBe(false);
    expect(await store.updateGuardSimulation({ id: "s1", jobIds: ["j9"], detail: { progress: 1 } })).toBe(true);
    expect(await store.updateGuardSimulation({ id: "s1", status: "completed", finishedAt: "2026-10-01T01:00:00.000Z", onlyFrom: ["running"] })).toBe(true);
    expect(await store.updateGuardSimulation({ id: "s1", status: "canceled", error: "late", onlyFrom: ["running"] })).toBe(false);
    expect(await store.updateGuardSimulation({ id: "missing", status: "canceled" })).toBe(false);
    expect(await store.getGuardSimulation("s1")).toMatchObject({ status: "completed", jobIds: ["j9"], detail: { progress: 1 }, error: null, finishedAt: "2026-10-01T01:00:00.000Z" });
    expect(await store.updateGuardSimulation({ id: "s1", error: null })).toBe(true);
  });

  it("lists one profile's simulations newest first with limit and offset; the running list is oldest first", async () => {
    const store = ctx.store();
    await store.insertGuardSimulation(row("old", { createdAt: "2026-10-01T00:00:00.000Z" }));
    await store.insertGuardSimulation(row("mid", { createdAt: "2026-10-02T00:00:00.000Z", status: "running" }));
    await store.insertGuardSimulation(row("new", { createdAt: "2026-10-03T00:00:00.000Z" }));
    await store.insertGuardSimulation(row("other", { profileId: "q", createdAt: "2026-10-04T00:00:00.000Z" }));
    expect((await store.listGuardSimulations({ profileId: "p" })).map((s) => s.id)).toEqual(["new", "mid", "old"]);
    expect((await store.listGuardSimulations({ profileId: "p", limit: 1, offset: 1 })).map((s) => s.id)).toEqual(["mid"]);
    expect((await store.listGuardSimulations({ profileId: "p", limit: 0 })).map((s) => s.id)).toEqual(["new"]);
    expect((await store.listRunningGuardSimulations()).map((s) => s.id)).toEqual(["mid"]);
  });

  it("a second running simulation is refused by the one-running index; finished ones are not limited", async () => {
    const store = ctx.store();
    await store.insertGuardSimulation(row("r1", { status: "running" }));
    const refused = await store.insertGuardSimulation(row("r2", { status: "running" })).then(() => undefined, (error: unknown) => error);
    expect(isOneRunningSimulationViolation(refused)).toBe(true);
    await store.insertGuardSimulation(row("c1"));
    const promoted = await store.updateGuardSimulation({ id: "c1", status: "running" }).then(() => undefined, (error: unknown) => error);
    expect(isOneRunningSimulationViolation(promoted)).toBe(true);
    expect(await store.updateGuardSimulation({ id: "r1", status: "completed" })).toBe(true);
    expect(await store.updateGuardSimulation({ id: "c1", status: "running" })).toBe(true);
  });

  it("prunes simulations created before a time, with their finished replay jobs and case results", async () => {
    const store = ctx.store();
    await store.createEvalDataset({ id: "ds", name: "Set", workflowId: "wf" });
    await store.createEvalFixture({ id: "fx", datasetId: "ds", name: "Case", input: {} });
    await store.createEvalRun({ id: "job-done", datasetId: "ds", workflowId: "wf", kind: "replay", status: "completed" });
    await store.createEvalRun({ id: "job-running", datasetId: "ds", workflowId: "wf", kind: "replay", status: "running" });
    await store.recordEvalResult({ id: "res-1", runId: "job-done", fixtureId: "fx", status: "pass" });
    await store.insertGuardSimulation(row("gone", { createdAt: "2026-09-01T00:00:00.000Z", jobIds: ["job-done", "job-running"] }));
    await store.insertGuardSimulation(row("kept", { createdAt: "2026-10-05T00:00:00.000Z" }));
    expect(await store.pruneGuardSimulations({ before: "2026-01-01T00:00:00.000Z" })).toBe(0);
    expect(await store.pruneGuardSimulations({ before: "2026-10-01T00:00:00.000Z" })).toBe(1);
    expect(await store.getGuardSimulation("gone")).toBeNull();
    expect(await store.getGuardSimulation("kept")).not.toBeNull();
    expect(await store.getEvalRun("job-done")).toBeNull();
    expect(await store.getEvalRun("job-running")).not.toBeNull();
    expect(await store.listEvalResults("job-done")).toEqual([]);
  });
});
