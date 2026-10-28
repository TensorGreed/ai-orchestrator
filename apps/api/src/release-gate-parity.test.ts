/**
 * Rollback and deleting the workflow follow the unpublish rule: admin-only while the release gate is on and enforced,
 * open to anyone who may publish when the gate is switched off (whatever its enforced flag says) or only observing.
 * The rule is checked before the write and again inside the store's transaction. Runs on SQLite and, under
 * TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRelease } from "@ai-orchestrator/shared";
import { ReleaseGateEnforcedError } from "./db/store-errors.js";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  enableReleaseGate,
  hookWorkflow,
  loginAs,
  productionHook,
  saveVersion,
  type ReleaseTestContext
} from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

async function context(): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext();
  contexts.push(created);
  return created;
}

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

type GateState = "enforced" | "observing" | "off_flagged_enforced";

/** v1 is the gate's baseline, v2 is live (an admin override); the gate is then left in `state`. */
async function gatedWorkflow(ctx: ReleaseTestContext, workflowId: string, state: GateState) {
  const admin = await loginAs(ctx, "admin");
  const builder = await loginAs(ctx, "builder");
  await saveVersion(ctx, hookWorkflow(workflowId, "one"));
  expect((await enableReleaseGate(ctx, admin.cookie, workflowId, { enforced: state !== "observing" })).statusCode).toBe(200);
  const v2 = await saveVersion(ctx, hookWorkflow(workflowId, "two"));
  const published = await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, admin.cookie, { version: v2, override: { reason: "test" } });
  expect(published.statusCode, published.body).toBe(200);
  if (state === "off_flagged_enforced") {
    const gate = (await ctx.store.getReleaseGate(workflowId))!;
    await ctx.store.upsertReleaseGate({ ...gate, enabled: false, enforced: true });
  }
  return { admin, builder, v1: 1, v2 };
}

const rollback = (ctx: ReleaseTestContext, cookie: string, workflowId: string, version: number) =>
  callAs(ctx, "POST", `/api/workflows/${workflowId}/rollback`, cookie, { version, reason: "back" });
const auditCount = async (ctx: ReleaseTestContext, eventType: string) => (await ctx.store.listAuditLogs({ eventType, pageSize: 10 })).items.length;

describe("rollback follows the unpublish rule", () => {
  it("on a gate that is on and enforced a builder is refused (403, audited, nothing written); an admin rolls back", async () => {
    const ctx = await context();
    const { admin, builder, v1, v2 } = await gatedWorkflow(ctx, "wf-rb-enf", "enforced");
    const refused = await rollback(ctx, builder.cookie, "wf-rb-enf", v1);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/enforced: only an admin can roll back/);
    expect(await ctx.store.getPublishedVersion("wf-rb-enf")).toBe(v2);
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(1);
    const done = await rollback(ctx, admin.cookie, "wf-rb-enf", v1);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v1, verdict: "rollback", previousVersion: v2 });
  });

  it.each(["observing", "off_flagged_enforced"] as const)("a builder may roll back when the gate is %s", async (state) => {
    const ctx = await context();
    const workflowId = `wf-rb-${state}`;
    const { builder, v1, v2 } = await gatedWorkflow(ctx, workflowId, state);
    const done = await rollback(ctx, builder.cookie, workflowId, v1);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v1, verdict: "rollback", previousVersion: v2, publishedBy: builder.email });
    expect(await productionHook(ctx, `hook-${workflowId}`)).toMatchObject({ output: { result: "one" } });
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(0);
    expect(await auditCount(ctx, "release.rolled_back")).toBe(1);
  });

  it("a gate enforced between the service check and the store write still refuses a builder, inside the transaction", async () => {
    const ctx = await context();
    const { admin, builder, v1, v2 } = await gatedWorkflow(ctx, "wf-rb-late", "observing");
    const real = ctx.store.publishWorkflowVersion.bind(ctx.store);
    // An admin enforces the gate after the service looked at it and before the store writes.
    const spy = vi.spyOn(ctx.store, "publishWorkflowVersion").mockImplementationOnce(async (...args) => {
      const gate = (await ctx.store.getReleaseGate("wf-rb-late"))!;
      await ctx.store.upsertReleaseGate({ ...gate, enabled: true, enforced: true });
      return real(...args);
    });
    const refused = await rollback(ctx, builder.cookie, "wf-rb-late", v1);
    spy.mockRestore();
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/only an admin can roll back/);
    expect(await ctx.store.getPublishedVersion("wf-rb-late")).toBe(v2);
    expect((await ctx.store.listWorkflowReleases("wf-rb-late")).some((entry) => entry.verdict === "rollback")).toBe(false);
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(1);
    expect(await auditCount(ctx, "release.rolled_back")).toBe(0);
    // An admin's rollback carries no flag and goes through.
    expect((await rollback(ctx, admin.cookie, "wf-rb-late", v1)).statusCode).toBe(200);
  });

  it("the store method on its own: refuseIfGateEnforced throws on an on-and-enforced gate and writes nothing; switched off it publishes", async () => {
    const ctx = await context();
    const { v1, v2 } = await gatedWorkflow(ctx, "wf-rb-store", "enforced");
    const hash = (await ctx.store.listWorkflowReleases("wf-rb-store")).find((entry) => entry.version === v1)!.workflowHash;
    const release = (id: string) => ({
      id,
      workflowId: "wf-rb-store",
      version: v1,
      workflowHash: hash,
      replayRunId: null,
      verdict: "rollback" as const,
      reason: "back",
      gateReasons: [],
      approval: null,
      publishedAt: new Date().toISOString(),
      publishedBy: "x@example.com",
      publishedByUserId: null
    });
    await expect(ctx.store.publishWorkflowVersion(release("rel_no"), v2, { refuseIfGateEnforced: true })).rejects.toBeInstanceOf(ReleaseGateEnforcedError);
    expect(await ctx.store.getPublishedVersion("wf-rb-store")).toBe(v2);
    expect((await ctx.store.listWorkflowReleases("wf-rb-store")).some((entry) => entry.id === "rel_no")).toBe(false);
    const gate = (await ctx.store.getReleaseGate("wf-rb-store"))!;
    await ctx.store.upsertReleaseGate({ ...gate, enabled: false, enforced: true });
    expect(await ctx.store.publishWorkflowVersion(release("rel_yes"), v2, { refuseIfGateEnforced: true })).toMatchObject({ id: "rel_yes", version: v1, previousVersion: v2 });
  });
});

describe("deleting the workflow follows the unpublish rule", () => {
  const remove = (ctx: ReleaseTestContext, cookie: string, workflowId: string) => callAs(ctx, "DELETE", `/api/workflows/${workflowId}`, cookie);

  it("on a gate that is on and enforced a builder is refused (403, audited, nothing deleted); an admin deletes", async () => {
    const ctx = await context();
    const { admin, builder } = await gatedWorkflow(ctx, "wf-del-enf", "enforced");
    const refused = await remove(ctx, builder.cookie, "wf-del-enf");
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/enforced release gate: only an admin can delete it/);
    expect(await ctx.store.getWorkflow("wf-del-enf")).not.toBeNull();
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(1);
    expect((await remove(ctx, admin.cookie, "wf-del-enf")).statusCode).toBe(200);
    expect(await ctx.store.getWorkflow("wf-del-enf")).toBeNull();
  });

  it.each(["observing", "off_flagged_enforced"] as const)("a builder may delete when the gate is %s", async (state) => {
    const ctx = await context();
    const workflowId = `wf-del-${state}`;
    const { builder } = await gatedWorkflow(ctx, workflowId, state);
    const done = await remove(ctx, builder.cookie, workflowId);
    expect(done.statusCode, done.body).toBe(200);
    expect(await ctx.store.getWorkflow(workflowId)).toBeNull();
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(0);
    // The gate and its history outlive the workflow, as before.
    expect(await ctx.store.getReleaseGate(workflowId)).not.toBeNull();
  });

  it("a gate enforced between the service check and the store delete still refuses a builder, inside the transaction", async () => {
    const ctx = await context();
    const { admin, builder } = await gatedWorkflow(ctx, "wf-del-late", "observing");
    const real = ctx.store.deleteWorkflow.bind(ctx.store);
    const spy = vi.spyOn(ctx.store, "deleteWorkflow").mockImplementationOnce(async (...args) => {
      const gate = (await ctx.store.getReleaseGate("wf-del-late"))!;
      await ctx.store.upsertReleaseGate({ ...gate, enabled: true, enforced: true });
      return real(...args);
    });
    const refused = await remove(ctx, builder.cookie, "wf-del-late");
    spy.mockRestore();
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/only an admin can delete it/);
    expect(await ctx.store.getWorkflow("wf-del-late")).not.toBeNull();
    expect((await ctx.store.listWorkflowVersions("wf-del-late")).length).toBeGreaterThan(0);
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(1);
    expect(await auditCount(ctx, "workflow.delete")).toBe(0);
    expect((await remove(ctx, admin.cookie, "wf-del-late")).statusCode).toBe(200);
  });

  it("the store method on its own: refuseIfGateEnforced throws on an on-and-enforced gate and deletes nothing; without it the delete goes through", async () => {
    const ctx = await context();
    await gatedWorkflow(ctx, "wf-del-store", "enforced");
    await expect(ctx.store.deleteWorkflow("wf-del-store", { refuseIfGateEnforced: true })).rejects.toBeInstanceOf(ReleaseGateEnforcedError);
    expect(await ctx.store.getWorkflow("wf-del-store")).not.toBeNull();
    expect((await ctx.store.listWorkflowVersions("wf-del-store")).length).toBeGreaterThan(0);
    expect(await ctx.store.deleteWorkflow("wf-del-store")).toBe(true);
    // No workflow, no gate row to refuse on: a delete of a missing workflow still answers false.
    expect(await ctx.store.deleteWorkflow("wf-missing", { refuseIfGateEnforced: true })).toBe(false);
  });
});
