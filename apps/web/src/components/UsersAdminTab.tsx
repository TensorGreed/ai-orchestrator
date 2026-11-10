/**
 * 13.2 — Settings > Users (admins): the people on this deployment and their roles. Service accounts are not listed
 * here (GET /api/users lists people; they have their own Service Accounts tab).
 *
 * - "Sign out everywhere" ends all of a user's live sessions (yours: every other one; this session stays).
 * - "Reset MFA" is for a user who lost their authenticator: it deletes the authenticator and backup codes and signs
 *   them out everywhere; their next sign-in sets MFA up again. It is refused on your own account.
 *
 * Both need a recent MFA check when step-up is on (the studio asks for a code and retries).
 */
import { useCallback, useEffect, useState } from "react";
import { fetchDeploymentUsers, resetUserMfa, revokeUserSessions, type DeploymentUserView } from "../lib/api";

function formatCreated(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function UsersAdminTab({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<DeploymentUserView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setUsers((await fetchDeploymentUsers()).users);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load users");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOutEverywhere = async (user: DeploymentUserView) => {
    const self = user.id === currentUserId;
    const prompt = self
      ? "Sign yourself out on every other device and browser? This session stays signed in."
      : `Sign ${user.email} out everywhere? They will need to sign in again.`;
    if (!window.confirm(prompt)) return;
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const result = await revokeUserSessions(user.id);
      const count = result.revoked === 1 ? "1 session" : `${result.revoked} sessions`;
      setNotice(`Ended ${count} for ${user.email}.`);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Could not end the sessions");
    } finally {
      setBusyId(null);
    }
  };

  const reset = async (user: DeploymentUserView) => {
    if (
      !window.confirm(
        `Reset MFA for ${user.email}? Their authenticator and backup codes are deleted and they are signed out everywhere. They set MFA up again at their next sign-in.`
      )
    ) {
      return;
    }
    setBusyId(user.id);
    setError(null);
    setNotice(null);
    try {
      const result = await resetUserMfa(user.id);
      setNotice(
        `${user.email}: ${result.hadMfa ? "MFA reset" : "no authenticator was set up"}; ${result.sessionsEnded} session${result.sessionsEnded === 1 ? "" : "s"} ended.`
      );
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Could not reset MFA");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="settings-section">
      <h3>Users</h3>
      <p className="settings-help">
        Everyone with an account on this deployment. Signing a user out everywhere ends all of their live sessions.
        Reset MFA for a user who lost their authenticator; you cannot reset your own, so ask another admin or use a
        break-glass sign-in from the server host.
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
      {!loaded ? (
        <div className="settings-loading">Loading users…</div>
      ) : (
        <div className="settings-card">
          {users.length === 0 ? (
            <p className="settings-muted">No users.</p>
          ) : (
            <table className="settings-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.email}
                      {user.id === currentUserId && <span className="settings-chip">You</span>}
                      {user.pending && <span className="settings-chip">Invited</span>}
                    </td>
                    <td>{user.role}</td>
                    <td>{formatCreated(user.createdAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => void signOutEverywhere(user)}
                        disabled={busyId !== null}
                        aria-label={`Sign ${user.email} out everywhere`}
                      >
                        Sign out everywhere
                      </button>
                      {user.id !== currentUserId && !user.pending && (
                        <button
                          type="button"
                          className="mini-btn"
                          disabled={busyId !== null}
                          onClick={() => void reset(user)}
                          aria-label={`Reset MFA for ${user.email}`}
                        >
                          Reset MFA
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
