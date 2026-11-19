/**
 * A template may bring the workflows it calls: an export's `companions` (each one a workflow export) are created next
 * to the new workflow when the template is used, with new ids, and the new workflow's Execute Workflow and Workflow
 * Tool nodes are pointed at them. A template without companions is used as before.
 */
import { importWorkflowFromJson } from "@ai-orchestrator/workflow-engine";
import type { Workflow } from "@ai-orchestrator/shared";

/** The most companions one template may bring. */
export const MAX_TEMPLATE_COMPANIONS = 5;

/** Node types whose `config.workflowId` names another workflow. */
const WORKFLOW_REFERENCE_NODE_TYPES = new Set(["execute_workflow", "workflow_tool"]);

/** The workflows a template's JSON brings with it (none for a plain workflow or export). Throws on an invalid one. */
export function templateCompanions(workflowJson: string): Workflow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(workflowJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const companions = (parsed as Record<string, unknown>).companions;
  if (!Array.isArray(companions) || companions.length === 0) return [];
  if (companions.length > MAX_TEMPLATE_COMPANIONS) {
    throw new Error(`A template may bring at most ${MAX_TEMPLATE_COMPANIONS} companion workflows.`);
  }
  const workflows = companions.map((companion) => importWorkflowFromJson(JSON.stringify(companion)));
  const ids = new Set(workflows.map((workflow) => workflow.id));
  if (ids.size !== workflows.length) throw new Error("Each companion workflow of a template needs its own id.");
  return workflows;
}

/** The workflow with each Execute Workflow / Workflow Tool reference found in `idMap` pointed at its new id. */
export function withRemappedWorkflowReferences(workflow: Workflow, idMap: ReadonlyMap<string, string>): Workflow {
  if (idMap.size === 0) return workflow;
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (!WORKFLOW_REFERENCE_NODE_TYPES.has(node.type)) return node;
      const config = (node.config ?? {}) as Record<string, unknown>;
      const current = typeof config.workflowId === "string" ? config.workflowId.trim() : "";
      const next = idMap.get(current);
      return next ? { ...node, config: { ...config, workflowId: next } } : node;
    })
  };
}
