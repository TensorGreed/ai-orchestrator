/**
 * 12.6b — AI routes: the models L2M serves on its OpenAI-compatible /v1 endpoint.
 *
 * A route set belongs to a project (its budgets and Guard floor apply) and holds routes: a public model name (the
 * alias a caller sends as `model`) mapped to a provider, an upstream model and a stored secret. Admins create and
 * change sets and routes, pick a set's Guard profile and default rate limit, and grant sets to clients (on the
 * client's Governance). Builders read everything here, including usage. Nothing is served until a set is granted.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AiGatewayRoute, AiGatewayUsageSummary, Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  type AiGatewayRouteSetView,
  type McpClientView,
  type SecretListItem,
  createAiGatewayRoute,
  createAiGatewayRouteSet,
  deleteAiGatewayRoute,
  deleteAiGatewayRouteSet,
  fetchAiGatewayRouteSets,
  fetchAiGatewayUsage,
  fetchMcpClients,
  fetchMcpToolsets,
  fetchProjects,
  fetchSecrets,
  updateAiGatewayRoute,
  updateAiGatewayRouteSet
} from "../lib/api";
import { formatCost, formatCount } from "../lib/mcp-control-plane";
import { GatewayGuardPicker, GatewayRateLimitEditor, GovernanceRow, describeRateLimit } from "./McpGatewayGovernance";
import { CopyButton } from "./McpToolsetsView";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

function pageOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

type UsageWindow = "24h" | "7d" | "30d";

export interface AiRoutesViewProps {
  isAdmin: boolean;
  activeProjectId?: string | null;
}

export function AiRoutesView({ isAdmin, activeProjectId }: AiRoutesViewProps) {
  const [sets, setSets] = useState<AiGatewayRouteSetView[]>([]);
  const [providers, setProviders] = useState<{ chat: string[]; embedding: string[] }>({ chat: [], embedding: [] });
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<McpClientView[]>([]);
  const [secrets, setSecrets] = useState<SecretListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await fetchAiGatewayRouteSets();
      setSets(result.routeSets);
      setProviders(result.providers);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    fetchProjects()
      .then((result) => setProjects(result.projects))
      .catch(() => undefined);
    fetchMcpClients()
      .then((result) => setClients(result.clients))
      .catch(() => undefined);
    // The deployment's public gateway URL (MCP_GATEWAY_PUBLIC_URL) when set; this page's origin otherwise.
    fetchMcpToolsets()
      .then((result) => setGatewayBaseUrl(result.gatewayBaseUrl))
      .catch(() => undefined);
    if (isAdmin) {
      fetchSecrets()
        .then((list) => setSecrets(list))
        .catch(() => undefined);
    }
  }, [refresh, isAdmin]);

  const endpoint = `${(gatewayBaseUrl ?? "").replace(/\/+$/, "") || pageOrigin()}/v1`;
  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? id : "No project");
  const clientName = (id: string) => clients.find((client) => client.id === id)?.name ?? id;

  return (
    <div className="mcp-ai-routes">
      <section className="kb-section">
        <div className="mcp-section-head">
          <h4>OpenAI-compatible endpoint</h4>
        </div>
        <div className="mcp-endpoint">
          <code className="mcp-endpoint-url" data-testid="ai-gateway-endpoint">
            {endpoint}
          </code>
          <CopyButton text={endpoint} ariaLabel="Copy endpoint" />
        </div>
        <p className="kb-subtle">
          Applications call <code>/v1/chat/completions</code>, <code>/v1/embeddings</code> and <code>/v1/models</code> with a client token as the
          API key and a route&apos;s model name as <code>model</code>. Each request passes the client&apos;s rate limit and budgets and the
          set&apos;s Guard profile; only metadata (tokens, cost, latency) is recorded.
        </p>
      </section>

      <section className="kb-section">
        <div className="mcp-section-head">
          <h4>Route sets ({sets.length})</h4>
          {isAdmin && !creating && (
            <button type="button" className="pg-btn primary" onClick={() => setCreating(true)}>
              + New route set
            </button>
          )}
        </div>
        {error && <div className="settings-error">{error}</div>}
        {loading && <p className="kb-subtle">Loading…</p>}
        {!loading && sets.length === 0 && !creating && (
          <p className="kb-subtle">
            No route sets yet. {isAdmin ? "Create one, add routes, then grant it to a client on the client's Governance." : "An admin creates them."}
          </p>
        )}
        {creating && isAdmin && (
          <RouteSetForm
            projects={projects}
            defaultProjectId={activeProjectId ?? "default"}
            onCancel={() => setCreating(false)}
            onCreated={async () => {
              setCreating(false);
              await refresh();
            }}
          />
        )}
        {sets.map((set) => (
          <RouteSetCard
            key={set.id}
            set={set}
            isAdmin={isAdmin}
            providers={providers}
            secrets={secrets}
            projectLabel={projectName(set.projectId)}
            clientNames={set.clientIds.map(clientName)}
            onChanged={refresh}
          />
        ))}
      </section>

      <AiGatewayUsagePanel />
    </div>
  );
}

function RouteSetForm({
  projects,
  defaultProjectId,
  onCancel,
  onCreated
}: {
  projects: Project[];
  defaultProjectId: string;
  onCancel: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createAiGatewayRouteSet({ name: name.trim(), description: description.trim(), projectId: projectId || null });
      await onCreated();
    } catch (err) {
      setError(formatError(err));
      setBusy(false);
    }
  };

  return (
    <form className="kb-form mcp-form" onSubmit={(event) => void submit(event)} aria-label="New route set">
      {error && <div className="settings-error">{error}</div>}
      <div className="kb-form-row kb-form-row-3">
        <label>
          Name
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Product apps" />
        </label>
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">No project</option>
            {projects.length === 0 && <option value={defaultProjectId}>{defaultProjectId}</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <input type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>
      <small className="kb-subtle">The project&apos;s budgets count this set&apos;s requests, and its routes may use the project&apos;s secrets.</small>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy}>
          {busy ? "Creating…" : "Create route set"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RouteSetCard({
  set,
  isAdmin,
  providers,
  secrets,
  projectLabel,
  clientNames,
  onChanged
}: {
  set: AiGatewayRouteSetView;
  isAdmin: boolean;
  providers: { chat: string[]; embedding: string[] };
  secrets: SecretListItem[];
  projectLabel: string;
  clientNames: string[];
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AiGatewayRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="mcp-ai-route-set" aria-label={`Route set ${set.name}`} data-testid="ai-route-set">
      <div className="mcp-section-head mcp-wrap">
        <h5>
          {set.name} {!set.enabled && <span className="kb-subtle">(off)</span>}
        </h5>
        {isAdmin && (
          <div className="mcp-row-actions">
            <button type="button" className="pg-btn small" disabled={busy} onClick={() => void act(() => updateAiGatewayRouteSet(set.id, { enabled: !set.enabled }))}>
              {set.enabled ? "Turn off" : "Turn on"}
            </button>
            <button
              type="button"
              className="pg-btn small danger"
              disabled={busy}
              onClick={() => {
                if (typeof window !== "undefined" && !window.confirm(`Delete route set ${set.name}? Its clients lose these models.`)) return;
                void act(() => deleteAiGatewayRouteSet(set.id));
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      {set.description && <p className="kb-subtle">{set.description}</p>}
      {error && <div className="settings-error">{error}</div>}
      <dl className="mcp-rule-scope">
        <div>
          <dt>Project</dt>
          <dd>{projectLabel}</dd>
        </div>
        <div>
          <dt>Clients</dt>
          <dd>{clientNames.length === 0 ? "none (grant it on a client's Governance)" : clientNames.join(", ")}</dd>
        </div>
        <div>
          <dt>Default rate limit</dt>
          <dd>{describeRateLimit(set.rateLimit)}</dd>
        </div>
      </dl>

      <table className="kb-table mcp-ai-route-table">
        <thead>
          <tr>
            <th scope="col">Model name</th>
            <th scope="col">Kind</th>
            <th scope="col">Provider</th>
            <th scope="col">Upstream model</th>
            <th scope="col">Key</th>
            {isAdmin && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {set.routes.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 6 : 5} className="kb-subtle">
                No routes yet.
              </td>
            </tr>
          )}
          {set.routes.map((route) => (
            <tr key={route.id} data-testid="ai-route-row">
              <td>
                <code>{route.alias}</code> {!route.enabled && <span className="kb-subtle">(off)</span>}
              </td>
              <td>{route.kind}</td>
              <td>{route.providerId}</td>
              <td>{route.model}</td>
              <td>{route.secretRef ? secrets.find((secret) => secret.id === route.secretRef?.secretId)?.name ?? "stored secret" : "provider default"}</td>
              {isAdmin && (
                <td>
                  <button type="button" className="pg-btn small" disabled={busy} onClick={() => setEditing(route)}>
                    Edit
                  </button>{" "}
                  <button type="button" className="pg-btn small danger" disabled={busy} onClick={() => void act(() => deleteAiGatewayRoute(route.id))}>
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && !adding && !editing && (
        <button type="button" className="pg-btn small" onClick={() => setAdding(true)}>
          + Add route
        </button>
      )}
      {isAdmin && (adding || editing) && (
        <RouteForm
          key={editing?.id ?? "new"}
          route={editing}
          providers={providers}
          secrets={secrets.filter((secret) => !set.projectId || !secret.projectId || secret.projectId === set.projectId || secret.projectId === "default")}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSave={async (payload) => {
            if (editing) await updateAiGatewayRoute(editing.id, payload);
            else await createAiGatewayRoute(set.id, payload);
            setAdding(false);
            setEditing(null);
            await onChanged();
          }}
        />
      )}

      <section className="mcp-governance" aria-label={`Governance of ${set.name}`}>
        <GovernanceRow title="Guard">
          <GatewayGuardPicker scope="ai_route_set" id={set.id} isAdmin={isAdmin} />
        </GovernanceRow>
        <GovernanceRow title="Rate limit">
          <GatewayRateLimitEditor
            scope="ai_route_set"
            id={set.id}
            value={set.rateLimit}
            isAdmin={isAdmin}
            onSave={async (limit) => {
              const updated = await updateAiGatewayRouteSet(set.id, { rateLimit: limit });
              await onChanged();
              return updated.rateLimit;
            }}
          />
        </GovernanceRow>
      </section>
    </article>
  );
}

type RoutePayload = Parameters<typeof createAiGatewayRoute>[1];

/** Parses an optional number field; undefined when empty, null when invalid. */
function optionalNumber(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function RouteForm({
  route,
  providers,
  secrets,
  onCancel,
  onSave
}: {
  route: AiGatewayRoute | null;
  providers: { chat: string[]; embedding: string[] };
  secrets: SecretListItem[];
  onCancel: () => void;
  onSave: (payload: RoutePayload) => Promise<void>;
}) {
  const [alias, setAlias] = useState(route?.alias ?? "");
  const [kind, setKind] = useState<"chat" | "embedding">(route?.kind ?? "chat");
  const [providerId, setProviderId] = useState(route?.providerId ?? providers.chat[0] ?? "openai");
  const [model, setModel] = useState(route?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(route?.baseUrl ?? "");
  const [secretId, setSecretId] = useState(route?.secretRef?.secretId ?? "");
  const [temperature, setTemperature] = useState(route?.defaults.temperature !== undefined ? String(route.defaults.temperature) : "");
  const [maxTokens, setMaxTokens] = useState(route?.defaults.maxTokens !== undefined ? String(route.defaults.maxTokens) : "");
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerChoices = kind === "embedding" ? providers.embedding : providers.chat;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const temp = optionalNumber(temperature);
    const max = optionalNumber(maxTokens);
    if (!alias.trim() || !model.trim()) {
      setError("Model name and upstream model are required");
      return;
    }
    if (temp === null || max === null) {
      setError("Defaults must be numbers");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({
        alias: alias.trim(),
        kind,
        providerId,
        model: model.trim(),
        baseUrl: baseUrl.trim() || null,
        secretRef: secretId ? { secretId } : null,
        defaults: { ...(temp !== undefined ? { temperature: temp } : {}), ...(max !== undefined ? { maxTokens: max } : {}) },
        enabled
      });
    } catch (err) {
      setError(formatError(err));
      setBusy(false);
    }
  };

  return (
    <form className="kb-form mcp-form" onSubmit={(event) => void submit(event)} aria-label={route ? `Edit route ${route.alias}` : "New route"}>
      {error && <div className="settings-error">{error}</div>}
      <div className="kb-form-row kb-form-row-3">
        <label>
          Model name
          <input type="text" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="fast-chat" />
        </label>
        <label>
          Kind
          <select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as "chat" | "embedding";
              setKind(next);
              const list = next === "embedding" ? providers.embedding : providers.chat;
              if (!list.includes(providerId) && list[0]) setProviderId(list[0]);
            }}
          >
            <option value="chat">chat</option>
            <option value="embedding">embedding</option>
          </select>
        </label>
        <label>
          Provider
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            {!providerChoices.includes(providerId) && <option value={providerId}>{providerId}</option>}
            {providerChoices.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="kb-form-row kb-form-row-3">
        <label>
          Upstream model
          <input type="text" value={model} onChange={(event) => setModel(event.target.value)} placeholder={providerId === "azure_openai" ? "deployment name" : "gpt-4o-mini"} />
        </label>
        <label>
          Base URL (optional)
          <input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="provider default" />
        </label>
        <label>
          API key
          <select value={secretId} onChange={(event) => setSecretId(event.target.value)}>
            <option value="">Provider default (environment)</option>
            {secretId && !secrets.some((secret) => secret.id === secretId) && <option value={secretId}>{secretId}</option>}
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="kb-form-row kb-form-row-3">
        <label>
          Default temperature
          <input type="text" inputMode="decimal" value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="provider default" />
        </label>
        <label>
          Default max tokens
          <input type="text" inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="provider default" />
        </label>
        <label className="mcp-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>On</span>
        </label>
      </div>
      <small className="kb-subtle">Callers send the model name as <code>model</code>; a request&apos;s own parameters win over these defaults.</small>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy}>
          {busy ? "Saving…" : route ? "Save route" : "Add route"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function AiGatewayUsagePanel() {
  const [usageWindow, setUsageWindow] = useState<UsageWindow>("7d");
  const [usage, setUsage] = useState<AiGatewayUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchAiGatewayUsage({ window: usageWindow })
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [usageWindow]);

  const totals = usage?.totals;
  const rows = useMemo(() => usage?.byAlias ?? [], [usage]);

  return (
    <section className="kb-section" aria-label="AI gateway usage" data-testid="ai-gateway-usage">
      <div className="mcp-section-head">
        <h4>Usage</h4>
        <label className="mcp-gw-inline">
          Window
          <select value={usageWindow} onChange={(event) => setUsageWindow(event.target.value as UsageWindow)}>
            <option value="24h">24 hours</option>
            <option value="7d">7 days</option>
            <option value="30d">30 days</option>
          </select>
        </label>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {totals && (
        <p>
          {formatCount(totals.requests)} requests · {formatCount(totals.totalTokens)} tokens · {formatCost(totals.costUsd)}
          {totals.errors > 0 && ` · ${formatCount(totals.errors)} errors`}
          {totals.blocked > 0 && ` · ${formatCount(totals.blocked)} blocked by Guard`}
        </p>
      )}
      {rows.length > 0 && (
        <table className="kb-table">
          <thead>
            <tr>
              <th scope="col">Model name</th>
              <th scope="col">Provider / model</th>
              <th scope="col">Requests</th>
              <th scope="col">Tokens</th>
              <th scope="col">Cost</th>
              <th scope="col">Last request</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.alias}>
                <td>
                  <code>{row.alias}</code>
                </td>
                <td>
                  {row.providerId} / {row.model}
                </td>
                <td>{formatCount(row.requests)}</td>
                <td>{formatCount(row.totalTokens)}</td>
                <td>{formatCost(row.costUsd)}</td>
                <td>{row.lastRequestAt ? new Date(row.lastRequestAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {totals && totals.requests === 0 && <p className="kb-subtle">No /v1 requests in this window.</p>}
      <small className="kb-subtle">Metadata only: prompts and answers are never stored. Requests count toward the client&apos;s and the project&apos;s budgets.</small>
    </section>
  );
}
