/**
 * What the editor lets you do with the open workflow, and why not: your role first (viewers and operators open
 * workflows but do not change or run them from the editor), then your access to this workflow (a builder may only
 * view a workflow shared with them, or one in a project where their role is view-only).
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

export function editorAccess(role: Role | undefined, access: WorkflowAccessView | null): EditorAccess {
  if (role === "viewer") {
    return {
      editDisabledReason: "You have the viewer role: you can open workflows and their runs, but not change them.",
      runDisabledReason: "You have the viewer role: running a workflow needs the builder role."
    };
  }
  if (role === "operator") {
    return {
      editDisabledReason: "You have the operator role: you can open workflows and their runs, but not change them.",
      runDisabledReason: "You have the operator role: running a workflow from the editor needs the builder role."
    };
  }
  if (!access) return { editDisabledReason: null, runDisabledReason: null };
  return {
    editDisabledReason: access.canEdit ? null : "You can view this workflow but not change it: it is shared with you, or your role in its project is view-only.",
    runDisabledReason: access.canRun ? null : "You do not have permission to run this workflow."
  };
}
