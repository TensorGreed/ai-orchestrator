import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReplayJobEstimate, WorkflowListItem } from "@ai-orchestrator/shared";
import {
  ApiError,
  addGoldenRunToSet,
  cancelReplayJob,
  createEvalDataset,
  deleteEvalDataset,
  deleteEvalFixture,
  estimateReplayJob,
  fetchDefinitions,
  fetchEvalDatasets,
  fetchEvalFixtures,
  fetchReplayJob,
  fetchReplayJobCase,
  fetchReplayJobs,
  fetchReplayRecordings,
  fetchSecrets,
  fetchWorkflowVersions,
  isEvalRunActive,
  startReplayJob,
  subscribeEvalRun,
  type EvalCaseDetail,
  type EvalCaseResult,
  type EvalDataset,
  type EvalFixture,
  type EvalRunView,
  type EvalScoreDetail,
  type EvalScorerSpec,
  type ReplayJobDetail,
  type ReplayMcpMode,
  type ReplayRecordingSummary,
  type SecretListItem,
  type ToolSequenceMode,
  type WorkflowVersionSummary
} from "../lib/api";
import {
  buildReplayJobRequest,
  candidateLabel,
  caseStatusLabel,
  comparisonLabel,
  emptyReplayJobForm,
  formatDuration,
  formatSpend,
  formatUsd,
  jobCounts,
  jobWarnings,
  overrideLines,
  releaseProofLine,
  shortHash,
  statusTone,
  type ReplayJobForm
} from "../lib/replay-jobs";
import { GoldenStarIcon, ReplayResultView } from "./GoldenRunPanel";
import { ReplayCandidateFields, ReplayEstimatePanel } from "./ReplayCandidateFields";
import { ReleaseGatePanel } from "./ReleaseGatePanel";
import { CaptureInbox } from "./CaptureInbox";

/**
 * Phase 15.2 — the Evaluations page: golden sets (golden runs of one
 * workflow, grouped) and replay jobs (every case of a set replayed against
 * the draft or a saved version, then scored). Phase 15.4 adds release
 * gates: which jobs a version must pass before it is published.
 */

export type EvaluationsRole = "admin" | "builder" | "operator" | "viewer";

export interface EvaluationsPageProps {
  workflows: WorkflowListItem[];
  activeProjectId?: string;
  role: EvaluationsRole;
  /** Opens Settings, where plain eval datasets with hand-written fixtures live. */
  onOpenSettings?: () => void;
  /** Phase 15.4 — the tab to open on, and the workflow the Release gates tab starts on. */
  initialTab?: EvaluationsTab;
  currentWorkflowId?: string;
  /** Phase 15.6 — opens a captured run's source execution on the Runs page. */
  onOpenRun?: (executionId: string) => void;
}

export type EvaluationsTab = "sets" | "jobs" | "gates";
type Tab = EvaluationsTab;

const TAB_LABELS: Record<Tab, string> = { sets: "Golden sets", jobs: "Replay jobs", gates: "Release gates" };

const TOOL_SEQUENCE_MODE_LABELS: Record<ToolSequenceMode, string> = {
  exact: "Exact order",
  subsequence: "Golden calls in order, extras allowed",
  set: "Same tools, any order",
  superset_allowed: "Golden tools present, extras allowed"
};

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function useEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

/** Moves focus into an overlay when it opens and hands it back when it closes. */
function useOverlayFocus<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node && !node.contains(document.activeElement)) {
      const target = node.querySelector<HTMLElement>("[autofocus], input, select, textarea, button");
      (target ?? node).focus();
    }
    return () => {
      if (previous && typeof previous.focus === "function" && document.contains(previous)) previous.focus();
    };
  }, []);
  return ref;
}

function StatusChip({ status, label }: { status: string; label?: string }) {
  return (
    <span className="status-pill" data-status={statusTone(status)}>
      {label ?? status}
    </span>
  );
}

function ScorerChip({ detail }: { detail: EvalScoreDetail }) {
  return (
    <span className={`evals-scorer-chip ${detail.pass ? "is-pass" : "is-fail"}`} title={detail.reason}>
      <span aria-hidden="true">{detail.pass ? "✓" : "✗"}</span>
      <span className="evals-scorer-type">{detail.type}</span>
      {typeof detail.score === "number" && <span className="evals-scorer-score">{detail.score.toFixed(2)}</span>}
      <span className="sr-only">{detail.pass ? " passed" : " failed"}: {detail.reason}</span>
    </span>
  );
}

function describeScorer(scorer: EvalScorerSpec): string {
  switch (scorer.type) {
    case "text_similarity":
      return scorer.threshold !== undefined ? `text_similarity ≥ ${scorer.threshold}` : "text_similarity";
    case "tool_sequence":
      return scorer.mode ? `tool_sequence · ${scorer.mode}` : "tool_sequence";
    case "llm_judge":
      return `llm_judge · ${scorer.mode ?? "absolute"}`;
    default:
      return scorer.type;
  }
}

export function EvaluationsPage({ workflows, activeProjectId, role, onOpenSettings, initialTab = "sets", currentWorkflowId, onOpenRun }: EvaluationsPageProps) {
  const canEdit = role === "admin" || role === "builder";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [jobsVersion, setJobsVersion] = useState(0);
  const workflowNames = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow.name])), [workflows]);

  const onJobStarted = useCallback((run: EvalRunView) => {
    setJobsVersion((value) => value + 1);
    setOpenJobId(run.id);
    setTab("jobs");
  }, []);

  return (
    <section className="page-pane evals-page">
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">Evaluations</h2>
          <p className="page-sub">
            Group golden runs into sets and replay them against the draft or a saved version, so a change is scored before it ships.
            {onOpenSettings && (
              <>
                {" "}
                Datasets with hand-written fixtures stay in{" "}
                <button type="button" className="evals-inline-link" onClick={onOpenSettings}>
                  Settings → Evals
                </button>
                .
              </>
            )}
          </p>
        </div>
        <div className="finops-range evals-tabs" role="tablist" aria-label="Evaluation views">
          {(["sets", "jobs", "gates"] as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              id={`evals-tab-${entry}`}
              aria-selected={tab === entry}
              aria-controls={`evals-panel-${entry}`}
              className={tab === entry ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setTab(entry)}
            >
              {TAB_LABELS[entry]}
            </button>
          ))}
        </div>
      </header>
      <div role="tabpanel" id={`evals-panel-${tab}`} aria-labelledby={`evals-tab-${tab}`} className="evals-panel">
        {tab === "sets" ? (
          <GoldenSetsView
            workflows={workflows}
            workflowNames={workflowNames}
            activeProjectId={activeProjectId}
            canEdit={canEdit}
            isAdmin={role === "admin"}
            onJobStarted={onJobStarted}
            {...(currentWorkflowId ? { currentWorkflowId } : {})}
            {...(onOpenRun ? { onOpenRun } : {})}
          />
        ) : tab === "gates" ? (
          <ReleaseGatePanel
            workflows={workflows}
            activeProjectId={activeProjectId}
            canEdit={canEdit}
            isAdmin={role === "admin"}
            {...(currentWorkflowId ? { initialWorkflowId: currentWorkflowId } : {})}
          />
        ) : (
          <ReplayJobsView
            key={jobsVersion}
            workflowNames={workflowNames}
            activeProjectId={activeProjectId}
            canEdit={canEdit}
            openJobId={openJobId}
            onOpenJob={setOpenJobId}
          />
        )}
      </div>
    </section>
  );
}

// --- golden sets ------------------------------------------------------------------

interface GoldenSetsViewProps {
  workflows: WorkflowListItem[];
  workflowNames: Map<string, string>;
  activeProjectId?: string;
  canEdit: boolean;
  isAdmin: boolean;
  onJobStarted: (run: EvalRunView) => void;
  currentWorkflowId?: string;
  onOpenRun?: (executionId: string) => void;
}

function GoldenSetsView({ workflows, workflowNames, activeProjectId, canEdit, isAdmin, onJobStarted, currentWorkflowId, onOpenRun }: GoldenSetsViewProps) {
  const [sets, setSets] = useState<EvalDataset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSetId, setOpenSetId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchEvalDatasets(activeProjectId);
      setSets(response.datasets.filter((dataset) => Boolean(dataset.workflowId)));
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load golden sets"));
      setSets([]);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openSet = sets?.find((set) => set.id === openSetId) ?? null;
  if (openSet) {
    return (
      <GoldenSetDetail
        set={openSet}
        workflowName={workflowNames.get(openSet.workflowId ?? "") ?? openSet.workflowId ?? "—"}
        canEdit={canEdit}
        onBack={() => setOpenSetId(null)}
        onChanged={() => void refresh()}
        onDeleted={() => {
          setOpenSetId(null);
          void refresh();
        }}
        onJobStarted={onJobStarted}
      />
    );
  }

  return (
    <div className="evals-stack">
      <div className="evals-toolbar">
        <span className="pg-eyebrow">Golden sets{sets ? ` · ${sets.length}` : ""}</span>
        {canEdit && !creating && (
          <button type="button" className="pg-btn small" onClick={() => setCreating(true)}>
            + New golden set
          </button>
        )}
      </div>
      {creating && (
        <CreateGoldenSetForm
          workflows={workflows}
          onCancel={() => setCreating(false)}
          onCreated={(dataset) => {
            setCreating(false);
            void refresh().then(() => setOpenSetId(dataset.id));
          }}
        />
      )}
      {error && <div className="error-banner">{error}</div>}
      {!sets ? (
        <div className="page-hint">Loading golden sets…</div>
      ) : sets.length === 0 ? (
        <div className="page-empty">
          {canEdit
            ? "No golden sets yet. Save a run as a golden run from the Runs page, then create a set here and add it."
            : "No golden sets yet. A builder saves golden runs from the Runs page and groups them into sets here."}
        </div>
      ) : (
        <ul className="evals-list" aria-label="Golden sets">
          {sets.map((set) => (
            <li key={set.id}>
              <button type="button" className="evals-row evals-set-row" onClick={() => setOpenSetId(set.id)}>
                <span className="evals-row-main">
                  <span className="evals-row-title">{set.name}</span>
                  {set.description && <span className="evals-row-sub">{set.description}</span>}
                </span>
                <span className="evals-row-cell">
                  <span className="evals-cell-label">Workflow</span>
                  {workflowNames.get(set.workflowId ?? "") ?? <span className="mono-cell">{set.workflowId}</span>}
                </span>
                <span className="evals-row-cell">
                  <span className="evals-cell-label">Golden runs</span>
                  <span className="pg-count">{set.goldenRunCount}</span>
                </span>
                <span className="evals-row-cell">
                  <span className="evals-cell-label">Created</span>
                  {formatDate(set.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <CaptureInbox
        workflows={workflows}
        activeProjectId={activeProjectId}
        canEdit={canEdit}
        isAdmin={isAdmin}
        onPromoted={() => void refresh()}
        {...(currentWorkflowId ? { initialWorkflowId: currentWorkflowId } : {})}
        {...(onOpenRun ? { onOpenRun } : {})}
      />
    </div>
  );
}

function CreateGoldenSetForm({ workflows, onCancel, onCreated }: { workflows: WorkflowListItem[]; onCancel: () => void; onCreated: (dataset: EvalDataset) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return setError("Give the set a name.");
    if (!workflowId) return setError("Pick the workflow whose golden runs the set holds.");
    setBusy(true);
    setError(null);
    try {
      const response = await createEvalDataset({ name: name.trim(), workflowId, ...(description.trim() ? { description: description.trim() } : {}) });
      onCreated(response.dataset);
    } catch (err) {
      setError(errorText(err, "Could not create the golden set"));
      setBusy(false);
    }
  };

  return (
    <form
      className="pg-card evals-form"
      aria-label="New golden set"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="evals-form-grid">
        <label>
          <span>Name</span>
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Refund regressions" autoFocus />
        </label>
        <label>
          <span>Workflow</span>
          <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
            {workflows.length === 0 && <option value="">No workflows in this project</option>}
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        <span>Description (optional)</span>
        <input value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="What a pass here proves" />
      </label>
      {error && <div className="error-banner">{error}</div>}
      <div className="golden-actions">
        <button type="button" className="pg-btn small ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-btn small" disabled={busy}>
          {busy ? "Creating…" : "Create set"}
        </button>
      </div>
    </form>
  );
}

interface GoldenSetDetailProps {
  set: EvalDataset;
  workflowName: string;
  canEdit: boolean;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onJobStarted: (run: EvalRunView) => void;
}

function GoldenSetDetail({ set, workflowName, canEdit, onBack, onChanged, onDeleted, onJobStarted }: GoldenSetDetailProps) {
  const [fixtures, setFixtures] = useState<EvalFixture[] | null>(null);
  const [recordings, setRecordings] = useState<ReplayRecordingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [fixtureResponse, recordingResponse] = await Promise.all([
        fetchEvalFixtures(set.id),
        set.workflowId ? fetchReplayRecordings({ workflowId: set.workflowId, limit: 200 }) : Promise.resolve({ items: [], total: 0 })
      ]);
      setFixtures(fixtureResponse.fixtures);
      setRecordings(recordingResponse.items);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load the golden set"));
      setFixtures((current) => current ?? []);
      setRecordings((current) => current ?? []);
    }
  }, [set.id, set.workflowId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const inSet = useMemo(() => new Set((fixtures ?? []).map((fixture) => fixture.recordingId).filter((id): id is string => Boolean(id))), [fixtures]);
  const goldenCases = (fixtures ?? []).filter((fixture) => fixture.recordingId);

  const add = async (recording: ReplayRecordingSummary) => {
    setBusyId(recording.id);
    setError(null);
    try {
      await addGoldenRunToSet(set.id, { recordingId: recording.id, name: recording.name });
      await refresh();
      onChanged();
    } catch (err) {
      setError(errorText(err, "Could not add the golden run"));
    } finally {
      setBusyId(null);
    }
  };

  const removeCase = async (fixture: EvalFixture) => {
    if (!window.confirm(`Remove "${fixture.name}" from this set? The golden run itself is kept.`)) return;
    setBusyId(fixture.id);
    try {
      await deleteEvalFixture(fixture.id);
      await refresh();
      onChanged();
    } catch (err) {
      setError(errorText(err, "Could not remove the case"));
    } finally {
      setBusyId(null);
    }
  };

  const removeSet = async () => {
    if (!window.confirm(`Delete the golden set "${set.name}" and its replay jobs? Its golden runs are kept.`)) return;
    try {
      await deleteEvalDataset(set.id);
      onDeleted();
    } catch (err) {
      setError(errorText(err, "Could not delete the golden set"));
    }
  };

  return (
    <div className="evals-stack">
      <div className="evals-detail-head">
        <button type="button" className="pg-btn small ghost" onClick={onBack}>
          ← Golden sets
        </button>
        <div className="evals-detail-title">
          <h3 className="pg-card-title">{set.name}</h3>
          <p className="golden-meta">
            <span>{workflowName}</span>
            <span className="mono-cell">{set.id}</span>
            <span>created {formatDate(set.createdAt)}</span>
          </p>
          {set.description && <p className="golden-note">{set.description}</p>}
        </div>
        {canEdit && (
          <div className="evals-detail-actions">
            <button type="button" className="pg-btn small ghost danger" onClick={() => void removeSet()}>
              Delete set
            </button>
            <button type="button" className="pg-btn primary evals-primary" onClick={() => setReplayOpen(true)} disabled={goldenCases.length === 0}>
              Run replay
            </button>
          </div>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}

      <section className="pg-card evals-card" aria-label="Cases">
        <span className="pg-eyebrow">Cases{fixtures ? ` · ${fixtures.length}` : ""}</span>
        {!fixtures ? (
          <div className="page-hint">Loading cases…</div>
        ) : fixtures.length === 0 ? (
          <div className="page-empty compact">
            {canEdit ? "No cases yet. Add one of this workflow's golden runs below." : "No cases yet. A builder adds this workflow's golden runs here."}
          </div>
        ) : (
          <ul className="evals-list">
            {fixtures.map((fixture) => (
              <li key={fixture.id} className="evals-row evals-case-item">
                <span className="evals-row-main">
                  <span className="evals-row-title">
                    {fixture.recordingId && (
                      <span className="golden-title-icon" aria-hidden="true">
                        <GoldenStarIcon />
                      </span>
                    )}
                    {fixture.name}
                  </span>
                  <span className="evals-row-sub">
                    {fixture.recordingId ? (
                      <>
                        golden run <span className="mono-cell">{fixture.recordingId}</span>
                      </>
                    ) : (
                      "hand-written fixture (skipped by replay jobs)"
                    )}
                  </span>
                </span>
                <span className="evals-row-cell evals-chip-cell">
                  <span className="evals-cell-label">Own scorers</span>
                  {fixture.scorers && fixture.scorers.length > 0 ? (
                    fixture.scorers.map((scorer, index) => (
                      <span key={`${scorer.type}-${index}`} className="pg-pill mono-pill">
                        {describeScorer(scorer)}
                      </span>
                    ))
                  ) : (
                    <span className="evals-muted">job scorers</span>
                  )}
                </span>
                {canEdit && (
                  <span className="evals-row-actions">
                    <button
                      type="button"
                      className="pg-btn small ghost danger"
                      aria-label={`Remove ${fixture.name}`}
                      disabled={busyId === fixture.id}
                      onClick={() => void removeCase(fixture)}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit && (
        <section className="pg-card evals-card" aria-label="Add golden runs">
          <span className="pg-eyebrow">Golden runs of {workflowName}</span>
          {!recordings ? (
            <div className="page-hint">Loading golden runs…</div>
          ) : recordings.length === 0 ? (
            <div className="page-empty compact">No golden runs for this workflow yet. Save a run as a golden run from the Runs page, then add it here.</div>
          ) : (
            <ul className="evals-list">
              {recordings.map((recording) => {
                const added = inSet.has(recording.id);
                return (
                  <li key={recording.id} className="evals-row evals-recording-item">
                    <span className="evals-row-main">
                      <span className="evals-row-title">{recording.name}</span>
                      <span className="evals-row-sub">
                        <span className="mono-cell">{recording.id}</span> · {recording.sourceStatus} · {formatDate(recording.createdAt)}
                        {recording.capabilities?.origin === "imported" && (
                          <>
                            {" · "}
                            <span className="golden-origin-badge">imported</span>
                            {recording.capabilities.capture?.maskingVerified === false ? " (masking not verified)" : null}
                          </>
                        )}
                      </span>
                    </span>
                    <span className="evals-row-actions">
                      <button
                        type="button"
                        className="pg-btn small"
                        disabled={added || busyId === recording.id}
                        aria-label={added ? `${recording.name} is in the set` : `Add ${recording.name}`}
                        onClick={() => void add(recording)}
                      >
                        {added ? "In set" : busyId === recording.id ? "Adding…" : "Add"}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {replayOpen && set.workflowId && (
        <RunReplayDialog
          set={set}
          workflowId={set.workflowId}
          caseCount={goldenCases.length}
          onClose={() => setReplayOpen(false)}
          onStarted={(run) => {
            setReplayOpen(false);
            onJobStarted(run);
          }}
        />
      )}
    </div>
  );
}

// --- run replay dialog ---------------------------------------------------------------

interface RunReplayDialogProps {
  set: EvalDataset;
  workflowId: string;
  caseCount: number;
  onClose: () => void;
  onStarted: (run: EvalRunView) => void;
}

export function RunReplayDialog({ set, workflowId, caseCount, onClose, onStarted }: RunReplayDialogProps) {
  const [form, setForm] = useState<ReplayJobForm>(() => emptyReplayJobForm());
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [providers, setProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Phase 15.3 — the job is estimated before it can start; any change to the form asks for a new estimate.
  const [estimate, setEstimate] = useState<ReplayJobEstimate | null>(null);
  const dialogRef = useOverlayFocus<HTMLDivElement>();
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    fetchWorkflowVersions(workflowId)
      .then((response) => !cancelled && setVersions(response.versions))
      .catch(() => {
        // Saved versions are optional; the draft is always a candidate.
      });
    fetchSecrets({ ...(set.projectId ? { projectId: set.projectId } : {}) })
      .then((items) => !cancelled && setSecrets(items))
      .catch(() => {
        // Without the secret list the judge uses the server's own credentials.
      });
    fetchDefinitions()
      .then((definitions) => {
        if (cancelled) return;
        const list = (definitions.providers as Array<{ id?: unknown; label?: unknown }>)
          .filter((provider) => typeof provider.id === "string")
          .map((provider) => ({ id: String(provider.id), label: typeof provider.label === "string" ? provider.label : String(provider.id) }));
        setProviders(list);
      })
      .catch(() => {
        // The provider can still be left to the server default.
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, set.projectId]);

  const update = (patch: Partial<ReplayJobForm>) => {
    setEstimate(null);
    setForm((current) => ({ ...current, ...patch }));
  };
  const updateScorers = (patch: Partial<ReplayJobForm["scorers"]>) => {
    setEstimate(null);
    setForm((current) => ({ ...current, scorers: { ...current.scorers, ...patch } }));
  };
  const scorers = form.scorers;

  const submit = async () => {
    const built = buildReplayJobRequest([set.id], form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    if (!estimate) {
      try {
        setEstimate(await estimateReplayJob(built.request));
      } catch (err) {
        setError(errorText(err, "The replay job could not be estimated"));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const response = await startReplayJob(built.request);
      onStarted(response.run);
    } catch (err) {
      setError(errorText(err, "The replay job could not start"));
      setBusy(false);
    }
  };
  const runs = estimate ? estimate.cases * estimate.runsPerCase : 0;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="pg-modal evals-replay-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evals-replay-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="pg-modal-header">
          <div>
            <h3 id="evals-replay-title" className="pg-modal-title">
              Run replay
            </h3>
            <p className="golden-meta">
              <span>{set.name}</span>
              <span>
                {caseCount} golden run{caseCount === 1 ? "" : "s"}
              </span>
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        <form
          className="pg-modal-body evals-replay-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <ReplayCandidateFields workflowId={workflowId} projectId={set.projectId} versions={versions} form={form} update={update} secrets={secrets} />
          <div className="evals-form-grid">
            <label title="Strict answers each recorded MCP call once. Lenient reuses the last answer when the candidate repeats a call more often than recorded. Neither reaches a live server.">
              <span>MCP calls</span>
              <select value={form.mcpMode} onChange={(event) => update({ mcpMode: event.target.value as ReplayMcpMode })}>
                <option value="strict">Strict</option>
                <option value="lenient">Lenient: reuse repeats</option>
              </select>
            </label>
            <label>
              <span>Number tolerance</span>
              <input inputMode="decimal" value={form.numberTolerance} onChange={(event) => update({ numberTolerance: event.target.value })} placeholder="0" />
            </label>
            <label>
              <span>Max cost (USD)</span>
              <input inputMode="decimal" value={form.maxCostUsd} onChange={(event) => update({ maxCostUsd: event.target.value })} placeholder="Server default" />
            </label>
          </div>
          <label>
            <span>Ignore paths (one per line)</span>
            <textarea
              className="mono-input"
              rows={3}
              value={form.ignorePaths}
              onChange={(event) => update({ ignorePaths: event.target.value })}
              placeholder={"answer.generatedAt\nitems.*.id"}
            />
          </label>

          <fieldset className="evals-scorers">
            <legend>Scorers</legend>
            <p className="golden-note">
              Leave every scorer off to use the server default: <span className="mono-cell">status</span> and <span className="mono-cell">json_equal</span> against
              the golden run. A case's own scorers run first.
            </p>
            <ScorerToggle label="status" hint="The run ends with the golden run's status" checked={scorers.status} onChange={(status) => updateScorers({ status })} />
            <ScorerToggle
              label="json_equal"
              hint="Output equals the golden run's, minus the ignore paths and within the number tolerance"
              checked={scorers.jsonEqual}
              onChange={(jsonEqual) => updateScorers({ jsonEqual })}
            />
            <ScorerToggle
              label="text_similarity"
              hint="Output text is close to the golden run's"
              checked={scorers.textSimilarity.enabled}
              onChange={(enabled) => updateScorers({ textSimilarity: { ...scorers.textSimilarity, enabled } })}
            >
              <label>
                <span>Threshold (0–1)</span>
                <input
                  inputMode="decimal"
                  value={scorers.textSimilarity.threshold}
                  onChange={(event) => updateScorers({ textSimilarity: { ...scorers.textSimilarity, threshold: event.target.value } })}
                />
              </label>
            </ScorerToggle>
            <ScorerToggle
              label="tool_sequence"
              hint="MCP tool calls match the golden run's"
              checked={scorers.toolSequence.enabled}
              onChange={(enabled) => updateScorers({ toolSequence: { ...scorers.toolSequence, enabled } })}
            >
              <label>
                <span>Mode</span>
                <select
                  value={scorers.toolSequence.mode}
                  onChange={(event) => updateScorers({ toolSequence: { ...scorers.toolSequence, mode: event.target.value as ToolSequenceMode } })}
                >
                  {(Object.keys(TOOL_SEQUENCE_MODE_LABELS) as ToolSequenceMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {TOOL_SEQUENCE_MODE_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </label>
            </ScorerToggle>
            <ScorerToggle
              label="no_new_guard_blocks"
              hint="Guard blocks nothing the golden run let through"
              checked={scorers.noNewGuardBlocks}
              onChange={(noNewGuardBlocks) => updateScorers({ noNewGuardBlocks })}
            />
            <ScorerToggle
              label="budget"
              hint="Cost, tokens and latency stay under limits"
              checked={scorers.budget.enabled}
              onChange={(enabled) => updateScorers({ budget: { ...scorers.budget, enabled } })}
            >
              <label>
                <span>Max cost (USD)</span>
                <input inputMode="decimal" value={scorers.budget.maxCostUsd} onChange={(event) => updateScorers({ budget: { ...scorers.budget, maxCostUsd: event.target.value } })} />
              </label>
              <label>
                <span>Max tokens</span>
                <input inputMode="numeric" value={scorers.budget.maxTokens} onChange={(event) => updateScorers({ budget: { ...scorers.budget, maxTokens: event.target.value } })} />
              </label>
              <label>
                <span>Max latency (ms)</span>
                <input inputMode="numeric" value={scorers.budget.maxLatencyMs} onChange={(event) => updateScorers({ budget: { ...scorers.budget, maxLatencyMs: event.target.value } })} />
              </label>
            </ScorerToggle>
            <ScorerToggle
              label="llm_judge"
              hint="A model grades the output against a rubric"
              checked={scorers.llmJudge.enabled}
              onChange={(enabled) => updateScorers({ llmJudge: { ...scorers.llmJudge, enabled } })}
            >
              <label className="evals-span-all">
                <span>Rubric</span>
                <textarea
                  rows={3}
                  value={scorers.llmJudge.rubric}
                  maxLength={4000}
                  onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, rubric: event.target.value } })}
                  placeholder="The answer approves a refund only when the order is under 30 days old."
                />
              </label>
              <label>
                <span>Mode</span>
                <select value={scorers.llmJudge.mode} onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, mode: event.target.value as "absolute" | "pairwise" } })}>
                  <option value="absolute">Absolute: grade the replay</option>
                  <option value="pairwise">Pairwise: compare with the golden run</option>
                </select>
              </label>
              <label>
                <span>Votes</span>
                <input inputMode="numeric" value={scorers.llmJudge.votes} onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, votes: event.target.value } })} />
              </label>
              <label>
                <span>Provider</span>
                <select value={scorers.llmJudge.providerId} onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, providerId: event.target.value } })}>
                  <option value="">Server default</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Model</span>
                <input value={scorers.llmJudge.model} onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, model: event.target.value } })} placeholder="Server default" />
              </label>
              <label className="evals-span-all">
                <span>Credentials (secret)</span>
                <select value={scorers.llmJudge.secretId} onChange={(event) => updateScorers({ llmJudge: { ...scorers.llmJudge, secretId: event.target.value } })}>
                  <option value="">Server credentials</option>
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name} · {secret.provider}
                    </option>
                  ))}
                </select>
              </label>
            </ScorerToggle>
          </fieldset>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          {estimate && <ReplayEstimatePanel estimate={estimate} />}
          <div className="golden-actions evals-sticky-actions">
            <button type="button" className="pg-btn small ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="pg-btn primary evals-primary" disabled={busy}>
              {estimate
                ? busy
                  ? "Starting…"
                  : `Start ${runs} run${runs === 1 ? "" : "s"}`
                : busy
                  ? "Estimating…"
                  : `Estimate ${caseCount} case${caseCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ScorerToggle({ label, hint, checked, onChange, children }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void; children?: ReactNode }) {
  return (
    <div className={`evals-scorer${checked ? " is-on" : ""}`}>
      <label className="evals-scorer-toggle">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="evals-scorer-name">{label}</span>
        <span className="evals-scorer-hint">{hint}</span>
      </label>
      {checked && children && <div className="evals-scorer-options">{children}</div>}
    </div>
  );
}

// --- replay jobs -----------------------------------------------------------------------

interface ReplayJobsViewProps {
  workflowNames: Map<string, string>;
  activeProjectId?: string;
  canEdit: boolean;
  openJobId: string | null;
  onOpenJob: (id: string | null) => void;
}

const JOB_LIST_POLL_MS = 3000;

function ReplayJobsView({ workflowNames, activeProjectId, canEdit, openJobId, onOpenJob }: ReplayJobsViewProps) {
  const [jobs, setJobs] = useState<EvalRunView[] | null>(null);
  const [setNames, setSetNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [jobResponse, setResponse] = await Promise.all([fetchReplayJobs({ limit: 100 }), fetchEvalDatasets(activeProjectId).catch(() => ({ datasets: [] as EvalDataset[] }))]);
      setSetNames(new Map(setResponse.datasets.map((dataset) => [dataset.id, dataset.name])));
      // The workflow list is the active project's: show that project's jobs.
      setJobs(workflowNames.size > 0 ? jobResponse.runs.filter((run) => workflowNames.has(run.workflowId)) : jobResponse.runs);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load replay jobs"));
      setJobs((current) => current ?? []);
    }
  }, [activeProjectId, workflowNames]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const anyActive = (jobs ?? []).some(isEvalRunActive);
  useEffect(() => {
    if (!anyActive || openJobId) return;
    const timer = setInterval(() => void refresh(), JOB_LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, openJobId, refresh]);

  if (openJobId) {
    return (
      <ReplayJobDetailView
        jobId={openJobId}
        workflowNames={workflowNames}
        setNames={setNames}
        canEdit={canEdit}
        onBack={() => {
          onOpenJob(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="evals-stack">
      <div className="evals-toolbar">
        <span className="pg-eyebrow">Replay jobs{jobs ? ` · ${jobs.length}` : ""}</span>
        <button type="button" className="pg-btn small ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!jobs ? (
        <div className="page-hint">Loading replay jobs…</div>
      ) : jobs.length === 0 ? (
        <div className="page-empty">No replay jobs yet. Open a golden set and choose Run replay to score a change against its golden runs.</div>
      ) : (
        <ul className="evals-list" aria-label="Replay jobs">
          {jobs.map((job) => {
            const counts = jobCounts(job);
            return (
              <li key={job.id}>
                <button type="button" className="evals-row evals-job-row" onClick={() => onOpenJob(job.id)} aria-label={`Replay job ${job.id}`}>
                  <span className="evals-row-cell evals-job-status">
                    <StatusChip status={job.status} />
                  </span>
                  <span className="evals-row-main">
                    <span className="evals-row-title">{job.datasetIds.map((id) => setNames.get(id) ?? id).join(", ")}</span>
                    <span className="evals-row-sub">{job.workflowName ?? workflowNames.get(job.workflowId) ?? job.workflowId}</span>
                  </span>
                  <span className="evals-row-cell">
                    <span className="evals-cell-label">Candidate</span>
                    <span className="evals-candidate">
                      <span className="evals-candidate-kind">{candidateLabel(job.candidate)}</span>
                      {job.candidate && <span className="mono-cell">{shortHash(job.candidate.workflowHash)}</span>}
                    </span>
                  </span>
                  <span className="evals-row-cell">
                    <span className="evals-cell-label">Cases</span>
                    <CountChips counts={counts} />
                  </span>
                  <span className="evals-row-cell">
                    <span className="evals-cell-label">Spent</span>
                    <span className="mono-cell" title={counts.costUnknown ? "Some calls are unpriced: at least this much" : undefined}>
                      {formatSpend(counts)}
                    </span>
                  </span>
                  <span className="evals-row-cell">
                    <span className="evals-cell-label">Started</span>
                    <span className="evals-row-main">
                      <span>{formatDate(job.startedAt)}</span>
                      {job.triggeredBy && <span className="evals-row-sub">by {job.triggeredBy}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function CountChips({ counts }: { counts: ReturnType<typeof jobCounts> }) {
  return (
    <span className="evals-counts">
      <span className="evals-count is-pass" title="passed">
        {counts.pass} pass
      </span>
      <span className={`evals-count${counts.fail > 0 ? " is-fail" : ""}`} title="failed (regressions)">
        {counts.fail} fail
      </span>
      {counts.error > 0 && (
        <span className="evals-count is-error" title="inconclusive">
          {counts.error} error
        </span>
      )}
      {counts.skipped > 0 && (
        <span className="evals-count" title="skipped">
          {counts.skipped} skipped
        </span>
      )}
    </span>
  );
}

interface ReplayJobDetailViewProps {
  jobId: string;
  workflowNames: Map<string, string>;
  setNames: Map<string, string>;
  canEdit: boolean;
  onBack: () => void;
}

function ReplayJobDetailView({ jobId, workflowNames, setNames, canEdit, onBack }: ReplayJobDetailViewProps) {
  const [job, setJob] = useState<ReplayJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const lastDone = useRef<number>(-1);

  const load = useCallback(async () => {
    try {
      const response = await fetchReplayJob(jobId);
      setJob(response.run);
      setError(null);
      return response.run;
    } catch (err) {
      setError(errorText(err, "Could not load the replay job"));
      return null;
    }
  }, [jobId]);

  const active = job ? isEvalRunActive(job) : false;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const unsubscribe = subscribeEvalRun(jobId, (event) => {
      setJob((current) => (current ? { ...current, ...event.run, results: current.results } : current));
      const done = event.run.progress?.done ?? -1;
      // New finished cases: fetch the job again for their rows.
      if (event.type === "done" || done !== lastDone.current) {
        lastDone.current = done;
        void load();
      }
    });
    return unsubscribe;
  }, [active, jobId, load]);

  const cancel = async () => {
    if (!job || !window.confirm("Cancel this replay job? Cases already scored are kept.")) return;
    setCanceling(true);
    try {
      const response = await cancelReplayJob(job.id);
      setJob((current) => (current ? { ...current, ...response.run, results: current.results } : current));
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) void load();
      setError(errorText(err, "Could not cancel the job"));
    } finally {
      setCanceling(false);
    }
  };

  if (!job) {
    return (
      <div className="evals-stack">
        <div>
          <button type="button" className="pg-btn small ghost" onClick={onBack}>
            ← Replay jobs
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : <div className="page-hint">Loading replay job…</div>}
      </div>
    );
  }

  const counts = jobCounts(job);
  const budget = job.options?.maxCostUsd ?? null;
  const pct = counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0;

  return (
    <div className="evals-stack">
      <div className="evals-detail-head">
        <button type="button" className="pg-btn small ghost" onClick={onBack}>
          ← Replay jobs
        </button>
        <div className="evals-detail-title">
          <h3 className="pg-card-title">
            {job.datasetIds.map((id) => setNames.get(id) ?? id).join(", ")} <StatusChip status={job.status} />
          </h3>
          <p className="golden-meta">
            <span>{job.workflowName ?? workflowNames.get(job.workflowId) ?? job.workflowId}</span>
            <span>
              against <strong className="evals-candidate-kind">{candidateLabel(job.candidate)}</strong>{" "}
              {job.candidate && <span className="mono-cell">{shortHash(job.candidate.workflowHash, 12)}</span>}
            </span>
            {job.options && <span>MCP {job.options.mcpMode}</span>}
            {job.options && <span>{comparisonLabel(job.options)}</span>}
            <span className="mono-cell">{job.id}</span>
            <span>
              started {formatDate(job.startedAt)}
              {job.triggeredBy ? ` by ${job.triggeredBy}` : ""}
            </span>
          </p>
        </div>
        {canEdit && active && (
          <div className="evals-detail-actions">
            <button type="button" className="pg-btn small danger" onClick={() => void cancel()} disabled={canceling}>
              {canceling ? "Canceling…" : "Cancel job"}
            </button>
          </div>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {overrideLines(job.candidate).length > 0 && (
        <section className="pg-card evals-card" aria-label="Candidate overrides">
          <span className="pg-eyebrow">Candidate overrides</span>
          <ul className="replay-override-list">
            {overrideLines(job.candidate).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      {releaseProofLine(job.candidate) && (
        <section className="pg-card evals-card" aria-label="Release proof">
          <span className="pg-eyebrow">Release proof</span>
          <p className={`golden-note${releaseProofLine(job.candidate)!.eligible ? "" : " is-warn"}`}>{releaseProofLine(job.candidate)!.text}</p>
          {releaseProofLine(job.candidate)!.reasons.length > 0 && (
            <ul className="replay-override-list">
              {releaseProofLine(job.candidate)!.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          {job.candidate?.guardProfile && (
            <p className="golden-meta">
              <span>
                Guard profile {job.candidate.guardProfile.profileId} v{job.candidate.guardProfile.version}
              </span>
              <span className="mono-cell">{shortHash(job.candidate.guardProfile.hash, 12)}</span>
            </p>
          )}
        </section>
      )}
      {job.error && <div className="golden-note is-warn">{job.error}</div>}
      {jobWarnings(job).map((warning) => (
        <div key={warning} className="golden-note is-warn" role="status">
          {warning}
        </div>
      ))}

      <section className="pg-card evals-card evals-progress-card" aria-label="Progress">
        <div className="evals-progress-head">
          <span>
            <strong>{counts.done}</strong> of {counts.total} case{counts.total === 1 ? "" : "s"} done
            {counts.running > 0 ? ` · ${counts.running} running` : ""}
          </span>
          <span className="mono-cell">
            spent {formatSpend(counts)}
            {budget !== null ? ` of ${formatUsd(budget)}` : ""}
            {job.summary?.replayedModelCalls
              ? ` · ${job.summary.replayedModelCalls} model call${job.summary.replayedModelCalls === 1 ? "" : "s"} from the tape (recorded cost ${formatUsd(job.summary.recordedCostUsd ?? 0)}, not spent)`
              : ""}
          </span>
        </div>
        <div
          className={`evals-progress${active ? " is-active" : ""}`}
          role="progressbar"
          aria-label="Cases done"
          aria-valuemin={0}
          aria-valuemax={counts.total}
          aria-valuenow={counts.done}
        >
          <span className="evals-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <CountChips counts={counts} />
      </section>

      <section className="pg-card evals-card" aria-label="Cases">
        <span className="pg-eyebrow">Cases · {job.results.length}</span>
        {job.results.length === 0 ? (
          <div className="page-empty compact">{active ? "Cases appear here as they finish." : "This job scored no cases."}</div>
        ) : (
          <>
            <div className="evals-case-head" aria-hidden="true">
              <span>Case</span>
              <span>Status</span>
              <span>Scorers</span>
              <span className="num">Cost</span>
              <span className="num">Duration</span>
            </div>
            <ul className="evals-list evals-case-list">
              {job.results.map((result) => (
                <li key={result.id}>
                  <CaseRow result={result} onOpen={() => setOpenCaseId(result.id)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {openCaseId && <CaseDrawer runId={job.id} resultId={openCaseId} onClose={() => setOpenCaseId(null)} />}
    </div>
  );
}

function CaseRow({ result, onOpen }: { result: EvalCaseResult; onOpen: () => void }) {
  const name = result.fixtureName ?? result.fixtureId;
  return (
    <button type="button" className="evals-row evals-case-row" onClick={onOpen} aria-label={`Open case ${name}`}>
      <span className="evals-row-main">
        <span className="evals-row-title">{name}</span>
        {result.error && <span className="evals-row-sub evals-case-error">{result.error}</span>}
        {result.repeats && (
          <span className="evals-row-sub">
            {result.repeats.pass} of {result.repeats.total} repeats passed{result.repeats.flaky ? " · flaky" : ""}
          </span>
        )}
      </span>
      <span className="evals-row-cell">
        <StatusChip status={result.status} label={caseStatusLabel(result.status)} />
      </span>
      <span className="evals-row-cell evals-chip-cell">
        {result.score?.details.map((detail, index) => <ScorerChip key={`${detail.type}-${index}`} detail={detail} />) ?? <span className="evals-muted">—</span>}
      </span>
      <span className="evals-row-cell num">
        <span className="evals-cell-label">Cost</span>
        <span className="mono-cell">{formatUsd(result.costUsd)}</span>
      </span>
      <span className="evals-row-cell num">
        <span className="evals-cell-label">Duration</span>
        <span className="mono-cell">{formatDuration(result.durationMs)}</span>
      </span>
    </button>
  );
}

export function CaseDrawer({ runId, resultId, onClose }: { runId: string; resultId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<EvalCaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drawerRef = useOverlayFocus<HTMLElement>();
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    fetchReplayJobCase(runId, resultId)
      .then((response) => !cancelled && setDetail(response.result))
      .catch((err: unknown) => !cancelled && setError(errorText(err, "Could not load the case")));
    return () => {
      cancelled = true;
    };
  }, [runId, resultId]);

  return (
    <div className="evals-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={drawerRef}
        tabIndex={-1}
        className="evals-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evals-case-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="evals-drawer-head">
          <div>
            <h3 id="evals-case-title" className="pg-modal-title">
              {detail?.fixtureName ?? "Case"}
            </h3>
            {detail && (
              <p className="golden-meta">
                <StatusChip status={detail.status} label={caseStatusLabel(detail.status)} />
                {detail.recordingId && (
                  <span>
                    golden run <span className="mono-cell">{detail.recordingId}</span>
                  </span>
                )}
                <span className="mono-cell">{formatUsd(detail.costUsd)}</span>
                <span className="mono-cell">{formatDuration(detail.durationMs)}</span>
              </p>
            )}
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close case">
            Close
          </button>
        </header>
        <div className="evals-drawer-body">
          {error && <div className="error-banner">{error}</div>}
          {!detail && !error && <div className="page-hint">Loading case…</div>}
          {detail && (
            <>
              {detail.score && detail.score.details.length > 0 && (
                <div className="golden-section">
                  <span className="pg-eyebrow">Scores</span>
                  <ul className="evals-score-list">
                    {detail.score.details.map((score, index) => (
                      <li key={`${score.type}-${index}`} className={score.pass ? "is-pass" : "is-fail"}>
                        <span className="evals-score-top">
                          <ScorerChip detail={score} />
                          {score.path && <span className="mono-cell">{score.path}</span>}
                          {typeof score.costUsd === "number" && <span className="mono-cell">{formatUsd(score.costUsd)}</span>}
                        </span>
                        <span className="evals-score-reason">{score.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.replay?.attempts && detail.replay.attempts.length > 0 && (
                <div className="golden-section">
                  <span className="pg-eyebrow">
                    Repeats{detail.replay.compare === "baseline_rerun" ? " · each against its own baseline rerun" : ""}
                  </span>
                  <ul className="evals-score-list">
                    {detail.replay.attempts.map((attempt) => (
                      <li key={attempt.repeatIndex} className={attempt.status === "pass" ? "is-pass" : "is-fail"}>
                        <span className="evals-score-top">
                          <span>Repeat {attempt.repeatIndex + 1}</span>
                          <StatusChip status={attempt.status} label={caseStatusLabel(attempt.status)} />
                          {attempt.executionId && <span className="mono-cell">{attempt.executionId}</span>}
                          {attempt.baselineExecutionId && <span className="mono-cell">baseline {attempt.baselineExecutionId}</span>}
                          <span className="mono-cell">{formatUsd(attempt.costUsd)}</span>
                        </span>
                        {attempt.reasons.length > 0 && <span className="evals-score-reason">{attempt.reasons.join(" ")}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.replay ? (
                <ReplayResultView result={detail.replay} />
              ) : detail.replayTruncated ? (
                <div className="golden-note is-warn" role="status">
                  The run diff was {detail.replayTruncated.bytes.toLocaleString()} bytes, over the {detail.replayTruncated.maxBytes.toLocaleString()}-byte limit for a stored case, so only its size was kept. The scores above were computed on the full diff and output.
                </div>
              ) : (
                <div className="golden-note is-warn" role="status">
                  {detail.error ?? (detail.status === "skipped" ? "This case was not replayed." : "No replay diff is stored for this case.")}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
