import { useState, useCallback, useEffect } from "react";
import { fetchMcpElicitations, type ExecutionHistoryDetail, type ExecutionHistorySummary, type McpReplayMode } from "../lib/api";
import type { McpElicitationView, WorkflowListItem } from "@ai-orchestrator/shared";
import { McpCassetteViewer } from "./McpCassetteViewer";
import { McpElicitationForm } from "./McpElicitationForm";
import { GuardTracePanel } from "./GuardTracePanel";
import { AuditBundlePanel } from "./AuditBundlePanel";

/** Phase 10.5 — how often the Runs page looks for server questions waiting on a person. */
const ELICITATION_POLL_MS = 5000;

/**
 * Pending `elicitation/create` requests across running workflows. The run
 * stays `running` while a question waits, so the list is fetched on its own
 * and refreshed while anything is pending.
 */
function PendingElicitations({ onAnswered }: { onAnswered?: () => void }) {
  const [items, setItems] = useState<McpElicitationView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchMcpElicitations({ status: "pending" })
        .then((response) => {
          if (cancelled) return;
          setItems(response.items);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Could not load server questions");
        });
    };
    load();
    const timer = window.setInterval(load, ELICITATION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (items.length === 0) return null;
  return (
    <section className="mcp-elicit-list" aria-label="Server questions waiting for you">
      <h3 className="mcp-elicit-list-title">
        Waiting for you <span className="mono-cell">{items.length}</span>
      </h3>
      <p className="kb-subtle">
        An MCP server asked a question during a run. The run continues as soon as you answer, decline, or the deadline passes.
      </p>
      {items.map((item) => (
        <McpElicitationForm
          key={item.id}
          elicitation={item}
          onAnswered={(settled) => {
            setItems((current) => current.filter((entry) => entry.id !== settled.id));
            onAnswered?.();
          }}
        />
      ))}
    </section>
  );
}

interface ExecutionHistoryFilters {
  status: string;
  workflowId: string;
  startedFrom: string;
  startedTo: string;
}

interface ExecutionHistoryPanelProps {
  executionHistoryTotal: number;
  executionsLoading: boolean;
  executionsError: string | null;
  executionHistoryItems: ExecutionHistorySummary[];
  workflowList: WorkflowListItem[];
  filters: ExecutionHistoryFilters;
  expandedExecutionIds: string[];
  executionDetailById: Record<string, ExecutionHistoryDetail | undefined>;
  /**
   * Legacy status → colour map. Status pills are now coloured by the
   * `data-status` attribute through design tokens; the map is only used as a
   * fallback for statuses the token set does not know.
   */
  statusColors: Record<string, string>;
  onFiltersChange: (filters: ExecutionHistoryFilters) => void;
  onRefresh: () => void;
  onToggleRow: (executionId: string) => Promise<void> | void;
  onDebugExecution: (executionId: string) => Promise<void> | void;
  onRerunExecution: (executionId: string) => Promise<void> | void;
  onCancelExecution: (executionId: string) => Promise<void> | void;
  /**
   * Phase 7.2 — replay the workflow starting at `nodeId`, seeding upstream
   * node outputs from the source execution. The server's
   * /api/workflows/:id/execute already accepts startNodeId + sourceExecutionId
   * for this; we just trigger it from here.
   */
  onReplayFromNode?: (executionId: string, nodeId: string) => Promise<void> | void;
  /**
   * Phase 10.8 — run a recorded execution again with its MCP calls answered
   * from its cassette. Omitted for roles that cannot read cassettes, which
   * also hides the cassette viewer.
   */
  onReplayCassette?: (executionId: string, mode: McpReplayMode) => Promise<void> | void;
  /** Admins may delete cassettes from the viewer. */
  canDeleteCassettes?: boolean;
}

const TOKENISED_STATUSES = new Set([
  "success",
  "error",
  "partial",
  "running",
  "pending",
  "waiting_approval",
  "canceled",
  "skipped",
  "unknown"
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "-";
  }
  if (value < 1000) {
    return `${value}ms`;
  }
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 2)}s`;
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function hasCustomData(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0);
}

function CassetteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.5" cy="7.5" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10.5" cy="7.5" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 12.5 5.5 10.5h5l1 2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function StatusPill({ status, statusColors }: { status: string; statusColors: Record<string, string> }) {
  const known = TOKENISED_STATUSES.has(status);
  return (
    <span
      className="status-pill"
      data-status={known ? status : "unknown"}
      style={!known && statusColors[status] ? { color: statusColors[status] } : undefined}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function ExecutionHistoryPanel({
  executionHistoryTotal,
  executionsLoading,
  executionsError,
  executionHistoryItems,
  workflowList,
  filters,
  expandedExecutionIds,
  executionDetailById,
  statusColors,
  onFiltersChange,
  onRefresh,
  onToggleRow,
  onDebugExecution,
  onRerunExecution,
  onCancelExecution,
  onReplayFromNode,
  onReplayCassette,
  canDeleteCassettes = false
}: ExecutionHistoryPanelProps) {
  const [expandedTraceKey, setExpandedTraceKey] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ cassetteId: string; executionId: string } | null>(null);
  const toggleTraceRow = useCallback((key: string) => {
    setExpandedTraceKey((current) => (current === key ? null : key));
  }, []);
  const clearFilters = () => {
    onFiltersChange({
      status: "",
      workflowId: "",
      startedFrom: "",
      startedTo: ""
    });
  };

  return (
    <section className="executions-pane page-pane">
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">Runs</h2>
          <p className="page-sub">
            Execution history and node-level traces · <span className="mono-cell">{executionHistoryTotal}</span> total
          </p>
        </div>
        <div className="page-actions">
          <button className="pg-btn" onClick={onRefresh} disabled={executionsLoading}>
            {executionsLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <form
        className="execution-filters"
        onSubmit={(event) => {
          event.preventDefault();
          onRefresh();
        }}
      >
        <label>
          <span>Status</span>
          <select
            value={filters.status}
            onChange={(event) => onFiltersChange({ ...filters, status: event.target.value })}
          >
            <option value="">All statuses</option>
            <option value="running">Running</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="partial">Partial</option>
            <option value="waiting_approval">Waiting approval</option>
            <option value="canceled">Canceled</option>
          </select>
        </label>
        <label>
          <span>Workflow</span>
          <select
            value={filters.workflowId}
            onChange={(event) => onFiltersChange({ ...filters, workflowId: event.target.value })}
          >
            <option value="">All workflows</option>
            {workflowList.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input
            type="datetime-local"
            value={filters.startedFrom}
            onChange={(event) => onFiltersChange({ ...filters, startedFrom: event.target.value })}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="datetime-local"
            value={filters.startedTo}
            onChange={(event) => onFiltersChange({ ...filters, startedTo: event.target.value })}
          />
        </label>
        <div className="execution-filters-actions">
          <button className="pg-btn small primary" type="submit" disabled={executionsLoading}>
            Apply
          </button>
          <button
            className="pg-btn small ghost"
            type="button"
            onClick={() => {
              clearFilters();
              window.setTimeout(onRefresh, 0);
            }}
            disabled={executionsLoading}
          >
            Clear
          </button>
        </div>
      </form>

      {executionsError && <div className="error-banner">{executionsError}</div>}

      <PendingElicitations onAnswered={onRefresh} />

      {!executionsLoading && executionHistoryItems.length === 0 && (
        <div className="page-empty">No executions yet. Run a workflow from the editor to populate history.</div>
      )}

      {executionHistoryItems.length > 0 && (
        <div className="executions-table-wrap">
          <table className="executions-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Trigger</th>
                <th>Started</th>
                <th className="num">Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {executionHistoryItems.map((item) => {
                const expanded = expandedExecutionIds.includes(item.id);
                const detail = executionDetailById[item.id];
                const nodeResults = Array.isArray(detail?.nodeResults) ? detail.nodeResults : [];
                const canRetry = item.status === "error" || item.status === "partial" || item.status === "canceled";
                const canCancel =
                  item.status === "running" ||
                  item.status === "waiting_approval" ||
                  (item.status === "partial" && !item.completedAt);
                const customData = detail?.customData ?? item.customData;

                return [
                  <tr
                    key={`${item.id}-summary`}
                    className={expanded ? "execution-row expanded" : "execution-row"}
                    aria-expanded={expanded}
                    onClick={() => {
                      void onToggleRow(item.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void onToggleRow(item.id);
                      }
                    }}
                    tabIndex={0}
                  >
                    <td className="mono-cell">
                      <span className="execution-row-caret" aria-hidden="true">
                        {expanded ? "▾" : "▸"}
                      </span>
                      {item.id.slice(0, 8)}
                    </td>
                    <td className="execution-row-workflow">
                      {item.workflowName ?? item.workflowId}
                      {item.mcpCassette &&
                        (onReplayCassette ? (
                          <button
                            type="button"
                            className="mcp-cassette-badge"
                            title={`MCP calls recorded into a cassette${item.mcpCassette.truncated ? " (truncated)" : ""}. Open it.`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setViewer({ cassetteId: item.mcpCassette!.id, executionId: item.id });
                            }}
                          >
                            <CassetteIcon />
                            {item.mcpCassette.callCount}
                            {item.mcpCassette.truncated ? "+" : ""}
                            <span className="sr-only"> MCP calls recorded</span>
                          </button>
                        ) : (
                          <span className="mcp-cassette-badge" title="MCP calls recorded into a cassette">
                            <CassetteIcon />
                            {item.mcpCassette.callCount}
                            <span className="sr-only"> MCP calls recorded</span>
                          </span>
                        ))}
                    </td>
                    <td>
                      <StatusPill status={item.status} statusColors={statusColors} />
                    </td>
                    <td className="mono-cell muted-cell">{item.triggerType ?? "unknown"}</td>
                    <td className="muted-cell">{formatWhen(item.startedAt)}</td>
                    <td className="mono-cell num">{formatDuration(item.durationMs)}</td>
                    <td className="execution-actions-cell">
                      <button
                        className="pg-btn small"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onDebugExecution(item.id);
                        }}
                      >
                        Debug
                      </button>
                      <button
                        className="pg-btn small"
                        disabled={!canRetry}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onRerunExecution(item.id);
                        }}
                      >
                        Retry
                      </button>
                      {item.mcpCassette && onReplayCassette && (
                        <button
                          className="pg-btn small"
                          title="Run again with MCP calls answered from the recorded cassette"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onReplayCassette(item.id, "strict");
                          }}
                        >
                          Replay
                        </button>
                      )}
                      {canCancel && (
                        <button
                          className="pg-btn small ghost danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onCancelExecution(item.id);
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>,
                  expanded ? (
                    <tr key={`${item.id}-detail`} className="execution-detail-row">
                      <td colSpan={7}>
                        {!detail && <div className="page-hint">Loading full trace…</div>}
                        {detail && (
                          <div className="execution-trace">
                            {hasCustomData(customData) && (
                              <div className="execution-custom-data">
                                <span className="pg-eyebrow">Custom data</span>
                                <pre className="result-block">{stringifyPretty(customData)}</pre>
                              </div>
                            )}
                            <AuditBundlePanel executionId={item.id} status={item.status} completedAt={item.completedAt} />
                            <GuardTracePanel executionId={item.id} nodeResults={nodeResults} />
                            <div className="execution-trace-grid">
                              {nodeResults.length === 0 && <div className="page-hint">No node-by-node trace available.</div>}
                              {nodeResults.map((entry, index) => {
                                const trace = asRecord(entry);
                                const nodeId = typeof trace?.nodeId === "string" ? trace.nodeId : `node-${index + 1}`;
                                const status = typeof trace?.status === "string" ? trace.status : "unknown";
                                const durationMs = typeof trace?.durationMs === "number" ? trace.durationMs : null;
                                const errorMessage = typeof trace?.error === "string" ? trace.error : "";
                                const errorRemediation =
                                  typeof trace?.errorRemediation === "string" ? trace.errorRemediation : "";
                                const traceKey = `${item.id}-${nodeId}-${index}`;
                                const isOpen = expandedTraceKey === traceKey;
                                const nodeInput = trace?.input;
                                const nodeOutput = trace?.output;
                                const hasState = nodeInput !== undefined || nodeOutput !== undefined;

                                return (
                                  <div key={traceKey} className={isOpen ? "execution-trace-node open" : "execution-trace-node"}>
                                    <div className={`execution-trace-item${hasState ? " expandable" : ""}${isOpen ? " expanded" : ""}`}>
                                      {hasState ? (
                                        <button
                                          type="button"
                                          className="execution-trace-toggle"
                                          aria-expanded={isOpen}
                                          onClick={() => toggleTraceRow(traceKey)}
                                        >
                                          <span className="execution-row-caret" aria-hidden="true">
                                            {isOpen ? "▾" : "▸"}
                                          </span>
                                          <span className="mono-cell">{nodeId}</span>
                                        </button>
                                      ) : (
                                        <span className="execution-trace-toggle static">
                                          <span className="mono-cell">{nodeId}</span>
                                        </span>
                                      )}
                                      <StatusPill status={status} statusColors={statusColors} />
                                      <span className="mono-cell num">{formatDuration(durationMs)}</span>
                                      <span className="execution-trace-extra">
                                        {onReplayFromNode && (
                                          <button
                                            type="button"
                                            className="pg-btn small ghost"
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void onReplayFromNode(item.id, nodeId);
                                            }}
                                            title={`Replay the workflow from ${nodeId}, seeding upstream outputs from this run`}
                                          >
                                            ▶ Replay from here
                                          </button>
                                        )}
                                      </span>
                                    </div>
                                    {errorMessage && (
                                      <div className="trace-error">
                                        {errorMessage}
                                        {errorRemediation && (
                                          <span className="trace-remediation">
                                            <strong>How to fix:</strong> {errorRemediation}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                    {isOpen && hasState && (
                                      <div
                                        className={`execution-trace-state${nodeInput !== undefined && nodeOutput !== undefined ? " two" : ""}`}
                                      >
                                        {nodeInput !== undefined && (
                                          <div>
                                            <span className="pg-eyebrow">Input</span>
                                            <pre className="result-block">{stringifyPretty(nodeInput)}</pre>
                                          </div>
                                        )}
                                        {nodeOutput !== undefined && (
                                          <div>
                                            <span className="pg-eyebrow">Output</span>
                                            <pre className="result-block">{stringifyPretty(nodeOutput)}</pre>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                            <span className="pg-eyebrow">Result</span>
                            <pre className="result-block">{stringifyPretty(detail.output ?? detail.error ?? detail)}</pre>
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {viewer && (
        <McpCassetteViewer
          cassetteId={viewer.cassetteId}
          canDelete={canDeleteCassettes}
          onClose={() => setViewer(null)}
          onDeleted={onRefresh}
          {...(onReplayCassette
            ? {
                onReplay: (mode: McpReplayMode) => {
                  const executionId = viewer.executionId;
                  setViewer(null);
                  void onReplayCassette(executionId, mode);
                }
              }
            : {})}
        />
      )}
    </section>
  );
}
