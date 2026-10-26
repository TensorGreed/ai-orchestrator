/**
 * Project authorization for run data: executions, approvals, queue entries,
 * golden runs and knowledge bases.
 *
 * Every route that starts, reads or acts on a run checks the workflow it
 * belongs to, on top of the route's global role check:
 *
 *   - Admins always pass.
 *   - A user who cannot read the workflow gets 404, the same answer as for a
 *     run that does not exist, so ids from other projects reveal nothing.
 *   - A user who can read the workflow but lacks the permission the action
 *     needs (`workflow:execute`, `workflow:write`) gets 403.
 *   - Runs whose workflow was deleted are admin-only.
 *
 * List endpoints are narrowed to the workflows (or projects) the user can
 * read before paging, so totals never count rows from other projects.
 *
 * New routes that touch run or project data should use this helper rather
 * than calling the RBAC service directly, so the 404/403 rules stay the same.
 */

import { DEFAULT_PROJECT_ID, type Workflow } from "@ai-orchestrator/shared";
import type { SafeUser } from "./services/auth-service.js";
import { filterAsync } from "./async-array.js";

export type RunPermission = "workflow:read" | "workflow:write" | "workflow:execute" | "workflow:delete" | "workflow:publish";

export type RunAccessDenial = { ok: false; status: 403 | 404; error: string };
export type RunAccessResult<T> = ({ ok: true } & T) | RunAccessDenial;

interface ExecutionLike {
  id: string;
  workflowId: string;
}

export interface RunAccessDeps {
  getWorkflow: (id: string) => Promise<Workflow | null | undefined>;
  listWorkflows: () => Promise<Array<{ id: string; projectId?: string | null }>>;
  listProjectIds: () => Promise<string[]>;
  canAccessWorkflow: (user: SafeUser, workflow: { id: string; projectId?: string }, permission: RunPermission) => Promise<boolean>;
  canInProject: (user: SafeUser, projectId: string, permission: RunPermission) => Promise<boolean>;
  /** Workflow ids shared (read or execute) to a project. */
  listWorkflowIdsSharedToProject: (projectId: string) => Promise<string[]>;
  /** Does a project with this id exist? The default project always does. */
  projectExists: (projectId: string) => Promise<boolean>;
}

export interface RunAccess {
  /** May the user act on this workflow with `permission`? `what` names the thing in the 404 message. */
  workflow(user: SafeUser, workflowId: string, permission: RunPermission, what?: string): Promise<RunAccessResult<{ workflow: Workflow }>>;
  /** The same check for a run: resolves the run's workflow first. */
  run<T extends ExecutionLike>(user: SafeUser, run: T | null | undefined, permission: RunPermission, what?: string): Promise<RunAccessResult<{ run: T; workflow: Workflow | null }>>;
  /** Workflow ids the user can read, or `null` when the user can read everything (admins). */
  readableWorkflowIds(user: SafeUser): Promise<string[] | null>;
  /** Keeps the rows whose workflow the user can read. */
  filterRuns<T extends { workflowId: string }>(user: SafeUser, rows: T[]): Promise<T[]>;
  /** May the user act in this project? A missing project id means the default project. */
  project(user: SafeUser, projectId: string | null | undefined, permission: RunPermission, what?: string): Promise<RunAccessResult<Record<never, never>>>;
  /** Project ids the user can read, or `null` for admins. */
  readableProjectIds(user: SafeUser): Promise<string[] | null>;
}

const notFound = (what: string): RunAccessDenial => ({ ok: false, status: 404, error: `${what} not found` });
const forbidden = (permission: RunPermission): RunAccessDenial => ({ ok: false, status: 403, error: `Permission '${permission}' required for this workflow` });

export function createRunAccess(deps: RunAccessDeps): RunAccess {
  const workflowVerdict = async (user: SafeUser, workflow: Workflow | null | undefined, permission: RunPermission, what: string): Promise<RunAccessDenial | null> => {
    if (user.role === "admin") return null;
    if (!workflow) return notFound(what);
    const ref = { id: workflow.id, projectId: workflow.projectId ?? undefined };
    if (!await deps.canAccessWorkflow(user, ref, "workflow:read")) return notFound(what);
    if (permission !== "workflow:read" && !await deps.canAccessWorkflow(user, ref, permission)) return forbidden(permission);
    return null;
  };

  // One membership lookup per project instead of one (or two) per workflow:
  // a workflow is readable when its project is, or when it is shared to a
  // project the user can read. Same rule as `canAccessWorkflow`, batched.
  const readableWorkflowIds = async (user: SafeUser): Promise<string[] | null> => {
    if (user.role === "admin") return null;
    const verdicts = new Map<string, boolean>();
    const canRead = async (projectId: string) => {
      let verdict = verdicts.get(projectId);
      if (verdict === undefined) {
        verdict = await deps.canInProject(user, projectId, "workflow:read");
        verdicts.set(projectId, verdict);
      }
      return verdict;
    };
    const shared = new Set<string>();
    for (const projectId of await deps.listProjectIds()) {
      if (!await canRead(projectId)) continue;
      for (const workflowId of await deps.listWorkflowIdsSharedToProject(projectId)) shared.add(workflowId);
    }
    const readable: string[] = [];
    for (const workflow of await deps.listWorkflows()) {
      if (shared.has(workflow.id) || await canRead(workflow.projectId ?? DEFAULT_PROJECT_ID)) readable.push(workflow.id);
    }
    return readable;
  };

  const projectKnown = async (projectId: string) => projectId === DEFAULT_PROJECT_ID || await deps.projectExists(projectId);

  return {
    async workflow(user, workflowId, permission, what = "Workflow") {
      const workflow = await deps.getWorkflow(workflowId);
      if (!workflow) return notFound(what);
      const denial = await workflowVerdict(user, workflow, permission, what);
      return denial ?? { ok: true, workflow };
    },

    async run(user, run, permission, what = "Execution") {
      if (!run) return notFound(what);
      const workflow = await deps.getWorkflow(run.workflowId) ?? null;
      const denial = await workflowVerdict(user, workflow, permission, what);
      return denial ?? { ok: true, run, workflow };
    },

    readableWorkflowIds,

    async filterRuns(user, rows) {
      const readable = await readableWorkflowIds(user);
      if (readable === null) return rows;
      const ids = new Set(readable);
      return rows.filter((row) => ids.has(row.workflowId));
    },

    async project(user, projectId, permission, what = "Project") {
      if (user.role === "admin") return { ok: true };
      const id = projectId ?? DEFAULT_PROJECT_ID;
      // A project that does not exist (or was deleted) reads as missing.
      if (!await projectKnown(id) || !await deps.canInProject(user, id, "workflow:read")) return notFound(what);
      if (permission !== "workflow:read" && !await deps.canInProject(user, id, permission)) {
        return { ok: false, status: 403, error: `Permission '${permission}' required in this project` };
      }
      return { ok: true };
    },

    async readableProjectIds(user) {
      if (user.role === "admin") return null;
      return await filterAsync(await deps.listProjectIds(), (id) => deps.canInProject(user, id, "workflow:read"));
    }
  };
}
