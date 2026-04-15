import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import {
  activateMfa,
  addProjectMember,
  ApiError,
  createApiKey,
  createCustomRole,
  createSsoMapping,
  deleteCustomRole,
  deleteSsoMapping,
  disableMfa,
  enrollMfa,
  fetchApiKeys,
  fetchCustomRoles,
  fetchMfaStatus,
  fetchProjectMembers,
  fetchSsoMappings,
  removeProjectMember,
  revokeApiKey,
  type ApiKeyRecord,
  type AuthUser,
  type CustomRoleRecord,
  type MfaStatus,
  type ProjectMembership,
  type SsoGroupMapping
} from "../lib/api";

type SettingsTab = "security" | "api-keys" | "members" | "roles" | "sso";

interface SettingsPageProps {
  authUser: AuthUser;
  projects: Project[];
  activeProjectId: string;
}

const BUILT_IN_PROJECT_ROLES: Array<{ value: "project_admin" | "editor" | "viewer"; label: string }> = [
  { value: "project_admin", label: "Project Admin" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" }
];

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

export function SettingsPage({ authUser, projects, activeProjectId }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("security");
  const isAdmin = authUser.role === "admin";

  const tabs: Array<{ id: SettingsTab; label: string; restricted?: boolean }> = [
    { id: "security", label: "Security (MFA)" },
    { id: "api-keys", label: "API Keys" },
    { id: "members", label: "Project Members" },
    { id: "roles", label: "Custom Roles", restricted: !isAdmin },
    { id: "sso", label: "SSO Mappings", restricted: !isAdmin }
  ];

  return (
    <section className="settings-page">
      <header className="settings-header">
        <div>
          <h2>Account &amp; Project Settings</h2>
          <p>
            Manage your two-factor authentication, personal API keys, and—if you're a project admin—invite members,
            define custom roles, and wire SSO group-to-role mappings.
          </p>
        </div>
      </header>

      <nav className="settings-tabs" role="tablist">
        {tabs
          .filter((item) => !item.restricted)
          .map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "settings-tab active" : "settings-tab"}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
      </nav>

      <div className="settings-body">
        {tab === "security" && <SecurityTab />}
        {tab === "api-keys" && <ApiKeysTab isAdmin={isAdmin} />}
        {tab === "members" && (
          <ProjectMembersTab
            projects={projects}
            initialProjectId={activeProjectId}
            currentUserRole={authUser.role}
          />
        )}
        {tab === "roles" && isAdmin && <CustomRolesTab projects={projects} initialProjectId={activeProjectId} />}
        {tab === "sso" && isAdmin && <SsoMappingsTab projects={projects} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Security (MFA)
// ---------------------------------------------------------------------------

function SecurityTab() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    otpauthUrl: string;
    backupCodes: string[];
  } | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchMfaStatus();
      setStatus(next);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleEnroll = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await enrollMfa();
      setEnrollment(response);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async () => {
    if (!activationCode.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await activateMfa({ code: activationCode.trim() });
      setEnrollment(null);
      setActivationCode("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setError(null);
    setBusy(true);
    try {
      await disableMfa({ code: disableCode.trim() });
      setDisableCode("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return <div className="settings-loading">Loading MFA status…</div>;
  }

  return (
    <div className="settings-section">
      <h3>Two-factor authentication</h3>
      <p className="settings-help">
        Time-based one-time passwords (TOTP) are compatible with Google Authenticator, 1Password, Authy, and similar
        apps. Enrolling MFA adds a second step to every future login.
      </p>
      {error && <div className="settings-error">{error}</div>}

      {status?.enabled ? (
        <div className="settings-card">
          <p>
            <strong>MFA is enabled.</strong> Activated {formatDate(status.activatedAt)}. Remaining backup codes:{" "}
            {status.remainingBackupCodes}.
          </p>
          <label htmlFor="mfa-disable-code">Current TOTP code (required to disable)</label>
          <input
            id="mfa-disable-code"
            value={disableCode}
            onChange={(event) => setDisableCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
          />
          <div className="settings-actions">
            <button
              className="header-btn"
              onClick={handleDisable}
              disabled={busy || disableCode.trim().length !== 6}
            >
              Disable MFA
            </button>
          </div>
        </div>
      ) : enrollment ? (
        <div className="settings-card">
          <p>
            <strong>Scan the QR code (or paste the secret) into your authenticator app.</strong>
          </p>
          <div className="mfa-otpauth">
            <code className="mfa-secret">{enrollment.secret}</code>
          </div>
          <p className="settings-help">
            otpauth URI (paste into your authenticator if QR isn't available):
            <br />
            <code className="mfa-uri">{enrollment.otpauthUrl}</code>
          </p>
          <div className="mfa-backup-codes">
            <strong>Backup codes (store securely — each can be used once):</strong>
            <ul>
              {enrollment.backupCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                </li>
              ))}
            </ul>
          </div>
          <label htmlFor="mfa-activation-code">Enter the current 6-digit code to activate</label>
          <input
            id="mfa-activation-code"
            value={activationCode}
            onChange={(event) => setActivationCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
          />
          <div className="settings-actions">
            <button
              className="header-btn"
              onClick={handleActivate}
              disabled={busy || activationCode.trim().length !== 6}
            >
              Activate MFA
            </button>
            <button className="header-btn ghost" onClick={() => setEnrollment(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-card">
          <p>MFA is not enrolled. Click below to generate a secret and backup codes.</p>
          <div className="settings-actions">
            <button className="header-btn" onClick={handleEnroll} disabled={busy}>
              Enrol in MFA
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function ApiKeysTab({ isAdmin }: { isAdmin: boolean }) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [scopes, setScopes] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchApiKeys();
      setKeys(response.keys);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const parsedScopes = scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedDays = expiresInDays.trim() ? Number(expiresInDays.trim()) : undefined;
      const response = await createApiKey({
        name: name.trim(),
        scopes: parsedScopes.length ? parsedScopes : undefined,
        expiresInDays: parsedDays && Number.isFinite(parsedDays) ? parsedDays : undefined
      });
      setPlaintext(response.key);
      setName("");
      setScopes("");
      setExpiresInDays("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!window.confirm("Revoke this API key? Requests using it will start returning 401.")) return;
    setError(null);
    try {
      await revokeApiKey(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  if (!loaded) return <div className="settings-loading">Loading API keys…</div>;

  return (
    <div className="settings-section">
      <h3>API keys</h3>
      <p className="settings-help">
        Use an API key as <code>Authorization: Bearer &lt;key&gt;</code> on any API call. Keys inherit your user role;
        scopes are informational today and reserved for finer-grained enforcement later. Keys are only shown once on
        creation.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Create a new key</h4>
        <label htmlFor="api-key-name">Name</label>
        <input
          id="api-key-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="ci-pipeline"
        />
        <label htmlFor="api-key-scopes">Scopes (comma-separated, optional)</label>
        <input
          id="api-key-scopes"
          value={scopes}
          onChange={(event) => setScopes(event.target.value)}
          placeholder="workflow:read,workflow:execute"
        />
        <label htmlFor="api-key-expiry">Expires in N days (leave empty for no expiry)</label>
        <input
          id="api-key-expiry"
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(event.target.value.replace(/\D/g, ""))}
          placeholder="90"
          inputMode="numeric"
        />
        <div className="settings-actions">
          <button className="header-btn" onClick={handleCreate} disabled={busy || !name.trim()}>
            Generate key
          </button>
        </div>
        {plaintext && (
          <div className="settings-highlight">
            <strong>New key — copy it now. It will not be shown again:</strong>
            <code>{plaintext}</code>
          </div>
        )}
      </div>

      <div className="settings-card">
        <h4>Your keys</h4>
        {keys.length === 0 ? (
          <p className="settings-muted">No keys yet.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                {isAdmin && <th>User</th>}
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
                  {isAdmin && <td>{key.userId}</td>}
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td>{key.expiresAt ? formatDate(key.expiresAt) : "never"}</td>
                  <td>
                    {key.revokedAt ? (
                      <span className="settings-muted">revoked</span>
                    ) : (
                      <button className="mini-btn" onClick={() => handleRevoke(key.id)}>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project members
// ---------------------------------------------------------------------------

function ProjectMembersTab({
  projects,
  initialProjectId,
  currentUserRole
}: {
  projects: Project[];
  initialProjectId: string;
  currentUserRole: AuthUser["role"];
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [members, setMembers] = useState<ProjectMembership[]>([]);
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<string>("editor");
  const [newCustomRoleId, setNewCustomRoleId] = useState("");
  const [customRoles, setCustomRoles] = useState<CustomRoleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = currentUserRole === "admin" || currentUserRole === "builder";

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [membersResponse, rolesResponse] = await Promise.all([
        fetchProjectMembers(projectId),
        fetchCustomRoles(projectId)
      ]);
      setMembers(membersResponse.members);
      setCustomRoles(rolesResponse.roles);
    } catch (err) {
      setError(formatError(err));
      setMembers([]);
      setCustomRoles([]);
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    if (!newUserId.trim()) return;
    if (newRole === "custom" && !newCustomRoleId) {
      setError("Select a custom role or choose a built-in role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addProjectMember(projectId, {
        userId: newUserId.trim(),
        role: newRole,
        customRoleId: newRole === "custom" ? newCustomRoleId : null
      });
      setNewUserId("");
      setNewCustomRoleId("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!window.confirm("Remove this member from the project?")) return;
    try {
      await removeProjectMember(projectId, userId);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const activeProject = projects.find((p) => p.id === projectId);

  return (
    <div className="settings-section">
      <h3>Project members</h3>
      <p className="settings-help">
        Project-level roles override a user's global role for that project. Use custom roles for finer-grained
        permissions.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <label htmlFor="project-select">Project</label>
      <select
        id="project-select"
        value={projectId}
        onChange={(event) => {
          setLoaded(false);
          setProjectId(event.target.value);
        }}
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>

      {activeProject && (
        <p className="settings-muted">
          Managing: <strong>{activeProject.name}</strong>
        </p>
      )}

      {canManage && (
        <div className="settings-card">
          <h4>Add member</h4>
          <label htmlFor="member-user-id">User ID (e.g. usr_…)</label>
          <input
            id="member-user-id"
            value={newUserId}
            onChange={(event) => setNewUserId(event.target.value)}
            placeholder="usr_AbCdEf…"
          />
          <label htmlFor="member-role">Role</label>
          <select id="member-role" value={newRole} onChange={(event) => setNewRole(event.target.value)}>
            {BUILT_IN_PROJECT_ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value="custom">Custom role…</option>
          </select>
          {newRole === "custom" && (
            <>
              <label htmlFor="member-custom-role">Custom role</label>
              <select
                id="member-custom-role"
                value={newCustomRoleId}
                onChange={(event) => setNewCustomRoleId(event.target.value)}
              >
                <option value="">Select a custom role…</option>
                {customRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="settings-actions">
            <button className="header-btn" onClick={handleAdd} disabled={busy || !newUserId.trim()}>
              Add member
            </button>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="settings-loading">Loading members…</div>
      ) : (
        <div className="settings-card">
          <h4>Members ({members.length})</h4>
          {members.length === 0 ? (
            <p className="settings-muted">No explicit members yet — users fall back to their global role.</p>
          ) : (
            <table className="settings-table">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.userId}>
                    <td>
                      <code>{member.userId}</code>
                    </td>
                    <td>
                      {member.role}
                      {member.customRoleId ? (
                        <span className="settings-chip">
                          {customRoles.find((r) => r.id === member.customRoleId)?.name ?? member.customRoleId}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <div className="settings-chips">
                        {member.permissions.map((permission) => (
                          <span key={permission} className="settings-chip">
                            {permission}
                          </span>
                        ))}
                      </div>
                    </td>
                    {canManage && (
                      <td>
                        <button className="mini-btn" onClick={() => handleRemove(member.userId)}>
                          Remove
                        </button>
                      </td>
                    )}
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

// ---------------------------------------------------------------------------
// Custom roles
// ---------------------------------------------------------------------------

function CustomRolesTab({
  projects,
  initialProjectId
}: {
  projects: Project[];
  initialProjectId: string;
}) {
  const [roles, setRoles] = useState<CustomRoleRecord[]>([]);
  const [availablePermissions, setAvailablePermissions] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string>(initialProjectId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchCustomRoles(projectId);
      setRoles(response.roles);
      setAvailablePermissions(response.availablePermissions);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const togglePermission = (permission: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || selectedPermissions.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await createCustomRole({
        name: name.trim(),
        description: description.trim() || null,
        projectId: projectId || null,
        permissions: Array.from(selectedPermissions)
      });
      setName("");
      setDescription("");
      setSelectedPermissions(new Set());
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this custom role? Members assigned to it will lose their custom permissions.")) return;
    try {
      await deleteCustomRole(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  return (
    <div className="settings-section">
      <h3>Custom roles</h3>
      <p className="settings-help">
        Custom roles let you compose a bundle of permissions. Scope a role to a specific project or leave it global to
        reuse across projects.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Create a custom role</h4>
        <label htmlFor="role-name">Name</label>
        <input id="role-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Runner" />
        <label htmlFor="role-description">Description (optional)</label>
        <input
          id="role-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Can read and execute workflows but not edit"
        />
        <label htmlFor="role-project">Scope</label>
        <select id="role-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Global (all projects)</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <label>Permissions</label>
        <div className="settings-permissions-grid">
          {availablePermissions.map((permission) => (
            <label key={permission} className="settings-permission-option">
              <input
                type="checkbox"
                checked={selectedPermissions.has(permission)}
                onChange={() => togglePermission(permission)}
              />
              <span>{permission}</span>
            </label>
          ))}
        </div>
        <div className="settings-actions">
          <button
            className="header-btn"
            onClick={handleCreate}
            disabled={busy || !name.trim() || selectedPermissions.size === 0}
          >
            Create role
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Existing custom roles</h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : roles.length === 0 ? (
          <p className="settings-muted">No custom roles yet.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Permissions</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <td>
                    {role.name}
                    {role.description && <div className="settings-muted">{role.description}</div>}
                  </td>
                  <td>{role.projectId ? projects.find((p) => p.id === role.projectId)?.name ?? role.projectId : "Global"}</td>
                  <td>
                    <div className="settings-chips">
                      {role.permissions.map((permission) => (
                        <span key={permission} className="settings-chip">
                          {permission}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <button className="mini-btn" onClick={() => handleDelete(role.id)}>
                      Delete
                    </button>
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

// ---------------------------------------------------------------------------
// SSO group mappings
// ---------------------------------------------------------------------------

function SsoMappingsTab({ projects }: { projects: Project[] }) {
  const [mappings, setMappings] = useState<SsoGroupMapping[]>([]);
  const [provider, setProvider] = useState<"saml" | "ldap">("saml");
  const [groupName, setGroupName] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [role, setRole] = useState<string>("viewer");
  const [customRoles, setCustomRoles] = useState<CustomRoleRecord[]>([]);
  const [customRoleId, setCustomRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [mappingsResponse, rolesResponse] = await Promise.all([
        fetchSsoMappings(),
        fetchCustomRoles()
      ]);
      setMappings(mappingsResponse.mappings);
      setCustomRoles(rolesResponse.roles);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!groupName.trim()) return;
    if (role === "custom" && !customRoleId) {
      setError("Select a custom role or pick a built-in role.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSsoMapping({
        provider,
        groupName: groupName.trim(),
        projectId: projectId || null,
        role,
        customRoleId: role === "custom" ? customRoleId : null
      });
      setGroupName("");
      setCustomRoleId("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this SSO mapping?")) return;
    try {
      await deleteSsoMapping(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const globalRoles = ["admin", "builder", "operator", "viewer"];
  const roleOptions = useMemo(() => {
    return projectId ? ["project_admin", "editor", "viewer"] : globalRoles;
  }, [projectId]);

  return (
    <div className="settings-section">
      <h3>SSO group-to-role mappings</h3>
      <p className="settings-help">
        When users log in via SAML or LDAP, their group memberships are matched against these rules. A mapping without
        a project assigns a global role; a mapping with a project creates a project-level membership on first login.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Add mapping</h4>
        <label htmlFor="sso-provider">Provider</label>
        <select
          id="sso-provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value as "saml" | "ldap")}
        >
          <option value="saml">SAML</option>
          <option value="ldap">LDAP</option>
        </select>
        <label htmlFor="sso-group">Group name</label>
        <input
          id="sso-group"
          value={groupName}
          onChange={(event) => setGroupName(event.target.value)}
          placeholder="engineering"
        />
        <label htmlFor="sso-project">Project (leave blank for global role)</label>
        <select id="sso-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Global</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <label htmlFor="sso-role">Role</label>
        <select id="sso-role" value={role} onChange={(event) => setRole(event.target.value)}>
          {roleOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          <option value="custom">Custom role…</option>
        </select>
        {role === "custom" && (
          <>
            <label htmlFor="sso-custom-role">Custom role</label>
            <select
              id="sso-custom-role"
              value={customRoleId}
              onChange={(event) => setCustomRoleId(event.target.value)}
            >
              <option value="">Select a custom role…</option>
              {customRoles
                .filter((r) => !projectId || r.projectId === projectId || r.projectId === null)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.projectId ? "" : "(global)"}
                  </option>
                ))}
            </select>
          </>
        )}
        <div className="settings-actions">
          <button className="header-btn" onClick={handleCreate} disabled={busy || !groupName.trim()}>
            Add mapping
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Existing mappings</h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : mappings.length === 0 ? (
          <p className="settings-muted">No mappings configured.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Group</th>
                <th>Project</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((mapping) => (
                <tr key={mapping.id}>
                  <td>{mapping.provider}</td>
                  <td>
                    <code>{mapping.groupName}</code>
                  </td>
                  <td>
                    {mapping.projectId
                      ? projects.find((p) => p.id === mapping.projectId)?.name ?? mapping.projectId
                      : "Global"}
                  </td>
                  <td>
                    {mapping.role}
                    {mapping.customRoleId && (
                      <span className="settings-chip">
                        {customRoles.find((r) => r.id === mapping.customRoleId)?.name ?? mapping.customRoleId}
                      </span>
                    )}
                  </td>
                  <td>
                    <button className="mini-btn" onClick={() => handleDelete(mapping.id)}>
                      Delete
                    </button>
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
