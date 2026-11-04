import { useEffect, useState, type FormEvent } from "react";
import { acceptInviteAndSignIn, isMfaChallenge, lookupInvite, type AuthUser, type InviteLookup } from "../lib/api";

interface AcceptInviteCardProps {
  token: string;
  onSignedIn: (user: AuthUser) => void;
  /** The new account has TOTP enforced: the login page's verification step comes next. */
  onMfaChallenge: (challengeId: string) => void;
  /** Back to the normal sign-in form. */
  onDismiss: () => void;
}

const MIN_PASSWORD = 8;

/** Roadmap 7.3 — the login page for an invite link: choose a password, then sign in with it. */
export function AcceptInviteCard({ token, onSignedIn, onMfaChallenge, onDismiss }: AcceptInviteCardProps) {
  const [invite, setInvite] = useState<InviteLookup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    lookupInvite(token).then(
      (found) => {
        if (!cancelled) setInvite(found);
      },
      (lookupError: unknown) => {
        if (!cancelled) setLoadError(lookupError instanceof Error ? lookupError.message : "This invite link is invalid or has expired");
      }
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD || password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInviteAndSignIn(token, password);
      if (isMfaChallenge(result)) onMfaChallenge(result.mfaChallenge);
      else onSignedIn(result.user);
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : "Could not accept the invite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={(event) => void submit(event)} aria-label="Accept invite">
        <div className="auth-brand">
          <img src={`${import.meta.env.BASE_URL}lsquarem-logo.svg`} alt="L2M logo" className="auth-brand-logo" />
          <h1>
            L<sup>2</sup>M
          </h1>
        </div>
        {loadError ? (
          <>
            <div className="error-banner">{loadError}</div>
            <p>Ask an admin for a new invite, or sign in if you already have an account.</p>
          </>
        ) : !invite ? (
          <p>Checking your invite...</p>
        ) : (
          <>
            <p>
              You are invited as <strong>{invite.role}</strong>. Choose a password for <strong>{invite.email}</strong>.
            </p>
            {error && <div className="error-banner">{error}</div>}
            <label htmlFor="invite-password">Password</label>
            <input
              id="invite-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              autoFocus
              required
            />
            <label htmlFor="invite-password-confirm">Confirm password</label>
            <input
              id="invite-password-confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
            />
            {(tooShort || mismatch) && (
              <div className="error-banner" role="status">
                {tooShort ? `Use at least ${MIN_PASSWORD} characters.` : "The passwords do not match."}
              </div>
            )}
            <button className="auth-submit" type="submit" disabled={busy || password.length < MIN_PASSWORD || password !== confirm}>
              {busy ? "Signing in..." : "Set password and sign in"}
            </button>
          </>
        )}
        <button type="button" className="auth-link-btn" onClick={onDismiss}>
          Go to sign in
        </button>
      </form>
    </div>
  );
}
