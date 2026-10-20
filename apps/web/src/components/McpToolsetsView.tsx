/**
 * Phase 10.4 — toolsets served by the MCP gateway.
 *
 * A toolset groups workflows with an "Expose as MCP Tool" trigger and
 * registered MCP servers (optionally narrowed by a tool glob). Each toolset
 * has its own Streamable HTTP endpoint at /mcp/<slug>. The detail shows the
 * endpoint with a copy button and a live preview of the tools a role sees
 * once tool policy is applied.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpPolicyRole, McpToolsetMemberSpec, Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  type McpRegisteredServer,
  type McpToolsetCandidate,
  type McpToolsetPreview,
  type McpToolsetView,
  createMcpToolset,
  deleteMcpToolset,
  fetchMcpToolsetCandidates,
  fetchMcpToolsets,
  fetchProjects,
  previewMcpToolset,
  updateMcpToolset
} from "../lib/api";
import { toolsetEndpointUrl } from "../lib/mcp-client-snippets";

const ROLES: McpPolicyRole[] = ["admin", "builder", "operator", "viewer"];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function pageOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/** Copy text and show "Copied" on the button for a moment. */
export function CopyButton({ text, label = "Copy", ariaLabel }: { text: string; label?: string; ariaLabel?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button type="button" className="pg-btn small" onClick={() => void copy()} aria-label={ariaLabel}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

interface McpToolsetsViewProps {
  isAdmin: boolean;
  servers: McpRegisteredServer[];
  activeProjectId?: string | null;
}

export function McpToolsetsView({ isAdmin, servers, activeProjectId }: McpToolsetsViewProps) {
  const [toolsets, setToolsets] = useState<McpToolsetView[]>([]);
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<McpToolsetCandidate[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | McpToolsetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, candidateList] = await Promise.all([fetchMcpToolsets(), fetchMcpToolsetCandidates()]);
      setToolsets(list.toolsets);
      setGatewayBaseUrl(list.gatewayBaseUrl);
      setCandidates(candidateList.workflows);
      setSelectedId((current) =>
        current && list.toolsets.some((toolset) => toolset.id === current) ? current : list.toolsets[0]?.id ?? null
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    fetchProjects()
      .then((result) => setProjects(result.projects))
      .catch(() => setProjects([]));
  }, []);

  const selected = toolsets.find((toolset) => toolset.id === selectedId) ?? null;

  const replaceToolset = (saved: McpToolsetView) => {
    setToolsets((current) =>
      current.some((entry) => entry.id === saved.id)
        ? current.map((entry) => (entry.id === saved.id ? saved : entry))
        : [...current, saved]
    );
    setSelectedId(saved.id);
  };

  const toggleEnabled = async (toolset: McpToolsetView) => {
    if (toolset.enabled && toolset.activeSessions > 0) {
      const message = `Disable "${toolset.name}"? ${toolset.activeSessions} connected client session(s) will be closed.`;
      if (!window.confirm(message)) return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await updateMcpToolset(toolset.id, { enabled: !toolset.enabled });
      replaceToolset(result.toolset);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (toolset: McpToolsetView) => {
    if (!window.confirm(`Delete toolset "${toolset.name}"? Clients scoped to it lose access and open sessions close.`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteMcpToolset(toolset.id);
      setToolsets((current) => current.filter((entry) => entry.id !== toolset.id));
      setSelectedId((current) => (current === toolset.id ? null : current));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-gateway">
      {error && <div className="settings-error">{error}</div>}

      <div className="mcp-section-head">
        <p className="kb-subtle">
          A toolset is an MCP endpoint that agents and IDEs connect to with a client token. It serves workflows with an
          &quot;Expose as MCP Tool&quot; trigger and tools of registered servers, filtered by tool policy for the
          client&apos;s role.
        </p>
        {isAdmin && editing === null && (
          <button type="button" className="pg-btn primary" onClick={() => setEditing("new")}>
            + New toolset
          </button>
        )}
      </div>

      {editing !== null && isAdmin && (
        <McpToolsetForm
          initial={editing === "new" ? undefined : editing}
          candidates={candidates}
          servers={servers}
          projects={projects}
          defaultProjectId={activeProjectId ?? null}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            replaceToolset(saved);
            setEditing(null);
          }}
        />
      )}

      <div className="kb-layout">
        <aside className="kb-list" aria-label="Toolsets">
          {loading && toolsets.length === 0 ? (
            <p className="kb-subtle">Loading…</p>
          ) : toolsets.length === 0 ? (
            <p className="kb-subtle">No toolsets yet. {isAdmin ? "Create one to serve tools over MCP." : "Only admins can create toolsets."}</p>
          ) : (
            toolsets.map((toolset) => (
              <button
                key={toolset.id}
                type="button"
                className={toolset.id === selectedId ? "kb-item active" : "kb-item"}
                aria-current={toolset.id === selectedId ? "true" : undefined}
                onClick={() => setSelectedId(toolset.id)}
              >
                <span className="mcp-item-head">
                  <span className="kb-item-name">{toolset.name}</span>
                  {!toolset.enabled && <span className="mcp-flag mcp-flag-neutral">disabled</span>}
                </span>
                <span className="kb-item-meta">
                  /mcp/{toolset.slug} · {toolset.members.length} member{toolset.members.length === 1 ? "" : "s"}
                </span>
              </button>
            ))
          )}
        </aside>

        <div className="kb-detail">
          {selected ? (
            <ToolsetDetail
              key={selected.id}
              toolset={selected}
              endpointUrl={toolsetEndpointUrl(selected.endpointPath, gatewayBaseUrl, pageOrigin())}
              projects={projects}
              isAdmin={isAdmin}
              busy={busy}
              onEdit={() => setEditing(selected)}
              onToggle={() => void toggleEnabled(selected)}
              onDelete={() => void remove(selected)}
            />
          ) : (
            <p className="kb-subtle">{loading ? "Loading…" : "Select a toolset to see its endpoint and tools."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolsetDetail({
  toolset,
  endpointUrl,
  projects,
  isAdmin,
  busy,
  onEdit,
  onToggle,
  onDelete
}: {
  toolset: McpToolsetView;
  endpointUrl: string;
  projects: Project[];
  isAdmin: boolean;
  busy: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const projectName = toolset.projectId
    ? projects.find((project) => project.id === toolset.projectId)?.name ?? toolset.projectId
    : "All projects";
  return (
    <div className="kb-detail-pane">
      <div className="kb-detail-header">
        <div>
          <div className="mcp-title-row">
            <h3>{toolset.name}</h3>
            <span className={toolset.enabled ? "mcp-status mcp-status-healthy" : "mcp-status"}>
              <span className="mcp-status-dot" aria-hidden="true" />
              {toolset.enabled ? "Serving" : "Disabled"}
            </span>
          </div>
          {toolset.description && <p className="kb-subtle">{toolset.description}</p>}
          <div className="kb-detail-meta">
            <span>
              Policy project <strong>{projectName}</strong>
            </span>
            <span>
              Open sessions <strong>{toolset.activeSessions}</strong>
            </span>
          </div>
        </div>
        {isAdmin && (
          <div className="mcp-rule-actions">
            <button type="button" className="pg-btn" onClick={onEdit} disabled={busy}>
              Edit
            </button>
            <button type="button" className="pg-btn ghost" onClick={onToggle} disabled={busy}>
              {toolset.enabled ? "Disable" : "Enable"}
            </button>
            <button type="button" className="pg-btn ghost danger" onClick={onDelete} disabled={busy}>
              Delete
            </button>
          </div>
        )}
      </div>

      <section className="kb-section">
        <h4>Endpoint</h4>
        <div className="mcp-endpoint">
          <code className="mcp-endpoint-url" data-testid="toolset-endpoint">
            {endpointUrl}
          </code>
          <CopyButton text={endpointUrl} ariaLabel="Copy endpoint URL" />
        </div>
        <p className="kb-subtle">
          Streamable HTTP transport. Clients send <code>Authorization: Bearer &lt;client token&gt;</code>; create a token on
          the Clients tab.
        </p>
      </section>

      <section className="kb-section">
        <h4>Members ({toolset.members.length})</h4>
        {toolset.members.length === 0 ? (
          <p className="kb-subtle">No members. {isAdmin ? "Edit the toolset to add workflows or servers." : ""}</p>
        ) : (
          <ul className="mcp-members" aria-label="Toolset members">
            {toolset.members.map((member) => (
              <li key={member.id} className="mcp-member">
                <span className="mcp-flag mcp-flag-neutral">{member.kind === "workflow" ? "workflow" : "server"}</span>
                <span className="mcp-rule-name">{member.label}</span>
                {member.kind === "server" && <code className="mcp-member-glob">{member.toolGlob ?? "*"}</code>}
                {member.missing && <span className="mcp-flag">missing</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ToolsetPreview toolsetId={toolset.id} version={toolset.updatedAt} />
    </div>
  );
}

function ToolsetPreview({ toolsetId, version }: { toolsetId: string; version: string }) {
  const [role, setRole] = useState<McpPolicyRole>("builder");
  const [preview, setPreview] = useState<McpToolsetPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    previewMcpToolset(toolsetId, role)
      .then((result) => {
        if (!cancelled) setPreview(result);
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
  }, [toolsetId, role, version]);

  return (
    <section className="kb-section" aria-label="Tool preview">
      <div className="mcp-section-head mcp-wrap">
        <h4>Tools a client sees</h4>
        <div className="finops-range" role="tablist" aria-label="Preview as role">
          {ROLES.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={role === entry}
              className={role === entry ? "finops-range-btn active" : "finops-range-btn"}
              onClick={() => setRole(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>
      <p className="kb-subtle">
        Preview for a client with the {role} role. A client never gets more than its creator&apos;s current role.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {loading && !preview ? (
        <p className="kb-subtle">Loading…</p>
      ) : preview ? (
        <>
          {preview.warnings.map((warning) => (
            <p key={warning} className="mcp-warning">
              {warning}
            </p>
          ))}
          {preview.tools.length === 0 ? (
            <p className="kb-subtle">No tools for this role.</p>
          ) : (
            <ul className="mcp-gw-tools" aria-label={`Tools visible to ${role}`}>
              {preview.tools.map((tool) => (
                <li key={tool.name} className="mcp-gw-tool">
                  <div className="mcp-rule-head">
                    <code className="mcp-gw-tool-name">{tool.name}</code>
                    <span className={tool.readOnly ? "mcp-class is-read" : "mcp-class is-write"}>
                      {tool.readOnly ? "read-only" : "write"}
                    </span>
                  </div>
                  <span className="kb-subtle">
                    {tool.kind === "workflow" ? `Workflow ${tool.workflowName ?? tool.workflowId}` : `${tool.serverName} · ${tool.toolName}`}
                  </span>
                  {tool.description && <span className="mcp-gw-tool-desc">{tool.description}</span>}
                </li>
              ))}
            </ul>
          )}
          {preview.hidden.length > 0 && (
            <div className="mcp-gw-hidden">
              <h4>Hidden by policy ({preview.hidden.length})</h4>
              <ul className="mcp-changes" aria-label={`Tools hidden from ${role}`}>
                {preview.hidden.map((entry) => (
                  <li key={entry.name} className="is-breaking">
                    <span className="mcp-change-tag">hidden</span>
                    <code>{entry.name}</code>
                    <span>{entry.ruleName ? `rule ${entry.ruleName}` : entry.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

interface ServerRow {
  key: number;
  serverId: string;
  toolGlob: string;
}

function McpToolsetForm({
  initial,
  candidates,
  servers,
  projects,
  defaultProjectId,
  onSaved,
  onCancel
}: {
  initial?: McpToolsetView;
  candidates: McpToolsetCandidate[];
  servers: McpRegisteredServer[];
  projects: Project[];
  defaultProjectId: string | null;
  onSaved: (toolset: McpToolsetView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [projectId, setProjectId] = useState(initial ? initial.projectId ?? "" : defaultProjectId ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [workflowIds, setWorkflowIds] = useState<string[]>(
    initial?.members.flatMap((member) => (member.kind === "workflow" ? [member.workflowId] : [])) ?? []
  );
  const [serverRows, setServerRows] = useState<ServerRow[]>(
    initial?.members.flatMap((member, index) =>
      member.kind === "server" ? [{ key: index, serverId: member.serverId, toolGlob: member.toolGlob ?? "" }] : []
    ) ?? []
  );
  const [nextKey, setNextKey] = useState(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workflowOptions = useMemo(() => {
    const known = new Set(candidates.map((candidate) => candidate.id));
    const extra = (initial?.members ?? [])
      .filter((member) => member.kind === "workflow" && !known.has(member.workflowId))
      .map((member) => ({ id: (member as { workflowId: string }).workflowId, name: member.label, projectId: null, tools: [] }));
    return [...candidates, ...extra];
  }, [candidates, initial]);

  const toggleWorkflow = (id: string) =>
    setWorkflowIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));

  const addServerRow = () => {
    setServerRows((current) => [...current, { key: nextKey, serverId: servers[0]?.id ?? "", toolGlob: "" }]);
    setNextKey((value) => value + 1);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const members: McpToolsetMemberSpec[] = [
      ...workflowIds.map((workflowId) => ({ kind: "workflow" as const, workflowId })),
      ...serverRows
        .filter((row) => row.serverId)
        .map((row) => ({ kind: "server" as const, serverId: row.serverId, toolGlob: row.toolGlob.trim() || null }))
    ];
    const payload = {
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      description: description.trim() || null,
      projectId: projectId || null,
      enabled,
      members
    };
    setBusy(true);
    try {
      const result = initial ? await updateMcpToolset(initial.id, payload) : await createMcpToolset(payload);
      onSaved(result.toolset);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="kb-create-form mcp-form mcp-gw-form"
      aria-label={initial ? "Edit toolset" : "New toolset"}
      onSubmit={(event) => void handleSubmit(event)}
    >
      {error && <div className="settings-error">{error}</div>}
      <div className="kb-form-row kb-form-row-2">
        <label>
          Name
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Support tools" />
        </label>
        <label>
          Slug
          <input
            type="text"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder={initial ? initial.slug : "derived from the name"}
            aria-describedby="toolset-slug-hint"
          />
          <small id="toolset-slug-hint" className="kb-subtle">
            Endpoint path /mcp/&lt;slug&gt;. Changing it disconnects open sessions.
          </small>
        </label>
      </div>
      <div className="kb-form-row kb-form-row-2">
        <label>
          Description
          <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          Policy project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects (global rules only)</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="mcp-role-picker mcp-gw-picker">
        <legend className="kb-subtle">Workflows exposed as tools</legend>
        {workflowOptions.length === 0 ? (
          <span className="kb-subtle">No workflow has an &quot;Expose as MCP Tool&quot; trigger yet.</span>
        ) : (
          workflowOptions.map((workflow) => (
            <label key={workflow.id} className="mcp-check">
              <input type="checkbox" checked={workflowIds.includes(workflow.id)} onChange={() => toggleWorkflow(workflow.id)} />
              <span>
                {workflow.name}
                {workflow.tools.length > 0 && <code className="mcp-member-glob">{workflow.tools.join(", ")}</code>}
              </span>
            </label>
          ))
        )}
      </fieldset>

      <fieldset className="mcp-role-picker mcp-gw-picker">
        <legend className="kb-subtle">Registered servers (tool glob such as read_* or *; empty means all tools)</legend>
        {serverRows.map((row, index) => (
          <div key={row.key} className="mcp-gw-server-row">
            <select
              aria-label={`Server ${index + 1}`}
              value={row.serverId}
              onChange={(event) =>
                setServerRows((current) =>
                  current.map((entry) => (entry.key === row.key ? { ...entry, serverId: event.target.value } : entry))
                )
              }
            >
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label={`Tool glob for server ${index + 1}`}
              placeholder="*"
              value={row.toolGlob}
              onChange={(event) =>
                setServerRows((current) =>
                  current.map((entry) => (entry.key === row.key ? { ...entry, toolGlob: event.target.value } : entry))
                )
              }
            />
            <button
              type="button"
              className="pg-btn ghost small"
              aria-label={`Remove server ${index + 1}`}
              onClick={() => setServerRows((current) => current.filter((entry) => entry.key !== row.key))}
            >
              Remove
            </button>
          </div>
        ))}
        {servers.length === 0 ? (
          <span className="kb-subtle">No servers registered.</span>
        ) : (
          <button type="button" className="pg-btn small" onClick={addServerRow}>
            + Add server
          </button>
        )}
      </fieldset>

      <label className="mcp-check">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        Enabled
      </label>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save toolset" : "Create toolset"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
