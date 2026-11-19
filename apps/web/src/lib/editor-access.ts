/**
 * What the editor lets you do with the open workflow, and why not: your role first (viewers open workflows read-only;
 * operators open them read-only and may run the saved workflow where they have run access), then your access to this
 * workflow (a builder may only view a workflow shared with them, or one in a project where their role is view-only).
 */
export interface WorkflowAccessView {
  workflowId: string;
  canEdit: boolean;
  canRun: boolean;
  canShare: boolean;
}

export interface EditorAccess {
  /** null when you may change the workflow; otherwise the tooltip of the disabled Save, Add node and Clear. */
  editDisabledReason: string | null;
  /** null when you may run it; otherwise the tooltip of the disabled Run and Webhook run. */
  runDisabledReason: string | null;
}

type Role = "admin" | "builder" | "operator" | "viewer";

/** Whether a role may use the editor's run options (run from a node, one node, pinned data, recording). */
export function roleMayUseEditorRunOptions(role: Role | undefined): boolean {
  return role === "admin" || role === "builder";
}

const NO_RUN = "You do not have permission to run this workflow.";

export function editorAccess(role: Role | undefined, access: WorkflowAccessView | null): EditorAccess {
  if (role === "viewer") {
    return {
      editDisabledReason: "You have the viewer role: you can open workflows and their runs, but not change them.",
      runDisabledReason: "You have the viewer role: running a workflow needs the operator role or higher."
    };
  }
  if (role === "operator") {
    return {
      editDisabledReason: "You have the operator role: you can open and run workflows, but not change them.",
      // Until the workflow's access is known, Run waits for it.
      runDisabledReason: access?.canRun ? null : access ? NO_RUN : "Checking whether you may run this workflow…"
    };
  }
  if (!access) return { editDisabledReason: null, runDisabledReason: null };
  return {
    editDisabledReason: access.canEdit ? null : "You can view this workflow but not change it: it is shared with you, or your role in its project is view-only.",
    runDisabledReason: access.canRun ? null : NO_RUN
  };
}
