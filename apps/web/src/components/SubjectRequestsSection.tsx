/**
 * 13.3 — Settings > Data protection > Data-subject requests: make an export or deletion request for one person, follow
 * the lookup, download the export once, or confirm the deletion after its preview. The person's value is sent once and
 * never shown again.
 */
import { useCallback, useEffect, useState } from "react";
import {
  SUBJECT_ROW_KIND_LABELS,
  type SubjectKind,
  type SubjectRequestType,
  type SubjectRequestView,
  type SubjectRowKind
} from "@ai-orchestrator/shared";
import { ApiError, confirmSubjectDeletion, createSubjectRequest, downloadSubjectExport, fetchSubjectRequests } from "../lib/api";

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
  running: "Deleting",
  deferred_by_hold: "Partly deleted: waiting for a legal hold",
  done: "Downloaded",
  expired: "Expired",
  failed: "Failed"
};

function statusLabel(request: SubjectRequestView): string {
  if (request.type === "delete" && request.status === "ready") return "Preview ready: confirm to delete";
  if (request.type === "delete" && request.status === "done") return "Deleted";
  if (request.type === "delete" && request.status === "expired") return "Not confirmed in time";
  return STATUS_LABELS[request.status];
}

function countsText(counts: Partial<Record<SubjectRowKind, number>>): string {
  return Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([kind, n]) => `${SUBJECT_ROW_KIND_LABELS[kind as SubjectRowKind] ?? kind}: ${(n ?? 0).toLocaleString()}`)
    .join(", ");
}

function describeFound(request: SubjectRequestView): string {
  if (request.staffPreview) {
    const p = request.staffPreview;
    if (!p.userFound && p.runsTriggered + p.workflowsCreated + p.approvals + p.evalRuns + p.releasesPublished === 0) return "No account or authored rows found";
    return [
      p.userFound ? "Account found" : "No account",
      `runs started: ${p.runsTriggered}`,
      `workflows: ${p.workflowsCreated}`,
      `approvals: ${p.approvals}`,
      `evaluation runs: ${p.evalRuns}`,
      `releases: ${p.releasesPublished}`,
      `audit-log rows kept: ${p.auditEntries}`
    ].join(", ");
  }
  const entries = Object.entries(request.counts).filter(([, n]) => (n ?? 0) > 0);
  if (entries.length === 0) return request.status === "searching" ? "—" : "Nothing found";
  const text = entries.map(([kind, n]) => `${SUBJECT_ROW_KIND_LABELS[kind as SubjectRowKind] ?? kind}: ${(n ?? 0).toLocaleString()}`).join(", ");
  return request.truncated ? `${text} (limit reached)` : text;
}

function describeDeletion(request: SubjectRequestView): string | null {
  const deletion = request.deletion;
  if (!deletion || !deletion.confirmedAt) return null;
  const parts: string[] = [];
  const deleted = countsText(deletion.deleted);
  if (deleted) parts.push(`Deleted: ${deleted}`);
  if (deletion.usageRowsCleared > 0) parts.push(`${deletion.usageRowsCleared} usage row(s) kept with the person cleared`);
  if (deletion.vaultTokensDeleted > 0) parts.push(`${deletion.vaultTokensDeleted} reversible token(s) deleted`);
  if (deletion.deferred > 0) parts.push(`${deletion.deferred} row(s) kept by a legal hold until it is released`);
  if (deletion.staff) {
    parts.push(
      `Email replaced with ${deletion.staff.pseudonym} in ${deletion.staff.rowsPseudonymised} row(s)${deletion.staff.userDeleted ? ", account deleted" : ""}`
    );
  }
  return parts.length > 0 ? parts.join(" · ") : "Nothing to delete";
}

function describeProgress(request: SubjectRequestView): string {
  if (request.status !== "searching") return statusLabel(request);
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
  const [type, setType] = useState<SubjectRequestType>("export");
  const [confirming, setConfirming] = useState<string | null>(null);

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

  const searching = requests?.some((request) => request.status === "searching" || request.status === "running") ?? false;
  useEffect(() => {
    if (!searching) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [searching, load]);

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      await createSubjectRequest(type === "delete" ? { type, subjectKind, value, scan } : { type, subjectKind, value, scan, revealTokens });
      setValue("");
      setRevealTokens(false);
      await load();
    } catch (err) {
      setFormError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeletion = async (id: string) => {
    if (!window.confirm("Delete this person's data now? This cannot be undone.")) return;
    setConfirming(id);
    setError(null);
    try {
      await confirmSubjectDeletion(id);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setConfirming(null);
      await load();
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
        Export or delete what this deployment holds about one person: the runs and agent memory their subject references
        point at and, when the search is on, any stored run, approval or paused run that contains the value. The value is
        never shown, logged or audited. Each export downloads once and then expires. A deletion shows what it found first
        and runs only once you confirm it; rows under a legal hold wait until the hold is released.
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
          <legend className="cfg-label">Request</legend>
          <label className="guard-check">
            <input type="radio" name="subject-type" checked={type === "export"} onChange={() => setType("export")} />
            <span>Export (access)</span>
          </label>
          <label className="guard-check">
            <input type="radio" name="subject-type" checked={type === "delete"} onChange={() => setType("delete")} />
            <span>Delete (erasure): find first, then confirm</span>
          </label>
        </fieldset>
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
        {type === "export" && (
          <label className="guard-check">
            <input type="checkbox" checked={revealTokens} onChange={(event) => setRevealTokens(event.target.checked)} />
            <span>Replace reversible tokens with their original values (may ask for a recent MFA check)</span>
          </label>
        )}
        {type === "delete" && subjectKind === "staff" && (
          <p className="settings-muted">
            Their email is replaced with a pseudonym wherever it records who started, wrote or decided something, and
            their account is deleted. Their audit-log rows are kept for security logging. Only an admin can confirm it.
          </p>
        )}
        {formError && <div className="settings-error">{formError}</div>}
        <button type="submit" className="pg-btn small" disabled={busy || !value.trim()}>
          {busy ? "Starting…" : type === "delete" ? "Find what to delete" : "Start export"}
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
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request.id} data-testid={`subject-request-${request.id}`}>
                <td>
                  {formatDate(request.createdAt)}
                  <div className="settings-muted">
                    {request.type === "delete" ? "Deletion · " : ""}
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
                  {request.type === "delete" ? (
                    request.status === "ready" ? (
                      <button
                        type="button"
                        className="pg-btn small danger"
                        disabled={confirming === request.id}
                        onClick={() => void confirmDeletion(request.id)}
                      >
                        {confirming === request.id ? "Confirming…" : "Confirm deletion"}
                      </button>
                    ) : (
                      describeDeletion(request) ?? "—"
                    )
                  ) : request.export?.available ? (
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
