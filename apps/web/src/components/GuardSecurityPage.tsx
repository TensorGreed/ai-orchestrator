/**
 * Phase 12.1 — Security: what the guard did across runs.
 *
 * Overview: verdict counts by action, category and channel over time, the
 * detectors that fire most, what shadow-mode rules would have blocked, and
 * the latest events (masked evidence only) with links to their runs. Filter
 * by project, workflow and profile. Profiles: the profile editor and the
 * project / workflow bindings with the enforced lock. Data destinations
 * (Phase 16): how far each place data goes is from home.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GuardEventView, GuardProfileSummary, Project, WorkflowListItem } from "@ai-orchestrator/shared";
import { ApiError, fetchGuardEvents, fetchGuardProfiles, fetchGuardStats, type GuardStats } from "../lib/api";
import { actionLabel, channelLabel, dailySeries } from "../lib/guard-trace";
import { DataDestinationsView } from "./DataDestinationsView";
import { GuardProfilesView } from "./GuardProfilesView";

type Tab = "overview" | "profiles" | "destinations";
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", profiles: "Profiles & bindings", destinations: "Data destinations" };
const DAY_WINDOWS = [7, 14, 30] as const;

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface GuardSecurityPageProps {
  projects: Project[];
  workflows: WorkflowListItem[];
  activeProjectId?: string;
  role: "admin" | "builder" | "operator" | "viewer";
  onOpenRun?: (executionId: string) => void;
}

export function GuardSecurityPage({ projects, workflows, activeProjectId, role, onOpenRun }: GuardSecurityPageProps) {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <section className="guard-page page-pane">
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">Security</h2>
          <p className="page-sub">Guard verdicts on prompts, tool calls, tool results and answers, and the profiles that decide them.</p>
        </div>
        <div className="finops-range guard-tabs" role="tablist" aria-label="Security views">
          {(["overview", "profiles", "destinations"] as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              className={tab === entry ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setTab(entry)}
            >
              {TAB_LABEL[entry]}
            </button>
          ))}
        </div>
      </header>
      {tab === "overview" && <GuardOverview projects={projects} workflows={workflows} {...(onOpenRun ? { onOpenRun } : {})} />}
      {tab === "profiles" && <GuardProfilesView projects={projects} workflows={workflows} activeProjectId={activeProjectId ?? "default"} role={role} />}
      {tab === "destinations" && <DataDestinationsView />}
    </section>
  );
}

function GuardOverview({ projects, workflows, onOpenRun }: { projects: Project[]; workflows: WorkflowListItem[]; onOpenRun?: (executionId: string) => void }) {
  const [days, setDays] = useState<number>(14);
  const [projectId, setProjectId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const [stats, setStats] = useState<GuardStats | null>(null);
  const [events, setEvents] = useState<Array<GuardEventView & { workflowName?: string }>>([]);
  const [total, setTotal] = useState(0);
  const [findingsOnly, setFindingsOnly] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGuardProfiles()
      .then((response) => setProfiles(response.profiles))
      .catch(() => setProfiles([]));
  }, []);

  const filter = useMemo(
    () => ({ days, ...(projectId ? { projectId } : {}), ...(workflowId ? { workflowId } : {}), ...(profileId ? { profileId } : {}) }),
    [days, profileId, projectId, workflowId]
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [statsResponse, eventsResponse] = await Promise.all([fetchGuardStats(filter), fetchGuardEvents({ ...filter, limit: 50, ...(findingsOnly ? { findings: true } : {}) })]);
      setStats(statsResponse.stats);
      setEvents(eventsResponse.events);
      setTotal(eventsResponse.total);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [filter, findingsOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleWorkflows = projectId ? workflows.filter((workflow) => (workflow.projectId ?? "default") === projectId) : workflows;
  const count = (rows: Array<{ key: string; count: number }> | undefined, keys: string[]) => (rows ?? []).filter((row) => keys.includes(row.key)).reduce((acc, row) => acc + row.count, 0);
  const verdictTotal = (stats?.verdicts ?? []).reduce((acc, row) => acc + row.count, 0);
  const series = dailySeries(stats?.daily ?? [], days);
  const peak = Math.max(1, ...series.map((entry) => entry.blocked + entry.review + entry.rewritten + entry.allowed));

  return (
    <div className="guard-overview" aria-busy={loading}>
      <div className="guard-filters" role="group" aria-label="Filters">
        <label>
          <span>Project</span>
          <select value={projectId} onChange={(event) => { setProjectId(event.target.value); setWorkflowId(""); }}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Workflow</span>
          <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
            <option value="">All workflows</option>
            {visibleWorkflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Profile</span>
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            <option value="">All profiles</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <div className="finops-range" role="group" aria-label="Window">
          {DAY_WINDOWS.map((entry) => (
            <button key={entry} type="button" aria-pressed={days === entry} className={days === entry ? "finops-range-btn active" : "finops-range-btn"} onClick={() => setDays(entry)}>
              {entry}d
            </button>
          ))}
        </div>
        <button type="button" className="pg-btn" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="settings-error">{error}</div>}

      <div className="mcp-stats" aria-label="Totals">
        <Stat label={`Verdicts · ${days}d`} value={String(verdictTotal)} />
        <Stat label="Blocked" value={String(count(stats?.verdicts, ["block"]))} tone="err" />
        <Stat label="Review or approval" value={String(count(stats?.verdicts, ["review", "require_approval"]))} tone="warn" />
        <Stat label="Rewritten" value={String(count(stats?.verdicts, ["redact", "mask", "protect", "transform"]))} hint="redacted, masked or protected" />
        <Stat label="Shadow: would block" value={String(stats?.shadowWouldBlock ?? 0)} hint={`${stats?.shadowFindings ?? 0} shadow findings`} />
        <Stat label="Budget exceeded" value={String(stats?.budgetExceeded ?? 0)} hint="detectors skipped" />
      </div>

      <section className="kb-section" aria-labelledby="guard-daily">
        <div className="mcp-section-head">
          <h4 id="guard-daily">Verdicts per day</h4>
          <span className="guard-legend">
            <i className="guard-swatch guard-swatch-block" /> blocked <i className="guard-swatch guard-swatch-review" /> review <i className="guard-swatch guard-swatch-rewrite" /> rewritten <i className="guard-swatch guard-swatch-allow" /> allowed
          </span>
        </div>
        <div className="guard-chart" role="list" aria-label="Verdicts per day">
          {series.map((entry) => {
            const sum = entry.blocked + entry.review + entry.rewritten + entry.allowed;
            const label = `${entry.day}: ${sum} verdicts (${entry.blocked} blocked, ${entry.review} review, ${entry.rewritten} rewritten, ${entry.allowed} allowed)`;
            return (
              <div key={entry.day} className="guard-chart-col" role="listitem" title={label} aria-label={label}>
                <div className="guard-chart-stack" style={{ height: `${(sum / peak) * 100}%` }}>
                  {entry.blocked > 0 && <i className="guard-bar guard-bar-block" style={{ flexGrow: entry.blocked }} />}
                  {entry.review > 0 && <i className="guard-bar guard-bar-review" style={{ flexGrow: entry.review }} />}
                  {entry.rewritten > 0 && <i className="guard-bar guard-bar-rewrite" style={{ flexGrow: entry.rewritten }} />}
                  {entry.allowed > 0 && <i className="guard-bar guard-bar-allow" style={{ flexGrow: entry.allowed }} />}
                </div>
                <span className="guard-chart-day">{entry.day.slice(5)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <div className="guard-grid">
        <Ranked title="By action" rows={stats?.actions ?? []} format={actionLabel} empty="No findings yet." />
        <Ranked title="By category" rows={stats?.categories ?? []} empty="No findings yet." />
        <Ranked title="By channel" rows={stats?.channels ?? []} format={channelLabel} empty="No verdicts yet." />
        <Ranked title="Top detectors" rows={stats?.detectors ?? []} empty="No findings yet." mono />
      </div>

      <section className="kb-section" aria-labelledby="guard-latest">
        <div className="mcp-section-head">
          <h4 id="guard-latest">
            Latest events <span className="kb-subtle">{total}</span>
          </h4>
          <label className="guard-inline-check">
            <input type="checkbox" checked={findingsOnly} onChange={(event) => setFindingsOnly(event.target.checked)} /> Findings only
          </label>
        </div>
        {events.length === 0 ? (
          <p className="kb-subtle">No guard events in this window.</p>
        ) : (
          <div className="mcp-table-scroll">
            <table className="kb-table guard-events-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Workflow · node</th>
                  <th>Channel</th>
                  <th>Finding</th>
                  <th>Action</th>
                  <th>Evidence (masked)</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="muted-cell">{formatWhen(event.createdAt)}</td>
                    <td>
                      <span>{event.workflowName ?? event.workflowId ?? "—"}</span>
                      <span className="mono-cell guard-cell-sub">
                        {event.nodeId}
                        {typeof event.iteration === "number" ? ` · step ${event.iteration}` : ""}
                        {event.toolName ? ` · ${event.toolName}` : ""}
                      </span>
                    </td>
                    <td>{channelLabel(event.channel)}</td>
                    <td>
                      {event.detectorId ? (
                        <>
                          <span className="mono-cell">{event.detectorId}</span>
                          <span className="guard-cell-sub">
                            {event.category}
                            {event.dataClass ? ` / ${event.dataClass}` : ""}
                            {typeof event.score === "number" ? ` · ${event.score.toFixed(2)}` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="kb-subtle">clean</span>
                      )}
                    </td>
                    <td>
                      <span className={`guard-action guard-action-${event.effectiveAction}`}>{actionLabel(event.effectiveAction)}</span>
                      {event.shadow && <span className="guard-chip guard-chip-shadow">shadow</span>}
                    </td>
                    <td>{event.evidence[0]?.evidence ? <code className="guard-evidence">{event.evidence[0].evidence}</code> : <span className="kb-subtle">—</span>}</td>
                    <td>
                      {onOpenRun ? (
                        <button type="button" className="mcp-ov-link mono-cell" onClick={() => onOpenRun(event.executionId)}>
                          {event.executionId.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="mono-cell">{event.executionId.slice(0, 8)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "err" | "warn" }) {
  return (
    <div className={`mcp-stat${tone ? ` guard-stat-${tone}` : ""}`}>
      <div className="mcp-stat-label">{label}</div>
      <div className="mcp-stat-value">{value}</div>
      {hint && <div className="mcp-stat-hint">{hint}</div>}
    </div>
  );
}

function Ranked({ title, rows, format, empty, mono }: { title: string; rows: Array<{ key: string; count: number }>; format?: (key: string) => string; empty: string; mono?: boolean }) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="kb-section guard-ranked" aria-label={title}>
      <h4>{title}</h4>
      {rows.length === 0 ? (
        <p className="kb-subtle">{empty}</p>
      ) : (
        <ul className="guard-ranked-list">
          {rows.slice(0, 8).map((row) => (
            <li key={row.key || "none"}>
              <span className={mono ? "mono-cell guard-ranked-key" : "guard-ranked-key"}>{format ? format(row.key) : row.key || "—"}</span>
              <span className="guard-ranked-bar" aria-hidden="true">
                <i style={{ width: `${(row.count / max) * 100}%` }} />
              </span>
              <span className="mono-cell num">{row.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
