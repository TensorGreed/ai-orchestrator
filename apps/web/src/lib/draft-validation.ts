import type { WorkflowValidationIssue } from "@ai-orchestrator/shared";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The issue messages of an API error's `validation` block, in order. */
export function validationMessagesOf(payload?: Record<string, unknown>): string[] {
  const issues = asRecord(payload?.validation)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .map((issue) => {
      const record = asRecord(issue);
      return record && typeof record.message === "string" ? record.message : "";
    })
    .filter((message) => message.length > 0);
}

/**
 * The text shown for a failed request: its message, followed by the validation issues the message does not already
 * name (the API's save error lists them itself, so they are not repeated).
 */
export function apiErrorText(message: string, payload?: Record<string, unknown>): string {
  const missing = [...new Set(validationMessagesOf(payload))].filter((issue) => !message.includes(issue));
  return missing.length > 0 ? `${message}: ${missing.join("; ")}` : message;
}

export interface DraftIssues {
  /** Issues a run stops at: the workflow saved, but it cannot run until each is fixed. */
  toFix: WorkflowValidationIssue[];
  /** Notes that do not stop a run (no Output node, a model the allowlist refuses, ...). */
  notes: WorkflowValidationIssue[];
}

/** Splits a saved workflow's validation issues into what stops a run and what is only a note. */
export function splitDraftIssues(issues: readonly WorkflowValidationIssue[] | null | undefined): DraftIssues {
  const toFix: WorkflowValidationIssue[] = [];
  const notes: WorkflowValidationIssue[] = [];
  for (const issue of issues ?? []) {
    (issue.severity === "warning" ? notes : toFix).push(issue);
  }
  return { toFix, notes };
}

/**
 * Warnings shown when a workflow is opened, not only after a save: each one is something to fix that a run does not
 * stop at (an `errorConfig` stored with invalid values blocks the next save until it is removed).
 */
const SHOWN_ON_OPEN_WARNING_CODES: ReadonlySet<string> = new Set(["invalid_error_config"]);

/** Whether the editor shows `issue` for a workflow just opened (`afterSave` false) or just saved. */
export function draftIssueShown(issue: WorkflowValidationIssue, afterSave: boolean): boolean {
  return afterSave || issue.severity !== "warning" || SHOWN_ON_OPEN_WARNING_CODES.has(issue.code);
}
