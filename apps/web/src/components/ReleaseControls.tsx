/**
 * Phase 15.4 — the editor's version pill and Publish dialog.
 *
 * The pill shows what production runs (the published version) and how far
 * the draft is ahead of it. The dialog picks a saved version, shows the
 * verdict its release gate gives now, and publishes it bound to the hash
 * that was judged: through a passing replay job, by sending it to the
 * gate's approvers, or (admins only) by an override with a reason. It also
 * offers Unpublish: production then runs the draft again.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  fetchPublishPreview,
  fetchReleaseState,
  fetchWorkflowVersions,
  publishWorkflowVersion,
  type PublishResult,
  type ReleasePublishPreview,
  type ReleaseStateView,
  type WorkflowVersionSummary
} from "../lib/api";
import { gateStatsLines, releasePillLabel, releaseVerdictLabel } from "../lib/release";
import { UnpublishControl } from "./UnpublishControl";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export interface ReleasePillProps {
  workflowId: string;
  /** Changes after a save, so the pill reloads the draft version. */
  refreshKey?: number | string;
  /** Used until the release state loads; then the server's answer (project roles included) decides. */
  canPublish: boolean;
  isAdmin: boolean;
  /** Opens the workflow's gate settings (Evaluations → Release gates). */
  onOpenGates?: () => void;
}

export function ReleasePill({ workflowId, refreshKey, canPublish, isAdmin, onOpenGates }: ReleasePillProps) {
  const [state, setState] = useState<ReleaseStateView | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetchReleaseState(workflowId);
      setState(response.state);
      setUnavailable(false);
    } catch (err) {
      setState(null);
      // A store without releases (501), or a workflow this user cannot read: no pill.
      setUnavailable(err instanceof ApiError && (err.status === 501 || err.status === 404 || err.status === 403));
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (unavailable) return null;
  const label = releasePillLabel(state);

  return (
    <>
      <button
        type="button"
        className={`hud-pill hud-btn hud-release-pill is-${label.tone}`}
        title={label.title}
        aria-label={`Release: ${label.text}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="hud-dot" aria-hidden="true" />
        <span className="hud-run-label">{label.text}</span>
        {state?.productionRefused && (
          <span className="hud-release-gate is-refused" title="The gate is on but no version is published: production refuses runs until one is">
            production off
          </span>
        )}
        {state?.gateEnabled && (
          <span className="hud-release-gate" title={state.gateEnforced ? "Release gate on (enforced by an admin)" : "Release gate on"}>
            gate{state.gateEnforced ? " · enforced" : ""}
          </span>
        )}
      </button>
      {open && (
        <PublishDialog
          workflowId={workflowId}
          state={state}
          canPublish={state ? state.canPublish : canPublish}
          isAdmin={isAdmin}
          onClose={() => setOpen(false)}
          onPublished={() => void load()}
          {...(onOpenGates
            ? {
                onOpenGates: () => {
                  setOpen(false);
                  onOpenGates();
                }
              }
            : {})}
        />
      )}
    </>
  );
}

export interface PublishDialogProps {
  workflowId: string;
  state: ReleaseStateView | null;
  canPublish: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onPublished: () => void;
  onOpenGates?: () => void;
}

export function PublishDialog({ workflowId, state, canPublish, isAdmin, onClose, onPublished, onOpenGates }: PublishDialogProps) {
  const [versions, setVersions] = useState<WorkflowVersionSummary[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [preview, setPreview] = useState<ReleasePublishPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [requestReason, setRequestReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unpublishedNotice, setUnpublishedNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWorkflowVersions(workflowId)
      .then((response) => {
        if (cancelled) return;
        const sorted = [...response.versions].sort((a, b) => b.version - a.version);
        setVersions(sorted);
        setVersion(sorted[0]?.version ?? null);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(errorText(err, "Could not load saved versions"));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  useEffect(() => {
    if (version === null) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setResult(null);
    setError(null);
    fetchPublishPreview(workflowId, version)
      .then((response) => {
        if (!cancelled) setPreview(response.preview);
      })
      .catch((err) => {
        if (!cancelled) setPreviewError(errorText(err, "Could not judge this version"));
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, version]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (extra: { override?: { reason: string }; requestApproval?: { reason: string } } = {}) => {
    if (version === null || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await publishWorkflowVersion(workflowId, {
        version,
        workflowHash: preview.workflowHash,
        ...(preview.replayRunId ? { replayRunId: preview.replayRunId } : {}),
        ...extra
      });
      setResult(outcome);
      if (outcome.outcome === "published") onPublished();
    } catch (err) {
      setError(errorText(err, "Publish failed"));
    } finally {
      setBusy(false);
    }
  };

  const alreadyLive = version !== null && state?.publishedVersion === version;
  const stats = gateStatsLines(preview?.stats ?? null);
  const verdict = preview ? (preview.gateEnabled ? preview.verdict : "ungated") : null;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal release-modal" role="dialog" aria-modal="true" aria-labelledby="release-publish-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="release-publish-title" className="pg-modal-title">
              Publish to production
            </h3>
            <p className="settings-help">
              Production webhooks, schedules, app triggers, chat, forms and the MCP gateway run the published version. The editor and /webhook-test/ keep running the draft.
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="pg-modal-body">
          {versions && versions.length === 0 && <div className="release-empty">Save the workflow first: only saved versions can be published.</div>}
          {versions && versions.length > 0 && (
            <div className="cfg-field">
              <label className="cfg-label" htmlFor="release-version">
                Version
              </label>
              <select id="release-version" className="cfg-input" value={version ?? ""} onChange={(event) => setVersion(Number(event.target.value))}>
                {versions.map((entry) => (
                  <option key={entry.version} value={entry.version}>
                    v{entry.version}
                    {entry.version === state?.publishedVersion ? " (live)" : ""}
                    {entry.changeNote ? ` · ${entry.changeNote}` : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {previewError && (
            <div className="approvals-error" role="alert">
              {previewError}
            </div>
          )}
          {!preview && !previewError && versions && versions.length > 0 && <div className="release-empty">Judging v{version}…</div>}

          {preview && verdict && (
            <section className={`release-verdict is-${verdict}`} aria-live="polite">
              <div className="release-verdict-head">
                <span className="release-verdict-badge">
                  {verdict === "ungated" ? "No release gate" : verdict === "passed" ? "Gate passed" : verdict === "needs_approval" ? "Needs an approver" : "Blocked"}
                </span>
                <code title={preview.workflowHash}>{preview.workflowHash.slice(0, 12)}</code>
                {preview.replayRunId && (
                  <span className="release-job">
                    job <code>{preview.replayRunId}</code>
                  </span>
                )}
              </div>
              {stats.length > 0 && <p className="release-stats">{stats.join(" · ")}</p>}
              {preview.reasons.length > 0 && (
                <ul className="release-reasons">
                  {preview.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {verdict === "ungated" && (
                <p className="settings-help">
                  This workflow has no release gate, so any saved version publishes.
                  {onOpenGates && (
                    <>
                      {" "}
                      <button type="button" className="evals-inline-link" onClick={onOpenGates}>
                        Set up a gate
                      </button>
                    </>
                  )}
                </p>
              )}
            </section>
          )}

          {result && (
            <div className={result.outcome === "blocked" ? "approvals-error" : "approvals-notice"} role="status">
              {result.outcome === "published" && `Published v${result.release.version}. Production now runs it.`}
              {result.outcome === "needs_approval" && "Sent to the gate's approvers. It is published when one approves it in Approvals."}
              {result.outcome === "blocked" && `Blocked: ${result.reasons.join("; ")}`}
            </div>
          )}
          {error && (
            <div className="approvals-error" role="alert">
              {error}
            </div>
          )}

          {!canPublish && <p className="settings-help">You can see the verdict, but publishing needs the workflow:publish permission.</p>}

          {canPublish && preview && result?.outcome !== "published" && (
            <div className="release-actions">
              {(verdict === "passed" || verdict === "ungated") && (
                <button type="button" className="pg-btn primary" disabled={busy || alreadyLive} onClick={() => void submit()}>
                  {alreadyLive ? `v${version} is live` : busy ? "Publishing…" : `Publish v${version}`}
                </button>
              )}
              {verdict === "needs_approval" && (
                <button type="button" className="pg-btn primary" disabled={busy || alreadyLive} onClick={() => void submit()}>
                  {busy ? "Sending…" : "Send to approvers"}
                </button>
              )}
              {verdict === "blocked" && preview.canRequestApproval && (
                <div className="cfg-field">
                  <label className="cfg-label" htmlFor="release-request-reason">
                    Ask an approver to ship it anyway
                  </label>
                  <textarea
                    id="release-request-reason"
                    className="cfg-input"
                    rows={2}
                    maxLength={2000}
                    placeholder="Why this version should ship despite the gate"
                    value={requestReason}
                    onChange={(event) => setRequestReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="pg-btn"
                    disabled={busy || !requestReason.trim()}
                    onClick={() => void submit({ requestApproval: { reason: requestReason.trim() } })}
                  >
                    Request approval
                  </button>
                </div>
              )}
              {verdict === "blocked" && isAdmin && (
                <div className="cfg-field release-override">
                  <label className="cfg-label" htmlFor="release-override-reason">
                    Admin override
                  </label>
                  <textarea
                    id="release-override-reason"
                    className="cfg-input"
                    rows={2}
                    maxLength={2000}
                    placeholder="The reason is stored with the release and in the audit log"
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                  />
                  <button
                    type="button"
                    className="pg-btn danger"
                    disabled={busy || !overrideReason.trim()}
                    onClick={() => void submit({ override: { reason: overrideReason.trim() } })}
                  >
                    Override and publish v{version}
                  </button>
                </div>
              )}
            </div>
          )}
          {result?.outcome === "published" && <p className="settings-help">Verdict: {releaseVerdictLabel(result.release.verdict)}</p>}

          {unpublishedNotice && (
            <div className="approvals-notice" role="status">
              Unpublished. {unpublishedNotice}
            </div>
          )}
          {canPublish && state && state.publishedVersion !== null && result?.outcome !== "published" && !unpublishedNotice && (
            <section className="release-unpublish-row" aria-label="Unpublish">
              <p className="settings-help">v{state.publishedVersion} is live. Unpublish it to run the draft in production again.</p>
              <UnpublishControl
                workflowId={workflowId}
                liveVersion={state.publishedVersion}
                gateEnabled={state.gateEnabled}
                gateEnforced={state.gateEnforced}
                onUnpublished={(outcome) => {
                  setUnpublishedNotice(outcome.notice);
                  onPublished();
                }}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
