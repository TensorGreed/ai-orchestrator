/**
 * Phase 10.3 — one catalogue of every tool on every registered MCP server.
 *
 * Search and filters (server, status, read-only/write, destructive, open
 * world, blocked for my role, has output schema), columns sortable by
 * telemetry, and a detail drawer with the schemas, annotations, the policy
 * decision for a chosen role and project, recent calls and the workflows
 * that use the tool.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { McpPolicyRole, Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  evaluateMcpToolPolicy,
  fetchMcpToolCatalog,
  fetchProjects,
  type McpCatalogTool,
  type McpServerStatus,
  type McpTelemetryWindow,
  type McpToolCatalogResponse,
  type McpToolPolicyEvaluation
} from "../lib/api";
import {
  EMPTY_TOOL_FILTERS,
  MCP_STATUS_LABEL,
  MCP_STATUS_ORDER,
  countActiveToolFilters,
  filterCatalogTools,
  formatCost,
  formatCount,
  formatMs,
  formatPercent,
  formatWhen,
  policyStateOf,
  sortCatalogTools,
  toolKey,
  type McpNavTarget,
  type McpToolFilters,
  type McpToolSortKey
} from "../lib/mcp-control-plane";
import { WindowPicker } from "./McpOverviewPage";
import { StatusBadge } from "./McpServersPage";
import { McpAnnotationChips, McpOutputSchema } from "./McpToolMeta";
import { CloseIcon } from "./shell-icons";

const ROLES: McpPolicyRole[] = ["admin", "builder", "operator", "viewer"];

const POLICY_LABEL: Record<ReturnType<typeof policyStateOf>, string> = {
  blocked: "Blocked for you",
  destructive: "Destructive",
  write: "Write",
  read_only: "Read-only"
};

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

const COLUMNS: Array<{ key: McpToolSortKey; label: string; numeric?: boolean }> = [
  { key: "name", label: "Tool" },
  { key: "server", label: "Server" },
  { key: "calls", label: "Calls", numeric: true },
  { key: "errors", label: "Errors", numeric: true },
  { key: "p95", label: "p95", numeric: true },
  { key: "cost", label: "Cost", numeric: true }
];

export interface McpToolsPageProps {
  activeProjectId?: string | null;
  /** Opens a tool's drawer when the page opens (from the overview, the changes feed or a canvas marker). */
  focus?: { serverId?: string; toolName?: string } | null;
  onNavigate: (target: McpNavTarget) => void;
  onOpenWorkflow?: (workflowId: string) => void;
}

export function McpToolsPage({ activeProjectId, focus, onNavigate, onOpenWorkflow }: McpToolsPageProps) {
  const [range, setRange] = useState<McpTelemetryWindow>("7d");
  const [catalog, setCatalog] = useState<McpToolCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<McpToolFilters>(() => ({ ...EMPTY_TOOL_FILTERS, serverId: focus?.serverId && !focus.toolName ? focus.serverId : "" }));
  const [sort, setSort] = useState<{ key: McpToolSortKey; direction: "asc" | "desc" }>({ key: "calls", direction: "desc" });
  const [openKey, setOpenKey] = useState<string | null>(
    focus?.serverId && focus.toolName ? toolKey({ serverId: focus.serverId, name: focus.toolName }) : null
  );
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await fetchMcpToolCatalog({ projectId: activeProjectId ?? null, window: range }));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, range]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tools = catalog?.tools ?? [];
  const visible = useMemo(
    () => sortCatalogTools(filterCatalogTools(tools, filters), sort.key, sort.direction),
    [tools, filters, sort]
  );
  const openTool = openKey ? tools.find((tool) => toolKey(tool) === openKey) ?? null : null;
  const activeFilters = countActiveToolFilters(filters);

  const setFilter = <K extends keyof McpToolFilters>(key: K, value: McpToolFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const toggleSort = (key: McpToolSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "name" || key === "server" ? "asc" : "desc" }
    );

  const closeDrawer = useCallback(() => {
    setOpenKey(null);
    const target = returnFocusRef.current;
    if (target && target.isConnected) target.focus();
  }, []);

  return (
    <section className="mcp-page mcp-tools page-pane" aria-busy={loading}>
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">MCP tools</h2>
          <p className="page-sub">
            Every tool on every registered server, with how it behaves, whether your role may call it
            {catalog ? <> in project <code>{catalog.policy.projectId}</code></> : null}, and how agents use it.
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

      <div className="mcp-tool-filters" role="search" aria-label="Filter tools">
        <input
          type="search"
          className="mcp-tool-search"
          placeholder="Search tools, descriptions and servers"
          aria-label="Search tools"
          value={filters.search}
          onChange={(event) => setFilter("search", event.target.value)}
        />
        <select aria-label="Server" value={filters.serverId} onChange={(event) => setFilter("serverId", event.target.value)}>
          <option value="">All servers</option>
          {(catalog?.servers ?? []).map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Server status"
          value={filters.status}
          onChange={(event) => setFilter("status", event.target.value as McpServerStatus | "any")}
        >
          <option value="any">Any status</option>
          {MCP_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>
              {MCP_STATUS_LABEL[status]}
            </option>
          ))}
        </select>
        <select
          aria-label="Read-only or write"
          value={filters.kind}
          onChange={(event) => setFilter("kind", event.target.value as McpToolFilters["kind"])}
        >
          <option value="any">Read-only and write</option>
          <option value="read">Read-only</option>
          <option value="write">Write</option>
        </select>
        <div className="mcp-tool-flags">
          <FlagToggle label="Destructive" checked={filters.destructive} onChange={(value) => setFilter("destructive", value)} />
          <FlagToggle label="Open world" checked={filters.openWorld} onChange={(value) => setFilter("openWorld", value)} />
          <FlagToggle label="Blocked for my role" checked={filters.blocked} onChange={(value) => setFilter("blocked", value)} />
          <FlagToggle label="Has output schema" checked={filters.outputSchema} onChange={(value) => setFilter("outputSchema", value)} />
          {activeFilters > 0 && (
            <button type="button" className="kb-link-btn" onClick={() => setFilters(EMPTY_TOOL_FILTERS)}>
              Clear {activeFilters} filter{activeFilters === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>

      <p className="kb-subtle" aria-live="polite">
        {loading && !catalog
          ? "Loading…"
          : `${visible.length} of ${tools.length} tool${tools.length === 1 ? "" : "s"} · telemetry for the last ${range}`}
      </p>

      {catalog && tools.length === 0 ? (
        <div className="page-empty">
          <div>
            <p>No tools yet. Register a server and probe it to list its tools.</p>
            <button type="button" className="pg-btn" onClick={() => onNavigate({ page: "servers" })}>
              Go to servers
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-table-scroll">
          <table className="kb-table mcp-catalog-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key;
                  return (
                    <th
                      key={column.key}
                      className={column.numeric ? "num" : undefined}
                      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                    >
                      <button type="button" className="mcp-sort-btn" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        <span className="mcp-sort-mark" aria-hidden="true">
                          {active ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                        </span>
                      </button>
                    </th>
                  );
                })}
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((tool) => {
                const state = policyStateOf(tool);
                const key = toolKey(tool);
                return (
                  <tr key={key} className={openKey === key ? "is-selected" : undefined}>
                    <td>
                      <button
                        type="button"
                        className="mcp-ov-link mono"
                        onClick={(event) => {
                          returnFocusRef.current = event.currentTarget;
                          setOpenKey(key);
                        }}
                        aria-haspopup="dialog"
                      >
                        {tool.name}
                      </button>
                      {tool.annotations?.title && <div className="kb-subtle">{tool.annotations.title}</div>}
                    </td>
                    <td>
                      <span className="mcp-server-cell">
                        <span className={`mcp-dot mcp-status-${tool.serverStatus}`} aria-hidden="true" />
                        <span>{tool.serverName}</span>
                        <span className="sr-only">({MCP_STATUS_LABEL[tool.serverStatus]})</span>
                      </span>
                    </td>
                    <td className="num">{tool.telemetry ? formatCount(tool.telemetry.calls) : "—"}</td>
                    <td className="num">
                      {tool.telemetry && tool.telemetry.calls > 0
                        ? `${tool.telemetry.errors} (${formatPercent(tool.telemetry.errorRate)})`
                        : "—"}
                    </td>
                    <td className="num">{formatMs(tool.telemetry?.p95Ms)}</td>
                    <td className="num">{formatCost(tool.telemetry?.costUsd)}</td>
                    <td>
                      <span className={`mcp-pstate mcp-pstate-${state}`}>{POLICY_LABEL[state]}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {catalog && visible.length === 0 && <p className="kb-subtle mcp-empty-filter">No tool matches these filters.</p>}
        </div>
      )}

      {openTool && catalog && (
        <ToolDrawer
          tool={openTool}
          range={range}
          viewerRole={catalog.policy.role}
          projectId={catalog.servers.find((server) => server.id === openTool.serverId)?.policyProjectId ?? catalog.policy.projectId}
          onClose={closeDrawer}
          onNavigate={onNavigate}
          onOpenWorkflow={onOpenWorkflow}
        />
      )}
    </section>
  );
}

function FlagToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" className={checked ? "mcp-flag-toggle is-on" : "mcp-flag-toggle"} aria-pressed={checked} onClick={() => onChange(!checked)}>
      {label}
    </button>
  );
}

function ToolDrawer({
  tool,
  range,
  viewerRole,
  projectId,
  onClose,
  onNavigate,
  onOpenWorkflow
}: {
  tool: McpCatalogTool;
  range: McpTelemetryWindow;
  viewerRole: McpPolicyRole;
  projectId: string;
  onClose: () => void;
  onNavigate: (target: McpNavTarget) => void;
  onOpenWorkflow?: (workflowId: string) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const state = policyStateOf(tool);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="mcp-drawer-scrim" aria-hidden="true" onClick={onClose} />
      <aside className="mcp-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="mcp-drawer-head">
          <div className="mcp-drawer-title">
            <h3 id={titleId}>
              <code>{tool.name}</code>
            </h3>
            <span className="kb-subtle">
              on{" "}
              <button type="button" className="mcp-ov-link" onClick={() => onNavigate({ page: "servers", serverId: tool.serverId })}>
                {tool.serverName}
              </button>
            </span>
          </div>
          <button ref={closeRef} type="button" className="sidebar-icon-btn" onClick={onClose} aria-label="Close tool details" title="Close">
            <CloseIcon />
          </button>
        </header>

        <div className="mcp-drawer-body">
          <div className="mcp-drawer-row">
            <StatusBadge status={tool.serverStatus} />
            <span className={`mcp-pstate mcp-pstate-${state}`}>{POLICY_LABEL[state]}</span>
            <span className="kb-subtle">
              {tool.classification.readOnly ? "Read-only" : "Write"} ({tool.classification.source === "manual" ? "set by an admin" : tool.classification.source === "annotation" ? "from the server's annotation" : "unknown counts as write"})
            </span>
          </div>
          {tool.annotations?.title && <p className="mcp-drawer-lead">{tool.annotations.title}</p>}
          {tool.description && <p className="kb-subtle">{tool.description}</p>}
          <McpAnnotationChips annotations={tool.annotations} />
          {!tool.access.allowed && (
            <p className="mcp-blocked">
              {tool.access.message ?? "Blocked by policy."}{" "}
              {tool.access.ruleId && (
                <button type="button" className="kb-link-btn" onClick={() => onNavigate({ page: "policies", policyId: tool.access.ruleId })}>
                  Open rule{tool.access.ruleName ? ` “${tool.access.ruleName}”` : ""}
                </button>
              )}
            </p>
          )}

          <PolicyEvaluator tool={tool} defaultRole={viewerRole} defaultProjectId={projectId} onNavigate={onNavigate} />

          <section className="mcp-drawer-section" aria-label="Input schema">
            <h4>Input schema</h4>
            <pre className="mcp-schema-pre">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          </section>

          <section className="mcp-drawer-section" aria-label="Output schema">
            <h4>Output schema</h4>
            {tool.outputSchema ? <McpOutputSchema schema={tool.outputSchema} /> : <p className="kb-subtle">The server does not declare one.</p>}
          </section>

          <section className="mcp-drawer-section" aria-label="Recent calls">
            <h4>Recent calls · {range}</h4>
            {tool.telemetry && tool.telemetry.calls > 0 && (
              <p className="kb-subtle">
                {formatCount(tool.telemetry.calls)} calls · {tool.telemetry.errors} failed · p50 {formatMs(tool.telemetry.p50Ms)} · p95{" "}
                {formatMs(tool.telemetry.p95Ms)} · cost {formatCost(tool.telemetry.costUsd)}
              </p>
            )}
            {tool.recentCalls && tool.recentCalls.length > 0 ? (
              <div className="mcp-table-scroll">
                <table className="kb-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Result</th>
                      <th className="num">Duration</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tool.recentCalls.map((call, index) => (
                      <tr key={`${call.startedAt}:${index}`}>
                        <td>{formatWhen(call.startedAt)}</td>
                        <td>
                          <span className={call.ok ? "mcp-result is-ok" : "mcp-result is-err"}>{call.ok ? "ok" : "failed"}</span>
                          {call.error && <div className="kb-subtle mcp-call-error">{call.error}</div>}
                        </td>
                        <td className="num">{formatMs(call.durationMs)}</td>
                        <td>{call.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="kb-subtle">No calls in this window.</p>
            )}
          </section>

          <section className="mcp-drawer-section" aria-label="Used by">
            <h4>Used by</h4>
            {tool.usages && tool.usages.length > 0 ? (
              <ul className="mcp-ov-list">
                {tool.usages.map((usage) => (
                  <li key={`${usage.workflowId}:${usage.nodeId}`}>
                    {onOpenWorkflow ? (
                      <button type="button" className="mcp-ov-link" onClick={() => onOpenWorkflow(usage.workflowId)}>
                        {usage.workflowName}
                      </button>
                    ) : (
                      <span className="mcp-ov-name">{usage.workflowName}</span>
                    )}
                    <span className="kb-subtle">
                      {usage.nodeName} · {usage.nodeType}
                      {usage.allTools ? " · offers every tool of the server" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kb-subtle">No workflow node uses this tool.</p>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function PolicyEvaluator({
  tool,
  defaultRole,
  defaultProjectId,
  onNavigate
}: {
  tool: McpCatalogTool;
  defaultRole: McpPolicyRole;
  defaultProjectId: string;
  onNavigate: (target: McpNavTarget) => void;
}) {
  const [role, setRole] = useState<McpPolicyRole>(defaultRole);
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  const [result, setResult] = useState<McpToolPolicyEvaluation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((response) => {
        if (!cancelled) setProjects(response.projects);
      })
      .catch(() => {
        // The project id still works without names.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    evaluateMcpToolPolicy({ role, projectId, serverId: tool.serverId, toolName: tool.name })
      .then((evaluation) => {
        if (!cancelled) setResult(evaluation);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role, projectId, tool.serverId, tool.name]);

  const projectOptions = projects.some((project) => project.id === projectId)
    ? projects
    : [{ id: projectId, name: projectId } as Project, ...projects];

  return (
    <section className="mcp-drawer-section" aria-label="Policy decision">
      <h4>Policy decision</h4>
      <div className="mcp-drawer-form">
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as McpPolicyRole)}>
            {ROLES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {result && (
        <p className="mcp-decision" aria-live="polite" aria-busy={busy}>
          <span className={result.allowed ? "mcp-result is-ok" : "mcp-result is-err"}>{result.allowed ? "Allowed" : "Blocked"}</span>{" "}
          {result.decidedBy === "default"
            ? "No rule matches; tools are allowed by default."
            : result.allowed
              ? `Allowed by rule “${result.ruleName ?? result.decidingRuleId ?? "unnamed"}”.`
              : result.message ?? `Denied by rule “${result.ruleName ?? "unnamed"}”.`}{" "}
          {result.decidingRuleId && (
            <button type="button" className="kb-link-btn" onClick={() => onNavigate({ page: "policies", policyId: result.decidingRuleId ?? undefined })}>
              Open rule
            </button>
          )}
        </p>
      )}
    </section>
  );
}
