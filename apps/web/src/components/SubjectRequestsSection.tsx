/**
 * 13.3 — Settings > Data protection > Data-subject requests: make an export request for one person, follow the lookup,
 * and download the export once. The person's value is sent once and never shown again.
 */
import { useCallback, useEffect, useState } from "react";
import { SUBJECT_ROW_KIND_LABELS, type SubjectKind, type SubjectRequestView, type SubjectRowKind } from "@ai-orchestrator/shared";
import { ApiError, createSubjectRequest, downloadSubjectExport, fetchSubjectRequests } from "../lib/api";

const POLL_MS = 3_000;

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABELS: Record<SubjectRequestView["status"], string> = {
  searching: "Searching",
  ready: "Ready to download",
  done: "Downloaded",
  expired: "Expired",
  failed: "Failed"
};

function describeFound(request: SubjectRequestView): string {
  const entries = Object.entries(request.counts).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return request.status === "searching" ? "—" : "Nothing found";
  const text = entries.map(([kind, n]) => `${SUBJECT_ROW_KIND_LABELS[kind as SubjectRowKind] ?? kind}: ${(n ?? 0).toLocaleString()}`).join(", ");
  return request.truncated ? `${text} (limit reached)` : text;
}

function describeProgress(request: SubjectRequestView): string {
  if (request.status !== "searching") return STATUS_LABELS[request.status];
  const { phase, kindsDone, kindsTotal, rowsSearched } = request.progress;
  if (phase === "references") return "Searching: following subject references";
  if (phase === "scan") return `Searching: ${kindsDone} of ${kindsTotal} kinds of data, ${rowsSearched.toLocaleString()} rows read`;
  return "Searching: preparing the export";
}

export function SubjectRequestsSection() {
  const [requests, setRequests] = useState<SubjectRequestView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [subjectKind, setSubjectKind] = useState<SubjectKind>("end_user");
  const [scan, setScan] = useState(true);
  const [revealTokens, setRevealTokens] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchSubjectRequests();
      setRequests(result.requests);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const searching = requests?.some((request) => request.status === "searching") ?? false;
  useEffect(() => {
    if (!searching) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [searching, load]);

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await createSubjectRequest({ type: "export", subjectKind, value, scan, revealTokens });
      setValue("");
      setRevealTokens(false);
      await load();
    } catch (err) {
      setFormError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async (id: string) => {
    setDownloading(id);
    setError(null);
    try {
      const file = await downloadSubjectExport(id);
      const href = URL.createObjectURL(file.blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = file.fileName;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setDownloading(null);
      await load();
    }
  };

  return (
    <section className="settings-section" aria-label="Data-subject requests">
      <h3>Data-subject requests</h3>
      <p className="settings-muted">
        Export what this deployment holds about one person: the runs and agent memory their subject references point at
        and, when the search is on, any stored run, approval or paused run that contains the value. The value is used for
        the lookup and then dropped; it is never shown, logged or audited. Each export downloads once and then expires.
      </p>
      <form
        className="subject-request-form"
        aria-label="New data-subject request"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) void submit();
        }}
      >
        <div className="cfg-field">
          <label className="cfg-label" htmlFor="subject-value">
            {subjectKind === "staff" ? "Staff member's email" : "The person's email, customer id or phone number"}
          </label>
          <input
            id="subject-value"
            className="cfg-input"
            type="text"
            autoComplete="off"
            value={value}
            maxLength={320}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <fieldset className="cfg-field">
          <legend className="cfg-label">Who</legend>
          <label className="guard-check">
            <input type="radio" name="subject-kind" checked={subjectKind === "end_user"} onChange={() => setSubjectKind("end_user")} />
            <span>Someone whose data flows through runs</span>
          </label>
          <label className="guard-check">
            <input type="radio" name="subject-kind" checked={subjectKind === "staff"} onChange={() => setSubjectKind("staff")} />
            <span>A staff member (their account, sign-ins and what they authored)</span>
          </label>
        </fieldset>
        <label className="guard-check">
          <input type="checkbox" checked={scan} onChange={(event) => setScan(event.target.checked)} />
          <span>Also search stored data for the value (slower; finds runs of workflows without subject references)</span>
        </label>
        <label className="guard-check">
          <input type="checkbox" checked={revealTokens} onChange={(event) => setRevealTokens(event.target.checked)} />
          <span>Replace reversible tokens with their original values (may ask for a recent MFA check)</span>
        </label>
        {formError && <div className="settings-error">{formError}</div>}
        <button type="submit" className="pg-btn small" disabled={busy || !value.trim()}>
          {busy ? "Starting…" : "Start export"}
        </button>
      </form>

      {error && <div className="settings-error">{error}</div>}
      {!requests && !error && <div className="settings-loading">Loading…</div>}
      {requests && requests.length === 0 && <p className="settings-muted">No requests yet.</p>}
      {requests && requests.length > 0 && (
        <table className="settings-table" aria-label="Data-subject requests">
          <thead>
            <tr>
              <th>Made</th>
              <th>Status</th>
              <th>Found</th>
              <th>Due</th>
              <th>Export</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id} data-testid={`subject-request-${request.id}`}>
                <td>
                  {formatDate(request.createdAt)}
                  <div className="settings-muted">
                    {request.subjectKind === "staff" ? "Staff" : "End user"}
                    {request.createdBy ? ` · by ${request.createdBy}` : ""}
                  </div>
                </td>
                <td>
                  {describeProgress(request)}
                  {request.error && <div className="settings-error">{request.error}</div>}
                </td>
                <td>{describeFound(request)}</td>
                <td>
                  {formatDate(request.dueAt)}
                  {request.overdue && request.status !== "done" && <div className="settings-error">Overdue</div>}
                </td>
                <td>
                  {request.export?.available ? (
                    <>
                      <button type="button" className="pg-btn small" disabled={downloading === request.id} onClick={() => void download(request.id)}>
                        {downloading === request.id ? "Downloading…" : `Download (${formatBytes(request.export.bytes)})`}
                      </button>
                      <div className="settings-muted">Once only; expires {formatDate(request.export.expiresAt)}</div>
                    </>
                  ) : request.export?.downloadedAt ? (
                    `Downloaded ${formatDate(request.export.downloadedAt)}${request.export.downloadedBy ? ` by ${request.export.downloadedBy}` : ""}`
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
