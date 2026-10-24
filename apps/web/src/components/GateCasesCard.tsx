/**
 * Release gate admission — Evaluations → Release gates, enforced gates only:
 * which cases the gate counts. Cases added after the gate was enforced wait
 * for admission: they run with every gate job but do not count yet. Admins
 * admit or reject them and mark cases required; builders ask the gate's
 * approvers in the approvals inbox. Nothing shows for an unenforced gate.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  admitGateCases,
  fetchReleaseGateCases,
  rejectGateCases,
  requestGateCases,
  setGateCaseRequired,
  type ReleaseGateCasesView,
  type ReleaseGateCaseView
} from "../lib/api";
import { gateAdmissionBanner } from "../lib/release";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

interface GateCasesCardProps {
  workflowId: string;
  /** Changes when the gate is saved, so the cases reload. */
  gateVersion: string | null;
}

type Asking = { action: "admit" | "remove"; fixtureIds: string[] } | null;

export function GateCasesCard({ workflowId, gateVersion }: GateCasesCardProps) {
  const [view, setView] = useState<ReleaseGateCasesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetchReleaseGateCases(workflowId);
      setView(response.cases);
      setError(null);
    } catch (err) {
      setError(errorText(err, "Could not load the gate's cases"));
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load, gateVersion]);

  const run = async (key: string, work: () => Promise<{ cases: ReleaseGateCasesView } | unknown>, done: string): Promise<boolean> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const response = await work();
      if (response && typeof response === "object" && "cases" in response) setView((response as { cases: ReleaseGateCasesView }).cases);
      else await load();
      setNotice(done);
      return true;
    } catch (err) {
      setError(errorText(err, "That did not work"));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (error && !view) {
    return (
      <div className="approvals-error" role="alert">
        {error}
      </div>
    );
  }
  if (!view || !view.enforced) return null;

  const pending = view.cases.filter((entry) => entry.admission === "pending");
  const admitted = view.cases.filter((entry) => entry.admission === "admitted");
  const askable = pending.filter((entry) => !entry.requestId).map((entry) => entry.fixtureId);
  const banner = gateAdmissionBanner(view.counts.pending);

  const submitRequest = async () => {
    if (!asking || !reason.trim()) return;
    const what = asking;
    const sent = await run(
      "request",
      () => requestGateCases(workflowId, { action: what.action, fixtureIds: what.fixtureIds, reason: reason.trim() }),
      what.action === "admit" ? "Sent to the gate's approvers in the approvals inbox." : "Removal request sent to the gate's approvers."
    );
    if (!sent) return;
    setAsking(null);
    setReason("");
  };

  const reject = async (entry: ReleaseGateCaseView) => {
    if (!window.confirm(`Reject "${entry.name}"? It leaves its golden set; the golden run itself is kept.`)) return;
    await run(`reject-${entry.fixtureId}`, () => rejectGateCases(workflowId, [entry.fixtureId]), `"${entry.name}" was rejected.`);
  };

  return (
    <section className="release-card gate-cases-card" aria-labelledby="gate-cases-title">
      <header className="release-card-head">
        <h3 id="gate-cases-title">Cases this gate counts</h3>
        <span className="release-tag">
          {view.counts.admitted} admitted · {view.counts.required} required
        </span>
      </header>
      {banner && (
        <div className="gate-admission-banner" role="status">
          <span>{banner}</span>
          {view.canAdmit && pending.length > 1 && (
            <button type="button" className="pg-btn small" disabled={busy !== null} onClick={() => void run("admit-all", () => admitGateCases(workflowId, pending.map((entry) => entry.fixtureId)), "Every waiting case now counts.")}>
              Admit all
            </button>
          )}
          {view.canRequest && askable.length > 0 && (
            <button type="button" className="pg-btn small" disabled={busy !== null} onClick={() => setAsking({ action: "admit", fixtureIds: askable })}>
              Request admission
            </button>
          )}
        </div>
      )}
      {view.cases.length === 0 ? (
        <div className="evals-empty">The gate's golden sets hold no cases yet.</div>
      ) : (
        <ul className="gate-cases">
          {[...pending, ...admitted].map((entry) => (
            <li key={entry.fixtureId} className={entry.admission === "pending" ? "is-pending" : undefined}>
              <span className="gate-case-main">
                <span className="gate-case-name">{entry.name}</span>
                <span className="cfg-help">{entry.datasetName ?? entry.datasetId}</span>
              </span>
              <span className="gate-case-chips">
                {entry.admission === "pending" && <span className="release-tag is-warn">waiting for admission</span>}
                {entry.required && <span className="release-tag is-ok gate-required-chip">required</span>}
                {entry.requestId && <span className="release-tag">{entry.requestKind === "remove_cases" ? "removal requested" : "admission requested"}</span>}
              </span>
              <span className="gate-case-actions">
                {view.canAdmit && entry.admission === "pending" && (
                  <>
                    <button
                      type="button"
                      className="pg-btn small"
                      aria-label={`Admit ${entry.name}`}
                      disabled={busy !== null}
                      onClick={() => void run(`admit-${entry.fixtureId}`, () => admitGateCases(workflowId, [entry.fixtureId]), `"${entry.name}" now counts.`)}
                    >
                      Admit
                    </button>
                    <button type="button" className="pg-btn small ghost danger" aria-label={`Reject ${entry.name}`} disabled={busy !== null} onClick={() => void reject(entry)}>
                      Reject
                    </button>
                  </>
                )}
                {view.canAdmit && entry.recordingId && (
                  <label className="guard-check gate-required-toggle">
                    <input
                      type="checkbox"
                      checked={entry.required}
                      disabled={busy !== null}
                      aria-label={`${entry.name} is required`}
                      onChange={(event) => {
                        const required = event.target.checked;
                        void run(
                          `required-${entry.fixtureId}`,
                          () => setGateCaseRequired(workflowId, entry.fixtureId, required),
                          required ? `"${entry.name}" must pass on every publish.` : `"${entry.name}" is no longer required.`
                        );
                      }}
                    />
                    <span>Required</span>
                  </label>
                )}
                {view.canRequest && entry.admission === "admitted" && !entry.requestId && (
                  <button
                    type="button"
                    className="pg-btn small ghost"
                    aria-label={`Request removal of ${entry.name}`}
                    disabled={busy !== null}
                    onClick={() => setAsking({ action: "remove", fixtureIds: [entry.fixtureId] })}
                  >
                    Request removal
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <div className="cfg-field release-rollback">
          <label className="cfg-label" htmlFor="gate-case-request-reason">
            {asking.action === "admit"
              ? `Why should ${asking.fixtureIds.length === 1 ? "this case" : `these ${asking.fixtureIds.length} cases`} count?`
              : "Why should this case stop counting?"}
          </label>
          <textarea id="gate-case-request-reason" className="cfg-input" rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className="release-actions">
            <button
              type="button"
              className="pg-btn small ghost"
              onClick={() => {
                setAsking(null);
                setReason("");
              }}
            >
              Cancel
            </button>
            <button type="button" className="pg-btn small primary" disabled={busy !== null || !reason.trim()} onClick={() => void submitRequest()}>
              {busy === "request" ? "Sending…" : "Send to approvers"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="approvals-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="approvals-notice" role="status">
          {notice}
        </div>
      )}
    </section>
  );
}
