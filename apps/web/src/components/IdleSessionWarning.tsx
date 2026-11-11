import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchAuthMe,
  getLastForegroundRequestAt,
  inBackground,
  sessionEndReasonOf,
  type SessionEndReason,
  type SessionInfo
} from "../lib/api";

/** How long before the idle sign-out the warning appears. */
export const IDLE_WARNING_LEAD_MS = 2 * 60_000;
const TICK_MS = 1000;
/** After a check at zero finds the session still alive, wait this long before checking again. */
const RECHECK_GAP_MS = 15_000;

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export interface IdleSessionWarningProps {
  /** The current session from `/api/auth/me`; nothing renders and no timer runs without an idle timeout. */
  session: SessionInfo | null | undefined;
  /** A fresh `/api/auth/me` answered: the caller stores the session it returned. */
  onSessionRefreshed: (session: SessionInfo | null) => void;
  /** The server says the session is over. */
  onSignedOut: (reason: SessionEndReason) => void;
}

/**
 * Phase 13.2 — warns two minutes before the idle timeout signs this browser out. The deadline is the server's
 * `idleExpiresAt` (the one it enforces, which also sees other tabs' activity). When this tab sent a foreground request
 * after the deadline was last read, the deadline is out of date: before warning, a background `/api/auth/me` reads it
 * again. Without a server deadline the warning counts from this tab's last foreground request.
 */
export function IdleSessionWarning({ session, onSessionRefreshed, onSignedOut }: IdleSessionWarningProps) {
  const idleMinutes = session?.idleTimeoutMinutes ?? null;
  const idleMs = idleMinutes && idleMinutes > 0 ? idleMinutes * 60_000 : null;
  const [serverDeadline, setServerDeadline] = useState<number | null>(() => parseTime(session?.idleExpiresAt));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const checkingRef = useRef(false);
  const nextCheckAtRef = useRef(0);
  /** When the server deadline was last read (the session prop or a /me answer). */
  const syncedAtRef = useRef(Date.now());
  const mountedRef = useRef(true);
  const callbacksRef = useRef({ onSessionRefreshed, onSignedOut });
  callbacksRef.current = { onSessionRefreshed, onSignedOut };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    syncedAtRef.current = Date.now();
    setServerDeadline(parseTime(session?.idleExpiresAt));
  }, [session?.idleExpiresAt]);

  useEffect(() => {
    if (!idleMs) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [idleMs]);

  const deadline = idleMs ? (serverDeadline ?? getLastForegroundRequestAt() + idleMs) : null;
  const remaining = deadline === null ? null : deadline - now;
  // This tab was used since the deadline was read: read it again before warning.
  const stale = remaining !== null && remaining <= IDLE_WARNING_LEAD_MS && getLastForegroundRequestAt() > syncedAtRef.current;

  useEffect(() => {
    if (remaining === null || (remaining > 0 && !stale)) return;
    if (checkingRef.current || (!stale && Date.now() < nextCheckAtRef.current)) return;
    checkingRef.current = true;
    const startedAt = Date.now();
    inBackground(() => fetchAuthMe())
      .then((result) => {
        if (!mountedRef.current) return;
        const next = result.session ?? null;
        nextCheckAtRef.current = Date.now() + RECHECK_GAP_MS;
        syncedAtRef.current = startedAt;
        setServerDeadline(parseTime(next?.idleExpiresAt));
        setNow(Date.now());
        callbacksRef.current.onSessionRefreshed(next);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        nextCheckAtRef.current = Date.now() + RECHECK_GAP_MS;
        if (error instanceof ApiError && error.status === 401) {
          callbacksRef.current.onSignedOut(sessionEndReasonOf(error.payload) ?? "idle");
        }
      })
      .finally(() => {
        checkingRef.current = false;
      });
  }, [remaining]);

  if (remaining === null || remaining > IDLE_WARNING_LEAD_MS || stale) return null;

  const staySignedIn = async () => {
    setBusy(true);
    try {
      const result = await fetchAuthMe();
      if (!mountedRef.current) return;
      const next = result.session ?? null;
      syncedAtRef.current = Date.now();
      setServerDeadline(parseTime(next?.idleExpiresAt));
      setNow(Date.now());
      callbacksRef.current.onSessionRefreshed(next);
    } catch (error) {
      if (mountedRef.current && error instanceof ApiError && error.status === 401) {
        callbacksRef.current.onSignedOut(sessionEndReasonOf(error.payload) ?? "idle");
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="pg-modal-backdrop idle-warning-backdrop" role="presentation">
      <div
        className="pg-modal idle-warning-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-body"
      >
        <header className="pg-modal-header">
          <h3 id="idle-warning-title" className="pg-modal-title">
            You will be signed out soon
          </h3>
        </header>
        <div className="pg-modal-body">
          <p id="idle-warning-body" className="settings-help">
            There has been no activity for a while. You will be signed out in{" "}
            <strong className="idle-warning-countdown" aria-live="polite">
              {formatCountdown(remaining)}
            </strong>
            .
          </p>
          <div className="settings-actions">
            <button type="button" className="pg-btn" onClick={() => void staySignedIn()} disabled={busy} autoFocus>
              Stay signed in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
