/**
 * Phase 11.2 — the workflow's "Ask before write tools" setting: agents pause
 * for a person's approval before they call an MCP tool an admin has not
 * marked read-only. Who may approve, whether the person who started the run
 * may approve it, and how long a request waits. When nobody but the
 * signed-in user could approve, the dialog says so: with self-approval off
 * their own runs would wait until the timeout rejects them.
 *
 * Phase 12.2 — the "Approve writes only after untrusted content" switch: a
 * tool rule scoped to this workflow (write tools wait for an admin's approval
 * only while the context holds untrusted outside content). It is saved on the
 * server at once, not with the workflow.
 */

import { useEffect, useState } from "react";
import { APPROVAL_DEFAULT_TIMEOUT_MINUTES, APPROVAL_MAX_TIMEOUT_MINUTES, APPROVER_ROLE_VALUES, type WriteToolApprovalSettings } from "@ai-orchestrator/shared";
import { ApiError, checkApprovalEligibility, fetchUntrustedWriteSwitch, setUntrustedWriteSwitch, type UntrustedWriteSwitchState } from "../lib/api";

interface WriteToolApprovalDialogProps {
  workflowId: string;
  projectId?: string;
  settings: WriteToolApprovalSettings | undefined;
  onChange: (settings: WriteToolApprovalSettings) => void;
  onClose: () => void;
}

type Eligibility = { othersCanApprove: boolean; requesterCanApprove: boolean };

export function WriteToolApprovalDialog({ workflowId, projectId, settings, onChange, onClose }: WriteToolApprovalDialogProps) {
  const current: WriteToolApprovalSettings = settings ?? { enabled: false };
  const roles = current.approverRoles ?? [];
  const [usersText, setUsersText] = useState(() => (current.approverUsers ?? []).join("\n"));
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const update = (patch: Partial<WriteToolApprovalSettings>) => onChange({ ...current, ...patch });

  const rolesKey = roles.join(",");
  const usersKey = (current.approverUsers ?? []).join("\n");
  useEffect(() => {
    if (!current.enabled) {
      setEligibility(null);
      return;
    }
    let canceled = false;
    const timer = window.setTimeout(() => {
      checkApprovalEligibility({
        workflowId,
        ...(projectId ? { projectId } : {}),
        approverRoles: rolesKey ? rolesKey.split(",") : [],
        approverUsers: usersKey ? usersKey.split("\n") : [],
        allowSelfApproval: current.allowSelfApproval === true
      })
        .then((result) => {
          if (!canceled) setEligibility(result);
        })
        .catch(() => {
          if (!canceled) setEligibility(null);
        });
    }, 250);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [workflowId, projectId, current.enabled, current.allowSelfApproval, rolesKey, usersKey]);

  const nobody = eligibility && !eligibility.othersCanApprove;

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal write-gate-modal" role="dialog" aria-modal="true" aria-labelledby="write-gate-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="write-gate-title" className="pg-modal-title">
              Ask before write tools
            </h3>
            <p className="settings-help">
              Agents in this workflow pause in Approvals before they call an MCP tool that an admin has not marked read-only. An approved call runs once.
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="pg-modal-body">
          <label className="guard-check">
            <input type="checkbox" checked={current.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
            <span>Ask for approval before write tools</span>
          </label>

          <fieldset className="cfg-field" disabled={!current.enabled}>
            <legend className="cfg-label">Approver roles</legend>
            <div className="gate-roles">
              {APPROVER_ROLE_VALUES.map((role) => (
                <label key={role} className="guard-check">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(event) => update({ approverRoles: event.target.checked ? [...new Set([...roles, role])] : roles.filter((entry) => entry !== role) })}
                  />
                  <span>{role}</span>
                </label>
              ))}
            </div>
            <div className="cfg-help">With no roles and no users, any operator, builder or admin with run access may decide.</div>
          </fieldset>

          <div className="cfg-field">
            <label className="cfg-label" htmlFor="write-gate-users">
              Approver users
            </label>
            <textarea
              id="write-gate-users"
              className="cfg-input"
              rows={2}
              disabled={!current.enabled}
              value={usersText}
              placeholder={"alice@example.com\nuser id"}
              onChange={(event) => {
                setUsersText(event.target.value);
                const users = event.target.value
                  .split(/[\n,]/)
                  .map((entry) => entry.trim())
                  .filter(Boolean);
                update({ approverUsers: [...new Set(users)] });
              }}
            />
          </div>

          <label className="guard-check">
            <input
              type="checkbox"
              disabled={!current.enabled}
              checked={current.allowSelfApproval === true}
              onChange={(event) => update({ allowSelfApproval: event.target.checked })}
            />
            <span>Let the person who started the run approve it</span>
          </label>

          <div className="cfg-field">
            <label className="cfg-label" htmlFor="write-gate-timeout">
              Timeout (minutes)
            </label>
            <input
              id="write-gate-timeout"
              type="number"
              className="cfg-input"
              min={1}
              max={APPROVAL_MAX_TIMEOUT_MINUTES}
              disabled={!current.enabled}
              value={current.timeoutMinutes ?? APPROVAL_DEFAULT_TIMEOUT_MINUTES}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value));
                update({ timeoutMinutes: Number.isFinite(value) ? Math.min(APPROVAL_MAX_TIMEOUT_MINUTES, Math.max(1, value)) : 1 });
              }}
            />
            <div className="cfg-help">An undecided call is rejected after this long.</div>
          </div>

          <UntrustedWriteSwitch workflowId={workflowId} />

          {nobody && (
            <div className="write-gate-warning" role="alert">
              {eligibility.requesterCanApprove
                ? "Nobody else can approve these requests: you would be approving your own runs."
                : "Nobody can approve your runs: you are the only possible approver and self-approval is off, so they would wait until the timeout rejects them. Add another approver, or let the person who started the run approve it."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function switchError(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function UntrustedWriteSwitch({ workflowId }: { workflowId: string }) {
  const [state, setState] = useState<UntrustedWriteSwitchState | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    setUnsaved(false);
    setState(null);
    const load = async () => {
      try {
        const result = await fetchUntrustedWriteSwitch(workflowId);
        if (!canceled && result) setState(result.switch);
      } catch (err) {
        if (canceled) return;
        if (err instanceof ApiError && err.status === 404) setUnsaved(true);
        else setError(switchError(err));
      }
    };
    void load();
    return () => {
      canceled = true;
    };
  }, [workflowId]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await setUntrustedWriteSwitch(workflowId, enabled);
      setState(result.switch);
    } catch (err) {
      setError(switchError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cfg-field untrusted-write-switch">
      <label className="guard-check">
        <input
          type="checkbox"
          disabled={busy || unsaved || !state}
          checked={state?.enabled === true}
          onChange={(event) => void toggle(event.target.checked)}
        />
        <span>Approve writes only after untrusted content</span>
      </label>
      <div className="cfg-help">
        {unsaved
          ? "Save the workflow first: this switch is a tool policy rule for this workflow."
          : "Independent of the setting above: while the agent's context holds outside content (a public webhook, a web page, a tool result), calls to write tools wait for an admin's approval. The approvers above do not apply. Saved at once, as a tool policy rule."}
      </div>
      {state?.enabled && state.mode === "shadow" && <div className="cfg-help">The rule is in shadow mode: it only records what it would do.</div>}
      {state?.enabled && state.ruleEnabled === false && <div className="cfg-help">An admin has disabled the rule.</div>}
      {state?.customised && <div className="cfg-help">An admin has changed the rule; only an admin can turn it off.</div>}
      {error && (
        <div className="write-gate-warning" role="status">
          {error}
        </div>
      )}
    </div>
  );
}
