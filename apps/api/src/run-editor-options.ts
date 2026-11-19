/**
 * Who may start a run with what. A caller with `workflow:execute` on a workflow (operators, and people with an execute
 * share) may run the saved workflow by id with their input. Options that change what runs (start from a node, run one
 * node, pinned or copied node outputs, variable overrides, recording the run's MCP calls) and a workflow graph sent
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
  "variables",
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
