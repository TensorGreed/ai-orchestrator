/**
 * Phase 15.6 — Evaluations → Golden sets: production capture for one
 * workflow. A "Capture production runs" toggle (10% of production runs, up
 * to 20 a day, every outcome, personal data masked) with the rest under
 * Advanced, and the "Captured runs" inbox: promote a captured run into a
 * golden set in one click, discard it, or open the run it came from.
 *
 * Nothing changes for a workflow that never turns capture on: the inbox is
 * empty and production runs are not recorded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { REPLAY_CAPTURE_DEFAULT_SET_NAME, REPLAY_CAPTURE_STATUSES, type ReplayCaptureStatus, type WorkflowListItem } from "@ai-orchestrator/shared";
import {
  ApiError,
  discardReplayCaptures,
  fetchEvalDatasets,
  fetchReplayCaptureSettings,
  fetchReplayCaptures,
  promoteReplayCaptures,
  saveReplayCaptureSettings,
  type EvalDataset,
  type ReplayCaptureSettingsView,
  type ReplayCaptureView
} from "../lib/api";
import {
  captureFormFrom,
  captureSettingsFromForm,
  captureStatusLabel,
  captureSummaryLine,
  captureTriggerLabel,
  dataClassLabel,
  type CaptureForm
} from "../lib/replay-capture";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface CaptureInboxProps {
  workflows: WorkflowListItem[];
  activeProjectId?: string;
  canEdit: boolean;
  isAdmin: boolean;
  /** The workflow to open first (the one in the editor). */
  initialWorkflowId?: string;
  /** Opens the production run a capture came from on the Runs page. */
  onOpenRun?: (executionId: string) => void;
  /** Called after a promote, so golden-set counts refresh. */
  onPromoted?: () => void;
}

export function CaptureInbox({ workflows, activeProjectId, canEdit, isAdmin, initialWorkflowId, onOpenRun, onPromoted }: CaptureInboxProps) {
  const [workflowId, setWorkflowId] = useState<string>(() =>
    initialWorkflowId && workflows.some((workflow) => workflow.id === initialWorkflowId) ? initialWorkflowId : (workflows[0]?.id ?? "")
  );
  useEffect(() => {
    if (!workflowId && workflows[0]) setWorkflowId(workflows[0].id);
  }, [workflowId, workflows]);

  if (workflows.length === 0) return null;

  return (
    <section className="capture-panel" aria-labelledby="capture-title">
      <header className="capture-head">
        <h3 id="capture-title" className="capture-title">
          Production capture
        </h3>
        {workflows.length > 1 && (
          <label className="capture-workflow">
            <span className="cfg-label">Workflow</span>
            <select className="cfg-input" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} aria-label="Capture workflow">
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {workflowId && (
        <WorkflowCapture
          key={workflowId}
          workflowId={workflowId}
          activeProjectId={activeProjectId}
          canEdit={canEdit}
          isAdmin={isAdmin}
          {...(onOpenRun ? { onOpenRun } : {})}
          {...(onPromoted ? { onPromoted } : {})}
        />
      )}
    </section>
  );
}

interface WorkflowCaptureProps {
  workflowId: string;
  activeProjectId?: string;
  canEdit: boolean;
  isAdmin: boolean;
  onOpenRun?: (executionId: string) => void;
  onPromoted?: () => void;
}

function WorkflowCapture({ workflowId, activeProjectId, canEdit, isAdmin, onOpenRun, onPromoted }: WorkflowCaptureProps) {
  const [view, setView] = useState<ReplayCaptureSettingsView | null>(null);
  const [form, setForm] = useState<CaptureForm | null>(null);
  const [sets, setSets] = useState<EvalDataset[]>([]);
  const [items, setItems] = useState<ReplayCaptureView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [outcome, setOutcome] = useState<"" | ReplayCaptureStatus>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    try {
      const page = await fetchReplayCaptures(workflowId, { limit: 100, ...(outcome ? { runStatus: outcome } : {}) });
      setItems(page.items);
      setTotal(page.total);
      setSelected((current) => new Set([...current].filter((id) => page.items.some((item) => item.id === id))));
    } catch (err) {
      setError(errorText(err, "Could not load captured runs"));
      setItems([]);
    }
  }, [workflowId, outcome]);

  const loadSettings = useCallback(async () => {
    try {
      const [settingsResponse, setsResponse] = await Promise.all([fetchReplayCaptureSettings(workflowId), fetchEvalDatasets(activeProjectId, { workflowId })]);
      setView(settingsResponse.settings);
      setForm(captureFormFrom(settingsResponse.settings));
      setSets(setsResponse.datasets.filter((dataset) => dataset.workflowId === workflowId));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load capture settings"));
    }
  }, [activeProjectId, workflowId]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    void loadInbox();
  }, [loadInbox]);

  const save = async (next: CaptureForm) => {
    if (!view) return;
    const { settings, errors } = captureSettingsFromForm(next, view, isAdmin);
    setFormErrors(errors);
    setNotice(null);
    if (errors.length > 0) return;
    if (Object.keys(settings).length === 0) return setNotice("Nothing changed.");
    setBusy("save");
    try {
      const response = await saveReplayCaptureSettings(workflowId, settings);
      setView(response.settings);
      setForm(captureFormFrom(response.settings));
      setNotice(response.settings.enabled ? "Capture settings saved." : "Capture is off.");
    } catch (err) {
      setFormErrors([errorText(err, "Could not save capture settings")]);
      setForm(captureFormFrom(view));
    } finally {
      setBusy(null);
    }
  };

  const act = async (kind: "promote" | "discard", ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(kind);
    setNotice(null);
    setError(null);
    try {
      if (kind === "promote") {
        const response = await promoteReplayCaptures(ids, form?.targetDatasetId || undefined);
        const failed = response.results.filter((result) => !result.ok);
        const setName = sets.find((set) => set.id === response.results.find((result) => result.ok)?.datasetId)?.name ?? REPLAY_CAPTURE_DEFAULT_SET_NAME;
        setNotice(response.promoted > 0 ? `${response.promoted} promoted to “${setName}”.` : null);
        if (failed.length > 0) setError(failed.map((result) => result.error).filter(Boolean).join(" · "));
        if (response.promoted > 0) {
          onPromoted?.();
          void loadSettings();
        }
      } else {
        const response = await discardReplayCaptures(ids);
        setNotice(`${response.discarded} discarded.`);
      }
      setSelected(new Set());
      await loadInbox();
    } catch (err) {
      setError(errorText(err, kind === "promote" ? "Could not promote" : "Could not discard"));
    } finally {
      setBusy(null);
    }
  };

  const allSelected = useMemo(() => Boolean(items && items.length > 0 && items.every((item) => selected.has(item.id))), [items, selected]);

  if (!view || !form) {
    return error ? (
      <div className="approvals-error" role="alert">
        {error}
      </div>
    ) : (
      <div className="evals-empty">Loading…</div>
    );
  }

  const update = (patch: Partial<CaptureForm>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const locked = !canEdit || busy === "save" || !view.deployment.enabled;
  const toggle = (next: Set<string>, id: string) => {
    const copy = new Set(next);
    if (copy.has(id)) copy.delete(id);
    else copy.add(id);
    return copy;
  };

  return (
    <div className="capture-grid">
      <div className="release-card capture-settings">
        <label className="guard-check capture-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={locked}
            onChange={(event) => {
              const next = { ...form, enabled: event.target.checked };
              setForm(next);
              void save(next);
            }}
          />
          <span>Capture production runs</span>
        </label>
        <p className="settings-help" aria-live="polite">
          {captureSummaryLine(view)}
        </p>
        <details className="capture-advanced">
          <summary>Advanced</summary>
          <fieldset className="release-fieldset" disabled={locked}>
            <div className="capture-fields">
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={`capture-rate-${workflowId}`}>
                  Sample rate (%)
                </label>
                <input id={`capture-rate-${workflowId}`} className="cfg-input" inputMode="decimal" value={form.ratePercent} onChange={(event) => update({ ratePercent: event.target.value })} />
              </div>
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={`capture-day-${workflowId}`}>
                  Most a day
                </label>
                <input id={`capture-day-${workflowId}`} className="cfg-input" inputMode="numeric" value={form.maxPerDay} onChange={(event) => update({ maxPerDay: event.target.value })} />
              </div>
            </div>
            <div className="cfg-field">
              <span className="cfg-label">Keep runs that</span>
              <div className="gate-roles">
                {REPLAY_CAPTURE_STATUSES.map((status) => (
                  <label key={status} className="guard-check">
                    <input
                      type="checkbox"
                      checked={form.onlyStatuses.includes(status)}
                      onChange={(event) =>
                        update({ onlyStatuses: event.target.checked ? [...form.onlyStatuses, status] : form.onlyStatuses.filter((entry) => entry !== status) })
                      }
                    />
                    {captureStatusLabel(status)}
                  </label>
                ))}
              </div>
            </div>
            <div className="cfg-field">
              <label className="cfg-label" htmlFor={`capture-target-${workflowId}`}>
                Promote into
              </label>
              <select id={`capture-target-${workflowId}`} className="cfg-input" value={form.targetDatasetId} onChange={(event) => update({ targetDatasetId: event.target.value })}>
                <option value="">“{REPLAY_CAPTURE_DEFAULT_SET_NAME}” (created on the first promote)</option>
                {sets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            </div>
            <label className="guard-check">
              <input type="checkbox" checked={form.dlp} disabled={!isAdmin && form.dlp} onChange={(event) => update({ dlp: event.target.checked })} />
              Mask personal data with surrogates
            </label>
            <div className="capture-help">
              Emails, card numbers, IBANs, SSNs, phone numbers and your guard profile's dictionary terms are replaced by stable stand-ins before the run is stored. This is
              pseudonymisation, not anonymisation. {isAdmin ? "Turning it off needs a reason and is audited." : "Only an admin can turn it off."}
            </div>
            {!form.dlp && view.dlp && (
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={`capture-reason-${workflowId}`}>
                  Why store unmasked runs?
                </label>
                <input id={`capture-reason-${workflowId}`} className="cfg-input" value={form.reason} onChange={(event) => update({ reason: event.target.value })} />
              </div>
            )}
            {!view.dlp && view.dlpOffReason && <div className="capture-help">Masking is off: “{view.dlpOffReason}”</div>}
            <div className="capture-help">
              Captured runs wait {view.deployment.retentionDays} days in the inbox; at {view.deployment.maxCandidates} the oldest is dropped.
            </div>
            {canEdit && (
              <div className="release-actions">
                <button type="button" className="pg-btn primary small" disabled={busy !== null} onClick={() => void save(form)}>
                  {busy === "save" ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </fieldset>
        </details>
        {formErrors.length > 0 && (
          <ul className="approvals-error release-form-errors" role="alert">
            {formErrors.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="release-card capture-inbox" aria-labelledby={`capture-inbox-${workflowId}`}>
        <header className="release-card-head">
          <h4 id={`capture-inbox-${workflowId}`} className="capture-inbox-title">
            Captured runs
          </h4>
          <span className={total > 0 ? "release-tag is-warn capture-badge" : "release-tag capture-badge"} aria-label={`${total} captured runs waiting`}>
            {total}
          </span>
          <select className="cfg-input capture-filter" aria-label="Filter by outcome" value={outcome} onChange={(event) => setOutcome(event.target.value as "" | ReplayCaptureStatus)}>
            <option value="">All outcomes</option>
            {REPLAY_CAPTURE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {captureStatusLabel(status)}
              </option>
            ))}
          </select>
        </header>
        {notice && (
          <div className="approvals-notice" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="approvals-error" role="alert">
            {error}
          </div>
        )}
        {!items ? (
          <div className="evals-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="evals-empty capture-empty">
            {view.enabled
              ? "No captured runs yet. Sampled production runs land here, masked, for you to promote into a golden set."
              : "Turn on capture and a sample of this workflow's production runs lands here, masked, ready to promote into a golden set."}
          </div>
        ) : (
          <>
            {canEdit && (
              <div className="capture-bulk">
                <label className="guard-check">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} />
                  Select all
                </label>
                <button type="button" className="pg-btn small primary" disabled={selected.size === 0 || busy !== null} onClick={() => void act("promote", [...selected])}>
                  Promote {selected.size > 0 ? selected.size : ""}
                </button>
                <button type="button" className="pg-btn small danger" disabled={selected.size === 0 || busy !== null} onClick={() => void act("discard", [...selected])}>
                  Discard {selected.size > 0 ? selected.size : ""}
                </button>
              </div>
            )}
            <ul className="capture-list" aria-label="Captured runs">
              {items.map((item) => (
                <li key={item.id} className="capture-row">
                  {canEdit && (
                    <input type="checkbox" aria-label={`Select ${item.name}`} checked={selected.has(item.id)} onChange={() => setSelected((current) => toggle(current, item.id))} />
                  )}
                  <span className="capture-row-main">
                    <span className="capture-row-title">{item.name}</span>
                    <span className="capture-row-sub">
                      {captureTriggerLabel(item.sourceTriggerType)} · {formatWhen(item.capturedAt)}
                      {item.capabilities.capture?.publishedVersion ? ` · v${item.capabilities.capture.publishedVersion}` : ""}
                    </span>
                  </span>
                  <span className={`release-tag is-${item.sourceStatus === "success" ? "ok" : "warn"}`}>
                    {captureStatusLabel((REPLAY_CAPTURE_STATUSES as readonly string[]).includes(item.sourceStatus) ? (item.sourceStatus as ReplayCaptureStatus) : "error")}
                  </span>
                  <span className="capture-chips" aria-label="Data classes">
                    {!item.masked ? (
                      <span className="capture-chip is-raw">not masked</span>
                    ) : item.dataClasses.length === 0 ? (
                      <span className="capture-chip is-none">no personal data found</span>
                    ) : (
                      item.dataClasses.map((dataClass) => (
                        <span key={dataClass} className="capture-chip">
                          {dataClassLabel(dataClass)}
                        </span>
                      ))
                    )}
                  </span>
                  <span className="capture-actions">
                    {onOpenRun && item.sourceExecutionId && (
                      <button type="button" className="pg-btn small ghost" onClick={() => onOpenRun(item.sourceExecutionId!)}>
                        Open run
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button type="button" className="pg-btn small danger" disabled={busy !== null} onClick={() => void act("discard", [item.id])}>
                          Discard
                        </button>
                        <button type="button" className="pg-btn small primary" disabled={busy !== null} onClick={() => void act("promote", [item.id])}>
                          Promote
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
