/**
 * Phase 10.1 — MCP server registry.
 *
 * List on the left, detail on the right (same layout as the knowledge base
 * page). The detail shows probe health, the tool schema history with diffs,
 * the pending breaking change (if any) and the nodes that use the server.
 * The Tools table carries per-tool call telemetry for a selectable window.
 *
 * Phase 10.2 — a Policies view holds the MCP tool policy rules, and the Tools
 * table shows each tool's read-only classification and whether the viewer's
 * role may use it.
 *
 * Phase 10.4 — Toolsets and Clients views manage the MCP gateway: toolsets
 * served at /mcp/<slug> and the client tokens that may call them.
 *
 * Phase 10.6 — "Import config" brings servers in from client config files,
 * the catalog banner reports the deployment catalog, and the Playground view
 * calls one tool through a schema-driven form.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type McpPreset,
  type McpRegisteredServer,
  type McpServerInput,
  type McpServerProbe,
  type McpServerUsage,
  type McpSnapshotTool,
  type McpTelemetryResponse,
  type McpTelemetryWindow,
  type McpToolSnapshotSummary,
  type McpToolTelemetry,
  type SecretListItem,
  acceptMcpServerChange,
  setMcpToolClassification,
  createMcpServer,
  deleteMcpServer,
  fetchMcpPresets,
  fetchMcpServer,
  fetchMcpServers,
  fetchMcpServerTelemetry,
  fetchMcpServerTools,
  fetchSecrets,
  probeMcpServer,
  updateMcpServer
} from "../lib/api";
import { McpAnnotationChips, McpOutputSchema } from "./McpToolMeta";
import { McpAuthFields } from "./McpAuthFields";
import { McpCatalogBanner } from "./McpCatalogBanner";
import { McpClientsView } from "./McpClientsView";
import { McpImportDialog } from "./McpImportDialog";
import { McpOAuthPanel, usesOAuth } from "./McpOAuthPanel";
import { McpPlaygroundPage } from "./McpPlaygroundPage";
import { McpPoliciesView } from "./McpPoliciesView";
import { McpToolsetsView } from "./McpToolsetsView";

const STATUS_LABEL: Record<McpRegisteredServer["status"], string> = {
  unknown: "Not probed",
  healthy: "Healthy",
  degraded: "Degraded",
  down: "Down"
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

function formatInterval(ms: number): string {
  if (ms <= 0) return "off";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1000)} s`;
}

function adapterShort(adapterId: string): string {
  return adapterId.replace(/_mcp$|-mcp$/, "");
}

export function StatusBadge({ status }: { status: McpRegisteredServer["status"] }) {
  return (
    <span className={`mcp-status mcp-status-${status}`}>
      <span className="mcp-status-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

interface McpServersPageProps {
  isAdmin: boolean;
  /** Builder or above: may preview imports and use the playground. Defaults to isAdmin. */
  canBuild?: boolean;
  /** Keys the playground's per-user call history in this browser. */
  currentUserId?: string;
  activeProjectId?: string | null;
}

export function McpServersPage({ isAdmin, canBuild = isAdmin, currentUserId, activeProjectId }: McpServersPageProps) {
  const [servers, setServers] = useState<McpRegisteredServer[]>([]);
  const [adapters, setAdapters] = useState<Array<{ id: string; label: string }>>([]);
  const [defaultIntervalMs, setDefaultIntervalMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);
  const [view, setView] = useState<"servers" | "policies" | "toolsets" | "clients" | "playground">("servers");
  const [showImport, setShowImport] = useState(false);

  const refreshList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchMcpServers(activeProjectId ?? undefined);
      setServers(r.servers);
      setAdapters(r.adapters);
      setDefaultIntervalMs(r.defaultProbeIntervalMs);
      setSelectedId((current) =>
        current && r.servers.some((server) => server.id === current) ? current : r.servers[0]?.id ?? null
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const onServerChanged = useCallback(async () => {
    await refreshList();
    setDetailVersion((v) => v + 1);
  }, [refreshList]);

  return (
    <section className="kb-page mcp-page page-pane">
      <header className="kb-header page-head">
        <div className="page-head-copy">
          <h2 className="page-title">MCP servers</h2>
          <p className="page-sub">
            Every MCP server your agents call, probed on a schedule ({formatInterval(defaultIntervalMs)} by default) with
            its tool schemas kept as history. Nodes that pick a registered server follow edits made here.
          </p>
        </div>
        <div className="page-actions">
          <div className="finops-range" role="tablist" aria-label="MCP view">
            <button
              type="button"
              role="tab"
              aria-selected={view === "servers"}
              className={view === "servers" ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setView("servers")}
            >
              Servers
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "policies"}
              className={view === "policies" ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setView("policies")}
            >
              Policies
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "toolsets"}
              className={view === "toolsets" ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setView("toolsets")}
            >
              Toolsets
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "clients"}
              className={view === "clients" ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setView("clients")}
            >
              Clients
            </button>
            {canBuild && (
              <button
                type="button"
                role="tab"
                aria-selected={view === "playground"}
                className={view === "playground" ? "finops-range-btn active" : "finops-range-btn"}
                onClick={() => setView("playground")}
              >
                Playground
              </button>
            )}
          </div>
          {view === "servers" && (
            <button type="button" className="pg-btn" onClick={() => void onServerChanged()} disabled={loading}>
              Refresh
            </button>
          )}
          {canBuild && view === "servers" && (
            <button type="button" className="pg-btn" onClick={() => setShowImport(true)}>
              Import config
            </button>
          )}
          {isAdmin && view === "servers" && (
            <button type="button" className="pg-btn primary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Cancel" : "+ Register server"}
            </button>
          )}
        </div>
      </header>

      {error && <div className="settings-error">{error}</div>}

      {view === "policies" && (
        <McpPoliciesView isAdmin={isAdmin} servers={servers} adapters={adapters} activeProjectId={activeProjectId} />
      )}

      {view === "toolsets" && <McpToolsetsView isAdmin={isAdmin} servers={servers} activeProjectId={activeProjectId} />}

      {view === "clients" && <McpClientsView isAdmin={isAdmin} />}

      {view === "playground" && canBuild && (
        <McpPlaygroundPage servers={servers} activeProjectId={activeProjectId} userId={currentUserId} />
      )}

      {view === "servers" && canBuild && <McpCatalogBanner isAdmin={isAdmin} />}

      <McpImportDialog
        open={showImport}
        canImport={isAdmin}
        projectId={activeProjectId ?? null}
        onClose={() => setShowImport(false)}
        onImported={(imported) => {
          void refreshList().then(() => {
            if (imported[0]) setSelectedId(imported[0].id);
          });
        }}
      />

      {view === "servers" && showCreate && isAdmin && (
        <McpServerForm
          adapters={adapters}
          projectId={activeProjectId ?? null}
          defaultIntervalMs={defaultIntervalMs}
          onSaved={async (server) => {
            setShowCreate(false);
            await refreshList();
            setSelectedId(server.id);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {view === "servers" && (
      <div className="kb-layout">
        <aside className="kb-list" aria-label="Registered MCP servers">
          {loading && servers.length === 0 ? (
            <p className="kb-subtle">Loading…</p>
          ) : servers.length === 0 ? (
            <p className="kb-subtle">
              No servers registered yet.{" "}
              {isAdmin ? "Register one to probe it and pick it on MCP Tool nodes." : "Ask an admin to register one."}
            </p>
          ) : (
            servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={selectedId === server.id ? "kb-item active" : "kb-item"}
                onClick={() => setSelectedId(server.id)}
              >
                <div className="mcp-item-head">
                  <span className="kb-item-name">{server.name}</span>
                  <span className={`mcp-dot mcp-status-${server.status}`} title={STATUS_LABEL[server.status]} />
                </div>
                <div className="kb-item-meta">
                  {adapterShort(server.adapterId)} · {server.toolCount} tools
                  {server.latency.p95Ms !== null && <> · p95 {formatMs(server.latency.p95Ms)}</>}
                </div>
                {server.pendingBreakingSnapshotId && <span className="mcp-flag">Breaking change</span>}
              </button>
            ))
          )}
        </aside>

        <div className="kb-detail">
          {selectedId ? (
            <McpServerDetail
              key={`${selectedId}:${detailVersion}`}
              serverId={selectedId}
              isAdmin={isAdmin}
              projectId={activeProjectId ?? undefined}
              adapters={adapters}
              defaultIntervalMs={defaultIntervalMs}
              onChanged={onServerChanged}
              onDeleted={async () => {
                setSelectedId(null);
                await refreshList();
              }}
            />
          ) : (
            <p className="kb-subtle">Select a server on the left, or register one to get started.</p>
          )}
        </div>
      </div>
      )}
    </section>
  );
}

function McpServerForm({
  adapters,
  projectId,
  defaultIntervalMs,
  initial,
  onSaved,
  onCancel
}: {
  adapters: Array<{ id: string; label: string }>;
  projectId: string | null;
  defaultIntervalMs: number;
  initial?: McpRegisteredServer;
  onSaved: (server: McpRegisteredServer) => Promise<void>;
  onCancel: () => void;
}) {
  const [presets, setPresets] = useState<McpPreset[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [presetNote, setPresetNote] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [adapterId, setAdapterId] = useState(initial?.adapterId ?? "http_mcp");
  const [connectionJson, setConnectionJson] = useState(
    JSON.stringify(initial?.connection ?? { endpoint: "http://127.0.0.1:7001/mcp", transport: "http_streamable" }, null, 2)
  );
  const [secretId, setSecretId] = useState(initial?.secretId ?? "");
  const [owner, setOwner] = useState(initial?.owner ?? "");
  const [probeEnabled, setProbeEnabled] = useState(initial?.probeEnabled ?? true);
  const [intervalMinutes, setIntervalMinutes] = useState(
    initial?.probeIntervalMs ? String(initial.probeIntervalMs / 60_000) : ""
  );
  const [blockOnBreakingChange, setBlockOnBreakingChange] = useState(initial?.blockOnBreakingChange ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      initial ? Promise.resolve({ presets: [] as McpPreset[] }) : fetchMcpPresets(),
      fetchSecrets({ projectId: projectId ?? undefined })
    ])
      .then(([presetResult, secretList]) => {
        if (cancelled) return;
        setPresets(presetResult.presets);
        setSecrets(secretList);
      })
      .catch(() => {
        // Presets and secrets only prefill the form; it still works without them.
      });
    return () => {
      cancelled = true;
    };
  }, [initial, projectId]);

  const applyPreset = (presetId: string) => {
    const preset = presets.find((entry) => entry.id === presetId);
    if (!preset) return;
    setName(preset.name);
    setDescription(preset.description);
    setAdapterId(preset.serverAdapter);
    setConnectionJson(JSON.stringify(preset.connection, null, 2));
    setPresetNote([preset.notes, preset.credentialHint?.description].filter(Boolean).join(" ") || null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    let connection: Record<string, unknown>;
    try {
      const parsed: unknown = connectionJson.trim() ? JSON.parse(connectionJson) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      connection = parsed as Record<string, unknown>;
    } catch {
      setError("Connection must be a JSON object.");
      return;
    }
    const minutes = intervalMinutes.trim() ? Number(intervalMinutes) : null;
    if (minutes !== null && (!Number.isFinite(minutes) || minutes * 60_000 < 10_000)) {
      setError("Probe interval must be at least 10 seconds (0.17 min).");
      return;
    }
    const payload: McpServerInput = {
      name: name.trim(),
      description: description.trim() || null,
      adapterId,
      connection,
      secretRef: secretId ? { secretId } : null,
      owner: owner.trim() || null,
      probeEnabled,
      probeIntervalMs: minutes === null ? null : Math.round(minutes * 60_000),
      blockOnBreakingChange
    };
    setBusy(true);
    try {
      const result = initial
        ? await updateMcpServer(initial.id, payload)
        : await createMcpServer({ ...payload, projectId });
      await onSaved(result.server);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="kb-create-form mcp-form" aria-label={initial ? "Edit MCP server" : "Register MCP server"}>
      {error && <div className="settings-error">{error}</div>}
      {!initial && presets.length > 0 && (
        <div className="kb-form-row">
          <label>
            Start from a preset
            <select defaultValue="" onChange={(event) => applyPreset(event.target.value)}>
              <option value="">Custom server</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.category} · {preset.name}
                </option>
              ))}
            </select>
            {presetNote && <small className="kb-subtle">{presetNote}</small>}
          </label>
        </div>
      )}
      <div className="kb-form-row kb-form-row-2">
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="GitHub (ops org)" />
        </label>
        <label>
          Owner
          <input type="text" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Defaults to you" />
        </label>
      </div>
      <div className="kb-form-row">
        <label>
          Description
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What agents use it for" />
        </label>
      </div>
      <div className="kb-form-row kb-form-row-2">
        <label>
          Adapter
          <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
            {adapters.map((adapter) => (
              <option key={adapter.id} value={adapter.id}>
                {adapter.label}
              </option>
            ))}
            {!adapters.some((adapter) => adapter.id === adapterId) && <option value={adapterId}>{adapterId}</option>}
          </select>
        </label>
        <label>
          Auth secret
          <select value={secretId} onChange={(e) => setSecretId(e.target.value)}>
            <option value="">None</option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name} ({secret.provider})
              </option>
            ))}
            {secretId && !secrets.some((secret) => secret.id === secretId) && <option value={secretId}>{secretId}</option>}
          </select>
        </label>
      </div>
      <div className="kb-form-row">
        <label>
          Connection (JSON)
          <textarea value={connectionJson} onChange={(e) => setConnectionJson(e.target.value)} rows={5} spellCheck={false} />
          <small className="kb-subtle">
            http: <code>endpoint</code>, <code>transport</code>, <code>authType</code>. stdio: <code>command</code>, <code>args</code>,{" "}
            <code>secretEnvVar</code>. Secret values never go here; pick a secret above.
          </small>
        </label>
      </div>
      {adapterId === "http_mcp" && (
        <div className="kb-form-row">
          <McpAuthFields connectionJson={connectionJson} onConnectionJsonChange={setConnectionJson} />
        </div>
      )}
      <div className="kb-form-row kb-form-row-2">
        <label className="mcp-check">
          <input type="checkbox" checked={probeEnabled} onChange={(e) => setProbeEnabled(e.target.checked)} />
          Probe on a schedule
        </label>
        <label>
          Probe every (minutes)
          <input
            type="number"
            min="0.17"
            step="any"
            value={intervalMinutes}
            onChange={(e) => setIntervalMinutes(e.target.value)}
            placeholder={`Default (${formatInterval(defaultIntervalMs)})`}
            disabled={!probeEnabled}
          />
        </label>
      </div>
      <div className="kb-form-row">
        <label className="mcp-check">
          <input type="checkbox" checked={blockOnBreakingChange} onChange={(e) => setBlockOnBreakingChange(e.target.checked)} />
          Block runs when a probe sees a breaking tool schema change, until an admin accepts it
        </label>
      </div>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : initial ? "Save changes" : "Register server"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function McpServerDetail({
  serverId,
  isAdmin,
  projectId,
  adapters,
  defaultIntervalMs,
  onChanged,
  onDeleted
}: {
  serverId: string;
  isAdmin: boolean;
  /** Project whose tool policy marks the tools; the server's own project when omitted. */
  projectId?: string;
  adapters: Array<{ id: string; label: string }>;
  defaultIntervalMs: number;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [server, setServer] = useState<McpRegisteredServer | null>(null);
  const [probes, setProbes] = useState<McpServerProbe[]>([]);
  const [snapshots, setSnapshots] = useState<McpToolSnapshotSummary[]>([]);
  const [usages, setUsages] = useState<McpServerUsage[]>([]);
  const [tools, setTools] = useState<McpSnapshotTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [telemetryWindow, setTelemetryWindow] = useState<McpTelemetryWindow>("7d");
  const [telemetry, setTelemetry] = useState<McpTelemetryResponse | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTelemetryError(null);
    fetchMcpServerTelemetry(serverId, telemetryWindow)
      .then((response) => {
        if (!cancelled) setTelemetry(response);
      })
      .catch((err) => {
        if (cancelled) return;
        setTelemetry(null);
        setTelemetryError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, telemetryWindow]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, toolList] = await Promise.all([fetchMcpServer(serverId), fetchMcpServerTools(serverId, projectId)]);
      setServer(detail.server);
      setProbes(detail.probes);
      setSnapshots(detail.snapshots);
      setUsages(detail.usages);
      setTools(toolList.tools);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [serverId, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!server) return;
    const inUse = usages.length > 0;
    const message = inUse
      ? `"${server.name}" is used by ${usages.length} node(s). Deleting it makes those nodes fail until they pick another server. Delete anyway?`
      : `Delete "${server.name}" and its probe history? This cannot be undone.`;
    if (!window.confirm(message)) return;
    setBusy("delete");
    try {
      await deleteMcpServer(server.id, { force: inUse });
      await onDeleted();
    } catch (err) {
      setError(formatError(err));
      setBusy(null);
    }
  };

  const pendingSnapshot = useMemo(
    () => snapshots.find((snapshot) => snapshot.id === server?.pendingBreakingSnapshotId) ?? null,
    [snapshots, server?.pendingBreakingSnapshotId]
  );

  if (loading && !server) return <p className="kb-subtle">Loading…</p>;
  if (!server) return <p className="kb-subtle">{error ?? "MCP server not found."}</p>;

  if (editing) {
    return (
      <McpServerForm
        adapters={adapters}
        projectId={server.projectId}
        defaultIntervalMs={defaultIntervalMs}
        initial={server}
        onSaved={async () => {
          setEditing(false);
          await onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const intervalLabel = server.probeEnabled
    ? `every ${formatInterval(server.probeIntervalMs ?? defaultIntervalMs)}${server.probeIntervalMs ? "" : " (default)"}`
    : "manual only";

  return (
    <div className="kb-detail-pane mcp-detail">
      {error && <div className="settings-error">{error}</div>}

      <header className="kb-detail-header">
        <div>
          <div className="mcp-title-row">
            <h3>{server.name}</h3>
            <StatusBadge status={server.status} />
          </div>
          {server.description && <p className="kb-subtle">{server.description}</p>}
          <div className="kb-detail-meta">
            <span>
              adapter <code>{server.adapterId}</code>
            </span>
            <span>·</span>
            <span>owner {server.owner ?? "—"}</span>
            <span>·</span>
            <span>probes {intervalLabel}</span>
            <span>·</span>
            <span>last probe {formatDate(server.lastProbeAt)}</span>
            {server.blockOnBreakingChange && (
              <>
                <span>·</span>
                <span>blocks runs on breaking changes</span>
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="pg-btn" onClick={() => void run("probe", () => probeMcpServer(server.id))} disabled={busy !== null}>
            {busy === "probe" ? "Probing…" : "Probe now"}
          </button>
          {isAdmin && (
            <>
              <button type="button" className="pg-btn ghost" onClick={() => setEditing(true)} disabled={busy !== null}>
                Edit
              </button>
              <button type="button" className="pg-btn ghost danger" onClick={() => void handleDelete()} disabled={busy !== null}>
                Delete
              </button>
            </>
          )}
        </div>
      </header>

      {server.pendingBreakingSnapshotId && (
        <section className="mcp-breaking" role="alert">
          <div className="mcp-breaking-head">
            <div>
              <strong>Breaking tool schema change</strong>
              <p className="kb-subtle">
                Seen {formatDate(pendingSnapshot?.createdAt ?? null)}.{" "}
                {server.blockOnBreakingChange
                  ? "Runs that use this server are blocked until an admin accepts the change."
                  : "Runs are not blocked; existing nodes may fail on the changed tools."}
              </p>
            </div>
            {isAdmin && (
              <button
                type="button"
                className="pg-btn primary"
                onClick={() => void run("accept", () => acceptMcpServerChange(server.id))}
                disabled={busy !== null}
              >
                {busy === "accept" ? "Accepting…" : "Accept change"}
              </button>
            )}
          </div>
          {pendingSnapshot && <ChangeList changes={pendingSnapshot.changes} />}
        </section>
      )}

      {server.lastProbeOk === false && server.lastProbeError && (
        <div className="settings-error">Last probe failed: {server.lastProbeError}</div>
      )}

      <div className="mcp-stats">
        <StatTile label="Tools" value={String(server.toolCount)} />
        <StatTile label="Latency p50" value={formatMs(server.latency.p50Ms)} />
        <StatTile label="Latency p95" value={formatMs(server.latency.p95Ms)} />
        <StatTile
          label="Failed probes"
          value={server.latency.errorRate === null ? "—" : `${Math.round(server.latency.errorRate * 100)}%`}
          hint={server.latency.samples ? `of the last ${server.latency.samples}` : "no probes yet"}
        />
      </div>

      {usesOAuth(server.adapterId, server.connection) && <McpOAuthPanel serverId={server.id} isAdmin={isAdmin} />}

      <ProbeStrip probes={probes} />

      <ToolsSection
        serverId={server.id}
        isAdmin={isAdmin}
        onToolChanged={(name, patch) =>
          setTools((current) => current.map((tool) => (tool.name === name ? { ...tool, ...patch } : tool)))
        }
        tools={tools}
        telemetry={telemetry}
        telemetryError={telemetryError}
        selectedWindow={telemetryWindow}
        onWindowChange={setTelemetryWindow}
      />

      <section className="kb-section">
        <h4>Schema history ({snapshots.length})</h4>
        {snapshots.length === 0 ? (
          <p className="kb-subtle">A snapshot is stored on the first successful probe and whenever the tool schemas change.</p>
        ) : (
          <ul className="mcp-history">
            {snapshots.map((snapshot) => (
              <SnapshotRow key={snapshot.id} snapshot={snapshot} current={snapshot.id === server.currentSnapshotId} />
            ))}
          </ul>
        )}
      </section>

      <section className="kb-section">
        <h4>Used by ({usages.length})</h4>
        {usages.length === 0 ? (
          <p className="kb-subtle">
            No nodes reference this server yet. Pick it under "Registered server" on an MCP Tool node.
          </p>
        ) : (
          <table className="kb-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Node</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {usages.map((usage) => (
                <tr key={`${usage.workflowId}:${usage.nodeId}`}>
                  <td>{usage.workflowName}</td>
                  <td>{usage.nodeName}</td>
                  <td>
                    <code>{usage.nodeType}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const TELEMETRY_WINDOWS: Array<{ value: McpTelemetryWindow; label: string; long: string }> = [
  { value: "24h", label: "24 h", long: "24 hours" },
  { value: "7d", label: "7 d", long: "7 days" },
  { value: "30d", label: "30 d", long: "30 days" }
];

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatCost(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatRate(rate: number): string {
  const pct = rate * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}

function ErrorsCell({ stats }: { stats: McpToolTelemetry }) {
  if (stats.errors === 0) return <>0</>;
  return (
    <span className="mcp-status mcp-status-down" title={`${stats.errors} of ${stats.calls} calls failed`}>
      <span className="mcp-status-dot" aria-hidden="true" />
      {stats.errors} · {formatRate(stats.errorRate)}
    </span>
  );
}

/**
 * Snapshot tools with their call telemetry, busiest first. Tools that were
 * called in the window but are no longer in the snapshot are listed too.
 */
function ClassificationCell({
  serverId,
  tool,
  isAdmin,
  onChanged
}: {
  serverId: string;
  tool: McpSnapshotTool;
  isAdmin: boolean;
  onChanged: (patch: Pick<McpSnapshotTool, "classification" | "manualReadOnly">) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const classification = tool.classification;
  const access = tool.access;
  const sourceLabel = !classification
    ? null
    : classification.source === "unknown"
      ? "unknown → write"
      : classification.source;

  const change = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const readOnly = value === "auto" ? null : value === "read";
      const result = await setMcpToolClassification(serverId, tool.name, readOnly);
      onChanged({ classification: result.classification, manualReadOnly: result.manualReadOnly });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-access">
      {classification && (
        <span className={classification.readOnly ? "mcp-class is-read" : "mcp-class is-write"}>
          {classification.readOnly ? "Read-only" : "Write"}
          <span className="mcp-class-source">{sourceLabel}</span>
        </span>
      )}
      {access && !access.allowed && (
        <span className="mcp-blocked" title={access.message}>
          Blocked for your role{access.ruleName ? `: ${access.ruleName}` : access.ruleId ? `: ${access.ruleId}` : ""}
        </span>
      )}
      {isAdmin && (
        <select
          className="mcp-class-select"
          aria-label={`Classification for ${tool.name}`}
          value={tool.manualReadOnly === true ? "read" : tool.manualReadOnly === false ? "write" : "auto"}
          disabled={busy}
          onChange={(event) => void change(event.target.value)}
        >
          <option value="auto">Auto (annotation)</option>
          <option value="read">Mark read-only</option>
          <option value="write">Mark write</option>
        </select>
      )}
      {error && <span className="mcp-blocked">{error}</span>}
    </div>
  );
}

function ToolsSection({
  serverId,
  isAdmin,
  onToolChanged,
  tools,
  telemetry,
  telemetryError,
  selectedWindow,
  onWindowChange
}: {
  serverId: string;
  isAdmin: boolean;
  onToolChanged: (name: string, patch: Partial<McpSnapshotTool>) => void;
  tools: McpSnapshotTool[];
  telemetry: McpTelemetryResponse | null;
  telemetryError: string | null;
  selectedWindow: McpTelemetryWindow;
  onWindowChange: (value: McpTelemetryWindow) => void;
}) {
  const rows = useMemo(() => {
    const stats = new Map((telemetry?.tools ?? []).map((entry) => [entry.toolName, entry]));
    const listed = tools.map((tool) => ({ name: tool.name, tool, stats: stats.get(tool.name) }));
    const known = new Set(tools.map((tool) => tool.name));
    const removed = (telemetry?.tools ?? [])
      .filter((entry) => !known.has(entry.toolName))
      .map((entry) => ({ name: entry.toolName, tool: undefined, stats: entry }));
    return [...listed, ...removed].sort((a, b) => (b.stats?.calls ?? 0) - (a.stats?.calls ?? 0));
  }, [tools, telemetry]);
  const windowLabel = TELEMETRY_WINDOWS.find((entry) => entry.value === selectedWindow)?.long ?? selectedWindow;
  const totals = telemetry?.totals;

  return (
    <section className="kb-section">
      <div className="mcp-section-head">
        <h4>Tools ({tools.length})</h4>
        <select
          className="finops-select"
          aria-label="Telemetry window"
          value={selectedWindow}
          onChange={(event) => onWindowChange(event.target.value as McpTelemetryWindow)}
        >
          {TELEMETRY_WINDOWS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              Last {entry.label}
            </option>
          ))}
        </select>
      </div>
      {telemetryError ? (
        <p className="kb-subtle">Call telemetry unavailable: {telemetryError}</p>
      ) : totals ? (
        <p className="kb-subtle">
          {totals.calls === 0
            ? `No calls in the last ${windowLabel}.`
            : `${totals.calls} ${totals.calls === 1 ? "call" : "calls"} in the last ${windowLabel} · ${totals.errors} failed · ${formatCost(totals.costUsd)} estimated`}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="kb-subtle">No tool snapshot yet. Run a probe to list the server's tools.</p>
      ) : (
        <div className="mcp-table-scroll">
        <table className="kb-table mcp-tool-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Access</th>
              <th>Inputs</th>
              <th>Outputs</th>
              <th className="num">Calls</th>
              <th className="num">p50</th>
              <th className="num">p95</th>
              <th className="num">Errors</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ name, tool, stats }) => {
              const called = stats && stats.calls > 0 ? stats : undefined;
              return (
                <tr key={name}>
                  <td>
                    <code>{name}</code>
                    {tool?.description ? <div className="kb-subtle">{tool.description}</div> : null}
                    {tool?.annotations ? <McpAnnotationChips annotations={tool.annotations} /> : null}
                  </td>
                  <td>
                    {tool ? (
                      <ClassificationCell
                        serverId={serverId}
                        tool={tool}
                        isAdmin={isAdmin}
                        onChanged={(patch) => onToolChanged(name, patch)}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {tool ? <ToolInputs schema={tool.inputSchema} /> : <span className="kb-subtle">not in current snapshot</span>}
                  </td>
                  <td>{tool ? <McpOutputSchema schema={tool.outputSchema} compact /> : "—"}</td>
                  <td className="num">{called ? formatCount(called.calls) : "—"}</td>
                  <td className="num">{called ? formatMs(called.p50Ms) : "—"}</td>
                  <td className="num">{called ? formatMs(called.p95Ms) : "—"}</td>
                  <td className="num">{called ? <ErrorsCell stats={called} /> : "—"}</td>
                  <td className="num" title={called ? `${called.inputTokens} in · ${called.outputTokens} out` : undefined}>
                    {called ? formatCount(called.inputTokens + called.outputTokens) : "—"}
                  </td>
                  <td className="num">{called ? formatCost(called.costUsd) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="mcp-stat">
      <div className="mcp-stat-label">{label}</div>
      <div className="mcp-stat-value">{value}</div>
      {hint && <div className="mcp-stat-hint">{hint}</div>}
    </div>
  );
}

/** Slots in the probe strip; matches the number of probes the detail endpoint returns. */
const PROBE_STRIP_SLOTS = 50;

/**
 * Recent probes, newest on the right. Slots are fixed so the newest probe always sits by the
 * "latest" label. Bar height is latency; failed probes are full-height error bars.
 */
export function ProbeStrip({ probes }: { probes: McpServerProbe[] }) {
  const ordered = useMemo(() => [...probes].reverse().slice(-PROBE_STRIP_SLOTS), [probes]);
  const okLatencies = ordered.filter((probe) => probe.ok).map((probe) => probe.latencyMs);
  const maxLatency = Math.max(1, ...okLatencies);
  const emptySlots = PROBE_STRIP_SLOTS - ordered.length;
  const [showTable, setShowTable] = useState(false);

  return (
    <section className="kb-section">
      <div className="mcp-section-head">
        <h4>Probe history ({probes.length})</h4>
        {probes.length > 0 && (
          <button type="button" className="kb-link-btn" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Show chart" : "Show table"}
          </button>
        )}
      </div>
      {probes.length === 0 ? (
        <p className="kb-subtle">No probes yet.</p>
      ) : showTable ? (
        <table className="kb-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Result</th>
              <th className="num">Latency</th>
              <th className="num">Tools</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((probe) => (
              <tr key={probe.id}>
                <td>{formatDate(probe.startedAt)}</td>
                <td>{probe.ok ? "ok" : "failed"}</td>
                <td className="num">{formatMs(probe.latencyMs)}</td>
                <td className="num">{probe.ok ? probe.toolCount : "—"}</td>
                <td>{probe.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div className="mcp-strip" role="img" aria-label={`Last ${probes.length} probes, oldest first`}>
            {Array.from({ length: emptySlots }, (_, index) => (
              <span key={`empty-${index}`} className="mcp-strip-cell is-empty" aria-hidden="true" />
            ))}
            {ordered.map((probe) => {
              const label = `${formatDate(probe.startedAt)} · ${
                probe.ok ? `ok · ${formatMs(probe.latencyMs)} · ${probe.toolCount} tools` : `failed · ${probe.error ?? "error"}`
              }`;
              const height = probe.ok ? Math.max(8, Math.round((probe.latencyMs / maxLatency) * 100)) : 100;
              return (
                <span key={probe.id} className="mcp-strip-cell" title={label} aria-label={label} tabIndex={0}>
                  <span className={probe.ok ? "mcp-strip-bar" : "mcp-strip-bar is-failed"} style={{ height: `${height}%` }} />
                </span>
              );
            })}
          </div>
          <div className="mcp-strip-axis">
            <span>older</span>
            <span>
              {okLatencies.length
                ? `bar height = latency (max ${formatMs(maxLatency)}) · red = failed`
                : "every probe shown failed"}
            </span>
            <span>latest</span>
          </div>
        </>
      )}
    </section>
  );
}

function ToolInputs({ schema }: { schema: Record<string, unknown> }) {
  const properties =
    schema.properties && typeof schema.properties === "object" ? Object.keys(schema.properties as object) : [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []);
  if (properties.length === 0) return <span className="kb-subtle">none</span>;
  return (
    <span className="mcp-inputs">
      {properties.map((name) => (
        <code key={name} className={required.has(name) ? "is-required" : undefined} title={required.has(name) ? "required" : "optional"}>
          {name}
          {required.has(name) ? "*" : ""}
        </code>
      ))}
    </span>
  );
}

export function ChangeList({ changes }: { changes: McpToolSnapshotSummary["changes"] }) {
  if (changes.length === 0) return <p className="kb-subtle">Baseline snapshot.</p>;
  const sorted = [...changes].sort((a, b) => Number(b.breaking) - Number(a.breaking));
  return (
    <ul className="mcp-changes">
      {sorted.map((change, index) => (
        <li key={`${change.tool}:${change.kind}:${change.path ?? ""}:${index}`} className={change.breaking ? "is-breaking" : undefined}>
          <span className="mcp-change-tag">{change.breaking ? "breaking" : "compatible"}</span>
          <code>{change.tool}</code>
          <span>{change.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function SnapshotRow({ snapshot, current }: { snapshot: McpToolSnapshotSummary; current: boolean }) {
  const [open, setOpen] = useState(snapshot.breaking && !snapshot.acknowledgedAt);
  const breakingCount = snapshot.changes.filter((change) => change.breaking).length;
  const summary = snapshot.previousSnapshotId
    ? `${snapshot.changes.length} change${snapshot.changes.length === 1 ? "" : "s"}${breakingCount ? `, ${breakingCount} breaking` : ""}`
    : "baseline";
  return (
    <li className="mcp-history-item">
      <button type="button" className="mcp-history-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>{formatDate(snapshot.createdAt)}</span>
        <span className="kb-subtle">
          {snapshot.toolCount} tools · {summary}
        </span>
        {current && <span className="mcp-flag mcp-flag-neutral">current</span>}
        {snapshot.breaking && (
          <span className={snapshot.acknowledgedAt ? "mcp-flag mcp-flag-neutral" : "mcp-flag"}>
            {snapshot.acknowledgedAt ? `accepted by ${snapshot.acknowledgedBy ?? "admin"}` : "breaking"}
          </span>
        )}
      </button>
      {open && <ChangeList changes={snapshot.changes} />}
    </li>
  );
}
