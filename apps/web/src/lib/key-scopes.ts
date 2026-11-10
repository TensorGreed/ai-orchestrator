/**
 * 13.2 — API key scopes as the server stores them: `role:<role>` (a ceiling) and `project:<id>` (an allow-list).
 * Anything else is a legacy free-form scope that the server keeps but does not enforce.
 */
export type KeyScopeRole = "admin" | "builder" | "operator" | "viewer";

export const KEY_SCOPE_ROLES: KeyScopeRole[] = ["viewer", "operator", "builder", "admin"];

export interface ParsedKeyScopes {
  role: KeyScopeRole | null;
  projects: string[];
  legacy: string[];
}

const RANK: Record<KeyScopeRole, number> = { viewer: 1, operator: 2, builder: 3, admin: 4 };

export function parseKeyScopes(scopes: readonly string[] | null | undefined): ParsedKeyScopes {
  let role: KeyScopeRole | null = null;
  const projects: string[] = [];
  const legacy: string[] = [];
  for (const entry of scopes ?? []) {
    const trimmed = entry.trim();
    if (trimmed.startsWith("role:") && (KEY_SCOPE_ROLES as string[]).includes(trimmed.slice(5))) {
      const next = trimmed.slice(5) as KeyScopeRole;
      role = role && RANK[role] <= RANK[next] ? role : next;
    } else if (trimmed.startsWith("project:") && /^\S{1,128}$/.test(trimmed.slice(8))) {
      if (!projects.includes(trimmed.slice(8))) projects.push(trimmed.slice(8));
    } else {
      legacy.push(entry);
    }
  }
  return { role, projects, legacy };
}

/** Roles a key may be capped at when its owner holds `ownerRole` (never above it). */
export function rolesUpTo(ownerRole: KeyScopeRole): KeyScopeRole[] {
  return KEY_SCOPE_ROLES.filter((role) => RANK[role] <= RANK[ownerRole]);
}

/** A one-line description of what a key may do, for key tables. */
export function describeKeyScopes(scopes: readonly string[] | null | undefined, projectName: (id: string) => string = (id) => id): string {
  const parsed = parseKeyScopes(scopes);
  const parts: string[] = [];
  if (parsed.projects.length > 0) {
    // A key limited to projects never acts above builder (the admin role is global).
    const role = parsed.role && RANK[parsed.role] < RANK.builder ? parsed.role : "builder";
    parts.push(`up to ${role}`, `projects: ${parsed.projects.map(projectName).join(", ")}`);
  } else if (parsed.role) {
    parts.push(`up to ${parsed.role}`);
  } else {
    parts.push("owner's role, all projects");
  }
  if (parsed.legacy.length > 0) parts.push(`legacy (not enforced): ${parsed.legacy.join(", ")}`);
  return parts.join(" · ");
}
