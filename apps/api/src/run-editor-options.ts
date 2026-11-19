/**
 * Who may start a run with what. A caller with `workflow:execute` on a workflow (operators, and people with an execute
 * share) may run the saved workflow by id with their input. Options that change what runs (start from a node, run one
 * node, pinned or copied node outputs, recording the run's MCP calls) and a workflow graph sent
 * with the request are the editor's: builder and up only. (The run routes never run a graph from the request; an
 * operator who sends one is told so instead of having it ignored.)
 */
import type { UserRole } from "./services/auth-service.js";
import { roleRank } from "./services/key-scopes.js";

/** The run request fields only a builder (or admin) may send. */
export const EDITOR_RUN_OPTIONS = [
  "startNodeId",
  "runMode",
  "usePinnedData",
  "pinnedData",
  "nodeOutputs",
  "sourceExecutionId",
  "nodeOutputsExecutionId",
  "record",
  "workflow",
  "nodes",
  "edges"
] as const;

/** Whether a role may use the editor's run options. */
export function roleMayUseEditorRunOptions(role: UserRole): boolean {
  return roleRank(role) >= roleRank("builder");
}

/**
 * The editor-only options a run request sets (absent, `false` and `runMode: "workflow"` do not count), or an empty list
 * when the role may use them.
 */
export function editorRunOptionsRefused(role: UserRole, rawBody: unknown): string[] {
  if (roleMayUseEditorRunOptions(role)) return [];
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return [];
  const body = rawBody as Record<string, unknown>;
  return EDITOR_RUN_OPTIONS.filter((key) => {
    const value = body[key];
    if (value === undefined || value === null || value === false) return false;
    if (key === "runMode" && value === "workflow") return false;
    return true;
  });
}

/** The 403 answer for a refused option list. */
export function editorRunOptionsError(refused: string[]): { error: string; refusedOptions: string[] } {
  return {
    error: `Only builders and admins may set ${refused.join(", ")} on a run; run the saved workflow with your input instead`,
    refusedOptions: refused
  };
}

/**
 * What a run by a role without the editor's options gets on top of its request: no pinned data (the engine uses the
 * workflow's pins unless told not to; pins are the editor's), and a timeout no longer than the deployment's.
 */
export function savedRunLimits(
  role: UserRole,
  timeoutMs: number,
  defaultTimeoutMs: number
): { usePinnedData?: false; pinnedData?: undefined; executionTimeoutMs: number } {
  if (roleMayUseEditorRunOptions(role)) return { executionTimeoutMs: timeoutMs };
  return { usePinnedData: false, pinnedData: undefined, executionTimeoutMs: Math.min(timeoutMs, defaultTimeoutMs) };
}

/**
 * Whose session memory a run uses, when it is kept to one person: the id of a signed-in person below builder
 * (operators), or of anyone who runs the workflow only through a share with them. Their runs read and write session
 * memory, the session tool cache and session artifacts under their own key, so knowing someone else's session id does
 * not continue that person's conversation. Builders and admins with access through their projects, API keys and
 * service accounts get `undefined`: their runs use the workflow's sessions as before.
 */
export function personalSessionOwner(
  user: { id: string; role: UserRole; apiKeyId?: string; serviceAccount?: true },
  runsOnlyThroughUserShare: boolean
): string | undefined {
  if (user.apiKeyId || user.serviceAccount) return undefined;
  if (!roleMayUseEditorRunOptions(user.role) || runsOnlyThroughUserShare) return user.id;
  return undefined;
}
