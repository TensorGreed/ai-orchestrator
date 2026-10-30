/**
 * Phase 12.4 — least-privilege rule suggestions from real runs.
 *
 * On demand ("Suggest rules", rate-limited; no background job), the tool calls of the last 30 days are grouped per
 * workflow and per gateway client (scope), then per server. A scope with at least `minCalls` usable calls gets, for
 * each server it used:
 *   - an allow rule per tool it actually called, scoped to it, with argument constraints only where the summaries
 *     support them: `one_of` over kept values (tokens, schema enum values, a single boolean) when there are at most
 *     10 distinct values, each seen in at least two calls; `lte` with headroom (observed max x 1.5, rounded up) for
 *     kept positive numbers; nothing for free text or hashed values (their real value is unknown, so a rule cannot
 *     name it);
 *   - a deny for the scope's other tools on that server (the allows are strictly narrower, so they carve the used
 *     tools out of it).
 * The rules apply to every role but admin (never for admins' own subject).
 *
 * Usable calls: reached the server (not refused by the runtime guard, a rule or the guard, not failed before the
 * call or before it connected), made by a workflow run or a gateway client, not by an admin. A call whose role was
 * not recorded counts: the tool was used, so the deny must not block it. Playground calls are never read.
 * Constraints need a summary on every call of the tool.
 *
 * Never from partial data: when the scan stops at its cap, nothing is generated (`notGenerated: "scan_capped"`).
 *
 * Tighten-only: a suggestion is dropped when one of its allow rules would be strictly narrower than an existing deny
 * or require_approval rule (it would carve an exception out of it), so accepting never allows more than today.
 * Proposals are stored (one open per scope and server); a dismissed or accepted proposal is not offered again
 * unchanged while its accepted rules are in place. Accepting adds the rules in SHADOW mode; enforcing is a separate
 * step.
 *
 * Once a scope's suggestion is accepted, a later proposal that only adds tools becomes an "Update accepted rules"
 * suggestion: the allows for the new tools, added in shadow next to the accepted set. Those allows carve the scope's
 * own accepted deny on purpose, so that deny is left out of the tighten-only check while it still hashes as it did when
 * accepted; every other deny, and that deny once edited, still counts.
 *
 * Summary format 2 marks no normalised value, so a kept v2 string with characters outside printable ASCII proposes no
 * `one_of` constraint ("normalised").
 */
import { createHash, randomUUID } from "node:crypto";
import {
  MCP_POLICY_ROLES,
  MCP_POLICY_SUGGESTION_MAX_DISTINCT,
  MCP_POLICY_SUGGESTION_MIN_CALLS_DEFAULT,
  MCP_POLICY_SUGGESTION_MIN_SEEN,
  MCP_POLICY_SUGGESTION_NUMBER_HEADROOM,
  MCP_POLICY_SUGGESTION_WINDOW_DAYS,
  mcpToolPolicyRuleInputSchema,
  parseMcpPolicyPath,
  type McpPolicyCondition,
  type McpPolicyRole,
  type McpPolicySuggestedRule,
  type McpPolicySuggestion,
  type McpPolicySuggestionConstraint,
  type McpPolicySuggestionGenerateResult,
  type McpPolicySuggestionSkip,
  type McpPolicySuggestionSkipReason,
  type McpPolicySuggestionToolEvidence,
  type McpPolicySuggestionUpdate,
  type McpToolPolicyRule,
  type ToolArgumentFieldSummary
} from "@ai-orchestrator/shared";
import { hashMcpToolPolicyRule, isStrictlyNarrower, isToolArgumentLocationKey, policyRuleMode } from "@ai-orchestrator/mcp-sdk";
import type { McpToolCallRecord } from "../db/database.js";
import type { Store } from "../db/store.js";
import { GATEWAY_WORKFLOW_TOOL_ADAPTER_ID, type McpPolicySimulationService } from "./mcp-policy-simulation-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Least time between two generations (per API instance). */
export const MCP_POLICY_SUGGESTION_COOLDOWN_MS = 30_000;
/** Most argument constraints on one suggested allow rule. */
const MAX_CONSTRAINTS_PER_RULE = 10;
/** Most skipped-constraint notes kept per tool. */
const MAX_SKIP_NOTES = 20;
/** Most "no suggestion" notes returned by one generation. */
const MAX_SKIPS = 200;
/** Every role but admin: suggestions never restrict admins' own subject. */
const NON_ADMIN_ROLES: McpPolicyRole[] = MCP_POLICY_ROLES.filter((role) => role !== "admin");
/** A plain dotted path of keys a summary kept (no lists, no hashed keys) that is also a valid rule path. */
const PLAIN_PATH = /^[A-Za-z][A-Za-z0-9_-]{0,31}(\.[A-Za-z][A-Za-z0-9_-]{0,31}){0,15}$/;
/**
 * Error text of a call that never reached the server: agent runtime, policy and guard refusals, and transport
 * failures before a connection was made (refused, unresolvable or unreachable host, connect timeout). Telemetry
 * records structured kinds only for runtime limits (`rejection`), so the rest is told apart by its text.
 */
const NOT_SENT_ERROR =
  /blocked by the guard|was blocked by policy|is blocked by policy|needs approval by policy|is missing required arguments|has been disabled due to repeated failures|does not exist\. Available tools|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|Connect Timeout Error|getaddrinfo/i;

export class McpPolicySuggestionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "McpPolicySuggestionError";
  }
}

/** True when the recorded call reached the tool's server. */
export function callReachedServer(call: Pick<McpToolCallRecord, "ok" | "error" | "rejection" | "policyDecision">): boolean {
  if (call.rejection) return false;
  const decision = call.policyDecision;
  if (decision?.effect === "deny") return false;
  if (decision?.effect === "require_approval" && decision.approval === "pending") return false;
  if (!call.ok && call.error && NOT_SENT_ERROR.test(call.error)) return false;
  return true;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asPolicyRule(rule: McpPolicySuggestedRule, id: string): McpToolPolicyRule {
  return { ...rule, id, enabled: true, mode: "enforce", annotationHint: null };
}

/** sha256 over the proposed rules' canonical hashes, in a stable order. */
export function suggestionFingerprint(rules: readonly McpPolicySuggestedRule[]): string {
  return sha256(
    rules
      .map((rule, index) => hashMcpToolPolicyRule(asPolicyRule(rule, `s${index}`)))
      .sort()
      .join("\n")
  );
}

export interface LoosenedRuleOptions {
  /** Only enforced rules count (the check at enforce time: shadow rules decide nothing yet). */
  enforcedOnly?: boolean;
  /** Rules left out: the scope's own accepted deny, which its allows carve on purpose. */
  ignoreIds?: ReadonlySet<string>;
}

/**
 * The existing deny / require_approval rule an allow would carve an exception out of, if any. `rules` are suggested
 * rules (read as enforced) or stored rules about to be enforced.
 */
export function loosenedRule(
  rules: ReadonlyArray<McpPolicySuggestedRule | McpToolPolicyRule>,
  current: readonly McpToolPolicyRule[],
  options: LoosenedRuleOptions = {}
): McpToolPolicyRule | null {
  const ownIds = new Set(rules.flatMap((rule) => ("id" in rule && typeof rule.id === "string" ? [rule.id] : [])));
  const strict = current.filter(
    (rule) =>
      rule.effect !== "allow" &&
      !ownIds.has(rule.id) &&
      !options.ignoreIds?.has(rule.id) &&
      (!options.enforcedOnly || (rule.enabled && policyRuleMode(rule) === "enforce"))
  );
  for (const [index, rule] of rules.entries()) {
    if (rule.effect !== "allow") continue;
    const candidate: McpToolPolicyRule =
      "id" in rule && typeof rule.id === "string" ? { ...rule, enabled: true, mode: "enforce" } : asPolicyRule(rule as McpPolicySuggestedRule, `suggested_${index}`);
    const carved = strict.find((existing) => isStrictlyNarrower(candidate, existing));
    if (carved) return carved;
  }
  return null;
}

/** The scope a suggestion belongs to: its accepted rules for one workflow or client on one server form a family. */
export function suggestionScopeKey(suggestion: Pick<McpPolicySuggestion, "scopeKind" | "scopeId" | "serverId">): string {
  return `${suggestion.scopeKind}\u0000${suggestion.scopeId}\u0000${suggestion.serverId}`;
}

/** Each created rule's canonical hash, recorded in the evidence when a suggestion is accepted. */
export function acceptedRuleHashes(rules: readonly McpToolPolicyRule[]): Record<string, string> {
  return Object.fromEntries(rules.map((rule) => [rule.id, hashMcpToolPolicyRule(rule)]));
}

/**
 * The scope's own accepted deny and require_approval rules its allows carve on purpose, from the scope's accepted
 * suggestions: each only while it still hashes as it did when accepted. A deny edited since (say, widened to every
 * workflow) is no longer the scope's own, so the tighten-only checks read it like any other rule.
 */
export function scopeOwnDenyIds(
  family: ReadonlyArray<Pick<McpPolicySuggestion, "acceptedRuleIds" | "evidence">>,
  currentById: ReadonlyMap<string, McpToolPolicyRule>
): Set<string> {
  const own = new Set<string>();
  for (const suggestion of family) {
    const recorded = suggestion.evidence.acceptedRuleHashes ?? {};
    for (const id of suggestion.acceptedRuleIds) {
      const rule = currentById.get(id);
      if (rule && rule.effect !== "allow" && recorded[id] !== undefined && recorded[id] === hashMcpToolPolicyRule(rule)) own.add(id);
    }
  }
  return own;
}

/** True for text of printable ASCII only: no character NFKC could fold. */
const PLAIN_ASCII = /^[\x20-\x7E]*$/;

/** An accepted suggestion counts only while every rule it created still exists. */
export function acceptedRulesInPlace(suggestion: Pick<McpPolicySuggestion, "status" | "acceptedRuleIds">, ruleIds: ReadonlySet<string>): boolean {
  return suggestion.status === "accepted" && suggestion.acceptedRuleIds.length > 0 && suggestion.acceptedRuleIds.every((id) => ruleIds.has(id));
}

interface ToolConstraints {
  conditions: McpPolicyCondition[];
  evidence: Omit<McpPolicySuggestionToolEvidence, "toolName" | "calls">;
}

function singleType(field: ToolArgumentFieldSummary): "string" | "number" | "boolean" | null {
  return field.type === "string" || field.type === "number" || field.type === "boolean" ? field.type : null;
}

/**
 * Argument constraints the summaries of one tool's calls support. Every call must carry a summary that was not
 * truncated; a path must be present in every call as one value of one scalar type.
 */
export function constraintsFromSummaries(calls: readonly McpToolCallRecord[]): ToolConstraints {
  const constraints: McpPolicySuggestionConstraint[] = [];
  const skipped: Array<{ path: string; reason: McpPolicySuggestionSkipReason }> = [];
  const conditions: McpPolicyCondition[] = [];
  const summaries = calls.map((call) => call.argsSummary ?? null);
  // Summary format 2 marks no adjusted value: a kept token with characters NFKC could fold may not be the real value.
  const unmarkedV2 = summaries.map((summary) => summary?.v === 2);
  if (summaries.length === 0 || summaries.some((summary) => summary === null || summary.truncated)) {
    return { conditions, evidence: { constraints, skipped: [{ path: "(arguments)", reason: "not_always_present" }] } };
  }
  const skip = (path: string, reason: McpPolicySuggestionSkipReason) => {
    if (skipped.length < MAX_SKIP_NOTES) skipped.push({ path, reason });
  };
  const paths = new Set<string>();
  for (const summary of summaries) for (const path of Object.keys(summary!.fields)) if (PLAIN_PATH.test(path)) paths.add(path);
  for (const path of [...paths].sort()) {
    if (conditions.length >= MAX_CONSTRAINTS_PER_RULE) break;
    const fields = summaries.map((summary) => summary!.fields[path]);
    if (fields.some((field) => field === undefined)) {
      skip(path, "not_always_present");
      continue;
    }
    const present = fields as ToolArgumentFieldSummary[];
    // Containers are read through their own paths.
    if (present.every((field) => field.type === "object" || field.type === "array")) continue;
    const type = singleType(present[0]!);
    if (!type || !parseMcpPolicyPath(path) || present.some((field) => singleType(field) !== type || (field.count ?? 1) !== 1 || field.more)) {
      skip(path, "mixed_types");
      continue;
    }
    if (present.some((field) => (field.hashes?.length ?? 0) > 0)) {
      skip(path, "hashed");
      continue;
    }
    if (
      type === "string" &&
      present.some((field, index) => field.adj || (unmarkedV2[index] && (field.values ?? []).some((value) => typeof value === "string" && !PLAIN_ASCII.test(value))))
    ) {
      // The kept text is a normalised form of the value: a one_of on it might not match the real value.
      skip(path, "normalised");
      continue;
    }
    if (present.some((field) => (field.values?.length ?? 0) !== 1)) {
      // A number that was not kept is known only by its magnitude: like a hash, its value is unknown.
      skip(path, type === "number" ? "hashed" : "free_text");
      continue;
    }
    const values = present.map((field) => field.values![0]!);
    if (type === "number") {
      if (path.split(".").some((key) => isToolArgumentLocationKey(key))) {
        skip(path, "location");
        continue;
      }
      const observedMax = Math.max(...(values as number[]));
      if (!(observedMax > 0)) {
        skip(path, "not_positive");
        continue;
      }
      const limit = Math.ceil(observedMax * MCP_POLICY_SUGGESTION_NUMBER_HEADROOM);
      constraints.push({ path, kind: "max", observedMax, limit });
      conditions.push({ path, op: "lte", value: limit });
      continue;
    }
    const seen = new Map<string, { value: string | boolean; count: number }>();
    for (const value of values as Array<string | boolean>) {
      const key = `${typeof value}:${String(value)}`;
      const entry = seen.get(key) ?? { value, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
    if (type === "boolean" && seen.size > 1) {
      skip(path, "both_values");
      continue;
    }
    if (seen.size > MCP_POLICY_SUGGESTION_MAX_DISTINCT) {
      skip(path, "too_many_values");
      continue;
    }
    if ([...seen.values()].some((entry) => entry.count < MCP_POLICY_SUGGESTION_MIN_SEEN)) {
      skip(path, "rare_values");
      continue;
    }
    const allowed = [...seen.values()].map((entry) => entry.value).sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    constraints.push({ path, kind: "one_of", values: allowed });
    conditions.push({ path, op: "one_of", value: allowed });
  }
  return { conditions, evidence: { constraints, skipped } };
}

function clip(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

interface ScopeCalls {
  kind: "workflow" | "client";
  id: string;
  scopeCalls: number;
  usable: McpToolCallRecord[];
}

/** The rule a tool's allow would be, and its evidence. */
interface ToolProposal {
  toolName: string;
  rule: McpPolicySuggestedRule;
  evidence: McpPolicySuggestionToolEvidence;
}

export class McpPolicySuggestionService {
  private readonly store: Store;
  private readonly simulation: McpPolicySimulationService;
  private readonly now: () => Date;
  private readonly cooldownMs: number;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private running = false;

  constructor(options: { store: Store; simulation: McpPolicySimulationService; now?: () => Date; cooldownMs?: number }) {
    this.store = options.store;
    this.simulation = options.simulation;
    this.now = options.now ?? (() => new Date());
    this.cooldownMs = options.cooldownMs ?? MCP_POLICY_SUGGESTION_COOLDOWN_MS;
  }

  async generate(input: { minCalls?: number; createdBy: string | null }): Promise<McpPolicySuggestionGenerateResult> {
    const started = this.now().getTime();
    if (this.running) throw new McpPolicySuggestionError("Suggestions are already being generated. Try again in a moment.", 409);
    const wait = this.lastStartedAt + this.cooldownMs - started;
    if (wait > 0) throw new McpPolicySuggestionError("Suggestions were generated moments ago. Try again shortly.", 429, wait);
    this.running = true;
    this.lastStartedAt = started;
    try {
      return await this.generateNow(input.minCalls ?? MCP_POLICY_SUGGESTION_MIN_CALLS_DEFAULT, input.createdBy);
    } finally {
      this.running = false;
    }
  }

  private async generateNow(minCalls: number, createdBy: string | null): Promise<McpPolicySuggestionGenerateResult> {
    const until = this.now();
    const since = new Date(until.getTime() - MCP_POLICY_SUGGESTION_WINDOW_DAYS * DAY_MS);
    const scopes = new Map<string, ScopeCalls>();
    const outcome = await this.simulation.scan(
      { since: since.toISOString(), until: until.toISOString(), sources: ["workflow", "gateway"], excludeAdapterId: GATEWAY_WORKFLOW_TOOL_ADAPTER_ID },
      (call) => {
        const gateway = call.source === "gateway";
        const id = gateway ? call.clientId : call.workflowId;
        if (!id) return;
        const kind = gateway ? "client" : "workflow";
        const key = `${kind}:${id}`;
        let scope = scopes.get(key);
        if (!scope) {
          scope = { kind, id, scopeCalls: 0, usable: [] };
          scopes.set(key, scope);
        }
        scope.scopeCalls += 1;
        // Every call that reached the server shows a used tool, whatever its role; only admins' own calls are left
        // out (the rules never apply to admins). A call with no recorded role still used the tool.
        if (call.subjectRole === "admin" || !callReachedServer(call)) return;
        scope.usable.push(call);
      }
    );

    if (outcome.capped) {
      // Never suggest from partial data: tools used before the oldest call read would be denied.
      return {
        windowDays: MCP_POLICY_SUGGESTION_WINDOW_DAYS,
        since: since.toISOString(),
        until: until.toISOString(),
        minCalls,
        scanned: outcome.scanned,
        capped: true,
        notGenerated: "scan_capped",
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: [],
        suggestions: []
      };
    }

    const current = await this.store.listMcpToolPolicies();
    const currentHashes = new Set(current.map((rule) => hashMcpToolPolicyRule(rule)));
    const currentById = new Map(current.map((rule) => [rule.id, rule]));
    const currentIds = new Set(currentById.keys());
    // Accepted suggestions whose rules are all still in place, by scope and server, however old.
    const families = new Map<string, McpPolicySuggestion[]>();
    for (const suggestion of await this.store.listAcceptedMcpPolicySuggestionsForRules([...currentIds])) {
      if (!acceptedRulesInPlace(suggestion, currentIds)) continue;
      const key = suggestionScopeKey(suggestion);
      families.set(key, [...(families.get(key) ?? []), suggestion]);
    }
    const [workflows, clients, servers] = await Promise.all([this.store.listWorkflows(), this.store.listMcpClients(), this.store.listMcpServers()]);
    const workflowNames = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
    const clientNames = new Map(clients.map((client) => [client.id, client.name]));
    const serverNames = new Map(servers.map((server) => [server.id, server.name]));

    const skipped: McpPolicySuggestionSkip[] = [];
    const noteSkip = (entry: McpPolicySuggestionSkip) => {
      if (skipped.length < MAX_SKIPS) skipped.push(entry);
    };
    const suggestions: McpPolicySuggestion[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    const ordered = [...scopes.values()].sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));
    for (const scope of ordered) {
      const scopeName = (scope.kind === "workflow" ? workflowNames.get(scope.id) : clientNames.get(scope.id)) ?? null;
      // A workflow or client that no longer exists gets nothing: its rule could not be saved.
      if (scopeName === null) continue;
      if (scope.usable.length < minCalls) {
        noteSkip({ scopeKind: scope.kind, scopeId: scope.id, scopeName, serverId: null, reason: "too_few_calls", detail: `${scope.usable.length} usable calls of ${minCalls} needed` });
        continue;
      }
      const roles = [...new Set(scope.usable.flatMap((call) => (call.subjectRole ? [call.subjectRole] : [])))].sort();
      const unknownRoleCalls = scope.usable.filter((call) => !call.subjectRole).length;
      const byServer = new Map<string, McpToolCallRecord[]>();
      for (const call of scope.usable) {
        const serverId = call.registryServerId ?? call.adapterId;
        const list = byServer.get(serverId) ?? [];
        list.push(call);
        byServer.set(serverId, list);
      }
      for (const [serverId, calls] of [...byServer.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const serverName = serverNames.get(serverId) ?? null;
        const base = { scopeKind: scope.kind, scopeId: scope.id, scopeName, serverId };
        const byTool = new Map<string, McpToolCallRecord[]>();
        for (const call of calls) {
          const list = byTool.get(call.toolName) ?? [];
          list.push(call);
          byTool.set(call.toolName, list);
        }
        const toolNames = [...byTool.keys()].sort();
        const globbed = toolNames.find((name) => name.includes("*"));
        if (globbed) {
          noteSkip({ ...base, reason: "glob_tool_name", detail: `Tool '${globbed}' has a * in its name, which a rule would read as a pattern` });
          continue;
        }
        const label = `${scopeName} on ${serverName ?? serverId}`;
        const principals = scope.kind === "workflow" ? { workflowIds: [scope.id], clientIds: [] } : { workflowIds: [], clientIds: [scope.id] };
        const description = `Suggested from ${calls.length} calls in the last ${MCP_POLICY_SUGGESTION_WINDOW_DAYS} days.`;
        const deny: McpPolicySuggestedRule = {
          name: clip(`Least privilege: ${label}, other tools`),
          description,
          effect: "deny",
          projectId: null,
          roles: NON_ADMIN_ROLES,
          serverId,
          toolPattern: "*",
          ...principals,
          conditions: null,
          kind: "tool"
        };
        const proposals: ToolProposal[] = toolNames.map((toolName) => {
          const toolCalls = byTool.get(toolName)!;
          const { conditions, evidence } = constraintsFromSummaries(toolCalls);
          return {
            toolName,
            evidence: { toolName, calls: toolCalls.length, ...evidence },
            rule: {
              name: clip(`Least privilege: ${label}, ${toolName}`),
              description,
              effect: "allow",
              projectId: null,
              roles: NON_ADMIN_ROLES,
              serverId,
              toolPattern: toolName,
              ...principals,
              conditions: conditions.length > 0 ? { all: conditions } : null,
              kind: "tool"
            }
          };
        });
        const fullRules = [deny, ...proposals.map((proposal) => proposal.rule)];
        // Every proposed rule must be one the API would accept as it stands.
        if (fullRules.some((rule) => !mcpToolPolicyRuleInputSchema.safeParse(rule).success)) continue;
        if (fullRules.every((rule, index) => currentHashes.has(hashMcpToolPolicyRule(asPolicyRule(rule, `s${index}`))))) {
          noteSkip({ ...base, reason: "already_in_place" });
          continue;
        }

        // A scope whose earlier suggestion is accepted (and in place) gets an update with only the new tools.
        const family = families.get(suggestionScopeKey({ scopeKind: scope.kind, scopeId: scope.id, serverId })) ?? [];
        let rules = fullRules;
        let tools = proposals.map((proposal) => proposal.evidence);
        let updates: McpPolicySuggestionUpdate | undefined;
        let ownDenyIds: Set<string> | undefined;
        if (family.length > 0) {
          const familyRules = family.flatMap((suggestion) => suggestion.acceptedRuleIds).map((id) => currentById.get(id)!);
          const allowedTools = new Set(familyRules.filter((rule) => rule.effect === "allow").map((rule) => rule.toolPattern));
          const added = proposals.filter((proposal) => !allowedTools.has(proposal.toolName));
          if (added.length === 0) {
            noteSkip({ ...base, reason: "already_accepted", detail: "The accepted rules already allow every tool it used" });
            continue;
          }
          rules = added.map((proposal) => proposal.rule);
          tools = added.map((proposal) => proposal.evidence);
          ownDenyIds = scopeOwnDenyIds(family, currentById);
          updates = {
            suggestionIds: family.map((suggestion) => suggestion.id),
            ruleIds: familyRules.map((rule) => rule.id),
            addedTools: added.map((proposal) => proposal.toolName)
          };
        }
        const carved = loosenedRule(rules, current, ownDenyIds ? { ignoreIds: ownDenyIds } : {});
        if (carved) {
          noteSkip({ ...base, reason: "would_loosen", detail: `An allow here would carve an exception out of rule ${carved.name ? `'${carved.name}'` : carved.id}` });
          continue;
        }
        const fingerprint = suggestionFingerprint(rules);
        const decided = await this.store.listDecidedMcpPolicySuggestions({ scopeKind: scope.kind, scopeId: scope.id, serverId, fingerprint });
        if (decided.some((entry) => entry.status === "dismissed")) {
          noteSkip({ ...base, reason: "dismissed_before" });
          continue;
        }
        if (decided.some((entry) => acceptedRulesInPlace(entry, currentIds))) {
          noteSkip({ ...base, reason: "already_accepted" });
          continue;
        }
        const inlineAdapter = calls.some((call) => !call.registryServerId);
        const stored = await this.store.upsertOpenMcpPolicySuggestion({
          id: `mps_${randomUUID()}`,
          scopeKind: scope.kind,
          scopeId: scope.id,
          scopeName,
          serverId,
          serverName,
          fingerprint,
          rules,
          evidence: {
            calls: calls.length,
            scopeCalls: scope.scopeCalls,
            roles,
            tools,
            capped: false,
            ...(unknownRoleCalls > 0 ? { unknownRoleCalls } : {}),
            ...(updates ? { updates } : {}),
            ...(inlineAdapter ? { inlineAdapter: true } : {})
          },
          windowDays: MCP_POLICY_SUGGESTION_WINDOW_DAYS,
          windowStart: since.toISOString(),
          windowEnd: until.toISOString(),
          callCount: calls.length,
          createdBy,
          now: until.toISOString()
        });
        if (stored.outcome === "created") created += 1;
        else if (stored.outcome === "updated") updated += 1;
        else unchanged += 1;
        suggestions.push(stored.suggestion);
      }
    }

    return {
      windowDays: MCP_POLICY_SUGGESTION_WINDOW_DAYS,
      since: since.toISOString(),
      until: until.toISOString(),
      minCalls,
      scanned: outcome.scanned,
      capped: outcome.capped,
      created,
      updated,
      unchanged,
      skipped,
      suggestions
    };
  }
}
