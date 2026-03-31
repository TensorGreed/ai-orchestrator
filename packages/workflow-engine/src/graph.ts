import type { WorkflowEdge } from "@ai-orchestrator/shared";

export const AGENT_ATTACHMENT_HANDLES = ["chat_model", "memory", "tool"] as const;
const AGENT_ATTACHMENT_SET = new Set<string>(AGENT_ATTACHMENT_HANDLES);

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

