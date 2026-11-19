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

describe("permissions", () => {
  it("lists only permissions something checks (no role:manage)", () => {
    expect(ALL_PERMISSIONS).not.toContain("role:manage");
  });
});
