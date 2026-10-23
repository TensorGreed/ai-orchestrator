/**
 * Phase 11.2 — Approvals: runs paused on a person, and (Phase 15.4)
 * requests to publish a workflow version past its release gate.
 *
 * Pending lists every request the user can see, with what the run asks,
 * who may decide and when it expires; approvers can edit the gate's fields,
 * add a reason and approve or reject. Decided keeps the history. Opening
 * `?mode=approvals&request=<id>` (the notification link) scrolls to and
 * highlights that request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalEditableField, ApprovalRequestView, ReleaseApprovalRequestView } from "@ai-orchestrator/shared";
import { ApiError, approveApproval, decideReleaseRequest, listApprovals, rejectApproval, type ApprovalInboxItem } from "../lib/api";
import {
  approvalKindLabel,
  approvalStatusLabel,
  approversSummary,
  buildApprovalEdits,
  decisionError,
  decisionOutcome,
  initialFieldDrafts,
  isReleaseInboxItem,
  matchesApprovalFilter,
  matchesFocus,
  relativeTime,
  releaseDecisionOutcome,
  type FieldDrafts
} from "../lib/approvals";

type Tab = "pending" | "decided";

export const APPROVAL_REQUEST_URL_PARAM = "request";

export function readApprovalRequestParam(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get(APPROVAL_REQUEST_URL_PARAM);
  return value && value.trim() ? value.trim() : null;
}

function clearApprovalRequestParam(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (!params.has(APPROVAL_REQUEST_URL_PARAM)) return;
  params.delete(APPROVAL_REQUEST_URL_PARAM);
  const search = params.toString();
  window.history.replaceState(window.history.state, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export interface ApprovalsPageProps {
  /** Request to scroll to; defaults to the `request` URL parameter. */
  focusRequestId?: string | null;
  /** Paused execution to scroll to (the Runs list links here by execution). */
  focusExecutionId?: string | null;
  onOpenRun?: (executionId: string) => void;
  /** Lets the sidebar badge follow the pending count this page loads. */
  onPendingCountChange?: (count: number) => void;
}

export function ApprovalsPage({ focusRequestId, focusExecutionId, onOpenRun, onPendingCountChange }: ApprovalsPageProps) {
  const [tab, setTab] = useState<Tab>("pending");
  const [items, setItems] = useState<ApprovalInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [focusId] = useState<string | null>(() => focusRequestId ?? focusExecutionId ?? readApprovalRequestParam());
  const pendingCountRef = useRef(onPendingCountChange);
  pendingCountRef.current = onPendingCountChange;

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    try {
      const response = await listApprovals({ status: which });
      setItems(response.items);
      if (which === "pending") pendingCountRef.current?.(response.items.filter((item) => item.canDecide).length);
    } catch (err) {
      setError(formatError(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  // The deep link only applies once; leaving the page drops it from the URL.
  useEffect(() => () => clearApprovalRequestParam(), []);

  // A linked request that was already decided lives on the Decided tab.
  const switchedForFocus = useRef(false);
  useEffect(() => {
    if (!focusId || loading || switchedForFocus.current || tab !== "pending") return;
    if (!items.some((item) => matchesFocus(item, focusId))) {
      switchedForFocus.current = true;
      setTab("decided");
    }
  }, [focusId, items, loading, tab]);

  const visible = useMemo(() => items.filter((item) => matchesApprovalFilter(item, filter)), [filter, items]);

  const handleDecided = useCallback(
    (message: string) => {
      setNotice(message);
      void load(tab);
    },
    [load, tab]
  );

  return (
    <section className="approvals-page page-pane">
      <header className="page-head">
        <div className="page-head-copy">
          <h2 className="page-title">Approvals</h2>
          <p className="page-sub">Runs paused on a person: approval gates, human approvals, guard reviews and write tools an agent wants to call, and versions waiting to be published.</p>
        </div>
        <div className="approvals-head-actions">
          <div className="finops-range" role="tablist" aria-label="Approval views">
            {(["pending", "decided"] as Tab[]).map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                className={tab === entry ? "finops-range-btn active" : "finops-range-btn"}
                onClick={() => {
                  setNotice(null);
                  setTab(entry);
                }}
              >
                {entry === "pending" ? "Pending" : "Decided"}
              </button>
            ))}
          </div>
          <button type="button" className="pg-btn small" onClick={() => void load(tab)} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      <div className="approvals-toolbar">
        <label className="approvals-filter">
          <span>Filter</span>
          <input
            type="search"
            value={filter}
            placeholder="Workflow, node, message, tool or person"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <span className="approvals-count" aria-live="polite">
          {loading ? "Loading…" : `${visible.length} of ${items.length}`}
        </span>
      </div>

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

      {!loading && !error && visible.length === 0 && (
        <div className="approvals-empty">
          {items.length === 0
            ? tab === "pending"
              ? "Nothing is waiting on a decision."
              : "No decided requests yet."
            : "No request matches the filter."}
        </div>
      )}

      <ul className="approvals-list" aria-busy={loading}>
        {visible.map((item) => (
          <li key={item.requestId}>
            {isReleaseInboxItem(item) ? (
              <ReleaseRequestCard view={item} focused={matchesFocus(item, focusId)} onDecided={handleDecided} />
            ) : (
              <ApprovalCard view={item} focused={matchesFocus(item, focusId)} onDecided={handleDecided} {...(onOpenRun ? { onOpenRun } : {})} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ApprovalCardProps {
  view: ApprovalRequestView;
  focused: boolean;
  onDecided: (message: string) => void;
  onOpenRun?: (executionId: string) => void;
}

export function ApprovalCard({ view, focused, onDecided, onOpenRun }: ApprovalCardProps) {
  const [drafts, setDrafts] = useState<FieldDrafts>(() => initialFieldDrafts(view.editableFields));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const pending = view.status === "pending";
  const details = view.details ?? {};
  const toolName = view.kind === "agent_tool" && typeof details.toolName === "string" ? details.toolName : null;
  const toolArgs = view.kind === "agent_tool" && typeof details.arguments === "string" ? details.arguments : null;
  const toolServer = view.kind === "agent_tool" && typeof details.server === "string" ? details.server : null;
  const idBase = `approval-${view.requestId}`;

  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const decide = async (decision: "approve" | "reject") => {
    setError(null);
    setFieldErrors({});
    const trimmed = reason.trim();
    if (decision === "reject" && view.requireRejectReason && !trimmed) {
      setFieldErrors({ reason: "A reason is required to reject this request" });
      return;
    }
    let edits: Record<string, unknown> = {};
    if (decision === "approve") {
      const built = buildApprovalEdits(view.editableFields, drafts);
      if (Object.keys(built.errors).length > 0) {
        setFieldErrors(built.errors);
        return;
      }
      edits = built.edits;
    }
    setBusy(decision);
    try {
      const response =
        decision === "approve"
          ? await approveApproval(view.executionId, {
              requestId: view.requestId,
              ...(trimmed ? { reason: trimmed } : {}),
              ...(Object.keys(edits).length > 0 ? { edits } : {})
            })
          : await rejectApproval(view.executionId, { requestId: view.requestId, ...(trimmed ? { reason: trimmed } : {}) });
      onDecided(decisionOutcome(decision, response));
    } catch (err) {
      // The decision was recorded and the run resumed, but ended in an error (400 with the run result).
      if (err instanceof ApiError && err.status === 400 && err.payload?.status === "error") {
        onDecided(`${decision === "approve" ? "Approved" : "Rejected"}. The resumed run failed${typeof err.payload.error === "string" ? `: ${err.payload.error}` : "."}`);
        return;
      }
      const parsed = decisionError(err);
      setError(parsed.message);
      setFieldErrors(parsed.fieldErrors);
      // Someone else decided first, or a newer request replaced this one: reload to show where it is.
      if (err instanceof ApiError && err.status === 409) onDecided(parsed.message);
    } finally {
      setBusy(null);
    }
  };

  const disabled = !pending || !view.canDecide || busy !== null;
  const reasonRequired = view.requireRejectReason;

  return (
    <article
      ref={cardRef}
      className={["approval-card", `is-${view.status}`, focused && "is-focused"].filter(Boolean).join(" ")}
      aria-labelledby={`${idBase}-title`}
      data-request-id={view.requestId}
    >
      <header className="approval-card-head">
        <div className="approval-card-title">
          <span className={`approval-status approval-status-${view.status}`}>{approvalStatusLabel(view.status)}</span>
          <span className="approval-kind">{approvalKindLabel(view.kind)}</span>
          <h3 id={`${idBase}-title`}>{view.message || "Approval required to continue."}</h3>
        </div>
        <div className="approval-card-when">
          <span title={formatWhen(view.createdAt)}>asked {relativeTime(view.createdAt)}</span>
          {pending && view.expiresAt && (
            <span title={formatWhen(view.expiresAt)}>
              {Date.parse(view.expiresAt) > Date.now() ? "expires " : "expired "}
              {relativeTime(view.expiresAt)}
              {view.timeoutOutcome === "fallback" ? " · then fallback" : " · then rejects"}
            </span>
          )}
        </div>
      </header>

      <dl className="approval-meta">
        <div>
          <dt>Workflow</dt>
          <dd>{view.workflowName ?? view.workflowId}</dd>
        </div>
        <div>
          <dt>Node</dt>
          <dd>
            <code>{view.nodeId}</code>
          </dd>
        </div>
        {view.path.length > 0 && (
          <div>
            <dt>Path</dt>
            <dd className="approval-path">
              {view.path.map((step) => (
                <span key={`${step.workflowId}:${step.nodeId}`}>
                  {step.workflowName ?? step.workflowId} › <code>{step.nodeId}</code>
                </span>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>Requested by</dt>
          <dd>
            {view.requestedBy ?? (
              <span className="approval-requester-unknown" title="A webhook, schedule or other automatic trigger started this run, so self-approval cannot be checked.">
                Requester unknown (automatic trigger)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Approvers</dt>
          <dd>{approversSummary(view)}</dd>
        </div>
        {!pending && (
          <div>
            <dt>Decided</dt>
            <dd>
              {view.decidedBy ?? "the timeout"} {view.decidedAt ? <span title={formatWhen(view.decidedAt)}>{relativeTime(view.decidedAt)}</span> : null}
              {view.reason ? <span className="approval-reason">“{view.reason}”</span> : null}
              {view.editedFields.length > 0 ? <span className="approval-edited">edited: {view.editedFields.join(", ")}</span> : null}
            </dd>
          </div>
        )}
      </dl>

      {toolName && (
        <div className="approval-tool">
          <div className="approval-tool-head">
            <span>Tool</span> <code>{toolName}</code>
            {toolServer ? <span className="approval-tool-server">on {toolServer}</span> : null}
          </div>
          {toolArgs && <pre className="approval-tool-args">{toolArgs}</pre>}
        </div>
      )}

      {pending && view.editableFields.length > 0 && (
        <fieldset className="approval-fields" disabled={disabled}>
          <legend>Fields you can change before approving</legend>
          {view.editableFields.map((field) => (
            <ApprovalFieldInput
              key={field.key}
              idBase={idBase}
              field={field}
              value={drafts[field.key] ?? ""}
              error={fieldErrors[field.key]}
              onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
        </fieldset>
      )}

      {pending && (
        <div className="approval-decide">
          <label className="approval-reason-input" htmlFor={`${idBase}-reason`}>
            <span>
              Reason{reasonRequired ? " (required to reject)" : " (optional)"}
            </span>
            <textarea
              id={`${idBase}-reason`}
              rows={2}
              maxLength={2000}
              value={reason}
              disabled={disabled}
              aria-invalid={fieldErrors.reason ? true : undefined}
              aria-describedby={fieldErrors.reason ? `${idBase}-reason-error` : undefined}
              onChange={(event) => setReason(event.target.value)}
            />
            {fieldErrors.reason && (
              <span id={`${idBase}-reason-error`} className="approval-field-error">
                {fieldErrors.reason}
              </span>
            )}
          </label>
          {fieldErrors["*"] && <div className="approval-field-error">{fieldErrors["*"]}</div>}
          {error && (
            <div className="approvals-error" role="alert">
              {error}
            </div>
          )}
          <div className="approval-actions">
            {!view.canDecide && view.cannotDecideReason && <span className="approval-cannot">{view.cannotDecideReason}</span>}
            {onOpenRun && (
              <button type="button" className="pg-btn small ghost" onClick={() => onOpenRun(view.executionId)}>
                Open run
              </button>
            )}
            <button type="button" className="pg-btn small danger" disabled={disabled} onClick={() => void decide("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className="pg-btn small primary" disabled={disabled} onClick={() => void decide("approve")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
          </div>
        </div>
      )}

      {!pending && onOpenRun && (
        <div className="approval-actions">
          <button type="button" className="pg-btn small ghost" onClick={() => onOpenRun(view.executionId)}>
            Open run
          </button>
        </div>
      )}
    </article>
  );
}

interface ReleaseRequestCardProps {
  view: ReleaseApprovalRequestView;
  focused: boolean;
  onDecided: (message: string) => void;
}

/** Phase 15.4 — a request to publish one exact version (by hash); approving publishes it. */
export function ReleaseRequestCard({ view, focused, onDecided }: ReleaseRequestCardProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const pending = view.status === "pending";
  const idBase = `approval-${view.requestId}`;

  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const decide = async (decision: "approve" | "reject") => {
    setError(null);
    setReasonError(null);
    const trimmed = reason.trim();
    if (decision === "reject" && !trimmed) {
      setReasonError("A reason is required to reject a release");
      return;
    }
    setBusy(decision);
    try {
      const response = await decideReleaseRequest(view.requestId, decision, trimmed || undefined);
      onDecided(releaseDecisionOutcome(decision, view.version, Boolean(response.release)));
    } catch (err) {
      setError(formatError(err));
      // Decided elsewhere, expired, or stale (the gate or the published version changed): reload.
      if (err instanceof ApiError && err.status === 409) onDecided(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const disabled = !pending || !view.canDecide || busy !== null;

  return (
    <article
      ref={cardRef}
      className={["approval-card", "is-release", `is-${view.status}`, focused && "is-focused"].filter(Boolean).join(" ")}
      aria-labelledby={`${idBase}-title`}
      data-request-id={view.requestId}
    >
      <header className="approval-card-head">
        <div className="approval-card-title">
          <span className={`approval-status approval-status-${view.status}`}>{approvalStatusLabel(view.status)}</span>
          <span className="approval-kind">{approvalKindLabel(view.kind)}</span>
          <h3 id={`${idBase}-title`}>{view.message}</h3>
        </div>
        <div className="approval-card-when">
          <span title={formatWhen(view.createdAt)}>asked {relativeTime(view.createdAt)}</span>
          {pending && view.expiresAt && (
            <span title={formatWhen(view.expiresAt)}>
              {Date.parse(view.expiresAt) > Date.now() ? "expires " : "expired "}
              {relativeTime(view.expiresAt)}
            </span>
          )}
        </div>
      </header>

      <dl className="approval-meta">
        <div>
          <dt>Workflow</dt>
          <dd>{view.workflowName ?? view.workflowId}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            v{view.version} <code title={view.workflowHash}>{view.workflowHash.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{view.origin === "blocked" ? "The gate blocked this publish; the requester asks to ship it anyway." : "This gate sends every publish to an approver."}</dd>
        </div>
        {view.replayRunId && (
          <div>
            <dt>Replay job</dt>
            <dd>
              <code>{view.replayRunId}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Requested by</dt>
          <dd>
            {view.requestedBy ?? "unknown"}
            {view.requestReason ? <span className="approval-reason">“{view.requestReason}”</span> : null}
          </dd>
        </div>
        <div>
          <dt>Approvers</dt>
          <dd>{approversSummary(view)}</dd>
        </div>
        {!pending && (
          <div>
            <dt>Decided</dt>
            <dd>
              {view.decidedBy ?? "the timeout"} {view.decidedAt ? <span title={formatWhen(view.decidedAt)}>{relativeTime(view.decidedAt)}</span> : null}
              {view.reason ? <span className="approval-reason">“{view.reason}”</span> : null}
            </dd>
          </div>
        )}
      </dl>

      {view.gateReasons.length > 0 && (
        <div className="approval-release-reasons">
          <div className="approval-tool-head">
            <span>Gate findings</span>
          </div>
          <ul>
            {view.gateReasons.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </div>
      )}

      {pending && (
        <div className="approval-decide">
          <label className="approval-reason-input" htmlFor={`${idBase}-reason`}>
            <span>Reason (required to reject)</span>
            <textarea
              id={`${idBase}-reason`}
              rows={2}
              maxLength={2000}
              value={reason}
              disabled={disabled}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? `${idBase}-reason-error` : undefined}
              onChange={(event) => setReason(event.target.value)}
            />
            {reasonError && (
              <span id={`${idBase}-reason-error`} className="approval-field-error">
                {reasonError}
              </span>
            )}
          </label>
          {error && (
            <div className="approvals-error" role="alert">
              {error}
            </div>
          )}
          <div className="approval-actions">
            {!view.canDecide && view.cannotDecideReason && <span className="approval-cannot">{view.cannotDecideReason}</span>}
            <button type="button" className="pg-btn small danger" disabled={disabled} onClick={() => void decide("reject")}>
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className="pg-btn small primary" disabled={disabled} onClick={() => void decide("approve")}>
              {busy === "approve" ? "Publishing…" : `Approve and publish v${view.version}`}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function ApprovalFieldInput({
  idBase,
  field,
  value,
  error,
  onChange
}: {
  idBase: string;
  field: ApprovalEditableField;
  value: string | boolean;
  error?: string;
  onChange: (value: string | boolean) => void;
}) {
  const id = `${idBase}-field-${field.key}`;
  const label = `${field.label || field.key}${field.required ? " *" : ""}`;
  const describedBy = error ? `${id}-error` : undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy
  } as const;
  return (
    <div className={field.type === "boolean" ? "approval-field approval-field-check" : "approval-field"}>
      {field.type === "boolean" ? (
        <label htmlFor={id}>
          <input {...common} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span>{label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            {label} <code className="approval-field-type">{field.type}</code>
          </label>
          {field.type === "text" || field.type === "json" ? (
            <textarea
              {...common}
              rows={field.type === "json" ? 5 : 3}
              className={field.type === "json" ? "approval-json" : undefined}
              spellCheck={field.type !== "json"}
              {...(field.maxLength ? { maxLength: field.maxLength } : {})}
              value={String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              {...common}
              type={field.type === "number" ? "number" : "text"}
              {...(field.type === "number" ? { step: "any" } : {})}
              {...(field.maxLength ? { maxLength: field.maxLength } : {})}
              value={String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </>
      )}
      {error && (
        <span id={`${id}-error`} className="approval-field-error">
          {field.label || field.key} {error}
        </span>
      )}
    </div>
  );
}
