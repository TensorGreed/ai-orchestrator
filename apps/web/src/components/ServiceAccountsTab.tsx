/**
 * 13.2 — Settings > Access control > Service accounts (admin): machine identities that act only through API keys.
 * Create one with a role, add it to projects, and give it keys with an optional role ceiling and project list. A key
 * is shown once, when it is created.
 */
import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  addProjectMember,
  createServiceAccount,
  createServiceAccountKey,
  deleteServiceAccount,
  fetchServiceAccountKeys,
  fetchServiceAccounts,
  removeProjectMember,
  revokeServiceAccountKey,
  updateServiceAccount,
  type ApiKeyRecord,
  type ServiceAccount
} from "../lib/api";
import { describeKeyScopes, KEY_SCOPE_ROLES } from "../lib/key-scopes";
import { EMPTY_KEY_SCOPE, KeyScopeFields, keyScopePayload, type KeyScopeValue } from "./KeyScopeFields";

type Role = ServiceAccount["role"];

const PROJECT_ROLES = [
  { value: "project_admin", label: "Project Admin" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" }
];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function ServiceAccountsTab({ projects }: { projects: Project[] }) {
  const [accounts, setAccounts] = useState<ServiceAccount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccounts((await fetchServiceAccounts()).serviceAccounts);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(async () => {
      const created = await createServiceAccount({ name: name.trim(), role, description: description.trim() || null });
      setName("");
      setDescription("");
      setRole("viewer");
      setOpenId(created.serviceAccount.id);
    });

  const handleDelete = (account: ServiceAccount) => {
    if (!window.confirm(`Delete service account ${account.name}? Its keys stop working at once.`)) return;
    void run(async () => {
      await deleteServiceAccount(account.id);
      if (openId === account.id) setOpenId(null);
    });
  };

  if (!loaded) return <div className="settings-loading">Loading service accounts…</div>;

  return (
    <div className="settings-section" aria-label="Service accounts">
      <h3>Service accounts</h3>
      <p className="settings-help">
        A service account is an identity for automation (CI, scripts, other services). It has a role and project
        memberships like a person, cannot sign in, and acts only through its API keys. Deleting the admin who created
        it does not affect it.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Create a service account</h4>
        <label htmlFor="sa-name">Name</label>
        <input id="sa-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="ci-deployer" />
        <label htmlFor="sa-role">Role</label>
        <select id="sa-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {KEY_SCOPE_ROLES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <label htmlFor="sa-description">Description (optional)</label>
        <input id="sa-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Deploys workflows from CI" />
        <div className="settings-actions">
          <button className="header-btn" onClick={() => void handleCreate()} disabled={busy || !name.trim()}>
            Create service account
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Service accounts</h4>
        {accounts.length === 0 ? (
          <p className="settings-muted">No service accounts yet.</p>
        ) : (
          <table className="settings-table" aria-label="Service accounts">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Projects</th>
                <th>Active keys</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.name}</strong>
                    {account.description && <div className="settings-muted">{account.description}</div>}
                  </td>
                  <td>
                    <select
                      aria-label={`Role of ${account.name}`}
                      value={account.role}
                      disabled={busy}
                      onChange={(event) => void run(() => updateServiceAccount(account.id, { role: event.target.value as Role }))}
                    >
                      {KEY_SCOPE_ROLES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{account.projects.length === 0 ? <span className="settings-muted">none</span> : account.projects.map((p) => `${projects.find((x) => x.id === p.projectId)?.name ?? p.projectId} (${p.role})`).join(", ")}</td>
                  <td>{account.activeKeys}</td>
                  <td>{formatDate(account.createdAt)}</td>
                  <td>
                    <div className="settings-actions">
                      <button className="mini-btn" onClick={() => setOpenId(openId === account.id ? null : account.id)}>
                        {openId === account.id ? "Close" : "Manage"}
                      </button>
                      <button className="mini-btn" onClick={() => handleDelete(account)} disabled={busy}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {accounts
        .filter((account) => account.id === openId)
        .map((account) => (
          <ServiceAccountDetail key={account.id} account={account} projects={projects} onChanged={refresh} onError={setError} />
        ))}
    </div>
  );
}

function ServiceAccountDetail({
  account,
  projects,
  onChanged,
  onError
}: {
  account: ServiceAccount;
  projects: Project[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [keyName, setKeyName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [scope, setScope] = useState<KeyScopeValue>(EMPTY_KEY_SCOPE);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [memberProject, setMemberProject] = useState(projects[0]?.id ?? "");
  const [memberRole, setMemberRole] = useState("editor");
  const [busy, setBusy] = useState(false);

  const loadKeys = useCallback(async () => {
    try {
      setKeys((await fetchServiceAccountKeys(account.id)).keys);
    } catch (err) {
      onError(formatError(err));
    }
  }, [account.id, onError]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const run = async (action: () => Promise<unknown>) => {
    onError(null);
    setBusy(true);
    try {
      await action();
      await loadKeys();
      await onChanged();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;

  return (
    <div className="settings-card" aria-label={`Service account ${account.name}`}>
      <h4>{account.name}</h4>
      <p className="settings-muted">
        <code>{account.email}</code> · id <code>{account.id}</code>
      </p>

      <h4>Projects</h4>
      {account.projects.length > 0 && (
        <ul>
          {account.projects.map((membership) => (
            <li key={membership.projectId}>
              {projectName(membership.projectId)} ({membership.role}){" "}
              <button className="mini-btn" disabled={busy} onClick={() => void run(() => removeProjectMember(membership.projectId, account.id))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-actions">
        <select aria-label="Project" value={memberProject} onChange={(event) => setMemberProject(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select aria-label="Project role" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
          {PROJECT_ROLES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <button className="mini-btn" disabled={busy || !memberProject} onClick={() => void run(() => addProjectMember(memberProject, { userId: account.id, role: memberRole }))}>
          Add to project
        </button>
      </div>

      <h4>New key</h4>
      <label htmlFor={`sa-key-name-${account.id}`}>Key name</label>
      <input id={`sa-key-name-${account.id}`} value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="github-actions" />
      <KeyScopeFields idPrefix={`sa-key-${account.id}`} ownerRole={account.role} projects={projects} value={scope} onChange={setScope} />
      <label htmlFor={`sa-key-expiry-${account.id}`}>Expires in N days (leave empty for no expiry)</label>
      <input
        id={`sa-key-expiry-${account.id}`}
        value={expiresInDays}
        onChange={(event) => setExpiresInDays(event.target.value.replace(/\D/g, ""))}
        placeholder="90"
        inputMode="numeric"
      />
      <div className="settings-actions">
        <button
          className="header-btn"
          disabled={busy || !keyName.trim()}
          onClick={() =>
            void run(async () => {
              const days = expiresInDays ? Number(expiresInDays) : undefined;
              const created = await createServiceAccountKey(account.id, {
                name: keyName.trim(),
                ...keyScopePayload(scope),
                ...(days ? { expiresInDays: days } : {})
              });
              setPlaintext(created.key);
              setKeyName("");
              setExpiresInDays("");
              setScope(EMPTY_KEY_SCOPE);
            })
          }
        >
          Generate key
        </button>
      </div>
      {plaintext && (
        <div className="settings-highlight">
          <strong>New key — copy it now. It will not be shown again:</strong>
          <code>{plaintext}</code>
        </div>
      )}

      {keys.length === 0 ? (
        <p className="settings-muted">No keys yet.</p>
      ) : (
        <table className="settings-table" aria-label={`Keys of ${account.name}`}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scope</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className={key.revokedAt ? "settings-row-muted" : undefined}>
                <td>{key.name}</td>
                <td>
                  <code>{key.keyPrefix}</code>
                </td>
                <td>{describeKeyScopes(key.scopes, projectName)}</td>
                <td>{formatDate(key.lastUsedAt)}</td>
                <td>{key.expiresAt ? formatDate(key.expiresAt) : "never"}</td>
                <td>
                  {key.revokedAt ? (
                    <span className="settings-muted">revoked</span>
                  ) : (
                    <button
                      className="mini-btn"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm("Revoke this key? Requests using it will start returning 401.")) void run(() => revokeServiceAccountKey(account.id, key.id));
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
