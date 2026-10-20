/**
 * Shared shapes for the external workflow import handlers.
 *
 * The converter in `external-builder.ts` and the per-app handler modules under
 * `apps/` both work on these types. They carry no behaviour of their own.
 */
import type { ImportNodeStatus, ImportReport, ImportReportSecret, WorkflowNode } from "@ai-orchestrator/shared";

// ---------------------------------------------------------------------------
// Source shapes (loosely typed on purpose; everything is defensively read)
// ---------------------------------------------------------------------------

export interface SourceNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: unknown;
  parameters: Record<string, unknown>;
  credentials: Record<string, Record<string, unknown>>;
  disabled: boolean;
  notes?: string;
}

export interface SourceConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface SourceConnection {
  sourceName: string;
  connectionType: string;
  outputIndex: number;
  target: SourceConnectionTarget;
}

export interface SourceWorkflow {
  name: string;
  nodes: SourceNode[];
  connections: SourceConnection[];
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Conversion context shared by all node handlers
// ---------------------------------------------------------------------------

export interface ExpressionScope {
  nodeId: string;
  sourceName: string;
  /** Id of the node feeding this node's main input, when there is exactly one obvious one. */
  previousNodeId?: string;
}

export interface ConvertedNode {
  node: WorkflowNode;
  status: ImportNodeStatus;
  reason: string;
  /** Source output index → L2M sourceHandle for branching nodes. */
  outputHandles?: string[];
  /** Nodes that only make sense as agent attachments and must not be wired into the DAG. */
  attachmentOnly?: boolean;
}

export interface ConversionContext {
  source: SourceWorkflow;
  nodeIdByName: Map<string, string>;
  previousNodeIdByName: Map<string, string | undefined>;
  report: ImportReport;
  secrets: Map<string, ImportReportSecret>;
  variables: Set<string>;
  settingsTimezone: string;
}

export type NodeHandler = (source: SourceNode, ctx: ConversionContext, scope: ExpressionScope) => ConvertedNode;
