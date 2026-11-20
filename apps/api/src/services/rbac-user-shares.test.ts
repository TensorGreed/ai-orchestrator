/**
 * v78 — what a workflow's share with a person gives them: read or execute, capped by their role, never write, and
 * nothing outside an API key's projects.
 */
import { describe, expect, it } from "vitest";
import type { Store } from "../db/store.js";
import type { SafeUser } from "./auth-service.js";
import { ALL_PERMISSIONS, RbacService, roleMayRunWorkflows } from "./rbac-service.js";

const shares: Record<string, "read" | "execute"> = { "wf|u-viewer": "execute", "wf|u-operator": "execute", "wf|u-builder": "read" };
const store = {
  getWorkflowUserShare: async (workflowId: string, userId: string) => (shares[`${workflowId}|${userId}`] ? { accessLevel: shares[`${workflowId}|${userId}`] } : null),
  getProjectRole: async () => null,
  listWorkflowShares: async () => []
} as unknown as Store;

const user = (role: SafeUser["role"], extra: Partial<SafeUser> = {}): SafeUser => ({ id: `u-${role}`, email: `${role}@x`, role, ...extra });
const wf = { id: "wf", projectId: "team" };

describe("user shares in RBAC", () => {
  const rbac = new RbacService(store, "strict");

  it("caps an execute share at the person's role", async () => {
    expect(roleMayRunWorkflows("viewer")).toBe(false);
    expect(roleMayRunWorkflows("operator")).toBe(true);
    expect(await rbac.userShareAccess(user("viewer"), wf)).toBe("read");
    expect(await rbac.userShareAccess(user("operator"), wf)).toBe("execute");
    expect(await rbac.userShareAccess(user("builder"), wf)).toBe("read");
    expect(await rbac.userShareAccess(user("viewer"), { id: "other", projectId: "team" })).toBeNull();
  });

  it("gives read and execute, never write or delete", async () => {
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:read")).toBe(true);
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:execute")).toBe(true);
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:write")).toBe(false);
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:delete")).toBe(false);
    expect(await rbac.canAccessWorkflow(user("viewer"), wf, "workflow:execute")).toBe(false);
    expect(await rbac.canAccessWorkflow(user("builder"), wf, "workflow:execute")).toBe(false);
  });

  it("lets only those who may invite to the owning project manage shares, an admin key limited to other projects not", async () => {
    expect(await rbac.mayManageWorkflowShares(user("admin"), wf)).toBe(true);
    expect(await rbac.mayManageWorkflowShares(user("admin", { projectScope: ["team"] }), wf)).toBe(true);
    expect(await rbac.mayManageWorkflowShares(user("admin", { projectScope: ["other"] }), wf)).toBe(false);
    expect(await rbac.mayManageWorkflowShares(user("builder"), wf)).toBe(false);
  });

  it("gives nothing to an API key limited to other projects", async () => {
    expect(await rbac.userShareAccess(user("operator", { projectScope: ["other"] }), wf)).toBeNull();
    expect(await rbac.userShareAccess(user("operator", { projectScope: ["team"] }), wf)).toBe("execute");
  });

  it("says whether a permission comes only through the share with the person", async () => {
    // Execute only through an execute share; read through any share.
    expect(await rbac.onlyThroughUserShare(user("operator"), wf, "workflow:execute")).toBe(true);
    expect(await rbac.onlyThroughUserShare(user("operator"), wf, "workflow:read")).toBe(true);
    expect(await rbac.onlyThroughUserShare(user("builder"), wf, "workflow:execute")).toBe(false);
    expect(await rbac.onlyThroughUserShare(user("builder"), wf, "workflow:read")).toBe(true);
    expect(await rbac.onlyThroughUserShare(user("operator"), { id: "other", projectId: "team" }, "workflow:read")).toBe(false);
  });

  it("does not count a project role or a share to a project the person may use", async () => {
    const withProject = {
      ...store,
      getProjectRole: async (userId: string, projectId: string) =>
        userId === "u-operator" && projectId === "ops" ? { userId, projectId, role: "editor", customRoleId: null } : null,
      listWorkflowShares: async () => [
        { workflowId: "wf", projectId: "ops", accessLevel: "read" as const }
      ]
    } as unknown as Store;
    const scoped = new RbacService(withProject, "strict");
    // A read share to their project gives read, not execute: execute still comes only through the person's share.
    expect(await scoped.onlyThroughUserShare(user("operator"), wf, "workflow:read")).toBe(false);
    expect(await scoped.onlyThroughUserShare(user("operator"), wf, "workflow:execute")).toBe(true);
  });
});

describe("a person share caps only someone it is the only way in for", () => {
  it("strict: a share-only builder gets read (and run with an execute share), never write, delete, publish or re-sharing, and nothing else in the project", async () => {
    const rbac = new RbacService(store, "strict");
    expect(await rbac.canAccessWorkflow(user("builder"), wf, "workflow:read")).toBe(true);
    for (const permission of ["workflow:execute", "workflow:write", "workflow:delete", "workflow:publish"] as const) {
      expect(await rbac.canAccessWorkflow(user("builder"), wf, permission)).toBe(false);
    }
    expect(await rbac.mayManageWorkflowShares(user("builder"), wf)).toBe(false);
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:execute")).toBe(true);
    expect(await rbac.canAccessWorkflow(user("builder"), { id: "other", projectId: "team" }, "workflow:read")).toBe(false);
    for (const permission of ["secret:read", "secret:write", "project:manage", "project:invite", "workflow:read"] as const) {
      expect(await rbac.can(user("builder"), "team", permission), permission).toBe(false);
    }
  });

  it("role: a builder whose role reaches the project keeps everything it gives; the share takes nothing away", async () => {
    const rbac = new RbacService(store, "role");
    expect(await rbac.shareIsOnlyWay(user("builder"), wf)).toBe(false);
    for (const permission of ["workflow:read", "workflow:execute", "workflow:write", "workflow:delete", "workflow:publish"] as const) {
      expect(await rbac.canAccessWorkflow(user("builder"), wf, permission), permission).toBe(true);
    }
    expect(await rbac.mayManageWorkflowShares(user("builder"), wf)).toBe(true);
    expect(await rbac.canAccessWorkflow(user("builder"), { id: "other", projectId: "team" }, "workflow:write")).toBe(true);
    for (const permission of ["secret:read", "secret:write", "project:invite", "workflow:read"] as const) {
      expect(await rbac.can(user("builder"), "team", permission), permission).toBe(true);
    }
    // An operator with an execute share keeps running it; admins are never capped.
    expect(await rbac.canAccessWorkflow(user("operator"), wf, "workflow:execute")).toBe(true);
    expect(await rbac.canAccessWorkflow(user("admin"), wf, "workflow:write")).toBe(true);
  });

  it("role: an API key limited to other projects reaches the project only through the share, so the share caps it", async () => {
    const rbac = new RbacService(store, "role");
    const scoped = user("builder", { projectScope: ["elsewhere"] } as Partial<SafeUser>);
    expect(await rbac.can(scoped, "team", "workflow:write")).toBe(false);
    expect(await rbac.canAccessWorkflow(scoped, wf, "workflow:write")).toBe(false);
  });

  it("does not cap a project member", async () => {
    const member = new RbacService(
      { ...store, getProjectRole: async (userId: string, projectId: string) => (userId === "u-builder" && projectId === "team" ? { userId, projectId, role: "editor", customRoleId: null } : null) } as unknown as Store,
      "strict"
    );
    expect(await member.canAccessWorkflow(user("builder"), wf, "workflow:write")).toBe(true);
  });
});

describe("permissions", () => {
  it("lists only permissions something checks (no role:manage)", () => {
    expect(ALL_PERMISSIONS).not.toContain("role:manage");
  });
});

describe("who gives project roles", () => {
  it("a member gives only roles whose permissions their own membership has; a non-member gives none", async () => {
    const rbac = new RbacService(
      { ...store, getProjectRole: async (userId: string, projectId: string) => (userId === "u-builder" && projectId === "team" ? { userId, projectId, role: "editor", customRoleId: null } : null) } as unknown as Store,
      "role"
    );
    expect(await rbac.roleWithin(user("builder"), "team", "viewer", null)).toBe(true);
    expect(await rbac.roleWithin(user("builder"), "team", "editor", null)).toBe(true);
    expect(await rbac.roleWithin(user("builder"), "team", "project_admin", null)).toBe(false);
    expect(await rbac.roleWithin(user("operator"), "team", "viewer", null)).toBe(false);
  });

  it("only a member with project:invite (or an admin) manages person shares", async () => {
    const rbac = new RbacService(
      { ...store, getProjectRole: async (userId: string, projectId: string) => (userId === "u-builder" && projectId === "team" ? { userId, projectId, role: "project_admin", customRoleId: null } : null) } as unknown as Store,
      "role"
    );
    const other = { id: "other", projectId: "team" };
    expect(await rbac.mayManagePersonShares(user("builder"), other)).toBe(true);
    expect(await rbac.mayManagePersonShares(user("admin"), other)).toBe(true);
    // Role isolation lends another builder project:invite, which still manages project shares but not person shares.
    const lent = { ...user("builder"), id: "u-lent" };
    expect(await rbac.mayManageWorkflowShares(lent, other)).toBe(true);
    expect(await rbac.mayManagePersonShares(lent, other)).toBe(false);
  });
});
