/**
 * Unpublish over the API: production falls back to the draft, the history and the audit log record it, a second call
 * is refused, publishing and rolling back afterwards follow the rules as before, and the gate never blocks it (with a
 * gate on, the answer says production runs the ungated draft). Runs on SQLite and, under TEST_STORE=postgres, on
 * Postgres.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ReleaseStateView, ReleaseUnpublishResult, Workflow, WorkflowRelease } from "@ai-orchestrator/shared";
import { releaseUnpublishNotice } from "@ai-orchestrator/shared";
import { MIGRATIONS } from "./db/migrations.js";
import { testSql } from "./test-support/test-sql.js";
import {
  callAs,
  closeReleaseTestContext,
  createReleaseTestContext,
  enableReleaseGate,
  hookWorkflow,
  loginAs,
  productionHook,
  saveVersion,
  testNode,
  testRouteHook,
  type ReleaseTestContext
} from "./test-support/release.test-helper.js";

const contexts: ReleaseTestContext[] = [];

async function context(options: { scheduler?: boolean } = {}): Promise<ReleaseTestContext> {
  const created = await createReleaseTestContext(options);
  contexts.push(created);
  return created;
}

afterEach(async () => {
  while (contexts.length > 0) await closeReleaseTestContext(contexts.pop()!);
});

const releasesOf = async (ctx: ReleaseTestContext, cookie: string, workflowId: string) =>
  (await callAs(ctx, "GET", `/api/workflows/${workflowId}/releases`, cookie)).json<{ releases: WorkflowRelease[]; publishedVersion: number | null }>();
const stateOf = async (ctx: ReleaseTestContext, cookie: string, workflowId: string) =>
  (await callAs(ctx, "GET", `/api/workflows/${workflowId}/release-state`, cookie)).json<{ state: ReleaseStateView }>().state;
const unpublish = (ctx: ReleaseTestContext, cookie: string, workflowId: string, payload: unknown = {}) =>
  callAs(ctx, "POST", `/api/workflows/${workflowId}/unpublish`, cookie, payload);

describe("migration 42", () => {
  it("adds workflows.unpublished_at in Postgres DDL with a down path, and the same column in SQLite", async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 42)!;
    expect(migration.up).toContain("ALTER TABLE workflows ADD COLUMN IF NOT EXISTS unpublished_at TIMESTAMPTZ");
    expect(migration.down).toContain("ALTER TABLE workflows DROP COLUMN IF EXISTS unpublished_at");
    expect(migration.up).toContain("ALTER TABLE workflow_releases ADD COLUMN seq BIGINT");
    expect(migration.down).toContain("ALTER TABLE workflow_releases DROP COLUMN IF EXISTS seq");
    const ctx = await context();
    const sql = testSql(ctx.store);
    const columns =
      sql.kind === "sqlite"
        ? (await sql.all<{ name: string }>("PRAGMA table_info(workflows)")).map((row) => row.name)
        : (await sql.all<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workflows'")).map((row) => row.column_name);
    expect(columns).toContain("unpublished_at");
  });
});

describe("unpublish without a gate", () => {
  it("production runs the draft; the history, the state and the audit log record who, when, why and which version was live", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-un", "published"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-un/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    await saveVersion(ctx, hookWorkflow("wf-un", "draft"));
    expect(await productionHook(ctx, "hook-wf-un")).toMatchObject({ status: 200, output: { result: "published" } });

    const response = await unpublish(ctx, builder.cookie, "wf-un", { reason: "  Bad answers in production  " });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ReleaseUnpublishResult>();
    expect(result).toMatchObject({ productionRuns: "draft", gateEnabled: false, gateEnforced: false });
    expect(result.release).toMatchObject({ verdict: "unpublished", version: v1, previousVersion: v1, reason: "Bad answers in production", publishedBy: builder.email, replayRunId: null });
    expect(result.release.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.notice).toBe(releaseUnpublishNotice({ version: v1, gateEnabled: false, gateEnforced: false }));
    expect(result.notice).not.toMatch(/gate/);

    expect(await productionHook(ctx, "hook-wf-un")).toMatchObject({ status: 200, output: { result: "draft" } });
    const history = await releasesOf(ctx, builder.cookie, "wf-un");
    expect(history.publishedVersion).toBeNull();
    expect(history.releases.map((entry) => entry.verdict)).toEqual(["unpublished", "ungated"]);
    expect(history.releases[0]!.id).toBe(result.release.id);
    const state = await stateOf(ctx, builder.cookie, "wf-un");
    expect(state).toMatchObject({ publishedVersion: null, productionRefused: false, aheadBy: 0, canPublish: true });
    expect(state.unpublishedAt).toBe(result.release.publishedAt);
    // The run records production with no version: the draft.
    const run = (await ctx.store.listExecutionHistory({ workflowId: "wf-un", page: 1, pageSize: 1 })).items[0]!;
    expect(await ctx.store.getExecutionRelease(run.id)).toEqual({ channel: "production", version: null });
    expect(await testRouteHook(ctx, "hook-wf-un")).toMatchObject({ output: { result: "draft" } });

    const audit = (await ctx.store.listAuditLogs({ eventType: "release.unpublished", pageSize: 5 })).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ category: "release", action: "unpublish", outcome: "success", resourceType: "workflow", resourceId: "wf-un" });
    expect(audit[0]!.metadata).toMatchObject({ releaseId: result.release.id, version: v1, reason: "Bad answers in production", gateEnabled: false, gateEnforced: false });
  });

  it("a second unpublish answers 409 and adds nothing; publishing again is a normal publish that clears the mark", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-twice", "one"));
    // Nothing published yet: 409.
    const early = await unpublish(ctx, builder.cookie, "wf-twice");
    expect(early.statusCode).toBe(409);
    expect(early.json<{ error: string }>().error).toMatch(/Nothing is published/);
    expect((await callAs(ctx, "POST", "/api/workflows/wf-twice/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    expect((await unpublish(ctx, builder.cookie, "wf-twice")).statusCode).toBe(200);
    const again = await unpublish(ctx, builder.cookie, "wf-twice", { reason: "again" });
    expect(again.statusCode).toBe(409);
    expect((await releasesOf(ctx, builder.cookie, "wf-twice")).releases.filter((entry) => entry.verdict === "unpublished")).toHaveLength(1);
    expect(await ctx.store.listAuditLogs({ eventType: "release.unpublished", pageSize: 5 }).then((page) => page.items.length)).toBe(1);

    // No reason given: stored as none.
    expect((await releasesOf(ctx, builder.cookie, "wf-twice")).releases[0]).toMatchObject({ verdict: "unpublished", reason: null });

    const v2 = await saveVersion(ctx, hookWorkflow("wf-twice", "two"));
    const published = await callAs(ctx, "POST", "/api/workflows/wf-twice/publish", builder.cookie, { version: v2 });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v2, verdict: "ungated", previousVersion: null });
    expect((await ctx.store.getPublishState("wf-twice")).unpublishedAt).toBeNull();
    expect((await stateOf(ctx, builder.cookie, "wf-twice")).unpublishedAt).toBeNull();
    await saveVersion(ctx, hookWorkflow("wf-twice", "three"));
    expect(await productionHook(ctx, "hook-wf-twice")).toMatchObject({ output: { result: "two" } });
  });

  it("two concurrent unpublishes: one succeeds, the other answers 409, one history entry", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const admin = await loginAs(ctx, "admin");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-race", "one"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-race/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const answers = await Promise.all([unpublish(ctx, builder.cookie, "wf-race"), unpublish(ctx, admin.cookie, "wf-race")]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
    expect((await ctx.store.listWorkflowReleases("wf-race")).filter((entry) => entry.verdict === "unpublished")).toHaveLength(1);

    // The store method itself: of two concurrent calls (two API instances), one writes.
    expect((await callAs(ctx, "POST", "/api/workflows/wf-race/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const entry = (id: string) => ({ id, workflowId: "wf-race", reason: null, unpublishedAt: new Date().toISOString(), unpublishedBy: "x@example.com", unpublishedByUserId: null });
    const results = await Promise.all([ctx.store.unpublishWorkflowVersion(entry("rel_a")), ctx.store.unpublishWorkflowVersion(entry("rel_b"))]);
    expect(results.filter((record) => record !== null)).toHaveLength(1);
    expect(results.find((record) => record !== null)).toMatchObject({ verdict: "unpublished", version: v1, previousVersion: v1 });
    expect((await ctx.store.listWorkflowReleases("wf-race")).filter((record) => record.verdict === "unpublished")).toHaveLength(2);
    expect(await ctx.store.getPublishedVersion("wf-race")).toBeNull();
    expect(await ctx.store.unpublishWorkflowVersion(entry("rel_c"))).toBeNull();
  });

  it("getPublishState reads the version and the mark together", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    expect(await ctx.store.getPublishState("missing")).toEqual({ publishedVersion: null, unpublishedAt: null });
    const v1 = await saveVersion(ctx, hookWorkflow("wf-state", "one"));
    expect(await ctx.store.getPublishState("wf-state")).toEqual({ publishedVersion: null, unpublishedAt: null });
    expect((await callAs(ctx, "POST", "/api/workflows/wf-state/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    expect(await ctx.store.getPublishState("wf-state")).toEqual({ publishedVersion: v1, unpublishedAt: null });
    expect((await unpublish(ctx, builder.cookie, "wf-state")).statusCode).toBe(200);
    const state = await ctx.store.getPublishState("wf-state");
    expect(state.publishedVersion).toBeNull();
    expect(state.unpublishedAt).not.toBeNull();
  });

  it("expectedVersion: unpublishes only the version the caller named", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-expect", "one"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-expect/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const v2 = await saveVersion(ctx, hookWorkflow("wf-expect", "two"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-expect/publish", builder.cookie, { version: v2 })).statusCode).toBe(200);

    // The dialog named v1, but v2 is live: refused, nothing changed.
    const stale = await unpublish(ctx, builder.cookie, "wf-expect", { expectedVersion: v1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: string }>().error).toContain(`v${v2} is live now`);
    expect(await ctx.store.getPublishState("wf-expect")).toEqual({ publishedVersion: v2, unpublishedAt: null });
    expect((await releasesOf(ctx, builder.cookie, "wf-expect")).releases.some((entry) => entry.verdict === "unpublished")).toBe(false);
    expect(await ctx.store.listAuditLogs({ eventType: "release.unpublished", pageSize: 5 }).then((page) => page.items.length)).toBe(0);
    expect(await productionHook(ctx, "hook-wf-expect")).toMatchObject({ output: { result: "two" } });

    // The store method alone, as a second instance would call it.
    const entry = (id: string, expectedVersion: number | null) => ({
      id,
      workflowId: "wf-expect",
      reason: null,
      expectedVersion,
      unpublishedAt: new Date().toISOString(),
      unpublishedBy: "x@example.com",
      unpublishedByUserId: null
    });
    expect(await ctx.store.unpublishWorkflowVersion(entry("rel_x", v1))).toBeNull();
    expect(await ctx.store.getPublishedVersion("wf-expect")).toBe(v2);

    // The right version goes through; a body without the field behaves as before.
    const done = await unpublish(ctx, builder.cookie, "wf-expect", { expectedVersion: v2 });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<ReleaseUnpublishResult>().release).toMatchObject({ verdict: "unpublished", version: v2 });
    const nothing = await unpublish(ctx, builder.cookie, "wf-expect", { expectedVersion: v2 });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json<{ error: string }>().error).toMatch(/Nothing is published/);
    expect((await unpublish(ctx, builder.cookie, "wf-expect", { expectedVersion: 0 })).statusCode).toBe(400);
  });

  it("lists same-millisecond history entries in the order they were written", async () => {
    const ctx = await context();
    const v1 = await saveVersion(ctx, hookWorkflow("wf-order", "one"));
    const at = "2026-10-27T10:00:00.000Z";
    const release = (id: string) => ({
      id,
      workflowId: "wf-order",
      version: v1,
      workflowHash: "hash-1",
      replayRunId: null,
      verdict: "ungated" as const,
      reason: null,
      gateReasons: [],
      approval: null,
      publishedAt: at,
      publishedBy: "x@example.com",
      publishedByUserId: null
    });
    // Ids deliberately sort against the write order.
    for (const round of ["rel_z", "rel_y", "rel_x"]) {
      expect(await ctx.store.publishWorkflowVersion(release(`${round}_pub`), await ctx.store.getPublishedVersion("wf-order"))).not.toBeNull();
      const taken = await ctx.store.unpublishWorkflowVersion({ id: `${round}_unpub`, workflowId: "wf-order", reason: null, unpublishedAt: at, unpublishedBy: "x@example.com", unpublishedByUserId: null });
      expect(taken).not.toBeNull();
    }
    const ids = (await ctx.store.listWorkflowReleases("wf-order")).map((entry) => entry.id);
    expect(ids).toEqual(["rel_x_unpub", "rel_x_pub", "rel_y_unpub", "rel_y_pub", "rel_z_unpub", "rel_z_pub"]);
  });

  it("rollback after an unpublish publishes that version again, through the same rules as before", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-back", "one"));
    const v2 = await saveVersion(ctx, hookWorkflow("wf-back", "two"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-back/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    expect((await unpublish(ctx, builder.cookie, "wf-back")).statusCode).toBe(200);
    // Only to a version published before, with a reason.
    expect((await callAs(ctx, "POST", "/api/workflows/wf-back/rollback", builder.cookie, { version: v2, reason: "x" })).statusCode).toBe(409);
    expect((await callAs(ctx, "POST", "/api/workflows/wf-back/rollback", builder.cookie, { version: v1 })).statusCode).toBe(400);
    const back = await callAs(ctx, "POST", "/api/workflows/wf-back/rollback", builder.cookie, { version: v1, reason: "Fixed upstream" });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: v1, verdict: "rollback", previousVersion: null });
    expect(await productionHook(ctx, "hook-wf-back")).toMatchObject({ output: { result: "one" } });
    expect((await ctx.store.getPublishState("wf-back")).unpublishedAt).toBeNull();
    expect((await releasesOf(ctx, builder.cookie, "wf-back")).releases.map((entry) => entry.verdict)).toEqual(["rollback", "unpublished", "ungated"]);
  });

  it("validates the body and refuses when the draft's production paths are another workflow's", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    expect((await unpublish(ctx, builder.cookie, "nope")).statusCode).toBe(404);
    const v1 = await saveVersion(ctx, hookWorkflow("wf-a", "a1", "default", "a-path"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-a/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    expect((await unpublish(ctx, builder.cookie, "wf-a", { reason: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await unpublish(ctx, builder.cookie, "wf-a", { version: 1 })).statusCode).toBe(400);
    // The draft moved onto a path another workflow serves (a published workflow's draft path is not checked on save).
    await saveVersion(ctx, hookWorkflow("wf-b", "b", "default", "shared-path"));
    await saveVersion(ctx, hookWorkflow("wf-a", "a2", "default", "shared-path"));
    const refused = await unpublish(ctx, builder.cookie, "wf-a");
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toMatch(/Cannot unpublish while another workflow serves production/);
    expect(await ctx.store.getPublishedVersion("wf-a")).toBe(v1);
    expect(await productionHook(ctx, "a-path")).toMatchObject({ output: { result: "a1" } });
  });
});

describe("who may unpublish", () => {
  it("admins and builders (workflow:publish); viewers, operators and roles without publish get 403; an unreadable workflow 404", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    const viewer = await loginAs(ctx, "viewer");
    const operator = await loginAs(ctx, "operator");
    const v1 = await saveVersion(ctx, hookWorkflow("wf-who", "one"));
    const publish = async () => expect((await callAs(ctx, "POST", "/api/workflows/wf-who/publish", admin.cookie, { version: v1 })).statusCode).toBe(200);
    await publish();
    expect((await unpublish(ctx, viewer.cookie, "wf-who")).statusCode).toBe(403);
    expect((await unpublish(ctx, operator.cookie, "wf-who")).statusCode).toBe(403);
    expect((await unpublish(ctx, builder.cookie, "wf-who")).statusCode).toBe(200);
    await publish();
    expect((await unpublish(ctx, admin.cookie, "wf-who")).statusCode).toBe(200);

    // Project roles: no read is 404, read and write without publish is 403, publish passes.
    const outsider = await loginAs(ctx, "builder", "outsider");
    const writer = await loginAs(ctx, "builder", "writer");
    await ctx.store.upsertProject({ id: "p-un", name: "Secret" });
    await ctx.store.upsertCustomRole({ id: "none-un", projectId: "p-un", name: "None", permissions: [] });
    await ctx.store.upsertCustomRole({ id: "write-un", projectId: "p-un", name: "Write", permissions: ["workflow:read", "workflow:write", "workflow:execute"] });
    await ctx.store.upsertProjectRole({ userId: outsider.id, projectId: "p-un", role: "custom", customRoleId: "none-un" });
    await ctx.store.upsertProjectRole({ userId: writer.id, projectId: "p-un", role: "custom", customRoleId: "write-un" });
    const p1 = await saveVersion(ctx, hookWorkflow("wf-sec", "x", "p-un"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-sec/publish", admin.cookie, { version: p1 })).statusCode).toBe(200);
    expect((await unpublish(ctx, outsider.cookie, "wf-sec")).statusCode).toBe(404);
    expect((await unpublish(ctx, writer.cookie, "wf-sec")).statusCode).toBe(403);
    await ctx.store.upsertCustomRole({ id: "write-un", projectId: "p-un", name: "Publish", permissions: ["workflow:read", "workflow:publish"] });
    expect((await unpublish(ctx, writer.cookie, "wf-sec")).statusCode).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-sec")).toBeNull();
  });
});

describe("unpublish with a release gate", () => {
  it("on an enforced gate only an admin unpublishes; the gate does not block it: production runs the ungated draft and the answer says so; publishing again goes through the gate", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    await saveVersion(ctx, hookWorkflow("wf-gated", "reviewed"));
    expect((await enableReleaseGate(ctx, admin.cookie, "wf-gated", { enforced: true })).statusCode).toBe(200);
    expect(await ctx.store.getPublishedVersion("wf-gated")).toBe(1);
    const v2 = await saveVersion(ctx, hookWorkflow("wf-gated", "unreviewed"));
    expect(await productionHook(ctx, "hook-wf-gated")).toMatchObject({ output: { result: "reviewed" } });

    // A builder is refused on an enforced gate, as for a rollback: nothing changes, and the refusal is audited.
    const refused = await unpublish(ctx, builder.cookie, "wf-gated", { reason: "Incident" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string }>().error).toMatch(/enforced: only an admin can unpublish/);
    expect(await ctx.store.getPublishedVersion("wf-gated")).toBe(1);
    expect(await productionHook(ctx, "hook-wf-gated")).toMatchObject({ output: { result: "reviewed" } });
    expect((await ctx.store.listAuditLogs({ eventType: "release.unpublish.refused", pageSize: 5 })).items).toHaveLength(1);

    const response = await unpublish(ctx, admin.cookie, "wf-gated", { reason: "Incident" });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<ReleaseUnpublishResult>();
    expect(result).toMatchObject({ productionRuns: "draft", gateEnabled: true, gateEnforced: true });
    expect(result.notice).toMatch(/release gate is enforced/);
    expect(result.notice).toMatch(/production runs the ungated draft/);
    expect(await productionHook(ctx, "hook-wf-gated")).toMatchObject({ status: 200, output: { result: "unreviewed" } });
    expect(await stateOf(ctx, builder.cookie, "wf-gated")).toMatchObject({ publishedVersion: null, productionRefused: false, gateEnabled: true, gateEnforced: true });
    expect((await ctx.store.listAuditLogs({ eventType: "release.unpublished", pageSize: 5 })).items[0]!.metadata).toMatchObject({ gateEnabled: true, gateEnforced: true });
    // Every save now goes live.
    await saveVersion(ctx, hookWorkflow("wf-gated", "saved later"));
    expect(await productionHook(ctx, "hook-wf-gated")).toMatchObject({ output: { result: "saved later" } });

    // Gate rules are unchanged: a publish without a passing job is blocked; rollback on an enforced gate is the admin's.
    const blocked = await callAs(ctx, "POST", "/api/workflows/wf-gated/publish", builder.cookie, { version: v2 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ verdict: string }>().verdict).toBe("blocked");
    expect((await callAs(ctx, "POST", "/api/workflows/wf-gated/rollback", builder.cookie, { version: 1, reason: "back" })).statusCode).toBe(403);
    const back = await callAs(ctx, "POST", "/api/workflows/wf-gated/rollback", admin.cookie, { version: 1, reason: "back" });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json<{ release: WorkflowRelease }>().release).toMatchObject({ version: 1, verdict: "rollback", previousVersion: null });
    expect(await productionHook(ctx, "hook-wf-gated")).toMatchObject({ output: { result: "reviewed" } });
  });

  it("a builder may unpublish while the gate is on but not enforced", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    await saveVersion(ctx, hookWorkflow("wf-observing", "reviewed"));
    expect((await enableReleaseGate(ctx, admin.cookie, "wf-observing")).statusCode).toBe(200);
    const response = await unpublish(ctx, builder.cookie, "wf-observing");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ReleaseUnpublishResult>()).toMatchObject({ gateEnabled: true, gateEnforced: false });
  });

  it("a gate that is on but not enforced says so too; deactivating is still the kill switch; a workflow created again under the id still fails closed", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    await saveVersion(ctx, hookWorkflow("wf-on", "reviewed"));
    expect((await enableReleaseGate(ctx, admin.cookie, "wf-on")).statusCode).toBe(200);
    await saveVersion(ctx, hookWorkflow("wf-on", "draft"));
    const result = (await unpublish(ctx, admin.cookie, "wf-on")).json<ReleaseUnpublishResult>();
    expect(result).toMatchObject({ gateEnabled: true, gateEnforced: false });
    expect(result.notice).toMatch(/release gate is on, but the gate does not check the draft/);
    expect(await productionHook(ctx, "hook-wf-on")).toMatchObject({ output: { result: "draft" } });

    // Deactivated: production refuses the draft as it refused the published version.
    expect((await callAs(ctx, "POST", "/api/workflows/wf-on/deactivate", admin.cookie, {})).statusCode).toBe(200);
    const deactivated = await ctx.app.inject({ method: "POST", url: "/webhook/hook-wf-on", payload: {} });
    expect(deactivated.statusCode).toBe(409);
    expect(deactivated.body).toMatch(/deactivated/);

    // Deleted and created again: the new row has no unpublish mark, so the gate fails closed as before.
    expect((await callAs(ctx, "DELETE", "/api/workflows/wf-on", admin.cookie)).statusCode).toBe(200);
    const imported = await callAs(ctx, "POST", "/api/workflows/import", admin.cookie, { workflow: hookWorkflow("wf-on", "unreviewed") });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await productionHook(ctx, "hook-wf-on")).status).toBe(404);
    expect(await stateOf(ctx, admin.cookie, "wf-on")).toMatchObject({ productionRefused: true, unpublishedAt: null });
  });

  it("an unpublished gated draft claims its production paths", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    await saveVersion(ctx, hookWorkflow("wf-claim", "gated", "default", "claim-path"));
    expect((await enableReleaseGate(ctx, admin.cookie, "wf-claim")).statusCode).toBe(200);
    await saveVersion(ctx, hookWorkflow("wf-claim", "gated draft", "default", "draft-path"));
    expect((await unpublish(ctx, admin.cookie, "wf-claim")).statusCode).toBe(200);
    // Another workflow cannot be saved onto the path the unpublished draft now serves.
    const other = await callAs(ctx, "POST", "/api/workflows", builder.cookie, hookWorkflow("wf-other", "other", "default", "draft-path"));
    expect(other.statusCode).toBe(409);
    expect(other.body).toMatch(/already used by/);
    expect(await productionHook(ctx, "draft-path")).toMatchObject({ output: { result: "gated draft" } });
  });

  it("a pending release request goes stale once production is unpublished", async () => {
    const ctx = await context();
    const admin = await loginAs(ctx, "admin");
    const builder = await loginAs(ctx, "builder");
    const lead = await loginAs(ctx, "builder", "lead");
    await saveVersion(ctx, hookWorkflow("wf-req", "one"));
    expect((await enableReleaseGate(ctx, admin.cookie, "wf-req", { requireApproval: true, approvers: { approverRoles: [], approverUsers: [lead.email], allowSelfApproval: false, timeoutMinutes: 60 } })).statusCode).toBe(200);
    const v2 = await saveVersion(ctx, hookWorkflow("wf-req", "two"));
    // The gate needs a job first; without one an approval request can still be asked for a blocked publish.
    const asked = await callAs(ctx, "POST", "/api/workflows/wf-req/publish", builder.cookie, { version: v2, requestApproval: { reason: "please" } });
    expect(asked.statusCode, asked.body).toBe(202);
    const requestId = asked.json<{ approvalRequestId: string }>().approvalRequestId;
    expect((await unpublish(ctx, builder.cookie, "wf-req")).statusCode).toBe(200);
    const decided = await callAs(ctx, "POST", `/api/approvals/${requestId}/approve`, lead.cookie, {});
    expect(decided.statusCode).toBe(409);
    expect(decided.body).toMatch(/unpublished after the request was made/);
    expect(await ctx.store.getPublishedVersion("wf-req")).toBeNull();
  });
});

describe("running executions keep their version", () => {
  it("a production run paused before the unpublish resumes on the version it started with", async () => {
    const ctx = await context();
    const builder = await loginAs(ctx, "builder");
    const lead = await loginAs(ctx, "builder", "lead");
    const paused = (answer: string): Workflow => ({
      id: "wf-pause",
      name: "Pause",
      schemaVersion: "1.0.0",
      workflowVersion: 1,
      projectId: "default",
      nodes: [
        testNode("hook", "webhook_input", { path: "hook-pause", method: "POST" }),
        testNode("gate", "approval_gate", { message: "Go?", approverUsers: [lead.email] }),
        testNode("out", "output", { responseTemplate: answer })
      ],
      edges: [{ id: "e1", source: "hook", target: "gate" }, { id: "e2", source: "gate", sourceHandle: "approved", target: "out" }]
    }) as Workflow;
    const v1 = await saveVersion(ctx, paused("started-version"));
    expect((await callAs(ctx, "POST", "/api/workflows/wf-pause/publish", builder.cookie, { version: v1 })).statusCode).toBe(200);
    const started = await ctx.app.inject({ method: "POST", url: "/webhook/hook-pause", payload: {} });
    expect(started.json<{ output: Record<string, unknown> }>().output).toMatchObject({ waitingForApproval: true });
    const executionId = (await ctx.store.listExecutionHistory({ workflowId: "wf-pause", page: 1, pageSize: 1 })).items[0]!.id;
    await saveVersion(ctx, paused("draft-version"));
    expect((await unpublish(ctx, builder.cookie, "wf-pause")).statusCode).toBe(200);
    const resumed = await callAs(ctx, "POST", `/api/approvals/${executionId}/approve`, lead.cookie, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(JSON.stringify(resumed.json().output)).toContain("started-version");
    expect(JSON.stringify(resumed.json().output)).not.toContain("draft-version");
  });
});
