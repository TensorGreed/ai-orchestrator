/**
 * Phase 10.2 — MCP tool policy, shown as the "Policies" view of the MCP
 * servers page. Admins add, edit, enable and delete rules; builders read them
 * and use the "Test a tool" evaluator to see why an agent will not get a tool.
 * Phase 12.4 — rules can match a call's arguments and data labels, require
 * approval, run in shadow mode and name workflows or gateway clients; admins
 * decide the gateway calls such rules held back.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  McpGatewayApproval,
  McpPolicyKind,
  McpPolicyRole,
  McpToolHintCondition,
  McpToolPolicyEffect,
  McpToolPolicyMode,
  McpToolPolicyRule,
  Project,
  WorkflowListItem
} from "@ai-orchestrator/shared";
import {
  ApiError,
  type McpClientView,
  type McpRegisteredServer,
  type McpToolPolicyEvaluation,
  type McpToolPolicyRuleExplanation,
  type McpToolPolicyRuleInput,
  createMcpToolPolicy,
  decideMcpGatewayApproval,
  deleteMcpToolPolicy,
  evaluateMcpToolPolicy,
  fetchMcpClients,
  fetchMcpGatewayApprovals,
  fetchMcpServerTools,
  fetchMcpToolPolicies,
  fetchProjects,
  fetchWorkflows,
  updateMcpToolPolicy
} from "../lib/api";
import {
  McpPolicyConditionsEditor,
  conditionsToDraft,
  describeConditions,
  draftToConditions,
  type ConditionsDraft
} from "./McpPolicyConditionsEditor";

const ROLES: McpPolicyRole[] = ["admin", "builder", "operator", "viewer"];

/** Field-level problems the API reports (zod issues), as "conditions.all.0.value: message". */
function issueText(payload: Record<string, unknown> | undefined): string | null {
  const details = payload?.details;
  if (!Array.isArray(details) || details.length === 0) return null;
  return details
    .slice(0, 5)
    .map((issue) => {
      const entry = issue as { path?: unknown[]; message?: unknown };
      const path = Array.isArray(entry.path) && entry.path.length > 0 ? `${entry.path.join(".")}: ` : "";
      return `${path}${String(entry.message ?? "")}`;
    })
    .join("; ");
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = issueText(err.payload);
    return issues ? `${err.message} (${issues})` : err.message;
  }
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

const KIND_LABELS: Record<McpPolicyKind, string> = {
  tool: "Tool",
  resource: "Resource",
  prompt: "Prompt",
  sampling: "Sampling"
};

const KIND_PATTERN_LABELS: Record<McpPolicyKind, string> = {
  tool: "Tool name or pattern",
  resource: "Resource URI or pattern",
  prompt: "Prompt name or pattern",
  sampling: "Model name or pattern"
};

const KIND_PATTERN_PLACEHOLDERS: Record<McpPolicyKind, string> = {
  tool: "* or create_* or search_issues",
  resource: "* or file:///srv/docs/* or db://public/*",
  prompt: "* or summarize_*",
  sampling: "* or gpt-4o-mini"
};

function hintLabel(hint: McpToolHintCondition | null | undefined): string {
  if (!hint) return "Any tool";
  return HINT_CONDITION_LABELS.find((entry) => entry.value === hint)?.label ?? hint;
}

function rolesLabel(roles: McpPolicyRole[]): string {
  return roles.length === 0 ? "All roles" : roles.join(", ");
}

const EFFECT_BADGES: Record<McpToolPolicyEffect, { label: string; tone: string }> = {
  deny: { label: "Deny", tone: "mcp-status-down" },
  require_approval: { label: "Needs approval", tone: "mcp-status-degraded" },
  allow: { label: "Allow", tone: "mcp-status-healthy" }
};

export function EffectBadge({ effect }: { effect: McpToolPolicyEffect }) {
  const badge = EFFECT_BADGES[effect] ?? EFFECT_BADGES.deny;
  return (
    <span className={`mcp-status ${badge.tone}`}>
      <span className="mcp-status-dot" aria-hidden="true" />
      {badge.label}
    </span>
  );
}

export function ShadowBadge() {
  return (
    <span className="mcp-flag mcp-flag-shadow" title="Shadow mode: recorded on each call, never applied">
      Shadow
    </span>
  );
}

/** Phase 12.4 — workflows and gateway clients a rule can name. Loaded once; either list may be unavailable. */
interface PrincipalLookups {
  workflows: Array<Pick<WorkflowListItem, "id" | "name">>;
  clients: Array<Pick<McpClientView, "id" | "name" | "status">>;
}

function principalNames(ids: string[] | undefined, known: Array<{ id: string; name: string }>): string {
  return (ids ?? []).map((id) => known.find((entry) => entry.id === id)?.name ?? id).join(", ");
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
  activeProjectId,
  focusRuleId
}: {
  isAdmin: boolean;
  servers: McpRegisteredServer[];
  adapters: Array<{ id: string; label: string }>;
  activeProjectId?: string | null;
  /** Phase 10.3 — rule to highlight and scroll to (opened from a canvas marker or the changes feed). */
  focusRuleId?: string | null;
}) {
  const [rules, setRules] = useState<McpToolPolicyRule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpToolPolicyRule | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [principals, setPrincipals] = useState<PrincipalLookups>({ workflows: [], clients: [] });

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
    // Workflow and client names label rules that name them, and fill the pickers; ids still work without them.
    fetchWorkflows()
      .then((workflows) => setPrincipals((current) => ({ ...current, workflows: workflows.map(({ id, name }) => ({ id, name })) })))
      .catch(() => undefined);
    fetchMcpClients()
      .then((result) =>
        setPrincipals((current) => ({ ...current, clients: result.clients.map(({ id, name, status }) => ({ id, name, status })) }))
      )
      .catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!focusRuleId || loading) return;
    const element = document.getElementById(`mcp-rule-${focusRuleId}`);
    if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
  }, [focusRuleId, loading]);

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
          With no rules every tool is allowed. Deny wins, then Needs approval, then Allow: a call is blocked when an enabled
          deny rule matches it, unless a rule that sits entirely inside that deny&apos;s scope (narrower in at least one way, for
          example by its conditions) carves it out. Runs a signed-in user starts use their role; webhooks, schedules and queued
          runs use the workflow owner&apos;s role, or viewer when the owner is unknown. Shadow rules are only recorded on each
          call, so you can see what they would do before you enforce them.
        </p>

        {editing !== null && isAdmin && (
          <McpPolicyForm
            initial={editing === "new" ? undefined : editing}
            lookups={lookups}
            principals={principals}
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
              <li
                key={rule.id}
                id={`mcp-rule-${rule.id}`}
                className={["mcp-rule", !rule.enabled && "is-disabled", rule.id === focusRuleId && "is-focused"].filter(Boolean).join(" ")}
                aria-current={rule.id === focusRuleId ? "true" : undefined}
              >
                <div className="mcp-rule-head">
                  <EffectBadge effect={rule.effect} />
                  <span className="mcp-rule-name">{rule.name ?? "Unnamed rule"}</span>
                  {rule.mode === "shadow" && <ShadowBadge />}
                  {!rule.enabled && <span className="mcp-flag mcp-flag-neutral">disabled</span>}
                </div>
                {rule.description && <p className="kb-subtle mcp-rule-desc">{rule.description}</p>}
                <dl className="mcp-rule-scope">
                  <div>
                    <dt>{KIND_LABELS[rule.kind ?? "tool"]}</dt>
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
                  {(rule.workflowIds?.length ?? 0) > 0 && (
                    <div>
                      <dt>Workflows</dt>
                      <dd>{principalNames(rule.workflowIds, principals.workflows)}</dd>
                    </div>
                  )}
                  {(rule.clientIds?.length ?? 0) > 0 && (
                    <div>
                      <dt>Gateway clients</dt>
                      <dd>{principalNames(rule.clientIds, principals.clients)}</dd>
                    </div>
                  )}
                </dl>
                {describeConditions(rule.conditions) && (
                  <p className="mcp-rule-conditions">
                    <span className="kb-subtle">When </span>
                    <code>{describeConditions(rule.conditions)}</code>
                  </p>
                )}
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

      <PolicyEvaluator lookups={lookups} principals={principals} activeProjectId={activeProjectId ?? null} />

      {isAdmin && <GatewayApprovals />}
    </div>
  );
}

function McpPolicyForm({
  initial,
  lookups,
  principals,
  defaultProjectId,
  onSaved,
  onCancel
}: {
  initial?: McpToolPolicyRule;
  lookups: ScopeLookups;
  principals: PrincipalLookups;
  defaultProjectId: string | null;
  onSaved: (rule: McpToolPolicyRule) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [effect, setEffect] = useState<McpToolPolicyEffect>(initial?.effect ?? "deny");
  const [mode, setMode] = useState<McpToolPolicyMode>(initial?.mode ?? "enforce");
  const [conditions, setConditions] = useState<ConditionsDraft>(() => conditionsToDraft(initial?.conditions));
  const [workflowIds, setWorkflowIds] = useState<string[]>(initial?.workflowIds ?? []);
  const [clientIds, setClientIds] = useState<string[]>(initial?.clientIds ?? []);
  const [projectId, setProjectId] = useState(initial ? initial.projectId ?? "" : defaultProjectId ?? "");
  const [roles, setRoles] = useState<McpPolicyRole[]>(initial?.roles ?? []);
  const [serverId, setServerId] = useState(initial?.serverId ?? "");
  const [toolPattern, setToolPattern] = useState(initial?.toolPattern ?? "*");
  const [annotationHint, setAnnotationHint] = useState<McpToolHintCondition | "">(initial?.annotationHint ?? "");
  const [kind, setKind] = useState<McpPolicyKind>(initial?.kind ?? "tool");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRole = (role: McpPolicyRole) =>
    setRoles((current) => (current.includes(role) ? current.filter((entry) => entry !== role) : [...current, role]));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsedConditions = kind === "tool" ? draftToConditions(conditions) : { conditions: null };
    if ("error" in parsedConditions) {
      setError(parsedConditions.error);
      return;
    }
    if (kind !== "tool" && effect === "require_approval") {
      setError("Needs approval applies to tool calls only.");
      return;
    }
    const payload: McpToolPolicyRuleInput = {
      name: name.trim() || null,
      description: description.trim() || null,
      effect,
      projectId: projectId || null,
      roles,
      serverId: serverId || null,
      toolPattern: toolPattern.trim() || "*",
      annotationHint: kind === "tool" ? annotationHint || null : null,
      kind,
      enabled,
      mode,
      conditions: parsedConditions.conditions,
      workflowIds,
      clientIds
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
          <select value={effect} onChange={(event) => setEffect(event.target.value as McpToolPolicyEffect)}>
            <option value="deny">Deny</option>
            <option value="require_approval" disabled={kind !== "tool"}>
              Needs approval (a person approves each call)
            </option>
            <option value="allow">Allow (exception to a broader rule)</option>
          </select>
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
          {KIND_PATTERN_LABELS[kind]}
          <input
            type="text"
            value={toolPattern}
            onChange={(event) => setToolPattern(event.target.value)}
            placeholder={KIND_PATTERN_PLACEHOLDERS[kind]}
            spellCheck={false}
          />
        </label>
      </div>
      {kind === "tool" && <McpPolicyConditionsEditor draft={conditions} onChange={setConditions} />}
      <div className="kb-form-row">
        <label className="mcp-check">
          <input
            type="checkbox"
            aria-label="Shadow mode"
            checked={mode === "shadow"}
            onChange={(event) => setMode(event.target.checked ? "shadow" : "enforce")}
          />
          Shadow mode: record what this rule would decide on each call, without applying it
        </label>
      </div>
      <details className="mcp-advanced" open={Boolean(initial && (initial.description || initial.annotationHint || (initial.kind ?? "tool") !== "tool" || initial.workflowIds?.length || initial.clientIds?.length))}>
        <summary>Advanced</summary>
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
          Applies to
          <select aria-label="Rule kind" value={kind} onChange={(event) => setKind(event.target.value as McpPolicyKind)}>
            {(Object.keys(KIND_LABELS) as McpPolicyKind[]).map((entry) => (
              <option key={entry} value={entry}>
                {KIND_LABELS[entry]}
              </option>
            ))}
          </select>
          <small className="kb-subtle">
            Tool calls, resource reads (matched on the URI), server prompts (matched on the prompt name) or sampling
            requests (matched on the model name).
          </small>
        </label>
        <label>
          Annotation
          <select
            aria-label="Annotation condition"
            value={annotationHint}
            disabled={kind !== "tool"}
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
          Only for workflows
          <select
            multiple
            aria-label="Only for workflows"
            value={workflowIds}
            onChange={(event) => setWorkflowIds(Array.from(event.target.selectedOptions, (option) => option.value))}
          >
            {principals.workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
            {workflowIds
              .filter((id) => !principals.workflows.some((workflow) => workflow.id === id))
              .map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </select>
          <small className="kb-subtle">None selected = every workflow, and gateway calls.</small>
        </label>
        <label>
          Only for gateway clients
          <select
            multiple
            aria-label="Only for gateway clients"
            value={clientIds}
            onChange={(event) => setClientIds(Array.from(event.target.selectedOptions, (option) => option.value))}
          >
            {principals.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
                {client.status !== "active" ? ` (${client.status})` : ""}
              </option>
            ))}
            {clientIds
              .filter((id) => !principals.clients.some((client) => client.id === id))
              .map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
          </select>
          <small className="kb-subtle">Their direct gateway calls and the runs they start. None selected = any caller.</small>
        </label>
      </div>
      </details>
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

function explanationText(entry: McpToolPolicyRuleExplanation): string {
  const name = entry.ruleName ?? entry.ruleId;
  const effect = EFFECT_BADGES[entry.effect]?.label.toLowerCase() ?? entry.effect;
  return `${effect} ${name}${entry.conditions ? ` (when ${entry.conditions})` : ""}`;
}

function PolicyEvaluator({
  lookups,
  principals,
  activeProjectId
}: {
  lookups: ScopeLookups;
  principals: PrincipalLookups;
  activeProjectId: string | null;
}) {
  const [projectId, setProjectId] = useState(activeProjectId ?? "");
  const [role, setRole] = useState<McpPolicyRole>("viewer");
  const [serverId, setServerId] = useState("");
  const [toolName, setToolName] = useState("");
  const [noWriteTools, setNoWriteTools] = useState(false);
  const [argumentsText, setArgumentsText] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [clientId, setClientId] = useState("");
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
    let args: Record<string, unknown> | undefined;
    if (argumentsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(argumentsText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        args = parsed as Record<string, unknown>;
      } catch {
        setResult(null);
        setError('Arguments must be a JSON object, such as {"repo": "acme/prod"}.');
        return;
      }
    }
    const labels = labelsText
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      setResult(
        await evaluateMcpToolPolicy({
          projectId: projectId || null,
          role,
          serverId: effectiveServerId,
          toolName: toolName.trim(),
          noWriteTools,
          ...(args ? { arguments: args } : {}),
          ...(labels.length > 0 ? { labels } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(clientId ? { clientId } : {})
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
      <p className="kb-subtle">
        Check what a role would get, before anyone runs a workflow. Add arguments to test rules with conditions; without them
        such rules cannot decide, as when an agent first lists its tools.
      </p>
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
        <label className="mcp-evaluator-args">
          Arguments (JSON, optional)
          <textarea
            value={argumentsText}
            onChange={(event) => setArgumentsText(event.target.value)}
            placeholder='{"repo": "acme/prod", "branch": "main"}'
            rows={2}
            spellCheck={false}
          />
        </label>
        <label>
          Data labels (optional)
          <input type="text" value={labelsText} onChange={(event) => setLabelsText(event.target.value)} placeholder="pii, email" spellCheck={false} />
        </label>
        <label>
          Workflow (optional)
          <select value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}>
            <option value="">Any workflow</option>
            {principals.workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Gateway client (optional)
          <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
            <option value="">No client</option>
            {principals.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
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
        <div
          className={!result.allowed ? "mcp-eval-result is-blocked" : result.approval ? "mcp-eval-result is-approval" : "mcp-eval-result is-allowed"}
          role="status"
        >
          <div className="mcp-rule-head">
            <span className={`mcp-status ${!result.allowed ? "mcp-status-down" : result.approval ? "mcp-status-degraded" : "mcp-status-healthy"}`}>
              <span className="mcp-status-dot" aria-hidden="true" />
              {!result.allowed ? "Blocked" : result.approval ? "Needs approval" : "Allowed"}
            </span>
            <span className="kb-subtle">
              {!result.allowed
                ? result.message
                : result.approval
                  ? result.approval.message
                  : result.decidedBy === "default"
                    ? "No rule matches, so the default applies: allowed."
                    : `Allowed by ${ruleName(result.decidingRuleId)}.`}
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
            {(result.why ?? []).map((entry) => (
              <li key={`why:${entry.ruleId}`}>Matched: {explanationText(entry)}</li>
            ))}
            {result.overriddenDenies.map((entry) => (
              <li key={`${entry.denyId}:${entry.byId}`}>
                {ruleName(entry.denyId)} set aside by the narrower rule {ruleName(entry.byId)}
              </li>
            ))}
            {(result.undecided ?? []).length > 0 && (
              <li>
                Depends on the arguments: {(result.undecided ?? []).map(explanationText).join("; ")}. Add arguments to see what they
                decide.
              </li>
            )}
            {result.shadow && (
              <li className="mcp-eval-shadow">
                <ShadowBadge />{" "}
                {result.shadow.changed
                  ? `Shadow rules would change this to: ${EFFECT_BADGES[result.shadow.effect]?.label ?? result.shadow.effect}`
                  : "Shadow rules match but would not change the outcome"}
                {result.shadow.matchedRules.length > 0 ? ` (${result.shadow.matchedRules.map(explanationText).join("; ")})` : ""}.
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

const APPROVAL_STATUS_LABELS: Record<McpGatewayApproval["status"], string> = {
  pending: "Pending",
  approved: "Approved, waiting for the retry",
  rejected: "Rejected",
  expired: "Expired",
  used: "Approved and used"
};

/**
 * Phase 12.4 — gateway calls a "Needs approval" rule held back. The client got an "approval pending" error; once
 * approved here, the same client can retry the identical call once within the approval window.
 */
function GatewayApprovals() {
  const [approvals, setApprovals] = useState<McpGatewayApproval[]>([]);
  const [windowMs, setWindowMs] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMcpGatewayApprovals(showAll ? {} : { status: "pending" });
      setApprovals(result.approvals);
      setWindowMs(result.approvalWindowMs);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approval: McpGatewayApproval, decision: "approve" | "reject") => {
    setBusyId(approval.id);
    setError(null);
    try {
      const result = await decideMcpGatewayApproval(approval.id, decision);
      setApprovals((current) =>
        showAll ? current.map((entry) => (entry.id === approval.id ? result.approval : entry)) : current.filter((entry) => entry.id !== approval.id)
      );
    } catch (err) {
      setError(formatError(err));
      void load();
    } finally {
      setBusyId(null);
    }
  };

  const minutes = windowMs ? Math.max(1, Math.round(windowMs / 60_000)) : null;

  return (
    <section className="kb-section mcp-gateway-approvals">
      <div className="mcp-section-head">
        <h4>Gateway approvals</h4>
        <label className="mcp-check">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          Show decided
        </label>
      </div>
      <p className="kb-subtle">
        Gateway calls a Needs approval rule held back. The client was told the call is pending; once you approve, the same client
        can retry the same call with the same arguments once{minutes ? ` within ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}.
      </p>
      {error && <div className="settings-error">{error}</div>}
      {loading && approvals.length === 0 ? (
        <p className="kb-subtle">Loading…</p>
      ) : approvals.length === 0 ? (
        <p className="kb-subtle">{showAll ? "No gateway approval requests yet." : "Nothing is waiting for approval."}</p>
      ) : (
        <ul className="mcp-rules" aria-label="Gateway approval requests">
          {approvals.map((approval) => (
            <li key={approval.id} className="mcp-rule">
              <div className="mcp-rule-head">
                <span className={`mcp-status ${approval.status === "pending" ? "mcp-status-degraded" : approval.status === "rejected" ? "mcp-status-down" : "mcp-status-healthy"}`}>
                  <span className="mcp-status-dot" aria-hidden="true" />
                  {APPROVAL_STATUS_LABELS[approval.status]}
                </span>
                <span className="mcp-rule-name">
                  {approval.clientName ?? approval.clientId} → <code>{approval.gatewayToolName}</code>
                </span>
              </div>
              {approval.message && <p className="kb-subtle mcp-rule-desc">{approval.message}</p>}
              {approval.argsPreview && (
                <pre className="mcp-approval-args" aria-label={`Arguments of ${approval.id}`}>
                  {approval.argsPreview}
                </pre>
              )}
              <dl className="mcp-rule-scope">
                <div>
                  <dt>Server</dt>
                  <dd>{approval.serverName ?? approval.serverId}</dd>
                </div>
                <div>
                  <dt>Rule</dt>
                  <dd>{approval.ruleName ?? approval.ruleId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Requested</dt>
                  <dd>{new Date(approval.requestedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>{approval.status === "pending" ? "Expires" : "Decided by"}</dt>
                  <dd>{approval.status === "pending" ? new Date(approval.expiresAt).toLocaleString() : approval.decidedBy ?? "—"}</dd>
                </div>
              </dl>
              {approval.status === "pending" && (
                <div className="mcp-rule-actions">
                  <button type="button" className="pg-btn primary" disabled={busyId === approval.id} onClick={() => void decide(approval, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="pg-btn ghost danger" disabled={busyId === approval.id} onClick={() => void decide(approval, "reject")}>
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
