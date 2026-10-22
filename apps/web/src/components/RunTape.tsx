import { useMemo } from "react";
import type { NodeProgressSnapshot, WorkflowExecutionResult } from "@ai-orchestrator/shared";
import { formatLatency } from "./WorkflowCanvasNode";
import { guardMarkerFor, type GuardMarker } from "../lib/guard-trace";

export interface RunTapeProps {
  executionResult: WorkflowExecutionResult | null;
  nodeMetaById: Map<string, { label: string; type: string }>;
  onSelectNode?: (nodeId: string) => void;
}

export interface TapeLane {
  nodeId: string;
  label: string;
  type: string;
  status: string;
  /** Offset from run start, ms. */
  startMs: number;
  durationMs: number;
  /** Provider-call latency inside the node, ms (LLM time). */
  llmMs: number | null;
  error?: string;
  /** Phase 10.5 — latest MCP tool progress the node reported. */
  progress?: NodeProgressSnapshot;
  /** Phase 12.1 — a guard blocked, held for review or rewrote content in this step. */
  guard?: GuardMarker;
}

/** 0..100 when the server sent a total, else null. */
export function progressPercent(progress: NodeProgressSnapshot): number | null {
  if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(100, Math.round(progress.percent)));
  }
  if (typeof progress.total === "number" && progress.total > 0) {
    return Math.max(0, Math.min(100, Math.round((progress.progress / progress.total) * 100)));
  }
  return null;
}

/** "tool search_issues: 40% — indexing" */
export function formatProgress(progress: NodeProgressSnapshot): string {
  const percent = progressPercent(progress);
  const amount = percent !== null ? `${percent}%` : `progress ${progress.progress}`;
  return `tool ${progress.toolName}: ${amount}${progress.message ? ` — ${progress.message}` : ""}`;
}

function toMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function guardLane(result: { output?: unknown; error?: string; status?: string }): { guard?: GuardMarker } {
  const marker = guardMarkerFor(result);
  return marker ? { guard: marker } : {};
}

export function buildTapeLanes(executionResult: WorkflowExecutionResult | null, nodeMetaById: Map<string, { label: string; type: string }>): { lanes: TapeLane[]; totalMs: number } {
  if (!executionResult) return { lanes: [], totalMs: 0 };
  const runStart = toMs(executionResult.startedAt);
  const starts = executionResult.nodeResults.map((result) => toMs(result.startedAt)).filter((v): v is number => v !== null);
  const t0 = runStart ?? (starts.length ? Math.min(...starts) : 0);

  let cursor = 0;
  const lanes: TapeLane[] = executionResult.nodeResults.map((result) => {
    const started = toMs(result.startedAt);
    const completed = toMs(result.completedAt);
    const duration = typeof result.durationMs === "number" ? result.durationMs : started !== null && completed !== null ? Math.max(completed - started, 0) : 0;
    const startMs = started !== null ? Math.max(started - t0, 0) : cursor;
    cursor = startMs + duration;
    const output = result.output;
    let llmMs: number | null = null;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const tel = (output as Record<string, unknown>)._telemetry;
      if (tel && typeof tel === "object" && typeof (tel as Record<string, unknown>).latencyMs === "number") {
        llmMs = (tel as Record<string, unknown>).latencyMs as number;
      }
    }
    const meta = nodeMetaById.get(result.nodeId);
    const record = result as unknown as { nodeType?: unknown };
    return {
      nodeId: result.nodeId,
      label: meta?.label ?? result.nodeId,
      type: typeof record.nodeType === "string" ? record.nodeType : meta?.type ?? "",
      status: result.status,
      startMs,
      durationMs: duration,
      llmMs,
      error: result.error,
      ...(result.progress ? { progress: result.progress } : {}),
      ...guardLane(result)
    };
  });

  const totalMs = lanes.reduce((acc, lane) => Math.max(acc, lane.startMs + lane.durationMs), 0);
  return { lanes, totalMs };
}

export function RunTape({ executionResult, nodeMetaById, onSelectNode }: RunTapeProps) {
  const { lanes, totalMs } = useMemo(() => buildTapeLanes(executionResult, nodeMetaById), [executionResult, nodeMetaById]);

  if (!executionResult) {
    return <div className="logs-placeholder">No run yet. Run the workflow to see per-node timing here.</div>;
  }
  if (lanes.length === 0) {
    return <div className="logs-placeholder">This run produced no node results.</div>;
  }

  const denominator = Math.max(totalMs, 1);
  const llmTotal = lanes.reduce((acc, lane) => acc + (lane.llmMs ?? 0), 0);

  return (
    <div className="run-tape" role="table" aria-label="Run tape">
      <div className="run-tape-head">
        <span>
          last run <b>{formatLatency(totalMs)}</b> · {lanes.length} node{lanes.length === 1 ? "" : "s"} · status <b className={`run-tape-status run-tape-status-${executionResult.status}`}>{executionResult.status}</b>
        </span>
        <span className="run-tape-key">
          <i className="run-tape-key-swatch run-tape-key-node" /> node
          <i className="run-tape-key-swatch run-tape-key-llm" /> LLM time{llmTotal > 0 ? ` (${formatLatency(llmTotal)})` : ""}
          <i className="run-tape-key-swatch run-tape-key-err" /> error
        </span>
      </div>
      <div className="run-tape-lanes">
        {lanes.map((lane) => {
          const left = (lane.startMs / denominator) * 100;
          const width = Math.max((lane.durationMs / denominator) * 100, 0.6);
          const llmWidth = lane.llmMs !== null && lane.durationMs > 0 ? Math.min((lane.llmMs / lane.durationMs) * 100, 100) : 0;
          const title = [
            `${lane.label} (${lane.nodeId})`,
            `${lane.status} · ${formatLatency(lane.durationMs)}`,
            lane.llmMs !== null ? `LLM ${formatLatency(lane.llmMs)}` : null,
            lane.error ? `error: ${lane.error}` : null,
            lane.progress ? formatProgress(lane.progress) : null,
            lane.guard ? lane.guard.title : null
          ]
            .filter(Boolean)
            .join("\n");
          const Tag = onSelectNode ? "button" : "div";
          return (
            <Tag
              key={lane.nodeId}
              type={onSelectNode ? "button" : undefined}
              className={`run-tape-lane run-tape-lane-${lane.status}`}
              role="row"
              title={title}
              onClick={onSelectNode ? () => onSelectNode(lane.nodeId) : undefined}
            >
              <span className="run-tape-label" role="cell">
                <b>{lane.label}</b>
                <small>{lane.type || lane.nodeId}</small>
                {lane.guard && (
                  <em className={`run-tape-guard run-tape-guard-${lane.guard.kind}`} title={lane.guard.title}>
                    {lane.guard.label}
                  </em>
                )}
              </span>
              <span className="run-tape-track" role="cell">
                <i className={`run-tape-bar run-tape-bar-${lane.status}`} style={{ left: `${left}%`, width: `${width}%` }}>
                  {llmWidth > 0 && <i className="run-tape-llm" style={{ width: `${llmWidth}%` }} />}
                  {lane.progress && lane.status === "running" && progressPercent(lane.progress) !== null && (
                    <i className="run-tape-progress-fill" style={{ width: `${progressPercent(lane.progress)}%` }} />
                  )}
                </i>
              </span>
              <span className="run-tape-time" role="cell">
                {formatLatency(lane.durationMs)}
              </span>
              {lane.progress && (
                <span className="run-tape-progress" role="cell">
                  {formatProgress(lane.progress)}
                </span>
              )}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}
