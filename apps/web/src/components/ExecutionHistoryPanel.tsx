import type { ExecutionHistoryDetail, ExecutionHistorySummary } from "../lib/api";
import type { WorkflowListItem } from "@ai-orchestrator/shared";

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
  statusColors: Record<string, string>;
  onFiltersChange: (filters: ExecutionHistoryFilters) => void;
  onRefresh: () => void;
  onToggleRow: (executionId: string) => Promise<void> | void;
  onDebugExecution: (executionId: string) => Promise<void> | void;
  onRerunExecution: (executionId: string) => Promise<void> | void;
  onCancelExecution: (executionId: string) => Promise<void> | void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringifyPretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatDuration(value: number | null | undefined): string {
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
  onCancelExecution
}: ExecutionHistoryPanelProps) {
  const clearFilters = () => {
    onFiltersChange({
      status: "",
      workflowId: "",
      startedFrom: "",
      startedTo: ""
    });
  };

  return (
    <section className="executions-pane">
      <div className="executions-header-row">
        <div>
          <h2>Runs</h2>
          <p className="muted">Execution history and node-level traces ({executionHistoryTotal} total)</p>
        </div>
        <button className="header-btn" onClick={onRefresh} disabled={executionsLoading}>
          {executionsLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

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
        <button className="mini-btn" type="submit" disabled={executionsLoading}>
          Apply
        </button>
        <button
          className="mini-btn"
          type="button"
          onClick={() => {
            clearFilters();
            window.setTimeout(onRefresh, 0);
          }}
          disabled={executionsLoading}
        >
          Clear
        </button>
      </form>

      {executionsError && <div className="error-banner">{executionsError}</div>}

      {!executionsLoading && executionHistoryItems.length === 0 && (
        <div className="logs-placeholder">No executions yet. Run a workflow from the editor to populate history.</div>
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
                <th>Duration</th>
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
                    onClick={() => {
                      void onToggleRow(item.id);
                    }}
                  >
                    <td className="mono-cell">{item.id.slice(0, 8)}</td>
                    <td>{item.workflowName ?? item.workflowId}</td>
                    <td>
                      <strong style={{ color: statusColors[item.status] ?? "#657087" }}>{item.status}</strong>
                    </td>
                    <td>{item.triggerType ?? "unknown"}</td>
                    <td>{formatWhen(item.startedAt)}</td>
                    <td>{formatDuration(item.durationMs)}</td>
                    <td className="execution-actions-cell">
                      <button
                        className="mini-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onDebugExecution(item.id);
                        }}
                      >
                        Debug
                      </button>
                      <button
                        className="mini-btn"
                        disabled={!canRetry}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onRerunExecution(item.id);
                        }}
                      >
                        Retry
                      </button>
                      {canCancel && (
                        <button
                          className="mini-btn danger"
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
                        {!detail && <div className="muted">Loading full trace...</div>}
                        {detail && (
                          <div className="execution-trace">
                            {hasCustomData(customData) && (
                              <div className="execution-custom-data">
                                <strong>Custom data</strong>
                                <pre className="result-block">{stringifyPretty(customData)}</pre>
                              </div>
                            )}
                            <div className="execution-trace-grid">
                              {nodeResults.length === 0 && <div className="muted">No node-by-node trace available.</div>}
                              {nodeResults.map((entry, index) => {
                                const trace = asRecord(entry);
                                const nodeId = typeof trace?.nodeId === "string" ? trace.nodeId : `node-${index + 1}`;
                                const status = typeof trace?.status === "string" ? trace.status : "unknown";
                                const durationMs = typeof trace?.durationMs === "number" ? trace.durationMs : null;
                                const errorMessage = typeof trace?.error === "string" ? trace.error : "";

                                return (
                                  <div key={`${item.id}-${nodeId}-${index}`} className="execution-trace-item">
                                    <span>{nodeId}</span>
                                    <strong style={{ color: statusColors[status] ?? "#657087" }}>{status}</strong>
                                    <span>{formatDuration(durationMs)}</span>
                                    {errorMessage && <span className="trace-error">{errorMessage}</span>}
                                  </div>
                                );
                              })}
                            </div>
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
    </section>
  );
}
