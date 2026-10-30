/**
 * Phase 12.4 — policies learned from real runs: simulation, shadow hits and least-privilege suggestions.
 *
 *   POST /api/mcp/policies/simulate                    what a draft rule set (or one added rule) would have done to
 *                                                      the calls of the last 7 or 30 days; nothing is written
 *   GET  /api/mcp/policies/shadow-hits?days=7          per shadow rule: calls it matched and would have changed
 *   GET  /api/mcp/policies/suggestions?status=open     stored suggestions
 *   POST /api/mcp/policies/suggestions/generate        "Suggest rules": build or refresh suggestions now (rate-limited)
 *   POST /api/mcp/policies/suggestions/:id/accept      add the suggested rules in SHADOW mode; the body names the
 *                                                      fingerprint the admin reviewed (409 when it was regenerated)
 *   POST /api/mcp/policies/suggestions/:id/dismiss     dismiss; the same proposal is not offered again
 *   POST /api/mcp/policies/suggestions/:id/enforce     switch the accepted rules still in shadow to enforce, together
 *   POST /api/mcp/policies/:id/enforce                 switch one shadow rule to enforce
 *
 * Enforcing is guarded twice, and refused with 409 (nothing changes, nothing is audited):
 *   - a deny or require_approval rule from an accepted suggestion cannot go alone while an allow of the same scope's
 *     accepted rules is still in shadow (it would block the tools those allows carve out): enforce the suggestion;
 *   - tighten-only, again: an allow that would carve an exception out of a deny or require_approval rule enforced
 *     now (other than its own scope's accepted deny) is refused, even if that rule was added after the suggestion.
 * Each rule switches only while it is still in shadow, in one transaction, so two admins enforcing at once change
 * and audit it once.
 *
 * Admin only. Responses carry argument SUMMARIES only, never raw arguments and never the summary hash key.
 * Simulating, accepting, dismissing and enforcing are audited as `mcp_policy.simulated` (rule hashes and filters
 * only), `mcp_policy.suggestion_accepted`, `mcp_policy.suggestion_dismissed` and `mcp_policy.enforced` (each created
 * rule also as `mcp_policy.created`).
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  mcpPolicyShadowHitsQuerySchema,
  mcpPolicySuggestionAcceptSchema,
  mcpPolicySimulationRequestSchema,
  mcpPolicySuggestionGenerateSchema,
  mcpPolicySuggestionListQuerySchema,
  type McpPolicySuggestion,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { McpPolicySimulationError, type McpPolicySimulationService } from "./services/mcp-policy-simulation-service.js";
import { hashMcpToolPolicyRule } from "@ai-orchestrator/mcp-sdk";
import {
  McpPolicySuggestionError,
  acceptedRulesInPlace,
  loosenedRule,
  suggestionScopeKey,
  type McpPolicySuggestionService
} from "./services/mcp-policy-suggestion-service.js";
import { draftToPolicyRule } from "./services/mcp-policy-simulation-service.js";

/** Simulations running at once on this instance; more get 429 (each reads up to the scan cap). */
const MAX_CONCURRENT_SIMULATIONS = 2;
/** Days without a shadow change after which a rule reads as ready to enforce. */
export const MCP_POLICY_ENFORCE_QUIET_DAYS = 7;

export interface McpPolicyLearningRoutesDeps {
  app: FastifyInstance;
  store: Store;
  simulation: McpPolicySimulationService;
  suggestions: McpPolicySuggestionService;
  requireRole: (request: FastifyRequest, reply: FastifyReply, roles: UserRole[]) => Promise<SafeUser | null>;
  validatePolicyScope: (
    input: { projectId?: string | null; serverId?: string | null; workflowIds?: string[] | null; clientIds?: string[] | null },
    reply: FastifyReply
  ) => Promise<{ error: string } | null>;
  recordPolicyAudit: (
    user: SafeUser,
    eventType: string,
    action: "create" | "update" | "delete" | "read",
    resourceId: string,
    metadata: Record<string, unknown>,
    projectId?: string | null
  ) => Promise<void>;
  policyAuditMetadata: (rule: McpToolPolicyRule) => Record<string, unknown>;
  policyRuleResponse: (rule: McpToolPolicyRule) => McpToolPolicyRule & { hash: string };
  now?: () => Date;
}

function ruleLabel(rule: Pick<McpToolPolicyRule, "id" | "name">): string {
  return rule.name ? `'${rule.name}'` : rule.id;
}

function suggestionAuditMetadata(suggestion: McpPolicySuggestion): Record<string, unknown> {
  return {
    scopeKind: suggestion.scopeKind,
    scopeId: suggestion.scopeId,
    serverId: suggestion.serverId,
    fingerprint: suggestion.fingerprint,
    callCount: suggestion.callCount,
    windowDays: suggestion.windowDays,
    rules: suggestion.rules.length
  };
}

export function registerMcpPolicyLearningRoutes(deps: McpPolicyLearningRoutesDeps): void {
  const { app, store, simulation, suggestions, requireRole } = deps;
  const now = deps.now ?? (() => new Date());
  let runningSimulations = 0;

  const fail = (reply: FastifyReply, status: number, error: string, details?: unknown) => {
    reply.code(status);
    return details === undefined ? { error } : { error, details };
  };

  app.post<{ Body: unknown }>("/api/mcp/policies/simulate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpPolicySimulationRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "Invalid policy simulation request", parsed.error.issues);
    if (runningSimulations >= MAX_CONCURRENT_SIMULATIONS) {
      reply.header("retry-after", "5");
      return fail(reply, 429, "Other simulations are running. Try again in a moment.");
    }
    runningSimulations += 1;
    try {
      const result = await simulation.simulate(parsed.data);
      // A simulation can confirm a guessed argument value against hashed summaries: record who asked what, by rule
      // hash (never the literals) and filters.
      const draftHashes = parsed.data.addRule
        ? [hashMcpToolPolicyRule(draftToPolicyRule(parsed.data.addRule, "draft"))]
        : (parsed.data.rules ?? []).map((entry, index) => ("keep" in entry ? `keep:${entry.keep}` : hashMcpToolPolicyRule(draftToPolicyRule(entry, entry.id ?? `draft_${index + 1}`))));
      await deps.recordPolicyAudit(user, "mcp_policy.simulated", "read", `simulation_${crypto.randomUUID()}`, {
        windowDays: parsed.data.windowDays,
        mode: parsed.data.addRule ? "add_rule" : "rule_set",
        ruleHashes: draftHashes.slice(0, 200),
        filters: parsed.data.filters ?? {},
        scanned: result.scanned,
        capped: result.capped
      });
      return { simulation: result };
    } catch (error) {
      if (error instanceof McpPolicySimulationError) return fail(reply, error.statusCode, error.message);
      throw error;
    } finally {
      runningSimulations -= 1;
    }
  });

  app.get<{ Querystring: unknown }>("/api/mcp/policies/shadow-hits", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpPolicyShadowHitsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return fail(reply, 400, "Invalid shadow hits query", parsed.error.issues);
    return { shadowHits: await simulation.shadowHits(parsed.data.days ?? MCP_POLICY_ENFORCE_QUIET_DAYS) };
  });

  app.get<{ Querystring: unknown }>("/api/mcp/policies/suggestions", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpPolicySuggestionListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return fail(reply, 400, "Invalid suggestions query", parsed.error.issues);
    const status = parsed.data.status ?? "open";
    return { suggestions: await store.listMcpPolicySuggestions(status === "all" ? {} : { status }) };
  });

  app.post<{ Body: unknown }>("/api/mcp/policies/suggestions/generate", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const parsed = mcpPolicySuggestionGenerateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "Invalid suggestion request", parsed.error.issues);
    try {
      return { result: await suggestions.generate({ ...parsed.data, createdBy: user.email }) };
    } catch (error) {
      if (error instanceof McpPolicySuggestionError) {
        if (error.retryAfterMs !== undefined) reply.header("retry-after", String(Math.ceil(error.retryAfterMs / 1000)));
        return fail(reply, error.statusCode, error.message);
      }
      throw error;
    }
  });

  const findSuggestion = async (id: string, reply: FastifyReply) => {
    const suggestion = await store.getMcpPolicySuggestion(id);
    if (!suggestion) {
      reply.code(404);
      return null;
    }
    return suggestion;
  };

  app.post<{ Params: { id: string } }>("/api/mcp/policies/suggestions/:id/accept", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const body = mcpPolicySuggestionAcceptSchema.safeParse(request.body ?? {});
    if (!body.success) return fail(reply, 400, "Name the fingerprint of the suggestion you reviewed", body.error.issues);
    const suggestion = await findSuggestion(request.params.id, reply);
    if (!suggestion) return { error: "Policy suggestion not found" };
    if (suggestion.status !== "open") return fail(reply, 409, `This suggestion was already ${suggestion.status}`);
    if (suggestion.fingerprint !== body.data.fingerprint) {
      return fail(reply, 409, "This suggestion was regenerated after you reviewed it. Review it again before accepting.");
    }
    // The rules may have changed since the suggestion was made: it must still only tighten. An update's allows carve
    // the scope's own accepted deny on purpose; that deny is left out of the check.
    const current = await store.listMcpToolPolicies();
    const currentById = new Map(current.map((rule) => [rule.id, rule]));
    const ownDenyIds = new Set(
      (suggestion.evidence.updates?.ruleIds ?? []).filter((id) => {
        const rule = currentById.get(id);
        return rule !== undefined && rule.effect !== "allow";
      })
    );
    const carved = loosenedRule(suggestion.rules, current, { ignoreIds: ownDenyIds });
    if (carved) {
      return fail(reply, 409, `Accepting would carve an exception out of rule ${ruleLabel(carved)}. Generate suggestions again.`);
    }
    for (const rule of suggestion.rules) {
      const invalid = await deps.validatePolicyScope(rule, reply);
      if (invalid) return invalid;
    }
    const decidedAt = now().toISOString();
    // Claim it first, so two admins accepting at once create the rules once.
    const claimed = await store.transitionMcpPolicySuggestion(suggestion.id, { from: "open", to: "accepted", decidedBy: user.email, decidedAt });
    if (!claimed) return fail(reply, 409, "This suggestion was decided meanwhile");
    const created: McpToolPolicyRule[] = [];
    try {
      for (const rule of suggestion.rules) {
        created.push(
          await store.createMcpToolPolicy({
            id: `mtp_${crypto.randomUUID()}`,
            name: rule.name,
            description: rule.description,
            effect: rule.effect,
            projectId: rule.projectId,
            roles: rule.roles,
            serverId: rule.serverId,
            toolPattern: rule.toolPattern,
            annotationHint: null,
            kind: "tool",
            enabled: true,
            conditions: rule.conditions,
            mode: "shadow",
            workflowIds: rule.workflowIds ?? [],
            clientIds: rule.clientIds ?? [],
            createdBy: user.email
          })
        );
      }
    } catch (error) {
      // Undo: remove what was created and reopen the suggestion.
      for (const rule of created) await store.deleteMcpToolPolicy(rule.id).catch(() => undefined);
      await store.transitionMcpPolicySuggestion(suggestion.id, { from: "accepted", to: "open", decidedBy: null, decidedAt: null, acceptedRuleIds: [] });
      throw error;
    }
    const accepted =
      (await store.transitionMcpPolicySuggestion(suggestion.id, {
        from: "accepted",
        to: "accepted",
        decidedBy: user.email,
        decidedAt,
        acceptedRuleIds: created.map((rule) => rule.id)
      })) ?? claimed;
    for (const rule of created) {
      await deps.recordPolicyAudit(user, "mcp_policy.created", "create", rule.id, { ...deps.policyAuditMetadata(rule), suggestionId: suggestion.id }, rule.projectId);
    }
    await deps.recordPolicyAudit(user, "mcp_policy.suggestion_accepted", "update", suggestion.id, {
      ...suggestionAuditMetadata(suggestion),
      ruleIds: created.map((rule) => rule.id),
      mode: "shadow"
    });
    return { suggestion: accepted, rules: created.map(deps.policyRuleResponse) };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/policies/suggestions/:id/dismiss", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const suggestion = await findSuggestion(request.params.id, reply);
    if (!suggestion) return { error: "Policy suggestion not found" };
    const dismissed = await store.transitionMcpPolicySuggestion(suggestion.id, {
      from: "open",
      to: "dismissed",
      decidedBy: user.email,
      decidedAt: now().toISOString()
    });
    if (!dismissed) return fail(reply, 409, `This suggestion was already ${(await store.getMcpPolicySuggestion(suggestion.id))?.status ?? "decided"}`);
    await deps.recordPolicyAudit(user, "mcp_policy.suggestion_dismissed", "update", suggestion.id, suggestionAuditMetadata(suggestion));
    return { suggestion: dismissed };
  });

  /**
   * The accepted rules of a scope (one workflow or client on one server) still in place: every accepted suggestion
   * of that scope whose rules all exist, by the suggestions that hold `ruleIds`.
   */
  const scopeFamily = async (ruleIds: readonly string[], current: Map<string, McpToolPolicyRule>) => {
    const accepted = (await store.listMcpPolicySuggestions({ status: "accepted", limit: 10_000 })).filter((suggestion) =>
      acceptedRulesInPlace(suggestion, new Set(current.keys()))
    );
    const keys = new Set(accepted.filter((suggestion) => suggestion.acceptedRuleIds.some((id) => ruleIds.includes(id))).map(suggestionScopeKey));
    const members = new Set(accepted.filter((suggestion) => keys.has(suggestionScopeKey(suggestion))).flatMap((suggestion) => suggestion.acceptedRuleIds));
    return [...members].map((id) => current.get(id)!).filter(Boolean);
  };

  /**
   * Why these shadow rules cannot be enforced together now, or null. Rules: their scope's shadow allows must go with
   * (or before) a deny or require_approval rule, and no allow may carve an exception out of a rule enforced now.
   */
  const enforceRefusal = async (rules: McpToolPolicyRule[], current: McpToolPolicyRule[]): Promise<string | null> => {
    const currentById = new Map(current.map((rule) => [rule.id, rule]));
    const ids = rules.map((rule) => rule.id);
    const family = await scopeFamily(ids, currentById);
    if (rules.some((rule) => rule.effect !== "allow")) {
      const left = family.filter((rule) => rule.effect === "allow" && policyModeOf(rule) === "shadow" && !ids.includes(rule.id));
      if (left.length > 0) {
        return `Enforcing this would block tools the scope's accepted allow rules carve out, while they are still in shadow: ${left
          .slice(0, 5)
          .map(ruleLabel)
          .join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}. Enforce the suggestion instead, or those allows first.`;
      }
    }
    const ownDenyIds = new Set(family.filter((rule) => rule.effect !== "allow").map((rule) => rule.id));
    const carved = loosenedRule(rules, current, { enforcedOnly: true, ignoreIds: ownDenyIds });
    if (carved) return `Enforcing would carve an exception out of rule ${ruleLabel(carved)}, which is enforced now. Nothing was changed.`;
    return null;
  };

  /** Switches shadow rules to enforce in one transaction, allows first, auditing each rule that changed. */
  const enforce = async (user: SafeUser, rules: McpToolPolicyRule[], suggestionId: string | null) => {
    const ordered = [...rules].sort((a, b) => (a.effect === "allow" ? 0 : 1) - (b.effect === "allow" ? 0 : 1));
    const hits = ordered.length > 0 ? await simulation.shadowHits(MCP_POLICY_ENFORCE_QUIET_DAYS) : null;
    const enforced = await store.enforceShadowMcpToolPolicies(
      ordered.map((rule) => rule.id),
      now().toISOString()
    );
    const group = suggestionId ? hits?.groups.find((row) => row.suggestionId === suggestionId) : undefined;
    for (const updated of enforced) {
      const evidence = hits?.rules.find((row) => row.ruleId === updated.id);
      await deps.recordPolicyAudit(
        user,
        "mcp_policy.enforced",
        "update",
        updated.id,
        {
          ...deps.policyAuditMetadata(updated),
          previousMode: "shadow",
          ...(suggestionId ? { suggestionId } : {}),
          shadowDays: MCP_POLICY_ENFORCE_QUIET_DAYS,
          shadowMatched: evidence?.matched ?? 0,
          shadowWouldChangeAlone: evidence?.wouldChange ?? 0,
          ...(group ? { suggestionShadowWouldChange: group.wouldChange } : {}),
          ...(hits?.capped ? { shadowScanCapped: true } : {})
        },
        updated.projectId
      );
    }
    return enforced;
  };

  app.post<{ Params: { id: string } }>("/api/mcp/policies/suggestions/:id/enforce", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const suggestion = await findSuggestion(request.params.id, reply);
    if (!suggestion) return { error: "Policy suggestion not found" };
    if (suggestion.status !== "accepted") return fail(reply, 409, "Only an accepted suggestion's rules can be enforced");
    const current = await store.listMcpToolPolicies();
    const currentById = new Map(current.map((rule) => [rule.id, rule]));
    const rules = suggestion.acceptedRuleIds.map((id) => currentById.get(id)).filter((rule): rule is McpToolPolicyRule => rule !== undefined && policyModeOf(rule) === "shadow");
    if (rules.length === 0) return fail(reply, 409, "None of this suggestion's rules is still in shadow");
    const refusal = await enforceRefusal(rules, current);
    if (refusal) return fail(reply, 409, refusal);
    const enforced = await enforce(user, rules, suggestion.id);
    return { suggestion, rules: enforced.map(deps.policyRuleResponse) };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/policies/:id/enforce", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const current = await store.listMcpToolPolicies();
    const rule = current.find((entry) => entry.id === request.params.id);
    if (!rule) return fail(reply, 404, "MCP tool policy rule not found");
    if (policyModeOf(rule) !== "shadow") return fail(reply, 409, "This rule is already enforced");
    const refusal = await enforceRefusal([rule], current);
    if (refusal) return fail(reply, 409, refusal);
    const [enforced] = await enforce(user, [rule], null);
    if (!enforced) return fail(reply, 409, "This rule was enforced meanwhile");
    return { rule: deps.policyRuleResponse(enforced) };
  });
}

function policyModeOf(rule: McpToolPolicyRule): "enforce" | "shadow" {
  return rule.mode === "shadow" ? "shadow" : "enforce";
}
