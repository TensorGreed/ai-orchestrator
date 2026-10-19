import { useMemo } from "react";
import type { EditorNodeData } from "../lib/workflow";

export interface StageStripNode {
  id: string;
  label: string;
  type: string;
  status?: EditorNodeData["executionStatus"];
}

export type StageStatus = "idle" | "running" | "success" | "error" | "skipped";

export interface StageStripProps {
  /** Stage index → nodes in that stage (DAG nodes only). */
  stages: StageStripNode[][];
  /** Stage index that currently contains a selected node, if any. */
  activeStage?: number | null;
  onFocusStage: (stageIndex: number, nodeIds: string[]) => void;
}

export function stageStatus(nodes: StageStripNode[]): StageStatus {
  let status: StageStatus = "idle";
  for (const node of nodes) {
    if (node.status === "error") return "error";
    if (node.status === "running") status = "running";
    else if (node.status === "success" && status === "idle") status = "success";
    else if (node.status === "skipped" && status === "idle") status = "skipped";
  }
  return status;
}

export function stageTitle(index: number, nodes: StageStripNode[]): string {
  if (index === 0) return "Trigger";
  return `Stage ${String(index + 1).padStart(2, "0")}`;
}

export function stageCaption(nodes: StageStripNode[]): string {
  if (nodes.length === 1) return nodes[0]!.label;
  return `${nodes.length} in parallel`;
}

export function StageStrip({ stages, activeStage, onFocusStage }: StageStripProps) {
  const items = useMemo(
    () =>
      stages.map((nodes, index) => ({
        index,
        nodes,
        title: stageTitle(index, nodes),
        caption: stageCaption(nodes),
        detail: nodes.length > 1 ? nodes.map((node) => node.label).join(", ") : nodes[0]?.type ?? "",
        status: stageStatus(nodes)
      })),
    [stages]
  );

  if (items.length === 0) return null;

  return (
    <nav className="stage-strip" aria-label="Workflow stages" style={{ height: "var(--strip-h)" }}>
      <ol className="stage-strip-list">
        {items.map((item) => (
          <li key={item.index} className="stage-strip-item">
            {item.index > 0 && <span className="stage-strip-link" aria-hidden="true" />}
            <button
              type="button"
              className={`stage-pill stage-pill-${item.status}${activeStage === item.index ? " active" : ""}`}
              onClick={() => onFocusStage(item.index, item.nodes.map((node) => node.id))}
              title={`${item.title} · ${item.detail}`}
              aria-current={activeStage === item.index ? "step" : undefined}
            >
              <span className="stage-pill-head">
                <span className="stage-pill-dot" aria-hidden="true" />
                <small>{item.title}</small>
              </span>
              <b>{item.caption}</b>
              <em>{item.detail}</em>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
