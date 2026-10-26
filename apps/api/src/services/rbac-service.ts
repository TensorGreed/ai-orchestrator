import { nanoid } from "nanoid";
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import type { SafeUser, UserRole } from "./auth-service";
import type { Store } from "../db/store.js";
import { mapAsync } from "../async-array.js";

export type ProjectRole = "project_admin" | "editor" | "viewer";

export type Permission =
  | "workflow:read"
  | "workflow:write"
  | "workflow:execute"
  | "workflow:delete"
  /** Phase 15.4 — move the published version (publish, rollback, approve a release request). */
  | "workflow:publish"
  | "secret:read"
  | "secret:write"
  | "secret:use"
  | "project:manage"
  | "project:invite"
  | "role:manage";

export const ALL_PERMISSIONS: Permission[] = [
  "workflow:read",
  "workflow:write",
  "workflow:execute",
  "workflow:delete",
  "workflow:publish",
  "secret:read",
  "secret:write",
  "secret:use",
  "project:manage",
  "project:invite",
  "role:manage"
];

const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, Permission[]> = {
  project_admin: [
    "workflow:read",
    "workflow:write",
    "workflow:execute",
    "workflow:delete",
    "workflow:publish",
    "secret:read",
    "secret:write",
    "secret:use",
    "project:manage",
    "project:invite",
    "role:manage"
  ],
  editor: [
    "workflow:read",
    "workflow:write",
    "workflow:execute",
    "workflow:publish",
    "secret:read",
    "secret:use"
  ],
  viewer: ["workflow:read", "secret:read"]
};

// Workflow/secret/share actions the global role is allowed for legacy callers without a project assignment.
const GLOBAL_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: ALL_PERMISSIONS,
  builder: [
    "workflow:read",
    "workflow:write",
    "workflow:execute",
    "workflow:delete",
    "workflow:publish",
    "secret:read",
    "secret:write",
    "secret:use",
    "project:invite",
    "role:manage"
  ],
  operator: ["workflow:read", "workflow:execute", "secret:use"],
  viewer: ["workflow:read", "secret:read"]
};

/**
 * The startup warning for strict isolation with no memberships at all: only
 * admins can see anything until they add members. Null when there is none.
 */
export function strictIsolationStartupWarning(isolation: ProjectIsolationMode, membershipCount: number): string | null {
  if (isolation !== "strict" || membershipCount > 0) return null;
  return "PROJECT_ISOLATION=strict is on and no user has a project membership: only admins can see anything. Add members (including to the default project) under Projects.";
}

export function isProjectRole(value: string): value is ProjectRole {
  return value === "project_admin" || value === "editor" || value === "viewer";
}

export interface ProjectMembership {
  userId: string;
  projectId: string;
  role: ProjectRole | "custom";
  customRoleId: string | null;
  permissions: Permission[];
}

/**
 * `role`: a user with no membership in a project gets their global role
 * there. `strict`: they get nothing, so only memberships grant access.
 */
export type ProjectIsolationMode = "role" | "strict";

export class RbacService {
  constructor(
    private readonly store: Store,
    private readonly isolation: ProjectIsolationMode = "role"
  ) {}

  // --- Project memberships -------------------------------------------------

  async addMember(input: {
    userId: string;
    projectId: string;
    role: ProjectRole | "custom";
    customRoleId?: string | null;
  }): Promise<void> {
    if (input.role === "custom" && !input.customRoleId) {
      throw new Error("customRoleId is required when role is 'custom'");
    }
    if (input.customRoleId) {
      const custom = await this.store.getCustomRole(input.customRoleId);
      if (!custom) {
        throw new Error("Custom role not found");
      }
      if (custom.projectId && custom.projectId !== input.projectId) {
        throw new Error("Custom role belongs to a different project");
      }
    }
    await this.store.upsertProjectRole({
      userId: input.userId,
      projectId: input.projectId,
      role: input.role,
      customRoleId: input.customRoleId ?? null
    });
  }

  async removeMember(userId: string, projectId: string): Promise<boolean> {
    return await this.store.removeProjectRole(userId, projectId);
  }

  async listMembers(projectId: string): Promise<ProjectMembership[]> {
    return await mapAsync(await this.store.listProjectMembers(projectId), (row) => this.hydrateMembership(row));
  }

  async listUserProjects(userId: string): Promise<ProjectMembership[]> {
    return await mapAsync(await this.store.listUserProjectRoles(userId), (row) => this.hydrateMembership(row));
  }

  async getMembership(userId: string, projectId: string): Promise<ProjectMembership | null> {
    const row = await this.store.getProjectRole(userId, projectId);
    if (!row) return null;
    return await this.hydrateMembership(row);
  }

  private async hydrateMembership(row: {
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  }): Promise<ProjectMembership> {
    const role: ProjectRole | "custom" = isProjectRole(row.role) ? row.role : "custom";
    let permissions: Permission[] = [];
    if (role === "custom") {
      if (row.customRoleId) {
        const custom = await this.store.getCustomRole(row.customRoleId);
        if (custom) {
          permissions = custom.permissions.filter((p): p is Permission =>
            ALL_PERMISSIONS.includes(p as Permission)
          );
        }
      }
    } else {
      permissions = [...PROJECT_ROLE_PERMISSIONS[role]];
    }
    return {
      userId: row.userId,
      projectId: row.projectId,
      role,
      customRoleId: row.customRoleId,
      permissions
    };
  }

  // --- Custom roles --------------------------------------------------------

  async createCustomRole(input: {
    projectId?: string | null;
    name: string;
    description?: string | null;
    permissions: Permission[];
    createdBy?: string | null;
  }): Promise<{ id: string }> {
    const id = `role_${nanoid(12)}`;
    const sanitized = input.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
    await this.store.upsertCustomRole({
      id,
      projectId: input.projectId ?? null,
      name: input.name,
      description: input.description ?? null,
      permissions: sanitized,
      createdBy: input.createdBy ?? null
    });
    return { id };
  }

  async updateCustomRole(
    id: string,
    input: {
      projectId?: string | null;
      name?: string;
      description?: string | null;
      permissions?: Permission[];
    }
  ): Promise<boolean> {
    const existing = await this.store.getCustomRole(id);
    if (!existing) return false;
    const sanitized = input.permissions?.filter((p) => ALL_PERMISSIONS.includes(p)) ?? existing.permissions;
    await this.store.upsertCustomRole({
      id,
      projectId: input.projectId === undefined ? existing.projectId : input.projectId,
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      permissions: sanitized,
      createdBy: existing.createdBy
    });
    return true;
  }

  async deleteCustomRole(id: string): Promise<boolean> {
    return await this.store.deleteCustomRole(id);
  }

  async listCustomRoles(projectId?: string | null) {
    return await this.store.listCustomRoles(projectId);
  }

  async getCustomRole(id: string) {
    return await this.store.getCustomRole(id);
  }

  // --- Authorization -------------------------------------------------------

  /**
   * Returns the effective permission set for a user against a given project.
   * Rules:
   *  - Global admins always get every permission.
   *  - Otherwise: use the user's explicit project membership if present.
   *  - Otherwise, in `role` isolation: fall back to the user's global role mapped to a coarse
   *    permission set (backwards-compatible behaviour for users without per-project roles).
   *  - Otherwise, in `strict` isolation: no permissions.
   */
  async effectivePermissions(user: SafeUser, projectId: string): Promise<Permission[]> {
    if (user.role === "admin") return [...ALL_PERMISSIONS];
    const membership = await this.getMembership(user.id, projectId);
    if (membership) return membership.permissions;
    if (this.isolation === "strict") return [];
    return [...GLOBAL_ROLE_PERMISSIONS[user.role]];
  }

  async can(user: SafeUser, projectId: string, permission: Permission): Promise<boolean> {
    return (await this.effectivePermissions(user, projectId)).includes(permission);
  }

  // --- Workflow sharing ----------------------------------------------------

  async shareWorkflow(input: {
    workflowId: string;
    projectId: string;
    accessLevel: "read" | "execute";
    sharedBy?: string | null;
  }): Promise<void> {
    await this.store.upsertWorkflowShare(input);
  }

  async unshareWorkflow(workflowId: string, projectId: string): Promise<boolean> {
    return await this.store.removeWorkflowShare(workflowId, projectId);
  }

  async listWorkflowShares(workflowId: string) {
    return await this.store.listWorkflowShares(workflowId);
  }

  async listWorkflowsVisibleToProject(projectId: string): Promise<Map<string, "read" | "execute">> {
    const shares = await this.store.listWorkflowsSharedToProject(projectId);
    const map = new Map<string, "read" | "execute">();
    for (const share of shares) {
      const level = share.accessLevel === "execute" ? "execute" : "read";
      map.set(share.workflowId, level);
    }
    return map;
  }

  async canAccessWorkflow(user: SafeUser, workflow: { id: string; projectId?: string }, permission: Permission): Promise<boolean> {
    const owningProject = workflow.projectId ?? DEFAULT_PROJECT_ID;
    if (await this.can(user, owningProject, permission)) return true;

    // Check if the workflow is shared to any of the user's projects. Running
    // it through an execute share needs execute in that project, not only read.
    const shares = await this.store.listWorkflowShares(workflow.id);
    for (const share of shares) {
      if (!await this.can(user, share.projectId, permission === "workflow:execute" ? "workflow:execute" : "workflow:read")) continue;
      if (permission === "workflow:read") return true;
      if (permission === "workflow:execute" && share.accessLevel === "execute") return true;
    }
    return false;
  }

  // --- Secret sharing ------------------------------------------------------

  async shareSecret(input: { secretId: string; projectId: string; sharedBy?: string | null }): Promise<void> {
    await this.store.upsertSecretShare(input);
  }

  async unshareSecret(secretId: string, projectId: string): Promise<boolean> {
    return await this.store.removeSecretShare(secretId, projectId);
  }

  async listSecretShares(secretId: string) {
    return await this.store.listSecretShares(secretId);
  }

  async listSecretsVisibleToProject(projectId: string): Promise<Set<string>> {
    return new Set(await this.store.listSecretsSharedToProject(projectId));
  }

  // --- SSO group-to-role mappings -----------------------------------------

  async upsertSsoGroupMapping(input: {
    id?: string;
    provider: string;
    groupName: string;
    projectId?: string | null;
    role: string;
    customRoleId?: string | null;
  }): Promise<string> {
    const id = input.id ?? `sgm_${nanoid(12)}`;
    await this.store.upsertSsoGroupMapping({
      id,
      provider: input.provider,
      groupName: input.groupName,
      projectId: input.projectId ?? null,
      role: input.role,
      customRoleId: input.customRoleId ?? null
    });
    return id;
  }

  async listSsoGroupMappings(provider?: string) {
    return await this.store.listSsoGroupMappings(provider);
  }

  async deleteSsoGroupMapping(id: string): Promise<boolean> {
    return await this.store.deleteSsoGroupMapping(id);
  }
}
