/**
 * 13.2 — what an API key may do: a role ceiling and a project allow-list, stored as structured strings in the key's
 * existing `scopes` list.
 *
 *   role:<admin|builder|operator|viewer>   the key acts with at most this role (never above its owner's role)
 *   project:<projectId>                    the key reaches only the listed projects (repeatable)
 *
 * Any other string is a legacy free-form scope: it is kept and shown, and enforces nothing, as before. A key with no
 * structured scope acts with its owner's full role in every project, exactly as keys always did.
 *
 * A key limited to projects:
 *   - never acts as an admin (the admin role is global, so it cannot be held per project): its role is capped at
 *     builder;
 *   - may call only the routes in KEY_PROJECT_ROUTES, each of which checks the project of what it touches through the
 *     shared RBAC checks (rbacService.can, run-access). Every other route answers 403, so a route nobody reviewed for
 *     project scope fails closed. key-scope-routes.test.ts holds one cross-project row per listed route.
 */
import { z } from "zod";
import type { SafeUser, UserRole } from "./auth-service.js";
import type { Store } from "../db/store.js";

export const KEY_SCOPE_ROLES: readonly UserRole[] = ["viewer", "operator", "builder", "admin"];

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };

/** The highest role a key limited to projects can act with. */
export const PROJECT_KEY_MAX_ROLE: UserRole = "builder";

/** The longest project list one key may carry. */
export const KEY_SCOPE_MAX_PROJECTS = 50;

export interface KeyScope {
  /** The role the key acts with at most, or null for no ceiling (the owner's role). */
  roleCeiling: UserRole | null;
  /** The projects the key may reach, or null for every project the owner can reach. Never empty. */
  projects: string[] | null;
  /** Free-form strings that enforce nothing (shown as legacy). */
  legacy: string[];
}

export function roleRank(role: UserRole): number {
  return ROLE_RANK[role];
}

/** The lower of two roles. */
export function lowerRole(a: UserRole, b: UserRole): UserRole {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

function asRole(value: string): UserRole | null {
  return (KEY_SCOPE_ROLES as readonly string[]).includes(value) ? (value as UserRole) : null;
}

/** A project id as a scope may name it: 1 to 128 characters, no whitespace. */
const PROJECT_ID_PATTERN = /^\S{1,128}$/;

/**
 * Reads a key's stored scopes. Several `role:` entries keep the lowest; `project:` entries are de-duplicated in order.
 * A malformed structured entry (an unknown role, an empty project) is legacy, so it never widens anything.
 */
export function parseKeyScopes(scopes: readonly string[] | null | undefined): KeyScope {
  let roleCeiling: UserRole | null = null;
  const projects: string[] = [];
  const legacy: string[] = [];
  for (const raw of scopes ?? []) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim();
    if (entry.startsWith("role:")) {
      const role = asRole(entry.slice("role:".length));
      if (role) {
        roleCeiling = roleCeiling ? lowerRole(roleCeiling, role) : role;
        continue;
      }
    } else if (entry.startsWith("project:")) {
      const projectId = entry.slice("project:".length);
      if (PROJECT_ID_PATTERN.test(projectId)) {
        if (!projects.includes(projectId)) projects.push(projectId);
        continue;
      }
    }
    legacy.push(raw);
  }
  return { roleCeiling, projects: projects.length > 0 ? projects : null, legacy };
}

/** True when the key carries a ceiling or a project list (something is enforced). */
export function isStructuredScope(scope: KeyScope): boolean {
  return scope.roleCeiling !== null || scope.projects !== null;
}

/** The stored form of a scope: `role:` first, then `project:` entries, then legacy strings as given. */
export function formatKeyScopes(scope: { roleCeiling?: UserRole | null; projects?: readonly string[] | null; legacy?: readonly string[] }): string[] {
  return [
    ...(scope.roleCeiling ? [`role:${scope.roleCeiling}`] : []),
    ...[...new Set(scope.projects ?? [])].map((projectId) => `project:${projectId}`),
    ...(scope.legacy ?? [])
  ];
}

/** The role a key acts with: its owner's role, capped at the ceiling, and at builder when it is limited to projects. */
export function effectiveKeyRole(ownerRole: UserRole, scope: KeyScope): UserRole {
  let role = scope.roleCeiling ? lowerRole(ownerRole, scope.roleCeiling) : ownerRole;
  if (scope.projects) role = lowerRole(role, PROJECT_KEY_MAX_ROLE);
  return role;
}

/** The user a key acts as: the owner with the effective role, and the project list when there is one. */
export function scopedKeyUser(owner: SafeUser, scope: KeyScope, apiKeyId?: string): SafeUser {
  const user: SafeUser = { id: owner.id, email: owner.email, role: effectiveKeyRole(owner.role, scope) };
  if (scope.projects) user.projectScope = [...scope.projects];
  if (apiKeyId) user.apiKeyId = apiKeyId;
  if (owner.serviceAccount) user.serviceAccount = true;
  return user;
}

/**
 * The user work that goes on later runs as (a resumed approval, a queued run, an eval or replay case), found again by
 * id. When an API key decided or started that work, it keeps the key's limits (its role ceiling and project list),
 * and is refused (null, as for a deleted user) once the key is revoked, has expired or belongs to someone else.
 */
export async function keyBoundUser(
  store: Pick<Store, "getUserById" | "listApiKeys">,
  userId: string,
  apiKeyId?: string | null,
  now: number = Date.now()
): Promise<SafeUser | null> {
  const found = await store.getUserById(userId);
  if (!found) return null;
  const user: SafeUser = { id: found.id, email: found.email, role: found.role as UserRole, ...(found.kind === "service" ? { serviceAccount: true as const } : {}) };
  if (!apiKeyId) return user;
  const key = (await store.listApiKeys(found.id)).find((entry) => entry.id === apiKeyId && entry.userId === found.id);
  if (!key || key.revokedAt || (key.expiresAt && Date.parse(key.expiresAt) <= now)) return null;
  return scopedKeyUser(user, parseKeyScopes(key.scopes), key.id);
}

/**
 * The routes a key limited to projects may call (`METHOD /route/pattern`, as Fastify names the route). Each one checks
 * the project of what it reads or changes through rbacService.can or run-access, which honour the key's project list.
 * Adding a route here needs a row in key-scope-routes.test.ts (the test fails otherwise).
 */
export const KEY_PROJECT_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/auth/me",
  "GET /api/projects",
  "GET /api/workflows",
  "POST /api/workflows",
  "GET /api/workflows/:id",
  "PUT /api/workflows/:id",
  "POST /api/workflows/:id/execute",
  "POST /api/workflows/:id/execute/stream",
  "GET /api/executions",
  "GET /api/executions/:id",
  "GET /api/executions/:id/events",
  "POST /api/executions/:id/retry",
  "POST /api/executions/:id/cancel",
  "GET /api/approvals",
  "POST /api/approvals/:id/approve",
  "POST /api/approvals/:id/reject"
]);

/** May a key with this scope call the route? Keys without a project list may call any route their role allows. */
export function keyMayCallRoute(scope: KeyScope, method: string | undefined, routeUrl: string | undefined): boolean {
  if (!scope.projects) return true;
  if (!method || !routeUrl) return false;
  // HEAD requests are answered by the GET handler.
  const verb = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  return KEY_PROJECT_ROUTES.has(`${verb} ${routeUrl}`);
}

/**
 * Routes that change the security of the key owner's own account (MFA). A key with a scope (a role ceiling or a
 * project list) may not call them, whatever its role: a session or an unscoped key may. A scoped key also revokes no
 * key but itself (DELETE /api/auth/api-keys/:id checks that). There is no self-service password route.
 */
export const ACCOUNT_SECURITY_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/auth/mfa/enroll",
  "POST /api/auth/mfa/activate",
  "POST /api/auth/mfa/disable"
]);

/** Whether a key with this scope may call this account-security route (true for every other route). */
export function keyMayManageAccount(scope: KeyScope, method: string | undefined, routeUrl: string | undefined): boolean {
  if (!isStructuredScope(scope)) return true;
  if (!method || !routeUrl) return true;
  return !ACCOUNT_SECURITY_ROUTES.has(`${method.toUpperCase()} ${routeUrl}`);
}

export type KeyScopeRequestError = { status: 400 | 403; error: string };

/**
 * The body of a key create (personal keys and service-account keys). `role` and `projects` are the structured way to
 * scope a key; `scopes` takes the stored strings directly (structured or legacy), as it always did.
 */
export const apiKeyCreateBodySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1).max(160)).optional(),
  role: z.enum(["admin", "builder", "operator", "viewer"]).nullable().optional(),
  projects: z.array(z.string().min(1).max(128)).max(KEY_SCOPE_MAX_PROJECTS).nullable().optional(),
  expiresInDays: z.number().int().nonnegative().optional()
});

/** What a caller asks for when creating a key. */
export interface KeyScopeRequest {
  /** Raw stored strings (structured or legacy), as the API always accepted. */
  scopes?: readonly string[];
  role?: UserRole | null;
  projects?: readonly string[] | null;
}

/**
 * The scope a new key gets, checked against who may hold it:
 *   - `ownerRole`: the role of the account the key belongs to; the ceiling may not be above it.
 *   - `callerScope`: when the request itself is authenticated by a key with a structured scope, the new key may not
 *     reach further than that key (an unscoped request inherits its ceiling and project list).
 * `projectExists` refuses unknown projects.
 */
export async function resolveNewKeyScope(
  request: KeyScopeRequest,
  options: {
    ownerRole: UserRole;
    callerRole: UserRole;
    callerScope: KeyScope | null;
    projectExists: (projectId: string) => Promise<boolean>;
  }
): Promise<{ ok: true; scopes: string[]; scope: KeyScope } | ({ ok: false } & KeyScopeRequestError)> {
  const fromStrings = parseKeyScopes(request.scopes);
  for (const entry of request.scopes ?? []) {
    const trimmed = entry.trim();
    if ((trimmed.startsWith("role:") || trimmed.startsWith("project:")) && fromStrings.legacy.includes(entry)) {
      return { ok: false, status: 400, error: `Invalid scope '${entry}': use role:<admin|builder|operator|viewer> or project:<projectId>` };
    }
  }
  let roleCeiling: UserRole | null = request.role ?? fromStrings.roleCeiling;
  if (request.role && fromStrings.roleCeiling) roleCeiling = lowerRole(request.role, fromStrings.roleCeiling);
  const requestedProjects = [...new Set([...(request.projects ?? []), ...(fromStrings.projects ?? [])])];
  for (const projectId of requestedProjects) {
    if (!PROJECT_ID_PATTERN.test(projectId)) return { ok: false, status: 400, error: `Invalid project id '${projectId}'` };
  }
  if (requestedProjects.length > KEY_SCOPE_MAX_PROJECTS) {
    return { ok: false, status: 400, error: `A key may name at most ${KEY_SCOPE_MAX_PROJECTS} projects` };
  }
  let projects: string[] | null = requestedProjects.length > 0 ? requestedProjects : null;

  // A key made with a scoped key reaches no further than that key.
  const caller = options.callerScope && isStructuredScope(options.callerScope) ? options.callerScope : null;
  if (caller) {
    if (!roleCeiling) roleCeiling = options.callerRole;
    if (caller.projects) {
      if (!projects) projects = [...caller.projects];
      const outside = projects.filter((projectId) => !caller.projects?.includes(projectId));
      if (outside.length > 0) {
        return { ok: false, status: 403, error: `This API key cannot create a key for project(s) it cannot reach: ${outside.join(", ")}` };
      }
    }
  }
  if (roleCeiling && roleRank(roleCeiling) > roleRank(options.ownerRole)) {
    return { ok: false, status: 403, error: `A key cannot carry the ${roleCeiling} role: its owner is ${options.ownerRole}` };
  }
  if (roleCeiling && roleRank(roleCeiling) > roleRank(options.callerRole)) {
    return { ok: false, status: 403, error: `A ${options.callerRole} cannot create a key with the ${roleCeiling} role` };
  }
  if (projects && roleCeiling === "admin") {
    return { ok: false, status: 400, error: "A key limited to projects cannot carry the admin role (admin is global); use builder or lower" };
  }
  for (const projectId of projects ?? []) {
    if (!await options.projectExists(projectId)) return { ok: false, status: 400, error: `Unknown project '${projectId}'` };
  }
  const scope: KeyScope = { roleCeiling, projects, legacy: fromStrings.legacy };
  return { ok: true, scope, scopes: formatKeyScopes(scope) };
}
