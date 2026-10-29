/**
 * Phase 13.1 — store contract: workflows, projects, folders, workflow versions and shares, on both stores.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";
import { ProjectNotEmptyError } from "../store-errors.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function workflow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [], ...overrides } as never;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

describeStoreContract("store contract: workflows", (ctx) => {
  it("saves, reads, lists and counts workflows; createdBy is kept from the first save", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-a", { tags: ["Ops", "rag"] }), { createdBy: "u1" });
    await tick();
    await store.upsertWorkflow(workflow("wf-b", { name: "beta" }), { createdBy: "u2" });
    // The list is newest-updated first: a distinct millisecond keeps the rename after wf-b's save.
    await tick();
    await store.upsertWorkflow(workflow("wf-a", { name: "Alpha renamed", tags: ["Ops"] }), { createdBy: "u9" });
    const a = await store.getWorkflow("wf-a");
    expect(a).toMatchObject({ id: "wf-a", name: "Alpha renamed", tags: ["Ops"], projectId: "default" });
    expect(a?.createdAt).toMatch(ISO);
    expect(await store.getWorkflowCreatedBy("wf-a")).toBe("u1");
    expect(await store.getWorkflowCreatedBy("missing")).toBeNull();
    expect(await store.countWorkflows()).toBe(2);
    expect((await store.listWorkflows()).map((w) => w.id)).toEqual(["wf-a", "wf-b"]);
    expect((await store.listWorkflows({ tag: "ops" })).map((w) => w.id)).toEqual(["wf-a"]);
    expect((await store.listWorkflows({ search: "BETA" })).map((w) => w.id)).toEqual(["wf-b"]);
    expect(await store.getWorkflow("missing")).toBeNull();
  });

  it("deleting a workflow removes its versions, shares, queue rows and history, and cancels its pending approvals", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-del", { nodes: [{ id: "n1", type: "llm_call", name: "n", position: { x: 0, y: 0 }, config: {} }] }));
    await store.appendWorkflowVersion({ id: "v1", workflowId: "wf-del", workflowJson: "{}", retention: 10 });
    await store.upsertWorkflowShare({ workflowId: "wf-del", projectId: "p2", accessLevel: "read" });
    await store.enqueueExecution({ id: "q1", workflowId: "wf-del", payload: {} });
    await store.saveExecutionHistory({ id: "run-1", workflowId: "wf-del", status: "waiting_approval", startedAt: new Date().toISOString() });
    await store.insertApprovalRequest({
      id: "req-1", executionId: "run-1", workflowId: "wf-del", projectId: "default", nodeId: "gate", kind: "approval_gate",
      spec: { kind: "approval_gate", approverRoles: [], approverUsers: [], allowSelfApproval: true, timeoutOutcome: "reject", requireRejectReason: false, editableFields: [] }
    });
    await store.saveSessionMemory("wf-del:n1", "s1", [{ role: "user", content: "hi" }]);
    expect(await store.deleteWorkflow("wf-del")).toBe(true);
    expect(await store.getWorkflow("wf-del")).toBeNull();
    expect(await store.listWorkflowVersions("wf-del")).toEqual([]);
    expect(await store.listWorkflowShares("wf-del")).toEqual([]);
    expect(await store.hasActiveQueueItem("q1")).toBe(false);
    expect(await store.getExecutionHistory("run-1")).toBeNull();
    expect(await store.loadSessionMemory("wf-del:n1", "s1")).toEqual([]);
    const request = await store.getApprovalRequest("req-1");
    expect(request).toMatchObject({ status: "canceled", reason: "The workflow was deleted" });
    expect(request?.workflowDeletedAt).toMatch(ISO);
    expect(await store.deleteWorkflow("wf-del")).toBe(false);
  });

  it("projects and folders list in binary name order", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "p-b", name: "beta" });
    await store.upsertProject({ id: "p-a", name: "Zulu" });
    await store.upsertProject({ id: "p-c", name: "alpha" });
    expect((await store.listProjects()).map((p) => p.name)).toEqual(["Zulu", "alpha", "beta"]);
    await store.upsertFolder({ id: "f1", name: "b", projectId: "p-a" });
    await store.upsertFolder({ id: "f2", name: "B", projectId: "p-a" });
    await store.upsertFolder({ id: "f3", name: "a", projectId: "p-a", parentId: "f1" });
    expect((await store.listFolders("p-a")).map((f) => f.name)).toEqual(["B", "a", "b"]);
    expect(await store.deleteFolder("f1")).toBe(true);
    expect((await store.getFolder("f3"))?.parentId).toBeUndefined();
    expect(await store.deleteFolder("f1")).toBe(false);
  });

  it("deleting a project removes its roles, custom roles, shares and folders; a project with workflows is refused", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "p1", name: "One" });
    await store.saveUser({ id: "u1", email: "u1@example.com", passwordHash: "x", role: "builder" });
    await store.upsertProjectRole({ userId: "u1", projectId: "p1", role: "builder" });
    await store.upsertFolder({ id: "f1", name: "F", projectId: "p1" });
    await store.upsertWorkflowShare({ workflowId: "wf-x", projectId: "p1", accessLevel: "execute" });
    expect(await store.deleteProject("p1")).toBe(true);
    expect(await store.getProject("p1")).toBeNull();
    expect(await store.getProjectRole("u1", "p1")).toBeNull();
    expect(await store.listFolders("p1")).toEqual([]);
    expect(await store.listWorkflowsSharedToProject("p1")).toEqual([]);
    expect(await store.deleteProject("p1")).toBe(false);

    await store.upsertProject({ id: "p2", name: "Two" });
    await store.upsertWorkflow(workflow("wf-p2", { projectId: "p2" }));
    await expect(store.deleteProject("p2")).rejects.toBeInstanceOf(ProjectNotEmptyError);
    expect(await store.getProject("p2")).not.toBeNull();
    await expect(store.deleteProject("default")).rejects.toThrow("Cannot delete the default project.");
  });

  it("workflow versions: append numbers, write replaces, list newest first, prune keeps the newest", async () => {
    const store = ctx.store();
    expect(await store.maxWorkflowVersionNumber("wf")).toBe(0);
    for (const n of [1, 2, 3]) {
      const appended = await store.appendWorkflowVersion({ id: `wfv-${n}`, workflowId: "wf", workflowJson: JSON.stringify({ n }), createdBy: "u1", changeNote: `v${n}`, retention: 0 });
      expect(appended).toMatchObject({ id: `wfv-${n}`, version: n });
      expect(appended.createdAt).toMatch(ISO);
    }
    expect(await store.maxWorkflowVersionNumber("wf")).toBe(3);
    const listed = await store.listWorkflowVersions("wf");
    expect(listed.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(listed[0]).toEqual({ id: "wfv-3", workflowId: "wf", version: 3, createdBy: "u1", changeNote: "v3", createdAt: expect.stringMatching(ISO) });
    expect((await store.listWorkflowVersions("wf", 2)).length).toBe(2);
    expect(await store.getWorkflowVersion("wf", 2)).toMatchObject({ id: "wfv-2", workflowJson: JSON.stringify({ n: 2 }), changeNote: "v2" });
    expect(await store.getWorkflowVersion("wf", 9)).toBeNull();

    await store.writeWorkflowVersion({ id: "ignored", workflowId: "wf", version: 2, workflowJson: "{\"n\":22}", changeNote: null });
    expect(await store.getWorkflowVersion("wf", 2)).toMatchObject({ id: "wfv-2", workflowJson: "{\"n\":22}", changeNote: null, createdBy: null });

    // Pinning comes with a release (q3b's domain); without pins prune keeps the newest `keep`.
    expect(await store.pruneWorkflowVersions("wf", 1)).toBe(2);
    expect((await store.listWorkflowVersions("wf")).map((v) => v.version)).toEqual([3]);
    expect(await store.pruneWorkflowVersions("wf", 0)).toBe(0);
  });

  it("appendWorkflowVersion prunes past the retention in the same write; concurrent appends get distinct numbers", async () => {
    const store = ctx.store();
    const appended = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => store.appendWorkflowVersion({ id: `wfv-${n}`, workflowId: "wf-keep", workflowJson: JSON.stringify({ n }), retention: 3 }))
    );
    expect(appended.map((entry) => entry.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await store.listWorkflowVersions("wf-keep", 10)).map((entry) => entry.version)).toEqual([6, 5, 4]);
    // Each number kept the JSON of the append that took it.
    for (const entry of appended.filter((e) => e.version > 3)) {
      const row = await store.getWorkflowVersion("wf-keep", entry.version);
      expect(row?.id).toBe(entry.id);
    }
    // A duplicate id is the caller's error, not a number race.
    const keptId = appended.find((entry) => entry.version === 6)!.id;
    await expect(store.appendWorkflowVersion({ id: keptId, workflowId: "wf-keep", workflowJson: "{}", retention: 3 })).rejects.toThrow();
  });

  it("workflow shares: upsert keeps the first sharer, lists by project id, removes once", async () => {
    const store = ctx.store();
    await store.upsertWorkflowShare({ workflowId: "wf", projectId: "p-b", accessLevel: "read", sharedBy: "u1" });
    await tick();
    await store.upsertWorkflowShare({ workflowId: "wf", projectId: "P-a", accessLevel: "execute" });
    await store.upsertWorkflowShare({ workflowId: "wf", projectId: "p-b", accessLevel: "execute", sharedBy: "u2" });
    await store.upsertWorkflowShare({ workflowId: "wf2", projectId: "p-b", accessLevel: "read" });
    const shares = await store.listWorkflowShares("wf");
    expect(shares.map((s) => [s.projectId, s.accessLevel, s.sharedBy])).toEqual([["P-a", "execute", null], ["p-b", "execute", "u1"]]);
    expect(shares[0]?.createdAt).toMatch(ISO);
    expect(await store.listWorkflowsSharedToProject("p-b")).toEqual([
      { workflowId: "wf", projectId: "p-b", accessLevel: "execute" },
      { workflowId: "wf2", projectId: "p-b", accessLevel: "read" }
    ]);
    expect(await store.removeWorkflowShare("wf", "p-b")).toBe(true);
    expect(await store.removeWorkflowShare("wf", "p-b")).toBe(false);
    expect((await store.listWorkflowShares("wf")).map((s) => s.projectId)).toEqual(["P-a"]);
  });
});
