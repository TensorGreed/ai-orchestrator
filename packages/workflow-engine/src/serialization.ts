import { WORKFLOW_SCHEMA_VERSION, workflowSchema, type Workflow } from "@ai-orchestrator/shared";

export interface WorkflowExportPayload {
  schemaVersion: string;
  workflowVersion: number;
  workflow: Workflow;
  exportedAt: string;
}

export function exportWorkflowToJson(workflow: Workflow): string {
  const payload: WorkflowExportPayload = {
    schemaVersion: workflow.schemaVersion || WORKFLOW_SCHEMA_VERSION,
    workflowVersion: workflow.workflowVersion,
    workflow,
    exportedAt: new Date().toISOString()
  };

  return JSON.stringify(payload, null, 2);
}

export function importWorkflowFromJson(raw: string): Workflow {
  const parsed = JSON.parse(raw) as Workflow | WorkflowExportPayload;
  const workflowCandidate = "workflow" in parsed ? parsed.workflow : parsed;

  const normalized: Workflow = {
    ...workflowCandidate,
    schemaVersion: workflowCandidate.schemaVersion || WORKFLOW_SCHEMA_VERSION,
    workflowVersion: workflowCandidate.workflowVersion || 1
  };

  return workflowSchema.parse(normalized);
}