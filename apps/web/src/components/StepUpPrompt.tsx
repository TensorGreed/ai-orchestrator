/**
 * 13.2 — step-up. When a security-admin action answers 403 `step_up_required`, the API client calls the handler this
 * component registers: it asks for a code from the authenticator app (or a backup code), sends it to
 * POST /api/auth/step-up, and the client retries the action once. Cancelling leaves the action refused. Requests that
 * need a code while the prompt is open wait for the same answer.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { setAuthChallengeHandlers, stepUpSession, type StepUpChallenge } from "../lib/api";

interface PendingPrompt {
  challenge: StepUpChallenge;
  waiters: Array<(ok: boolean) => void>;
}

export function StepUpPrompt() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAuthChallengeHandlers({
      onStepUp: (challenge) =>
        new Promise<boolean>((resolve) => {
          const open = pendingRef.current;
          if (open) {
            open.waiters.push(resolve);
            return;
          }
          const next = { challenge, waiters: [resolve] };
          pendingRef.current = next;
          setPending(next);
          setCode("");
          setError(null);
        })
    });
    return () => setAuthChallengeHandlers({ onStepUp: undefined });
  }, []);

  const finish = (ok: boolean) => {
    const open = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setCode("");
    setError(null);
    for (const resolve of open?.waiters ?? []) resolve(ok);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await stepUpSession({ code: code.trim() });
      finish(true);
    } catch (stepUpError) {
      setError(stepUpError instanceof Error ? stepUpError.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  if (!pending) return null;
  const minutes = pending.challenge.maxAgeMinutes;

  return (
    <div className="pg-modal-backdrop" role="presentation">
      <form
        className="pg-modal step-up-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="step-up-title"
        onSubmit={(event) => void submit(event)}
      >
        <header className="pg-modal-header">
          <h3 id="step-up-title" className="pg-modal-title">
            Confirm it's you
          </h3>
        </header>
        <div className="pg-modal-body">
          <p className="settings-help">
            {pending.challenge.message}
            {minutes ? ` The code covers security actions for the next ${minutes} minutes.` : ""}
          </p>
          {error && (
            <div className="settings-error" role="alert">
              {error}
            </div>
          )}
          <label className="cfg-label" htmlFor="step-up-code">
            Verification code
          </label>
          <input
            id="step-up-code"
            className="cfg-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <div className="settings-actions">
            <button type="submit" className="header-btn" disabled={busy || !code.trim()}>
              {busy ? "Verifying..." : "Verify"}
            </button>
            <button type="button" className="header-btn ghost" disabled={busy} onClick={() => finish(false)}>
              Cancel
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
