/**
 * Settings > Users > Invite user (admins): an email and a role. The server emails the invite link when a mail server
 * is set; otherwise the link is shown here once, to copy and pass on. Inviting the email of someone already invited
 * sends a new link (the old one stops working).
 */
import { useEffect, useId, useRef, useState } from "react";
import { inviteUser, type UserInviteResult } from "../lib/api";

type InviteRole = "admin" | "builder" | "operator" | "viewer";

const ROLE_HELP: Record<InviteRole, string> = {
  viewer: "Opens workflows and runs; changes nothing.",
  operator: "Viewer, plus approvals and connections to MCP servers.",
  builder: "Builds, saves and runs workflows.",
  admin: "Everything, including users and settings."
};

interface InviteUserDialogProps {
  /** Called after an invite is created, so the user list can refresh. */
  onInvited: (result: UserInviteResult) => void;
  onClose: () => void;
}

export function InviteUserDialog({ onInvited, onClose }: InviteUserDialogProps) {
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UserInviteResult | null>(null);
  const [copied, setCopied] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    emailRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const submit = async () => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Enter an email address, such as ana@example.com.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const invited = await inviteUser({ email: trimmed, role });
      setResult(invited);
      onInvited(invited);
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Could not send the invite");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal write-gate-modal" role="dialog" aria-modal="true" aria-labelledby="invite-user-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="invite-user-title" className="pg-modal-title">
              Invite user
            </h3>
            <p className="settings-help">They choose a password from the invite link. The link works once and expires in 7 days.</p>
          </div>
        </header>
        <div className="pg-modal-body">
          {result ? (
            <div role="status">
              {result.emailed ? (
                <p>
                  Invite sent to <strong>{result.user.email}</strong> as {result.user.role}.
                </p>
              ) : (
                <>
                  <p>
                    <strong>{result.user.email}</strong> is invited as {result.user.role}. No mail server is set, so send them this
                    link yourself. It is shown only now.
                  </p>
                  <div className="invite-link-row">
                    <input className="cfg-input" readOnly value={result.inviteUrl ?? ""} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
                    <button type="button" className="pg-btn" onClick={() => void copy()}>
                      {copied ? "Copied" : "Copy link"}
                    </button>
                  </div>
                </>
              )}
              <div className="webhook-test-actions">
                <button type="button" className="pg-btn primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={emailId}>
                  Email
                </label>
                <input
                  id={emailId}
                  ref={emailRef}
                  className="cfg-input"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (error) setError(null);
                  }}
                />
              </div>
              <div className="cfg-field">
                <label className="cfg-label" htmlFor={roleId}>
                  Role
                </label>
                <select id={roleId} className="cfg-input" value={role} onChange={(event) => setRole(event.target.value as InviteRole)}>
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                  <option value="builder">Builder</option>
                  <option value="admin">Admin</option>
                </select>
                <p className="settings-help">{ROLE_HELP[role]}</p>
              </div>
              {error ? (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="webhook-test-actions">
                <button type="button" className="pg-btn ghost" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="pg-btn primary" disabled={busy}>
                  Send invite
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
