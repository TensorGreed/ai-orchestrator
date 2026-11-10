/**
 * 13.3 — Settings > Data protection > Legal holds: the holds in place, placing one (a project, a workflow, a list of
 * runs, or the rows the data-subject lookup finds for a value) and releasing one with a reason. Held data is kept
 * from every deletion until the hold is released; who may read it does not change.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { LegalHoldPlaceInput, LegalHoldPlaceableScope, LegalHoldStatus, LegalHoldView } from "@ai-orchestrator/shared";
import { ApiError, fetchLegalHolds, placeLegalHold, releaseLegalHold } from "../lib/api";

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

const SCOPE_LABELS: Record<LegalHoldPlaceableScope, string> = {
  project: "A project",
  workflow: "A workflow",
  runs: "Runs",
  subject: "A data subject"
};

function describeScope(hold: LegalHoldView): string {
  switch (hold.scopeType) {
    case "project":
      return `Project ${hold.scopeId}`;
    case "workflow":
      return `Workflow ${hold.scopeId}`;
    case "runs":
      return `${hold.itemCount} ${hold.itemCount === 1 ? "run" : "runs"}`;
    case "subject":
      return `Data subject: ${hold.itemCount} ${hold.itemCount === 1 ? "row" : "rows"}`;
    default:
      return hold.scopeType;
  }
}

export function LegalHoldsSection() {
  const [status, setStatus] = useState<LegalHoldStatus>("active");
  const [holds, setHolds] = useState<LegalHoldView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [matterRef, setMatterRef] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [scopeType, setScopeType] = useState<LegalHoldPlaceableScope>("project");
  const [scopeId, setScopeId] = useState("");
  const [runIds, setRunIds] = useState("");
  const [subject, setSubject] = useState("");
  const [releasing, setReleasing] = useState<string | null>(null);
  const [releaseReason, setReleaseReason] = useState("");

  const load = useCallback(async () => {
    try {
      setHolds((await fetchLegalHolds(status)).holds);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const place = async (event: FormEvent) => {
    event.preventDefault();
    const payload: LegalHoldPlaceInput = {
      name: name.trim(),
      reason: reason.trim(),
      scopeType,
      ...(matterRef.trim() ? { matterRef: matterRef.trim() } : {}),
      ...(endsAt ? { endsAt: new Date(`${endsAt}T00:00:00Z`).toISOString() } : {}),
      ...(scopeType === "project" || scopeType === "workflow" ? { scopeId: scopeId.trim() } : {}),
      ...(scopeType === "runs" ? { executionIds: runIds.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean) } : {}),
      ...(scopeType === "subject" ? { subject: { value: subject } } : {})
    };
    setBusy(true);
    setNotice(null);
    try {
      const { hold } = await placeLegalHold(payload);
      setNotice(`Placed "${hold.name}": ${describeScope(hold)}.`);
      setName("");
      setReason("");
      setMatterRef("");
      setEndsAt("");
      setScopeId("");
      setRunIds("");
      setSubject("");
      setError(null);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const release = async (hold: LegalHoldView) => {
    if (!releaseReason.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await releaseLegalHold(hold.id, releaseReason.trim());
      setNotice(`Released "${hold.name}". The next purge deletes what was due.`);
      setReleasing(null);
      setReleaseReason("");
      setError(null);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="Legal holds">
      <h3>Legal holds</h3>
      <p className="settings-muted">
        A legal hold keeps data from every deletion: retention purges, deleting a workflow, project, golden run or
        cassette, and data-subject deletes. It stays until someone releases it; the review date is a reminder only.
        Who may read the data does not change.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {notice && (
        <p className="settings-muted" role="status">
          {notice}
        </p>
      )}
      <div className="settings-actions">
        <label htmlFor="lh-status">Show</label>
        <select id="lh-status" value={status} onChange={(event) => setStatus(event.target.value as LegalHoldStatus)}>
          <option value="active">Active</option>
          <option value="released">Released</option>
        </select>
      </div>
      {!holds && !error && <div className="settings-loading">Loading…</div>}
      {holds && holds.length === 0 && <p className="settings-muted">No {status} holds.</p>}
      {holds && holds.length > 0 && (
        <table className="settings-table" aria-label="Holds">
          <thead>
            <tr>
              <th>Hold</th>
              <th>Covers</th>
              <th>Placed</th>
              <th>{status === "active" ? "Review by" : "Released"}</th>
              {status === "active" && <th />}
            </tr>
          </thead>
          <tbody>
            {holds.map((hold) => (
              <tr key={hold.id} data-testid={`legal-hold-${hold.id}`}>
                <td>
                  {hold.name}
                  {hold.matterRef && <div className="settings-muted">Matter {hold.matterRef}</div>}
                  <div className="settings-muted">{hold.status === "active" ? hold.reason : hold.releaseReason}</div>
                </td>
                <td>{describeScope(hold)}</td>
                <td>
                  {formatDate(hold.createdAt)}
                  {hold.createdBy && <div className="settings-muted">{hold.createdBy}</div>}
                </td>
                <td>
                  {hold.status === "active" ? formatDate(hold.endsAt) : formatDate(hold.releasedAt)}
                  {hold.status !== "active" && hold.releasedBy && <div className="settings-muted">{hold.releasedBy}</div>}
                </td>
                {status === "active" && (
                  <td>
                    {releasing === hold.id ? (
                      <div className="settings-actions">
                        <input
                          aria-label="Reason for release"
                          placeholder="Reason for release"
                          value={releaseReason}
                          onChange={(event) => setReleaseReason(event.target.value)}
                        />
                        <button type="button" disabled={busy || !releaseReason.trim()} onClick={() => void release(hold)}>
                          Release
                        </button>
                        <button type="button" onClick={() => setReleasing(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setReleasing(hold.id)}>
                        Release…
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="settings-card" onSubmit={(event) => void place(event)} aria-label="Place a legal hold">
        <h4>Place a hold</h4>
        <label htmlFor="lh-name">Name</label>
        <input id="lh-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} />
        <label htmlFor="lh-reason">Reason</label>
        <input id="lh-reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} />
        <label htmlFor="lh-matter">Matter reference (optional)</label>
        <input id="lh-matter" value={matterRef} onChange={(event) => setMatterRef(event.target.value)} maxLength={200} />
        <label htmlFor="lh-ends">Review by (optional)</label>
        <input id="lh-ends" type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        <label htmlFor="lh-scope">Covers</label>
        <select id="lh-scope" value={scopeType} onChange={(event) => setScopeType(event.target.value as LegalHoldPlaceableScope)}>
          {(Object.keys(SCOPE_LABELS) as LegalHoldPlaceableScope[]).map((value) => (
            <option key={value} value={value}>
              {SCOPE_LABELS[value]}
            </option>
          ))}
        </select>
        {(scopeType === "project" || scopeType === "workflow") && (
          <>
            <label htmlFor="lh-scope-id">{scopeType === "project" ? "Project id" : "Workflow id"}</label>
            <input id="lh-scope-id" value={scopeId} onChange={(event) => setScopeId(event.target.value)} required />
          </>
        )}
        {scopeType === "runs" && (
          <>
            <label htmlFor="lh-runs">Run ids (one per line or comma-separated)</label>
            <textarea id="lh-runs" className="settings-textarea" value={runIds} onChange={(event) => setRunIds(event.target.value)} required rows={3} />
          </>
        )}
        {scopeType === "subject" && (
          <>
            <label htmlFor="lh-subject">Value to look up (an email address, phone number, …)</label>
            <input id="lh-subject" value={subject} onChange={(event) => setSubject(event.target.value)} required autoComplete="off" />
            <p className="settings-muted">The rows the data-subject lookup finds now are held. The value itself is not stored.</p>
          </>
        )}
        <div className="settings-actions">
          <button type="submit" disabled={busy}>
            Place hold
          </button>
        </div>
      </form>
    </section>
  );
}
