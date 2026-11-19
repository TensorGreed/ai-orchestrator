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
 * Someone who can read a workflow only through a share with them (not as a
 * member of its project, not through a project share, not an admin) sees only
 * their own runs of it: the runs they started and the runs whose sessions are
 * theirs (`session_owner`). Who started a run is its starter's user id (v80;
 * migration 80 set it on the runs recorded before), never an email
 * (`runOwnedBy`). Anyone else's run answers 404, as a missing one.
 * Run lists apply the same rule before paging (`runListScope`), and data built
 * from many people's runs (golden runs, captures, cassettes, eval and replay
 * runs, content-rule events, the dead-letter queue) leaves such workflows out
 * (`runVisibleWorkflowIds`).
 *
 * New routes that touch run or project data should use this helper rather
 * than calling the RBAC service directly, so the 404/403 rules stay the same.
 */

import { DEFAULT_PROJECT_ID, type Workflow } from "@ai-orchestrator/shared";
import type { SafeUser } from "./services/auth-service.js";
import type { OwnRunsFilter } from "./db/database.js";
import { filterAsync } from "./async-array.js";

export type RunPermission = "workflow:read" | "workflow:write" | "workflow:execute" | "workflow:delete" | "workflow:publish";

export type RunAccessDenial = { ok: false; status: 403 | 404; error: string };
export type RunAccessResult<T> = ({ ok: true } & T) | RunAccessDenial;

interface ExecutionLike {
  id: string;
  workflowId: string;
  /** The run this record belongs to, when `id` is not a run id (a cassette, a captured run). */
  executionId?: string | null;
}

/** Who a run belongs to: who started it and whose sessions it used. */
export interface RunOwner {
  /** v80 — the user id of the person who started it; null when no person did, or none could be told (migration 80). */
  triggeredByUserId: string | null;
  sessionOwner: string | null;
}

/** Runs of these workflows are the person's own only: they started them, or the runs used their sessions. */
export type OwnRunsOnly = OwnRunsFilter;

/**
 * Which runs a list may show: every run of `workflowIds`, and the person's own runs of `ownRunsOnly.workflowIds`
 * (null when there are none).
 */
export interface RunListScope {
  workflowIds: string[];
  ownRunsOnly: OwnRunsOnly | null;
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
  /** v78 — workflow ids shared with this person (read or execute), from one indexed read. */
  listWorkflowIdsSharedToUser?: (userId: string) => Promise<string[]>;
  /** Does the person read this workflow only through a share with them? Then they see only their own runs of it. */
  readsOnlyThroughUserShare: (user: SafeUser, workflow: { id: string; projectId?: string | null }) => Promise<boolean>;
  /** Who a run belongs to; null when there is no such run. */
  getRunOwner: (executionId: string) => Promise<RunOwner | null>;
}

export interface RunAccess {
  /** May the user act on this workflow with `permission`? `what` names the thing in the 404 message. */
  workflow(user: SafeUser, workflowId: string, permission: RunPermission, what?: string): Promise<RunAccessResult<{ workflow: Workflow }>>;
  /**
   * The workflow-level check for runs of a workflow, as `run` makes it but for no run in particular: admins pass also
   * when the workflow was deleted. It does not judge whose run it is: use `run` for that.
   */
  runsOfWorkflow(user: SafeUser, workflowId: string, permission: RunPermission, what?: string): Promise<RunAccessResult<{ workflow: Workflow | null }>>;
  /** The same check for a run: resolves the run's workflow first. */
  run<T extends ExecutionLike>(user: SafeUser, run: T | null | undefined, permission: RunPermission, what?: string): Promise<RunAccessResult<{ run: T; workflow: Workflow | null }>>;
  /** Workflow ids the user can read, or `null` when the user can read everything (admins). */
  readableWorkflowIds(user: SafeUser): Promise<string[] | null>;
  /** The runs a run list may show the user, or `null` for every run (admins). */
  runListScope(user: SafeUser): Promise<RunListScope | null>;
  /**
   * Workflow ids whose runs the user sees all of, or `null` for admins: readable workflows except those shared only
   * with the person. For data built from many people's runs.
   */
  runVisibleWorkflowIds(user: SafeUser): Promise<string[] | null>;
  /** Does the user see every run of this workflow (true), or only their own (false)? */
  seesAllRuns(user: SafeUser, workflow: { id: string; projectId?: string | null }): Promise<boolean>;
  /** Is this run the user's own: started by them, or run in their sessions? */
  ownsRun(user: SafeUser, executionId: string): Promise<boolean>;
  /** Keeps the rows the user may see: of readable workflows, and only their own runs where that is all they see. */
  filterRuns<T extends { workflowId: string; id?: string; executionId?: string | null }>(user: SafeUser, rows: T[]): Promise<T[]>;
  /** May the user act in this project? A missing project id means the default project. */
  project(user: SafeUser, projectId: string | null | undefined, permission: RunPermission, what?: string): Promise<RunAccessResult<Record<never, never>>>;
  /** Project ids the user can read, or `null` for admins. */
  readableProjectIds(user: SafeUser): Promise<string[] | null>;
}

/**
 * Admins pass every project check, unless the request's API key is limited to projects (13.2). Such a key is capped
 * at builder already; this keeps the shortcut closed should that cap ever change.
 */
const globalAdmin = (user: SafeUser): boolean => user.role === "admin" && !user.projectScope;

/**
 * Is the run the person's: run in their sessions, or started by them (its starter's user id, v80)? Never by email: an
 * email given to another account does not bring runs with it. The same rule as the stores' SQL (db/own-runs-sql.ts).
 */
export function runOwnedBy(owner: RunOwner, userId: string): boolean {
  return owner.sessionOwner === userId || owner.triggeredByUserId === userId;
}

const executionIdOf = (run: ExecutionLike): string => (typeof run.executionId === "string" && run.executionId ? run.executionId : run.id);

const notFound = (what: string): RunAccessDenial => ({ ok: false, status: 404, error: `${what} not found` });
const forbidden = (permission: RunPermission): RunAccessDenial => ({ ok: false, status: 403, error: `Permission '${permission}' required for this workflow` });

/**
 * Who sees an MCP elicitation (the elicitation API, a run's event streams and the MCP overview count): like approvals,
 * users who can read the run's workflow. A request from a run someone else started is shown only to users who may also
 * run that workflow (`workflow:execute`), judged in the workflow's project as every other run action is: global admins
 * always, otherwise the user's membership role there (project admins and editors yes, project viewers no, custom roles
 * by what they grant), and without a membership the global role where isolation allows it (operators, builders and
 * admins yes, viewers no). The user who started the run, or anyone who can read it when nobody did, sees it too.
 */
export async function elicitationVisibleTo(
  runAccess: RunAccess,
  user: SafeUser,
  record: { createdBy: string | null; workflowId: string; executionId?: string | null }
): Promise<boolean> {
  const own = !record.createdBy || record.createdBy === user.id;
  const permission = own ? "workflow:read" : "workflow:execute";
  // Someone who sees only their own runs of the workflow sees only the questions of those runs.
  if (record.executionId) {
    const access = await runAccess.run(user, { id: record.executionId, workflowId: record.workflowId }, permission);
    // A deleted workflow's questions stay hidden, also from admins (they cannot be answered).
    return access.ok && access.workflow !== null;
  }
  const access = await runAccess.workflow(user, record.workflowId, permission);
  return access.ok && await runAccess.seesAllRuns(user, access.workflow);
}

export function createRunAccess(deps: RunAccessDeps): RunAccess {
  const workflowVerdict = async (user: SafeUser, workflow: Workflow | null | undefined, permission: RunPermission, what: string): Promise<RunAccessDenial | null> => {
    if (globalAdmin(user)) return null;
    if (!workflow) return notFound(what);
    const ref = { id: workflow.id, projectId: workflow.projectId ?? undefined };
    if (!await deps.canAccessWorkflow(user, ref, "workflow:read")) return notFound(what);
    if (permission !== "workflow:read" && !await deps.canAccessWorkflow(user, ref, permission)) return forbidden(permission);
    return null;
  };

  // One membership lookup per project instead of one (or two) per workflow:
  // a workflow is readable when its project is, or when it is shared to a
  // project the user can read. Same rule as `canAccessWorkflow`, batched.
  // `ownOnly` holds the readable workflows the user reads only through a share with them.
  const classifyWorkflows = async (user: SafeUser): Promise<{ full: string[]; ownOnly: string[] }> => {
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
    // v78 — shared with the person: readable, unless an API key limits the request to other projects.
    const sharedToUser = new Set(deps.listWorkflowIdsSharedToUser ? await deps.listWorkflowIdsSharedToUser(user.id) : []);
    const scopeAllows = (projectId: string) => !user.projectScope || user.projectScope.includes(projectId);
    const full: string[] = [];
    const ownOnly: string[] = [];
    for (const workflow of await deps.listWorkflows()) {
      const projectId = workflow.projectId ?? DEFAULT_PROJECT_ID;
      if (shared.has(workflow.id) || await canRead(projectId)) full.push(workflow.id);
      else if (sharedToUser.has(workflow.id) && scopeAllows(projectId)) ownOnly.push(workflow.id);
    }
    return { full, ownOnly };
  };

  const readableWorkflowIds = async (user: SafeUser): Promise<string[] | null> => {
    if (globalAdmin(user)) return null;
    const { full, ownOnly } = await classifyWorkflows(user);
    return [...full, ...ownOnly];
  };

  const seesAllRuns = async (user: SafeUser, workflow: { id: string; projectId?: string | null }): Promise<boolean> =>
    globalAdmin(user) || !await deps.readsOnlyThroughUserShare(user, workflow);

  const ownsRun = async (user: SafeUser, executionId: string): Promise<boolean> => {
    const owner = await deps.getRunOwner(executionId);
    return owner !== null && runOwnedBy(owner, user.id);
  };

  /** A readable run the user still may not see: someone else's run of a workflow they see only their own runs of. */
  const hiddenRun = async (user: SafeUser, run: ExecutionLike, workflow: Workflow | null): Promise<boolean> => {
    if (globalAdmin(user) || !workflow) return false;
    if (await seesAllRuns(user, workflow)) return false;
    return !await ownsRun(user, executionIdOf(run));
  };

  const projectKnown = async (projectId: string) => projectId === DEFAULT_PROJECT_ID || await deps.projectExists(projectId);

  return {
    async workflow(user, workflowId, permission, what = "Workflow") {
      const workflow = await deps.getWorkflow(workflowId);
      if (!workflow) return notFound(what);
      const denial = await workflowVerdict(user, workflow, permission, what);
      return denial ?? { ok: true, workflow };
    },

    async runsOfWorkflow(user, workflowId, permission, what = "Workflow") {
      const workflow = await deps.getWorkflow(workflowId) ?? null;
      const denial = await workflowVerdict(user, workflow, permission, what);
      return denial ?? { ok: true, workflow };
    },

    async run(user, run, permission, what = "Execution") {
      if (!run) return notFound(what);
      const workflow = await deps.getWorkflow(run.workflowId) ?? null;
      // Read first, then whether the run is theirs to see, and only then the action's permission: someone else's run
      // must answer as missing (404) before a 403 for the action could tell them it exists.
      const readDenial = await workflowVerdict(user, workflow, "workflow:read", what);
      if (readDenial) return readDenial;
      if (await hiddenRun(user, run, workflow)) return notFound(what);
      const denial = permission === "workflow:read" ? null : await workflowVerdict(user, workflow, permission, what);
      if (denial) return denial;
      return { ok: true, run, workflow };
    },

    readableWorkflowIds,

    async runListScope(user) {
      if (globalAdmin(user)) return null;
      const { full, ownOnly } = await classifyWorkflows(user);
      return {
        workflowIds: full,
        ownRunsOnly: ownOnly.length > 0 ? { workflowIds: ownOnly, userId: user.id, email: user.email } : null
      };
    },

    async runVisibleWorkflowIds(user) {
      if (globalAdmin(user)) return null;
      return (await classifyWorkflows(user)).full;
    },

    seesAllRuns,

    ownsRun,

    async filterRuns(user, rows) {
      if (globalAdmin(user)) return rows;
      const { full, ownOnly } = await classifyWorkflows(user);
      const all = new Set(full);
      const own = new Set(ownOnly);
      const kept: typeof rows = [];
      for (const row of rows) {
        const runId = row.executionId || row.id;
        if (all.has(row.workflowId) || (own.has(row.workflowId) && runId && await ownsRun(user, runId))) kept.push(row);
      }
      return kept;
    },

    async project(user, projectId, permission, what = "Project") {
      if (globalAdmin(user)) return { ok: true };
      const id = projectId ?? DEFAULT_PROJECT_ID;
      // A project that does not exist (or was deleted) reads as missing.
      if (!await projectKnown(id) || !await deps.canInProject(user, id, "workflow:read")) return notFound(what);
      if (permission !== "workflow:read" && !await deps.canInProject(user, id, permission)) {
        return { ok: false, status: 403, error: `Permission '${permission}' required in this project` };
      }
      return { ok: true };
    },

    async readableProjectIds(user) {
      if (globalAdmin(user)) return null;
      return await filterAsync(await deps.listProjectIds(), (id) => deps.canInProject(user, id, "workflow:read"));
    }
  };
}
