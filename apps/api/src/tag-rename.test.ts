/**
 * Roadmap 7.3 — PUT /api/tags/:tag renames a tag on every workflow that carries it (builder or above, audited).
 * Runs on SQLite and, under TEST_STORE=postgres, on Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  hookWorkflow,
  loginAs,
  type ReleaseTestContext
} from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

async function context(env?: Record<string, string>): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext(env ? { env } : {});
  contexts.push(created);
  return created;
}

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

async function tagged(ctx: ReleaseTestContext, id: string, tags: string[], projectId = "default") {
  await ctx.store.upsertWorkflow({ ...hookWorkflow(id, "ok", projectId), tags });
}

const rename = (ctx: ReleaseTestContext, cookie: string, tag: string, name: unknown) =>
  callAs(ctx, "PUT", `/api/tags/${encodeURIComponent(tag)}`, cookie, { name });

describe("PUT /api/tags/:tag", () => {
  it("renames the tag on every workflow and audits it", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    await tagged(ctx, "wf-1", ["sales", "ops"]);
    await tagged(ctx, "wf-2", ["sales"]);
    await tagged(ctx, "wf-3", ["other"]);

    const response = await rename(ctx, builder.cookie, "sales", "  revenue ");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true, tag: "revenue", previous: "sales", renamedInWorkflows: 2 });
    expect((await ctx.store.getWorkflow("wf-1"))?.tags).toEqual(["revenue", "ops"]);
    expect((await ctx.store.getWorkflow("wf-2"))?.tags).toEqual(["revenue"]);
    expect((await ctx.store.getWorkflow("wf-3"))?.tags).toEqual(["other"]);
    expect((await callAs(ctx, "GET", "/api/tags", builder.cookie)).json()).toEqual({ tags: ["ops", "other", "revenue"] });

    const audit = await ctx.store.listAuditLogs({ eventType: "tag.rename", pageSize: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ resourceType: "tag", resourceId: "revenue", actorUserId: builder.id, metadata: { from: "sales", to: "revenue", renamedInWorkflows: 2 } });
  });

  it("refuses a name another tag has, case-insensitively, and allows a case change of the same tag", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    await tagged(ctx, "wf-1", ["sales"]);
    await tagged(ctx, "wf-2", ["Ops"]);
    const taken = await rename(ctx, builder.cookie, "sales", "ops");
    expect(taken.statusCode).toBe(409);
    expect((await ctx.store.getWorkflow("wf-1"))?.tags).toEqual(["sales"]);
    const caseOnly = await rename(ctx, builder.cookie, "sales", "Sales");
    expect(caseOnly.statusCode, caseOnly.body).toBe(200);
    expect((await ctx.store.getWorkflow("wf-1"))?.tags).toEqual(["Sales"]);
  });

  it("rewrites only the tags: a graph saved meanwhile is kept, no version is taken, and a delete does the same", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    await tagged(ctx, "wf-1", ["sales", "ops"]);
    await tagged(ctx, "wf-2", ["sales"]);
    // A save lands after the rename's permission pass has read the workflow: its graph must survive.
    const stale = (await ctx.store.getWorkflow("wf-1"))!;
    await ctx.store.upsertWorkflow({ ...stale, name: "Saved meanwhile", workflowVersion: 7, tags: ["sales", "ops"] });
    const changed = await ctx.store.renameWorkflowTag(["wf-1", "wf-2", "wf-missing"], "sales", "revenue");
    expect(changed.sort()).toEqual(["wf-1", "wf-2"]);
    const after = (await ctx.store.getWorkflow("wf-1"))!;
    expect(after).toMatchObject({ name: "Saved meanwhile", workflowVersion: 7, tags: ["revenue", "ops"] });
    expect(await ctx.store.renameWorkflowTag(["wf-1"], "sales", "x")).toEqual([]);
    expect(await ctx.store.listWorkflowVersions("wf-1")).toHaveLength(0);

    const removed = await callAs(ctx, "DELETE", "/api/tags/revenue", admin.cookie);
    expect(removed.json()).toMatchObject({ removedFromWorkflows: 2 });
    expect((await ctx.store.getWorkflow("wf-1"))).toMatchObject({ name: "Saved meanwhile", workflowVersion: 7, tags: ["ops"] });
    expect((await ctx.store.getWorkflow("wf-2"))?.tags).toEqual([]);
  });

  it("answers 404 for an unknown tag and 400 for an empty name", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    await tagged(ctx, "wf-1", ["sales"]);
    expect((await rename(ctx, builder.cookie, "missing", "x")).statusCode).toBe(404);
    expect((await rename(ctx, builder.cookie, "sales", "   ")).statusCode).toBe(400);
    expect((await rename(ctx, builder.cookie, "sales", "x".repeat(101))).statusCode).toBe(400);
  });

  it("needs a builder, and refuses a tag on workflows the user cannot edit without changing any", async () => {
    const ctx = await context({ PROJECT_ISOLATION: "strict" });
    const admin = await loginAs(ctx, "admin");
    const viewer = await loginAs(ctx, "viewer");
    const builder = await loginAs(ctx, "builder");
    expect((await callAs(ctx, "POST", "/api/projects", admin.cookie, { id: "proj-a", name: "A" })).statusCode).toBe(200);
    expect((await callAs(ctx, "POST", "/api/projects", admin.cookie, { id: "proj-b", name: "B" })).statusCode).toBe(200);
    expect((await callAs(ctx, "POST", "/api/projects/proj-a/members", admin.cookie, { userId: builder.id, role: "editor" })).statusCode).toBe(200);
    await tagged(ctx, "wf-a", ["shared"], "proj-a");
    await tagged(ctx, "wf-b", ["shared"], "proj-b");

    expect((await rename(ctx, viewer.cookie, "shared", "x")).statusCode).toBe(403);
    const refused = await rename(ctx, builder.cookie, "shared", "renamed");
    expect(refused.statusCode).toBe(403);
    expect((await ctx.store.getWorkflow("wf-a"))?.tags).toEqual(["shared"]);
    expect((await ctx.store.getWorkflow("wf-b"))?.tags).toEqual(["shared"]);

    const byAdmin = await rename(ctx, admin.cookie, "shared", "renamed");
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
    expect(byAdmin.json<{ renamedInWorkflows: number }>().renamedInWorkflows).toBe(2);
  });
});
