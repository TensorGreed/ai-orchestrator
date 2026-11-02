/**
 * 12.6 — governance of MCP gateway toolsets and clients, shown on the objects themselves.
 *
 * `GatewayGuardPicker` picks the Guard profile that checks a toolset's or client's tool calls (none by default). `ClientGovernance` is the client's Governance section: one row per setting, so later settings (limits,
 * budgets) add a row. Admins change them; everyone else reads them.
 */

import { useEffect, useState, type ReactNode } from "react";
import { GUARD_DESTINATION_RULES_PROFILE_ID, type GuardProfileSummary, type GuardResolutionView } from "@ai-orchestrator/shared";
import {
  ApiError,
  type GuardGatewayBindingInput,
  fetchGuardClientBinding,
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
  const held = (rule: unknown) => {
    if (!rule || typeof rule !== "object") return false;
    const entry = rule as { action?: unknown; shadow?: unknown };
    return typeof entry.action === "string" && HELD_ACTIONS.has(entry.action) && entry.shadow !== true;
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

/** The client's Governance section. Each setting is a row; add new settings as rows. */
export function ClientGovernance({ clientId, isAdmin, active }: { clientId: string; isAdmin: boolean; active: boolean }) {
  return (
    <section className="mcp-client-usage mcp-governance" aria-label="Client governance">
      <GovernanceRow title="Guard">
        <GatewayGuardPicker scope="client" id={clientId} isAdmin={isAdmin && active} />
      </GovernanceRow>
    </section>
  );
}
