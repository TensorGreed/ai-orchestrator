/**
 * 13.3 — Settings > Data retention: how long one project keeps its runs, tool calls, rule events and agent memory.
 * Each class inherits the deployment's value until the project sets its own, within the deployment's bounds. Admins and
 * the project's admins can change the values; other members see them read-only.
 */
import { useCallback, useEffect, useState } from "react";
import {
  RETENTION_DATA_CLASS_LABELS,
  type Project,
  type ProjectRetentionOverride,
  type ProjectRetentionView,
  type RetentionDataClass
} from "@ai-orchestrator/shared";
import { ApiError, fetchProjectRetention, updateProjectRetention } from "../lib/api";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

export function formatRetentionDays(days: number): string {
  if (days <= 0) return "Kept forever";
  return days === 1 ? "1 day" : `${days.toLocaleString()} days`;
}

function describeBounds(view: ProjectRetentionView): string {
  const { minDays, maxDays } = view.bounds;
  if (maxDays === null) return `Values from ${formatRetentionDays(minDays)} up, or 0 to keep forever.`;
  return `Values from ${formatRetentionDays(minDays)} to ${formatRetentionDays(maxDays)}.`;
}

type Drafts = Partial<Record<RetentionDataClass, string>>;

function draftsOf(view: ProjectRetentionView): Drafts {
  return Object.fromEntries(view.classes.map((entry) => [entry.class, entry.days === null ? "" : String(entry.days)]));
}

export function ProjectRetentionTab({ projects, initialProjectId }: { projects: Project[]; initialProjectId: string }) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [view, setView] = useState<ProjectRetentionView | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setSaved(false);
    setView(null);
    try {
      const result = await fetchProjectRetention(projectId);
      setView(result);
      setDrafts(draftsOf(result));
    } catch (err) {
      setError(formatError(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!view) return;
    const classes: Partial<Record<RetentionDataClass, number | null>> = {};
    for (const entry of view.classes) {
      const text = (drafts[entry.class] ?? "").trim();
      if (text === "") {
        if (entry.days !== null) classes[entry.class] = null;
        continue;
      }
      const days = Number(text);
      if (!Number.isInteger(days) || days < 0) {
        setError(`${entry.label}: enter a whole number of days, or leave it empty to use the deployment default.`);
        return;
      }
      if (days !== entry.days) classes[entry.class] = days;
    }
    if (Object.keys(classes).length === 0) {
      setSaved(true);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await updateProjectRetention(view.projectId, classes);
      setView(result);
      setDrafts(draftsOf(result));
      setSaved(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Data retention">
      <h3>Data retention</h3>
      <p className="settings-muted">
        How long this project keeps its data before the retention purge deletes it. A class without a value of its own
        uses the deployment default.
      </p>
      <label htmlFor="retention-project-select">Project</label>
      <select id="retention-project-select" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {error && <div className="settings-error">{error}</div>}
      {!view && !error && <div className="settings-loading">Loading…</div>}
      {view && (
        <>
          <p className="settings-muted" data-testid="retention-exemptions">
            {view.exemptions}
          </p>
          <table className="settings-table" aria-label="Retention per class">
            <thead>
              <tr>
                <th>Data</th>
                <th>Days kept</th>
                <th>Applies now</th>
              </tr>
            </thead>
            <tbody>
              {view.classes.map((entry) => (
                <tr key={entry.class} data-testid={`project-retention-${entry.class}`}>
                  <td>
                    {entry.label}
                    <div className="settings-muted">{entry.what}</div>
                  </td>
                  <td>
                    {view.canEdit ? (
                      <>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          aria-label={`${entry.label} days`}
                          value={drafts[entry.class] ?? ""}
                          placeholder={`Default: ${formatRetentionDays(entry.deploymentDays)}`}
                          onChange={(event) => setDrafts((current) => ({ ...current, [entry.class]: event.target.value }))}
                        />
                        {(drafts[entry.class] ?? "") !== "" && (
                          <button
                            type="button"
                            className="header-btn"
                            onClick={() => setDrafts((current) => ({ ...current, [entry.class]: "" }))}
                          >
                            Use deployment default
                          </button>
                        )}
                      </>
                    ) : entry.days === null ? (
                      <span className="settings-muted">Deployment default</span>
                    ) : (
                      formatRetentionDays(entry.days)
                    )}
                  </td>
                  <td>
                    {formatRetentionDays(entry.effectiveDays)}
                    {entry.days === null && (
                      <div className="settings-muted">
                        Inherited from <code>{entry.deploymentSetting}</code>
                      </div>
                    )}
                    {entry.clamped && <div className="settings-muted">Outside the deployment's current range, so the nearest limit applies.</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.canEdit ? (
            <div className="settings-actions">
              <span className="settings-muted">{describeBounds(view)} Shortening a value deletes older data on the next purges.</span>
              <button type="button" className="header-btn" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save"}
              </button>
              {saved && <span role="status">Saved</span>}
            </div>
          ) : (
            <p className="settings-muted">Only admins and this project's admins can change these values.</p>
          )}
        </>
      )}
    </section>
  );
}

/** The admin Data protection page's list of projects with values of their own. */
export function ProjectRetentionOverrides({ overrides }: { overrides: ProjectRetentionOverride[] }) {
  if (overrides.length === 0) return null;
  return (
    <table className="settings-table" aria-label="Projects with their own retention">
      <thead>
        <tr>
          <th>Project</th>
          <th>Own values</th>
        </tr>
      </thead>
      <tbody>
        {overrides.map((override) => (
          <tr key={override.projectId} data-testid={`retention-override-${override.projectId}`}>
            <td>{override.projectName ?? override.projectId}</td>
            <td>
              {Object.entries(override.classes)
                .map(([key, days]) => `${RETENTION_DATA_CLASS_LABELS[key as RetentionDataClass]?.label ?? key}: ${formatRetentionDays(days ?? 0)}`)
                .join(", ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
