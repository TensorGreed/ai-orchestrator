/**
 * Unpublish: the button that takes the live version down, and its confirm
 * dialog. The dialog names the live version and says production runs the
 * draft from then on; with a release gate on it also says the gate does not
 * check the draft. The reason is optional. Used in the Publish dialog and in
 * the Releases card of the Gates tab.
 */

import { useEffect, useId, useRef, useState } from "react";
import { releaseUnpublishNotice } from "@ai-orchestrator/shared";
import { ApiError, unpublishWorkflowRelease, type ReleaseUnpublishResult } from "../lib/api";

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

export interface UnpublishControlProps {
  workflowId: string;
  /** The version production runs now. */
  liveVersion: number;
  gateEnabled: boolean;
  gateEnforced: boolean;
  onUnpublished: (result: ReleaseUnpublishResult) => void;
  /** Class of the opening button (defaults to a small ghost button). */
  buttonClassName?: string;
}

export function UnpublishControl({ workflowId, liveVersion, gateEnabled, gateEnforced, onUnpublished, buttonClassName }: UnpublishControlProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClassName ?? "pg-btn small ghost"} onClick={() => setOpen(true)}>
        Unpublish v{liveVersion}
      </button>
      {open && (
        <UnpublishConfirmDialog
          workflowId={workflowId}
          liveVersion={liveVersion}
          gateEnabled={gateEnabled}
          gateEnforced={gateEnforced}
          onCancel={() => setOpen(false)}
          onUnpublished={(result) => {
            setOpen(false);
            onUnpublished(result);
          }}
        />
      )}
    </>
  );
}

export interface UnpublishConfirmDialogProps {
  workflowId: string;
  liveVersion: number;
  gateEnabled: boolean;
  gateEnforced: boolean;
  onCancel: () => void;
  onUnpublished: (result: ReleaseUnpublishResult) => void;
}

export function UnpublishConfirmDialog({ workflowId, liveVersion, gateEnabled, gateEnforced, onCancel, onUnpublished }: UnpublishConfirmDialogProps) {
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus moves into the dialog (on Cancel, the safe choice) and goes back to what had it when the dialog closes.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    // Escape closes this dialog only, not a dialog it was opened from.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await unpublishWorkflowRelease(workflowId, { expectedVersion: liveVersion, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      onUnpublished(result);
    } catch (err) {
      setError(errorText(err, "Unpublish failed"));
      setBusy(false);
    }
  };

  return (
    <div
      className="pg-modal-backdrop release-unpublish-backdrop"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div className="pg-modal release-modal release-unpublish" role="alertdialog" aria-modal="true" aria-labelledby={titleId} onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <h3 id={titleId} className="pg-modal-title">
            Unpublish v{liveVersion}?
          </h3>
        </header>
        <div className="pg-modal-body">
          <p className={gateEnabled ? "release-unpublish-warning release-unpublish-notice" : "settings-help release-unpublish-notice"}>
            {releaseUnpublishNotice({ version: liveVersion, gateEnabled, gateEnforced })}
          </p>
          <p className="settings-help">Runs already in progress finish on v{liveVersion}. Publishing or rolling back puts a version live again.</p>
          <div className="cfg-field">
            <label className="cfg-label" htmlFor={reasonId}>
              Reason (optional)
            </label>
            <textarea
              id={reasonId}
              className="cfg-input"
              rows={2}
              maxLength={2000}
              placeholder="Stored in the release history and the audit log"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {error && (
            <div className="approvals-error" role="alert">
              {error}
            </div>
          )}
          <div className="release-actions">
            <button ref={cancelRef} type="button" className="pg-btn small ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="pg-btn small danger" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Unpublishing…" : `Unpublish v${liveVersion}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
