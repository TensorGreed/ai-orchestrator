import { nanoid } from "nanoid";
import type { Workflow } from "@ai-orchestrator/shared";
import type { Store } from "../db/store.js";

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
    private readonly store: Store,
    private readonly retention: number = 100
  ) {}

  async snapshot(input: {
    workflow: Workflow;
    createdBy?: string | null;
    changeNote?: string | null;
  }): Promise<WorkflowVersionSummary> {
    const appended = await this.store.appendWorkflowVersion({
      id: `wfv_${nanoid(14)}`,
      workflowId: input.workflow.id,
      workflowJson: JSON.stringify(input.workflow),
      createdBy: input.createdBy ?? null,
      changeNote: input.changeNote ?? null,
      retention: this.retention
    });
    return {
      id: appended.id,
      workflowId: input.workflow.id,
      version: appended.version,
      createdBy: input.createdBy ?? null,
      changeNote: input.changeNote ?? null,
      createdAt: appended.createdAt
    };
  }

  async list(workflowId: string, limit = 100): Promise<WorkflowVersionSummary[]> {
    return await this.store.listWorkflowVersions(workflowId, limit);
  }

  /** Every node id any stored version of the workflow used (versions that do not parse are skipped). */
  async nodeIds(workflowId: string): Promise<string[]> {
    const ids = new Set<string>();
    for (const json of await this.store.listWorkflowVersionJson(workflowId)) {
      try {
        const parsed = JSON.parse(json) as { nodes?: Array<{ id?: unknown }> };
        for (const node of parsed.nodes ?? []) if (typeof node?.id === "string") ids.add(node.id);
      } catch {
        // A version that does not parse names no ids.
      }
    }
    return [...ids].sort();
  }

  async get(workflowId: string, version: number): Promise<WorkflowVersionFull | null> {
    const row = await this.store.getWorkflowVersion(workflowId, version);
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
