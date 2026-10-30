/**
 * Phase 12.4 — policies learned from real runs: simulation, shadow hits and least-privilege suggestions.
 *
 *   POST /api/mcp/policies/simulate                    what a draft rule set (or one added rule) would have done to
 *                                                      the calls of the last 7 or 30 days; nothing is written
 *   GET  /api/mcp/policies/shadow-hits?days=7          per shadow rule: calls it matched and would have changed
 *   GET  /api/mcp/policies/suggestions?status=open     stored suggestions
 *   POST /api/mcp/policies/suggestions/generate        "Suggest rules": build or refresh suggestions now (rate-limited)
 *   POST /api/mcp/policies/suggestions/:id/accept      add the suggested rules in SHADOW mode
 *   POST /api/mcp/policies/suggestions/:id/dismiss     dismiss; the same proposal is not offered again
 *   POST /api/mcp/policies/suggestions/:id/enforce     switch the accepted rules still in shadow to enforce
 *   POST /api/mcp/policies/:id/enforce                 switch one shadow rule to enforce
 *
 * Admin only. Responses carry argument SUMMARIES only, never raw arguments and never the summary hash key.
 * Accepting, dismissing and enforcing are audited as `mcp_policy.suggestion_accepted`,
 * `mcp_policy.suggestion_dismissed` and `mcp_policy.enforced` (each created rule also as `mcp_policy.created`).
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  mcpPolicyShadowHitsQuerySchema,
  mcpPolicySimulationRequestSchema,
  mcpPolicySuggestionGenerateSchema,
  mcpPolicySuggestionListQuerySchema,
  type McpPolicySuggestion,
  type McpToolPolicyRule
} from "@ai-orchestrator/shared";
import type { Store } from "./db/store.js";
import type { SafeUser, UserRole } from "./services/auth-service.js";
import { McpPolicySimulationError, type McpPolicySimulationService } from "./services/mcp-policy-simulation-service.js";
import { McpPolicySuggestionError, loosenedRule, type McpPolicySuggestionService } from "./services/mcp-policy-suggestion-service.js";

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
    action: "create" | "update" | "delete",
    resourceId: string,
    metadata: Record<string, unknown>,
    projectId?: string | null
  ) => Promise<void>;
  policyAuditMetadata: (rule: McpToolPolicyRule) => Record<string, unknown>;
  policyRuleResponse: (rule: McpToolPolicyRule) => McpToolPolicyRule & { hash: string };
  now?: () => Date;
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
      return { simulation: await simulation.simulate(parsed.data) };
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
    const suggestion = await findSuggestion(request.params.id, reply);
    if (!suggestion) return { error: "Policy suggestion not found" };
    if (suggestion.status !== "open") return fail(reply, 409, `This suggestion was already ${suggestion.status}`);
    // The rules may have changed since the suggestion was made: it must still only tighten.
    const carved = loosenedRule(suggestion.rules, await store.listMcpToolPolicies());
    if (carved) {
      return fail(reply, 409, `Accepting would carve an exception out of rule ${carved.name ? `'${carved.name}'` : carved.id}. Generate suggestions again.`);
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

  /** Switches shadow rules to enforce, auditing each with its recent shadow evidence. */
  const enforce = async (user: SafeUser, rules: McpToolPolicyRule[], suggestionId: string | null) => {
    const hits = rules.length > 0 ? await simulation.shadowHits(MCP_POLICY_ENFORCE_QUIET_DAYS) : null;
    const enforced: McpToolPolicyRule[] = [];
    for (const rule of rules) {
      const updated = await store.updateMcpToolPolicy(rule.id, { mode: "enforce" });
      if (!updated) continue;
      enforced.push(updated);
      const evidence = hits?.rules.find((row) => row.ruleId === rule.id);
      await deps.recordPolicyAudit(
        user,
        "mcp_policy.enforced",
        "update",
        rule.id,
        {
          ...deps.policyAuditMetadata(updated),
          previousMode: "shadow",
          ...(suggestionId ? { suggestionId } : {}),
          shadowDays: MCP_POLICY_ENFORCE_QUIET_DAYS,
          shadowMatched: evidence?.matched ?? 0,
          shadowWouldChange: evidence?.wouldChange ?? 0
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
    const rules: McpToolPolicyRule[] = [];
    for (const id of suggestion.acceptedRuleIds) {
      const rule = await store.getMcpToolPolicy(id);
      if (rule && (rule.mode ?? "enforce") === "shadow") rules.push(rule);
    }
    // The deny goes last: the allows it carves out are enforced before it is.
    rules.sort((a, b) => (a.effect === "deny" ? 1 : 0) - (b.effect === "deny" ? 1 : 0));
    const enforced = await enforce(user, rules, suggestion.id);
    return { suggestion, rules: enforced.map(deps.policyRuleResponse) };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/policies/:id/enforce", async (request, reply) => {
    const user = await requireRole(request, reply, ["admin"]);
    if (!user) return;
    const rule = await store.getMcpToolPolicy(request.params.id);
    if (!rule) return fail(reply, 404, "MCP tool policy rule not found");
    if ((rule.mode ?? "enforce") !== "shadow") return fail(reply, 409, "This rule is already enforced");
    const [enforced] = await enforce(user, [rule], null);
    if (!enforced) return fail(reply, 404, "MCP tool policy rule not found");
    return { rule: deps.policyRuleResponse(enforced) };
  });
}
