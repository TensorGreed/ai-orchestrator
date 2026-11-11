import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  fetchMySessions,
  notifySessionEnded,
  revokeMyOtherSessions,
  revokeMySession,
  type SessionPolicyView,
  type SessionView
} from "../lib/api";
import { authMethodLabel, describeSessionPolicy, describeUserAgent } from "../lib/session-display";

function formatError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Phase 13.2 — Settings > Security: this user's live sign-ins, with a way to end the others. */
export function SignedInSessionsCard() {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [policy, setPolicy] = useState<SessionPolicyView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchMySessions();
      setSessions(response.sessions);
      setPolicy(response.policy);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOutOne = async (session: SessionView) => {
    setBusy(session.handle);
    setError(null);
    setNotice(null);
    try {
      const result = await revokeMySession(session.handle);
      if (result.current) {
        notifySessionEnded("logout");
        return;
      }
      setNotice(`Signed out ${describeUserAgent(session.userAgent)}.`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const signOutOthers = async () => {
    setBusy("others");
    setError(null);
    setNotice(null);
    try {
      const result = await revokeMyOtherSessions();
      setNotice(result.revoked === 1 ? "Signed out 1 other session." : `Signed out ${result.revoked} other sessions.`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const others = sessions.filter((session) => !session.current);

  return (
    <div className="settings-section signed-in-sessions">
      <h3>Signed-in sessions</h3>
      <p className="settings-help">Browsers and devices where you are signed in. Sign out any you do not recognise.</p>
      {policy && <p className="settings-muted session-policy-line">{describeSessionPolicy(policy)}</p>}
      {error && <div className="settings-error">{error}</div>}
      {notice && (
        <div className="info-banner" role="status">
          {notice}
        </div>
      )}
      {!loaded ? (
        <div className="settings-loading">Loading sessions…</div>
      ) : (
        <div className="settings-card">
          {sessions.length === 0 ? (
            <p className="settings-muted">No signed-in sessions to show.</p>
          ) : (
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>IP address</th>
                  <th>Sign-in method</th>
                  <th>Signed in</th>
                  <th>Last active</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.handle}>
                    <td>
                      <span title={session.userAgent ?? undefined}>{describeUserAgent(session.userAgent)}</span>
                      {session.current && <span className="settings-chip">This device</span>}
                      {session.breakGlass && <span className="settings-chip settings-chip-danger">Break-glass</span>}
                    </td>
                    <td>
                      <code>{session.ipAddress ?? "—"}</code>
                    </td>
                    <td>{authMethodLabel(session.authMethod)}</td>
                    <td>{formatDate(session.createdAt)}</td>
                    <td>{formatDate(session.lastSeenAt)}</td>
                    <td>
                      {!session.current && (
                        <button
                          type="button"
                          className="mini-btn"
                          onClick={() => void signOutOne(session)}
                          disabled={busy !== null}
                          aria-label={`Sign out ${describeUserAgent(session.userAgent)}`}
                        >
                          Sign out
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="settings-actions">
            <button type="button" className="header-btn" onClick={() => void signOutOthers()} disabled={busy !== null || others.length === 0}>
              Sign out other sessions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
