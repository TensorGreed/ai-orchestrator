import { WORKFLOW_SCHEMA_VERSION, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeType } from "@ai-orchestrator/shared";
import type { Edge, Node } from "reactflow";
import type { McpCanvasMarker, McpNavTarget } from "./mcp-control-plane";
import {
  computeAttachmentSlots,
  findHubOf,
  hasOrbitOverlap,
  hasUsablePositions,
  orbitPositions,
  tidyLayout,
  type AttachmentSlots
} from "./stages";

export type NodeColorKey = "gray" | "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink";

export interface NodeTelemetry {
  providerId?: string;
  model?: string;
  /** Cumulative across all model calls in this node (1 for llm_call; n for agent_orchestrator). */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** Sum of provider-call latencies in ms (excludes tool execution + runtime overhead). */
  latencyMs?: number;
  /** Number of model calls (only set for agent nodes; llm_call is always 1). */
  llmCallCount?: number;
}

export interface EditorNodeData {
  label: string;
  nodeType: WorkflowNodeType;
  config: Record<string, unknown>;
  executionStatus?: "pending" | "running" | "success" | "error" | "skipped" | "canceled";
  executionPreview?: {
    input?: string;
    output?: string;
    /** Tail of the model text streamed so far, while the node runs. */
    live?: string;
    error?: string;
    /** One-sentence remediation hint produced by the executor for the failing
     *  node. Surfaced under the raw error in the on-canvas preview. */
    errorRemediation?: string;
  };
  /**
   * Phase 7.1 telemetry — token usage + provider-call latency, populated by
   * the executor on llm_call and agent_orchestrator nodes after a run.
   * Surfaced as inline pills on the canvas card.
   */
  telemetry?: NodeTelemetry;
  /** Browser clock (ms) when the node started running; drives the elapsed pill. Render-time only. */
  liveStartedAtMs?: number;
  pinned?: boolean;
  disabled?: boolean;
  color?: NodeColorKey;
  onOpenAgentAttachmentDrawer?: (sourceHandle: "chat_model" | "memory" | "tool" | "worker" | "guard" | "protection") => void;
  /**
   * Render-time only (set by WorkflowCanvasArea, never persisted): attachment
   * slots of an agent hub, and for attached nodes the hub + port they orbit.
   */
  slots?: AttachmentSlots;
  attachedTo?: string;
  attachedAs?: "chat_model" | "memory" | "tool" | "worker" | "guard" | "protection";
  /** Which side of a satellite its label sits on (away from the hub). */
  labelSide?: "top" | "bottom" | "left" | "right";
  /**
   * Phase 10.3 — render-time only: the registered server's probe status, a pending
   * breaking change and the current user's policy state for an MCP Tool node, and
   * where clicking a marker goes.
   */
  mcpMarker?: McpCanvasMarker;
  onOpenMcpTarget?: (target: McpNavTarget) => void;
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

/**
 * Converts a workflow into React Flow nodes/edges. When the workflow has no
 * usable positions (all nodes at one point, e.g. a generated or hand-written
 * import) or a saved layout would put a hub's rings over other nodes, the
 * stage layout is applied. Nodes attached to an agent hub are
 * always snapped onto their orbit so the canvas and the saved JSON agree.
 */
export function workflowToEditor(workflow: Workflow): { nodes: EditorNode[]; edges: Edge[]; autoTidied: boolean } {
  const autoTidied = !hasUsablePositions(workflow.nodes) || hasOrbitOverlap(workflow.nodes, workflow.edges);
  const laidOut = autoTidied ? tidyLayout(workflow.nodes, workflow.edges) : {};
  const orbit: Record<string, { x: number; y: number }> = {};
  if (!autoTidied) {
    const slots = computeAttachmentSlots(workflow.nodes, workflow.edges);
    for (const node of workflow.nodes) {
      if (slots[node.id] && !findHubOf(node.id, slots)) {
        Object.assign(orbit, orbitPositions(node.id, slots, node.position));
      }
    }
  }

  const nodes: EditorNode[] = workflow.nodes.map((node) => ({
    id: node.id,
    type: node.type === "sticky_note" ? "stickyNote" : "workflowNode",
    position: laidOut[node.id] ?? orbit[node.id] ?? node.position,
    data: {
      label: node.name,
      nodeType: node.type,
      config: (node.config ?? {}) as Record<string, unknown>,
      pinned: Boolean(workflow.pinnedData && Object.prototype.hasOwnProperty.call(workflow.pinnedData, node.id)),
      disabled: node.disabled,
      color: node.color as NodeColorKey | undefined
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

  return { nodes, edges, autoTidied };
}

export function editorToWorkflow(base: Workflow, nodes: EditorNode[], edges: Edge[]): Workflow {
  const normalizedNodes: WorkflowNode[] = nodes.map((node) => ({
    id: node.id,
    type: node.data.nodeType,
    name: node.data.label,
    position: node.position,
    config: node.data.config,
    ...(node.data.disabled ? { disabled: true } : {}),
    ...(node.data.color ? { color: node.data.color } : {})
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
