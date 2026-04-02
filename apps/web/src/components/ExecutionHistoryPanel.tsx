import type { ExecutionHistoryDetail, ExecutionHistorySummary } from "../lib/api";

interface ExecutionHistoryPanelProps {
  executionHistoryTotal: number;
  executionsLoading: boolean;
  executionsError: string | null;
  executionHistoryItems: ExecutionHistorySummary[];
  expandedExecutionIds: string[];
  executionDetailById: Record<string, ExecutionHistoryDetail | undefined>;
  statusColors: Record<string, string>;
  onRefresh: () => void;
  onToggleRow: (executionId: string) => Promise<void> | void;
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

export function ExecutionHistoryPanel({
  executionHistoryTotal,
  executionsLoading,
  executionsError,
  executionHistoryItems,
  expandedExecutionIds,
  executionDetailById,
  statusColors,
  onRefresh,
  onToggleRow
}: ExecutionHistoryPanelProps) {
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
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {executionHistoryItems.map((item) => {
                const expanded = expandedExecutionIds.includes(item.id);
                const detail = executionDetailById[item.id];
                const nodeResults = Array.isArray(detail?.nodeResults) ? detail.nodeResults : [];

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
                    <td>{formatDuration(item.durationMs)}</td>
                  </tr>,
                  expanded ? (
                    <tr key={`${item.id}-detail`} className="execution-detail-row">
                      <td colSpan={5}>
                        {!detail && <div className="muted">Loading full trace...</div>}
                        {detail && (
                          <div className="execution-trace">
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
