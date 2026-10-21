/**
 * Phase 10.3 — MCP overview: fleet health at a glance.
 *
 * Servers by status (with labels and a table view), what needs attention
 * (pending breaking changes, OAuth connections, open elicitation questions),
 * servers allowed to sample, the busiest and most error-prone tools, active
 * gateway clients and the latest changes. Every item links to the page that
 * owns it.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchMcpOverview, type McpOverview, type McpOverviewToolRow, type McpTelemetryWindow } from "../lib/api";
import {
  MCP_CHANGE_KIND_LABEL,
  MCP_STATUS_LABEL,
  MCP_STATUS_ORDER,
  changeLinkTarget,
  changeSeverityLabel,
  formatCost,
  formatCount,
  formatMs,
  formatPercent,
  formatWhen,
  type McpNavTarget
} from "../lib/mcp-control-plane";
import { StatusBadge } from "./McpServersPage";

const WINDOWS: McpTelemetryWindow[] = ["24h", "7d", "30d"];

const OAUTH_STATE_LABEL: Record<string, string> = {
  not_connected: "Not connected",
  expired: "Token expired",
  error: "Connection error",
  connected: "Connected"
};

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export interface McpOverviewPageProps {
  onNavigate: (target: McpNavTarget) => void;
}

export function McpOverviewPage({ onNavigate }: McpOverviewPageProps) {
  const [range, setRange] = useState<McpTelemetryWindow>("7d");
  const [data, setData] = useState<McpOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchMcpOverview(range));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="mcp-page mcp-overview page-pane" aria-busy={loading}>
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">MCP overview</h2>
          <p className="page-sub">
            Health of every registered MCP server, what needs a decision, and how agents and clients use the tools.
          </p>
        </div>
        <div className="page-actions">
          <WindowPicker value={range} onChange={setRange} />
          <button type="button" className="pg-btn" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="settings-error">{error}</div>}

      {!data ? (
        loading ? <p className="kb-subtle">Loading…</p> : null
      ) : data.servers.total === 0 ? (
        <div className="page-empty">
          <div>
            <p>No MCP servers registered yet.</p>
            <button type="button" className="pg-btn primary" onClick={() => onNavigate({ page: "servers" })}>
              Go to servers
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mcp-stats" aria-label="Totals">
            <Stat label="Servers" value={String(data.servers.total)} hint={`${data.servers.byStatus.healthy} healthy`} />
            <Stat label={`Tool calls · ${data.window}`} value={formatCount(data.tools.calls)} />
            <Stat
              label={`Failed calls · ${data.window}`}
              value={formatCount(data.tools.errors)}
              hint={data.tools.calls > 0 ? `${formatPercent(data.tools.errors / data.tools.calls)} of calls` : undefined}
            />
            <Stat label="Active clients" value={String(data.clients.active)} hint={`of ${data.clients.total}`} />
          </div>

          <div className="mcp-overview-grid">
            <FleetHealth overview={data} onNavigate={onNavigate} />
            <Attention overview={data} onNavigate={onNavigate} />
          </div>

          <div className="mcp-overview-grid">
            <RankedTools
              title="Busiest tools"
              empty="No tool calls in this window."
              rows={data.tools.busiest}
              value={(row) => row.calls}
              valueLabel={(row) => `${formatCount(row.calls)} calls`}
              columns={["Calls", "p95", "Cost"]}
              cells={(row) => [formatCount(row.calls), formatMs(row.p95Ms), formatCost(row.costUsd)]}
              onNavigate={onNavigate}
            />
            <RankedTools
              title="Most error-prone tools"
              empty="No failed tool calls in this window."
              rows={data.tools.errorProne}
              value={(row) => row.errorRate}
              max={1}
              valueLabel={(row) => `${formatPercent(row.errorRate)} · ${row.errors} of ${row.calls} failed`}
              columns={["Error rate", "Failed", "Calls"]}
              cells={(row) => [formatPercent(row.errorRate), String(row.errors), formatCount(row.calls)]}
              onNavigate={onNavigate}
            />
          </div>

          <div className="mcp-overview-grid">
            <section className="kb-section" aria-labelledby="mcp-ov-clients">
              <div className="mcp-section-head">
                <h4 id="mcp-ov-clients">Active gateway clients</h4>
                <button type="button" className="kb-link-btn" onClick={() => onNavigate({ page: "clients" })}>
                  All clients
                </button>
              </div>
              {data.clients.top.length === 0 ? (
                <p className="kb-subtle">No active client tokens.</p>
              ) : (
                <ul className="mcp-ov-list">
                  {data.clients.top.map((client) => (
                    <li key={client.id}>
                      <span className="mcp-ov-name">{client.name}</span>
                      <span className="kb-subtle">
                        {formatCount(client.calls)} calls{client.errors > 0 ? ` · ${client.errors} failed` : ""} · last{" "}
                        {formatWhen(client.lastCalledAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="kb-section" aria-labelledby="mcp-ov-changes">
              <div className="mcp-section-head">
                <h4 id="mcp-ov-changes">Latest changes</h4>
                <button type="button" className="kb-link-btn" onClick={() => onNavigate({ page: "changes" })}>
                  All changes
                </button>
              </div>
              {data.changes.length === 0 ? (
                <p className="kb-subtle">Nothing has changed yet.</p>
              ) : (
                <ul className="mcp-ov-list">
                  {data.changes.map((item) => {
                    const target = changeLinkTarget(item.link);
                    return (
                      <li key={item.id} className={`mcp-ov-change is-${item.severity}`}>
                        <span className={`mcp-sev mcp-sev-${item.severity}`}>{changeSeverityLabel(item)}</span>
                        {target ? (
                          <button type="button" className="mcp-ov-link" onClick={() => onNavigate(target)}>
                            {item.title}
                          </button>
                        ) : (
                          <span className="mcp-ov-name">{item.title}</span>
                        )}
                        <span className="kb-subtle">
                          {MCP_CHANGE_KIND_LABEL[item.kind]} · {formatWhen(item.at)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

export function WindowPicker({ value, onChange }: { value: McpTelemetryWindow; onChange: (value: McpTelemetryWindow) => void }) {
  return (
    <div className="finops-range" role="group" aria-label="Telemetry window">
      {WINDOWS.map((entry) => (
        <button
          key={entry}
          type="button"
          aria-pressed={value === entry}
          className={value === entry ? "finops-range-btn active" : "finops-range-btn"}
          onClick={() => onChange(entry)}
        >
          {entry}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="mcp-stat">
      <div className="mcp-stat-label">{label}</div>
      <div className="mcp-stat-value">{value}</div>
      {hint && <div className="mcp-stat-hint">{hint}</div>}
    </div>
  );
}

function FleetHealth({ overview, onNavigate }: { overview: McpOverview; onNavigate: (target: McpNavTarget) => void }) {
  const [showTable, setShowTable] = useState(false);
  const { total, byStatus, list } = overview.servers;
  const sorted = [...list].sort(
    (a, b) => MCP_STATUS_ORDER.indexOf(a.status) - MCP_STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name)
  );
  return (
    <section className="kb-section" aria-labelledby="mcp-ov-health">
      <div className="mcp-section-head">
        <h4 id="mcp-ov-health">Server health</h4>
        <button type="button" className="kb-link-btn" onClick={() => setShowTable((value) => !value)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {showTable ? (
        <div className="mcp-table-scroll">
          <table className="kb-table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Status</th>
                <th>Last probe</th>
                <th className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((server) => (
                <tr key={server.id}>
                  <td>
                    <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: server.id })}>
                      {server.name}
                    </button>
                  </td>
                  <td>
                    <StatusBadge status={server.status} />
                  </td>
                  <td>{formatWhen(server.lastProbeAt)}</td>
                  <td className="num">{formatMs(server.latency.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="mcp-fleet-bar" role="list" aria-label={`${total} servers by status`}>
            {MCP_STATUS_ORDER.filter((status) => byStatus[status] > 0).map((status) => {
              const label = `${MCP_STATUS_LABEL[status]}: ${byStatus[status]} of ${total} servers`;
              return (
                <span
                  key={status}
                  role="listitem"
                  tabIndex={0}
                  className={`mcp-fleet-seg mcp-fleet-${status}`}
                  style={{ flexGrow: byStatus[status] }}
                  title={label}
                  aria-label={label}
                />
              );
            })}
          </div>
          <ul className="mcp-fleet-legend" aria-label="Status counts">
            {MCP_STATUS_ORDER.map((status) => (
              <li key={status}>
                <StatusBadge status={status} />
                <span className="mcp-fleet-count">{byStatus[status]}</span>
              </li>
            ))}
          </ul>
          <ul className="mcp-ov-list mcp-ov-servers">
            {sorted
              .filter((server) => server.status !== "healthy")
              .slice(0, 6)
              .map((server) => (
                <li key={server.id}>
                  <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: server.id })}>
                    {server.name}
                  </button>
                  <span className="kb-subtle">
                    {MCP_STATUS_LABEL[server.status]} · last probe {formatWhen(server.lastProbeAt)}
                  </span>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Attention({ overview, onNavigate }: { overview: McpOverview; onNavigate: (target: McpNavTarget) => void }) {
  const items = overview.pendingBreaking.length + overview.oauthAttention.length + (overview.elicitations.pending > 0 ? 1 : 0);
  return (
    <section className="kb-section" aria-labelledby="mcp-ov-attention">
      <div className="mcp-section-head">
        <h4 id="mcp-ov-attention">Needs attention</h4>
        <span className="kb-subtle">{items === 0 ? "All clear" : `${items} item${items === 1 ? "" : "s"}`}</span>
      </div>
      <ul className="mcp-ov-list">
        {overview.pendingBreaking.map((entry) => (
          <li key={`breaking-${entry.serverId}`}>
            <span className="mcp-sev mcp-sev-breaking">Breaking</span>
            <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: entry.serverId })}>
              Review the breaking change on {entry.serverName}
            </button>
            <span className="kb-subtle">
              {entry.breakingChanges} breaking change{entry.breakingChanges === 1 ? "" : "s"}
              {entry.blocksRuns ? " · runs blocked until accepted" : ""}
              {entry.detectedAt ? ` · ${formatWhen(entry.detectedAt)}` : ""}
            </span>
          </li>
        ))}
        {overview.oauthAttention.map((entry) => (
          <li key={`oauth-${entry.serverId}`}>
            <span className="mcp-sev mcp-sev-warning">OAuth</span>
            <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: entry.serverId })}>
              {entry.serverName}: {OAUTH_STATE_LABEL[entry.state] ?? entry.state}
            </button>
            {entry.lastError && <span className="kb-subtle">{entry.lastError}</span>}
          </li>
        ))}
        {overview.elicitations.pending > 0 && (
          <li>
            <span className="mcp-sev mcp-sev-warning">Question</span>
            <span className="mcp-ov-name">
              {overview.elicitations.pending} open question{overview.elicitations.pending === 1 ? "" : "s"} from MCP servers waiting
              for an answer
            </span>
            <span className="kb-subtle">
              Answer them from the run that asked{overview.elicitations.oldestAt ? ` · oldest ${formatWhen(overview.elicitations.oldestAt)}` : ""}
            </span>
          </li>
        )}
        {items === 0 && <li className="kb-subtle">No pending breaking changes, OAuth problems or open questions.</li>}
      </ul>

      <div className="mcp-section-head">
        <h4>Sampling enabled</h4>
        <span className="kb-subtle">{overview.sampling.length === 0 ? "None" : `${overview.sampling.length} server${overview.sampling.length === 1 ? "" : "s"}`}</span>
      </div>
      {overview.sampling.length > 0 ? (
        <ul className="mcp-ov-list">
          {overview.sampling.map((entry) => (
            <li key={`sampling-${entry.serverId}`}>
              <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: entry.serverId })}>
                {entry.serverName}
              </button>
              <span className="kb-subtle">
                up to {entry.maxTokens.toLocaleString("en-US")} tokens · {entry.maxRequestsPerCall} request{entry.maxRequestsPerCall === 1 ? "" : "s"} per call
                {entry.allowedModels > 0 ? ` · ${entry.allowedModels} allowed model${entry.allowedModels === 1 ? "" : "s"}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="kb-subtle">No server may request model completions.</p>
      )}
    </section>
  );
}

function RankedTools({
  title,
  empty,
  rows,
  value,
  max,
  valueLabel,
  columns,
  cells,
  onNavigate
}: {
  title: string;
  empty: string;
  rows: McpOverviewToolRow[];
  value: (row: McpOverviewToolRow) => number;
  max?: number;
  valueLabel: (row: McpOverviewToolRow) => string;
  columns: [string, string, string];
  cells: (row: McpOverviewToolRow) => [string, string, string];
  onNavigate: (target: McpNavTarget) => void;
}) {
  const [showTable, setShowTable] = useState(false);
  const scale = max ?? Math.max(1, ...rows.map(value));
  const headingId = `mcp-ov-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const open = (row: McpOverviewToolRow) => onNavigate({ page: "tools", serverId: row.serverId, toolName: row.toolName });
  return (
    <section className="kb-section" aria-labelledby={headingId}>
      <div className="mcp-section-head">
        <h4 id={headingId}>{title}</h4>
        {rows.length > 0 && (
          <button type="button" className="kb-link-btn" onClick={() => setShowTable((current) => !current)}>
            {showTable ? "Show chart" : "Show table"}
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="kb-subtle">{empty}</p>
      ) : showTable ? (
        <div className="mcp-table-scroll">
          <table className="kb-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Server</th>
                {columns.map((column) => (
                  <th key={column} className="num">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.serverId}:${row.toolName}`}>
                  <td>
                    <button type="button" className="mcp-ov-link mono" onClick={() => open(row)}>
                      {row.toolName}
                    </button>
                  </td>
                  <td>{row.serverName}</td>
                  {cells(row).map((cell, index) => (
                    <td key={index} className="num">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ol className="mcp-rank">
          {rows.map((row) => {
            const label = `${row.toolName} on ${row.serverName}: ${valueLabel(row)}`;
            const width = Math.max(2, Math.round((value(row) / scale) * 100));
            return (
              <li key={`${row.serverId}:${row.toolName}`}>
                <button type="button" className="mcp-rank-row" onClick={() => open(row)} title={label} aria-label={label}>
                  <span className="mcp-rank-name">
                    <code>{row.toolName}</code>
                    <span className="kb-subtle">{row.serverName}</span>
                  </span>
                  <span className="mcp-rank-track" aria-hidden="true">
                    <span className="mcp-rank-bar" style={{ width: `${width}%` }} />
                  </span>
                  <span className="mcp-rank-value">{valueLabel(row)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
