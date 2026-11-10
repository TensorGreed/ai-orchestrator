/**
 * 13.2 — the scope pickers of an API key form: a role ceiling and a project allow-list. Both are optional: a key with
 * neither acts with its owner's role in every project, as keys always did.
 */
import type { Project } from "@ai-orchestrator/shared";
import { rolesUpTo, type KeyScopeRole } from "../lib/key-scopes";

export interface KeyScopeValue {
  role: KeyScopeRole | "";
  projects: string[];
}

export const EMPTY_KEY_SCOPE: KeyScopeValue = { role: "", projects: [] };

/** The create payload fields for a scope value (nothing when no scope is picked). */
export function keyScopePayload(value: KeyScopeValue): { role?: KeyScopeRole; projects?: string[] } {
  return {
    ...(value.role ? { role: value.role } : {}),
    ...(value.projects.length > 0 ? { projects: value.projects } : {})
  };
}

export function KeyScopeFields({
  idPrefix,
  ownerRole,
  projects,
  value,
  onChange
}: {
  idPrefix: string;
  ownerRole: KeyScopeRole;
  projects: Project[];
  value: KeyScopeValue;
  onChange: (next: KeyScopeValue) => void;
}) {
  // A key limited to projects acts as builder at most (the admin role is global).
  const roles = rolesUpTo(ownerRole).filter((role) => value.projects.length === 0 || role !== "admin");
  const toggleProject = (projectId: string, checked: boolean) => {
    const projectsNext = checked ? [...value.projects, projectId] : value.projects.filter((id) => id !== projectId);
    onChange({ role: projectsNext.length > 0 && value.role === "admin" ? "builder" : value.role, projects: projectsNext });
  };
  return (
    <>
      <label htmlFor={`${idPrefix}-role`}>Role ceiling</label>
      <select id={`${idPrefix}-role`} value={value.role} onChange={(event) => onChange({ ...value, role: event.target.value as KeyScopeRole | "" })}>
        <option value="">{value.projects.length > 0 ? "Owner's role (builder at most)" : "Owner's role"}</option>
        {roles.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
      <fieldset className="settings-fieldset">
        <legend>Projects (none ticked: every project the owner can reach)</legend>
        {projects.map((project) => (
          <label key={project.id} className="settings-checkbox">
            <input
              type="checkbox"
              checked={value.projects.includes(project.id)}
              onChange={(event) => toggleProject(project.id, event.target.checked)}
            />
            {project.name}
          </label>
        ))}
      </fieldset>
    </>
  );
}
