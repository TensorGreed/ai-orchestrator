/**
 * 12.6 — governance of MCP gateway toolsets and clients, shown on the objects themselves.
 *
 * `GatewayGuardPicker` picks the Guard profile that checks a toolset's or client's tool calls (none by default).
 * `GatewayRateLimitEditor` sets an optional rate limit (a client's own, or a toolset's default for each client).
 * `ClientGovernance` is the client's Governance section: one row per setting (Guard, rate limit, budgets). Admins
 * change them; everyone else reads them.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  GUARD_DESTINATION_RULES_PROFILE_ID,
  MCP_GATEWAY_RATE_LIMIT_MAX,
  type GuardProfileSummary,
  type GuardResolutionView,
  type McpClientBudgetUsage,
  type McpGatewayRateLimit
} from "@ai-orchestrator/shared";
import {
  ApiError,
  type GuardGatewayBindingInput,
  type McpClientView,
  fetchGuardClientBinding,
  fetchMcpClientBudgets,
  updateMcpClient,
  fetchGuardProfile,
  fetchGuardProfiles,
  fetchGuardToolsetBinding,
  updateGuardClientBinding,
  updateGuardToolsetBinding
} from "../lib/api";

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}

type Scope = "toolset" | "client";

const HELP: Record<Scope, string> = {
  toolset: "Checks what clients send to this toolset's tools and what comes back, and the Guard nodes and agents of its workflow tools.",
  client: "Checks this client's tool calls on every toolset, on top of the toolset's own profile."
};

const HELD_ACTIONS = new Set(["review", "require_approval"]);

/**
 * Whether a profile document asks for a review or an approval where the gateway checks calls (tool arguments,
 * tool results, destination rules). No one waits on a gateway call, so the gateway blocks such calls instead.
 * Shadow rules only record, so they do not count.
 */
export function gatewayHeldActions(document: Record<string, unknown> | null | undefined): boolean {
  if (!document) return false;
  // A rule's own `shadow` wins; otherwise the profile's per-action shadow switch decides (as in the Guard engine).
  const profileShadow = (document.shadow && typeof document.shadow === "object" ? document.shadow : {}) as Record<string, unknown>;
  const held = (rule: unknown) => {
    if (!rule || typeof rule !== "object") return false;
    const entry = rule as { action?: unknown; shadow?: unknown };
    if (typeof entry.action !== "string" || !HELD_ACTIONS.has(entry.action)) return false;
    const shadow = typeof entry.shadow === "boolean" ? entry.shadow : profileShadow[entry.action] === true;
    return !shadow;
  };
  const channels = (document.channels ?? {}) as Record<string, unknown>;
  for (const name of ["tool_arguments", "tool_result"]) {
    const channel = channels[name] as { actions?: Record<string, unknown>; defaultAction?: unknown } | undefined;
    if (!channel || typeof channel !== "object") continue;
    if (held(channel.defaultAction) || Object.values(channel.actions ?? {}).some(held)) return true;
  }
  const destinations = document.destinations as { rules?: unknown[] } | undefined;
  return Array.isArray(destinations?.rules) && destinations.rules.some(held);
}

interface Loaded {
  profileId: string | null;
  /** Profiles that apply, in order, for the picker's object (the first of the client's toolsets for a client). */
  stack: GuardResolutionView["stack"];
}

async function load(scope: Scope, id: string): Promise<Loaded> {
  if (scope === "toolset") {
    const result = await fetchGuardToolsetBinding(id);
    return { profileId: result.binding.mode === "override" ? result.binding.profileId : null, stack: result.effective.stack };
  }
  const result = await fetchGuardClientBinding(id);
  return { profileId: result.binding.mode === "override" ? result.binding.profileId : null, stack: result.toolsets[0]?.effective.stack ?? [] };
}

async function save(scope: Scope, id: string, payload: GuardGatewayBindingInput): Promise<Loaded> {
  if (scope === "toolset") {
    const result = await updateGuardToolsetBinding(id, payload);
    return { profileId: result.binding.mode === "override" ? result.binding.profileId : null, stack: result.effective.stack };
  }
  const result = await updateGuardClientBinding(id, payload);
  return { profileId: result.binding.mode === "override" ? result.binding.profileId : null, stack: result.toolsets[0]?.effective.stack ?? [] };
}

export function GatewayGuardPicker({ scope, id, isAdmin, disabled = false }: { scope: Scope; id: string; isAdmin: boolean; disabled?: boolean }) {
  const [profiles, setProfiles] = useState<GuardProfileSummary[]>([]);
  const [current, setCurrent] = useState<Loaded | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Whether the chosen profile has review/approval actions the gateway turns into blocks (admins only).
  const [heldActions, setHeldActions] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHeldActions(false);
    if (!isAdmin || !choice) return;
    fetchGuardProfile(choice)
      .then((result) => {
        if (!cancelled) setHeldActions(gatewayHeldActions(result.latest.document));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [choice, isAdmin]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setCurrent(null);
    Promise.all([load(scope, id), isAdmin ? fetchGuardProfiles().then((result) => result.profiles) : Promise.resolve([] as GuardProfileSummary[])])
      .then(([binding, list]) => {
        if (cancelled) return;
        setCurrent(binding);
        setChoice(binding.profileId ?? "");
        // The deployment applies its destination rules profile on its own; it is never offered here.
        setProfiles(list.filter((profile) => profile.id !== GUARD_DESTINATION_RULES_PROFILE_ID));
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [scope, id, isAdmin]);

  const label = scope === "toolset" ? "Guard profile for this toolset" : "Guard profile for this client";
  const helpId = `gateway-guard-help-${scope}-${id}`;
  const apply = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await save(scope, id, choice ? { mode: "override", profileId: choice } : { mode: "inherit" });
      setCurrent(next);
      setChoice(next.profileId ?? "");
      setSaved(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const names = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const currentName = current?.profileId ? names.get(current.profileId) ?? current.profileId : null;
  const others = current ? current.stack.filter((entry) => entry.profileId !== current.profileId) : [];

  return (
    <div className="mcp-gw-guard" data-testid={`gateway-guard-${scope}`}>
      {error && <div className="settings-error">{error}</div>}
      {current === null && !error ? (
        <p className="kb-subtle">Loading…</p>
      ) : current === null ? null : isAdmin ? (
        <div className="mcp-gw-guard-row">
          <label>
            {label}
            <select
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
                setSaved(false);
              }}
              disabled={busy || disabled}
              aria-describedby={helpId}
            >
              <option value="">None</option>
              {current.profileId && !names.has(current.profileId) && <option value={current.profileId}>{current.profileId}</option>}
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="pg-btn small" onClick={() => void apply()} disabled={busy || disabled || choice === (current.profileId ?? "")}>
            Save
          </button>
          {saved && <span className="kb-subtle">Saved</span>}
        </div>
      ) : (
        <p>
          {label}: <strong>{currentName ?? "None"}</strong>
        </p>
      )}
      <small id={helpId} className="kb-subtle">
        {HELP[scope]}
      </small>
      {heldActions && (
        <small className="mcp-gw-guard-warning" role="note" data-testid={`gateway-guard-${scope}-held`}>
          {" "}This profile asks for reviews or approvals. On the gateway these block the call.
        </small>
      )}
      {current && current.profileId && others.length > 0 && (
        <small className="kb-subtle" data-testid={`gateway-guard-${scope}-stack`}>
          {" "}Also applied: {others.map((entry) => entry.name ?? entry.profileId).join(", ")}.
        </small>
      )}
    </div>
  );
}

/** One setting in a Governance section: a short name and its control. */
export function GovernanceRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mcp-governance-row">
      <h5>{title}</h5>
      {children}
    </div>
  );
}

type RateLimitField = keyof McpGatewayRateLimit;

const RATE_LIMIT_FIELDS: Array<{ field: RateLimitField; label: string }> = [
  { field: "requestsPerMinute", label: "Calls per minute" },
  { field: "burst", label: "Burst" },
  { field: "maxConcurrent", label: "Calls at once" }
];

const RATE_LIMIT_HELP: Record<Scope, string> = {
  client: "Caps this client's tool calls on every toolset and replaces the toolset default entirely. Leave a field empty for no limit there.",
  toolset: "Caps each client's calls to this toolset. A client's own limit replaces this default entirely. Leave a field empty for no limit there."
};

/** Words for a rate limit: "60 calls per minute (burst 10), 2 at once", or "No limit". */
export function describeRateLimit(limit: McpGatewayRateLimit | null | undefined): string {
  if (!limit || (limit.requestsPerMinute === null && limit.maxConcurrent === null)) return "No limit";
  const parts: string[] = [];
  if (limit.requestsPerMinute !== null) parts.push(`${limit.requestsPerMinute} calls per minute${limit.burst !== null ? ` (burst ${limit.burst})` : ""}`);
  if (limit.maxConcurrent !== null) parts.push(`${limit.maxConcurrent} at once`);
  return parts.join(", ");
}

type Draft = Record<RateLimitField, string>;

function toDraft(limit: McpGatewayRateLimit | null | undefined): Draft {
  return {
    requestsPerMinute: limit?.requestsPerMinute != null ? String(limit.requestsPerMinute) : "",
    burst: limit?.burst != null ? String(limit.burst) : "",
    maxConcurrent: limit?.maxConcurrent != null ? String(limit.maxConcurrent) : ""
  };
}

/** The limit a draft asks for, or an error to show (empty field = no limit there; all empty = no limit). */
export function parseRateLimitDraft(draft: Draft): { limit: McpGatewayRateLimit | null } | { error: string } {
  const values: Partial<Record<RateLimitField, number | null>> = {};
  for (const { field, label } of RATE_LIMIT_FIELDS) {
    const text = draft[field].trim();
    if (!text) {
      values[field] = null;
      continue;
    }
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > MCP_GATEWAY_RATE_LIMIT_MAX[field]) {
      return { error: `${label} must be a whole number from 1 to ${MCP_GATEWAY_RATE_LIMIT_MAX[field]}.` };
    }
    values[field] = value;
  }
  if (values.burst !== null && values.requestsPerMinute === null) return { error: "Burst needs calls per minute." };
  if (values.requestsPerMinute === null && values.maxConcurrent === null) return { limit: null };
  return { limit: { requestsPerMinute: values.requestsPerMinute ?? null, burst: values.burst ?? null, maxConcurrent: values.maxConcurrent ?? null } };
}

/** An optional rate limit: admins edit it, everyone else reads it. */
export function GatewayRateLimitEditor({
  scope,
  id,
  value,
  isAdmin,
  onSave
}: {
  scope: Scope;
  id: string;
  value: McpGatewayRateLimit | null | undefined;
  isAdmin: boolean;
  onSave: (limit: McpGatewayRateLimit | null) => Promise<McpGatewayRateLimit | null>;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(toDraft(value));
  }, [value]);

  const helpId = `gateway-rate-limit-help-${scope}-${id}`;
  const dirty = RATE_LIMIT_FIELDS.some(({ field }) => draft[field].trim() !== toDraft(value)[field]);
  const apply = async () => {
    const parsed = parseRateLimitDraft(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setDraft(toDraft(await onSave(parsed.limit)));
      setSaved(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-gw-rate-limit" data-testid={`gateway-rate-limit-${scope}`}>
      {error && <div className="settings-error">{error}</div>}
      {isAdmin ? (
        <div className="mcp-gw-guard-row">
          {RATE_LIMIT_FIELDS.map(({ field, label }) => (
            <label key={field}>
              {label}
              <input
                type="number"
                min={1}
                max={MCP_GATEWAY_RATE_LIMIT_MAX[field]}
                inputMode="numeric"
                placeholder="No limit"
                value={draft[field]}
                onChange={(event) => {
                  const next = event.target.value;
                  setDraft((current) => ({ ...current, [field]: next }));
                  setSaved(false);
                }}
                disabled={busy}
                aria-describedby={helpId}
              />
            </label>
          ))}
          <button type="button" className="pg-btn small" onClick={() => void apply()} disabled={busy || !dirty}>
            Save
          </button>
          {saved && <span className="kb-subtle">Saved</span>}
        </div>
      ) : (
        <p>
          Rate limit: <strong>{describeRateLimit(value)}</strong>
        </p>
      )}
      <small id={helpId} className="kb-subtle">
        {RATE_LIMIT_HELP[scope]}
      </small>
    </div>
  );
}

function formatBudgetAmount(value: number, limitType: McpClientBudgetUsage["limitType"]): string {
  if (limitType === "usd") return `$${value.toFixed(2)}`;
  const tokens = Math.round(value);
  return `${tokens.toLocaleString()} ${tokens === 1 ? "token" : "tokens"}`;
}

/**
 * Every budget that applies to the client (its own, its toolsets' projects', the deployment's), each labelled by scope,
 * with what it counted this period; one that refuses the client's calls now says so. Budgets are set in Settings,
 * FinOps.
 */
export function ClientBudgets({ clientId }: { clientId: string }) {
  const [budgets, setBudgets] = useState<McpClientBudgetUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBudgets(null);
    fetchMcpClientBudgets(clientId)
      .then((result) => {
        if (!cancelled) setBudgets(result.budgets);
      })
      .catch((err) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return (
    <div className="mcp-gw-budgets" data-testid="gateway-client-budgets">
      {error && <div className="settings-error">{error}</div>}
      {budgets === null && !error && <p className="kb-subtle">Loading…</p>}
      {budgets && budgets.length === 0 && <p className="kb-subtle">No budget applies to this client.</p>}
      {budgets && budgets.length > 0 && (
        <ul className="mcp-gw-budget-list">
          {budgets.map((budget) => {
            const amounts = budget.limitValue !== undefined && budget.current !== undefined ? { cap: budget.limitValue, spent: budget.current } : null;
            const pct = amounts && amounts.cap > 0 ? Math.min(100, Math.round((amounts.spent / amounts.cap) * 100)) : 0;
            return (
              <li key={budget.budgetId} data-refusing={budget.refusing ? "true" : undefined}>
                <span className="kb-subtle">{budget.scopeLabel}</span>
                {" · "}
                <strong>{budget.name}</strong>
                {": "}
                {amounts
                  ? `${formatBudgetAmount(amounts.spent, budget.limitType)} of ${formatBudgetAmount(amounts.cap, budget.limitType)} this ${budget.period} (${pct}%)`
                  : `per ${budget.period}`}
                {" · "}
                {budget.action === "block" ? "blocks calls when used up" : "warns only"}
                {!budget.enabled && " · off"}
                {budget.refusing && (
                  <>
                    {" · "}
                    <strong className="mcp-gw-budget-refusing">Used up: refusing this client's calls</strong>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <small className="kb-subtle">Spend of the runs and model sampling this client's calls use. Set budgets in Settings, FinOps.</small>
    </div>
  );
}

/** The client's Governance section. Each setting is a row; add new settings as rows. */
export function ClientGovernance({
  clientId,
  isAdmin,
  active,
  rateLimit = null,
  onClientChange
}: {
  clientId: string;
  isAdmin: boolean;
  active: boolean;
  rateLimit?: McpGatewayRateLimit | null;
  onClientChange?: (client: McpClientView) => void;
}) {
  return (
    <section className="mcp-client-usage mcp-governance" aria-label="Client governance">
      <GovernanceRow title="Guard">
        <GatewayGuardPicker scope="client" id={clientId} isAdmin={isAdmin && active} />
      </GovernanceRow>
      <GovernanceRow title="Rate limit">
        <GatewayRateLimitEditor
          scope="client"
          id={clientId}
          value={rateLimit}
          isAdmin={isAdmin && active}
          onSave={async (limit) => {
            const result = await updateMcpClient(clientId, { rateLimit: limit });
            onClientChange?.(result.client);
            return result.client.rateLimit;
          }}
        />
      </GovernanceRow>
      <GovernanceRow title="Budgets">
        <ClientBudgets clientId={clientId} />
      </GovernanceRow>
    </section>
  );
}
