import { nanoid } from "nanoid";
import type { Workflow } from "@ai-orchestrator/shared";
import type { SqliteStore } from "../db/database";

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  version: number;
  createdBy: string | null;
  changeNote: string | null;
  createdAt: string;
}

export interface WorkflowVersionFull extends WorkflowVersionSummary {
  workflow: Workflow;
}

/**
 * Built-in version history for workflows. Every save is snapshotted into the
 * `workflow_versions` table so users can roll back without relying on git.
 */
export class WorkflowVersionService {
  constructor(
    private readonly store: SqliteStore,
    private readonly retention: number = 100
  ) {}

  snapshot(input: {
    workflow: Workflow;
    createdBy?: string | null;
    changeNote?: string | null;
  }): WorkflowVersionSummary {
    const nextVersion = this.store.maxWorkflowVersionNumber(input.workflow.id) + 1;
    const id = `wfv_${nanoid(14)}`;
    this.store.writeWorkflowVersion({
      id,
      workflowId: input.workflow.id,
      version: nextVersion,
      workflowJson: JSON.stringify(input.workflow),
      createdBy: input.createdBy ?? null,
      changeNote: input.changeNote ?? null
    });
    if (this.retention > 0) {
      this.store.pruneWorkflowVersions(input.workflow.id, this.retention);
    }
    return {
      id,
      workflowId: input.workflow.id,
      version: nextVersion,
      createdBy: input.createdBy ?? null,
      changeNote: input.changeNote ?? null,
      createdAt: new Date().toISOString()
    };
  }

  list(workflowId: string, limit = 100): WorkflowVersionSummary[] {
    return this.store.listWorkflowVersions(workflowId, limit);
  }

  get(workflowId: string, version: number): WorkflowVersionFull | null {
    const row = this.store.getWorkflowVersion(workflowId, version);
    if (!row) return null;
    let parsed: Workflow;
    try {
      parsed = JSON.parse(row.workflowJson) as Workflow;
    } catch {
      return null;
    }
    return {
      id: row.id,
      workflowId: row.workflowId,
      version: row.version,
      createdBy: row.createdBy,
      changeNote: row.changeNote,
      createdAt: row.createdAt,
      workflow: parsed
    };
  }
}
