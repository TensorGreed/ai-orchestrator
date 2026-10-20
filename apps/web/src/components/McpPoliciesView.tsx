/**
 * Phase 10.2 — MCP tool policy, shown as the "Policies" view of the MCP
 * servers page. Admins add, edit, enable and delete rules; builders read them
 * and use the "Test a tool" evaluator to see why an agent will not get a tool.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpPolicyRole, McpToolHintCondition, McpToolPolicyRule, Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  type McpRegisteredServer,
  type McpToolPolicyEvaluation,
  type McpToolPolicyRuleInput,
  createMcpToolPolicy,
  deleteMcpToolPolicy,
  evaluateMcpToolPolicy,
  fetchMcpServerTools,
  fetchMcpToolPolicies,
  fetchProjects,
  updateMcpToolPolicy
} from "../lib/api";

const ROLES: McpPolicyRole[] = ["admin", "builder", "operator", "viewer"];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

interface ScopeLookups {
  servers: McpRegisteredServer[];
  adapters: Array<{ id: string; label: string }>;
  projects: Project[];
}

function projectLabel(projectId: string | null, lookups: ScopeLookups): string {
  if (!projectId) return "All projects";
  return lookups.projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function serverLabel(serverId: string | null, lookups: ScopeLookups): string {
  if (!serverId) return "Any server";
  const registered = lookups.servers.find((server) => server.id === serverId);
  if (registered) return registered.name;
  return `${serverId} (inline)`;
}

/** Phase 10.5 — annotation conditions a rule can require, in the order the form lists them. */
export const HINT_CONDITION_LABELS: Array<{ value: McpToolHintCondition; label: string }> = [
  { value: "destructive", label: "Destructive tools" },
  { value: "not_destructive", label: "Non-destructive tools" },
  { value: "read_only", label: "Read-only tools" },
  { value: "not_read_only", label: "Not read-only tools" },
  { value: "idempotent", label: "Idempotent tools" },
  { value: "not_idempotent", label: "Not idempotent tools" },
  { value: "open_world", label: "Open-world tools" },
  { value: "not_open_world", label: "Closed-world tools" }
];

function hintLabel(hint: McpToolHintCondition | null | undefined): string {
  if (!hint) return "Any tool";
  return HINT_CONDITION_LABELS.find((entry) => entry.value === hint)?.label ?? hint;
}

function rolesLabel(roles: McpPolicyRole[]): string {
  return roles.length === 0 ? "All roles" : roles.join(", ");
}

export function EffectBadge({ effect }: { effect: "allow" | "deny" }) {
  return (
    <span className={`mcp-status ${effect === "deny" ? "mcp-status-down" : "mcp-status-healthy"}`}>
      <span className="mcp-status-dot" aria-hidden="true" />
      {effect === "deny" ? "Deny" : "Allow"}
    </span>
  );
}

/** Server options: registered servers by name, then adapter ids for servers configured inline on nodes. */
function ServerOptions({ lookups }: { lookups: ScopeLookups }) {
  return (
    <>
      {lookups.servers.length > 0 && (
        <optgroup label="Registered servers">
          {lookups.servers.map((server) => (
            <option key={server.id} value={server.id}>
              {server.name}
            </option>
          ))}
        </optgroup>
      )}
      {lookups.adapters.length > 0 && (
        <optgroup label="Inline servers (by adapter)">
          {lookups.adapters.map((adapter) => (
            <option key={adapter.id} value={adapter.id}>
              {adapter.label} ({adapter.id})
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function McpPoliciesView({
  isAdmin,
  servers,
  adapters,
  activeProjectId
}: {
  isAdmin: boolean;
  servers: McpRegisteredServer[];
  adapters: Array<{ id: string; label: string }>;
  activeProjectId?: string | null;
}) {
  const [rules, setRules] = useState<McpToolPolicyRule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpToolPolicyRule | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const lookups = useMemo<ScopeLookups>(() => ({ servers, adapters, projects }), [servers, adapters, projects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMcpToolPolicies();
      setRules(result.rules);
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
      .catch(() => {
        // Project names only label rules; ids still show without them.
      });
  }, [refresh]);

  const toggleEnabled = async (rule: McpToolPolicyRule) => {
    setBusyId(rule.id);
    setError(null);
    try {
      const result = await updateMcpToolPolicy(rule.id, { enabled: !rule.enabled });
      setRules((current) => current.map((entry) => (entry.id === rule.id ? result.rule : entry)));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (rule: McpToolPolicyRule) => {
    if (!window.confirm(`Delete the ${rule.effect} rule "${rule.name ?? rule.toolPattern}"? Runs pick up the change on their next node.`)) {
      return;
    }
    setBusyId(rule.id);
    setError(null);
    try {
      await deleteMcpToolPolicy(rule.id);
      setRules((current) => current.filter((entry) => entry.id !== rule.id));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mcp-policies">
      {error && <div className="settings-error">{error}</div>}

      <section className="kb-section">
        <div className="mcp-section-head">
          <h4>Tool policy rules ({rules.length})</h4>
          {isAdmin && editing === null && (
            <button type="button" className="pg-btn primary" onClick={() => setEditing("new")}>
              + Add rule
            </button>
          )}
        </div>
        <p className="kb-subtle">
          With no rules every tool is allowed. Deny wins: a tool is blocked when an enabled deny rule matches it, unless an
          allow rule that sits entirely inside that deny&apos;s scope (narrower in at least one way) carves it out. Runs a
          signed-in user starts use their role; webhooks, schedules and queued runs use the workflow owner&apos;s role, or
          viewer when the owner is unknown.
        </p>

        {editing !== null && isAdmin && (
          <McpPolicyForm
            initial={editing === "new" ? undefined : editing}
            lookups={lookups}
            defaultProjectId={null}
            onCancel={() => setEditing(null)}
            onSaved={(saved) => {
              setRules((current) =>
                current.some((entry) => entry.id === saved.id)
                  ? current.map((entry) => (entry.id === saved.id ? saved : entry))
                  : [...current, saved]
              );
              setEditing(null);
            }}
          />
        )}

        {loading && rules.length === 0 ? (
          <p className="kb-subtle">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="kb-subtle">
            No rules yet. {isAdmin ? "Add a deny rule to keep a server or tool away from a role." : "Only admins can add rules."}
          </p>
        ) : (
          <ul className="mcp-rules" aria-label="Tool policy rules">
            {rules.map((rule) => (
              <li key={rule.id} className={rule.enabled ? "mcp-rule" : "mcp-rule is-disabled"}>
                <div className="mcp-rule-head">
                  <EffectBadge effect={rule.effect} />
                  <span className="mcp-rule-name">{rule.name ?? "Unnamed rule"}</span>
                  {!rule.enabled && <span className="mcp-flag mcp-flag-neutral">disabled</span>}
                </div>
                {rule.description && <p className="kb-subtle mcp-rule-desc">{rule.description}</p>}
                <dl className="mcp-rule-scope">
                  <div>
                    <dt>Tool</dt>
                    <dd>
                      <code>{rule.toolPattern}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Server</dt>
                    <dd>{serverLabel(rule.serverId, lookups)}</dd>
                  </div>
                  {rule.annotationHint && (
                    <div>
                      <dt>Annotation</dt>
                      <dd>{hintLabel(rule.annotationHint)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Roles</dt>
                    <dd>{rolesLabel(rule.roles)}</dd>
                  </div>
                  <div>
                    <dt>Project</dt>
                    <dd>{projectLabel(rule.projectId, lookups)}</dd>
                  </div>
                </dl>
                {isAdmin && (
                  <div className="mcp-rule-actions">
                    <label className="mcp-check">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={busyId === rule.id}
                        onChange={() => void toggleEnabled(rule)}
                        aria-label={`Enable rule ${rule.name ?? rule.id}`}
                      />
                      Enabled
                    </label>
                    <button type="button" className="pg-btn ghost" onClick={() => setEditing(rule)} disabled={busyId === rule.id}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="pg-btn ghost danger"
                      onClick={() => void remove(rule)}
                      disabled={busyId === rule.id}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <PolicyEvaluator lookups={lookups} activeProjectId={activeProjectId ?? null} />
    </div>
  );
}

function McpPolicyForm({
  initial,
  lookups,
  defaultProjectId,
  onSaved,
  onCancel
}: {
  initial?: McpToolPolicyRule;
  lookups: ScopeLookups;
  defaultProjectId: string | null;
  onSaved: (rule: McpToolPolicyRule) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [effect, setEffect] = useState<"allow" | "deny">(initial?.effect ?? "deny");
  const [projectId, setProjectId] = useState(initial ? initial.projectId ?? "" : defaultProjectId ?? "");
  const [roles, setRoles] = useState<McpPolicyRole[]>(initial?.roles ?? []);
  const [serverId, setServerId] = useState(initial?.serverId ?? "");
  const [toolPattern, setToolPattern] = useState(initial?.toolPattern ?? "*");
  const [annotationHint, setAnnotationHint] = useState<McpToolHintCondition | "">(initial?.annotationHint ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRole = (role: McpPolicyRole) =>
    setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const payload: McpToolPolicyRuleInput = {
      name: name.trim() || null,
      description: description.trim() || null,
      effect,
      projectId: projectId || null,
      roles,
      serverId: serverId || null,
      toolPattern: toolPattern.trim() || "*",
      annotationHint: annotationHint || null,
      enabled
    };
    setBusy(true);
    try {
      const result = initial ? await updateMcpToolPolicy(initial.id, payload) : await createMcpToolPolicy(payload);
      onSaved(result.rule);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="kb-create-form mcp-form mcp-policy-form"
      aria-label={initial ? "Edit tool policy rule" : "Add tool policy rule"}
      onSubmit={(event) => void handleSubmit(event)}
    >
      {error && <div className="settings-error">{error}</div>}
      <div className="kb-form-row kb-form-row-2">
        <label>
          Name
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="Viewers: no GitHub writes" />
        </label>
        <label>
          Effect
          <select value={effect} onChange={(event) => setEffect(event.target.value as "allow" | "deny")}>
            <option value="deny">Deny</option>
            <option value="allow">Allow (exception to a broader deny)</option>
          </select>
        </label>
      </div>
      <div className="kb-form-row">
        <label>
          Description
          <input
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Why this rule exists"
          />
        </label>
      </div>
      <div className="kb-form-row kb-form-row-2">
        <label>
          Server
          <select value={serverId} onChange={(event) => setServerId(event.target.value)}>
            <option value="">Any server</option>
            <ServerOptions lookups={lookups} />
            {serverId &&
              !lookups.servers.some((server) => server.id === serverId) &&
              !lookups.adapters.some((adapter) => adapter.id === serverId) && <option value={serverId}>{serverId}</option>}
          </select>
        </label>
        <label>
          Tool name or pattern
          <input
            type="text"
            value={toolPattern}
            onChange={(event) => setToolPattern(event.target.value)}
            placeholder="* or create_* or search_issues"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="kb-form-row">
        <label>
          Annotation
          <select
            aria-label="Annotation condition"
            value={annotationHint}
            onChange={(event) => setAnnotationHint(event.target.value as McpToolHintCondition | "")}
          >
            <option value="">Any tool</option>
            {HINT_CONDITION_LABELS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
          <small className="kb-subtle">
            Matches the hints a server sends with its tools. Missing hints count as the MCP defaults: not read-only,
            destructive, not idempotent, open world. An admin's read-only override wins.
          </small>
        </label>
      </div>
      <div className="kb-form-row kb-form-row-2">
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {lookups.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {projectId && !lookups.projects.some((project) => project.id === projectId) && <option value={projectId}>{projectId}</option>}
          </select>
        </label>
        <fieldset className="mcp-role-picker">
          <legend>Roles (none checked = all roles)</legend>
          {ROLES.map((role) => (
            <label key={role} className="mcp-check">
              <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} />
              {role}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="kb-form-row">
        <label className="mcp-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          Enabled
        </label>
      </div>
      <div className="kb-form-row mcp-form-actions">
        <button type="submit" className="pg-btn primary" disabled={busy}>
          {busy ? "Saving…" : initial ? "Save rule" : "Add rule"}
        </button>
        <button type="button" className="pg-btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function classificationText(evaluation: Pick<McpToolPolicyEvaluation, "classification">): string {
  const { readOnly, source } = evaluation.classification;
  if (source === "unknown") return "Write (no annotation, so unknown → write)";
  return `${readOnly ? "Read-only" : "Write"} (${source === "manual" ? "set by an admin" : "server annotation"})`;
}

function PolicyEvaluator({ lookups, activeProjectId }: { lookups: ScopeLookups; activeProjectId: string | null }) {
  const [projectId, setProjectId] = useState(activeProjectId ?? "");
  const [role, setRole] = useState<McpPolicyRole>("viewer");
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const [noWriteTools, setNoWriteTools] = useState(false);
  const [toolOptions, setToolOptions] = useState<string[]>([]);
  const [result, setResult] = useState<McpToolPolicyEvaluation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveServerId = serverId || lookups.servers[0]?.id || lookups.adapters[0]?.id || "";

  useEffect(() => {
    let cancelled = false;
    setToolOptions([]);
    if (!lookups.servers.some((server) => server.id === effectiveServerId)) return;
    fetchMcpServerTools(effectiveServerId)
      .then((response) => {
        if (!cancelled) setToolOptions(response.tools.map((tool) => tool.name));
      })
      .catch(() => {
        // Suggestions only; any tool name can still be typed.
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveServerId, lookups.servers]);

  const evaluate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!effectiveServerId || !toolName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await evaluateMcpToolPolicy({
          projectId: projectId || null,
          role,
          serverId: effectiveServerId,
          toolName: toolName.trim(),
          noWriteTools
        })
      );
    } catch (err) {
      setResult(null);
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const ruleName = (id: string | null) => {
    if (!id) return "";
    const rule = result?.matchedRules.find((entry) => entry.id === id);
    return rule?.name ?? id;
  };

  return (
    <section className="kb-section mcp-evaluator">
      <h4>Test a tool</h4>
      <p className="kb-subtle">Check what a role would get, before anyone runs a workflow.</p>
      <form className="kb-create-form mcp-evaluator-form" aria-label="Test a tool against the policy" onSubmit={(event) => void evaluate(event)}>
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">No project</option>
            {lookups.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {projectId && !lookups.projects.some((project) => project.id === projectId) && <option value={projectId}>{projectId}</option>}
          </select>
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
          Server
          <select value={effectiveServerId} onChange={(event) => setServerId(event.target.value)}>
            <ServerOptions lookups={lookups} />
          </select>
        </label>
        <label>
          Tool
          <input
            type="text"
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            list="mcp-evaluator-tools"
            placeholder="calculator"
            spellCheck={false}
          />
          <datalist id="mcp-evaluator-tools">
            {toolOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label className="mcp-check">
          <input type="checkbox" checked={noWriteTools} onChange={(event) => setNoWriteTools(event.target.checked)} />
          Workflow allows no write tools
        </label>
        <button type="submit" className="pg-btn" disabled={busy || !effectiveServerId || !toolName.trim()}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {error && <div className="settings-error">{error}</div>}
      {result && (
        <div className={result.allowed ? "mcp-eval-result is-allowed" : "mcp-eval-result is-blocked"} role="status">
          <div className="mcp-rule-head">
            <span className={`mcp-status ${result.allowed ? "mcp-status-healthy" : "mcp-status-down"}`}>
              <span className="mcp-status-dot" aria-hidden="true" />
              {result.allowed ? "Allowed" : "Blocked"}
            </span>
            <span className="kb-subtle">
              {result.allowed
                ? result.decidedBy === "default"
                  ? "No rule matches, so the default applies: allowed."
                  : `Allowed by ${ruleName(result.decidingRuleId)}.`
                : result.message}
            </span>
          </div>
          <ul className="mcp-eval-facts">
            <li>Classification: {classificationText(result)}</li>
            <li>
              Matching rules:{" "}
              {result.matchedRules.length === 0
                ? "none"
                : result.matchedRules.map((rule) => `${rule.effect} ${rule.name ?? rule.id}`).join("; ")}
            </li>
            {result.overriddenDenies.map((entry) => (
              <li key={`${entry.denyId}:${entry.byId}`}>
                {ruleName(entry.denyId)} set aside by the narrower allow {ruleName(entry.byId)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
