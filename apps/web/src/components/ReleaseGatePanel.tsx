/**
 * Phase 15.4 — Evaluations → Release gates: one workflow's gate settings
 * (golden sets, policy, approvers, enforcement) and its release history,
 * with rollback to a version published before.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RELEASE_APPROVER_ROLE_CHOICES, type WorkflowListItem } from "@ai-orchestrator/shared";
import {
  ApiError,
  fetchEvalDatasets,
  fetchReleaseGate,
  fetchReleases,
  rollbackWorkflowRelease,
  saveReleaseGate,
  type EvalDataset,
  type ReleaseGateView,
  type WorkflowReleasesView
} from "../lib/api";
import { gateFormFrom, gateLocks, gateSettingsFromForm, releaseVerdictLabel, releaseVerdictTone, type GateForm } from "../lib/release";

/** Only roles that can hold workflow:publish can approve a release. */
const APPROVER_ROLES = RELEASE_APPROVER_ROLE_CHOICES;

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface ReleaseGatePanelProps {
  workflows: WorkflowListItem[];
  activeProjectId?: string;
  canEdit: boolean;
  isAdmin: boolean;
  /** The workflow to open first (the one in the editor). */
  initialWorkflowId?: string;
}

export function ReleaseGatePanel({ workflows, activeProjectId, canEdit, isAdmin, initialWorkflowId }: ReleaseGatePanelProps) {
  const [workflowId, setWorkflowId] = useState<string>(() =>
    initialWorkflowId && workflows.some((workflow) => workflow.id === initialWorkflowId) ? initialWorkflowId : (workflows[0]?.id ?? "")
  );
  useEffect(() => {
    if (!workflowId && workflows[0]) setWorkflowId(workflows[0].id);
  }, [workflowId, workflows]);

  if (workflows.length === 0) return <div className="evals-empty">No workflows in this project yet.</div>;

  return (
    <div className="release-panel">
      <div className="cfg-field release-workflow-pick">
        <label className="cfg-label" htmlFor="release-gate-workflow">
          Workflow
        </label>
        <select id="release-gate-workflow" className="cfg-input" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
      </div>
      {workflowId && <WorkflowReleaseView key={workflowId} workflowId={workflowId} activeProjectId={activeProjectId} canEdit={canEdit} isAdmin={isAdmin} />}
    </div>
  );
}

function WorkflowReleaseView({ workflowId, activeProjectId, canEdit, isAdmin }: { workflowId: string; activeProjectId?: string; canEdit: boolean; isAdmin: boolean }) {
  const [gate, setGate] = useState<ReleaseGateView | null>(null);
  const [form, setForm] = useState<GateForm | null>(null);
  const [sets, setSets] = useState<EvalDataset[]>([]);
  const [history, setHistory] = useState<WorkflowReleasesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [gateResponse, setsResponse, releasesResponse] = await Promise.all([
        fetchReleaseGate(workflowId),
        fetchEvalDatasets(activeProjectId, { workflowId }),
        fetchReleases(workflowId)
      ]);
      setGate(gateResponse.gate);
      setForm(gateFormFrom(gateResponse.gate));
      setSets(setsResponse.datasets.filter((dataset) => dataset.workflowId === workflowId));
      setHistory(releasesResponse);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load the release gate"));
    }
  }, [activeProjectId, workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  // On an enforced gate a builder may only tighten it; the server checks it too.
  const locks = gate ? gateLocks(gate, isAdmin) : { adminOnly: !isAdmin, selfApproval: !isAdmin };
  const locked = !canEdit || locks.adminOnly;

  const save = async () => {
    if (!form || !gate) return;
    const { settings, errors } = gateSettingsFromForm(form, gate);
    setFormErrors(errors);
    setNotice(null);
    if (errors.length > 0) return;
    setSaving(true);
    try {
      const response = await saveReleaseGate(workflowId, settings as never);
      setGate(response.gate);
      setForm(gateFormFrom(response.gate));
      setNotice("Gate saved.");
    } catch (err) {
      setFormErrors([errorText(err, "Could not save the gate")]);
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="approvals-error" role="alert">
        {error}
      </div>
    );
  }
  if (!gate || !form || !history) return <div className="evals-empty">Loading…</div>;

  const update = (patch: Partial<GateForm>) => setForm((current) => (current ? { ...current, ...patch } : current));

  return (
    <div className="release-grid">
      <section className="release-card" aria-labelledby="release-gate-title">
        <header className="release-card-head">
          <h3 id="release-gate-title">Release gate</h3>
          {gate.enforced && <span className="release-tag is-warn">Enforced by an admin</span>}
        </header>
        <p className="settings-help">
          With the gate on, a version reaches production only after a completed replay job of that exact version passes over these golden sets, under the policy in force when you publish.
        </p>
        {locks.adminOnly && canEdit && (
          <p className="settings-help">An admin enforces this gate: you can tighten its policy and add golden sets; everything else is the admin's.</p>
        )}
        <fieldset className="release-fieldset" disabled={!canEdit || saving}>
          <label className="guard-check">
            <input type="checkbox" checked={form.enabled} disabled={locked && form.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
            <span>Gate publishing on replay jobs</span>
          </label>

          <div className="cfg-field">
            <span className="cfg-label">Golden sets</span>
            {sets.length === 0 ? (
              <div className="cfg-help">This workflow has no golden sets yet. Save golden runs and group them under Golden sets.</div>
            ) : (
              <div className="release-sets">
                {sets.map((set) => (
                  <label key={set.id} className="guard-check">
                    <input
                      type="checkbox"
                      checked={form.datasetIds.includes(set.id)}
                      disabled={locked && gate.datasetIds.includes(set.id)}
                      onChange={(event) =>
                        update({ datasetIds: event.target.checked ? [...form.datasetIds, set.id] : form.datasetIds.filter((id) => id !== set.id) })
                      }
                    />
                    <span>
                      {set.name} <span className="cfg-help">({set.goldenRunCount} golden runs)</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="release-policy">
            <NumberField id="gate-pass-rate" label="Minimum pass rate (%)" value={form.minPassRatePct} onChange={(value) => update({ minPassRatePct: value })} />
            <NumberField id="gate-regressions" label="Maximum regressions" value={form.maxRegressions} onChange={(value) => update({ maxRegressions: value })} />
            <NumberField id="gate-min-cases" label="Minimum cases" value={form.minCases} onChange={(value) => update({ minCases: value })} />
            <NumberField id="gate-cost" label="Max cost increase (%)" placeholder="no limit" value={form.maxCostIncreasePct} onChange={(value) => update({ maxCostIncreasePct: value })} />
            <NumberField id="gate-latency" label="Max p95 latency increase (%)" placeholder="no limit" value={form.maxP95LatencyIncreasePct} onChange={(value) => update({ maxP95LatencyIncreasePct: value })} />
            <NumberField id="gate-age" label="Oldest golden run (days)" value={form.maxRecordingAgeDays} onChange={(value) => update({ maxRecordingAgeDays: value })} />
          </div>
          <div className="cfg-field">
            <label className="cfg-label" htmlFor="gate-mcp-mode">
              MCP answers in the job
            </label>
            <select id="gate-mcp-mode" className="cfg-input" value={form.mcpMode} disabled={locked} onChange={(event) => update({ mcpMode: event.target.value === "lenient" ? "lenient" : "strict" })}>
              <option value="strict">Strict: every call must match a recorded one</option>
              <option value="lenient">Lenient: unmatched calls fail the call, not the job</option>
            </select>
          </div>
          <label className="guard-check">
            <input type="checkbox" checked={form.noNewGuardBlocks} disabled={locked && gate.policy.noNewGuardBlocks} onChange={(event) => update({ noNewGuardBlocks: event.target.checked })} />
            <span>Block a version that adds guard blocks</span>
          </label>
          <label className="guard-check">
            <input type="checkbox" checked={form.errorsCountAsFailures} disabled={locked && gate.policy.errorsCountAsFailures} onChange={(event) => update({ errorsCountAsFailures: event.target.checked })} />
            <span>Errored cases count as failures</span>
          </label>

          <div className="cfg-field">
            <span className="cfg-label">Approvers</span>
            <div className="gate-roles">
              {APPROVER_ROLES.map((role) => (
                <label key={role} className="guard-check">
                  <input
                    type="checkbox"
                    checked={form.approverRoles.includes(role)}
                    disabled={locked}
                    onChange={(event) =>
                      update({ approverRoles: event.target.checked ? [...form.approverRoles, role] : form.approverRoles.filter((entry) => entry !== role) })
                    }
                  />
                  <span>{role}</span>
                </label>
              ))}
            </div>
            <input
              className="cfg-input"
              aria-label="Approver emails"
              placeholder="Approver emails, comma separated"
              value={form.approverUsers}
              disabled={locked}
              onChange={(event) => update({ approverUsers: event.target.value })}
            />
            <div className="cfg-help">Approvers also need permission to publish this workflow. A blocked publish can be sent to them with a reason.</div>
          </div>
          <label className="guard-check">
            <input type="checkbox" checked={form.requireApproval} disabled={locked && gate.requireApproval} onChange={(event) => update({ requireApproval: event.target.checked })} />
            <span>Every publish needs an approver, even when the gate passes</span>
          </label>
          <label className="guard-check">
            <input
              type="checkbox"
              checked={form.allowSelfApproval}
              disabled={locked || (locks.selfApproval && !form.allowSelfApproval)}
              onChange={(event) => update({ allowSelfApproval: event.target.checked })}
            />
            <span>The requester or the version's author may approve their own release{locks.selfApproval ? " (admins only)" : ""}</span>
          </label>
          {isAdmin && (
            <label className="guard-check">
              <input type="checkbox" checked={form.enforced} onChange={(event) => update({ enforced: event.target.checked })} />
              <span>Enforce: only admins can turn this gate off or loosen it</span>
            </label>
          )}
        </fieldset>
        {formErrors.length > 0 && (
          <ul className="approvals-error release-form-errors" role="alert">
            {formErrors.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        )}
        {notice && (
          <div className="approvals-notice" role="status">
            {notice}
          </div>
        )}
        {canEdit && (
          <div className="release-actions">
            <button type="button" className="pg-btn primary" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save gate"}
            </button>
          </div>
        )}
      </section>

      <ReleaseHistory workflowId={workflowId} history={history} canRollback={canEdit && !locks.adminOnly} onChanged={() => void load()} />
    </div>
  );
}

function NumberField({ id, label, value, placeholder, onChange }: { id: string; label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  return (
    <div className="cfg-field">
      <label className="cfg-label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="cfg-input" type="number" min={0} inputMode="numeric" placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function ReleaseHistory({ workflowId, history, canRollback, onChanged }: { workflowId: string; history: WorkflowReleasesView; canRollback: boolean; onChanged: () => void }) {
  const [target, setTarget] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rollback is offered once per version, on its newest release.
  const newestOfVersion = useMemo(() => {
    const seen = new Set<number>();
    const ids = new Set<string>();
    for (const release of history.releases) {
      if (seen.has(release.version)) continue;
      seen.add(release.version);
      ids.add(release.id);
    }
    return ids;
  }, [history.releases]);

  const rollback = async () => {
    if (target === null || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await rollbackWorkflowRelease(workflowId, { version: target, reason: reason.trim() });
      setTarget(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(errorText(err, "Rollback failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="release-card" aria-labelledby="release-history-title">
      <header className="release-card-head">
        <h3 id="release-history-title">Releases</h3>
        <span className="release-tag">{history.publishedVersion === null ? "Not published: production runs the latest save" : `v${history.publishedVersion} live`}</span>
      </header>
      {history.releases.length === 0 ? (
        <div className="evals-empty">No version was published yet.</div>
      ) : (
        <ol className="release-history">
          {history.releases.map((release) => (
            <li key={release.id} className={release.version === history.publishedVersion ? "is-live" : undefined}>
              <div className="release-history-head">
                <strong>v{release.version}</strong>
                <span className={`release-tag is-${releaseVerdictTone(release.verdict)}`}>{releaseVerdictLabel(release.verdict)}</span>
                <span className="cfg-help">
                  {release.publishedBy ?? "unknown"} · {formatWhen(release.publishedAt)}
                  {release.previousVersion !== null ? ` · from v${release.previousVersion}` : ""}
                </span>
              </div>
              {release.reason && <div className="release-history-reason">“{release.reason}”</div>}
              {release.approval && <div className="cfg-help">Asked by {release.approval.requestedBy ?? "unknown"}, approved by {release.approval.decidedBy ?? "unknown"}</div>}
              {release.replayRunId && (
                <div className="cfg-help">
                  Replay job <code>{release.replayRunId}</code>
                </div>
              )}
              {canRollback && release.version !== history.publishedVersion && newestOfVersion.has(release.id) && (
                <button
                  type="button"
                  className="pg-btn small ghost"
                  onClick={() => {
                    setTarget(release.version);
                    setError(null);
                  }}
                >
                  Roll back to v{release.version}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      {target !== null && (
        <div className="cfg-field release-rollback">
          <label className="cfg-label" htmlFor="release-rollback-reason">
            Why roll back to v{target}?
          </label>
          <textarea id="release-rollback-reason" className="cfg-input" rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="release-actions">
            <button type="button" className="pg-btn small ghost" onClick={() => setTarget(null)}>
              Cancel
            </button>
            <button type="button" className="pg-btn small danger" disabled={busy || !reason.trim()} onClick={() => void rollback()}>
              {busy ? "Rolling back…" : `Roll back to v${target}`}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="approvals-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
