/**
 * Rollback and workflow delete follow unpublish: only while the release gate is on and enforced do they need an
 * admin. A gate that is switched off restricts nothing, even when still flagged enforced. The check is made before
 * the write and again inside the store's transaction, so a gate enforced in between still refuses a builder. Runs on
 * SQLite and, under TEST_STORE=postgres, on Postgres.
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
  vi.restoreAllMocks();
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

const rollback = (ctx: ReleaseTestContext, cookie: string, workflowId: string, version: number) =>
  callAs(ctx, "POST", `/api/workflows/${workflowId}/rollback`, cookie, { version, reason: "back" });
const remove = (ctx: ReleaseTestContext, cookie: string, workflowId: string) => callAs(ctx, "DELETE", `/api/workflows/${workflowId}`, cookie);
const auditCount = async (ctx: ReleaseTestContext, eventType: string) => (await ctx.store.listAuditLogs({ eventType, pageSize: 10 })).items.length;

/**
 * v1 and v2 published by a builder with no gate (v2 live), then a gate saved by an admin with the given state. The
 * gate is turned on through the API (so it is valid), then set to the state asked for directly in the store.
 */
async function publishedTwiceWithGate(ctx: ReleaseTestContext, workflowId: string, gate: { enabled: boolean; enforced: boolean }) {
  const admin = await loginAs(ctx, "admin");
  const builder = await loginAs(ctx, "builder");
  const v1 = await saveVersion(ctx, hookWorkflow(workflowId, "one"));
  expect((await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, builder.cookie, { version: v1 })).statusCode).toBe(200);
  const v2 = await saveVersion(ctx, hookWorkflow(workflowId, "two"));
  expect((await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, builder.cookie, { version: v2 })).statusCode).toBe(200);
  const saved = await enableReleaseGate(ctx, admin.cookie, workflowId, { enforced: true });
  expect(saved.statusCode, saved.body).toBe(200);
  const record = (await ctx.store.getReleaseGate(workflowId))!;
  await ctx.store.upsertReleaseGate({ ...record, ...gate });
  return { admin, builder, v1, v2 };
}

describe("rollback and delete with the gate switched off but still flagged enforced", () => {
  it("a builder may roll back", async () => {
    const ctx = await context();
    const { builder, v1 } = await publishedTwiceWithGate(ctx, "wf-off-rb", { enabled: false, enforced: true });
    const response = await rollback(ctx, builder.cookie, "wf-off-rb", v1);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v1, verdict: "rollback" });
    expect(await productionHook(ctx, "hook-wf-off-rb")).toMatchObject({ output: { result: "one" } });
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(0);
  });

  it("a builder may delete the workflow", async () => {
    const ctx = await context();
    const { builder } = await publishedTwiceWithGate(ctx, "wf-off-del", { enabled: false, enforced: true });
    const response = await remove(ctx, builder.cookie, "wf-off-del");
    expect(response.statusCode, response.body).toBe(200);
    expect(await ctx.store.getWorkflow("wf-off-del")).toBeNull();
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(0);
  });
});

describe("rollback and delete with the gate on but not enforced", () => {
  it("a builder may roll back and delete", async () => {
    const ctx = await context();
    const { builder, v1 } = await publishedTwiceWithGate(ctx, "wf-observe", { enabled: true, enforced: false });
    expect((await rollback(ctx, builder.cookie, "wf-observe", v1)).statusCode).toBe(200);
    expect((await remove(ctx, builder.cookie, "wf-observe")).statusCode).toBe(200);
  });
});

describe("rollback and delete with the gate on and enforced", () => {
  it("a builder is refused (audited); an admin may roll back and delete", async () => {
    const ctx = await context();
    const { admin, builder, v1, v2 } = await publishedTwiceWithGate(ctx, "wf-enf", { enabled: true, enforced: true });

    const refusedRollback = await rollback(ctx, builder.cookie, "wf-enf", v1);
    expect(refusedRollback.statusCode).toBe(403);
    expect(refusedRollback.json<{ error: string }>().error).toMatch(/only an admin can roll back/);
    expect(await ctx.store.getPublishedVersion("wf-enf")).toBe(v2);
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(1);

    const refusedDelete = await remove(ctx, builder.cookie, "wf-enf");
    expect(refusedDelete.statusCode).toBe(403);
    expect(refusedDelete.json<{ error: string }>().error).toMatch(/only an admin can delete it/);
    expect(await ctx.store.getWorkflow("wf-enf")).not.toBeNull();
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(1);

    expect((await rollback(ctx, admin.cookie, "wf-enf", v1)).statusCode).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-enf")).toBe(v1);
    expect((await remove(ctx, admin.cookie, "wf-enf")).statusCode).toBe(200);
    expect(await ctx.store.getWorkflow("wf-enf")).toBeNull();
  });
});

describe("a gate enforced between the check and the write", () => {
  it("refuses a builder's rollback inside the transaction and writes nothing", async () => {
    const ctx = await context();
    const { admin, builder, v1, v2 } = await publishedTwiceWithGate(ctx, "wf-late-rb", { enabled: false, enforced: false });
    const real = ctx.store.publishWorkflowVersion.bind(ctx.store);
    // An admin enforces the gate after the service looked at it and before the store writes.
    vi.spyOn(ctx.store, "publishWorkflowVersion").mockImplementationOnce(async (...args) => {
      const gate = (await ctx.store.getReleaseGate("wf-late-rb"))!;
      await ctx.store.upsertReleaseGate({ ...gate, enabled: true, enforced: true });
      return real(...args);
    });
    const refused = await rollback(ctx, builder.cookie, "wf-late-rb", v1);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/only an admin can roll back/);
    expect(await ctx.store.getPublishedVersion("wf-late-rb")).toBe(v2);
    expect((await ctx.store.listWorkflowReleases("wf-late-rb")).some((entry) => entry.verdict === "rollback")).toBe(false);
    expect(await auditCount(ctx, "release.rollback.refused")).toBe(1);
    expect(await auditCount(ctx, "release.rolled_back")).toBe(0);

    // The store method on its own: refused with the flag on an enforced gate, written without it.
    const release = (id: string) => ({
      id,
      workflowId: "wf-late-rb",
      version: v1,
      workflowHash: "h",
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
    expect(await ctx.store.getPublishedVersion("wf-late-rb")).toBe(v2);
    expect(await ctx.store.publishWorkflowVersion(release("rel_yes"), v2)).toMatchObject({ version: v1, previousVersion: v2 });
    expect((await rollback(ctx, admin.cookie, "wf-late-rb", v2)).statusCode).toBe(200);
  });

  it("refuses a builder's delete inside the transaction and deletes nothing", async () => {
    const ctx = await context();
    const { admin, builder } = await publishedTwiceWithGate(ctx, "wf-late-del", { enabled: false, enforced: false });
    const real = ctx.store.deleteWorkflow.bind(ctx.store);
    vi.spyOn(ctx.store, "deleteWorkflow").mockImplementationOnce(async (...args) => {
      const gate = (await ctx.store.getReleaseGate("wf-late-del"))!;
      await ctx.store.upsertReleaseGate({ ...gate, enabled: true, enforced: true });
      return real(...args);
    });
    const refused = await remove(ctx, builder.cookie, "wf-late-del");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/only an admin can delete it/);
    expect(await ctx.store.getWorkflow("wf-late-del")).not.toBeNull();
    expect((await ctx.store.listWorkflowVersions("wf-late-del")).length).toBeGreaterThan(0);
    expect(await auditCount(ctx, "release.workflow_delete.refused")).toBe(1);
    expect(await auditCount(ctx, "workflow.delete")).toBe(0);

    // The store method on its own: refused with the flag, deleted without it.
    await expect(ctx.store.deleteWorkflow("wf-late-del", { refuseIfGateEnforced: true })).rejects.toBeInstanceOf(ReleaseGateEnforcedError);
    expect(await ctx.store.getWorkflow("wf-late-del")).not.toBeNull();
    expect((await remove(ctx, admin.cookie, "wf-late-del")).statusCode).toBe(200);
    expect(await ctx.store.getWorkflow("wf-late-del")).toBeNull();
  });
});
