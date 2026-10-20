/**
 * Phase 10.1 — MCP server registry.
 *
 * List on the left, detail on the right (same layout as the knowledge base
 * page). The detail shows probe health, the tool schema history with diffs,
 * the pending breaking change (if any) and the nodes that use the server.
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
  type McpToolSnapshotSummary,
  type SecretListItem,
  acceptMcpServerChange,
  createMcpServer,
  deleteMcpServer,
  fetchMcpPresets,
  fetchMcpServer,
  fetchMcpServers,
  fetchMcpServerTools,
  fetchSecrets,
  probeMcpServer,
  updateMcpServer
} from "../lib/api";

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
  activeProjectId?: string | null;
}

export function McpServersPage({ isAdmin, activeProjectId }: McpServersPageProps) {
  const [servers, setServers] = useState<McpRegisteredServer[]>([]);
  const [adapters, setAdapters] = useState<Array<{ id: string; label: string }>>([]);
  const [defaultIntervalMs, setDefaultIntervalMs] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailVersion, setDetailVersion] = useState(0);

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
          <button type="button" className="pg-btn" onClick={() => void onServerChanged()} disabled={loading}>
            Refresh
          </button>
          {isAdmin && (
            <button type="button" className="pg-btn primary" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Cancel" : "+ Register server"}
            </button>
          )}
        </div>
      </header>

      {error && <div className="settings-error">{error}</div>}

      {showCreate && isAdmin && (
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
  adapters,
  defaultIntervalMs,
  onChanged,
  onDeleted
}: {
  serverId: string;
  isAdmin: boolean;
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, toolList] = await Promise.all([fetchMcpServer(serverId), fetchMcpServerTools(serverId)]);
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
  }, [serverId]);

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

      <ProbeStrip probes={probes} />

      <section className="kb-section">
        <h4>Tools ({tools.length})</h4>
        {tools.length === 0 ? (
          <p className="kb-subtle">No tool snapshot yet. Run a probe to list the server's tools.</p>
        ) : (
          <table className="kb-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Inputs</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.name}>
                  <td>
                    <code>{tool.name}</code>
                  </td>
                  <td>
                    <ToolInputs schema={tool.inputSchema} />
                  </td>
                  <td>{tool.description || <span className="kb-subtle">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
