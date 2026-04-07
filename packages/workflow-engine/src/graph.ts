import type { WorkflowEdge } from "@ai-orchestrator/shared";

export const AGENT_ATTACHMENT_HANDLES = ["chat_model", "memory", "tool", "worker"] as const;
const AGENT_ATTACHMENT_SET = new Set<string>(AGENT_ATTACHMENT_HANDLES);

export const BRANCH_HANDLES_IF = new Set(["true", "false"]);
export const BRANCH_HANDLES_TRY_CATCH = new Set(["success", "error"]);

export function isAgentAttachmentEdge(edge: WorkflowEdge): boolean {
  return Boolean(edge.sourceHandle && AGENT_ATTACHMENT_SET.has(edge.sourceHandle));
}

export function isAuxiliaryEdge(edge: WorkflowEdge): boolean {
  if (isAgentAttachmentEdge(edge)) {
    return true;
  }

  return Boolean(edge.sourceHandle?.startsWith("aux") || edge.targetHandle?.startsWith("aux"));
}

export function isExecutionEdge(edge: WorkflowEdge): boolean {
  return !isAuxiliaryEdge(edge);
}

export function isBranchingEdge(edge: WorkflowEdge): boolean {
  if (!edge.sourceHandle) {
    return false;
  }
  if (BRANCH_HANDLES_IF.has(edge.sourceHandle) || BRANCH_HANDLES_TRY_CATCH.has(edge.sourceHandle)) {
    return true;
  }
  // switch_node cases use arbitrary sourceHandle values (not in any fixed set)
  // we mark them at execution time rather than here
  return false;
}

