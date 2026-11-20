/**
 * Settings > Security: change your own password (current + new, at least 8 characters). Your other sessions end; this
 * one stays. Someone who signs in only with SSO has no password they know; they change it at the identity provider.
 */
import { useState, type FormEvent } from "react";
import { ApiError, changeMyPassword } from "../lib/api";

const MIN_LENGTH = 8;

export function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const ready = currentPassword.length > 0 && newPassword.length >= MIN_LENGTH && confirmPassword === newPassword;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await changeMyPassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice(
        result.sessionsEnded > 0
          ? `Password changed. ${result.sessionsEnded} other session${result.sessionsEnded === 1 ? " was" : "s were"} signed out.`
          : "Password changed."
      );
    } catch (changeError) {
      setError(changeError instanceof ApiError || changeError instanceof Error ? changeError.message : "Could not change the password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <h3>Password</h3>
      <p className="settings-help">
        Changing your password signs you out on every other device and browser; this session stays. If you sign in with
        SSO, change your password at your identity provider.
      </p>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="info-banner" role="status">
          {notice}
        </div>
      )}
      <form className="settings-card" onSubmit={(event) => void submit(event)}>
        <label htmlFor="password-current">Current password</label>
        <input
          id="password-current"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="password-new">New password (at least {MIN_LENGTH} characters)</label>
        <input
          id="password-new"
          type="password"
          autoComplete="new-password"
          minLength={MIN_LENGTH}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <label htmlFor="password-confirm">Confirm the new password</label>
        <input
          id="password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          aria-invalid={mismatch}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        {mismatch && <p className="settings-help">The passwords do not match.</p>}
        <div className="settings-actions">
          <button type="submit" className="header-btn" disabled={!ready || busy}>
            Change password
          </button>
        </div>
      </form>
    </div>
  );
}
