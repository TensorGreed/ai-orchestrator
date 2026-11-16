/**
 * 13.2 — Settings > Provisioning (SCIM), admins only: whether SCIM_ENABLED is on, the base URL to give the identity
 * provider, its bearer tokens (each shown once, when made or rotated; rotating keeps the old token working for the
 * grace window picked) and the groups it pushed, with whether a mapping grants anything for each. Group-to-role
 * mappings are made under SSO Mappings with the "SCIM groups" provider. Token changes need a recent MFA check when
 * step-up is on (the studio asks for a code and retries).
 */
import { useCallback, useEffect, useState } from "react";
import { KEY_ROTATION_GRACE_HOURS, type ScimGroupSummary, type ScimSettingsView, type ScimTokenSummary } from "@ai-orchestrator/shared";
import { createScimToken, fetchScimGroups, fetchScimSettings, revokeScimToken, rotateScimToken } from "../lib/api";

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ScimProvisioningTab() {
  const [settings, setSettings] = useState<ScimSettingsView | null>(null);
  const [groups, setGroups] = useState<ScimGroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("identity-provider");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [rotatedNote, setRotatedNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [view, groupList] = await Promise.all([fetchScimSettings(), fetchScimGroups()]);
      setSettings(view);
      setGroups(groupList.groups);
      setError(null);
    } catch (loadError) {
      setError(message(loadError, "Could not load provisioning settings"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(message(actionError, "The change did not go through"));
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const days = expiresInDays.trim() === "" ? undefined : Number(expiresInDays);
      if (days !== undefined && (!Number.isInteger(days) || days < 0)) throw new Error("Expiry must be a whole number of days");
      const created = await createScimToken({ name: name.trim(), ...(days ? { expiresInDays: days } : {}) });
      setPlaintext(created.token);
      setRotatedNote(null);
    });

  const rotate = (token: ScimTokenSummary) => {
    const answer = window.prompt(
      `Rotate ${token.name}? The old token keeps working for this many hours (0 ends it now):`,
      String(KEY_ROTATION_GRACE_HOURS.default)
    );
    if (answer === null) return;
    const graceHours = Number(answer);
    if (!Number.isInteger(graceHours) || graceHours < KEY_ROTATION_GRACE_HOURS.min || graceHours > KEY_ROTATION_GRACE_HOURS.max) {
      setError(`Grace must be a whole number of hours from ${KEY_ROTATION_GRACE_HOURS.min} to ${KEY_ROTATION_GRACE_HOURS.max}`);
      return;
    }
    void run(async () => {
      const rotated = await rotateScimToken(token.id, graceHours);
      setPlaintext(rotated.token);
      setRotatedNote(graceHours === 0 ? "The old token stopped working." : `The old token works until ${formatDate(rotated.previous.expiresAt)}.`);
    });
  };

  const revoke = (token: ScimTokenSummary) => {
    if (!window.confirm(`Revoke ${token.name}? Provisioning with it stops at once.`)) return;
    void run(async () => {
      await revokeScimToken(token.id);
      setPlaintext(null);
    });
  };

  if (!settings && !error) return <div className="settings-loading">Loading provisioning…</div>;

  return (
    <div className="settings-section" aria-label="SCIM provisioning">
      <h3>Provisioning (SCIM)</h3>
      <p className="settings-help">
        Your identity provider creates, updates and removes users and groups here over SCIM 2.0. A user it deactivates or
        removes is disabled at once: their sessions end and their API keys are revoked. Their account and history stay.
        Groups grant roles only through a mapping under SSO Mappings (provider "SCIM groups").
      </p>
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}

      {settings && (
        <div className="settings-card">
          <h4>Endpoint</h4>
          {settings.enabled ? (
            <p>
              SCIM is on. Base URL: <code>{settings.baseUrl}</code>
            </p>
          ) : (
            <p className="settings-muted">
              SCIM is off. Set <code>SCIM_ENABLED=true</code> and restart to serve <code>{settings.baseUrl}</code>. You can make
              the token first.
            </p>
          )}
          <p className="settings-muted">
            {settings.provisionedUsers} provisioned user{settings.provisionedUsers === 1 ? "" : "s"}, {settings.groups} group
            {settings.groups === 1 ? "" : "s"}, {settings.disabledUsers} disabled user{settings.disabledUsers === 1 ? "" : "s"}.
          </p>
        </div>
      )}

      <div className="settings-card">
        <h4>Tokens</h4>
        <label htmlFor="scim-token-name">Name</label>
        <input id="scim-token-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
        <label htmlFor="scim-token-expiry">Expires in days (blank = never)</label>
        <input id="scim-token-expiry" inputMode="numeric" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} />
        <div className="settings-actions">
          <button className="header-btn" onClick={() => void create()} disabled={busy || !name.trim()}>
            Generate token
          </button>
        </div>
        {plaintext && (
          <div className="settings-highlight">
            <strong>New token — copy it into your identity provider now. It will not be shown again:</strong>
            <code>{plaintext}</code>
            {rotatedNote && <p>{rotatedNote}</p>}
          </div>
        )}
        {settings && settings.tokens.length === 0 ? (
          <p className="settings-muted">No tokens yet.</p>
        ) : (
          <table className="settings-table" aria-label="SCIM tokens">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {settings?.tokens.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>
                    <code>{token.tokenPrefix}</code>
                  </td>
                  <td>{formatDate(token.createdAt)}</td>
                  <td>{formatDate(token.lastUsedAt)}</td>
                  <td>{formatDate(token.expiresAt)}</td>
                  <td>
                    {token.active ? (
                      <div className="settings-actions">
                        {!token.supersededBy && (
                          <button className="mini-btn" disabled={busy} onClick={() => rotate(token)} aria-label={`Rotate ${token.name}`}>
                            Rotate
                          </button>
                        )}
                        <button className="mini-btn" disabled={busy} onClick={() => revoke(token)} aria-label={`Revoke ${token.name}`}>
                          Revoke
                        </button>
                      </div>
                    ) : (
                      <span className="settings-muted">{token.revokedAt ? "revoked" : "expired"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-card">
        <h4>Groups</h4>
        {groups.length === 0 ? (
          <p className="settings-muted">No groups provisioned yet.</p>
        ) : (
          <table className="settings-table" aria-label="SCIM groups">
            <thead>
              <tr>
                <th>Group</th>
                <th>Members</th>
                <th>Grants</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    {group.displayName}
                    {group.externalId && <div className="settings-muted">{group.externalId}</div>}
                  </td>
                  <td>{group.memberCount}</td>
                  <td>
                    {group.mappingIds.length === 0 ? (
                      <span className="settings-muted">nothing (no mapping)</span>
                    ) : (
                      `${group.mappingIds.length} mapping${group.mappingIds.length === 1 ? "" : "s"}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
