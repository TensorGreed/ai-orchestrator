/**
 * 13.3 — Settings > Data protection: how long the deployment keeps each kind of data (read-only, from the environment),
 * what is due for deletion now, and the latest purges; then data-subject requests.
 */
import { useEffect, useState } from "react";
import { RETENTION_PURGE_CLASS_LABELS, type RetentionAdminView, type RetentionRunView } from "@ai-orchestrator/shared";
import { ApiError, fetchRetention } from "../lib/api";
import { SubjectRequestsSection } from "./SubjectRequestsSection";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDays(days: number): string {
  if (days <= 0) return "Kept forever";
  return days === 1 ? "1 day" : `${days.toLocaleString()} days`;
}

function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "every hour" : `every ${minutes / 60} hours`;
  return minutes <= 1 ? "every minute" : `every ${minutes} minutes`;
}

const REASON_LABELS: Record<RetentionRunView["reason"], string> = {
  startup: "At start-up",
  interval: "Scheduled",
  write: "After a run",
  manual: "Manual"
};

function describeCounts(run: RetentionRunView): string {
  const entries = Object.entries(run.counts).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return "Nothing due";
  return entries
    .map(([key, n]) => `${RETENTION_PURGE_CLASS_LABELS[key as keyof typeof RETENTION_PURGE_CLASS_LABELS]?.label ?? key}: ${(n ?? 0).toLocaleString()}`)
    .join(", ");
}

export function DataProtectionTab() {
  const [view, setView] = useState<RetentionAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRetention()
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
    <section className="settings-section" aria-label="Data protection">
      <h3>Data protection</h3>
      <p className="settings-muted">
        How long this deployment keeps each kind of data. The values come from environment variables and are shown here
        read-only. Golden runs, golden-set cases, paused runs and pending approvals are never deleted by age.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {!view && !error && <div className="settings-loading">Loading…</div>}
      {view && (
        <>
          <p className="settings-muted" data-testid="retention-schedule">
            Purges run on the leader {formatInterval(view.intervalMs)} and after finished runs, deleting at most{" "}
            {view.maxRowsPerTick.toLocaleString()} rows per table each time; anything left goes on the next purge.
          </p>
          <table className="settings-table" aria-label="Retention per class">
            <thead>
              <tr>
                <th>Data</th>
                <th>Kept</th>
                <th>Setting</th>
                <th>Due now</th>
              </tr>
            </thead>
            <tbody>
              {view.classes.map((entry) => (
                <tr key={entry.class} data-testid={`retention-class-${entry.class}`}>
                  <td>
                    {entry.label}
                    <div className="settings-muted">{entry.what}</div>
                  </td>
                  <td>{formatDays(entry.days)}</td>
                  <td>
                    <code>{entry.setting}</code>
                  </td>
                  <td>
                    {entry.backlog === null
                      ? "—"
                      : entry.backlogCapped
                        ? `${view.backlogCap.toLocaleString()}+ rows`
                        : `${entry.backlog.toLocaleString()} ${entry.backlog === 1 ? "row" : "rows"}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="settings-table" aria-label="Purges">
            <tbody>
              <tr data-testid="retention-last-run">
                <th scope="row">Last purge</th>
                <td>
                  {view.lastRun
                    ? `${formatDate(view.lastRun.startedAt)} (${REASON_LABELS[view.lastRun.reason]}): ${describeCounts(view.lastRun)}`
                    : "None yet"}
                  {view.lastRun?.error && <div className="settings-error">{view.lastRun.error}</div>}
                </td>
              </tr>
              <tr data-testid="retention-next-run">
                <th scope="row">Next scheduled purge</th>
                <td>{view.nextRunAt ? formatDate(view.nextRunAt) : "After the first scheduled purge"}</td>
              </tr>
            </tbody>
          </table>
          {view.runs.length > 1 && (
            <table className="settings-table" aria-label="Recent purges">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Why</th>
                  <th>Outcome</th>
                  <th>Deleted</th>
                </tr>
              </thead>
              <tbody>
                {view.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{formatDate(run.startedAt)}</td>
                    <td>{REASON_LABELS[run.reason]}</td>
                    <td>{run.outcome === "ok" ? "OK" : run.outcome === "partial" ? "Partly failed" : "Failed"}</td>
                    <td>{describeCounts(run)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
    <SubjectRequestsSection />
    </>
  );
}
