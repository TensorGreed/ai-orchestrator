/**
 * 13.2 — the page a break-glass link opens. It names the admin and what the session allows, and signs in only when
 * the person clicks: a link preview or a mail scanner that loads the page uses nothing.
 */
import { useState } from "react";
import { confirmBreakGlass, type AuthUser } from "../lib/api";
import type { BreakGlassLink } from "../lib/break-glass";

interface BreakGlassConfirmCardProps {
  link: BreakGlassLink;
  onSignedIn: (user: AuthUser) => void;
  onDismiss: () => void;
}

export function BreakGlassConfirmCard({ link, onSignedIn, onDismiss }: BreakGlassConfirmCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await confirmBreakGlass(link.token);
      onSignedIn(result.user);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Break-glass sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" role="dialog" aria-label="Break-glass sign-in">
        <div className="auth-brand">
          <img src={`${import.meta.env.BASE_URL}lsquarem-logo.svg`} alt="L2M logo" className="auth-brand-logo" />
          <h1>
            L<sup>2</sup>M
          </h1>
        </div>
        <div className="error-banner">Break-glass sign-in</div>
        <p>
          Sign in as <strong>{link.email ?? "the admin named by the command"}</strong> for one hour. The session skips the
          sign-in policies, every action is recorded, and the notification channels are alerted.
        </p>
        <p>The link works once. Continue only if you asked for it.</p>
        {error && <div className="error-banner">{error}</div>}
        <button className="auth-submit" type="button" disabled={busy} onClick={() => void confirm()}>
          {busy ? "Signing in..." : "Sign in for one hour"}
        </button>
        <button type="button" className="auth-link-btn" onClick={onDismiss}>
          Cancel
        </button>
      </div>
    </div>
  );
}
