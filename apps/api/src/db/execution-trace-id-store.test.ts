/**
 * v70 — the trace id on a run's history row, on every store: SQLite always, Postgres when TEST_POSTGRES_URL is set.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../test-support/test-store.js";

describeStoreContract("run trace id (v70)", (ctx) => {
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const ID = "0123456789abcdef0123456789abcdef";

  it("is null on a run that never had one", async () => {
    await ctx.store().saveExecutionHistory({ id: "run-none", workflowId: "wf", status: "success", startedAt });
    expect((await ctx.store().getExecutionHistory("run-none"))?.traceId).toBeNull();
  });

  it("is stored, read back, and kept by later writes of the run's history", async () => {
    const store = ctx.store();
    await store.saveExecutionHistory({ id: "run-traced", workflowId: "wf", status: "running", startedAt });
    await store.setExecutionTraceId("run-traced", ID);
    expect((await store.getExecutionHistory("run-traced"))?.traceId).toBe(ID);
    await store.saveExecutionHistory({ id: "run-traced", workflowId: "wf", status: "success", startedAt, completedAt: new Date().toISOString() });
    const after = await store.getExecutionHistory("run-traced");
    expect(after?.status).toBe("success");
    expect(after?.traceId).toBe(ID);
  });

  it("writing a trace id for a missing run changes nothing", async () => {
    await ctx.store().setExecutionTraceId("no-such-run", ID);
    expect(await ctx.store().getExecutionHistory("no-such-run")).toBeNull();
  });
});
