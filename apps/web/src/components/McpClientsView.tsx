/**
 * Phase 10.4 — client credentials for the MCP gateway.
 *
 * Admins create a client (name, toolsets, role, expiry) and see its token
 * exactly once, with copy-paste configuration for common MCP clients.
 * Clients can be revoked, or rotated (a new token; the old one keeps working for a grace window). Usage comes from
 * the gateway's call telemetry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpGatewaySessionView, McpPolicyRole } from "@ai-orchestrator/shared";
import {
  ApiError,
  type McpClientView,
  type McpTelemetryResponse,
  type McpTelemetryWindow,
  type McpToolsetView,
  createMcpClient,
  fetchMcpClients,
  fetchMcpClientSessions,
  fetchMcpClientUsage,
  fetchMcpToolsets,
  revokeMcpClient,
  rotateMcpClient
} from "../lib/api";
import { buildMcpClientSnippets, snippetServerName, toolsetEndpointUrl } from "../lib/mcp-client-snippets";
import { CopyButton } from "./McpToolsetsView";
import { DataLabelChips } from "./DataLabelChips";
import { ClientGovernance } from "./McpGatewayGovernance";
import { ClientNetwork, describeClientNetwork } from "./McpClientNetwork";
import { CredentialExpiry, RotateCredentialButton, rotatedNotice } from "./CredentialRotation";

const ROLES: McpPolicyRole[] = ["viewer", "operator", "builder", "admin"];

const EXPIRY_OPTIONS: Array<{ value: string; label: string; days: number | null }> = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
  { value: "never", label: "Never", days: null }
];

const STATUS_LABEL: Record<McpClientView["status"], string> = {
  active: "Active",
  revoked: "Revoked",
  expired: "Expired"
};

const STATUS_CLASS: Record<McpClientView["status"], string> = {
  active: "mcp-status mcp-status-healthy",
  revoked: "mcp-status mcp-status-down",
  expired: "mcp-status mcp-status-degraded"
};

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function formatDate(value: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function pageOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

interface McpClientsViewProps {
  isAdmin: boolean;
}

export function McpClientsView({ isAdmin }: McpClientsViewProps) {
  const [clients, setClients] = useState<McpClientView[]>([]);
  const [toolsets, setToolsets] = useState<McpToolsetView[]>([]);
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ client: McpClientView; token: string; rotatedNote?: string } | null>(null);
  const [usageFor, setUsageFor] = useState<string | null>(null);
  const [sessionsFor, setSessionsFor] = useState<string | null>(null);
  const [governanceFor, setGovernanceFor] = useState<string | null>(null);
  const [networkFor, setNetworkFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [clientList, toolsetList] = await Promise.all([fetchMcpClients(), fetchMcpToolsets()]);
      setClients(clientList.clients);
      setToolsets(toolsetList.toolsets);
      setGatewayBaseUrl(toolsetList.gatewayBaseUrl);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toolsetName = useMemo(() => {
    const names = new Map(toolsets.map((toolset) => [toolset.id, toolset.name]));
    return (id: string) => names.get(id) ?? id;
  }, [toolsets]);

  const revoke = async (client: McpClientView) => {
    const sessions = client.activeSessions > 0 ? ` Its ${client.activeSessions} open session(s) close now.` : "";
    if (!window.confirm(`Revoke client "${client.name}"? Requests with its token start returning 401.${sessions}`)) return;
    setBusyId(client.id);
    setError(null);
    try {
      const result = await revokeMcpClient(client.id);
      setClients((current) => current.map((entry) => (entry.id === client.id ? { ...entry, ...result.client } : entry)));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  };

  const rotate = async (client: McpClientView, graceHours: number) => {
    setBusyId(client.id);
    setError(null);
    try {
      const result = await rotateMcpClient(client.id, graceHours);
      setClients((current) => current.map((entry) => (entry.id === client.id ? { ...entry, ...result.client } : entry)));
      setRevealed({ client: result.client, token: result.token, rotatedNote: rotatedNotice("token", result.client.previousExpiresAt) });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mcp-gateway">
      {error && <div className="settings-error">{error}</div>}

      {revealed && (
        <TokenReveal
          client={revealed.client}
          token={revealed.token}
          toolsets={toolsets.filter((toolset) => revealed.client.toolsetIds.includes(toolset.id))}
          gatewayBaseUrl={gatewayBaseUrl}
          {...(revealed.rotatedNote ? { rotatedNote: revealed.rotatedNote } : {})}
          onDone={() => setRevealed(null)}
        />
      )}

      <section className="kb-section">
        <div className="mcp-section-head">
          <h4>MCP clients ({clients.length})</h4>
          {isAdmin && !creating && !revealed && (
            <button type="button" className="pg-btn primary" onClick={() => setCreating(true)}>
              + New client
            </button>
          )}
        </div>
        <p className="kb-subtle">
          Each client has its own bearer token, scoped to the toolsets you pick. Tool policy evaluates its calls as the
          client&apos;s role, capped at the current role of the admin who created it. Tokens are stored hashed and shown
          only once.
        </p>
        {isAdmin && toolsets.length === 0 && !loading && (
          <p className="kb-subtle">No toolsets yet: a new client can call only the AI routes you grant it (Governance, AI routes).</p>
        )}

        {creating && isAdmin && (
          <McpClientForm
            toolsets={toolsets}
            onCancel={() => setCreating(false)}
            onCreated={(client, token) => {
              setCreating(false);
              setClients((current) => [client, ...current]);
              setRevealed({ client, token });
            }}
          />
        )}

        {loading && clients.length === 0 ? (
          <p className="kb-subtle">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="kb-subtle">No clients yet.</p>
        ) : (
          <ul className="mcp-rules" aria-label="MCP clients">
            {clients.map((client) => (
              <li key={client.id} className={client.status === "active" ? "mcp-rule" : "mcp-rule is-disabled"}>
                <div className="mcp-rule-head">
                  <span className={STATUS_CLASS[client.status]}>
                    <span className="mcp-status-dot" aria-hidden="true" />
                    {STATUS_LABEL[client.status]}
                  </span>
                  <span className="mcp-rule-name">{client.name}</span>
                  <code className="mcp-member-glob">{client.tokenPrefix}…</code>
                </div>
                <dl className="mcp-rule-scope">
                  <div>
                    <dt>Toolsets</dt>
                    <dd>{client.toolsetIds.length === 0 ? "none" : client.toolsetIds.map(toolsetName).join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Role</dt>
                    <dd>
                      {client.role}
                      {client.effectiveRole !== client.role && ` (acts as ${client.effectiveRole})`}
                    </dd>
                  </div>
                  <div>
                    <dt>Calls 7d</dt>
                    <dd>
                      {client.usage.calls}
                      {client.usage.errors > 0 && ` · ${client.usage.errors} failed`}
                    </dd>
                  </div>
                  <div>
                    <dt>Last used</dt>
                    <dd>{formatDate(client.lastUsedAt)}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>
                      <CredentialExpiry expiresAt={client.expiresAt} revoked={Boolean(client.revokedAt)} />
                    </dd>
                  </div>
                  {client.previousTokenPrefix && client.previousExpiresAt && Date.parse(client.previousExpiresAt) > Date.now() && (
                    <div>
                      <dt>Previous token</dt>
                      <dd>
                        <code>{client.previousTokenPrefix}…</code> works until {formatDate(client.previousExpiresAt)}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Created by</dt>
                    <dd>{client.createdByEmail ?? "unknown"}</dd>
                  </div>
                  <div>
                    <dt>Open sessions</dt>
                    <dd>{client.activeSessions}</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd data-testid="client-network-summary">{describeClientNetwork(client)}</dd>
                  </div>
                  {client.revokedAt && (
                    <div>
                      <dt>Revoked</dt>
                      <dd>{formatDate(client.revokedAt)}</dd>
                    </div>
                  )}
                </dl>
                <div className="mcp-rule-actions">
                  <button
                    type="button"
                    className="pg-btn ghost"
                    aria-expanded={usageFor === client.id}
                    onClick={() => setUsageFor((current) => (current === client.id ? null : client.id))}
                  >
                    {usageFor === client.id ? "Hide usage" : "Usage"}
                  </button>
                  <button
                    type="button"
                    className="pg-btn ghost"
                    aria-expanded={sessionsFor === client.id}
                    onClick={() => setSessionsFor((current) => (current === client.id ? null : client.id))}
                  >
                    {sessionsFor === client.id ? "Hide sessions" : "Sessions"}
                  </button>
                  <button
                    type="button"
                    className="pg-btn ghost"
                    aria-expanded={governanceFor === client.id}
                    onClick={() => setGovernanceFor((current) => (current === client.id ? null : client.id))}
                  >
                    {governanceFor === client.id ? "Hide governance" : "Governance"}
                  </button>
                  <button
                    type="button"
                    className="pg-btn ghost"
                    aria-expanded={networkFor === client.id}
                    onClick={() => setNetworkFor((current) => (current === client.id ? null : client.id))}
                  >
                    {networkFor === client.id ? "Hide network" : "Network"}
                  </button>
                  {isAdmin && client.status === "active" && !revealed && (
                    <RotateCredentialButton
                      what="token"
                      name={client.name}
                      buttonClassName="pg-btn ghost"
                      disabled={busyId === client.id}
                      onRotate={(graceHours) => rotate(client, graceHours)}
                    />
                  )}
                  {isAdmin && client.status === "active" && (
                    <button
                      type="button"
                      className="pg-btn ghost danger"
                      onClick={() => void revoke(client)}
                      disabled={busyId === client.id}
                    >
                      Revoke
                    </button>
                  )}
                </div>
                {usageFor === client.id && <ClientUsage clientId={client.id} />}
                {sessionsFor === client.id && <ClientSessions clientId={client.id} />}
                {governanceFor === client.id && (
                  <ClientGovernance
                    clientId={client.id}
                    isAdmin={isAdmin}
                    active={client.status === "active"}
                    rateLimit={client.rateLimit}
                    onClientChange={(updated) => setClients((current) => current.map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry)))}
                  />
                )}
                {networkFor === client.id && (
                  <ClientNetwork
                    client={client}
                    isAdmin={isAdmin}
                    onSaved={(updated) => setClients((current) => current.map((entry) => (entry.id === updated.id ? { ...entry, ...updated } : entry)))}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function McpClientForm({
  toolsets,
  onCreated,
  onCancel
}: {
  toolsets: McpToolsetView[];
  onCreated: (client: McpClientView, token: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [toolsetIds, setToolsetIds] = useState<string[]>(toolsets.length === 1 ? [toolsets[0]!.id] : []);
  const [role, setRole] = useState<McpPolicyRole>("viewer");
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setToolsetIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const days = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days ?? null;
    const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    setBusy(true);
    try {
      const result = await createMcpClient({ name: name.trim(), toolsetIds, role, expiresAt });
      onCreated(result.client, result.token);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="kb-create-form mcp-form mcp-gw-form" aria-label="New MCP client" onSubmit={(event) => void handleSubmit(event)}>
      {error && <div className="settings-error">{error}</div>}
      <div className="kb-form-row kb-form-row-3">
        <label>
          Name
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Team IDE agents" />
        </label>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as McpPolicyRole)}>
            {ROLES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expires
          <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="mcp-role-picker mcp-gw-picker">
        <legend className="kb-subtle">Toolsets this token may call (none: AI routes only, granted after creating it)</legend>
        {toolsets.map((toolset) => (
          <label key={toolset.id} className="mcp-check">
            <input type="checkbox" checked={toolsetIds.includes(toolset.id)} onChange={() => toggle(toolset.id)} />
            <span>
              {toolset.name} <code className="mcp-member-glob">/mcp/{toolset.slug}</code>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy}>
          {busy ? "Creating…" : "Create client"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TokenReveal({
  client,
  token,
  toolsets,
  gatewayBaseUrl,
  rotatedNote,
  onDone
}: {
  client: McpClientView;
  token: string;
  toolsets: McpToolsetView[];
  gatewayBaseUrl: string | null;
  /** 13.2 — after a rotation: how long the old token keeps working. */
  rotatedNote?: string;
  onDone: () => void;
}) {
  const [toolsetId, setToolsetId] = useState(toolsets[0]?.id ?? "");
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // The reveal sits above the client list; bring it into view after creating a client.
    sectionRef.current?.scrollIntoView?.({ block: "start" });
  }, []);
  const toolset = toolsets.find((entry) => entry.id === toolsetId) ?? toolsets[0];
  const snippets = toolset
    ? buildMcpClientSnippets({
        serverName: snippetServerName(toolset.slug),
        url: toolsetEndpointUrl(toolset.endpointPath, gatewayBaseUrl, pageOrigin()),
        token
      })
    : [];

  return (
    <section ref={sectionRef} className="kb-section mcp-token-reveal" aria-label="New client token">
      <div className="mcp-section-head mcp-wrap">
        <h4>Token for {client.name}</h4>
        <button type="button" className="pg-btn primary" onClick={onDone}>
          I&apos;ve stored the token
        </button>
      </div>
      <p className="mcp-warning">This is the only time the token is shown. Store it in your client now; L2M keeps only a hash.</p>
      {rotatedNote && <p className="kb-subtle">{rotatedNote}</p>}
      <div className="mcp-endpoint">
        <code className="mcp-endpoint-url" data-testid="client-token">
          {token}
        </code>
        <CopyButton text={token} ariaLabel="Copy token" />
      </div>

      {toolsets.length > 1 && (
        <label className="mcp-gw-inline">
          Snippets for toolset
          <select value={toolset?.id ?? ""} onChange={(event) => setToolsetId(event.target.value)}>
            {toolsets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {snippets.map((snippet) => (
        <div key={snippet.id} className="mcp-snippet">
          <div className="mcp-section-head mcp-wrap">
            <strong className="mcp-snippet-title">{snippet.title}</strong>
            <CopyButton text={snippet.text} ariaLabel={`Copy ${snippet.title}`} />
          </div>
          <p className="kb-subtle">{snippet.hint}</p>
          <pre className="mcp-snippet-code">
            <code>{snippet.text}</code>
          </pre>
        </div>
      ))}
    </section>
  );
}

/**
 * 12.2 — a client's open sessions and, on toolsets that track outside content per session, the labels each session
 * has collected (the same chips as the run inspector).
 */
export function ClientSessions({ clientId }: { clientId: string }) {
  const [sessions, setSessions] = useState<McpGatewaySessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by "Refresh": a session's labels change while its client works.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    fetchMcpClientSessions(clientId)
      .then((result) => {
        if (!cancelled) setSessions(result.sessions);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, reloads]);

  return (
    <div className="mcp-client-usage" aria-label="Client sessions">
      <div className="mcp-rule-actions">
        <button type="button" className="pg-btn ghost" aria-busy={loading} disabled={loading} onClick={() => setReloads((count) => count + 1)}>
          Refresh
        </button>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {sessions === null && !error && <p className="kb-subtle">Loading…</p>}
      {sessions !== null && sessions.length === 0 && <p className="kb-subtle">No open sessions on this server.</p>}
      {sessions !== null && sessions.length > 0 && (
        <ul className="mcp-members" aria-label="Open sessions">
          {sessions.map((session) => (
            <li key={session.idPrefix} className="mcp-member">
              <code className="mcp-member-glob">{session.idPrefix}…</code>
              <span className="mcp-rule-name">{session.toolsetName ?? session.toolsetId}</span>
              {session.clientInfo.name && (
                <span className="kb-subtle">
                  {session.clientInfo.name}
                  {session.clientInfo.version ? ` ${session.clientInfo.version}` : ""}
                </span>
              )}
              <span className="kb-subtle">last call {formatDate(session.lastSeenAt)}</span>
              {!session.tracked ? (
                <span className="kb-subtle">outside content not tracked</span>
              ) : session.labels && (session.labels.provenance.length > 0 || session.labels.dataClasses.length > 0) ? (
                <DataLabelChips labels={session.labels} />
              ) : (
                <span className="kb-subtle">nothing from outside yet</span>
              )}
              {(session.guard?.blocks ?? 0) > 0 && (
                <span
                  className="mcp-flag"
                  data-testid="session-guard-blocks"
                  title={session.guard?.lastBlock ? `Last: ${session.guard.lastBlock.tool}, ${session.guard.lastBlock.reason}` : undefined}
                >
                  Rules blocked {session.guard?.blocks}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClientUsage({ clientId }: { clientId: string }) {
  const [usageWindow, setUsageWindow] = useState<McpTelemetryWindow>("7d");
  const [usage, setUsage] = useState<McpTelemetryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchMcpClientUsage(clientId, usageWindow)
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, usageWindow]);

  return (
    <div className="mcp-client-usage" aria-label="Client usage">
      <div className="finops-range" role="tablist" aria-label="Usage window">
        {(["24h", "7d", "30d"] as McpTelemetryWindow[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={usageWindow === entry}
            className={usageWindow === entry ? "finops-range-btn active" : "finops-range-btn"}
            onClick={() => setUsageWindow(entry)}
          >
            {entry}
          </button>
        ))}
      </div>
      {error && <div className="settings-error">{error}</div>}
      {usage && (
        <>
          <div className="mcp-stats">
            <div className="mcp-stat">
              <div className="mcp-stat-label">Calls</div>
              <div className="mcp-stat-value">{usage.totals.calls}</div>
            </div>
            <div className="mcp-stat">
              <div className="mcp-stat-label">Errors</div>
              <div className="mcp-stat-value">{usage.totals.errors}</div>
              <div className="mcp-stat-hint">{Math.round(usage.totals.errorRate * 100)}% of calls</div>
            </div>
            <div className="mcp-stat">
              <div className="mcp-stat-label">p95 latency</div>
              <div className="mcp-stat-value">{formatMs(usage.totals.p95Ms)}</div>
            </div>
            <div className="mcp-stat">
              <div className="mcp-stat-label">Last call</div>
              <div className="mcp-stat-hint">{formatDate(usage.totals.lastCalledAt)}</div>
            </div>
          </div>
          {usage.tools.length > 0 && (
            <div className="mcp-table-scroll">
              <table className="kb-table mcp-tool-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Calls</th>
                    <th>Errors</th>
                    <th>p50</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.tools.map((tool) => (
                    <tr key={`${tool.adapterId ?? ""}:${tool.toolName}`}>
                      <td>
                        <code>{tool.toolName}</code>
                      </td>
                      <td className="num">{tool.calls}</td>
                      <td className="num">{tool.errors}</td>
                      <td className="num">{formatMs(tool.p50Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
