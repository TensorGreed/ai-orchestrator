/**
 * 13.2 — the screen for a session restricted by MFA_REQUIRED_ROLES. `enroll`: the user's role requires MFA and no
 * authenticator is set up, so the session can only set one up (secret, backup codes, then a code to activate it).
 * `verify`: an authenticator is set up but this session has not passed a code yet. Either way, once the code passes
 * the session is unrestricted and the studio opens.
 */
import { useState, type FormEvent } from "react";
import { activateMfa, enrollMfa, mfaReauthFromError, stepUpSession, type MfaGate } from "../lib/api";

interface MfaGateCardProps {
  gate: MfaGate;
  email: string;
  onDone: () => void;
  onSignOut: () => void;
}

export function MfaGateCard({ gate, email, onDone, onSignOut }: MfaGateCardProps) {
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUrl: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState<"password" | "sso" | null>(null);
  const [password, setPassword] = useState("");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      try {
        setEnrollment(await enrollMfa(reauth === "password" ? { password } : {}));
        setReauth(null);
      } catch (enrollError) {
        // More than 10 minutes after signing in: the password again (or, for SSO, signing in again).
        const needed = mfaReauthFromError(enrollError);
        if (needed) setReauth(needed);
        throw enrollError;
      }
    });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!code.trim()) return;
    void run(async () => {
      if (gate === "enroll") await activateMfa({ code: code.trim() });
      else await stepUpSession({ code: code.trim() });
      onDone();
    });
  };

  const showCodeForm = gate === "verify" || enrollment !== null;

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit} aria-label={gate === "enroll" ? "Set up MFA" : "Verify MFA"}>
        <div className="auth-brand">
          <img src={`${import.meta.env.BASE_URL}lsquarem-logo.svg`} alt="L2M logo" className="auth-brand-logo" />
          <h1>
            L<sup>2</sup>M
          </h1>
        </div>
        {gate === "enroll" ? (
          <p>
            Your role requires multi-factor authentication. Set up an authenticator app (Google Authenticator, 1Password,
            Authy or similar) for <strong>{email}</strong> to continue.
          </p>
        ) : (
          <p>
            Your role requires multi-factor authentication. Enter the 6-digit code from your authenticator app (or a
            backup code) to continue.
          </p>
        )}
        {error && <div className="error-banner">{error}</div>}
        {gate === "enroll" && !enrollment && reauth === "password" && (
          <>
            <label htmlFor="mfa-gate-password">Your password</label>
            <input
              id="mfa-gate-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </>
        )}
        {gate === "enroll" && !enrollment && reauth !== "sso" && (
          <button
            className="auth-submit"
            type="button"
            onClick={() => void start()}
            disabled={busy || (reauth === "password" && !password)}
          >
            {busy ? "Preparing..." : "Set up authenticator"}
          </button>
        )}
        {enrollment && (
          <div className="mfa-gate-enrollment">
            <p>Add this secret to your authenticator app:</p>
            <code className="mfa-secret">{enrollment.secret}</code>
            <p className="settings-help">
              Or paste this URI: <code className="mfa-uri">{enrollment.otpauthUrl}</code>
            </p>
            <div className="mfa-backup-codes">
              <strong>Backup codes (store them safely; each works once):</strong>
              <ul>
                {enrollment.backupCodes.map((backupCode) => (
                  <li key={backupCode}>
                    <code>{backupCode}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {showCodeForm && (
          <>
            <label htmlFor="mfa-gate-code">{gate === "enroll" ? "Code from the app, to activate it" : "Verification code"}</label>
            <input
              id="mfa-gate-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoFocus
            />
            <button className="auth-submit" type="submit" disabled={busy || !code.trim()}>
              {busy ? "Verifying..." : gate === "enroll" ? "Activate and continue" : "Verify"}
            </button>
          </>
        )}
        <button type="button" className="auth-link-btn" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </form>
    </div>
  );
}
