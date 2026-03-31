import { WORKFLOW_SCHEMA_VERSION, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeType } from "@ai-orchestrator/shared";
import type { Edge, Node } from "reactflow";

export interface EditorNodeData {
  label: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  executionStatus?: "pending" | "running" | "success" | "error" | "skipped";
}

export type EditorNode = Node<EditorNodeData>;

export function createBlankWorkflow(): Workflow {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `wf-${Date.now()}`;

  return {
    id,
    name: "Untitled Workflow",
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: 1,
    nodes: [],
    edges: []
  };
}

export function workflowToEditor(workflow: Workflow): { nodes: EditorNode[]; edges: Edge[] } {
  const nodes: EditorNode[] = workflow.nodes.map((node) => ({
    id: node.id,
    type: "workflowNode",
    position: node.position,
    data: {
      label: node.name,
      nodeType: node.type,
      config: (node.config ?? {}) as Record<string, unknown>
    }
  }));

  const edges: Edge[] = workflow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label
  }));

  return { nodes, edges };
}

export function editorToWorkflow(base: Workflow, nodes: EditorNode[], edges: Edge[]): Workflow {
  const normalizedNodes: WorkflowNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.data.nodeType,
    name: node.data.label,
    position: node.position,
    config: node.data.config
  }));

  const normalizedEdges: WorkflowEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    label: typeof edge.label === "string" ? edge.label : undefined
  }));

  return {
    ...base,
    nodes: normalizedNodes,
    edges: normalizedEdges
  };
}

export function createNodeId(type: WorkflowNodeType): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${type}-${suffix}`;
}

export function createEdgeId(source: string, target: string): string {
  return `edge-${source}-${target}-${Math.random().toString(36).slice(2, 6)}`;
}
