/**
 * 12.2 — a trigger's input trust is an admin's setting, so a non-admin may not bring another one into production. Rollback
 * already refused it; publishing an older version, and approving a release request a non-admin made, refuse it too.
 * Runs on SQLite and, under TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { bindTriggerTrust } from "./services/trigger-trust.js";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  enableReleaseGate,
  hookWorkflow,
  loginAs,
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

/** The webhook workflow with the admin's `user` input trust on its trigger, bound to it. */
function trusted(workflowId: string, answer: string): Workflow {
  const workflow = hookWorkflow(workflowId, answer);
  workflow.nodes[0] = { ...workflow.nodes[0]!, config: { ...workflow.nodes[0]!.config, inputTrust: "user" } };
  return { ...workflow, nodes: bindTriggerTrust(null, workflow.nodes) };
}

const auditCount = async (ctx: ReleaseTestContext, eventType: string) => (await ctx.store.listAuditLogs({ eventType, pageSize: 20 })).items.length;

/** v1 (with the admin's trust) then v2 (without it) published by an admin: v2 serves production. */
async function trustDroppedSince(ctx: ReleaseTestContext, workflowId: string) {
  const admin = await loginAs(ctx, "admin");
  const v1 = await saveVersion(ctx, trusted(workflowId, "one"));
  const v2 = await saveVersion(ctx, hookWorkflow(workflowId, "two"));
  for (const version of [v1, v2]) expect((await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, admin.cookie, { version })).statusCode).toBe(200);
  return { admin, v1, v2 };
}

describe("publishing an older version with another trigger input trust", () => {
  it("refuses a builder's session (audited) and lets an admin publish it", async () => {
    const ctx = await context();
    const { admin, v1, v2 } = await trustDroppedSince(ctx, "wf-trust");
    const builder = await loginAs(ctx, "builder");

    const rollback = await callAs(ctx, "POST", "/api/workflows/wf-trust/rollback", builder.cookie, { version: v1, reason: "back" });
    expect(rollback.statusCode).toBe(403);
    expect(rollback.json<{ error: string }>().error).toMatch(/only an admin can roll back to it/);

    const publish = await callAs(ctx, "POST", "/api/workflows/wf-trust/publish", builder.cookie, { version: v1 });
    expect(publish.statusCode, publish.body).toBe(403);
    expect(publish.json<{ error: string; code: string }>()).toMatchObject({ code: "trigger_trust", error: expect.stringMatching(/another input trust on trigger 'hook': only an admin can publish it/) });
    expect(await ctx.store.getPublishedVersion("wf-trust")).toBe(v2);
    expect(await auditCount(ctx, "release.publish.refused")).toBe(1);

    expect((await callAs(ctx, "POST", "/api/workflows/wf-trust/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-trust")).toBe(v1);
  });

  it("refuses a project-limited key whose owner is an admin (it acts as a builder)", async () => {
    const ctx = await context();
    const { admin, v1, v2 } = await trustDroppedSince(ctx, "wf-trust-key");
    const created = await callAs(ctx, "POST", "/api/auth/api-keys", admin.cookie, { name: "ci", projects: ["default"] });
    expect(created.statusCode, created.body).toBe(200);
    const key = created.json<{ key: string }>().key;
    const withKey = (url: string, payload: object) => ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${key}` }, payload });

    expect((await withKey("/api/workflows/wf-trust-key/rollback", { version: v1, reason: "back" })).statusCode).toBe(403);
    const publish = await withKey("/api/workflows/wf-trust-key/publish", { version: v1 });
    expect(publish.statusCode, publish.body).toBe(403);
    expect(publish.json<{ code: string }>().code).toBe("trigger_trust");
    expect(await ctx.store.getPublishedVersion("wf-trust-key")).toBe(v2);
  });

  it("lets a builder publish a version that keeps the trust production runs with", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    const v1 = await saveVersion(ctx, trusted("wf-same", "one"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-same/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    const v2 = await saveVersion(ctx, trusted("wf-same", "two"));
    const publish = await callAs(ctx, "POST", "/api/workflows/wf-same/publish", builder.cookie, { version: v2 });
    expect(publish.statusCode, publish.body).toBe(200);
  });
});

describe("approving a release request that brings back another trigger input trust", () => {
  /** v1 without trust is live behind a gate whose approver is `lead`; v2 (with trust) is sent for approval by `asker`. */
  async function requested(ctx: ReleaseTestContext, workflowId: string, askerName: string) {
    const admin = await loginAs(ctx, "admin");
    const asker = await loginAs(ctx, "admin", askerName);
    const lead = await loginAs(ctx, "builder", `lead-${askerName}`);
    const v1 = await saveVersion(ctx, hookWorkflow(workflowId, "one"));
    expect((await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, admin.cookie, { version: v1 })).statusCode).toBe(200);
    const gate = await enableReleaseGate(ctx, admin.cookie, workflowId, { approvers: { approverUsers: [lead.email] } });
    expect(gate.statusCode, gate.body).toBe(200);
    const v2 = await saveVersion(ctx, trusted(workflowId, "two"));
    const asked = await callAs(ctx, "POST", `/api/workflows/${workflowId}/publish`, asker.cookie, { version: v2, requestApproval: { reason: "ship the trust change" } });
    expect(asked.statusCode, asked.body).toBe(202);
    return { asker, lead, v1, v2, requestId: asked.json<{ approvalRequestId: string }>().approvalRequestId };
  }

  it("publishes when an admin asked", async () => {
    const ctx = await context();
    const { lead, v2, requestId } = await requested(ctx, "wf-req-ok", "asker-ok");
    const approved = await callAs(ctx, "POST", `/api/approvals/${requestId}/approve`, lead.cookie, { reason: "ok" });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-req-ok")).toBe(v2);
  });

  it("refuses when the person who asked is no longer an admin, and publishes nothing", async () => {
    const ctx = await context();
    const { asker, lead, v1, requestId } = await requested(ctx, "wf-req-demoted", "asker-demoted");
    await ctx.store.updateUserRole(asker.id, "builder");
    const approved = await callAs(ctx, "POST", `/api/approvals/${requestId}/approve`, lead.cookie, { reason: "ok" });
    expect(approved.statusCode, approved.body).toBe(403);
    expect(approved.json<{ error: string }>().error).toMatch(/only an admin can publish it/);
    expect(await ctx.store.getPublishedVersion("wf-req-demoted")).toBe(v1);
    expect((await ctx.store.getReleaseApprovalRequest(requestId))!.status).toBe("pending");
  });
});
