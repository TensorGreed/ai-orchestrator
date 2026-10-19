import { BaseEdge, EdgeLabelRenderer, getBezierPath, useStore, type EdgeProps, type ReactFlowState } from "reactflow";
import type { AgentAttachmentHandle } from "../lib/agent-attachments";
import { ORBIT } from "../lib/stages";

interface WorkflowCanvasEdgeData {
  onDeleteEdge?: (edgeId: string) => void;
  attachmentHandle?: AgentAttachmentHandle;
  sourceType?: string;
  targetType?: string;
}

function DeleteButton({ id, x, y, onDeleteEdge }: { id: string; x: number; y: number; onDeleteEdge: (edgeId: string) => void }) {
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        className="edge-delete-btn nodrag nopan"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDeleteEdge(id);
        }}
        title="Delete connection"
        aria-label="Delete connection"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </EdgeLabelRenderer>
  );
}

/** Bezier DAG edge with an optional delete affordance when selected. */
export function WorkflowCanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  labelStyle,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  selected,
  data
}: EdgeProps<WorkflowCanvasEdgeData>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });

  const showDelete = selected && typeof data?.onDeleteEdge === "function";

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={style}
        markerEnd={markerEnd}
        label={typeof label === "string" ? label : undefined}
        labelX={labelX}
        labelY={labelY}
        labelStyle={labelStyle}
        labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
      />
      {showDelete && data?.onDeleteEdge ? <DeleteButton id={id} x={labelX} y={labelY} onDeleteEdge={data.onDeleteEdge} /> : null}
    </>
  );
}

function centerOf(state: ReactFlowState, nodeId: string, fallback: { x: number; y: number }) {
  const node = state.nodeInternals.get(nodeId);
  if (!node) return fallback;
  const base = node.positionAbsolute ?? node.position;
  const width = node.width ?? ORBIT.satelliteSize;
  const height = node.height ?? ORBIT.satelliteSize;
  return { x: base.x + width / 2, y: base.y + height / 2 };
}

/**
 * Straight spoke from a hub centre to an attached node centre, coloured by
 * the port (`--port-model|memory|tool|worker`). Used for chat_model / memory /
 * tool / worker attachment edges, which are not DAG steps.
 */
export function AttachmentSpokeEdge({ id, source, target, sourceX, sourceY, targetX, targetY, style, selected, data }: EdgeProps<WorkflowCanvasEdgeData>) {
  const from = useStore((state) => centerOf(state, source, { x: sourceX, y: sourceY }));
  const to = useStore((state) => centerOf(state, target, { x: targetX, y: targetY }));
  const port = data?.attachmentHandle ?? "tool";
  const path = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const showDelete = selected && typeof data?.onDeleteEdge === "function";

  return (
    <>
      <path d={path} className="react-flow__edge-interaction" fill="none" stroke="transparent" strokeWidth={14} />
      <path
        d={path}
        className={`wf-spoke wf-spoke-${port}${selected ? " selected" : ""}`}
        fill="none"
        style={style}
        data-port={port}
      />
      {showDelete && data?.onDeleteEdge ? <DeleteButton id={id} x={midX} y={midY} onDeleteEdge={data.onDeleteEdge} /> : null}
    </>
  );
}
