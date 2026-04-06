import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "reactflow";

interface WorkflowCanvasEdgeData {
  onDeleteEdge?: (edgeId: string) => void;
}

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
      {showDelete ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="edge-delete-btn nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              data?.onDeleteEdge?.(id);
            }}
            title="Delete connection"
            aria-label="Delete connection"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="m7 7 10 10M17 7 7 17"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

