/**
 * v78 — store contract: per-workflow user shares, on both stores. A share needs an existing workflow and user, is
 * listed with the person's email, role and disabled flag, and goes with the workflow or the user.
 */
import { expect, it } from "vitest";
import { describeStoreContract } from "../../test-support/test-store.js";

function workflow(id: string) {
  return { id, name: `Workflow ${id}`, schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] } as never;
}

describeStoreContract("store contract: workflow user shares", (ctx) => {
  it("adds, changes, lists and removes shares; only for an existing workflow and user", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-a"));
    await store.upsertWorkflow(workflow("wf-b"));
    await store.saveUser({ id: "u-b", email: "bea@example.com", passwordHash: "x", role: "viewer" });
    await store.saveUser({ id: "u-a", email: "ana@example.com", passwordHash: "x", role: "operator" });

    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-a", userId: "u-b", accessLevel: "read", sharedBy: "owner@example.com" })).toBe(true);
    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-a", userId: "u-a", accessLevel: "read" })).toBe(true);
    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-a", userId: "u-a", accessLevel: "execute" })).toBe(true);
    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-b", userId: "u-a", accessLevel: "read" })).toBe(true);
    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-missing", userId: "u-a", accessLevel: "read" })).toBe(false);
    expect(await store.upsertWorkflowUserShare({ workflowId: "wf-a", userId: "u-missing", accessLevel: "read" })).toBe(false);

    const shares = await store.listWorkflowUserShares("wf-a");
    expect(shares.map(({ createdAt, ...rest }) => rest)).toEqual([
      { workflowId: "wf-a", userId: "u-a", email: "ana@example.com", role: "operator", disabled: false, accessLevel: "execute", sharedBy: null },
      { workflowId: "wf-a", userId: "u-b", email: "bea@example.com", role: "viewer", disabled: false, accessLevel: "read", sharedBy: "owner@example.com" }
    ]);
    expect(shares[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await store.getWorkflowUserShare("wf-a", "u-a")).toEqual({ accessLevel: "execute" });
    expect(await store.getWorkflowUserShare("wf-a", "u-nobody")).toBeNull();
    const sharedToA = await store.listWorkflowsSharedToUser("u-a");
    expect(sharedToA.every((share) => typeof share.updatedAt === "string" && share.updatedAt.length > 0)).toBe(true);
    expect(sharedToA.map(({ updatedAt, ...rest }) => rest)).toEqual([
      { workflowId: "wf-a", accessLevel: "execute", name: "Workflow wf-a", projectId: "default" },
      { workflowId: "wf-b", accessLevel: "read", name: "Workflow wf-b", projectId: "default" }
    ]);

    expect(await store.removeWorkflowUserShare("wf-a", "u-a")).toBe(true);
    expect(await store.removeWorkflowUserShare("wf-a", "u-a")).toBe(false);
    expect((await store.listWorkflowsSharedToUser("u-a")).map((share) => share.workflowId + ":" + share.accessLevel)).toEqual(["wf-b:read"]);
  });

  it("deleting the workflow or the user removes their shares; a disabled user's shares stay, marked", async () => {
    const store = ctx.store();
    await store.upsertWorkflow(workflow("wf-a"));
    await store.upsertWorkflow(workflow("wf-b"));
    await store.saveUser({ id: "u-a", email: "ana@example.com", passwordHash: "x", role: "operator", kind: "human" } as never);
    await store.saveUser({ id: "u-b", email: "bea@example.com", passwordHash: "x", role: "viewer" });
    await store.upsertWorkflowUserShare({ workflowId: "wf-a", userId: "u-a", accessLevel: "read" });
    await store.upsertWorkflowUserShare({ workflowId: "wf-b", userId: "u-a", accessLevel: "read" });
    await store.upsertWorkflowUserShare({ workflowId: "wf-b", userId: "u-b", accessLevel: "read" });

    expect(await store.deleteWorkflow("wf-a")).toBe(true);
    expect((await store.listWorkflowsSharedToUser("u-a")).map((share) => share.workflowId + ":" + share.accessLevel)).toEqual(["wf-b:read"]);
    // A workflow created again with the id starts unshared.
    await store.upsertWorkflow(workflow("wf-a"));
    expect(await store.listWorkflowUserShares("wf-a")).toEqual([]);

    await store.setUserDisabled("u-a", { disabled: true, now: new Date().toISOString() });
    expect((await store.listWorkflowUserShares("wf-b")).map((share) => [share.userId, share.disabled])).toEqual([
      ["u-a", true],
      ["u-b", false]
    ]);

    expect(await store.deleteUser("u-b")).toBe(true);
    expect((await store.listWorkflowUserShares("wf-b")).map((share) => share.userId)).toEqual(["u-a"]);
    expect(await store.listWorkflowsSharedToUser("u-b")).toEqual([]);
  });

  it("lists the workflows shared to a project with their names, in one query", async () => {
    const store = ctx.store();
    await store.upsertProject({ id: "p-own", name: "Own" });
    await store.upsertProject({ id: "p-to", name: "To" });
    await store.upsertWorkflow({ ...(workflow("wf-x") as object), projectId: "p-own" } as never);
    await store.upsertWorkflowShare({ workflowId: "wf-x", projectId: "p-to", accessLevel: "execute" });
    const listed = await store.listWorkflowSummariesSharedToProject("p-to");
    expect(listed.map(({ updatedAt, ...rest }) => rest)).toEqual([{ workflowId: "wf-x", ownerProjectId: "p-own", accessLevel: "execute", name: "Workflow wf-x" }]);
    expect(typeof listed[0]!.updatedAt).toBe("string");
    expect(await store.listWorkflowSummariesSharedToProject("p-own")).toEqual([]);
  });
});
