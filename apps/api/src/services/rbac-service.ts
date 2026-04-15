import { nanoid } from "nanoid";
import { DEFAULT_PROJECT_ID } from "@ai-orchestrator/shared";
import { SqliteStore } from "../db/database";
import type { SafeUser, UserRole } from "./auth-service";

export type ProjectRole = "project_admin" | "editor" | "viewer";

export type Permission =
  | "workflow:read"
  | "workflow:write"
  | "workflow:execute"
  | "workflow:delete"
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
    "secret:read",
    "secret:write",
    "secret:use",
    "project:invite",
    "role:manage"
  ],
  operator: ["workflow:read", "workflow:execute", "secret:use"],
  viewer: ["workflow:read", "secret:read"]
};

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

export class RbacService {
  constructor(private readonly store: SqliteStore) {}

  // --- Project memberships -------------------------------------------------

  addMember(input: {
    userId: string;
    projectId: string;
    role: ProjectRole | "custom";
    customRoleId?: string | null;
  }): void {
    if (input.role === "custom" && !input.customRoleId) {
      throw new Error("customRoleId is required when role is 'custom'");
    }
    if (input.customRoleId) {
      const custom = this.store.getCustomRole(input.customRoleId);
      if (!custom) {
        throw new Error("Custom role not found");
      }
      if (custom.projectId && custom.projectId !== input.projectId) {
        throw new Error("Custom role belongs to a different project");
      }
    }
    this.store.upsertProjectRole({
      userId: input.userId,
      projectId: input.projectId,
      role: input.role,
      customRoleId: input.customRoleId ?? null
    });
  }

  removeMember(userId: string, projectId: string): boolean {
    return this.store.removeProjectRole(userId, projectId);
  }

  listMembers(projectId: string): ProjectMembership[] {
    return this.store.listProjectMembers(projectId).map((row) => this.hydrateMembership(row));
  }

  listUserProjects(userId: string): ProjectMembership[] {
    return this.store.listUserProjectRoles(userId).map((row) => this.hydrateMembership(row));
  }

  getMembership(userId: string, projectId: string): ProjectMembership | null {
    const row = this.store.getProjectRole(userId, projectId);
    if (!row) return null;
    return this.hydrateMembership(row);
  }

  private hydrateMembership(row: {
    userId: string;
    projectId: string;
    role: string;
    customRoleId: string | null;
  }): ProjectMembership {
    const role: ProjectRole | "custom" = isProjectRole(row.role) ? row.role : "custom";
    let permissions: Permission[] = [];
    if (role === "custom") {
      if (row.customRoleId) {
        const custom = this.store.getCustomRole(row.customRoleId);
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

  createCustomRole(input: {
    projectId?: string | null;
    name: string;
    description?: string | null;
    permissions: Permission[];
    createdBy?: string | null;
  }): { id: string } {
    const id = `role_${nanoid(12)}`;
    const sanitized = input.permissions.filter((p) => ALL_PERMISSIONS.includes(p));
    this.store.upsertCustomRole({
      id,
      projectId: input.projectId ?? null,
      name: input.name,
      description: input.description ?? null,
      permissions: sanitized,
      createdBy: input.createdBy ?? null
    });
    return { id };
  }

  updateCustomRole(
    id: string,
    input: {
      projectId?: string | null;
      name?: string;
      description?: string | null;
      permissions?: Permission[];
    }
  ): boolean {
    const existing = this.store.getCustomRole(id);
    if (!existing) return false;
    const sanitized = input.permissions?.filter((p) => ALL_PERMISSIONS.includes(p)) ?? existing.permissions;
    this.store.upsertCustomRole({
      id,
      projectId: input.projectId === undefined ? existing.projectId : input.projectId,
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      permissions: sanitized,
      createdBy: existing.createdBy
    });
    return true;
  }

  deleteCustomRole(id: string): boolean {
    return this.store.deleteCustomRole(id);
  }

  listCustomRoles(projectId?: string | null) {
    return this.store.listCustomRoles(projectId);
  }

  getCustomRole(id: string) {
    return this.store.getCustomRole(id);
  }

  // --- Authorization -------------------------------------------------------

  /**
   * Returns the effective permission set for a user against a given project.
   * Rules:
   *  - Global admins always get every permission.
   *  - Otherwise: use the user's explicit project membership if present.
   *  - Otherwise: fall back to the user's global role mapped to a coarse permission set
   *    (this preserves backwards-compatible behaviour for users without per-project roles).
   */
  effectivePermissions(user: SafeUser, projectId: string): Permission[] {
    if (user.role === "admin") return [...ALL_PERMISSIONS];
    const membership = this.getMembership(user.id, projectId);
    if (membership) return membership.permissions;
    return [...GLOBAL_ROLE_PERMISSIONS[user.role]];
  }

  can(user: SafeUser, projectId: string, permission: Permission): boolean {
    return this.effectivePermissions(user, projectId).includes(permission);
  }

  // --- Workflow sharing ----------------------------------------------------

  shareWorkflow(input: {
    workflowId: string;
    projectId: string;
    accessLevel: "read" | "execute";
    sharedBy?: string | null;
  }): void {
    this.store.upsertWorkflowShare(input);
  }

  unshareWorkflow(workflowId: string, projectId: string): boolean {
    return this.store.removeWorkflowShare(workflowId, projectId);
  }

  listWorkflowShares(workflowId: string) {
    return this.store.listWorkflowShares(workflowId);
  }

  listWorkflowsVisibleToProject(projectId: string): Map<string, "read" | "execute"> {
    const shares = this.store.listWorkflowsSharedToProject(projectId);
    const map = new Map<string, "read" | "execute">();
    for (const share of shares) {
      const level = share.accessLevel === "execute" ? "execute" : "read";
      map.set(share.workflowId, level);
    }
    return map;
  }

  canAccessWorkflow(user: SafeUser, workflow: { id: string; projectId?: string }, permission: Permission): boolean {
    const owningProject = workflow.projectId ?? DEFAULT_PROJECT_ID;
    if (this.can(user, owningProject, permission)) return true;

    // Check if the workflow is shared to any of the user's projects.
    const shares = this.store.listWorkflowShares(workflow.id);
    for (const share of shares) {
      if (!this.can(user, share.projectId, "workflow:read")) continue;
      if (permission === "workflow:read") return true;
      if (permission === "workflow:execute" && share.accessLevel === "execute") return true;
    }
    return false;
  }

  // --- Secret sharing ------------------------------------------------------

  shareSecret(input: { secretId: string; projectId: string; sharedBy?: string | null }): void {
    this.store.upsertSecretShare(input);
  }

  unshareSecret(secretId: string, projectId: string): boolean {
    return this.store.removeSecretShare(secretId, projectId);
  }

  listSecretShares(secretId: string) {
    return this.store.listSecretShares(secretId);
  }

  listSecretsVisibleToProject(projectId: string): Set<string> {
    return new Set(this.store.listSecretsSharedToProject(projectId));
  }

  // --- SSO group-to-role mappings -----------------------------------------

  upsertSsoGroupMapping(input: {
    id?: string;
    provider: string;
    groupName: string;
    projectId?: string | null;
    role: string;
    customRoleId?: string | null;
  }): string {
    const id = input.id ?? `sgm_${nanoid(12)}`;
    this.store.upsertSsoGroupMapping({
      id,
      provider: input.provider,
      groupName: input.groupName,
      projectId: input.projectId ?? null,
      role: input.role,
      customRoleId: input.customRoleId ?? null
    });
    return id;
  }

  listSsoGroupMappings(provider?: string) {
    return this.store.listSsoGroupMappings(provider);
  }

  deleteSsoGroupMapping(id: string): boolean {
    return this.store.deleteSsoGroupMapping(id);
  }
}
