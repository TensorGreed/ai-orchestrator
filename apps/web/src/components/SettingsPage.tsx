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
  createVariable,
  deleteCustomRole,
  deleteExternalProvider,
  deleteLogStreamDestination,
  deleteSsoMapping,
  deleteVariable,
  disableMfa,
  disconnectGit,
  enrollMfa,
  fetchApiKeys,
  fetchAuditLogs,
  fetchCustomRoles,
  fetchExternalProviders,
  fetchGitConfig,
  fetchLogStreamDeliveryEvents,
  fetchMcpPresets,
  fetchObservability,
  fetchRecentTraces,
  fetchLogStreamDestinations,
  fetchMfaStatus,
  fetchProjectMembers,
  fetchSecrets,
  fetchSsoMappings,
  fetchVariables,
  pullGit,
  pushGit,
  removeProjectMember,
  revokeApiKey,
  testExternalProvider,
  testLogStreamDestination,
  updateExternalProvider,
  updateGitConfig,
  updateLogStreamDestination,
  updateVariable,
  type ApiKeyRecord,
  type AuditLogEntry,
  type AuditLogFilter,
  type AuthUser,
  type CustomRoleRecord,
  type ExternalSecretProviderRecord,
  type ExternalSecretProviderType,
  type GitConfigRecord,
  type GitStatusRecord,
  type GitSyncResult,
  type MetricsSnapshot,
  type TraceSpan,
  type LogLevel,
  type LogStreamDeliveryEvent,
  type LogStreamDestination,
  type LogStreamDestinationType,
  type MfaStatus,
  type ProjectMembership,
  type McpPreset,
  type SecretListItem,
  type SsoGroupMapping,
  type VariableRecord,
  deleteNotificationConfig,
  fetchNotificationConfigs,
  testNotificationConfig,
  upsertNotificationConfig,
  type NotificationConfig,
  fetchCommunityNodes,
  installCommunityNode,
  uninstallCommunityNode,
  reloadCommunityNodes,
  type CommunityNodesStatus,
  type CommunityNodePackageState,
  fetchEvalDatasets,
  createEvalDataset,
  deleteEvalDataset,
  fetchEvalFixtures,
  createEvalFixture,
  deleteEvalFixture,
  startEvalRun,
  fetchEvalRuns,
  fetchEvalRun,
  fetchWorkflows,
  type EvalDataset,
  type EvalFixture,
  type EvalRun,
  type EvalResult,
  fetchUsageTotals,
  fetchUsageRollup,
  fetchRecentUsage,
  type UsageGroupBy,
  type UsageRollupRow,
  type UsageTotals,
  type UsageEvent,
  fetchBudgets,
  createBudget,
  updateBudget,
  deleteBudgetApi,
  fetchBudgetAlerts,
  type Budget,
  type BudgetAlert,
  type BudgetScopeType,
  type BudgetPeriod,
  type BudgetLimitType,
  type BudgetAction,
  verifyAuditChain,
  fetchAuditExportDestinations,
  createAuditExportDestination,
  deleteAuditExportDestination,
  runAuditExportDestination,
  type AuditChainStatus,
  type AuditExportDestination
} from "../lib/api";

type SettingsTab =
  | "security"
  | "api-keys"
  | "members"
  | "roles"
  | "sso"
  | "external-secrets"
  | "audit-log"
  | "log-streams"
  | "source-control"
  | "variables"
  | "observability"
  | "notifications"
  | "mcp-servers"
  | "community-nodes"
  | "evals"
  | "finops";

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
    { id: "log-streams", label: "Log Streams", restricted: !isAdmin },
    { id: "source-control", label: "Source Control", restricted: !isAdmin },
    { id: "variables", label: "Variables" },
    { id: "observability", label: "Observability", restricted: !isAdmin },
    { id: "notifications", label: "Notifications", restricted: !isAdmin },
    { id: "mcp-servers", label: "MCP Servers" },
    { id: "community-nodes", label: "Community Nodes", restricted: !isAdmin },
    { id: "evals", label: "Evals" },
    { id: "finops", label: "FinOps", restricted: !isAdmin }
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
        {tab === "source-control" && isAdmin && <SourceControlTab />}
        {tab === "variables" && (
          <VariablesTab projects={projects} initialProjectId={activeProjectId} isAdmin={isAdmin} />
        )}
        {tab === "observability" && isAdmin && <ObservabilityTab />}
        {tab === "notifications" && isAdmin && <NotificationsTab />}
        {tab === "mcp-servers" && <McpServersTab />}
        {tab === "community-nodes" && isAdmin && <CommunityNodesTab />}
        {tab === "evals" && <EvalsTab />}
        {tab === "finops" && isAdmin && <FinOpsTab />}
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

      <AuditChainPanel />
      <AuditExportPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.4 — audit chain + export destinations
// ---------------------------------------------------------------------------

function AuditChainPanel() {
  const [status, setStatus] = useState<AuditChainStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await verifyAuditChain());
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="settings-card" style={{ marginTop: "1rem" }}>
      <h4>Tamper-evidence (hash chain)</h4>
      <p className="settings-help">
        Every audit row stores <code>SHA-256(prev_hash + canonical_payload)</code>. Verification recomputes the chain and reports the first broken link.
      </p>
      <div className="settings-actions">
        <button type="button" className="header-btn primary" onClick={() => void handleVerify()} disabled={busy}>
          {busy ? "Verifying…" : "Verify chain integrity"}
        </button>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {status && (
        <div className="settings-help" style={{ marginTop: "0.5rem" }}>
          {status.ok ? (
            <span style={{ color: "#16a34a" }}>✓ Chain intact — verified {status.rowsChecked} rows.</span>
          ) : (
            <span style={{ color: "#dc2626" }}>
              ✗ Chain broken at row {status.firstBrokenAt?.id} ({status.firstBrokenAt?.createdAt}). Rows verified before break: {status.rowsChecked}.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function AuditExportPanel() {
  const [destinations, setDestinations] = useState<AuditExportDestination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAuditExportDestinations();
      setDestinations(r.destinations);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleRunNow = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const result = await runAuditExportDestination(id);
      window.alert(`Export ${result.outcome.status}: ${result.outcome.rowsExported} rows`);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (dest: AuditExportDestination) => {
    if (!window.confirm(`Delete export destination "${dest.name}"?`)) return;
    setBusy(true);
    try {
      await deleteAuditExportDestination(dest.id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <div className="settings-card" style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={{ margin: 0 }}>Export destinations</h4>
        <button type="button" className="header-btn primary" onClick={() => setShowCreate((v) => !v)} disabled={busy}>
          {showCreate ? "Cancel" : "+ New destination"}
        </button>
      </div>
      <p className="settings-help">
        Cursor-based bulk export of audit rows to long-term sinks. Each NDJSON record carries <code>entryHash</code> so consumers can re-verify the chain. Set <code>AUDIT_EXPORT_ENABLED=true</code> for scheduled runs; "Run now" works regardless.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {showCreate && <CreateAuditExportForm onCreated={async () => { setShowCreate(false); await refresh(); }} onError={setError} />}

      {loading ? (
        <p className="settings-help">Loading…</p>
      ) : destinations.length === 0 ? (
        <p className="settings-help">No export destinations configured.</p>
      ) : (
        <table className="finops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Interval</th>
              <th>Last export</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {destinations.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.kind}</td>
                <td>{d.intervalSeconds}s</td>
                <td>{d.lastExportAt ? formatDate(d.lastExportAt) : "—"}</td>
                <td>{d.lastStatus ?? "—"}{d.lastError && <div className="settings-error" style={{ fontSize: "0.7rem" }}>{d.lastError}</div>}</td>
                <td style={{ display: "flex", gap: "0.4rem" }}>
                  <button type="button" className="header-btn ghost" onClick={() => void handleRunNow(d.id)} disabled={busy}>Run now</button>
                  <button type="button" className="finops-delete" onClick={() => void handleDelete(d)} disabled={busy}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CreateAuditExportForm({ onCreated, onError }: { onCreated: () => Promise<void>; onError: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "file">("http");
  const [intervalSeconds, setIntervalSeconds] = useState("3600");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [filePath, setFilePath] = useState("apps/api/data/audit-export.ndjson");
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      let config: Record<string, unknown>;
      if (kind === "http") {
        config = { url: url.trim() };
        if (headers.trim()) {
          const parsed: Record<string, string> = {};
          for (const line of headers.split("\n")) {
            const idx = line.indexOf(":");
            if (idx > 0) parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
          config.headers = parsed;
        }
      } else {
        config = { path: filePath.trim() };
      }
      await createAuditExportDestination({
        name: name.trim(),
        kind,
        config,
        intervalSeconds: Number(intervalSeconds)
      });
      await onCreated();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [name, kind, url, headers, filePath, intervalSeconds, onCreated, onError]);

  return (
    <form onSubmit={handleSubmit} className="finops-create-form">
      <div className="finops-form-row finops-form-row-2">
        <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Datadog Logs" /></label>
        <label>Interval (seconds)<input type="number" min="60" value={intervalSeconds} onChange={(e) => setIntervalSeconds(e.target.value)} /></label>
      </div>
      <div className="finops-form-row">
        <label>Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as "http" | "file")}>
            <option value="http">HTTP (POST NDJSON)</option>
            <option value="file">File (append NDJSON)</option>
          </select>
        </label>
      </div>
      {kind === "http" ? (
        <>
          <div className="finops-form-row">
            <label>URL<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://http-intake.logs.datadoghq.com/api/v2/logs" /></label>
          </div>
          <div className="finops-form-row">
            <label>Headers (one per line, "Name: value")
              <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} placeholder="DD-API-KEY: abc123" />
            </label>
          </div>
        </>
      ) : (
        <div className="finops-form-row">
          <label>Path (must live under <code>AUDIT_EXPORT_FILE_ROOT</code>)
            <input type="text" value={filePath} onChange={(e) => setFilePath(e.target.value)} required />
          </label>
        </div>
      )}
      <div className="finops-form-row">
        <button type="submit" disabled={busy} className="header-btn primary">{busy ? "Saving…" : "Create destination"}</button>
      </div>
    </form>
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

// ---------------------------------------------------------------------------
// Source control (Phase 5.6)
// ---------------------------------------------------------------------------

function SourceControlTab() {
  const [config, setConfig] = useState<GitConfigRecord | null>(null);
  const [status, setStatus] = useState<GitStatusRecord | null>(null);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [workflowsDir, setWorkflowsDir] = useState("workflows");
  const [variablesFile, setVariablesFile] = useState("variables.json");
  const [authSecretId, setAuthSecretId] = useState("");
  const [userName, setUserName] = useState("ai-orchestrator");
  const [userEmail, setUserEmail] = useState("sync@ai-orchestrator.local");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [lastResult, setLastResult] = useState<GitSyncResult | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [gitResponse, secretList] = await Promise.all([fetchGitConfig(), fetchSecrets({})]);
      setConfig(gitResponse.config);
      setStatus(gitResponse.status);
      setSecrets(secretList);
      if (gitResponse.config) {
        setRepoUrl(gitResponse.config.repoUrl);
        setDefaultBranch(gitResponse.config.defaultBranch);
        setWorkflowsDir(gitResponse.config.workflowsDir);
        setVariablesFile(gitResponse.config.variablesFile);
        setAuthSecretId(gitResponse.config.authSecretId ?? "");
        setUserName(gitResponse.config.userName);
        setUserEmail(gitResponse.config.userEmail);
        setEnabled(gitResponse.config.enabled);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    if (!repoUrl.trim()) {
      setError("Repo URL is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await updateGitConfig({
        repoUrl: repoUrl.trim(),
        defaultBranch: defaultBranch.trim() || "main",
        workflowsDir: workflowsDir.trim() || "workflows",
        variablesFile: variablesFile.trim() || "variables.json",
        authSecretId: authSecretId || null,
        userName: userName.trim(),
        userEmail: userEmail.trim(),
        enabled
      });
      setConfig(response.config);
      setStatus(response.status);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm("Disconnect git and clear the local mirror?")) return;
    setBusy(true);
    try {
      await disconnectGit();
      await refresh();
      setConfig(null);
      setLastResult(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await pushGit({ branch: defaultBranch });
      setLastResult(result);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePull = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await pullGit({ branch: defaultBranch });
      setLastResult(result);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <h3>Git source control</h3>
      <p className="settings-help">
        Back every workflow and variable into a git repository. Push serialises each workflow as
        JSON with credential stubs (secret names, not IDs) so exports are safe to commit. Pull
        replays the repo into the local database, mapping stubs back to local secrets by name.
        Branch-per-environment is supported: set the default branch (e.g. <code>main</code>,{" "}
        <code>staging</code>) and override per push/pull.
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <h4>Configuration</h4>
        <label htmlFor="git-repo">Repo URL</label>
        <input
          id="git-repo"
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          placeholder="https://github.com/your-org/workflows.git"
        />
        <label htmlFor="git-branch">Default branch (environment)</label>
        <input
          id="git-branch"
          value={defaultBranch}
          onChange={(event) => setDefaultBranch(event.target.value)}
          placeholder="main"
        />
        <label htmlFor="git-workflows-dir">Workflows directory</label>
        <input
          id="git-workflows-dir"
          value={workflowsDir}
          onChange={(event) => setWorkflowsDir(event.target.value)}
        />
        <label htmlFor="git-vars-file">Variables file</label>
        <input
          id="git-vars-file"
          value={variablesFile}
          onChange={(event) => setVariablesFile(event.target.value)}
        />
        <label htmlFor="git-auth">Auth secret (optional)</label>
        <select id="git-auth" value={authSecretId} onChange={(event) => setAuthSecretId(event.target.value)}>
          <option value="">(none — repo must be public or embed token in URL)</option>
          {secrets.map((secret) => (
            <option key={secret.id} value={secret.id}>
              {secret.name} — {secret.id}
            </option>
          ))}
        </select>
        <label htmlFor="git-user-name">Commit author name</label>
        <input
          id="git-user-name"
          value={userName}
          onChange={(event) => setUserName(event.target.value)}
        />
        <label htmlFor="git-user-email">Commit author email</label>
        <input
          id="git-user-email"
          value={userEmail}
          onChange={(event) => setUserEmail(event.target.value)}
        />
        <label className="settings-permission-option">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Sync enabled
        </label>
        <div className="settings-actions">
          <button className="header-btn" onClick={handleSave} disabled={busy || !repoUrl.trim()}>
            {config ? "Update" : "Connect"}
          </button>
          {config && (
            <button className="header-btn ghost" onClick={handleDisconnect} disabled={busy}>
              Disconnect
            </button>
          )}
        </div>
      </div>

      {loaded && config && (
        <div className="settings-card">
          <h4>Sync</h4>
          <p className="settings-muted">
            Branch: <code>{status?.branch ?? config.defaultBranch}</code>
            {" · "}Last push: {formatDate(config.lastPushAt)}
            {" · "}Last pull: {formatDate(config.lastPullAt)}
            {status?.dirty ? " · pending local changes" : ""}
          </p>
          {config.lastError && <div className="settings-error">Last error: {config.lastError}</div>}
          <div className="settings-actions">
            <button className="header-btn" onClick={handlePush} disabled={busy}>
              Push
            </button>
            <button className="header-btn ghost" onClick={handlePull} disabled={busy}>
              Pull
            </button>
          </div>
          {lastResult && (
            <p className="settings-muted" style={{ fontSize: "0.85rem", marginTop: "8px" }}>
              {lastResult.ok
                ? `✓ ${lastResult.workflowsExported !== undefined ? `Exported ${lastResult.workflowsExported} workflow(s)` : ""}${
                    lastResult.workflowsImported !== undefined ? `Imported ${lastResult.workflowsImported} workflow(s)` : ""
                  } · ${lastResult.variablesSynced ?? 0} variable(s) · commit ${lastResult.commit?.slice(0, 8) ?? "—"}`
                : `✗ ${lastResult.error ?? "failed"}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variables (Phase 5.6)
// ---------------------------------------------------------------------------

function VariablesTab({
  projects,
  initialProjectId,
  isAdmin
}: {
  projects: Project[];
  initialProjectId: string;
  isAdmin: boolean;
}) {
  const [projectId, setProjectId] = useState(initialProjectId);
  const [variables, setVariables] = useState<VariableRecord[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  void isAdmin;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchVariables(projectId);
      setVariables(response.variables);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!newKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createVariable({ projectId, key: newKey.trim(), value: newValue });
      setNewKey("");
      setNewValue("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await updateVariable(id, { value: editValue });
      setEditingId(null);
      setEditValue("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this variable?")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteVariable(id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <h3>Project variables</h3>
      <p className="settings-help">
        Plain-text key/value pairs exposed to every workflow in this project as{" "}
        <code>{'{{vars.KEY}}'}</code>. Not secrets — use the Secrets manager for credentials.
        Variables are included in git pushes/pulls (stored at the repository root).
      </p>
      {error && <div className="settings-error">{error}</div>}

      <div className="settings-card">
        <label htmlFor="var-project">Project</label>
        <select id="var-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-card">
        <h4>Add variable</h4>
        <label htmlFor="var-key">Key</label>
        <input
          id="var-key"
          value={newKey}
          onChange={(event) => setNewKey(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
          placeholder="API_BASE_URL"
        />
        <label htmlFor="var-value">Value</label>
        <textarea
          id="var-value"
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          rows={3}
          className="settings-textarea"
        />
        <div className="settings-actions">
          <button className="header-btn" onClick={handleCreate} disabled={busy || !newKey.trim()}>
            Add variable
          </button>
        </div>
      </div>

      <div className="settings-card">
        <h4>Variables ({variables.length})</h4>
        {!loaded ? (
          <div className="settings-loading">Loading…</div>
        ) : variables.length === 0 ? (
          <p className="settings-muted">No variables yet in this project.</p>
        ) : (
          <table className="settings-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {variables.map((variable) => (
                <tr key={variable.id}>
                  <td>
                    <code>{variable.key}</code>
                  </td>
                  <td>
                    {editingId === variable.id ? (
                      <textarea
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        rows={2}
                        className="settings-textarea"
                      />
                    ) : (
                      <span
                        className="settings-muted"
                        style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                      >
                        {variable.value.length > 80
                          ? `${variable.value.slice(0, 80)}…`
                          : variable.value || "—"}
                      </span>
                    )}
                  </td>
                  <td>{formatDate(variable.updatedAt)}</td>
                  <td>
                    {editingId === variable.id ? (
                      <>
                        <button
                          className="mini-btn"
                          onClick={() => handleSaveEdit(variable.id)}
                          disabled={busy}
                        >
                          Save
                        </button>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            setEditingId(null);
                            setEditValue("");
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="mini-btn"
                          onClick={() => {
                            setEditingId(variable.id);
                            setEditValue(variable.value);
                          }}
                        >
                          Edit
                        </button>
                        <button className="mini-btn" onClick={() => handleDelete(variable.id)}>
                          Delete
                        </button>
                      </>
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
// Observability (Phase 5.7)
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function ObservabilityTab() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [tracingEnabled, setTracingEnabled] = useState(false);
  const [traces, setTraces] = useState<TraceSpan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [obs, trace] = await Promise.all([
        fetchObservability(),
        fetchRecentTraces(50).catch(() => ({ spans: [] as TraceSpan[] }))
      ]);
      setSnapshot(obs.metrics);
      setTracingEnabled(obs.tracing.enabled);
      setTraces(trace.spans);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 10000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  if (!loaded) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading observability…</div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3>Observability &amp; metrics</h3>
      <p className="settings-help">
        Live metrics from this instance. Prometheus scrape endpoint: <code>GET /metrics</code>.
        Import the Grafana dashboard template from{" "}
        <code>ops/grafana/ai-orchestrator-dashboard.json</code> for a ready-made view of throughput,
        latency, SLOs, and process health.
      </p>
      {error && <div className="settings-error">{error}</div>}

      {snapshot && (
        <>
          <div className="settings-card">
            <h4>SLO status</h4>
            <div
              className="settings-permissions-grid"
              style={{ gridTemplateColumns: "repeat(2, 1fr)" }}
            >
              <div>
                <strong>Success rate</strong>
                <div className="settings-muted">
                  {(snapshot.slo.currentSuccessRate * 100).toFixed(2)}% (target{" "}
                  {(snapshot.slo.successTarget * 100).toFixed(2)}%)
                </div>
                <div className="settings-muted" style={{ fontSize: "0.75rem" }}>
                  Budget remaining: {(snapshot.slo.successBudgetRemaining * 100).toFixed(2)}%
                </div>
              </div>
              <div>
                <strong>p95 latency</strong>
                <div className="settings-muted">
                  {snapshot.slo.currentP95LatencyMs} ms (target {snapshot.slo.p95LatencyTargetMs} ms)
                </div>
                <div className="settings-muted" style={{ fontSize: "0.75rem" }}>
                  Budget remaining: {snapshot.slo.latencyBudgetRemaining} ms
                </div>
              </div>
            </div>
            <div style={{ marginTop: "10px" }}>
              <span
                className="settings-chip"
                style={{
                  background: snapshot.slo.healthy ? "#dcfce7" : "#fee2e2",
                  color: snapshot.slo.healthy ? "#166534" : "#991b1b",
                  borderColor: snapshot.slo.healthy ? "#86efac" : "#fca5a5"
                }}
              >
                {snapshot.slo.healthy ? "SLOs healthy" : "SLOs breached"}
              </span>
            </div>
          </div>

          <div className="settings-card">
            <h4>Execution metrics</h4>
            <table className="settings-table">
              <tbody>
                <tr>
                  <td>Total executions</td>
                  <td>{snapshot.executionsTotal}</td>
                </tr>
                <tr>
                  <td>Successful</td>
                  <td>{snapshot.executionsSuccess}</td>
                </tr>
                <tr>
                  <td>Failed / canceled</td>
                  <td>{snapshot.executionsFailure}</td>
                </tr>
                <tr>
                  <td>Active executions</td>
                  <td>{snapshot.activeExecutions}</td>
                </tr>
                <tr>
                  <td>Latency p50 / p95 / p99</td>
                  <td>
                    {snapshot.executionP50Ms} / {snapshot.executionP95Ms} / {snapshot.executionP99Ms} ms
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="settings-card">
            <h4>HTTP metrics</h4>
            <table className="settings-table">
              <tbody>
                <tr>
                  <td>Total requests</td>
                  <td>{snapshot.httpRequestsTotal}</td>
                </tr>
                <tr>
                  <td>Latency p50 / p95</td>
                  <td>
                    {snapshot.httpP50Ms} / {snapshot.httpP95Ms} ms
                  </td>
                </tr>
                <tr>
                  <td>Process uptime</td>
                  <td>{formatUptime(snapshot.uptimeSeconds)}</td>
                </tr>
              </tbody>
            </table>
            <p className="settings-muted" style={{ fontSize: "0.85rem", marginTop: "8px" }}>
              Prometheus endpoint: <code>GET /metrics</code> · Health: <code>GET /health</code>
            </p>
          </div>

          <div className="settings-card">
            <h4>Distributed tracing</h4>
            <p className="settings-muted">
              {tracingEnabled
                ? "Tracing is enabled. Spans are flushed to the OTLP endpoint if TRACING_ENDPOINT is set."
                : "Tracing is disabled. Set TRACING_ENABLED=true and TRACING_ENDPOINT to forward spans to your OpenTelemetry collector."}
            </p>
            {traces.length > 0 && (
              <table className="settings-table">
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>Trace ID</th>
                    <th>Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.slice(0, 20).map((span) => (
                    <tr key={span.spanId}>
                      <td>{span.operationName}</td>
                      <td>
                        <code>{span.traceId.slice(0, 16)}…</code>
                      </td>
                      <td>{span.durationMs !== null ? `${span.durationMs} ms` : "—"}</td>
                      <td>{span.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <p className="settings-muted" style={{ fontSize: "0.8rem", marginTop: "12px" }}>
        Metrics refresh every 10s. For production scraping, configure Prometheus to hit{" "}
        <code>/metrics</code> every 15s.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 7.5 — Notifications tab
// ---------------------------------------------------------------------------

const NOTIFICATION_CHANNELS = [
  { value: "email" as const, label: "Email" },
  { value: "slack" as const, label: "Slack" },
  { value: "teams" as const, label: "Teams" }
];

const NOTIFICATION_EVENTS = [
  { value: "workflow_failure", label: "Workflow Failure" },
  { value: "workflow_success", label: "Workflow Success" }
];

function NotificationsTab() {
  const [configs, setConfigs] = useState<NotificationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // form state
  const [formChannel, setFormChannel] = useState<"email" | "slack" | "teams">("email");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formEvents, setFormEvents] = useState<string[]>(["workflow_failure"]);

  // email fields
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [emailFrom, setEmailFrom] = useState("");
  const [emailTo, setEmailTo] = useState("");

  // slack / teams
  const [webhookUrl, setWebhookUrl] = useState("");

  const loadConfigs = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchNotificationConfigs();
      setConfigs(result.configs);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs]);

  function resetForm() {
    setFormChannel("email");
    setFormEnabled(true);
    setFormEvents(["workflow_failure"]);
    setSmtpHost("");
    setSmtpPort("587");
    setSmtpSecure(false);
    setSmtpUser("");
    setSmtpPass("");
    setEmailFrom("");
    setEmailTo("");
    setWebhookUrl("");
    setTestResult(null);
    setShowForm(false);
  }

  function buildConfig(): Record<string, unknown> {
    if (formChannel === "email") {
      return {
        host: smtpHost,
        port: Number(smtpPort),
        secure: smtpSecure,
        username: smtpUser,
        password: smtpPass,
        from: emailFrom,
        to: emailTo
      };
    }
    return { webhookUrl };
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      await upsertNotificationConfig({
        channel: formChannel,
        enabled: formEnabled,
        config: buildConfig(),
        events: formEvents
      });
      resetForm();
      await loadConfigs();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testNotificationConfig({
        channel: formChannel,
        config: buildConfig()
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, message: formatError(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete(id: string) {
    setError("");
    try {
      await deleteNotificationConfig(id);
      await loadConfigs();
    } catch (err) {
      setError(formatError(err));
    }
  }

  async function handleToggle(cfg: NotificationConfig) {
    setError("");
    try {
      await upsertNotificationConfig({
        id: cfg.id,
        channel: cfg.channel,
        enabled: !cfg.enabled,
        config: cfg.config,
        events: cfg.events
      });
      await loadConfigs();
    } catch (err) {
      setError(formatError(err));
    }
  }

  function toggleEvent(event: string) {
    setFormEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]
    );
  }

  return (
    <div>
      <h3>Notification Channels</h3>
      <p className="settings-muted">
        Configure channels to receive alerts for workflow events.
      </p>

      {error && (
        <div className="settings-error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {loading ? (
        <p className="settings-muted">Loading...</p>
      ) : (
        <>
          {configs.length > 0 && (
            <div className="ntf-list">
              {configs.map((cfg) => (
                <div key={cfg.id} className="ntf-card">
                  <div className="ntf-card-info">
                    <span className={`ntf-channel-badge ${cfg.channel}`}>
                      {cfg.channel}
                    </span>
                    <span style={{ fontSize: "0.85rem" }}>
                      {cfg.events.join(", ")}
                    </span>
                  </div>
                  <div className="ntf-card-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void handleToggle(cfg)}
                    >
                      {cfg.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => void handleDelete(cfg.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!showForm ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowForm(true)}
            >
              + Add Channel
            </button>
          ) : (
            <div className="ntf-form">
              <h4>Add Notification Channel</h4>

              <div style={{ marginBottom: "0.75rem" }}>
                <label>Channel Type</label>
                <select
                  className="input"
                  value={formChannel}
                  onChange={(e) => setFormChannel(e.target.value as "email" | "slack" | "teams")}
                >
                  {NOTIFICATION_CHANNELS.map((ch) => (
                    <option key={ch.value} value={ch.value}>
                      {ch.label}
                    </option>
                  ))}
                </select>
              </div>

              {formChannel === "email" && (
                <div className="ntf-form-grid">
                  <div>
                    <label>SMTP Host</label>
                    <input
                      className="input"
                      value={smtpHost}
                      onChange={(e) => setSmtpHost(e.target.value)}
                      placeholder="smtp.example.com"
                    />
                  </div>
                  <div>
                    <label>Port</label>
                    <input
                      className="input"
                      value={smtpPort}
                      onChange={(e) => setSmtpPort(e.target.value)}
                      placeholder="587"
                    />
                  </div>
                  <div>
                    <label>Username</label>
                    <input
                      className="input"
                      value={smtpUser}
                      onChange={(e) => setSmtpUser(e.target.value)}
                    />
                  </div>
                  <div>
                    <label>Password</label>
                    <input
                      className="input"
                      type="password"
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                    />
                  </div>
                  <div>
                    <label>From</label>
                    <input
                      className="input"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                      placeholder="alerts@example.com"
                    />
                  </div>
                  <div>
                    <label>To</label>
                    <input
                      className="input"
                      value={emailTo}
                      onChange={(e) => setEmailTo(e.target.value)}
                      placeholder="team@example.com"
                    />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <input
                      type="checkbox"
                      checked={smtpSecure}
                      onChange={(e) => setSmtpSecure(e.target.checked)}
                      id="smtp-secure"
                    />
                    <label htmlFor="smtp-secure">Secure (TLS)</label>
                  </div>
                </div>
              )}

              {(formChannel === "slack" || formChannel === "teams") && (
                <div style={{ marginBottom: "0.75rem" }}>
                  <label>Webhook URL</label>
                  <input
                    className="input"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                  />
                </div>
              )}

              <div className="ntf-events">
                {NOTIFICATION_EVENTS.map((ev) => (
                  <label key={ev.value}>
                    <input
                      type="checkbox"
                      checked={formEvents.includes(ev.value)}
                      onChange={() => toggleEvent(ev.value)}
                    />
                    {ev.label}
                  </label>
                ))}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
                <input
                  type="checkbox"
                  checked={formEnabled}
                  onChange={(e) => setFormEnabled(e.target.checked)}
                  id="ntf-enabled"
                />
                <label htmlFor="ntf-enabled">Enabled</label>
              </div>

              {testResult && (
                <div
                  className={testResult.ok ? "settings-success" : "settings-error"}
                  style={{ marginBottom: "0.75rem" }}
                >
                  {testResult.message}
                </div>
              )}

              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={testing}
                  onClick={() => void handleTest()}
                >
                  {testing ? "Testing..." : "Test"}
                </button>
                <button type="button" className="btn" onClick={resetForm}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function McpServersTab() {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMcpPresets()
      .then((response) => {
        if (!cancelled) {
          setPresets(response.presets);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(formatError(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <div className="settings-section">
        <div className="settings-loading">Loading MCP server catalogue…</div>
      </div>
    );
  }

  const grouped = new Map<string, McpPreset[]>();
  for (const preset of presets) {
    const list = grouped.get(preset.category) ?? [];
    list.push(preset);
    grouped.set(preset.category, list);
  }
  const categories = Array.from(grouped.keys()).sort();

  return (
    <div className="settings-section">
      <h3>MCP Servers</h3>
      <p className="settings-help">
        Curated catalogue of popular Model Context Protocol servers from the
        community. Open the MCP Tool node in any workflow and use the{" "}
        <strong>Load preset</strong> dropdown to drop one in with its connection
        and credential hints pre-filled. Servers run locally as child processes
        via the <code>stdio_mcp</code> adapter — they do not phone home to L2M.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {presets.length === 0 ? (
        <div className="settings-muted">No presets available.</div>
      ) : (
        categories.map((category) => (
          <div key={category} className="settings-card">
            <h4>{category}</h4>
            <div className="settings-permissions-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
              {(grouped.get(category) ?? []).map((preset) => (
                <div key={preset.id} style={{ padding: "8px 0" }}>
                  <strong>{preset.name}</strong>
                  <div className="settings-muted" style={{ marginTop: "4px" }}>
                    {preset.description}
                  </div>
                  {preset.credentialHint && (
                    <div className="settings-muted" style={{ marginTop: "4px", fontSize: "0.75rem" }}>
                      Requires <code>{preset.credentialHint.envVar}</code> —{" "}
                      {preset.credentialHint.description}
                    </div>
                  )}
                  {preset.notes && (
                    <div className="settings-muted" style={{ marginTop: "4px", fontSize: "0.75rem" }}>
                      <em>{preset.notes}</em>
                    </div>
                  )}
                  <div style={{ marginTop: "6px", fontSize: "0.75rem" }}>
                    <a href={preset.source} target="_blank" rel="noreferrer">
                      View source
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 6 — Community Nodes
//
// Admin-only tab. When COMMUNITY_NODES_ENABLED=false on the server, the
// initial fetch returns enabled=false and we render the disabled state with
// an explainer. When enabled, admins can install/list/uninstall packages
// by npm name. Allowlist is informational here — server enforces it on POST.
// ---------------------------------------------------------------------------

function CommunityNodesTab() {
  const [status, setStatus] = useState<CommunityNodesStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installSpec, setInstallSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchCommunityNodes());
    } catch (err) {
      const apiErr = err as { status?: number; message?: string; payload?: { error?: string } };
      if (apiErr.status === 503) {
        setStatus({ enabled: false });
      } else {
        setError(apiErr.payload?.error ?? apiErr.message ?? "Failed to load community-node status");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleInstall = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const spec = installSpec.trim();
      if (!spec) return;
      setBusy(true);
      setActionError(null);
      try {
        await installCommunityNode(spec);
        setInstallSpec("");
        await refresh();
      } catch (err) {
        const apiErr = err as { payload?: { error?: string }; message?: string };
        setActionError(apiErr.payload?.error ?? apiErr.message ?? "Install failed");
      } finally {
        setBusy(false);
      }
    },
    [installSpec, refresh]
  );

  const handleUninstall = useCallback(
    async (packageName: string) => {
      if (!window.confirm(`Uninstall ${packageName}? Adapters it registered stay loaded until the server restarts.`)) {
        return;
      }
      setBusy(true);
      setActionError(null);
      try {
        await uninstallCommunityNode(packageName);
        await refresh();
      } catch (err) {
        const apiErr = err as { payload?: { error?: string }; message?: string };
        setActionError(apiErr.payload?.error ?? apiErr.message ?? "Uninstall failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const handleReload = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      await reloadCommunityNodes();
      await refresh();
    } catch (err) {
      const apiErr = err as { payload?: { error?: string }; message?: string };
      setActionError(apiErr.payload?.error ?? apiErr.message ?? "Reload failed");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading) return <div className="settings-loading">Loading community-node status…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!status) return null;

  if (!status.enabled) {
    return (
      <div className="settings-section">
        <h3>Community Nodes</h3>
        <p className="settings-help">
          The community-node SDK lets you install third-party <code>l2m-nodes-*</code> npm packages
          to add new LLM providers, MCP transports, and connectors without modifying L2M source.
        </p>
        <div className="info-banner">
          <strong>Disabled.</strong> Set <code>COMMUNITY_NODES_ENABLED=true</code> in the server&apos;s
          environment to enable. Install/uninstall is admin-only and runs <code>npm install --ignore-scripts</code>.
          See the{" "}
          <a href="/docs/extensions/community-nodes" target="_blank" rel="noreferrer">
            community-nodes documentation
          </a>{" "}
          for the threat model.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3>Community Nodes</h3>
      <p className="settings-help">
        Install third-party <code>l2m-nodes-*</code> packages by npm name. The server runs
        <code> npm install --ignore-scripts</code> and validates each package&apos;s manifest
        before importing it. Uninstall removes the package files but adapters stay loaded
        until the next server restart.
      </p>

      <div className="settings-card">
        <h4>Install a package</h4>
        <form onSubmit={handleInstall} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 280px" }}>
            <span>Package spec</span>
            <input
              type="text"
              placeholder="l2m-nodes-cohere or l2m-nodes-cohere@1.2.3"
              value={installSpec}
              onChange={(event) => setInstallSpec(event.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" className="header-btn" disabled={busy || !installSpec.trim()}>
            Install
          </button>
          <button type="button" className="header-btn" onClick={handleReload} disabled={busy}>
            Re-scan
          </button>
        </form>
        {status.allowlist && status.allowlist.length > 0 && (
          <p className="settings-help" style={{ fontSize: "0.78rem", marginTop: 6 }}>
            Allowlist: {status.allowlist.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}
          </p>
        )}
        {status.pluginsDir && (
          <p className="settings-help" style={{ fontSize: "0.78rem" }}>
            Plugins directory: <code>{status.pluginsDir}</code>
          </p>
        )}
        {actionError && <div className="error-banner">{actionError}</div>}
      </div>

      <div className="settings-card">
        <h4>Loaded packages ({status.packages?.length ?? 0})</h4>
        {!status.packages || status.packages.length === 0 ? (
          <p className="settings-help">
            No community packages installed. Try <code>l2m-nodes-template</code> to bootstrap your own.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
            {status.packages.map((pkg) => (
              <CommunityPackageRow key={pkg.packageName} pkg={pkg} onUninstall={handleUninstall} busy={busy} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CommunityPackageRow({
  pkg,
  onUninstall,
  busy
}: {
  pkg: CommunityNodePackageState;
  onUninstall: (name: string) => void;
  busy: boolean;
}) {
  const stateLabel = pkg.state === "loaded" ? "loaded" : pkg.state === "errored" ? "errored" : "unsupported";
  const totalContribs =
    pkg.contributions.providers + pkg.contributions.mcpAdapters + pkg.contributions.connectors;
  return (
    <li
      style={{
        border: "1px solid var(--panel-border)",
        borderRadius: 10,
        padding: 14,
        background: "var(--panel)"
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: "0.96rem", fontWeight: 600, color: "var(--text)" }}>
            {pkg.displayName ?? pkg.packageName}{" "}
            <code style={{ fontSize: "0.78rem", color: "var(--muted)", fontWeight: 400 }}>
              {pkg.packageName}@{pkg.version}
            </code>
          </div>
          {pkg.description && (
            <div style={{ fontSize: "0.86rem", color: "var(--muted)", marginTop: 4 }}>{pkg.description}</div>
          )}
          <div style={{ fontSize: "0.76rem", color: "var(--muted)", marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>State: <strong style={{ color: pkg.state === "loaded" ? "var(--run-success)" : "var(--accent)" }}>{stateLabel}</strong></span>
            {totalContribs > 0 && (
              <span>
                Contributes: {pkg.contributions.providers} providers · {pkg.contributions.mcpAdapters} MCP · {pkg.contributions.connectors} connectors
              </span>
            )}
            {pkg.author && <span>by {pkg.author}</span>}
            {pkg.license && <span>{pkg.license}</span>}
            {pkg.homepage && (
              <a href={pkg.homepage} target="_blank" rel="noreferrer">
                Homepage
              </a>
            )}
          </div>
          {pkg.error && (
            <div style={{ marginTop: 8, fontSize: "0.84rem", color: "var(--accent)" }}>
              {pkg.error}
            </div>
          )}
        </div>
        <button
          type="button"
          className="header-btn danger"
          onClick={() => onUninstall(pkg.packageName)}
          disabled={busy}
        >
          Uninstall
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Phase 7.3 — Eval framework
//
// Three views in one tab:
//   - Datasets list + create
//   - Drill into a dataset to manage fixtures + start a run
//   - Drill into a run to see per-fixture pass/fail + scores
// ---------------------------------------------------------------------------

function EvalsTab() {
  const [view, setView] = useState<"datasets" | "dataset" | "run">("datasets");
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  if (view === "run" && activeRunId) {
    return (
      <EvalRunDetail
        runId={activeRunId}
        onBack={() => {
          setActiveRunId(null);
          setView(activeDatasetId ? "dataset" : "datasets");
        }}
      />
    );
  }
  if (view === "dataset" && activeDatasetId) {
    return (
      <EvalDatasetDetail
        datasetId={activeDatasetId}
        onBack={() => {
          setActiveDatasetId(null);
          setView("datasets");
        }}
        onOpenRun={(runId) => {
          setActiveRunId(runId);
          setView("run");
        }}
      />
    );
  }
  return (
    <EvalDatasetsList
      onOpenDataset={(id) => {
        setActiveDatasetId(id);
        setView("dataset");
      }}
    />
  );
}

function EvalDatasetsList({ onOpenDataset }: { onOpenDataset: (id: string) => void }) {
  const [datasets, setDatasets] = useState<EvalDataset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchEvalDatasets();
      setDatasets(res.datasets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load datasets");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const handleCreate = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createEvalDataset({ name: name.trim(), description: description.trim() || undefined });
      setName("");
      setDescription("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create dataset");
    } finally {
      setBusy(false);
    }
  }, [name, description, refresh]);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm("Delete dataset and all its fixtures + runs?")) return;
    try {
      await deleteEvalDataset(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }, [refresh]);

  return (
    <div className="settings-section">
      <h3>Eval datasets</h3>
      <p className="settings-help">
        Group fixtures (test inputs + expected outputs) into datasets. Run a dataset against any
        workflow to grade its outputs with the bundled exact-match / contains / regex scorers.
        Eval runs use the same execution path as live runs, so token counts and latency match.
      </p>
      <div className="settings-card">
        <h4>New dataset</h4>
        <form onSubmit={handleCreate} style={{ display: "grid", gap: 8 }}>
          <label>
            <span>Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer triage v2" disabled={busy} />
          </label>
          <label>
            <span>Description (optional)</span>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="100 representative tickets from Q1" disabled={busy} />
          </label>
          <div>
            <button type="submit" className="header-btn" disabled={busy || !name.trim()}>Create</button>
          </div>
        </form>
        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="settings-card">
        <h4>Existing datasets ({datasets?.length ?? 0})</h4>
        {!datasets ? (
          <div className="muted">Loading…</div>
        ) : datasets.length === 0 ? (
          <p className="settings-help">No datasets yet. Create one above to get started.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {datasets.map((d) => (
              <li
                key={d.id}
                style={{
                  border: "1px solid var(--panel-border)",
                  borderRadius: 10,
                  padding: 12,
                  background: "var(--panel)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 10
                }}
              >
                <div style={{ flex: 1, cursor: "pointer" }} onClick={() => onOpenDataset(d.id)}>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  {d.description && <div style={{ fontSize: "0.86rem", color: "var(--muted)", marginTop: 2 }}>{d.description}</div>}
                  <div style={{ fontSize: "0.76rem", color: "var(--muted)", marginTop: 6 }}>
                    {d.fixtureCount} fixture{d.fixtureCount === 1 ? "" : "s"} · created {new Date(d.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className="header-btn" onClick={() => onOpenDataset(d.id)}>Open</button>
                  <button type="button" className="header-btn danger" onClick={() => handleDelete(d.id)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EvalDatasetDetail({
  datasetId,
  onBack,
  onOpenRun
}: {
  datasetId: string;
  onBack: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const [fixtures, setFixtures] = useState<EvalFixture[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fixName, setFixName] = useState("");
  const [fixInput, setFixInput] = useState("{\n  \"user_prompt\": \"\"\n}");
  const [fixExpected, setFixExpected] = useState("");
  const [selectedWorkflow, setSelectedWorkflow] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const [fixRes, runsRes, wfRes] = await Promise.all([
        fetchEvalFixtures(datasetId),
        fetchEvalRuns({ datasetId, limit: 20 }),
        fetchWorkflows()
      ]);
      setFixtures(fixRes.fixtures);
      setRuns(runsRes.runs);
      setWorkflows(wfRes.map((w) => ({ id: w.id, name: w.name })));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, [datasetId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const handleAddFixture = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!fixName.trim()) return;
    let inputParsed: unknown;
    try {
      inputParsed = JSON.parse(fixInput);
    } catch (err) {
      setError(`Input must be valid JSON: ${(err as Error).message}`);
      return;
    }
    let expectedParsed: unknown | undefined;
    if (fixExpected.trim()) {
      try {
        expectedParsed = JSON.parse(fixExpected);
      } catch {
        expectedParsed = fixExpected.trim();
      }
    }
    setBusy(true);
    setError(null);
    try {
      await createEvalFixture(datasetId, { name: fixName.trim(), input: inputParsed, expected: expectedParsed });
      setFixName("");
      setFixExpected("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add fixture");
    } finally {
      setBusy(false);
    }
  }, [datasetId, fixName, fixInput, fixExpected, refresh]);

  const handleStartRun = useCallback(async () => {
    if (!selectedWorkflow) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startEvalRun({ datasetId, workflowId: selectedWorkflow });
      await refresh();
      onOpenRun(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setBusy(false);
    }
  }, [datasetId, selectedWorkflow, refresh, onOpenRun]);

  return (
    <div className="settings-section">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="header-btn" onClick={onBack}>← Back</button>
        <h3 style={{ margin: 0 }}>Dataset</h3>
      </div>

      <div className="settings-card">
        <h4>Fixtures ({fixtures?.length ?? 0})</h4>
        <form onSubmit={handleAddFixture} style={{ display: "grid", gap: 8 }}>
          <label>
            <span>Name</span>
            <input type="text" value={fixName} onChange={(e) => setFixName(e.target.value)} placeholder="Refund request — billing" disabled={busy} />
          </label>
          <label>
            <span>Input (JSON)</span>
            <textarea rows={4} value={fixInput} onChange={(e) => setFixInput(e.target.value)} disabled={busy} style={{ fontFamily: "JetBrains Mono, Fira Code, monospace", fontSize: "0.84rem" }} />
          </label>
          <label>
            <span>Expected (JSON or string, optional)</span>
            <textarea rows={3} value={fixExpected} onChange={(e) => setFixExpected(e.target.value)} disabled={busy} placeholder='"refund processed" or {"category":"billing"}' style={{ fontFamily: "JetBrains Mono, Fira Code, monospace", fontSize: "0.84rem" }} />
          </label>
          <div>
            <button type="submit" className="header-btn" disabled={busy || !fixName.trim()}>Add fixture</button>
          </div>
        </form>
        {fixtures && fixtures.length > 0 && (
          <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "grid", gap: 6 }}>
            {fixtures.map((f) => (
              <li key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: "var(--app-bg)", border: "1px solid var(--panel-border)", borderRadius: 6, fontSize: "0.86rem" }}>
                <span>{f.name}</span>
                <button type="button" className="mini-btn danger" onClick={async () => { await deleteEvalFixture(f.id); await refresh(); }}>Delete</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="settings-card">
        <h4>Run against a workflow</h4>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <label style={{ flex: "1 1 280px" }}>
            <span>Workflow</span>
            <select value={selectedWorkflow} onChange={(e) => setSelectedWorkflow(e.target.value)} disabled={busy}>
              <option value="">— pick a workflow —</option>
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !selectedWorkflow || !fixtures || fixtures.length === 0}
            onClick={handleStartRun}
          >
            {busy ? "Running…" : `Run ${fixtures?.length ?? 0} fixtures`}
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="settings-card">
        <h4>Recent runs</h4>
        {!runs || runs.length === 0 ? (
          <p className="settings-help">No runs yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {runs.map((r) => (
              <li key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "var(--panel)", border: "1px solid var(--panel-border)", borderRadius: 8, cursor: "pointer" }} onClick={() => onOpenRun(r.id)}>
                <div>
                  <div style={{ fontSize: "0.88rem" }}>{new Date(r.startedAt).toLocaleString()}</div>
                  {r.summary && <div style={{ fontSize: "0.76rem", color: "var(--muted)", marginTop: 2, fontFamily: "JetBrains Mono, Fira Code, monospace" }}>
                    {r.summary.pass} pass · {r.summary.fail} fail · {r.summary.error} error · {Math.round(r.summary.passRate * 100)}% pass rate
                  </div>}
                </div>
                <span style={{ fontSize: "0.76rem", color: r.status === "completed" ? "var(--run-success)" : "var(--accent)" }}>{r.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EvalRunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<(EvalRun & { results: EvalResult[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchEvalRun(runId).then(setRun).catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [runId]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!run) return <div className="settings-loading">Loading run…</div>;

  return (
    <div className="settings-section">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="header-btn" onClick={onBack}>← Back</button>
        <h3 style={{ margin: 0 }}>Eval run</h3>
      </div>

      {run.summary && (
        <div className="settings-card">
          <h4>Summary</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, fontFamily: "JetBrains Mono, Fira Code, monospace", fontSize: "0.86rem" }}>
            <div><strong>{run.summary.total}</strong><br /><span style={{ color: "var(--muted)" }}>total</span></div>
            <div><strong style={{ color: "var(--run-success)" }}>{run.summary.pass}</strong><br /><span style={{ color: "var(--muted)" }}>pass</span></div>
            <div><strong style={{ color: "var(--accent)" }}>{run.summary.fail}</strong><br /><span style={{ color: "var(--muted)" }}>fail</span></div>
            <div><strong>{run.summary.error}</strong><br /><span style={{ color: "var(--muted)" }}>error</span></div>
            <div><strong>{Math.round(run.summary.passRate * 100)}%</strong><br /><span style={{ color: "var(--muted)" }}>pass rate</span></div>
            <div><strong>{run.summary.totalTokenTotal}</strong><br /><span style={{ color: "var(--muted)" }}>total tokens</span></div>
            <div><strong>{Math.round(run.summary.avgDurationMs)}ms</strong><br /><span style={{ color: "var(--muted)" }}>avg latency</span></div>
          </div>
        </div>
      )}

      <div className="settings-card">
        <h4>Per-fixture results ({run.results.length})</h4>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {run.results.map((r) => (
            <li key={r.id} style={{ padding: "10px 12px", background: r.status === "pass" ? "rgba(5, 150, 105, 0.08)" : r.status === "fail" ? "rgba(37, 99, 235, 0.08)" : "rgba(239, 68, 68, 0.08)", border: `1px solid ${r.status === "pass" ? "rgba(5, 150, 105, 0.3)" : "var(--panel-border)"}`, borderRadius: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "0.88rem", fontWeight: 600 }}>{r.fixtureName ?? r.fixtureId}</div>
                  {r.score && (
                    <div style={{ fontSize: "0.76rem", color: "var(--muted)", marginTop: 4 }}>
                      {r.score.details.map((d, i) => (
                        <div key={i}>
                          <strong>{d.type}</strong>{d.path ? ` (${d.path})` : ""}: {d.pass ? "✓" : "✗"} {d.reason}
                        </div>
                      ))}
                    </div>
                  )}
                  {r.error && <div style={{ fontSize: "0.78rem", color: "var(--accent)", marginTop: 4 }}>{r.error}</div>}
                </div>
                <div style={{ fontSize: "0.74rem", color: "var(--muted)", fontFamily: "JetBrains Mono, Fira Code, monospace", textAlign: "right", whiteSpace: "nowrap" }}>
                  <div style={{ color: r.status === "pass" ? "var(--run-success)" : r.status === "fail" ? "var(--accent)" : "#ef4444", fontWeight: 600 }}>{r.status}</div>
                  {r.durationMs !== null && <div>{r.durationMs}ms</div>}
                  {r.tokenTotal !== null && <div>{r.tokenTotal} tok</div>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 8.2 — FinOps tab (cost dashboards backed by usage_events)
// ---------------------------------------------------------------------------

function formatUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${(v / 1000).toFixed(1)}k`;
}

function formatTokens(v: number): string {
  if (v < 1000) return `${v}`;
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

const FINOPS_RANGES = [
  { id: "24h", label: "Last 24h", days: 1 },
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 }
] as const;

type FinOpsRangeId = (typeof FINOPS_RANGES)[number]["id"];

function FinOpsTab() {
  const [rangeId, setRangeId] = useState<FinOpsRangeId>("30d");
  const [groupBy, setGroupBy] = useState<UsageGroupBy>("workflow");
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [series, setSeries] = useState<UsageRollupRow[]>([]);
  const [breakdown, setBreakdown] = useState<UsageRollupRow[]>([]);
  const [recent, setRecent] = useState<UsageEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => {
    const range = FINOPS_RANGES.find((r) => r.id === rangeId) ?? FINOPS_RANGES[2];
    const to = new Date().toISOString();
    const from = new Date(Date.now() - range.days * 24 * 60 * 60 * 1000).toISOString();
    return { from, to };
  }, [rangeId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, s, b, r] = await Promise.all([
        fetchUsageTotals(window),
        fetchUsageRollup({ ...window, groupBy: rangeId === "24h" ? "hour" : "day", limit: 200 }),
        fetchUsageRollup({ ...window, groupBy, limit: 20 }),
        fetchRecentUsage({ limit: 25 })
      ]);
      setTotals(t.totals);
      setSeries(s.rows);
      setBreakdown(b.rows);
      setRecent(r.events);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [window, groupBy, rangeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const seriesMaxCost = Math.max(...series.map((r) => r.costUsd), 0.0001);

  return (
    <div className="finops-tab">
      <header className="finops-header">
        <div>
          <h3>FinOps — cost &amp; token usage</h3>
          <p className="finops-subtle">
            Aggregated from <code>_telemetry</code> recorded on every llm_call / agent_orchestrator / supervisor_node run. Cost uses list-price pricing — override per-tenant via <code>LLM_PRICING_OVERRIDES_JSON</code>.
          </p>
        </div>
        <div className="finops-controls">
          <div className="finops-range" role="tablist" aria-label="Time range">
            {FINOPS_RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={rangeId === r.id}
                className={rangeId === r.id ? "finops-range-btn active" : "finops-range-btn"}
                onClick={() => setRangeId(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button type="button" className="finops-refresh" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <div className="finops-error">{error}</div>}

      <div className="finops-kpis">
        <FinOpsKpi label="Total spend" value={totals ? formatUsd(totals.costUsd) : "—"} hint={totals ? `${totals.executions} executions` : undefined} />
        <FinOpsKpi label="Total tokens" value={totals ? formatTokens(totals.totalTokens) : "—"} hint={totals ? `${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out` : undefined} />
        <FinOpsKpi label="LLM calls" value={totals ? totals.llmCallCount.toLocaleString() : "—"} hint={totals && totals.executions ? `${(totals.llmCallCount / totals.executions).toFixed(1)} per exec` : undefined} />
        <FinOpsKpi label="Avg latency" value={totals ? `${totals.avgDurationMs} ms` : "—"} hint="per execution" />
        <FinOpsKpi label="Cached tokens" value={totals ? formatTokens(totals.cachedInputTokens) : "—"} hint={totals && totals.inputTokens ? `${((totals.cachedInputTokens / totals.inputTokens) * 100).toFixed(0)}% of input` : undefined} />
      </div>

      <section className="finops-section">
        <h4>Spend over time</h4>
        {series.length === 0 ? (
          <p className="finops-subtle">No usage in this window yet.</p>
        ) : (
          <div className="finops-bars" role="img" aria-label="Spend per bucket">
            {series.map((row) => {
              const pct = Math.max(2, (row.costUsd / seriesMaxCost) * 100);
              return (
                <div key={row.bucket} className="finops-bar-col" title={`${row.bucket}\n${formatUsd(row.costUsd)} / ${formatTokens(row.totalTokens)} tok / ${row.executions} execs`}>
                  <div className="finops-bar" style={{ height: `${pct}%` }} />
                  <div className="finops-bar-label">{row.bucket.split("T")[0]?.slice(5) ?? row.bucket}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="finops-section">
        <div className="finops-section-header">
          <h4>Breakdown</h4>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as UsageGroupBy)} className="finops-select">
            <option value="workflow">By workflow</option>
            <option value="user">By user</option>
            <option value="provider">By provider / model</option>
            <option value="project">By project</option>
          </select>
        </div>
        {breakdown.length === 0 ? (
          <p className="finops-subtle">No data.</p>
        ) : (
          <table className="finops-table">
            <thead>
              <tr>
                <th>{groupBy === "provider" ? "Provider / Model" : groupBy === "user" ? "User" : groupBy === "project" ? "Project" : "Workflow"}</th>
                <th className="num">Executions</th>
                <th className="num">Tokens</th>
                <th className="num">LLM calls</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.bucket}>
                  <td>
                    {groupBy === "workflow" ? (row.workflowName ?? row.workflowId ?? row.bucket) :
                     groupBy === "user" ? (row.userEmail ?? row.userId ?? "(anonymous)") :
                     row.bucket}
                  </td>
                  <td className="num">{row.executions}</td>
                  <td className="num">{formatTokens(row.totalTokens)}</td>
                  <td className="num">{row.llmCallCount}</td>
                  <td className="num">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="finops-section">
        <h4>Recent executions</h4>
        {recent.length === 0 ? (
          <p className="finops-subtle">No recent executions.</p>
        ) : (
          <table className="finops-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Workflow</th>
                <th>Trigger</th>
                <th>Status</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Latency</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((ev) => (
                <tr key={ev.id}>
                  <td title={ev.createdAt}>{formatDate(ev.createdAt)}</td>
                  <td>{ev.workflowName ?? ev.workflowId}</td>
                  <td>{ev.triggerType ?? "—"}</td>
                  <td className={`finops-status finops-status-${ev.status}`}>{ev.status}</td>
                  <td className="num">{formatTokens(ev.totalTokens)}</td>
                  <td className="num">{formatUsd(ev.costUsd)}</td>
                  <td className="num">{ev.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <BudgetsPanel />
    </div>
  );
}

function BudgetsPanel() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [b, a] = await Promise.all([fetchBudgets(), fetchBudgetAlerts({ limit: 25 })]);
      setBudgets(b.budgets);
      setAlerts(a.alerts);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(async (budget: Budget) => {
    setBusy(true);
    try {
      await updateBudget(budget.id, { enabled: !budget.enabled });
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (budget: Budget) => {
    if (!window.confirm(`Delete budget "${budget.name}"?`)) return;
    setBusy(true);
    try {
      await deleteBudgetApi(budget.id);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return (
    <section className="finops-section">
      <div className="finops-section-header">
        <h4>Budgets &amp; alerts</h4>
        <button
          type="button"
          className="finops-refresh"
          onClick={() => setShowCreate((v) => !v)}
          disabled={busy}
        >
          {showCreate ? "Cancel" : "+ New budget"}
        </button>
      </div>
      <p className="finops-subtle">
        Spend caps with <strong>warn</strong> (alert when crossed) or <strong>block</strong> (reject pre-execution with HTTP 402) actions. Block enforcement is on the manual <code>/api/workflows/:id/execute</code> endpoint; webhook + scheduled triggers still get post-execution alerts.
      </p>

      {error && <div className="finops-error">{error}</div>}

      {showCreate && <CreateBudgetForm onCreated={async () => { setShowCreate(false); await refresh(); }} onError={setError} />}

      {loading ? (
        <p className="finops-subtle">Loading…</p>
      ) : budgets.length === 0 ? (
        <p className="finops-subtle">No budgets configured.</p>
      ) : (
        <table className="finops-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Scope</th>
              <th>Period</th>
              <th>Limit</th>
              <th>Action</th>
              <th>Enabled</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {budgets.map((b) => (
              <tr key={b.id}>
                <td>{b.name}</td>
                <td>{b.scopeType}{b.scopeId ? `:${b.scopeId}` : ""}</td>
                <td>{b.period}</td>
                <td>{b.limitType === "usd" ? `$${b.limitValue}` : `${b.limitValue.toLocaleString()} tok`}</td>
                <td><span className={`finops-action-badge finops-action-${b.action}`}>{b.action}</span></td>
                <td>
                  <label className="finops-toggle">
                    <input type="checkbox" checked={b.enabled} disabled={busy} onChange={() => void handleToggle(b)} />
                    <span>{b.enabled ? "On" : "Off"}</span>
                  </label>
                </td>
                <td>
                  <button type="button" className="finops-delete" onClick={() => void handleDelete(b)} disabled={busy}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {alerts.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <h5 style={{ margin: "0 0 0.4rem 0", fontSize: "0.85rem" }}>Recent alerts</h5>
          <table className="finops-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Severity</th>
                <th>Budget</th>
                <th>Period</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>{formatDate(a.firedAt)}</td>
                  <td><span className={`finops-action-badge finops-action-${a.severity}`}>{a.severity}</span></td>
                  <td>{a.budgetId.slice(0, 12)}…</td>
                  <td>{a.periodStart.slice(0, 10)}</td>
                  <td>{a.message ?? `${a.usageValue} of ${a.limitValue}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateBudgetForm({ onCreated, onError }: { onCreated: () => Promise<void>; onError: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [scopeType, setScopeType] = useState<BudgetScopeType>("global");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState<BudgetPeriod>("month");
  const [limitType, setLimitType] = useState<BudgetLimitType>("usd");
  const [limitValue, setLimitValue] = useState("100");
  const [warnThresholdPct, setWarnThresholdPct] = useState("0.8");
  const [action, setAction] = useState<BudgetAction>("warn");
  const [notifyChannel, setNotifyChannel] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await createBudget({
        name: name.trim(),
        scopeType,
        scopeId: scopeType === "global" ? null : scopeId.trim(),
        period,
        limitType,
        limitValue: Number(limitValue),
        warnThresholdPct: Number(warnThresholdPct),
        action,
        notifyChannel: notifyChannel.trim() || null
      });
      await onCreated();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }, [name, scopeType, scopeId, period, limitType, limitValue, warnThresholdPct, action, notifyChannel, onCreated, onError]);

  return (
    <form onSubmit={handleSubmit} className="finops-create-form">
      <div className="finops-form-row">
        <label>Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q2 marketing spend" required /></label>
      </div>
      <div className="finops-form-row finops-form-row-3">
        <label>Scope
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value as BudgetScopeType)}>
            <option value="global">global</option>
            <option value="project">project</option>
            <option value="workflow">workflow</option>
            <option value="user">user</option>
          </select>
        </label>
        {scopeType !== "global" && (
          <label>Scope ID
            <input type="text" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder={scopeType === "user" ? "email or user_id" : `${scopeType}_id`} required />
          </label>
        )}
        <label>Period
          <select value={period} onChange={(e) => setPeriod(e.target.value as BudgetPeriod)}>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </select>
        </label>
      </div>
      <div className="finops-form-row finops-form-row-3">
        <label>Limit type
          <select value={limitType} onChange={(e) => setLimitType(e.target.value as BudgetLimitType)}>
            <option value="usd">USD</option>
            <option value="tokens">tokens</option>
          </select>
        </label>
        <label>Limit value
          <input type="number" min="0" step="0.01" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} required />
        </label>
        <label>Warn at (%)
          <input type="number" min="0" max="1" step="0.05" value={warnThresholdPct} onChange={(e) => setWarnThresholdPct(e.target.value)} />
        </label>
      </div>
      <div className="finops-form-row finops-form-row-2">
        <label>Action
          <select value={action} onChange={(e) => setAction(e.target.value as BudgetAction)}>
            <option value="warn">warn</option>
            <option value="block">block (HTTP 402)</option>
          </select>
        </label>
        <label>Notify webhook (optional)
          <input type="url" value={notifyChannel} onChange={(e) => setNotifyChannel(e.target.value)} placeholder="https://hooks.slack.com/..." />
        </label>
      </div>
      <div className="finops-form-row">
        <button type="submit" disabled={busy} className="finops-refresh">
          {busy ? "Saving…" : "Create budget"}
        </button>
      </div>
    </form>
  );
}

function FinOpsKpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="finops-kpi">
      <div className="finops-kpi-label">{label}</div>
      <div className="finops-kpi-value">{value}</div>
      {hint && <div className="finops-kpi-hint">{hint}</div>}
    </div>
  );
}
