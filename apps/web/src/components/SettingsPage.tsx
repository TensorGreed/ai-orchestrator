import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import {
  activateMfa,
  addProjectMember,
  ApiError,
  auditExportUrl,
  createApiKey,
  createCustomRole,
  createExternalProvider,
  createLogStreamDestination,
  createSsoMapping,
  deleteCustomRole,
  deleteExternalProvider,
  deleteLogStreamDestination,
  deleteSsoMapping,
  disableMfa,
  enrollMfa,
  fetchApiKeys,
  fetchAuditLogs,
  fetchCustomRoles,
  fetchExternalProviders,
  fetchLogStreamDeliveryEvents,
  fetchLogStreamDestinations,
  fetchMfaStatus,
  fetchProjectMembers,
  fetchSecrets,
  fetchSsoMappings,
  removeProjectMember,
  revokeApiKey,
  testExternalProvider,
  testLogStreamDestination,
  updateExternalProvider,
  updateLogStreamDestination,
  type ApiKeyRecord,
  type AuditLogEntry,
  type AuditLogFilter,
  type AuthUser,
  type CustomRoleRecord,
  type ExternalSecretProviderRecord,
  type ExternalSecretProviderType,
  type LogLevel,
  type LogStreamDeliveryEvent,
  type LogStreamDestination,
  type LogStreamDestinationType,
  type MfaStatus,
  type ProjectMembership,
  type SecretListItem,
  type SsoGroupMapping
} from "../lib/api";

type SettingsTab =
  | "security"
  | "api-keys"
  | "members"
  | "roles"
  | "sso"
  | "external-secrets"
  | "audit-log"
  | "log-streams";

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
    { id: "sso", label: "SSO Mappings", restricted: !isAdmin },
    { id: "external-secrets", label: "External Secrets", restricted: !isAdmin },
    { id: "audit-log", label: "Audit Log", restricted: !isAdmin },
    { id: "log-streams", label: "Log Streams", restricted: !isAdmin }
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
        {tab === "external-secrets" && isAdmin && (
          <ExternalSecretsTab activeProjectId={activeProjectId} />
        )}
        {tab === "audit-log" && isAdmin && <AuditLogTab />}
        {tab === "log-streams" && isAdmin && <LogStreamsTab />}
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

// ---------------------------------------------------------------------------
// External Secrets
// ---------------------------------------------------------------------------

const EXTERNAL_PROVIDER_TYPES: Array<{ value: ExternalSecretProviderType; label: string; configHint: string }> = [
  {
    value: "aws-secrets-manager",
    label: "AWS Secrets Manager",
    configHint: '{"region": "us-east-1"} — credentials secret stores JSON {accessKeyId, secretAccessKey}'
  },
  {
    value: "hashicorp-vault",
    label: "HashiCorp Vault",
    configHint: '{"endpoint": "https://vault.example.com", "field": "value"} — credentials secret stores the Vault token'
  },
  {
    value: "google-secret-manager",
    label: "Google Secret Manager",
    configHint: '{"projectId": "my-gcp-project"} — credentials secret stores service-account JSON'
  },
  {
    value: "azure-key-vault",
    label: "Azure Key Vault",
    configHint: '{"vaultUrl": "https://my-vault.vault.azure.net"} — credentials secret stores {tenantId, clientId, clientSecret}'
  },
  {
    value: "mock",
    label: "Mock (testing only)",
    configHint: "{} — values are injected by tests"
  }
];

function ExternalSecretsTab({ activeProjectId }: { activeProjectId: string }) {
  const [providers, setProviders] = useState<ExternalSecretProviderRecord[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<ExternalSecretProviderType>("aws-secrets-manager");
  const [configJson, setConfigJson] = useState("{}");
  const [credentialsSecretId, setCredentialsSecretId] = useState("");
  const [cacheTtlMs, setCacheTtlMs] = useState("300000");
  const [testingKey, setTestingKey] = useState<Record<string, string>>({});
  const [testingResult, setTestingResult] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const typeHint = EXTERNAL_PROVIDER_TYPES.find((t) => t.value === type)?.configHint ?? "";

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [p, s] = await Promise.all([fetchExternalProviders(), fetchSecrets({ projectId: activeProjectId })]);
      setProviders(p.providers);
      setSecrets(s.filter((secret) => secret.source === undefined || secret.source === "local"));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, [activeProjectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let parsedConfig: Record<string, unknown>;
      try {
        parsedConfig = configJson.trim() ? (JSON.parse(configJson) as Record<string, unknown>) : {};
      } catch {
        setError("Config must be valid JSON");
        setBusy(false);
        return;
      }
      await createExternalProvider({
        name: name.trim(),
        type,
        config: parsedConfig,
        credentialsSecretId: credentialsSecretId || null,
        cacheTtlMs: cacheTtlMs.trim() ? Number(cacheTtlMs) : undefined
      });
      setName("");
      setConfigJson("{}");
      setCredentialsSecretId("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this external secret provider?")) return;
    setError(null);
    try {
      await deleteExternalProvider(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const handleToggle = async (provider: ExternalSecretProviderRecord) => {
    setError(null);
    try {
      await updateExternalProvider(provider.id, { enabled: !provider.enabled });
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const handleTest = async (providerId: string) => {
    const key = (testingKey[providerId] ?? "").trim();
    if (!key) {
      setTestingResult({ ...testingResult, [providerId]: "Enter a key to test" });
      return;
    }
    setTestingResult({ ...testingResult, [providerId]: "Testing…" });
    try {
      const response = await testExternalProvider(providerId, { key });
      setTestingResult({ ...testingResult, [providerId]: `Resolved (${response.length} chars)` });
    } catch (err) {
      setTestingResult({ ...testingResult, [providerId]: formatError(err) });
    }
  };

  return (
    <div className="settings-section">
      <h3>External secret providers</h3>
      <p className="settings-help">
        Register a connection to an external secret manager (AWS Secrets Manager, HashiCorp Vault, Google Secret
        Manager, Azure Key Vault). The provider's auth credentials live in a regular encrypted secret you create first.
        Values are cached per-provider according to <code>cacheTtlMs</code> so rotations propagate automatically.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Register provider</h4>
        <label htmlFor="esp-name">Name</label>
        <input id="esp-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="prod-aws" />
        <label htmlFor="esp-type">Type</label>
        <select
          id="esp-type"
          value={type}
          onChange={(event) => setType(event.target.value as ExternalSecretProviderType)}
        >
          {EXTERNAL_PROVIDER_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="settings-muted" style={{ fontSize: "0.8rem" }}>
          {typeHint}
        </p>
        <label htmlFor="esp-config">Config JSON</label>
        <textarea
          id="esp-config"
          value={configJson}
          onChange={(event) => setConfigJson(event.target.value)}
          rows={4}
          className="settings-textarea"
        />
        <label htmlFor="esp-credentials">Credentials secret (optional)</label>
        <select
          id="esp-credentials"
          value={credentialsSecretId}
          onChange={(event) => setCredentialsSecretId(event.target.value)}
        >
          <option value="">(none — use default credential chain)</option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name} — {secret.id}
            </option>
          ))}
        </select>
        <label htmlFor="esp-ttl">Cache TTL (ms)</label>
        <input
          id="esp-ttl"
          value={cacheTtlMs}
          onChange={(event) => setCacheTtlMs(event.target.value.replace(/\D/g, ""))}
          placeholder="300000"
          inputMode="numeric"
        />
        <div className="settings-actions">
          <button className="header-btn" onClick={handleCreate} disabled={busy || !name.trim()}>
            Register provider
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Registered providers ({providers.length})</h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : providers.length === 0 ? (
          <p className="settings-muted">No external providers yet.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Credentials</th>
                <th>TTL</th>
                <th>Enabled</th>
                <th>Test key</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <td>
                    <strong>{provider.name}</strong>
                    <div className="settings-muted">
                      <code>{provider.id}</code>
                    </div>
                  </td>
                  <td>{provider.type}</td>
                  <td>
                    {provider.credentialsSecretId ? (
                      <code>{provider.credentialsSecretId}</code>
                    ) : (
                      <span className="settings-muted">default</span>
                    )}
                  </td>
                  <td>{provider.cacheTtlMs} ms</td>
                  <td>
                    <button className="mini-btn" onClick={() => handleToggle(provider)}>
                      {provider.enabled ? "Disable" : "Enable"}
                    </button>
                  </td>
                  <td>
                    <input
                      placeholder="secret name / ARN"
                      value={testingKey[provider.id] ?? ""}
                      onChange={(event) =>
                        setTestingKey({ ...testingKey, [provider.id]: event.target.value })
                      }
                    />
                    <button className="mini-btn" onClick={() => handleTest(provider.id)}>
                      Test
                    </button>
                    {testingResult[provider.id] && (
                      <div className="settings-muted" style={{ fontSize: "0.75rem" }}>
                        {testingResult[provider.id]}
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="mini-btn" onClick={() => handleDelete(provider.id)}>
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
// Audit log
// ---------------------------------------------------------------------------

const AUDIT_CATEGORIES = [
  "auth",
  "mfa",
  "sso",
  "api_key",
  "secret",
  "external_secret",
  "workflow",
  "execution",
  "project",
  "rbac",
  "sharing",
  "system"
];

function AuditLogTab() {
  const [filter, setFilter] = useState<AuditLogFilter>({ page: 1, pageSize: 50 });
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchAuditLogs(filter);
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateFilter = (patch: Partial<AuditLogFilter>) => {
    setFilter((prev) => ({ ...prev, ...patch, page: 1 }));
  };

  const totalPages = Math.max(1, Math.ceil(total / (filter.pageSize ?? 50)));

  return (
    <div className="settings-section">
      <h3>Audit log</h3>
      <p className="settings-help">
        Comprehensive trail of authentication, credential, workflow, execution, sharing, and RBAC events. Retention is
        controlled by <code>AUDIT_LOG_RETENTION_DAYS</code>.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Filter</h4>
        <div className="settings-filter-grid">
          <div>
            <label htmlFor="audit-category">Category</label>
            <select
              id="audit-category"
              value={filter.category ?? ""}
              onChange={(event) => updateFilter({ category: event.target.value || undefined })}
            >
              <option value="">All</option>
              {AUDIT_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-outcome">Outcome</label>
            <select
              id="audit-outcome"
              value={filter.outcome ?? ""}
              onChange={(event) => updateFilter({ outcome: event.target.value || undefined })}
            >
              <option value="">All</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <div>
            <label htmlFor="audit-actor">Actor user ID</label>
            <input
              id="audit-actor"
              value={filter.actorUserId ?? ""}
              onChange={(event) => updateFilter({ actorUserId: event.target.value || undefined })}
            />
          </div>
          <div>
            <label htmlFor="audit-resource">Resource type</label>
            <input
              id="audit-resource"
              value={filter.resourceType ?? ""}
              onChange={(event) => updateFilter({ resourceType: event.target.value || undefined })}
            />
          </div>
          <div>
            <label htmlFor="audit-from">From (ISO)</label>
            <input
              id="audit-from"
              value={filter.from ?? ""}
              onChange={(event) => updateFilter({ from: event.target.value || undefined })}
              placeholder="2026-01-01T00:00:00Z"
            />
          </div>
          <div>
            <label htmlFor="audit-to">To (ISO)</label>
            <input
              id="audit-to"
              value={filter.to ?? ""}
              onChange={(event) => updateFilter({ to: event.target.value || undefined })}
              placeholder="2026-12-31T23:59:59Z"
            />
          </div>
        </div>
        <div className="settings-actions">
          <button className="header-btn" onClick={() => setFilter({ page: 1, pageSize: 50 })}>
            Reset filters
          </button>
          <a className="header-btn" href={auditExportUrl(filter)} target="_blank" rel="noreferrer">
            Export CSV
          </a>
        </div>
      </div>

      <div className="settings-card">
        <h4>
          Entries ({total}) — page {filter.page ?? 1} of {totalPages}
        </h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : items.length === 0 ? (
          <p className="settings-muted">No audit events match your filters.</p>
        ) : (
          <div className="settings-audit-scroll">
            <table className="settings-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Category</th>
                  <th>Event</th>
                  <th>Outcome</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th>Metadata</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>
                      <span className="settings-chip">{item.category}</span>
                    </td>
                    <td>
                      <code>{item.eventType}</code>
                    </td>
                    <td>
                      <span
                        className={
                          item.outcome === "success" ? "settings-chip" : "settings-chip settings-chip-danger"
                        }
                      >
                        {item.outcome}
                      </span>
                    </td>
                    <td>{item.actorEmail ?? item.actorUserId ?? item.actorType ?? "—"}</td>
                    <td>
                      {item.resourceType && <div className="settings-muted">{item.resourceType}</div>}
                      {item.resourceId && <code>{item.resourceId}</code>}
                    </td>
                    <td>
                      {item.metadata ? (
                        <details>
                          <summary>inspect</summary>
                          <pre className="settings-audit-metadata">{JSON.stringify(item.metadata, null, 2)}</pre>
                        </details>
                      ) : (
                        <span className="settings-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="settings-actions">
          <button
            className="header-btn ghost"
            onClick={() => setFilter((prev) => ({ ...prev, page: Math.max(1, (prev.page ?? 1) - 1) }))}
            disabled={(filter.page ?? 1) <= 1}
          >
            ← Prev
          </button>
          <button
            className="header-btn ghost"
            onClick={() =>
              setFilter((prev) => ({ ...prev, page: Math.min(totalPages, (prev.page ?? 1) + 1) }))
            }
            disabled={(filter.page ?? 1) >= totalPages}
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log streams (Phase 5.5)
// ---------------------------------------------------------------------------

const LOG_STREAM_TYPES: Array<{
  value: LogStreamDestinationType;
  label: string;
  hint: string;
  sampleConfig: string;
}> = [
  {
    value: "syslog",
    label: "Syslog (RFC 5424)",
    hint: "Streams each event as an RFC 5424 message over UDP or TCP.",
    sampleConfig: JSON.stringify(
      { host: "syslog.example.com", port: 514, transport: "udp", facility: 16, appName: "ai-orchestrator" },
      null,
      2
    )
  },
  {
    value: "webhook",
    label: "HTTP webhook",
    hint: "POSTs JSON to a URL. Optional HMAC signing and custom headers.",
    sampleConfig: JSON.stringify(
      {
        url: "https://logs.example.com/ingest",
        method: "POST",
        headers: { "x-source": "ai-orchestrator" },
        hmacSecret: "change-me",
        hmacHeader: "x-ao-signature"
      },
      null,
      2
    )
  },
  {
    value: "sentry",
    label: "Sentry",
    hint: "Sends events to a Sentry project via a classic DSN.",
    sampleConfig: JSON.stringify(
      { dsn: "https://<key>@o12345.ingest.sentry.io/67890", environment: "production" },
      null,
      2
    )
  }
];

const LOG_STREAM_CATEGORIES = [
  "auth",
  "mfa",
  "sso",
  "api_key",
  "secret",
  "external_secret",
  "workflow",
  "execution",
  "project",
  "rbac",
  "sharing",
  "system"
];

function LogStreamsTab() {
  const [destinations, setDestinations] = useState<LogStreamDestination[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<LogStreamDestinationType>("webhook");
  const [minLevel, setMinLevel] = useState<LogLevel>("info");
  const [categoriesInput, setCategoriesInput] = useState<string[]>([]);
  const [configJson, setConfigJson] = useState(
    LOG_STREAM_TYPES.find((t) => t.value === "webhook")!.sampleConfig
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [expandedEvents, setExpandedEvents] = useState<Record<string, LogStreamDeliveryEvent[] | "loading">>({});

  const typeMeta = LOG_STREAM_TYPES.find((t) => t.value === type);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchLogStreamDestinations();
      setDestinations(response.destinations);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleTypeChange = (next: LogStreamDestinationType) => {
    setType(next);
    const meta = LOG_STREAM_TYPES.find((t) => t.value === next);
    if (meta) setConfigJson(meta.sampleConfig);
  };

  const toggleCategory = (category: string) => {
    setCategoriesInput((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      let parsedConfig: Record<string, unknown>;
      try {
        parsedConfig = JSON.parse(configJson) as Record<string, unknown>;
      } catch {
        setError("Config must be valid JSON");
        setBusy(false);
        return;
      }
      await createLogStreamDestination({
        name: name.trim(),
        type,
        minLevel,
        categories: categoriesInput,
        config: parsedConfig
      });
      setName("");
      setCategoriesInput([]);
      if (typeMeta) setConfigJson(typeMeta.sampleConfig);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (dest: LogStreamDestination) => {
    setError(null);
    try {
      await updateLogStreamDestination(dest.id, { enabled: !dest.enabled });
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this log stream destination?")) return;
    setError(null);
    try {
      await deleteLogStreamDestination(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    }
  };

  const handleTest = async (id: string) => {
    setTestResult((prev) => ({ ...prev, [id]: "Sending…" }));
    try {
      const response = await testLogStreamDestination(id);
      setTestResult((prev) => ({
        ...prev,
        [id]: response.ok ? "✓ delivered" : `✗ ${response.error ?? "failed"}`
      }));
      await refresh();
    } catch (err) {
      setTestResult((prev) => ({ ...prev, [id]: `✗ ${formatError(err)}` }));
    }
  };

  const handleToggleEvents = async (id: string) => {
    if (expandedEvents[id]) {
      setExpandedEvents((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    setExpandedEvents((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const response = await fetchLogStreamDeliveryEvents(id);
      setExpandedEvents((prev) => ({ ...prev, [id]: response.events }));
    } catch (err) {
      setExpandedEvents((prev) => ({ ...prev, [id]: [] }));
      setError(formatError(err));
    }
  };

  return (
    <div className="settings-section">
      <h3>Log streaming destinations</h3>
      <p className="settings-help">
        Forward audit, workflow, and system events to external log systems. Every destination encrypts
        its config at rest, streams asynchronously, and tracks success/failure counters plus recent
        delivery events for debugging. Leave categories empty to send every event.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Register destination</h4>
        <label htmlFor="lsd-name">Name</label>
        <input id="lsd-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="prod-syslog" />
        <label htmlFor="lsd-type">Type</label>
        <select
          id="lsd-type"
          value={type}
          onChange={(event) => handleTypeChange(event.target.value as LogStreamDestinationType)}
        >
          {LOG_STREAM_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="settings-muted" style={{ fontSize: "0.8rem" }}>
          {typeMeta?.hint}
        </p>
        <label htmlFor="lsd-min-level">Minimum level</label>
        <select id="lsd-min-level" value={minLevel} onChange={(event) => setMinLevel(event.target.value as LogLevel)}>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <label>Categories</label>
        <div className="settings-permissions-grid">
          {LOG_STREAM_CATEGORIES.map((category) => (
            <label key={category} className="settings-permission-option">
              <input
                type="checkbox"
                checked={categoriesInput.includes(category)}
                onChange={() => toggleCategory(category)}
              />
              {category}
            </label>
          ))}
        </div>
        <p className="settings-muted" style={{ fontSize: "0.75rem" }}>
          {categoriesInput.length === 0
            ? "No filter — all categories will be forwarded."
            : `Filtering to ${categoriesInput.length} categor${categoriesInput.length === 1 ? "y" : "ies"}.`}
        </p>
        <label htmlFor="lsd-config">Config JSON</label>
        <textarea
          id="lsd-config"
          value={configJson}
          onChange={(event) => setConfigJson(event.target.value)}
          rows={8}
          className="settings-textarea"
        />
        <div className="settings-actions">
          <button className="header-btn" onClick={handleCreate} disabled={busy || !name.trim()}>
            Register destination
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Registered destinations ({destinations.length})</h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : destinations.length === 0 ? (
          <p className="settings-muted">No log stream destinations yet.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Min level</th>
                <th>Categories</th>
                <th>Dispatched / Failed</th>
                <th>Last success</th>
                <th>Last error</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {destinations.map((dest) => {
                const events = expandedEvents[dest.id];
                return (
                  <Fragment key={dest.id}>
                    <tr>
                      <td>
                        <strong>{dest.name}</strong>
                        <div className="settings-muted">
                          <code>{dest.id}</code>
                        </div>
                      </td>
                      <td>{dest.type}</td>
                      <td>{dest.minLevel}</td>
                      <td>
                        {dest.categories.length === 0 ? (
                          <span className="settings-muted">all</span>
                        ) : (
                          <span className="settings-muted">{dest.categories.join(", ")}</span>
                        )}
                      </td>
                      <td>
                        {dest.dispatchedCount} / {dest.failedCount}
                      </td>
                      <td>{formatDate(dest.lastSuccessAt)}</td>
                      <td>
                        {dest.lastError ? (
                          <span className="settings-muted" title={dest.lastError}>
                            {dest.lastError.length > 40
                              ? `${dest.lastError.slice(0, 40)}…`
                              : dest.lastError}
                          </span>
                        ) : (
                          <span className="settings-muted">—</span>
                        )}
                      </td>
                      <td>
                        <button className="mini-btn" onClick={() => handleToggle(dest)}>
                          {dest.enabled ? "Disable" : "Enable"}
                        </button>
                      </td>
                      <td>
                        <button className="mini-btn" onClick={() => handleTest(dest.id)}>
                          Test
                        </button>
                        <button className="mini-btn" onClick={() => handleToggleEvents(dest.id)}>
                          {events ? "Hide events" : "Events"}
                        </button>
                        <button className="mini-btn" onClick={() => handleDelete(dest.id)}>
                          Delete
                        </button>
                        {testResult[dest.id] && (
                          <div className="settings-muted" style={{ fontSize: "0.75rem" }}>
                            {testResult[dest.id]}
                          </div>
                        )}
                      </td>
                    </tr>
                    {events && (
                      <tr>
                        <td colSpan={9}>
                          {events === "loading" ? (
                            <div className="settings-loading">Loading events…</div>
                          ) : events.length === 0 ? (
                            <p className="settings-muted">No delivery events recorded yet.</p>
                          ) : (
                            <table className="settings-table">
                              <thead>
                                <tr>
                                  <th>Time</th>
                                  <th>Category</th>
                                  <th>Event</th>
                                  <th>Level</th>
                                  <th>Status</th>
                                  <th>Attempts</th>
                                  <th>Error</th>
                                </tr>
                              </thead>
                              <tbody>
                                {events.map((event) => (
                                  <tr key={event.id}>
                                    <td>{formatDate(event.createdAt)}</td>
                                    <td>{event.category}</td>
                                    <td>{event.eventType}</td>
                                    <td>{event.level}</td>
                                    <td>{event.status}</td>
                                    <td>{event.attempts}</td>
                                    <td>
                                      {event.error ? (
                                        <span className="settings-muted">{event.error}</span>
                                      ) : (
                                        <span className="settings-muted">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
